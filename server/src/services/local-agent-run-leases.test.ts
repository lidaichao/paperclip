import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issues,
  localAgentRunLeases,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { localAgentRunLeaseService } from "./local-agent-run-leases.js";
import { heartbeatService } from "./heartbeat.js";
import { agentService } from "./agents.js";
import { updateAgentSchema } from "@paperclipai/shared";
import { localAgentRunWriteGate } from "../middleware/local-agent-run-write-gate.js";
import { localAgentRunRoutes } from "../routes/local-agent-runs.js";

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

  it("continues past twenty ineligible queued runs instead of starving a ready task", async () => {
    const scope = await fixture();
    await db.insert(heartbeatRuns).values(Array.from({ length: 20 }, (_, index) => ({
      id: randomUUID(), companyId: scope.companyId, agentId: scope.agentId,
      status: "queued" as const,
      createdAt: new Date(Date.now() - 120_000 + index),
      contextSnapshot: { wakeReason: "no_issue" },
    })));
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-page-001", idempotencyKey: randomUUID(),
    });
    expect(claimed?.runId).toBe(scope.runId);
  });

  it("serializes server admission with a concurrent mode switch and desktop claim across DB pools", async () => {
    const scope = await fixture();
    const second = createDb(external ?? temporary!.connectionString);
    try {
      await db.update(agents).set({ runtimeConfig: { executionMode: "server" } })
        .where(eq(agents.id, scope.agentId));
      const [queuedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      let signalLocked!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
      const released = new Promise<void>((resolve) => { releaseLock = resolve; });
      const modeSwitch = db.transaction(async (tx) => {
        await tx.select().from(agents).where(eq(agents.id, scope.agentId)).for("update");
        signalLocked();
        await released;
        await tx.update(agents).set({ runtimeConfig: { executionMode: "client_pull" } })
          .where(eq(agents.id, scope.agentId));
      });
      await locked;
      const serverAdmission = second.transaction((tx) =>
        heartbeatService(second).serverRunClaimAdmission(tx as unknown as typeof second, queuedRun));
      const stillWaiting = await Promise.race([
        serverAdmission.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 40)),
      ]);
      expect(stillWaiting).toBe(true);
      releaseLock();
      await modeSwitch;
      const desktopClaim = localAgentRunLeaseService(db).claim({
        ...scope, deviceId: "device-desktop-mode-001", idempotencyKey: randomUUID(),
      });
      expect(await serverAdmission).toBe(false);
      expect((await desktopClaim)?.runId).toBe(scope.runId);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      expect(run.runtimeMode).toBe("client_pull");
      expect(run.status).toBe("running");
    } finally {
      await second.$client.end();
    }
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
    const [afterControl] = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(afterControl.cancelRequestedAt).not.toBeNull();
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

  it("persists bounded run events and a finish summary under the same lease identity", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-log-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, issueId: scope.issueId, deviceId: "device-desktop-log-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId } as const;
    const event = { ...owner, clientRequestId: randomUUID(), stream: "stdout" as const,
      level: "info" as const, message: "Executed local step" };
    const first = await svc.appendFencedEvent(event, actor);
    expect(first.seq).toBe(1);
    expect((await svc.appendFencedEvent(event, actor)).id).toBe(first.id);
    await expect(svc.appendFencedEvent({ ...event, message: "Changed intent" }, actor))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.appendFencedEvent({ ...event, clientRequestId: randomUUID(), message: "字".repeat(3000) }, actor))
      .rejects.toMatchObject({ status: 400 });
    await expect(svc.appendFencedEvent({ ...event, issueId: randomUUID(), clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 403 });
    const finish = { ...owner, outcome: "succeeded" as const, exitCode: 0,
      processStopped: true as const, clientRequestId: randomUUID(), summary: "Finished test work" };
    expect((await svc.finish(finish)).status).toBe("succeeded");
    expect((await svc.finish(finish)).status).toBe("succeeded");
    await expect(svc.finish({ ...finish, summary: "Changed summary" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.appendFencedEvent({ ...event, clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 409 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(run.resultJson?.localWorkerFinish).toEqual({
      clientRequestId: finish.clientRequestId, outcome: "succeeded", exitCode: 0,
      summary: "Finished test work",
    });
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, scope.runId)))
      .toHaveLength(1);
  });

  it("rejects new run events after a cancellation commits", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-log-002", idempotencyKey: randomUUID() });
    const owner = { ...scope, issueId: scope.issueId, deviceId: "device-desktop-log-002",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId } as const;
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await expect(svc.appendFencedEvent({ ...owner, clientRequestId: randomUUID(),
      stream: "stderr", level: "warn", message: "Too late" }, actor))
      .rejects.toMatchObject({ status: 409 });
    const stop = { ...owner, outcome: "cancelled" as const, exitCode: null,
      processStopped: true as const, clientRequestId: randomUUID() };
    await expect(svc.finish({ ...stop, outcome: "succeeded", exitCode: 0 }))
      .rejects.toMatchObject({ status: 409 });
    expect((await svc.finish(stop)).status).toBe("cancelled");
    expect((await svc.finish(stop)).status).toBe("cancelled");
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, scope.runId)))
      .toHaveLength(0);
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

  it("writes a current-run comment and issue edit with the lease transaction", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-009", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-009", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId } as const;
    const comment = await svc.addFencedComment({ ...owner, body: "Local execution progress" }, actor);
    expect(comment.createdByRunId).toBe(scope.runId);
    expect(comment.authorAgentId).toBe(scope.agentId);
    const replay = await svc.addFencedComment({ ...owner, body: "Local execution progress" }, actor);
    expect(replay.id).toBe(comment.id);
    await expect(svc.addFencedComment({ ...owner, body: "Different content" }, actor))
      .rejects.toMatchObject({ status: 409 });
    const updated = await svc.patchFencedIssue({ ...owner, title: "Edited from desktop" }, actor);
    expect(updated.title).toBe("Edited from desktop");
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).length).toBe(1);
  });

  it("retries reference projection after a committed comment's first post-commit failure", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-015", idempotencyKey: randomUUID(),
    });
    const owner = { ...scope, deviceId: "device-desktop-015", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID(), body: "Reference retry" };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId } as const;
    const sync = vi.fn().mockRejectedValueOnce(new Error("projection unavailable")).mockResolvedValue(undefined);
    const svc = localAgentRunLeaseService(db, { syncCommentReferences: sync });
    await expect(svc.addFencedComment(owner, actor)).rejects.toThrow("projection unavailable");
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId));
    expect(stored.body).toBe("Reference retry");
    const replay = await svc.addFencedComment(owner, actor);
    expect(replay.id).toBe(stored.id);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).toHaveLength(1);
  });

  it("rejects other issues, companies, generations, and writes after cancellation", async () => {
    const scope = await fixture();
    const other = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-010", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-010", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId } as const;
    const count = async () => (await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).length;
    await expect(svc.addFencedComment({ ...owner, issueId: other.issueId, body: "cross company" }, actor))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.patchFencedIssue({ ...owner, issueId: other.issueId, title: "cross company" }, actor))
      .rejects.toMatchObject({ status: 403 });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: scope.companyId, title: "Other issue", status: "todo", assigneeAgentId: scope.agentId });
    await expect(svc.addFencedComment({ ...owner, issueId: otherIssueId, body: "cross issue" }, actor))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.addFencedComment({ ...owner, generation: owner.generation + 1, body: "stale" }, actor))
      .rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await expect(svc.addFencedComment({ ...owner, body: "after cancel" }, actor))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.patchFencedIssue({ ...owner, title: "after cancel" }, actor))
      .rejects.toMatchObject({ status: 403 });
    expect(await count()).toBe(0);
  });

  it("does not let a comment cross a concurrently committed cancellation", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-012", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-012", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId } as const;
    let releaseCancellation!: () => void;
    let cancellationLocked!: () => void;
    const allowCommit = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const lockHeld = new Promise<void>((resolve) => { cancellationLocked = resolve; });
    const cancellation = db.transaction(async (tx) => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId)).for("update");
      cancellationLocked();
      await allowCommit;
      await tx.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    });
    await lockHeld;
    const lateWrite = svc.addFencedComment({ ...owner, body: "Must not escape" }, actor);
    releaseCancellation();
    await cancellation;
    await expect(lateWrite).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).toHaveLength(0);
  });

  it("honors the scheduler daily run limit before claiming a queued desktop run", async () => {
    const scope = await fixture();
    await db.update(agents).set({
      runtimeConfig: { executionMode: "client_pull", heartbeat: { maxDailyRuns: 0 } },
    }).where(eq(agents.id, scope.agentId));
    const svc = localAgentRunLeaseService(db);
    await expect(svc.claim({ ...scope, deviceId: "device-desktop-013", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(run.status).toBe("queued");
  });

  it("persists executionMode through the existing agent update contract", async () => {
    const scope = await fixture();
    const parsed = updateAgentSchema.parse({ runtimeConfig: { executionMode: "client_pull" } });
    expect(parsed.runtimeConfig?.executionMode).toBe("client_pull");
    await agentService(db).update(scope.agentId, { runtimeConfig: {} });
    await agentService(db).update(scope.agentId, { runtimeConfig: parsed.runtimeConfig });
    const [stored] = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents)
      .where(eq(agents.id, scope.agentId));
    expect(stored.runtimeConfig?.executionMode).toBe("client_pull");
    expect((await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-014", idempotencyKey: randomUUID(),
    }))?.runId).toBe(scope.runId);
  });

  it("keeps status and assignee edits closed at the dedicated HTTP route", async () => {
    const scope = await fixture();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const payload = { deviceId: "device-desktop-016", leaseId: randomUUID(),
      generation: 1, issueId: scope.issueId };
    await request(app).patch(`/api/agents/me/local-runs/${scope.runId}/issue`)
      .send({ ...payload, status: "in_review", comment: "Review this" }).expect(400);
    await request(app).patch(`/api/agents/me/local-runs/${scope.runId}/issue`)
      .send({ ...payload, assigneeAgentId: randomUUID() }).expect(400);
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: payload.deviceId, idempotencyKey: randomUUID(),
    });
    await request(app).post(`/api/agents/me/local-runs/${scope.runId}/events`).send({
      ...payload, leaseId: claimed!.leaseId, generation: claimed!.generation,
      clientRequestId: randomUUID(), stream: "system", level: "info", message: "HTTP event",
    }).expect(201);
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.status).toBe("todo");
    expect(issue.assigneeAgentId).toBe(scope.agentId);
  });

  it("preserves deletion of a task and its run after a historical lease", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-011", idempotencyKey: randomUUID() });
    await svc.finish({ ...scope, deviceId: "device-desktop-011", leaseId: claimed!.leaseId,
      generation: claimed!.generation, outcome: "succeeded", exitCode: 0, processStopped: true });
    await db.delete(issues).where(eq(issues.id, scope.issueId));
    const [lease] = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(lease.issueId).toBe(scope.issueId);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId))).toHaveLength(0);
  });
});
