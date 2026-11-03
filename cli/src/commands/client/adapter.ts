import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AdapterOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson?: string;
  refresh?: boolean;
  environmentId?: string;
}

export function registerAdapterCommands(program: Command): void {
  const adapter = program.command("adapter").description("适配器管理操作");

  addCommonClientOptions(
    adapter
      .command("list")
      .description("列出已注册适配器")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/adapters"), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addJsonPost(adapter, "install", "安装外部适配器", "/api/adapters/install");

  addCommonClientOptions(
    adapter
      .command("get")
      .description("获取一个适配器")
      .argument("<type>", "适配器类型")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/adapters/${type}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addAdapterPatch(adapter, "update", "更新适配器设置", "");
  addAdapterPatch(adapter, "override", "暂停或恢复内置适配器覆盖", "/override");
  addAdapterPost(adapter, "reload", "重新加载适配器", "/reload");
  addAdapterPost(adapter, "reinstall", "重新安装适配器", "/reinstall");

  addCommonClientOptions(
    adapter
      .command("delete")
      .description("删除外部适配器注册")
      .argument("<type>", "适配器类型")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.delete(apiPath`/api/adapters/${type}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    adapter
      .command("config-schema")
      .description("获取适配器配置结构")
      .argument("<type>", "适配器类型")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/adapters/${type}/config-schema`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    adapter
      .command("ui-parser")
      .description("获取适配器界面解析器 JavaScript")
      .argument("<type>", "适配器类型")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/adapters/${type}/ui-parser.js`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    adapter
      .command("models")
      .description("列出公司的适配器模型")
      .argument("<type>", "适配器类型")
      .option("-C, --company-id <id>", "公司编号")
      .option("--refresh", "刷新服务商模型列表", false)
      .option("--environment-id <id>", "支持环境感知的适配器所使用的环境编号")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams();
          if (opts.refresh) query.set("refresh", "true");
          if (opts.environmentId?.trim()) query.set("environmentId", opts.environmentId.trim());
          const suffix = query.size > 0 ? `?${query.toString()}` : "";
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/adapters/${type}/models`}${suffix}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCompanyAdapterGet(adapter, "detect-model", "检测适配器模型", "detect-model");
  addCompanyAdapterPost(adapter, "test-environment", "测试适配器环境配置", "test-environment");
}

function addJsonPost(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent.command(name).description(description).requiredOption("--payload-json <json>", "JSON 数据").action(async (opts: AdapterOptions) => {
      try {
        const ctx = resolveCommandContext(opts);
        printOutput(await ctx.api.post(path, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
  );
}

function addAdapterPatch(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<type>", "适配器类型")
      .requiredOption("--payload-json <json>", "JSON 数据")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.patch(`${apiPath`/api/adapters/${type}`}${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addAdapterPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<type>", "适配器类型")
      .option("--payload-json <json>", "JSON 数据", "{}")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(`${apiPath`/api/adapters/${type}`}${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addCompanyAdapterGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<type>", "适配器类型")
      .option("-C, --company-id <id>", "公司编号")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/adapters/${type}`}/${suffix}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyAdapterPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<type>", "适配器类型")
      .option("-C, --company-id <id>", "公司编号")
      .option("--payload-json <json>", "JSON 数据", "{}")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}/adapters/${type}`}/${suffix}`, parseJson(opts.payloadJson ?? "{}")),
            { json: ctx.json },
          );
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
