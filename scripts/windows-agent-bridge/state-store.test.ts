import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchLeaseKey, StateStore } from "./state-store.js";
import type { BridgeInboxItem } from "./types.js";

const AGENT_ID = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const COMPANY_ID = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";

function issue(): BridgeInboxItem {
  return {
    id: "issue-1",
    companyId: COMPANY_ID,
    projectId: null,
    identifier: "PAP-1",
    title: "实现功能",
    status: "todo",
    priority: "high",
    assigneeAgentId: AGENT_ID,
    updatedAt: "2026-11-03T10:00:00.000Z",
    activeRunId: null,
  };
}

async function storeAt(now = new Date("2026-11-03T10:10:00.000Z")): Promise<StateStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alice-bridge-state-"));
  const store = new StateStore(path.join(dir, "state.json"), { now: () => now });
  await store.load();
  return store;
}

describe("StateStore", () => {
  it("does not acquire the same task twice", async () => {
    const store = await storeAt();
    expect(await store.tryAcquire(issue(), AGENT_ID)).toBe(true);
    expect(await store.tryAcquire(issue(), AGENT_ID)).toBe(false);
  });

  it("recovers a running record only when its pid is gone", async () => {
    const store = await storeAt();
    const task = issue();
    await store.tryAcquire(task, AGENT_ID);
    const leaseKey = dispatchLeaseKey(task, AGENT_ID);
    await store.markRunning(leaseKey, { pid: 4123 });
    expect(await store.recoverOrphans(() => false)).toEqual([task.id]);
    expect(store.snapshot().records[leaseKey]?.status).toBe("retryable");
  });

  it("keeps a live process running", async () => {
    const store = await storeAt();
    const task = issue();
    await store.tryAcquire(task, AGENT_ID);
    const leaseKey = dispatchLeaseKey(task, AGENT_ID);
    await store.markRunning(leaseKey, { pid: 4123 });
    expect(await store.recoverOrphans((pid) => pid === 4123)).toEqual([]);
    expect(store.snapshot().records[leaseKey]?.status).toBe("running");
  });
});

