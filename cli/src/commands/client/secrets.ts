import { Command } from "commander";
import pc from "picocolors";
import type {
  Agent,
  AgentEnvConfig,
  CompanyPortabilityEnvInput,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityInclude,
  CompanySecret,
  EnvBinding,
  SecretProvider,
  SecretProviderDescriptor,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SecretListOptions extends BaseClientOptions {
  companyId?: string;
}

interface SecretDeclarationsOptions extends BaseClientOptions {
  companyId?: string;
  include?: string;
  kind?: "all" | "secret" | "plain";
}

interface SecretCreateOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  key?: string;
  provider?: SecretProvider;
  value?: string;
  valueEnv?: string;
  description?: string;
}

interface SecretUpdateOptions extends BaseClientOptions {
  payloadJson?: string;
}

interface SecretRotateOptions extends BaseClientOptions {
  value?: string;
  valueEnv?: string;
}

interface SecretDeleteOptions extends BaseClientOptions {
  yes?: boolean;
  confirm?: string;
}

interface SecretLinkOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  key?: string;
  provider?: SecretProvider;
  externalRef?: string;
  providerVersionRef?: string;
  description?: string;
}

interface SecretDoctorOptions extends BaseClientOptions {
  companyId?: string;
}

interface SecretMigrateInlineEnvOptions extends BaseClientOptions {
  companyId?: string;
  apply?: boolean;
}

interface SecretJsonOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson?: string;
}

interface SecretProviderHealth {
  provider: SecretProvider;
  status: "ok" | "warn" | "error";
  message: string;
  warnings?: string[];
  backupGuidance?: string[];
  details?: Record<string, unknown>;
}

interface SecretProviderHealthResponse {
  providers: SecretProviderHealth[];
}

export interface InlineSecretMigrationCandidate {
  agentId: string;
  agentName: string;
  envKey: string;
  secretName: string;
  existingSecretId: string | null;
}

const SENSITIVE_ENV_KEY_RE =
  /(^token$|[-_]?token$|api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

const DEFAULT_DECLARATION_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  projects: true,
  issues: false,
  skills: false,
};

export function parseSecretsInclude(input: string | undefined): CompanyPortabilityInclude {
  if (!input?.trim()) return { ...DEFAULT_DECLARATION_INCLUDE };
  const values = input.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const include = {
    company: values.includes("company"),
    agents: values.includes("agents"),
    projects: values.includes("projects"),
    issues: values.includes("issues") || values.includes("tasks"),
    skills: values.includes("skills"),
  };
  if (!Object.values(include).some(Boolean)) {
    throw new Error("--include 值无效。请至少选择一项：company、agents、projects、issues、tasks、skills");
  }
  return include;
}

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

export function toPlainEnvValue(binding: unknown): string | null {
  if (typeof binding === "string") return binding;
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return null;
  const record = binding as Record<string, unknown>;
  if (record.type === "plain" && typeof record.value === "string") return record.value;
  return null;
}

export function buildInlineMigrationSecretName(agentId: string, key: string): string {
  return `agent_${agentId.slice(0, 8)}_${key.toLowerCase()}`;
}

export function collectInlineSecretMigrationCandidates(
  agents: Agent[],
  existingSecrets: CompanySecret[],
): InlineSecretMigrationCandidate[] {
  const secretByName = new Map(existingSecrets.map((secret) => [secret.name, secret]));
  const candidates: InlineSecretMigrationCandidate[] = [];

  for (const agent of agents) {
    const env = asRecord(agent.adapterConfig.env);
    if (!env) continue;
    for (const [envKey, binding] of Object.entries(env)) {
      if (!isSensitiveEnvKey(envKey)) continue;
      const plain = toPlainEnvValue(binding);
      if (plain === null || plain.trim().length === 0) continue;
      const secretName = buildInlineMigrationSecretName(agent.id, envKey);
      candidates.push({
        agentId: agent.id,
        agentName: agent.name,
        envKey,
        secretName,
        existingSecretId: secretByName.get(secretName)?.id ?? null,
      });
    }
  }

  return candidates;
}

