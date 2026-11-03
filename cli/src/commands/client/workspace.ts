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

interface RuntimeActionOptions extends BaseClientOptions {
  payloadJson?: string;
}

interface OrgOutputOptions extends CompanyOptions {
  out?: string;
}

export function registerWorkspaceCommands(program: Command): void {
  const org = program.command("org").description("组织架构图操作");
  addCompanyGet(org, "get", "获取组织架构图数据", "org");
  addBinaryCompanyGet(org, "svg", "下载 SVG 格式组织架构图", "org.svg");
  addBinaryCompanyGet(org, "png", "下载 PNG 格式组织架构图", "org.png");
  addCompanyGet(program.command("agent-config").description("智能体配置摘要"), "list", "列出智能体配置", "agent-configurations");

  const workspace = program.command("workspace").description("执行工作区操作");
  addCompanyGet(workspace, "list", "列出执行工作区", "execution-workspaces");
  addIdGet(workspace, "get", "获取执行工作区", "execution-workspaces");
  addIdGet(workspace, "close-readiness", "检查执行工作区是否可关闭", "execution-workspaces", "close-readiness");
  addIdGet(workspace, "operations", "列出执行工作区操作", "execution-workspaces", "workspace-operations");
  addPatchJson(workspace, "update", "更新执行工作区", "execution-workspaces");
  addRuntimeAction(workspace, "runtime-service", "控制执行工作区运行时服务", "execution-workspaces", "runtime-services");
  addRuntimeAction(workspace, "runtime-command", "运行执行工作区命令", "execution-workspaces", "runtime-commands");

  const environment = program.command("environment").description("运行环境操作");
  addCompanyGet(environment, "list", "列出运行环境", "environments");
  addCompanyGet(environment, "capabilities", "获取运行环境能力", "environments/capabilities");
  addCompanyPostJson(environment, "create", "创建运行环境", "environments");
  addIdGet(environment, "get", "获取运行环境", "environments");
  addIdGet(environment, "leases", "列出运行环境租约", "environments", "leases");
  addCommonClientOptions(
    environment
      .command("lease")
      .description("获取运行环境租约")
      .argument("<leaseId>", "租约 ID")
      .action(async (leaseId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/environment-leases/${leaseId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addPatchJson(environment, "update", "更新运行环境", "environments");
  addDelete(environment, "delete", "删除运行环境", "environments");
  addPostEmpty(environment, "probe", "探测运行环境", "environments", "probe");
  addCompanyPostJson(environment, "probe-config", "探测运行环境配置", "environments/probe-config");

  const projectWorkspace = program.command("project-workspace").description("项目工作区操作");
  addCommonClientOptions(
    projectWorkspace
      .command("list")
      .description("列出项目工作区")
      .argument("<projectId>", "项目 ID")
      .action(async (projectId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/projects/${projectId}/workspaces`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addProjectWorkspaceJson(projectWorkspace, "create", "创建项目工作区", "post");
  addProjectWorkspaceJson(projectWorkspace, "update", "更新项目工作区", "patch");
  addCommonClientOptions(
    projectWorkspace
      .command("delete")
      .description("删除项目工作区")
      .argument("<projectId>", "项目 ID")
      .argument("<workspaceId>", "工作区 ID")
      .action(async (projectId: string, workspaceId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/projects/${projectId}/workspaces/${workspaceId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addProjectRuntimeAction(projectWorkspace, "runtime-service", "控制项目工作区运行时服务", "runtime-services");
  addProjectRuntimeAction(projectWorkspace, "runtime-command", "运行项目工作区命令", "runtime-commands");
}

function addCompanyGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "公司 ID")
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

function addBinaryCompanyGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "公司 ID")
      .option("--out <path>", "将输出写入文件")
      .action(async (opts: OrgOutputOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const response = await fetch(buildApiUrl(ctx.api.apiBase, `${apiPath`/api/companies/${ctx.companyId}`}/${path}`), {
            headers: ctx.api.apiKey ? { authorization: `Bearer ${ctx.api.apiKey}` } : undefined,
          });
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!response.ok) throw new Error(`API 错误 ${response.status}：${bytes.toString("utf8")}`);
          if (opts.out) {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(opts.out, bytes);
            printOutput({ out: opts.out, bytes: bytes.byteLength }, { json: ctx.json });
            return;
          }
          process.stdout.write(bytes);
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
      .option("-C, --company-id <id>", "公司 ID")
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

function addIdGet(parent: Command, name: string, description: string, resource: string, suffix?: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<id>", "ID")
      .action(async (id: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(`/api/${resource}/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ""}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addPatchJson(parent: Command, name: string, description: string, resource: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<id>", "ID")
      .requiredOption("--payload-json <json>", "JSON 数据")
      .action(async (id: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.patch(`/api/${resource}/${encodeURIComponent(id)}`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addDelete(parent: Command, name: string, description: string, resource: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<id>", "ID")
      .action(async (id: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(`/api/${resource}/${encodeURIComponent(id)}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addPostEmpty(parent: Command, name: string, description: string, resource: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<id>", "ID")
      .action(async (id: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(`/api/${resource}/${encodeURIComponent(id)}/${suffix}`, {});
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addRuntimeAction(parent: Command, name: string, description: string, resource: string, actionResource: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<id>", "工作区 ID")
      .argument("<action>", "可选值：start、stop、restart 或 run")
      .option("--payload-json <json>", "运行目标 JSON 数据", "{}")
      .action(async (id: string, action: string, opts: RuntimeActionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(`/api/${resource}/${encodeURIComponent(id)}/${actionResource}/${encodeURIComponent(action)}`, parseJson(opts.payloadJson ?? "{}"));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addProjectWorkspaceJson(parent: Command, name: string, description: string, method: "post" | "patch"): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<projectId>", "项目 ID")
      .argument("[workspaceId]", "更新时使用的工作区 ID")
      .requiredOption("--payload-json <json>", "JSON 数据")
      .action(async (projectId: string, workspaceId: string | undefined, opts: JsonPayloadOptions) => {
        try {
          if (method === "patch" && !workspaceId) throw new Error("更新时必须提供 workspaceId");
          const ctx = resolveCommandContext(opts);
          const path = method === "post"
            ? apiPath`/api/projects/${projectId}/workspaces`
            : apiPath`/api/projects/${projectId}/workspaces/${workspaceId}`;
          const result = method === "post"
            ? await ctx.api.post(path, parseJson(opts.payloadJson))
            : await ctx.api.patch(path, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addProjectRuntimeAction(parent: Command, name: string, description: string, actionResource: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<projectId>", "项目 ID")
      .argument("<workspaceId>", "工作区 ID")
      .argument("<action>", "可选值：start、stop、restart 或 run")
      .option("--payload-json <json>", "运行目标 JSON 数据", "{}")
      .action(async (projectId: string, workspaceId: string, action: string, opts: RuntimeActionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(
            `${apiPath`/api/projects/${projectId}/workspaces/${workspaceId}`}/${actionResource}/${encodeURIComponent(action)}`,
            parseJson(opts.payloadJson ?? "{}"),
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
