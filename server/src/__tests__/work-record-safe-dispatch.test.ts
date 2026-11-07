import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projectIterations,
  projectVersions,
  projects,
  workspaceOperations,
  workRecordDispatchCommands,
  workRecordDependencies,
  workRecordExecutionHolds,
  workRecordExecutionProjections,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecords,
} from "@paperclipai/db";
import { deriveWorkRecordDisplayState } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { createNonOverlappingWorkRecordTick, workRecordService } from "../services/work-records.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("SD-01..SD-11 safe work-record dispatch contract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-dispatch-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({ name: `Company ${suffix}`, issuePrefix: `W${suffix}` }).returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({ companyId: company.id, name: "Safe dispatch" }).returning().then((rows) => rows[0]);
    const agent = await db.insert(agents).values({ companyId: company.id, name: "Rabbit", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning().then((rows) => rows[0]);
    return { company, project, agent, service: workRecordService(db) };
  }

  async function createRecord(
    context: Awaited<ReturnType<typeof seed>>,
    title: string,
    predecessorRecordIds: string[] = [],
  ) {
    return context.service.create(context.company.id, {
      projectId: context.project.id,
      kind: "plan",
      title,
      assigneeAgentId: context.agent.id,
      predecessorRecordIds,
    }, { actorType: "system", actorId: "test" });
  }

  it("SD-01 saves and preassigns without issue, wake, run, or outbox side effects", async () => {
    const context = await seed();
    const record = await createRecord(context, "Saved only");
    await context.service.update(context.company.id, context.project.id, record.id, {
      expectedRevision: record.revision,
      description: "Edited without dispatch",
    });
    expect(await db.select().from(issues).where(eq(issues.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.companyId, context.company.id))).toHaveLength(0);
  });

  it("G1 persists planned dates and defect details without dispatch side effects", async () => {
    const context = await seed();
    const defect = await context.service.create(context.company.id, {
      projectId: context.project.id,
      kind: "defect",
      title: "Checkout fails",
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      defectSeverity: "high",
      defectReproductionSteps: "Open checkout and submit a valid cart.",
      defectExpectedResult: "Order is created.",
      defectActualResult: "The request returns 500.",
      predecessorRecordIds: [],
    }, { actorType: "system", actorId: "test" });

    expect(defect).toMatchObject({
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      defectSeverity: "high",
      defectReproductionSteps: "Open checkout and submit a valid cart.",
      defectExpectedResult: "Order is created.",
      defectActualResult: "The request returns 500.",
    });
    await expect(context.service.create(context.company.id, {
      projectId: context.project.id,
      kind: "plan",
      title: "Plan cannot carry defect details",
      defectSeverity: "critical",
      predecessorRecordIds: [],
    }, { actorType: "system", actorId: "test" })).rejects.toMatchObject({ status: 422 });
    await expect(context.service.update(context.company.id, context.project.id, defect.id, {
      expectedRevision: defect.revision,
      plannedStartDate: "2026-11-20",
      plannedCompletionDate: "2026-11-19",
    })).rejects.toMatchObject({ status: 422 });

    expect(await db.select().from(issues).where(eq(issues.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.companyId, context.company.id))).toHaveLength(0);
  });

  it("G1 keeps version and iteration history, rejects stale writers, and only deletes empty containers", async () => {
    const context = await seed();
    const version = await context.service.createVersion(context.company.id, context.project.id, {
      name: "1.0",
      targetDate: "2026-12-31",
    });
    const iteration = await context.service.createIteration(context.company.id, context.project.id, {
      versionId: version.id,
      name: "Iteration 1",
      startsOn: "2026-11-01",
      endsOn: "2026-11-14",
    });
    const record = await context.service.create(context.company.id, {
      projectId: context.project.id,
      iterationId: iteration.id,
      kind: "plan",
      title: "Bound record",
      predecessorRecordIds: [],
    }, { actorType: "system", actorId: "test" });

    await expect(context.service.updateVersion(context.company.id, context.project.id, version.id, {
      expectedRevision: 999,
      name: "stale writer",
    })).rejects.toMatchObject({ status: 409, message: "Project version changed" });

    const archivedIteration = await context.service.archiveIteration(
      context.company.id,
      context.project.id,
      iteration.id,
      iteration.revision,
    );
    await expect(context.service.create(context.company.id, {
      projectId: context.project.id,
      iterationId: iteration.id,
      kind: "plan",
      title: "Rejected historical write",
      predecessorRecordIds: [],
    }, { actorType: "system", actorId: "test" })).rejects.toMatchObject({ status: 409 });
    await expect(context.service.deleteIteration(
      context.company.id,
      context.project.id,
      iteration.id,
      archivedIteration.revision,
    )).rejects.toMatchObject({ status: 409, message: "Only an empty iteration can be deleted" });

    const restoredIteration = await context.service.restoreIteration(
      context.company.id,
      context.project.id,
      iteration.id,
      archivedIteration.revision,
    );
    const archivedVersion = await context.service.archiveVersion(
      context.company.id,
      context.project.id,
      version.id,
      version.revision,
    );
    await expect(context.service.createIteration(context.company.id, context.project.id, {
      versionId: version.id,
      name: "Rejected iteration",
    })).rejects.toMatchObject({ status: 409, message: "Archived version cannot accept iterations" });
    await expect(context.service.create(context.company.id, {
      projectId: context.project.id,
      iterationId: restoredIteration.id,
      kind: "plan",
      title: "Rejected record under archived version",
      predecessorRecordIds: [],
    }, { actorType: "system", actorId: "test" })).rejects.toMatchObject({
      status: 409,
      message: "Iteration belongs to an archived version",
    });
    const restoredVersion = await context.service.restoreVersion(
      context.company.id,
      context.project.id,
      version.id,
      archivedVersion.revision,
    );

    expect((await context.service.listVersions(context.company.id, context.project.id))[0]).toMatchObject({ id: version.id });
    expect((await context.service.listIterations(context.company.id, context.project.id))[0]).toMatchObject({
      id: iteration.id,
      archivedAt: null,
      revision: restoredIteration.revision,
    });
    expect((await context.service.list(context.company.id, context.project.id))[0]).toMatchObject({ id: record.id, iterationId: iteration.id });

    const emptyVersion = await context.service.createVersion(context.company.id, context.project.id, { name: "empty" });
    await expect(context.service.deleteVersion(
      context.company.id,
      context.project.id,
      version.id,
      restoredVersion.revision,
    )).rejects.toMatchObject({ status: 409, message: "Only an empty version can be deleted" });
    await expect(context.service.deleteVersion(
      context.company.id,
      context.project.id,
      emptyVersion.id,
      emptyVersion.revision,
    )).resolves.toEqual({ id: emptyVersion.id, deleted: true });

    expect(await db.select().from(projectVersions).where(eq(projectVersions.companyId, context.company.id))).toHaveLength(1);
    expect(await db.select().from(projectIterations).where(eq(projectIterations.companyId, context.company.id))).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.companyId, context.company.id))).toHaveLength(0);
  });

  it("G1 preserves every predecessor when unrelated fields change and conflicts stale concurrent edits", async () => {
    const context = await seed();
    const first = await createRecord(context, "A");
    const second = await createRecord(context, "B");
    const dependent = await createRecord(context, "C", [first.id, second.id]);

    const results = await Promise.allSettled([
      context.service.update(context.company.id, context.project.id, dependent.id, {
        expectedRevision: dependent.revision,
        title: "C title",
      }),
      context.service.update(context.company.id, context.project.id, dependent.id, {
        expectedRevision: dependent.revision,
        description: "C description",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 409, message: "Work record revision changed" },
    });
    const edges = await db.select().from(workRecordDependencies).where(and(
      eq(workRecordDependencies.companyId, context.company.id),
      eq(workRecordDependencies.successorRecordId, dependent.id),
    ));
    expect(new Set(edges.map((edge) => edge.predecessorRecordId))).toEqual(new Set([first.id, second.id]));
  });

  it("serializes concurrent dependency writers per project so two valid prechecks cannot commit a cycle", async () => {
    const context = await seed();
    const first = await createRecord(context, "A");
    const second = await createRecord(context, "B");

    const results = await Promise.allSettled([
      context.service.update(context.company.id, context.project.id, first.id, {
        expectedRevision: first.revision,
        predecessorRecordIds: [second.id],
      }),
      context.service.update(context.company.id, context.project.id, second.id, {
        expectedRevision: second.revision,
        predecessorRecordIds: [first.id],
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 422, message: "Dependency update would create a cycle" },
    });
    expect(await db.select().from(workRecordDependencies).where(and(
      eq(workRecordDependencies.companyId, context.company.id),
      eq(workRecordDependencies.projectId, context.project.id),
    ))).toHaveLength(1);
  });

  it("SD-02 dispatches a dependent record once but holds it when its source is undispatched", async () => {
    const context = await seed();
    const source = await createRecord(context, "A");
    const dependent = await createRecord(context, "B", [source.id]);
    const result = await context.service.dispatch(context.company.id, context.project.id, dependent.id, { clientRequestId: "dispatch-b", expectedRevision: dependent.revision }, { actorType: "system", actorId: "test" });
    expect(result.record.dispatchState).toBe("blocked");
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.recordId, dependent.id))).toHaveLength(1);
    expect(await db.select().from(workRecordExecutionHolds).where(and(eq(workRecordExecutionHolds.dependentRecordId, dependent.id), eq(workRecordExecutionHolds.reason, "prerequisite_not_dispatched")))).toHaveLength(1);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, dependent.id))).toHaveLength(0);
  });

  it("SD-03 serializes concurrent dispatch retries onto one command, issue, and primary link", async () => {
    const context = await seed();
    const record = await createRecord(context, "Concurrent");
    const input = { clientRequestId: "same-request", expectedRevision: record.revision };
    const [first, second] = await Promise.all([
      context.service.dispatch(context.company.id, context.project.id, record.id, input, { actorType: "system", actorId: "test" }),
      context.service.dispatch(context.company.id, context.project.id, record.id, input, { actorType: "system", actorId: "test" }),
    ]);
    expect(first.issueId).toBe(second.issueId);
    expect(await db.select().from(workRecordDispatchCommands).where(eq(workRecordDispatchCommands.recordId, record.id))).toHaveLength(1);
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.recordId, record.id))).toHaveLength(1);
  });

  it("SD-04 blocks both central admission and status-dropdown bypass while a source hold exists", async () => {
    const context = await seed();
    const source = await createRecord(context, "A");
    const dependent = await createRecord(context, "B", [source.id]);
    const result = await context.service.dispatch(context.company.id, context.project.id, dependent.id, { clientRequestId: "b", expectedRevision: dependent.revision }, { actorType: "system", actorId: "test" });
    const readiness = await issueService(db).getDependencyReadiness(result.issueId);
    expect(readiness).toMatchObject({ isDependencyReady: false, unresolvedSourceHoldCount: 1 });
    await expect(context.service.assertNoSourceHoldStatusBypass(context.company.id, result.issueId, "in_progress")).rejects.toMatchObject({ status: 409 });
    await expect(context.service.update(context.company.id, context.project.id, dependent.id, {
      expectedRevision: result.record.revision,
      businessStatus: "in_progress",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("SD-05 changes the hold to prerequisite_not_completed after the source is dispatched", async () => {
    const context = await seed();
    const source = await createRecord(context, "A");
    const dependent = await createRecord(context, "B", [source.id]);
    await context.service.dispatch(context.company.id, context.project.id, dependent.id, { clientRequestId: "b", expectedRevision: dependent.revision }, { actorType: "system", actorId: "test" });
    await context.service.dispatch(context.company.id, context.project.id, source.id, { clientRequestId: "a", expectedRevision: source.revision }, { actorType: "system", actorId: "test" });
    await context.service.reconcileRecord(context.company.id, context.project.id, dependent.id);
    const hold = await db.select().from(workRecordExecutionHolds).where(and(eq(workRecordExecutionHolds.dependentRecordId, dependent.id), isNull(workRecordExecutionHolds.resolvedAt))).then((rows) => rows[0]);
    expect(hold.reason).toBe("prerequisite_not_completed");
  });

  it("SD-06 waits for successful workspace delivery after source completion", async () => {
    const context = await seed();
    const source = await createRecord(context, "A");
    const dependent = await createRecord(context, "B", [source.id]);
    const sourceDispatch = await context.service.dispatch(context.company.id, context.project.id, source.id, { clientRequestId: "a", expectedRevision: source.revision }, { actorType: "system", actorId: "test" });
    await context.service.dispatch(context.company.id, context.project.id, dependent.id, { clientRequestId: "b", expectedRevision: dependent.revision }, { actorType: "system", actorId: "test" });
    const workspace = await db.insert(executionWorkspaces).values({ companyId: context.company.id, projectId: context.project.id, sourceIssueId: sourceDispatch.issueId, mode: "isolated", strategyType: "git_worktree", name: "A workspace" }).returning().then((rows) => rows[0]);
    await db.update(issues).set({ status: "done", executionWorkspaceId: workspace.id }).where(eq(issues.id, sourceDispatch.issueId));
    await db.insert(workspaceOperations).values({ companyId: context.company.id, executionWorkspaceId: workspace.id, issueId: sourceDispatch.issueId, phase: "workspace_finalize", status: "running" });
    await context.service.reconcileRecord(context.company.id, context.project.id, dependent.id);
    const hold = await db.select().from(workRecordExecutionHolds).where(and(eq(workRecordExecutionHolds.dependentRecordId, dependent.id), eq(workRecordExecutionHolds.reason, "delivery_sync_pending"))).then((rows) => rows[0]);
    expect(hold).toBeTruthy();
  });

  it("SD-07 and SD-08 emit one effective release and replay to one run", async () => {
    await db.delete(workRecordOutbox);
    const context = await seed();
    const source = await createRecord(context, "A");
    const dependent = await createRecord(context, "B", [source.id]);
    const sourceDispatch = await context.service.dispatch(context.company.id, context.project.id, source.id, { clientRequestId: "a", expectedRevision: source.revision }, { actorType: "system", actorId: "test" });
    const dependentDispatch = await context.service.dispatch(context.company.id, context.project.id, dependent.id, { clientRequestId: "b", expectedRevision: dependent.revision }, { actorType: "system", actorId: "test" });
    await db.delete(workRecordOutbox).where(eq(workRecordOutbox.recordId, source.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceDispatch.issueId));
    await Promise.all([1, 2, 3].map(() => context.service.reconcileRecord(context.company.id, context.project.id, dependent.id)));
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, dependent.id))).toHaveLength(1);
    let wakeCalls = 0;
    const wake = async (agentId: string, options: { idempotencyKey: string }) => {
      wakeCalls += 1;
      const request = await db.insert(agentWakeupRequests).values({ companyId: context.company.id, agentId, source: "assignment", status: "queued", idempotencyKey: options.idempotencyKey }).returning().then((rows) => rows[0]);
      await db.insert(heartbeatRuns).values({ companyId: context.company.id, agentId, wakeupRequestId: request.id, status: "queued" });
      return request;
    };
    await Promise.all([context.service.processOutbox(wake as never), context.service.processOutbox(wake as never)]);
    await context.service.processOutbox(wake as never);
    const replay = await context.service.dispatch(context.company.id, context.project.id, dependent.id, { clientRequestId: "retry-after-timeout", expectedRevision: dependent.revision }, { actorType: "system", actorId: "test" });
    expect(replay.issueId).toBe(dependentDispatch.issueId);
    expect(wakeCalls).toBe(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(1);
  });

  it("queries a timed-out dispatch by the same client request without creating a new tuple", async () => {
    const context = await seed();
    const record = await createRecord(context, "Timeout lookup");
    const dispatched = await context.service.dispatch(
      context.company.id,
      context.project.id,
      record.id,
      { clientRequestId: "stable-request", expectedRevision: record.revision },
      { actorType: "system", actorId: "test" },
    );
    const result = await context.service.getDispatchRequest(
      context.company.id,
      context.project.id,
      record.id,
      "stable-request",
    );
    expect(result).toMatchObject({
      clientRequestId: "stable-request",
      state: "linked",
      issueId: dispatched.issueId,
      issueLinkId: dispatched.issueLinkId,
      record: { id: record.id, dispatchRound: 1 },
    });
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.recordId, record.id))).toHaveLength(1);
    expect(await db.select().from(workRecordDispatchCommands).where(eq(workRecordDispatchCommands.recordId, record.id))).toHaveLength(1);
  });

  it("persists release failure and safely re-arms the same outbox tuple", async () => {
    const context = await seed();
    const record = await createRecord(context, "Recover release");
    await context.service.dispatch(context.company.id, context.project.id, record.id, { clientRequestId: "dispatch", expectedRevision: record.revision }, { actorType: "system", actorId: "test" });
    await context.service.processOutbox(async () => { throw new Error("simulated transport failure"); });
    expect(await db.select().from(workRecords).where(eq(workRecords.id, record.id)).then((rows) => rows[0])).toMatchObject({ dispatchState: "failed" });
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, record.id)).then((rows) => rows[0])).toMatchObject({ state: "retry", lastError: "simulated transport failure" });

    const recovered = await context.service.recoverRecord(context.company.id, context.project.id, record.id);
    expect(recovered).toMatchObject({ dispatchState: "linked", recovery: { code: "release_pending", canReconcile: true } });
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, record.id)).then((rows) => rows[0])).toMatchObject({ state: "pending", lastError: null });
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.recordId, record.id))).toHaveLength(1);
    await db.update(workRecordOutbox).set({ state: "superseded" }).where(eq(workRecordOutbox.recordId, record.id));
  });

  it("projects a terminal release run as ended and flags a missing disposition", async () => {
    const context = await seed();
    const record = await createRecord(context, "No disposition");
    const dispatched = await context.service.dispatch(context.company.id, context.project.id, record.id, { clientRequestId: "dispatch", expectedRevision: record.revision }, { actorType: "system", actorId: "test" });
    const event = await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, record.id)).then((rows) => rows[0]);
    const request = await db.insert(agentWakeupRequests).values({
      companyId: context.company.id,
      agentId: context.agent.id,
      source: "assignment",
      status: "completed",
      reason: "work_record_released",
      idempotencyKey: `work-record-release:${event.eventKey}`,
    }).returning().then((rows) => rows[0]);
    const run = await db.insert(heartbeatRuns).values({
      companyId: context.company.id,
      agentId: context.agent.id,
      wakeupRequestId: request.id,
      status: "succeeded",
      startedAt: new Date(Date.now() - 1_000),
      finishedAt: new Date(),
      contextSnapshot: { issueId: dispatched.issueId, wakeReason: "work_record_released", source: "work_record_release" },
    }).returning().then((rows) => rows[0]);
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, request.id));
    await db.update(workRecordOutbox).set({ state: "delivered", deliveredAt: new Date() }).where(eq(workRecordOutbox.id, event.id));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, dispatched.issueId));
    await context.service.reconcileRecord(context.company.id, context.project.id, record.id);

    const [projected] = await context.service.list(context.company.id, context.project.id);
    expect(projected).toMatchObject({
      dispatchState: "linked",
      execution: {
        lastRunId: run.id,
        lastRunStatus: "succeeded",
        projectionState: "error",
        projectionError: "successful_run_missing_disposition",
      },
      recovery: { code: "projection_error", canReconcile: true },
      delivery: {
        eventKey: event.eventKey,
        deliveryState: "delivered",
        deliveredAt: expect.any(Date),
        wakeRequestId: request.id,
        wakeStatus: "completed",
        acknowledgedAt: null,
        runId: run.id,
      },
    });
  });

  it("reclaims an expired processing lease without creating a second effective wake", async () => {
    const context = await seed();
    const record = await createRecord(context, "Crash recovery");
    await context.service.dispatch(context.company.id, context.project.id, record.id, { clientRequestId: "dispatch", expectedRevision: record.revision }, { actorType: "system", actorId: "test" });
    await db.update(workRecordOutbox).set({ state: "processing", availableAt: new Date(Date.now() - 1_000) }).where(eq(workRecordOutbox.recordId, record.id));
    let wakeCalls = 0;
    await context.service.processOutbox(async (agentId, options) => {
      wakeCalls += 1;
      return db.insert(agentWakeupRequests).values({
        companyId: context.company.id,
        agentId,
        source: "assignment",
        status: "queued",
        idempotencyKey: options.idempotencyKey,
      }).returning().then((rows) => rows[0]);
    });
    await context.service.processOutbox(async () => { throw new Error("must not redeliver"); });
    expect(wakeCalls).toBe(1);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, record.id)).then((rows) => rows[0])).toMatchObject({ state: "delivered", attemptCount: 1 });
  });

  it("supersedes an outbox event whose dispatch tuple is no longer current", async () => {
    const context = await seed();
    const record = await createRecord(context, "Stale release");
    await context.service.dispatch(context.company.id, context.project.id, record.id, { clientRequestId: "dispatch", expectedRevision: record.revision }, { actorType: "system", actorId: "test" });
    await db.update(workRecords).set({ blockedCycle: 1 }).where(eq(workRecords.id, record.id));
    let wakeCalls = 0;
    await context.service.processOutbox(async () => { wakeCalls += 1; });
    expect(wakeCalls).toBe(0);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, record.id)).then((rows) => rows[0])).toMatchObject({ state: "superseded" });
  });

  async function expectNativeHeartbeatGateKeepsOutboxPending(
    context: Awaited<ReturnType<typeof seed>>,
    recordId: string,
    expectedWakeReason: string,
  ) {
    const nativeHeartbeat = heartbeatService(db, { runtimeEnv: { NODE_ENV: "test" } });
    await context.service.processOutbox(nativeHeartbeat.wakeup);
    const event = await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, recordId)).then((rows) => rows[0]);
    expect(event).toMatchObject({ state: "retry", attemptCount: 1 });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id))).toEqual([
      expect.objectContaining({ status: "skipped", reason: expectedWakeReason }),
    ]);
  }

  it("keeps outbox pending when native heartbeat admission sees a paused company", async () => {
    const context = await seed();
    const record = await createRecord(context, "Company paused");
    await context.service.dispatch(context.company.id, context.project.id, record.id, { clientRequestId: "dispatch", expectedRevision: record.revision }, { actorType: "system", actorId: "test" });
    await db.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(companies.id, context.company.id));
    await expectNativeHeartbeatGateKeepsOutboxPending(context, record.id, "company.inactive");
  });

  it("keeps outbox pending when native heartbeat admission sees an exceeded budget hard-stop", async () => {
    const context = await seed();
    const record = await createRecord(context, "Budget stopped");
    const dispatched = await context.service.dispatch(context.company.id, context.project.id, record.id, { clientRequestId: "dispatch", expectedRevision: record.revision }, { actorType: "system", actorId: "test" });
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
      issueId: dispatched.issueId,
      projectId: context.project.id,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "gate-proof",
      costCents: 125,
      occurredAt: new Date(),
    });
    await expectNativeHeartbeatGateKeepsOutboxPending(context, record.id, "budget.blocked");
  });

  it("keeps outbox pending when native heartbeat admission sees an agent awaiting approval", async () => {
    const context = await seed();
    const record = await createRecord(context, "Approval pending");
    await context.service.dispatch(context.company.id, context.project.id, record.id, { clientRequestId: "dispatch", expectedRevision: record.revision }, { actorType: "system", actorId: "test" });
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, context.agent.id));
    await expectNativeHeartbeatGateKeepsOutboxPending(context, record.id, "agent.not_invokable");
  });

  it("allows multiple records to reference one issue without weakening the one-primary-link-per-record rule", async () => {
    const context = await seed();
    const primary = await createRecord(context, "Primary");
    const firstReference = await createRecord(context, "Reference 1");
    const secondReference = await createRecord(context, "Reference 2");
    const dispatched = await context.service.dispatch(context.company.id, context.project.id, primary.id, { clientRequestId: "primary", expectedRevision: primary.revision }, { actorType: "system", actorId: "test" });
    await db.insert(workRecordIssueLinks).values([
      { companyId: context.company.id, projectId: context.project.id, recordId: firstReference.id, issueId: dispatched.issueId, purpose: "reference", dispatchRound: 0 },
      { companyId: context.company.id, projectId: context.project.id, recordId: secondReference.id, issueId: dispatched.issueId, purpose: "reference", dispatchRound: 0 },
    ]);
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.issueId, dispatched.issueId))).toHaveLength(3);
    await expect(db.insert(workRecordIssueLinks).values({
      companyId: context.company.id,
      projectId: context.project.id,
      recordId: firstReference.id,
      issueId: dispatched.issueId,
      purpose: "primary",
      dispatchRound: 1,
    })).rejects.toThrow();
  });

  it("bounds each reconciliation scan", async () => {
    const context = await seed();
    const first = await createRecord(context, "First queued record");
    const second = await createRecord(context, "Second queued record");
    await context.service.dispatch(context.company.id, context.project.id, first.id, { clientRequestId: "first", expectedRevision: first.revision }, { actorType: "system", actorId: "test" });
    await context.service.dispatch(context.company.id, context.project.id, second.id, { clientRequestId: "second", expectedRevision: second.revision }, { actorType: "system", actorId: "test" });
    await expect(context.service.reconcileAll(1)).resolves.toBe(1);
  });

  it("SD-11 reconciles business and execution projections from the authoritative issue version", async () => {
    const context = await seed();
    const record = await createRecord(context, "Projection");
    const dispatched = await context.service.dispatch(context.company.id, context.project.id, record.id, { clientRequestId: "dispatch", expectedRevision: record.revision }, { actorType: "system", actorId: "test" });
    const authoritative = await db.update(issues).set({ status: "done" }).where(eq(issues.id, dispatched.issueId)).returning().then((rows) => rows[0]);
    await context.service.reconcileRecord(context.company.id, context.project.id, record.id);
    const [projected] = await context.service.list(context.company.id, context.project.id);
    expect(projected).toMatchObject({
      businessStatus: "done",
      statusVersion: authoritative.statusVersion,
      execution: { issueStatus: "done", issueStatusVersion: authoritative.statusVersion, projectionState: "current" },
    });
  });

  it("offers stale projections an executable reconcile without creating another issue, link, or run", async () => {
    const context = await seed();
    const record = await createRecord(context, "Stale projection");
    await context.service.dispatch(context.company.id, context.project.id, record.id, {
      clientRequestId: "dispatch",
      expectedRevision: record.revision,
    }, { actorType: "system", actorId: "test" });
    await db.update(workRecordExecutionProjections).set({
      syncState: "stale",
      syncError: null,
      projectedAt: new Date(Date.now() - 60_000),
    }).where(eq(workRecordExecutionProjections.recordId, record.id));

    const [stale] = await context.service.list(context.company.id, context.project.id);
    expect(stale).toMatchObject({
      execution: { projectionState: "stale" },
      recovery: { code: "projection_stale", canReconcile: true },
    });
    const before = {
      issues: await db.select().from(issues).where(eq(issues.companyId, context.company.id)),
      links: await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.recordId, record.id)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id)),
    };

    const reconciled = await context.service.recoverRecord(context.company.id, context.project.id, record.id);

    expect(reconciled).toMatchObject({
      execution: { projectionState: "current" },
      recovery: { code: "release_pending", canReconcile: true },
    });
    expect(await db.select().from(issues).where(eq(issues.companyId, context.company.id))).toHaveLength(before.issues.length);
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.recordId, record.id))).toHaveLength(before.links.length);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(before.runs.length);
  });

  it("rejects company/project boundary crossing without leaking records", async () => {
    const left = await seed();
    const right = await seed();
    const record = await createRecord(left, "Left only");
    const rightRecord = await createRecord(right, "Right only");
    await expect(right.service.dispatch(right.company.id, right.project.id, record.id, { clientRequestId: "cross", expectedRevision: record.revision }, { actorType: "system", actorId: "test" })).rejects.toMatchObject({ status: 404 });
    await expect(db.insert(workRecordDependencies).values({
      companyId: right.company.id,
      projectId: right.project.id,
      predecessorRecordId: record.id,
      successorRecordId: rightRecord.id,
    })).rejects.toThrow();
  });
});

