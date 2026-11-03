import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import {
  agentLinkRow,
  keyValueRow,
  runLinkRow,
  systemNoticePresentation,
  type NoticeMetadataRow,
  type NoticeMetadataSection,
} from "./notice-format.js";

// Short human-readable body plus the presentation header for one recovery
// family. The escalation path merges in the metadata rows only it knows
// (recovery action, owner, source run) via buildStrandedRecoveryEscalationNotice.
export type StrandedRecoveryNoticeSeed = {
  body: string;
  title: string;
  tone: IssueCommentPresentation["tone"];
  nextAction?: string;
};

export type StrandedRecoveryEscalationNotice = {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
};

export const DEFAULT_STRANDED_RECOVERY_NOTICE_BODY =
  "Alice 无法自动恢复此任务的有效执行路径。" +
  "已将其移至 `blocked` 状态，以便人工介入。";

const DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE = "自动恢复受阻";

const STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE: Record<string, string> = {
  workspace_validation_failed: "工作区验证失败",
  configuration_incomplete: "配置不完整",
  execution_review_participant_recovery: "评审恢复停滞",
};

// Titles keyed by the source run's classified error code. The raw failure text
// never reaches the issue thread (summarizeRunFailureForIssueComment withholds
// it), so the classified code is the only safe, specific cause the collapsed
// notice row can lead with. A mapped code outranks the seed titles because the
// seeds describe the recovery family ("No live execution path"), not the cause.
const STRANDED_RECOVERY_NOTICE_TITLES_BY_RUN_ERROR_CODE: Record<string, string> = {
  provider_quota: "错误：已达到用量上限",
  claude_auth_required: "错误：尚未登录 Claude",
  acpx_auth_required: "错误：需要登录智能体账户",
};

const WORKSPACE_SCAN_NOTICES: Record<string, { title: string; nextAction: string }> = {
  workspace_git_scan_timeout: { title: "工作区扫描超时", nextAction: "检查仓库访问权限和服务器负载，然后重试任务。" },
  workspace_git_scan_saturated: { title: "工作区扫描队列已满", nextAction: "检查服务器负载和工作区扫描队列，然后重试任务。" },
  workspace_git_scan_output_limit: { title: "工作区扫描超出限制", nextAction: "检查仓库大小和工作区扫描输出限制，然后重试任务。" },
  workspace_git_scan_failed: { title: "工作区扫描失败", nextAction: "检查失败的运行，并确认仓库访问权限和完整性，然后重试任务。" },
  workspace_git_scan_cancelled: { title: "工作区扫描已取消", nextAction: "先查明工作区准备被取消的原因，再重试任务。" },
};

export function buildImmediateExecutionPathRecoveryNoticeSeed(input: {
  status: "todo" | "in_progress";
}): StrandedRecoveryNoticeSeed {
  const retryDescription = input.status === "todo"
    ? "Alice 在终止运行恢复期间，已自动重试派发这个已分配的 `todo` 任务"
    : "Alice 在终止运行恢复期间，已自动重试继续执行这个已分配的 `in_progress` 任务";
  return {
    body:
      `${retryDescription}，但任务仍没有有效的执行路径。` +
      "已将其移至 `blocked` 状态，以便人工介入。",
    title: "没有有效的执行路径",
    tone: "danger",
  };
}

export function buildWorkspaceValidationRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "任务工作区验证失败，因此 Alice 在启动本地适配器前停止。" +
      "已将任务移至 `blocked` 状态；修复工作区链接、当前工作目录或 Git 检出后再继续。",
    title: "工作区验证失败",
    tone: "danger",
  };
}

export const SANDBOX_PROVIDER_PLUGIN_NOT_READY_REASON = "sandbox_provider_plugin_not_ready";

