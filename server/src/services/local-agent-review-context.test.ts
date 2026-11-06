import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentApiKeys, agentWakeupRequests, agents, companies, createDb, getEmbeddedPostgresTestSupport,
  heartbeatRuns, issueThreadInteractions, issues, localAgentDeviceBindings,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { localAgentRunRoutes } from "../routes/local-agent-runs.js";
import { localAgentRunWriteGate } from "../middleware/local-agent-run-write-gate.js";
import { localAgentRunLeaseService } from "./local-agent-run-leases.js";
import { localAgentReviewDeliveryService } from "./local-agent-review-delivery.js";
import { localAgentReviewContextService } from "./local-agent-review-context.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

suite("local reviewer context (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-review-context-");
      db = createDb(temporary.connectionString);
    }
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID();
    const sourceAgentId = randomUUID(), reviewerAgentId = randomUUID();
    const sourceRunId = randomUUID(), sourceKeyId = randomUUID();
    const reviewerKeyId = randomUUID(), deviceId = "reviewer-context-001";
    await db.insert(companies).values({ id: companyId,
      name: "Review context", issuePrefix: `RC${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: sourceAgentId, companyId, name: "Source agent", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
      { id: reviewerAgentId, companyId, name: "Reviewer agent", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
    ]);
    await db.insert(agentApiKeys).values([
      { id: sourceKeyId, companyId, agentId: sourceAgentId,
        name: "Source key", keyHash: randomUUID() },
      { id: reviewerKeyId, companyId, agentId: reviewerAgentId,
        name: "Reviewer key", keyHash: randomUUID() },
    ]);
    await db.insert(localAgentDeviceBindings).values([
      { companyId, agentId: sourceAgentId, keyId: sourceKeyId,
        deviceId: "source-context-001" },
      { companyId, agentId: reviewerAgentId, keyId: reviewerKeyId, deviceId },
    ]);
    await db.insert(issues).values({ id: issueId, companyId,
      title: "Review this delivery", description: "Acceptance criteria",
      status: "todo", assigneeAgentId: sourceAgentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId,
      companyId, agentId: sourceAgentId, status: "queued",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
    const leases = localAgentRunLeaseService(db);
    const source = await leases.claim({ companyId, agentId: sourceAgentId,
      keyId: sourceKeyId, deviceId: "source-context-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const sourceOwner = { companyId, agentId: sourceAgentId, keyId: sourceKeyId,
      deviceId: "source-context-001", runId: sourceRunId,
      leaseId: source!.leaseId, generation: source!.generation };
    const handoff = await leases.createFencedCompletionReviewHandoff({
      ...sourceOwner, issueId, reviewerAgentId,
      prompt: "Check the acceptance criteria", body: "Implementation is ready",
      clientRequestId: randomUUID(),
    }, { type: "agent", source: "agent_key", companyId,
      agentId: sourceAgentId, keyId: sourceKeyId });
    await leases.finish({ ...sourceOwner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    const queued = await localAgentReviewDeliveryService(db).deliver(handoff.delivery.id);
    const claim = await leases.claim({ companyId, agentId: reviewerAgentId,
      keyId: reviewerKeyId, deviceId, idempotencyKey: randomUUID() });
    expect(claim?.runId).toBe(queued.run.id);
    const owner = { companyId, agentId: reviewerAgentId, keyId: reviewerKeyId,
      deviceId, runId: queued.run.id, leaseId: claim!.leaseId,
      generation: claim!.generation };
    const actor = { type: "agent", source: "agent_key", companyId,
      agentId: reviewerAgentId, keyId: reviewerKeyId, runId: queued.run.id } as const;
    return { owner, actor, handoff, issueId, sourceKeyId,
      sourceDeviceId: "source-context-001" };
  }

  it("reads only the currently addressed review and closes after card invalidation", async () => {
    const f = await fixture();
    const context = await localAgentReviewContextService(db).read(f.owner, f.actor);
    expect(context.issue.assigneeAgentId).not.toBe(f.owner.agentId);
    expect(context.issue.description).toBe("Acceptance criteria");
    expect(context.review).toMatchObject({ id: f.handoff.review.id,
      prompt: "Check the acceptance criteria",
      handoffSummary: "Implementation is ready" });
    await createRunSecretRedactionRegistry(db).register(
      f.owner.companyId, f.handoff.review.sourceRunId, "Acceptance criteria");
    const redacted = await localAgentReviewContextService(db).read(f.owner, f.actor);
    expect(redacted.issue.description).not.toContain("Acceptance criteria");
    await expect(localAgentReviewContextService(db).read({ ...f.owner,
      deviceId: "another-device-001" }, f.actor)).rejects.toMatchObject({ status: 409 });
    await db.update(issueThreadInteractions).set({ status: "cancelled" })
      .where(eq(issueThreadInteractions.id, f.handoff.interaction.id));
    await expect(localAgentReviewContextService(db).read(f.owner, f.actor))
      .rejects.toMatchObject({ status: 409 });
  }, 30_000);

  it("exposes the review context only to the bound local agent route", async () => {
    const f = await fixture();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = f.actor; next(); });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((error: { status?: number; message?: string }, _req: Request,
      res: Response, _next: NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    const path = `/api/agents/me/local-runs/${f.owner.runId}/review-context`;
    const query = { deviceId: f.owner.deviceId, leaseId: f.owner.leaseId,
      generation: f.owner.generation };
    const response = await request(app).get(path).query(query).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.review.id).toBe(f.handoff.review.id);
    await request(app).get(path).query({ ...query, generation: 99 }).expect(409);
    await expect(localAgentReviewContextService(db).read(f.owner, {
      ...f.actor, agentId: randomUUID(),
    })).rejects.toMatchObject({ status: 403 });

    const decisionPath = `/api/agents/me/local-runs/${f.owner.runId}/review-accept`;
    const decisionBody = { ...query, issueId: f.issueId,
      reviewId: f.handoff.review.id, clientRequestId: randomUUID(),
      summary: "Acceptance criteria verified" };
    await request(app).post(decisionPath).send({ ...decisionBody,
      generation: 99 }).expect(409);
    const accepted = await request(app).post(decisionPath).send(decisionBody).expect(200);
    expect(accepted.body).toMatchObject({ outcome: "accepted",
      reviewId: f.handoff.review.id, requestId: decisionBody.clientRequestId });
    expect((await db.select({ status: issues.status }).from(issues)
      .where(eq(issues.id, f.issueId)))[0]?.status).toBe("done");
    const replay = await request(app).post(decisionPath).send(decisionBody).expect(200);
    expect(replay.body).toEqual(accepted.body);
    await request(app).post(decisionPath).send({ ...decisionBody,
      clientRequestId: randomUUID() }).expect(409);
  }, 30_000);

  it("rejects through the fenced route and returns the task to its local source agent", async () => {
    const f = await fixture();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = f.actor; next(); });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((error: { status?: number; message?: string }, _req: Request,
      res: Response, _next: NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    const path = `/api/agents/me/local-runs/${f.owner.runId}/review-reject`;
    const body = { deviceId: f.owner.deviceId, leaseId: f.owner.leaseId,
      generation: f.owner.generation, issueId: f.issueId,
      reviewId: f.handoff.review.id, clientRequestId: randomUUID(),
      summary: "Acceptance criterion is missing" };
    await request(app).post(path).send({ ...body, generation: 99 }).expect(409);
    const rejected = await request(app).post(path).send(body).expect(200);
    expect(rejected.body).toMatchObject({ outcome: "rejected",
      reviewId: f.handoff.review.id, requestId: body.clientRequestId });
    expect((await db.select({ status: issues.status }).from(issues)
      .where(eq(issues.id, f.issueId)))[0]?.status).toBe("todo");
    const sourceWake = (await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.owner.companyId)))
      .find((wake) => wake.reason === "issue_completion_review_rejected");
    expect(sourceWake?.agentId).toBe(f.handoff.review.sourceAgentId);
    expect((await localAgentRunLeaseService(db).control(f.owner)).action).toBe("continue");
    expect(await localAgentRunLeaseService(db).claim({
      companyId: f.owner.companyId, agentId: f.handoff.review.sourceAgentId,
      keyId: f.sourceKeyId, deviceId: f.sourceDeviceId,
      idempotencyKey: randomUUID(),
    })).toBeNull();
    await localAgentRunLeaseService(db).finish({ ...f.owner, outcome: "succeeded",
      exitCode: 0, processStopped: true, clientRequestId: randomUUID() });
    const sourceClaim = await localAgentRunLeaseService(db).claim({
      companyId: f.owner.companyId, agentId: f.handoff.review.sourceAgentId,
      keyId: f.sourceKeyId, deviceId: f.sourceDeviceId,
      idempotencyKey: randomUUID(),
    });
    expect(sourceClaim?.runId).toBe(sourceWake?.runId);
    expect((await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, sourceWake!.id)))[0]?.status).toBe("claimed");
  }, 30_000);
});
