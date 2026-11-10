import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentApiKeys,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issueComments,
  issues,
  localAgentDeviceBindings,
  localAgentRunLeases,
  localDefectQaVerdictCommands,
  localDefectRepairHandoffs,
  projects,
  startEmbeddedPostgresTestDatabase,
  workRecordIssueLinks,
  workRecordQualityCycles,
  workRecordQualityItems,
  workRecordQualityVerdicts,
  workRecords,
} from "@paperclipai/db";
import { AliceClient } from "../../../scripts/windows-agent-bridge/paperclip-client.js";
import { localAgentRunWriteGate } from "../middleware/local-agent-run-write-gate.js";
import { localAgentRunRoutes } from "../routes/local-agent-runs.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { WORK_RECORD_WORKFLOW_V2_COHORTS_ENV } from "../services/work-record-workflow-v2-rollout.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

type HttpReceipt = { method: string; path: string; status: number; body: unknown };

suite("local independent-defect bridge HTTP chain (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const evidence: Record<string, unknown>[] = [];

  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-defect-bridge-http-");
      db = createDb(temporary.connectionString);
    }
  }, 90_000);

  afterAll(async () => {
    const evidenceDir = process.env.PAPERCLIP_PAP17_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "defect-bridge-http.json"), `${JSON.stringify({
        schemaVersion: 1,
        testedCommit: process.env.PAPERCLIP_PAP17_TESTED_COMMIT ?? null,
        cases: evidence,
      }, null, 2)}\n`, "utf8");
    }
    await db?.$client.end();
    await temporary?.cleanup();
  });

  it("uses the Windows bridge client from repair handoff through stopped QA finish and record writeback", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const repairAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const repairKeyId = randomUUID();
    const qaKeyId = randomUUID();
    const repairDeviceId = randomUUID();
    const qaDeviceId = randomUUID();
    const issueId = randomUUID();
    const repairRunId = randomUUID();
    const defectRecordId = randomUUID();
    const repairToken = "repair-test-token";
    const qaToken = "qa-test-token";
    const previousEnabled = process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
    const previousCohorts = process.env[WORK_RECORD_WORKFLOW_V2_COHORTS_ENV];

    await db.insert(companies).values({
      id: companyId,
      name: "PAP-17 defect bridge HTTP",
      issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "G2 HTTP cohort" });
    await db.insert(agents).values([
      { id: repairAgentId, companyId, name: "Repair bridge", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
      { id: qaAgentId, companyId, name: "QA bridge", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
    ]);
    await db.insert(agentApiKeys).values([
      { id: repairKeyId, companyId, agentId: repairAgentId, name: "Repair key", keyHash: randomUUID() },
      { id: qaKeyId, companyId, agentId: qaAgentId, name: "QA key", keyHash: randomUUID() },
    ]);
    await db.insert(localAgentDeviceBindings).values([
      { companyId, agentId: repairAgentId, keyId: repairKeyId, deviceId: repairDeviceId },
      { companyId, agentId: qaAgentId, keyId: qaKeyId, deviceId: qaDeviceId },
    ]);
    const executionPolicy = normalizeIssueExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      maxReviewRounds: 3,
      stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: qaAgentId }] }],
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Independent defect HTTP chain",
      status: "todo",
      assigneeAgentId: repairAgentId,
      executionPolicy,
    });
    await db.insert(heartbeatRuns).values({
      id: repairRunId,
      companyId,
      agentId: repairAgentId,
      status: "queued",
      runtimeMode: "client_pull",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(workRecords).values({
      id: defectRecordId,
      recordNumber: 1,
      companyId,
      projectId,
      kind: "defect",
      title: "Bridge defect",
      assigneeAgentId: repairAgentId,
      qaAssigneeAgentId: qaAgentId,
      dispatchState: "dispatched",
      dispatchRound: 1,
      businessStatus: "in_progress",
    });
    const [link] = await db.insert(workRecordIssueLinks).values({
      companyId,
      projectId,
      recordId: defectRecordId,
      issueId,
      purpose: "primary",
      dispatchRound: 1,
    }).returning();
    const [cycle] = await db.insert(workRecordQualityCycles).values({
      companyId,
      projectId,
      aggregateRecordId: defectRecordId,
      cycleNumber: 1,
      kind: "independent_defect",
      state: "open",
      qualityPhase: "waiting_fix",
      scopeDigest: randomUUID(),
    }).returning();
    await db.insert(workRecordQualityItems).values([
      { companyId, projectId, cycleId: cycle.id, recordId: defectRecordId,
        defectRecordId, role: "repair", state: "ready", issueLinkId: link.id },
      { companyId, projectId, cycleId: cycle.id, recordId: defectRecordId,
        defectRecordId, role: "qa", state: "blocked", issueLinkId: link.id },
    ]);

    // The rollout resolver is captured by the route-owned service. Inject the
    // exact isolated company/project cohort before constructing that router.
    process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = "true";
    process.env[WORK_RECORD_WORKFLOW_V2_COHORTS_ENV] = JSON.stringify([
      { companyId, projectIds: [projectId] },
    ]);

    const identities = new Map([
      [repairToken, { id: repairAgentId, companyId, name: "Repair bridge", keyId: repairKeyId }],
      [qaToken, { id: qaAgentId, companyId, name: "QA bridge", keyId: qaKeyId }],
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const identity = identities.get(token);
      if (!identity) return res.status(401).json({ error: "Unauthenticated" });
      req.actor = { type: "agent", source: "agent_key", agentId: identity.id,
        companyId: identity.companyId, keyId: identity.keyId };
      next();
    });
    app.get("/api/agents/me", (req, res) => {
      const identity = identities.get(req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "")!;
      res.json({ id: identity.id, companyId: identity.companyId, name: identity.name });
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((error: { status?: number; message?: string; details?: unknown }, _req: Request,
      res: Response, _next: NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message ?? "Internal error",
        ...(error.details ? { details: error.details } : {}) });
    });

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const port = (server.address() as AddressInfo).port;
    const apiBase = `http://127.0.0.1:${port}`;
    const httpReceipts: HttpReceipt[] = [];
    const captureFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      const body = response.status === 204 ? null : await response.clone().json().catch(() => null);
      httpReceipts.push({
        method: init?.method ?? "GET",
        path: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname,
        status: response.status,
        body,
      });
      return response;
    };

    try {
      const repairClient = new AliceClient({ apiBase, token: repairToken, fetch: captureFetch });
      await repairClient.verifyIdentity(repairAgentId, companyId, "Repair bridge");
      const repairClaim = await repairClient.claimLocalRun(repairDeviceId, randomUUID());
      expect(repairClaim).not.toBeNull();
      const [repairIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const repairLease = { deviceId: repairDeviceId, runId: repairClaim!.runId,
        leaseId: repairClaim!.leaseId, generation: repairClaim!.generation };
      const handoff = await repairClient.prepareLocalDefectRepairHandoff(repairLease, {
        issueId,
        expectedStatusVersion: repairIssue.statusVersion,
        summary: "Repair completed and ready for independent QA",
        clientRequestId: randomUUID(),
      });
      expect(await repairClient.finishLocalRun(repairLease, "succeeded", 0, {
        clientRequestId: randomUUID(), summary: "Repair process stopped after QA handoff",
      })).toBe("succeeded");

      const qaClient = new AliceClient({ apiBase, token: qaToken, fetch: captureFetch });
      await qaClient.verifyIdentity(qaAgentId, companyId, "QA bridge");
      const qaClaim = await qaClient.claimLocalRun(qaDeviceId, randomUUID());
      expect(qaClaim?.wakeReason).toBe("independent_defect_qa");
      const qaContext = await qaClient.readLocalDefectQaContext(qaClaim!, qaDeviceId) as {
        issueId: string; cycleId: string; itemId: string; handoffId: string;
        expectedStatusVersion: number; expectedCycleRevision: number; expectedItemRevision: number;
      };
      expect(qaContext.handoffId).toBe(handoff.receiptId);
      const qaLease = { deviceId: qaDeviceId, runId: qaClaim!.runId,
        leaseId: qaClaim!.leaseId, generation: qaClaim!.generation };
      const qaCommand = await qaClient.prepareLocalDefectQaVerdict(qaLease, {
        issueId,
        expectedStatusVersion: qaContext.expectedStatusVersion,
        cycleId: qaContext.cycleId,
        itemId: qaContext.itemId,
        expectedCycleRevision: qaContext.expectedCycleRevision,
        expectedItemRevision: qaContext.expectedItemRevision,
        outcome: "pass",
        summary: "Independent QA reproduced the fix and found no regression",
        evidenceRefs: ["pap17://defect-bridge-http/pass"],
        clientRequestId: randomUUID(),
      });
      expect(await qaClient.finishLocalRun(qaLease, "succeeded", 0, {
        clientRequestId: randomUUID(), summary: "QA process stopped after verdict preparation",
      })).toBe("succeeded");

      const [finalIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [finalRecord] = await db.select().from(workRecords).where(eq(workRecords.id, defectRecordId));
      const [finalCycle] = await db.select().from(workRecordQualityCycles)
        .where(eq(workRecordQualityCycles.id, cycle.id));
      const [repairHandoff] = await db.select().from(localDefectRepairHandoffs)
        .where(eq(localDefectRepairHandoffs.id, handoff.receiptId));
      const [verdictCommand] = await db.select().from(localDefectQaVerdictCommands)
        .where(eq(localDefectQaVerdictCommands.id, qaCommand.receiptId));
      const [verdict] = await db.select().from(workRecordQualityVerdicts)
        .where(eq(workRecordQualityVerdicts.id, verdictCommand.verdictId!));
      const leases = await db.select().from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.companyId, companyId),
        eq(localAgentRunLeases.issueId, issueId),
      ));
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      const wakes = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      expect(finalIssue.status).toBe("done");
      expect(finalRecord.businessStatus).toBe("done");
      expect(finalCycle).toMatchObject({ state: "accepted", qualityPhase: "accepted" });
      expect(repairHandoff).toMatchObject({ state: "submitted", qaAgentId });
      expect(verdictCommand).toMatchObject({ state: "committed", qaAgentId });
      expect(verdict).toMatchObject({ outcome: "pass", itemId: qaContext.itemId });
      expect(leases).toHaveLength(2);
      expect(leases.every((lease) => lease.releasedAt && lease.stopAcknowledgedAt)).toBe(true);
      expect(httpReceipts.filter((receipt) => receipt.status >= 400)).toEqual([]);

      evidence.push({
        case: "PAP-17-independent-defect-real-http",
        cohort: { companyId, projectId },
        ids: {
          defectRecordId,
          issueId,
          repairRunId,
          qaRunId: qaClaim!.runId,
          leaseIds: leases.map((lease) => lease.leaseId),
          commentIds: comments.map((comment) => comment.id),
          cycleId: cycle.id,
          qaItemId: qaContext.itemId,
          handoffId: repairHandoff.id,
          qaWakeupRequestId: repairHandoff.qaWakeupRequestId,
          qaCommandId: verdictCommand.id,
          verdictId: verdict.id,
          wakeupRequestIds: wakes.map((wake) => wake.id),
        },
        final: { issueStatus: finalIssue.status, recordBusinessStatus: finalRecord.businessStatus,
          cycleState: finalCycle.state, cycleQualityPhase: finalCycle.qualityPhase },
        httpReceipts,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previousEnabled === undefined) delete process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
      else process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = previousEnabled;
      if (previousCohorts === undefined) delete process.env[WORK_RECORD_WORKFLOW_V2_COHORTS_ENV];
      else process.env[WORK_RECORD_WORKFLOW_V2_COHORTS_ENV] = previousCohorts;
    }
  }, 60_000);
});
