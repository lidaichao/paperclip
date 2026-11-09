import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { agentSessionWriteService } from "../services/agent-session-writes.js";

export function agentSessionWriteRoutes(db: Db) {
  const router = Router();
  const service = agentSessionWriteService(db);

  router.post("/agents/me/session-writes", async (req, res) => {
    if (req.actor.type !== "agent" || req.actor.source !== "agent_key" ||
      !req.actor.companyId || !req.actor.agentId || !req.actor.keyId || req.actor.runId) {
      throw forbidden("An agent's own ordinary-session API key is required");
    }
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw badRequest("JSON object required");
    }
    const body = req.body as Record<string, unknown>;
    const unknown = Object.keys(body).find((key) => !["deviceId", "ttlMinutes"].includes(key));
    if (unknown) throw badRequest(`Unsupported session write grant field: ${unknown}`);
    res.set("Cache-Control", "no-store");
    return res.status(201).json(await service.issue({
      companyId: req.actor.companyId,
      agentId: req.actor.agentId,
      keyId: req.actor.keyId,
      deviceId: body.deviceId === undefined ? null : String(body.deviceId),
      ttlMinutes: body.ttlMinutes === undefined ? undefined : Number(body.ttlMinutes),
    }));
  });

  return router;
}
