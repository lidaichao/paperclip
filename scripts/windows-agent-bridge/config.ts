import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeAdapterType, BridgeAgentConfig, BridgeConfig } from "./types.js";
import { expectedGbrainIdentity } from "./gbrain-identity.js";

const ROOT_KEYS = new Set([
  "schemaVersion",
  "deviceId",
  "workerHome",
  "modelAuthMode",
  "apiBase",
  "localProxyUrl",
  "gbrainMcpUrl",
  "companyId",
  "credentialsFile",
  "supervisorExecutable",
  "pollIntervalMs",
  "agents",
]);

const AGENT_KEYS = new Set([
  "remoteAgentId",
  "remoteAgentName",
  "localAgentName",
  "gbrainEnvRef",
  "gbrainCredentialFile",
  "adapterType",
  "localAdapterConfig",
  "maxConcurrentRuns",
]);

const LOCAL_ADAPTER_KEYS = new Set([
  "cwd", "command", "model", "mode", "effort", "engine", "search",
  "variant", "fastMode", "graceSec", "timeoutSec", "paperclipSkillSync",
  "instructionsFilePath", "instructionsRootPath", "instructionsEntryFile",
  "instructionsBundleMode", "modelReasoningEffort",
  "dangerouslyBypassApprovalsAndSandbox",
  "extraArgs",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GBRAIN_ENV_REF = /^GBRAIN_[A-Z][A-Z0-9_]*_TOKEN$/;
const FORBIDDEN_SECRET_KEY = /(?:^|[_-])(api[_-]?key|token|secret)(?:$|[_-])/i;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNoInlineSecrets(value: unknown, location = "config"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInlineSecrets(entry, `${location}[${index}]`));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEY.test(key)) {
      throw new Error(`${location}.${key} is forbidden; store credentials only in credentialsFile`);
    }
    assertNoInlineSecrets(child, `${location}.${key}`);
  }
}

function assertKnownKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requiredUuid(record: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(record, key, label);
  if (!UUID_PATTERN.test(value)) throw new Error(`${label}.${key} must be a UUID`);
  return value.toLowerCase();
}

