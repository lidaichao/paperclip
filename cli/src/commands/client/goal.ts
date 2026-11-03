import { Command } from "commander";
import type { Goal } from "@paperclipai/shared";
import { createGoalSchema, updateGoalSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface GoalListOptions extends BaseClientOptions {
  companyId?: string;
}

interface GoalCreateOptions extends BaseClientOptions {
  companyId?: string;
  title: string;
  description?: string;
  level?: string;
  status?: string;
  parentId?: string;
  ownerAgentId?: string;
}

interface GoalUpdateOptions extends BaseClientOptions {
  title?: string;
  description?: string;
  level?: string;
  status?: string;
  parentId?: string;
  ownerAgentId?: string;
}

interface GoalDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

export function registerGoalCommands(program: Command): void {
  const goal = program.command("goal").description("目标操作");

  addCommonClientOptions(
    goal
      .command("list")
      .description("列出公司目标")
      .option("-C, --company-id <id>", "公司编号")
      .action(async (opts: GoalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Goal[]>(apiPath`/api/companies/${ctx.companyId}/goals`)) ?? [];
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
              status: row.status,
              title: row.title,
              level: row.level,
              parentId: row.parentId,
              ownerAgentId: row.ownerAgentId,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    goal
      .command("get")
      .description("获取一个目标")
      .argument("<goalId>", "目标编号")
      .action(async (goalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Goal>(apiPath`/api/goals/${goalId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    goal
      .command("create")
      .description("创建目标")
      .requiredOption("-C, --company-id <id>", "公司编号")
      .requiredOption("--title <title>", "目标标题")
      .option("--description <text>", "目标描述")
      .option("--level <level>", "目标层级")
      .option("--status <status>", "目标状态")
      .option("--parent-id <id>", "父目标编号")
      .option("--owner-agent-id <id>", "负责智能体编号")
      .action(async (opts: GoalCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createGoalSchema.parse({
            title: opts.title,
            description: opts.description,
            level: opts.level,
            status: opts.status,
            parentId: parseNullableString(opts.parentId),
            ownerAgentId: parseNullableString(opts.ownerAgentId),
          });
          const created = await ctx.api.post<Goal>(apiPath`/api/companies/${ctx.companyId}/goals`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    goal
      .command("update")
      .description("更新目标")
      .argument("<goalId>", "目标编号")
      .option("--title <title>", "目标标题")
      .option("--description <text|null>", "目标描述")
      .option("--level <level>", "目标层级")
      .option("--status <status>", "目标状态")
      .option("--parent-id <id|null>", "父目标编号")
      .option("--owner-agent-id <id|null>", "负责智能体编号")
      .action(async (goalId: string, opts: GoalUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateGoalSchema.parse({
            title: opts.title,
            description: parseNullableString(opts.description),
            level: opts.level,
            status: opts.status,
            parentId: parseNullableString(opts.parentId),
            ownerAgentId: parseNullableString(opts.ownerAgentId),
          });
          const updated = await ctx.api.patch<Goal>(apiPath`/api/goals/${goalId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    goal
      .command("delete")
      .description("删除目标")
      .argument("<goalId>", "目标编号")
      .option("--yes", "确认删除")
      .action(async (goalId: string, opts: GoalDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("删除操作必须提供 --yes。");
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<Goal>(apiPath`/api/goals/${goalId}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseNullableString(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase() === "null" ? null : value;
}
