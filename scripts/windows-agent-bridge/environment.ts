import path from "node:path";
import os from "node:os";
import type { BridgeAgentConfig, BridgeConfig } from "./types.js";
import { expectedGbrainIdentity } from "./gbrain-identity.js";
import { normalizeLocalProxyUrl } from "./config.js";

const OS_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "PROGRAMDATA", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH",
  "LOGONSERVER", "SYSTEMDRIVE",
]);

function nonEmpty(source: NodeJS.ProcessEnv, key: string): string | null {
  const entry = Object.entries(source).find(([name]) => name.toUpperCase() === key.toUpperCase());
  return entry && typeof entry[1] === "string" && entry[1].trim() ? entry[1] : null;
}

function workerProxyBypass(config: BridgeConfig): string {
  const hosts = new Set(["127.0.0.1", "localhost", "::1", new URL(config.apiBase).hostname]);
  if (config.gbrainMcpUrl) hosts.add(new URL(config.gbrainMcpUrl).hostname);
  return [...hosts].join(",");
}

function codexHome(config: BridgeConfig): string {
  return config.modelAuthMode === "shared_user_codex"
    ? path.join(os.userInfo().homedir, ".codex") : path.join(config.workerHome, "codex-home");
}

function cursorConfigDir(config: BridgeConfig): string {
  return config.modelAuthMode === "shared_user_cursor"
    ? path.join(os.userInfo().homedir, ".cursor") : path.join(config.workerHome, "home", ".cursor");
}

/** The parser never accepts adapter env from private JSON; inject only this trusted path. */
export function buildLocalAdapterConfig(agent: BridgeAgentConfig, config: BridgeConfig,
  env: NodeJS.ProcessEnv): Record<string, unknown> {
  if (agent.adapterType === "cursor") {
    if (env.HOME !== path.join(config.workerHome, "home") || env.CURSOR_HOME !== cursorConfigDir(config)) {
      throw new Error("Cursor home identity is mismatched");
    }
    return { ...agent.localAdapterConfig, env: { HOME: env.HOME, CURSOR_HOME: env.CURSOR_HOME,
      ...(config.modelAuthMode === "shared_user_cursor" ? { CURSOR_CONFIG_DIR: env.CURSOR_CONFIG_DIR } : {}) } };
  }
  if (env.CODEX_HOME !== codexHome(config)) throw new Error("Codex home identity is mismatched");
  return { ...agent.localAdapterConfig, env: { CODEX_HOME: env.CODEX_HOME },
    ...(config.modelAuthMode === "shared_user_codex" ? { externalCodexHomeNoManagedWrites: true } : {}) };
}

/** The launcher keeps a source token only long enough to build one child env. */
export function buildWorkerEnvironment(source: NodeJS.ProcessEnv, config: BridgeConfig, loadedToken?: string): NodeJS.ProcessEnv {
  if (config.agents.length !== 1) throw new Error("one worker requires exactly one agent");
  expectedGbrainIdentity(config.agents[0]);
  const ref = config.agents[0].gbrainEnvRef;
  const token = config.agents[0].gbrainCredentialFile ? loadedToken : nonEmpty(source, ref);
  if (!token) throw new Error(`configured GBrain credential reference ${ref} is unavailable`);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (OS_KEYS.has(key.toUpperCase()) && typeof value === "string") env[key] = value;
  }
  env.GBRAIN_AGENT_TOKEN = token;
  env[ref] = token;
  env.HOME = path.join(config.workerHome, "home");
  env.USERPROFILE = env.HOME;
  const homeRoot = path.parse(env.HOME).root;
  env.HOMEDRIVE = homeRoot.replace(/[\\/]$/, "");
  env.HOMEPATH = env.HOME.slice(env.HOMEDRIVE.length);
  env.CODEX_HOME = codexHome(config);
  env.CURSOR_HOME = cursorConfigDir(config);
  if (config.modelAuthMode === "shared_user_cursor") env.CURSOR_CONFIG_DIR = env.CURSOR_HOME;
  env.PAPERCLIP_HOME = path.join(config.workerHome, "paperclip-home");
  env.APPDATA = path.join(config.workerHome, "appdata");
  env.LOCALAPPDATA = path.join(config.workerHome, "localappdata");
  env.TEMP = path.join(config.workerHome, "temp");
  env.TMP = env.TEMP;
  env.XDG_CONFIG_HOME = path.join(config.workerHome, "config");
  if (config.localProxyUrl) {
    const proxy = normalizeLocalProxyUrl(config.localProxyUrl);
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.ALL_PROXY = proxy;
    env.NO_PROXY = workerProxyBypass(config);
  }
  return env;
}

