import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import {
  addIssueCommentSchema,
  acceptIssueThreadInteractionSchema,
  cancelIssueThreadInteractionSchema,
  checkoutIssueSchema,
  createChildIssueSchema,
  createIssueLabelSchema,
  createIssueSchema,
  createIssueThreadInteractionSchema,
  createIssueTreeHoldSchema,
  createIssueWorkProductSchema,
  type FeedbackTrace,
  type HeartbeatRun,
  linkIssueApprovalSchema,
  previewIssueTreeControlSchema,
  rejectIssueThreadInteractionSchema,
  releaseIssueTreeHoldSchema,
  respondIssueThreadInteractionSchema,
  resolveIssueRecoveryActionSchema,
  restoreIssueDocumentRevisionSchema,
  updateIssueSchema,
  updateIssueWorkProductSchema,
  type Issue,
  type IssueComment,
  upsertIssueDocumentSchema,
  upsertIssueFeedbackVoteSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  inferContentTypeFromPath,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import {
  buildFeedbackTraceQuery,
  normalizeFeedbackTraceExportFormat,
  serializeFeedbackTraces,
} from "./feedback.js";

interface IssueBaseOptions extends BaseClientOptions {
  status?: string;
  assigneeAgentId?: string;
  projectId?: string;
  match?: string;
}

interface IssueCreateOptions extends BaseClientOptions {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  requestDepth?: string;
  billingCode?: string;
}

interface IssueUpdateOptions extends BaseClientOptions {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  requestDepth?: string;
  billingCode?: string;
  comment?: string;
  hiddenAt?: string;
}

interface IssueCommentOptions extends BaseClientOptions {
  body: string;
  attachmentId?: string[];
  reopen?: boolean;
  resume?: boolean;
}

interface IssueCommentListOptions extends BaseClientOptions {
  afterCommentId?: string;
  order?: string;
  limit?: string;
}

interface IssueCheckoutOptions extends BaseClientOptions {
  agentId: string;
  expectedStatuses?: string;
}

interface IssueFeedbackOptions extends BaseClientOptions {
  targetType?: string;
  vote?: string;
  status?: string;
  from?: string;
  to?: string;
  sharedOnly?: boolean;
  includePayload?: boolean;
  out?: string;
  format?: string;
}

interface IssueDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

interface JsonPayloadOptions extends BaseClientOptions {
  payloadJson: string;
}

interface IssueDocumentPutOptions extends BaseClientOptions {
  title?: string;
  format?: string;
  body?: string;
  bodyFile?: string;
  changeSummary?: string;
  baseRevisionId?: string;
}

interface IssueAttachmentUploadOptions extends BaseClientOptions {
  companyId?: string;
  file: string;
  commentId?: string;
}

interface IssueAttachmentDownloadOptions extends BaseClientOptions {
  out?: string;
}

interface IssueLabelCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  color: string;
}

interface IssueRecoveryResolveOptions extends BaseClientOptions {
  actionId?: string;
  outcome: string;
  sourceIssueStatus: string;
  resolutionNote?: string;
}

interface InteractionAcceptOptions extends BaseClientOptions {
  selectedClientKeys?: string;
  selectedOptionIds?: string;
}

interface InteractionReasonOptions extends BaseClientOptions {
  reason?: string;
}

interface InteractionRespondOptions extends BaseClientOptions {
  answersJson: string;
  summaryMarkdown?: string;
}

interface TreeHoldListOptions extends BaseClientOptions {
  status?: string;
  mode?: string;
  includeMembers?: boolean;
}

