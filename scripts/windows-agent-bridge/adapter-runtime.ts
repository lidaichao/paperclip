import type { LocalReviewContext } from "./paperclip-client.js";
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
  wakeReason?: string;
  apiBase: string;
  remoteCompanyId: string;
  remoteAgentId: string;
  remoteAgentName: string;
  issue: BridgeInboxItem;
  reviewContext?: LocalReviewContext;
  token: string;
  localAgent: LocalAgentRuntimeConfig;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onEvent?: (event: { eventType: string; stream?: "stdout" | "stderr" | "system";
    level?: "info" | "warn" | "error"; message?: string }) => Promise<void>;
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
  summary?: string | null;
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
  const reviewerRun = input.wakeReason === "issue_completion_review";
  if (input.issue.companyId !== input.remoteCompanyId ||
    (reviewerRun ? !input.reviewContext ||
      input.reviewContext.issue.id !== input.issue.id ||
      input.reviewContext.review.reviewerAgentId !== input.remoteAgentId ||
      input.reviewContext.review.sourceAgentId !== input.issue.assigneeAgentId ||
      input.issue.assigneeAgentId === input.remoteAgentId ||
      input.issue.status !== "in_review"
      : input.reviewContext !== undefined || input.issue.assigneeAgentId !== input.remoteAgentId)) {
    throw new Error("refusing to run a task assigned to a different Alice identity or review lease");
  }
  if (input.localAgent.adapterType !== "codex_local" && input.localAgent.adapterType !== "cursor") {
    throw new Error("unsupported local adapter type");
  }

  const requestedApiBase = input.apiBase.replace(/\/+$/, "");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(requestedApiBase)) {
    throw new Error("local run API must be a loopback capability");
  }
  const previousApiBase = process.env.PAPERCLIP_API_URL;
  process.env.PAPERCLIP_API_URL = requestedApiBase;

  const execute = input.localAgent.adapterType === "codex_local"
    ? input.dependencies?.codexExecute ?? executeCodex
    : input.dependencies?.cursorExecute ?? executeCursor;
  const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
    await input.onLog?.(stream, redactToken(chunk, input.token));
  };
  const cwd = requiredString(input.localAgent.adapterConfig, "cwd", "local adapter config");
  const reviewerPrompt = [
    "You are the designated completion reviewer for this one Paperclip task.",
    "Read the task and review brief with GET /api/issues/$PAPERCLIP_TASK_ID on PAPERCLIP_API_URL.",
    "Verify the delivered work against the original requirement and acceptance criteria.",
    "Submit exactly one decision with POST /api/issues/$PAPERCLIP_TASK_ID/review-decision,",
    "JSON {\"outcome\":\"accepted\"|\"rejected\",\"summary\":\"specific evidence and reason\"}.",
    "This run may not edit the source task or post an ordinary comment.",
    "Only finish after the decision endpoint confirms the receipt.",
  ].join("\n");
  const sourcePrompt = [
    "You are the source agent for this one locally claimed Paperclip task.",
    "Read its current details with GET /api/issues/$PAPERCLIP_TASK_ID on PAPERCLIP_API_URL.",
    "Do the assigned work in your local workspace. The API capability only permits this task's",
    "plain comments and title, description, or priority edits while the lease is live.",
    "For a dispatched plan child in an open PO work package, after the work is",
    "done POST /api/issues/$PAPERCLIP_TASK_ID/child-complete with JSON",
    "{\"expectedStatusVersion\":number,\"summary\":\"specific delivery evidence\"}.",
    "Take expectedStatusVersion from the current GET response. Wait for a prepared",
    "receipt, then end the process; the server marks done only after it stops.",
    "The parent PO and defect QA use separate contracts;",
    "For a dispatched parent PO, read GET",
    "/api/issues/$PAPERCLIP_TASK_ID/work-package-context to inspect the current",
    "acceptance cycle, child deliveries and QA results. The verdict write",
    "contract is not available yet; report the decision as a blocker and do not",
    "mark the parent done or use child-complete.",
    "do not use child-complete for them or mark any work-record task done with PATCH.",
    "The completion-review handoff applies only to ordinary native tasks, not",
    "to tasks dispatched from plan or defect work records.",
    "For an ordinary native task whose deliverable is ready and which identifies",
    "a distinct reviewer agent UUID,",
    "POST /api/issues/$PAPERCLIP_TASK_ID/completion-review-handoff with JSON",
    "{\"reviewerAgentId\":\"UUID\",\"prompt\":\"specific acceptance check\",\"body\":\"plain handoff summary\"}.",
    "Wait for the handoff receipt before ending. Do not mark the task done yourself.",
    "If no authorized reviewer is identified or work is incomplete, report the blocker;",
    "a run without an accepted handoff is returned to a recoverable blocked state.",
  ].join("\n");
  const existingPrompt = typeof input.localAgent.adapterConfig.promptTemplate === "string"
    ? input.localAgent.adapterConfig.promptTemplate.trim() : "";
  const adapterConfig = {
    ...input.localAgent.adapterConfig,
    promptTemplate: [existingPrompt, reviewerRun ? reviewerPrompt : sourcePrompt]
      .filter(Boolean).join("\n\n"),
  };

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
        adapterConfig,
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: input.issue.identifier,
      },
      config: adapterConfig,
      context: {
        taskId: input.issue.id,
        issueId: input.issue.id,
        wakeReason: input.wakeReason ?? "assignment",
        ...(reviewerRun ? { paperclipTaskMarkdown: [
          `# ${input.issue.identifier} — ${input.issue.title}`,
          `Review request: ${input.reviewContext!.review.prompt}`,
          `Source handoff: ${input.reviewContext!.review.handoffSummary}`,
          `Original description: ${input.reviewContext!.issue.description ?? "(none)"}`,
        ].join("\n\n") } : {}),
        conversationMode: false,
        paperclipWorkspace: {
          cwd,
          source: "agent_home",
          agentHome: cwd,
        },
      },
      onLog,
      onMeta: async () => undefined,
      onEvent: async (event) => input.onEvent?.({ eventType: event.eventType, stream: event.stream,
        level: event.level, message: event.message ? redactToken(event.message, input.token) : undefined }),
      onSpawn: input.onSpawn,
      authToken: input.token,
    });
  } catch {
    throw new Error("local agent adapter execution failed");
  } finally {
    if (previousApiBase === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = previousApiBase;
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
    summary: typeof result.summary === "string" ? redactToken(result.summary, input.token) : null,
  };
}

