import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaimStateStore } from "./claim-state.js";
import { claimAndRunOnce } from "./main.js";
import { AliceClient } from "./paperclip-client.js";
import type { LocalAgentRunInput } from "./adapter-runtime.js";

const agentId = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const companyId = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";
const deviceId = "8da47d3b-0a6e-49d4-9c26-17bc76de470f";
const runId = "f2c991f1-b53d-4bb5-b134-8e29d43815d0";
const issueId = "1b9c2019-b811-40a0-bd21-0365977a0001";
const leaseId = "784d88a1-7a05-42d2-a7d8-e714d70f2d0b";
const agent = { remoteAgentId: agentId, remoteAgentName: "Luna", localAgentName: "Luna",
  gbrainEnvRef: "GBRAIN_LUNA_TOKEN",
  adapterType: "codex_local" as const, localAdapterConfig: { cwd: "H:/AIagent/Luna", command: "C:/tools/codex.exe" },
  maxConcurrentRuns: 1 as const };
const localAgent = { id: agentId, companyId, name: "Luna", adapterType: "codex_local" as const,
  adapterConfig: agent.localAdapterConfig };

function reply(value: unknown): Response { return Response.json(value); }
function claimResponse() {
  return { runId, issueId, agentId, leaseId, generation: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    leaseTtlMs: 60_000,
    wakeReason: "assignment", workspacePolicy: "agent_home" };
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alice-claim-cycle-"));
  const file = path.join(dir, "claim.json");
  return { file, state: new ClaimStateStore(file, deviceId, agentId) };
}

