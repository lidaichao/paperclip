import { Command } from "commander";
import type { Project } from "@paperclipai/shared";
import { createProjectSchema, updateProjectSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface ProjectListOptions extends BaseClientOptions {
  companyId?: string;
}

interface ProjectCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  description?: string;
  status?: string;
  goalId?: string;
  goalIds?: string;
  leadAgentId?: string;
  targetDate?: string;
  color?: string;
  envJson?: string;
  executionWorkspacePolicyJson?: string;
}

interface ProjectUpdateOptions extends BaseClientOptions {
  name?: string;
  description?: string;
  status?: string;
  goalId?: string;
  goalIds?: string;
  leadAgentId?: string;
  targetDate?: string;
  color?: string;
  envJson?: string;
  executionWorkspacePolicyJson?: string;
  archivedAt?: string;
}

interface ProjectDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("项目操作");

  addCommonClientOptions(
    project
      .command("list")
      .description("列出公司项目")
      .option("-C, --company-id <id>", "公司编号")
      .action(async (opts: ProjectListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Project[]>(apiPath`/api/companies/${ctx.companyId}/projects`)) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              id: row.id,
              name: row.name,
              status: row.status,
              urlKey: row.urlKey,
              goalIds: row.goalIds?.join(",") ?? "",
              leadAgentId: row.leadAgentId,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("get")
      .description("按编号或短名称获取项目")
      .argument("<project>", "项目编号或短名称")
      .option("-C, --company-id <id>", "短名称查询使用的公司编号")
      .action(async (projectRef: string, opts: ProjectListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = ctx.companyId ? `?${new URLSearchParams({ companyId: ctx.companyId }).toString()}` : "";
          const row = await ctx.api.get<Project>(`${apiPath`/api/projects/${projectRef}`}${query}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("create")
      .description("创建项目")
      .requiredOption("-C, --company-id <id>", "公司编号")
      .requiredOption("--name <name>", "项目名称")
      .option("--description <text>", "项目描述")
      .option("--status <status>", "项目状态")
      .option("--goal-id <id>", "已弃用的单个目标编号")
      .option("--goal-ids <csv>", "用逗号分隔的目标编号")
      .option("--lead-agent-id <id>", "负责人智能体编号")
      .option("--target-date <date>", "目标日期")
      .option("--color <value>", "项目颜色")
      .option("--env-json <json>", "项目环境绑定 JSON")
      .option("--execution-workspace-policy-json <json>", "执行工作区策略 JSON")
      .action(async (opts: ProjectCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createProjectSchema.parse({
            name: opts.name,
            description: opts.description,
            status: opts.status,
            goalId: parseNullableString(opts.goalId),
            goalIds: parseCsv(opts.goalIds),
            leadAgentId: parseNullableString(opts.leadAgentId),
            targetDate: parseNullableString(opts.targetDate),
            color: parseNullableString(opts.color),
            env: parseOptionalJson(opts.envJson),
            executionWorkspacePolicy: parseOptionalJson(opts.executionWorkspacePolicyJson),
          });
          const created = await ctx.api.post<Project>(apiPath`/api/companies/${ctx.companyId}/projects`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("update")
      .description("更新项目")
      .argument("<project>", "项目编号或短名称")
      .option("-C, --company-id <id>", "短名称查询使用的公司编号")
      .option("--name <name>", "项目名称")
      .option("--description <text|null>", "项目描述")
      .option("--status <status>", "项目状态")
      .option("--goal-id <id|null>", "已弃用的单个目标编号")
      .option("--goal-ids <csv>", "用逗号分隔的目标编号")
      .option("--lead-agent-id <id|null>", "负责人智能体编号")
      .option("--target-date <date|null>", "目标日期")
      .option("--color <value|null>", "项目颜色")
      .option("--env-json <json|null>", "项目环境绑定 JSON")
      .option("--execution-workspace-policy-json <json|null>", "执行工作区策略 JSON")
      .option("--archived-at <iso8601|null>", "归档时间戳或 null")
      .action(async (projectRef: string, opts: ProjectUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateProjectSchema.parse({
            name: opts.name,
            description: parseNullableString(opts.description),
            status: opts.status,
            goalId: parseNullableString(opts.goalId),
            goalIds: opts.goalIds === undefined ? undefined : parseCsv(opts.goalIds),
            leadAgentId: parseNullableString(opts.leadAgentId),
            targetDate: parseNullableString(opts.targetDate),
            color: parseNullableString(opts.color),
            env: parseOptionalJson(opts.envJson),
            executionWorkspacePolicy: parseOptionalJson(opts.executionWorkspacePolicyJson),
            archivedAt: parseNullableString(opts.archivedAt),
          });
          const query = ctx.companyId ? `?${new URLSearchParams({ companyId: ctx.companyId }).toString()}` : "";
          const updated = await ctx.api.patch<Project>(`${apiPath`/api/projects/${projectRef}`}${query}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("delete")
      .description("删除项目")
      .argument("<project>", "项目编号或短名称")
      .option("-C, --company-id <id>", "短名称查询使用的公司编号")
      .option("--yes", "确认删除")
      .action(async (projectRef: string, opts: ProjectDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("删除操作必须提供 --yes。");
          const ctx = resolveCommandContext(opts);
          const query = ctx.companyId ? `?${new URLSearchParams({ companyId: ctx.companyId }).toString()}` : "";
          const deleted = await ctx.api.delete<Project>(`${apiPath`/api/projects/${projectRef}`}${query}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function parseNullableString(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase() === "null" ? null : value;
}

function parseOptionalJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "null") return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`JSON 无效：${err instanceof Error ? err.message : String(err)}`);
  }
}
