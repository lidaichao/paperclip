import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem, tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  closeRegisteredClients,
  costEvents,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
  projects,
  runDatabaseBackup,
  runDatabaseRestore,
  workRecordDependencies,
  workRecordDispatchBatches,
  workRecordExecutionIntents,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecordQualityCycles,
  workRecords,
} from "@paperclipai/db";
import type { PreviewWorkPackageDispatch } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { workRecordRoutes } from "../routes/work-records.js";
import { workPackageDispatchService } from "../services/work-package-dispatch.js";
import { workRecordService } from "../services/work-records.js";
import { reconcileCandidatesIndependently } from "../services/work-record-candidate-scan.js";
import { createWorkRecordWorkflowTick } from "../services/work-record-workflow-tick.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("M2-E workflow hardening", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-m2e-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  async function seed(label: string) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({ name: `${label} ${suffix}`, issuePrefix: `E${suffix}` })
      .returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({ companyId: company.id, name: label })
      .returning().then((rows) => rows[0]);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Rabbit M2-E",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
    }).returning().then((rows) => rows[0]);
    return { company, project, agent, records: workRecordService(db) };
  }

  function createApi(
    companyId: string,
    membershipRole: "admin" | "viewer" = "admin",
    database: ReturnType<typeof createDb> = db,
  ) {
    const previous = process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
    process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = "true";
    const router = workRecordRoutes(database);
    if (previous === undefined) delete process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
    else process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = previous;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: `m2e-${membershipRole}`,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole, status: "active" }],
        source: "session",
        isInstanceAdmin: membershipRole === "admin",
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", router);
    app.use(errorHandler);
    return app;
  }

  function input(projectId: string, selectedRecordIds: string[]): PreviewWorkPackageDispatch {
    return {
      workflowVersion: 2,
      projectId,
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds,
    };
  }

  async function prepare(companyId: string, projectId: string, selectedRecordIds: string[], requestId: string) {
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const command = input(projectId, selectedRecordIds);
    const preview = await service.preview(companyId, projectId, command);
    return service.prepare(companyId, projectId, {
      ...command,
      clientRequestId: requestId,
      requestPayloadDigest: `digest:${requestId}`,
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "m2e-test" });
  }

  it("isolates a bad candidate, advances to the next page, and still reaches both outboxes", async () => {
    const candidates = [{ id: "0001" }, { id: "0002" }];
    const visited: string[] = [];
    const outboxes: string[] = [];

    const scan = async (afterId: string | null) => {
      const rows = candidates.filter((candidate) => afterId === null || candidate.id > afterId).slice(0, 1);
      const settled = await reconcileCandidatesIndependently(rows, async (candidate) => {
        visited.push(candidate.id);
        if (candidate.id === "0001") throw Object.assign(new Error("injected candidate failure"), { code: "m2e_bad_candidate" });
      });
      return { ...settled, nextAfterId: rows.at(-1)?.id ?? null };
    };

    const emptyPage = async () => ({ processed: 0, succeeded: 0, failures: [], nextAfterId: null });
    const tick = createWorkRecordWorkflowTick({
      records: async (afterId) => {
        const page = await scan(afterId);
        return { processed: 1, ...page };
      },
      qualityCycles: emptyPage,
      packages: emptyPage,
      legacyOutbox: async () => { outboxes.push("legacy"); return 1; },
      workflowV2Outbox: async () => { outboxes.push("workflow-v2"); return 1; },
    });

    const first = await tick();
    expect(first.candidates.records).toEqual({
      processed: 1,
      succeeded: 0,
      failures: [{ id: "0001", code: "m2e_bad_candidate" }],
      nextAfterId: "0001",
    });
    expect(first.outbox).toEqual({ legacyProcessed: 1, workflowV2Processed: 1 });
    const second = await tick();
    expect(second.candidates.records).toEqual({ processed: 1, succeeded: 1, failures: [], nextAfterId: "0002" });
    expect(second.outbox).toEqual({ legacyProcessed: 1, workflowV2Processed: 1 });
    expect(visited).toEqual(["0001", "0002"]);
    expect(outboxes).toEqual(["legacy", "workflow-v2", "legacy", "workflow-v2"]);
  });

  it("paginates records compatibly and rotates package reconciliation candidates", async () => {
    const context = await seed("M2-E pagination");
    const created = [];
    for (const title of ["Page A", "Page B", "Page C"]) {
      created.push(await context.records.create(context.company.id, {
        projectId: context.project.id,
        kind: "plan",
        title,
        assigneeAgentId: context.agent.id,
      }, { actorType: "system", actorId: "m2e-test" }));
    }
    const app = createApi(context.company.id);
    const base = `/api/companies/${context.company.id}/projects/${context.project.id}/work-records`;
    const legacy = await request(app).get(base).expect(200);
    expect(Array.isArray(legacy.body)).toBe(true);
    expect(legacy.body).toHaveLength(3);

    const first = await request(app).get(`${base}?limit=2`).expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app).get(`${base}?limit=2&afterId=${first.body.nextCursor}`).expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect(new Set([...first.body.items, ...second.body.items].map((row: { id: string }) => row.id)).size).toBe(3);

    await prepare(context.company.id, context.project.id, [created[0].id], "m2e-page-batch-a");
    await prepare(context.company.id, context.project.id, [created[1].id], "m2e-page-batch-b");
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const firstCandidates = await service.reconcilePage(1);
    expect(firstCandidates).toMatchObject({ processed: 1, nextAfterId: expect.any(String) });
    const secondCandidates = await service.reconcilePage(1, firstCandidates.nextAfterId);
    expect(secondCandidates).toMatchObject({ processed: 1, nextAfterId: null });
  });

  it("dead-letters after five failures, recovers the same row, and exposes cost/rollback metrics", async () => {
    const context = await seed("M2-E recovery");
    await db.update(workRecordOutbox).set({ state: "superseded", updatedAt: new Date() }).where(eq(workRecordOutbox.workflowVersion, 2));
    const target = await context.records.create(context.company.id, {
      projectId: context.project.id,
      kind: "plan",
      title: "Dead-letter target",
      assigneeAgentId: context.agent.id,
    }, { actorType: "system", actorId: "m2e-test" });
    await prepare(context.company.id, context.project.id, [target.id], "m2e-dead-letter");
    const link = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      eq(workRecordIssueLinks.recordId, target.id),
    )).then((rows) => rows[0]);
    await db.update(issues).set({ responsibleUserId: "m2e-owner" }).where(eq(issues.id, link.issueId));
    const event = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.recordId, target.id),
      eq(workRecordOutbox.workflowVersion, 2),
    )).then((rows) => rows[0]);
    const service = workPackageDispatchService(db, { writesEnabled: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.processOutbox(async () => {
        throw new Error("m2e_injected_wakeup_failure");
      }, 1);
      await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) })
        .where(eq(workRecordOutbox.id, event.id));
    }
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.id, event.id)).then((rows) => rows[0]))
      .toMatchObject({ id: event.id, state: "dead_letter", attemptCount: 5, recoveryCount: 0 });
    const before = await service.operationsMetrics(context.company.id, context.project.id);
    expect(before.outbox).toMatchObject({ deadLetter: 1, maxAttempts: 5 });
    expect(before.rollback).toMatchObject({ safeForOldBinary: false, actionableOutboxEvents: 1 });

    const app = createApi(context.company.id);
    const recoveryPath = `/api/companies/${context.company.id}/projects/${context.project.id}/work-record-workflow/outbox/${event.id}/recover`;
    const conflict = await request(app).post(recoveryPath)
      .send({ expectedAttemptCount: 4, reason: "stale operator observation" }).expect(409);
    expect(conflict.body.details).toMatchObject({ code: "work_record_outbox_attempt_conflict" });
    await request(createApi(context.company.id, "viewer")).post(recoveryPath)
      .send({ expectedAttemptCount: 5, reason: "viewer cannot recover" }).expect(403);
    const recovered = await request(app).post(recoveryPath)
      .send({ expectedAttemptCount: 5, reason: "isolated M2-E recovery proof" }).expect(200);
    expect(recovered.body).toMatchObject({ id: event.id, state: "pending", attemptCount: 0, recoveryCount: 1 });

    const wake = await db.insert(agentWakeupRequests).values({
      companyId: context.company.id,
      agentId: context.agent.id,
      source: "assignment",
      triggerDetail: "system",
      reason: "work_record_workflow_v2_released",
      status: "completed",
      idempotencyKey: `work-record-intent:${event.executionIntentId}:1`,
      finishedAt: new Date(),
    }).returning().then((rows) => rows[0]);
    const run = await db.insert(heartbeatRuns).values({
      companyId: context.company.id,
      agentId: context.agent.id,
      status: "succeeded",
      wakeupRequestId: wake.id,
      startedAt: new Date(),
      finishedAt: new Date(),
    }).returning().then((rows) => rows[0]);
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    await service.processOutbox(async () => {
      throw new Error("existing admission receipt must prevent a duplicate wake");
    }, 1);
    expect(run).toMatchObject({ status: "succeeded" });
    await db.insert(costEvents).values({
      companyId: context.company.id,
      agentId: context.agent.id,
      issueId: link.issueId,
      projectId: context.project.id,
      heartbeatRunId: run.id,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "m2e-cost-proof",
      costCents: 37,
      occurredAt: new Date(),
    });
    await db.update(workRecordExecutionIntents).set({
      state: "waiting_governance",
      waitingReason: "budget_hard_stop",
      updatedAt: new Date(),
    }).where(eq(workRecordExecutionIntents.id, event.executionIntentId!));
    await db.update(workRecordOutbox).set({
      attemptCount: 99,
      updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1_000),
    }).where(eq(workRecordOutbox.id, event.id));

    const preview = await request(app)
      .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/preview`)
      .send(input(context.project.id, [target.id]))
      .expect(200);
    await request(app)
      .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/prepare`)
      .send({
        ...input(context.project.id, [target.id]),
        clientRequestId: "m2e-stale-scope-metric",
        requestPayloadDigest: "m2e-stale-scope-metric",
        expectedScopeDigest: "stale-scope-digest",
        expectedRootRevision: preview.body.rootRevision,
        expectedDependencySetRevision: preview.body.dependencySetRevision,
      })
      .expect(409);
    const after = await service.operationsMetrics(context.company.id, context.project.id);
    expect(after.outbox).toMatchObject({
      deadLetter: 0,
      recoveredEventCount: 1,
      attemptP95: null,
      attemptWindow: { hours: 24, states: ["pending", "retry", "processing"], timestampField: "updatedAt" },
    });
    expect(after.execution).toMatchObject({ runs: 1, costEvents: 1, costCents: 37 });
    expect(after.consistency).toMatchObject({
      staleEvents: 0,
      orphanLinks: 0,
      orphanIntents: 0,
      scopeDigestMismatchesLast24Hours: 1,
    });
    expect(after.runtimeSafety).toEqual({
      duplicateWakeIntents: 0,
      duplicateRunIntents: 0,
      effectiveWakeStatuses: ["queued", "claimed", "completed"],
      effectiveRunStatuses: ["queued", "running", "succeeded"],
      issuesWithMultipleActiveIntents: 0,
      issuesWithMultipleActiveRuns: 0,
    });
    expect(after.quality).toMatchObject({ maxReworkRound: 0, unverifiedDefects: 0 });
    expect(after.governance).toMatchObject({ totalWait: 1, budgetWait: 1, pauseWait: 0, approvalWait: 0 });
    expect(after.rejections).toMatchObject({
      windowHours: 24,
      byStatus: { forbidden403: 0, conflict409: 1, unprocessable422: 0 },
    });
    expect(after.rollback).toMatchObject({ safeForOldBinary: false, activeIntents: 1, actionableOutboxEvents: 0 });
  }, 30_000);

  it("classifies effective execution, consistency, quality waits, governance, and rejections exactly", async () => {
    const context = await seed("M2-E exact metrics");
    const targets = [];
    for (const title of ["Exact metrics A", "Exact metrics B"]) {
      targets.push(await context.records.create(context.company.id, {
        projectId: context.project.id,
        kind: "plan",
        title,
        assigneeAgentId: context.agent.id,
      }, { actorType: "system", actorId: "m2e-test" }));
    }
    await prepare(context.company.id, context.project.id, [targets[0].id], "m2e-exact-a");
    await prepare(context.company.id, context.project.id, [targets[1].id], "m2e-exact-b");
    const intents = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.projectId, context.project.id),
    ));
    expect(intents).toHaveLength(2);

    const insertWakeAndRun = async (intent: typeof intents[number], status: "succeeded" | "failed") => {
      const wake = await db.insert(agentWakeupRequests).values({
        companyId: context.company.id,
        agentId: context.agent.id,
        source: "assignment",
        triggerDetail: "system",
        reason: "work_record_workflow_v2_released",
        status: status === "succeeded" ? "completed" : "failed",
        idempotencyKey: `work-record-intent:${intent.id}:${intent.generation}`,
        finishedAt: new Date(),
      }).returning().then((rows) => rows[0]);
      const run = await db.insert(heartbeatRuns).values({
        companyId: context.company.id,
        agentId: context.agent.id,
        status,
        wakeupRequestId: wake.id,
        startedAt: new Date(),
        finishedAt: new Date(),
      }).returning().then((rows) => rows[0]);
      await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
      return { wake, run };
    };
    await insertWakeAndRun(intents[0], "succeeded");
    await insertWakeAndRun(intents[0], "failed");
    await insertWakeAndRun(intents[1], "succeeded");
    const duplicate = await insertWakeAndRun(intents[1], "succeeded");

    const outboxes = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.projectId, context.project.id),
    ));
    expect(outboxes).toHaveLength(2);
    await db.update(workRecordOutbox).set({ state: "superseded", lastError: "stale_issue_revision" })
      .where(eq(workRecordOutbox.id, outboxes[0].id));
    await db.update(workRecordOutbox).set({ state: "superseded", lastError: "Unsupported work-record workflow v2 event" })
      .where(eq(workRecordOutbox.id, outboxes[1].id));

    await db.insert(workRecordQualityCycles).values([
      {
        companyId: context.company.id,
        projectId: context.project.id,
        aggregateRecordId: targets[0].id,
        cycleNumber: 1,
        kind: "metrics_fixture",
        state: "open",
        qualityPhase: "qa_initial",
        scopeDigest: "m2e-exact-qa-open",
      },
      {
        companyId: context.company.id,
        projectId: context.project.id,
        aggregateRecordId: targets[1].id,
        cycleNumber: 1,
        kind: "metrics_fixture",
        state: "accepted",
        qualityPhase: "qa_initial",
        scopeDigest: "m2e-exact-qa-closed",
      },
    ]);

    const app = createApi(context.company.id);
    const base = `/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch`;
    const preview = await request(app).post(`${base}/preview`)
      .send(input(context.project.id, [targets[0].id])).expect(200);
    await request(app).post(`${base}/prepare`).send({
      ...input(context.project.id, [targets[0].id]),
      clientRequestId: "m2e-exact-scope-mismatch",
      requestPayloadDigest: "m2e-exact-scope-mismatch",
      expectedScopeDigest: "not-the-current-scope",
      expectedRootRevision: preview.body.rootRevision,
      expectedDependencySetRevision: preview.body.dependencySetRevision,
    }).expect(409);
    await request(app).post(`${base}/prepare`).send({
      ...input(context.project.id, [targets[0].id]),
      clientRequestId: "m2e-exact-revision-mismatch",
      requestPayloadDigest: "m2e-exact-revision-mismatch",
      expectedScopeDigest: preview.body.scopeDigest,
      expectedRootRevision: preview.body.rootRevision + 1,
      expectedDependencySetRevision: preview.body.dependencySetRevision,
    }).expect(409);

    const rejectionRows = [
      { status: 403, code: "work_record_workflow_role_denied" },
      { status: 403, code: "authorization_permission_denied" },
      { status: 422, code: "work_record_workflow_project_boundary" },
      { status: 422, code: "work_record_quality_target_invalid" },
    ];
    await db.insert(activityLog).values(rejectionRows.map((error, index) => ({
      companyId: context.company.id,
      actorType: "system",
      actorId: "m2e-test",
      action: index < 2 ? "work_record.quality_command" : "work_record.dispatch_command",
      entityType: "work_record_metrics_fixture",
      entityId: `m2e-exact-rejection-${index}`,
      details: { projectId: context.project.id, outcome: "rejected", error },
    })));

    await db.update(workRecordExecutionIntents).set({ state: "waiting_governance", waitingReason: "budget.blocked" })
      .where(eq(workRecordExecutionIntents.id, intents[0].id));
    await db.update(workRecordExecutionIntents).set({ state: "waiting_governance", waitingReason: "budgetish_unknown" })
      .where(eq(workRecordExecutionIntents.id, intents[1].id));
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const positive = await service.operationsMetrics(context.company.id, context.project.id);
    expect(positive.execution).toMatchObject({ wakes: 4, runs: 4, effectiveWakes: 3, effectiveRuns: 3 });
    expect(positive.runtimeSafety).toMatchObject({ duplicateWakeIntents: 1, duplicateRunIntents: 1 });
    expect(positive.consistency).toMatchObject({ staleEvents: 1, scopeDigestMismatchesLast24Hours: 1 });
    expect(positive.quality.qaWait).toMatchObject({ count: 1, oldestSeconds: expect.any(Number) });
    expect(positive.governance).toMatchObject({ totalWait: 2, budgetWait: 1, pauseWait: 0, approvalWait: 0, otherWait: 1 });
    expect(positive.rejections).toMatchObject({
      byStatus: { forbidden403: 2, conflict409: 2, unprocessable422: 2 },
      roleDenied: 1,
      crossScope: 1,
    });

    await db.update(agentWakeupRequests).set({ status: "failed" }).where(eq(agentWakeupRequests.id, duplicate.wake.id));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, duplicate.run.id));
    await db.update(workRecordExecutionIntents).set({ waitingReason: "company.inactive" })
      .where(eq(workRecordExecutionIntents.id, intents[0].id));
    await db.update(workRecordExecutionIntents).set({ waitingReason: "governance_pending" })
      .where(eq(workRecordExecutionIntents.id, intents[1].id));
    const negative = await service.operationsMetrics(context.company.id, context.project.id);
    expect(negative.execution).toMatchObject({ wakes: 4, runs: 4, effectiveWakes: 2, effectiveRuns: 2 });
    expect(negative.runtimeSafety).toMatchObject({ duplicateWakeIntents: 0, duplicateRunIntents: 0 });
    expect(negative.governance).toMatchObject({ totalWait: 2, budgetWait: 0, pauseWait: 1, approvalWait: 1, otherWait: 0 });
  }, 30_000);

  it("accepts 200 records/8 levels/2,000 edges and rejects each +1 boundary without writes", async () => {
    const context = await seed("M2-E capacity");
    const ids = Array.from({ length: 200 }, () => randomUUID());
    await db.insert(workRecords).values(ids.map((id, index) => ({
      id,
      companyId: context.company.id,
      projectId: context.project.id,
      parentRecordId: index === 0 ? null : index <= 8 ? ids[index - 1] : ids[0],
      kind: "plan" as const,
      title: `Capacity ${index}`,
      assigneeAgentId: context.agent.id,
    })));
    const edges: Array<{
      companyId: string;
      projectId: string;
      predecessorRecordId: string;
      successorRecordId: string;
    }> = [];
    for (let successor = 1; successor < ids.length && edges.length < 2_000; successor += 1) {
      for (let predecessor = 0; predecessor < successor && edges.length < 2_000; predecessor += 1) {
        edges.push({
          companyId: context.company.id,
          projectId: context.project.id,
          predecessorRecordId: ids[predecessor],
          successorRecordId: ids[successor],
        });
      }
    }
    await db.insert(workRecordDependencies).values(edges);
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const command: PreviewWorkPackageDispatch = {
      workflowVersion: 2,
      projectId: context.project.id,
      scopeKind: "whole_package",
      rootRecordId: ids[0],
      selectedRecordIds: [],
    };
    const durationsMs: number[] = [];
    for (let sample = 0; sample < 30; sample += 1) {
      const startedAt = performance.now();
      const preview = await service.preview(context.company.id, context.project.id, command);
      durationsMs.push(performance.now() - startedAt);
      expect(preview).toMatchObject({ recordCount: 200, edgeCount: 2_000, maxDepth: 8 });
    }

    const extraEdgeId = randomUUID();
    await db.insert(workRecordDependencies).values({
      id: extraEdgeId,
      companyId: context.company.id,
      projectId: context.project.id,
      predecessorRecordId: ids[198],
      successorRecordId: ids[199],
    });
    await expect(service.preview(context.company.id, context.project.id, command)).rejects.toMatchObject({
      status: 422,
      details: { code: "work_package_dependency_snapshot_too_large", limit: 2_000, actual: 2_001 },
    });
    await db.delete(workRecordDependencies).where(eq(workRecordDependencies.id, extraEdgeId));

    await db.update(workRecords).set({ parentRecordId: ids[8] }).where(eq(workRecords.id, ids[9]));
    await expect(service.preview(context.company.id, context.project.id, command)).rejects.toMatchObject({
      status: 422,
      details: { code: "work_package_depth_too_large", limit: 8, actual: 9 },
    });
    await db.update(workRecords).set({ parentRecordId: ids[0] }).where(eq(workRecords.id, ids[9]));

    const extraRecordId = randomUUID();
    await db.insert(workRecords).values({
      id: extraRecordId,
      companyId: context.company.id,
      projectId: context.project.id,
      parentRecordId: ids[0],
      kind: "plan",
      title: "Capacity 201",
      assigneeAgentId: context.agent.id,
    });
    await expect(service.preview(context.company.id, context.project.id, command)).rejects.toMatchObject({
      status: 422,
      details: { code: "work_package_scope_too_large", limit: 200, actual: 201 },
    });
    expect(await db.select().from(workRecordDispatchBatches).where(eq(workRecordDispatchBatches.companyId, context.company.id)))
      .toHaveLength(0);
    await db.delete(workRecords).where(eq(workRecords.id, extraRecordId));

    let queryCount = 0;
    const measuredDb = createDb(tempDb!.connectionString, {
      applicationName: "paperclip-m2e-performance",
      debug: () => { queryCount += 1; },
    });
    const performanceApp = createApi(context.company.id, "admin", measuredDb);
    const listPath = `/api/companies/${context.company.id}/projects/${context.project.id}/work-records`;
    const previewPath = `/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/preview`;
    const slo = {
      listP95Ms: 2_000,
      readinessP95Ms: 2_000,
      maxQueriesPerRequest: 25,
      maxResponseBytes: 2 * 1024 * 1024,
      maxRssGrowthBytes: 128 * 1024 * 1024,
      maxLockWaiters: 0,
      minimumLogicalCpu: 2,
      minimumMemoryBytes: 4 * 1024 * 1024 * 1024,
    };
    const environment = {
      platform: platform(),
      release: release(),
      architecture: process.arch,
      node: process.version,
      logicalCpu: cpus().length,
      cpuModel: cpus()[0]?.model ?? "unknown",
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freemem(),
      postgresVersion: (await measuredDb.execute<{ version: string }>(sql`select version() as version`))[0]?.version ?? "unknown",
    };
    expect(environment.logicalCpu).toBeGreaterThanOrEqual(slo.minimumLogicalCpu);
    expect(environment.totalMemoryBytes).toBeGreaterThanOrEqual(slo.minimumMemoryBytes);

    const requestSample = async (kind: "list" | "readiness") => {
      queryCount = 0;
      const cpuBefore = process.cpuUsage();
      const rssBefore = process.memoryUsage().rss;
      const startedAt = performance.now();
      const response = kind === "list"
        ? await request(performanceApp).get(`${listPath}?limit=100`).expect(200)
        : await request(performanceApp).post(previewPath).send(command).expect(200);
      const cpu = process.cpuUsage(cpuBefore);
      return {
        latencyMs: performance.now() - startedAt,
        queryCount,
        responseBytes: Buffer.byteLength(response.text, "utf8"),
        cpuMicros: cpu.user + cpu.system,
        rssGrowthBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
      };
    };

    // Warm both paths before collecting the fixed 30-sample evidence set.
    await requestSample("list");
    await requestSample("readiness");
    queryCount = 0;
    await request(performanceApp).get(`${listPath}?limit=1`).expect(200);
    const oneRowQueryCount = queryCount;
    queryCount = 0;
    const firstPage = await request(performanceApp).get(`${listPath}?limit=100`).expect(200);
    const hundredRowQueryCount = queryCount;
    const secondPage = await request(performanceApp)
      .get(`${listPath}?limit=100&afterId=${firstPage.body.nextCursor}`).expect(200);
    expect(firstPage.body.items).toHaveLength(100);
    expect(secondPage.body.items).toHaveLength(100);
    expect(secondPage.body.nextCursor).toBeNull();
    expect(new Set([...firstPage.body.items, ...secondPage.body.items].map((row: { id: string }) => row.id)).size).toBe(200);
    expect(hundredRowQueryCount).toBeLessThanOrEqual(oneRowQueryCount + 1);

    const listSamples = [] as Awaited<ReturnType<typeof requestSample>>[];
    const readinessSamples = [] as Awaited<ReturnType<typeof requestSample>>[];
    const lockWaiters: number[] = [];
    for (let sample = 0; sample < 30; sample += 1) {
      listSamples.push(await requestSample("list"));
      readinessSamples.push(await requestSample("readiness"));
      const [locks] = await measuredDb.execute<{ count: number }>(sql`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `);
      lockWaiters.push(Number(locks?.count ?? 0));
    }
    const percentile = (values: number[], ratio: number) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.ceil((sorted.length - 1) * ratio)];
    };
    const summarize = (samples: typeof listSamples) => ({
      raw: samples,
      latencyMs: { p50: percentile(samples.map((sample) => sample.latencyMs), 0.5), p95: percentile(samples.map((sample) => sample.latencyMs), 0.95), max: Math.max(...samples.map((sample) => sample.latencyMs)) },
      queryCount: { min: Math.min(...samples.map((sample) => sample.queryCount)), max: Math.max(...samples.map((sample) => sample.queryCount)) },
      responseBytes: { max: Math.max(...samples.map((sample) => sample.responseBytes)) },
      cpuMicros: { p95: percentile(samples.map((sample) => sample.cpuMicros), 0.95) },
      rssGrowthBytes: { max: Math.max(...samples.map((sample) => sample.rssGrowthBytes)) },
    });
    const listPerformance = summarize(listSamples);
    const readinessPerformance = summarize(readinessSamples);
    expect(listPerformance.latencyMs.p95).toBeLessThanOrEqual(slo.listP95Ms);
    expect(readinessPerformance.latencyMs.p95).toBeLessThanOrEqual(slo.readinessP95Ms);
    expect(Math.max(listPerformance.queryCount.max, readinessPerformance.queryCount.max)).toBeLessThanOrEqual(slo.maxQueriesPerRequest);
    expect(Math.max(listPerformance.responseBytes.max, readinessPerformance.responseBytes.max)).toBeLessThanOrEqual(slo.maxResponseBytes);
    expect(Math.max(listPerformance.rssGrowthBytes.max, readinessPerformance.rssGrowthBytes.max)).toBeLessThanOrEqual(slo.maxRssGrowthBytes);
    expect(Math.max(...lockWaiters)).toBeLessThanOrEqual(slo.maxLockWaiters);

    const listPlan = await measuredDb.execute(sql.raw(`explain (analyze, buffers, format json)
      select id from work_records
      where company_id = '${context.company.id}' and project_id = '${context.project.id}'
      order by id asc limit 101`));
    const readinessPlan = await measuredDb.execute(sql.raw(`explain (analyze, buffers, format json)
      select not exists (
        select 1 from work_record_quality_items qi
        join work_record_quality_cycles qc on qc.id = qi.cycle_id
        where qc.company_id = '${context.company.id}' and qc.project_id = '${context.project.id}'
          and qi.required = true and qi.state <> 'accepted'
      ) as ready`));

    durationsMs.sort((left, right) => left - right);
    const evidence = {
      schemaVersion: 2,
      testedCommit: process.env.PAPERCLIP_M2E_TESTED_COMMIT ?? null,
      environment,
      slo,
      fixture: { records: 200, maxDepth: 8, edges: 2_000, samples: durationsMs.length },
      servicePreviewLatencyMs: {
        min: durationsMs[0],
        p50: durationsMs[Math.floor((durationsMs.length - 1) * 0.5)],
        p95: durationsMs[Math.ceil((durationsMs.length - 1) * 0.95)],
        max: durationsMs.at(-1),
      },
      api: {
        pagination: { pageSize: 100, pages: 2, uniqueRecords: 200, oneRowQueryCount, hundredRowQueryCount },
        list: listPerformance,
        readiness: readinessPerformance,
        lockWaiters,
      },
      queryPlans: { list: listPlan, readiness: readinessPlan },
      rejected: [
        { code: "work_package_scope_too_large", actual: 201 },
        { code: "work_package_depth_too_large", actual: 9 },
        { code: "work_package_dependency_snapshot_too_large", actual: 2_001 },
      ],
    };
    const evidenceDir = process.env.PAPERCLIP_M2E_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "capacity-performance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
  }, 240_000);

  it("backs up and restores workflow-v2 recovery facts into an empty isolated database", async () => {
    const sourceEvent = await db.select().from(workRecordOutbox)
      .where(eq(workRecordOutbox.recoveryCount, 1)).then((rows) => rows[0]);
    expect(sourceEvent).toBeTruthy();
    const backupDir = await mkdtemp(path.join(tmpdir(), "paperclip-m2e-backup-"));
    const sourceUrl = new URL(tempDb!.connectionString);
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    const restoredDatabaseName = `m2e_restore_${randomUUID().replaceAll("-", "")}`;
    const restoredUrl = new URL(sourceUrl);
    restoredUrl.pathname = `/${restoredDatabaseName}`;
    try {
      const backup = await runDatabaseBackup({
        connectionString: sourceUrl.toString(),
        backupDir,
        filenamePrefix: "lun-305-workflow-v2",
        retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
        backupEngine: "javascript",
      });
      await ensurePostgresDatabase(adminUrl.toString(), restoredDatabaseName);
      await runDatabaseRestore({ connectionString: restoredUrl.toString(), backupFile: backup.backupFile });
      const restoredDb = createDb(restoredUrl.toString());
      const restoredEvent = await restoredDb.select().from(workRecordOutbox)
        .where(eq(workRecordOutbox.id, sourceEvent.id)).then((rows) => rows[0]);
      expect(restoredEvent).toMatchObject({
        id: sourceEvent.id,
        workflowVersion: 2,
        state: sourceEvent.state,
        recoveryCount: 1,
        lastRecoveredAt: expect.any(Date),
      });
      const evidenceDir = process.env.PAPERCLIP_M2E_EVIDENCE_DIR?.trim();
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(path.join(evidenceDir, "backup-restore.json"), `${JSON.stringify({
          schemaVersion: 1,
          testedCommit: process.env.PAPERCLIP_M2E_TESTED_COMMIT ?? null,
          backupSizeBytes: backup.sizeBytes,
          restoredEvent: {
            id: restoredEvent.id,
            workflowVersion: restoredEvent.workflowVersion,
            state: restoredEvent.state,
            recoveryCount: restoredEvent.recoveryCount,
            lastRecoveredAt: restoredEvent.lastRecoveredAt,
          },
        }, null, 2)}\n`, "utf8");
      }
      await closeRegisteredClients(restoredUrl.toString());
    } finally {
      await closeRegisteredClients(restoredUrl.toString()).catch(() => {});
      await rm(backupDir, { recursive: true, force: true });
    }
  }, 120_000);
});
