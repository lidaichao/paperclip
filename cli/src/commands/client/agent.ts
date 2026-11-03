import { Command } from "commander";
import {
  agentSkillSyncSchema,
  createAgentSchema,
  resetAgentSessionSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentInstructionsPathSchema,
  updateAgentPermissionsSchema,
  updateAgentSchema,
  upsertAgentInstructionsFileSchema,
  wakeAgentSchema,
  type Agent,
  type AgentWakeupResponse,
  type Issue,
} from "@paperclipai/shared";
import {
  removeMaintainerOnlySkillSymlinks,
  resolvePaperclipSkillsDir,
} from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AgentListOptions extends BaseClientOptions {
  companyId?: string;
}

interface AgentLocalCliOptions extends BaseClientOptions {
  companyId?: string;
  keyName?: string;
  installSkills?: boolean;
}

interface AgentInboxMineOptions extends BaseClientOptions {
  userId: string;
  status?: string;
}

interface AgentWakeOptions extends BaseClientOptions {
  companyId?: string;
  source?: string;
  trigger?: string;
  reason?: string;
  payload?: string;
  idempotencyKey?: string;
  forceFreshSession?: boolean;
}

interface AgentJsonPayloadOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson: string;
}

interface AgentDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

interface AgentResetSessionOptions extends BaseClientOptions {
  taskKey?: string;
}

interface AgentSkillsSyncOptions extends BaseClientOptions {
  desiredSkills: string;
  mode: string;
}

interface AgentInstructionsFileOptions extends BaseClientOptions {
  path: string;
}

interface AgentInstructionsFilePutOptions extends BaseClientOptions {
  path: string;
  content?: string;
  contentFile?: string;
  clearLegacyPromptTemplate?: boolean;
}

interface CreatedAgentKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

interface SkillsInstallSummary {
  tool: "codex" | "claude" | "kimi";
  target: string;
  linked: string[];
  removed: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function codexSkillsHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".codex");
  return path.join(base, "skills");
}

function claudeSkillsHome(): string {
  const fromEnv = process.env.CLAUDE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".claude");
  return path.join(base, "skills");
}

function kimiSkillsHome(): string {
  const fromEnv = process.env.KIMI_CODE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".kimi-code");
  return path.join(base, "skills");
}

