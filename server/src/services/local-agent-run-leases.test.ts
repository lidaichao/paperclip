import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agentApiKeys,
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issueRelations,
  issueCommandDeliveries,
  issueCompletionReviews,
  issueThreadInteractions,
  issues,
  localAgentRunLeases,
  localIssueCompletionCommands,
  localRunWriteReceipts,
  localRunFinishReceipts,
  localAgentDeviceBindings,
  projects,
  workRecords,
  workRecordIssueLinks,
  workRecordQualityCycles,
  workRecordQualityItems,
  workRecordQualityVerdicts,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { localAgentRunLeaseService } from "./local-agent-run-leases.js";
import { workRecordQualityService } from "./work-record-quality.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { localAgentReviewDeliveryService } from "./local-agent-review-delivery.js";
import { issueCompletionReviewDecisionService } from "./issue-completion-review-decisions.js";
import { clientPullCompletionReviewWakeKey } from "./local-agent-review-claim.js";
import { issueCommandDeliveryService } from "./issue-command-deliveries.js";
import { localAgentDeviceBindingService } from "./local-agent-device-bindings.js";
import { accessService } from "./access.js";
import { heartbeatService } from "./heartbeat.js";
import { agentService } from "./agents.js";
import { issueService } from "./issues.js";
import { updateAgentSchema } from "@paperclipai/shared";
import { localAgentRunWriteGate } from "../middleware/local-agent-run-write-gate.js";
import { localAgentRunRoutes } from "../routes/local-agent-runs.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

