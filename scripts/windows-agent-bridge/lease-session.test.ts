import { describe, expect, it, vi } from "vitest";
import { runLeaseSession } from "./lease-session.js";
import type { LocalRunClaim } from "./paperclip-client.js";

const claim: LocalRunClaim = {
  runId: "f2c991f1-b53d-4bb5-b134-8e29d43815d0",
  issueId: "1b9c2019-b811-40a0-bd21-0365977a0001",
  agentId: "38a5808c-47f3-4029-bdfe-0d84504bdc8a",
  leaseId: "784d88a1-7a05-42d2-a7d8-e714d70f2d0b",
  generation: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  wakeReason: "assignment",
  workspacePolicy: "agent_home",
};

describe("local run lease session", () => {
  it("finishes only after the local executor has settled", async () => {
    const finish = vi.fn().mockResolvedValue("succeeded");
    const client = { renewLocalRun: vi.fn(), finishLocalRun: finish };
    const result = await runLeaseSession({
      client, claim, deviceId: "device-one",
      execute: async () => ({ succeeded: true, exitCode: 0 }),
    });
    expect(result).toEqual({ outcome: "succeeded", status: "succeeded" });
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ runId: claim.runId, leaseId: claim.leaseId }), "succeeded", 0);
  });

  it("aborts local execution and reports cancellation after stop is confirmed", async () => {
    const finish = vi.fn().mockResolvedValue("cancelled");
    const client = { renewLocalRun: vi.fn().mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: true }), finishLocalRun: finish };
    const result = await runLeaseSession({
      client, claim, deviceId: "device-one", renewIntervalMs: 5,
      execute: async (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ succeeded: false, exitCode: null }), { once: true })),
    });
    expect(result.outcome).toBe("cancelled");
    expect(finish).toHaveBeenCalledOnce();
  });

  it("stops on lost lease and never claims a stale success", async () => {
    const finish = vi.fn();
    const client = { renewLocalRun: vi.fn().mockRejectedValue(new Error("HTTP 409")), finishLocalRun: finish };
    await expect(runLeaseSession({
      client, claim, deviceId: "device-one", renewIntervalMs: 5,
      execute: async (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ succeeded: false, exitCode: null }), { once: true })),
    })).rejects.toThrow("lease was lost");
    expect(finish).not.toHaveBeenCalled();
  });

  it("refuses execution if the claimed lease is already near expiry", async () => {
    const execute = vi.fn();
    await expect(runLeaseSession({
      client: { renewLocalRun: vi.fn(), finishLocalRun: vi.fn() },
      claim: { ...claim, leaseExpiresAt: new Date(Date.now() + 4_000).toISOString() },
      deviceId: "device-one", execute,
    })).rejects.toThrow("too close to expiry");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not report processStopped when cancellation leaves a hung executor", async () => {
    const finish = vi.fn();
    await expect(runLeaseSession({
      client: { renewLocalRun: vi.fn().mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: true }), finishLocalRun: finish },
      claim, deviceId: "device-one", renewIntervalMs: 5, stopTimeoutMs: 5,
      execute: async () => new Promise(() => undefined),
    })).rejects.toThrow("stop was not confirmed");
    expect(finish).not.toHaveBeenCalled();
  });

  it("does not acknowledge stop when the executor rejects after cancellation", async () => {
    const finish = vi.fn();
    await expect(runLeaseSession({
      client: { renewLocalRun: vi.fn().mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: true }), finishLocalRun: finish },
      claim, deviceId: "device-one", renewIntervalMs: 5,
      execute: async (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("adapter lost child status")), { once: true })),
    })).rejects.toThrow("stop was not confirmed");
    expect(finish).not.toHaveBeenCalled();
  });
});
