import { Command } from "commander";
import {
  agentSkillAssignmentModeSchema,
  type AgentSkillAssignmentMode,
  type Agent,
  type AgentSkillSnapshot,
  type CatalogSkill,
  type CompanySkill,
  type CompanySkillAuditResult,
  type CompanySkillDetail,
  type CompanySkillFileDetail,
  type CompanySkillImportResult,
  type CompanySkillInstallCatalogResult,
  type CompanySkillListItem,
  type CompanySkillProjectScanResult,
  type CompanySkillUpdateStatus,
} from "@paperclipai/shared";
import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

interface SkillsOptions extends BaseClientOptions {
  companyId?: string;
}

interface SkillFileOptions extends SkillsOptions {
  path?: string;
}

interface SkillCreateOptions extends SkillsOptions {
  name: string;
  slug?: string;
  description?: string;
  bodyFile?: string;
}

interface SkillScanProjectsOptions extends SkillsOptions {
  projectId?: string[];
  workspaceId?: string[];
}

interface CatalogBrowseOptions extends BaseClientOptions {
  kind?: string;
  category?: string;
  query?: string;
}

interface CatalogInstallOptions extends SkillsOptions {
  as?: string;
  force?: boolean;
}

interface SkillUpdateOptions extends SkillsOptions {
  all?: boolean;
  force?: boolean;
}

interface ConfirmedSkillOptions extends SkillsOptions {
  yes?: boolean;
  force?: boolean;
}

interface AgentSkillSyncOptions extends SkillsOptions {
  skill?: string[];
  mode: AgentSkillAssignmentMode;
}

type CompanySkillReferenceTarget = Pick<CompanySkillListItem, "id" | "key" | "slug" | "name">;

export interface CompanySkillCheckRow {
  skill: CompanySkillReferenceTarget;
  status: CompanySkillUpdateStatus;
}

export interface CompanySkillUpdateRow {
  skillRef: string;
  action: "updated" | "skipped" | "failed";
  skill?: CompanySkill;
  status?: CompanySkillUpdateStatus;
  reason?: string;
}

