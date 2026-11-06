import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests, agents, heartbeatRuns, issueCompletionReviews,
  issues, issueThreadInteractions, localAgentRunLeases,
} from "@paperclipai/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { conflict } from "../errors.js";
import { completionReviewRejectedWakeKey,
  ISSUE_COMPLETION_REVIEW_TARGET_KEY } from "./issue-completion-review-contract.js";

export const CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON = "issue_completion_review";

/** Stable receipt key for the future dedicated reviewer wake producer. */
export function clientPullCompletionReviewWakeKey(reviewId: string, interactionId: string) {
  return `interaction:${interactionId}:completion-review:${reviewId}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/**
 * Inert admission check for a future reviewer claim. The caller must already
 * hold agent→key→queued run→issue locks; this helper never claims a run, starts
 * a model, changes the source assignee, or writes issues.executionRunId.
 * Dedicated queued reviewer runs may exist, but no claim path admits them yet.
 */
export async function assertClientPullReviewClaimCandidate(
  db: Db,
  tx: Db,
  input: {
    agent: typeof agents.$inferSelect;
    run: typeof heartbeatRuns.$inferSelect;
    issue: typeof issues.$inferSelect;
  },
) {
  const { agent, run, issue } = input;
  const context = object(run.contextSnapshot);
  const issueId = context.issueId;
  const interactionId = context.interactionId;
  const reviewId = context.reviewId;
  const sourceRunId = context.sourceRunId;
  if (run.status !== "queued" || run.runtimeMode !== "client_pull" ||
    run.companyId !== agent.companyId ||
    run.agentId !== agent.id || issue.companyId !== agent.companyId ||
    issue.id !== issueId || issue.status !== "in_review" ||
    issue.executionRunId !== null || issue.assigneeAgentId === agent.id ||
    typeof reviewId !== "string" || typeof interactionId !== "string" ||
    typeof sourceRunId !== "string" ||
    context.wakeReason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON ||
    !run.wakeupRequestId ||
    object(agent.runtimeConfig).executionMode !== "client_pull" ||
    ["terminated", "pending_approval", "paused"].includes(agent.status) ||
    agent.pausedAt) {
    throw conflict("Dedicated reviewer run is not claimable");
  }

  const [review] = await tx.select().from(issueCompletionReviews).where(and(
    eq(issueCompletionReviews.id, reviewId),
    eq(issueCompletionReviews.companyId, agent.companyId),
    eq(issueCompletionReviews.issueId, issue.id),
  )).limit(1).for("update");
  const [interaction] = await tx.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId),
    eq(issueThreadInteractions.companyId, agent.companyId),
    eq(issueThreadInteractions.issueId, issue.id),
  )).limit(1).for("update");
  const target = object(object(interaction?.payload).target);
  if (!review || !interaction || review.state !== "pending" ||
    review.sourceKind !== "client_pull" ||
    review.reviewerAgentId !== agent.id ||
    review.sourceAgentId !== issue.assigneeAgentId ||
    review.sourceAgentId === agent.id ||
    review.sourceRunId !== sourceRunId ||
    review.clientPullLeaseRunId !== sourceRunId ||
    review.interactionId !== interaction.id ||
    Number(review.issueStatusVersion) !== Number(issue.statusVersion) ||
    interaction.kind !== "request_confirmation" || interaction.status !== "pending" ||
    interaction.continuationPolicy !== "wake_assignee" ||
    interaction.requestedResolverPolicy !== "not_creator" ||
    interaction.effectiveResolverPolicy !== "not_creator" ||
    interaction.addresseeAgentId !== agent.id ||
    interaction.addresseeUserId !== null ||
    interaction.createdByAgentId !== review.sourceAgentId ||
    interaction.sourceRunId !== sourceRunId ||
    target.type !== "custom" || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
    target.revisionId !== review.id ||
    object(interaction.payload).toolAction !== undefined ||
    object(interaction.payload).secretProposal !== undefined) {
    throw conflict("Dedicated completion review is stale or not addressed to this agent");
  }

  const [wake] = await tx.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, run.wakeupRequestId)).limit(1).for("update");
  const payload = object(wake?.payload);
  if (!wake || wake.companyId !== agent.companyId || wake.agentId !== agent.id ||
    wake.runId !== run.id || wake.status !== "queued" ||
    wake.source !== "automation" ||
    wake.reason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON ||
    wake.idempotencyKey !== clientPullCompletionReviewWakeKey(review.id, interaction.id) ||
    payload.issueId !== issue.id || payload.interactionId !== interaction.id ||
    payload.reviewId !== review.id || payload.sourceRunId !== sourceRunId) {
    throw conflict("Reviewer wake receipt does not match the review revision");
  }

  const [sourceRun] = await tx.select({ status: heartbeatRuns.status,
    companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
  }).from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId)).limit(1);
  const [sourceLease] = await tx.select({ releasedAt: localAgentRunLeases.releasedAt,
    stopAcknowledgedAt: localAgentRunLeases.stopAcknowledgedAt,
    outcome: localAgentRunLeases.outcome, companyId: localAgentRunLeases.companyId,
    agentId: localAgentRunLeases.agentId, issueId: localAgentRunLeases.issueId,
  }).from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, sourceRunId)).limit(1);
  const [otherRunning] = await tx.select({ id: heartbeatRuns.id })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, agent.companyId),
      eq(heartbeatRuns.status, "running"), ne(heartbeatRuns.id, run.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`)).limit(1);
  const [otherLease] = await tx.select({ runId: localAgentRunLeases.runId })
    .from(localAgentRunLeases).where(and(
      eq(localAgentRunLeases.companyId, agent.companyId),
      eq(localAgentRunLeases.issueId, issue.id),
      isNull(localAgentRunLeases.releasedAt),
    )).limit(1);
  if (!sourceRun || sourceRun.companyId !== agent.companyId ||
    sourceRun.agentId !== review.sourceAgentId || sourceRun.status !== "succeeded" ||
    !sourceLease || sourceLease.companyId !== agent.companyId ||
    sourceLease.agentId !== review.sourceAgentId || sourceLease.issueId !== issue.id ||
    !sourceLease.releasedAt || !sourceLease.stopAcknowledgedAt ||
    sourceLease.outcome !== "succeeded" || otherRunning || otherLease) {
    throw conflict("Source execution has not fully released the review task");
  }

  // The same scheduler suppression, worktree cutoff, org-chain, budget and
  // daily limits used by ordinary local claims remain mandatory.
  const { heartbeatService } = await import("./heartbeat.js");
  await heartbeatService(db).assertClientPullClaimAdmission(run, agent, issue, tx);
  return { issueId: issue.id, interactionId: interaction.id, reviewId: review.id,
    sourceRunId, wakeReason: CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON };
}

