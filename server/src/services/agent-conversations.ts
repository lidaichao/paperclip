import {
  persistActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import type { NativeStatusDecision } from "./native-runtime/status-arbiter.js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueTreeHolds,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";

import { sanitizeQuarantinedCommentForHigherTrust } from "./source-trust.js";

export type ConversationIdentity = {
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
  conversationState?: string | null;
  status?: string;
};
export function isConversation(
  issue: ConversationIdentity | null | undefined,
): boolean {
  return Boolean(issue?.conversationAgentId && issue.conversationUserId);
}
export function isWaitingConversation(
  issue: ConversationIdentity | null | undefined,
): boolean {
  return (
    isConversation(issue) &&
    issue?.conversationState === "waiting" &&
    issue.status === "in_review"
  );
}

/** Recovery for an older turn must not replace a reset or an answered chat. */
export function isSupersededConversationRun(
  issue: ConversationIdentity & {
    conversationSessionGeneration?: number;
    executionRunId?: string | null;
  },
  run: { id: string; contextSnapshot: Record<string, unknown> | null },
): boolean {
  if (!isConversation(issue)) return false;
  const generation = run.contextSnapshot?.conversationSessionGeneration;
  return (
    (typeof generation === "number" &&
      typeof issue.conversationSessionGeneration === "number" &&
      generation !== issue.conversationSessionGeneration) ||
    (typeof generation === "number" &&
      isWaitingConversation(issue) &&
      issue.executionRunId !== run.id)
  );
}
/** Execution tasks may link to a conversation, but never drive its turns.
 * Apply before enqueue, including while a reply is still running: waiting until
 * finalization is too late to prevent a deferred dependency follow-up.
 */
export function isConversationExecutionWake(
  issue: ConversationIdentity | null | undefined,
  reason: string | null | undefined,
): boolean {
  return isConversation(issue) && (
    reason === "issue_blockers_resolved" ||
    reason === "issue_children_completed" ||
    reason === "issue_unblock_requested"
  );
}

export function isConversationReset(body: string): boolean {
  return body.trim() === "/new";
}

export const AGENT_CHAT_DIRECTIVE = `你正在与用户持续对话。请帮助用户明确想要的结果。当缺失信息会实质影响任务时，提出聚焦的问题；请求已经清楚时，不要要求形式化确认。

请在这里使用对话的计划文档进行调研、澄清并形成完整计划。随着讨论推进修订草稿。只有计划不会创建执行任务；实施和实质执行工作必须放入独立任务。

当用户要求在移交前批准计划时，请先发布计划并创建绑定具体版本的批准卡片，再结束当前轮次。使用原生工具时，调用 request_human_input：interactionKind 设为 "confirmation"，targetRevisionId 使用已保存文档的 latestRevisionId，提供绑定该版本的 idempotencyKey，并将 continuationPolicy 设为 "wake_assignee"。将 payload.target 设为 { type: "issue_document", key: "plan", revisionId: latestRevisionId }。通过 HTTP 接口时，向 /api/issues/{issueId}/interactions POST 等效的 request_confirmation 交互。仅在回复文字中请求批准不会创建批准卡片。按要求修订后，请为新保存的版本创建新卡片。这只适用于用户明确要求的计划批准；普通对话回复和计划草稿不需要确认。在问答模式中，只讨论计划，不创建或修订文档和批准卡片。

移交工作前，检查可用项目和代码仓库。你从此聊天创建的每个任务都必须属于合适的项目。优先复用适合的现有项目；否则使用 create_project。考虑所有相关且可用的代码仓库；工作跨仓库时，通过 repositoryIds 传入一个或多个仓库。对于可访问但尚未进入目录的现有 GitHub 仓库，传入其 HTTPS repositoryUrls；这会将仓库登记到项目中，而不会创建远程 GitHub 仓库。可以组合已知编号和地址，并附加多个仓库。直接使用 HTTP 时，向 /api/companies/{companyId}/projects POST name、repositoryIds 和／或 repositoryUrls 数组以及 idempotencyKey。创建时一次包含所有选定仓库；不要将这些数组与 workspace 混用。绝不能编造仓库编号或用无法访问的仓库代替。如果选择存在实质歧义或缺少必要权限，请询问用户。非代码项目可以不需要仓库。

创建普通的已分配任务，绝不能创建为此对话的子任务。为每个任务提供清晰的结果、上下文、验收标准、项目和合适的负责人。使用 create_task 并通过 initialPlan 在执行开始前把相关计划复制到新任务。直接使用 HTTP 时，向 /api/companies/{companyId}/issues POST：projectId、assigneeAgentId、status: "todo"、包含相关计划 Markdown 的 initialPlan 以及 idempotencyKey；不要提供 parentId。把计划写进 description 并不会创建任务计划文档。声称移交完成前，先验证新任务的计划文档。请在这里保留原计划。只传递剩余执行步骤，不要传递已完成的规划、批准、项目创建或任务创建步骤。包含源对话编号、已批准计划版本编号和已接受交互编号，使执行者能够核对已记录批准。说明获批范围和已经完成的内容；不要声称新计划文档自身已经获批。执行者应执行该授权范围，只有范围变化或其他适用门禁要求时才再次询问。拆分工作时，把计划的相关部分写入每个任务。声称任务存在前，先创建并链接每个任务。

对于评审或跟进任务，应包含负责人所需的现有源材料，而不只是任务编号或检查标准。读取源任务保存的文档和评论，再把相关现有内容复制到移交说明中，或附加接收者确实能读取的资源。新任务的工具可能只能访问自身文档和历史记录。提供现有源材料属于协调，不等于替负责人制作交付物。

更新状态时，区分任务记录状态、实际执行状态和已核实进度。解释阻塞或声称工作正在进行前，先读取最新相关评论和运行结果。需要查看其他任务详情时，使用已声明的接口工具。依赖已完成并不能证明阻塞理由已经失效；请报告负责人记录的原因。智能体配置可能经过脱敏：没有配置读取权限时，空配置对象不能证明设置已禁用或处于默认值。证据不可用时，请说明能够核实的内容和仍未知的内容，不要猜测或建议修改状态。

请在这里保持讨论，并让对话能够接收下一条消息。在回复中链接已移交任务；不要让这些任务的完成阻塞此对话，也不要等待它们完成。创建已分配任务后，让任务自己的运行过程执行工作；不要在此聊天中制作该任务的交付物或修改其执行状态。正常回复并结束当前轮次；Alice 会管理对话的等待状态。不要修改此对话状态，不要仅为了结束回复而创建评审确认，不要把它标记为完成，也不要轮询下一条回复。已接受计划只授权移交给执行任务，绝不授权在此对话中实施。遵守正常审批。问答模式不允许变更；计划模式支持调研和编写或修订计划；只能通过正常授权流程移交执行。`;

/** A reset keeps history visible, but parked input from a stopped session cannot become a new turn. */
export function currentConversationCommentCondition() {
  return sql`not exists (
    select 1 from ${issues} conversation_issue
    join ${issueComments} conversation_boundary
      on conversation_boundary.id = conversation_issue.conversation_boundary_comment_id
      and conversation_boundary.company_id = conversation_issue.company_id
      and conversation_boundary.issue_id = conversation_issue.id
    where conversation_issue.id = ${issueComments.issueId}
      and conversation_issue.company_id = ${issueComments.companyId}
      and conversation_issue.conversation_agent_id is not null
      and (${issueComments.createdAt}, ${issueComments.id}) < (conversation_boundary.created_at, conversation_boundary.id)
  )`;
}

/** Runs under the normal issue execution lock, before any provider session is read. */
export async function prepareConversationTurn(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = { ...(run.contextSnapshot ?? {}) };
  const issueId = typeof context.issueId === "string" ? context.issueId : null;
  if (!issueId) return { context, reset: false, conversation: false };
  let publication: ActivityPublication | null = null;
  const result = await db.transaction(async (tx) => {
    const [issue] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .for("update");
    if (!isConversation(issue))
      return { context, reset: false, conversation: false };
    const commentId =
      typeof context.wakeCommentId === "string"
        ? context.wakeCommentId
        : typeof context.commentId === "string"
          ? context.commentId
          : null;
    const [comment] = commentId
      ? await tx
          .select()
          .from(issueComments)
          .where(
            and(
              eq(issueComments.id, commentId),
              eq(issueComments.issueId, issueId),
              eq(issueComments.companyId, run.companyId),
            ),
          )
      : [];
    const reset = Boolean(
      comment && comment.authorUserId && isConversationReset(comment.body),
    );
    let generation = issue.conversationSessionGeneration;
    if (
      typeof context.conversationSessionGeneration === "number" &&
      context.conversationSessionGeneration !== generation
    ) {
      throw new Error(
        "会话已发生变化；无法恢复此较早的对话轮次",
      );
    }
    // The boundary lives on the command comment. A crash/retry reuses it instead of resetting twice.
    if (reset && comment && comment.conversationSessionGeneration == null) {
      generation += 1;
      await tx
        .update(issues)
        .set({
          conversationSessionGeneration: generation,
          conversationBoundaryCommentId: comment.id,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));
      await tx
        .update(issueComments)
        .set({ conversationSessionGeneration: generation })
        .where(eq(issueComments.id, comment.id));
      // Questions from the previous session must not keep occupying the
      // composer or wake the old topic, even if they survive normal comments.
      const expiredQuestions = await tx.update(issueThreadInteractions).set({
        status: "expired", resolvedAt: new Date(), updatedAt: new Date(),
        resolvedByUserId: comment.authorUserId,
        result: { version: 1, outcome: "withdrawn", reason: "新的对话会话", answers: [], summaryMarkdown: null },
      }).where(and(eq(issueThreadInteractions.companyId, issue.companyId),
        eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.status, "pending"),
        eq(issueThreadInteractions.kind, "ask_user_questions"))).returning({ id: issueThreadInteractions.id });
      publication = (
        await persistActivity(tx as unknown as Db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "conversation",
          action: "issue.conversation_session_started",
          entityType: "issue",
          entityId: issue.id,
          runId: run.id,
          details: { generation, boundaryCommentId: comment.id, expiredInteractionIds: expiredQuestions.map((row) => row.id) },
        })
      ).publication;
      // Deliberately do not touch agentRuntimeState or sessions belonging to other tasks.
      await tx
        .delete(agentTaskSessions)
        .where(
          and(
            eq(agentTaskSessions.companyId, issue.companyId),
            eq(agentTaskSessions.agentId, issue.conversationAgentId!),
            eq(agentTaskSessions.taskKey, issue.id),
          ),
        );
    }
    await tx
      .update(issues)
      .set({
        conversationState: "active",
        status: "in_progress",
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));
    const next = {
      ...context,
      conversationSessionGeneration: generation,
      conversationMode: true,
    };
    await tx
      .update(heartbeatRuns)
      .set({ contextSnapshot: next })
      .where(eq(heartbeatRuns.id, run.id));
    return { context: next, reset, conversation: true };
  });
  if (publication) publishActivity(publication);
  return result;
}

