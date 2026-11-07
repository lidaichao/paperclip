import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaimStateStore } from "./claim-state.js";
import type { LocalRunClaim } from "./paperclip-client.js";

const deviceId = "8da47d3b-0a6e-49d4-9c26-17bc76de470f";
const agentId = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const claim: LocalRunClaim = {
  runId: "f2c991f1-b53d-4bb5-b134-8e29d43815d0",
  issueId: "1b9c2019-b811-40a0-bd21-0365977a0001",
  agentId,
  leaseId: "784d88a1-7a05-42d2-a7d8-e714d70f2d0b",
  generation: 1,
  leaseExpiresAt: "2026-11-06T04:00:00Z",
  leaseDeadlineMonotonicMs: performance.now() + 60_000,
  wakeReason: "assignment",
  workspacePolicy: "agent_home",
};

describe("durable local claim state", () => {
  it("persists the same key across a lost claim response and rotates only after confirmed finish", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "alice-claim-state-"));
    const file = path.join(dir, "claim.json");
    const first = new ClaimStateStore(file, deviceId, agentId);
    const key = await first.claimKey();
    expect(JSON.parse(await readFile(file, "utf8")).idempotencyKey).toBe(key);
    const restarted = new ClaimStateStore(file, deviceId, agentId);
    expect(await restarted.claimKey()).toBe(key);
    await restarted.markClaimed(claim);
    await expect(new ClaimStateStore(file, deviceId, agentId).claimKey()).rejects.toThrow("manual recovery required");
    await restarted.markFinished(claim.runId);
    expect(await new ClaimStateStore(file, deviceId, agentId).claimKey()).not.toBe(key);
  });

  it("refuses another device or agent identity", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "alice-claim-identity-"));
    const file = path.join(dir, "claim.json");
    await new ClaimStateStore(file, deviceId, agentId).claimKey();
    await expect(new ClaimStateStore(file, agentId, agentId).claimKey()).rejects.toThrow("identity or format mismatch");
  });

  it("persists possible execution, process reports and exact finish intent across restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "alice-claim-recovery-"));
    const file = path.join(dir, "claim.json");
    const state = new ClaimStateStore(file, deviceId, agentId);
    await state.markClaimed(claim);
    await state.markExecutionStarting(claim.runId);
    await state.markProcessReported(claim.runId, { pid: 1441, startedAt: "2026-11-07T12:00:00Z" });
    const intent = { clientRequestId: "42afdb98-d301-401e-9430-2b1a9e6d43e1",
      outcome: "succeeded" as const, exitCode: 0, summary: "completed" };
    await state.markFinishIntent(claim.runId, intent);
    const restarted = new ClaimStateStore(file, deviceId, agentId);
    expect(await restarted.recoveryState()).toMatchObject({ schemaVersion: 2,
      activeClaim: { runId: claim.runId }, executionMayHaveStarted: true,
      reportedProcesses: [{ pid: 1441, startedAt: "2026-11-07T12:00:00Z" }],
      finishIntent: intent });
    await expect(restarted.claimKey()).rejects.toThrow("manual recovery required");
    await restarted.markFinished(claim.runId);
    expect(await new ClaimStateStore(file, deviceId, agentId).recoveryState()).toMatchObject({
      activeClaim: null, executionMayHaveStarted: false, reportedProcesses: [], finishIntent: null });
  });

  it("rejects a legacy active claim because its process state is unknown", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "alice-legacy-recovery-"));
    const file = path.join(dir, "claim.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, deviceId, agentId,
      idempotencyKey: "a31b8095-1ee5-4455-a56d-73278f0dd223", activeClaim: claim }));
    await expect(new ClaimStateStore(file, deviceId, agentId).recoveryState())
      .rejects.toThrow("manual recovery required");
  });
});
