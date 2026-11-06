import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunTelemetryStore } from "./run-telemetry.js";

const RUN = "f2c991f1-b53d-4bb5-b134-8e29d43815d0";
const ISSUE = "1b9c2019-b811-40a0-bd21-0365977a0001";
const LEASE = { runId: RUN, leaseId: "784d88a1-7a05-42d2-a7d8-e714d70f2d0b",
  deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f", generation: 1 };

describe("local run telemetry", () => {
  it("persists one finish UUID and one event UUID across a lost response", async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "run-events-")), "events.json");
    const first = new RunTelemetryStore(file, RUN, ISSUE, []);
    const finishId = await first.finishRequestId();
    await first.append("system", "info", "started");
    const ids: string[] = [];
    const client = { postLocalRunEvent: vi.fn(async (_lease, _issue, event) => {
      ids.push(event.clientRequestId);
      if (ids.length === 1) throw new Error("response lost");
    }) };
    await expect(first.flush(client, LEASE)).rejects.toThrow("response lost");
    const second = new RunTelemetryStore(file, RUN, ISSUE, []);
    expect(await second.finishRequestId()).toBe(finishId);
    await second.flush(client, LEASE);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    await second.flush(client, LEASE);
    expect(ids).toHaveLength(2);
  });

  it("redacts known secret values before persisting", async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "run-events-")), "events.json");
    const store = new RunTelemetryStore(file, RUN, ISSUE, ["private-token-123456"]);
    await store.append("system", "warn", "token private-token-123456");
    const saved = await readFile(file, "utf8");
    expect(saved).not.toContain("private-token-123456");
    expect(saved).toContain("[redacted]");
  });

  it("does not upload after cancellation", async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "run-events-")), "events.json");
    const store = new RunTelemetryStore(file, RUN, ISSUE, []);
    await store.append("system", "info", "started");
    const postLocalRunEvent = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(store.flush({ postLocalRunEvent }, LEASE, controller.signal)).rejects.toThrow("cancelled");
    expect(postLocalRunEvent).not.toHaveBeenCalled();
  });
});