/** Finalizers only park a turn with a durable response, interaction, or processed /new. */
export async function settleConversationTurn(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
) {
  if (run.status !== "succeeded") return false;
  const context = run.contextSnapshot ?? {};
  const issueId = typeof context.issueId === "string" ? context.issueId : null;
  if (!issueId) return false;
  let publication: ActivityPublication | null = null;
  const settled = await db.transaction(async (tx) => {
    const [issue] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .for("update");
    if (
      !isConversation(issue) ||
      (issue.executionRunId && issue.executionRunId !== run.id)
    )
      return false;
    const [response] = await tx
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          eq(issueComments.createdByRunId, run.id),
          eq(issueComments.authorAgentId, issue.conversationAgentId!),
          isNull(issueComments.deletedAt),
        ),
      )
      .limit(1);
    // Native question/plan waits use the durable interaction as the reply;
    // their terminal prose is deliberately not materialized as a comment.
    const [interaction] = !response && context.conversationReset !== true
      ? await tx.select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.companyId, run.companyId),
            eq(issueThreadInteractions.issueId, issueId),
            eq(issueThreadInteractions.sourceRunId, run.id),
            eq(issueThreadInteractions.createdByAgentId, issue.conversationAgentId!),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .limit(1)
      : [];
    if (!response && !interaction && context.conversationReset !== true) return false;
    if (
      context.conversationSessionGeneration !==
      issue.conversationSessionGeneration
    )
      return false;
    // Messages arriving during the reply remain actionable, including the
    // crash window between their comment commit and wake enqueue.
    const wakeId =
      typeof context.wakeCommentId === "string"
        ? context.wakeCommentId
        : context.commentId;
    const [wake] =
      typeof wakeId === "string"
        ? await tx
            .select()
            .from(issueComments)
            .where(eq(issueComments.id, wakeId))
        : [];
    const [pending] = wake
      ? await tx
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.issueId, issueId),
              isNull(issueComments.deletedAt),
              sql`${issueComments.authorUserId} is not null`,
              sql`(${issueComments.createdAt}, ${issueComments.id}) > (select cursor.created_at, cursor.id from issue_comments cursor where cursor.id = ${wake.id}::uuid)`,
            ),
          )
          .limit(1)
      : [];
    const status = pending ? "in_progress" : "in_review";
    const conversationState = pending ? "active" : "waiting";
    if (
      issue.status === status &&
      issue.conversationState === conversationState
    )
      return true;
    await tx
      .update(issues)
      .set({
        status,
        conversationState,
        statusVersion: sql`${issues.statusVersion} + 1`,
        completedAt: null,
        cancelledAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issues.id, issueId),
          sql`(${issues.executionRunId} is null or ${issues.executionRunId} = ${run.id})`,
        ),
      );
    publication = (
      await persistActivity(tx as unknown as Db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "conversation",
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
        runId: run.id,
        details: {
          status,
          conversationState,
          conversationSessionGeneration: issue.conversationSessionGeneration,
        },
      })
    ).publication;
    return true;
  });
  if (publication) publishActivity(publication);
  return settled;
}

