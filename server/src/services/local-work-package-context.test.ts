import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentApiKeys, agents, companies, createDb, getEmbeddedPostgresTestSupport,
  heartbeatRuns, issueComments, issues, localAgentDeviceBindings,
  localAgentRunLeases, localIssueCompletionCommands, projects,
  startEmbeddedPostgresTestDatabase, workRecordIssueLinks,
  workRecordQualityCycles, workRecordQualityItems, workRecords,
} from "@paperclipai/db";
import { localWorkPackageContextService } from "./local-work-package-context.js";

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
});
