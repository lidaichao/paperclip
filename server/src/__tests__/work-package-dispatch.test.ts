import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agentApiKeys,
  agents,
  authUsers,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
  localAgentDeviceBindings,
  localIssueCompletionCommands,
  projects,
  workRecords,
  workRecordAssignmentGapEscalations,
  workRecordDispatchBatches,
  workRecordDispatchBatchItems,
  workRecordDependencySnapshots,
  workRecordExecutionHolds,
  workRecordExecutionIntents,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecordQualityCycles,
} from "@paperclipai/db";
import type { PreviewWorkPackageDispatch } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workPackageDispatchService, type WorkPackageFailpoint } from "../services/work-package-dispatch.js";
import { heartbeatService } from "../services/heartbeat.js";
import { localAgentRunLeaseService } from "../services/local-agent-run-leases.js";
import { issueService } from "../services/issues.js";
import { workRecordService } from "../services/work-records.js";
import { createWorkRecordWorkflowTick } from "../services/work-record-workflow-tick.js";
import { workRecordRoutes } from "../routes/work-records.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("M2-B work-package dispatch and cancellation source barrier", () => {
  let db!: ReturnType<typeof createDb>;
  let secondDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-package-dispatch-");
    db = createDb(tempDb.connectionString);
    secondDb = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({ name: `M2B ${suffix}`, issuePrefix: `M${suffix}` }).returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({ companyId: company.id, name: "M2B package" }).returning().then((rows) => rows[0]);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Rabbit",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "console.log('work-record release'); process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
    }).returning().then((rows) => rows[0]);
    return { company, project, agent, records: workRecordService(db) };
  }

  async function record(
    context: Awaited<ReturnType<typeof seed>>,
    title: string,
    options: { parentRecordId?: string; predecessorRecordIds?: string[]; assigned?: boolean } = {},
  ) {
    return context.records.create(context.company.id, {
      projectId: context.project.id,
      parentRecordId: options.parentRecordId,
      kind: "plan",
      title,
      assigneeAgentId: options.assigned === false ? null : context.agent.id,
      predecessorRecordIds: options.predecessorRecordIds ?? [],
    }, { actorType: "system", actorId: "test" });
  }

  function scopeInput(
    context: Awaited<ReturnType<typeof seed>>,
    input: Omit<PreviewWorkPackageDispatch, "workflowVersion" | "projectId">,
  ): PreviewWorkPackageDispatch {
    return { workflowVersion: 2, projectId: context.project.id, ...input };
  }

  function createApi(
    database: typeof db,
    companyId: string,
    writesEnabled: boolean,
    membershipRole = "admin",
    heartbeat?: Parameters<typeof workRecordRoutes>[1]["heartbeat"],
  ) {
    const router = workRecordRoutes(database, {
      heartbeat,
      workflowV2WritesEnabled: writesEnabled,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: `api-${membershipRole}`,
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

  async function prepare(
    service: ReturnType<typeof workPackageDispatchService>,
    context: Awaited<ReturnType<typeof seed>>,
    input: PreviewWorkPackageDispatch,
    requestId = randomUUID(),
  ) {
    const preview = await service.preview(context.company.id, context.project.id, input);
    return service.prepare(context.company.id, context.project.id, {
      ...input,
      clientRequestId: requestId,
      requestPayloadDigest: `payload:${requestId}`,
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "test" });
  }

  async function eightLayerSnapshot(companyId: string, recordId: string) {
    const records = await db.select().from(workRecords).where(and(
      eq(workRecords.companyId, companyId), eq(workRecords.id, recordId),
    ));
    const items = await db.select().from(workRecordDispatchBatchItems).where(and(
      eq(workRecordDispatchBatchItems.companyId, companyId),
      eq(workRecordDispatchBatchItems.recordId, recordId),
    ));
    const batches = items.length === 0 ? [] : await db.select().from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, companyId),
      inArray(workRecordDispatchBatches.id, [...new Set(items.map((item) => item.batchId))]),
    ));
    const links = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, companyId), eq(workRecordIssueLinks.recordId, recordId),
    ));
    const intents = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, companyId), eq(workRecordExecutionIntents.recordId, recordId),
    ));
    const outbox = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, companyId), eq(workRecordOutbox.recordId, recordId),
    ));
    const wakeKeys = intents.map((intent) => `work-record-intent:${intent.id}:${intent.generation}`);
    const wakes = wakeKeys.length === 0 ? [] : await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.idempotencyKey, wakeKeys),
    ));
    const runs = wakes.length === 0 ? [] : await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.wakeupRequestId, wakes.map((wake) => wake.id)),
    ));
    const layer = <T extends { id: string }>(rows: T[], isEffective: (row: T) => boolean = () => true) => ({
      ids: rows.map((row) => row.id),
      states: rows.map((row) => "state" in row ? String(row.state) : "status" in row ? String(row.status) : null),
      effectiveCount: rows.filter(isEffective).length,
    });
    return {
      record: layer(records),
      batch: layer(batches, (row) => !["failed", "superseded"].includes(row.state)),
      item: layer(items, (row) => !["failed", "blocked"].includes(row.materializationState)),
      link: layer(links),
      intent: layer(intents, (row) => !["superseded", "cancelled"].includes(row.state)),
      outbox: layer(outbox, (row) => !["superseded", "failed"].includes(row.state)),
      wake: layer(wakes, (row) => ["queued", "claimed", "running", "completed"].includes(row.status)),
      run: layer(runs, (row) => ["queued", "running", "succeeded"].includes(row.status)),
    };
  }

  async function isolatePendingV2Outbox(companyId: string) {
    await db.update(workRecordOutbox).set({ state: "superseded", updatedAt: new Date() }).where(and(
      eq(workRecordOutbox.workflowVersion, 2),
      ne(workRecordOutbox.companyId, companyId),
      inArray(workRecordOutbox.state, ["pending", "retry", "processing"]),
    ));
  }

  it("D01 keeps writes disabled by default while preview remains read-only", async () => {
    const context = await seed();
    const target = await record(context, "Preview only");
    const service = workPackageDispatchService(db, { writesEnabled: false });
    const input = scopeInput(context, { scopeKind: "selected_records", rootRecordId: null, selectedRecordIds: [target.id] });
    const preview = await service.preview(context.company.id, context.project.id, input);
    expect(preview.records.map((item) => item.id)).toEqual([target.id]);
    await expect(service.prepare(context.company.id, context.project.id, {
      ...input,
      clientRequestId: "disabled",
      requestPayloadDigest: "disabled",
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "test" })).rejects.toMatchObject({
      status: 403,
      details: { code: "work_record_workflow_v2_disabled" },
    });
  });

  it("D06 exercises two real API clients plus default-off and viewer contracts", async () => {
    const context = await seed();
    const target = await record(context, "API race target");
    const input = scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [target.id],
    });
    const enabledApp = createApi(db, context.company.id, true);
    const previewResponse = await request(enabledApp)
      .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/preview`)
      .send(input)
      .expect(200);
    const prepareBody = {
      ...input,
      clientRequestId: "api-double-client",
      requestPayloadDigest: "api-double-client-payload",
      expectedScopeDigest: previewResponse.body.scopeDigest,
      expectedRootRevision: previewResponse.body.rootRevision,
      expectedDependencySetRevision: previewResponse.body.dependencySetRevision,
    };
    const endpoint = `/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/prepare`;
    const [left, right] = await Promise.all([
      request(enabledApp).post(endpoint).send(prepareBody),
      request(enabledApp).post(endpoint).send(prepareBody),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 201]);
    expect(left.body.batch.id).toBe(right.body.batch.id);
    const conflictResponse = await request(enabledApp)
      .post(endpoint)
      .send({ ...prepareBody, requestPayloadDigest: "api-conflicting-payload" })
      .expect(409);
    expect(conflictResponse.body.details).toMatchObject({ code: "work_record_workflow_idempotency_conflict" });

    const viewerResponse = await request(createApi(db, context.company.id, true, "viewer"))
      .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/${left.body.batch.id}/reconcile`)
      .send({})
      .expect(403);
    const disabledApp = createApi(db, context.company.id, false);
    const disabledPreview = await request(disabledApp)
      .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/preview`)
      .send(input)
      .expect(200);
    const disabledGet = await request(disabledApp)
      .get(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/${left.body.batch.id}`)
      .expect(200);
    const disabledPrepare = await request(disabledApp)
      .post(endpoint)
      .send({ ...prepareBody, clientRequestId: "disabled-api" })
      .expect(403);
    const disabledReconcile = await request(disabledApp)
      .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/${left.body.batch.id}/reconcile`)
      .send({})
      .expect(403);
    expect(disabledPrepare.body.details).toMatchObject({ code: "work_record_workflow_v2_disabled" });
    expect(disabledReconcile.body.details).toMatchObject({ code: "work_record_workflow_v2_disabled" });

    const evidenceDir = process.env.PAPERCLIP_M2B_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "api-contract.json"), `${JSON.stringify({
        schemaVersion: 1,
        preview: { status: previewResponse.status, body: previewResponse.body },
        concurrentPrepare: [
          { status: left.status, body: left.body },
          { status: right.status, body: right.body },
        ],
        conflict: { status: conflictResponse.status, body: conflictResponse.body },
        viewer: { status: viewerResponse.status, body: viewerResponse.body },
        defaultOff: {
          preview: { status: disabledPreview.status, body: disabledPreview.body },
          get: { status: disabledGet.status, body: disabledGet.body },
          prepare: { status: disabledPrepare.status, body: disabledPrepare.body },
          reconcile: { status: disabledReconcile.status, body: disabledReconcile.body },
        },
      }, null, 2)}\n`, "utf8");
    }
  });

  it("A03-A05 exports real API plus heartbeat final-admission denials", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    const effectiveWakeStatuses = new Set(["queued", "claimed", "running", "completed"]);
    const effectiveRunStatuses = new Set(["queued", "starting", "running", "succeeded"]);

    const accessContext = await seed();
    const accessTarget = await record(accessContext, "Admission API boundary target");
    const accessInput = scopeInput(accessContext, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [accessTarget.id],
    });
    const foreignContext = await seed();
    const boundaryApp = createApi(db, accessContext.company.id, true);
    const accessPreview = await request(boundaryApp)
      .post(`/api/companies/${accessContext.company.id}/projects/${accessContext.project.id}/work-package-dispatch/preview`)
      .send(accessInput)
      .expect(200);
    const crossCompany = await request(boundaryApp)
      .post(`/api/companies/${foreignContext.company.id}/projects/${foreignContext.project.id}/work-package-dispatch/preview`)
      .send({ ...accessInput, projectId: foreignContext.project.id });
    const projectBoundary = await request(boundaryApp)
      .post(`/api/companies/${accessContext.company.id}/projects/${accessContext.project.id}/work-package-dispatch/preview`)
      .send({ ...accessInput, projectId: foreignContext.project.id });
    const viewer = await request(createApi(db, accessContext.company.id, true, "viewer"))
      .post(`/api/companies/${accessContext.company.id}/projects/${accessContext.project.id}/work-package-dispatch/prepare`)
      .send({
        ...accessInput,
        clientRequestId: "viewer-denied",
        requestPayloadDigest: "viewer-denied",
        expectedScopeDigest: accessPreview.body.scopeDigest,
        expectedRootRevision: accessPreview.body.rootRevision,
        expectedDependencySetRevision: accessPreview.body.dependencySetRevision,
      });
    expect(crossCompany.status).toBe(403);
    expect(projectBoundary.status).toBe(422);
    expect(projectBoundary.body.details).toMatchObject({ code: "work_record_workflow_project_boundary" });
    expect(viewer.status).toBe(403);
    evidence.push(
      { case: "company_boundary", http: { status: crossCompany.status, body: crossCompany.body }, admissionReason: "company_access_denied", effectiveWakeCount: 0, effectiveRunCount: 0 },
      { case: "project_boundary", http: { status: projectBoundary.status, body: projectBoundary.body }, admissionReason: "work_record_workflow_project_boundary", effectiveWakeCount: 0, effectiveRunCount: 0 },
      { case: "viewer", http: { status: viewer.status, body: viewer.body }, admissionReason: "role_denied", effectiveWakeCount: 0, effectiveRunCount: 0 },
    );

    type GateContext = Awaited<ReturnType<typeof seed>> & {
      target: Awaited<ReturnType<typeof record>>;
      issueId: string;
      intentId: string;
      batchId: string;
      prepareHttp: { status: number; body: unknown };
    };
    async function prepareGateCase(label: string): Promise<GateContext> {
      const context = await seed();
      await isolatePendingV2Outbox(context.company.id);
      const target = await record(context, `Final admission ${label}`);
      const input = scopeInput(context, {
        scopeKind: "selected_records",
        rootRecordId: null,
        selectedRecordIds: [target.id],
      });
      const app = createApi(db, context.company.id, true);
      const preview = await request(app)
        .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/preview`)
        .send(input)
        .expect(200);
      const prepared = await request(app)
        .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/prepare`)
        .send({
          ...input,
          clientRequestId: `admission-${label}`,
          requestPayloadDigest: `admission-${label}`,
          expectedScopeDigest: preview.body.scopeDigest,
          expectedRootRevision: preview.body.rootRevision,
          expectedDependencySetRevision: preview.body.dependencySetRevision,
        })
        .expect(201);
      const intent = await db.select().from(workRecordExecutionIntents).where(and(
        eq(workRecordExecutionIntents.companyId, context.company.id),
        eq(workRecordExecutionIntents.recordId, target.id),
      )).then((rows) => rows[0]);
      await db.update(issues).set({ responsibleUserId: "m2b-admission-owner" }).where(eq(issues.id, intent.issueId!));
      return {
        ...context,
        target,
        issueId: intent.issueId!,
        intentId: intent.id,
        batchId: prepared.body.batch.id,
        prepareHttp: { status: prepared.status, body: prepared.body },
      };
    }

    async function exerciseGate(
      name: string,
      mutate: (context: GateContext) => Promise<(() => Promise<void>) | void>,
      expectedReason: string,
    ) {
      const context = await prepareGateCase(name);
      const cleanup = await mutate(context);
      const wakeIdsBefore = new Set((await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(
        eq(agentWakeupRequests.companyId, context.company.id),
      )).map((row) => row.id));
      const runIdsBefore = new Set((await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(
        eq(heartbeatRuns.companyId, context.company.id),
      )).map((row) => row.id));
      const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
      const workflow = workPackageDispatchService(db, { writesEnabled: true });
      for (let tick = 0; tick < 6; tick += 1) {
        await workflow.processOutbox(heartbeat.wakeup, 1);
        await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) })
          .where(and(
            eq(workRecordOutbox.executionIntentId, context.intentId),
            inArray(workRecordOutbox.state, ["retry", "processing"]),
          ));
      }
      if (!cleanup) await heartbeat.drainActiveRunExecutions();
      const wakes = (await db.select().from(agentWakeupRequests).where(
        eq(agentWakeupRequests.companyId, context.company.id),
      )).filter((row) => !wakeIdsBefore.has(row.id));
      const runs = (await db.select().from(heartbeatRuns).where(
        eq(heartbeatRuns.companyId, context.company.id),
      )).filter((row) => !runIdsBefore.has(row.id));
      const intent = await db.select().from(workRecordExecutionIntents).where(eq(workRecordExecutionIntents.id, context.intentId)).then((rows) => rows[0]);
      const outbox = await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.executionIntentId, context.intentId)).then((rows) => rows[0]);
      expect(outbox.state).not.toBe("dead_letter");
      expect(outbox.attemptCount).toBe(0);
      const app = createApi(db, context.company.id, true);
      const batch = await request(app)
        .get(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/${context.batchId}`)
        .expect(200);
      const effectiveWakeCount = wakes.filter((wake) => effectiveWakeStatuses.has(wake.status)).length;
      const effectiveRunCount = runs.filter((run) => effectiveRunStatuses.has(run.status)).length;
      const actualReasons = [
        ...wakes.map((wake) => wake.status === "skipped" || wake.status === "deferred_issue_execution" ? wake.reason : wake.error),
        ...runs.map((run) => run.errorCode ?? run.error),
        intent.waitingReason,
        outbox.lastError,
      ].filter((value): value is string => Boolean(value));
      expect(effectiveWakeCount).toBe(0);
      expect(effectiveRunCount).toBe(0);
      if (!actualReasons.join(" | ").includes(expectedReason)) {
        throw new Error(`Admission reason ${expectedReason} missing: ${JSON.stringify({
          wakes: wakes.map((row) => ({ status: row.status, reason: row.reason, error: row.error })),
          runs: runs.map((row) => ({ status: row.status, errorCode: row.errorCode, error: row.error })),
          intent: { state: intent.state, waitingReason: intent.waitingReason },
          outbox: { state: outbox.state, lastError: outbox.lastError },
        })}`);
      }
      evidence.push({
        case: name,
        http: { prepare: context.prepareHttp, get: { status: batch.status, body: batch.body } },
        admissionReason: expectedReason,
        observedReasons: actualReasons,
        wake: { ids: wakes.map((row) => row.id), statuses: wakes.map((row) => row.status), effectiveCount: effectiveWakeCount },
        run: { ids: runs.map((row) => row.id), statuses: runs.map((row) => row.status), effectiveCount: effectiveRunCount },
        intent: { id: intent.id, state: intent.state, waitingReason: intent.waitingReason },
        outbox: { id: outbox.id, state: outbox.state, lastError: outbox.lastError },
      });
      if (cleanup) await cleanup();
    }

    await exerciseGate("approval_pending", async (context) => {
      await db.update(issues).set({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: "approval-stage",
          currentStageIndex: 0,
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: "m2b-approver" },
          returnAssignee: { type: "agent", agentId: context.agent.id },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      }).where(eq(issues.id, context.issueId));
    }, "approval_pending");
    await exerciseGate("approval_stale", async (context) => {
      await db.update(issues).set({ statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, context.issueId));
    }, "stale_issue_revision");
    await exerciseGate("approval_reject", async (context) => {
      await db.update(issues).set({ status: "in_progress", statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, context.issueId));
    }, "stale_issue_revision");
    await exerciseGate("budget_hard_stop", async (context) => {
      await db.insert(budgetPolicies).values({
        companyId: context.company.id,
        scopeType: "project",
        scopeId: context.project.id,
        metric: "billed_cents",
        windowKind: "lifetime",
        amount: 100,
        hardStopEnabled: true,
        isActive: true,
      });
      await db.insert(costEvents).values({
        companyId: context.company.id,
        agentId: context.agent.id,
        issueId: context.issueId,
        projectId: context.project.id,
        provider: "test",
        biller: "test",
        billingType: "metered_api",
        model: "m2b-final-admission",
        costCents: 125,
        occurredAt: new Date(),
      });
    }, "budget.blocked");
    await exerciseGate("company_paused", async (context) => {
      await db.update(companies).set({ status: "paused", pauseReason: "m2b-test", pausedAt: new Date() })
        .where(eq(companies.id, context.company.id));
    }, "company_paused");
    await exerciseGate("agent_paused", async (context) => {
      await db.update(agents).set({ status: "paused", pauseReason: "m2b-test", pausedAt: new Date() })
        .where(eq(agents.id, context.agent.id));
    }, "agent_paused");
    await exerciseGate("source_hold", async (context) => {
      const blocker = await record(context, "Late source hold blocker");
      await db.insert(workRecordExecutionHolds).values({
        companyId: context.company.id,
        projectId: context.project.id,
        dependentRecordId: context.target.id,
        dependentIssueId: context.issueId,
        blockingRecordId: blocker.id,
        reason: "prerequisite_not_dispatched",
        dispatchRound: context.target.dispatchRound,
        dependencySetRevision: context.target.dependencySetRevision,
        blockedCycle: context.target.blockedCycle,
      });
    }, "issue_dependencies_blocked");
    await exerciseGate("issue_execution_lock", async (context) => {
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 30000)"] },
      }).where(eq(agents.id, context.agent.id));
      const holderHeartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
      const holderRun = await holderHeartbeat.wakeup(context.agent.id, {
        source: "assignment",
        triggerDetail: "system",
        reason: "m2b_issue_lock_holder",
        payload: { issueId: context.issueId },
        idempotencyKey: `m2b-lock-holder:${context.issueId}`,
        allowRunCoalescing: false,
        requestedByActorType: "system",
        requestedByActorId: "m2b-test",
        contextSnapshot: { issueId: context.issueId, source: "m2b_lock_test" },
      });
      expect(holderRun).toBeTruthy();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const holder = await db.select({ status: heartbeatRuns.status, processPid: heartbeatRuns.processPid }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, holderRun!.id)).then((rows) => rows[0]);
        if (holder?.status === "running" && holder.processPid) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const lockedIssue = await db.select({ statusVersion: issues.statusVersion }).from(issues)
        .where(eq(issues.id, context.issueId)).then((rows) => rows[0]);
      await db.update(workRecordExecutionIntents).set({ expectedIssueStatusVersion: lockedIssue.statusVersion })
        .where(eq(workRecordExecutionIntents.id, context.intentId));
      return async () => {
        await holderHeartbeat.cancelRun(holderRun!.id, "M2-B issue-lock evidence captured");
        await holderHeartbeat.drainActiveRunExecutions();
      };
    }, "issue.execution_active");

    const resumed = await prepareGateCase("company_pause_resume");
    const resumedEvent = await db.select().from(workRecordOutbox)
      .where(eq(workRecordOutbox.executionIntentId, resumed.intentId))
      .then((rows) => rows[0]);
    await db.update(companies).set({ status: "paused", pauseReason: "m2b-resume-proof", pausedAt: new Date() })
      .where(eq(companies.id, resumed.company.id));
    const resumeHeartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
    const resumeWorkflow = workPackageDispatchService(db, { writesEnabled: true });
    for (let tick = 0; tick < 6; tick += 1) {
      await resumeWorkflow.processOutbox(resumeHeartbeat.wakeup, 1);
      await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) })
        .where(eq(workRecordOutbox.id, resumedEvent.id));
    }
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.id, resumedEvent.id)).then((rows) => rows[0]))
      .toMatchObject({ id: resumedEvent.id, state: "retry", attemptCount: 0, deadLetteredAt: null });
    await db.update(companies).set({ status: "active", pauseReason: null, pausedAt: null })
      .where(eq(companies.id, resumed.company.id));
    await resumeWorkflow.processOutbox(resumeHeartbeat.wakeup, 1);
    await resumeHeartbeat.drainActiveRunExecutions();
    const resumedOutbox = await db.select().from(workRecordOutbox)
      .where(eq(workRecordOutbox.id, resumedEvent.id)).then((rows) => rows[0]);
    const resumedWakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, resumed.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-intent:${resumed.intentId}:1`),
    ));
    const resumedRuns = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, resumed.company.id),
      inArray(heartbeatRuns.wakeupRequestId, resumedWakes.map((wake) => wake.id)),
    ));
    expect(resumedOutbox).toMatchObject({ id: resumedEvent.id, state: "delivered", attemptCount: 1 });
    expect(resumedWakes.filter((wake) => effectiveWakeStatuses.has(wake.status))).toHaveLength(1);
    expect(resumedRuns.filter((run) => effectiveRunStatuses.has(run.status)).length).toBeLessThanOrEqual(1);
    evidence.push({
      case: "company_pause_resume",
      eventId: resumedEvent.id,
      governanceTicks: 6,
      blockedAttemptCount: 0,
      finalState: resumedOutbox.state,
      effectiveWakeCount: resumedWakes.filter((wake) => effectiveWakeStatuses.has(wake.status)).length,
      effectiveRunCount: resumedRuns.filter((run) => effectiveRunStatuses.has(run.status)).length,
    });

    const evidenceDir = process.env.PAPERCLIP_M2B_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "final-admission-matrix.json"), `${JSON.stringify({
        schemaVersion: 1,
        baselineCommit: "6fdd60d393c828f3a1500f78c10503e0badd1451",
        testedCommit: process.env.PAPERCLIP_M2B_TESTED_COMMIT ?? null,
        cases: evidence,
      }, null, 2)}\n`, "utf8");
    }
  }, 120_000);

  it("preserves one intent and event through approval wait/release in the real scheduler order", async () => {
    const context = await seed();
    await isolatePendingV2Outbox(context.company.id);
    const target = await record(context, "Scheduler approval wait");
    const prepared = await prepare(workPackageDispatchService(db, { writesEnabled: true }), context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [target.id],
    }), "scheduler-approval-wait");
    const intent = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, target.id),
    )).then((rows) => rows[0]);
    const event = await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.executionIntentId, intent.id))
      .then((rows) => rows[0]);
    const issueBeforeWait = await db.select().from(issues).where(eq(issues.id, intent.issueId!))
      .then((rows) => rows[0]);
    await db.update(issues).set({
      status: "in_review",
      executionState: {
        status: "pending",
        currentStageId: "scheduler-approval-stage",
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "scheduler-approver" },
        returnAssignee: { type: "agent", agentId: context.agent.id },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      responsibleUserId: "scheduler-approval-owner",
    }).where(eq(issues.id, intent.issueId!));
    const issueWaiting = await db.select().from(issues).where(eq(issues.id, intent.issueId!))
      .then((rows) => rows[0]);
    expect(issueWaiting.statusVersion).toBe(issueBeforeWait.statusVersion + 1);

    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const workflow = workPackageDispatchService(db, { writesEnabled: true });
    const emptyPage = async () => ({ processed: 0, succeeded: 0, failures: [], nextAfterId: null });
    const schedulerTick = createWorkRecordWorkflowTick({
      records: emptyPage,
      qualityCycles: emptyPage,
      packages: (afterId) => workflow.reconcilePage(1_000, afterId),
      legacyOutbox: async () => 0,
      workflowV2Outbox: () => workflow.processOutbox(heartbeat.wakeup, 25),
    });

    for (let tick = 0; tick < 6; tick += 1) {
      await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) })
        .where(eq(workRecordOutbox.id, event.id));
      await schedulerTick();
      const waitingIntent = await db.select().from(workRecordExecutionIntents)
        .where(eq(workRecordExecutionIntents.id, intent.id)).then((rows) => rows[0]);
      const waitingEvent = await db.select().from(workRecordOutbox)
        .where(eq(workRecordOutbox.id, event.id)).then((rows) => rows[0]);
      expect(waitingIntent).toMatchObject({
        id: intent.id,
        state: "waiting_governance",
        waitingReason: "approval_pending",
        expectedIssueStatusVersion: issueWaiting.statusVersion,
      });
      expect(waitingEvent).toMatchObject({ id: event.id, state: "retry", attemptCount: 0, deadLetteredAt: null });
    }

    await db.update(issues).set({ status: "todo", executionState: null }).where(eq(issues.id, intent.issueId!));
    const issueReleased = await db.select().from(issues).where(eq(issues.id, intent.issueId!))
      .then((rows) => rows[0]);
    expect(issueReleased.statusVersion).toBe(issueWaiting.statusVersion + 1);
    await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) })
      .where(eq(workRecordOutbox.id, event.id));
    await schedulerTick();
    await heartbeat.drainActiveRunExecutions();

    const finalIntents = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, target.id),
    ));
    const finalEvents = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.executionIntentId, intent.id),
    ));
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-intent:${intent.id}:1`),
    ));
    const runs = wakes.length === 0 ? [] : await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      inArray(heartbeatRuns.wakeupRequestId, wakes.map((wake) => wake.id)),
    ));
    const effectiveWakeStates = new Set(["queued", "claimed", "completed"]);
    const effectiveRunStates = new Set(["queued", "running", "succeeded"]);
    expect(finalIntents).toHaveLength(1);
    expect(finalIntents[0]).toMatchObject({ id: intent.id, expectedIssueStatusVersion: issueReleased.statusVersion });
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0]).toMatchObject({ id: event.id, state: "delivered", attemptCount: 1 });
    expect(wakes.filter((wake) => effectiveWakeStates.has(wake.status))).toHaveLength(1);
    expect(runs.filter((run) => effectiveRunStates.has(run.status)).length).toBeLessThanOrEqual(1);
    expect(prepared.batch.id).toBe(event.batchId);
  }, 120_000);

  it("D01 releases a whole package in predecessor, successor, then PO order through real heartbeats", async () => {
    const context = await seed();
    await isolatePendingV2Outbox(context.company.id);
    const root = await record(context, "Ordered package");
    const predecessor = await record(context, "Ordered predecessor", { parentRecordId: root.id });
    const successor = await record(context, "Ordered successor", {
      parentRecordId: root.id,
      predecessorRecordIds: [predecessor.id],
    });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const prepared = await prepare(service, context, scopeInput(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    }), "whole-package-release-order");
    const links = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      inArray(workRecordIssueLinks.recordId, [root.id, predecessor.id, successor.id]),
    ));
    const linkByRecord = new Map(links.map((link) => [link.recordId, link]));
    await db.update(issues).set({ responsibleUserId: "m2b-order-owner" }).where(and(
      eq(issues.companyId, context.company.id),
      inArray(issues.id, links.map((link) => link.issueId)),
    ));
    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const release = async () => {
      await service.processOutbox(heartbeat.wakeup, 25);
      await heartbeat.drainActiveRunExecutions();
    };

    await release();
    let runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id)).orderBy(heartbeatRuns.createdAt);
    expect(runs.map((run) => run.contextSnapshot?.issueId)).toEqual([linkByRecord.get(predecessor.id)!.issueId]);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, linkByRecord.get(predecessor.id)!.issueId));
    await context.records.reconcileRecord(context.company.id, context.project.id, successor.id);
    await service.reconcile(context.company.id, context.project.id, prepared.batch.id, { actorType: "system", actorId: "test" });
    await release();
    runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id)).orderBy(heartbeatRuns.createdAt);
    expect(runs.map((run) => run.contextSnapshot?.issueId)).toEqual([
      linkByRecord.get(predecessor.id)!.issueId,
      linkByRecord.get(successor.id)!.issueId,
    ]);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, linkByRecord.get(successor.id)!.issueId));
    await service.reconcile(context.company.id, context.project.id, prepared.batch.id, { actorType: "system", actorId: "test" });
    await release();
    runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id)).orderBy(heartbeatRuns.createdAt);
    expect(runs.map((run) => run.contextSnapshot?.issueId)).toEqual([
      linkByRecord.get(predecessor.id)!.issueId,
      linkByRecord.get(successor.id)!.issueId,
      linkByRecord.get(root.id)!.issueId,
    ]);
  }, 30_000);

  it("releases the successor only after a local predecessor process stops and completes", async () => {
    const context = await seed();
    await db.insert(authUsers).values({ id: "local-package-owner",
      name: "Local package owner", email: `local-${randomUUID()}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await isolatePendingV2Outbox(context.company.id);
    await db.update(agents).set({ adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { executionMode: "client_pull",
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } } })
      .where(eq(agents.id, context.agent.id));
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: keyId,
      companyId: context.company.id, agentId: context.agent.id,
      name: "Local package test", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId: context.company.id,
      agentId: context.agent.id, keyId, deviceId: "package-desktop" });
    const root = await record(context, "Local PO package");
    const predecessor = await record(context, "Local predecessor", { parentRecordId: root.id });
    const successor = await record(context, "Local successor", {
      parentRecordId: root.id, predecessorRecordIds: [predecessor.id],
    });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const prepared = await prepare(service, context, scopeInput(context, {
      scopeKind: "whole_package", rootRecordId: root.id, selectedRecordIds: [],
    }), "local-predecessor-release");
    const links = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      inArray(workRecordIssueLinks.recordId, [predecessor.id, successor.id]),
    ));
    await db.update(issues).set({ responsibleUserId: "local-package-owner" })
      .where(and(eq(issues.companyId, context.company.id),
        inArray(issues.id, links.map((link) => link.issueId))));
    const issueByRecord = new Map(links.map((link) => [link.recordId, link.issueId]));
    const predecessorIssueId = issueByRecord.get(predecessor.id)!;
    const successorIssueId = issueByRecord.get(successor.id)!;
    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await service.processOutbox(heartbeat.wakeup, 25);
    await heartbeat.drainActiveRunExecutions();
    const [queued] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${predecessorIssueId}`,
    ));
    expect(queued?.status).toBe("queued");
    const leaseService = localAgentRunLeaseService(db);
    const claimed = await leaseService.claim({ companyId: context.company.id,
      agentId: context.agent.id, keyId, deviceId: "package-desktop",
      idempotencyKey: randomUUID() });
    expect(claimed?.runId).toBe(queued.id);
    expect(claimed?.issueId).toBe(predecessorIssueId);
    const [source] = await db.select().from(issues).where(eq(issues.id, predecessorIssueId));
    expect(source.status).toBe("in_progress");
    const owner = { companyId: context.company.id, agentId: context.agent.id,
      keyId, deviceId: "package-desktop", runId: queued.id,
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    await leaseService.completeFencedChildWorkRecord({ ...owner,
      issueId: predecessorIssueId, expectedStatusVersion: source.statusVersion,
      summary: "Predecessor delivery ready for dependent task",
      clientRequestId: randomUUID() }, {
        type: "agent", source: "agent_key", agentId: context.agent.id,
        companyId: context.company.id, keyId,
      });
    await service.reconcile(context.company.id, context.project.id, prepared.batch.id,
      { actorType: "system", actorId: "test" });
    await service.processOutbox(heartbeat.wakeup, 25);
    expect((await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${successorIssueId}`,
    )))).toHaveLength(0);
    await leaseService.finish({ ...owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    expect((await db.select().from(localIssueCompletionCommands).where(and(
      eq(localIssueCompletionCommands.companyId, context.company.id),
      eq(localIssueCompletionCommands.issueId, predecessorIssueId),
    )))[0]?.state).toBe("completed");
    await context.records.reconcileRecord(context.company.id, context.project.id,
      successor.id);
    await service.reconcile(context.company.id, context.project.id, prepared.batch.id,
      { actorType: "system", actorId: "test" });
    await service.processOutbox(heartbeat.wakeup, 25);
    await heartbeat.drainActiveRunExecutions();
    const successorRuns = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${successorIssueId}`,
    ));
    expect(successorRuns).toHaveLength(1);
    expect(successorRuns[0]?.status).toBe("queued");
    const successorClaim = await leaseService.claim({ companyId: context.company.id,
      agentId: context.agent.id, keyId, deviceId: "package-desktop",
      idempotencyKey: randomUUID() });
    expect(successorClaim?.runId).toBe(successorRuns[0]?.id);
  }, 60_000);

  it("D02 previews every missing owner, preserves named owners, and rejects prepare without side effects", async () => {
    const context = await seed();
    const root = await record(context, "Root without PO", { assigned: false });
    const missingChild = await record(context, "Unassigned child", { parentRecordId: root.id, assigned: false });
    const assignedChild = await record(context, "Named owner stays", { parentRecordId: root.id });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const input = scopeInput(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    });
    const preview = await service.preview(context.company.id, context.project.id, input);
    expect(preview.eligibility.canPrepare).toBe(false);
    expect(preview.eligibility.blockers).toEqual(expect.arrayContaining([
        { code: "missing_po", recordId: root.id, title: "Root without PO", requiredRole: "PO" },
        { code: "missing_assignee", recordId: missingChild.id, title: "Unassigned child", requiredRole: "执行人" },
    ]));
    expect(preview.eligibility.blockers).toHaveLength(2);
    expect(preview.records.find((item) => item.id === assignedChild.id)?.assigneeAgentId).toBe(context.agent.id);
    await expect(service.prepare(context.company.id, context.project.id, {
      ...input,
      clientRequestId: "missing-owner-prepare",
      requestPayloadDigest: "missing-owner-prepare",
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "test" })).rejects.toMatchObject({
      status: 422,
      details: { code: "work_package_assignment_required" },
    });
    expect(await db.select().from(workRecordDispatchBatches).where(eq(workRecordDispatchBatches.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(workRecordDispatchBatchItems).where(eq(workRecordDispatchBatchItems.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(workRecordExecutionIntents).where(eq(workRecordExecutionIntents.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, context.company.id))).toHaveLength(0);
  });

  it("D02 persists one CEO coordination record, delivers once, and restores it without changing owners", async () => {
    const context = await seed();
    const ceo = await db.insert(agents).values({
      companyId: context.company.id,
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
    }).returning().then((rows) => rows[0]);
    const root = await record(context, "Root without PO", { assigned: false });
    const missingChild = await record(context, "Unassigned child", { parentRecordId: root.id, assigned: false });
    const assignedChild = await record(context, "Named owner stays", { parentRecordId: root.id });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const input = scopeInput(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    });
    const preview = await service.preview(context.company.id, context.project.id, input);
    let deliveries = 0;
    const deliver = async ({ escalationId, targetCeoAgentId, deliveryAttempt }: { escalationId: string; targetCeoAgentId: string; deliveryAttempt: number }) => {
      deliveries += 1;
      const wakeup = await db.insert(agentWakeupRequests).values({
        companyId: context.company.id,
        agentId: targetCeoAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "work_record_assignment_gap_escalated",
        status: "queued",
        idempotencyKey: `work-record-assignment-gap:${escalationId}:${deliveryAttempt}`,
        payload: { escalationId },
      }).returning().then((rows) => rows[0]);
      return { wakeupRequestId: wakeup.id, wakeStatus: wakeup.status, runId: wakeup.runId, claimedAt: wakeup.claimedAt, finishedAt: wakeup.finishedAt };
    };
    const command = {
      ...input,
      clientRequestId: "gap-escalation-1",
      requestPayloadDigest: "gap-escalation-payload",
      expectedScopeDigest: preview.scopeDigest,
    };

    const first = await service.escalateAssignmentGaps(
      context.company.id,
      context.project.id,
      command,
      { actorType: "system", actorId: "test" },
      deliver,
    );
    const replay = await service.escalateAssignmentGaps(
      context.company.id,
      context.project.id,
      command,
      { actorType: "system", actorId: "test" },
      deliver,
    );
    const queuedAfterRefresh = await service.latestAssignmentEscalation(context.company.id, context.project.id, root.id);

    expect(first).toMatchObject({ state: "queued", deliveryAttempt: 1, targetCeoAgentId: ceo.id, replayed: false });
    expect(replay).toMatchObject({ id: first.id, state: "queued", replayed: true });
    expect(queuedAfterRefresh).toMatchObject({ id: first.id, state: "queued", wakeStatus: "queued", wakeupRequestId: first.wakeupRequestId });
    expect(deliveries).toBe(1);
    expect(await db.select().from(workRecordAssignmentGapEscalations).where(
      eq(workRecordAssignmentGapEscalations.companyId, context.company.id),
    )).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-assignment-gap:${first.id}:1`),
    ))).toHaveLength(1);
    expect(await db.select().from(workRecords).where(and(
      eq(workRecords.companyId, context.company.id),
      eq(workRecords.id, assignedChild.id),
    )).then((rows) => rows[0]?.assigneeAgentId)).toBe(context.agent.id);
    expect(first.missingRecordIds).toEqual(expect.arrayContaining([root.id, missingChild.id]));

    const claimedAt = new Date("2026-10-28T06:40:00Z");
    const run = await db.insert(heartbeatRuns).values({
      companyId: context.company.id,
      agentId: ceo.id,
      status: "running",
      startedAt: claimedAt,
      wakeupRequestId: first.wakeupRequestId,
    }).returning().then((rows) => rows[0]);
    await db.update(agentWakeupRequests).set({
      status: "claimed",
      runId: run.id,
      claimedAt,
      updatedAt: claimedAt,
    }).where(eq(agentWakeupRequests.id, first.wakeupRequestId!));
    const delivered = await service.latestAssignmentEscalation(context.company.id, context.project.id, root.id);
    expect(delivered).toMatchObject({ id: first.id, state: "delivered", wakeStatus: "claimed", runId: run.id, runStatus: "running" });

    const finishedAt = new Date("2026-10-28T06:41:00Z");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt, updatedAt: finishedAt }).where(eq(heartbeatRuns.id, run.id));
    await db.update(agentWakeupRequests).set({ status: "completed", finishedAt, updatedAt: finishedAt }).where(eq(agentWakeupRequests.id, first.wakeupRequestId!));
    const acknowledged = await service.latestAssignmentEscalation(context.company.id, context.project.id, root.id);
    expect(acknowledged).toMatchObject({ id: first.id, state: "acknowledged", wakeStatus: "completed", runStatus: "succeeded" });
    expect(acknowledged?.acknowledgedAt).toEqual(finishedAt);
  });

  it("D02 records CEO unavailability and delivery failure as distinct states", async () => {
    const context = await seed();
    const root = await record(context, "Root without PO", { assigned: false });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const input = scopeInput(context, { scopeKind: "whole_package", rootRecordId: root.id, selectedRecordIds: [] });
    const preview = await service.preview(context.company.id, context.project.id, input);
    const deliver = async () => { throw new Error("delivery must not run"); };

    const receipt = await service.escalateAssignmentGaps(context.company.id, context.project.id, {
      ...input,
      clientRequestId: "gap-without-ceo",
      requestPayloadDigest: "gap-without-ceo",
      expectedScopeDigest: preview.scopeDigest,
    }, { actorType: "system", actorId: "test" }, deliver);

    expect(receipt).toMatchObject({ state: "ceo_unavailable", targetCeoAgentId: null, wakeupRequestId: null });

    const ceo = await db.insert(agents).values({
      companyId: context.company.id,
      name: "Unavailable delivery CEO",
      role: "ceo",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    }).returning().then((rows) => rows[0]);
    const unavailableRecovered = await service.escalateAssignmentGaps(context.company.id, context.project.id, {
      ...input,
      clientRequestId: "gap-without-ceo",
      requestPayloadDigest: "gap-without-ceo",
      expectedScopeDigest: preview.scopeDigest,
    }, { actorType: "system", actorId: "test" }, async ({ escalationId, deliveryAttempt }) => {
      const wake = await db.insert(agentWakeupRequests).values({
        companyId: context.company.id,
        agentId: ceo.id,
        source: "automation",
        status: "queued",
        idempotencyKey: `work-record-assignment-gap:${escalationId}:${deliveryAttempt}`,
      }).returning().then((rows) => rows[0]);
      return { wakeupRequestId: wake.id, wakeStatus: wake.status, runId: null, claimedAt: null, finishedAt: null };
    });
    expect(unavailableRecovered).toMatchObject({ id: receipt.id, state: "queued", deliveryAttempt: 1, targetCeoAgentId: ceo.id });
    await db.update(agentWakeupRequests).set({
      status: "failed",
      error: "adapter unavailable",
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(agentWakeupRequests.id, unavailableRecovered.wakeupRequestId!));
    const authoritativeFailure = await service.latestAssignmentEscalation(context.company.id, context.project.id, root.id);
    expect(authoritativeFailure).toMatchObject({ id: receipt.id, state: "delivery_failed", wakeStatus: "failed", deliveryErrorCode: "ceo_wakeup_failed" });
    const failedWakeRetried = await service.escalateAssignmentGaps(context.company.id, context.project.id, {
      ...input,
      clientRequestId: "gap-without-ceo",
      requestPayloadDigest: "gap-without-ceo",
      expectedScopeDigest: preview.scopeDigest,
    }, { actorType: "system", actorId: "test" }, async ({ escalationId, deliveryAttempt }) => {
      const wake = await db.insert(agentWakeupRequests).values({
        companyId: context.company.id,
        agentId: ceo.id,
        source: "automation",
        status: "queued",
        idempotencyKey: `work-record-assignment-gap:${escalationId}:${deliveryAttempt}`,
      }).returning().then((rows) => rows[0]);
      return { wakeupRequestId: wake.id, wakeStatus: wake.status, runId: null, claimedAt: null, finishedAt: null };
    });
    expect(failedWakeRetried).toMatchObject({ id: receipt.id, state: "queued", deliveryAttempt: 2 });

    const secondRoot = await record(context, "Second root without PO", { assigned: false });
    const secondAssignedChild = await record(context, "Second named owner stays", { parentRecordId: secondRoot.id });
    const secondInput = scopeInput(context, { scopeKind: "whole_package", rootRecordId: secondRoot.id, selectedRecordIds: [] });
    const secondPreview = await service.preview(context.company.id, context.project.id, secondInput);
    const failedCommand = {
      ...secondInput,
      clientRequestId: "gap-delivery-failed",
      requestPayloadDigest: "gap-delivery-failed",
      expectedScopeDigest: secondPreview.scopeDigest,
    };
    const failed = await service.escalateAssignmentGaps(context.company.id, context.project.id, failedCommand,
      { actorType: "system", actorId: "test" }, async () => { throw new Error("wakeup failed"); });

    expect(failed).toMatchObject({ state: "delivery_failed", deliveryAttempt: 1, deliveryErrorCode: "ceo_wakeup_failed", wakeupRequestId: null });
    const retried = await service.escalateAssignmentGaps(context.company.id, context.project.id, failedCommand,
      { actorType: "system", actorId: "test" }, async ({ escalationId, deliveryAttempt }) => {
        const wake = await db.insert(agentWakeupRequests).values({
          companyId: context.company.id,
          agentId: ceo.id,
          source: "automation",
          status: "queued",
          idempotencyKey: `work-record-assignment-gap:${escalationId}:${deliveryAttempt}`,
        }).returning().then((rows) => rows[0]);
        return { wakeupRequestId: wake.id, wakeStatus: wake.status, runId: null, claimedAt: null, finishedAt: null };
      });
    expect(retried).toMatchObject({ id: failed.id, state: "queued", deliveryAttempt: 2 });
    expect(await db.select().from(workRecordAssignmentGapEscalations).where(and(
      eq(workRecordAssignmentGapEscalations.companyId, context.company.id),
      eq(workRecordAssignmentGapEscalations.scopeDigest, secondPreview.scopeDigest),
    ))).toHaveLength(1);
    expect(await db.select().from(workRecords).where(eq(workRecords.id, secondAssignedChild.id))
      .then((rows) => rows[0]?.assigneeAgentId)).toBe(context.agent.id);
  });

  it("D02 reconciles a stale interrupted delivery in place before retrying", async () => {
    const context = await seed();
    await db.update(agents).set({ role: "ceo" }).where(eq(agents.id, context.agent.id));
    const root = await record(context, "Interrupted escalation root", { assigned: false });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const input = scopeInput(context, { scopeKind: "whole_package", rootRecordId: root.id, selectedRecordIds: [] });
    const preview = await service.preview(context.company.id, context.project.id, input);
    const command = { ...input, clientRequestId: "gap-stale-delivering", requestPayloadDigest: "gap-stale-delivering", expectedScopeDigest: preview.scopeDigest };
    const failed = await service.escalateAssignmentGaps(context.company.id, context.project.id, command,
      { actorType: "system", actorId: "test" }, async () => { throw new Error("interrupted"); });
    await db.update(workRecordAssignmentGapEscalations).set({
      state: "delivering",
      deliveryErrorCode: null,
      updatedAt: new Date(Date.now() - 120_000),
    }).where(eq(workRecordAssignmentGapEscalations.id, failed.id));

    const reconciled = await service.latestAssignmentEscalation(context.company.id, context.project.id, root.id);
    expect(reconciled).toMatchObject({ id: failed.id, state: "delivery_failed", deliveryErrorCode: "ceo_wakeup_timeout" });
    const retried = await service.escalateAssignmentGaps(context.company.id, context.project.id, command,
      { actorType: "system", actorId: "test" }, async ({ escalationId, deliveryAttempt }) => {
        const wake = await db.insert(agentWakeupRequests).values({
          companyId: context.company.id,
          agentId: context.agent.id,
          source: "automation",
          status: "queued",
          idempotencyKey: `work-record-assignment-gap:${escalationId}:${deliveryAttempt}`,
        }).returning().then((rows) => rows[0]);
        return { wakeupRequestId: wake.id, wakeStatus: wake.status, runId: null, claimedAt: null, finishedAt: null };
      });
    expect(retried).toMatchObject({ id: failed.id, state: "queued", deliveryAttempt: 2 });
  });

  it("D02 recovers a committed CEO wake when its escalation receipt was never saved", async () => {
    const context = await seed();
    await db.update(agents).set({ role: "ceo" }).where(eq(agents.id, context.agent.id));
    const root = await record(context, "Wake persisted before process loss", { assigned: false });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const input = scopeInput(context, { scopeKind: "whole_package", rootRecordId: root.id, selectedRecordIds: [] });
    const preview = await service.preview(context.company.id, context.project.id, input);
    const command = { ...input, clientRequestId: "gap-wake-without-receipt", requestPayloadDigest: "gap-wake-without-receipt", expectedScopeDigest: preview.scopeDigest };
    let wakeupId = "";
    const first = await service.escalateAssignmentGaps(context.company.id, context.project.id, command,
      { actorType: "system", actorId: "test" }, async ({ escalationId, deliveryAttempt }) => {
        const wake = await db.insert(agentWakeupRequests).values({
          companyId: context.company.id,
          agentId: context.agent.id,
          source: "automation",
          status: "queued",
          idempotencyKey: `work-record-assignment-gap:${escalationId}:${deliveryAttempt}`,
        }).returning().then((rows) => rows[0]);
        wakeupId = wake.id;
        throw new Error("process stopped after wake commit, before receipt commit");
      });
    expect(first).toMatchObject({ state: "queued", deliveryAttempt: 1, wakeupRequestId: wakeupId });

    // Model a restart reading the original claimed row instead of the recovered receipt.
    await db.update(workRecordAssignmentGapEscalations).set({
      state: "delivering",
      wakeupRequestId: null,
      wakeStatus: null,
      deliveryErrorCode: null,
      updatedAt: new Date(Date.now() - 120_000),
    }).where(eq(workRecordAssignmentGapEscalations.id, first.id));

    const recovered = await service.latestAssignmentEscalation(context.company.id, context.project.id, root.id);
    expect(recovered).toMatchObject({ id: first.id, state: "queued", deliveryAttempt: 1, wakeupRequestId: wakeupId });
    const replay = await service.escalateAssignmentGaps(context.company.id, context.project.id, command,
      { actorType: "system", actorId: "test" }, async () => { throw new Error("must not send a second CEO wake"); });
    expect(replay).toMatchObject({ id: first.id, state: "queued", deliveryAttempt: 1, wakeupRequestId: wakeupId });
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-assignment-gap:${first.id}:1`),
    ))).toHaveLength(1);
  });

  it("D02 API delivers one durable CEO wake and replays the same coordination receipt", async () => {
    const context = await seed();
    await db.update(agents).set({ role: "ceo" }).where(eq(agents.id, context.agent.id));
    const root = await record(context, "API root without PO", { assigned: false });
    const assignedChild = await record(context, "API named owner stays", { parentRecordId: root.id });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const input = scopeInput(context, { scopeKind: "whole_package", rootRecordId: root.id, selectedRecordIds: [] });
    const preview = await service.preview(context.company.id, context.project.id, input);
    const body = {
      ...input,
      clientRequestId: "api-gap-escalation",
      requestPayloadDigest: "api-gap-escalation",
      expectedScopeDigest: preview.scopeDigest,
    };
    const apiHeartbeat = {
      wakeup: async (agentId: string, options: {
        source?: "timer" | "assignment" | "on_demand" | "automation";
        triggerDetail?: "manual" | "ping" | "callback" | "system";
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        idempotencyKey?: string | null;
      }) => db.insert(agentWakeupRequests).values({
        companyId: context.company.id,
        agentId,
        source: options.source ?? "on_demand",
        triggerDetail: options.triggerDetail ?? null,
        reason: options.reason ?? null,
        payload: options.payload ?? null,
        status: "queued",
        idempotencyKey: options.idempotencyKey ?? null,
      }).returning().then((rows) => rows[0]),
    } as Parameters<typeof workRecordRoutes>[1]["heartbeat"];
    const app = createApi(db, context.company.id, true, "admin", apiHeartbeat);

    const first = await request(app)
      .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/assignment-gap-escalations`)
      .send(body)
      .expect(201);
    const replay = await request(app)
      .post(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/assignment-gap-escalations`)
      .send(body)
      .expect(200);
    const refreshed = await request(app)
      .get(`/api/companies/${context.company.id}/projects/${context.project.id}/work-package-dispatch/assignment-gap-escalations/latest?rootRecordId=${root.id}`)
      .expect(200);

    expect(first.body).toMatchObject({ state: "queued", deliveryAttempt: 1, targetCeoAgentId: context.agent.id, replayed: false });
    expect(replay.body).toMatchObject({ id: first.body.id, state: "queued", replayed: true });
    expect(refreshed.body).toMatchObject({ id: first.body.id, state: "queued", wakeupRequestId: first.body.wakeupRequestId });
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-assignment-gap:${first.body.id}:1`),
    ))).toHaveLength(1);
    expect(await db.select().from(workRecords).where(eq(workRecords.id, assignedChild.id)).then((rows) => rows[0]?.assigneeAgentId)).toBe(context.agent.id);
  }, 20_000);

  it("D03/D05 partial dispatch materializes only explicit selections and mixes reused plus new links", async () => {
    const context = await seed();
    const parent = await record(context, "Parent");
    const selected = await record(context, "Selected", { parentRecordId: parent.id });
    const freshSelected = await record(context, "Fresh selected", { parentRecordId: parent.id });
    const sibling = await record(context, "Sibling", { parentRecordId: parent.id });
    const existing = await context.records.dispatch(context.company.id, context.project.id, selected.id, {
      clientRequestId: "legacy-link",
      expectedRevision: selected.revision,
    }, { actorType: "system", actorId: "test" });
    await db.delete(workRecordOutbox).where(eq(workRecordOutbox.companyId, context.company.id));
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const result = await prepare(service, context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [selected.id, freshSelected.id],
    }));
    expect(result.items).toHaveLength(2);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: selected.id, materializationState: "reused" }),
      expect.objectContaining({ recordId: freshSelected.id, materializationState: "materialized" }),
    ]));
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.companyId, context.company.id))).toHaveLength(2);
    expect(await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      eq(workRecordIssueLinks.issueId, existing.issueId),
    ))).toHaveLength(1);
    expect(await db.select().from(workRecordDispatchBatchItems).where(and(
      eq(workRecordDispatchBatchItems.companyId, context.company.id),
      eq(workRecordDispatchBatchItems.recordId, sibling.id),
    ))).toHaveLength(0);
    expect(await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      eq(workRecordIssueLinks.recordId, parent.id),
    ))).toHaveLength(0);
  });

  it("keeps a real process adapter single-execution when M1 and workflow v2 outboxes coexist", async () => {
    const context = await seed();
    await isolatePendingV2Outbox(context.company.id);
    const target = await record(context, "M1 plus v2");
    const legacy = await context.records.dispatch(context.company.id, context.project.id, target.id, {
      clientRequestId: "m1-v2-legacy",
      expectedRevision: target.revision,
    }, { actorType: "system", actorId: "test" });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    await prepare(service, context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [target.id],
    }), "m1-v2-workflow");
    expect(await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.recordId, target.id),
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflowVersion: 1 }),
      expect.objectContaining({ workflowVersion: 2 }),
    ]));
    await db.update(issues).set({ responsibleUserId: "m2b-compat-owner" }).where(eq(issues.id, legacy.issueId));
    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await context.records.processOutbox(heartbeat.wakeup, 25);
    await service.processOutbox(heartbeat.wakeup, 25);
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(1);
  }, 20_000);

  it("D04-D06 holds an undispatched prerequisite and turns cancellation into impact_review without a PO release", async () => {
    const context = await seed();
    const root = await record(context, "Package root");
    const prerequisite = await record(context, "Prerequisite");
    const child = await record(context, "Child", { parentRecordId: root.id, predecessorRecordIds: [prerequisite.id] });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const result = await prepare(service, context, scopeInput(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    }));
    const childLink = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id), eq(workRecordIssueLinks.recordId, child.id),
    )).then((rows) => rows[0]);
    expect(await db.select().from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.dependentIssueId, childLink.issueId),
      eq(workRecordExecutionHolds.reason, "prerequisite_not_dispatched"),
    ))).toHaveLength(1);
    expect(await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.recordId, child.id),
    ))).toHaveLength(0);

    const prerequisiteDispatch = await context.records.dispatch(context.company.id, context.project.id, prerequisite.id, {
      clientRequestId: "cancel-prerequisite",
      expectedRevision: prerequisite.revision,
    }, { actorType: "system", actorId: "test" });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, prerequisiteDispatch.issueId));
    await context.records.reconcileRecord(context.company.id, context.project.id, child.id);
    await service.reconcile(context.company.id, context.project.id, result.batch.id, { actorType: "system", actorId: "test" });
    expect(await db.select().from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.dependentIssueId, childLink.issueId),
      eq(workRecordExecutionHolds.reason, "prerequisite_cancelled_impact_pending"),
    ))).toHaveLength(1);

    const childIssue = await db.select().from(issues).where(eq(issues.id, childLink.issueId)).then((rows) => rows[0]);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, childIssue.id));
    await service.reconcile(context.company.id, context.project.id, result.batch.id, { actorType: "system", actorId: "test" });
    const rootLink = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id), eq(workRecordIssueLinks.recordId, root.id),
    )).then((rows) => rows[0]);
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, rootLink.issueId));
    await expect(issueService(db).getWakeableParentAfterChildCompletion(rootLink.issueId)).resolves.toBeNull();
    const cycle = await db.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, context.company.id),
      eq(workRecordQualityCycles.aggregateRecordId, root.id),
    )).then((rows) => rows[0]);
    expect(cycle.qualityPhase).toBe("impact_review");
    expect(await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.eventType, "po_acceptance_release"),
    ))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(0);
  });

  it("R04-R06 converges after batch, partial-materialization, response-loss, and stale-event failpoints", async () => {
    const context = await seed();
    await isolatePendingV2Outbox(context.company.id);
    const recoveryEvidence: Array<{ case: string; phase: "before" | "after"; snapshot: Awaited<ReturnType<typeof eightLayerSnapshot>> }> = [];
    const root = await record(context, "Recovery root");
    await record(context, "Recovery child", { parentRecordId: root.id });
    const input = scopeInput(context, { scopeKind: "whole_package", rootRecordId: root.id, selectedRecordIds: [] });
    const fail = (name: WorkPackageFailpoint) => {
      if (name === "before_batch_commit") throw new Error("before_batch_commit");
    };
    const failing = workPackageDispatchService(db, { writesEnabled: true, failpoint: fail });
    const preview = await failing.preview(context.company.id, context.project.id, input);
    await expect(failing.prepare(context.company.id, context.project.id, {
      ...input,
      clientRequestId: "rollback-before-batch",
      requestPayloadDigest: "rollback-before-batch",
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "test" })).rejects.toThrow("before_batch_commit");
    expect(await db.select().from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, context.company.id),
      eq(workRecordDispatchBatches.clientRequestId, "rollback-before-batch"),
    ))).toHaveLength(0);
    recoveryEvidence.push({ case: "before_batch_commit", phase: "before", snapshot: await eightLayerSnapshot(context.company.id, root.id) });

    let partialFailed = false;
    const partial = workPackageDispatchService(db, {
      writesEnabled: true,
      failpoint: (name) => {
        if (name === "after_partial_materialization" && !partialFailed) {
          partialFailed = true;
          throw new Error("after_partial_materialization");
        }
      },
    });
    await expect(prepare(partial, context, input, "partial-recovery")).rejects.toThrow("after_partial_materialization");
    const batch = await db.select().from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, context.company.id),
      eq(workRecordDispatchBatches.clientRequestId, "partial-recovery"),
    )).then((rows) => rows[0]);
    recoveryEvidence.push({ case: "partial_materialization", phase: "before", snapshot: await eightLayerSnapshot(context.company.id, root.id) });
    const recovered = await workPackageDispatchService(db, { writesEnabled: true }).reconcile(
      context.company.id,
      context.project.id,
      batch.id,
      { actorType: "system", actorId: "test" },
    );
    expect(recovered.batch.state).toBe("prepared");
    expect(recovered.items.every((item) => ["materialized", "reused"].includes(item.materializationState))).toBe(true);
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.companyId, context.company.id))).toHaveLength(2);
    recoveryEvidence.push({ case: "before_batch_commit", phase: "after", snapshot: await eightLayerSnapshot(context.company.id, root.id) });
    recoveryEvidence.push({ case: "partial_materialization", phase: "after", snapshot: await eightLayerSnapshot(context.company.id, root.id) });

    const childIntent = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.kind, "initial_release"),
    )).then((rows) => rows[0]);
    const event = await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.executionIntentId, childIntent.id)).then((rows) => rows[0]);
    await db.update(issues).set({ responsibleUserId: "m2b-recovery-owner" }).where(eq(issues.id, childIntent.issueId!));
    const recoveryHeartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    expect(event).toBeTruthy();
    let responseLost = false;
    const responseLoss = workPackageDispatchService(db, {
      writesEnabled: true,
      failpoint: (name) => {
        if (name === "after_outbox_commit" && !responseLost) {
          responseLost = true;
          throw new Error("response_lost");
        }
      },
    });
    await responseLoss.processOutbox(recoveryHeartbeat.wakeup);
    await recoveryHeartbeat.drainActiveRunExecutions();
    recoveryEvidence.push({ case: "wake_response_loss", phase: "before", snapshot: await eightLayerSnapshot(context.company.id, childIntent.recordId) });
    await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) }).where(eq(workRecordOutbox.id, event.id));
    await workPackageDispatchService(db, { writesEnabled: true }).processOutbox(recoveryHeartbeat.wakeup);
    await recoveryHeartbeat.drainActiveRunExecutions();
    recoveryEvidence.push({ case: "wake_response_loss", phase: "after", snapshot: await eightLayerSnapshot(context.company.id, childIntent.recordId) });
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-intent:${childIntent.id}:${childIntent.generation}`),
    ))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      eq(heartbeatRuns.agentId, context.agent.id),
    ))).toHaveLength(1);

    const projectionTarget = await record(context, "Projection recovery target");
    await prepare(workPackageDispatchService(db, { writesEnabled: true }), context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [projectionTarget.id],
    }), "projection-recovery");
    const projectionIntent = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, projectionTarget.id),
    )).then((rows) => rows[0]);
    await db.update(issues).set({ responsibleUserId: "m2b-recovery-owner" }).where(eq(issues.id, projectionIntent.issueId!));
    let projectionFailed = false;
    await workPackageDispatchService(db, {
      writesEnabled: true,
      failpoint: (name) => {
        if (name === "before_projection_update" && !projectionFailed) {
          projectionFailed = true;
          throw new Error("projection_not_updated");
        }
      },
    }).processOutbox(recoveryHeartbeat.wakeup, 1);
    await recoveryHeartbeat.drainActiveRunExecutions();
    const projectionEventBefore = await db.select().from(workRecordOutbox)
      .where(eq(workRecordOutbox.executionIntentId, projectionIntent.id)).then((rows) => rows[0]);
    const projectionWakeKey = `work-record-intent:${projectionIntent.id}:${projectionIntent.generation}`;
    const projectionWakesBefore = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, projectionWakeKey),
    ));
    const projectionRunsBefore = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      inArray(heartbeatRuns.wakeupRequestId, projectionWakesBefore.map((wake) => wake.id)),
    ));
    expect(projectionEventBefore.state).toBe("retry");
    expect(projectionWakesBefore).toHaveLength(1);
    expect(projectionRunsBefore).toHaveLength(1);
    recoveryEvidence.push({ case: "projection_not_updated", phase: "before", snapshot: await eightLayerSnapshot(context.company.id, projectionTarget.id) });
    await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) }).where(eq(workRecordOutbox.id, projectionEventBefore.id));
    await workPackageDispatchService(db, { writesEnabled: true }).processOutbox(recoveryHeartbeat.wakeup, 1);
    await recoveryHeartbeat.drainActiveRunExecutions();
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.id, projectionEventBefore.id)).then((rows) => rows[0])).toMatchObject({ state: "delivered" });
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, projectionWakeKey),
    ))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      inArray(heartbeatRuns.wakeupRequestId, projectionWakesBefore.map((wake) => wake.id)),
    ))).toHaveLength(1);
    recoveryEvidence.push({ case: "projection_not_updated", phase: "after", snapshot: await eightLayerSnapshot(context.company.id, projectionTarget.id) });

    const staleTarget = await record(context, "Stale target");
    const stale = await prepare(workPackageDispatchService(db, { writesEnabled: true }), context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [staleTarget.id],
    }), "stale-event");
    const staleLink = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id), eq(workRecordIssueLinks.recordId, staleTarget.id),
    )).then((rows) => rows[0]);
    await db.update(issues).set({ status: "in_progress", statusVersion: 1 }).where(eq(issues.id, staleLink.issueId));
    recoveryEvidence.push({ case: "out_of_order_old_event", phase: "before", snapshot: await eightLayerSnapshot(context.company.id, staleTarget.id) });
    await workPackageDispatchService(db, { writesEnabled: true }).processOutbox(recoveryHeartbeat.wakeup);
    const staleIntent = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id), eq(workRecordExecutionIntents.recordId, staleTarget.id),
    )).then((rows) => rows[0]);
    expect(stale.batch.state).toBe("prepared");
    expect(staleIntent.state).toBe("superseded");
    recoveryEvidence.push({ case: "out_of_order_old_event", phase: "after", snapshot: await eightLayerSnapshot(context.company.id, staleTarget.id) });

    const unknownTarget = await record(context, "Unknown event target");
    await prepare(workPackageDispatchService(db, { writesEnabled: true }), context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [unknownTarget.id],
    }), "unknown-event");
    const unknownEvent = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.recordId, unknownTarget.id),
    )).then((rows) => rows[0]);
    await db.update(workRecordOutbox).set({ eventType: "unknown_v2_event" }).where(eq(workRecordOutbox.id, unknownEvent.id));
    const wakeCountBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id));
    await workPackageDispatchService(db, { writesEnabled: true }).processOutbox(recoveryHeartbeat.wakeup);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.id, unknownEvent.id)).then((rows) => rows[0])).toMatchObject({
      state: "superseded",
      lastError: expect.stringContaining("Unsupported work-record workflow v2 event"),
    });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id))).toHaveLength(wakeCountBefore.length);
    const evidenceDir = process.env.PAPERCLIP_M2B_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "recovery-failpoint-snapshots.json"), `${JSON.stringify({
        schemaVersion: 1,
        baselineCommit: "6fdd60d393c828f3a1500f78c10503e0badd1451",
        testedCommit: process.env.PAPERCLIP_M2B_TESTED_COMMIT ?? null,
        snapshots: recoveryEvidence,
      }, null, 2)}\n`, "utf8");
    }
  });

  it("G01-G02 supersedes stale intent/outbox facts and requires a fresh dependency snapshot", async () => {
    const context = await seed();
    await isolatePendingV2Outbox(context.company.id);
    const target = await record(context, "Revision target");
    const newPrerequisite = await record(context, "New prerequisite");
    const retargetedPrerequisite = await record(context, "Retargeted prerequisite");
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const first = await prepare(service, context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [target.id],
    }), "revision-one");
    const firstIntent = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, target.id),
    )).then((rows) => rows[0]);
    await db.update(issues).set({ responsibleUserId: "m2b-revision-owner" }).where(eq(issues.id, firstIntent.issueId!));
    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await service.processOutbox(heartbeat.wakeup, 1);
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.executionIntentId, firstIntent.id)).then((rows) => rows[0])).toMatchObject({ state: "delivered" });
    const v2Records = workRecordService(db, { writesEnabled: true });
    const revised = await v2Records.update(context.company.id, context.project.id, target.id, {
      expectedRevision: target.revision,
      predecessorRecordIds: [newPrerequisite.id],
    });
    expect(revised.dependencySetRevision).toBe(target.dependencySetRevision + 1);
    expect(await db.select().from(workRecordDispatchBatches).where(eq(workRecordDispatchBatches.id, first.batch.id)).then((rows) => rows[0])).toMatchObject({ state: "superseded" });
    expect(await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id), eq(workRecordExecutionIntents.recordId, target.id),
    )).then((rows) => rows[0])).toMatchObject({ state: "superseded" });
    expect(await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id), eq(workRecordOutbox.recordId, target.id),
    )).then((rows) => rows[0])).toMatchObject({ state: "superseded" });

    const second = await prepare(service, context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [target.id],
    }), "revision-two");
    expect(second.batch.id).not.toBe(first.batch.id);
    expect(await db.select().from(workRecordDependencySnapshots).where(and(
      eq(workRecordDependencySnapshots.companyId, context.company.id),
      eq(workRecordDependencySnapshots.batchId, second.batch.id),
    ))).toEqual([expect.objectContaining({
      predecessorRecordId: newPrerequisite.id,
      successorRecordId: target.id,
    })]);

    const removed = await v2Records.update(context.company.id, context.project.id, target.id, {
      expectedRevision: revised.revision,
      predecessorRecordIds: [],
    });
    const third = await prepare(service, context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [target.id],
    }), "revision-three-remove");
    expect(third.batch.id).not.toBe(second.batch.id);
    expect(await db.select().from(workRecordDependencySnapshots).where(and(
      eq(workRecordDependencySnapshots.companyId, context.company.id),
      eq(workRecordDependencySnapshots.batchId, third.batch.id),
    ))).toHaveLength(0);

    await v2Records.update(context.company.id, context.project.id, target.id, {
      expectedRevision: removed.revision,
      predecessorRecordIds: [retargetedPrerequisite.id],
    });
    const fourth = await prepare(service, context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [target.id],
    }), "revision-four-retarget");
    expect(fourth.batch.id).not.toBe(third.batch.id);
    expect(await db.select().from(workRecordDependencySnapshots).where(and(
      eq(workRecordDependencySnapshots.companyId, context.company.id),
      eq(workRecordDependencySnapshots.batchId, fourth.batch.id),
    ))).toEqual([expect.objectContaining({
      predecessorRecordId: retargetedPrerequisite.id,
      successorRecordId: target.id,
    })]);
    const wakeCount = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-intent:${firstIntent.id}:${firstIntent.generation}`),
    ));
    await service.processOutbox(heartbeat.wakeup);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-intent:${firstIntent.id}:${firstIntent.generation}`),
    ))).toHaveLength(wakeCount.length);
  });

  it("O01 exports a 50-round real PostgreSQL eight-layer ledger through heartbeatService.wakeup", async () => {
    const context = await seed();
    await isolatePendingV2Outbox(context.company.id);
    const first = workPackageDispatchService(db, { writesEnabled: true });
    const second = workPackageDispatchService(secondDb, { writesEnabled: true });
    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const ledger: Array<Record<string, unknown>> = [];
    for (let round = 0; round < 50; round += 1) {
      const target = await record(context, `Race ${round}`);
      const input = scopeInput(context, { scopeKind: "selected_records", rootRecordId: null, selectedRecordIds: [target.id] });
      const preview = await first.preview(context.company.id, context.project.id, input);
      const request = {
        ...input,
        clientRequestId: `race-${round}`,
        requestPayloadDigest: `race-payload-${round}`,
        expectedScopeDigest: preview.scopeDigest,
        expectedRootRevision: preview.rootRevision,
        expectedDependencySetRevision: preview.dependencySetRevision,
      };
      const [left, right] = await Promise.all([
        first.prepare(context.company.id, context.project.id, request, { actorType: "system", actorId: "left" }),
        second.prepare(context.company.id, context.project.id, request, { actorType: "system", actorId: "right" }),
      ]);
      expect(left.batch.id).toBe(right.batch.id);
      let conflictCode: string | null = null;
      try {
        await first.prepare(context.company.id, context.project.id, {
          ...request,
          requestPayloadDigest: "conflicting-payload",
        }, { actorType: "system", actorId: "conflict" });
      } catch (error) {
        expect(error).toMatchObject({ status: 409, details: { code: "work_record_workflow_idempotency_conflict" } });
        conflictCode = (error as { details?: { code?: string } }).details?.code ?? null;
      }

      const intent = await db.select().from(workRecordExecutionIntents).where(and(
        eq(workRecordExecutionIntents.companyId, context.company.id),
        eq(workRecordExecutionIntents.recordId, target.id),
      )).then((rows) => rows[0]);
      const issueLink = await db.select().from(workRecordIssueLinks).where(and(
        eq(workRecordIssueLinks.companyId, context.company.id),
        eq(workRecordIssueLinks.recordId, target.id),
      )).then((rows) => rows[0]);
      await db.update(issues).set({ responsibleUserId: "m2b-evidence-owner" }).where(eq(issues.id, issueLink.issueId));

      let lost = false;
      const responseLoss = workPackageDispatchService(db, {
        writesEnabled: true,
        failpoint: (name) => {
          if (name === "after_outbox_commit" && !lost) {
            lost = true;
            throw new Error(`simulated_wakeup_response_loss:${round}`);
          }
        },
      });
      await responseLoss.processOutbox(heartbeat.wakeup, 1);
      await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) })
        .where(eq(workRecordOutbox.executionIntentId, intent.id));
      await workPackageDispatchService(secondDb, { writesEnabled: true }).processOutbox(heartbeat.wakeup, 1);
      await heartbeat.drainActiveRunExecutions();

      const item = await db.select().from(workRecordDispatchBatchItems).where(and(
        eq(workRecordDispatchBatchItems.companyId, context.company.id),
        eq(workRecordDispatchBatchItems.batchId, left.batch.id),
        eq(workRecordDispatchBatchItems.recordId, target.id),
      )).then((rows) => rows[0]);
      const outbox = await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.executionIntentId, intent.id));
      const wakeKey = `work-record-intent:${intent.id}:${intent.generation}`;
      const wakes = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, context.company.id),
        eq(agentWakeupRequests.idempotencyKey, wakeKey),
      ));
      const runs = wakes.length === 0 ? [] : await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, context.company.id),
        inArray(heartbeatRuns.wakeupRequestId, wakes.map((wake) => wake.id)),
      ));
      expect(outbox).toHaveLength(1);
      expect(wakes).toHaveLength(1);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("succeeded");
      ledger.push({
        round,
        winner: left.replayed ? "right" : "left",
        replayed: [left.replayed, right.replayed],
        conflictCode,
        layers: {
          record: { ids: [target.id], effectiveCount: 1 },
          batch: { ids: [left.batch.id], effectiveCount: 1 },
          item: { ids: [item.id], effectiveCount: 1 },
          link: { ids: [issueLink.id], effectiveCount: 1 },
          intent: { ids: [intent.id], effectiveCount: 1 },
          outbox: { ids: outbox.map((row) => row.id), effectiveCount: outbox.filter((row) => row.state === "delivered").length },
          wake: { ids: wakes.map((row) => row.id), effectiveCount: wakes.filter((row) => ["queued", "claimed", "running", "completed"].includes(row.status)).length },
          run: { ids: runs.map((row) => row.id), effectiveCount: runs.filter((row) => ["queued", "running", "succeeded"].includes(row.status)).length },
        },
      });
    }
    expect(await db.select().from(workRecordDispatchBatches).where(eq(workRecordDispatchBatches.companyId, context.company.id))).toHaveLength(50);
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.companyId, context.company.id))).toHaveLength(50);
    expect(await db.select().from(workRecordExecutionIntents).where(eq(workRecordExecutionIntents.companyId, context.company.id))).toHaveLength(50);
    expect(ledger).toHaveLength(50);
    const evidenceDir = process.env.PAPERCLIP_M2B_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "o01-eight-layer-ledger.json"), `${JSON.stringify({
        schemaVersion: 1,
        baselineCommit: "6fdd60d393c828f3a1500f78c10503e0badd1451",
        testedCommit: process.env.PAPERCLIP_M2B_TESTED_COMMIT ?? null,
        rounds: ledger,
      }, null, 2)}\n`, "utf8");
    }
  }, 240_000);
});