describe("single-agent claim cycle", () => {
  it("persists the key before claim and rotates it only after the server confirms finish", async () => {
    const { file, state } = await fixture();
    let claimKey = "";
    const paths: string[] = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret", fetch: async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      paths.push(pathname);
      if (pathname === "/api/agents/me") return reply({ id: agentId, companyId, name: "Luna" });
      if (pathname.endsWith("/claim")) {
        claimKey = new Headers(init?.headers).get("idempotency-key") ?? "";
        expect(JSON.parse(await readFile(file, "utf8")).idempotencyKey).toBe(claimKey);
        return reply(claimResponse());
      }
      if (pathname === `/api/issues/${issueId}`) return reply({ id: issueId, companyId,
        assigneeAgentId: agentId, executionRunId: runId, identifier: "PAP-1", title: "只读验收", status: "in_progress",
        priority: "medium", updatedAt: "2026-11-06T03:00:00Z" });
      if (pathname.endsWith("/finish")) {
        expect(JSON.parse(await readFile(file, "utf8")).activeClaim.runId).toBe(runId);
        return reply({ runId, status: "succeeded" });
      }
      throw new Error(`unexpected path ${pathname}`);
    } });
    await client.verifyIdentity(agentId, companyId);
    const runner = vi.fn(async () => ({ runId, exitCode: 0, signal: null, timedOut: false,
      succeeded: true, errorCode: null, sessionParams: null, sessionDisplayId: null }));
    expect(await claimAndRunOnce({ client, state, deviceId, companyId, agent, localAgent,
      token: "secret", signal: new AbortController().signal, runner })).toBe("finished");
    expect(paths).toEqual(["/api/agents/me", "/api/agents/me/local-runs/claim", `/api/issues/${issueId}`,
      `/api/agents/me/local-runs/${runId}/finish`]);
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ runId }));
    expect(JSON.parse(await readFile(file, "utf8")).idempotencyKey).not.toBe(claimKey);
  });

  it("reuses the durable key after a lost claim response without starting a model", async () => {
    const { file, state } = await fixture();
    const keys: string[] = [];
    let request = 0;
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret", fetch: async (url, init) => {
      if (String(url).endsWith("/api/agents/me")) return reply({ id: agentId, companyId, name: "Luna" });
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (request++ === 0) throw new Error("connection dropped");
      return new Response(null, { status: 204 });
    } });
    await client.verifyIdentity(agentId, companyId);
    const runner = vi.fn();
    const input = { client, state, deviceId, companyId, agent, localAgent,
      token: "secret", signal: new AbortController().signal, runner };
    await expect(claimAndRunOnce(input)).rejects.toThrow("connection dropped");
    expect(await claimAndRunOnce(input)).toBe("idle");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(JSON.parse(await readFile(file, "utf8")).idempotencyKey).toBe(keys[0]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("cancels the model and waits for its stop before acknowledging finish", async () => {
    const { file, state } = await fixture();
    const events: string[] = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret", fetch: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/agents/me") return reply({ id: agentId, companyId, name: "Luna" });
      if (pathname.endsWith("/claim")) return reply(claimResponse());
      if (pathname === `/api/issues/${issueId}`) return reply({ id: issueId, companyId,
        assigneeAgentId: agentId, executionRunId: runId, identifier: "PAP-1", title: "只读验收", status: "in_progress",
        priority: "medium", updatedAt: "2026-11-06T03:00:00Z" });
      if (pathname.endsWith("/renew")) return reply({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: true });
      if (pathname.endsWith("/finish")) { events.push("finish"); return reply({ runId, status: "cancelled" }); }
      throw new Error(`unexpected path ${pathname}`);
    } });
    await client.verifyIdentity(agentId, companyId);
    const runner = vi.fn(async ({ signal, onSpawn }: LocalAgentRunInput) => {
      await onSpawn?.({ pid: 12345, processGroupId: null, startedAt: new Date().toISOString() });
      return new Promise<{
      runId: string; exitCode: null; signal: null; timedOut: false; succeeded: false;
      errorCode: null; sessionParams: null; sessionDisplayId: null;
    }>((resolve) => signal?.addEventListener("abort", () => {
      events.push("abort");
      setTimeout(() => { events.push("stopped"); resolve({ runId, exitCode: null, signal: null,
        timedOut: false, succeeded: false, errorCode: null, sessionParams: null, sessionDisplayId: null }); }, 1);
    }, { once: true }));
    });
    const stopProcessTree = vi.fn(async () => { events.push("tree-stop"); });
    expect(await claimAndRunOnce({ client, state, deviceId, companyId, agent, localAgent,
      token: "secret", signal: new AbortController().signal, runner,
      stopProcessTree, renewIntervalMs: 5 })).toBe("finished");
    expect(events).toEqual(["tree-stop", "abort", "stopped", "finish"]);
    expect(stopProcessTree).toHaveBeenCalledWith(12345);
    expect(JSON.parse(await readFile(file, "utf8")).activeClaim).toBeNull();
  });

  it("keeps the claim latched if the local process never confirms stop", async () => {
    const { file, state } = await fixture();
    const finish = vi.fn();
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret", fetch: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/agents/me") return reply({ id: agentId, companyId, name: "Luna" });
      if (pathname.endsWith("/claim")) return reply(claimResponse());
      if (pathname === `/api/issues/${issueId}`) return reply({ id: issueId, companyId,
        assigneeAgentId: agentId, executionRunId: runId, identifier: "PAP-1", title: "只读验收", status: "in_progress",
        priority: "medium", updatedAt: "2026-11-06T03:00:00Z" });
      if (pathname.endsWith("/renew")) return reply({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: true });
      if (pathname.endsWith("/finish")) { finish(); return reply({ runId, status: "cancelled" }); }
      throw new Error(`unexpected path ${pathname}`);
    } });
    await client.verifyIdentity(agentId, companyId);
    const runner = vi.fn(async ({ onSpawn }: LocalAgentRunInput) => {
      await onSpawn?.({ pid: 12345, processGroupId: null, startedAt: new Date().toISOString() });
      return new Promise<never>(() => undefined);
    });
    await expect(claimAndRunOnce({ client, state, deviceId, companyId, agent, localAgent,
      token: "secret", signal: new AbortController().signal, runner,
      stopProcessTree: async () => undefined,
      renewIntervalMs: 5, stopTimeoutMs: 5 })).rejects.toThrow("stop was not confirmed");
    expect(finish).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(file, "utf8")).activeClaim.runId).toBe(runId);
    await expect(new ClaimStateStore(file, deviceId, agentId).claimKey()).rejects.toThrow("manual recovery required");
  });
});