export function buildMigratedAgentEnv(
  env: Record<string, unknown>,
  secretIdByEnvKey: Map<string, string>,
): AgentEnvConfig {
  const next: AgentEnvConfig = { ...(env as Record<string, EnvBinding>) };
  for (const [envKey, secretId] of secretIdByEnvKey) {
    next[envKey] = {
      type: "secret_ref",
      secretId,
      version: "latest",
    };
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readValueFromOptions(opts: { value?: string; valueEnv?: string }): string {
  if (opts.value !== undefined && opts.valueEnv !== undefined) {
    throw new Error("--value 和 --value-env 只能使用其中一个。");
  }
  if (opts.valueEnv !== undefined) {
    const value = process.env[opts.valueEnv];
    if (!value) throw new Error(`环境变量 ${opts.valueEnv} 为空或未设置。`);
    return value;
  }
  if (opts.value !== undefined) return opts.value;
  throw new Error("必须提供密钥值。请传入 --value 或 --value-env。");
}

function renderDeclaration(input: CompanyPortabilityEnvInput): Record<string, unknown> {
  const scope = input.agentSlug
    ? `agent:${input.agentSlug}`
    : input.projectSlug
      ? `project:${input.projectSlug}`
      : "company";
  return {
    key: input.key,
    scope,
    kind: input.kind,
    requirement: input.requirement,
    portability: input.portability,
    hasDefault: input.defaultValue !== null && input.defaultValue.length > 0,
    description: input.description,
  };
}

function renderSecret(secret: CompanySecret): Record<string, unknown> {
  return {
    id: secret.id,
    name: secret.name,
    key: secret.key,
    provider: secret.provider,
    status: secret.status,
    managedMode: secret.managedMode,
    latestVersion: secret.latestVersion,
    externalRef: secret.externalRef ? "yes" : "no",
  };
}

function printProviderHealth(rows: SecretProviderHealth[], json: boolean): void {
  if (json) {
    printOutput(rows, { json: true });
    return;
  }
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        id: row.provider,
        status: row.status,
        message: row.message,
      }),
    );
    for (const warning of row.warnings ?? []) {
      console.log(pc.yellow(`warning=${warning}`));
    }
    const missingConfig = asStringArray(row.details?.missingConfig);
    if (missingConfig.length > 0) {
      console.log(pc.dim(`missingConfig=${missingConfig.join(",")}`));
    }
    const credentialSource = typeof row.details?.credentialSource === "string"
      ? row.details.credentialSource
      : null;
    if (credentialSource) {
      console.log(pc.dim(`credentialSource=${credentialSource}`));
    }
    const detectedCredentialSources = asStringArray(row.details?.detectedCredentialSources);
    if (detectedCredentialSources.length > 0) {
      console.log(pc.dim(`detectedCredentialSources=${detectedCredentialSources.join(",")}`));
    }
    for (const guidance of row.backupGuidance ?? []) {
      console.log(pc.dim(`backup=${guidance}`));
    }
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

async function migrateInlineEnv(opts: SecretMigrateInlineEnvOptions): Promise<void> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const companyId = ctx.companyId!;
  const agents = (await ctx.api.get<Agent[]>(apiPath`/api/companies/${companyId}/agents`)) ?? [];
  const secrets = (await ctx.api.get<CompanySecret[]>(apiPath`/api/companies/${companyId}/secrets`)) ?? [];
  const candidates = collectInlineSecretMigrationCandidates(agents, secrets);

  if (!opts.apply) {
    printOutput(
      {
        apply: false,
        agentsToUpdate: new Set(candidates.map((candidate) => candidate.agentId)).size,
        secretsToCreate: candidates.filter((candidate) => !candidate.existingSecretId).length,
        secretsToRotate: candidates.filter((candidate) => candidate.existingSecretId).length,
        candidates,
      },
      { json: ctx.json },
    );
    if (!ctx.json) {
      console.log(pc.dim("请使用 --apply 重新运行，以创建或轮换密钥并更新智能体环境变量绑定。"));
    }
    return;
  }

  const createdOrRotated = new Map<string, string>();
  let createdSecrets = 0;
  let rotatedSecrets = 0;

  for (const candidate of candidates) {
    const agent = agents.find((row) => row.id === candidate.agentId);
    const env = asRecord(agent?.adapterConfig.env);
    const value = env ? toPlainEnvValue(env[candidate.envKey]) : null;
    if (!value) continue;

    if (candidate.existingSecretId) {
      await ctx.api.post(apiPath`/api/secrets/${candidate.existingSecretId}/rotate`, { value });
      createdOrRotated.set(`${candidate.agentId}:${candidate.envKey}`, candidate.existingSecretId);
      rotatedSecrets += 1;
      continue;
    }

    const created = await ctx.api.post<CompanySecret>(apiPath`/api/companies/${companyId}/secrets`, {
      name: candidate.secretName,
      provider: "local_encrypted",
      value,
      description: `从智能体 ${candidate.agentId} 的环境变量 ${candidate.envKey} 迁移`,
    });
    if (!created) throw new Error(`创建密钥 ${candidate.secretName} 后未返回数据`);
    createdOrRotated.set(`${candidate.agentId}:${candidate.envKey}`, created.id);
    createdSecrets += 1;
  }

  let updatedAgents = 0;
  for (const agent of agents) {
    const env = asRecord(agent.adapterConfig.env);
    if (!env) continue;
    const secretIdByEnvKey = new Map<string, string>();
    for (const [key] of Object.entries(env)) {
      const secretId = createdOrRotated.get(`${agent.id}:${key}`);
      if (secretId) secretIdByEnvKey.set(key, secretId);
    }
    if (secretIdByEnvKey.size === 0) continue;
    const adapterConfig = {
      ...agent.adapterConfig,
      env: buildMigratedAgentEnv(env, secretIdByEnvKey),
    };
    await ctx.api.patch(apiPath`/api/agents/${agent.id}`, {
      adapterConfig,
      replaceAdapterConfig: true,
    });
    updatedAgents += 1;
  }

  printOutput(
    {
      apply: true,
      updatedAgents,
      createdSecrets,
      rotatedSecrets,
    },
    { json: ctx.json },
  );
}

