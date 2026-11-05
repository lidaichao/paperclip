import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBridgeConfig } from "./config.js";
import { loadAgentTokens } from "./credentials.js";
import { AliceClient } from "./paperclip-client.js";
import { StateStore } from "./state-store.js";
import { Dispatcher } from "./dispatcher.js";
import { loadLocalAgentRuntimeConfig, runLocalAgent } from "./adapter-runtime.js";
import type { LocalAgentRuntimeConfig } from "./types.js";

interface LockDocument { pid: number; startedAt: string; token: string }

export interface BridgeLock {
  path: string;
  document: LockDocument;
  release(): Promise<void>;
}

export interface BridgeHealth {
  schemaVersion: 1;
  connected: boolean;
  lastSuccessfulPollAt: string | null;
  agents: Record<string, { state: "idle" | "running" | "backoff" | "disabled"; activeTask: string | null }>;
  lastError: string | null;
  updatedAt: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function acquireSingleInstanceLock(
  lockPath: string,
  options: { pid?: number; now?: () => Date; alive?: (pid: number) => boolean } = {},
): Promise<BridgeLock | null> {
  const resolved = path.resolve(lockPath);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const alive = options.alive ?? isProcessAlive;
  const document: LockDocument = { pid, startedAt: now().toISOString(), token: randomUUID() };
  await mkdir(path.dirname(resolved), { recursive: true });

  const create = async () => {
    const handle = await open(resolved, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  };

  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: Partial<LockDocument> = {};
    try { existing = JSON.parse(await readFile(resolved, "utf8")); } catch { /* stale or corrupt */ }
    if (typeof existing.pid === "number" && alive(existing.pid)) return null;
    await rm(resolved, { force: true });
    await create();
  }

  return {
    path: resolved,
    document,
    async release() {
      try {
        const current = JSON.parse(await readFile(resolved, "utf8")) as Partial<LockDocument>;
        if (current.token === document.token && current.pid === document.pid) await rm(resolved, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
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

export async function runBridge(configPath: string, signal: AbortSignal): Promise<"started" | "already-running"> {
  const config = await loadBridgeConfig(configPath);
  // This bridge has no server-issued run/checkout handshake. A local UUID
  // cannot authorize issue writes, so fail before a lock, poll, or agent spawn.
  throw new Error("Alice bridge run binding is unavailable; use a server-managed execution target");
  const lock = await acquireSingleInstanceLock(`${config.stateFile}.lock`);
  if (!lock) return "already-running";
  const healthPath = `${config.stateFile}.health.json`;
  const state = new StateStore(config.stateFile);
  await state.load();
  await state.recoverOrphans(isProcessAlive);
  const agentIds = config.agents.map((agent) => agent.remoteAgentId);
  const tokens = await loadAgentTokens(config.credentialsFile, agentIds);
  const clients = new Map<string, AliceClient>();
  const localAgents = new Map<string, LocalAgentRuntimeConfig>();

  try {
    for (const agent of config.agents) {
      const token = tokens.get(agent.remoteAgentId);
      if (!token) throw new Error(`缺少 ${agent.remoteAgentName} 的凭据`);
      const client = new AliceClient({ apiBase: config.apiBase, token });
      await client.verifyIdentity(agent.remoteAgentId, config.companyId);
      clients.set(agent.remoteAgentId, client);
      localAgents.set(agent.remoteAgentId, await loadLocalAgentRuntimeConfig({
        localApiBase: config.localApiBase,
        localCompanyId: config.localCompanyId,
        localAgentName: agent.localAgentName,
        expectedAdapterType: agent.adapterType,
      }));
    }

    const dispatcher = new Dispatcher({
      companyId: config.companyId,
      agents: config.agents,
      state,
      dependencies: {
        clientFor: (agent) => {
          const client = clients.get(agent.remoteAgentId);
          if (!client) throw new Error("Alice 客户端未初始化");
          return client;
        },
        run: async ({ agent, issue, onSpawn }) => {
          const token = tokens.get(agent.remoteAgentId);
          const localAgent = localAgents.get(agent.remoteAgentId);
          if (!token || !localAgent) throw new Error("智能体运行配置未初始化");
          return await runLocalAgent({
            signal,
            apiBase: config.apiBase,
            remoteCompanyId: config.companyId,
            remoteAgentId: agent.remoteAgentId,
            remoteAgentName: agent.remoteAgentName,
            issue,
            token,
            localAgent,
            onSpawn: async (meta) => onSpawn({ pid: meta.pid, startedAt: meta.startedAt }),
          });
        },
      },
    });

    let lastSuccessfulPollAt: string | null = null;
    while (!signal.aborted) {
      let lastError: string | null = null;
      try { await dispatcher.cycle(); lastSuccessfulPollAt = new Date().toISOString(); }
      catch (error) { lastError = safeError(error); }
      await writeHealth(healthPath, {
        schemaVersion: 1,
        connected: lastError === null,
        lastSuccessfulPollAt,
        agents: Object.fromEntries(config.agents.map((agent) => [agent.remoteAgentId, {
          state: dispatcher.activeCount > 0 ? "running" : "idle",
          activeTask: null,
        }])),
        lastError,
        updatedAt: new Date().toISOString(),
      });
      await waitForPollInterval(config.pollIntervalMs, signal);
    }
    await Promise.race([dispatcher.waitForIdle(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
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
