import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { addIssueCommentSchema, updateIssueSchema } from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { localAgentRunLeaseService, type LocalRunOwner } from "../services/local-agent-run-leases.js";

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("JSON object required");
  return value as Record<string, unknown>;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw badRequest(`Unsupported local run write field: ${unknown}`);
}

const ownerFields = ["deviceId", "leaseId", "generation", "issueId"] as const;

export function localAgentRunRoutes(db: Db) {
  const router = Router();
  const leases = localAgentRunLeaseService(db);

  function actorScope(req: Request) {
    if (req.actor.type !== "agent" || req.actor.source !== "agent_key" || !req.actor.agentId || !req.actor.companyId) {
      throw forbidden("An agent's own API key is required");
    }
    return { companyId: req.actor.companyId, agentId: req.actor.agentId };
  }

  function owner(req: Request, body: Record<string, unknown>): LocalRunOwner {
    const scope = actorScope(req);
    return {
      ...scope,
      runId: String(req.params.runId ?? ""),
      deviceId: String(body.deviceId ?? ""),
      leaseId: String(body.leaseId ?? ""),
      generation: Number(body.generation),
    };
  }

  router.post("/agents/me/local-runs/claim", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const scope = actorScope(req);
    const body = objectBody(req.body);
    const claimed = await leases.claim({
      ...scope,
      deviceId: String(body.deviceId ?? ""),
      idempotencyKey: req.header("Idempotency-Key") ?? "",
    });
    if (!claimed) return res.status(204).end();
    return res.json(claimed);
  });

  router.post("/agents/me/local-runs/:runId/renew", async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json(await leases.renew(owner(req, objectBody(req.body))));
  });

  router.get("/agents/me/local-runs/:runId/control", async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json(await leases.control(owner(req, req.query as Record<string, unknown>)));
  });

  router.post("/agents/me/local-runs/:runId/finish", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    if (!["succeeded", "failed", "cancelled"].includes(String(body.outcome ?? ""))) throw badRequest("Invalid outcome");
    if (body.processStopped !== true) throw badRequest("processStopped must be true");
    return res.json(await leases.finish({
      ...owner(req, body),
      outcome: body.outcome as "succeeded" | "failed" | "cancelled",
      exitCode: body.exitCode === null ? null : Number(body.exitCode),
      processStopped: true,
    }));
  });

  router.post("/agents/me/local-runs/:runId/comments", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    onlyFields(body, [...ownerFields, "body", "clientRequestId"]);
    const parsed = addIssueCommentSchema.pick({ body: true, clientRequestId: true }).parse(body);
    if (!parsed.clientRequestId) throw badRequest("clientRequestId is required");
    const comment = await leases.addFencedComment({
      ...owner(req, body), issueId: String(body.issueId ?? ""), body: parsed.body,
      clientRequestId: parsed.clientRequestId,
    }, req.actor);
    return res.status(201).json(comment);
  });

  router.patch("/agents/me/local-runs/:runId/issue", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    onlyFields(body, [...ownerFields, "title", "description", "priority"]);
    const patch = updateIssueSchema.pick({ title: true, description: true, priority: true }).parse(body);
    if (Object.keys(patch).length === 0) throw badRequest("At least one issue field is required");
    return res.json(await leases.patchFencedIssue({
      ...owner(req, body), issueId: String(body.issueId ?? ""), ...patch,
    }, req.actor));
  });

  return router;
}
