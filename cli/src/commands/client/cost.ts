import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOptions extends BaseClientOptions {
  companyId?: string;
}

interface JsonPayloadOptions extends CompanyOptions {
  payloadJson: string;
}

interface IncidentOptions extends CompanyOptions {
  payloadJson?: string;
}

export function registerCostCommands(program: Command): void {
  const cost = program.command("cost").description("成本与财务操作");

  for (const [name, path] of [
    ["summary", "costs/summary"],
    ["by-agent", "costs/by-agent"],
    ["by-agent-model", "costs/by-agent-model"],
    ["by-provider", "costs/by-provider"],
    ["by-biller", "costs/by-biller"],
    ["by-project", "costs/by-project"],
    ["window-spend", "costs/window-spend"],
    ["quota-windows", "costs/quota-windows"],
  ] as const) {
    addCompanyGet(cost, name, `获取 ${name} 成本数据`, path);
  }

  addCommonClientOptions(
    cost
      .command("issue")
      .description("获取任务成本摘要")
      .argument("<issueId>", "任务编号")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/issues/${issueId}/cost-summary`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCompanyPostJson(cost, "event:create", "记录成本事件", "cost-events");

  const finance = program.command("finance").description("财务事件与摘要操作");
  addCompanyPostJson(finance, "event:create", "记录财务事件", "finance-events");
  addCompanyGet(finance, "events", "列出财务事件", "costs/finance-events");
  addCompanyGet(finance, "summary", "获取财务摘要", "costs/finance-summary");
  addCompanyGet(finance, "by-biller", "按计费方获取财务摘要", "costs/finance-by-biller");
  addCompanyGet(finance, "by-kind", "按类型获取财务摘要", "costs/finance-by-kind");

  const budget = program.command("budget").description("预算策略与事件操作");
  addCompanyGet(budget, "overview", "获取预算概览", "budgets/overview");
  addCompanyPostJson(budget, "policy:upsert", "创建或更新预算策略", "budgets/policies");

  addCommonClientOptions(
    budget
      .command("company:update")
      .description("更新公司预算")
      .option("-C, --company-id <id>", "公司编号")
      .requiredOption("--payload-json <json>", "UpdateBudget JSON 数据")
      .action(async (opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.patch(apiPath`/api/companies/${ctx.companyId}/budgets`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    budget
      .command("agent:update")
      .description("更新智能体预算")
      .argument("<agentId>", "智能体编号")
      .requiredOption("--payload-json <json>", "UpdateBudget JSON 数据")
      .action(async (agentId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.patch(apiPath`/api/agents/${agentId}/budgets`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    budget
      .command("incident:resolve")
      .description("解决预算事件")
      .argument("<incidentId>", "预算事件编号")
      .option("-C, --company-id <id>", "公司编号")
      .option("--payload-json <json>", "ResolveBudgetIncident JSON 数据", "{}")
      .action(async (incidentId: string, opts: IncidentOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(
            apiPath`/api/companies/${ctx.companyId}/budget-incidents/${incidentId}/resolve`,
            parseJson(opts.payloadJson ?? "{}"),
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "公司编号")
      .action(async (opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyPostJson(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "公司编号")
      .requiredOption("--payload-json <json>", "JSON 数据")
      .action(async (opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
