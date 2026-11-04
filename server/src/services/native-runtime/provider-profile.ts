import {
  isPaperclipRunnerProvider,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  resolvePaperclipRunnerPermissionMode,
  type PaperclipRunnerProvider,
} from "@paperclipai/adapter-utils";
import {
  AGENTCORE_QUALIFIED_MODEL,
  CLAUDE_MANAGED_QUALIFIED_MODEL,
} from "../provider-profile-qualification.js";

export const QUALIFIED_OPENCODE_RUNNER_VERSION = "1.18.32" as const;
export const DEFAULT_OPENCODE_RUNNER_MODEL =
  "openrouter/deepseek/deepseek-v4-flash-0731" as const;
export const CLAUDE_MANAGED_BETA_VERSION = "managed-agents-2026-04-01" as const;

export const QUALIFIED_ACPX_RUNNER_MODELS = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-sol",
} as const;

export type QualifiedPaperclipRunnerAcpxAgent =
  keyof typeof QUALIFIED_ACPX_RUNNER_MODELS;

export type PaperclipRunnerProviderProfile =
  | {
      provider: "codex";
      backend: "codex_app_server";
      model: string | null;
    }
  | {
      provider: "opencode";
      backend: "opencode_server";
      model: string;
    }
  | {
      provider: "claude_managed";
      backend: "claude_managed_agents_api";
      managedProfileId: string;
      model: string | null;
      maxSessionListCostUsd: number | null;
    }
  | {
      provider: "aws_agentcore";
      backend: "aws_agentcore_harness_api";
      agentCoreProfileId: string;
      model: string | null;
      maxEstimatedSessionCostUsd: number | null;
    }
  | {
      provider: "acpx";
      backend: "acpx_runtime";
      model: string;
      acpxAgent: QualifiedPaperclipRunnerAcpxAgent;
    };

export type PaperclipRunnerNativeProviderInput =
  | {
      provider: "codex";
      model: string | null;
      codexApprovalPolicy: "never" | "on-request" | "untrusted";
    }
  | {
      provider: "opencode";
      model: string;
      opencodePermissionMode: "allow" | "ask" | "deny";
    }
  | {
      provider: "claude_managed";
      model: string;
      managedProfile: {
        profileId: string;
        anthropicAgentId: string;
        agentVersion: string;
        environmentId: string;
        betaVersion: typeof CLAUDE_MANAGED_BETA_VERSION;
      };
      maxSessionListCostUsd: number;
    }
  | {
      provider: "aws_agentcore";
      model: string;
      agentCoreProfile: {
        profileId: string;
        region: string;
        accountId: string;
        harnessArn: string;
        harnessVersion: string;
        endpointArn: string;
        endpointQualifier: string;
        agentRuntimeArn: string;
        memoryArn: string;
        memoryId: string;
        invocationRoleArn: string;
        contextBucket: string;
        contextPrefix: string;
        contextKmsKeyArn: string;
        qualificationRevision: string;
        eventExpiryDays: 90;
      };
      maxEstimatedSessionCostUsd: number;
      invocationLimits: {
        maxIterations: number;
        maxOutputTokens: number;
        timeoutSeconds: number;
      };
    }
  | {
      provider: "acpx";
      model: string;
      acpxAgent: QualifiedPaperclipRunnerAcpxAgent;
      acpxPermissionMode: "approve-all" | "approve-paperclip" | "approve-reads" | "deny-all";
    };

export class PaperclipRunnerProviderProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaperclipRunnerProviderProfileError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function positiveNumberOrNull(
  value: unknown,
  code: string,
  message: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PaperclipRunnerProviderProfileError(code, message);
  }
  return parsed;
}

function boundedPositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  code: string,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > maximum
  ) {
    throw new PaperclipRunnerProviderProfileError(
      code,
      `${label} 必须是 1 到 ${maximum} 之间的整数。`,
    );
  }
  return value;
}

function assertPermissionMode(
  provider: PaperclipRunnerProvider,
  config: Record<string, unknown>,
): void {
  const capability = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[provider];
  if (!capability.configurable) return;
  const configured = config[capability.configKey];
  if (
    configured !== undefined
    && resolvePaperclipRunnerPermissionMode(provider, configured) !== configured
  ) {
    if (provider === "codex") {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_codex_permission_mode_unqualified",
        "Alice 运行器目前仅支持将 Codex 的 codexPermissionMode 设置为 never。开始新的原生运行前，请更新智能体配置。",
      );
    }
    throw new PaperclipRunnerProviderProfileError(
      "runner_permission_mode_invalid",
      `${provider} 不支持 ${capability.configKey}。`,
    );
  }
}

