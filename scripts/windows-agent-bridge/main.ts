import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBridgeConfig } from "./config.js";
import { loadAgentTokens } from "./credentials.js";
import { AliceClient } from "./paperclip-client.js";
import { ClaimStateStore } from "./claim-state.js";
import { assertWorkerEnvironment, buildLocalAdapterConfig } from "./environment.js";
import { executeClaimedRun } from "./claimed-run.js";
import { runLocalAgent } from "./adapter-runtime.js";
import { verifyGbrainIdentity } from "./gbrain-identity.js";
import { acquireSingleInstanceLock } from "./single-instance-lock.js";
export { acquireSingleInstanceLock } from "./single-instance-lock.js";
import type { BridgeAgentConfig, LocalAgentRuntimeConfig } from "./types.js";

export interface BridgeHealth {
  schemaVersion: 1;
  connected: boolean;
  lastSuccessfulPollAt: string | null;
  agents: Record<string, { state: "idle" | "running" | "backoff" | "disabled"; activeTask: string | null }>;
  lastError: string | null;
  updatedAt: string;
}

export async function writeHealth(filePath: string, health: BridgeHealth): Promise<void> {
  const resolved = path.resolve(filePath);
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(resolved), { recursive: true });
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(health, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, resolved);
}

export async function waitForPollInterval(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "未知错误";
  return error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

export async function claimAndRunOnce(input: {
  client: AliceClient;
  state: ClaimStateStore;
  deviceId: string;
  companyId: string;
  agent: BridgeAgentConfig;
  localAgent: LocalAgentRuntimeConfig;
  token: string;
  intentFile: string;
  signal: AbortSignal;
  runner?: typeof runLocalAgent;
  stopProcessTree?: (pid: number, startedAt: string) => Promise<void>;
  renewIntervalMs?: number;
  stopTimeoutMs?: number;
}): Promise<"idle" | "finished"> {
  if (input.signal.aborted) return "idle";
  // The key must reach disk before POST. A lost response reuses the same key.
  const key = await input.state.claimKey();
  const claim = await input.client.claimLocalRun(input.deviceId, key);
  if (!claim) return "idle";
  // An interrupted or unconfirmed run stays latched on restart. Never spawn
  // another process merely because the server lease expired.
  await input.state.markClaimed(claim);
  await executeClaimedRun({
    claim, client: input.client, deviceId: input.deviceId,
    companyId: input.companyId, agent: input.agent, localAgent: input.localAgent,
    token: input.token, intentFile: input.intentFile, signal: input.signal, runner: input.runner,
    stopProcessTree: input.stopProcessTree,
    renewIntervalMs: input.renewIntervalMs, stopTimeoutMs: input.stopTimeoutMs,
  });
  await input.state.markFinished(claim.runId);
  return "finished";
}

function requireWriteFence(): void {
  throw new Error("Alice bridge write fencing is unavailable; local execution remains disabled");
}

export async function runBridge(configPath: string, signal: AbortSignal): Promise<"started" | "already-running"> {
  const config = await loadBridgeConfig(configPath);
  // Ordinary agent writes still lack a transaction-bound lease fence. Keep
  // installation and direct invocation disabled even though claim is wired.
  requireWriteFence();
  assertWorkerEnvironment(process.env, config);
  if (config.agents.length !== 1) throw new Error("pilot bridge requires exactly one local agent");
  const lock = await acquireSingleInstanceLock(`${config.stateFile}.lock`);
  if (!lock) return "already-running";
  const healthPath = `${config.stateFile}.health.json`;
  try {
    const agent = config.agents[0];
    const tokens = await loadAgentTokens(config.credentialsFile, [agent.remoteAgentId]);
    const token = tokens.get(agent.remoteAgentId);
    if (!token) throw new Error(`缺少 ${agent.remoteAgentName} 的凭据`);
    await verifyGbrainIdentity({ agent, endpoint: config.gbrainMcpUrl, token: process.env[agent.gbrainEnvRef] });
    const client = new AliceClient({ apiBase: config.apiBase, token });
    await client.verifyIdentity(agent.remoteAgentId, config.companyId, agent.remoteAgentName);
    const state = new ClaimStateStore(config.stateFile, config.deviceId, agent.remoteAgentId);
    const localAgent: LocalAgentRuntimeConfig = {
      id: agent.remoteAgentId, companyId: config.companyId, name: agent.localAgentName,
      adapterType: agent.adapterType, adapterConfig: buildLocalAdapterConfig(agent, config, process.env),
    };
    let lastSuccessfulPollAt: string | null = null;
    while (!signal.aborted) {
      // A failed cycle exits. The scheduled task must not repeatedly relaunch
      // an uncertain claim or a process whose stop was not confirmed.
      await claimAndRunOnce({ client, state, deviceId: config.deviceId,
        companyId: config.companyId, agent, localAgent, token, signal,
        intentFile: `${config.stateFile}.comment-intent.json` });
      lastSuccessfulPollAt = new Date().toISOString();
      await writeHealth(healthPath, {
        schemaVersion: 1,
        connected: true,
        lastSuccessfulPollAt,
        agents: { [agent.remoteAgentId]: { state: "idle", activeTask: null } },
        lastError: null,
        updatedAt: new Date().toISOString(),
      });
      await waitForPollInterval(config.pollIntervalMs, signal);
    }
    return "started";
  } finally {
    await lock.release();
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("用法：node main.js <config.json>");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const result = await runBridge(configPath, controller.signal);
  if (result === "already-running") process.stdout.write("Alice 智能体桥接已在运行。\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1; });
}
