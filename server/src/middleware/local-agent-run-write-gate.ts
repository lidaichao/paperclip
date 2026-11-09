import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, localAgentRunLeases } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { isClientPullRuntimeConfig } from "../services/local-agent-run-leases.js";
import { agentSessionWriteService, digestSessionWriteRequest } from "../services/agent-session-writes.js";

const localRunMutation = /^\/api\/agents\/me\/local-runs\/(?:claim|[0-9a-f-]{36}\/(?:renew|finish|events|comments|subtasks|review-accept|review-reject|issue\/(?:review-handoff|review-confirmation|completion-review-handoff|child-complete|defect-repair-handoff|defect-qa-verdict|po-verdict)))\/?$/i;
const sessionGrantMutation = /^\/api\/agents\/me\/session-writes\/?$/i;
const sessionWriteRoutes = [
  { method: "POST", path: /^\/api\/companies\/[0-9a-f-]{36}\/issues\/?$/i },
  { method: "POST", path: /^\/api\/issues\/[0-9a-f-]{36}\/comments\/?$/i },
  { method: "PATCH", path: /^\/api\/issues\/[0-9a-f-]{36}\/?$/i },
  { method: "PUT", path: /^\/api\/issues\/[0-9a-f-]{36}\/documents\/[^/]+\/?$/i },
] as const;

function isSessionWriteRoute(method: string, path: string) {
  return sessionWriteRoutes.some((route) => route.method === method && route.path.test(path));
}

function isSafeIssuePatch(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const allowed = new Set(["title", "description", "priority", "assigneeAgentId", "status"]);
  if (Object.keys(record).length === 0 || Object.keys(record).some((key) => !allowed.has(key))) return false;
  return record.status === undefined || ["backlog", "todo"].includes(String(record.status));
}

/**
 * Fail closed until each ordinary write endpoint can verify the lease inside
 * the same transaction as its business mutation. An auth-time lease check alone
 * would race a concurrent cancellation and permit a stale write.
 */
export function localAgentRunWriteGate(db: Db): RequestHandler {
  const sessionWrites = agentSessionWriteService(db);
  return async (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.actor.type !== "agent" ||
      !req.actor.agentId || !req.actor.companyId) return next();

    const [agent] = await db.select({ runtimeConfig: agents.runtimeConfig })
      .from(agents).where(and(eq(agents.id, req.actor.agentId), eq(agents.companyId, req.actor.companyId))).limit(1);
    // A long-lived key must never regain ordinary write powers merely because
    // the operator toggled executionMode off after a desktop lease ended.
    const [localHistory] = await db.select({ runId: localAgentRunLeases.runId })
      .from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.companyId, req.actor.companyId),
        eq(localAgentRunLeases.agentId, req.actor.agentId),
      )).limit(1);
    const [attributedRun] = req.actor.runId
      ? await db.select({ runtimeMode: heartbeatRuns.runtimeMode }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, req.actor.runId), eq(heartbeatRuns.companyId, req.actor.companyId),
          eq(heartbeatRuns.agentId, req.actor.agentId),
        )).limit(1)
      : [];
    if (isClientPullRuntimeConfig(agent?.runtimeConfig) || localHistory || attributedRun?.runtimeMode === "client_pull") {
      if (req.actor.source === "agent_key" && localRunMutation.test(req.path)) return next();
      if (req.actor.source === "agent_key" && sessionGrantMutation.test(req.path) && !req.actor.runId) return next();
      const token = typeof req.header === "function"
        ? (req.header("X-Paperclip-Session-Write") ?? "")
        : "";
      if (req.actor.source === "agent_key" && req.actor.keyId && !req.actor.runId && token &&
        isSessionWriteRoute(req.method, req.path) &&
        (req.method !== "PATCH" || isSafeIssuePatch(req.body))) {
        const authorization = await sessionWrites.authorize({
          companyId: req.actor.companyId,
          agentId: req.actor.agentId,
          keyId: req.actor.keyId,
          token,
          idempotencyKey: req.header("Idempotency-Key") ?? "",
          requestDigest: digestSessionWriteRequest(req.method, req.path, req.body),
          method: req.method,
          path: req.path,
        });
        if (authorization.replay) {
          res.set("X-Paperclip-Idempotent-Replay", "true");
          return res.status(authorization.receipt.statusCode!).json(authorization.receipt.responseBody);
        }
        req.sessionWriteAuthorization = {
          grantId: authorization.grant.id,
          receiptId: authorization.receipt.id,
          requestDigest: authorization.receipt.requestDigest,
        };
        const originalJson = res.json.bind(res);
        let finalizing = false;
        res.json = ((body: unknown) => {
          if (finalizing) return originalJson(body);
          finalizing = true;
          void sessionWrites.complete(authorization.receipt.id, res.statusCode, body)
            .then(() => originalJson(body))
            .catch(next);
          return res;
        }) as typeof res.json;
        return next();
      }
      res.status(403).json({
        error: "Client-pull run writes require a transaction-bound lease fence; this endpoint is not enabled",
        code: "CLIENT_PULL_WRITE_FENCED",
      });
      return;
    }
    next();
  };
}
