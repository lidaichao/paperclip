import { Router } from "express";
import type { Db } from "@paperclipai/db";

import { unprocessable } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import {
  remoteAgentProfileService,
  type RemoteAgentProfileInput,
  type RemoteAgentService,
} from "../services/remote-agent-profiles.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function remoteAgentService(value: unknown): RemoteAgentService {
  if (value !== "aws_bedrock_agentcore_harness") {
    throw unprocessable("不支持此远程智能体服务");
  }
  return value;
}

function profileInput(value: unknown): RemoteAgentProfileInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unprocessable("需要远程智能体资料请求体");
  }
  const body = value as Record<string, unknown>;
  if ("credentialSecretId" in body) {
    throw unprocessable("AWS AgentCore 资料使用工作负载身份，而不是凭据密钥");
  }
  return {
    profileKey: String(body.profileKey ?? ""),
    displayName: String(body.displayName ?? ""),
    service: remoteAgentService(body.service),
    configuration:
      body.configuration
      && typeof body.configuration === "object"
      && !Array.isArray(body.configuration)
        ? body.configuration as Record<string, unknown>
        : {},
    enabled: body.enabled === true,
    retentionAcknowledged: body.retentionAcknowledged === true,
    qualification:
      body.qualification
      && typeof body.qualification === "object"
      && !Array.isArray(body.qualification)
        ? body.qualification as Record<string, unknown>
        : {},
  };
}

export function remoteAgentProfileRoutes(db: Db) {
  const router = Router();
  const profiles = remoteAgentProfileService(db);

  router.get("/companies/:companyId/remote-agent-profiles", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const service = req.query.service === undefined
      ? undefined
      : remoteAgentService(req.query.service);
    res.json(await profiles.list(companyId, service));
  });

  router.post("/companies/:companyId/remote-agent-profiles", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const profile = await profiles.upsert(companyId, profileInput(req.body));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "remote_agent_profile.upserted",
      entityType: "remote_agent_profile",
      entityId: profile.id,
      details: {
        profileKey: profile.profileKey,
        service: profile.service,
        enabled: profile.enabled,
        retentionAcknowledged: profile.retentionAcknowledged,
        qualifiedRevision: profile.qualifiedRevision,
      },
    });
    res.status(201).json(profile);
  });

  return router;
}
