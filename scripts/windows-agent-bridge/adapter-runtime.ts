import type { LocalReviewContext } from "./paperclip-client.js";
import type { SupervisorBinding } from "./supervisor-client.js";
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
  supervisorBinding?: SupervisorBinding;
  localAgent: LocalAgentRuntimeConfig;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onEvent?: (event: { eventType: string; stream?: "stdout" | "stderr" | "system";
    level?: "info" | "warn" | "error"; message?: string }) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string;
    supervisor?: { nonce: string; receiptDir: string } }) => Promise<void>;
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
  const defectQaRun = input.wakeReason === "independent_defect_qa";
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
  if (input.supervisorBinding && (input.supervisorBinding.runId !== input.runId ||
    input.supervisorBinding.deviceId.length === 0)) {
    throw new Error("local supervisor binding does not match run");
  }
  const previousApiBase = process.env.PAPERCLIP_API_URL;
  const previousSupervisor = process.env.PAPERCLIP_LOCAL_RUN_SUPERVISOR;

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
    "Do the assigned work in your local workspace. The API capability permits only",
    "this task's plain comments and the completion or handoff contract for its role.",
    "For a dispatched plan child in an open PO work package, after the work is",
    "done POST /api/issues/$PAPERCLIP_TASK_ID/child-complete with JSON",
    "{\"expectedStatusVersion\":number,\"summary\":\"specific delivery evidence\"}.",
    "Take expectedStatusVersion from the current GET response. Wait for a prepared",
    "receipt, then end the process; the server marks done only after it stops.",
    "For a dispatched independent defect repair, POST",
    "/api/issues/$PAPERCLIP_TASK_ID/defect-repair-handoff with JSON",
    "{\"expectedStatusVersion\":number,\"summary\":\"specific repair evidence for QA\"}.",
    "Take expectedStatusVersion from GET issue, wait for a prepared receipt,",
    "then stop. The server assigns QA only after the repair process stops.",
    "The parent PO and defect QA use separate contracts.",
    "For a dispatched parent PO, read GET",
    "/api/issues/$PAPERCLIP_TASK_ID/work-package-context to inspect the current",
    "acceptance cycle, child deliveries and QA results. After checking the",
    "original requirement, submit POST /api/issues/$PAPERCLIP_TASK_ID/po-verdict",
    "with expectedStatusVersion from GET issue, cycleId, itemId and",
    "expectedCycleRevision from the package context, outcome approve or return,",
    "a specific reason, evidenceRefs and targetRecordIds. A return must target",
    "existing child records. Wait for a prepared receipt, then stop; the server",
    "commits the decision only after the model process stops. Never mark the",
    "parent done or use child-complete.",
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
  const defectQaPrompt = [
    "You are the designated QA agent for this one independently dispatched defect.",
    "Read GET /api/issues/$PAPERCLIP_TASK_ID and",
    "GET /api/issues/$PAPERCLIP_TASK_ID/defect-qa-context on PAPERCLIP_API_URL.",
    "Retest the original defect and the repair evidence in your local workspace.",
    "Submit exactly one decision with POST",
    "/api/issues/$PAPERCLIP_TASK_ID/defect-qa-verdict and JSON",
    "{\"expectedStatusVersion\":number,\"cycleId\":\"UUID\",\"itemId\":\"UUID\",",
    "\"expectedCycleRevision\":number,\"expectedItemRevision\":number,",
    "\"outcome\":\"pass\"|\"return\",\"summary\":\"specific retest evidence\",",
    "\"evidenceRefs\":[]}.",
    "Copy the IDs and revisions from the QA context; do not invent or edit them.",
    "This run cannot edit the issue or send an ordinary task completion.",
    "Stop only after the preparation receipt is confirmed. The final decision",
    "is committed only after the local model process has stopped.",
  ].join("\n");
  const existingPrompt = typeof input.localAgent.adapterConfig.promptTemplate === "string"
    ? input.localAgent.adapterConfig.promptTemplate.trim() : "";
  const adapterConfig = {
    ...input.localAgent.adapterConfig,
    promptTemplate: [existingPrompt, reviewerRun ? reviewerPrompt
      : defectQaRun ? defectQaPrompt : sourcePrompt]
      .filter(Boolean).join("\n\n"),
  };

  let result: AdapterExecutionResult;
  try {
    process.env.PAPERCLIP_API_URL = requestedApiBase;
    if (input.supervisorBinding) {
      process.env.PAPERCLIP_LOCAL_RUN_SUPERVISOR = JSON.stringify(input.supervisorBinding);
    }
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
    if (previousSupervisor === undefined) delete process.env.PAPERCLIP_LOCAL_RUN_SUPERVISOR;
    else process.env.PAPERCLIP_LOCAL_RUN_SUPERVISOR = previousSupervisor;
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

