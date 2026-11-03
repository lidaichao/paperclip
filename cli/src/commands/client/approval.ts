import { Command } from "commander";
import {
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  type Approval,
  type ApprovalComment,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface ApprovalListOptions extends BaseClientOptions {
  companyId?: string;
  status?: string;
}

interface ApprovalDecisionOptions extends BaseClientOptions {
  decisionNote?: string;
  decidedByUserId?: string;
}

interface ApprovalCreateOptions extends BaseClientOptions {
  companyId?: string;
  type: string;
  requestedByAgentId?: string;
  payload: string;
  issueIds?: string;
}

interface ApprovalResubmitOptions extends BaseClientOptions {
  payload?: string;
}

interface ApprovalCommentOptions extends BaseClientOptions {
  body: string;
}

export function registerApprovalCommands(program: Command): void {
  const approval = program.command("approval").description("审批操作");

  addCommonClientOptions(
    approval
      .command("list")
      .description("列出公司审批")
      .requiredOption("-C, --company-id <id>", "公司编号")
      .option("--status <status>", "状态筛选")
      .action(async (opts: ApprovalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          const query = params.toString();
          const rows =
            (await ctx.api.get<Approval[]>(
              `${apiPath`/api/companies/${ctx.companyId}/approvals`}${query ? `?${query}` : ""}`,
            )) ?? [];

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
                type: row.type,
                status: row.status,
                requestedByAgentId: row.requestedByAgentId,
                requestedByUserId: row.requestedByUserId,
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
    approval
      .command("get")
      .description("获取一个审批")
      .argument("<approvalId>", "审批编号")
      .action(async (approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Approval>(apiPath`/api/approvals/${approvalId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("create")
      .description("创建审批请求")
      .requiredOption("-C, --company-id <id>", "公司编号")
      .requiredOption("--type <type>", "审批类型（hire_agent|approve_ceo_strategy）")
      .requiredOption("--payload <json>", "JSON 对象形式的审批数据")
      .option("--requested-by-agent-id <id>", "发起请求的智能体编号")
      .option("--issue-ids <csv>", "用逗号分隔的关联任务编号")
      .action(async (opts: ApprovalCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payloadJson = parseJsonObject(opts.payload, "payload");
          const payload = createApprovalSchema.parse({
            type: opts.type,
            payload: payloadJson,
            requestedByAgentId: opts.requestedByAgentId,
            issueIds: parseCsv(opts.issueIds),
          });
          const created = await ctx.api.post<Approval>(apiPath`/api/companies/${ctx.companyId}/approvals`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    approval
      .command("approve")
      .description("批准审批请求")
      .argument("<approvalId>", "审批编号")
      .option("--decision-note <text>", "决策说明")
      .option("--decided-by-user-id <id>", "决策用户编号")
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resolveApprovalSchema.parse({
            decisionNote: opts.decisionNote,
            decidedByUserId: opts.decidedByUserId,
          });
          const updated = await ctx.api.post<Approval>(apiPath`/api/approvals/${approvalId}/approve`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("reject")
      .description("拒绝审批请求")
      .argument("<approvalId>", "审批编号")
      .option("--decision-note <text>", "决策说明")
      .option("--decided-by-user-id <id>", "决策用户编号")
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resolveApprovalSchema.parse({
            decisionNote: opts.decisionNote,
            decidedByUserId: opts.decidedByUserId,
          });
          const updated = await ctx.api.post<Approval>(apiPath`/api/approvals/${approvalId}/reject`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("request-revision")
      .description("请求修改审批")
      .argument("<approvalId>", "审批编号")
      .option("--decision-note <text>", "决策说明")
      .option("--decided-by-user-id <id>", "决策用户编号")
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = requestApprovalRevisionSchema.parse({
            decisionNote: opts.decisionNote,
            decidedByUserId: opts.decidedByUserId,
          });
          const updated = await ctx.api.post<Approval>(apiPath`/api/approvals/${approvalId}/request-revision`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("resubmit")
      .description("重新提交审批（可提供新数据）")
      .argument("<approvalId>", "审批编号")
      .option("--payload <json>", "JSON 数据对象")
      .action(async (approvalId: string, opts: ApprovalResubmitOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resubmitApprovalSchema.parse({
            payload: opts.payload ? parseJsonObject(opts.payload, "payload") : undefined,
          });
          const updated = await ctx.api.post<Approval>(apiPath`/api/approvals/${approvalId}/resubmit`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("comment")
      .description("为审批添加评论")
      .argument("<approvalId>", "审批编号")
      .requiredOption("--body <text>", "评论正文")
      .action(async (approvalId: string, opts: ApprovalCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const created = await ctx.api.post<ApprovalComment>(apiPath`/api/approvals/${approvalId}/comments`, {
            body: opts.body,
          });
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const rows = value.split(",").map((v) => v.trim()).filter(Boolean);
  return rows.length > 0 ? rows : undefined;
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${name} 必须是 JSON 对象`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${name} JSON 无效：${err instanceof Error ? err.message : String(err)}`);
  }
}
