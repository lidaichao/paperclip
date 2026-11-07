import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentApiKeys, agents, companies, createDb, getEmbeddedPostgresTestSupport,
  heartbeatRuns, issueComments, issues, localAgentDeviceBindings,
  localAgentRunLeases, localIssueCompletionCommands, projects,
  localPoVerdictCommands,
  startEmbeddedPostgresTestDatabase, workRecordIssueLinks,
  workRecordDispatchBatches, workRecordDispatchBatchItems,
  workRecordQualityCycles, workRecordQualityItems, workRecords,
} from "@paperclipai/db";
import { localWorkPackageContextService } from "./local-work-package-context.js";
import { localAgentRunLeaseService } from "./local-agent-run-leases.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("local PO package context (PostgreSQL)", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-local-po-context-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID();
    const poAgentId = randomUUID(), childAgentId = randomUUID();
    const parentIssueId = randomUUID(), childIssueId = randomUUID();
    const parentRecordId = randomUUID(), childRecordId = randomUUID();
    const runId = randomUUID(), childRunId = randomUUID();
    const keyId = randomUUID(), leaseId = randomUUID();
    const cycleId = randomUUID(), poItemId = randomUUID(), childItemId = randomUUID();
    const commentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "PO context",
      issuePrefix: `P${companyId.slice(0, 7)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Acceptance" });
    await db.insert(agents).values([
      { id: poAgentId, companyId, name: "PO", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
      { id: childAgentId, companyId, name: "Developer", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
    ]);
    await db.insert(agentApiKeys).values({ id: keyId, companyId,
      agentId: poAgentId, name: "PO local key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId,
      agentId: poAgentId, keyId, deviceId: "po-desktop-001" });
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId: poAgentId, status: "running",
        runtimeMode: "client_pull", contextSnapshot: { issueId: parentIssueId } },
      { id: childRunId, companyId, agentId: childAgentId,
        status: "succeeded", runtimeMode: "client_pull",
        contextSnapshot: { issueId: childIssueId } },
    ]);
    await db.insert(issues).values([
      { id: parentIssueId, companyId, projectId, title: "PO package",
        status: "in_progress", assigneeAgentId: poAgentId, executionRunId: runId },
      { id: childIssueId, companyId, projectId, title: "Implement package",
        status: "done", assigneeAgentId: childAgentId },
    ]);
    await db.insert(localAgentRunLeases).values({ runId, companyId,
      agentId: poAgentId, issueId: parentIssueId, deviceId: "po-desktop-001",
      deviceKeyId: keyId, leaseId, idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(workRecords).values([
      { id: parentRecordId, companyId, projectId, kind: "plan",
        title: "PO package", description: "Acceptance objective",
        assigneeAgentId: poAgentId, dispatchState: "dispatched" },
      { id: childRecordId, companyId, projectId, kind: "plan",
        parentRecordId, title: "Implementation", description: "Implement feature",
        assigneeAgentId: childAgentId, dispatchState: "dispatched" },
    ]);
    await db.insert(workRecordIssueLinks).values([
      { companyId, projectId, recordId: parentRecordId, issueId: parentIssueId,
        purpose: "primary", dispatchRound: 1 },
      { companyId, projectId, recordId: childRecordId, issueId: childIssueId,
        purpose: "primary", dispatchRound: 1 },
    ]);
    const [batch] = await db.insert(workRecordDispatchBatches).values({
      companyId, projectId, rootRecordId: parentRecordId,
      clientRequestId: randomUUID(), requestPayloadDigest: randomUUID(),
      scopeKind: "whole_package", scopeDigest: randomUUID(),
      rootRecordRevision: 1, dependencySetRevision: 1,
      state: "prepared",
    }).returning();
    await db.insert(workRecordDispatchBatchItems).values([
      { companyId, projectId, batchId: batch.id, recordId: parentRecordId,
        recordRevision: 1, inclusionReason: "root", materializationState: "linked" },
      { companyId, projectId, batchId: batch.id, recordId: childRecordId,
        recordRevision: 1, inclusionReason: "descendant", materializationState: "linked" },
    ]);
    await db.insert(workRecordQualityCycles).values({ id: cycleId,
      companyId, projectId, aggregateRecordId: parentRecordId,
      cycleNumber: 1, kind: "package_acceptance", state: "open",
      qualityPhase: "po_acceptance", scopeDigest: randomUUID() });
    await db.insert(workRecordQualityItems).values([
      { id: poItemId, companyId, projectId, cycleId, recordId: parentRecordId,
        role: "po", state: "ready" },
      { id: childItemId, companyId, projectId, cycleId, recordId: childRecordId,
        role: "repair", state: "accepted" },
    ]);
    await db.insert(issueComments).values({ id: commentId, companyId,
      issueId: childIssueId, body: "Feature delivered and reviewed" });
    await db.insert(localIssueCompletionCommands).values({ companyId,
      issueId: childIssueId, recordId: childRecordId,
      runId: childRunId, clientRequestId: randomUUID(), requestDigest: randomUUID(),
      preparedStatusVersion: 1, completedStatusVersion: 2,
      state: "completed", commentId });
    const owner = { companyId, agentId: poAgentId, keyId,
      deviceId: "po-desktop-001", leaseId, generation: 1, runId };
    const actor = { type: "agent" as const, source: "agent_key" as const,
      companyId, agentId: poAgentId, keyId };
    return { owner, actor, parentIssueId, childIssueId, parentRecordId,
      childRecordId, cycleId, poItemId };
  }

  it("shows the claimed parent, current cycle and child delivery evidence", async () => {
    const f = await fixture();
    const context = await localWorkPackageContextService(db).read(f.owner, f.actor);
    expect(context.issue.id).toBe(f.parentIssueId);
    expect(context.package.id).toBe(f.parentRecordId);
    expect(context.cycle).toMatchObject({ id: f.cycleId, poItemId: f.poItemId });
    expect(context.members).toEqual([expect.objectContaining({
      recordId: f.childRecordId, issueId: f.childIssueId,
      state: "accepted", completionSummary: "Feature delivered and reviewed",
    })]);
  });

  it("reads the rework cycle without reusing last round's delivery summary", async () => {
    const f = await fixture();
    await db.update(workRecordQualityCycles).set({ state: "superseded" })
      .where(eq(workRecordQualityCycles.id, f.cycleId));
    const [rework] = await db.insert(workRecordQualityCycles).values({
      companyId: f.owner.companyId, projectId: (await db.select().from(workRecords)
        .where(eq(workRecords.id, f.parentRecordId)))[0]!.projectId,
      aggregateRecordId: f.parentRecordId, cycleNumber: 2,
      kind: "package_rework", state: "open", qualityPhase: "po_acceptance",
      scopeDigest: randomUUID(),
    }).returning();
    await db.insert(workRecordQualityItems).values([
      { companyId: f.owner.companyId, projectId: rework.projectId,
        cycleId: rework.id, recordId: f.parentRecordId, role: "po", state: "ready" },
      { companyId: f.owner.companyId, projectId: rework.projectId,
        cycleId: rework.id, recordId: f.childRecordId, role: "repair", state: "accepted" },
    ]);
    const context = await localWorkPackageContextService(db).read(f.owner, f.actor);
    expect(context.cycle.id).toBe(rework.id);
    expect(context.members[0]?.completionSummary).toBeNull();
  });

  it("rejects a foreign key, a stale lease and a released PO item", async () => {
    const f = await fixture();
    const service = localWorkPackageContextService(db);
    await expect(service.read(f.owner, { ...f.actor, keyId: randomUUID() }))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.read({ ...f.owner, leaseId: randomUUID() }, f.actor))
      .rejects.toMatchObject({ status: 409 });
    await db.update(localAgentRunLeases).set({ releasedAt: new Date() })
      .where(eq(localAgentRunLeases.runId, f.owner.runId));
    await expect(service.read(f.owner, f.actor)).rejects.toMatchObject({ status: 409 });
  });

  it("prepares the PO decision without completing the parent, then commits on stopped finish", async () => {
    const f = await fixture();
    const lease = localAgentRunLeaseService(db, { workRecordWorkflowV2WritesEnabled: true });
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parentIssueId));
    const [cycle] = await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, f.cycleId));
    const command = { ...f.owner, issueId: f.parentIssueId,
      expectedStatusVersion: parent.statusVersion,
      clientRequestId: randomUUID(), cycleId: f.cycleId, itemId: f.poItemId,
      expectedCycleRevision: cycle.revision, outcome: "approve" as const,
      reason: "Child delivery matches the acceptance objective",
      evidenceRefs: [], targetRecordIds: [] };
    const prepared = await lease.prepareFencedPoVerdict(command, f.actor);
    expect(prepared.disposition).toBe("prepared");
    expect((await lease.prepareFencedPoVerdict(command, f.actor)).replayed).toBe(true);
    await expect(lease.prepareFencedPoVerdict({ ...command,
      reason: "Changed acceptance reason" }, f.actor)).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(issues).where(eq(issues.id, f.parentIssueId)))[0]?.status)
      .toBe("in_progress");
    expect((await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, f.cycleId)))[0]?.state).toBe("open");
    const finishId = randomUUID();
    await lease.finish({ ...f.owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: finishId });
    expect((await db.select().from(issues).where(eq(issues.id, f.parentIssueId)))[0]?.status)
      .toBe("done");
    expect((await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, f.cycleId)))[0]?.state).toBe("accepted");
    expect((await db.select().from(localPoVerdictCommands)
      .where(eq(localPoVerdictCommands.runId, f.owner.runId)))[0]?.state).toBe("committed");
    expect((await lease.finish({ ...f.owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: finishId })).status).toBe("succeeded");
  });

  it("rolls back a stale PO finish without releasing the local run", async () => {
    const f = await fixture();
    const lease = localAgentRunLeaseService(db, { workRecordWorkflowV2WritesEnabled: true });
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parentIssueId));
    const [cycle] = await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, f.cycleId));
    await lease.prepareFencedPoVerdict({ ...f.owner, issueId: f.parentIssueId,
      expectedStatusVersion: parent.statusVersion,
      clientRequestId: randomUUID(), cycleId: f.cycleId, itemId: f.poItemId,
      expectedCycleRevision: cycle.revision, outcome: "approve",
      reason: "Ready for acceptance", evidenceRefs: [], targetRecordIds: [] }, f.actor);
    await db.update(issues).set({ statusVersion: parent.statusVersion + 1 })
      .where(eq(issues.id, f.parentIssueId));
    await expect(lease.finish({ ...f.owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, f.owner.runId)))[0]?.releasedAt).toBeNull();
    expect((await db.select().from(localPoVerdictCommands)
      .where(eq(localPoVerdictCommands.runId, f.owner.runId)))[0]?.state).toBe("prepared");
  });

  it("returns the original child task and blocks the parent after the PO stops", async () => {
    const f = await fixture();
    const lease = localAgentRunLeaseService(db, { workRecordWorkflowV2WritesEnabled: true });
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parentIssueId));
    const [cycle] = await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, f.cycleId));
    await lease.prepareFencedPoVerdict({ ...f.owner, issueId: f.parentIssueId,
      expectedStatusVersion: parent.statusVersion,
      clientRequestId: randomUUID(), cycleId: f.cycleId, itemId: f.poItemId,
      expectedCycleRevision: cycle.revision, outcome: "return",
      reason: "Original child requires correction", evidenceRefs: [],
      targetRecordIds: [f.childRecordId] }, f.actor);
    await lease.finish({ ...f.owner, outcome: "succeeded", exitCode: 0,
      processStopped: true, clientRequestId: randomUUID() });
    expect((await db.select().from(issues).where(eq(issues.id, f.parentIssueId)))[0]?.status)
      .toBe("blocked");
    expect((await db.select().from(issues).where(eq(issues.id, f.childIssueId)))[0]?.status)
      .toBe("todo");
    const childLinks = await db.select().from(workRecordIssueLinks)
      .where(eq(workRecordIssueLinks.recordId, f.childRecordId));
    expect(childLinks).toHaveLength(1);
    expect(childLinks[0]?.issueId).toBe(f.childIssueId);
    const cycles = await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.aggregateRecordId, f.parentRecordId));
    expect(cycles.map((row) => row.state).sort()).toEqual(["open", "superseded"]);
  });

  it("rejects an unrelated rework target before the PO model stops", async () => {
    const f = await fixture();
    const lease = localAgentRunLeaseService(db, { workRecordWorkflowV2WritesEnabled: true });
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parentIssueId));
    const [cycle] = await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, f.cycleId));
    await expect(lease.prepareFencedPoVerdict({ ...f.owner,
      issueId: f.parentIssueId, expectedStatusVersion: parent.statusVersion,
      clientRequestId: randomUUID(), cycleId: f.cycleId, itemId: f.poItemId,
      expectedCycleRevision: cycle.revision, outcome: "return",
      reason: "Invalid target", evidenceRefs: [],
      targetRecordIds: [randomUUID()] }, f.actor)).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(localPoVerdictCommands)
      .where(eq(localPoVerdictCommands.runId, f.owner.runId))).toHaveLength(0);
  });

  it("aborts a prepared PO verdict when the model process fails", async () => {
    const f = await fixture();
    const lease = localAgentRunLeaseService(db, { workRecordWorkflowV2WritesEnabled: true });
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parentIssueId));
    const [cycle] = await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, f.cycleId));
    await lease.prepareFencedPoVerdict({ ...f.owner, issueId: f.parentIssueId,
      expectedStatusVersion: parent.statusVersion,
      clientRequestId: randomUUID(), cycleId: f.cycleId, itemId: f.poItemId,
      expectedCycleRevision: cycle.revision, outcome: "approve",
      reason: "Tentative approval", evidenceRefs: [], targetRecordIds: [] }, f.actor);
    await lease.finish({ ...f.owner, outcome: "failed", exitCode: 1,
      processStopped: true, clientRequestId: randomUUID() });
    expect((await db.select().from(localPoVerdictCommands)
      .where(eq(localPoVerdictCommands.runId, f.owner.runId)))[0]?.state).toBe("aborted");
    expect((await db.select().from(workRecordQualityCycles)
      .where(eq(workRecordQualityCycles.id, f.cycleId)))[0]?.state).toBe("open");
    expect((await db.select().from(issues).where(eq(issues.id, f.parentIssueId)))[0]?.status)
      .toBe("blocked");
  });
});
