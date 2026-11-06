import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns, issueCompletionReviews, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { and, eq, ne } from "drizzle-orm";
import { badRequest, conflict, unprocessable } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { ISSUE_COMPLETION_REVIEW_TARGET_KEY } from "./issue-completion-review-contract.js";
import {
  issueService, type IssuePostCommitAction,
} from "./issues.js";

type DecisionInput = {
  companyId: string;
  issueId: string;
  reviewId: string;
  actorAgentId: string;
  actorRunId: string;
  requestId: string;
  summary: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function normalizedRequest(input: DecisionInput) {
  const summary = input.summary.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)
    || summary.length < 1 || summary.length > 4096) {
    throw badRequest("Use a UUID decision request and a 1–4096 character summary");
  }
  const digest = createHash("sha256").update(JSON.stringify([
    "issue_completion_review_accept_v1", input.reviewId, summary,
  ])).digest("hex");
  return { summary, digest };
}

/**
 * Inert internal command. No route or worker calls this until reviewer-run
 * authentication, dependency release, and the rejection outbox are verified.
 */
export function issueCompletionReviewDecisionService(db: Db, testHooks: {
  afterReviewerRunLocked?: () => Promise<void>;
} = {}) {
  async function accept(input: DecisionInput) {
    const normalized = normalizedRequest(input);
    const publications: ActivityPublication[] = [];
    const postCommitActions: IssuePostCommitAction[] = [];
    const receipt = await db.transaction(async (tx) => {
      // Serializes terminal cancellation and other reviewers before touching
      // the review or confirmation card.
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
      )).for("update");
      if (!issue) throw conflict("Review issue no longer belongs to this company");
      const [review] = await tx.select().from(issueCompletionReviews).where(and(
        eq(issueCompletionReviews.companyId, input.companyId),
        eq(issueCompletionReviews.issueId, input.issueId),
        eq(issueCompletionReviews.id, input.reviewId),
      )).for("update");
      if (!review || review.reviewerAgentId !== input.actorAgentId) {
        throw conflict("Review actor or scope changed");
      }
      const [interaction] = await tx.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.id, review.interactionId),
      )).for("update");
      if (!interaction) throw conflict("Review confirmation card is missing");
      if (review.state !== "pending") {
        if (review.state === "accepted" && review.decisionRequestId === input.requestId
          && review.decisionRequestDigest === normalized.digest
          && review.decisionReceipt && interaction.status === "accepted"
          && interaction.resolvedByAgentId === input.actorAgentId
          && interaction.resolvedByRunId === input.actorRunId) return review.decisionReceipt;
        throw conflict("Completion review was already decided with different content");
      }
      const payload = record(interaction?.payload);
      const target = record(payload.target);
      if (issue.status !== "in_review" || issue.statusVersion !== review.issueStatusVersion
        || issue.assigneeAgentId !== review.sourceAgentId
        || !interaction || interaction.status !== "pending"
        || interaction.kind !== "request_confirmation"
        || interaction.effectiveResolverPolicy !== "not_creator"
        || interaction.addresseeAgentId !== review.reviewerAgentId
        || interaction.addresseeUserId !== null
        || interaction.createdByAgentId !== review.sourceAgentId
        || interaction.sourceRunId !== review.sourceRunId
        || target.type !== "custom" || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY
        || target.revisionId !== review.id || payload.toolAction !== undefined
        || payload.secretProposal !== undefined) {
        throw conflict("Completion review revision or confirmation card is stale");
      }
      const [reviewerRun] = await tx.select({ id: heartbeatRuns.id,
        status: heartbeatRuns.status, companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId, runtimeMode: heartbeatRuns.runtimeMode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      }).from(heartbeatRuns).where(eq(heartbeatRuns.id, input.actorRunId))
        // Existing cancel/finish paths lock run before issue. Never wait on
        // that run while holding issue→review→card in the opposite order.
        .for("update", { skipLocked: true });
      const context = record(reviewerRun?.contextSnapshot);
      if (!reviewerRun || reviewerRun.companyId !== input.companyId
        || reviewerRun.agentId !== review.reviewerAgentId || reviewerRun.status !== "running"
        || context.issueId !== input.issueId || context.interactionId !== review.interactionId) {
        throw conflict("Reviewer run is unavailable or changing; retry after refreshing the review");
      }
      if (reviewerRun.runtimeMode === "client_pull") {
        throw unprocessable("Client-pull reviewer lease and device proof are not connected to this command");
      }
      await testHooks.afterReviewerRunLocked?.();

      const decidedAt = new Date();
      const stableReceipt = { schemaVersion: 1, reviewId: review.id,
        requestId: input.requestId, outcome: "accepted", summary: normalized.summary,
        issueId: input.issueId, interactionId: interaction.id,
        decidedAt: decidedAt.toISOString() };
      const [acceptedReview] = await tx.update(issueCompletionReviews).set({
        state: "accepted", decidedAt, decisionRequestId: input.requestId,
        decisionRequestDigest: normalized.digest, decisionSummary: normalized.summary,
        decisionReceipt: stableReceipt,
      }).where(and(eq(issueCompletionReviews.id, review.id),
        eq(issueCompletionReviews.state, "pending"))).returning({ id: issueCompletionReviews.id });
      if (!acceptedReview) throw conflict("Completion review changed during decision");
      const [acceptedCard] = await tx.update(issueThreadInteractions).set({
        status: "accepted", result: { version: 1, outcome: "accepted" },
        resolvedByAgentId: input.actorAgentId, resolvedByRunId: input.actorRunId,
        resolvedAt: decidedAt, updatedAt: decidedAt,
      }).where(and(eq(issueThreadInteractions.id, interaction.id),
        eq(issueThreadInteractions.status, "pending"))).returning({ id: issueThreadInteractions.id });
      if (!acceptedCard) throw conflict("Confirmation card changed during decision");

      const [otherCard] = await tx.select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.issueId, input.issueId),
          eq(issueThreadInteractions.status, "pending"),
          ne(issueThreadInteractions.id, interaction.id),
        )).limit(1);
      const [otherReview] = await tx.select({ id: issueCompletionReviews.id })
        .from(issueCompletionReviews).where(and(
          eq(issueCompletionReviews.companyId, input.companyId),
          eq(issueCompletionReviews.issueId, input.issueId),
          eq(issueCompletionReviews.state, "pending"),
          ne(issueCompletionReviews.id, review.id),
        )).limit(1);
      if (!otherCard && !otherReview) {
        const completed = await issueService(db).update(input.issueId, {
          companyGuard: input.companyId, status: "done", actorAgentId: input.actorAgentId,
        }, tx, publications, postCommitActions);
        if (!completed || completed.status !== "done") {
          throw conflict("Issue completion did not commit with the review");
        }
      }
      await logActivity(tx as unknown as Db, {
        companyId: input.companyId, actorType: "agent", actorId: input.actorAgentId,
        agentId: input.actorAgentId, runId: input.actorRunId,
        action: "issue.completion_review_accepted", entityType: "issue",
        entityId: input.issueId, issueId: input.issueId,
        details: { reviewId: review.id, interactionId: interaction.id,
          requestId: input.requestId },
      }, publications);
      // No external post-commit work is recoverable from this inert command.
      // A future outbox must own that path before the command can support it.
      if (postCommitActions.length > 0) {
        throw unprocessable("Completion review requires an unsupported post-commit action");
      }
      return stableReceipt;
    });
    for (const publication of publications) publishActivity(publication);
    return receipt;
  }

  async function reject(_input: DecisionInput): Promise<never> {
    throw unprocessable("Review rejection requires a durable source-agent notification outbox");
  }

  return { accept, reject };
}
