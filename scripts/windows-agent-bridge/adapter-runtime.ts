import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../../packages/adapter-utils/src/types.js";
import { execute as executeCodex } from "../../packages/adapters/codex-local/src/server/index.js";
import { execute as executeCursor } from "../../packages/adapters/cursor-local/src/server/index.js";
import type {
  BridgeInboxItem,
  LocalAgentRuntimeConfig,
} from "./types.js";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LocalAdapterExecute = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

export interface AdapterRuntimeDependencies {
  codexExecute?: LocalAdapterExecute;
  cursorExecute?: LocalAdapterExecute;
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

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}.${key} is missing`);
  }
  return value.trim();
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

