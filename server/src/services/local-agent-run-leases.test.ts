import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issues,
  localAgentRunLeases,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { localAgentRunLeaseService } from "./local-agent-run-leases.js";
import { localAgentRunWriteGate } from "../middleware/local-agent-run-write-gate.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

suite("local client-pull run ownership (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-local-run-leases-");
      db = createDb(temporary.connectionString);
    }
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Local run lease fixture",
      issuePrefix: `L${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Desktop agent",
      adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Owned task",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    return { companyId, agentId, issueId, runId };
  }

  it("atomically admits one device and replays the same idempotency key after a service restart", async () => {
    const scope = await fixture();
    const first = localAgentRunLeaseService(db);
    const key = randomUUID();
    const input = { ...scope, deviceId: "device-desktop-001", idempotencyKey: key };
    const otherInput = { ...scope, deviceId: "device-desktop-002", idempotencyKey: randomUUID() };
    const raced = await Promise.allSettled([
      first.claim(input),
      first.claim(otherInput),
    ]);
    const winners = raced.filter((result) => result.status === "fulfilled" && result.value !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0] as PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof first.claim>>>>;
    expect(winner.value.runId).toBe(scope.runId);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(run.status).toBe("running");
    expect(run.runtimeMode).toBe("client_pull");
    expect(issue.executionRunId).toBe(scope.runId);
    const secondService = localAgentRunLeaseService(db);
    const replay = await secondService.claim(raced[0].status === "fulfilled" ? input : otherInput);
    expect(replay?.leaseId).toBe(winner.value.leaseId);
    expect(replay?.generation).toBe(1);
    const rows = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(rows).toHaveLength(1);
  });

  it("does not renew an expired lease or reassign before stop acknowledgement", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-003", idempotencyKey: randomUUID() });
    expect(claimed).not.toBeNull();
    const owner = { ...scope, deviceId: "device-desktop-003", leaseId: claimed!.leaseId, generation: claimed!.generation };
    await db.update(localAgentRunLeases).set({ expiresAt: new Date(0) }).where(eq(localAgentRunLeases.runId, scope.runId));
    await expect(svc.renew(owner)).rejects.toMatchObject({ status: 409 });
    expect((await svc.control(owner)).action).toBe("cancel");
    await expect(svc.claim({ ...scope, deviceId: "device-desktop-004", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.finish({ ...owner, outcome: "succeeded", exitCode: 0, processStopped: true }))
      .rejects.toMatchObject({ status: 409 });
    const finished = await svc.finish({ ...owner, outcome: "cancelled", exitCode: null, processStopped: true });
    expect(finished.status).toBe("cancelled");
    const [lease] = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(lease.stopAcknowledgedAt).not.toBeNull();
    expect(lease.releasedAt).not.toBeNull();
  });

  it("rejects success after cancellation and rejects a stale generation", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-005", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-005", leaseId: claimed!.leaseId, generation: claimed!.generation };
    await expect(svc.renew({ ...owner, generation: owner.generation + 1 })).rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    expect((await svc.renew(owner)).cancelRequested).toBe(true);
    await expect(svc.finish({ ...owner, outcome: "succeeded", exitCode: 0, processStopped: true }))
      .rejects.toMatchObject({ status: 409 });
    expect((await svc.finish({ ...owner, outcome: "cancelled", exitCode: null, processStopped: true })).status)
      .toBe("cancelled");
    expect((await svc.finish({ ...owner, outcome: "cancelled", exitCode: null, processStopped: true })).status)
      .toBe("cancelled");
  });

  it("keeps an unacknowledged cancelled issue reserved across reassignment", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const old = await svc.claim({ ...scope, deviceId: "device-desktop-006", idempotencyKey: randomUUID() });
    const newAgentId = randomUUID();
    const newRunId = randomUUID();
    await db.insert(agents).values({
      id: newAgentId, companyId: scope.companyId, name: "Replacement desktop",
      runtimeConfig: { executionMode: "client_pull" },
    });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await db.update(issues).set({
      assigneeAgentId: newAgentId, executionRunId: null,
    }).where(eq(issues.id, scope.issueId));
    await db.insert(heartbeatRuns).values({
      id: newRunId, companyId: scope.companyId, agentId: newAgentId,
      status: "queued", contextSnapshot: { issueId: scope.issueId },
    });
    const nextInput = {
      companyId: scope.companyId, agentId: newAgentId,
      deviceId: "device-desktop-007", idempotencyKey: randomUUID(),
    };
    expect(await svc.claim(nextInput)).toBeNull();
    await svc.finish({
      companyId: scope.companyId, agentId: scope.agentId, runId: scope.runId,
      deviceId: "device-desktop-006", leaseId: old!.leaseId, generation: old!.generation,
      outcome: "cancelled", exitCode: null, processStopped: true,
    });
    expect((await svc.claim(nextInput))?.runId).toBe(newRunId);
  });

  it("fences ordinary writes for an opted-in desktop agent", async () => {
    const scope = await fixture();
    const gate = localAgentRunWriteGate(db);
    const response = {
      status: vi.fn().mockReturnThis(), json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    const request = {
      method: "PATCH", path: `/api/issues/${scope.issueId}`,
      actor: { type: "agent", source: "agent_key", companyId: scope.companyId, agentId: scope.agentId },
    } as unknown as Request;
    await gate(request, response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "CLIENT_PULL_WRITE_FENCED" }));
    expect(next).not.toHaveBeenCalled();

    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-008", idempotencyKey: randomUUID() });
    await svc.finish({
      ...scope, deviceId: "device-desktop-008", leaseId: claimed!.leaseId,
      generation: claimed!.generation, outcome: "succeeded", exitCode: 0,
      processStopped: true,
    });
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, scope.agentId));
    vi.mocked(response.status).mockClear();
    vi.mocked(response.json).mockClear();
    await gate(request, response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
