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
  leaseDeadlineMonotonicMs: performance.now() + 60_000,
  wakeReason: "assignment",
  workspacePolicy: "agent_home",
};
const continueControl = () => ({ controlLocalRun: vi.fn(async () => ({ action: "continue" as const,
  generation: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })) });

describe("local run lease session", () => {
  it("finishes only after the local executor has settled", async () => {
    const finish = vi.fn().mockResolvedValue("succeeded");
    const client = { ...continueControl(), renewLocalRun: vi.fn(), finishLocalRun: finish };
    const result = await runLeaseSession({
      client, claim, deviceId: "device-one",
      execute: async () => ({ succeeded: true, exitCode: 0 }),
    });
    expect(result).toEqual({ outcome: "succeeded", status: "succeeded" });
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ runId: claim.runId, leaseId: claim.leaseId }), "succeeded", 0);
  });

  it("reports cancelled when the server cancels just before natural completion", async () => {
    const finish = vi.fn().mockResolvedValue("cancelled");
    const client = { renewLocalRun: vi.fn(), finishLocalRun: finish,
      controlLocalRun: vi.fn(async () => ({ action: "cancel" as const, generation: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })) };
    const result = await runLeaseSession({ client, claim, deviceId: "device-one",
      execute: async () => ({ succeeded: true, exitCode: 0 }) });
    expect(result.outcome).toBe("cancelled");
    expect(finish).toHaveBeenCalledWith(expect.anything(), "cancelled", 0);
  });

  it("rechecks cancellation after a success finish loses the race; uncertain state stays latched", async () => {
    const finish = vi.fn().mockRejectedValueOnce(new Error("Alice API request failed with HTTP 409"))
      .mockResolvedValueOnce("cancelled");
    const controlLocalRun = vi.fn().mockResolvedValueOnce({ action: "continue", generation: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })
      .mockResolvedValueOnce({ action: "cancel", generation: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    const client = { renewLocalRun: vi.fn(), finishLocalRun: finish, controlLocalRun };
    const result = await runLeaseSession({ client, claim, deviceId: "device-one",
      execute: async () => ({ succeeded: true, exitCode: 0 }) });
    expect(result.outcome).toBe("cancelled");
    expect(finish.mock.calls.map((call) => call[1])).toEqual(["succeeded", "cancelled"]);

    const uncertain = { ...continueControl(), renewLocalRun: vi.fn(),
      finishLocalRun: vi.fn().mockRejectedValue(new Error("Alice API request failed with HTTP 409")) };
    await expect(runLeaseSession({ client: uncertain, claim, deviceId: "device-one",
      execute: async () => ({ succeeded: true, exitCode: 0 }) })).rejects.toThrow("HTTP 409");
  });

  it("aborts local execution and reports cancellation after stop is confirmed", async () => {
    const finish = vi.fn().mockResolvedValue("cancelled");
    const client = { ...continueControl(), renewLocalRun: vi.fn().mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: true }), finishLocalRun: finish };
    const result = await runLeaseSession({
      client, claim, deviceId: "device-one", renewIntervalMs: 5,
      execute: async (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ succeeded: false, exitCode: null }), { once: true })),
    });
    expect(result.outcome).toBe("cancelled");
    expect(finish).toHaveBeenCalledOnce();
  });

  it("stops on lost lease and never claims a stale success", async () => {
    const finish = vi.fn();
    const client = { ...continueControl(), renewLocalRun: vi.fn().mockRejectedValue(new Error("HTTP 409")), finishLocalRun: finish };
    await expect(runLeaseSession({
      client, claim, deviceId: "device-one", renewIntervalMs: 5,
      execute: async (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ succeeded: false, exitCode: null }), { once: true })),
    })).rejects.toThrow("lease was lost");
    expect(finish).not.toHaveBeenCalled();
  });

  it("refuses execution if the claimed lease is already near expiry", async () => {
    const execute = vi.fn();
    await expect(runLeaseSession({
      client: { ...continueControl(), renewLocalRun: vi.fn(), finishLocalRun: vi.fn() },
      claim: { ...claim, leaseDeadlineMonotonicMs: performance.now() + 4_000 },
      deviceId: "device-one", execute,
    })).rejects.toThrow("too close to expiry");
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the server TTL deadline even when the local wall clock disagrees", async () => {
    const finish = vi.fn().mockResolvedValue("succeeded");
    const result = await runLeaseSession({
      client: { ...continueControl(), renewLocalRun: vi.fn(), finishLocalRun: finish },
      claim: { ...claim, leaseExpiresAt: "2000-01-01T00:00:00Z",
        leaseDeadlineMonotonicMs: performance.now() + 60_000 },
      deviceId: "device-one", execute: async () => ({ succeeded: true, exitCode: 0 }),
    });
    expect(result.outcome).toBe("succeeded");
    expect(finish).toHaveBeenCalledOnce();
  });

  it("renews from a monotonic server TTL while ignoring stale wall-clock dates", async () => {
    const finish = vi.fn().mockResolvedValue("succeeded");
    const renew = vi.fn().mockImplementation(async () => ({
      leaseExpiresAt: "2000-01-01T00:00:00Z", cancelRequested: false,
      leaseDeadlineMonotonicMs: performance.now() + 60_000,
    }));
    const result = await runLeaseSession({
      client: { ...continueControl(), renewLocalRun: renew, finishLocalRun: finish }, claim,
      deviceId: "device-one", renewIntervalMs: 5,
      execute: async () => { await new Promise((resolve) => setTimeout(resolve, 18)); return { succeeded: true, exitCode: 0 }; },
    });
    expect(result.outcome).toBe("succeeded");
    expect(renew).toHaveBeenCalled();
  });

  it("does not report processStopped when cancellation leaves a hung executor", async () => {
    const finish = vi.fn();
    await expect(runLeaseSession({
      client: { ...continueControl(), renewLocalRun: vi.fn().mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: true }), finishLocalRun: finish },
      claim, deviceId: "device-one", renewIntervalMs: 5, stopTimeoutMs: 5,
      execute: async () => new Promise(() => undefined),
    })).rejects.toThrow("stop was not confirmed");
    expect(finish).not.toHaveBeenCalled();
  });

  it("does not acknowledge stop when the executor rejects after cancellation", async () => {
    const finish = vi.fn();
    await expect(runLeaseSession({
      client: { ...continueControl(), renewLocalRun: vi.fn().mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: true }), finishLocalRun: finish },
      claim, deviceId: "device-one", renewIntervalMs: 5,
      execute: async (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("adapter lost child status")), { once: true })),
    })).rejects.toThrow("stop was not confirmed");
    expect(finish).not.toHaveBeenCalled();
  });
});