/** A direct launch with the inherited user environment must fail closed. */
export function assertWorkerEnvironment(env: NodeJS.ProcessEnv, config: BridgeConfig): void {
  const ref = config.agents[0]?.gbrainEnvRef;
  if (config.agents.length !== 1) throw new Error("one worker requires exactly one agent");
  expectedGbrainIdentity(config.agents[0]);
  const allowed = new Set([...OS_KEYS, "GBRAIN_AGENT_TOKEN", ref, "HOME", "USERPROFILE", "CODEX_HOME", "CURSOR_HOME", "PAPERCLIP_HOME",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "XDG_CONFIG_HOME", "CURSOR_CONFIG_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
  if (!ref || !nonEmpty(env, ref) || nonEmpty(env, ref) !== nonEmpty(env, "GBRAIN_AGENT_TOKEN")) {
    throw new Error("worker GBrain identity is missing or mismatched");
  }
  for (const key of Object.keys(env)) {
    if (!allowed.has(key.toUpperCase())) throw new Error(`worker environment contains unapproved key ${key}`);
  }
  if (config.localProxyUrl) {
    const proxy = normalizeLocalProxyUrl(config.localProxyUrl);
    if (nonEmpty(env, "HTTP_PROXY") !== proxy ||
      nonEmpty(env, "HTTPS_PROXY") !== proxy ||
      nonEmpty(env, "ALL_PROXY") !== proxy ||
      nonEmpty(env, "NO_PROXY") !== workerProxyBypass(config)) {
      throw new Error("worker proxy configuration is mismatched");
    }
  } else if (["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].some((key) => nonEmpty(env, key))) {
    throw new Error("worker proxy was not explicitly configured");
  }
  if (nonEmpty(env, "CURSOR_CONFIG_DIR") !== (config.modelAuthMode === "shared_user_cursor" ? cursorConfigDir(config) : null)) {
    throw new Error("Cursor config directory is mismatched");
  }
  if (nonEmpty(env, "CODEX_HOME") !== codexHome(config) ||
    nonEmpty(env, "CURSOR_HOME") !== cursorConfigDir(config) ||
    nonEmpty(env, "PAPERCLIP_HOME") !== path.join(config.workerHome, "paperclip-home") ||
    nonEmpty(env, "HOME") !== path.join(config.workerHome, "home") ||
    nonEmpty(env, "USERPROFILE") !== path.join(config.workerHome, "home") ||
    nonEmpty(env, "APPDATA") !== path.join(config.workerHome, "appdata") ||
    nonEmpty(env, "LOCALAPPDATA") !== path.join(config.workerHome, "localappdata") ||
    nonEmpty(env, "TEMP") !== path.join(config.workerHome, "temp") ||
    nonEmpty(env, "TMP") !== path.join(config.workerHome, "temp") ||
    nonEmpty(env, "XDG_CONFIG_HOME") !== path.join(config.workerHome, "config")) {
    throw new Error("worker home identity is mismatched");
  }
  const homeRoot = path.parse(path.join(config.workerHome, "home")).root;
  if (nonEmpty(env, "HOMEDRIVE") !== homeRoot.replace(/[\\/]$/, "") ||
    nonEmpty(env, "HOMEPATH") !== path.join(config.workerHome, "home").slice(homeRoot.replace(/[\\/]$/, "").length)) {
    throw new Error("worker Windows home identity is mismatched");
  }
}