/**
 * Rebind a persisted Claude Managed run only to the still-qualified profile
 * and the profile's current company secret. The secret itself may rotate, but
 * the agent configuration must rotate its binding to the same profile-owned
 * secret before recovery can continue.
 */
export function assertManagedProfileRecoveryBinding(input: {
  adapterConfig: unknown;
  snapshot: {
    profileId: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: string;
  };
  stored: {
    id: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: string;
    apiKeySecretId: string;
  };
}): void {
  const { snapshot, stored } = input;
  if (
    snapshot.profileId !== stored.id
    || snapshot.anthropicAgentId !== stored.anthropicAgentId
    || snapshot.agentVersion !== stored.agentVersion
    || snapshot.environmentId !== stored.environmentId
    || snapshot.betaVersion !== stored.betaVersion
  ) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_claude_managed_recovery_identity_mismatch",
      "已保存的 Claude Managed 身份已不再与其认证配置匹配。",
    );
  }
  const rawBinding = asRecord(asRecord(input.adapterConfig).env).ANTHROPIC_API_KEY;
  const boundSecretId = asRecord(rawBinding).secretId;
  if (boundSecretId !== stored.apiKeySecretId) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_claude_managed_recovery_secret_mismatch",
      "已保存的 Claude Managed 运行未绑定到该配置当前的 API 密钥。",
    );
  }
}

/** Revalidate the operator's AWS profile revocation and immutable identity on recovery. */
export function assertAgentCoreProfileRecoveryBinding(input: {
  snapshot: {
    profileId: string;
    region: string;
    accountId: string;
    harnessArn: string;
    harnessVersion: string;
    endpointArn: string;
    endpointQualifier: string;
    agentRuntimeArn: string;
    memoryArn: string;
    memoryId: string;
    invocationRoleArn: string;
    contextBucket: string;
    contextPrefix: string;
    contextKmsKeyArn: string;
    qualificationRevision: string;
    eventExpiryDays: number;
  };
  stored: {
    id: string;
    configuration: Record<string, unknown>;
  };
}): void {
  const { snapshot, stored } = input;
  const configuration = asRecord(stored.configuration);
  const fields = [
    "region",
    "accountId",
    "harnessArn",
    "harnessVersion",
    "endpointArn",
    "endpointQualifier",
    "agentRuntimeArn",
    "memoryArn",
    "memoryId",
    "invocationRoleArn",
    "contextBucket",
    "contextPrefix",
    "contextKmsKeyArn",
    "qualificationRevision",
    "eventExpiryDays",
  ] as const;
  if (
    snapshot.profileId !== stored.id
    || fields.some((field) => snapshot[field] !== configuration[field])
  ) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_aws_agentcore_recovery_identity_mismatch",
      "已保存的 AWS AgentCore 身份已不再与其认证配置匹配。",
    );
  }
}

/**
 * Resolve the immutable provider identity used for a fresh Paperclip Runner
 * selection. The persisted adapterConfig is the authority; runtimeConfig is
 * deliberately not consulted so model-profile or migration metadata cannot
 * silently switch the harness selected for a run.
 */