function normalizeApiBase(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("apiBase must be an absolute http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("apiBase must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("apiBase must not contain credentials, query parameters, or fragments");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeLocalProxyUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error("localProxyUrl must be an absolute loopback HTTP URL"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
    !parsed.port || parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash) {
    throw new Error("localProxyUrl must be an uncredentialed 127.0.0.1 HTTP URL with an explicit port");
  }
  return `http://127.0.0.1:${parsed.port}`;
}

function resolveConfigPath(configDir: string, raw: string, label: string): string {
  const resolved = path.resolve(configDir, raw);
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must resolve to an absolute path`);
  return resolved;
}

function parseLocalAdapterConfig(value: unknown, adapterType: BridgeAdapterType, label: string): Record<string, unknown> {
  const config = asRecord(value, label);
  assertKnownKeys(config, LOCAL_ADAPTER_KEYS, label);
  for (const key of ["cwd", "command"]) {
    const candidate = requiredString(config, key, label);
    if (!path.isAbsolute(candidate) && !path.win32.isAbsolute(candidate)) {
      throw new Error(`${label}.${key} must be an absolute local path`);
    }
  }
  for (const key of ["instructionsFilePath", "instructionsRootPath", "instructionsEntryFile"]) {
    if (config[key] === undefined) continue;
    const candidate = requiredString(config, key, label);
    if (!path.isAbsolute(candidate) && !path.win32.isAbsolute(candidate)) {
      throw new Error(`${label}.${key} must be an absolute local path`);
    }
  }
  if (adapterType === "cursor") requiredString(config, "model", label);
  const extraArgs = config.extraArgs;
  const permittedArgs = adapterType === "cursor"
    ? ["--trust", "--trust,--auto-review"]
    : ["--ignore-user-config,--ephemeral"];
  if (extraArgs !== undefined &&
    (!Array.isArray(extraArgs) || !permittedArgs.includes(extraArgs.join(",")))) {
    throw new Error(`${label}.extraArgs must match the approved ${adapterType} arguments`);
  }
  return structuredClone(config);
}

function parseAgent(value: unknown, index: number): BridgeAgentConfig {
  const label = `agents[${index}]`;
  const record = asRecord(value, label);
  assertKnownKeys(record, AGENT_KEYS, label);
  const adapterType = requiredString(record, "adapterType", label);
  if (adapterType !== "codex_local" && adapterType !== "cursor") {
    throw new Error(`${label}.adapterType must be codex_local or cursor`);
  }
  if (record.maxConcurrentRuns !== 1) {
    throw new Error(`${label}.maxConcurrentRuns must be exactly 1`);
  }

  return {
    remoteAgentId: requiredUuid(record, "remoteAgentId", label),
    remoteAgentName: requiredString(record, "remoteAgentName", label),
    localAgentName: requiredString(record, "localAgentName", label),
    gbrainEnvRef: requiredString(record, "gbrainEnvRef", label),
    ...(record.gbrainCredentialFile === undefined ? {} : {
      gbrainCredentialFile: requiredString(record, "gbrainCredentialFile", label),
    }),
    adapterType: adapterType as BridgeAdapterType,
    localAdapterConfig: parseLocalAdapterConfig(record.localAdapterConfig, adapterType as BridgeAdapterType, `${label}.localAdapterConfig`),
    maxConcurrentRuns: 1,
  };
}

function assertUniqueAgents(agents: BridgeAgentConfig[]): void {
  for (const [field, values] of [
    ["remoteAgentId", agents.map((agent) => agent.remoteAgentId)],
    ["remoteAgentName", agents.map((agent) => agent.remoteAgentName.toLocaleLowerCase())],
    ["localAgentName", agents.map((agent) => agent.localAgentName.toLocaleLowerCase())],
  ] as const) {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) throw new Error(`duplicate ${field}: ${value}`);
      seen.add(value);
    }
  }
}

export async function loadBridgeConfig(configPath: string): Promise<BridgeConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const rawText = await readFile(absoluteConfigPath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error("bridge config is not valid JSON");
  }

  assertNoInlineSecrets(raw);
  const record = asRecord(raw, "config");
  assertKnownKeys(record, ROOT_KEYS, "config");
  if (record.schemaVersion !== 3) throw new Error("schemaVersion must be 3");
  const apiBase = normalizeApiBase(requiredString(record, "apiBase", "config"));
  if (!Number.isInteger(record.pollIntervalMs) || Number(record.pollIntervalMs) < 5_000 || Number(record.pollIntervalMs) > 300_000) {
    throw new Error("pollIntervalMs must be an integer between 5000 and 300000");
  }
  if (!Array.isArray(record.agents) || record.agents.length !== 1) {
    throw new Error("one bridge process requires exactly one agent");
  }
  const agents = record.agents.map(parseAgent);
  assertUniqueAgents(agents);
  expectedGbrainIdentity(agents[0]);
  const configDir = path.dirname(absoluteConfigPath);
  if (agents[0].gbrainCredentialFile) {
    const candidate = agents[0].gbrainCredentialFile;
    if (!path.isAbsolute(candidate) && !path.win32.isAbsolute(candidate)) {
      throw new Error("gbrainCredentialFile must be an absolute member-local path");
    }
    agents[0].gbrainCredentialFile = path.resolve(candidate);
  }
  const workerHomeRaw = requiredString(record, "workerHome", "config");
  if (!path.isAbsolute(workerHomeRaw) && !path.win32.isAbsolute(workerHomeRaw)) {
    throw new Error("workerHome must be an absolute local path");
  }
  const workerHome = resolveConfigPath(configDir, workerHomeRaw, "workerHome");
  if (path.basename(workerHome).toLowerCase() !== agents[0].remoteAgentId) {
    throw new Error("workerHome must end with the configured agent ID");
  }
  if (!GBRAIN_ENV_REF.test(agents[0].gbrainEnvRef) || agents[0].gbrainEnvRef === "GBRAIN_AGENT_TOKEN") {
    throw new Error("gbrainEnvRef must name one member-specific GBRAIN_*_TOKEN variable");
  }
  const modelAuthMode = record.modelAuthMode ?? "private";
  if (modelAuthMode !== "private" && modelAuthMode !== "shared_user_codex" && modelAuthMode !== "shared_user_cursor") {
    throw new Error("modelAuthMode must be private, shared_user_codex or shared_user_cursor");
  }
  if (modelAuthMode === "shared_user_codex" && agents[0].adapterType !== "codex_local") {
    throw new Error("shared_user_codex is only supported for codex_local agents");
  }
  if (modelAuthMode === "shared_user_cursor" && agents[0].adapterType !== "cursor") {
    throw new Error("shared_user_cursor is only supported for cursor agents");
  }

  return {
    schemaVersion: 3,
    deviceId: requiredUuid(record, "deviceId", "config"),
    workerHome,
    modelAuthMode,
    apiBase,
    localProxyUrl: record.localProxyUrl === undefined ? undefined :
      normalizeLocalProxyUrl(requiredString(record, "localProxyUrl", "config")),
    gbrainMcpUrl: typeof record.gbrainMcpUrl === "string"
      ? normalizeApiBase(record.gbrainMcpUrl) : undefined,
    companyId: requiredUuid(record, "companyId", "config"),
    credentialsFile: resolveConfigPath(configDir, requiredString(record, "credentialsFile", "config"), "credentialsFile"),
    supervisorExecutable: record.supervisorExecutable === undefined ? undefined :
      resolveConfigPath(configDir, requiredString(record, "supervisorExecutable", "config"), "supervisorExecutable"),
    stateFile: path.join(workerHome, "claim-state.json"),
    pollIntervalMs: Number(record.pollIntervalMs),
    agents,
  };
}

