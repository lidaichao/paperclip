import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests, agents, heartbeatRuns, issueCompletionReviews,
  issues, issueThreadInteractions, localAgentRunLeases,
} from "@paperclipai/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { conflict } from "../errors.js";
import { ISSUE_COMPLETION_REVIEW_TARGET_KEY } from "./issue-completion-review-contract.js";

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
