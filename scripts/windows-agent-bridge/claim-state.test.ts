import { mkdtemp, readFile } from "node:fs/promises";
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
});
