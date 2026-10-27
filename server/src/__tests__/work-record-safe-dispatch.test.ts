import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
  workspaceOperations,
  workRecordDispatchCommands,
  workRecordDependencies,
  workRecordExecutionHolds,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecords,
} from "@paperclipai/db";
import { deriveWorkRecordDisplayState } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { workRecordService } from "../services/work-records.js";

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

  it.each(["company pause", "budget hard stop", "approval gate"])("keeps outbox pending when the authoritative heartbeat denies %s", async () => {
    const context = await seed();
    const record = await createRecord(context, "Gated");
    await context.service.dispatch(context.company.id, context.project.id, record.id, { clientRequestId: "dispatch", expectedRevision: record.revision }, { actorType: "system", actorId: "test" });
    await context.service.processOutbox(async () => { throw new Error("authoritative gate denied"); });
    const event = await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, record.id)).then((rows) => rows[0]);
    expect(event.state).toBe("retry");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(0);
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

describe("SD-09..SD-11 layered display state", () => {
  it("SD-09 animates only a real running run", () => {
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "queued", liveRunStatus: "running" })).toEqual({ state: "running", animated: true });
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "queued", liveRunStatus: "queued" }).animated).toBe(false);
    expect(deriveWorkRecordDisplayState({ businessStatus: "todo", dispatchState: "linked", liveRunStatus: "queued" })).toEqual({ state: "queued", animated: false });
  });
  it("SD-10 reports unknown without animation when liveness cannot be read", () => {
    expect(deriveWorkRecordDisplayState({ businessStatus: "in_progress", dispatchState: "linked", liveRunQueryFailed: true })).toEqual({ state: "unknown", animated: false });
  });
  it("SD-11 surfaces terminal/live conflicts instead of pretending normal execution", () => {
    expect(deriveWorkRecordDisplayState({ businessStatus: "done", dispatchState: "queued", liveRunStatus: "running" })).toEqual({ state: "conflict", animated: false });
  });
});