/** The reviewer may write run telemetry while its exact review remains open. */
export async function assertClientPullReviewEventContext(tx: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  issue: typeof issues.$inferSelect;
}) {
  const { run, issue } = input;
  const context = object(run.contextSnapshot);
  if (run.status !== "running" || run.runtimeMode !== "client_pull" ||
    context.wakeReason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON ||
    context.issueId !== issue.id || run.companyId !== issue.companyId ||
    issue.status !== "in_review" || issue.executionRunId !== null ||
    issue.assigneeAgentId === run.agentId || issue.conversationAgentId ||
    typeof context.reviewId !== "string" ||
    typeof context.interactionId !== "string" ||
    typeof context.sourceRunId !== "string" || !run.wakeupRequestId) {
    throw staleReviewEvent();
  }
  const [review] = await tx.select().from(issueCompletionReviews).where(and(
    eq(issueCompletionReviews.id, context.reviewId),
    eq(issueCompletionReviews.companyId, issue.companyId),
    eq(issueCompletionReviews.issueId, issue.id),
  )).for("update");
  const [card] = await tx.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, context.interactionId),
    eq(issueThreadInteractions.companyId, issue.companyId),
    eq(issueThreadInteractions.issueId, issue.id),
  )).for("update");
  const [wake] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.companyId, issue.companyId),
  )).for("update");
  const target = object(object(card?.payload).target);
  const wakePayload = object(wake?.payload);
  if (!review || !card || !wake || review.state !== "pending" ||
    review.sourceKind !== "client_pull" ||
    review.reviewerAgentId !== run.agentId ||
    review.sourceAgentId !== issue.assigneeAgentId ||
    review.sourceRunId !== context.sourceRunId ||
    review.clientPullLeaseRunId !== context.sourceRunId ||
    review.issueStatusVersion !== issue.statusVersion ||
    review.interactionId !== card.id ||
    card.kind !== "request_confirmation" || card.status !== "pending" ||
    card.sourceRunId !== review.sourceRunId ||
    card.createdByAgentId !== review.sourceAgentId ||
    card.addresseeAgentId !== run.agentId || card.addresseeUserId !== null ||
    card.continuationPolicy !== "wake_assignee" ||
    card.requestedResolverPolicy !== "not_creator" ||
    card.effectiveResolverPolicy !== "not_creator" ||
    target.type !== "custom" || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
    target.revisionId !== review.id ||
    wake.runId !== run.id || wake.agentId !== run.agentId ||
    wake.status !== "claimed" ||
    wake.reason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON ||
    wake.idempotencyKey !== clientPullCompletionReviewWakeKey(review.id, card.id) ||
    wakePayload.issueId !== issue.id || wakePayload.reviewId !== review.id ||
    wakePayload.interactionId !== card.id ||
    wakePayload.sourceRunId !== review.sourceRunId) {
    throw staleReviewEvent();
  }
  return { review, card };
}

