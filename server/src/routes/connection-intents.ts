import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  CONNECTION_REQUEST_TOOL_DESCRIPTION,
  CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
  completeConnectionIntentSchema,
  connectionRequestInputSchema,
  connectionsSearchInputSchema,
  declineConnectionIntentSchema,
} from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";
import { verifyRuntimeToolsToken } from "../runtime-tools-token.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { logActivity } from "../services/activity-log.js";
import { accessService } from "../services/access.js";
import type { heartbeatService } from "../services/heartbeat.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";

function bearer(req: Request) {
  const value = req.header("authorization") ?? "";
  return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "").trim() : "";
}

function runtimeClaims(req: Request) {
  const claims = verifyRuntimeToolsToken(bearer(req));
  if (!claims) throw unauthorized("运行时工具令牌缺失、无效或已过期");
  return claims;
}

function resultContent(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export { RUNTIME_CONNECTION_TOOL_DEFINITIONS } from "../services/connection-tool-definitions.js";
import { RUNTIME_CONNECTION_TOOL_DEFINITIONS } from "../services/connection-tool-definitions.js";

/** Public, token-authenticated routes mounted before the general actor middleware. */
export function runtimeConnectionIntentRoutes(db: Db) {
  const router = Router();
  const service = connectionIntentService(db);

  router.post("/runtime-tools/github/credentials", async (req, res) => {
    // This capability is never accepted as board/session authentication.
    // Node fetch sends Sec-Fetch-Mode too; browsers additionally send Origin or Sec-Fetch-Site.
    if (req.headers.origin || req.headers.cookie || req.headers["sec-fetch-site"]) throw forbidden("GitHub 凭据需要运行时身份验证");
    const claims = verifyRuntimeToolsToken(typeof req.headers["x-paperclip-github-capability"] === "string"
      ? req.headers["x-paperclip-github-capability"] : bearer(req), "github_credentials");
    if (!claims) throw unauthorized("GitHub 运行时能力无效");
    res.setHeader("Cache-Control", "no-store");
    res.json(await resolveGitHubOperationCredentials(db, {
      companyId: claims.company_id, agentId: claims.sub, runId: claims.run_id,
    }));
  });

  router.get("/mcp/runtime-tools", async (req, res) => {
    await service.validate(runtimeClaims(req));
    res.json({ name: "paperclip-runtime-tools", protocolVersion: "2025-03-26" });
  });

  router.post("/mcp/runtime-tools", async (req, res) => {
    const claims = runtimeClaims(req);
    // Streamable HTTP lifecycle calls are token uses too. Revalidate the bound
    // run before initialize/list as well as before an actual tool call so an
    // ended heartbeat cannot keep probing the endpoint with a once-valid token.
    await service.validate(claims);
    const request = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    const id = request.id ?? null;
    if (request.method === "initialize") {
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "paperclip-runtime-tools", version: "1" },
        },
      });
      return;
    }
    if (request.method === "notifications/initialized") {
      res.status(202).end();
      return;
    }
    if (request.method === "tools/list") {
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: RUNTIME_CONNECTION_TOOL_DEFINITIONS,
        },
      });
      return;
    }
    if (request.method === "tools/call") {
      const params = request.params && typeof request.params === "object"
        ? request.params as { name?: unknown; arguments?: unknown }
        : {};
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "connections_search") {
        const input = connectionsSearchInputSchema.parse(params.arguments ?? {});
        const result = await service.search(claims, input.query);
        res.json({ jsonrpc: "2.0", id, result: resultContent(result) });
        return;
      }
      if (name === "connection_request") {
        const input = connectionRequestInputSchema.parse(params.arguments ?? {});
        const result = await service.request(claims, input.service);
        res.json({ jsonrpc: "2.0", id, result: resultContent(result) });
        return;
      }
      res.status(404).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `未知工具：${name || "缺失"}` },
      });
      return;
    }
    res.status(404).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `未知方法：${request.method ?? "缺失"}` },
    });
  });

  router.post("/runtime-tools/connections/search", async (req, res) => {
    const input = connectionsSearchInputSchema.parse(req.body ?? {});
    res.json(await service.search(runtimeClaims(req), input.query));
  });
  router.post("/runtime-tools/connections/request", async (req, res) => {
    const input = connectionRequestInputSchema.parse(req.body ?? {});
    res.json(await service.request(runtimeClaims(req), input.service));
  });
  return router;
}

