import { describe, expect, it, vi } from "vitest";
import { executeClaimedRun, stopWindowsProcessTree } from "./claimed-run.js";
import { AliceClient, type LocalRunClaim } from "./paperclip-client.js";
import type { LocalAgentRunInput } from "./adapter-runtime.js";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const AGENT_ID = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const COMPANY_ID = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";
const ISSUE_ID = "1b9c2019-b811-40a0-bd21-0365977a0001";
const RUN_ID = "f2c991f1-b53d-4bb5-b134-8e29d43815d0";
const DEVICE_ID = "8da47d3b-0a6e-49d4-9c26-17bc76de470f";
const claim: LocalRunClaim = {
  runId: RUN_ID, issueId: ISSUE_ID, agentId: AGENT_ID,
  leaseId: "784d88a1-7a05-42d2-a7d8-e714d70f2d0b", generation: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), wakeReason: "assignment", workspacePolicy: "agent_home",
  leaseDeadlineMonotonicMs: performance.now() + 60_000,
};
const agent = {
  remoteAgentId: AGENT_ID, remoteAgentName: "Luna", localAgentName: "Luna",
  gbrainEnvRef: "GBRAIN_LUNA_TOKEN",
  adapterType: "codex_local" as const,
  localAdapterConfig: { cwd: "H:/AIagent/Luna", command: "C:/tools/codex.exe" }, maxConcurrentRuns: 1 as const,
};
const localAgent = { id: AGENT_ID, companyId: COMPANY_ID, name: "Luna",
  adapterType: "codex_local" as const, adapterConfig: agent.localAdapterConfig };

describe("claimed local run", () => {
  it("never kills a PID reused by a different Windows process", async () => {
    const kill = vi.fn(async () => undefined);
    await stopWindowsProcessTree(12345, "2026-11-06T10:00:00.000Z", {
      platform: "win32", alive: () => true, kill,
      inspect: async () => ({ parentPid: process.pid, createdAt: "2026-11-06T10:00:05.000Z" }),
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous same-millisecond PID identity without killing it", async () => {
    const kill = vi.fn(async () => undefined);
    await expect(stopWindowsProcessTree(12345, "2026-11-06T10:00:00.000Z", {
      platform: "win32", alive: () => true, kill,
      inspect: async () => ({ parentPid: process.pid, createdAt: "2026-11-06T10:00:00.500Z" }),
    })).rejects.toThrow("ambiguous");
    expect(kill).not.toHaveBeenCalled();
  });
  it("passes the true server run ID into the local adapter and then finishes", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "server-only-key-123456", fetch: async (url, init) => {
      calls.push(String(url));
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      if (String(url).endsWith("/api/agents/me")) return Response.json({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" });
      if (String(url).endsWith(`/api/issues/${ISSUE_ID}`)) return Response.json({ id: ISSUE_ID, companyId: COMPANY_ID,
        assigneeAgentId: AGENT_ID, executionRunId: RUN_ID, identifier: "PAP-20", title: "只读验收", status: "in_progress", priority: "medium",
        updatedAt: "2026-11-06T03:00:00Z" });
      if (String(url).includes(`/local-runs/${RUN_ID}/control`)) return Response.json({ action: "continue", generation: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
      return Response.json({ runId: RUN_ID, status: "succeeded" });
    } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const runner = vi.fn(async (_input: LocalAgentRunInput) => {
      await _input.onLog?.("stdout", `started ${_input.token}\n`);
      await _input.onEvent?.({ eventType: "work", message: "step complete" });
      return { runId: RUN_ID, exitCode: 0, signal: null, timedOut: false,
        succeeded: true, errorCode: null, sessionParams: null, sessionDisplayId: null,
        summary: `finished ${_input.token}` };
    });
    const intentFile = path.join(await mkdtemp(path.join(os.tmpdir(), "alice-write-")), "intent.json");
    const result = await executeClaimedRun({ claim, client, deviceId: DEVICE_ID, companyId: COMPANY_ID,
      agent, localAgent, token: "server-only-key-123456", intentFile, runner });
    expect(result.outcome).toBe("succeeded");
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, issue: expect.objectContaining({ id: ISSUE_ID }) }));
    const adapterInput = runner.mock.calls[0]?.[0] as { token: string; apiBase: string };
    expect(adapterInput.token).not.toBe("server-only-key-123456");
    expect(adapterInput.apiBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(adapterInput)).not.toContain(claim.leaseId);
    expect(calls.some((url) => url.endsWith(`/api/agents/me/local-runs/${RUN_ID}/finish`))).toBe(true);
    expect(calls.filter((url) => url.endsWith(`/api/agents/me/local-runs/${RUN_ID}/events`))).toHaveLength(2);
    expect(JSON.stringify(bodies)).not.toContain(adapterInput.token);
    expect(JSON.stringify(bodies)).not.toContain("server-only-key-123456");
    expect((await readFile(`${intentFile}.${RUN_ID}.events.json`, "utf8"))).not.toContain(adapterInput.token);
  });

  it("rejects a claim for another agent without running a model", async () => {
    const runner = vi.fn();
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret", fetch: async () => { throw new Error("no network expected"); } });
    await expect(executeClaimedRun({ claim: { ...claim, agentId: ISSUE_ID }, client,
      deviceId: DEVICE_ID, companyId: COMPANY_ID, agent, localAgent, token: "secret", intentFile: "unused", runner }))
      .rejects.toThrow("different agent");
    expect(runner).not.toHaveBeenCalled();
  });
});
