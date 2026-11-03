import { Command } from "commander";
import type { DashboardSummary } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface DashboardGetOptions extends BaseClientOptions {
  companyId?: string;
}

export function registerDashboardCommands(program: Command): void {
  const dashboard = program.command("dashboard").description("仪表盘摘要操作");

  addCommonClientOptions(
    dashboard
      .command("get")
      .description("获取公司的仪表盘摘要")
      .requiredOption("-C, --company-id <id>", "公司编号")
      .action(async (opts: DashboardGetOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<DashboardSummary>(apiPath`/api/companies/${ctx.companyId}/dashboard`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
