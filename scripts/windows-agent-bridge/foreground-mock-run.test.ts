import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeClaimedRun } from "./claimed-run.js";
import { runBridge } from "./main.js";
import { AliceClient, type LocalRunClaim } from "./paperclip-client.js";
import type { LocalAgentRunInput } from "./adapter-runtime.js";

const execFileAsync = promisify(execFile);
const AGENT_ID = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const COMPANY_ID = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";
const ISSUE_ID = "1b9c2019-b811-40a0-bd21-0365977a0001";
const RUN_ID = "f2c991f1-b53d-4bb5-b134-8e29d43815d0";
const DEVICE_ID = "8da47d3b-0a6e-49d4-9c26-17bc76de470f";
const claim: LocalRunClaim = {
  runId: RUN_ID, issueId: ISSUE_ID, agentId: AGENT_ID,
  leaseId: "784d88a1-7a05-42d2-a7d8-e714d70f2d0b", generation: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  leaseDeadlineMonotonicMs: performance.now() + 60_000,
  wakeReason: "assignment", workspacePolicy: "agent_home",
};
const agent = {
  remoteAgentId: AGENT_ID, remoteAgentName: "Luna", localAgentName: "Luna",
  gbrainEnvRef: "GBRAIN_LUNA_TOKEN", adapterType: "codex_local" as const,
  localAdapterConfig: { cwd: "H:/AIagent/Luna", command: "C:/tools/codex.exe" },
  maxConcurrentRuns: 1 as const,
};
const localAgent = { id: AGENT_ID, companyId: COMPANY_ID, name: "Luna",
  adapterType: "codex_local" as const, adapterConfig: agent.localAdapterConfig };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("single-member local foreground acceptance", () => {
  it.skipIf(process.platform !== "win32")("cancels a hidden mock model and confirms no visible window", async () => {
    const calls: string[] = [];
    let spawned!: () => void;
    const childStarted = new Promise<void>((resolve) => { spawned = resolve; });
    const client = new AliceClient({ apiBase: "http://alice.test", token: "fake-server-key", fetch: async (url) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(pathname);
      if (pathname === "/api/agents/me") return Response.json({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" });
      if (pathname === `/api/issues/${ISSUE_ID}`) return Response.json({ id: ISSUE_ID, companyId: COMPANY_ID,
        assigneeAgentId: AGENT_ID, executionRunId: RUN_ID, identifier: "PAP-20", title: "mock only",
        status: "in_progress", priority: "medium", updatedAt: "2026-11-06T03:00:00Z" });
      if (pathname.endsWith("/renew")) {
        await childStarted;
        return Response.json({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: true });
      }
      if (pathname.endsWith("/finish")) return Response.json({ runId: RUN_ID, status: "cancelled" });
      throw new Error(`unexpected mock route ${pathname}`);
    } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const dir = await mkdtemp(path.join(os.tmpdir(), "alice-foreground-mock-"));
    const intentFile = path.join(dir, "intent.json");
    let modelPid = 0;
    try {
      const runner = async (input: LocalAgentRunInput) => {
        const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          windowsHide: true, shell: false, stdio: "ignore",
          env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: process.env.PATH ?? "" },
        });
        modelPid = child.pid ?? 0;
        if (!modelPid) throw new Error("mock model did not spawn");
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        const startedAt = new Date().toISOString();
        await input.onSpawn?.({ pid: modelPid, processGroupId: null, startedAt });
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
          "-Command", `(Get-Process -Id ${modelPid}).MainWindowHandle`], { windowsHide: true, timeout: 5_000 });
        expect(stdout.trim()).toBe("0");
        spawned();
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
        return { runId: RUN_ID, exitCode: null, signal: null, timedOut: false,
          succeeded: false, errorCode: null, sessionParams: null, sessionDisplayId: null };
      };
      const result = await executeClaimedRun({ claim, client, deviceId: DEVICE_ID,
        companyId: COMPANY_ID, agent, localAgent, token: "fake-server-key", intentFile,
        runner, renewIntervalMs: 100, stopTimeoutMs: 15_000 });
      expect(result).toEqual({ outcome: "cancelled", status: "cancelled" });
      expect(alive(modelPid)).toBe(false);
      expect(calls.some((route) => route.endsWith("/renew"))).toBe(true);
      expect(calls.at(-1)).toBe(`/api/agents/me/local-runs/${RUN_ID}/finish`);
      const journal = await readFile(`${intentFile}.${RUN_ID}.events.json`, "utf8");
      expect(journal).not.toContain("fake-server-key");
      expect(journal).not.toContain(claim.leaseId);
    } finally {
      if (modelPid && alive(modelPid)) {
        await execFileAsync("taskkill.exe", ["/PID", String(modelPid), "/T", "/F"],
          { windowsHide: true, timeout: 5_000 }).catch(() => undefined);
      }
    }
  }, 30_000);

  it("keeps the real worker disabled before any API or credential access", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "alice-closed-gate-"));
    const configFile = path.join(dir, "config.json");
    await writeFile(configFile, JSON.stringify({ schemaVersion: 3, deviceId: DEVICE_ID,
      workerHome: path.join(dir, AGENT_ID), apiBase: "http://192.168.72.157:3100/",
      companyId: COMPANY_ID, credentialsFile: "missing.dpapi", pollIntervalMs: 10_000,
      agents: [agent] }), "utf8");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("network forbidden"); });
    try {
      await expect(runBridge(configFile, new AbortController().signal)).rejects.toThrow("explicit --pilot-once or --service mode");
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(readFile(path.join(dir, AGENT_ID, "claim-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { fetchSpy.mockRestore(); }
  });
});
