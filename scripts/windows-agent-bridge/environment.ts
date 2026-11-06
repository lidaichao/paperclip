import path from "node:path";
import type { BridgeConfig } from "./types.js";
import { expectedGbrainIdentity } from "./gbrain-identity.js";

const OS_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "USERPROFILE", "HOMEDRIVE",
  "HOMEPATH", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "USERNAME", "USERDOMAIN",
]);

function nonEmpty(source: NodeJS.ProcessEnv, key: string): string | null {
  const entry = Object.entries(source).find(([name]) => name.toUpperCase() === key.toUpperCase());
  return entry && typeof entry[1] === "string" && entry[1].trim() ? entry[1] : null;
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
  env.CODEX_HOME = path.join(config.workerHome, "codex-home");
  env.PAPERCLIP_HOME = path.join(config.workerHome, "paperclip-home");
  return env;
}

/** A direct launch with the inherited user environment must fail closed. */
export function assertWorkerEnvironment(env: NodeJS.ProcessEnv, config: BridgeConfig): void {
  const ref = config.agents[0]?.gbrainEnvRef;
  if (config.agents.length !== 1) throw new Error("one worker requires exactly one agent");
  expectedGbrainIdentity(config.agents[0]);
  const allowed = new Set([...OS_KEYS, "GBRAIN_AGENT_TOKEN", ref, "HOME", "CODEX_HOME", "PAPERCLIP_HOME"]);
  if (!ref || !nonEmpty(env, ref) || nonEmpty(env, ref) !== nonEmpty(env, "GBRAIN_AGENT_TOKEN")) {
    throw new Error("worker GBrain identity is missing or mismatched");
  }
  for (const key of Object.keys(env)) {
    if (!allowed.has(key.toUpperCase())) throw new Error(`worker environment contains unapproved key ${key}`);
  }
  if (nonEmpty(env, "CODEX_HOME") !== path.join(config.workerHome, "codex-home") ||
    nonEmpty(env, "PAPERCLIP_HOME") !== path.join(config.workerHome, "paperclip-home") ||
    nonEmpty(env, "HOME") !== path.join(config.workerHome, "home")) {
    throw new Error("worker home identity is mismatched");
  }
}