type Heartbeat = ReturnType<typeof heartbeatService>;

export { wakeConnectionIntentAfterResolution } from "../services/connection-intent-delivery.js";
export function connectionIntentBoardRoutes(db: Db, heartbeat: Heartbeat) {
  const router = Router();
  const service = connectionIntentService(db);
  const access = accessService(db);

  function bypassCurrentMembershipCheck(req: Request) {
    return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
  }

  async function canManageCompanyConnections(req: Request, companyId: string) {
    if (bypassCurrentMembershipCheck(req)) return true;
    return Boolean(req.actor.userId && await access.hasPermission(
      companyId,
      "user",
      req.actor.userId,
      "tools:manage_connections",
    ));
  }

  async function addressedIntent(req: Request) {
    assertBoard(req);
    const loaded = await service.loadIntent(req.params.interactionId as string);
    assertCompanyAccess(req, loaded.issue.companyId);
    const userId = req.actor.userId ?? "local-board";
    if (loaded.interaction.addresseeUserId !== userId) {
      throw forbidden("只有指定用户才能处理此连接请求");
    }
    return { loaded, userId };
  }

  async function wakeAfterResolution(input: {
    loaded: Awaited<ReturnType<typeof service.loadIntent>>;
    status: string;
    actorId: string;
  }) {
    await connectionIntentDeliveryService(db, heartbeat).tryDeliver(input.loaded.interaction.id);
  }

  router.get("/connection-intents/:interactionId/setup-options", async (req, res) => {
    const { loaded } = await addressedIntent(req);
    res.json(await service.setupOptions(req.params.interactionId as string, {
      canManageOrganizationGrant: await canManageCompanyConnections(req, loaded.issue.companyId),
    }));
  });

  router.post("/connection-intents/:interactionId/phase", async (req, res) => {
    const { userId } = await addressedIntent(req);
    const phase = req.body?.phase;
    if (phase !== "requested" && phase !== "authorizing" && phase !== "needs_retry") {
      res.status(422).json({ error: "phase 必须是 requested、authorizing 或 needs_retry" });
      return;
    }
    res.json(await service.updatePhase(req.params.interactionId as string, phase, userId, {
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    }));
  });

  router.post("/connection-intents/:interactionId/complete", async (req, res) => {
    const { loaded, userId } = await addressedIntent(req);
    const input = completeConnectionIntentSchema.parse(req.body);
    const interaction = await service.complete(loaded.interaction.id, input.connectionId, userId, {
      canManageOrganizationGrant: await canManageCompanyConnections(req, loaded.issue.companyId),
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    });
    await logActivity(db, {
      companyId: loaded.issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.connection_intent_connected",
      entityType: "issue",
      entityId: loaded.issue.id,
      details: {
        interactionId: interaction.id,
        connectionId: interaction.result?.connectionId ?? null,
        requestingAgentId: interaction.payload.requestingAgentId,
      },
    });
    await wakeAfterResolution({ loaded, status: interaction.status, actorId: userId });
    res.json(interaction);
  });

  router.post("/connection-intents/:interactionId/decline", async (req, res) => {
    const { loaded, userId } = await addressedIntent(req);
    const input = declineConnectionIntentSchema.parse(req.body ?? {});
    const interaction = await service.decline(loaded.interaction.id, userId, input.reason, {
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    });
    await logActivity(db, {
      companyId: loaded.issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.connection_intent_declined",
      entityType: "issue",
      entityId: loaded.issue.id,
      details: { interactionId: interaction.id, reason: input.reason ?? null },
    });
    await wakeAfterResolution({ loaded, status: interaction.status, actorId: userId });
    res.json(interaction);
  });

  return router;
}
