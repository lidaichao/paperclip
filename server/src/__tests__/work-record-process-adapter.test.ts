import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  workRecordIssueLinks,
  workRecordOutbox,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { workRecordService } from "../services/work-records.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("work-record real process adapter regression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let activeHeartbeat: ReturnType<typeof heartbeatService> | null = null;
  let previousJwtSecret: string | undefined;

  beforeAll(async () => {
    previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "work-record-process-adapter-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-process-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await activeHeartbeat?.drainActiveRunExecutions();
    activeHeartbeat = null;
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "work_record_outbox",
        "work_record_execution_projections",
        "work_record_execution_holds",
        "work_record_issue_links",
        "work_record_dispatch_commands",
        "work_record_dependencies",
        "work_records",
        "issues",
        "projects",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await activeHeartbeat?.drainActiveRunExecutions();
    await tempDb?.cleanup();
    if (previousJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
  });

  async function seed(script: string) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({
      name: `Process ${suffix}`,
      issuePrefix: `P${suffix}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    }).returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({ companyId: company.id, name: "Process regression" }).returning().then((rows) => rows[0]);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Process worker",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", script] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    }).returning().then((rows) => rows[0]);
    const service = workRecordService(db);
    const record = await service.create(company.id, {
      projectId: project.id,
      kind: "plan",
      title: "Execute exactly once",
      assigneeAgentId: agent.id,
      predecessorRecordIds: [],
    }, { actorType: "system", actorId: "test" });
    const dispatched = await service.dispatch(company.id, project.id, record.id, {
      clientRequestId: "stable-dispatch-request",
      expectedRevision: record.revision,
    }, { actorType: "system", actorId: "test" });
    return { company, project, agent, record, dispatched, service };
  }

  async function persistReleaseRun(context: Awaited<ReturnType<typeof seed>>) {
    await context.service.processOutbox(async (agentId, options) => {
      const request = await db.insert(agentWakeupRequests).values({
        companyId: context.company.id,
        agentId,
        source: options.source,
        triggerDetail: options.triggerDetail,
        reason: options.reason,
        payload: options.payload,
        status: "queued",
        requestedByActorType: options.requestedByActorType,
        requestedByActorId: options.requestedByActorId,
        idempotencyKey: options.idempotencyKey,
      }).returning().then((rows) => rows[0]);
      const run = await db.insert(heartbeatRuns).values({
        companyId: context.company.id,
        agentId,
        invocationSource: options.source,
        triggerDetail: options.triggerDetail,
        status: "queued",
        wakeupRequestId: request.id,
        contextSnapshot: { ...options.contextSnapshot, wakeReason: options.reason },
      }).returning().then((rows) => rows[0]);
      await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, request.id));
      return request;
    });
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id)).then((rows) => rows[0]);
  }

  async function waitForStatus(runId: string, status: string, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
      if (run?.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
  }

  async function waitForProcessStart(runId: string, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
      if (run?.processPid) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
  }

  it("executes a no-disposition release once after service restart and does not mint a handoff run", async () => {
    const context = await seed("console.log('work-record release'); process.exit(0)");
    const queued = await persistReleaseRun(context);

    activeHeartbeat = heartbeatService(db);
    await activeHeartbeat.resumeQueuedRuns();
    await activeHeartbeat.drainActiveRunExecutions();

    const finished = await waitForStatus(queued.id, "succeeded");
    expect(finished.status).toBe("succeeded");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].contextSnapshot).toMatchObject({ source: "work_record_release", wakeReason: "work_record_released" });
    const handoffWakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.reason, "finish_successful_run_handoff"),
    ));
    const links = await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.recordId, context.record.id));
    const outboxRows = await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, context.record.id));
    expect(handoffWakes).toHaveLength(0);
    expect(links).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    console.info("LUN-277 process evidence", {
      scenario: "no-disposition-after-restart",
      runId: queued.id,
      runCount: runs.length,
      handoffWakeCount: handoffWakes.length,
      issueLinkCount: links.length,
      outboxCount: outboxRows.length,
    });
  }, 20_000);

  it("keeps one release run when the issue receives a successful disposition", async () => {
    const context = await seed("setTimeout(() => process.exit(0), 750)");
    const queued = await persistReleaseRun(context);
    activeHeartbeat = heartbeatService(db);
    await activeHeartbeat.resumeQueuedRuns();
    expect((await waitForProcessStart(queued.id)).processPid).toEqual(expect.any(Number));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, context.dispatched.issueId));
    await activeHeartbeat.drainActiveRunExecutions();
    expect((await waitForStatus(queued.id, "succeeded")).status).toBe("succeeded");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id));
    expect(runs).toHaveLength(1);
    await context.service.reconcileRecord(context.company.id, context.project.id, context.record.id);
    const [record] = await context.service.list(context.company.id, context.project.id);
    expect(record).toMatchObject({ businessStatus: "done", execution: { lastRunId: queued.id, lastRunStatus: "succeeded", projectionState: "current" } });
    console.info("LUN-277 process evidence", {
      scenario: "successful-disposition",
      runId: queued.id,
      runCount: runs.length,
      businessStatus: record.businessStatus,
      projectionState: record.execution.projectionState,
    });
  }, 20_000);

  it("injects the dispatched issue id into a real process adapter run", async () => {
    const context = await seed([
      "if (!process.env.PAPERCLIP_TASK_ID) {",
      "  console.error('missing PAPERCLIP_TASK_ID');",
      "  process.exit(2);",
      "}",
      "console.log(process.env.PAPERCLIP_TASK_ID);",
    ].join("\n"));
    const queued = await persistReleaseRun(context);

    activeHeartbeat = heartbeatService(db);
    await activeHeartbeat.resumeQueuedRuns();
    await activeHeartbeat.drainActiveRunExecutions();

    const finished = await waitForStatus(queued.id, "succeeded");
    expect(finished.status).toBe("succeeded");
    expect(finished.stdoutExcerpt).toContain(context.dispatched.issueId);
  }, 20_000);
});
