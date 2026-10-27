import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  projects,
  workRecordAssignmentCommands,
  workRecordExecutionIntents,
  workRecordOutbox,
  workRecordQualityCycles,
  workRecordQualityItems,
  workRecordQualityVerdicts,
  workRecords,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type JsonRecord = Record<string, unknown>;

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected an ephemeral TCP listener"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server | null) {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readTree(root: string): Promise<Array<{ path: string; body: string }>> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: Array<{ path: string; body: string }> = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) files.push(...await readTree(path));
      else if (entry.isFile()) files.push({ path, body: await readFile(path, "utf8") });
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describeDb("M2-C A02/O02 dynamic HTTP and PostgreSQL evidence", () => {
  let db!: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let appServer: Server | null = null;
  let sinkServer: Server | null = null;
  let apiBase = "";
  let evidenceRoot = "";
  let processLogPath = "";
  let telemetrySinkDir = "";
  let sentrySinkDir = "";
  let telemetryStateDir = "";
  let logDestination: { flushSync(): void; end(): void } | null = null;
  let telemetryClient: { flush(): Promise<void>; stop(): void } | null = null;
  let shutdownSentry: (() => Promise<void>) | null = null;
  let createLocalAgentJwt!: typeof import("../agent-auth-jwt.js")["createLocalAgentJwt"];
  let records!: ReturnType<typeof import("../services/work-records.js")["workRecordService"]>;
  const priorEnv = new Map<string, string | undefined>();

  const setEnv = (key: string, value: string | undefined) => {
    if (!priorEnv.has(key)) priorEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeAll(async () => {
    evidenceRoot = await mkdtemp(join(tmpdir(), "paperclip-m2c-dynamic-"));
    processLogPath = join(evidenceRoot, "process", "http.jsonl");
    telemetrySinkDir = join(evidenceRoot, "telemetry-sink");
    sentrySinkDir = join(evidenceRoot, "sentry-sink");
    await Promise.all([
      mkdir(join(evidenceRoot, "process"), { recursive: true }),
      mkdir(telemetrySinkDir, { recursive: true }),
      mkdir(sentrySinkDir, { recursive: true }),
    ]);

    let sinkSequence = 0;
    sinkServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const target = req.url?.startsWith("/telemetry") ? telemetrySinkDir : sentrySinkDir;
        const body = Buffer.concat(chunks).toString("utf8");
        sinkSequence += 1;
        void writeFile(join(target, `${String(sinkSequence).padStart(4, "0")}.json`), body, "utf8")
          .then(() => {
            res.statusCode = req.url?.startsWith("/telemetry") ? 202 : 200;
            res.setHeader("content-type", "application/json");
            res.end("{}");
          })
          .catch((error) => {
            res.statusCode = 500;
            res.end(String(error));
          });
      });
    });
    const sinkPort = await listen(sinkServer);

    const instanceId = `m2c-dynamic-${randomUUID().slice(0, 8)}`;
    setEnv("PAPERCLIP_HOME", evidenceRoot);
    setEnv("PAPERCLIP_INSTANCE_ID", instanceId);
    setEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    setEnv("PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED", "true");
    setEnv("PAPERCLIP_TELEMETRY_DISABLED", undefined);
    setEnv("PAPERCLIP_TELEMETRY_ENDPOINT", `http://127.0.0.1:${sinkPort}/telemetry`);
    setEnv("DO_NOT_TRACK", undefined);
    setEnv("CI", undefined);
    setEnv("CONTINUOUS_INTEGRATION", undefined);
    setEnv("GITHUB_ACTIONS", undefined);
    setEnv("GITLAB_CI", undefined);
    setEnv("BUILD_NUMBER", undefined);
    setEnv("SENTRY_DSN", undefined);
    setEnv("SENTRY_DSN_FRONTEND", undefined);
    setEnv("SENTRY_DSN_BACKEND", `http://public@127.0.0.1:${sinkPort}/1`);

    database = await startEmbeddedPostgresTestDatabase("paperclip-m2c-dynamic-db-");
    db = createDb(database.connectionString);

    const [
      { actorMiddleware },
      { createLocalAgentJwt: createJwt },
      { HTTP_LOG_REDACT_PATHS },
      { createHttpLogger },
      { workRecordRoutes },
      { errorHandler },
      telemetry,
      sentry,
      { workRecordService },
      { resolvePaperclipInstanceRoot },
      { default: pino },
    ] = await Promise.all([
      import("../middleware/auth.js"),
      import("../agent-auth-jwt.js"),
      import("../middleware/http-log-redaction.js"),
      import("../middleware/logger.js"),
      import("../routes/work-records.js"),
      import("../middleware/error-handler.js"),
      import("../telemetry.js"),
      import("../sentry.js"),
      import("../services/work-records.js"),
      import("../home-paths.js"),
      import("pino"),
    ]);
    createLocalAgentJwt = createJwt;
    records = workRecordService(db);
    telemetryStateDir = join(resolvePaperclipInstanceRoot(), "telemetry");
    telemetryClient = telemetry.initTelemetry({ enabled: true });
    shutdownSentry = sentry.shutdownSentry;
    await sentry.sentryReady;

    logDestination = pino.destination({ dest: processLogPath, sync: true });
    const app = express();
    app.locals.paperclipDb = db;
    app.use(express.json());
    app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, logDestination)));
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.use("/api", workRecordRoutes(db));
    app.use(errorHandler);
    appServer = createServer(app);
    const appPort = await listen(appServer);
    apiBase = `http://127.0.0.1:${appPort}`;
  }, 45_000);

  afterAll(async () => {
    telemetryClient?.stop();
    await shutdownSentry?.();
    await close(appServer);
    logDestination?.flushSync();
    logDestination?.end();
    await database?.cleanup();
    await close(sinkServer);
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!process.env.PAPERCLIP_M2C_KEEP_DYNAMIC_TMP) {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("proves A02 approval rejection and O02 append-only sanitized audit through live routes", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({
      name: `M2C dynamic ${suffix}`,
      issuePrefix: `D${suffix}`,
    }).returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({
      companyId: company.id,
      name: "M2C dynamic evidence",
    }).returning().then((rows) => rows[0]);
    const makeAgent = async (name: string, role: string) => db.insert(agents).values({
      companyId: company.id,
      name,
      role,
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]);
    const ceo = await makeAgent("CEO", "ceo");
    const po = await makeAgent("PO", "po");
    const qa = await makeAgent("QA", "qa");
    const developer = await makeAgent("Developer", "engineer");
    const replacement = await makeAgent("Replacement", "engineer");

    const makeRun = async (agentId: string) => db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "m2c_dynamic_evidence",
      status: "running",
      startedAt: new Date(),
    }).returning().then((rows) => rows[0]);
    const ceoRun = await makeRun(ceo.id);
    const poRun = await makeRun(po.id);
    const qaRun = await makeRun(qa.id);
    const tokens = {
      ceo: createLocalAgentJwt(ceo.id, company.id, ceo.adapterType, ceoRun.id),
      po: createLocalAgentJwt(po.id, company.id, po.adapterType, poRun.id),
      qa: createLocalAgentJwt(qa.id, company.id, qa.adapterType, qaRun.id),
    };
    expect(tokens.ceo).toBeTruthy();
    expect(tokens.po).toBeTruthy();
    expect(tokens.qa).toBeTruthy();

    const post = async (token: string, runId: string, path: string, body: JsonRecord) => {
      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-paperclip-run-id": runId,
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as JsonRecord;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { status: response.status, body: payload };
    };
    const createRecord = (title: string, assigneeAgentId: string | null) => records.create(company.id, {
      projectId: project.id,
      kind: "plan",
      title,
      assigneeAgentId,
      predecessorRecordIds: [],
    }, { actorType: "system", actorId: "m2c-dynamic-evidence" });
    const assignmentPath = (recordId: string) =>
      `/api/companies/${company.id}/projects/${project.id}/work-records/${recordId}/assignment`;
    const assignmentInput = (
      record: { id: string; revision: number; assigneeAgentId: string | null },
      requestKey: string,
      approvalId: string | null,
    ) => ({
      workflowVersion: 2,
      clientRequestId: requestKey,
      requestPayloadDigest: `digest:${requestKey}`,
      recordId: record.id,
      assigneeAgentId: replacement.id,
      expectedRecordRevision: record.revision,
      expectedAssigneeAgentId: record.assigneeAgentId,
      approvalId,
    });

    const gap = await createRecord("CEO fills NULL assignment", null);
    const positiveRunsBefore = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id));
    const positive = await post(tokens.ceo!, ceoRun.id, assignmentPath(gap.id), {
      ...assignmentInput(gap, "a02-ceo-null-to-agent", null),
      assigneeAgentId: developer.id,
    });
    expect(positive).toMatchObject({ status: 201, body: { replayed: false } });
    const positiveRecord = await db.select().from(workRecords).where(eq(workRecords.id, gap.id)).then((rows) => rows[0]);
    expect(positiveRecord).toMatchObject({ assigneeAgentId: developer.id, revision: gap.revision + 1 });
    const positiveCommands = await db.select().from(workRecordAssignmentCommands)
      .where(eq(workRecordAssignmentCommands.recordId, gap.id));
    expect(positiveCommands).toHaveLength(1);
    expect(await db.select().from(workRecordExecutionIntents).where(eq(workRecordExecutionIntents.recordId, gap.id))).toHaveLength(0);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.recordId, gap.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toHaveLength(positiveRunsBefore.length);

    const noApproval = await createRecord("Replacement without approval", developer.id);
    const wrongApproval = await createRecord("Replacement with wrong scope approval", developer.id);
    const staleRevisionBase = await createRecord("Replacement with old approval", developer.id);
    const wrongApprovalRow = await db.insert(approvals).values({
      companyId: company.id,
      type: "request_board_approval",
      status: "approved",
      requestedByAgentId: ceo.id,
      decidedByUserId: "jack",
      decidedAt: new Date(),
      payload: {
        action: "work_record.replace_assignee",
        companyId: company.id,
        projectId: randomUUID(),
        recordId: wrongApproval.id,
        recordRevision: wrongApproval.revision,
        fromAssigneeAgentId: developer.id,
        toAssigneeAgentId: replacement.id,
      },
    }).returning().then((rows) => rows[0]);
    const oldApproval = await db.insert(approvals).values({
      companyId: company.id,
      type: "request_board_approval",
      status: "approved",
      requestedByAgentId: ceo.id,
      decidedByUserId: "jack",
      decidedAt: new Date(),
      payload: {
        action: "work_record.replace_assignee",
        companyId: company.id,
        projectId: project.id,
        recordId: staleRevisionBase.id,
        recordRevision: staleRevisionBase.revision,
        fromAssigneeAgentId: developer.id,
        toAssigneeAgentId: replacement.id,
      },
    }).returning().then((rows) => rows[0]);
    const staleRevision = await records.update(company.id, project.id, staleRevisionBase.id, {
      expectedRevision: staleRevisionBase.revision,
      title: "Revision advanced after approval",
    });

    const zeroDispatchSnapshot = async (recordId: string) => ({
      assignmentCommandIds: await db.select({ id: workRecordAssignmentCommands.id }).from(workRecordAssignmentCommands)
        .where(eq(workRecordAssignmentCommands.recordId, recordId)).then((rows) => rows.map((row) => row.id)),
      intentIds: await db.select({ id: workRecordExecutionIntents.id }).from(workRecordExecutionIntents)
        .where(eq(workRecordExecutionIntents.recordId, recordId)).then((rows) => rows.map((row) => row.id)),
      outboxIds: await db.select({ id: workRecordOutbox.id }).from(workRecordOutbox)
        .where(eq(workRecordOutbox.recordId, recordId)).then((rows) => rows.map((row) => row.id)),
      wakeIds: await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, company.id)).then((rows) => rows.map((row) => row.id)),
      runIds: await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, company.id)).then((rows) => rows.map((row) => row.id)),
    });
    const rejectionCases = [
      {
        name: "no_approval",
        record: noApproval,
        input: assignmentInput(noApproval, "a02-no-approval", null),
        status: 400,
        error: "Validation error",
      },
      {
        name: "wrong_scope_payload_approval",
        record: wrongApproval,
        input: assignmentInput(wrongApproval, "a02-wrong-approval", wrongApprovalRow.id),
        status: 403,
        code: "work_record_assignment_approval_required",
      },
      {
        name: "old_approval_and_revision",
        record: staleRevision,
        input: {
          ...assignmentInput(staleRevision, "a02-stale-approval", oldApproval.id),
          expectedRecordRevision: staleRevisionBase.revision,
        },
        status: 409,
        code: "work_record_workflow_stale_revision",
      },
    ];
    const rejectedEvidence: JsonRecord[] = [];
    for (const scenario of rejectionCases) {
      const before = await zeroDispatchSnapshot(scenario.record.id);
      const response = await post(tokens.ceo!, ceoRun.id, assignmentPath(scenario.record.id), scenario.input);
      expect(response.status).toBe(scenario.status);
      if ("code" in scenario) expect(response.body.code).toBe(scenario.code);
      if ("error" in scenario) expect(response.body.error).toBe(scenario.error);
      const after = await zeroDispatchSnapshot(scenario.record.id);
      expect(after).toEqual(before);
      const persisted = await db.select().from(workRecords).where(eq(workRecords.id, scenario.record.id)).then((rows) => rows[0]);
      expect(persisted).toMatchObject({
        assigneeAgentId: developer.id,
        revision: scenario.record.revision,
      });
      rejectedEvidence.push({
        name: scenario.name,
        status: response.status,
        code: response.body.code ?? response.body.error,
        recordId: scenario.record.id,
        recordRevision: persisted.revision,
        unchanged: before,
      });
    }

    const createQualityFixture = async (title: string) => {
      const record = await createRecord(title, po.id);
      const cycle = await db.insert(workRecordQualityCycles).values({
        companyId: company.id,
        projectId: project.id,
        aggregateRecordId: record.id,
        cycleNumber: 1,
        kind: "package",
        state: "open",
        qualityPhase: "po_acceptance",
        scopeDigest: `scope:${record.id}`,
      }).returning().then((rows) => rows[0]);
      const item = await db.insert(workRecordQualityItems).values({
        companyId: company.id,
        projectId: project.id,
        cycleId: cycle.id,
        recordId: record.id,
        role: "po",
        required: true,
        state: "ready",
      }).returning().then((rows) => rows[0]);
      const intent = await db.insert(workRecordExecutionIntents).values({
        companyId: company.id,
        projectId: project.id,
        recordId: record.id,
        qualityItemId: item.id,
        intentKey: `dynamic-evidence:${item.id}`,
        requestPayloadDigest: `dynamic-evidence:${item.id}`,
        kind: "po_acceptance_release",
        generation: 1,
        expectedIssueStatusVersion: 0,
        state: "succeeded",
      }).returning().then((rows) => rows[0]);
      return { record, cycle, item, intent };
    };
    const successfulQuality = await createQualityFixture("O02 success and replay");
    const refusedQuality = await createQualityFixture("O02 role refusal");
    const canaries = [
      "credential-canary-sk-live-M2C-dynamic",
      "token-canary-bearer-M2C-dynamic",
      "evidence-body-canary-M2C-dynamic",
    ];
    const qualityPath = (recordId: string) =>
      `/api/companies/${company.id}/projects/${project.id}/work-records/${recordId}/quality/po-verdicts`;
    const qualityBody = {
      workflowVersion: 2,
      clientRequestId: "o02-success-replay",
      requestPayloadDigest: "o02-success-replay-digest",
      cycleId: successfulQuality.cycle.id,
      itemId: successfulQuality.item.id,
      expectedCycleRevision: successfulQuality.cycle.revision,
      outcome: "approve",
      targetRecordIds: [],
      reason: canaries[2],
      evidenceRefs: [canaries[0], canaries[1]],
    };

    const qualityAuditRows = () => db.select().from(activityLog).where(and(
      eq(activityLog.companyId, company.id),
      eq(activityLog.action, "work_record.quality_command"),
    )).orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const qualityRunEvents = () => db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, company.id),
      eq(heartbeatRunEvents.message, "work_record_quality_command"),
    )).orderBy(asc(heartbeatRunEvents.createdAt), asc(heartbeatRunEvents.id));
    const appendOnlySnapshots: Array<{ activityIds: string[]; runEventIds: string[] }> = [];
    const captureAppendOnlySnapshot = async (expectedCount: number) => {
      const activity = await qualityAuditRows();
      const runEvents = await qualityRunEvents();
      expect(activity).toHaveLength(expectedCount);
      expect(runEvents).toHaveLength(expectedCount);
      const snapshot = {
        activityIds: activity.map((row) => row.id),
        runEventIds: runEvents.map((row) => row.id),
      };
      if (appendOnlySnapshots.length > 0) {
        const previous = appendOnlySnapshots.at(-1)!;
        expect(snapshot.activityIds.slice(0, -1)).toEqual(previous.activityIds);
        expect(snapshot.runEventIds.slice(0, -1)).toEqual(previous.runEventIds);
      }
      appendOnlySnapshots.push(snapshot);
    };

    const success = await post(tokens.po!, poRun.id, qualityPath(successfulQuality.record.id), qualityBody);
    expect(success.status).toBe(201);
    await captureAppendOnlySnapshot(1);
    const replay = await post(tokens.po!, poRun.id, qualityPath(successfulQuality.record.id), qualityBody);
    expect(replay.status).toBe(200);
    await captureAppendOnlySnapshot(2);
    const refusal = await post(tokens.qa!, qaRun.id, qualityPath(refusedQuality.record.id), {
      ...qualityBody,
      clientRequestId: "o02-role-refusal",
      requestPayloadDigest: "o02-role-refusal-digest",
      cycleId: refusedQuality.cycle.id,
      itemId: refusedQuality.item.id,
      expectedCycleRevision: refusedQuality.cycle.revision,
    });
    expect(refusal).toMatchObject({ status: 403, body: { code: "work_record_workflow_role_denied" } });
    await captureAppendOnlySnapshot(3);
    const conflict = await post(tokens.po!, poRun.id, qualityPath(successfulQuality.record.id), {
      ...qualityBody,
      requestPayloadDigest: "o02-conflicting-digest",
    });
    expect(conflict).toMatchObject({ status: 409, body: { code: "work_record_workflow_idempotency_conflict" } });
    await captureAppendOnlySnapshot(4);

    const auditRows = await qualityAuditRows();
    const runEvents = await qualityRunEvents();
    expect(auditRows.map((row) => (row.details as JsonRecord).outcome)).toEqual([
      "succeeded",
      "replayed",
      "rejected",
      "conflict",
    ]);
    for (const row of auditRows) {
      const details = row.details as JsonRecord;
      expect(details).toMatchObject({
        companyId: company.id,
        projectId: project.id,
        actorType: "agent",
      });
      for (const field of [
        "recordId",
        "cycleId",
        "itemId",
        "intentIds",
        "actorId",
        "runId",
        "requestKey",
        "beforeRevision",
        "afterRevision",
        "outcome",
        "error",
      ]) expect(details).toHaveProperty(field);
    }
    for (const event of runEvents) {
      expect(event.id).toEqual(expect.any(Number));
      expect(event.payload).toMatchObject({ companyId: company.id, projectId: project.id });
    }

    const verdictCount = await db.select().from(workRecordQualityVerdicts)
      .where(eq(workRecordQualityVerdicts.companyId, company.id));
    expect(verdictCount).toHaveLength(1);

    await telemetryClient?.flush();
    await shutdownSentry?.();
    logDestination?.flushSync();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const persistedArtifacts = {
      activity: JSON.stringify(auditRows),
      runLog: JSON.stringify(runEvents),
      processLog: await readFile(processLogPath, "utf8"),
      telemetryState: (await readTree(telemetryStateDir)).map((file) => file.body).join("\n"),
      telemetrySink: (await readTree(telemetrySinkDir)).map((file) => file.body).join("\n"),
      sentrySink: (await readTree(sentrySinkDir)).map((file) => file.body).join("\n"),
    };
    for (const [sink, artifact] of Object.entries(persistedArtifacts)) {
      for (const canary of canaries) {
        expect(artifact, `${sink} leaked ${canary}`).not.toContain(canary);
      }
    }
    expect(await readTree(telemetrySinkDir)).toHaveLength(0);
    expect(await readTree(sentrySinkDir)).toHaveLength(0);

    const evidenceDir = process.env.PAPERCLIP_M2C_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, "dynamic-http-postgres-evidence.json"), `${JSON.stringify({
        schemaVersion: 1,
        testedCommit: process.env.PAPERCLIP_M2C_TESTED_COMMIT ?? null,
        generatedAt: new Date().toISOString(),
        transport: "TCP HTTP on 127.0.0.1 with signed run JWTs",
        database: "isolated embedded PostgreSQL",
        a02: {
          companyId: company.id,
          projectId: project.id,
          positive: {
            status: positive.status,
            recordId: gap.id,
            commandId: positiveCommands[0].id,
            beforeRevision: gap.revision,
            afterRevision: positiveRecord.revision,
            assignmentCommandCount: positiveCommands.length,
            executionIntentCount: 0,
            outboxCount: 0,
            wakeCount: 0,
            runDelta: 0,
          },
          rejected: rejectedEvidence,
        },
        o02: {
          responses: [
            { name: "success", status: success.status },
            { name: "replay", status: replay.status },
            { name: "refusal", status: refusal.status, code: refusal.body.code },
            { name: "conflict", status: conflict.status, code: conflict.body.code },
          ],
          appendOnlySnapshots,
          activity: auditRows.map((row) => ({
            id: row.id,
            requestKey: (row.details as JsonRecord).requestKey,
            recordId: (row.details as JsonRecord).recordId,
            cycleId: (row.details as JsonRecord).cycleId,
            itemId: (row.details as JsonRecord).itemId,
            intentIds: (row.details as JsonRecord).intentIds,
            actorId: (row.details as JsonRecord).actorId,
            runId: (row.details as JsonRecord).runId,
            beforeRevision: (row.details as JsonRecord).beforeRevision,
            afterRevision: (row.details as JsonRecord).afterRevision,
            outcome: (row.details as JsonRecord).outcome,
            error: (row.details as JsonRecord).error,
          })),
          runLog: runEvents.map((row) => ({
            id: row.id,
            runId: row.runId,
            requestKey: (row.payload as JsonRecord).requestKey,
            cycleId: (row.payload as JsonRecord).cycleId,
            itemId: (row.payload as JsonRecord).itemId,
            intentIds: (row.payload as JsonRecord).intentIds,
            beforeRevision: (row.payload as JsonRecord).beforeRevision,
            afterRevision: (row.payload as JsonRecord).afterRevision,
            outcome: (row.payload as JsonRecord).outcome,
            error: (row.payload as JsonRecord).error,
          })),
          verdictRows: verdictCount.length,
        },
        canaryScan: {
          canaryCount: canaries.length,
          persistedArtifacts: Object.keys(persistedArtifacts),
          leaks: 0,
          telemetryRequests: (await readTree(telemetrySinkDir)).length,
          sentryRequests: (await readTree(sentrySinkDir)).length,
          firstPartyTelemetryEvents: 0,
        },
      }, null, 2)}\n`, "utf8");
    }
  }, 60_000);
});