export function registerSkillsCommands(program: Command): void {
  const skills = program.command("skills").description("公司与智能体技能操作");

  addCommonClientOptions(
    skills
      .command("browse")
      .description("浏览应用内置技能目录，不执行安装")
      .option("--kind <kind>", "按目录类型筛选（bundled 或 optional）")
      .option("--category <slug>", "按目录分类筛选")
      .option("--query <text>", "搜索目录内容")
      .action(async (opts: CatalogBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogSkills(ctx, opts);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogSkillRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    skills
      .command("search")
      .description("搜索应用内置技能目录，不执行安装")
      .argument("<query>", "搜索内容")
      .option("--kind <kind>", "按目录类型筛选（bundled 或 optional）")
      .option("--category <slug>", "按目录分类筛选")
      .action(async (query: string, opts: CatalogBrowseOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCatalogSkills(ctx, { ...opts, query });
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCatalogSkillRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    skills
      .command("inspect")
      .description("安装前检查应用内置技能")
      .argument("<catalogRef>", "技能目录 ID、键名或唯一标识")
      .action(async (catalogRef: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const detail = await getCatalogSkill(ctx, catalogRef);
          if (ctx.json) {
            printOutput(detail, { json: true });
            return;
          }
          printCatalogSkillDetail(detail);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    skills
      .command("install")
      .description("将目录技能安装到公司技能库，但不分配给智能体")
      .argument("<catalogRef>", "技能目录 ID、键名或唯一标识")
      .option("--as <slug>", "覆盖公司技能标识")
      .option("--force", "服务端允许时替换同键名的目录托管技能", false)
      .action(async (catalogRef: string, opts: CatalogInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CompanySkillInstallCatalogResult>(
            `/api/companies/${ctx.companyId}/skills/install-catalog`,
            {
              catalogSkillId: catalogRef,
              slug: opts.as,
              force: opts.force || undefined,
            },
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          printCatalogInstallResult(result);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("list")
      .description("列出公司技能")
      .action(async (opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await listCompanySkills(ctx);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCompanySkillRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("show")
      .description("显示公司技能详情")
      .argument("<skillRef>", "公司技能 ID、键名或唯一标识")
      .action(async (skillRef: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          const detail = await ctx.api.get<CompanySkillDetail>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}`,
          );
          printOutput(detail, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("file")
      .description("输出公司技能文件")
      .argument("<skillRef>", "公司技能 ID、键名或唯一标识")
      .option("--path <path>", "相对文件路径", "SKILL.md")
      .action(async (skillRef: string, opts: SkillFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          const params = new URLSearchParams({ path: opts.path?.trim() || "SKILL.md" });
          const file = await ctx.api.get<CompanySkillFileDetail>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/files?${params.toString()}`,
          );
          if (ctx.json) {
            printOutput(file, { json: true });
            return;
          }
          process.stdout.write(file?.content ?? "");
          if (file?.content && !file.content.endsWith("\n")) {
            process.stdout.write("\n");
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("import")
      .description("从本地路径、GitHub、skills.sh 或 URL 来源导入公司技能")
      .argument("<source>", "技能来源")
      .action(async (source: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CompanySkillImportResult>(
            `/api/companies/${ctx.companyId}/skills/import`,
            { source },
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          console.log(
            `已导入 ${result?.imported.length ?? 0} 个技能；警告=${result?.warnings.length ?? 0}`,
          );
          printCompanySkillRows(result?.imported ?? []);
          for (const warning of result?.warnings ?? []) {
            console.log(`警告=${warning}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("create")
      .description("创建托管的本地公司技能")
      .requiredOption("--name <name>", "技能名称")
      .option("--slug <slug>", "技能标识")
      .option("--description <text>", "技能说明")
      .option("--body-file <path>", "Markdown 正文文件；使用 - 从标准输入读取")
      .action(async (opts: SkillCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const markdown = opts.bodyFile ? await readBodyFile(opts.bodyFile) : undefined;
          const created = await ctx.api.post<CompanySkill>(
            `/api/companies/${ctx.companyId}/skills`,
            {
              name: opts.name,
              slug: opts.slug,
              description: opts.description,
              markdown,
            },
          );
          if (ctx.json) {
            printOutput(created, { json: true });
            return;
          }
          console.log(`已创建技能 ${created?.name ?? opts.name}（${created?.key ?? created?.id ?? "未知"}）`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("scan-projects")
      .description("扫描项目工作区中的技能")
      .option("--project-id <id>", "要扫描的项目 ID；可重复使用", collectOptionValue, [] as string[])
      .option("--workspace-id <id>", "要扫描的工作区 ID；可重复使用", collectOptionValue, [] as string[])
      .action(async (opts: SkillScanProjectsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post<CompanySkillProjectScanResult>(
            `/api/companies/${ctx.companyId}/skills/scan-projects`,
            {
              projectIds: emptyToUndefined(opts.projectId),
              workspaceIds: emptyToUndefined(opts.workspaceId),
            },
          );
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          console.log(
            `扫描结果：项目=${result?.scannedProjects ?? 0} 工作区=${result?.scannedWorkspaces ?? 0} 发现=${result?.discovered ?? 0} 导入=${result?.imported.length ?? 0} 更新=${result?.updated.length ?? 0} 跳过=${result?.skipped.length ?? 0} 冲突=${result?.conflicts.length ?? 0} 警告=${result?.warnings.length ?? 0}`,
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("check")
      .description("检查公司技能更新状态")
      .argument("[skillRef]", "公司技能 ID、键名或唯一标识")
      .action(async (skillRef: string | undefined, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await checkCompanySkills(ctx, skillRef);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          printCompanySkillCheckRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("update")
      .description("安装公司技能更新")
      .argument("[skillRef]", "公司技能 ID、键名或唯一标识")
      .option("--all", "检查全部技能并安装可用更新", false)
      .option("--force", "忽略本地修改或软性审计拦截；硬性审计问题仍会失败", false)
      .action(async (skillRef: string | undefined, opts: SkillUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (opts.all && skillRef?.trim()) {
            throw new Error("技能引用和 --all 只能使用其中一个。");
          }
          const rows = opts.all
            ? await updateAllCompanySkills(ctx, opts)
            : [await updateOneCompanySkill(ctx, requireSkillRef(skillRef), opts)];
          if (ctx.json) {
            printOutput(rows.length === 1 && !opts.all ? rows[0] : rows, { json: true });
            return;
          }
          printCompanySkillUpdateRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("audit")
      .description("审计已安装的公司技能文件，但不执行它们")
      .argument("[skillRef]", "公司技能 ID、键名或唯一标识")
      .action(async (skillRef: string | undefined, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = await auditCompanySkills(ctx, skillRef);
          if (ctx.json) {
            printOutput(rows.length === 1 && skillRef ? rows[0]?.audit : rows, { json: true });
            return;
          }
          printCompanySkillAuditRows(rows);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("reset")
      .description("将目录托管的公司技能重置到固定的安装来源")
      .argument("<skillRef>", "公司技能 ID、键名或唯一标识")
      .option("--yes", "直接确认重置，不再询问", false)
      .option("--force", "放弃本地修改或接受软性审计警告；硬性审计问题仍会失败", false)
      .action(async (skillRef: string, opts: ConfirmedSkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          await confirmDangerousAction(opts.yes, `是否将目录技能“${skill.name}”（${skill.key}）重置到固定来源？`);
          const reset = await ctx.api.post<CompanySkill>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/reset`,
            { force: opts.force || undefined },
          );
          if (ctx.json) {
            printOutput(reset, { json: true });
            return;
          }
          console.log(`已将技能 ${reset?.name ?? skill.name}（${reset?.key ?? skill.key}）重置到固定来源。`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    skills
      .command("remove")
      .description("移除公司技能")
      .argument("<skillRef>", "公司技能 ID、键名或唯一标识")
      .option("--yes", "直接确认移除，不再询问", false)
      .action(async (skillRef: string, opts: ConfirmedSkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const skill = await resolveCompanySkill(ctx, skillRef);
          await confirmDangerousAction(opts.yes, `是否移除公司技能“${skill.name}”（${skill.key}）？`);
          const removed = await ctx.api.delete<CompanySkill>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}`,
          );
          if (ctx.json) {
            printOutput(removed, { json: true });
            return;
          }
          console.log(`已移除技能 ${removed?.name ?? skill.name}（${removed?.key ?? skill.key}）`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  registerAgentSkillCommands(skills);
}

function registerAgentSkillCommands(skills: Command): void {
  const agent = skills.command("agent").description("智能体指定技能与运行时同步操作");

  addCommonClientOptions(
    agent
      .command("list")
      .description("列出智能体运行时技能快照")
      .argument("<agentRef>", "智能体 ID、短名称或 URL 键名")
      .action(async (agentRef: string, opts: SkillsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx, agentRef);
          const snapshot = await ctx.api.get<AgentSkillSnapshot>(
            `/api/agents/${encodeURIComponent(agentRow.id)}/skills`,
          );
          if (ctx.json) {
            printOutput(snapshot, { json: true });
            return;
          }
          printAgentSkillSnapshot(snapshot, agentRow);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    agent
      .command("sync")
      .description("合并智能体指定的公司技能并同步运行时状态")
      .argument("<agentRef>", "智能体 ID、短名称或 URL 键名")
      .option("--skill <skillRef>", "指定的公司技能 ID、键名或标识；可重复使用", collectOptionValue, [] as string[])
      .requiredOption(
        "--mode <mode>",
        "合并模式：add 保留其他技能；remove 只删除指定技能；replace 会覆盖完整技能集合",
      )
      .action(async (agentRef: string, opts: AgentSkillSyncOptions) => {
        try {
          const desiredSkills = opts.skill ?? [];
          if (desiredSkills.length === 0) {
            throw new Error("同步智能体技能时至少需要一个 --skill 值。");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx, agentRef);
          const mode = agentSkillAssignmentModeSchema.parse(opts.mode);
          const snapshot = await ctx.api.post<AgentSkillSnapshot>(
            `/api/agents/${encodeURIComponent(agentRow.id)}/skills/sync`,
            { desiredSkills, mode },
          );
          if (ctx.json) {
            printOutput(snapshot, { json: true });
            return;
          }
          console.log(
            `已使用 ${mode} 模式更新 ${agentRow.name}（${agentRow.id}）的指定公司技能；运行时同步返回 ${snapshot?.entries.length ?? 0} 条记录。`,
          );
          printAgentSkillSnapshot(snapshot, agentRow);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    agent
      .command("clear")
      .description("清除智能体指定的公司技能并同步运行时状态")
      .argument("<agentRef>", "智能体 ID、短名称或 URL 键名")
      .option("--yes", "直接确认清除，不再询问", false)
      .action(async (agentRef: string, opts: ConfirmedSkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const agentRow = await resolveAgent(ctx, agentRef);
          await confirmDangerousAction(
            opts.yes,
            `是否清除“${agentRow.name}”（${agentRow.id}）指定的公司技能？`,
          );
          const snapshot = await ctx.api.post<AgentSkillSnapshot>(
            `/api/agents/${encodeURIComponent(agentRow.id)}/skills/sync`,
            { desiredSkills: [], mode: "replace" },
          );
          if (ctx.json) {
            printOutput(snapshot, { json: true });
            return;
          }
          console.log(
            `已清除 ${agentRow.name}（${agentRow.id}）指定的公司技能。`,
          );
          printAgentSkillSnapshot(snapshot, agentRow);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

async function listCompanySkills(ctx: ResolvedClientContext): Promise<CompanySkillListItem[]> {
  return (await ctx.api.get<CompanySkillListItem[]>(`/api/companies/${ctx.companyId}/skills`)) ?? [];
}

async function listCatalogSkills(
  ctx: ResolvedClientContext,
  opts: CatalogBrowseOptions,
): Promise<CatalogSkill[]> {
  const params = new URLSearchParams();
  appendQueryParam(params, "kind", opts.kind);
  appendQueryParam(params, "category", opts.category);
  appendQueryParam(params, "q", opts.query);
  const query = params.toString();
  return (await ctx.api.get<CatalogSkill[]>(`/api/skills/catalog${query ? `?${query}` : ""}`)) ?? [];
}

async function getCatalogSkill(ctx: ResolvedClientContext, catalogRef: string): Promise<CatalogSkill> {
  const ref = catalogRef.trim();
  if (!ref) {
    throw new Error("必须提供技能目录引用。");
  }
  const detail = await ctx.api.get<CatalogSkill>(`/api/skills/catalog/ref?ref=${encodeURIComponent(ref)}`);
  if (!detail) {
    throw new Error(`未找到技能目录：${catalogRef}`);
  }
  return detail;
}

export function resolveCompanySkillReference(
  skills: CompanySkillReferenceTarget[],
  reference: string,
): CompanySkillReferenceTarget {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error("必须提供技能引用。");
  }

  const byId = skills.find((skill) => skill.id === trimmed);
  if (byId) return byId;

  const byKey = skills.find((skill) => skill.key === trimmed);
  if (byKey) return byKey;

  const normalizedSlug = normalizeSkillSlug(trimmed);
  const bySlug = skills.filter((skill) => skill.slug === normalizedSlug);
  if (bySlug.length === 1 && bySlug[0]) return bySlug[0];
  if (bySlug.length > 1) {
    throw new Error(`技能标识“${trimmed}”不唯一。请改用技能 ID 或键名。`);
  }

  throw new Error(`未找到技能：${reference}`);
}

async function resolveCompanySkill(
  ctx: ResolvedClientContext,
  reference: string,
): Promise<CompanySkillReferenceTarget> {
  return resolveCompanySkillReference(await listCompanySkills(ctx), reference);
}

async function checkCompanySkills(
  ctx: ResolvedClientContext,
  skillRef: string | undefined,
): Promise<CompanySkillCheckRow[]> {
  const skills = await listCompanySkills(ctx);
  const selected = skillRef ? [resolveCompanySkillReference(skills, skillRef)] : skills;
  const rows: CompanySkillCheckRow[] = [];
  for (const skill of selected) {
    const status = await ctx.api.get<CompanySkillUpdateStatus>(
      `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/update-status`,
    );
    if (!status) {
      throw new Error(`技能 ${skill.key} 未返回更新状态。`);
    }
    rows.push({ skill: toSkillReferenceTarget(skill), status });
  }
  return rows;
}

async function updateOneCompanySkill(
  ctx: ResolvedClientContext,
  skillRef: string,
  opts: SkillUpdateOptions = {},
): Promise<CompanySkillUpdateRow> {
  const skill = await resolveCompanySkill(ctx, skillRef);
  const updated = await ctx.api.post<CompanySkill>(
    `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/install-update`,
    { force: opts.force || undefined },
  );
  return {
    skillRef,
    action: "updated",
    skill: updated ?? undefined,
  };
}

async function updateAllCompanySkills(ctx: ResolvedClientContext, opts: SkillUpdateOptions = {}): Promise<CompanySkillUpdateRow[]> {
  const checks = await checkCompanySkills(ctx, undefined);
  const rows: CompanySkillUpdateRow[] = [];
  for (const row of checks) {
    if (!row.status.supported) {
      rows.push({
        skillRef: row.skill.key,
        action: "skipped",
        status: row.status,
        reason: row.status.reason ?? "该技能不支持更新检查。",
      });
      continue;
    }
    if (!row.status.hasUpdate) {
      rows.push({
        skillRef: row.skill.key,
        action: "skipped",
        status: row.status,
        reason: "已是最新版本。",
      });
      continue;
    }
    try {
      const updated = await ctx.api.post<CompanySkill>(
        `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(row.skill.id)}/install-update`,
        { force: opts.force || undefined },
      );
      rows.push({
        skillRef: row.skill.key,
        action: "updated",
        status: row.status,
        skill: updated ?? undefined,
      });
    } catch (err) {
      rows.push({
        skillRef: row.skill.key,
        action: "failed",
        status: row.status,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows;
}

async function auditCompanySkills(
  ctx: ResolvedClientContext,
  skillRef: string | undefined,
): Promise<Array<{ skill: CompanySkillReferenceTarget; audit: CompanySkillAuditResult }>> {
  const skills = await listCompanySkills(ctx);
  const selected = skillRef ? [resolveCompanySkillReference(skills, skillRef)] : skills;
  const rows: Array<{ skill: CompanySkillReferenceTarget; audit: CompanySkillAuditResult }> = [];
  for (const skill of selected) {
    const audit = await ctx.api.post<CompanySkillAuditResult>(
      `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skill.id)}/audit`,
      {},
    );
    if (!audit) {
      throw new Error(`技能 ${skill.key} 未返回审计结果。`);
    }
    rows.push({ skill: toSkillReferenceTarget(skill), audit });
  }
  return rows;
}

async function resolveAgent(ctx: ResolvedClientContext, agentRef: string): Promise<Agent> {
  const params = new URLSearchParams({ companyId: ctx.companyId ?? "" });
  const agent = await ctx.api.get<Agent>(`/api/agents/${encodeURIComponent(agentRef)}?${params.toString()}`);
  if (!agent) {
    throw new Error(`未找到智能体：${agentRef}`);
  }
  return agent;
}

function printCompanySkillRows(rows: Array<CompanySkillListItem | CompanySkill>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        编号: row.id,
        键名: row.key,
        标识: row.slug,
        名称: row.name,
        来源: "sourceBadge" in row ? row.sourceBadge : row.sourceType,
        信任级别: row.trustLevel,
        兼容性: row.compatibility,
        已分配智能体: "attachedAgentCount" in row ? row.attachedAgentCount : undefined,
      }),
    );
  }
}

function printCatalogSkillRows(rows: CatalogSkill[]): void {
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
    适用角色: row.recommendedForRoles.join(",") || "-",
  })));
}

function printCatalogSkillDetail(skill: CatalogSkill): void {
  console.log(
    formatInlineRecord({
      编号: skill.id,
      键名: skill.key,
      类型: skill.kind,
      分类: skill.category,
      标识: skill.slug,
      名称: skill.name,
      信任级别: skill.trustLevel,
      兼容性: skill.compatibility,
      内容哈希: skill.contentHash,
    }),
  );
  console.log(`说明=${skill.description || "-"}`);
  console.log(`推荐角色=${skill.recommendedForRoles.join(",") || "-"}`);
  console.log(`标签=${skill.tags.join(",") || "-"}`);
  console.log("文件：");
  printTable(skill.files.map((file) => ({
    路径: file.path,
    类型: file.kind,
    字节数: file.sizeBytes,
    sha256: file.sha256,
  })));
}

function printCatalogInstallResult(result: CompanySkillInstallCatalogResult | null): void {
  if (!result) {
    console.log("技能目录安装未返回结果。");
    return;
  }
  console.log(
    `技能目录操作 ${result.action}：已将 ${result.skill.name}（${result.skill.key}）写入公司技能库。`,
  );
  console.log(
    "此操作不会把技能分配给智能体。需要使用时，请运行 `paperclipai skills agent sync <智能体> --skill <技能>`。",
  );
  for (const warning of result.warnings) {
    console.log(`警告=${warning}`);
  }
}

function printCompanySkillCheckRows(rows: CompanySkillCheckRow[]): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        编号: row.skill.id,
        键名: row.skill.key,
        标识: row.skill.slug,
        名称: row.skill.name,
        支持更新: row.status.supported,
        存在更新: row.status.hasUpdate,
        当前版本: row.status.currentRef,
        最新版本: row.status.latestRef,
        安装哈希: row.status.installedHash,
        来源哈希: row.status.originHash,
        暂停原因: row.status.updateHoldReason,
        审计结果: row.status.auditVerdict,
        原因: row.status.reason,
      }),
    );
  }
}

function printCompanySkillAuditRows(rows: Array<{ skill: CompanySkillReferenceTarget; audit: CompanySkillAuditResult }>): void {
  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        编号: row.skill.id,
        键名: row.skill.key,
        标识: row.skill.slug,
        结论: row.audit.verdict,
        安装哈希: row.audit.installedHash,
        来源哈希: row.audit.originHash,
        代码: row.audit.codes.join(",") || null,
      }),
    );
    for (const finding of row.audit.findings) {
      console.log(
        formatInlineRecord({
          严重程度: finding.severity,
          代码: finding.code,
          路径: finding.path,
          信息: finding.message,
        }),
      );
    }
  }
}

function printCompanySkillUpdateRows(rows: CompanySkillUpdateRow[]): void {
  for (const row of rows) {
    console.log(
      formatInlineRecord({
        操作: row.action,
        技能引用: row.skillRef,
        键名: row.skill?.key,
        标识: row.skill?.slug,
        存在更新: row.status?.hasUpdate,
        原因: row.reason,
      }),
    );
  }
}

function printAgentSkillSnapshot(snapshot: AgentSkillSnapshot | null, agent: Agent): void {
  if (!snapshot) {
    console.log(`智能体 ${agent.name}（${agent.id}）未返回技能快照。`);
    return;
  }
  console.log(
    `智能体 ${agent.name}（${agent.id}）适配器=${snapshot.adapterType} 支持同步=${snapshot.supported} 模式=${snapshot.mode} 指定公司技能=${snapshot.desiredSkills.length}`,
  );
  if (snapshot.warnings.length > 0) {
    for (const warning of snapshot.warnings) {
      console.log(`警告=${warning}`);
    }
  }
  if (snapshot.entries.length === 0) {
    printOutput([], { json: false });
    return;
  }
  for (const entry of snapshot.entries) {
    console.log(
      formatInlineRecord({
        键名: entry.key,
        运行时名称: entry.runtimeName,
        已指定: entry.desired,
        受管理: entry.managed,
        状态: entry.state,
        来源: entry.origin,
        详情: entry.detail,
      }),
    );
  }
}

function toSkillReferenceTarget(skill: CompanySkillReferenceTarget): CompanySkillReferenceTarget {
  return {
    id: skill.id,
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
  };
}

function normalizeSkillSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function requireSkillRef(skillRef: string | undefined): string {
  if (!skillRef?.trim()) {
    throw new Error("未使用 --all 时必须提供技能引用。");
  }
  return skillRef;
}

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function emptyToUndefined(values: string[] | undefined): string[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function appendQueryParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) {
    params.set(key, trimmed);
  }
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
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

async function readBodyFile(filePath: string): Promise<string> {
  if (filePath === "-") {
    return readStdin();
  }
  return readFile(filePath, "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function confirmDangerousAction(yes: boolean | undefined, message: string): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("非交互式终端必须使用 --yes 执行此命令。");
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${message} 输入 yes 继续：`)).trim().toLowerCase();
    if (answer !== "yes") {
      throw new Error("已取消。");
    }
  } finally {
    rl.close();
  }
}
