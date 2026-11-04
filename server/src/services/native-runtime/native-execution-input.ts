import { buildNativeContinuationPrompt } from "./native-continuation.js";
import type {
  NativeAcpxAgent,
  NativeAcpxPermissionMode,
  NativeCodexApprovalPolicy,
  NativeExecutionInputV4,
  NativeInteractionResponseEnvelope,
  NativeOpenCodePermissionMode,
  NativePlanningContext,
  NativeRuntimeContextSnapshot,
  StrictCompletionContractInput,
} from "../../vendor/paperclip-runner/index.js";
import {
  parseNativeExecutionInput,
  resolveQualifiedAcpxProfile,
} from "../../vendor/paperclip-runner/index.js";
import {
  isPaperclipExternalChatContractTurn,
  isPaperclipExternalChatQuestionResponseTurn,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";

const NATIVE_GITHUB_ATTACHMENT_RECOVERY_GUIDANCE = [
  "## GitHub 附件恢复导航",
  "Alice 负责不可用 GitHub 附件的恢复导航。仅当当前来源仍获授权且存在安全配置的管理面板 URL 时，Alice 才可在已接受的答复后追加经过认证的任务链接；模型不能选择或授权该链接。",
  "提示或工具结果中没有任务 URL，并不代表无法提供任务链接；不能仅因看不到 URL 就声称链接不可用。不要编造 URL，也不要承诺链接会出现。请简要说明输入不可用，并请用户将文件直接附加到此 Alice 任务，或粘贴所需文本。绝不能推测文件内容，也不能用旧文件替代。",
].join("\n");

/** Closed constructor: callers cannot spread legacy context or environment data. */
export function buildNativeExecutionInput(input: {
  companyId: string;
  runId: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    workMode: string;
  };
  taskPrompt: string;
  initialCommunicationGuidance?: string | null;
  /**
   * The already-sanitized Paperclip wake envelope for this run. Native drivers
   * receive a closed execution input rather than the legacy adapter context,
   * so the constructor must deliberately project the same bounded wake delta
   * that legacy adapters place in their provider prompt.
   */
  wakePayload?: unknown;
  resumedSession?: boolean;
  previousTurn?: { runId: string; task: { title: string; description: string | null } } | null;
  conversationMode?: boolean;
  agentId: string;
  workspace: {
    id: string;
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  normalizedSessionId: string | null;
  provider?: "codex" | "opencode" | "claude_managed" | "aws_agentcore" | "acpx";
  acpxAgent?: NativeAcpxAgent;
  codexApprovalPolicy?: NativeCodexApprovalPolicy;
  opencodePermissionMode?: NativeOpenCodePermissionMode;
  acpxPermissionMode?: NativeAcpxPermissionMode;
  model?: string | null;
  managedProfile?: Extract<
    NativeExecutionInputV4["provider"],
    { kind: "claude_managed" }
  >["managedProfile"];
  maxSessionListCostUsd?: number;
  agentCoreProfile?: Extract<
    NativeExecutionInputV4["provider"],
    { kind: "aws_agentcore" }
  >["agentCoreProfile"];
  maxEstimatedSessionCostUsd?: number;
  invocationLimits?: Extract<
    NativeExecutionInputV4["provider"],
    { kind: "aws_agentcore" }
  >["invocationLimits"];
  lifecyclePolicy?: NativeExecutionInputV4["session"]["lifecyclePolicy"];
  executionMode?: "default" | "plan";
  planningContext?: NativePlanningContext | null;
  interactionResponses?: NativeInteractionResponseEnvelope[];
  completionContract: {
    id: string;
    sha256: string;
    schemaVersion: string;
    contract: StrictCompletionContractInput;
  };
  runtimeContext: NativeRuntimeContextSnapshot;
}): NativeExecutionInputV4 {
  if (input.issue.workMode !== "standard" && input.issue.workMode !== "planning" && input.issue.workMode !== "ask") {
    throw new Error("native_execution_input_invalid: issue work mode must be standard, planning, or ask");
  }
  const executionMode = input.executionMode
    ?? (input.issue.workMode === "planning" ? "plan" : "default");
  const acpxProfile = input.provider === "acpx"
    ? resolveQualifiedAcpxProfile(
        input.acpxAgent ?? "codex",
        input.model ?? "",
      )
    : null;
  // Answers are materialized from the authoritative interaction only for this
  // invocation; do not persist a duplicate answer in the durable wake snapshot.
  const wake =
    input.wakePayload &&
    typeof input.wakePayload === "object" &&
    !Array.isArray(input.wakePayload)
      ? (input.wakePayload as Record<string, unknown>)
      : null;
  const question = wake?.externalChatQuestionResponse
    ? input.interactionResponses?.find(
        (response) =>
          response.interactionId === wake.interactionId &&
          response.kind === "ask_user_questions" &&
          response.response.status === "answered",
      )
    : null;
  const answerResult = question?.response.result as
    Record<string, unknown> | undefined;
  // The server supplies only the revalidated answer chain, in source order.
  // Keep prior choices available even when this continuation starts a fresh
  // provider session; never recover them from model prose or a transcript.
  const answerChain = question
    ? input.interactionResponses?.filter((response) =>
        response.kind === "ask_user_questions" &&
        response.response.status === "answered" &&
        typeof (response.response.result as Record<string, unknown> | undefined)
          ?.summaryMarkdown === "string")
    : null;
  const answerSummary =
    answerChain && answerChain.length > 1 &&
    answerChain.at(-1)?.interactionId === question?.interactionId
      ? answerChain.map((response, index) => {
          const label = index === answerChain.length - 1
            ? "最近已回答问题" : `较早答复 ${index + 1}`;
          return `${label}:\n${(response.response.result as Record<string, unknown>).summaryMarkdown}`;
        }).join("\n\n")
      : answerResult?.summaryMarkdown;
  const wakePayload =
    question && typeof answerSummary === "string"
      ? {
          ...wake,
          questionResponse: {
            interactionId: question.interactionId,
            summaryMarkdown: answerSummary,
          },
        }
      : input.wakePayload;
  const wakePrompt = renderPaperclipWakePrompt(wakePayload, {
    resumedSession: false,
    conversationMode: input.conversationMode === true,
    suppressIssueDescription: input.taskPrompt.trim().length > 0,
    nativeWakeReaderAvailable: true,
  });
  const externalChatTurn =
    isPaperclipExternalChatContractTurn(wakePayload) ||
    isPaperclipExternalChatQuestionResponseTurn(wakePayload);
  const taskPrompt = [
    wakePrompt,
    // Durable task questions must survive the current provider turn.
    // Keep routing visible before deferred tool discovery; usage belongs in the tool schema.
    "请使用 Alice 的 request_human_input 提出需要持久保留的任务问题。",
    externalChatTurn && wake?.externalChatProvider === "github"
      ? NATIVE_GITHUB_ATTACHMENT_RECOVERY_GUIDANCE
      : "",
    input.taskPrompt.trim(),
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
  return parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v4",
    ...(input.initialCommunicationGuidance ? { initialCommunicationGuidance: input.initialCommunicationGuidance } : {}),
    ...(input.resumedSession && input.previousTurn && !input.conversationMode ? {
      continuationPrompt: buildNativeContinuationPrompt({
        wakePayload: input.wakePayload,
        previousRunId: input.previousTurn.runId,
        previousIssue: input.previousTurn.task,
        allowExternalChat: true,
        issue: input.issue,
      }),
    } : {}),
    executionMode,
    planningContext: input.planningContext ?? null,
    binding: {
      companyId: input.companyId,
      runId: input.runId,
      issueId: input.issue.id,
      agentId: input.agentId,
      executionWorkspaceId: input.workspace.id,
    },
    task: {
      identifier: input.issue.identifier ?? input.issue.id,
      // The issue title is durable background context and may itself contain an
      // exact-output instruction from the thread's first message. Repeating it
      // as the native turn title can override a newer provider message in small
      // models. Keep the canonical title and description in task.prompt as
      // explicitly labeled background, but give authenticated external-chat
      // turns neutral structured fields.
      title: externalChatTurn ? "外部聊天后续消息" : input.issue.title,
      description: externalChatTurn ? null : input.issue.description,
      prompt: taskPrompt,
      workMode: input.issue.workMode,
    },
    workspace: {
      cwd: input.workspace.cwd,
      repoUrl: input.workspace.repoUrl,
      repoRef: input.workspace.repoRef,
      branchName: input.workspace.branchName,
    },
    session: {
      normalizedSessionId: input.normalizedSessionId,
      driverKind: input.provider === "opencode"
        ? "opencode_server"
        : input.provider === "claude_managed"
          ? "claude_managed_agents_api"
          : input.provider === "aws_agentcore"
            ? "aws_agentcore_harness_api"
        : input.provider === "acpx"
            ? "acpx_runtime"
            : "codex_app_server",
      protocolVersion: 1,
      lifecyclePolicy: input.lifecyclePolicy ?? { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: input.provider === "claude_managed"
      ? {
          kind: "claude_managed",
          model: input.model,
          managedProfile: input.managedProfile,
          maxSessionListCostUsd: input.maxSessionListCostUsd,
        }
      : input.provider === "aws_agentcore"
        ? {
            kind: "aws_agentcore",
            model: input.model,
            agentCoreProfile: input.agentCoreProfile,
            maxEstimatedSessionCostUsd: input.maxEstimatedSessionCostUsd,
            invocationLimits: input.invocationLimits,
          }
      : input.provider === "acpx"
      ? {
          kind: "acpx",
          agent: acpxProfile!.agent,
          model: input.model,
          permissionMode: input.acpxPermissionMode ?? "approve-all",
          profile: {
            driverKind: acpxProfile!.driverKind,
            protocolVersion: acpxProfile!.protocolVersion,
            acpxVersion: acpxProfile!.acpxVersion,
            agent: acpxProfile!.agent,
            agentProfileVersion: acpxProfile!.agentProfileVersion,
            agentServerPackage: acpxProfile!.agentServerPackage,
            agentServerVersion: acpxProfile!.agentServerVersion,
            agentRuntimePackage: acpxProfile!.agentRuntimePackage,
            agentRuntimeVersion: acpxProfile!.agentRuntimeVersion,
            commandDigest: acpxProfile!.commandDigest,
          },
        }
      : input.provider === "opencode"
        ? {
            kind: "opencode",
            model: input.model,
            permissionMode: input.opencodePermissionMode ?? "allow",
          }
        : {
            kind: "codex",
            model: input.model ?? null,
            approvalPolicy: input.codexApprovalPolicy ?? "never",
          },
    completionContract: input.completionContract,
    interactionResponses: input.interactionResponses ?? [],
    credentialBindings: [],
    runtimeContext: input.runtimeContext,
  }) as NativeExecutionInputV4;
}
