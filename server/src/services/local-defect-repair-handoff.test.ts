import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentApiKeys, agentWakeupRequests, agents, companies, createDb,
  getEmbeddedPostgresTestSupport, heartbeatRuns, issueThreadInteractions, issues,
  localAgentDeviceBindings, localAgentRunLeases, localDefectRepairHandoffs,
  projects, startEmbeddedPostgresTestDatabase, workRecordExecutionIntents,
  workRecordIssueLinks, workRecordQualityCycles, workRecordQualityItems, workRecords,
} from "@paperclipai/db";
import { localAgentRunLeaseService } from "./local-agent-run-leases.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

suite("independent defect repair local handoff (PostgreSQL)", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-local-defect-handoff-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID();
    const repairAgentId = randomUUID(), qaAgentId = randomUUID();
    const issueId = randomUUID(), recordId = randomUUID(), runId = randomUUID();
    const cycleId = randomUUID(), repairItemId = randomUUID(), qaItemId = randomUUID();
    const keyId = randomUUID(), leaseId = randomUUID();
    const deviceId = "defect-repair-device-001";
    const policy = { mode: "normal", commentRequired: true, maxReviewRounds: 3,
      stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: qaAgentId }] }],
    };
    await db.insert(companies).values({ id: companyId, name: "Defect handoff",
      issuePrefix: `D${companyId.slice(0, 7)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "QA handoff" });
    await db.insert(agents).values([
      { id: repairAgentId, companyId, name: "Repairer", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
      { id: qaAgentId, companyId, name: "QA", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
    ]);
    await db.insert(agentApiKeys).values({ id: keyId, companyId,
      agentId: repairAgentId, name: "Repairer key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId,
      agentId: repairAgentId, keyId, deviceId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId,
      agentId: repairAgentId, status: "running", runtimeMode: "client_pull",
      contextSnapshot: { issueId } });
    await db.insert(issues).values({ id: issueId, companyId, projectId,
      title: "Original independent defect", status: "in_progress",
      assigneeAgentId: repairAgentId, executionRunId: runId,
      executionPolicy: policy });
    await db.insert(localAgentRunLeases).values({ runId, companyId,
      agentId: repairAgentId, issueId, deviceId, deviceKeyId: keyId,
      leaseId, idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(workRecords).values({ id: recordId, companyId, projectId,
      kind: "defect", title: "Original defect", assigneeAgentId: repairAgentId,
      qaAssigneeAgentId: qaAgentId, dispatchState: "dispatched" });
    const [link] = await db.insert(workRecordIssueLinks).values({
      companyId, projectId, recordId, issueId, purpose: "primary", dispatchRound: 1,
    }).returning();
    await db.insert(workRecordQualityCycles).values({ id: cycleId,
      companyId, projectId, aggregateRecordId: recordId, cycleNumber: 1,
      kind: "independent_defect", state: "open", qualityPhase: "waiting_fix",
      scopeDigest: randomUUID() });
    await db.insert(workRecordQualityItems).values([
      { id: repairItemId, companyId, projectId, cycleId, recordId,
        defectRecordId: recordId, issueLinkId: link.id,
        role: "repair", state: "ready" },
      { id: qaItemId, companyId, projectId, cycleId, recordId,
        defectRecordId: recordId, issueLinkId: link.id,
        role: "qa", state: "blocked" },
    ]);
    const owner = { companyId, agentId: repairAgentId, keyId,
      deviceId, leaseId, generation: 1, runId };
    const actor = { type: "agent" as const, source: "agent_key" as const,
      companyId, agentId: repairAgentId, keyId };
    return { companyId, projectId, repairAgentId, qaAgentId, issueId,
      recordId, runId, cycleId, repairItemId, qaItemId, owner, actor,
      service: localAgentRunLeaseService(db) };
  }

  async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const command = { ...f.owner, issueId: f.issueId,
      summary: "Repair implemented and ready for independent QA",
      expectedStatusVersion: issue.statusVersion, clientRequestId: randomUUID() };
    return { command, receipt: await f.service.prepareFencedDefectRepairHandoff(command, f.actor) };
  }

  it("prepares without QA wake and transfers the native stage only after stopped finish", async () => {
    const f = await fixture();
    const { command, receipt } = await prepare(f);
    expect(receipt.disposition).toBe("prepared");
    expect((await f.service.prepareFencedDefectRepairHandoff(command, f.actor)).replayed).toBe(true);
    await expect(f.service.prepareFencedDefectRepairHandoff({ ...command,
      summary: "Changed summary" }, f.actor)).rejects.toMatchObject({ status: 409 });
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(before).toMatchObject({ status: "in_progress", assigneeAgentId: f.repairAgentId,
      executionRunId: f.runId });
    expect((await db.select().from(workRecordQualityItems)
      .where(eq(workRecordQualityItems.id, f.qaItemId)))[0]?.state).toBe("blocked");
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);

    const finishRequest = { ...f.owner, outcome: "succeeded" as const,
      exitCode: 0, processStopped: true as const, clientRequestId: randomUUID() };
    const finished = await f.service.finish(finishRequest);
    expect(finished.status).toBe("succeeded");
    expect(await f.service.finish(finishRequest)).toEqual(finished);
    await expect(f.service.finish({ ...finishRequest, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ id: f.issueId, status: "in_review",
      assigneeAgentId: f.qaAgentId, executionRunId: null,
      executionState: { status: "pending",
        currentParticipant: { type: "agent", agentId: f.qaAgentId } } });
    expect((await db.select().from(workRecordQualityItems)
      .where(eq(workRecordQualityItems.id, f.repairItemId)))[0]?.state).toBe("accepted");
    expect((await db.select().from(workRecordQualityItems)
      .where(eq(workRecordQualityItems.id, f.qaItemId)))[0]?.state).toBe("active");
    expect((await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, f.cycleId)))[0]?.qualityPhase).toBe("qa_retest");
    expect((await db.select().from(localDefectRepairHandoffs)
      .where(eq(localDefectRepairHandoffs.runId, f.runId)))[0])
      .toMatchObject({ state: "submitted", submittedStatusVersion: issue.statusVersion });
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(workRecordExecutionIntents)
      .where(eq(workRecordExecutionIntents.recordId, f.recordId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  }, 30_000);

  it("rolls back stop when the native policy no longer selects the assigned QA", async () => {
    const f = await fixture();
    await prepare(f);
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const changedPolicy = { mode: "normal", commentRequired: true,
      stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: f.repairAgentId }] }],
    };
    await db.update(issues).set({ executionPolicy: changedPolicy })
      .where(eq(issues.id, f.issueId));
    await expect(f.service.finish({ ...f.owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [after] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(after).toMatchObject({ status: before.status,
      statusVersion: before.statusVersion, assigneeAgentId: before.assigneeAgentId,
      executionRunId: before.executionRunId });
    expect((await db.select().from(localDefectRepairHandoffs)
      .where(eq(localDefectRepairHandoffs.runId, f.runId)))[0]?.state).toBe("prepared");
    expect((await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, f.runId)))[0]?.releasedAt).toBeNull();
    expect((await db.select().from(workRecordQualityItems)
      .where(eq(workRecordQualityItems.id, f.qaItemId)))[0]?.state).toBe("blocked");
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it("rolls back the native transfer if the later quality update fails", async () => {
    const f = await fixture();
    await prepare(f);
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await db.execute(sql`ALTER TABLE work_record_quality_items
      ADD CONSTRAINT local_defect_handoff_rollback_check
      CHECK (state <> 'active') NOT VALID`);
    try {
      await expect(f.service.finish({ ...f.owner, outcome: "succeeded", exitCode: 0,
        processStopped: true, clientRequestId: randomUUID() })).rejects.toThrow();
      const [after] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(after).toMatchObject({ status: before.status,
        statusVersion: before.statusVersion,
        assigneeAgentId: before.assigneeAgentId,
        executionState: before.executionState, executionRunId: before.executionRunId });
      expect((await db.select().from(localDefectRepairHandoffs)
        .where(eq(localDefectRepairHandoffs.runId, f.runId)))[0]?.state).toBe("prepared");
      expect((await db.select().from(localAgentRunLeases)
        .where(eq(localAgentRunLeases.runId, f.runId)))[0]?.releasedAt).toBeNull();
      expect((await db.select().from(workRecordQualityCycles)
        .where(eq(workRecordQualityCycles.id, f.cycleId)))[0]?.qualityPhase).toBe("waiting_fix");
      expect((await db.select().from(workRecordQualityItems)
        .where(eq(workRecordQualityItems.id, f.qaItemId)))[0]?.state).toBe("blocked");
      expect(await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    } finally {
      await db.execute(sql`ALTER TABLE work_record_quality_items
        DROP CONSTRAINT local_defect_handoff_rollback_check`);
    }
  }, 30_000);

  it("aborts a prepared handoff on failed stop and never releases QA", async () => {
    const f = await fixture();
    await prepare(f);
    await f.service.finish({ ...f.owner, outcome: "failed", exitCode: 1,
      processStopped: true, clientRequestId: randomUUID() });
    expect((await db.select().from(localDefectRepairHandoffs)
      .where(eq(localDefectRepairHandoffs.runId, f.runId)))[0]?.state).toBe("aborted");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]?.status)
      .toBe("blocked");
    expect((await db.select().from(workRecordQualityItems)
      .where(eq(workRecordQualityItems.id, f.qaItemId)))[0]?.state).toBe("blocked");
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it("refuses an old completion-review card before preparation", async () => {
    const f = await fixture();
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId,
      issueId: f.issueId, sourceRunId: f.runId,
      kind: "request_confirmation", status: "pending",
      createdByAgentId: f.repairAgentId, addresseeAgentId: f.qaAgentId,
      payload: { version: 1, prompt: "Old review", target: {
        type: "custom", key: "issue_completion_review", revisionId: randomUUID(),
      } },
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await expect(f.service.prepareFencedDefectRepairHandoff({ ...f.owner,
      issueId: f.issueId, summary: "Repair ready",
      expectedStatusVersion: issue.statusVersion,
      clientRequestId: randomUUID() }, f.actor))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(localDefectRepairHandoffs)
      .where(eq(localDefectRepairHandoffs.runId, f.runId))).toHaveLength(0);
  }, 30_000);
});
