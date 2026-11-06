import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runLocalAgent } from "./adapter-runtime.js";
import { runLeaseSession } from "./lease-session.js";
import { LocalCommentIntentStore, startLocalRunWriteProxy } from "./local-run-write-proxy.js";
import { RunTelemetryStore } from "./run-telemetry.js";
import type { AliceClient, LocalRunClaim } from "./paperclip-client.js";
import type { BridgeAgentConfig, BridgeInboxItem, LocalAgentRuntimeConfig } from "./types.js";

type LocalRunner = typeof runLocalAgent;
type StopProcessTree = (pid: number, startedAt: string) => Promise<void>;
const execFileAsync = promisify(execFile);

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface WindowsProcessIdentity { parentPid: number; createdAt: string }

async function inspectWindowsProcess(pid: number): Promise<WindowsProcessIdentity | null> {
  const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; ` +
    `if ($null -ne $p) { [pscustomobject]@{ parentPid = [int]$p.ParentProcessId; ` +
    `createdAt = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command], {
    windowsHide: true, timeout: 5_000,
  });
  return result.stdout.trim() ? JSON.parse(result.stdout) as WindowsProcessIdentity : null;
}

/** Kill only the direct child reported by this adapter invocation, never a reused PID. */
export async function stopWindowsProcessTree(pid: number, startedAt: string, options: {
  platform?: NodeJS.Platform;
  inspect?: (pid: number) => Promise<WindowsProcessIdentity | null>;
  kill?: (pid: number) => Promise<void>;
  alive?: (pid: number) => boolean;
} = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== "win32" || !Number.isSafeInteger(pid) || pid <= 0 ||
    Number.isNaN(Date.parse(startedAt))) {
    throw new Error("Windows child process identity is required for cancellation");
  }
  const alive = options.alive ?? processIsAlive;
  if (!alive(pid)) return;
  const identity = await (options.inspect ?? inspectWindowsProcess)(pid);
  if (!identity) return;
  const started = Date.parse(startedAt);
  const created = Date.parse(identity.createdAt);
  if (identity.parentPid !== process.pid || Number.isNaN(created) || created > started + 1000) {
    // The original child has exited and Windows may have reused its PID.
    return;
  }
  if (created > started || created < started - 2_000) {
    throw new Error("Windows child process identity is ambiguous; refusing to kill or confirm stop");
  }
  if (alive(pid)) {
    try {
      if (options.kill) await options.kill(pid);
      else await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true, timeout: 5_000,
        });
    } catch {
      // The child may have exited between the liveness check and taskkill.
      // Only the final liveness check below decides whether stop is confirmed.
    }
  }
  for (let attempt = 0; attempt < 20 && alive(pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (alive(pid)) throw new Error("local process tree stop was not confirmed");
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
  intentFile: string;
  signal?: AbortSignal;
  runner?: LocalRunner;
  stopProcessTree?: StopProcessTree;
  renewIntervalMs?: number;
  stopTimeoutMs?: number;
}): Promise<{ outcome: "succeeded" | "failed" | "cancelled"; status: string }> {
  if (input.claim.agentId !== input.agent.remoteAgentId || input.localAgent.id !== input.agent.remoteAgentId) {
    throw new Error("claimed run is for a different agent");
  }
  const reviewContext = input.claim.wakeReason === "issue_completion_review"
    ? await input.client.readLocalReviewContext(input.claim, input.deviceId) : undefined;
  const issue: BridgeInboxItem = reviewContext?.issue ?? await input.client.getClaimedIssue(input.claim);
  if (issue.companyId !== input.companyId || issue.id !== input.claim.issueId) {
    throw new Error("claimed run is for a different company or issue");
  }
  const runner = input.runner ?? runLocalAgent;
  const stopProcessTree = input.stopProcessTree ?? stopWindowsProcessTree;
  let telemetry: RunTelemetryStore | undefined;
  let summary: string | undefined;
  return await runLeaseSession({
    client: {
      renewLocalRun: (lease) => input.client.renewLocalRun(lease),
      controlLocalRun: (lease) => input.client.controlLocalRun(lease),
      finishLocalRun: async (lease, outcome, exitCode) => {
        if (!telemetry) throw new Error("local run telemetry was not initialized");
        if (outcome !== "cancelled") await telemetry.flush(input.client, lease);
        return input.client.finishLocalRun(lease, outcome, exitCode, {
          clientRequestId: await telemetry.finishRequestId(),
          ...(outcome !== "cancelled" && summary ? { summary } : {}),
        });
      },
    },
    claim: input.claim,
    deviceId: input.deviceId,
    signal: input.signal,
    renewIntervalMs: input.renewIntervalMs,
    stopTimeoutMs: input.stopTimeoutMs,
    execute: async (signal) => {
      const proxy = await startLocalRunWriteProxy({
        client: input.client, claim: input.claim, deviceId: input.deviceId, signal,
        intentStore: new LocalCommentIntentStore(input.intentFile),
        reviewContext,
      });
      const secrets = [input.token, proxy.token, process.env[input.agent.gbrainEnvRef]];
      try {
        telemetry = new RunTelemetryStore(`${input.intentFile}.${input.claim.runId}.events.json`,
          input.claim.runId, input.claim.issueId, secrets);
        // Persist the finish identity before any model process is allowed to start.
        await telemetry.finishRequestId();
      } catch (error) {
        await proxy.close();
        throw error;
      }
      const pids = new Map<number, string>();
      const stopPromises = new Map<number, Promise<void>>();
      const stopPid = (pid: number) => {
        if (!stopPromises.has(pid)) {
          const stopping = stopProcessTree(pid, pids.get(pid)!);
          stopPromises.set(pid, stopping);
          // Keep rejection attached until we explicitly await all stop results.
          void stopping.catch(() => undefined);
        }
      };
      const stop = () => { for (const pid of pids.keys()) stopPid(pid); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        let telemetryError: unknown;
        await telemetry.append("system", "info", "local adapter started");
        if (signal.aborted) return { succeeded: false, exitCode: null };
        let outputObserved = false;
        const result = await runner({
          signal,
          runId: input.claim.runId,
          wakeReason: input.claim.wakeReason,
          apiBase: proxy.apiBase,
          remoteCompanyId: input.companyId,
          remoteAgentId: input.agent.remoteAgentId,
          remoteAgentName: input.agent.remoteAgentName,
          issue,
          reviewContext,
          token: proxy.token,
          localAgent: input.localAgent,
          // Raw model output may contain auth files, environment values or command
          // arguments. Keep stdout/stderr outside both the local journal and API.
          onLog: async () => {
            if (signal.aborted || outputObserved) return;
            outputObserved = true;
            try {
              await telemetry!.append("system", "info", "local adapter output observed");
              await telemetry!.flush(input.client, {
                deviceId: input.deviceId, runId: input.claim.runId, leaseId: input.claim.leaseId,
                generation: input.claim.generation,
              }, signal);
            } catch (error) {
              if (signal.aborted) return;
              telemetryError ??= error;
              stop();
              throw error;
            }
          },
          onEvent: async (event) => {
            if (signal.aborted) return;
            try {
              const safeEvent = event.eventType === "codex.auth_precedence_warning"
                ? "Codex authentication precedence warning" : "local adapter event";
              await telemetry!.append("system", event.level ?? "info", safeEvent);
              await telemetry!.flush(input.client, {
                deviceId: input.deviceId, runId: input.claim.runId, leaseId: input.claim.leaseId,
                generation: input.claim.generation,
              }, signal);
            } catch (error) {
              if (signal.aborted) return;
              telemetryError ??= error;
              stop();
              throw error;
            }
          },
          onSpawn: async (meta) => {
            if (!Number.isSafeInteger(meta.pid) || meta.pid <= 0) throw new Error("local adapter reported an invalid process");
            pids.set(meta.pid, meta.startedAt);
            if (signal.aborted) stopPid(meta.pid);
          },
        });
        if (telemetryError) throw telemetryError;
        const succeeded = result.succeeded && !proxy.writeFailed() &&
          (!reviewContext || proxy.decisionConfirmed());
        summary = succeeded ? "Local adapter completed successfully"
          : reviewContext && !proxy.decisionConfirmed()
            ? "Reviewer stopped without a committed decision"
            : proxy.writeFailed() ? "Local field write failed"
            : "Local adapter finished with an error";
        if (signal.aborted) {
          if (pids.size === 0) throw new Error("cancelled run has no reported process identity");
          stop();
          await Promise.all(stopPromises.values());
        }
        return { succeeded, exitCode: succeeded ? result.exitCode : result.exitCode ?? 1 };
      } finally {
        signal.removeEventListener("abort", stop);
        await proxy.close();
      }
    },
  });
}
