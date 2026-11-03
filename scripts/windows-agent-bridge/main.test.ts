import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSingleInstanceLock, waitForPollInterval, writeHealth } from "./main.js";

describe("bridge lifecycle", () => {
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
