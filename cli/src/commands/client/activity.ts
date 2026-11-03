import { Command } from "commander";
import type { ActivityEvent } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface ActivityListOptions extends BaseClientOptions {
  companyId?: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
  payloadJson?: string;
}

export function registerActivityCommands(program: Command): void {
  const activity = program.command("activity").description("活动日志操作");

  addCommonClientOptions(
    activity
      .command("list")
      .description("列出公司活动日志")
      .requiredOption("-C, --company-id <id>", "公司编号")
      .option("--agent-id <id>", "按智能体编号筛选")
      .option("--entity-type <type>", "按实体类型筛选")
      .option("--entity-id <id>", "按实体编号筛选")
      .action(async (opts: ActivityListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.agentId) params.set("agentId", opts.agentId);
          if (opts.entityType) params.set("entityType", opts.entityType);
          if (opts.entityId) params.set("entityId", opts.entityId);

          const query = params.toString();
          const path = `${apiPath`/api/companies/${ctx.companyId}/activity`}${query ? `?${query}` : ""}`;
          const rows = (await ctx.api.get<ActivityEvent[]>(path)) ?? [];

          if (ctx.json) {
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
                id: row.id,
                action: row.action,
                actorType: row.actorType,
                actorId: row.actorId,
                entityType: row.entityType,
                entityId: row.entityId,
                createdAt: String(row.createdAt),
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    activity
      .command("create")
      .description("创建公司活动日志")
      .requiredOption("-C, --company-id <id>", "公司编号")
      .requiredOption("--payload-json <json>", "CreateActivity JSON 数据")
      .action(async (opts: ActivityListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/activity`, parseJson(opts.payloadJson ?? "{}"));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    activity
      .command("issue")
      .description("列出任务活动")
      .argument("<issueId>", "任务编号")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/issues/${issueId}/activity`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
