import { and, desc, eq, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { completionContracts } from "@paperclipai/db";
import type { StrictCompletionContractInput } from "../../vendor/paperclip-runner/index.js";

import { nativeSha256 } from "./canonical.js";

export const NATIVE_COMPLETION_CONTRACT_SCHEMA = "paperclip.completion-contract.v1";
export const NATIVE_COMPLETION_POLICY_VERSION = "phase6-v4";

export function nativeCompletionRequestsForComments(
  comments: readonly {
    body: string;
    attachments?: readonly unknown[];
  }[],
  options: { requiredFullWakeCommentCount?: number } = {},
): string[] {
  if (
    Number.isSafeInteger(options.requiredFullWakeCommentCount) &&
    (options.requiredFullWakeCommentCount ?? 0) > 0
  ) {
    return [
      `使用 read_current_wake_comments 读取所有服务器绑定的待处理外部聊天评论，直到 complete=true；然后按顺序回答全部 ${options.requiredFullWakeCommentCount} 条已接受评论，不得遗漏任何请求。请如实说明不可用附件；附件元数据不等于附件内容。`,
    ];
  }
  return comments.flatMap((comment, index) => {
    const body = comment.body.trim();
    if (body) return [body];
    // 仅包含文件的消息仍是当前请求。不得退回使用较早的命令式标题，
    // 也不得将用户控制的文件名视为策略。
    return comment.attachments?.length
      ? [`检查并回复待处理评论 ${index + 1} 中的附件。`]
      : [];
  });
}

export function resolveNativeCompletionPolicy(issue: {
  reviewPolicy?: string | null;
}) {
  const externalReviewRequired =
    issue.reviewPolicy === "human_only" || issue.reviewPolicy === "not_creator";
  return externalReviewRequired
    ? { risk: "standard", completionAuthority: "server_arbiter" } as const
    : { risk: "low", completionAuthority: "agent_claim_policy" } as const;
}

export function buildNativeCompletionContract(
  issue: { title: string; description: string | null },
  options: {
    readonly revision?: number;
    readonly immediateRequest?: string | null;
    readonly immediateRequests?: readonly string[] | null;
    /** 本次唤醒中经服务器验证的 humanResponses 条目 ID；其内容已在任务上下文中。 */
    readonly humanResponseId?: string | null;
  } = {},
): StrictCompletionContractInput {
  const immediateRequests = (
    options.immediateRequests ??
    (options.immediateRequest == null ? [] : [options.immediateRequest])
  )
    .map((request) => request.trim())
    .filter((request) => request.length > 0);
  const humanResponseId = options.humanResponseId?.trim();
  const hasFollowUp = immediateRequests.length > 0 || Boolean(humanResponseId);
  // 引用现有上下文，不要在每份后续契约中重复复制任务说明和历史记录。
  // 评论变化或恢复执行时，这段指引应保持稳定。
  const followUpObjective = "请根据所提供上下文中的任务说明和用户当前指示，完成当前已授权阶段。较新的用户指示会替代与其冲突的范围；其他要求、已分配技能的说明和审批门禁仍需保留。仅在对应问题或决定的范围内应用已认证的 humanResponses。澄清不等于批准。如果执行前需要接受确认，请先提出或保存所需计划并等待确认。";
  return {
    revision: String(options.revision ?? 1),
    objective: hasFollowUp
      ? followUpObjective
      : issue.title,
    criteria: hasFollowUp
      ? [
          ...immediateRequests.map((request, index) => ({
            id: immediateRequests.length === 1 ? "objective" : `pending_comment_${index + 1}`,
            requirement: request,
          })),
          ...(humanResponseId ? [{
            id: "human_response",
            requirement: `请在所提供的当前请求上下文中，应用服务器已验证且 id 为 ${JSON.stringify(humanResponseId)} 的 humanResponses 条目；仅限其问题或决定范围，并服从用户后续指示。`,
          }] : []),
        ]
      : [
          {
            id: "objective",
            requirement:
              issue.description?.trim() || `完成：${issue.title}`,
          },
        ],
  };
}

export async function ensureNativeCompletionContract(input: {
  db: Db;
  companyId: string;
  issue: {
    id: string;
    title: string;
    description: string | null;
    reviewPolicy?: string | null;
  };
  actorId: string;
  immediateRequest?: string | null;
  immediateRequests?: readonly string[] | null;
  humanResponseId?: string | null;
}) {
  return input.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${[
      "paperclip:native-completion-contract",
      input.companyId,
      input.issue.id,
    ].join(":")}, 0))`);
    const policy = resolveNativeCompletionPolicy(input.issue);
    const latest = await tx
      .select()
      .from(completionContracts)
      .where(and(
        eq(completionContracts.companyId, input.companyId),
        eq(completionContracts.issueId, input.issue.id),
      ))
      .orderBy(desc(completionContracts.revision))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const latestRevision = latest?.revision ?? 1;
    const latestCandidate = buildNativeCompletionContract(input.issue, {
      revision: latestRevision,
      immediateRequest: input.immediateRequest,
      immediateRequests: input.immediateRequests,
      humanResponseId: input.humanResponseId,
    });
    const latestCandidateSha256 = nativeSha256({
      schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
      policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
      ...policy,
      contract: latestCandidate,
    });
    if (latest?.canonicalSha256 === latestCandidateSha256) {
      return { row: latest, contract: latestCandidate };
    }

    const nextRevision = latest ? latest.revision + 1 : 1;
    const contract = buildNativeCompletionContract(input.issue, {
      revision: nextRevision,
      immediateRequest: input.immediateRequest,
      immediateRequests: input.immediateRequests,
      humanResponseId: input.humanResponseId,
    });
    const canonicalSha256 = nativeSha256({
      schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
      policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
      ...policy,
      contract,
    });
    const [row] = await tx.insert(completionContracts).values({
      companyId: input.companyId,
      issueId: input.issue.id,
      revision: nextRevision,
      schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
      policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
      ...policy,
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: contract as unknown as Record<string, unknown>,
      canonicalSha256,
      createdByActorType: "system",
      createdByActorId: input.actorId,
      supersedesContractId: latest?.id ?? null,
    }).returning();
    if (!row) throw new Error("native_completion_contract_not_persisted");
    return { row, contract };
  });
}