export function registerIssueCommands(program: Command): void {
  const issue = program.command("issue").description("任务卡操作");

  addCommonClientOptions(
    issue
      .command("list")
      .description("列出公司的任务卡")
      .option("-C, --company-id <id>", "公司 ID")
      .option("--status <csv>", "以逗号分隔的状态")
      .option("--assignee-agent-id <id>", "按负责人智能体 ID 筛选")
      .option("--project-id <id>", "按项目 ID 筛选")
      .option("--match <text>", "在编号、标题和描述中进行本地文本匹配")
      .action(async (opts: IssueBaseOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.assigneeAgentId) params.set("assigneeAgentId", opts.assigneeAgentId);
          if (opts.projectId) params.set("projectId", opts.projectId);

          const query = params.toString();
          const path = `${apiPath`/api/companies/${ctx.companyId}/issues`}${query ? `?${query}` : ""}`;
          const rows = (await ctx.api.get<Issue[]>(path)) ?? [];

          const filtered = filterIssueRows(rows, opts.match);
          if (ctx.json) {
            printOutput(filtered, { json: true });
            return;
          }

          if (filtered.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const item of filtered) {
            console.log(
              formatInlineRecord({
                编号: item.identifier,
                ID: item.id,
                状态: item.status,
                优先级: item.priority,
                负责人智能体ID: item.assigneeAgentId,
                标题: item.title,
                项目ID: item.projectId,
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
    issue
      .command("get")
      .description("通过 UUID 或编号获取任务卡（例如 PC-12）")
      .argument("<idOrIdentifier>", "任务卡 ID 或编号")
      .action(async (idOrIdentifier: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Issue>(apiPath`/api/issues/${idOrIdentifier}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("delete")
      .description("删除任务卡")
      .argument("<issueId>", "任务卡 ID")
      .option("--yes", "确认删除")
      .action(async (issueId: string, opts: IssueDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("未使用 --yes，拒绝删除。");
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<Issue>(apiPath`/api/issues/${issueId}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("heartbeat-context")
      .description("获取任务卡的心跳上下文")
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const context = await ctx.api.get(apiPath`/api/issues/${issueId}/heartbeat-context`);
          printOutput(context, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("create")
      .description("创建任务卡")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .requiredOption("--title <title>", "任务卡标题")
      .option("--description <text>", "任务卡描述")
      .option("--status <status>", "任务卡状态")
      .option("--priority <priority>", "任务卡优先级")
      .option("--assignee-agent-id <id>", "负责人智能体 ID")
      .option("--project-id <id>", "项目 ID")
      .option("--goal-id <id>", "目标 ID")
      .option("--parent-id <id>", "父任务卡 ID")
      .option("--request-depth <n>", "请求深度整数")
      .option("--billing-code <code>", "计费代码")
      .action(async (opts: IssueCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createIssueSchema.parse({
            title: opts.title,
            description: opts.description,
            status: opts.status,
            priority: opts.priority,
            assigneeAgentId: opts.assigneeAgentId,
            projectId: opts.projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
            requestDepth: parseOptionalInt(opts.requestDepth),
            billingCode: opts.billingCode,
          });

          const created = await ctx.api.post<Issue>(apiPath`/api/companies/${ctx.companyId}/issues`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("update")
      .description("更新任务卡")
      .argument("<issueId>", "任务卡 ID")
      .option("--title <title>", "任务卡标题")
      .option("--description <text>", "任务卡描述")
      .option("--status <status>", "任务卡状态")
      .option("--priority <priority>", "任务卡优先级")
      .option("--assignee-agent-id <id>", "负责人智能体 ID")
      .option("--project-id <id>", "项目 ID")
      .option("--goal-id <id>", "目标 ID")
      .option("--parent-id <id>", "父任务卡 ID")
      .option("--request-depth <n>", "请求深度整数")
      .option("--billing-code <code>", "计费代码")
      .option("--comment <text>", "更新时附加的可选评论")
      .option("--hidden-at <iso8601|null>", "设置 hiddenAt 时间戳或字面值 null")
      .action(async (issueId: string, opts: IssueUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateIssueSchema.parse({
            title: opts.title,
            description: opts.description,
            status: opts.status,
            priority: opts.priority,
            assigneeAgentId: opts.assigneeAgentId,
            projectId: opts.projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
            requestDepth: parseOptionalInt(opts.requestDepth),
            billingCode: opts.billingCode,
            comment: opts.comment,
            hiddenAt: parseHiddenAt(opts.hiddenAt),
          });

          const updated = await ctx.api.patch<Issue & { comment?: IssueComment | null }>(apiPath`/api/issues/${issueId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment")
      .description("为任务卡添加评论")
      .argument("<issueId>", "任务卡 ID")
      .requiredOption("--body <text>", "评论正文")
      .option(
        "--attachment-id <id...>",
        "将已上传的任务卡附件绑定到此评论",
      )
      .option("--reopen", "任务卡已完成或已取消时重新打开")
      .option("--resume", "明确请求继续处理，并在可恢复时唤醒负责人")
      .action(async (issueId: string, opts: IssueCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = addIssueCommentSchema.parse({
            body: opts.body,
            attachmentIds: opts.attachmentId,
            reopen: opts.reopen,
            resume: opts.resume,
          });
          const comment = await ctx.api.post<IssueComment>(apiPath`/api/issues/${issueId}/comments`, payload);
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comments")
      .description("列出任务卡评论")
      .argument("<issueId>", "任务卡 ID")
      .option("--after-comment-id <id>", "仅返回此评论 ID 之后的评论")
      .option("--order <order>", "asc 升序或 desc 降序")
      .option("--limit <n>", "最多返回的评论数")
      .action(async (issueId: string, opts: IssueCommentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.afterCommentId) params.set("afterCommentId", opts.afterCommentId);
          if (opts.order) params.set("order", opts.order);
          if (opts.limit) params.set("limit", opts.limit);
          const query = params.toString();
          const comments = (await ctx.api.get<IssueComment[]>(
            `${apiPath`/api/issues/${issueId}/comments`}${query ? `?${query}` : ""}`,
          )) ?? [];
          printOutput(comments, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment:get")
      .description("获取一条任务卡评论")
      .argument("<issueId>", "任务卡 ID")
      .argument("<commentId>", "评论 ID")
      .action(async (issueId: string, commentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const comment = await ctx.api.get<IssueComment>(apiPath`/api/issues/${issueId}/comments/${commentId}`);
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment:delete")
      .description("删除或取消一条任务卡评论")
      .argument("<issueId>", "任务卡 ID")
      .argument("<commentId>", "评论 ID")
      .action(async (issueId: string, commentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<IssueComment>(apiPath`/api/issues/${issueId}/comments/${commentId}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("approvals")
      .description("列出任务卡关联的审批")
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const approvals = await ctx.api.get(apiPath`/api/issues/${issueId}/approvals`);
          printOutput(approvals, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("approval:link")
      .description("将审批关联到任务卡")
      .argument("<issueId>", "任务卡 ID")
      .argument("<approvalId>", "审批 ID")
      .action(async (issueId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = linkIssueApprovalSchema.parse({ approvalId });
          const approvals = await ctx.api.post(apiPath`/api/issues/${issueId}/approvals`, payload);
          printOutput(approvals, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("approval:unlink")
      .description("解除任务卡与审批的关联")
      .argument("<issueId>", "任务卡 ID")
      .argument("<approvalId>", "审批 ID")
      .action(async (issueId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/issues/${issueId}/approvals/${approvalId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addIssuePostDeleteMarkerCommand(issue, "read", "将任务卡标记为已读", "post", "/read");
  addIssuePostDeleteMarkerCommand(issue, "unread", "将任务卡标记为未读", "delete", "/read");
  addIssuePostDeleteMarkerCommand(issue, "archive", "从收件箱归档任务卡", "post", "/inbox-archive");
  addIssuePostDeleteMarkerCommand(issue, "unarchive", "恢复收件箱中的任务卡", "delete", "/inbox-archive");

  addCommonClientOptions(
    issue
      .command("recovery-actions")
      .description("列出任务卡的有效恢复操作")
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/issues/${issueId}/recovery-actions`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("recovery:resolve")
      .description("处理任务卡恢复操作")
      .argument("<issueId>", "任务卡 ID")
      .requiredOption("--outcome <outcome>", "结果：restored、false_positive、blocked 或 cancelled")
      .requiredOption("--source-issue-status <status>", "恢复结果可使用 todo、done 或 in_review；blocked 仅适用于受阻结果")
      .option("--action-id <id>", "指定恢复操作 ID")
      .option("--resolution-note <text>", "处理说明")
      .action(async (issueId: string, opts: IssueRecoveryResolveOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resolveIssueRecoveryActionSchema.parse({
            actionId: opts.actionId,
            outcome: opts.outcome,
            sourceIssueStatus: opts.sourceIssueStatus,
            resolutionNote: opts.resolutionNote,
          });
          const result = await ctx.api.post(apiPath`/api/issues/${issueId}/recovery-actions/resolve`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("child:create")
      .description("通过 JSON 数据创建子任务卡")
      .argument("<issueId>", "父任务卡 ID")
      .requiredOption("--payload-json <json>", "CreateChildIssue JSON 数据")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createChildIssueSchema.parse(parseJson(opts.payloadJson));
          const child = await ctx.api.post<Issue>(apiPath`/api/issues/${issueId}/children`, payload);
          printOutput(child, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("force-release")
      .description("强制解除智能体对任务卡的签出")
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(apiPath`/api/issues/${issueId}/admin/force-release`, {});
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-products")
      .description("列出任务卡工作成果")
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await ctx.api.get(apiPath`/api/issues/${issueId}/work-products`);
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-product:create")
      .description("通过 JSON 创建任务卡工作成果")
      .argument("<issueId>", "任务卡 ID")
      .requiredOption("--payload-json <json>", "CreateIssueWorkProduct JSON 数据")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createIssueWorkProductSchema.parse(parseJson(opts.payloadJson));
          const product = await ctx.api.post(apiPath`/api/issues/${issueId}/work-products`, payload);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-product:update")
      .description("通过 JSON 更新工作成果")
      .argument("<workProductId>", "工作成果 ID")
      .requiredOption("--payload-json <json>", "UpdateIssueWorkProduct JSON 数据")
      .action(async (workProductId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateIssueWorkProductSchema.parse(parseJson(opts.payloadJson));
          const product = await ctx.api.patch(apiPath`/api/work-products/${workProductId}`, payload);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-product:delete")
      .description("删除工作成果")
      .argument("<workProductId>", "工作成果 ID")
      .action(async (workProductId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const product = await ctx.api.delete(apiPath`/api/work-products/${workProductId}`);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("documents")
      .description("列出任务卡文档")
      .argument("<issueId>", "任务卡 ID")
      .option("--include-system", "包含系统文档")
      .action(async (issueId: string, opts: BaseClientOptions & { includeSystem?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.includeSystem ? "?includeSystem=true" : "";
          const docs = await ctx.api.get(`${apiPath`/api/issues/${issueId}/documents`}${query}`);
          printOutput(docs, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:get")
      .description("获取任务卡文档")
      .argument("<issueId>", "任务卡 ID")
      .argument("<key>", "文档键名")
      .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const doc = await ctx.api.get(apiPath`/api/issues/${issueId}/documents/${key}`);
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:put")
      .description("创建或更新任务卡文档")
      .argument("<issueId>", "任务卡 ID")
      .argument("<key>", "文档键名")
      .option("--title <title>", "文档标题")
      .option("--format <format>", "文档格式", "markdown")
      .option("--body <markdown>", "文档正文")
      .option("--body-file <path>", "从文件读取文档正文")
      .option("--change-summary <text>", "变更摘要")
      .option("--base-revision-id <id>", "预期的基础修订版本 ID")
      .action(async (issueId: string, key: string, opts: IssueDocumentPutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const body = opts.bodyFile ? await readFile(opts.bodyFile, "utf8") : opts.body;
          const payload = upsertIssueDocumentSchema.parse({
            title: opts.title,
            format: opts.format,
            body,
            changeSummary: opts.changeSummary,
            baseRevisionId: opts.baseRevisionId,
          });
          const doc = await ctx.api.put(apiPath`/api/issues/${issueId}/documents/${key}`, payload);
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("interactions")
      .description("列出任务卡对话交互")
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const interactions = await ctx.api.get(apiPath`/api/issues/${issueId}/interactions`);
          printOutput(interactions, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("interaction:create")
      .description("通过 JSON 创建任务卡对话交互")
      .argument("<issueId>", "任务卡 ID")
      .requiredOption("--payload-json <json>", "CreateIssueThreadInteraction JSON 数据")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createIssueThreadInteractionSchema.parse(parseJson(opts.payloadJson));
          const interaction = await ctx.api.post(apiPath`/api/issues/${issueId}/interactions`, payload);
          printOutput(interaction, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("interaction:accept")
      .description("接受任务卡对话交互")
      .argument("<issueId>", "任务卡 ID")
      .argument("<interactionId>", "交互 ID")
      .option("--selected-client-keys <csv>", "要接受的客户端键名")
      .option("--selected-option-ids <csv>", "要接受的复选项 ID")
      .action(async (issueId: string, interactionId: string, opts: InteractionAcceptOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = acceptIssueThreadInteractionSchema.parse({
            selectedClientKeys: opts.selectedClientKeys === undefined ? undefined : parseCsv(opts.selectedClientKeys),
            selectedOptionIds: opts.selectedOptionIds === undefined ? undefined : parseCsv(opts.selectedOptionIds),
          });
          const interaction = await ctx.api.post(apiPath`/api/issues/${issueId}/interactions/${interactionId}/accept`, payload);
          printOutput(interaction, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, action, schema, description] of [
    ["interaction:reject", "reject", rejectIssueThreadInteractionSchema, "拒绝任务卡对话交互"],
    ["interaction:cancel", "cancel", cancelIssueThreadInteractionSchema, "取消任务卡对话交互"],
  ] as const) {
    addCommonClientOptions(
      issue
        .command(name)
        .description(description)
        .argument("<issueId>", "任务卡 ID")
        .argument("<interactionId>", "交互 ID")
        .option("--reason <text>", "原因")
        .action(async (issueId: string, interactionId: string, opts: InteractionReasonOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const payload = schema.parse({ reason: opts.reason });
            const interaction = await ctx.api.post(`${apiPath`/api/issues/${issueId}/interactions/${interactionId}`}/${action}`, payload);
            printOutput(interaction, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    issue
      .command("interaction:respond")
      .description("回复任务卡问题交互")
      .argument("<issueId>", "任务卡 ID")
      .argument("<interactionId>", "交互 ID")
      .requiredOption("--answers-json <json>", "答案数组 JSON")
      .option("--summary-markdown <markdown>", "可选回复摘要")
      .action(async (issueId: string, interactionId: string, opts: InteractionRespondOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = respondIssueThreadInteractionSchema.parse({
            answers: parseJson(opts.answersJson),
            summaryMarkdown: opts.summaryMarkdown,
          });
          const interaction = await ctx.api.post(apiPath`/api/issues/${issueId}/interactions/${interactionId}/respond`, payload);
          printOutput(interaction, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-state")
      .description("获取任务树控制状态")
      .argument("<issueId>", "根任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const state = await ctx.api.get(apiPath`/api/issues/${issueId}/tree-control/state`);
          printOutput(state, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-preview")
      .description("预览任务树控制变更")
      .argument("<issueId>", "根任务卡 ID")
      .requiredOption("--payload-json <json>", "PreviewIssueTreeControl JSON 数据")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = previewIssueTreeControlSchema.parse(parseJson(opts.payloadJson));
          const preview = await ctx.api.post(apiPath`/api/issues/${issueId}/tree-control/preview`, payload);
          printOutput(preview, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-holds")
      .description("列出任务树暂停记录")
      .argument("<issueId>", "根任务卡 ID")
      .option("--status <status>", "状态：active 或 released")
      .option("--mode <mode>", "模式：pause、resume、cancel 或 restore")
      .option("--include-members", "包含暂停成员")
      .action(async (issueId: string, opts: TreeHoldListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.mode) params.set("mode", opts.mode);
          if (opts.includeMembers) params.set("includeMembers", "true");
          const query = params.toString();
          const holds = await ctx.api.get(`${apiPath`/api/issues/${issueId}/tree-holds`}${query ? `?${query}` : ""}`);
          printOutput(holds, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-hold:create")
      .description("通过 JSON 创建任务树暂停记录")
      .argument("<issueId>", "根任务卡 ID")
      .requiredOption("--payload-json <json>", "CreateIssueTreeHold JSON 数据")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createIssueTreeHoldSchema.parse(parseJson(opts.payloadJson));
          const hold = await ctx.api.post(apiPath`/api/issues/${issueId}/tree-holds`, payload);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-hold:get")
      .description("获取任务树暂停记录")
      .argument("<issueId>", "根任务卡 ID")
      .argument("<holdId>", "暂停记录 ID")
      .action(async (issueId: string, holdId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const hold = await ctx.api.get(apiPath`/api/issues/${issueId}/tree-holds/${holdId}`);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-hold:release")
      .description("解除任务树暂停")
      .argument("<issueId>", "根任务卡 ID")
      .argument("<holdId>", "暂停记录 ID")
      .option("--payload-json <json>", "ReleaseIssueTreeHold JSON 数据", "{}")
      .action(async (issueId: string, holdId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = releaseIssueTreeHoldSchema.parse(parseJson(opts.payloadJson));
          const hold = await ctx.api.post(apiPath`/api/issues/${issueId}/tree-holds/${holdId}/release`, payload);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("attachments")
      .description("列出任务卡附件")
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const attachments = await ctx.api.get(apiPath`/api/issues/${issueId}/attachments`);
          printOutput(attachments, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("attachment:upload")
      .description("上传任务卡附件")
      .argument("<issueId>", "任务卡 ID")
      .option("-C, --company-id <id>", "公司 ID")
      .requiredOption("--file <path>", "要上传的文件")
      .option("--comment-id <id>", "关联到任务卡评论")
      .action(async (issueId: string, opts: IssueAttachmentUploadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const attachment = await uploadAttachment(ctx.api.apiBase, ctx.api.apiKey, {
            companyId: ctx.companyId ?? "",
            issueId,
            filePath: opts.file,
            commentId: opts.commentId,
            runId: ctx.api.runId,
          });
          printOutput(attachment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("attachment:download")
      .description("下载附件")
      .argument("<attachmentId>", "附件 ID")
      .option("--out <path>", "输出文件路径；省略时输出到标准输出")
      .action(async (attachmentId: string, opts: IssueAttachmentDownloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const bytes = await downloadAttachment(ctx.api.apiBase, ctx.api.apiKey, attachmentId);
          if (opts.out) {
            await writeFile(opts.out, bytes);
            if (ctx.json) printOutput({ out: opts.out, bytes: bytes.byteLength }, { json: true });
            else console.log(`已将 ${bytes.byteLength} 字节写入 ${opts.out}`);
            return;
          }
          process.stdout.write(bytes);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("attachment:delete")
      .description("删除附件")
      .argument("<attachmentId>", "附件 ID")
      .action(async (attachmentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/attachments/${attachmentId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("label:list")
      .description("列出公司的任务卡标签")
      .option("-C, --company-id <id>", "公司 ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const labels = await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/labels`);
          printOutput(labels, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("label:create")
      .description("创建任务卡标签")
      .option("-C, --company-id <id>", "公司 ID")
      .requiredOption("--name <name>", "标签名称")
      .requiredOption("--color <hex>", "标签颜色，例如 #4f46e5")
      .action(async (opts: IssueLabelCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createIssueLabelSchema.parse({ name: opts.name, color: opts.color });
          const label = await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/labels`, payload);
          printOutput(label, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("label:delete")
      .description("删除任务卡标签")
      .argument("<labelId>", "标签 ID")
      .action(async (labelId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/labels/${labelId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:votes")
      .description("列出任务卡反馈投票")
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const votes = await ctx.api.get(apiPath`/api/issues/${issueId}/feedback-votes`);
          printOutput(votes, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:vote")
      .description("创建或更新反馈投票")
      .argument("<issueId>", "任务卡 ID")
      .requiredOption("--payload-json <json>", "UpsertIssueFeedbackVote JSON 数据")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = upsertIssueFeedbackVoteSchema.parse(parseJson(opts.payloadJson));
          const vote = await ctx.api.post(apiPath`/api/issues/${issueId}/feedback-votes`, payload);
          printOutput(vote, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, pathSuffix, description] of [
    ["document:delete", "", "删除任务卡文档"],
    ["document:lock", "/lock", "锁定任务卡文档"],
    ["document:unlock", "/unlock", "解锁任务卡文档"],
  ] as const) {
    addCommonClientOptions(
      issue
        .command(name)
        .description(description)
        .argument("<issueId>", "任务卡 ID")
        .argument("<key>", "文档键名")
        .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const path = `${apiPath`/api/issues/${issueId}/documents/${key}`}${pathSuffix}`;
            const result = name === "document:delete" ? await ctx.api.delete(path) : await ctx.api.post(path, {});
            printOutput(result, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    issue
      .command("document:revisions")
      .description("列出任务卡文档修订版本")
      .argument("<issueId>", "任务卡 ID")
      .argument("<key>", "文档键名")
      .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const revisions = await ctx.api.get(apiPath`/api/issues/${issueId}/documents/${key}/revisions`);
          printOutput(revisions, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:restore")
      .description("恢复任务卡文档修订版本")
      .argument("<issueId>", "任务卡 ID")
      .argument("<key>", "文档键名")
      .argument("<revisionId>", "修订版本 ID")
      .action(async (issueId: string, key: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = restoreIssueDocumentRevisionSchema.parse({});
          const doc = await ctx.api.post(
            apiPath`/api/issues/${issueId}/documents/${key}/revisions/${revisionId}/restore`,
            payload,
          );
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:list")
      .description("列出任务卡反馈追踪记录")
      .argument("<issueId>", "任务卡 ID")
      .option("--target-type <type>", "按目标类型筛选")
      .option("--vote <vote>", "按投票值筛选")
      .option("--status <status>", "按追踪状态筛选")
      .option("--from <iso8601>", "仅包含此时间戳及之后创建的记录")
      .option("--to <iso8601>", "仅包含此时间戳及之前创建的记录")
      .option("--shared-only", "仅包含可共享或导出的记录")
      .option("--include-payload", "在响应中包含已存储的数据快照")
      .action(async (issueId: string, opts: IssueFeedbackOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const traces = (await ctx.api.get<FeedbackTrace[]>(
            `${apiPath`/api/issues/${issueId}/feedback-traces`}${buildFeedbackTraceQuery(opts)}`,
          )) ?? [];
          if (ctx.json) {
            printOutput(traces, { json: true });
            return;
          }
          printOutput(
            traces.map((trace) => ({
              id: trace.id,
              issue: trace.issueIdentifier ?? trace.issueId,
              vote: trace.vote,
              status: trace.status,
              targetType: trace.targetType,
              target: trace.targetSummary.label,
            })),
            { json: false },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("runs")
      .description("列出任务卡关联的心跳运行记录")
      .argument("<issueId>", "任务卡 ID 或编号")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(apiPath`/api/issues/${issueId}/runs`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("live-runs")
      .description("列出任务卡关联的排队中或运行中的心跳")
      .argument("<issueId>", "任务卡 ID 或编号")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<HeartbeatRun[]>(apiPath`/api/issues/${issueId}/live-runs`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("active-run")
      .description("显示任务卡关联的有效心跳运行记录")
      .argument("<issueId>", "任务卡 ID 或编号")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const run = await ctx.api.get<HeartbeatRun | null>(apiPath`/api/issues/${issueId}/active-run`);
          printOutput(run, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:export")
      .description("导出任务卡反馈追踪记录")
      .argument("<issueId>", "任务卡 ID")
      .option("--target-type <type>", "按目标类型筛选")
      .option("--vote <vote>", "按投票值筛选")
      .option("--status <status>", "按追踪状态筛选")
      .option("--from <iso8601>", "仅包含此时间戳及之后创建的记录")
      .option("--to <iso8601>", "仅包含此时间戳及之前创建的记录")
      .option("--shared-only", "仅包含可共享或导出的记录")
      .option("--include-payload", "在导出中包含已存储的数据快照")
      .option("--out <path>", "写入文件路径，而不是标准输出")
      .option("--format <format>", "导出格式：json 或 ndjson", "ndjson")
      .action(async (issueId: string, opts: IssueFeedbackOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const traces = (await ctx.api.get<FeedbackTrace[]>(
            `${apiPath`/api/issues/${issueId}/feedback-traces`}${buildFeedbackTraceQuery(opts, opts.includePayload ?? true)}`,
          )) ?? [];
            const serialized = serializeFeedbackTraces(traces, opts.format);
            if (opts.out?.trim()) {
              await writeFile(opts.out, serialized, "utf8");
              if (ctx.json) {
                printOutput(
                  { out: opts.out, count: traces.length, format: normalizeFeedbackTraceExportFormat(opts.format) },
                  { json: true },
                );
                return;
              }
              console.log(`已将 ${traces.length} 条反馈追踪记录写入 ${opts.out}`);
            return;
          }
          process.stdout.write(`${serialized}${serialized.endsWith("\n") ? "" : "\n"}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("checkout")
      .description("将任务卡签出给智能体")
      .argument("<issueId>", "任务卡 ID")
      .requiredOption("--agent-id <id>", "智能体 ID")
      .option(
        "--expected-statuses <csv>",
        "预期的当前状态",
        "todo,backlog,blocked",
      )
      .action(async (issueId: string, opts: IssueCheckoutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = checkoutIssueSchema.parse({
            agentId: opts.agentId,
            expectedStatuses: parseCsv(opts.expectedStatuses),
          });
          const updated = await ctx.api.post<Issue>(apiPath`/api/issues/${issueId}/checkout`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("release")
      .description("将任务卡释放回待办并清除负责人")
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const updated = await ctx.api.post<Issue>(apiPath`/api/issues/${issueId}/release`, {});
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function addIssuePostDeleteMarkerCommand(
  issue: Command,
  name: string,
  description: string,
  method: "post" | "delete",
  pathSuffix: string,
): void {
  addCommonClientOptions(
    issue
      .command(name)
      .description(description)
      .argument("<issueId>", "任务卡 ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = method === "post"
            ? await ctx.api.post(`${apiPath`/api/issues/${issueId}`}${pathSuffix}`, {})
            : await ctx.api.delete(`${apiPath`/api/issues/${issueId}`}${pathSuffix}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`无效的整数值：${value}`);
  }
  return parsed;
}

function parseHiddenAt(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "null") return null;
  return value;
}

function filterIssueRows(rows: Issue[], match: string | undefined): Issue[] {
  if (!match?.trim()) return rows;
  const needle = match.trim().toLowerCase();
  return rows.filter((row) => {
    const text = [row.identifier, row.title, row.description]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .toLowerCase();
    return text.includes(needle);
  });
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}

async function uploadAttachment(
  apiBase: string,
  apiKey: string | undefined,
  input: { companyId: string; issueId: string; filePath: string; commentId?: string; runId?: string },
): Promise<unknown> {
  const bytes = await readFile(input.filePath);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: inferContentTypeFromPath(input.filePath) }), input.filePath.split(/[\\/]/).pop() ?? "attachment");
  if (input.commentId) form.set("issueCommentId", input.commentId);
  // This multipart upload uses a hand-rolled fetch rather than PaperclipApiClient,
  // so it must forward the agent run-id header itself — otherwise an
  // agent-authenticated upload is rejected with "401 Agent run id required"
  // (the client injects x-paperclip-run-id automatically for JSON requests).
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (input.runId) headers["x-paperclip-run-id"] = input.runId;
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/companies/${input.companyId}/issues/${input.issueId}/attachments`), {
    method: "POST",
    headers,
    body: form,
  });
  return parseFetchResponse(response);
}

async function downloadAttachment(
  apiBase: string,
  apiKey: string | undefined,
  attachmentId: string,
): Promise<Buffer> {
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/attachments/${attachmentId}/content`), {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) {
    await parseFetchResponse(response);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function parseFetchResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = text.trim() ? safeJson(text) : null;
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `请求失败，状态码 ${response.status}`;
    throw new Error(`API 错误 ${response.status}：${message}`);
  }
  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