function readNonEmptyStringField(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * What the operator must do to bring a sandbox provider plugin back to
 * `ready`, by the status the run observed. Enabling an `upgrade_pending`
 * plugin also approves the capabilities the upgrade added, so that case asks
 * for a review first.
 */
export function sandboxProviderPluginRemedy(pluginStatus: string): string {
  switch (pluginStatus) {
    case "upgrade_pending":
      return "检查并批准升级后的插件能力，然后启用插件（插件 → 启用）";
    case "disabled":
      return "重新启用插件（插件 → 启用）；该插件此前被操作员禁用";
    default:
      return "启用插件（插件 → 启用）；重启服务器也会重新激活内置插件";
  }
}

/**
 * Seed for a `configuration_incomplete` escalation. `configurationIncomplete`
 * is the structured payload the failed run recorded in `resultJson`; the body
 * names the specific gap for the reasons this notice knows, and falls back to
 * the secret/env-binding wording (the original and most common reason).
 */
export function buildConfigurationIncompleteRecoveryNoticeSeed(
  configurationIncomplete?: Record<string, unknown> | null,
): StrandedRecoveryNoticeSeed {
  if (readNonEmptyStringField(configurationIncomplete, "reason") === "ai_connection_unavailable") {
    return {
      title: "AI 连接需要处理",
      body: "所选 AI 账户不可用，因此任务已暂停。请重新连接该账户，或选择可用连接后继续。",
      nextAction: "重新连接所选 AI 账户，或选择可用连接，然后继续任务。",
      tone: "danger",
    };
  }
  if (readNonEmptyStringField(configurationIncomplete, "reason") === SANDBOX_PROVIDER_PLUGIN_NOT_READY_REASON) {
    const pluginKey = readNonEmptyStringField(configurationIncomplete, "pluginKey") ?? "沙箱服务提供商插件";
    const pluginStatus = readNonEmptyStringField(configurationIncomplete, "pluginStatus") ?? "未就绪";
    return {
      body:
        `沙箱服务提供商插件 \`${pluginKey}\` 当前状态为 \`${pluginStatus}\`，无法租用沙箱，因此 Alice 在派发适配器前停止。` +
        `在插件恢复为 \`ready\` 前，运行会持续以相同原因失败。已将任务移至 \`blocked\` 状态，以便操作员先${sandboxProviderPluginRemedy(pluginStatus)}，` +
        "然后再继续任务。",
      title: "配置不完整",
      tone: "danger",
    };
  }
  return {
    body:
      "缺少必需的密钥或环境变量绑定，因此 Alice 在派发适配器前停止。" +
      "已将任务移至 `blocked` 状态，以便操作员绑定缺失的密钥后再继续。",
    title: "配置不完整",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "Alice 已重试一次待处理的执行评审参与者，但评审阶段仍没有已完成的决定或正在运行的评审任务。" +
      "已将任务移至 `blocked` 状态，以便团队检查证据、修复评审运行环境、恢复评审阶段，或记录明确的人工处理结果。",
    title: "评审恢复停滞",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantUnavailableNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "待处理的执行评审参与者无法调用，且评审阶段没有已完成的决定或正在运行的评审任务，因此 Alice 无法继续。" +
      "已将任务移至 `blocked` 状态，以便团队检查证据、修复评审运行环境、恢复评审阶段，或记录明确的人工处理结果。",
    title: "评审恢复停滞",
    tone: "danger",
  };
}

// Escalation dedupe matches the `Recovery action` key_value row via
// noticeMetadataReferencesRecoveryAction, so this builder must always emit
// that row with the raw action id.
export function buildStrandedRecoveryEscalationNotice(input: {
  seed?: StrandedRecoveryNoticeSeed | null;
  fallbackBody?: string | null;
  recoveryCause?: string | null;
  recoveryActionId: string;
  recoveryOwner: { id: string; name: string | null } | null | undefined;
  sourceRun: {
    id: string;
    agentId?: string | null;
    status: string;
    errorCode?: string | null;
    errorSummary?: string | null;
  } | null | undefined;
}): StrandedRecoveryEscalationNotice {
  const workspaceScan = WORKSPACE_SCAN_NOTICES[input.sourceRun?.errorCode ?? ""];
  const seed = workspaceScan ? {
    ...workspaceScan,
    body: `Alice 无法在智能体启动前准备工作区，自动恢复无法继续。${workspaceScan.nextAction}`,
    tone: "danger" as const,
  } : input.seed;
  const fallbackBody = input.fallbackBody?.trim();
  const body = seed?.body ?? (fallbackBody || DEFAULT_STRANDED_RECOVERY_NOTICE_BODY);
  const title =
    STRANDED_RECOVERY_NOTICE_TITLES_BY_RUN_ERROR_CODE[input.sourceRun?.errorCode?.trim() ?? ""] ??
    seed?.title ??
    STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE[input.recoveryCause ?? ""] ??
    DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE;

  const recoveryRows: NoticeMetadataRow[] = [
    keyValueRow("恢复操作", input.recoveryActionId),
    input.recoveryOwner
      ? agentLinkRow("恢复负责人", input.recoveryOwner)
      : keyValueRow(
          "恢复负责人",
          "需要团队决策",
        ),
    keyValueRow(
      "下一步操作",
      seed?.nextAction ?? (input.recoveryOwner
        ? "恢复负责人应恢复有效的执行路径，或在来源任务中记录人工处理结果"
        : "检查证据，然后重试原负责人、明确重新分配、修复执行路径，或记录明确的处理结果"),
    ),
  ];

  const runRows: NoticeMetadataRow[] = [];
  if (input.sourceRun) {
    runRows.push(runLinkRow("来源运行", input.sourceRun));
    const failureCode = input.sourceRun.errorCode?.trim();
    if (failureCode) runRows.push(keyValueRow("失败代码", failureCode));
    const failureSummary = input.sourceRun.errorSummary?.trim();
    if (failureSummary) runRows.push(keyValueRow("失败摘要", failureSummary));
  }

  const sections: NoticeMetadataSection[] = [
    { title: "恢复处理", rows: recoveryRows },
    ...(runRows.length > 0 ? [{ title: "运行证据", rows: runRows }] : []),
  ];

  return {
    body,
    presentation: systemNoticePresentation({ tone: seed?.tone ?? "danger", title }),
    metadata: {
      version: 1,
      sourceRunId: input.sourceRun?.id ?? null,
      sections,
    },
  };
}
