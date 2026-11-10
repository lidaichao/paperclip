import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentApiKeys, agentWakeupRequests, agents, companies, createDb, heartbeatRuns,
  issues, localAgentDeviceBindings, localAgentRunLeases, projects,
  workRecordDescriptionDeliveries, workRecords,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase }
  from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { localAgentRunLeaseService } from "./local-agent-run-leases.js";
import { workRecordService } from "./work-records.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

suite("work-record description delivery through client-pull adapter", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-description-client-pull-");
      db = createDb(temporary.connectionString);
    }
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  it("keeps one revision lineage until the device confirms the old process stopped", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const runId = randomUUID(), keyId = randomUUID(), projectId = randomUUID();
    const recordId = randomUUID(), intentKey = `work-record-description:${recordId}:2`;
    await db.insert(companies).values({ id: companyId, name: "Description client-pull",
      issuePrefix: `D${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Desktop agent",
      adapterType: "codex_local", runtimeConfig: { executionMode: "client_pull" } });
    await db.insert(agentApiKeys).values({ id: keyId, companyId, agentId,
      name: "Desktop test key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId, agentId, keyId,
      deviceId: "device-description-001" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Description project" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Owned task",
      status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "description-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
    await db.insert(workRecords).values({ id: recordId, recordNumber: 1, companyId, projectId, kind: "plan",
      title: "Description revision", descriptionRevision: 2, assigneeAgentId: agentId,
      dispatchState: "dispatched" });
    await db.insert(workRecordDescriptionDeliveries).values({ companyId, projectId, recordId,
      issueId, commentId: randomUUID(), descriptionRevision: 2, intentKey,
      payloadDigest: "client-pull-revision" });

    const local = localAgentRunLeaseService(db);
    const claimed = await local.claim({ companyId, agentId, keyId,
      deviceId: "device-description-001", idempotencyKey: randomUUID() });
    const owner = { companyId, agentId, runId, keyId, deviceId: "device-description-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const heartbeat = heartbeatService(db, { descriptionRevisionStopTimeoutMs: 20 });
    const records = workRecordService(db);

    const first = await records.deliverDescriptionRevision(companyId, projectId, recordId, 2,
      heartbeat.admitWorkRecordDescriptionRevision);
    expect(first).toMatchObject({ state: "retry", sourceRunId: runId, successorRunId: null });
    expect((await local.control(owner)).action).toBe("cancel");
    const [beforeStop] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, runId));
    expect(beforeStop).toMatchObject({ cancelRequestedAt: expect.any(Date),
      stopAcknowledgedAt: null, releasedAt: null });
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, intentKey),
    ))).toHaveLength(0);

    await local.finish({ ...owner, outcome: "cancelled", exitCode: null, processStopped: true });
    const replay = await records.deliverDescriptionRevision(companyId, projectId, recordId, 2,
      heartbeat.admitWorkRecordDescriptionRevision);
    expect(replay).toMatchObject({ state: "queued", sourceRunId: runId,
      successorRunId: expect.any(String), wakeupRequestId: expect.any(String),
      stopConfirmedAt: expect.any(Date), lastError: null });
    const successor = await local.claim({ companyId, agentId, keyId,
      deviceId: "device-description-001", idempotencyKey: randomUUID() });
    expect(successor?.runId).toBe(replay.successorRunId);
    const confirmed = await records.acknowledgeDescriptionRevision(companyId, projectId,
      recordId, 2, intentKey, { agentId, runId: successor!.runId });
    expect(confirmed).toMatchObject({ state: "confirmed", sourceRunId: runId,
      successorRunId: successor!.runId, modelVisibleAt: expect.any(Date),
      confirmedAt: expect.any(Date) });
  });
});
