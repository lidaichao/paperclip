import { Command } from "commander";
import type { Agent, Issue, IssueComment } from "@paperclipai/shared";
import { addIssueCommentSchema, createIssueSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface PromptOptions extends BaseClientOptions {
  agent?: string;
  apiKeyEnv?: string;
  issue?: string;
  title?: string;
  wake?: boolean;
  companyId?: string;
}

interface PromptResult {
  ok: true;
  mode: "issue" | "comment";
  actor: "agent" | "board";
  apiBase: string;
  companyId: string;
  agent: {
    id: string;
    name: string;
    urlKey?: string | null;
  };
  issue?: Issue | null;
  comment?: IssueComment | null;
  wakeup?: unknown;
}

export function registerPromptCommands(program: Command): void {
  addCommonClientOptions(
    program
      .command("agent-prompt")
      .description("使用智能体接口密钥为智能体创建或更新 Alice 工作")
      .argument("<agent>", "智能体编号、短名称或名称")
      .argument("<agentApiKey>", "智能体接口密钥")
      .argument("<prompt...>", "提示词文本")
      .option("--issue <issueId>", "作为评论追加到现有任务")
      .option("--title <title>", "新建任务时使用的任务标题")
      .option("--no-wake", "创建或更新工作后不唤醒智能体")
      .action(async (agent: string, agentApiKey: string, promptParts: string[], opts: PromptOptions) => {
        try {
          const result = await runAgentPrompt(agent, promptParts.join(" "), {
            ...opts,
            apiKey: agentApiKey,
            wake: opts.wake,
          });
          printOutput(result, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const agent = program.commands.find((cmd) => cmd.name() === "agent") ?? program.command("agent");
  addCommonClientOptions(
    agent
      .command("prompt")
      .description("使用智能体身份创建或更新 Alice 工作")
      .argument("<prompt...>", "提示词文本")
      .option("--agent <agent>", "智能体编号、短名称或名称；默认使用配置或身份中的智能体")
      .option("--api-key-env <name>", "从此环境变量读取智能体接口密钥")
      .option("--issue <issueId>", "作为评论追加到现有任务")
      .option("--title <title>", "新建任务时使用的任务标题")
      .option("--no-wake", "创建或更新工作后不唤醒智能体")
      .action(async (promptParts: string[], opts: PromptOptions) => {
        try {
          const apiKey = readApiKeyEnvOption(opts);
          const result = await runAgentPrompt(opts.agent, promptParts.join(" "), {
            ...opts,
            apiKey: apiKey ?? opts.apiKey,
            wake: opts.wake,
          });
          printOutput(result, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const board = program.command("board").description("看板操作员操作");
  addCommonClientOptions(
    board
      .command("prompt")
      .description("使用看板认证为智能体创建或更新 Alice 工作")
      .requiredOption("--agent <agent>", "目标智能体编号、短名称或名称")
      .option("-C, --company-id <id>", "公司编号")
      .option("--issue <issueId>", "作为评论追加到现有任务")
      .option("--title <title>", "新建任务时使用的任务标题")
      .option("--no-wake", "创建或更新工作后不唤醒智能体")
      .argument("<prompt...>", "提示词文本")
      .action(async (promptParts: string[], opts: PromptOptions) => {
        try {
          const result = await runBoardPrompt(opts.agent ?? "", promptParts.join(" "), opts);
          printOutput(result, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

export async function runAgentPrompt(
  agentRef: string | undefined,
  prompt: string,
  opts: PromptOptions,
): Promise<PromptResult> {
  const ctx = resolveCommandContext(opts);
  if (ctx.profile.persona && ctx.profile.persona !== "agent") {
    throw new Error(`配置“${ctx.profileName}”的身份为 ${ctx.profile.persona}；请使用智能体配置或看板提示词。`);
  }
  const body = normalizePrompt(prompt);
  const me = await ctx.api.get<Agent>("/api/agents/me");
  if (!me) throw new Error("智能体认证失败");
  const expectedRef = agentRef?.trim() || ctx.profile.agentId || me.id;
  assertAgentMatchesReference(me, expectedRef);

  const result = await createOrCommentForAgent({
    api: ctx.api,
    actor: "agent",
    agent: me,
    companyId: me.companyId,
    prompt: body,
    issueId: opts.issue,
    title: opts.title,
    wake: opts.wake !== false,
  });
  return result;
}

export async function runBoardPrompt(
  agentRef: string,
  prompt: string,
  opts: PromptOptions,
): Promise<PromptResult> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  if (ctx.profile.persona && ctx.profile.persona !== "board") {
    throw new Error(`配置“${ctx.profileName}”的身份为 ${ctx.profile.persona}；请使用智能体提示词命令或看板配置。`);
  }
  const body = normalizePrompt(prompt);
  const query = new URLSearchParams({ companyId: ctx.companyId ?? "" });
  const agent = await ctx.api.get<Agent>(`${apiPath`/api/agents/${agentRef}`}?${query.toString()}`);
  if (!agent) throw new Error(`未找到智能体：${agentRef}`);

  return createOrCommentForAgent({
    api: ctx.api,
    actor: "board",
    agent,
    companyId: ctx.companyId ?? agent.companyId,
    prompt: body,
    issueId: opts.issue,
    title: opts.title,
    wake: opts.wake !== false,
  });
}

async function createOrCommentForAgent(input: {
  api: {
    apiBase: string;
    post<T>(path: string, body?: unknown): Promise<T | null>;
  };
  actor: "agent" | "board";
  agent: Agent;
  companyId: string;
  prompt: string;
  issueId?: string;
  title?: string;
  wake: boolean;
}): Promise<PromptResult> {
  if (input.issueId?.trim()) {
    const payload = addIssueCommentSchema.parse({
      body: input.prompt,
      resume: input.wake,
    });
    const comment = await input.api.post<IssueComment>(apiPath`/api/issues/${input.issueId.trim()}/comments`, payload);
    const wakeup = input.wake
      ? await wakeAgent(input.api, input.agent.id, input.issueId.trim(), "提示词评论交接")
      : null;
    return {
      ok: true,
      mode: "comment",
      actor: input.actor,
      apiBase: input.api.apiBase,
      companyId: input.companyId,
      agent: agentSummary(input.agent),
      comment,
      wakeup,
    };
  }

  const payload = createIssueSchema.parse({
    title: input.title?.trim() || defaultPromptTitle(input.prompt),
    description: input.prompt,
    status: "todo",
    priority: "medium",
    assigneeAgentId: input.agent.id,
  });
  const issue = await input.api.post<Issue>(apiPath`/api/companies/${input.companyId}/issues`, payload);
  const wakeup = input.wake && issue?.id
    ? await wakeAgent(input.api, input.agent.id, issue.id, "提示词任务交接")
    : null;
  return {
    ok: true,
    mode: "issue",
    actor: input.actor,
    apiBase: input.api.apiBase,
    companyId: input.companyId,
    agent: agentSummary(input.agent),
    issue,
    wakeup,
  };
}

function wakeAgent(
  api: { post<T>(path: string, body?: unknown): Promise<T | null> },
  agentId: string,
  issueId: string,
  reason: string,
): Promise<unknown> {
  return api.post(apiPath`/api/agents/${agentId}/wakeup`, {
    source: "on_demand",
    triggerDetail: "manual",
    reason,
    payload: { issueId },
  });
}

function normalizePrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) throw new Error("必须提供提示词文本");
  return normalized;
}

function defaultPromptTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "提示词交接";
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

function assertAgentMatchesReference(agent: Agent, reference: string): void {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) throw new Error("必须提供智能体引用");
  const matches = [
    agent.id,
    agent.name,
    typeof agent.urlKey === "string" ? agent.urlKey : null,
  ].some((value) => value?.toLowerCase() === normalized);
  if (!matches) {
    throw new Error(
      `智能体密钥属于 ${agent.name}（${agent.id}），并非“${reference}”。请使用匹配的智能体或看板提示词。`,
    );
  }
}

function agentSummary(agent: Agent): PromptResult["agent"] {
  return {
    id: agent.id,
    name: agent.name,
    urlKey: typeof agent.urlKey === "string" ? agent.urlKey : null,
  };
}

function readApiKeyEnvOption(opts: PromptOptions): string | undefined {
  if (!opts.apiKeyEnv?.trim()) return undefined;
  const value = process.env[opts.apiKeyEnv.trim()]?.trim();
  if (!value) throw new Error(`未设置环境变量 ${opts.apiKeyEnv.trim()}`);
  return value;
}