suite("local client-pull run ownership (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-local-run-leases-");
      db = createDb(temporary.connectionString);
    }
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Local run lease fixture",
      issuePrefix: `L${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Desktop agent",
      adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" },
    });
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({
      id: keyId, companyId, agentId, name: "Desktop test key", keyHash: randomUUID(),
    });
    await db.insert(localAgentDeviceBindings).values({
      companyId, agentId, keyId, deviceId: "device-desktop-001",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Owned task",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    return { companyId, agentId, issueId, runId, keyId };
  }

  it("creates one run-fenced child and rejects a changed retry or expired lease", async () => {
    const scope = await fixture();
    const projectId = randomUUID();
    const childAgentId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: scope.companyId,
      name: "Delegation project" });
    await db.update(agents).set({ role: "ceo" }).where(eq(agents.id, scope.agentId));
    await db.insert(agents).values({ id: childAgentId, companyId: scope.companyId,
      name: "Rabbit", reportsTo: scope.agentId, adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" } });
    await db.update(issues).set({ projectId }).where(eq(issues.id, scope.issueId));
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const command = { ...scope, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation,
      title: "G0 baseline", description: "Inspect the current source and report evidence",
      assigneeAgentId: childAgentId, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    await expect(svc.createFencedSubtask({ ...command,
      assigneeAgentId: scope.agentId, clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.createFencedSubtask({ ...command,
      assigneeAgentId: randomUUID(), clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 403 });
    const [first, concurrent] = await Promise.all([
      svc.createFencedSubtask(command, actor),
      svc.createFencedSubtask(command, actor),
    ]);
    expect([first.replayed, concurrent.replayed].sort()).toEqual([false, true]);
    expect(concurrent.child.id).toBe(first.child.id);
    expect(first.child).toMatchObject({ parentId: scope.issueId, projectId,
      assigneeAgentId: childAgentId, createdByAgentId: scope.agentId });
    const replay = await svc.createFencedSubtask(command, actor);
    expect(replay).toMatchObject({ replayed: true,
      child: { id: first.child.id } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { ...actor, runId: scope.runId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request,
      res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const route = `/api/agents/me/local-runs/${scope.runId}/subtasks`;
    const payload = { deviceId: command.deviceId, leaseId: command.leaseId,
      generation: command.generation, issueId: scope.issueId,
      title: command.title, description: command.description,
      assigneeAgentId: childAgentId, clientRequestId: command.clientRequestId };
    await request(app).post(route).send(payload).expect(403);
    const routed = await request(app).post(route)
      .set("X-Paperclip-Run-Id", scope.runId).send(payload).expect(200);
    expect(routed.body).toMatchObject({ replayed: true, child: { id: first.child.id } });
    await expect(svc.createFencedSubtask({ ...command, title: "Changed" }, actor))
      .rejects.toMatchObject({ status: 409 });
    const children = await db.select({ id: issues.id }).from(issues)
      .where(eq(issues.parentId, scope.issueId));
    expect(children).toHaveLength(1);
    await db.update(localAgentRunLeases).set({ expiresAt: new Date(0) })
      .where(eq(localAgentRunLeases.runId, scope.runId));
    await expect(svc.createFencedSubtask({ ...command, clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 403 });
  });

  async function dedicatedReviewFixture() {
    const scope = await fixture();
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId: scope.companyId,
      name: "Local reviewer", adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" } });
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const owner = { ...scope, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    const handoff = await svc.createFencedCompletionReviewHandoff({ ...owner,
      reviewerAgentId, prompt: "Verify", body: "Ready for acceptance",
      clientRequestId: randomUUID() }, actor);
    return { scope, owner, svc, handoff };
  }

  it("keeps the quality cycle, issue and review card unchanged when native policy re-pends defect QA", async () => {
    const f = await dedicatedReviewFixture();
    const projectId = randomUUID(), defectId = randomUUID(), cycleId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.scope.companyId,
      name: "Native QA policy mismatch" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.scope.issueId));
    const policy = normalizeIssueExecutionPolicy({ mode: "normal",
      commentRequired: true, maxReviewRounds: 3,
      stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent",
          agentId: f.handoff.review.reviewerAgentId }] }],
    });
    const staged = applyIssueExecutionPolicyTransition({
      issue: { ...issue, status: "in_progress" }, policy,
      requestedStatus: "done", requestedAssigneePatch: {},
      actor: { agentId: f.scope.agentId, userId: null },
      allowBoardOverride: false, commentBody: "Repair ready for QA",
    });
    expect(staged.patch.status).toBe("in_review");
    // Completion-review handoff retains the source assignee while the native
    // execution policy names QA as the pending stage participant.
    await db.update(issues).set({ projectId,
      executionPolicy: policy as unknown as Record<string, unknown>,
      executionState: staged.patch.executionState as Record<string, unknown>,
    }).where(eq(issues.id, issue.id));
    await db.insert(workRecords).values({ id: defectId,
      companyId: f.scope.companyId, projectId, kind: "defect",
      title: "QA must not close early", assigneeAgentId: f.scope.agentId,
      qaAssigneeAgentId: f.handoff.review.reviewerAgentId,
      dispatchState: "dispatched" });
    const [link] = await db.insert(workRecordIssueLinks).values({
      companyId: f.scope.companyId, projectId, recordId: defectId,
      issueId: issue.id, purpose: "primary", dispatchRound: 1,
    }).returning();
    await db.insert(workRecordQualityCycles).values({ id: cycleId,
      companyId: f.scope.companyId, projectId, aggregateRecordId: defectId,
      cycleNumber: 1, kind: "independent_defect", state: "open",
      qualityPhase: "qa_retest", scopeDigest: randomUUID() });
    const [qaItem] = await db.insert(workRecordQualityItems).values({
      companyId: f.scope.companyId, projectId, cycleId,
      recordId: defectId, defectRecordId: defectId,
      issueLinkId: link.id, role: "qa", state: "active",
    }).returning();
    const [beforeIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(beforeIssue.executionState).toMatchObject({ status: "pending",
      currentParticipant: { agentId: f.handoff.review.reviewerAgentId } });
    expect(beforeIssue.assigneeAgentId).toBe(f.scope.agentId);
    const [beforeCycle] = await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, cycleId));
    const quality = workRecordQualityService(db, { writesEnabled: true });
    for (const outcome of ["pass", "return"] as const) {
      await expect(quality.recordQaVerdict(f.scope.companyId, projectId, defectId, {
        workflowVersion: 2, clientRequestId: randomUUID(),
        requestPayloadDigest: randomUUID(), cycleId, itemId: qaItem.id,
        expectedCycleRevision: beforeCycle.revision, outcome,
        defectRecordId: defectId, repairRecordId: outcome === "return" ? defectId : null,
        reason: "Native stage has not finished", evidenceRefs: [],
      }, { actorType: "agent", actorId: f.handoff.review.reviewerAgentId,
        agentId: f.handoff.review.reviewerAgentId })).rejects.toMatchObject({
          status: 409, details: { code: "work_record_quality_native_review_pending" },
        });
      const [afterIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
      const [afterCycle] = await db.select().from(workRecordQualityCycles)
        .where(eq(workRecordQualityCycles.id, cycleId));
      const [afterItem] = await db.select().from(workRecordQualityItems)
        .where(eq(workRecordQualityItems.id, qaItem.id));
      expect(afterIssue).toMatchObject({ status: beforeIssue.status,
        statusVersion: beforeIssue.statusVersion,
        assigneeAgentId: beforeIssue.assigneeAgentId,
        executionState: beforeIssue.executionState });
      expect(afterCycle).toMatchObject({ state: beforeCycle.state,
        qualityPhase: beforeCycle.qualityPhase, revision: beforeCycle.revision });
      expect(afterItem.state).toBe("active");
      expect((await db.select().from(issueCompletionReviews)
        .where(eq(issueCompletionReviews.id, f.handoff.review.id)))[0]?.state).toBe("pending");
      expect((await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, f.handoff.interaction.id)))[0]?.status).toBe("pending");
      expect(await db.select().from(workRecordQualityVerdicts)
        .where(eq(workRecordQualityVerdicts.cycleId, cycleId))).toHaveLength(0);
    }
  }, 30_000);

  async function claimedReviewerFixture() {
    const f = await dedicatedReviewFixture();
    await f.svc.finish({ ...f.owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    const { run } = await localAgentReviewDeliveryService(db)
      .deliver(f.handoff.delivery.id);
    const keyId = randomUUID(), deviceId = "reviewer-finish-001";
    await db.insert(agentApiKeys).values({ id: keyId,
      companyId: f.scope.companyId, agentId: f.handoff.review.reviewerAgentId,
      name: "Reviewer finish key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId: f.scope.companyId,
      agentId: f.handoff.review.reviewerAgentId, keyId, deviceId });
    const claim = await f.svc.claim({ companyId: f.scope.companyId,
      agentId: f.handoff.review.reviewerAgentId, keyId, deviceId,
      idempotencyKey: randomUUID() });
    const reviewerOwner = { companyId: f.scope.companyId,
      agentId: f.handoff.review.reviewerAgentId, keyId, deviceId,
      runId: run.id, leaseId: claim!.leaseId, generation: claim!.generation };
    const proof = { owner: reviewerOwner, actor: { type: "agent" as const,
      source: "agent_key" as const, companyId: f.scope.companyId,
      agentId: reviewerOwner.agentId, keyId, runId: run.id } };
    return { ...f, reviewerOwner, proof };
  }

  it("refuses a client-pull claim without a registered credential binding", async () => {
    const scope = await fixture();
    await expect(localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "unregistered-device-001", keyId: randomUUID(),
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ status: 403 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(run.status).toBe("queued");
  });

  it("revokes an active device and lets a new key rebind without inheriting its old lease", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const bindings = localAgentDeviceBindingService(db);
    const deviceId = "device-desktop-001";
    const claimed = await svc.claim({ ...scope, deviceId, idempotencyKey: randomUUID() });
    const oldOwner = { ...scope, deviceId, leaseId: claimed!.leaseId,
      generation: claimed!.generation };
    const [oldBinding] = await db.select().from(localAgentDeviceBindings)
      .where(eq(localAgentDeviceBindings.keyId, scope.keyId));
    const replacementKeyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: replacementKeyId, companyId: scope.companyId,
      agentId: scope.agentId, name: "Replacement key", keyHash: randomUUID() });
    await expect(bindings.bind({ ...scope, keyId: replacementKeyId, deviceId }))
      .rejects.toMatchObject({ status: 409 });
    await bindings.revoke({ ...scope, bindingId: oldBinding.id });
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, scope.runId));
    expect(lease.cancelRequestedAt).not.toBeNull();
    expect((await svc.control(oldOwner)).action).toBe("cancel");
    expect((await svc.renew(oldOwner)).cancelRequested).toBe(true);
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    await expect(svc.addFencedComment({ ...oldOwner, issueId: scope.issueId,
      body: "After device revocation", clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 403 });
    const replacement = await bindings.bind({ ...scope, keyId: replacementKeyId, deviceId });
    expect(replacement.revokedAt).toBeNull();
    await expect(svc.renew({ ...oldOwner, keyId: replacementKeyId }))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.control({ ...oldOwner, keyId: replacementKeyId }))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.finish({ ...oldOwner, keyId: replacementKeyId,
      outcome: "cancelled", exitCode: null, processStopped: true }))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.finish({ ...oldOwner, outcome: "succeeded",
      exitCode: 0, processStopped: true })).rejects.toMatchObject({ status: 409 });
    expect((await svc.finish({ ...oldOwner, outcome: "cancelled",
      exitCode: null, processStopped: true })).status).toBe("cancelled");
    await expect(bindings.bind({ ...scope, keyId: scope.keyId,
      deviceId: "other-approved-device" })).rejects.toMatchObject({ status: 409 });
  });

  it("serializes claim and device revocation across database pools", async () => {
    const scope = await fixture();
    const [binding] = await db.select().from(localAgentDeviceBindings)
      .where(eq(localAgentDeviceBindings.keyId, scope.keyId));
    const second = createDb(external ?? temporary!.connectionString);
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    try {
      const gate = db.transaction(async (tx) => {
        await tx.select().from(agents).where(eq(agents.id, scope.agentId)).for("update");
        locked();
        await hold;
      });
      await ready;
      const claim = localAgentRunLeaseService(db).claim({
        ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
      });
      const revoke = localAgentDeviceBindingService(second).revoke({
        ...scope, bindingId: binding.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      release();
      await gate;
      const [claimResult, revokeResult] = await Promise.allSettled([claim, revoke]);
      expect(revokeResult.status).toBe("fulfilled");
      if (claimResult.status === "rejected") {
        expect(claimResult.reason).toMatchObject({ status: 403 });
      }
      const [after] = await db.select().from(localAgentDeviceBindings)
        .where(eq(localAgentDeviceBindings.id, binding.id));
      expect(after.revokedAt).not.toBeNull();
      const leases = await db.select().from(localAgentRunLeases)
        .where(eq(localAgentRunLeases.runId, scope.runId));
      if (leases.length) expect(leases[0]!.cancelRequestedAt).not.toBeNull();
    } finally {
      release?.();
      await second.$client.end();
    }
  }, 30_000);

  it("limits device management HTTP routes to an authorized company administrator and audits changes", async () => {
    const scope = await fixture();
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: keyId, companyId: scope.companyId,
      agentId: scope.agentId, name: "Second device key", keyHash: randomUUID() });
    function appFor(actor: Request["actor"]) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use(localAgentRunWriteGate(db));
      app.use("/api", localAgentRunRoutes(db));
      app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
        res.status(err.status ?? 500).json({ error: err.message });
      });
      return app;
    }
    const path = `/api/agents/${scope.agentId}/local-devices`;
    const payload = { keyId, deviceId: "device-desktop-002" };
    const admin = appFor({ type: "board", source: "session", userId: "device-admin",
      companyIds: [scope.companyId], isInstanceAdmin: true });
    const viewer = appFor({ type: "board", source: "session", userId: "viewer",
      companyIds: [scope.companyId], memberships: [{ companyId: scope.companyId,
        membershipRole: "viewer", status: "active" }] });
    const outsider = appFor({ type: "board", source: "session", userId: "other-admin",
      companyIds: [], isInstanceAdmin: true });
    const agent = appFor({ type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId });
    await request(outsider).post(path).send(payload).expect(404);
    await request(viewer).post(path).send(payload).expect(403);
    await request(agent).post(path).send(payload).expect(403);
    await request(admin).post(path).send({ ...payload, createdByUserId: "spoofed" }).expect(400);
    const created = await request(admin).post(path).send(payload).expect(201);
    expect(created.body.keyId).toBe(keyId);
    expect(created.body.createdByUserId).toBe("device-admin");
    const listed = await request(admin).get(path).expect(200);
    expect(listed.body).toHaveLength(2);
    const revoked = await request(admin).delete(`${path}/${created.body.id}`).expect(200);
    expect(revoked.body.revokedByUserId).toBe("device-admin");
    const events = (await db.select().from(activityLog).where(eq(activityLog.entityId, scope.agentId)))
      .filter((event) => event.action.startsWith("agent.local_device_"));
    expect(events.map((event) => event.action).sort()).toEqual([
      "agent.local_device_bound", "agent.local_device_revoked",
    ]);
    expect(events.every((event) => event.actorId === "device-admin")).toBe(true);
  }, 30_000);

  it("allows a company owner with explicit agent-management permission to bind a device", async () => {
    const scope = await fixture();
    const userId = "device-company-owner";
    const access = accessService(db);
    await access.setPrincipalPermission(scope.companyId, "user", userId,
      "agents:create", true, null);
    await access.ensureMembership(scope.companyId, "user", userId, "owner", "active");
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: keyId, companyId: scope.companyId,
      agentId: scope.agentId, name: "Owner approved key", keyHash: randomUUID() });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId,
        companyIds: [scope.companyId], memberships: [{ companyId: scope.companyId,
          membershipRole: "owner", status: "active" }] };
      next();
    });
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const response = await request(app).post(`/api/agents/${scope.agentId}/local-devices`)
      .send({ keyId, deviceId: "device-desktop-002" }).expect(201);
    expect(response.body.createdByUserId).toBe(userId);
  }, 30_000);

  it("atomically admits one device and replays the same idempotency key after a service restart", async () => {
    const scope = await fixture();
    const first = localAgentRunLeaseService(db);
    const key = randomUUID();
    const input = { ...scope, deviceId: "device-desktop-001", idempotencyKey: key };
    const otherInput = { ...scope, deviceId: "device-desktop-002", idempotencyKey: randomUUID() };
    const raced = await Promise.allSettled([
      first.claim(input),
      first.claim(otherInput),
    ]);
    const winners = raced.filter((result) => result.status === "fulfilled" && result.value !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0] as PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof first.claim>>>>;
    expect(winner.value.runId).toBe(scope.runId);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(run.status).toBe("running");
    expect(run.runtimeMode).toBe("client_pull");
    expect(issue.executionRunId).toBe(scope.runId);
    expect(issue.status).toBe("in_progress");
    expect(issue.statusVersion).toBe(1);
    const secondService = localAgentRunLeaseService(db);
    const replay = await secondService.claim(raced[0].status === "fulfilled" ? input : otherInput);
    expect(replay?.leaseId).toBe(winner.value.leaseId);
    expect(replay?.generation).toBe(1);
    const rows = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(rows).toHaveLength(1);
  });

  it("continues past twenty ineligible queued runs instead of starving a ready task", async () => {
    const scope = await fixture();
    await db.insert(heartbeatRuns).values(Array.from({ length: 20 }, (_, index) => ({
      id: randomUUID(), companyId: scope.companyId, agentId: scope.agentId,
      status: "queued" as const,
      createdAt: new Date(Date.now() - 120_000 + index),
      contextSnapshot: { wakeReason: "no_issue" },
    })));
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    expect(claimed?.runId).toBe(scope.runId);
  });

  it("serializes server admission with a concurrent mode switch and desktop claim across DB pools", async () => {
    const scope = await fixture();
    const second = createDb(external ?? temporary!.connectionString);
    try {
      await db.update(agents).set({ runtimeConfig: { executionMode: "server" } })
        .where(eq(agents.id, scope.agentId));
      const [queuedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      let signalLocked!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
      const released = new Promise<void>((resolve) => { releaseLock = resolve; });
      const modeSwitch = db.transaction(async (tx) => {
        await tx.select().from(agents).where(eq(agents.id, scope.agentId)).for("update");
        signalLocked();
        await released;
        await tx.update(agents).set({ runtimeConfig: { executionMode: "client_pull" } })
          .where(eq(agents.id, scope.agentId));
      });
      await locked;
      const serverAdmission = second.transaction((tx) =>
        heartbeatService(second).serverRunClaimAdmission(tx as unknown as typeof second, queuedRun));
      const stillWaiting = await Promise.race([
        serverAdmission.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 40)),
      ]);
      expect(stillWaiting).toBe(true);
      releaseLock();
      await modeSwitch;
      const desktopClaim = localAgentRunLeaseService(db).claim({
        ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
      });
      expect(await serverAdmission).toBe(false);
      expect((await desktopClaim)?.runId).toBe(scope.runId);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      expect(run.runtimeMode).toBe("client_pull");
      expect(run.status).toBe("running");
    } finally {
      await second.$client.end();
    }
  });

  it("does not renew an expired lease or reassign before stop acknowledgement", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    expect(claimed).not.toBeNull();
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId, generation: claimed!.generation };
    await db.update(localAgentRunLeases).set({ expiresAt: new Date(0) }).where(eq(localAgentRunLeases.runId, scope.runId));
    await expect(svc.renew(owner)).rejects.toMatchObject({ status: 409 });
    expect((await svc.control(owner)).action).toBe("cancel");
    const [afterControl] = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(afterControl.cancelRequestedAt).not.toBeNull();
    await expect(svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.finish({ ...owner, outcome: "succeeded", exitCode: 0, processStopped: true }))
      .rejects.toMatchObject({ status: 409 });
    const finished = await svc.finish({ ...owner, outcome: "cancelled", exitCode: null, processStopped: true });
    expect(finished.status).toBe("cancelled");
    const [lease] = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(lease.stopAcknowledgedAt).not.toBeNull();
    expect(lease.releasedAt).not.toBeNull();
  });

  it("rejects success after cancellation and rejects a stale generation", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId, generation: claimed!.generation };
    await expect(svc.renew({ ...owner, generation: owner.generation + 1 })).rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    expect((await svc.renew(owner)).cancelRequested).toBe(true);
    await expect(svc.finish({ ...owner, outcome: "succeeded", exitCode: 0, processStopped: true }))
      .rejects.toMatchObject({ status: 409 });
    expect((await svc.finish({ ...owner, outcome: "cancelled", exitCode: null, processStopped: true })).status)
      .toBe("cancelled");
    expect((await svc.finish({ ...owner, outcome: "cancelled", exitCode: null, processStopped: true })).status)
      .toBe("cancelled");
  });

  it("persists bounded run events and a finish summary under the same lease identity", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, issueId: scope.issueId, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
    const event = { ...owner, clientRequestId: randomUUID(), stream: "stdout" as const,
      level: "info" as const, message: "Executed local step" };
    const first = await svc.appendFencedEvent(event, actor);
    expect(first.seq).toBe(1);
    expect((await svc.appendFencedEvent(event, actor)).id).toBe(first.id);
    await expect(svc.appendFencedEvent({ ...event, message: "Changed intent" }, actor))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.appendFencedEvent({ ...event, clientRequestId: randomUUID(), message: "字".repeat(3000) }, actor))
      .rejects.toMatchObject({ status: 400 });
    await expect(svc.appendFencedEvent({ ...event, issueId: randomUUID(), clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 403 });
    const finish = { ...owner, outcome: "succeeded" as const, exitCode: 0,
      processStopped: true as const, clientRequestId: randomUUID(), summary: "Finished test work" };
    expect((await svc.finish(finish)).status).toBe("succeeded");
    expect((await svc.finish(finish)).status).toBe("succeeded");
    await expect(svc.finish({ ...finish, summary: "Changed summary" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.appendFencedEvent({ ...event, clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 409 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(run.resultJson?.localWorkerFinish).toMatchObject({
      clientRequestId: finish.clientRequestId, outcome: "succeeded", exitCode: 0,
      summary: "Finished test work",
    });
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, scope.runId)))
      .toHaveLength(1);
  });

  it("reconciles a lost finish response only from its immutable scoped receipt", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const requestId = randomUUID();
    const finish = { ...owner, outcome: "failed" as const, exitCode: 1,
      processStopped: true as const, clientRequestId: requestId, summary: "Local failure" };
    const digest = createHash("sha256").update(JSON.stringify({ kind: "finish",
      runId: scope.runId, issueId: scope.issueId, agentId: scope.agentId,
      deviceId: owner.deviceId, canonicalContent: JSON.stringify({ outcome: "failed",
        exitCode: 1, processStopped: true, summary: "Local failure" }),
    })).digest("hex");
    const lookup = { ...owner, clientRequestId: requestId, requestDigest: digest };
    expect((await svc.readFencedFinishReceipt(lookup)).state).toBe("unknown");
    expect((await svc.finish(finish)).status).toBe("failed");
    const receipt = await svc.readFencedFinishReceipt(lookup);
    expect(receipt).toMatchObject({ state: "committed", outcome: "failed", runStatus: "failed" });
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request,
      res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const response = await request(app).get(`/api/agents/me/local-runs/${scope.runId}/finish-receipt`)
      .query({ deviceId: owner.deviceId, leaseId: owner.leaseId,
        generation: owner.generation, issueId: scope.issueId,
        clientRequestId: requestId, requestDigest: digest }).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ state: "committed", receiptId: expect.any(String) });
    expect(await db.select().from(localRunFinishReceipts)
      .where(eq(localRunFinishReceipts.runId, scope.runId))).toHaveLength(1);
    await expect(svc.readFencedFinishReceipt({ ...lookup, requestDigest: "a".repeat(64) }))
      .rejects.toMatchObject({ status: 409 });
    expect((await svc.readFencedFinishReceipt({ ...lookup, clientRequestId: randomUUID() }))
      .state).toBe("not_committed");
    await expect(svc.readFencedFinishReceipt({ ...lookup, issueId: randomUUID() }))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.readFencedFinishReceipt({ ...lookup, generation: owner.generation + 1 }))
      .rejects.toMatchObject({ status: 403 });
    await db.update(localAgentDeviceBindings).set({ revokedAt: new Date() })
      .where(eq(localAgentDeviceBindings.keyId, scope.keyId));
    await expect(svc.readFencedFinishReceipt(lookup)).rejects.toMatchObject({ status: 403 });
  }, 30_000);

  it("does not expose a finish receipt after the finish transaction rolls back", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const requestId = randomUUID();
    const digest = createHash("sha256").update(JSON.stringify({ kind: "finish",
      runId: scope.runId, issueId: scope.issueId, agentId: scope.agentId,
      deviceId: owner.deviceId, canonicalContent: JSON.stringify({ outcome: "failed",
        exitCode: 1, processStopped: true, summary: null }),
    })).digest("hex");
    await db.execute(sql`create function reject_finish_receipt_test() returns trigger language plpgsql as $$
      begin
        raise exception 'injected finish update failure';
      end $$`);
    await db.execute(sql`create trigger reject_finish_receipt_test_trigger before update on local_agent_run_leases
      for each row execute function reject_finish_receipt_test()`);
    try {
      await expect(svc.finish({ ...owner, outcome: "failed", exitCode: 1,
        processStopped: true, clientRequestId: requestId })).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger reject_finish_receipt_test_trigger on local_agent_run_leases`);
      await db.execute(sql`drop function reject_finish_receipt_test()`);
    }
    expect(await db.select().from(localRunFinishReceipts)
      .where(eq(localRunFinishReceipts.runId, scope.runId))).toHaveLength(0);
    expect((await svc.readFencedFinishReceipt({ ...owner, clientRequestId: requestId,
      requestDigest: digest })).state).toBe("unknown");
  }, 30_000);

  it("leaves pre-migration finished runs without immutable receipts unknown", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    await db.update(localAgentRunLeases).set({ releasedAt: new Date(),
      stopAcknowledgedAt: new Date(), outcome: "failed" })
      .where(eq(localAgentRunLeases.runId, scope.runId));
    await db.update(heartbeatRuns).set({ status: "failed", exitCode: 1,
      finishedAt: new Date() }).where(eq(heartbeatRuns.id, scope.runId));
    expect((await svc.readFencedFinishReceipt({ ...owner,
      clientRequestId: randomUUID(), requestDigest: "a".repeat(64) })).state)
      .toBe("unknown");
  }, 30_000);

  it("recovers a successful source process that never made a business handoff", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const finish = { ...scope, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation,
      outcome: "succeeded" as const, exitCode: 0,
      processStopped: true as const, clientRequestId: randomUUID() };
    expect((await svc.finish(finish)).status).toBe("succeeded");
    expect((await svc.finish(finish)).status).toBe("succeeded");
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.status).toBe("blocked");
    expect(issue.executionRunId).toBeNull();
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId)))
      .filter((row) => row.action === "issue.local_run_missing_review_handoff"))
      .toHaveLength(1);

    const human = await fixture();
    const humanClaim = await svc.claim({ ...human, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "todo", statusVersion: 9 })
      .where(eq(issues.id, human.issueId));
    const [humanChanged] = await db.select().from(issues).where(eq(issues.id, human.issueId));
    await svc.finish({ ...human, deviceId: "device-desktop-001",
      leaseId: humanClaim!.leaseId, generation: humanClaim!.generation,
      outcome: "succeeded", exitCode: 0, processStopped: true,
      clientRequestId: randomUUID() });
    const [preserved] = await db.select().from(issues).where(eq(issues.id, human.issueId));
    expect(preserved.status).toBe("todo");
    expect(preserved.statusVersion).toBe(humanChanged.statusVersion);
  }, 30_000);

  it.each(["failed", "cancelled"] as const)(
    "recovers a %s source process that never made a business handoff",
    async (outcome) => {
      const scope = await fixture();
      const svc = localAgentRunLeaseService(db);
      const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
        idempotencyKey: randomUUID() });
      await db.update(issues).set({ status: "in_progress" })
        .where(eq(issues.id, scope.issueId));
      const finish = { ...scope, deviceId: "device-desktop-001",
        leaseId: claimed!.leaseId, generation: claimed!.generation,
        outcome, exitCode: outcome === "failed" ? 1 : null,
        processStopped: true as const, clientRequestId: randomUUID() };
      expect((await svc.finish(finish)).status).toBe(outcome);
      const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
      expect(issue.status).toBe("blocked");
      expect(issue.executionRunId).toBeNull();
      const activities = await db.select().from(activityLog)
        .where(eq(activityLog.entityId, scope.issueId));
      expect(activities.filter((row) => row.action === "issue.local_run_missing_review_handoff" &&
        row.details?.reason === "unsuccessful_process_without_business_handoff"))
        .toHaveLength(1);
    }, 30_000,
  );

  it("rejects new run events after a cancellation commits", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, issueId: scope.issueId, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await expect(svc.appendFencedEvent({ ...owner, clientRequestId: randomUUID(),
      stream: "stderr", level: "warn", message: "Too late" }, actor))
      .rejects.toMatchObject({ status: 409 });
    const stop = { ...owner, outcome: "cancelled" as const, exitCode: null,
      processStopped: true as const, clientRequestId: randomUUID() };
    await expect(svc.finish({ ...stop, outcome: "succeeded", exitCode: 0 }))
      .rejects.toMatchObject({ status: 409 });
    expect((await svc.finish(stop)).status).toBe("cancelled");
    expect((await svc.finish(stop)).status).toBe("cancelled");
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, scope.runId)))
      .toHaveLength(0);
  });

  it("keeps an unacknowledged cancelled issue reserved across reassignment", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const old = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const newAgentId = randomUUID();
    const newRunId = randomUUID();
    await db.insert(agents).values({
      id: newAgentId, companyId: scope.companyId, name: "Replacement desktop",
      runtimeConfig: { executionMode: "client_pull" },
    });
    const newKeyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: newKeyId, companyId: scope.companyId,
      agentId: newAgentId, name: "Replacement desktop key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId: scope.companyId,
      agentId: newAgentId, keyId: newKeyId, deviceId: "device-desktop-001" });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await db.update(issues).set({
      assigneeAgentId: newAgentId, executionRunId: null,
    }).where(eq(issues.id, scope.issueId));
    await db.insert(heartbeatRuns).values({
      id: newRunId, companyId: scope.companyId, agentId: newAgentId,
      status: "queued", contextSnapshot: { issueId: scope.issueId },
    });
    const nextInput = {
      companyId: scope.companyId, agentId: newAgentId,
      keyId: newKeyId,
      deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    };
    expect(await svc.claim(nextInput)).toBeNull();
    await svc.finish({
      companyId: scope.companyId, agentId: scope.agentId, runId: scope.runId,
      keyId: scope.keyId,
      deviceId: "device-desktop-001", leaseId: old!.leaseId, generation: old!.generation,
      outcome: "cancelled", exitCode: null, processStopped: true,
    });
    expect((await svc.claim(nextInput))?.runId).toBe(newRunId);
  });

  it("fences ordinary writes for an opted-in desktop agent", async () => {
    const scope = await fixture();
    const gate = localAgentRunWriteGate(db);
    const response = {
      status: vi.fn().mockReturnThis(), json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    const request = {
      method: "PATCH", path: `/api/issues/${scope.issueId}`,
      actor: { type: "agent", source: "agent_key", companyId: scope.companyId, agentId: scope.agentId },
    } as unknown as Request;
    await gate(request, response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "CLIENT_PULL_WRITE_FENCED" }));
    expect(next).not.toHaveBeenCalled();

    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    await svc.finish({
      ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, outcome: "succeeded", exitCode: 0,
      processStopped: true,
    });
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, scope.agentId));
    vi.mocked(response.status).mockClear();
    vi.mocked(response.json).mockClear();
    await gate(request, response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("writes a current-run comment and issue edit with the lease transaction", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
    const comment = await svc.addFencedComment({ ...owner, body: "Local execution progress" }, actor);
    expect(comment.createdByRunId).toBe(scope.runId);
    expect(comment.authorAgentId).toBe(scope.agentId);
    const replay = await svc.addFencedComment({ ...owner, body: "Local execution progress" }, actor);
    expect(replay.id).toBe(comment.id);
    await expect(svc.addFencedComment({ ...owner, body: "Different content" }, actor))
      .rejects.toMatchObject({ status: 409 });
    const updated = await svc.patchFencedIssue({ ...owner, title: "Edited from desktop" }, actor);
    expect(updated.title).toBe("Edited from desktop");
    await db.update(issues).set({ status: "in_review", executionRunId: null })
      .where(eq(issues.id, scope.issueId));
    const afterHandoffReplay = await svc.addFencedComment({ ...owner, body: "Local execution progress" }, actor);
    expect(afterHandoffReplay.id).toBe(comment.id);
    await expect(svc.addFencedComment({ ...owner, clientRequestId: randomUUID(),
      body: "Another progress update" }, actor)).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).length).toBe(1);
  });

  it("reads only the original scoped comment receipt after the visible comment changes", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, issueId: scope.issueId };
    const body = "Progress before response loss";
    const digest = createHash("sha256").update(JSON.stringify({
      kind: "comment", runId: owner.runId, issueId: owner.issueId,
      agentId: owner.agentId, deviceId: owner.deviceId, canonicalContent: body,
    })).digest("hex");
    const clientRequestId = randomUUID();
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    expect((await svc.readFencedWriteReceipt({ ...owner, kind: "comment",
      clientRequestId, requestDigest: digest })).state).toBe("unknown");
    const comment = await svc.addFencedComment({ ...owner, body, clientRequestId }, actor);
    await db.update(issueComments).set({ body: "Changed visible comment" })
      .where(eq(issueComments.id, comment.id));
    const receipt = await svc.readFencedWriteReceipt({ ...owner, kind: "comment",
      clientRequestId, requestDigest: digest });
    expect(receipt).toMatchObject({ state: "committed", kind: "comment" });
    await expect(svc.readFencedWriteReceipt({ ...owner, kind: "comment",
      clientRequestId, requestDigest: "a".repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(svc.readFencedWriteReceipt({ ...owner, deviceId: "other-desktop-001",
      kind: "comment", clientRequestId, requestDigest: digest })).rejects.toMatchObject({ status: 403 });
    await expect(svc.readFencedWriteReceipt({ ...owner, issueId: randomUUID(),
      kind: "comment", clientRequestId, requestDigest: digest })).rejects.toMatchObject({ status: 403 });
    expect((await svc.readFencedWriteReceipt({ ...owner, kind: "child_complete",
      clientRequestId, requestDigest: digest })).state).toBe("unknown");
  });

  it("rolls back comment and audit when reference projection fails, then retries the same request", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID(), body: "Reference retry" };
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
    const sync = vi.fn().mockRejectedValueOnce(new Error("projection unavailable")).mockResolvedValue(undefined);
    const svc = localAgentRunLeaseService(db, { syncCommentReferences: sync });
    await expect(svc.addFencedComment(owner, actor)).rejects.toThrow("projection unavailable");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId)))
      .toHaveLength(0);
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId)))
      .filter((event) => event.action === "issue.comment_added")).toHaveLength(0);
    const replay = await svc.addFencedComment(owner, actor);
    expect(replay.body).toBe("Reference retry");
    expect(sync).toHaveBeenCalledTimes(2);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).toHaveLength(1);
  });

  it("rolls back a pure progress comment when external-object projection fails", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID(), body: "Halfway through" };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    const svc = localAgentRunLeaseService(db, {
      syncCommentExternalObjects: async () => { throw new Error("external projection unavailable"); },
    });
    await expect(svc.addFencedComment(owner, actor)).rejects.toThrow("external projection unavailable");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId)))
      .toHaveLength(0);
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId)))
      .filter((event) => event.action === "issue.comment_added")).toHaveLength(0);
  });

  it("starts the claimed task and rejects mentions or links in progress comments", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    const svc = localAgentRunLeaseService(db);
    expect((await db.select().from(issues).where(eq(issues.id, scope.issueId)))[0].status)
      .toBe("in_progress");
    await svc.addFencedComment({ ...owner, body: "I started" }, actor);
    for (const body of ["@Luna please see", "https://example.com", "www.example.com",
      "example.com", "mailto:team@example.com"]) {
      await expect(svc.addFencedComment({ ...owner, body }, actor))
        .rejects.toMatchObject({ status: 400 });
    }
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId)))
      .toHaveLength(1);
  });

  it("rejects other issues, companies, generations, and writes after cancellation", async () => {
    const scope = await fixture();
    const other = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
    const count = async () => (await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).length;
    await expect(svc.addFencedComment({ ...owner, issueId: other.issueId, body: "cross company" }, actor))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.patchFencedIssue({ ...owner, issueId: other.issueId, title: "cross company" }, actor))
      .rejects.toMatchObject({ status: 403 });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: scope.companyId, title: "Other issue", status: "todo", assigneeAgentId: scope.agentId });
    await expect(svc.addFencedComment({ ...owner, issueId: otherIssueId, body: "cross issue" }, actor))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.addFencedComment({ ...owner, generation: owner.generation + 1, body: "stale" }, actor))
      .rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await expect(svc.addFencedComment({ ...owner, body: "after cancel" }, actor))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.patchFencedIssue({ ...owner, title: "after cancel" }, actor))
      .rejects.toMatchObject({ status: 403 });
    expect(await count()).toBe(0);
  });

  it("does not let a comment cross a concurrently committed cancellation", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
    let releaseCancellation!: () => void;
    let cancellationLocked!: () => void;
    const allowCommit = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const lockHeld = new Promise<void>((resolve) => { cancellationLocked = resolve; });
    const cancellation = db.transaction(async (tx) => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId)).for("update");
      cancellationLocked();
      await allowCommit;
      await tx.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    });
    await lockHeld;
    const lateWrite = svc.addFencedComment({ ...owner, body: "Must not escape" }, actor);
    releaseCancellation();
    await cancellation;
    await expect(lateWrite).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).toHaveLength(0);
  });

  it("honors the scheduler daily run limit before claiming a queued desktop run", async () => {
    const scope = await fixture();
    await db.update(agents).set({
      runtimeConfig: { executionMode: "client_pull", heartbeat: { maxDailyRuns: 0 } },
    }).where(eq(agents.id, scope.agentId));
    const svc = localAgentRunLeaseService(db);
    await expect(svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(run.status).toBe("queued");
  });

  it("persists executionMode through the existing agent update contract", async () => {
    const scope = await fixture();
    const parsed = updateAgentSchema.parse({ runtimeConfig: { executionMode: "client_pull" } });
    expect(parsed.runtimeConfig?.executionMode).toBe("client_pull");
    await agentService(db).update(scope.agentId, { runtimeConfig: {} });
    await agentService(db).update(scope.agentId, { runtimeConfig: parsed.runtimeConfig });
    const [stored] = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents)
      .where(eq(agents.id, scope.agentId));
    expect(stored.runtimeConfig?.executionMode).toBe("client_pull");
    expect((await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    }))?.runId).toBe(scope.runId);
  });

  it("opens only a fenced progress comment while keeping ordinary writes and edits closed", async () => {
    const scope = await fixture();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const payload = { deviceId: "device-desktop-001", leaseId: randomUUID(),
      generation: 1, issueId: scope.issueId };
    await request(app).patch(`/api/agents/me/local-runs/${scope.runId}/issue`)
      .send({ ...payload, status: "in_review", comment: "Review this" }).expect(403);
    await request(app).patch(`/api/agents/me/local-runs/${scope.runId}/issue`)
      .send({ ...payload, assigneeAgentId: randomUUID() }).expect(403);
    await request(app).post(`/api/issues/${scope.issueId}/comments`)
      .send({ body: "Ordinary write forbidden" }).expect(403);
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: payload.deviceId, idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    await request(app).post(`/api/agents/me/local-runs/${scope.runId}/comments`)
      .send({ ...payload, leaseId: claimed!.leaseId, generation: claimed!.generation,
        body: "Work is underway", clientRequestId: randomUUID() }).expect(201);
    await request(app).post(`/api/agents/me/local-runs/${scope.runId}/events`).send({
      ...payload, leaseId: claimed!.leaseId, generation: claimed!.generation,
      clientRequestId: randomUUID(), stream: "system", level: "info", message: "HTTP event",
    }).expect(201);
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.status).toBe("in_progress");
    expect(issue.assigneeAgentId).toBe(scope.agentId);
  });

  it("atomically hands an owned task to review and replays only the exact committed command", async () => {
    const scope = await fixture();
    const deviceId = "device-desktop-001";
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId, idempotencyKey: randomUUID(),
    });
    const owner = { ...scope, deviceId, leaseId: claimed!.leaseId, generation: claimed!.generation };
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const [confirmation] = await db.insert(issueThreadInteractions).values({
      companyId: scope.companyId, issueId: scope.issueId,
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      createdByAgentId: scope.agentId, sourceRunId: scope.runId,
      payload: { version: 1, prompt: "Review the result" },
    }).returning();
    const command = { ...owner, body: "Ready for acceptance", reviewInteractionId: confirmation.id,
      clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    const svc = localAgentRunLeaseService(db);
    const first = await svc.reviewFencedIssue(command, actor);
    expect(first.replayed).toBe(false);
    expect(first.issue.status).toBe("in_review");
    expect(first.comment.createdByRunId).toBe(scope.runId);
    const second = await svc.reviewFencedIssue(command, actor);
    expect(second.replayed).toBe(true);
    expect(second.comment.id).toBe(first.comment.id);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId)))
      .toHaveLength(1);
    const events = (await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId)))
      .filter((event) => event.action === "issue.updated" || event.action === "issue.comment_added");
    expect(events.map((event) => event.action).sort()).toEqual(["issue.comment_added", "issue.updated"]);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, confirmation.id)))[0]?.status)
      .toBe("pending");
    await expect(svc.reviewFencedIssue({ ...command, body: "Different content" }, actor))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.reviewFencedIssue({ ...command, clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.reviewFencedIssue({ ...command, reviewInteractionId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 409 });
    const replacement = randomUUID();
    await db.insert(agents).values({ id: replacement, companyId: scope.companyId,
      name: "Replacement", runtimeConfig: { executionMode: "client_pull" } });
    await db.update(issues).set({ assigneeAgentId: replacement }).where(eq(issues.id, scope.issueId));
    await expect(svc.reviewFencedIssue(command, actor)).rejects.toMatchObject({ status: 403 });
  }, 30_000);

  it("exposes only the fenced review handoff over HTTP and rejects it after cancellation", async () => {
    const scope = await fixture();
    const deviceId = "device-desktop-001";
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId, idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const [confirmation] = await db.insert(issueThreadInteractions).values({
      companyId: scope.companyId, issueId: scope.issueId,
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      createdByAgentId: scope.agentId, sourceRunId: scope.runId,
      payload: { version: 1, prompt: "Review this" },
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const path = `/api/agents/me/local-runs/${scope.runId}/issue/review-handoff`;
    const payload = { deviceId, leaseId: claimed!.leaseId, generation: claimed!.generation,
      issueId: scope.issueId, body: "Ready for acceptance",
      reviewInteractionId: confirmation.id, clientRequestId: randomUUID() };
    const first = await request(app).post(path).send(payload).expect(201);
    const replay = await request(app).post(path).send(payload).expect(200);
    expect(replay.body.comment.id).toBe(first.body.comment.id);
    await request(app).post(path).send({ ...payload, clientRequestId: randomUUID() }).expect(409);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await request(app).post(path).send(payload).expect(403);
  }, 30_000);

  it("creates a human review confirmation in the lease transaction and replays one receipt", async () => {
    const scope = await fixture();
    const deviceId = "device-desktop-001";
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId, idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const path = `/api/agents/me/local-runs/${scope.runId}/issue/review-confirmation`;
    const payload = { deviceId, leaseId: claimed!.leaseId, generation: claimed!.generation,
      issueId: scope.issueId, prompt: "Please verify the result", clientRequestId: randomUUID() };
    const first = await request(app).post(path).send(payload).expect(201);
    const replay = await request(app).post(path).send(payload).expect(200);
    expect(replay.body.interaction.id).toBe(first.body.interaction.id);
    expect(first.body.interaction).toMatchObject({ kind: "request_confirmation", status: "pending",
      sourceRunId: scope.runId, createdByAgentId: scope.agentId,
      effectiveResolverPolicy: "human_only" });
    await request(app).post(path).send({ ...payload, prompt: "Different request" }).expect(409);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId));
    expect(activities.filter((row) => row.action === "issue.thread_interaction_created" &&
      row.details?.interactionId === first.body.interaction.id)).toHaveLength(1);
    await request(app).post(`/api/agents/me/local-runs/${scope.runId}/issue/review-handoff`)
      .send({ ...payload, body: "Ready for acceptance", reviewInteractionId: first.body.interaction.id,
        clientRequestId: randomUUID(), prompt: undefined }).expect(201);
    const [pendingReview] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, first.body.interaction.id));
    expect(pendingReview.status).toBe("pending");
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await request(app).post(path).send(payload).expect(403);
  }, 30_000);

  it("rolls back a fenced review confirmation when its audit row cannot persist", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    await db.execute(sql`create function reject_local_review_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'issue.thread_interaction_created' then
          raise exception 'injected review audit failure';
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger reject_local_review_audit_trigger before insert on activity_log
      for each row execute function reject_local_review_audit()`);
    try {
      await expect(localAgentRunLeaseService(db).createFencedReviewConfirmation({
        ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
        generation: claimed!.generation, prompt: "Please verify the result",
        clientRequestId: randomUUID(),
      }, { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId }))
        .rejects.toThrow("Failed query");
      expect(await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, scope.issueId))).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger reject_local_review_audit_trigger on activity_log`);
      await db.execute(sql`drop function reject_local_review_audit()`);
    }
  }, 30_000);

  it("rejects addressed-agent review before creating a card until delivery is durable", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const reviewerId = randomUUID();
    const pausedId = randomUUID();
    const foreignCompanyId = randomUUID();
    const foreignReviewerId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId,
      name: "Foreign review company", issuePrefix: `F${foreignCompanyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: reviewerId, companyId: scope.companyId, name: "Review agent" },
      { id: pausedId, companyId: scope.companyId, name: "Paused review agent", status: "paused" },
      { id: foreignReviewerId, companyId: foreignCompanyId, name: "Foreign review agent" },
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string; details?: unknown }, _req: Request,
      res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message, details: err.details });
    });
    const path = `/api/agents/me/local-runs/${scope.runId}/issue/review-confirmation`;
    const payload = { deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, issueId: scope.issueId,
      prompt: "Please review", clientRequestId: randomUUID() };
    for (const target of [reviewerId, scope.agentId, pausedId, foreignReviewerId]) {
      const denied = await request(app).post(path)
        .send({ ...payload, reviewerAgentId: target }).expect(422);
      expect(denied.body.details?.code).toBe("local_run_agent_review_delivery_unavailable");
    }
    expect(await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, scope.issueId))).toHaveLength(0);
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId)))
      .filter((row) => row.action === "issue.thread_interaction_created")).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await request(app).post(path).send({ ...payload, reviewerAgentId: reviewerId }).expect(403);
  }, 30_000);

  it("exposes only the atomic completion-review handoff to the source lease", async () => {
    const scope = await fixture();
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId: scope.companyId,
      name: "Review recipient", adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" } });
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request,
      res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const path = `/api/agents/me/local-runs/${scope.runId}/issue/completion-review-handoff`;
    const payload = { deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, issueId: scope.issueId, reviewerAgentId,
      prompt: "Verify delivered result", body: "Ready for acceptance",
      clientRequestId: randomUUID() };
    await request(app).post(path).send({ ...payload, generation: 99 }).expect(403);
    const first = await request(app).post(path).send(payload).expect(201);
    expect(first.body).toMatchObject({ issueId: scope.issueId,
      status: "in_review", replayed: false });
    expect(first.body).not.toHaveProperty("body");
    const replay = await request(app).post(path).send(payload).expect(200);
    expect(replay.body).toMatchObject({ reviewId: first.body.reviewId,
      interactionId: first.body.interactionId, replayed: true });
    await request(app).post(path).send({ ...payload, body: "Changed" }).expect(409);
    expect(await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.issueId, scope.issueId))).toHaveLength(1);
  }, 30_000);

  it("refuses generic review for a dispatched child work record", async () => {
    const scope = await fixture();
    const projectId = randomUUID();
    const parentRecordId = randomUUID();
    const childRecordId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: scope.companyId,
      name: "Package completion boundary" });
    await db.insert(workRecords).values([
      { id: parentRecordId, companyId: scope.companyId, projectId,
        kind: "plan", title: "Parent PO package" },
      { id: childRecordId, companyId: scope.companyId, projectId,
        parentRecordId, kind: "plan", title: "Child delivery",
        dispatchState: "dispatched", dispatchRound: 1 },
    ]);
    await db.update(issues).set({ projectId }).where(eq(issues.id, scope.issueId));
    await db.insert(workRecordIssueLinks).values({ companyId: scope.companyId,
      projectId, recordId: childRecordId, issueId: scope.issueId,
      purpose: "primary", dispatchRound: 1 });
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId: scope.companyId,
      name: "Second agent", adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" } });
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const actor = { type: "agent" as const, source: "agent_key" as const,
      agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId };
    await expect(svc.createFencedCompletionReviewHandoff({ ...scope,
      deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, reviewerAgentId,
      prompt: "Review", body: "Ready", clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 422,
        details: { code: "work_record_completion_contract_required" } });
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.status).toBe("in_progress");
    expect(await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.issueId, scope.issueId))).toHaveLength(0);
    expect(await db.select().from(localRunWriteReceipts)
      .where(eq(localRunWriteReceipts.runId, scope.runId))).toHaveLength(0);
    expect(await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, scope.issueId))).toHaveLength(0);
  }, 30_000);

  it("completes one assigned child under its source lease and replays only its receipt", async () => {
    const scope = await fixture();
    const projectId = randomUUID();
    const parentRecordId = randomUUID();
    const childRecordId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: scope.companyId,
      name: "Child completion package" });
    await db.insert(workRecords).values([
      { id: parentRecordId, companyId: scope.companyId, projectId,
        kind: "plan", title: "PO package", assigneeAgentId: scope.agentId,
        dispatchState: "linked", dispatchRound: 1 },
      { id: childRecordId, companyId: scope.companyId, projectId,
        parentRecordId, kind: "plan", title: "Child task",
        assigneeAgentId: scope.agentId, dispatchState: "linked", dispatchRound: 1 },
    ]);
    await db.update(issues).set({ projectId }).where(eq(issues.id, scope.issueId));
    await db.insert(workRecordIssueLinks).values({ companyId: scope.companyId,
      projectId, recordId: childRecordId, issueId: scope.issueId,
      purpose: "primary", dispatchRound: 1 });
    const [cycle] = await db.insert(workRecordQualityCycles).values({
      companyId: scope.companyId, projectId, aggregateRecordId: parentRecordId,
      cycleNumber: 1, kind: "package_acceptance", state: "open",
      qualityPhase: "waiting_children", scopeDigest: "fixture",
    }).returning();
    await db.insert(workRecordQualityItems).values({ companyId: scope.companyId,
      projectId, cycleId: cycle.id, recordId: childRecordId,
      role: "repair", required: true, state: "waiting" });
    const dependentId = randomUUID();
    await db.insert(issues).values({ id: dependentId,
      companyId: scope.companyId, projectId, title: "Dependent child",
      status: "blocked", blockedTransitionAt: new Date(),
      assigneeAgentId: scope.agentId });
    await db.insert(issueRelations).values({ companyId: scope.companyId,
      issueId: scope.issueId, relatedIssueId: dependentId, type: "blocks" });
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const [before] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const actor = { type: "agent" as const, source: "agent_key" as const,
      agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId };
    const command = { ...scope, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation,
      expectedStatusVersion: before.statusVersion,
      summary: "Child delivery checked against the brief",
      clientRequestId: randomUUID() };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string; details?: unknown },
      _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message, details: err.details });
    });
    const endpoint = `/api/agents/me/local-runs/${scope.runId}/issue/child-complete`;
    const body = { deviceId: command.deviceId, leaseId: command.leaseId,
      generation: command.generation, issueId: scope.issueId,
      expectedStatusVersion: command.expectedStatusVersion,
      summary: command.summary, clientRequestId: command.clientRequestId };
    const requestDigest = createHash("sha256").update(JSON.stringify({
      kind: "child_complete", runId: scope.runId, issueId: scope.issueId,
      agentId: scope.agentId, deviceId: command.deviceId,
      canonicalContent: JSON.stringify({ expectedStatusVersion: command.expectedStatusVersion,
        summary: command.summary }),
    })).digest("hex");
    const lookup = { ...command, issueId: scope.issueId,
      kind: "child_complete", requestDigest };
    expect((await svc.readFencedWriteReceipt({ ...lookup,
      clientRequestId: command.clientRequestId })).state).toBe("unknown");
    await request(app).post(endpoint).send({ ...body, generation: 99 }).expect(403);
    const completedResponse = await request(app).post(endpoint).send(body).expect(201);
    const completed = completedResponse.body;
    expect(completed).toMatchObject({ issueId: scope.issueId, status: "in_progress",
      statusVersion: before.statusVersion, disposition: "prepared", replayed: false });
    expect(await svc.readFencedWriteReceipt(lookup)).toMatchObject({
      state: "committed", kind: "child_complete", sourceReceiptId: completed.receiptId,
    });
    await expect(svc.readFencedWriteReceipt({ ...lookup,
      requestDigest: "a".repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(svc.readFencedWriteReceipt({ ...lookup,
      kind: "po_verdict" })).rejects.toMatchObject({ status: 409 });
    await expect(db.insert(localRunWriteReceipts).values({
      companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId,
      agentId: scope.agentId, deviceId: command.deviceId,
      clientRequestId: command.clientRequestId, kind: "po_verdict",
      requestDigest, sourceReceiptId: completed.receiptId,
    })).rejects.toThrow();
    const replay = (await request(app).post(endpoint).send(body).expect(200)).body;
    expect(replay).toMatchObject({ ...completed, replayed: true });
    await expect(svc.completeFencedChildWorkRecord({ ...command,
      summary: "Changed" }, actor)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(localIssueCompletionCommands)
      .where(eq(localIssueCompletionCommands.issueId, scope.issueId))).toHaveLength(1);
    expect(await db.select().from(issueComments)
      .where(eq(issueComments.issueId, scope.issueId))).toHaveLength(1);
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.status).toBe("in_progress");
    expect(await issueService(db).listWakeableBlockedDependents(scope.issueId)).toEqual([]);
    expect((await svc.finish({ ...scope, deviceId: command.deviceId,
      leaseId: command.leaseId, generation: command.generation,
      outcome: "succeeded", exitCode: 0, processStopped: true,
      clientRequestId: randomUUID() })).status)
      .toBe("succeeded");
    expect((await db.select().from(issues).where(eq(issues.id, scope.issueId)))[0].status)
      .toBe("done");
    expect((await issueService(db).listWakeableBlockedDependents(scope.issueId))
      .map((candidate) => candidate.id)).toEqual([dependentId]);
    const [receipt] = await db.select().from(localIssueCompletionCommands)
      .where(eq(localIssueCompletionCommands.issueId, scope.issueId));
    expect(receipt.state).toBe("completed");
    expect(receipt.completedStatusVersion).toBe(before.statusVersion + 1);
    expect((await svc.readFencedWriteReceipt(lookup)).state).toBe("committed");
    await db.update(localAgentDeviceBindings).set({ revokedAt: new Date() })
      .where(eq(localAgentDeviceBindings.keyId, scope.keyId));
    await expect(svc.readFencedWriteReceipt(lookup)).rejects.toMatchObject({ status: 403 });
  }, 30_000);

  it("aborts a prepared child completion when its local process fails", async () => {
    const scope = await fixture();
    const projectId = randomUUID(), rootId = randomUUID(), childId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: scope.companyId,
      name: "Failed child package" });
    await db.insert(workRecords).values([
      { id: rootId, companyId: scope.companyId, projectId, kind: "plan",
        title: "Package", assigneeAgentId: scope.agentId },
      { id: childId, companyId: scope.companyId, projectId, parentRecordId: rootId,
        kind: "plan", title: "Child", assigneeAgentId: scope.agentId,
        dispatchState: "linked", dispatchRound: 1 },
    ]);
    await db.update(issues).set({ projectId }).where(eq(issues.id, scope.issueId));
    await db.insert(workRecordIssueLinks).values({ companyId: scope.companyId,
      projectId, recordId: childId, issueId: scope.issueId,
      purpose: "primary", dispatchRound: 1 });
    const [cycle] = await db.insert(workRecordQualityCycles).values({
      companyId: scope.companyId, projectId, aggregateRecordId: rootId,
      cycleNumber: 1, kind: "package_acceptance", scopeDigest: "failed",
    }).returning();
    await db.insert(workRecordQualityItems).values({ companyId: scope.companyId,
      projectId, cycleId: cycle.id, recordId: childId, role: "repair" });
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const [before] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const owner = { ...scope, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const actor = { type: "agent" as const, source: "agent_key" as const,
      agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId };
    await svc.completeFencedChildWorkRecord({ ...owner,
      expectedStatusVersion: before.statusVersion, summary: "Prepared delivery",
      clientRequestId: randomUUID() }, actor);
    expect((await svc.finish({ ...owner, outcome: "failed", exitCode: 1,
      processStopped: true, clientRequestId: randomUUID() })).status).toBe("failed");
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const [receipt] = await db.select().from(localIssueCompletionCommands)
      .where(eq(localIssueCompletionCommands.issueId, scope.issueId));
    expect(issue.status).toBe("blocked");
    expect(receipt.state).toBe("aborted");
    expect(receipt.completedStatusVersion).toBeNull();
  }, 30_000);

  it("atomically creates a dedicated completion review and replays only the exact request", async () => {
    const scope = await fixture();
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId: scope.companyId,
      name: "Local reviewer", adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" } });
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const [before] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const owner = { ...scope, issueId: scope.issueId, reviewerAgentId,
      deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, prompt: "Verify the delivered task",
      body: "Ready for acceptance", clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    const first = await svc.createFencedCompletionReviewHandoff(owner, actor);
    expect(first.replayed).toBe(false);
    expect((await db.select().from(localRunWriteReceipts).where(eq(
      localRunWriteReceipts.clientRequestId, owner.clientRequestId)))[0])
      .toMatchObject({ kind: "completion_review_handoff", sourceReceiptId: first.review.id,
        deviceId: owner.deviceId });
    expect(first.issue.status).toBe("in_review");
    expect(first.issue.statusVersion).toBe(before.statusVersion + 1);
    expect(first.issue.assigneeAgentId).toBe(scope.agentId);
    expect(first.review.issueStatusVersion).toBe(before.statusVersion + 1);
    expect(first.review.clientPullLeaseRunId).toBe(scope.runId);
    expect((first.interaction.payload as unknown as Record<string, unknown>).target).toEqual({ type: "custom",
      key: "issue_completion_review", revisionId: first.review.id });
    expect(first.delivery).toMatchObject({ kind: "completion_review", reviewId: first.review.id,
      status: "awaiting_handoff", targetAgentId: reviewerAgentId });
    const replay = await svc.createFencedCompletionReviewHandoff(owner, actor);
    expect(replay.replayed).toBe(true);
    expect(replay.review.id).toBe(first.review.id);
    await expect(svc.createFencedCompletionReviewHandoff({ ...owner, body: "Changed" }, actor))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.createFencedCompletionReviewHandoff({ ...owner,
      reviewerAgentId: randomUUID() }, actor)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.issueId, scope.issueId))).toHaveLength(1);
    expect(await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.issueId, scope.issueId))).toHaveLength(1);
    expect(await db.select().from(issueComments)
      .where(eq(issueComments.issueId, scope.issueId))).toHaveLength(1);
  }, 30_000);

  it("rolls back the dedicated review if its durable intent fails", async () => {
    const scope = await fixture();
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId: scope.companyId,
      name: "Local reviewer", adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" } });
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const [before] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const owner = { ...scope, reviewerAgentId, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation,
      prompt: "Verify", body: "Ready", clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    await db.execute(sql`create function reject_dedicated_review_intent() returns trigger language plpgsql as $$
      begin
        if NEW.issue_id = '${sql.raw(scope.issueId)}' then
          raise exception 'injected dedicated intent failure';
        end if;
        return NEW;
      end $$`);
    await db.execute(sql`create trigger reject_dedicated_review_intent_trigger before insert on issue_command_deliveries
      for each row execute function reject_dedicated_review_intent()`);
    try {
      await expect(svc.createFencedCompletionReviewHandoff(owner, actor)).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger reject_dedicated_review_intent_trigger on issue_command_deliveries`);
      await db.execute(sql`drop function reject_dedicated_review_intent()`);
    }
    expect(await db.select().from(localRunWriteReceipts)
      .where(eq(localRunWriteReceipts.runId, scope.runId))).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.status).toBe("in_progress");
    expect(issue.statusVersion).toBe(before.statusVersion);
    expect(await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, scope.issueId))).toHaveLength(0);
    expect(await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.issueId, scope.issueId))).toHaveLength(0);
    expect(await db.select().from(issueComments)
      .where(eq(issueComments.issueId, scope.issueId))).toHaveLength(0);
  }, 30_000);

  it("rejects a governed or cancelled dedicated review without leaving a card", async () => {
    const scope = await fixture();
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId: scope.companyId,
      name: "Local reviewer", adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" } });
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001",
      idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const owner = { ...scope, reviewerAgentId, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation,
      prompt: "Verify", body: "Ready", clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    await db.update(companies).set({ interactionResolverGovernance: {
      request_confirmation: { cap: "human_only" },
    } }).where(eq(companies.id, scope.companyId));
    await expect(svc.createFencedCompletionReviewHandoff(owner, actor))
      .rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, scope.issueId))).toHaveLength(0);
    await db.update(companies).set({ interactionResolverGovernance: {} })
      .where(eq(companies.id, scope.companyId));
    await db.update(localAgentRunLeases).set({ cancelRequestedAt: new Date() })
      .where(eq(localAgentRunLeases.runId, scope.runId));
    await expect(svc.createFencedCompletionReviewHandoff(owner, actor))
      .rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.issueId, scope.issueId))).toHaveLength(0);
  }, 30_000);

  it("releases a successful source run and readies only its dedicated review intent", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    const finish = { ...owner, outcome: "succeeded" as const, exitCode: 0,
      processStopped: true as const, clientRequestId: randomUUID(), summary: "Delivered" };
    expect((await svc.finish(finish)).status).toBe("succeeded");
    expect((await svc.finish(finish)).status).toBe("succeeded");
    await expect(svc.finish({ ...finish, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, handoff.review.id));
    const [delivery] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, handoff.delivery.id));
    const [card] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, handoff.interaction.id));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(issue.status).toBe("in_review");
    expect(issue.assigneeAgentId).toBe(scope.agentId);
    expect(review.state).toBe("pending");
    expect(card.status).toBe("pending");
    expect(delivery.status).toBe("ready");
    expect(run.resultJson?.localWorkerFinish).toMatchObject({
      clientRequestId: finish.clientRequestId, reviewId: review.id,
      deliveryId: delivery.id, disposition: "ready", issueStatus: "in_review",
    });
  }, 30_000);

  it("blocks a failed handoff and atomically cancels the review card and intent", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    const finish = { ...owner, outcome: "failed" as const, exitCode: 1,
      processStopped: true as const, clientRequestId: randomUUID() };
    expect((await svc.finish(finish)).status).toBe("failed");
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, handoff.review.id));
    const [delivery] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, handoff.delivery.id));
    const [card] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, handoff.interaction.id));
    expect(issue.status).toBe("blocked");
    expect(review.state).toBe("cancelled");
    expect(delivery.status).toBe("cancelled");
    expect(card.status).toBe("expired");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(run.resultJson?.localWorkerFinish).toMatchObject({ disposition: "blocked",
      reviewId: review.id, deliveryId: delivery.id, issueStatus: "blocked" });
  }, 30_000);

  it("acknowledges cancellation by blocking the task and invalidating review", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await db.update(localAgentRunLeases).set({ cancelRequestedAt: new Date() })
      .where(eq(localAgentRunLeases.runId, scope.runId));
    expect((await svc.finish({ ...owner, outcome: "cancelled", exitCode: null,
      processStopped: true, clientRequestId: randomUUID() })).status).toBe("cancelled");
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, handoff.review.id));
    const [delivery] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, handoff.delivery.id));
    expect(issue.status).toBe("blocked");
    expect(review.state).toBe("cancelled");
    expect(delivery.status).toBe("cancelled");
  }, 30_000);

  it("preserves a human change made before source finish", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await issueService(db).update(scope.issueId, { status: "todo", companyGuard: scope.companyId });
    const [changed] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect((await svc.finish({ ...owner, outcome: "failed", exitCode: 1,
      processStopped: true, clientRequestId: randomUUID() })).status).toBe("failed");
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, handoff.review.id));
    expect(issue.status).toBe("todo");
    expect(issue.statusVersion).toBe(changed.statusVersion);
    expect(review.state).toBe("cancelled");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(run.resultJson?.localWorkerFinish).toMatchObject({ disposition: "preserved",
      issueStatus: "todo" });
  }, 30_000);

  it("rolls source finish back if dedicated intent cannot become ready", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await db.execute(sql`create function reject_review_ready() returns trigger language plpgsql as $$
      begin
        if NEW.id = '${sql.raw(handoff.delivery.id)}' and NEW.status = 'ready' then
          raise exception 'injected review ready failure';
        end if;
        return NEW;
      end $$`);
    await db.execute(sql`create trigger reject_review_ready_trigger before update on issue_command_deliveries
      for each row execute function reject_review_ready()`);
    try {
      await expect(svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
        processStopped: true, clientRequestId: randomUUID() })).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger reject_review_ready_trigger on issue_command_deliveries`);
      await db.execute(sql`drop function reject_review_ready()`);
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, scope.runId));
    const [delivery] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, handoff.delivery.id));
    expect(run.status).toBe("running");
    expect(lease.releasedAt).toBeNull();
    expect(delivery.status).toBe("awaiting_handoff");
  }, 30_000);

  it("rolls cancellation back if moving the issue to blocked fails", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await db.execute(sql`create function reject_review_blocked() returns trigger language plpgsql as $$
      begin
        if NEW.id = '${sql.raw(scope.issueId)}' and NEW.status = 'blocked' then
          raise exception 'injected blocked transition failure';
        end if;
        return NEW;
      end $$`);
    await db.execute(sql`create trigger reject_review_blocked_trigger before update on issues
      for each row execute function reject_review_blocked()`);
    try {
      await expect(svc.finish({ ...owner, outcome: "cancelled", exitCode: null,
        processStopped: true, clientRequestId: randomUUID() })).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger reject_review_blocked_trigger on issues`);
      await db.execute(sql`drop function reject_review_blocked()`);
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, scope.runId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, handoff.review.id));
    const [delivery] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, handoff.delivery.id));
    expect(run.status).toBe("running");
    expect(lease.releasedAt).toBeNull();
    expect(review.state).toBe("pending");
    expect(delivery.status).toBe("awaiting_handoff");
  }, 30_000);

  it("serializes a human status change before finish without overwriting it", async () => {
    const { scope, owner, svc } = await dedicatedReviewFixture();
    let notifyLocked!: (pid: number) => void;
    let releaseIssue!: () => void;
    const locked = new Promise<number>((resolve) => { notifyLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseIssue = resolve; });
    const human = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, scope.issueId)).for("update");
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      notifyLocked(backend.pid);
      await release;
      await issueService(db).update(scope.issueId,
        { status: "todo", companyGuard: scope.companyId }, tx);
    });
    const blockerPid = await locked;
    const finishing = svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    try {
      await expect.poll(async () => {
        const [waiter] = await db.execute<{ blocked: boolean }>(sql`
          select exists (
            select 1 from pg_stat_activity where datname = current_database()
              and ${blockerPid} = any(pg_blocking_pids(pid))
          ) as blocked`);
        return waiter?.blocked ?? false;
      }, { timeout: 5_000 }).toBe(true);
    } finally {
      releaseIssue();
      await human;
    }
    expect((await finishing).status).toBe("succeeded");
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(issue.status).toBe("todo");
    expect(run.resultJson?.localWorkerFinish).toMatchObject({ disposition: "preserved",
      issueStatus: "todo" });
  }, 30_000);

  it("preserves deletion of a task and its run after a historical lease", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    await svc.finish({ ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, outcome: "succeeded", exitCode: 0, processStopped: true });
    await db.delete(issues).where(eq(issues.id, scope.issueId));
    const [lease] = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(lease.issueId).toBe(scope.issueId);
    // Audit rows retain their run FK; remove the fixture's audit before testing
    // the historical lease's cascade behavior in isolation.
    await db.delete(activityLog).where(eq(activityLog.runId, scope.runId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId))).toHaveLength(0);
  });

  it("queues a dedicated local review exactly once after source finish", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    expect(await issueCommandDeliveryService(db).claim({ companyId: scope.companyId })).toBeNull();
    const producer = localAgentReviewDeliveryService(db);
    const [first, second] = await Promise.all([
      producer.deliver(handoff.delivery.id), producer.deliver(handoff.delivery.id),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.run.id).toBe(second.run.id);
    expect(first.wake.id).toBe(second.wake.id);
    expect(first.run.runtimeMode).toBe("client_pull");
    expect(first.run.status).toBe("queued");
    expect(first.run.agentId).toBe(handoff.review.reviewerAgentId);
    expect(first.run.responsibleUserId).toBeNull();
    expect(first.wake.idempotencyKey).toBe(clientPullCompletionReviewWakeKey(
      handoff.review.id, handoff.interaction.id));
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.assigneeAgentId).toBe(scope.agentId);
    expect(issue.executionRunId).toBeNull();
    const [intent] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, handoff.delivery.id));
    expect(intent.status).toBe("delivered");
    expect(intent.wakeupRequestId).toBe(first.wake.id);
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy" })
      .where(eq(heartbeatRuns.id, first.run.id));
    await expect(producer.deliver(handoff.delivery.id)).rejects.toMatchObject({ status: 409 });
  }, 30_000);

  it("sweeps a committed dedicated review into one local reviewer run", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    const producer = localAgentReviewDeliveryService(db);
    expect(await producer.sweepReady()).toMatchObject({ scanned: 1, delivered: 1 });
    expect(await producer.sweepReady()).toMatchObject({ scanned: 0, delivered: 0 });
    const [intent] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, handoff.delivery.id));
    expect(intent.status).toBe("delivered");
    const runs = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRuns.agentId, handoff.review.reviewerAgentId),
    ));
    expect(runs.filter((run) => run.contextSnapshot?.reviewId === handoff.review.id)).toHaveLength(1);
  }, 30_000);

  it("rolls back wake and run when dedicated intent delivery fails", async () => {
    const { owner, svc, handoff } = await dedicatedReviewFixture();
    await svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    await db.execute(sql`create function reject_dedicated_delivery() returns trigger language plpgsql as $$
      begin
        if NEW.id = '${sql.raw(handoff.delivery.id)}' and NEW.status = 'delivered' then
          raise exception 'injected dedicated delivery failure';
        end if;
        return NEW;
      end $$`);
    await db.execute(sql`create trigger reject_dedicated_delivery_trigger before update on issue_command_deliveries
      for each row execute function reject_dedicated_delivery()`);
    try {
      await expect(localAgentReviewDeliveryService(db).deliver(handoff.delivery.id)).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger reject_dedicated_delivery_trigger on issue_command_deliveries`);
      await db.execute(sql`drop function reject_dedicated_delivery()`);
    }
    const key = clientPullCompletionReviewWakeKey(handoff.review.id, handoff.interaction.id);
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, key))).toHaveLength(0);
    const [intent] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, handoff.delivery.id));
    expect(intent.status).toBe("ready");
  }, 30_000);

  it("refuses to queue before source finish or for a paused reviewer", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    const producer = localAgentReviewDeliveryService(db);
    await expect(producer.deliver(handoff.delivery.id)).rejects.toMatchObject({ status: 409 });
    await svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    await db.update(agents).set({ status: "paused" })
      .where(eq(agents.id, handoff.review.reviewerAgentId));
    await expect(producer.deliver(handoff.delivery.id)).rejects.toMatchObject({ status: 409 });
    await db.update(agents).set({ status: "idle", runtimeConfig: {} })
      .where(eq(agents.id, handoff.review.reviewerAgentId));
    await expect(producer.deliver(handoff.delivery.id)).rejects.toMatchObject({ status: 409 });
    await db.update(agents).set({ runtimeConfig: { executionMode: "client_pull" } })
      .where(eq(agents.id, handoff.review.reviewerAgentId));
    await db.update(issueThreadInteractions).set({ status: "expired" })
      .where(eq(issueThreadInteractions.id, handoff.interaction.id));
    await expect(producer.deliver(handoff.delivery.id)).rejects.toMatchObject({ status: 409 });
    const [intent] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, handoff.delivery.id));
    expect(intent.status).toBe("ready");
    const key = clientPullCompletionReviewWakeKey(handoff.review.id, handoff.interaction.id);
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, key))).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.executionRunId).toBeNull();
  }, 30_000);

  it("refuses an obsolete review revision and an occupied cancelled wake key", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    const producer = localAgentReviewDeliveryService(db);
    await db.update(issues).set({ statusVersion: handoff.review.issueStatusVersion + 1 })
      .where(eq(issues.id, scope.issueId));
    await expect(producer.deliver(handoff.delivery.id)).rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ statusVersion: handoff.review.issueStatusVersion })
      .where(eq(issues.id, scope.issueId));
    const key = clientPullCompletionReviewWakeKey(handoff.review.id, handoff.interaction.id);
    await db.insert(agentWakeupRequests).values({ companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, source: "automation",
      triggerDetail: "system", reason: "issue_completion_review", status: "cancelled",
      idempotencyKey: key });
    await expect(producer.deliver(handoff.delivery.id)).rejects.toMatchObject({ status: 409 });
    await expect(db.insert(agentWakeupRequests).values({ companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, source: "automation",
      triggerDetail: "system", reason: "issue_completion_review", status: "failed",
      idempotencyKey: key })).rejects.toThrow();
  }, 30_000);

  it("lets the addressed local reviewer claim without taking the source task owner lock", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    const { run, wake } = await localAgentReviewDeliveryService(db)
      .deliver(handoff.delivery.id);
    const reviewerKeyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: reviewerKeyId,
      companyId: scope.companyId, agentId: handoff.review.reviewerAgentId,
      name: "Reviewer test key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, keyId: reviewerKeyId,
      deviceId: "reviewer-desktop-001" });
    const claimInput = { companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, keyId: reviewerKeyId,
      deviceId: "reviewer-desktop-001", idempotencyKey: randomUUID() };
    const claimed = await svc.claim(claimInput);
    expect(claimed?.runId).toBe(run.id);
    expect(claimed?.issueId).toBe(scope.issueId);
    expect(claimed?.wakeReason).toBe("issue_completion_review");
    expect((await svc.claim(claimInput))?.leaseId).toBe(claimed?.leaseId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.assigneeAgentId).toBe(scope.agentId);
    expect(issue.executionRunId).toBeNull();
    const [claimedWake] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wake.id));
    expect(claimedWake.status).toBe("claimed");
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, run.id));
    expect(lease.agentId).toBe(handoff.review.reviewerAgentId);
    expect(lease.issueId).toBe(scope.issueId);
    const eventInput = { companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, issueId: scope.issueId,
      runId: run.id, keyId: reviewerKeyId,
      deviceId: claimInput.deviceId, leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID(),
      stream: "system" as const, level: "info" as const,
      message: "Review started" };
    const actor = { type: "agent", source: "agent_key",
      companyId: scope.companyId, agentId: handoff.review.reviewerAgentId,
      keyId: reviewerKeyId, runId: run.id } as const;
    expect((await svc.appendFencedEvent(eventInput, actor)).message)
      .toBe("Review started");
    expect((await svc.control(eventInput)).action).toBe("continue");
    await db.update(issueThreadInteractions).set({ status: "cancelled" })
      .where(eq(issueThreadInteractions.id, handoff.interaction.id));
    expect((await svc.control(eventInput)).action).toBe("cancel");
    expect((await svc.renew(eventInput)).cancelRequested).toBe(true);
    await expect(svc.appendFencedEvent({ ...eventInput,
      clientRequestId: randomUUID(), message: "Stale review event" }, actor))
      .rejects.toMatchObject({ status: 409 });
  }, 30_000);

  it("rejects a stale reviewer card and leaves the queued run untouched", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    const { run } = await localAgentReviewDeliveryService(db)
      .deliver(handoff.delivery.id);
    const reviewerKeyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: reviewerKeyId,
      companyId: scope.companyId, agentId: handoff.review.reviewerAgentId,
      name: "Reviewer stale key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, keyId: reviewerKeyId,
      deviceId: "reviewer-stale-001" });
    await db.update(issueThreadInteractions).set({ status: "cancelled" })
      .where(eq(issueThreadInteractions.id, handoff.interaction.id));
    await expect(svc.claim({ companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, keyId: reviewerKeyId,
      deviceId: "reviewer-stale-001", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [queued] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(queued.status).toBe("queued");
    expect(await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, run.id))).toHaveLength(0);
  }, 30_000);

  it("stops renewal when a claimed review becomes obsolete", async () => {
    const { scope, owner, svc, handoff } = await dedicatedReviewFixture();
    await svc.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    const { run } = await localAgentReviewDeliveryService(db)
      .deliver(handoff.delivery.id);
    const reviewerKeyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: reviewerKeyId,
      companyId: scope.companyId, agentId: handoff.review.reviewerAgentId,
      name: "Reviewer renewal key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, keyId: reviewerKeyId,
      deviceId: "reviewer-renew-001" });
    const claim = await svc.claim({ companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, keyId: reviewerKeyId,
      deviceId: "reviewer-renew-001", idempotencyKey: randomUUID() });
    expect(claim?.runId).toBe(run.id);
    await db.update(issueThreadInteractions).set({ status: "cancelled" })
      .where(eq(issueThreadInteractions.id, handoff.interaction.id));
    const renewed = await svc.renew({ companyId: scope.companyId,
      agentId: handoff.review.reviewerAgentId, keyId: reviewerKeyId,
      deviceId: "reviewer-renew-001", runId: run.id,
      leaseId: claim!.leaseId, generation: claim!.generation });
    expect(renewed.cancelRequested).toBe(true);
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, run.id));
    expect(lease.cancelRequestedAt).not.toBeNull();
  }, 30_000);

  it("does not finish a pending reviewer run as success", async () => {
    const f = await claimedReviewerFixture();
    await expect(f.svc.finish({ ...f.reviewerOwner, outcome: "succeeded",
      exitCode: 0, processStopped: true, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.reviewerOwner.runId));
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, f.reviewerOwner.runId));
    expect(run.status).toBe("running");
    expect(lease.releasedAt).toBeNull();
  }, 30_000);

  it("keeps an accepted reviewer live and finishes only its own decision", async () => {
    const f = await claimedReviewerFixture();
    const decision = await issueCompletionReviewDecisionService(db).accept({
      companyId: f.scope.companyId, issueId: f.scope.issueId,
      reviewId: f.handoff.review.id, actorAgentId: f.reviewerOwner.agentId,
      actorRunId: f.reviewerOwner.runId, requestId: randomUUID(),
      summary: "Reviewed and accepted", clientPullProof: f.proof,
    });
    expect(decision.outcome).toBe("accepted");
    expect((await f.svc.control(f.reviewerOwner)).action).toBe("continue");
    expect((await f.svc.renew(f.reviewerOwner)).cancelRequested).toBe(false);
    await expect(f.svc.finish({ ...f.reviewerOwner, outcome: "succeeded",
      exitCode: 0, processStopped: true }))
      .rejects.toMatchObject({ status: 400 });
    const requestId = randomUUID();
    const finish = { ...f.reviewerOwner, outcome: "succeeded" as const,
      exitCode: 0, processStopped: true as const, clientRequestId: requestId };
    expect((await f.svc.finish(finish)).status).toBe("succeeded");
    expect((await f.svc.finish(finish)).status).toBe("succeeded");
    await expect(f.svc.finish({ ...finish, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.reviewerOwner.runId));
    expect(run.resultJson?.localWorkerFinish).toMatchObject({
      reviewerReviewId: f.handoff.review.id,
      decisionRequestId: decision.requestId,
      reviewerDisposition: "accepted",
    });
  }, 30_000);

  it("preserves an accepted reviewer decision when its local process later fails", async () => {
    const f = await claimedReviewerFixture();
    const decision = await issueCompletionReviewDecisionService(db).accept({
      companyId: f.scope.companyId, issueId: f.scope.issueId,
      reviewId: f.handoff.review.id, actorAgentId: f.reviewerOwner.agentId,
      actorRunId: f.reviewerOwner.runId, requestId: randomUUID(),
      summary: "Reviewed before local process failure", clientPullProof: f.proof,
    });
    const finish = { ...f.reviewerOwner, outcome: "failed" as const,
      exitCode: 1, processStopped: true as const, clientRequestId: randomUUID() };
    expect((await f.svc.finish(finish)).status).toBe("failed");
    expect((await f.svc.finish(finish)).status).toBe("failed");
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.scope.issueId));
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.reviewerOwner.runId));
    expect(issue.status).toBe("done");
    expect(run.resultJson?.localWorkerFinish).toMatchObject({
      reviewerReviewId: f.handoff.review.id,
      decisionRequestId: decision.requestId,
      reviewerDisposition: "accepted",
    });
  }, 30_000);

  it("lets one accepted reviewer finish while another review keeps the issue in review", async () => {
    const f = await claimedReviewerFixture();
    const otherReviewerId = randomUUID(), otherReviewId = randomUUID();
    await db.insert(agents).values({ id: otherReviewerId, companyId: f.scope.companyId,
      name: "Second reviewer" });
    const [otherCard] = await db.insert(issueThreadInteractions).values({
      companyId: f.scope.companyId, issueId: f.scope.issueId,
      sourceRunId: f.scope.runId, kind: "request_confirmation", status: "pending",
      effectiveResolverPolicy: "not_creator", createdByAgentId: f.scope.agentId,
      addresseeAgentId: otherReviewerId, addresseeUserId: null,
      payload: { version: 1, prompt: "Second review", target: {
        type: "custom", key: "issue_completion_review", revisionId: otherReviewId,
      } },
    }).returning();
    await db.insert(issueCompletionReviews).values({ id: otherReviewId,
      companyId: f.scope.companyId, issueId: f.scope.issueId,
      sourceRunId: f.scope.runId, sourceAgentId: f.scope.agentId,
      reviewerAgentId: otherReviewerId, interactionId: otherCard.id,
      sourceKind: "client_pull", clientPullLeaseRunId: f.scope.runId,
      requestId: randomUUID(), requestDigest: "second-review-request",
      issueStatusVersion: f.handoff.review.issueStatusVersion });
    await issueCompletionReviewDecisionService(db).accept({
      companyId: f.scope.companyId, issueId: f.scope.issueId,
      reviewId: f.handoff.review.id, actorAgentId: f.reviewerOwner.agentId,
      actorRunId: f.reviewerOwner.runId, requestId: randomUUID(),
      summary: "My review accepted", clientPullProof: f.proof,
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.scope.issueId));
    expect(issue.status).toBe("in_review");
    expect((await f.svc.control(f.reviewerOwner)).action).toBe("continue");
    expect((await f.svc.renew(f.reviewerOwner)).cancelRequested).toBe(false);
    expect((await f.svc.finish({ ...f.reviewerOwner, outcome: "succeeded",
      exitCode: 0, processStopped: true, clientRequestId: randomUUID() })).status)
      .toBe("succeeded");
  }, 30_000);

  it("rejects another run's accepted card as reviewer finish proof", async () => {
    const f = await claimedReviewerFixture();
    await issueCompletionReviewDecisionService(db).accept({
      companyId: f.scope.companyId, issueId: f.scope.issueId,
      reviewId: f.handoff.review.id, actorAgentId: f.reviewerOwner.agentId,
      actorRunId: f.reviewerOwner.runId, requestId: randomUUID(),
      summary: "Reviewed and accepted", clientPullProof: f.proof,
    });
    await db.update(issueThreadInteractions).set({ resolvedByRunId: f.scope.runId })
      .where(eq(issueThreadInteractions.id, f.handoff.interaction.id));
    await expect(f.svc.finish({ ...f.reviewerOwner, outcome: "succeeded",
      exitCode: 0, processStopped: true, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, f.reviewerOwner.runId));
    expect(lease.releasedAt).toBeNull();
  }, 30_000);

  it("rolls back reviewer lease release when run completion cannot commit", async () => {
    const f = await claimedReviewerFixture();
    await issueCompletionReviewDecisionService(db).accept({
      companyId: f.scope.companyId, issueId: f.scope.issueId,
      reviewId: f.handoff.review.id, actorAgentId: f.reviewerOwner.agentId,
      actorRunId: f.reviewerOwner.runId, requestId: randomUUID(),
      summary: "Reviewed and accepted", clientPullProof: f.proof,
    });
    await db.execute(sql`create function reject_reviewer_run_finish() returns trigger language plpgsql as $$
      begin
        if old.status = 'running' and new.status = 'succeeded'
          and new.runtime_mode = 'client_pull' then
          raise exception 'injected reviewer run finish failure';
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger reject_reviewer_run_finish_trigger before update on heartbeat_runs
      for each row execute function reject_reviewer_run_finish()`);
    try {
      await expect(f.svc.finish({ ...f.reviewerOwner, outcome: "succeeded",
        exitCode: 0, processStopped: true, clientRequestId: randomUUID() }))
        .rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger reject_reviewer_run_finish_trigger on heartbeat_runs`);
      await db.execute(sql`drop function reject_reviewer_run_finish()`);
    }
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, f.reviewerOwner.runId));
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.reviewerOwner.runId));
    expect(lease.releasedAt).toBeNull();
    expect(run.status).toBe("running");
  }, 30_000);

  it("blocks a failed reviewer run and cancels its current review in one transaction", async () => {
    const f = await claimedReviewerFixture();
    const finish = { ...f.reviewerOwner, outcome: "failed" as const,
      exitCode: 1, processStopped: true as const, clientRequestId: randomUUID(),
      summary: "Reviewer process stopped before a decision" };
    expect((await f.svc.finish(finish)).status).toBe("failed");
    expect((await f.svc.finish(finish)).status).toBe("failed");
    await expect(f.svc.finish({ ...finish, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.scope.issueId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, f.handoff.review.id));
    const [card] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.handoff.interaction.id));
    const [delivery] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, f.handoff.delivery.id));
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, f.reviewerOwner.runId));
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.reviewerOwner.runId));
    expect(issue.status).toBe("blocked");
    expect(review.state).toBe("cancelled");
    expect(card.status).toBe("expired");
    expect(delivery.status).toBe("delivered");
    expect(lease.releasedAt).not.toBeNull();
    expect(run.resultJson?.localWorkerFinish).toMatchObject({
      reviewerDisposition: "blocked", reviewerReviewId: review.id,
      issueStatus: "blocked", summary: finish.summary,
    });
    const events = await db.select().from(activityLog)
      .where(eq(activityLog.entityId, f.scope.issueId));
    expect(events.some((row) => row.action === "issue.completion_review_reviewer_run_failed"
      && row.runId === f.reviewerOwner.runId)).toBe(true);
  }, 30_000);

  it("acknowledges reviewer cancellation by blocking and invalidating its review", async () => {
    const f = await claimedReviewerFixture();
    await db.update(localAgentRunLeases).set({ cancelRequestedAt: new Date() })
      .where(eq(localAgentRunLeases.runId, f.reviewerOwner.runId));
    expect((await f.svc.finish({ ...f.reviewerOwner, outcome: "cancelled",
      exitCode: null, processStopped: true, clientRequestId: randomUUID() })).status)
      .toBe("cancelled");
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.scope.issueId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, f.handoff.review.id));
    const [card] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.handoff.interaction.id));
    expect(issue.status).toBe("blocked");
    expect(review.state).toBe("cancelled");
    expect(card.status).toBe("expired");
  }, 30_000);

  it("preserves a human status change before an unsuccessful reviewer finish", async () => {
    const f = await claimedReviewerFixture();
    await issueService(db).update(f.scope.issueId, {
      status: "todo", companyGuard: f.scope.companyId,
    });
    const [changed] = await db.select().from(issues).where(eq(issues.id, f.scope.issueId));
    expect((await f.svc.finish({ ...f.reviewerOwner, outcome: "failed",
      exitCode: 1, processStopped: true, clientRequestId: randomUUID() })).status)
      .toBe("failed");
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.scope.issueId));
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.reviewerOwner.runId));
    expect(issue.status).toBe("todo");
    expect(issue.statusVersion).toBe(changed.statusVersion);
    expect(run.resultJson?.localWorkerFinish).toMatchObject({
      reviewerDisposition: "preserved", issueStatus: "todo",
    });
  }, 30_000);

  it("rolls an unsuccessful reviewer finish back if blocking the issue fails", async () => {
    const f = await claimedReviewerFixture();
    await db.execute(sql`create function reject_reviewer_blocked() returns trigger language plpgsql as $$
      begin
        if new.status = 'blocked' and old.status = 'in_review' then
          raise exception 'injected reviewer blocked failure';
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger reject_reviewer_blocked_trigger before update on issues
      for each row execute function reject_reviewer_blocked()`);
    try {
      await expect(f.svc.finish({ ...f.reviewerOwner, outcome: "failed",
        exitCode: 1, processStopped: true, clientRequestId: randomUUID() }))
        .rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger reject_reviewer_blocked_trigger on issues`);
      await db.execute(sql`drop function reject_reviewer_blocked()`);
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.scope.issueId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, f.handoff.review.id));
    const [card] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.handoff.interaction.id));
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, f.reviewerOwner.runId));
    expect(issue.status).toBe("in_review");
    expect(review.state).toBe("pending");
    expect(card.status).toBe("pending");
    expect(lease.releasedAt).toBeNull();
  }, 30_000);

  it("rolls the blocked issue back if its reviewer card cannot expire", async () => {
    const f = await claimedReviewerFixture();
    await db.execute(sql`create function reject_reviewer_card_expiry() returns trigger language plpgsql as $$
      begin
        if new.status = 'expired' and old.status = 'pending' then
          raise exception 'injected reviewer card expiry failure';
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger reject_reviewer_card_expiry_trigger before update on issue_thread_interactions
      for each row execute function reject_reviewer_card_expiry()`);
    try {
      await expect(f.svc.finish({ ...f.reviewerOwner, outcome: "cancelled",
        exitCode: null, processStopped: true, clientRequestId: randomUUID() }))
        .rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger reject_reviewer_card_expiry_trigger on issue_thread_interactions`);
      await db.execute(sql`drop function reject_reviewer_card_expiry()`);
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.scope.issueId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, f.handoff.review.id));
    const [card] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.handoff.interaction.id));
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, f.reviewerOwner.runId));
    expect(issue.status).toBe("in_review");
    expect(review.state).toBe("pending");
    expect(card.status).toBe("pending");
    expect(lease.releasedAt).toBeNull();
  }, 30_000);
});
