import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireSingleInstanceLock, claimAndRunOnce, runBridge, waitForPollInterval, writeHealth } from "./main.js";
import { LocalCommentIntentStore } from "./local-run-write-proxy.js";
import type { AliceClient } from "./paperclip-client.js";
import type { ClaimStateStore } from "./claim-state.js";

describe("bridge lifecycle", () => {
  it("does not claim or start another model while an earlier write intent is unresolved", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-unresolved-"));
    const intentFile = path.join(dir, "intent.json");
    await new LocalCommentIntentStore(intentFile).pending(
      "f2c991f1-b53d-4bb5-b134-8e29d43815d0",
      "1b9c2019-b811-40a0-bd21-0365977a0001", "possibly committed comment");
    const claimLocalRun = vi.fn();
    const claimKey = vi.fn();
    await expect(claimAndRunOnce({
      client: { claimLocalRun } as unknown as AliceClient,
      state: { claimKey } as unknown as ClaimStateStore,
      deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
      companyId: "af8e9089-b0bb-43ac-ade3-c029c73b96e6",
      agent: { remoteAgentId: "38a5808c-47f3-4029-bdfe-0d84504bdc8a",
        remoteAgentName: "Luna", localAgentName: "Luna", gbrainEnvRef: "GBRAIN_LUNA_TOKEN",
        adapterType: "codex_local", localAdapterConfig: {}, maxConcurrentRuns: 1 },
      localAgent: { id: "38a5808c-47f3-4029-bdfe-0d84504bdc8a",
        companyId: "af8e9089-b0bb-43ac-ade3-c029c73b96e6", name: "Luna",
        adapterType: "codex_local", adapterConfig: {} },
      token: "never-used", intentFile, signal: new AbortController().signal,
    })).rejects.toThrow("manual reconciliation");
    expect(claimKey).not.toHaveBeenCalled();
    expect(claimLocalRun).not.toHaveBeenCalled();
  });

  it("refuses to start before any lock or poll while ordinary writes are fenced", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-run-binding-"));
    const stateFile = path.join(dir, "38a5808c-47f3-4029-bdfe-0d84504bdc8a", "claim-state.json");
    const configFile = path.join(dir, "bridge.json");
    await writeFile(configFile, JSON.stringify({
      schemaVersion: 3,
      deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
      workerHome: path.join(dir, "38a5808c-47f3-4029-bdfe-0d84504bdc8a"),
      apiBase: "http://192.168.72.157:3100",
      companyId: "af8e9089-b0bb-43ac-ade3-c029c73b96e6",
      credentialsFile: "credentials.dpapi",
      pollIntervalMs: 10_000,
      agents: [{
        remoteAgentId: "38a5808c-47f3-4029-bdfe-0d84504bdc8a",
        remoteAgentName: "Luna",
        localAgentName: "Luna",
        gbrainEnvRef: "GBRAIN_LUNA_TOKEN",
        adapterType: "codex_local",
        localAdapterConfig: { cwd: "H:/AIagent/Luna", command: "C:/tools/codex.exe" },
        maxConcurrentRuns: 1,
      }],
    }));
    await expect(runBridge(configFile, new AbortController().signal)).rejects.toThrow("write fencing is unavailable");
    await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only one healthy lock owner and refuses stale-lock auto takeover", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-lock-"));
    const lockPath = path.join(dir, "bridge.lock");
    const first = await acquireSingleInstanceLock(lockPath, { pid: 101, alive: (pid) => pid === 101 });
    expect(first).not.toBeNull();
    expect(await acquireSingleInstanceLock(lockPath, { pid: 202, alive: (pid) => pid === 101 })).toBeNull();
    await writeFile(lockPath, JSON.stringify({ pid: 303, startedAt: "old", token: "stale" }));
    await expect(acquireSingleInstanceLock(lockPath, { pid: 202, alive: () => false }))
      .rejects.toThrow("manual recovery");
    await first?.release();
    expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(303);
  });

  it("keeps a stale lock under two simultaneous takeover attempts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-lock-race-"));
    const lockPath = path.join(dir, "bridge.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 303, startedAt: "old", token: "stale" }));
    const contenders = await Promise.allSettled([101, 202].map((pid) =>
      acquireSingleInstanceLock(lockPath, { pid, alive: () => false })));
    expect(contenders.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(303);
  });

  it("grants one atomic owner when two processes race for an absent lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-lock-create-"));
    const lockPath = path.join(dir, "bridge.lock");
    const contenders = await Promise.all([101, 202].map((pid) =>
      acquireSingleInstanceLock(lockPath, { pid, alive: () => true })));
    expect(contenders.filter(Boolean)).toHaveLength(1);
    await contenders.find(Boolean)?.release();
  });

  it("cancels a pending poll wait immediately", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = waitForPollInterval(60_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("writes redacted health data atomically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-health-"));
    const healthPath = path.join(dir, "health.json");
    await writeHealth(healthPath, {
      schemaVersion: 1,
      connected: true,
      lastSuccessfulPollAt: "2026-11-03T00:00:00.000Z",
      agents: { agent: { state: "idle", activeTask: null } },
      lastError: null,
      updatedAt: "2026-11-03T00:00:00.000Z",
    });
    const raw = await readFile(healthPath, "utf8");
    expect(raw).not.toContain("authorization");
    expect(JSON.parse(raw).connected).toBe(true);
  });
});