/** A reviewer may stop successfully only after its own immutable decision committed. */
export async function assertClientPullAcceptedReviewContext(tx: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  issue: typeof issues.$inferSelect;
}) {
  const { run, issue } = input;
  const context = object(run.contextSnapshot);
  if (run.status !== "running" || run.runtimeMode !== "client_pull" ||
    context.wakeReason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON ||
    context.issueId !== issue.id || run.companyId !== issue.companyId ||
    !["in_review", "done"].includes(issue.status) || issue.executionRunId !== null ||
    issue.assigneeAgentId === run.agentId || issue.conversationAgentId ||
    typeof context.reviewId !== "string" ||
    typeof context.interactionId !== "string" ||
    typeof context.sourceRunId !== "string" || !run.wakeupRequestId) {
    throw staleReviewEvent();
  }
  const [review] = await tx.select().from(issueCompletionReviews).where(and(
    eq(issueCompletionReviews.id, context.reviewId),
    eq(issueCompletionReviews.companyId, issue.companyId),
    eq(issueCompletionReviews.issueId, issue.id),
  )).for("update");
  const [card] = await tx.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, context.interactionId),
    eq(issueThreadInteractions.companyId, issue.companyId),
    eq(issueThreadInteractions.issueId, issue.id),
  )).for("update");
  const [wake] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.companyId, issue.companyId),
  )).for("update");
  const target = object(object(card?.payload).target);
  const receipt = object(review?.decisionReceipt);
  const wakePayload = object(wake?.payload);
  if (!review || !card || !wake || review.state !== "accepted" ||
    review.sourceKind !== "client_pull" ||
    review.reviewerAgentId !== run.agentId ||
    review.sourceAgentId !== issue.assigneeAgentId ||
    review.sourceRunId !== context.sourceRunId ||
    review.clientPullLeaseRunId !== context.sourceRunId ||
    review.interactionId !== card.id ||
    !((issue.status === "in_review" &&
      issue.statusVersion === review.issueStatusVersion) ||
      (issue.status === "done" &&
        issue.statusVersion === review.issueStatusVersion + 1)) ||
    !review.decisionRequestId || !review.decidedAt ||
    receipt.schemaVersion !== 1 || receipt.outcome !== "accepted" ||
    receipt.reviewerRuntimeMode !== "client_pull" ||
    receipt.reviewId !== review.id || receipt.requestId !== review.decisionRequestId ||
    receipt.issueId !== issue.id || receipt.interactionId !== card.id ||
    receipt.summary !== review.decisionSummary ||
    card.kind !== "request_confirmation" || card.status !== "accepted" ||
    card.sourceRunId !== review.sourceRunId ||
    card.createdByAgentId !== review.sourceAgentId ||
    card.addresseeAgentId !== run.agentId || card.addresseeUserId !== null ||
    card.continuationPolicy !== "wake_assignee" ||
    card.requestedResolverPolicy !== "not_creator" ||
    card.effectiveResolverPolicy !== "not_creator" ||
    card.resolvedByAgentId !== run.agentId || card.resolvedByRunId !== run.id ||
    target.type !== "custom" || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
    target.revisionId !== review.id ||
    wake.runId !== run.id || wake.agentId !== run.agentId ||
    wake.status !== "claimed" ||
    wake.reason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON ||
    wake.idempotencyKey !== clientPullCompletionReviewWakeKey(review.id, card.id) ||
    wakePayload.issueId !== issue.id || wakePayload.reviewId !== review.id ||
    wakePayload.interactionId !== card.id ||
    wakePayload.sourceRunId !== review.sourceRunId) {
    throw staleReviewEvent();
  }
  return { reviewId: review.id, decisionRequestId: review.decisionRequestId };
}

