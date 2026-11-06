import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issueThreadInteractions,
  issues,
  localAgentRunLeases,
  localAgentDeviceBindings,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { localAgentRunLeaseService } from "./local-agent-run-leases.js";
import { localAgentDeviceBindingService } from "./local-agent-device-bindings.js";
import { accessService } from "./access.js";
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
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({
      id: keyId, companyId, agentId, name: "Desktop test key", keyHash: randomUUID(),
    });
    await db.insert(localAgentDeviceBindings).values({
      companyId, agentId, keyId, deviceId: "device-desktop-001",
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
    return { companyId, agentId, issueId, runId, keyId };
  }

  it("refuses a client-pull claim without a registered credential binding", async () => {
    const scope = await fixture();
    await expect(localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "unregistered-device-001", keyId: randomUUID(),
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ status: 403 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(run.status).toBe("queued");
  });

  it("revokes an active device and lets a new key rebind without inheriting its old lease", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const bindings = localAgentDeviceBindingService(db);
    const deviceId = "device-desktop-001";
    const claimed = await svc.claim({ ...scope, deviceId, idempotencyKey: randomUUID() });
    const oldOwner = { ...scope, deviceId, leaseId: claimed!.leaseId,
      generation: claimed!.generation };
    const [oldBinding] = await db.select().from(localAgentDeviceBindings)
      .where(eq(localAgentDeviceBindings.keyId, scope.keyId));
    const replacementKeyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: replacementKeyId, companyId: scope.companyId,
      agentId: scope.agentId, name: "Replacement key", keyHash: randomUUID() });
    await expect(bindings.bind({ ...scope, keyId: replacementKeyId, deviceId }))
      .rejects.toMatchObject({ status: 409 });
    await bindings.revoke({ ...scope, bindingId: oldBinding.id });
    const [lease] = await db.select().from(localAgentRunLeases)
      .where(eq(localAgentRunLeases.runId, scope.runId));
    expect(lease.cancelRequestedAt).not.toBeNull();
    expect((await svc.control(oldOwner)).action).toBe("cancel");
    expect((await svc.renew(oldOwner)).cancelRequested).toBe(true);
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    await expect(svc.addFencedComment({ ...oldOwner, issueId: scope.issueId,
      body: "After device revocation", clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 403 });
    const replacement = await bindings.bind({ ...scope, keyId: replacementKeyId, deviceId });
    expect(replacement.revokedAt).toBeNull();
    await expect(svc.renew({ ...oldOwner, keyId: replacementKeyId }))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.control({ ...oldOwner, keyId: replacementKeyId }))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.finish({ ...oldOwner, keyId: replacementKeyId,
      outcome: "cancelled", exitCode: null, processStopped: true }))
      .rejects.toMatchObject({ status: 403 });
    await expect(svc.finish({ ...oldOwner, outcome: "succeeded",
      exitCode: 0, processStopped: true })).rejects.toMatchObject({ status: 409 });
    expect((await svc.finish({ ...oldOwner, outcome: "cancelled",
      exitCode: null, processStopped: true })).status).toBe("cancelled");
    await expect(bindings.bind({ ...scope, keyId: scope.keyId,
      deviceId: "other-approved-device" })).rejects.toMatchObject({ status: 409 });
  });

  it("serializes claim and device revocation across database pools", async () => {
    const scope = await fixture();
    const [binding] = await db.select().from(localAgentDeviceBindings)
      .where(eq(localAgentDeviceBindings.keyId, scope.keyId));
    const second = createDb(external ?? temporary!.connectionString);
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    try {
      const gate = db.transaction(async (tx) => {
        await tx.select().from(agents).where(eq(agents.id, scope.agentId)).for("update");
        locked();
        await hold;
      });
      await ready;
      const claim = localAgentRunLeaseService(db).claim({
        ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
      });
      const revoke = localAgentDeviceBindingService(second).revoke({
        ...scope, bindingId: binding.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      release();
      await gate;
      const [claimResult, revokeResult] = await Promise.allSettled([claim, revoke]);
      expect(revokeResult.status).toBe("fulfilled");
      if (claimResult.status === "rejected") {
        expect(claimResult.reason).toMatchObject({ status: 403 });
      }
      const [after] = await db.select().from(localAgentDeviceBindings)
        .where(eq(localAgentDeviceBindings.id, binding.id));
      expect(after.revokedAt).not.toBeNull();
      const leases = await db.select().from(localAgentRunLeases)
        .where(eq(localAgentRunLeases.runId, scope.runId));
      if (leases.length) expect(leases[0]!.cancelRequestedAt).not.toBeNull();
    } finally {
      release?.();
      await second.$client.end();
    }
  }, 30_000);

  it("limits device management HTTP routes to an authorized company administrator and audits changes", async () => {
    const scope = await fixture();
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: keyId, companyId: scope.companyId,
      agentId: scope.agentId, name: "Second device key", keyHash: randomUUID() });
    function appFor(actor: Request["actor"]) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use(localAgentRunWriteGate(db));
      app.use("/api", localAgentRunRoutes(db));
      app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
        res.status(err.status ?? 500).json({ error: err.message });
      });
      return app;
    }
    const path = `/api/agents/${scope.agentId}/local-devices`;
    const payload = { keyId, deviceId: "device-desktop-002" };
    const admin = appFor({ type: "board", source: "session", userId: "device-admin",
      companyIds: [scope.companyId], isInstanceAdmin: true });
    const viewer = appFor({ type: "board", source: "session", userId: "viewer",
      companyIds: [scope.companyId], memberships: [{ companyId: scope.companyId,
        membershipRole: "viewer", status: "active" }] });
    const outsider = appFor({ type: "board", source: "session", userId: "other-admin",
      companyIds: [], isInstanceAdmin: true });
    const agent = appFor({ type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId });
    await request(outsider).post(path).send(payload).expect(404);
    await request(viewer).post(path).send(payload).expect(403);
    await request(agent).post(path).send(payload).expect(403);
    await request(admin).post(path).send({ ...payload, createdByUserId: "spoofed" }).expect(400);
    const created = await request(admin).post(path).send(payload).expect(201);
    expect(created.body.keyId).toBe(keyId);
    expect(created.body.createdByUserId).toBe("device-admin");
    const listed = await request(admin).get(path).expect(200);
    expect(listed.body).toHaveLength(2);
    const revoked = await request(admin).delete(`${path}/${created.body.id}`).expect(200);
    expect(revoked.body.revokedByUserId).toBe("device-admin");
    const events = (await db.select().from(activityLog).where(eq(activityLog.entityId, scope.agentId)))
      .filter((event) => event.action.startsWith("agent.local_device_"));
    expect(events.map((event) => event.action).sort()).toEqual([
      "agent.local_device_bound", "agent.local_device_revoked",
    ]);
    expect(events.every((event) => event.actorId === "device-admin")).toBe(true);
  }, 30_000);

  it("allows a company owner with explicit agent-management permission to bind a device", async () => {
    const scope = await fixture();
    const userId = "device-company-owner";
    const access = accessService(db);
    await access.setPrincipalPermission(scope.companyId, "user", userId,
      "agents:create", true, null);
    await access.ensureMembership(scope.companyId, "user", userId, "owner", "active");
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: keyId, companyId: scope.companyId,
      agentId: scope.agentId, name: "Owner approved key", keyHash: randomUUID() });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId,
        companyIds: [scope.companyId], memberships: [{ companyId: scope.companyId,
          membershipRole: "owner", status: "active" }] };
      next();
    });
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const response = await request(app).post(`/api/agents/${scope.agentId}/local-devices`)
      .send({ keyId, deviceId: "device-desktop-002" }).expect(201);
    expect(response.body.createdByUserId).toBe(userId);
  }, 30_000);

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
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
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
        ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
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
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    expect(claimed).not.toBeNull();
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId, generation: claimed!.generation };
    await db.update(localAgentRunLeases).set({ expiresAt: new Date(0) }).where(eq(localAgentRunLeases.runId, scope.runId));
    await expect(svc.renew(owner)).rejects.toMatchObject({ status: 409 });
    expect((await svc.control(owner)).action).toBe("cancel");
    const [afterControl] = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(afterControl.cancelRequestedAt).not.toBeNull();
    await expect(svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() }))
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
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId, generation: claimed!.generation };
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
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, issueId: scope.issueId, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
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
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, issueId: scope.issueId, deviceId: "device-desktop-001",
      leaseId: claimed!.leaseId, generation: claimed!.generation };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
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
    const old = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const newAgentId = randomUUID();
    const newRunId = randomUUID();
    await db.insert(agents).values({
      id: newAgentId, companyId: scope.companyId, name: "Replacement desktop",
      runtimeConfig: { executionMode: "client_pull" },
    });
    const newKeyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: newKeyId, companyId: scope.companyId,
      agentId: newAgentId, name: "Replacement desktop key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId: scope.companyId,
      agentId: newAgentId, keyId: newKeyId, deviceId: "device-desktop-001" });
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
      keyId: newKeyId,
      deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    };
    expect(await svc.claim(nextInput)).toBeNull();
    await svc.finish({
      companyId: scope.companyId, agentId: scope.agentId, runId: scope.runId,
      keyId: scope.keyId,
      deviceId: "device-desktop-001", leaseId: old!.leaseId, generation: old!.generation,
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
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    await svc.finish({
      ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
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
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
    const comment = await svc.addFencedComment({ ...owner, body: "Local execution progress" }, actor);
    expect(comment.createdByRunId).toBe(scope.runId);
    expect(comment.authorAgentId).toBe(scope.agentId);
    const replay = await svc.addFencedComment({ ...owner, body: "Local execution progress" }, actor);
    expect(replay.id).toBe(comment.id);
    await expect(svc.addFencedComment({ ...owner, body: "Different content" }, actor))
      .rejects.toMatchObject({ status: 409 });
    const updated = await svc.patchFencedIssue({ ...owner, title: "Edited from desktop" }, actor);
    expect(updated.title).toBe("Edited from desktop");
    await db.update(issues).set({ status: "in_review", executionRunId: null })
      .where(eq(issues.id, scope.issueId));
    const afterHandoffReplay = await svc.addFencedComment({ ...owner, body: "Local execution progress" }, actor);
    expect(afterHandoffReplay.id).toBe(comment.id);
    await expect(svc.addFencedComment({ ...owner, clientRequestId: randomUUID(),
      body: "Another progress update" }, actor)).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).length).toBe(1);
  });

  it("rolls back comment and audit when reference projection fails, then retries the same request", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID(), body: "Reference retry" };
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
    const sync = vi.fn().mockRejectedValueOnce(new Error("projection unavailable")).mockResolvedValue(undefined);
    const svc = localAgentRunLeaseService(db, { syncCommentReferences: sync });
    await expect(svc.addFencedComment(owner, actor)).rejects.toThrow("projection unavailable");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId)))
      .toHaveLength(0);
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId)))
      .filter((event) => event.action === "issue.comment_added")).toHaveLength(0);
    const replay = await svc.addFencedComment(owner, actor);
    expect(replay.body).toBe("Reference retry");
    expect(sync).toHaveBeenCalledTimes(2);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).toHaveLength(1);
  });

  it("rolls back a pure progress comment when external-object projection fails", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID(), body: "Halfway through" };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    const svc = localAgentRunLeaseService(db, {
      syncCommentExternalObjects: async () => { throw new Error("external projection unavailable"); },
    });
    await expect(svc.addFencedComment(owner, actor)).rejects.toThrow("external projection unavailable");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId)))
      .toHaveLength(0);
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId)))
      .filter((event) => event.action === "issue.comment_added")).toHaveLength(0);
  });

  it("rejects mentions, links and progress comments on an unstarted task", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    const svc = localAgentRunLeaseService(db);
    await expect(svc.addFencedComment({ ...owner, body: "I started" }, actor))
      .rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    for (const body of ["@Luna please see", "https://example.com", "www.example.com",
      "example.com", "mailto:team@example.com"]) {
      await expect(svc.addFencedComment({ ...owner, body }, actor))
        .rejects.toMatchObject({ status: 400 });
    }
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId)))
      .toHaveLength(0);
  });

  it("rejects other issues, companies, generations, and writes after cancellation", async () => {
    const scope = await fixture();
    const other = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
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
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    const owner = { ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId } as const;
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
    await expect(svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() }))
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
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    }))?.runId).toBe(scope.runId);
  });

  it("opens only a fenced progress comment while keeping ordinary writes and edits closed", async () => {
    const scope = await fixture();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId, companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const payload = { deviceId: "device-desktop-001", leaseId: randomUUID(),
      generation: 1, issueId: scope.issueId };
    await request(app).patch(`/api/agents/me/local-runs/${scope.runId}/issue`)
      .send({ ...payload, status: "in_review", comment: "Review this" }).expect(403);
    await request(app).patch(`/api/agents/me/local-runs/${scope.runId}/issue`)
      .send({ ...payload, assigneeAgentId: randomUUID() }).expect(403);
    await request(app).post(`/api/issues/${scope.issueId}/comments`)
      .send({ body: "Ordinary write forbidden" }).expect(403);
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: payload.deviceId, idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    await request(app).post(`/api/agents/me/local-runs/${scope.runId}/comments`)
      .send({ ...payload, leaseId: claimed!.leaseId, generation: claimed!.generation,
        body: "Work is underway", clientRequestId: randomUUID() }).expect(201);
    await request(app).post(`/api/agents/me/local-runs/${scope.runId}/events`).send({
      ...payload, leaseId: claimed!.leaseId, generation: claimed!.generation,
      clientRequestId: randomUUID(), stream: "system", level: "info", message: "HTTP event",
    }).expect(201);
    const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
    expect(issue.status).toBe("in_progress");
    expect(issue.assigneeAgentId).toBe(scope.agentId);
  });

  it("atomically hands an owned task to review and replays only the exact committed command", async () => {
    const scope = await fixture();
    const deviceId = "device-desktop-001";
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId, idempotencyKey: randomUUID(),
    });
    const owner = { ...scope, deviceId, leaseId: claimed!.leaseId, generation: claimed!.generation };
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const [confirmation] = await db.insert(issueThreadInteractions).values({
      companyId: scope.companyId, issueId: scope.issueId,
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      createdByAgentId: scope.agentId, sourceRunId: scope.runId,
      payload: { version: 1, prompt: "Review the result" },
    }).returning();
    const command = { ...owner, body: "Ready for acceptance", reviewInteractionId: confirmation.id,
      clientRequestId: randomUUID() };
    const actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
      companyId: scope.companyId, keyId: scope.keyId } as const;
    const svc = localAgentRunLeaseService(db);
    const first = await svc.reviewFencedIssue(command, actor);
    expect(first.replayed).toBe(false);
    expect(first.issue.status).toBe("in_review");
    expect(first.comment.createdByRunId).toBe(scope.runId);
    const second = await svc.reviewFencedIssue(command, actor);
    expect(second.replayed).toBe(true);
    expect(second.comment.id).toBe(first.comment.id);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId)))
      .toHaveLength(1);
    const events = (await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId)))
      .filter((event) => event.action === "issue.updated" || event.action === "issue.comment_added");
    expect(events.map((event) => event.action).sort()).toEqual(["issue.comment_added", "issue.updated"]);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, confirmation.id)))[0]?.status)
      .toBe("pending");
    await expect(svc.reviewFencedIssue({ ...command, body: "Different content" }, actor))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.reviewFencedIssue({ ...command, clientRequestId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.reviewFencedIssue({ ...command, reviewInteractionId: randomUUID() }, actor))
      .rejects.toMatchObject({ status: 409 });
    const replacement = randomUUID();
    await db.insert(agents).values({ id: replacement, companyId: scope.companyId,
      name: "Replacement", runtimeConfig: { executionMode: "client_pull" } });
    await db.update(issues).set({ assigneeAgentId: replacement }).where(eq(issues.id, scope.issueId));
    await expect(svc.reviewFencedIssue(command, actor)).rejects.toMatchObject({ status: 403 });
  }, 30_000);

  it("exposes only the fenced review handoff over HTTP and rejects it after cancellation", async () => {
    const scope = await fixture();
    const deviceId = "device-desktop-001";
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId, idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const [confirmation] = await db.insert(issueThreadInteractions).values({
      companyId: scope.companyId, issueId: scope.issueId,
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      createdByAgentId: scope.agentId, sourceRunId: scope.runId,
      payload: { version: 1, prompt: "Review this" },
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const path = `/api/agents/me/local-runs/${scope.runId}/issue/review-handoff`;
    const payload = { deviceId, leaseId: claimed!.leaseId, generation: claimed!.generation,
      issueId: scope.issueId, body: "Ready for acceptance",
      reviewInteractionId: confirmation.id, clientRequestId: randomUUID() };
    const first = await request(app).post(path).send(payload).expect(201);
    const replay = await request(app).post(path).send(payload).expect(200);
    expect(replay.body.comment.id).toBe(first.body.comment.id);
    await request(app).post(path).send({ ...payload, clientRequestId: randomUUID() }).expect(409);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await request(app).post(path).send(payload).expect(403);
  }, 30_000);

  it("creates a human review confirmation in the lease transaction and replays one receipt", async () => {
    const scope = await fixture();
    const deviceId = "device-desktop-001";
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId, idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    const path = `/api/agents/me/local-runs/${scope.runId}/issue/review-confirmation`;
    const payload = { deviceId, leaseId: claimed!.leaseId, generation: claimed!.generation,
      issueId: scope.issueId, prompt: "Please verify the result", clientRequestId: randomUUID() };
    const first = await request(app).post(path).send(payload).expect(201);
    const replay = await request(app).post(path).send(payload).expect(200);
    expect(replay.body.interaction.id).toBe(first.body.interaction.id);
    expect(first.body.interaction).toMatchObject({ kind: "request_confirmation", status: "pending",
      sourceRunId: scope.runId, createdByAgentId: scope.agentId,
      effectiveResolverPolicy: "human_only" });
    await request(app).post(path).send({ ...payload, prompt: "Different request" }).expect(409);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId));
    expect(activities.filter((row) => row.action === "issue.thread_interaction_created" &&
      row.details?.interactionId === first.body.interaction.id)).toHaveLength(1);
    await request(app).post(`/api/agents/me/local-runs/${scope.runId}/issue/review-handoff`)
      .send({ ...payload, body: "Ready for acceptance", reviewInteractionId: first.body.interaction.id,
        clientRequestId: randomUUID(), prompt: undefined }).expect(201);
    const [pendingReview] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, first.body.interaction.id));
    expect(pendingReview.status).toBe("pending");
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await request(app).post(path).send(payload).expect(403);
  }, 30_000);

  it("rolls back a fenced review confirmation when its audit row cannot persist", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    await db.execute(sql`create function reject_local_review_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'issue.thread_interaction_created' then
          raise exception 'injected review audit failure';
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger reject_local_review_audit_trigger before insert on activity_log
      for each row execute function reject_local_review_audit()`);
    try {
      await expect(localAgentRunLeaseService(db).createFencedReviewConfirmation({
        ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
        generation: claimed!.generation, prompt: "Please verify the result",
        clientRequestId: randomUUID(),
      }, { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId }))
        .rejects.toThrow("Failed query");
      expect(await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, scope.issueId))).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger reject_local_review_audit_trigger on activity_log`);
      await db.execute(sql`drop function reject_local_review_audit()`);
    }
  }, 30_000);

  it("rejects addressed-agent review before creating a card until delivery is durable", async () => {
    const scope = await fixture();
    const claimed = await localAgentRunLeaseService(db).claim({
      ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID(),
    });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.issueId));
    const reviewerId = randomUUID();
    const pausedId = randomUUID();
    const foreignCompanyId = randomUUID();
    const foreignReviewerId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId,
      name: "Foreign review company", issuePrefix: `F${foreignCompanyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: reviewerId, companyId: scope.companyId, name: "Review agent" },
      { id: pausedId, companyId: scope.companyId, name: "Paused review agent", status: "paused" },
      { id: foreignReviewerId, companyId: foreignCompanyId, name: "Foreign review agent" },
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: scope.agentId,
        companyId: scope.companyId, keyId: scope.keyId };
      next();
    });
    app.use(localAgentRunWriteGate(db));
    app.use("/api", localAgentRunRoutes(db));
    app.use((err: { status?: number; message?: string; details?: unknown }, _req: Request,
      res: Response, _next: NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message, details: err.details });
    });
    const path = `/api/agents/me/local-runs/${scope.runId}/issue/review-confirmation`;
    const payload = { deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, issueId: scope.issueId,
      prompt: "Please review", clientRequestId: randomUUID() };
    for (const target of [reviewerId, scope.agentId, pausedId, foreignReviewerId]) {
      const denied = await request(app).post(path)
        .send({ ...payload, reviewerAgentId: target }).expect(422);
      expect(denied.body.details?.code).toBe("local_run_agent_review_delivery_unavailable");
    }
    expect(await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, scope.issueId))).toHaveLength(0);
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, scope.issueId)))
      .filter((row) => row.action === "issue.thread_interaction_created")).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, scope.runId));
    await request(app).post(path).send({ ...payload, reviewerAgentId: reviewerId }).expect(403);
  }, 30_000);

  it("preserves deletion of a task and its run after a historical lease", async () => {
    const scope = await fixture();
    const svc = localAgentRunLeaseService(db);
    const claimed = await svc.claim({ ...scope, deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    await svc.finish({ ...scope, deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, outcome: "succeeded", exitCode: 0, processStopped: true });
    await db.delete(issues).where(eq(issues.id, scope.issueId));
    const [lease] = await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId));
    expect(lease.issueId).toBe(scope.issueId);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(await db.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, scope.runId))).toHaveLength(0);
  });
});
