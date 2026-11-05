import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runLocalAgent } from "./adapter-runtime.js";
import { runLeaseSession } from "./lease-session.js";
import type { AliceClient, LocalRunClaim } from "./paperclip-client.js";
import type { BridgeAgentConfig, BridgeInboxItem, LocalAgentRuntimeConfig } from "./types.js";

type LocalRunner = typeof runLocalAgent;
type StopProcessTree = (pid: number) => Promise<void>;
const execFileAsync = promisify(execFile);

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Kill the exact child reported by the adapter, including its descendants. */
export async function stopWindowsProcessTree(pid: number): Promise<void> {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Windows child process identity is required for cancellation");
  }
  if (processIsAlive(pid)) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true, timeout: 5_000,
      });
    } catch {
      // The child may have exited between the liveness check and taskkill.
      // Only the final liveness check below decides whether stop is confirmed.
    }
  }
  for (let attempt = 0; attempt < 20 && processIsAlive(pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processIsAlive(pid)) throw new Error("local process tree stop was not confirmed");
}

/** Execute exactly one already claimed server run; never infer ownership from inbox rows. */
export async function executeClaimedRun(input: {
  claim: LocalRunClaim;
  client: AliceClient;
  deviceId: string;
  companyId: string;
  agent: BridgeAgentConfig;
  localAgent: LocalAgentRuntimeConfig;
  token: string;
  signal?: AbortSignal;
  runner?: LocalRunner;
  stopProcessTree?: StopProcessTree;
  renewIntervalMs?: number;
  stopTimeoutMs?: number;
}): Promise<{ outcome: "succeeded" | "failed" | "cancelled"; status: string }> {
  if (input.claim.agentId !== input.agent.remoteAgentId || input.localAgent.id !== input.agent.remoteAgentId) {
    throw new Error("claimed run is for a different agent");
  }
  const issue: BridgeInboxItem = await input.client.getClaimedIssue(input.claim);
  if (issue.companyId !== input.companyId || issue.id !== input.claim.issueId) {
    throw new Error("claimed run is for a different company or issue");
  }
  const runner = input.runner ?? runLocalAgent;
  const stopProcessTree = input.stopProcessTree ?? stopWindowsProcessTree;
  return await runLeaseSession({
    client: input.client,
    claim: input.claim,
    deviceId: input.deviceId,
    signal: input.signal,
    renewIntervalMs: input.renewIntervalMs,
    stopTimeoutMs: input.stopTimeoutMs,
    execute: async (signal) => {
      let pid: number | null = null;
      let stopPromise: Promise<void> | null = null;
      const stop = () => {
        if (pid === null || stopPromise) return;
        stopPromise = stopProcessTree(pid);
        // Keep the rejection attached while the adapter's own promise settles.
        void stopPromise.catch(() => undefined);
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        const result = await runner({
          signal,
          runId: input.claim.runId,
          wakeReason: input.claim.wakeReason,
          apiBase: input.client.apiBase,
          remoteCompanyId: input.companyId,
          remoteAgentId: input.agent.remoteAgentId,
          remoteAgentName: input.agent.remoteAgentName,
          issue,
          token: input.token,
          localAgent: input.localAgent,
          onSpawn: async (meta) => {
            if (pid !== null) throw new Error("local adapter reported more than one process");
            pid = meta.pid;
            if (signal.aborted) stop();
          },
        });
        if (signal.aborted) {
          if (pid === null) throw new Error("cancelled run has no reported process identity");
          stop();
          await stopPromise;
        }
        return { succeeded: result.succeeded, exitCode: result.exitCode };
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },
  });
}