export function resolvePaperclipRunnerProviderProfile(
  adapterConfig: unknown,
): PaperclipRunnerProviderProfile {
  const config = asRecord(adapterConfig);
  const candidate = config.provider ?? "codex";
  if (!isPaperclipRunnerProvider(candidate)) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_provider_unsupported",
      "Alice 运行器的提供方必须是 Codex、OpenCode、Claude Managed、AWS AgentCore 或 ACPX。",
    );
  }

  assertPermissionMode(candidate, config);
  const model = optionalString(config.model);
  if (candidate === "codex") {
    return {
      provider: "codex",
      backend: "codex_app_server",
      model,
    };
  }

  if (candidate === "opencode") {
    if (!model || !model.includes("/") || model.endsWith("/")) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_opencode_model_invalid",
        "Alice 运行器的 OpenCode 模型必须使用 provider/model 格式。",
      );
    }
    return {
      provider: "opencode",
      backend: "opencode_server",
      model,
    };
  }

  if (candidate === "claude_managed") {
    const managedProfileId = optionalString(config.managedProfileId);
    if (!managedProfileId) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_profile_required",
        "Alice 运行器的 Claude Managed 需要公司级托管智能体配置。",
      );
    }
    if (config.managedAgentsRetentionAcknowledged !== true) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_retention_required",
        "Alice 运行器的 Claude Managed 需要确认有状态测试版的数据保留规则。",
      );
    }
    if (model !== null && model !== CLAUDE_MANAGED_QUALIFIED_MODEL) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_model_unqualified",
        `Claude Managed 配置要求使用指定模型 ${CLAUDE_MANAGED_QUALIFIED_MODEL}。`,
      );
    }
    return {
      provider: "claude_managed",
      backend: "claude_managed_agents_api",
      managedProfileId,
      model,
      maxSessionListCostUsd: positiveNumberOrNull(
        config.maxSessionListCostUsd,
        "paperclip_runner_claude_managed_spend_cap_invalid",
        "覆盖会话支出上限时，Alice 运行器的 Claude Managed 要求该值大于 0。",
      ),
    };
  }

  if (candidate === "aws_agentcore") {
    const agentCoreProfileId = optionalString(config.agentCoreProfileId);
    if (!agentCoreProfileId) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_profile_required",
        "Alice 运行器的 AWS AgentCore 需要公司级远程智能体配置。",
      );
    }
    if (config.agentCoreRetentionAcknowledged !== true) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_retention_required",
        "Alice 运行器的 AWS AgentCore 需要确认记忆数据保留 90 天。",
      );
    }
    if (model !== null && model !== AGENTCORE_QUALIFIED_MODEL) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_model_unqualified",
        `AWS AgentCore 配置要求使用指定模型 ${AGENTCORE_QUALIFIED_MODEL}。`,
      );
    }
    return {
      provider: "aws_agentcore",
      backend: "aws_agentcore_harness_api",
      agentCoreProfileId,
      model,
      maxEstimatedSessionCostUsd: positiveNumberOrNull(
        config.maxEstimatedSessionCostUsd,
        "paperclip_runner_aws_agentcore_spend_cap_invalid",
        "覆盖预计会话支出上限时，Alice 运行器的 AWS AgentCore 要求该值大于 0。",
      ),
    };
  }

  const acpxAgent = config.acpxAgent ?? "claude";
  if (acpxAgent !== "claude" && acpxAgent !== "codex") {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_acpx_agent_unavailable",
      "Alice 运行器的 ACPX 需要已认证的 Claude 或 Codex 智能体配置；Pi 暂不可用。",
    );
  }
  const qualifiedModel = QUALIFIED_ACPX_RUNNER_MODELS[acpxAgent];
  if (acpxAgent === "codex" && model !== qualifiedModel) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_acpx_model_unqualified",
      `Alice 运行器的 ACPX ${acpxAgent} 要求使用指定模型 ${qualifiedModel}。`,
    );
  }
  return {
    provider: "acpx",
    backend: "acpx_runtime",
    model: model || qualifiedModel,
    acpxAgent,
  };
}

/**
 * Project the operator-owned adapter configuration and a qualified stored
 * profile into the closed native execution descriptor. Editable adapter
 * configuration can select a stored profile, but it cannot replace that
 * profile's immutable remote resource identity.
 */