describe("work-record background reconciliation", () => {
  it("does not overlap ticks and resumes after the active tick settles", async () => {
    let releaseFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const tick = createNonOverlappingWorkRecordTick(async () => {
      calls += 1;
      if (calls === 1) await firstRun;
    });

    const active = tick();
    await expect(tick()).resolves.toBe(false);
    expect(calls).toBe(1);
    releaseFirst();
    await expect(active).resolves.toBe(true);
    await expect(tick()).resolves.toBe(true);
    expect(calls).toBe(2);
  });
});

describe("SD-09..SD-11 layered display state", () => {
  it("SD-09 animates only a real running run", () => {
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "queued", liveRunStatus: "running" })).toEqual({ state: "running", animated: true });
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "queued", liveRunStatus: "queued" }).animated).toBe(false);
    expect(deriveWorkRecordDisplayState({ businessStatus: "todo", dispatchState: "linked", liveRunStatus: "queued" })).toEqual({ state: "queued", animated: false });
  });
  it("SD-10 reports unknown without animation when liveness cannot be read", () => {
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "linked", liveRunQueryFailed: true })).toEqual({ state: "unknown", animated: false });
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "linked", liveRunStatus: "running", liveRunQueryFailed: true })).toEqual({ state: "unknown", animated: false });
  });
  it("SD-11 surfaces terminal/live conflicts instead of pretending normal execution", () => {
    expect(deriveWorkRecordDisplayState({ businessStatus: "done", dispatchState: "queued", liveRunStatus: "running" })).toEqual({ state: "conflict", animated: false });
  });
  it("does not retain queued after the release run ends and distinguishes stale/error projections", () => {
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "queued", lastRunStatus: "succeeded" })).toEqual({ state: "ended", animated: false });
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "linked", projectionState: "stale" })).toEqual({ state: "stale", animated: false });
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "linked", projectionState: "error" })).toEqual({ state: "error", animated: false });
  });
});