export function registerSecretCommands(program: Command): void {
  const secrets = program.command("secrets").description("密钥声明与提供方操作");

  addCommonClientOptions(
    secrets
      .command("list")
      .description("列出公司的密钥元数据")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .action(async (opts: SecretListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<CompanySecret[]>(apiPath`/api/companies/${ctx.companyId}/secrets`)) ?? [];
          printOutput(ctx.json ? rows : rows.map(renderSecret), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("declarations")
      .description("列出公司导出生成的可移植环境变量声明")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .option("--include <values>", "以逗号分隔的包含范围：company、agents、projects、issues、tasks、skills", "company,agents,projects")
      .option("--kind <kind>", "按声明类型筛选：all、secret、plain", "all")
      .action(async (opts: SecretDeclarationsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const kind = opts.kind ?? "all";
          if (!["all", "secret", "plain"].includes(kind)) {
            throw new Error("--kind 值无效。可选值：all、secret、plain");
          }
          const preview = await ctx.api.post<CompanyPortabilityExportPreviewResult>(
            apiPath`/api/companies/${ctx.companyId}/exports/preview`,
            { include: parseSecretsInclude(opts.include) },
          );
          const declarations = (preview?.manifest.envInputs ?? [])
            .filter((entry) => kind === "all" || entry.kind === kind);
          printOutput(ctx.json ? declarations : declarations.map(renderDeclaration), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("create")
      .description("创建由 Alice 管理的密钥")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .requiredOption("--name <name>", "密钥显示名称")
      .option("--key <key>", "可移植密钥键名")
      .option("--provider <provider>", "密钥提供方 ID")
      .option("--value <value>", "密钥值")
      .option("--value-env <name>", "从环境变量读取密钥值")
      .option("--description <text>", "说明")
      .action(async (opts: SecretCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const created = await ctx.api.post<CompanySecret>(apiPath`/api/companies/${ctx.companyId}/secrets`, {
            name: opts.name,
            key: opts.key,
            provider: opts.provider,
            value: readValueFromOptions(opts),
            description: opts.description,
          });
          printOutput(ctx.json ? created : renderSecret(created!), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("link")
      .description("关联外部提供方管理的密钥，而不在 Alice 中存储密钥值")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .requiredOption("--name <name>", "密钥显示名称")
      .requiredOption("--provider <provider>", "密钥提供方 ID")
      .requiredOption("--external-ref <ref>", "提供方密钥的 ARN、名称、路径或引用")
      .option("--key <key>", "可移植密钥键名")
      .option("--provider-version-ref <ref>", "提供方版本 ID 或标签")
      .option("--description <text>", "说明")
      .action(async (opts: SecretLinkOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const created = await ctx.api.post<CompanySecret>(apiPath`/api/companies/${ctx.companyId}/secrets`, {
            name: opts.name,
            key: opts.key,
            provider: opts.provider,
            managedMode: "external_reference",
            externalRef: opts.externalRef,
            providerVersionRef: opts.providerVersionRef,
            description: opts.description,
          });
          printOutput(ctx.json ? created : renderSecret(created!), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("update")
      .description("更新密钥元数据")
      .argument("<secretId>", "密钥 ID")
      .requiredOption("--payload-json <json>", "UpdateSecret JSON 数据")
      .action(async (secretId: string, opts: SecretUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.patch(apiPath`/api/secrets/${secretId}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("rotate")
      .description("轮换由 Alice 管理的密钥值")
      .argument("<secretId>", "密钥 ID")
      .option("--value <value>", "新的密钥值")
      .option("--value-env <name>", "从环境变量读取新的密钥值")
      .action(async (secretId: string, opts: SecretRotateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/secrets/${secretId}/rotate`, { value: readValueFromOptions(opts) }), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("usage")
      .description("显示密钥的引用位置")
      .argument("<secretId>", "密钥 ID")
      .action(async (secretId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/secrets/${secretId}/usage`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("access-events")
      .description("列出密钥访问事件")
      .argument("<secretId>", "密钥 ID")
      .action(async (secretId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/secrets/${secretId}/access-events`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("delete")
      .description("删除密钥")
      .argument("<secretId>", "密钥 ID")
      .option("--yes", "确认破坏性操作所需的安全标志", false)
      .option("--confirm <secretId>", "再次输入密钥 ID 以确认删除")
      .action(async (secretId: string, opts: SecretDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("删除操作必须传入 --yes。");
          if (opts.confirm !== secretId) {
            throw new Error("删除操作必须传入与密钥 ID 一致的 --confirm <secretId>。");
          }
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.delete(apiPath`/api/secrets/${secretId}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("doctor")
      .description("通过 Alice API 运行密钥提供方健康检查")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .action(async (opts: SecretDoctorOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const health = await ctx.api.get<SecretProviderHealthResponse>(
            apiPath`/api/companies/${ctx.companyId}/secret-providers/health`,
          );
          printProviderHealth(health?.providers ?? [], ctx.json);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("providers")
      .description("列出已配置的密钥提供方说明")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .action(async (opts: SecretDoctorOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<SecretProviderDescriptor[]>(
            apiPath`/api/companies/${ctx.companyId}/secret-providers`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("provider-configs")
      .description("列出公司的密钥提供方保险库配置")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .action(async (opts: SecretDoctorOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/secret-provider-configs`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCompanySecretJsonPost(secrets, "provider-config:create", "创建密钥提供方保险库配置", "secret-provider-configs");
  addCompanySecretJsonPost(
    secrets,
    "provider-config:discovery-preview",
    "预览提供方保险库密钥发现结果",
    "secret-provider-configs/discovery/preview",
  );
  addSecretProviderConfigGet(secrets, "provider-config:get", "获取密钥提供方保险库配置", "");
  addSecretProviderConfigPatch(secrets, "provider-config:update", "更新密钥提供方保险库配置", "");
  addSecretProviderConfigPost(secrets, "provider-config:default", "设为默认提供方保险库配置", "default");
  addSecretProviderConfigPost(secrets, "provider-config:health", "检查提供方保险库健康状态", "health");
  addSecretProviderConfigDelete(secrets, "provider-config:delete", "删除密钥提供方保险库配置");
  addCompanySecretJsonPost(secrets, "remote-import:preview", "预览远程密钥导入", "secrets/remote-import/preview");
  addCompanySecretJsonPost(secrets, "remote-import", "导入选定的远程密钥", "secrets/remote-import");

  addCommonClientOptions(
    secrets
      .command("migrate-inline-env")
      .description("将智能体环境变量中的敏感值迁移为密钥引用")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .option("--apply", "保存变更；默认仅试运行", false)
      .action(async (opts: SecretMigrateInlineEnvOptions) => {
        try {
          await migrateInlineEnv(opts);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addCompanySecretJsonPost(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .requiredOption("--payload-json <json>", "JSON 数据")
      .action(async (opts: SecretJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addSecretProviderConfigGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<configId>", "提供方配置 ID")
      .action(async (configId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(`${apiPath`/api/secret-provider-configs/${configId}`}${suffix ? `/${suffix}` : ""}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addSecretProviderConfigPatch(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<configId>", "提供方配置 ID")
      .requiredOption("--payload-json <json>", "JSON 数据")
      .action(async (configId: string, opts: SecretJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.patch(`${apiPath`/api/secret-provider-configs/${configId}`}${suffix ? `/${suffix}` : ""}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addSecretProviderConfigPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<configId>", "提供方配置 ID")
      .action(async (configId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(`${apiPath`/api/secret-provider-configs/${configId}`}/${suffix}`, {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addSecretProviderConfigDelete(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<configId>", "提供方配置 ID")
      .action(async (configId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.delete(apiPath`/api/secret-provider-configs/${configId}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
