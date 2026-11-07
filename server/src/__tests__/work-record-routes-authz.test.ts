import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { conflict, forbidden } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { workRecordRoutes } from "../routes/work-records.js";

const service = vi.hoisted(() => ({
  listVersions: vi.fn(),
  createVersion: vi.fn(),
  updateVersion: vi.fn(),
  archiveVersion: vi.fn(),
  restoreVersion: vi.fn(),
  deleteVersion: vi.fn(),
  listIterations: vi.fn(),
  createIteration: vi.fn(),
  updateIteration: vi.fn(),
  archiveIteration: vi.fn(),
  restoreIteration: vi.fn(),
  deleteIteration: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  fillAssignmentGap: vi.fn(),
  dispatch: vi.fn(),
  getDispatchRequest: vi.fn(),
  recoverRecord: vi.fn(),
}));
const logActivity = vi.hoisted(() => vi.fn());
const packageService = vi.hoisted(() => ({
  preview: vi.fn(),
  prepare: vi.fn(),
  assignmentEscalationTarget: vi.fn(),
  latestAssignmentEscalation: vi.fn(),
  escalateAssignmentGaps: vi.fn(),
  getBatch: vi.fn(),
  reconcile: vi.fn(),
}));
const heartbeat = vi.hoisted(() => ({ wakeup: vi.fn() }));
const qualityService = vi.hoisted(() => ({
  get: vi.fn(),
  auditSnapshot: vi.fn(),
  recordPoVerdict: vi.fn(),
  recordQaVerdict: vi.fn(),
  linkPackageDefect: vi.fn(),
}));
const access = vi.hoisted(() => ({ decide: vi.fn() }));
const appendHeartbeatRunEvent = vi.hoisted(() => vi.fn());
const processLogSink = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const telemetrySink = vi.hoisted(() => ({ capture: vi.fn() }));
const trackErrorHandlerCrash = vi.hoisted(() => vi.fn());
const captureException = vi.hoisted(() => vi.fn());
let auditEvidence: Record<string, unknown> | null = null;

vi.mock("../services/heartbeat-run-events.js", () => ({ appendHeartbeatRunEvent }));
vi.mock("../middleware/logger.js", () => ({ logger: processLogSink }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => telemetrySink }));
vi.mock("@paperclipai/shared/telemetry", () => ({ trackErrorHandlerCrash }));
vi.mock("../sentry.js", () => ({ captureException }));

vi.mock("../services/index.js", () => ({
  workRecordService: () => service,
  workPackageDispatchService: () => packageService,
  workRecordQualityService: () => qualityService,
  accessService: () => access,
  heartbeatService: () => heartbeat,
  logActivity,
}));

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", workRecordRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const viewer = {
  type: "board",
  userId: "viewer-1",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
  source: "session",
  isInstanceAdmin: false,
} as Express.Request["actor"];

