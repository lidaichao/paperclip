import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../../packages/adapter-utils/src/types.js";
import { execute as executeCodex } from "../../packages/adapters/codex-local/src/server/index.js";
import { execute as executeCursor } from "../../packages/adapters/cursor-local/src/server/index.js";
import type {
  BridgeAdapterType,
  BridgeInboxItem,
  LocalAgentRuntimeConfig,
} from "./types.js";

const SAFE_ADAPTER_CONFIG_KEYS = new Set([
  "cwd",
  "mode",
  "model",
  "effort",
  "engine",
  "search",
  "command",
  "variant",
  "fastMode",
  "graceSec",
  "extraArgs",
  "args",
  "timeoutSec",
  "paperclipSkillSync",
  "instructionsFilePath",
  "instructionsRootPath",
  "modelReasoningEffort",
  "instructionsEntryFile",
  "instructionsBundleMode",
  "dangerouslyBypassApprovalsAndSandbox",
]);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LocalAdapterExecute = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

export interface AdapterRuntimeDependencies {
  codexExecute?: LocalAdapterExecute;
  cursorExecute?: LocalAdapterExecute;
  fetch?: typeof globalThis.fetch;
}

export interface LocalAgentRunInput {
  signal?: AbortSignal;
  runId: string;
  apiBase: string;
  remoteCompanyId: string;
  remoteAgentId: string;
  remoteAgentName: string;
  issue: BridgeInboxItem;
  token: string;
  localAgent: LocalAgentRuntimeConfig;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  dependencies?: AdapterRuntimeDependencies;
}

export interface LocalAgentRunResult {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  succeeded: boolean;
  errorCode: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}.${key} is missing`);
  }
  return value.trim();
}

function sanitizeAdapterConfig(value: unknown, adapterType: BridgeAdapterType): Record<string, unknown> {
  const source = asRecord(value);
  // The local API returns binding descriptors, not resolved secret values.
  // Silently dropping env would launch members without their GR identity.
  if (source.env != null && (typeof source.env !== "object" || Array.isArray(source.env) || Object.keys(source.env).length > 0)) {
    throw new Error("local adapter env bindings require a verified secret-resolution path");
  }
  const config: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (SAFE_ADAPTER_CONFIG_KEYS.has(key)) config[key] = structuredClone(entry);
  }
  const cwd = requiredString(config, "cwd", "local adapter config");
  if (!path.isAbsolute(cwd) && !path.win32.isAbsolute(cwd)) {
    throw new Error("local adapter config.cwd must be absolute");
  }
  const command = requiredString(config, "command", "local adapter config");
  if (!path.isAbsolute(command) && !path.win32.isAbsolute(command)) {
    throw new Error("local adapter config.command must be absolute");
  }
  if (adapterType === "cursor" && typeof config.model !== "string") {
    throw new Error("Cursor local adapter config.model is missing");
  }
  return config;
}

export async function loadLocalAgentRuntimeConfig(input: {
  localApiBase: string;
  localCompanyId: string;
  localAgentName: string;
  expectedAdapterType: BridgeAdapterType;
  fetch?: typeof globalThis.fetch;
}): Promise<LocalAgentRuntimeConfig> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  try {
    const response = await fetchImpl(
      `${input.localApiBase.replace(/\/+$/, "")}/api/companies/${encodeURIComponent(input.localCompanyId)}/agents`,
      { method: "GET", headers: { accept: "application/json" }, signal: controller.signal },
    );
    if (!response.ok) throw new Error(`local Paperclip returned HTTP ${response.status}`);
    const raw = await response.json();
    if (!Array.isArray(raw)) throw new Error("local Paperclip returned an invalid agent list");
    const candidate = raw
      .map(asRecord)
      .find((agent) => typeof agent.name === "string" && agent.name.localeCompare(input.localAgentName, undefined, { sensitivity: "accent" }) === 0);
    if (!candidate) throw new Error(`local agent ${input.localAgentName} was not found`);
    const adapterType = requiredString(candidate, "adapterType", "local agent") as BridgeAdapterType;
    if (adapterType !== input.expectedAdapterType) {
      throw new Error(`local agent ${input.localAgentName} adapter type mismatch`);
    }
    return {
      id: requiredString(candidate, "id", "local agent"),
      companyId: requiredString(candidate, "companyId", "local agent"),
      name: requiredString(candidate, "name", "local agent"),
      adapterType,
      adapterConfig: sanitizeAdapterConfig(candidate.adapterConfig, adapterType),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("local Paperclip agent lookup timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function redactToken(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

export async function runLocalAgent(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
  if (typeof input.runId !== "string" || !RUN_ID_PATTERN.test(input.runId)) {
    throw new Error("valid server-issued Paperclip run id is required before local execution");
  }
  if (input.issue.assigneeAgentId !== input.remoteAgentId || input.issue.companyId !== input.remoteCompanyId) {
    throw new Error("refusing to run a task assigned to a different Alice identity");
  }
  if (input.localAgent.adapterType !== "codex_local" && input.localAgent.adapterType !== "cursor") {
    throw new Error("unsupported local adapter type");
  }

  const configuredApiBase = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "");
  const requestedApiBase = input.apiBase.replace(/\/+$/, "");
  if (configuredApiBase && configuredApiBase !== requestedApiBase) {
    throw new Error("PAPERCLIP_API_URL is already bound to a different server");
  }
  process.env.PAPERCLIP_API_URL = requestedApiBase;

  const execute = input.localAgent.adapterType === "codex_local"
    ? input.dependencies?.codexExecute ?? executeCodex
    : input.dependencies?.cursorExecute ?? executeCursor;
  const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
    await input.onLog?.(stream, redactToken(chunk, input.token));
  };
  const cwd = requiredString(input.localAgent.adapterConfig, "cwd", "local adapter config");

  let result: AdapterExecutionResult;
  try {
    result = await execute({
      signal: input.signal,
      runId: input.runId,
      agent: {
        id: input.remoteAgentId,
        companyId: input.remoteCompanyId,
        name: input.remoteAgentName,
        adapterType: input.localAgent.adapterType,
        adapterConfig: input.localAgent.adapterConfig,
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: input.issue.identifier,
      },
      config: input.localAgent.adapterConfig,
      context: {
        taskId: input.issue.id,
        issueId: input.issue.id,
        wakeReason: "assignment",
        conversationMode: false,
        paperclipWorkspace: {
          cwd,
          source: "agent_home",
          agentHome: cwd,
        },
      },
      onLog,
      onMeta: async () => undefined,
      onEvent: async () => undefined,
      onSpawn: input.onSpawn,
      authToken: input.token,
    });
  } catch {
    throw new Error("local agent adapter execution failed");
  }

  return {
    runId: input.runId,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    succeeded: result.exitCode === 0 && !result.timedOut && !result.errorCode,
    errorCode: result.errorCode ?? null,
    sessionParams: result.sessionParams ?? null,
    sessionDisplayId: result.sessionDisplayId ?? null,
  };
}

