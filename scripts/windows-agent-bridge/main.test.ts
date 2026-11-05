import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSingleInstanceLock, runBridge, waitForPollInterval, writeHealth } from "./main.js";

describe("bridge lifecycle", () => {
  it("refuses to start before any lock or poll while no server run binding exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-run-binding-"));
    const stateFile = path.join(dir, "state.json");
    const configFile = path.join(dir, "bridge.json");
    await writeFile(configFile, JSON.stringify({
      schemaVersion: 2,
      deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
      apiBase: "http://192.168.72.157:3100",
      companyId: "af8e9089-b0bb-43ac-ade3-c029c73b96e6",
      credentialsFile: "credentials.dpapi",
      stateFile,
      pollIntervalMs: 10_000,
      agents: [{
        remoteAgentId: "38a5808c-47f3-4029-bdfe-0d84504bdc8a",
        remoteAgentName: "Luna",
        localAgentName: "Luna",
        adapterType: "codex_local",
        localAdapterConfig: { cwd: "H:/AIagent/Luna", command: "C:/tools/codex.exe" },
        maxConcurrentRuns: 1,
      }],
    }));
    await expect(runBridge(configFile, new AbortController().signal)).rejects.toThrow("run binding is unavailable");
    await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only one healthy lock owner and safely replaces a stale lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-lock-"));
    const lockPath = path.join(dir, "bridge.lock");
    const first = await acquireSingleInstanceLock(lockPath, { pid: 101, alive: (pid) => pid === 101 });
    expect(first).not.toBeNull();
    expect(await acquireSingleInstanceLock(lockPath, { pid: 202, alive: (pid) => pid === 101 })).toBeNull();
    await writeFile(lockPath, JSON.stringify({ pid: 303, startedAt: "old", token: "stale" }));
    const replacement = await acquireSingleInstanceLock(lockPath, { pid: 202, alive: () => false });
    expect(replacement?.document.pid).toBe(202);
    await first?.release();
    expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(202);
    await replacement?.release();
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
