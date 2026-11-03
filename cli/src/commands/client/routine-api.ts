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
  projectId?: string;
}

interface JsonOptions extends CompanyOptions {
  payloadJson?: string;
  limit?: string;
}

export function registerRoutineApiCommands(program: Command): void {
  const routine = program.command("routine").description("例行任务接口操作");
  addCommonClientOptions(
    routine
      .command("list")
      .description("列出例行任务")
      .option("-C, --company-id <id>", "公司编号")
      .option("--project-id <id>", "按项目编号筛选")
      .action(async (opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = opts.projectId ? `?${new URLSearchParams({ projectId: opts.projectId }).toString()}` : "";
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/routines`}${query}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
  addCompanyPost(routine, "create", "创建例行任务", "routines");
  addIdGet(routine, "get", "获取例行任务", "routines");
  addIdPatch(routine, "update", "更新例行任务", "routines");
  addIdGet(routine, "revisions", "列出例行任务修订版本", "routines", "revisions");
  addCommonClientOptions(
    routine
      .command("revision:restore")
      .description("恢复例行任务修订版本")
      .argument("<routineId>", "例行任务编号")
      .argument("<revisionId>", "修订版本编号")
      .action(async (routineId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/routines/${routineId}/revisions/${revisionId}/restore`, {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addCommonClientOptions(
    routine
      .command("runs")
      .description("列出例行任务运行记录")
      .argument("<routineId>", "例行任务编号")
      .option("--limit <n>", "最多返回的运行记录数")
      .action(async (routineId: string, opts: JsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.limit ? `?${new URLSearchParams({ limit: opts.limit }).toString()}` : "";
          printOutput(await ctx.api.get(`${apiPath`/api/routines/${routineId}/runs`}${query}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addIdPost(routine, "run", "运行例行任务", "routines", "run");
  addIdPost(routine, "trigger:create", "创建例行任务触发器", "routines", "triggers");
  addIdPatch(routine, "trigger:update", "更新例行任务触发器", "routine-triggers");
  addIdDelete(routine, "trigger:delete", "删除例行任务触发器", "routine-triggers");
  addIdPost(routine, "trigger:rotate-secret", "轮换例行任务触发器密钥", "routine-triggers", "rotate-secret");
  addCommonClientOptions(
    routine
      .command("trigger:fire")
      .description("触发公开例行任务触发器")
      .argument("<publicId>", "公开触发器编号")
      .option("--payload-json <json>", "公开触发器数据", "{}")
      .action(async (publicId: string, opts: JsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/routine-triggers/public/${publicId}/fire`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addCompanyPost(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).option("-C, --company-id <id>", "公司编号").requiredOption("--payload-json <json>", "JSON 数据").action(async (opts: JsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts, { requireCompany: true });
      printOutput(await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }), { includeCompany: false });
}

function addIdGet(parent: Command, name: string, description: string, resource: string, suffix?: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "编号").action(async (id: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(`/api/${resource}/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ""}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addIdPatch(parent: Command, name: string, description: string, resource: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "编号").requiredOption("--payload-json <json>", "JSON 数据").action(async (id: string, opts: JsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.patch(`/api/${resource}/${encodeURIComponent(id)}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addIdPost(parent: Command, name: string, description: string, resource: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "编号").option("--payload-json <json>", "JSON 数据", "{}").action(async (id: string, opts: JsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/${resource}/${encodeURIComponent(id)}/${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addIdDelete(parent: Command, name: string, description: string, resource: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "编号").action(async (id: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.delete(`/api/${resource}/${encodeURIComponent(id)}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