async function installSkillsForTarget(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  tool: "codex" | "claude" | "kimi",
): Promise<SkillsInstallSummary> {
  const summary: SkillsInstallSummary = {
    tool,
    target: targetSkillsDir,
    linked: [],
    removed: [],
    skipped: [],
    failed: [],
  };

  await fs.mkdir(targetSkillsDir, { recursive: true });
  const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true });
  summary.removed = await removeMaintainerOnlySkillSymlinks(
    targetSkillsDir,
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceSkillsDir, entry.name);
    const target = path.join(targetSkillsDir, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) {
      if (existing.isSymbolicLink()) {
        let linkedPath: string | null = null;
        try {
          linkedPath = await fs.readlink(target);
        } catch (err) {
          await fs.unlink(target);
          try {
            await fs.symlink(source, target);
            summary.linked.push(entry.name);
            continue;
          } catch (linkErr) {
            summary.failed.push({
              name: entry.name,
              error:
                err instanceof Error && linkErr instanceof Error
                  ? `${err.message}; then ${linkErr.message}`
                  : err instanceof Error
                    ? err.message
                    : `Failed to recover broken symlink: ${String(err)}`,
            });
            continue;
          }
        }

        const resolvedLinkedPath = path.isAbsolute(linkedPath)
          ? linkedPath
          : path.resolve(path.dirname(target), linkedPath);
        const linkedTargetExists = await fs
          .stat(resolvedLinkedPath)
          .then(() => true)
          .catch(() => false);

        if (!linkedTargetExists) {
          await fs.unlink(target);
        } else {
          summary.skipped.push(entry.name);
          continue;
        }
      } else {
        summary.skipped.push(entry.name);
        continue;
      }
    }

    try {
      await fs.symlink(source, target);
      summary.linked.push(entry.name);
    } catch (err) {
      summary.failed.push({
        name: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

function buildAgentEnvExports(input: {
  apiBase: string;
  companyId: string;
  agentId: string;
  apiKey: string;
}): string {
  const escaped = (value: string) => value.replace(/'/g, "'\"'\"'");
  return [
    `export PAPERCLIP_API_URL='${escaped(input.apiBase)}'`,
    `export PAPERCLIP_COMPANY_ID='${escaped(input.companyId)}'`,
    `export PAPERCLIP_AGENT_ID='${escaped(input.agentId)}'`,
    `export PAPERCLIP_API_KEY='${escaped(input.apiKey)}'`,
  ].join("\n");
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("智能体操作");

  addCommonClientOptions(
    agent
      .command("me")
      .description("显示当前智能体身份")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const me = await ctx.api.get<Agent>("/api/agents/me");
          printOutput(me, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("inbox")
      .description("列出当前分配给智能体的收件箱项目")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<Issue[]>("/api/agents/me/inbox-lite")) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              identifier: row.identifier,
              id: row.id,
              status: row.status,
              priority: row.priority,
              title: row.title,
              projectId: row.projectId,
            }));
          }
          if (rows.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("inbox-mine")
      .description("列出工作台用户处理或归档过的当前智能体收件箱项目")
      .requiredOption("--user-id <id>", "工作台用户 ID")
      .option("--status <csv>", "以逗号分隔的任务状态")
      .action(async (opts: AgentInboxMineOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams({ userId: opts.userId });
          if (opts.status) params.set("status", opts.status);
          const rows = (await ctx.api.get<Issue[]>(`/api/agents/me/inbox/mine?${params.toString()}`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("list")
      .description("列出公司的智能体")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .action(async (opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Agent[]>(apiPath`/api/companies/${ctx.companyId}/agents`)) ?? [];

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
                name: row.name,
                role: row.role,
                status: row.status,
                reportsTo: row.reportsTo,
                budgetMonthlyCents: row.budgetMonthlyCents,
                spentMonthlyCents: row.spentMonthlyCents,
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
    agent
      .command("get")
      .description("获取一个智能体")
      .argument("<agentId>", "智能体 ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Agent>(apiPath`/api/agents/${agentId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("create")
      .description("根据 JSON 数据创建智能体")
      .option("-C, --company-id <id>", "公司 ID")
      .requiredOption("--payload-json <json>", "CreateAgent JSON 数据")
      .action(async (opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createAgentSchema.parse(parseJson(opts.payloadJson));
          const created = await ctx.api.post<Agent>(apiPath`/api/companies/${ctx.companyId}/agents`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("hire")
      .description("创建智能体招募申请")
      .option("-C, --company-id <id>", "公司 ID")
      .requiredOption("--payload-json <json>", "CreateAgentHire JSON 数据")
      .action(async (opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/agent-hires`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("update")
      .description("根据 JSON 数据更新智能体")
      .argument("<agentId>", "智能体 ID")
      .requiredOption("--payload-json <json>", "UpdateAgent JSON 数据")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentSchema.parse(parseJson(opts.payloadJson));
          const updated = await ctx.api.patch<Agent>(apiPath`/api/agents/${agentId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("delete")
      .description("删除智能体")
      .argument("<agentId>", "智能体 ID")
      .option("--yes", "确认删除")
      .action(async (agentId: string, opts: AgentDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("未传入 --yes，拒绝执行删除。");
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/agents/${agentId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, path, description] of [
    ["pause", "pause", "暂停智能体"],
    ["resume", "resume", "恢复智能体"],
    ["approve", "approve", "批准待处理的智能体"],
    ["terminate", "terminate", "终止智能体"],
    ["heartbeat:invoke", "heartbeat/invoke", "触发智能体心跳"],
    ["claude-login", "claude-login", "触发智能体的 Claude 登录"],
  ] as const) {
    addCommonClientOptions(
      agent
        .command(name)
        .description(description)
        .argument("<agentId>", "智能体 ID")
        .action(async (agentId: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const result = await ctx.api.post(`${apiPath`/api/agents/${agentId}`}/${path}`, {});
            printOutput(result, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    agent
      .command("permissions:update")
      .description("更新智能体权限")
      .argument("<agentId>", "智能体 ID")
      .requiredOption("--payload-json <json>", "UpdateAgentPermissions JSON 数据")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentPermissionsSchema.parse(parseJson(opts.payloadJson));
          const updated = await ctx.api.patch(apiPath`/api/agents/${agentId}/permissions`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("configuration")
      .description("获取已脱敏的智能体配置")
      .argument("<agentId>", "智能体 ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/configuration`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("config-revisions")
      .description("列出智能体配置修订记录")
      .argument("<agentId>", "智能体 ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/config-revisions`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("config-revision:get")
      .description("获取一条智能体配置修订记录")
      .argument("<agentId>", "智能体 ID")
      .argument("<revisionId>", "修订记录 ID")
      .action(async (agentId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/config-revisions/${revisionId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("config-revision:rollback")
      .description("将智能体回滚到指定配置修订记录")
      .argument("<agentId>", "智能体 ID")
      .argument("<revisionId>", "修订记录 ID")
      .action(async (agentId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(apiPath`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`, {});
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("runtime-state")
      .description("获取智能体运行时状态")
      .argument("<agentId>", "智能体 ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/runtime-state`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("runtime-state:reset-session")
      .description("重置智能体运行时会话")
      .argument("<agentId>", "智能体 ID")
      .option("--task-key <key>", "指定任务会话键名")
      .action(async (agentId: string, opts: AgentResetSessionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resetAgentSessionSchema.parse({ taskKey: opts.taskKey });
          const result = await ctx.api.post(apiPath`/api/agents/${agentId}/runtime-state/reset-session`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("task-sessions")
      .description("列出智能体任务会话")
      .argument("<agentId>", "智能体 ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/task-sessions`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("skills")
      .description("列出智能体技能")
      .argument("<agentId>", "智能体 ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/skills`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("skills:sync")
      .description("将指定技能同步到智能体")
      .argument("<agentId>", "智能体 ID")
      .requiredOption("--desired-skills <csv>", "指定的技能名称")
      .requiredOption(
        "--mode <mode>",
        "合并模式：add 保留其他技能；remove 只删除指定技能；replace 会覆盖完整技能集合",
      )
      .action(async (agentId: string, opts: AgentSkillsSyncOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = agentSkillSyncSchema.parse({
            desiredSkills: parseCsv(opts.desiredSkills),
            mode: opts.mode,
          });
          const result = await ctx.api.post(apiPath`/api/agents/${agentId}/skills/sync`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-path:update")
      .description("更新智能体指令路径。进程适配器需要 adapterConfigKey，相对路径需要 adapterConfig.cwd。")
      .argument("<agentId>", "智能体 ID")
      .requiredOption("--payload-json <json>", "UpdateAgentInstructionsPath JSON 数据，例如 {\"path\":\"/tmp/AGENTS.md\",\"adapterConfigKey\":\"instructionsFilePath\"}")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentInstructionsPathSchema.parse(parseJson(opts.payloadJson));
          const result = await ctx.api.patch(apiPath`/api/agents/${agentId}/instructions-path`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-bundle")
      .description("获取智能体指令包")
      .argument("<agentId>", "智能体 ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/instructions-bundle`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-bundle:update")
      .description("更新智能体指令包")
      .argument("<agentId>", "智能体 ID")
      .requiredOption("--payload-json <json>", "UpdateAgentInstructionsBundle JSON 数据")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentInstructionsBundleSchema.parse(parseJson(opts.payloadJson));
          const result = await ctx.api.patch(apiPath`/api/agents/${agentId}/instructions-bundle`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-file:get")
      .description("获取智能体指令文件")
      .argument("<agentId>", "智能体 ID")
      .requiredOption("--path <path>", "相对于指令包的文件路径")
      .action(async (agentId: string, opts: AgentInstructionsFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = new URLSearchParams({ path: opts.path });
          const result = await ctx.api.get(`${apiPath`/api/agents/${agentId}/instructions-bundle/file`}?${query.toString()}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-file:put")
      .description("创建或更新智能体指令文件")
      .argument("<agentId>", "智能体 ID")
      .requiredOption("--path <path>", "相对于指令包的文件路径")
      .option("--content <text>", "文件内容")
      .option("--content-file <path>", "从磁盘读取文件内容")
      .option("--clear-legacy-prompt-template", "清除旧版提示词模板")
      .action(async (agentId: string, opts: AgentInstructionsFilePutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const content = opts.contentFile ? await fs.readFile(opts.contentFile, "utf8") : opts.content;
          const payload = upsertAgentInstructionsFileSchema.parse({
            path: opts.path,
            content,
            clearLegacyPromptTemplate: Boolean(opts.clearLegacyPromptTemplate),
          });
          const result = await ctx.api.put(apiPath`/api/agents/${agentId}/instructions-bundle/file`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-file:delete")
      .description("删除智能体指令文件")
      .argument("<agentId>", "智能体 ID")
      .requiredOption("--path <path>", "相对于指令包的文件路径")
      .action(async (agentId: string, opts: AgentInstructionsFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = new URLSearchParams({ path: opts.path });
          const result = await ctx.api.delete(`${apiPath`/api/agents/${agentId}/instructions-bundle/file`}?${query.toString()}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("wake")
      .description("请求唤醒智能体心跳")
      .argument("<agentRef>", "智能体 ID、短名称或 URL 键名")
      .option("-C, --company-id <id>", "按短名称或 URL 键名查找时使用的公司 ID")
      .option("--source <source>", "调用来源（timer、assignment、on_demand、automation）", "on_demand")
      .option("--trigger <trigger>", "触发详情（manual、ping、callback、system）", "manual")
      .option("--reason <text>", "唤醒原因")
      .option("--payload <json>", "JSON 对象数据")
      .option("--idempotency-key <key>", "唤醒幂等键")
      .option("--force-fresh-session", "请求新的适配器会话")
      .action(async (agentRef: string, opts: AgentWakeOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.companyId ? `?${new URLSearchParams({ companyId: opts.companyId }).toString()}` : "";
          const agentRow = await ctx.api.get<Agent>(`${apiPath`/api/agents/${agentRef}`}${query}`);
          if (!agentRow) {
            throw new Error(`未找到智能体：${agentRef}`);
          }
          const payload = wakeAgentSchema.parse({
            source: opts.source,
            triggerDetail: opts.trigger,
            reason: opts.reason,
            payload: parseJsonObject(opts.payload),
            idempotencyKey: opts.idempotencyKey,
            forceFreshSession: Boolean(opts.forceFreshSession),
          });
          const result = await ctx.api.post<AgentWakeupResponse>(apiPath`/api/agents/${agentRow.id}/wakeup`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("local-cli")
      .description(
        "创建智能体 API 密钥、为 Codex/Claude 安装本地 Alice 技能，并输出终端环境变量",
      )
      .argument("<agentRef>", "智能体 ID、短名称或 URL 键名")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .option("--key-name <name>", "API 密钥标签", "local-cli")
      .option(
        "--no-install-skills",
        "跳过将 Alice 技能安装到 ~/.codex/skills、~/.claude/skills 和 ~/.kimi-code/skills",
      )
      .action(async (agentRef: string, opts: AgentLocalCliOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ companyId: ctx.companyId ?? "" });
          const agentRow = await ctx.api.get<Agent>(
            `${apiPath`/api/agents/${agentRef}`}?${query.toString()}`,
          );
          if (!agentRow) {
            throw new Error(`未找到智能体：${agentRef}`);
          }

          const now = new Date().toISOString().replaceAll(":", "-");
          const keyName = opts.keyName?.trim() ? opts.keyName.trim() : `local-cli-${now}`;
          const key = await ctx.api.post<CreatedAgentKey>(apiPath`/api/agents/${agentRow.id}/keys`, { name: keyName });
          if (!key) {
            throw new Error("创建 API 密钥失败");
          }

          const installSummaries: SkillsInstallSummary[] = [];
          if (opts.installSkills !== false) {
            const skillsDir = await resolvePaperclipSkillsDir(__moduleDir, [path.resolve(process.cwd(), "skills")]);
            if (!skillsDir) {
              throw new Error(
                "找不到本地 Alice 技能目录。仓库检出目录中应存在 ./skills。",
              );
            }

            installSummaries.push(
              await installSkillsForTarget(skillsDir, codexSkillsHome(), "codex"),
              await installSkillsForTarget(skillsDir, claudeSkillsHome(), "claude"),
              await installSkillsForTarget(skillsDir, kimiSkillsHome(), "kimi"),
            );
          }

          const exportsText = buildAgentEnvExports({
            apiBase: ctx.api.apiBase,
            companyId: agentRow.companyId,
            agentId: agentRow.id,
            apiKey: key.token,
          });

          if (ctx.json) {
            printOutput(
              {
                agent: {
                  id: agentRow.id,
                  name: agentRow.name,
                  urlKey: agentRow.urlKey,
                  companyId: agentRow.companyId,
                },
                key: {
                  id: key.id,
                  name: key.name,
                  createdAt: key.createdAt,
                  token: key.token,
                },
                skills: installSummaries,
                exports: exportsText,
              },
              { json: true },
            );
            return;
          }

          console.log(`智能体：${agentRow.name}（${agentRow.id}）`);
          console.log(`API 密钥已创建：${key.name}（${key.id}）`);
          if (installSummaries.length > 0) {
            for (const summary of installSummaries) {
              console.log(
                `${summary.tool}：已链接=${summary.linked.length} 已移除=${summary.removed.length} 已跳过=${summary.skipped.length} 失败=${summary.failed.length} 目标=${summary.target}`,
              );
              for (const failed of summary.failed) {
                console.log(`  失败 ${failed.name}：${failed.error}`);
              }
            }
          }
          console.log("");
          console.log("# 启动 Codex 或 Claude 前，请在终端中运行以下命令：");
          console.log(exportsText);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--payload 必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}