/** Fresh provider context uses only messages in this session, up to this turn. */
export async function conversationReplay(
  db: Db,
  companyId: string,
  issueId: string,
  wakeCommentId: string | null,
) {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  if (!isConversation(issue)) return "";
  const [boundary] = issue.conversationBoundaryCommentId
    ? await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, issue.conversationBoundaryCommentId))
    : [];
  const [wake] = wakeCommentId
    ? await db
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.id, wakeCommentId),
            eq(issueComments.issueId, issueId),
          ),
        )
    : [];
  const rows = await db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt),
        boundary
          ? sql`(${issueComments.createdAt}, ${issueComments.id}) > (select cursor.created_at, cursor.id from issue_comments cursor where cursor.id = ${boundary.id}::uuid)`
          : undefined,
        wake
          ? sql`(${issueComments.createdAt}, ${issueComments.id}) < (select cursor.created_at, cursor.id from issue_comments cursor where cursor.id = ${wake.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(40);
  return rows
    .reverse()
    .map((row) =>
      JSON.stringify({
        author: row.authorAgentId ? "agent" : "user",
        body: sanitizeQuarantinedCommentForHigherTrust(row).body.slice(0, 8000),
      }),
    )
    .join("\n");
}

/** Comment rows form a durable outbox for the narrow commit-to-enqueue crash window. */
export async function undeliveredConversationComments(
  db: Db,
  companyId: string,
  issueId: string,
) {
  return db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt),
        sql`${issueComments.clientRequestId} is not null`,
        sql`not exists (select 1 from ${agentWakeupRequests} where ${agentWakeupRequests.companyId} = ${companyId}
      and ${agentWakeupRequests.idempotencyKey} = 'conversation-comment:' || ${issueComments.id}::text)`,
      ),
    )
    .orderBy(issueComments.createdAt, issueComments.id)
    .limit(100);
}

/** A user's /new resumes this chat without replaying the stopped turn. */
export async function resumeConversationForReset(db: Db, comment: typeof issueComments.$inferSelect) {
  if (!comment.authorUserId || !isConversationReset(comment.body)) return;
  const publications: ActivityPublication[] = [];
  await db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, comment.issueId), eq(issues.companyId, comment.companyId),
    )).for("update");
    if (!isConversation(issue) || comment.conversationSessionGeneration != null) return;
    const released = await tx.update(issueTreeHolds).set({
      status: "released", releasedAt: new Date(), updatedAt: new Date(),
      releasedByActorType: "user", releasedByUserId: comment.authorUserId,
      releaseReason: "通过 /new 恢复", releaseMetadata: { commentId: comment.id, wakeAgents: false },
    }).where(and(eq(issueTreeHolds.companyId, issue.companyId),
      eq(issueTreeHolds.rootIssueId, issue.id), eq(issueTreeHolds.mode, "pause"),
      eq(issueTreeHolds.status, "active"))).returning();
    for (const hold of released) {
      publications.push((await persistActivity(tx as unknown as Db, {
        companyId: issue.companyId, actorType: "user", actorId: comment.authorUserId!,
        action: "issue.tree_hold_released", entityType: "issue", entityId: issue.id,
        details: { holdId: hold.id, mode: "pause", reason: "通过 /new 恢复", commentId: comment.id },
      })).publication);
    }
  });
  for (const publication of publications) publishActivity(publication);
}

/** Serialize durable outbox delivery across API servers; the normal wake queue owns execution. */
export async function deliverConversationComments(
  db: Db,
  issue: { id: string; companyId: string; conversationAgentId: string | null },
  enqueue: (
    agentId: string,
    options: {
      source: "on_demand";
      triggerDetail: "manual";
      reason: string;
      idempotencyKey: string;
      requestedByActorType: "user";
      requestedByActorId: string | null;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    },
  ) => Promise<unknown>,
) {
  if (!issue.conversationAgentId) return;
  for (;;) {
    const delivered = await db.transaction(async (tx) => {
      // Contenders release their connection while waiting so concurrent sends
      // cannot exhaust the pool needed by normal wake admission.
      const locks = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${"conversation-delivery:" + issue.id}, 0)) as acquired`,
      );
      if (!locks[0]?.acquired) return false;
      for (const comment of await undeliveredConversationComments(
        tx as unknown as Db,
        issue.companyId,
        issue.id,
      )) {
        await resumeConversationForReset(db, comment);
        await enqueue(issue.conversationAgentId!, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "issue_commented",
          idempotencyKey: `conversation-comment:${comment.id}`,
          requestedByActorType: "user",
          requestedByActorId: comment.authorUserId,
          payload: { issueId: issue.id, commentId: comment.id },
          contextSnapshot: {
            issueId: issue.id,
            taskKey: issue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeCommentIds: [comment.id],
            source: "issue.comment",
          },
        });
      }
      return true;
    });
    if (delivered) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Conversation turns do not need execution-task completion evidence or a continuation. */
export function conversationNativeDecision(input: {
  conversation: boolean;
  terminalState: unknown;
  workspaceFinalizeStatus: string;
  hasGovernanceGate: boolean;
  priorStatus: NativeStatusDecision["toStatus"];
  decision: NativeStatusDecision;
}): NativeStatusDecision {
  if (
    !input.conversation ||
    input.terminalState !== "succeeded" ||
    input.workspaceFinalizeStatus !== "succeeded" ||
    input.hasGovernanceGate ||
    input.decision.statusAction === "blocked" ||
    input.decision.effects.some(
      (effect) =>
        effect.kind === "schedule_retry" ||
        effect.kind === "record_finalization_error",
    )
  )
    return input.decision;
  return {
    ...input.decision,
    statusAction: "preserve",
    toStatus: input.priorStatus,
    reasonCode: "conversation_turn_finished",
    unblockDescriptor: null,
    effects: [],
  };
}