/** A committed rejection remains valid after the source task is returned. */
export async function assertClientPullRejectedReviewContext(tx: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  issue: typeof issues.$inferSelect;
}) {
  const { run, issue } = input;
  const context = object(run.contextSnapshot);
  if (run.status !== "running" || run.runtimeMode !== "client_pull" ||
    context.wakeReason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON ||
    context.issueId !== issue.id || run.companyId !== issue.companyId ||
    typeof context.reviewId !== "string" ||
    typeof context.interactionId !== "string" ||
    typeof context.sourceRunId !== "string" || !run.wakeupRequestId) {
    throw staleReviewEvent();
  }
  const [review] = await tx.select().from(issueCompletionReviews).where(and(
    eq(issueCompletionReviews.id, context.reviewId),
    eq(issueCompletionReviews.companyId, issue.companyId),
    eq(issueCompletionReviews.issueId, issue.id),
  )).for("update");
  const [card] = await tx.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, context.interactionId),
    eq(issueThreadInteractions.companyId, issue.companyId),
    eq(issueThreadInteractions.issueId, issue.id),
  )).for("update");
  const [reviewWake] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.companyId, issue.companyId),
  )).for("update");
  const receipt = object(review?.decisionReceipt);
  const target = object(object(card?.payload).target);
  const reviewWakePayload = object(reviewWake?.payload);
  if (!review || !card || !reviewWake || review.state !== "rejected" ||
    review.sourceKind !== "client_pull" || review.reviewerAgentId !== run.agentId ||
    review.sourceRunId !== context.sourceRunId ||
    review.clientPullLeaseRunId !== context.sourceRunId ||
    review.interactionId !== card.id || !review.decisionRequestId || !review.decidedAt ||
    receipt.schemaVersion !== 1 || receipt.outcome !== "rejected" ||
    receipt.reviewerRuntimeMode !== "client_pull" || receipt.reviewId !== review.id ||
    receipt.requestId !== review.decisionRequestId || receipt.issueId !== issue.id ||
    receipt.interactionId !== card.id || receipt.summary !== review.decisionSummary ||
    card.kind !== "request_confirmation" || card.status !== "rejected" ||
    card.sourceRunId !== review.sourceRunId ||
    card.createdByAgentId !== review.sourceAgentId ||
    card.addresseeAgentId !== run.agentId || card.addresseeUserId !== null ||
    card.resolvedByAgentId !== run.agentId || card.resolvedByRunId !== run.id ||
    target.type !== "custom" || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
    target.revisionId !== review.id ||
    reviewWake.runId !== run.id || reviewWake.agentId !== run.agentId ||
    reviewWake.status !== "claimed" ||
    reviewWake.reason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON ||
    reviewWake.idempotencyKey !== clientPullCompletionReviewWakeKey(review.id, card.id) ||
    reviewWakePayload.issueId !== issue.id ||
    reviewWakePayload.reviewId !== review.id ||
    reviewWakePayload.interactionId !== card.id ||
    reviewWakePayload.sourceRunId !== review.sourceRunId) {
    throw staleReviewEvent();
  }
  const [sourceWake] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, issue.companyId),
    eq(agentWakeupRequests.idempotencyKey, completionReviewRejectedWakeKey(review.id)),
  )).limit(1);
  const sourcePayload = object(sourceWake?.payload);
  const [sourceRun] = sourceWake?.runId ? await tx.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId, wakeupRequestId: heartbeatRuns.wakeupRequestId,
  }).from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceWake.runId)) : [];
  if (!sourceWake || !sourceRun || sourceWake.id !== receipt.wakeupRequestId ||
    sourceWake.runId !== receipt.sourceRetryRunId ||
    sourceWake.agentId !== review.sourceAgentId ||
    sourceRun.companyId !== issue.companyId ||
    sourceRun.agentId !== review.sourceAgentId ||
    sourceRun.wakeupRequestId !== sourceWake.id ||
    sourcePayload.issueId !== issue.id || sourcePayload.reviewId !== review.id ||
    sourcePayload.interactionId !== card.id ||
    sourcePayload.decisionRequestId !== review.decisionRequestId) {
    throw staleReviewEvent();
  }
  return { reviewId: review.id, decisionRequestId: review.decisionRequestId };
}

function staleReviewEvent() {
  return conflict("Dedicated reviewer run no longer owns an open review");
}
