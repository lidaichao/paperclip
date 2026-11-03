import { Command } from "commander";
import type {
  Approval,
  CatalogTeam,
  CatalogTeamImportPreviewResult,
  CatalogTeamInstallResult,
  CatalogTeamInstallOptions,
  CatalogTeamImportOptions,
  CatalogTeamSourcePolicy,
  InstalledCatalogTeam,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";
import { ApiRequestError } from "../../client/http.js";

interface TeamBrowseOptions extends BaseClientOptions {
  kind?: string;
  category?: string;
  query?: string;
}

interface TeamListOptions extends TeamBrowseOptions {}

interface TeamPreviewOptions extends BaseClientOptions {
  companyId?: string;
  targetManagerAgentId?: string;
  targetManagerSlug?: string;
  agent?: string[];
  collisionStrategy?: "rename" | "skip" | "replace";
  nameOverride?: string[];
  selectedFile?: string[];
  allowExternalSources?: boolean;
  allowUnpinnedOptionalSources?: boolean;
  allowLocalPathSources?: boolean;
}

interface TeamInstallOptions extends TeamPreviewOptions {
  requestApprovalOnForbidden?: boolean;
  approvalIssueId?: string;
  secretValue?: string[];
  adapterOverride?: string[];
}

interface TeamInstallApprovalFallbackResult {
  status: "approval_requested";
  approval: Approval;
  installAttempt: {
    companyId: string;
    catalogRef: string;
    options: CatalogTeamInstallOptions;
    deniedReason: string;
  };
}

export function registerTeamCommands(program: Command): void {
  const teams = program.command("teams").description("应用内置团队目录操作");

  addCommonClientOptions(
    teams
      .command("browse")
      .description("浏览应用内置团队目录，不执行安装")
      .option("--kind <kind>", "按目录类型筛选（bundled 或 optional）")
      .option("--category <slug>", "按目录分类筛选")
      .option("--query <text>", "搜索目录内容")
      .action(async (opts: TeamBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogTeams(ctx, opts);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogTeamRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teams
      .command("list")
      .description("列出应用内置团队及其在公司中的安装状态")
      .option("--kind <kind>", "按目录类型筛选（bundled 或 optional）")
      .option("--category <slug>", "按目录分类筛选")
      .option("--query <text>", "搜索目录内容")
      .action(async (opts: TeamListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await listCatalogTeamStatusRows(ctx, opts);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogTeamStatusRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    teams
      .command("search")
      .description("搜索应用内置团队目录，不执行安装")
      .argument("<query>", "搜索内容")
      .option("--kind <kind>", "按目录类型筛选（bundled 或 optional）")
      .option("--category <slug>", "按目录分类筛选")
      .action(async (query: string, opts: TeamBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogTeams(ctx, { ...opts, query });
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogTeamRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teams
      .command("inspect")
      .description("安装前检查应用内置团队")
      .argument("<catalogRef>", "团队目录 ID、键名或唯一标识")
      .option("--file <path>", "输出指定团队目录文件，而非清单详情")
      .action(async (catalogRef: string, opts: BaseClientOptions & { file?: string }) => {
        try {
          const ctx = resolveCommandContext(opts);
          if (opts.file?.trim()) {
            const file = await getCatalogTeamFile(ctx, catalogRef, opts.file);
            if (ctx.json) {
              printOutput(file, { json: true });
              return;
            }
            process.stdout.write(file?.content ?? "");
            if (file?.content && !file.content.endsWith("\n")) {
              process.stdout.write("\n");
            }
            return;
          }

          const detail = await getCatalogTeam(ctx, catalogRef);
          if (ctx.json) {
            printOutput(detail, { json: true });
            return;
          }
          printCatalogTeamDetail(detail);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    teams
      .command("preview")
      .description("预览将目录团队导入公司")
      .argument("<catalogRef>", "团队目录 ID、键名或唯一标识")
      .option("--target-manager-agent-id <id>", "目录根智能体要汇报给的现有智能体 ID")
      .option("--target-manager-slug <slug>", "目录根智能体要汇报给的可移植主管标识")
      .option("--agent <slug>", "只预览选定的智能体标识；可重复使用", collectOptionValue, [] as string[])
      .option("--collision-strategy <strategy>", "导入冲突策略（rename、skip、replace）")
      .option("--name-override <slug=name>", "覆盖导入实体名称；可重复使用", collectOptionValue, [] as string[])
      .option("--selected-file <path>", "只预览选定的可移植文件；可重复使用", collectOptionValue, [] as string[])
      .option("--allow-external-sources", "允许目录团队声明的 GitHub、URL 或 skills.sh 技能来源", false)
      .option("--allow-unpinned-optional-sources", "允许未固定到提交的可选团队外部技能来源", false)
      .option("--allow-local-path-sources", "仅限开发：允许目录团队声明的本地路径技能来源", false)
      .action(async (catalogRef: string, opts: TeamPreviewOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CatalogTeamImportPreviewResult>(
            catalogTeamCompanyPath(ctx.companyId, catalogRef, "preview"),
            buildTeamOptions(opts),
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printCatalogTeamPreview(result);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    teams
      .command("install")
      .description("将目录团队安装到公司")
      .argument("<catalogRef>", "团队目录 ID、键名或唯一标识")
      .option("--target-manager-agent-id <id>", "目录根智能体要汇报给的现有智能体 ID")
      .option("--target-manager-slug <slug>", "目录根智能体要汇报给的可移植主管标识")
      .option("--agent <slug>", "只安装选定的智能体标识；可重复使用", collectOptionValue, [] as string[])
      .option("--collision-strategy <strategy>", "导入冲突策略（rename、skip、replace）")
      .option("--name-override <slug=name>", "覆盖导入实体名称；可重复使用", collectOptionValue, [] as string[])
      .option("--selected-file <path>", "只安装选定的可移植文件；可重复使用", collectOptionValue, [] as string[])
      .option("--secret-value <key=value>", "安装所需的敏感环境变量值；可重复使用", collectOptionValue, [] as string[])
      .option("--adapter-override <slug=type>", "覆盖导入智能体的适配器类型；可重复使用", collectOptionValue, [] as string[])
      .option("--allow-external-sources", "允许目录团队声明的 GitHub、URL 或 skills.sh 技能来源", false)
      .option("--allow-unpinned-optional-sources", "允许未固定到提交的可选团队外部技能来源", false)
      .option("--allow-local-path-sources", "仅限开发：允许目录团队声明的本地路径技能来源", false)
      .option(
        "--request-approval-on-forbidden",
        "当 agents:create 权限拒绝安装时，创建工作台审批请求，而不是直接返回 403",
        false,
      )
      .option("--approval-issue-id <id>", "关联备用审批请求的任务 ID；已设置时默认使用 PAPERCLIP_TASK_ID")
      .action(async (catalogRef: string, opts: TeamInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const installOptions = buildTeamInstallOptions(opts);
          const result = await ctx.api.post<CatalogTeamInstallResult>(
            catalogTeamCompanyPath(ctx.companyId, catalogRef, "install"),
            installOptions,
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printCatalogTeamInstall(result);
        } catch (err) {
          if (shouldRequestInstallApproval(err, opts)) {
            try {
              const ctx = resolveCommandContext(opts, { requireCompany: true });
              const fallback = await requestInstallApproval(ctx, catalogRef, buildTeamInstallOptions(opts), opts, err);
              if (ctx.json) {
                printOutput(fallback, { json: true });
                return;
              }
              printInstallApprovalRequested(fallback);
              return;
            } catch (fallbackErr) {
              handleCommandError(fallbackErr);
            }
          }
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

async function listCatalogTeams(
  ctx: ResolvedClientContext,
  opts: TeamBrowseOptions,
): Promise<CatalogTeam[]> {
  const params = new URLSearchParams();
  appendQueryParam(params, "kind", opts.kind);
  appendQueryParam(params, "category", opts.category);
  appendQueryParam(params, "q", opts.query);
  const query = params.toString();
  return (await ctx.api.get<CatalogTeam[]>(`/api/teams/catalog${query ? `?${query}` : ""}`)) ?? [];
}

type CatalogTeamInstalledStatus = "not_installed" | "installed" | "out_of_date" | "installed_missing";

interface CatalogTeamStatusRow {
  catalogId: string;
  catalogKey: string | null;
  kind: CatalogTeam["kind"] | null;
  category: string | null;
  slug: string | null;
  name: string;
  installedStatus: CatalogTeamInstalledStatus;
  installedAgentCount: number;
  catalogAgentCount: number | null;
  projectCount: number | null;
  trustLevel: CatalogTeam["trustLevel"] | null;
  present: boolean;
  outOfDate: boolean;
  currentContentHash: string | null;
  installedOriginHashes: string[];
}

async function listCatalogTeamStatusRows(
  ctx: ResolvedClientContext,
  opts: TeamListOptions,
): Promise<CatalogTeamStatusRow[]> {
  if (!ctx.companyId) {
    throw new Error("必须提供公司 ID。");
  }

  const [teams, installed] = await Promise.all([
    listCatalogTeams(ctx, opts),
    ctx.api.get<InstalledCatalogTeam[]>(
      `/api/companies/${encodeURIComponent(ctx.companyId)}/teams/catalog/installed`,
    ),
  ]);

  const installedByCatalogId = new Map((installed ?? []).map((row) => [row.catalogId, row]));
  const rows = teams.map((team) => {
    const installedTeam = installedByCatalogId.get(team.id);
    if (installedTeam) {
      installedByCatalogId.delete(team.id);
    }
    return buildCatalogTeamStatusRow(team, installedTeam ?? null);
  });

  for (const installedTeam of installedByCatalogId.values()) {
    if (installedTeam.present) continue;
    rows.push(buildMissingInstalledTeamStatusRow(installedTeam));
  }

  return rows;
}

async function getCatalogTeam(ctx: ResolvedClientContext, catalogRef: string): Promise<CatalogTeam> {
  const ref = catalogRef.trim();
  if (!ref) {
    throw new Error("必须提供团队目录引用。");
  }
  const detail = await ctx.api.get<CatalogTeam>(`/api/teams/catalog/ref?ref=${encodeURIComponent(ref)}`);
  if (!detail) {
    throw new Error(`未找到团队目录：${catalogRef}`);
  }
  return detail;
}

async function getCatalogTeamFile(
  ctx: ResolvedClientContext,
  catalogRef: string,
  filePath: string,
): Promise<{ content: string } | null> {
  const ref = catalogRef.trim();
  const path = filePath.trim();
  if (!ref) throw new Error("必须提供团队目录引用。");
  if (!path) throw new Error("必须提供团队目录文件路径。");
  const params = new URLSearchParams({ ref, path });
  return ctx.api.get(`/api/teams/catalog/ref/files?${params.toString()}`);
}

function catalogTeamCompanyPath(companyId: string | undefined, catalogRef: string, action: "preview" | "install") {
  if (!companyId) throw new Error("必须提供公司 ID。");
  const params = new URLSearchParams({ ref: catalogRef.trim() });
  return `/api/companies/${encodeURIComponent(companyId)}/teams/catalog/ref/${action}?${params.toString()}`;
}

function buildTeamOptions(opts: TeamPreviewOptions): CatalogTeamImportOptions {
  return removeUndefined({
    targetManagerAgentId: emptyStringToUndefined(opts.targetManagerAgentId),
    targetManagerSlug: emptyStringToUndefined(opts.targetManagerSlug),
    agents: opts.agent && opts.agent.length > 0 ? opts.agent : undefined,
    collisionStrategy: opts.collisionStrategy,
    nameOverrides: parseNameOverrides(opts.nameOverride),
    selectedFiles: opts.selectedFile && opts.selectedFile.length > 0 ? opts.selectedFile : undefined,
    sourcePolicy: buildSourcePolicy(opts),
  });
}

function buildTeamInstallOptions(opts: TeamInstallOptions): CatalogTeamInstallOptions {
  return removeUndefined({
    ...buildTeamOptions(opts),
    adapterOverrides: parseAdapterOverrides(opts.adapterOverride),
    secretValues: parseSecretValues(opts.secretValue),
  });
}

const INSTALL_APPROVAL_FALLBACK_MESSAGES = [
  "missing permission: agents:create",
  "missing permission: can create agents",
];
const SECRET_VALUE_REDACTION = "[redacted]";

function shouldRequestInstallApproval(error: unknown, opts: TeamInstallOptions): error is ApiRequestError {
  if (!(opts.requestApprovalOnForbidden || isPaperclipTaskRun())) return false;
  if (!(error instanceof ApiRequestError) || error.status !== 403) return false;
  const message = error.message.toLowerCase();
  return INSTALL_APPROVAL_FALLBACK_MESSAGES.some((expected) => message.includes(expected));
}

function isPaperclipTaskRun(): boolean {
  return Boolean(process.env.PAPERCLIP_TASK_ID?.trim());
}

async function requestInstallApproval(
  ctx: ResolvedClientContext,
  catalogRef: string,
  installOptions: CatalogTeamInstallOptions,
  opts: TeamInstallOptions,
  error: ApiRequestError,
): Promise<TeamInstallApprovalFallbackResult> {
  if (!ctx.companyId) throw new Error("必须提供公司 ID。");
  const trimmedRef = catalogRef.trim();
  const issueIds = resolveApprovalIssueIds(opts);
  const approvalInstallOptions = omitInstallSecretValues(installOptions);
  const returnedInstallOptions = redactInstallSecretValues(installOptions);
  const payload = {
    type: "request_board_approval",
    issueIds,
    payload: {
      title: `批准安装目录团队：${trimmedRef}`,
      summary:
        `Alice 命令行智能体运行尝试将目录团队“${trimmedRef}”安装到公司“${ctx.companyId}”，` +
        `但 API 拒绝了安装：${error.message}。`,
      recommendedAction:
        "批准该团队目录来源，并使用工作台或智能体创建者令牌重新安装；也可以授予申请智能体 agents:create 权限后重新运行同一命令。",
      risks: [
        "安装目录团队可能创建智能体、项目、任务、例行任务、技能和密钥绑定。",
        "仅在检查目录来源、选定文件、目标主管和冲突策略后批准。",
      ],
      installAttempt: {
        companyId: ctx.companyId,
        catalogRef: trimmedRef,
        options: approvalInstallOptions,
        deniedReason: error.message,
      },
    },
  };
  const approval = await ctx.api.post<Approval>(apiPath`/api/companies/${ctx.companyId}/approvals`, payload);
  if (!approval) {
    throw new Error("审批请求失败。");
  }
  return {
    status: "approval_requested",
    approval,
    installAttempt: {
      companyId: ctx.companyId,
      catalogRef: trimmedRef,
      options: returnedInstallOptions,
      deniedReason: error.message,
    },
  };
}

function omitInstallSecretValues(options: CatalogTeamInstallOptions): CatalogTeamInstallOptions {
  if (!options.secretValues) return options;
  const { secretValues: _secretValues, ...safeOptions } = options;
  return safeOptions;
}

function redactInstallSecretValues(options: CatalogTeamInstallOptions): CatalogTeamInstallOptions {
  if (!options.secretValues) return options;
  return {
    ...options,
    secretValues: Object.fromEntries(
      Object.keys(options.secretValues).map((key) => [key, SECRET_VALUE_REDACTION]),
    ),
  };
}

function resolveApprovalIssueIds(opts: TeamInstallOptions): string[] | undefined {
  const issueId = opts.approvalIssueId?.trim() || process.env.PAPERCLIP_TASK_ID?.trim();
  if (!issueId) return undefined;
  return isUuidLike(issueId) ? [issueId] : undefined;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildSourcePolicy(opts: TeamPreviewOptions): CatalogTeamSourcePolicy | undefined {
  const sourcePolicy = removeUndefined({
    allowExternalSources: opts.allowExternalSources || undefined,
    allowUnpinnedOptionalSources: opts.allowUnpinnedOptionalSources || undefined,
    allowLocalPathSources: opts.allowLocalPathSources || undefined,
  });
  return Object.keys(sourcePolicy).length > 0 ? sourcePolicy : undefined;
}

function parseNameOverrides(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const raw of values) {
    const [slug, name] = parseKeyValueOption(raw, "--name-override", "slug=name");
    if (!slug || !name) {
      throw new Error(`--name-override“${raw}”无效。请使用 slug=name 格式。`);
    }
    result[slug] = name;
  }
  return result;
}

function parseSecretValues(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const raw of values) {
    const [key, value] = parseKeyValueOption(raw, "--secret-value", "key=value");
    if (!key) {
      throw new Error(`--secret-value“${raw}”无效。请使用 key=value 格式。`);
    }
    result[key] = value;
  }
  return result;
}

function parseAdapterOverrides(
  values: string[] | undefined,
): CatalogTeamInstallOptions["adapterOverrides"] | undefined {
  if (!values || values.length === 0) return undefined;
  const result: NonNullable<CatalogTeamInstallOptions["adapterOverrides"]> = {};
  for (const raw of values) {
    const [slug, adapterType] = parseKeyValueOption(raw, "--adapter-override", "slug=type");
    if (!slug || !adapterType) {
      throw new Error(`--adapter-override“${raw}”无效。请使用 slug=type 格式。`);
    }
    result[slug] = { adapterType };
  }
  return result;
}

function parseKeyValueOption(raw: string, flag: string, format: string): [string, string] {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new Error(`${flag}“${raw}”无效。请使用 ${format} 格式。`);
  }
  return [raw.slice(0, separator).trim(), raw.slice(separator + 1).trim()];
}

function removeUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function emptyStringToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function appendQueryParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) {
    params.set(key, trimmed);
  }
}

function printCatalogTeamRows(rows: CatalogTeam[]): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  printTable(rows.map((row) => ({
    编号: row.id,
    键名: row.key,
    类型: row.kind,
    分类: row.category,
    标识: row.slug,
    名称: row.name,
    信任级别: row.trustLevel,
    智能体: row.counts.agents,
    项目: row.counts.projects,
  })));
}

function buildCatalogTeamStatusRow(
  team: CatalogTeam,
  installed: InstalledCatalogTeam | null,
): CatalogTeamStatusRow {
  return {
    catalogId: team.id,
    catalogKey: team.key,
    kind: team.kind,
    category: team.category,
    slug: team.slug,
    name: team.name,
    installedStatus: installed ? (installed.outOfDate ? "out_of_date" : "installed") : "not_installed",
    installedAgentCount: installed?.agentCount ?? 0,
    catalogAgentCount: team.counts.agents,
    projectCount: team.counts.projects,
    trustLevel: team.trustLevel,
    present: true,
    outOfDate: installed?.outOfDate ?? false,
    currentContentHash: team.contentHash,
    installedOriginHashes: installed?.installedOriginHashes ?? [],
  };
}

function buildMissingInstalledTeamStatusRow(installed: InstalledCatalogTeam): CatalogTeamStatusRow {
  const name = installed.catalogKey ?? installed.catalogId;
  return {
    catalogId: installed.catalogId,
    catalogKey: installed.catalogKey,
    kind: null,
    category: null,
    slug: null,
    name,
    installedStatus: "installed_missing",
    installedAgentCount: installed.agentCount,
    catalogAgentCount: null,
    projectCount: null,
    trustLevel: null,
    present: false,
    outOfDate: false,
    currentContentHash: installed.currentContentHash,
    installedOriginHashes: installed.installedOriginHashes,
  };
}

function printCatalogTeamStatusRows(rows: CatalogTeamStatusRow[]): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  printTable(rows.map((row) => ({
    编号: row.catalogId,
    键名: row.catalogKey,
    类型: row.kind,
    分类: row.category,
    标识: row.slug,
    名称: row.name,
    安装状态: row.installedStatus,
    已安装智能体: row.installedAgentCount,
    目录智能体: row.catalogAgentCount,
    项目: row.projectCount,
    信任级别: row.trustLevel,
  })));
}

function printCatalogTeamDetail(team: CatalogTeam): void {
  console.log(
    formatInlineRecord({
      编号: team.id,
      键名: team.key,
      类型: team.kind,
      分类: team.category,
      标识: team.slug,
      名称: team.name,
      信任级别: team.trustLevel,
      兼容性: team.compatibility,
      内容哈希: team.contentHash,
    }),
  );
  console.log(`说明=${team.description || "-"}`);
  console.log(`推荐公司类型=${team.recommendedForCompanyTypes.join(",") || "-"}`);
  console.log(`标签=${team.tags.join(",") || "-"}`);
  console.log(
    `数量=智能体:${team.counts.agents},项目:${team.counts.projects},任务:${team.counts.tasks},技能:${team.counts.localSkills + team.counts.catalogSkills}`,
  );
  console.log("文件：");
  printTable(team.files.map((file) => ({
    路径: file.path,
    类型: file.kind,
    字节数: file.sizeBytes,
    sha256: file.sha256,
  })));
}

function printCatalogTeamPreview(result: CatalogTeamImportPreviewResult | null): void {
  if (!result) {
    console.log("团队目录预览未返回结果。");
    return;
  }
  const preview = result.portabilityPreview;
  console.log(
    `团队目录预览：${result.team.name}（${result.team.key}）智能体=${preview.plan.agentPlans.length} 项目=${preview.plan.projectPlans.length} 任务=${preview.plan.issuePlans.length} 警告=${result.warnings.length} 错误=${result.errors.length}`,
  );
  for (const warning of result.warnings) console.log(`警告=${warning}`);
  for (const error of result.errors) console.log(`错误=${error}`);
}

function printCatalogTeamInstall(result: CatalogTeamInstallResult | null): void {
  if (!result) {
    console.log("团队目录安装未返回结果。");
    return;
  }
  console.log(
    `团队目录已安装：${result.team.name}（${result.team.key}）智能体=${result.portabilityImport.agents.length} 项目=${result.portabilityImport.projects.length} 警告=${result.warnings.length}`,
  );
  for (const warning of result.warnings) console.log(`警告=${warning}`);
}

function printInstallApprovalRequested(result: TeamInstallApprovalFallbackResult): void {
  console.log(
    formatInlineRecord({
      状态: result.status,
      审批编号: result.approval.id,
      审批状态: result.approval.status,
      类型: result.approval.type,
      目录引用: result.installAttempt.catalogRef,
      拒绝原因: result.installAttempt.deniedReason,
    }),
  );
  console.log("尚未执行安装。请先在工作台批准请求，再使用已授权令牌重新运行安装。");
}

function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  const columns = Object.keys(rows[0] ?? {});
  const widths = new Map(columns.map((column) => [column, column.length]));
  for (const row of rows) {
    for (const column of columns) {
      widths.set(column, Math.max(widths.get(column) ?? 0, renderTableValue(row[column]).length));
    }
  }
  console.log(columns.map((column) => column.padEnd(widths.get(column) ?? column.length)).join("  "));
  console.log(columns.map((column) => "-".repeat(widths.get(column) ?? column.length)).join("  "));
  for (const row of rows) {
    console.log(
      columns
        .map((column) => renderTableValue(row[column]).padEnd(widths.get(column) ?? column.length))
        .join("  "),
    );
  }
}

function renderTableValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