describe("work-record route authorization", () => {
  afterAll(async () => {
    const evidenceDir = process.env.PAPERCLIP_M2C_EVIDENCE_DIR;
    if (!evidenceDir || !auditEvidence) return;
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      join(evidenceDir, "quality-audit-canary-evidence.json"),
      `${JSON.stringify({
        testedCommit: process.env.PAPERCLIP_M2C_TESTED_COMMIT ?? null,
        generatedAt: new Date().toISOString(),
        ...auditEvidence,
      }, null, 2)}\n`,
      "utf8",
    );
  });

  beforeEach(() => {
    for (const mock of Object.values(service)) mock.mockReset();
    logActivity.mockReset();
    for (const mock of Object.values(packageService)) mock.mockReset();
    for (const mock of Object.values(qualityService)) mock.mockReset();
    access.decide.mockReset();
    access.decide.mockResolvedValue({ allowed: true });
    service.list.mockResolvedValue([]);
    service.listVersions.mockResolvedValue([]);
    service.listIterations.mockResolvedValue([]);
    service.getDispatchRequest.mockResolvedValue({ state: "linked" });
    packageService.preview.mockResolvedValue({
      scopeDigest: "viewer-scope",
      records: [],
      eligibility: { canPrepare: false, blockers: [{ code: "missing_po", recordId: "22222222-2222-4222-8222-222222222222", title: "缺少 PO", requiredRole: "PO" }] },
    });
    packageService.assignmentEscalationTarget.mockResolvedValue("33333333-3333-4333-8333-333333333333");
    packageService.latestAssignmentEscalation.mockResolvedValue(null);
    packageService.escalateAssignmentGaps.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      clientRequestId: "admin-gap",
      scopeDigest: "viewer-scope",
      targetCeoAgentId: "33333333-3333-4333-8333-333333333333",
      state: "queued",
      deliveryAttempt: 1,
      wakeupRequestId: "55555555-5555-4555-8555-555555555555",
      wakeStatus: "queued",
      runId: null,
      runStatus: null,
      deliveryErrorCode: null,
      deliveredAt: null,
      acknowledgedAt: null,
      recordedAt: new Date(),
      updatedAt: new Date(),
      missingRecordIds: ["22222222-2222-4222-8222-222222222222"],
      replayed: false,
    });
    qualityService.get.mockResolvedValue({ cycle: null, items: [], verdicts: [], links: [] });
    qualityService.auditSnapshot.mockResolvedValue({
      recordRevision: 4,
      cycleRevision: 2,
      itemRevision: 1,
      intentIds: ["55555555-5555-4555-8555-555555555555"],
    });
    appendHeartbeatRunEvent.mockReset();
    for (const mock of Object.values(processLogSink)) mock.mockReset();
    telemetrySink.capture.mockReset();
    trackErrorHandlerCrash.mockReset();
    captureException.mockReset();
  });

  it("allows a viewer to read records and inspect the same dispatch request", async () => {
    const app = createApp(viewer);
    await request(app).get("/api/companies/company-1/projects/project-1/work-records").expect(200, []);
    await request(app).get("/api/companies/company-1/projects/project-1/work-records/record-1/dispatch-requests/request-1").expect(200, { state: "linked" });
    expect(service.list).toHaveBeenCalledWith("company-1", "project-1");
    expect(service.getDispatchRequest).toHaveBeenCalledWith("company-1", "project-1", "record-1", "request-1");
  });

  it("keeps viewer access read-only for reconcile/recovery", async () => {
    const app = createApp(viewer);
    await request(app).post("/api/companies/company-1/projects/project-1/work-records/record-1/reconcile").send({}).expect(403, { error: "只读成员只能查看，不能修改" });
    expect(service.recoverRecord).not.toHaveBeenCalled();
  });

  it("rejects cross-company reads before the service can disclose records", async () => {
    const app = createApp(viewer);
    await request(app).get("/api/companies/company-2/projects/project-2/work-records").expect(403, { error: "用户无权访问此公司" });
    expect(service.list).not.toHaveBeenCalled();
  });

  it("allows container history reads but rejects viewer and cross-company writes", async () => {
    const app = createApp(viewer);
    const projectId = "11111111-1111-4111-8111-111111111111";
    await request(app).get(`/api/companies/company-1/projects/${projectId}/versions`).expect(200, []);
    await request(app).get(`/api/companies/company-1/projects/${projectId}/iterations`).expect(200, []);
    await request(app).post(`/api/companies/company-1/projects/${projectId}/versions`).send({ name: "1.0" })
      .expect(403, { error: "只读成员只能查看，不能修改" });
    await request(app).post(`/api/companies/company-2/projects/${projectId}/iterations`).send({ name: "Iteration 1" })
      .expect(403, { error: "用户无权访问此公司" });
    expect(service.createVersion).not.toHaveBeenCalled();
    expect(service.createIteration).not.toHaveBeenCalled();
  });

  it("validates G1 planned dates and defect-only fields before creating a record", async () => {
    const admin = {
      ...viewer,
      userId: "admin-1",
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
      isInstanceAdmin: true,
    } as Express.Request["actor"];
    service.create.mockResolvedValueOnce({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "defect",
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      defectSeverity: "high",
      packageQaRole: null,
      qaRetestExemptionReason: null,
    });
    const app = createApp(admin);
    const valid = {
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "defect",
      title: "Checkout fails",
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      defectSeverity: "high",
      defectReproductionSteps: "Submit a valid cart.",
      defectExpectedResult: "Order is created.",
      defectActualResult: "The request returns 500.",
    };
    await request(app).post("/api/companies/company-1/work-records").send(valid).expect(201);
    expect(service.create).toHaveBeenCalledWith("company-1", expect.objectContaining(valid), expect.anything());

    await request(app).post("/api/companies/company-1/work-records").send({
      projectId: valid.projectId,
      kind: "plan",
      title: "Invalid plan",
      defectSeverity: "critical",
    }).expect(400);
    await request(app).post("/api/companies/company-1/work-records").send({
      ...valid,
      plannedStartDate: "2026-11-13",
      plannedCompletionDate: "2026-11-12",
    }).expect(400);
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it("keeps workflow-v2 prepare behind company write authorization", async () => {
    const app = createApp(viewer);
    await request(app)
      .post("/api/companies/company-1/projects/11111111-1111-4111-8111-111111111111/work-package-dispatch/prepare")
      .send({
        workflowVersion: 2,
        projectId: "11111111-1111-4111-8111-111111111111",
        rootRecordId: null,
        scopeKind: "selected_records",
        selectedRecordIds: ["22222222-2222-4222-8222-222222222222"],
        clientRequestId: "viewer-denied",
        requestPayloadDigest: "viewer-denied",
        expectedRootRevision: 1,
        expectedDependencySetRevision: 1,
        expectedScopeDigest: "viewer-denied",
      })
      .expect(403, { error: "只读成员只能查看，不能修改" });
    expect(packageService.preview).not.toHaveBeenCalled();
    expect(packageService.prepare).not.toHaveBeenCalled();
  });

  it("lets viewers preview facts and returns preflight capability denials before write attempts", async () => {
    const app = createApp(viewer);
    const projectId = "11111111-1111-4111-8111-111111111111";
    const previewBody = {
      workflowVersion: 2,
      projectId,
      rootRecordId: "22222222-2222-4222-8222-222222222222",
      scopeKind: "whole_package",
      selectedRecordIds: [],
    };
    const capabilities = await request(app)
      .get(`/api/companies/company-1/projects/${projectId}/work-record-capabilities`)
      .expect(200);
    expect(capabilities.body).toMatchObject({
      preparePackage: { allowed: false, requiredRole: expect.stringContaining("Operator") },
      recordPoVerdict: { allowed: false, requiredRole: expect.stringContaining("PO") },
      recordQaVerdict: { allowed: false, requiredRole: expect.stringContaining("QA") },
    });
    const previewResponse = await request(app)
      .post(`/api/companies/company-1/projects/${projectId}/work-package-dispatch/preview`)
      .send(previewBody)
      .expect(200);
    expect(previewResponse.body.eligibility.blockers).toHaveLength(1);
    await request(app)
      .post(`/api/companies/company-1/projects/${projectId}/work-package-dispatch/assignment-gap-escalations`)
      .send({ ...previewBody, clientRequestId: "viewer-gap", requestPayloadDigest: "viewer-gap", expectedScopeDigest: "viewer-scope" })
      .expect(403, { error: "只读成员只能查看，不能修改" });
    expect(logActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "work_record.assignment_gap_escalated" }));
  });

  it("records an authorized CEO ownership-gap escalation without changing assignments", async () => {
    const admin = {
      ...viewer,
      userId: "admin-1",
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
      isInstanceAdmin: true,
    } as Express.Request["actor"];
    const app = createApp(admin);
    const projectId = "11111111-1111-4111-8111-111111111111";
    const response = await request(app)
      .post(`/api/companies/company-1/projects/${projectId}/work-package-dispatch/assignment-gap-escalations`)
      .send({
        workflowVersion: 2,
        projectId,
        rootRecordId: "22222222-2222-4222-8222-222222222222",
        scopeKind: "whole_package",
        selectedRecordIds: [],
        clientRequestId: "admin-gap",
        requestPayloadDigest: "admin-gap",
        expectedScopeDigest: "viewer-scope",
      })
      .expect(201);
    expect(response.body).toMatchObject({ state: "queued", scopeDigest: "viewer-scope", missingRecordIds: ["22222222-2222-4222-8222-222222222222"] });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "work_record.assignment_gap_escalated",
      details: expect.objectContaining({ targetCeoAgentId: "33333333-3333-4333-8333-333333333333", wakeupRequestId: "55555555-5555-4555-8555-555555555555" }),
    }));
    expect(service.fillAssignmentGap).not.toHaveBeenCalled();
  });

  it("allows viewers to recover the latest persisted coordination state", async () => {
    packageService.latestAssignmentEscalation.mockResolvedValueOnce({ id: "escalation-1", state: "delivered" });
    const app = createApp(viewer);
    const projectId = "11111111-1111-4111-8111-111111111111";
    const rootRecordId = "22222222-2222-4222-8222-222222222222";

    const response = await request(app)
      .get(`/api/companies/company-1/projects/${projectId}/work-package-dispatch/assignment-gap-escalations/latest?rootRecordId=${rootRecordId}`)
      .expect(200);

    expect(response.body).toMatchObject({ id: "escalation-1", state: "delivered" });
    expect(packageService.latestAssignmentEscalation).toHaveBeenCalledWith("company-1", projectId, rootRecordId);
  });

  it("allows quality reads but keeps PO/QA verdicts and defect links read-only for viewers", async () => {
    const app = createApp(viewer);
    const projectId = "11111111-1111-4111-8111-111111111111";
    const recordId = "22222222-2222-4222-8222-222222222222";
    const cycleId = "33333333-3333-4333-8333-333333333333";
    const itemId = "44444444-4444-4444-8444-444444444444";
    await request(app)
      .get(`/api/companies/company-1/projects/${projectId}/work-records/${recordId}/quality`)
      .expect(200);
    await request(app)
      .post(`/api/companies/company-1/projects/${projectId}/work-records/${recordId}/quality/po-verdicts`)
      .send({
        workflowVersion: 2,
        clientRequestId: "viewer-po",
        requestPayloadDigest: "viewer-po",
        cycleId,
        itemId,
        expectedCycleRevision: 1,
        outcome: "approve",
        targetRecordIds: [],
        reason: "viewer must not write",
        evidenceRefs: [],
      })
      .expect(403, { error: "只读成员只能查看，不能修改" });
    expect(qualityService.get).toHaveBeenCalledWith("company-1", projectId, recordId);
    expect(qualityService.recordPoVerdict).not.toHaveBeenCalled();
  });

  it("rejects viewer assignment commands, writes denial audit, and creates no assignment", async () => {
    const app = createApp(viewer);
    const projectId = "11111111-1111-4111-8111-111111111111";
    const recordId = "22222222-2222-4222-8222-222222222222";
    await request(app)
      .post(`/api/companies/company-1/projects/${projectId}/work-records/${recordId}/assignment`)
      .send({
        workflowVersion: 2,
        clientRequestId: "viewer-assignment-denied",
        requestPayloadDigest: "viewer-assignment-denied-digest",
        recordId,
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        expectedRecordRevision: 1,
        expectedAssigneeAgentId: null,
      })
      .expect(403, { error: "只读成员只能查看，不能修改" });
    expect(service.fillAssignmentGap).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "work_record.assignment_command",
      details: expect.objectContaining({
        projectId,
        recordId,
        requestKey: "viewer-assignment-denied",
        outcome: "rejected",
        error: expect.objectContaining({ status: 403, code: "http_error" }),
      }),
    }));
  });

  it("audits quality success, refusal, and conflict with complete linkage but no canary leakage or telemetry", async () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const recordId = "33333333-3333-4333-8333-333333333333";
    const cycleId = "44444444-4444-4444-8444-444444444444";
    const itemId = "55555555-5555-4555-8555-555555555555";
    const agentId = "66666666-6666-4666-8666-666666666666";
    const runId = "77777777-7777-4777-8777-777777777777";
    const canaries = [
      "credential-canary-sk-live-M2O02",
      "token-canary-bearer-M2O02",
      "evidence-body-canary-M2O02",
    ];
    const actor = {
      type: "agent",
      agentId,
      companyId,
      runId,
      keyId: "88888888-8888-4888-8888-888888888888",
      source: "agent_jwt",
    } as Express.Request["actor"];
    const app = createApp(actor);
    const before = {
      recordRevision: 4,
      cycleRevision: 2,
      itemRevision: 1,
      intentIds: ["99999999-9999-4999-8999-999999999999"],
    };
    const after = {
      recordRevision: 4,
      cycleRevision: 3,
      itemRevision: 2,
      intentIds: ["99999999-9999-4999-8999-999999999999"],
    };
    qualityService.auditSnapshot.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    qualityService.recordPoVerdict.mockResolvedValue({
      replayed: false,
      verdict: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", outcome: "approve" },
      nextCycleId: null,
      quality: {},
    });
    await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/work-records/${recordId}/quality/po-verdicts`)
      .send({
        workflowVersion: 2,
        clientRequestId: "audit-success",
        requestPayloadDigest: "audit-success-digest",
        cycleId,
        itemId,
        expectedCycleRevision: 2,
        outcome: "approve",
        targetRecordIds: [],
        reason: canaries[2],
        evidenceRefs: [canaries[0], canaries[1]],
      })
      .expect(201);

    qualityService.auditSnapshot.mockResolvedValue(before);
    qualityService.recordQaVerdict.mockRejectedValueOnce(conflict("Quality cycle revision changed", {
      code: "work_record_workflow_stale_revision",
      currentRevision: 3,
    }));
    await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/work-records/${recordId}/quality/qa-verdicts`)
      .send({
        workflowVersion: 2,
        clientRequestId: "audit-conflict",
        requestPayloadDigest: "audit-conflict-digest",
        cycleId,
        itemId,
        expectedCycleRevision: 2,
        outcome: "pass",
        defectRecordId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        repairRecordId: null,
        reason: canaries[2],
        evidenceRefs: [canaries[0], canaries[1]],
      })
      .expect(409);

    qualityService.linkPackageDefect.mockRejectedValueOnce(forbidden("QA quality command is restricted", {
      code: "work_record_workflow_role_denied",
    }));
    await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/work-record-quality/defect-links`)
      .send({
        workflowVersion: 2,
        clientRequestId: "audit-rejected",
        requestPayloadDigest: "audit-rejected-digest",
        cycleId,
        expectedCycleRevision: 2,
        defectRecordId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        packageRecordId: recordId,
        repairRecordId: null,
        qaRecordId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        reason: canaries[2],
        evidenceRefs: [canaries[0], canaries[1]],
      })
      .expect(403);

    const auditRows = logActivity.mock.calls
      .map((call) => call[1])
      .filter((entry) => entry.action === "work_record.quality_command");
    expect(auditRows.map((entry) => entry.details?.outcome)).toEqual(["succeeded", "conflict", "rejected"]);
    for (const entry of auditRows) {
      expect(entry).toMatchObject({
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId,
        entityType: "work_record_quality_command",
        details: {
          companyId,
          projectId,
          recordId,
          batchId: null,
          cycleId,
          actorId: agentId,
          runId,
        },
      });
      expect(entry.details).toHaveProperty("itemId");
      expect(entry.details).toHaveProperty("intentIds");
      expect(entry.details).toHaveProperty("requestKey");
      expect(entry.details).toHaveProperty("beforeRevision");
      expect(entry.details).toHaveProperty("afterRevision");
      expect(entry.details).toHaveProperty("error");
    }

    const scannedSinks = JSON.stringify({
      activity: logActivity.mock.calls,
      runLog: appendHeartbeatRunEvent.mock.calls,
      processLog: Object.fromEntries(Object.entries(processLogSink).map(([key, mock]) => [key, mock.mock.calls])),
      telemetry: {
        capture: telemetrySink.capture.mock.calls,
        firstPartyEvents: trackErrorHandlerCrash.mock.calls,
        sentry: captureException.mock.calls,
      },
    });
    for (const canary of canaries) expect(scannedSinks).not.toContain(canary);
    expect(trackErrorHandlerCrash).not.toHaveBeenCalled();
    expect(telemetrySink.capture).not.toHaveBeenCalled();
    auditEvidence = {
      scenario: "O02",
      commandOutcomes: auditRows.map((entry) => ({
        command: entry.details?.command,
        requestKey: entry.details?.requestKey,
        outcome: entry.details?.outcome,
        companyId: entry.details?.companyId,
        projectId: entry.details?.projectId,
        recordId: entry.details?.recordId,
        cycleId: entry.details?.cycleId,
        itemId: entry.details?.itemId,
        intentIds: entry.details?.intentIds,
        actorId: entry.details?.actorId,
        runId: entry.details?.runId,
        beforeRevision: entry.details?.beforeRevision,
        afterRevision: entry.details?.afterRevision,
        error: entry.details?.error,
      })),
      canaryScan: {
        canaryCount: canaries.length,
        scannedSinks: ["activity", "run_log", "process_log", "telemetry", "sentry"],
        leaks: 0,
      },
      telemetry: {
        clientCaptures: telemetrySink.capture.mock.calls.length,
        firstPartyEvents: trackErrorHandlerCrash.mock.calls.length,
        sentryEvents: captureException.mock.calls.length,
      },
    };
  });
});