export function resolvePaperclipRunnerNativeProviderInput(input: {
  backend: PaperclipRunnerProviderProfile["backend"];
  adapterConfig: unknown;
  managedProfile?: {
    id: string;
    profileKey: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: string;
    defaultModel: string;
    defaultMaxListCostCents: number;
  } | null;
  agentCoreProfile?: {
    id: string;
    profileKey: string;
    configuration: Record<string, unknown>;
  } | null;
}): PaperclipRunnerNativeProviderInput {
  const config = asRecord(input.adapterConfig);
  const profile = resolvePaperclipRunnerProviderProfile(config);
  if (profile.backend !== input.backend) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_provider_changed",
      "本次运行选择原生后端后，Alice 运行器的提供方发生了变化。",
    );
  }
  if (profile.provider === "opencode") {
    return {
      provider: "opencode",
      model: profile.model,
      opencodePermissionMode: resolvePaperclipRunnerPermissionMode(
        "opencode",
        config.opencodePermissionMode,
      ) as "allow" | "ask" | "deny",
    };
  }
  if (profile.provider === "acpx") {
    return {
      provider: "acpx",
      model: profile.model,
      acpxAgent: profile.acpxAgent,
      acpxPermissionMode: resolvePaperclipRunnerPermissionMode(
        "acpx",
        config.acpxPermissionMode,
      ) as "approve-all" | "approve-paperclip" | "approve-reads" | "deny-all",
    };
  }
  if (profile.provider === "claude_managed") {
    const stored = input.managedProfile;
    if (
      !stored
      || (
        profile.managedProfileId !== stored.id
        && profile.managedProfileId !== stored.profileKey
      )
    ) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_profile_mismatch",
        "已认证的 Claude Managed 配置与适配器选择不匹配。",
      );
    }
    if (stored.betaVersion !== CLAUDE_MANAGED_BETA_VERSION) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_beta_unqualified",
        "Claude Managed 配置的测试版版本未通过认证。",
      );
    }
    const model = profile.model ?? optionalString(stored.defaultModel);
    const maxSessionListCostUsd = profile.maxSessionListCostUsd
      ?? stored.defaultMaxListCostCents / 100;
    if (!model) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_model_invalid",
        "Claude Managed 配置必须指定模型。",
      );
    }
    if (model !== CLAUDE_MANAGED_QUALIFIED_MODEL) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_model_unqualified",
        `Claude Managed 配置要求使用指定模型 ${CLAUDE_MANAGED_QUALIFIED_MODEL}。`,
      );
    }
    if (!Number.isFinite(maxSessionListCostUsd) || maxSessionListCostUsd <= 0) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_spend_cap_invalid",
        "Claude Managed 配置要求会话支出上限大于 0。",
      );
    }
    return {
      provider: "claude_managed",
      model,
      managedProfile: {
        profileId: stored.id,
        anthropicAgentId: stored.anthropicAgentId,
        agentVersion: stored.agentVersion,
        environmentId: stored.environmentId,
        betaVersion: CLAUDE_MANAGED_BETA_VERSION,
      },
      maxSessionListCostUsd,
    };
  }
  if (profile.provider === "aws_agentcore") {
    const stored = input.agentCoreProfile;
    if (
      !stored
      || (
        profile.agentCoreProfileId !== stored.id
        && profile.agentCoreProfileId !== stored.profileKey
      )
    ) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_profile_mismatch",
        "已认证的 AWS AgentCore 配置与适配器选择不匹配。",
      );
    }
    const remote = asRecord(stored.configuration);
    const required = (key: string): string => {
      const value = optionalString(remote[key]);
      if (!value) {
        throw new PaperclipRunnerProviderProfileError(
          "paperclip_runner_aws_agentcore_profile_invalid",
          `已认证的 AWS AgentCore 配置缺少 ${key}。`,
        );
      }
      return value;
    };
    if (remote.eventExpiryDays !== 90) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_retention_unqualified",
        "已认证的 AWS AgentCore 配置必须将记忆事件保留整整 90 天。",
      );
    }
    const maxEstimatedSessionCostUsd = profile.maxEstimatedSessionCostUsd
      ?? positiveNumberOrNull(
        remote.defaultMaxEstimatedSessionCostUsd,
        "paperclip_runner_aws_agentcore_spend_cap_invalid",
        "AWS AgentCore 配置要求预计会话支出上限大于 0。",
      );
    if (maxEstimatedSessionCostUsd === null) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_spend_cap_invalid",
        "AWS AgentCore 配置要求预计会话支出上限大于 0。",
      );
    }
    const model = profile.model ?? required("defaultModel");
    if (model !== AGENTCORE_QUALIFIED_MODEL) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_model_unqualified",
        `AWS AgentCore 配置要求使用指定模型 ${AGENTCORE_QUALIFIED_MODEL}。`,
      );
    }
    return {
      provider: "aws_agentcore",
      model,
      agentCoreProfile: {
        profileId: stored.id,
        region: required("region"),
        accountId: required("accountId"),
        harnessArn: required("harnessArn"),
        harnessVersion: required("harnessVersion"),
        endpointArn: required("endpointArn"),
        endpointQualifier: required("endpointQualifier"),
        agentRuntimeArn: required("agentRuntimeArn"),
        memoryArn: required("memoryArn"),
        memoryId: required("memoryId"),
        invocationRoleArn: required("invocationRoleArn"),
        contextBucket: required("contextBucket"),
        contextPrefix: required("contextPrefix"),
        contextKmsKeyArn: required("contextKmsKeyArn"),
        qualificationRevision: required("qualificationRevision"),
        eventExpiryDays: 90,
      },
      maxEstimatedSessionCostUsd,
      invocationLimits: {
        maxIterations: boundedPositiveInteger(
          config.maxIterations,
          8,
          8,
          "paperclip_runner_aws_agentcore_max_iterations_invalid",
          "AWS AgentCore maxIterations",
        ),
        maxOutputTokens: boundedPositiveInteger(
          config.maxOutputTokens,
          4_096,
          4_096,
          "paperclip_runner_aws_agentcore_max_output_tokens_invalid",
          "AWS AgentCore maxOutputTokens",
        ),
        timeoutSeconds: boundedPositiveInteger(
          config.timeoutSeconds,
          300,
          300,
          "paperclip_runner_aws_agentcore_timeout_invalid",
          "AWS AgentCore timeoutSeconds",
        ),
      },
    };
  }
  return {
    provider: "codex",
    model: profile.model,
    codexApprovalPolicy: resolvePaperclipRunnerPermissionMode(
      "codex",
      config.codexPermissionMode,
    ) as "never" | "on-request" | "untrusted",
  };
}
