import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SkillOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson?: string;
  path?: string;
}

export function registerSkillCommands(program: Command): void {
  const skill = program.command("skill").description("公司技能操作");

  addCompanyGet(skill, "list", "列出公司技能", "skills");

  addCommonClientOptions(
    skill
      .command("get")
      .description("获取公司技能详情")
      .argument("<skillId>", "技能编号")
      .option("-C, --company-id <id>", "公司编号")
      .action(async (skillId: string, opts: SkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/skills/${skillId}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("file")
      .description("读取公司技能文件")
      .argument("<skillId>", "技能编号")
      .option("-C, --company-id <id>", "公司编号")
      .option("--path <path>", "技能目录内的相对文件路径", "SKILL.md")
      .action(async (skillId: string, opts: SkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ path: opts.path ?? "SKILL.md" });
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/skills/${skillId}/files`}?${query.toString()}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCompanyPost(skill, "create", "创建本地公司技能", "skills", true);
  addCompanyPost(skill, "import", "从来源导入公司技能", "skills/import", true);
  addCompanyPost(skill, "scan-projects", "扫描项目工作区中的公司技能", "skills/scan-projects", true);

  addCommonClientOptions(
    skill
      .command("file:update")
      .description("更新公司技能文件")
      .argument("<skillId>", "技能编号")
      .option("-C, --company-id <id>", "公司编号")
      .requiredOption("--payload-json <json>", "CompanySkillFileUpdate JSON 数据")
      .action(async (skillId: string, opts: SkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.patch(apiPath`/api/companies/${ctx.companyId}/skills/${skillId}/files`, parseJson(opts.payloadJson ?? "{}")),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addSkillAction(skill, "update-status", "获取公司技能更新状态", "update-status", "GET");
  addSkillAction(skill, "install-update", "安装可用的公司技能更新", "install-update", "POST");
  addSkillAction(skill, "delete", "删除公司技能", "", "DELETE");
}

function addCompanyGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent.command(name).description(description).option("-C, --company-id <id>", "公司编号").action(async (opts: SkillOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addCompanyPost(parent: Command, name: string, description: string, path: string, requirePayload = false): void {
  const command = parent.command(name).description(description).option("-C, --company-id <id>", "公司编号");
  if (requirePayload) {
    command.requiredOption("--payload-json <json>", "JSON 数据");
  } else {
    command.option("--payload-json <json>", "JSON 数据", "{}");
  }
  addCommonClientOptions(
    command.action(async (opts: SkillOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addSkillAction(parent: Command, name: string, description: string, suffix: string, method: "GET" | "POST" | "DELETE"): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<skillId>", "技能编号")
      .option("-C, --company-id <id>", "公司编号")
      .action(async (skillId: string, opts: SkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const path = `${apiPath`/api/companies/${ctx.companyId}/skills/${skillId}`}${suffix ? `/${suffix}` : ""}`;
          const result =
            method === "GET"
              ? await ctx.api.get(path)
              : method === "POST"
                ? await ctx.api.post(path, {})
                : await ctx.api.delete(path);
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
