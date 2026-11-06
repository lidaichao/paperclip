import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { addIssueCommentSchema, updateIssueSchema } from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { localAgentRunLeaseService, type LocalRunOwner } from "../services/local-agent-run-leases.js";
import { localAgentReviewContextService } from "../services/local-agent-review-context.js";
import { issueCompletionReviewDecisionService } from "../services/issue-completion-review-decisions.js";
import { localAgentDeviceBindingService } from "../services/local-agent-device-bindings.js";
import { accessService } from "../services/access.js";
import { assertBoard, getAccessibleResource } from "./authz.js";

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
  const reviewContext = localAgentReviewContextService(db);
  const reviewDecisions = issueCompletionReviewDecisionService(db);
  const bindings = localAgentDeviceBindingService(db);

  async function managedAgent(req: Request, res: Response) {
    assertBoard(req);
    const agentId = String(req.params.agentId ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) {
      res.status(404).json({ error: "Agent not found" });
      return null;
    }
    const [candidate] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    const agent = await getAccessibleResource(req, res, candidate, "Agent not found");
    if (!agent) return null;
    const membership = req.actor.memberships?.find((item) =>
      item.companyId === agent.companyId && item.status === "active");
    if (!req.actor.isInstanceAdmin &&
      membership?.membershipRole !== "owner" && membership?.membershipRole !== "admin") {
      throw forbidden("Company owner or admin is required to manage local devices");
    }
    const decision = await accessService(db).decide({
      actor: req.actor, action: "agents:create",
      resource: { type: "company", companyId: agent.companyId },
    });
    if (!decision.allowed) throw forbidden("Agent management permission is required");
    return agent;
  }

  router.get("/agents/:agentId/local-devices", async (req, res) => {
    const agent = await managedAgent(req, res);
    if (!agent) return;
    res.set("Cache-Control", "no-store");
    res.json(await bindings.list(agent.companyId, agent.id));
  });

  router.post("/agents/:agentId/local-devices", async (req, res) => {
    const agent = await managedAgent(req, res);
    if (!agent) return;
    const body = objectBody(req.body);
    onlyFields(body, ["keyId", "deviceId"]);
    res.set("Cache-Control", "no-store");
    res.status(201).json(await bindings.bind({
      companyId: agent.companyId, agentId: agent.id,
      keyId: String(body.keyId ?? ""), deviceId: String(body.deviceId ?? ""),
      createdByUserId: req.actor.userId ?? null,
    }));
  });

  router.delete("/agents/:agentId/local-devices/:bindingId", async (req, res) => {
    const agent = await managedAgent(req, res);
    if (!agent) return;
    res.set("Cache-Control", "no-store");
    res.json(await bindings.revoke({
      companyId: agent.companyId, agentId: agent.id,
      bindingId: String(req.params.bindingId ?? ""),
      revokedByUserId: req.actor.userId ?? null,
    }));
  });

  function actorScope(req: Request) {
    if (req.actor.type !== "agent" || req.actor.source !== "agent_key" || !req.actor.agentId ||
      !req.actor.companyId || !req.actor.keyId) {
      throw forbidden("An agent's own API key is required");
    }
    return { companyId: req.actor.companyId, agentId: req.actor.agentId, keyId: req.actor.keyId };
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

  router.get("/agents/me/local-runs/:runId/review-context", async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json(await reviewContext.read(
      owner(req, req.query as Record<string, unknown>), req.actor));
  });

  router.post("/agents/me/local-runs/:runId/review-accept", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    onlyFields(body, [...ownerFields, "reviewId", "clientRequestId", "summary"]);
    const proof = owner(req, body);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(String(body.issueId ?? "")) || !uuid.test(String(body.reviewId ?? "")) ||
      !uuid.test(String(body.clientRequestId ?? "")) || typeof body.summary !== "string") {
      throw badRequest("Issue, review, decision request and summary are required");
    }
    return res.json(await reviewDecisions.accept({
      companyId: proof.companyId, issueId: String(body.issueId),
      reviewId: String(body.reviewId), actorAgentId: proof.agentId,
      actorRunId: proof.runId, requestId: String(body.clientRequestId),
      summary: body.summary, clientPullProof: { owner: proof, actor: req.actor },
    }));
  });

  router.post("/agents/me/local-runs/:runId/review-reject", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    onlyFields(body, [...ownerFields, "reviewId", "clientRequestId", "summary"]);
    const proof = owner(req, body);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(String(body.issueId ?? "")) || !uuid.test(String(body.reviewId ?? "")) ||
      !uuid.test(String(body.clientRequestId ?? "")) || typeof body.summary !== "string") {
      throw badRequest("Issue, review, decision request and summary are required");
    }
    return res.json(await reviewDecisions.reject({
      companyId: proof.companyId, issueId: String(body.issueId),
      reviewId: String(body.reviewId), actorAgentId: proof.agentId,
      actorRunId: proof.runId, requestId: String(body.clientRequestId),
      summary: body.summary, clientPullProof: { owner: proof, actor: req.actor },
    }));
  });

  router.post("/agents/me/local-runs/:runId/finish", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    if (!["succeeded", "failed", "cancelled"].includes(String(body.outcome ?? ""))) throw badRequest("Invalid outcome");
    if (body.processStopped !== true) throw badRequest("processStopped must be true");
    onlyFields(body, [...ownerFields.slice(0, 3), "outcome", "exitCode", "processStopped", "clientRequestId", "summary"]);
    return res.json(await leases.finish({
      ...owner(req, body),
      outcome: body.outcome as "succeeded" | "failed" | "cancelled",
      exitCode: body.exitCode === null ? null : Number(body.exitCode),
      processStopped: true,
      ...(body.clientRequestId !== undefined ? { clientRequestId: String(body.clientRequestId) } : {}),
      ...(body.summary !== undefined ? { summary: body.summary as string } : {}),
    }));
  });

  router.post("/agents/me/local-runs/:runId/events", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    onlyFields(body, [...ownerFields, "clientRequestId", "stream", "level", "message"]);
    const event = await leases.appendFencedEvent({
      ...owner(req, body), issueId: String(body.issueId ?? ""),
      clientRequestId: String(body.clientRequestId ?? ""),
      stream: body.stream as "stdout" | "stderr" | "system",
      level: body.level as "info" | "warn" | "error",
      message: body.message as string,
    }, req.actor);
    return res.status(201).json(event);
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

  router.post("/agents/me/local-runs/:runId/issue/review-handoff", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    onlyFields(body, [...ownerFields, "body", "reviewInteractionId", "clientRequestId"]);
    const parsed = addIssueCommentSchema.pick({ body: true, clientRequestId: true }).parse(body);
    if (!parsed.clientRequestId) throw badRequest("clientRequestId is required");
    const result = await leases.reviewFencedIssue({
      ...owner(req, body), issueId: String(body.issueId ?? ""),
      body: parsed.body, clientRequestId: parsed.clientRequestId,
      reviewInteractionId: String(body.reviewInteractionId ?? ""),
    }, req.actor);
    return res.status(result.replayed ? 200 : 201).json(result);
  });

  router.post("/agents/me/local-runs/:runId/issue/review-confirmation", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    onlyFields(body, [...ownerFields, "prompt", "clientRequestId", "reviewerAgentId"]);
    const result = await leases.createFencedReviewConfirmation({
      ...owner(req, body), issueId: String(body.issueId ?? ""),
      prompt: body.prompt as string, clientRequestId: body.clientRequestId as string,
      ...(body.reviewerAgentId !== undefined ? { reviewerAgentId: body.reviewerAgentId as string } : {}),
    }, req.actor);
    return res.status(result.replayed ? 200 : 201).json(result);
  });

  router.post("/agents/me/local-runs/:runId/issue/completion-review-handoff", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    onlyFields(body, [...ownerFields, "reviewerAgentId", "prompt", "body", "clientRequestId"]);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(String(body.issueId ?? "")) ||
      !uuid.test(String(body.reviewerAgentId ?? "")) ||
      !uuid.test(String(body.clientRequestId ?? "")) ||
      typeof body.prompt !== "string" || typeof body.body !== "string") {
      throw badRequest("Issue, reviewer, request, prompt and handoff summary are required");
    }
    const result = await leases.createFencedCompletionReviewHandoff({
      ...owner(req, body), issueId: String(body.issueId),
      reviewerAgentId: String(body.reviewerAgentId),
      prompt: body.prompt, body: body.body,
      clientRequestId: String(body.clientRequestId),
    }, req.actor);
    return res.status(result.replayed ? 200 : 201).json({
      issueId: result.issue.id, status: result.issue.status,
      statusVersion: result.issue.statusVersion,
      reviewId: result.review.id, interactionId: result.interaction.id,
      deliveryId: result.delivery.id, replayed: result.replayed,
    });
  });

  router.post("/agents/me/local-runs/:runId/issue/child-complete", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = objectBody(req.body);
    onlyFields(body, [...ownerFields, "summary", "expectedStatusVersion", "clientRequestId"]);
    const result = await leases.completeFencedChildWorkRecord({
      ...owner(req, body), issueId: String(body.issueId ?? ""),
      summary: body.summary as string,
      expectedStatusVersion: body.expectedStatusVersion as number,
      clientRequestId: String(body.clientRequestId ?? ""),
    }, req.actor);
    return res.status(result.replayed ? 200 : 201).json(result);
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
