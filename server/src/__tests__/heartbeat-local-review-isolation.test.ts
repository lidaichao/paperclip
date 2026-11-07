import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues,
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

suite("local completion review heartbeat isolation (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-local-review-isolation-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture(input: {
    runtimeMode: string;
    wakeReason: string;
    contextReason: string;
    wakeStatus?: string;
    clientPullConfig?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeId = randomUUID();
    const reviewId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Local review isolation",
      issuePrefix: `R${companyId.slice(0, 7)}`, defaultResponsibleUserId: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Local reviewer",
      adapterType: "process", status: "idle", runtimeConfig: input.clientPullConfig
        ? { executionMode: "client_pull" } : {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review target",
      status: "in_review", responsibleUserId: "owner" });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId,
      source: "automation", triggerDetail: "system", reason: input.wakeReason,
      status: input.wakeStatus ?? "queued",
      idempotencyKey: input.wakeReason === "issue_completion_review"
        ? `interaction:${interactionId}:completion-review:${reviewId}` : `ordinary:${randomUUID()}`,
      payload: { issueId, reviewId, interactionId } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      status: "queued", runtimeMode: input.runtimeMode,
      invocationSource: "automation", responsibleUserId: "owner",
      wakeupRequestId: wakeId, contextSnapshot: { issueId,
        wakeReason: input.contextReason, reviewId, interactionId } });
    await db.update(agentWakeupRequests).set({ runId })
      .where(eq(agentWakeupRequests.id, wakeId));
    return { companyId, agentId, issueId, runId, wakeId };
  }

  it("leaves a persisted client-pull reviewer run queued after an agent mode switch", async () => {
    const scope = await fixture({ runtimeMode: "client_pull",
      wakeReason: "issue_completion_review", contextReason: "issue_completion_review",
      clientPullConfig: true });
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, scope.agentId));
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.serverRunClaimAdmission(db,
      (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId)))[0]!))
      .toBe(false);
    expect((await heartbeat.dispatchPendingNativeStatusWakeups()).scanned).toBe(0);
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(scope.runId))?.status).toBe("queued");
    expect((await db.select().from(issues).where(eq(issues.id, scope.issueId)))[0]?.executionRunId)
      .toBeNull();
    expect((await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, scope.wakeId)))[0]?.status).toBe("queued");
    expect(execute).not.toHaveBeenCalled();
  }, 30_000);

  it("does not reinterpret a dedicated wake receipt as a legacy server run", async () => {
    const scope = await fixture({ runtimeMode: "legacy", wakeReason: "issue_completion_review",
      contextReason: "issue_assigned", wakeStatus: "cancelled" });
    const heartbeat = heartbeatService(db);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(await heartbeat.serverRunClaimAdmission(db, run)).toBe(false);
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(scope.runId))?.status).toBe("queued");
    expect((await db.select().from(issues).where(eq(issues.id, scope.issueId)))[0]?.executionRunId)
      .toBeNull();
    expect(execute).not.toHaveBeenCalled();
  }, 30_000);

  it("does not server-start a legacy queued run while its agent is configured client-pull", async () => {
    const scope = await fixture({ runtimeMode: "legacy", wakeReason: "issue_assigned",
      contextReason: "issue_assigned", clientPullConfig: true });
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(scope.runId))?.status).toBe("queued");
    expect(execute).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects an issue-less manual wake for a client-pull agent without queuing a run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Local wake scope",
      issuePrefix: `W${companyId.slice(0, 7)}`, defaultResponsibleUserId: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Local worker",
      adapterType: "process", status: "idle",
      runtimeConfig: { executionMode: "client_pull" } });

    const heartbeat = heartbeatService(db);
    await expect(heartbeat.wakeup(agentId, { source: "on_demand",
      triggerDetail: "manual" })).rejects.toThrow("本机领取智能体必须指定任务后再唤醒");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
      .toHaveLength(0);
  }, 30_000);
});
