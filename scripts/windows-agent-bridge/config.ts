import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeAdapterType, BridgeAgentConfig, BridgeConfig } from "./types.js";

const ROOT_KEYS = new Set([
  "schemaVersion",
  "apiBase",
  "companyId",
  "localApiBase",
  "localCompanyId",
  "credentialsFile",
  "stateFile",
  "pollIntervalMs",
  "agents",
]);

const AGENT_KEYS = new Set([
  "remoteAgentId",
  "remoteAgentName",
  "localAgentName",
  "adapterType",
  "maxConcurrentRuns",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function resolveConfigPath(configDir: string, raw: string, label: string): string {
  const resolved = path.resolve(configDir, raw);
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must resolve to an absolute path`);
  return resolved;
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
    adapterType: adapterType as BridgeAdapterType,
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
  if (record.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const apiBase = normalizeApiBase(requiredString(record, "apiBase", "config"));
  const localApiBase = requiredString(record, "localApiBase", "config");
  if (localApiBase !== "http://127.0.0.1:3100") {
    throw new Error("localApiBase must be exactly http://127.0.0.1:3100");
  }
  if (!Number.isInteger(record.pollIntervalMs) || Number(record.pollIntervalMs) < 5_000 || Number(record.pollIntervalMs) > 300_000) {
    throw new Error("pollIntervalMs must be an integer between 5000 and 300000");
  }
  if (!Array.isArray(record.agents) || record.agents.length === 0) {
    throw new Error("agents must be a non-empty array");
  }
  const agents = record.agents.map(parseAgent);
  assertUniqueAgents(agents);
  const configDir = path.dirname(absoluteConfigPath);

  return {
    schemaVersion: 1,
    apiBase,
    companyId: requiredUuid(record, "companyId", "config"),
    localApiBase,
    localCompanyId: requiredUuid(record, "localCompanyId", "config"),
    credentialsFile: resolveConfigPath(configDir, requiredString(record, "credentialsFile", "config"), "credentialsFile"),
    stateFile: resolveConfigPath(configDir, requiredString(record, "stateFile", "config"), "stateFile"),
    pollIntervalMs: Number(record.pollIntervalMs),
    agents,
  };
}

