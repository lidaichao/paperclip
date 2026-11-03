import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Dispatcher, retryDelayMs, selectEligibleIssues } from "./dispatcher.js";
import { StateStore } from "./state-store.js";
import type { BridgeAgentConfig, BridgeInboxItem } from "./types.js";

const agent = (id: string, name: string): BridgeAgentConfig => ({
  remoteAgentId: id,
  remoteAgentName: name,
  localAgentName: name,
  adapterType: "codex_local",
  maxConcurrentRuns: 1,
});

const issue = (overrides: Partial<BridgeInboxItem> = {}): BridgeInboxItem => ({
  id: "issue-1",
  companyId: "company-1",
  projectId: null,
  identifier: "PAP-1",
  title: "任务",
  status: "todo",
  priority: "medium",
  assigneeAgentId: "agent-1",
  updatedAt: "2026-11-03T00:00:00.000Z",
  activeRunId: null,
  ...overrides,
});

describe("dispatcher scheduling", () => {
  it("orders eligible tasks by priority, age, and identifier", () => {
    const selected = selectEligibleIssues([
      issue({ id: "4", identifier: "PAP-4", priority: "critical", activeRunId: "active" }),
      issue({ id: "3", identifier: "PAP-3", priority: "high", updatedAt: "2026-11-03T02:00:00.000Z" }),
      issue({ id: "2", identifier: "PAP-2", priority: "high", updatedAt: "2026-11-03T01:00:00.000Z" }),
      issue({ id: "1", identifier: "PAP-1", priority: "low" }),
      issue({ id: "5", identifier: "PAP-5", status: "blocked" }),
    ]);
    expect(selected.map((item) => item.identifier)).toEqual(["PAP-2", "PAP-3", "PAP-1"]);
  });

  it("uses bounded retry delays", () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([5_000, 15_000, 45_000, 120_000, 300_000, 300_000]);
  });

  it("launches at most one task per agent and does not relaunch an unchanged task", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-dispatcher-"));
    const state = new StateStore(path.join(dir, "state.json"));
    await state.load();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async ({ onSpawn }: { onSpawn(meta: { pid: number; startedAt: string }): Promise<void> }) => {
      await onSpawn({ pid: process.pid, startedAt: "2026-11-03T00:00:00.000Z" });
      await gate;
      return { succeeded: true, errorCode: null };
    });
    const dispatcher = new Dispatcher({
      companyId: "company-1",
      agents: [agent("agent-1", "Luna")],
      state,
      dependencies: {
        clientFor: () => ({ listInbox: async () => [issue()] }),
        run,
      },
    });

    expect((await dispatcher.cycle()).launched).toEqual(["PAP-1"]);
    expect((await dispatcher.cycle()).launched).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await dispatcher.waitForIdle();
    expect((await dispatcher.cycle()).launched).toEqual([]);
  });

  it("rotates agent polling order fairly", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alice-round-robin-"));
    const state = new StateStore(path.join(dir, "state.json"));
    await state.load();
    const seen: string[] = [];
    const agents = [agent("agent-1", "Luna"), agent("agent-2", "Rabbit")];
    const dispatcher = new Dispatcher({
      companyId: "company-1",
      agents,
      state,
      dependencies: {
        clientFor: (configured) => ({ listInbox: async () => { seen.push(configured.remoteAgentId); return []; } }),
        run: async () => ({ succeeded: true, errorCode: null }),
      },
    });
    await dispatcher.cycle();
    await dispatcher.cycle();
    expect(seen).toEqual(["agent-1", "agent-2", "agent-2", "agent-1"]);
  });
});
