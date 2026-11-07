import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agentApiKeys, agentWakeupRequests, agents, heartbeatRuns, issueCompletionReviews, issues,
  issueThreadInteractions, localAgentDeviceBindings, localAgentRunLeases,
  localRunWriteReceipts,
} from "@paperclipai/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { badRequest, conflict, forbidden, unprocessable } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { completionReviewRejectedWakeKey, ISSUE_COMPLETION_REVIEW_TARGET_KEY } from "./issue-completion-review-contract.js";
import type { LocalRunOwner } from "./local-agent-run-leases.js";
import { assertClientPullReviewEventContext } from "./local-agent-review-claim.js";
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
  clientPullProof?: {
    owner: LocalRunOwner;
    actor: Express.Request["actor"];
  };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function normalizedRequest(input: DecisionInput, outcome: "accepted" | "rejected" = "accepted") {
  const summary = input.summary.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)
    || summary.length < 1 || summary.length > 4096) {
    throw badRequest("Use a UUID decision request and a 1–4096 character summary");
  }
  const digest = createHash("sha256").update(JSON.stringify([
    `issue_completion_review_${outcome}_v1`, input.reviewId, summary,
  ])).digest("hex");
  return { summary, digest };
}

async function recordLocalReviewDecisionReceipt(tx: Db, input: DecisionInput,
  outcome: "accepted" | "rejected") {
  const owner = input.clientPullProof?.owner;
  if (!owner) return;
  const requestDigest = createHash("sha256").update(JSON.stringify({
    kind: "review_decision", runId: input.actorRunId, issueId: input.issueId,
    agentId: input.actorAgentId, deviceId: owner.deviceId,
    canonicalContent: JSON.stringify({ outcome, summary: input.summary }),
  })).digest("hex");
  await tx.insert(localRunWriteReceipts).values({
    companyId: input.companyId, runId: input.actorRunId, issueId: input.issueId,
    agentId: input.actorAgentId, deviceId: owner.deviceId,
    clientRequestId: input.requestId, kind: "review_decision", requestDigest,
    sourceReceiptId: input.reviewId,
  });
}

async function assertClientPullReviewProof(tx: Db, input: DecisionInput,
  run: { id: string; companyId: string; agentId: string }) {
  const proof = input.clientPullProof;
  if (!proof) throw unprocessable("Client-pull reviewer lease and device proof are required");
  const { owner, actor } = proof;
  if (actor.type !== "agent" || actor.source !== "agent_key" ||
    actor.companyId !== input.companyId || actor.agentId !== input.actorAgentId ||
    actor.keyId !== owner.keyId || (actor.runId && actor.runId !== input.actorRunId)) {
    throw forbidden("An authenticated reviewer agent key is required");
  }
  if (owner.companyId !== input.companyId || owner.agentId !== input.actorAgentId ||
    owner.runId !== input.actorRunId || run.id !== owner.runId ||
    run.companyId !== owner.companyId || run.agentId !== owner.agentId) {
    throw conflict("Reviewer run proof changed; retry after refreshing the review");
  }
  // The issue, review, card and run are already locked. Never wait on a lease
  // or key held by the existing run-first cancellation/finish paths.
  const [lease] = await tx.select().from(localAgentRunLeases)
    .where(eq(localAgentRunLeases.runId, owner.runId))
    .for("update", { skipLocked: true });
  if (!lease || lease.companyId !== owner.companyId || lease.agentId !== owner.agentId ||
    lease.issueId !== input.issueId || lease.deviceId !== owner.deviceId ||
    lease.deviceKeyId !== owner.keyId || lease.leaseId !== owner.leaseId ||
    lease.generation !== owner.generation || lease.cancelRequestedAt || lease.releasedAt) {
    throw conflict("Reviewer lease is unavailable or changing; retry after refreshing the review");
  }
  const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
    .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, owner.runId));
  if (!live?.live) throw conflict("Reviewer lease expired; retry after refreshing the review");
  const [key] = await tx.select({ id: agentApiKeys.id }).from(agentApiKeys).where(and(
    eq(agentApiKeys.id, owner.keyId), eq(agentApiKeys.companyId, owner.companyId),
    eq(agentApiKeys.agentId, owner.agentId), isNull(agentApiKeys.revokedAt),
  )).for("update", { skipLocked: true });
  if (!key) throw conflict("Reviewer device key is unavailable or changing; retry after refreshing the review");
  // Device revocation locks run→lease before changing the binding, so the run
  // lock above makes this nonblocking binding read stable until commit.
  const [binding] = await tx.select({ id: localAgentDeviceBindings.id })
    .from(localAgentDeviceBindings).where(and(
      eq(localAgentDeviceBindings.companyId, owner.companyId),
      eq(localAgentDeviceBindings.agentId, owner.agentId),
      eq(localAgentDeviceBindings.keyId, owner.keyId),
      eq(localAgentDeviceBindings.deviceId, owner.deviceId),
      isNull(localAgentDeviceBindings.revokedAt),
    )).limit(1);
  if (!binding) throw conflict("Reviewer device binding changed; retry after refreshing the review");
}

/** Lease-fenced completion review decisions with atomic task settlement. */
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
          && interaction.resolvedByRunId === input.actorRunId) {
          if (record(review.decisionReceipt).reviewerRuntimeMode === "client_pull") {
            if (!input.clientPullProof) {
              throw unprocessable("Client-pull reviewer lease and device proof are required");
            }
            const [lockedRun] = await tx.select({ id: heartbeatRuns.id,
              companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
              status: heartbeatRuns.status,
            }).from(heartbeatRuns).where(eq(heartbeatRuns.id, input.actorRunId))
              .for("update", { skipLocked: true });
            if (!lockedRun || lockedRun.status !== "running") {
              throw conflict("Reviewer run changed; retry after refreshing the review");
            }
            await assertClientPullReviewProof(tx as unknown as Db, input, lockedRun);
          }
          return review.decisionReceipt;
        }
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
      const [reviewerRun] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.actorRunId))
        // Existing cancel/finish paths lock run before issue. Never wait on
        // that run while holding issue→review→card in the opposite order.
        .for("update", { skipLocked: true });
      const context = record(reviewerRun?.contextSnapshot);
      if (!reviewerRun || reviewerRun.companyId !== input.companyId
        || reviewerRun.agentId !== review.reviewerAgentId || reviewerRun.status !== "running"
        || context.issueId !== input.issueId || context.interactionId !== review.interactionId) {
        throw conflict("Reviewer run is unavailable or changing; retry after refreshing the review");
      }
      if (reviewerRun.runtimeMode === "client_pull")
        await assertClientPullReviewProof(tx as unknown as Db, input, reviewerRun);
      await testHooks.afterReviewerRunLocked?.();

      const decidedAt = new Date();
      const stableReceipt = { schemaVersion: 1, reviewId: review.id,
        requestId: input.requestId, outcome: "accepted", summary: normalized.summary,
        issueId: input.issueId, interactionId: interaction.id,
        ...(reviewerRun.runtimeMode === "client_pull"
          ? { reviewerRuntimeMode: "client_pull" } : {}),
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
      await recordLocalReviewDecisionReceipt(tx as unknown as Db, input, "accepted");
      return stableReceipt;
    });
    for (const publication of publications) publishActivity(publication);
    return receipt;
  }

  async function reject(input: DecisionInput) {
    const normalized = normalizedRequest(input, "rejected");
    const publications: ActivityPublication[] = [];
    const postCommitActions: IssuePostCommitAction[] = [];
    const receipt = await db.transaction(async (tx) => {
      // Claim locks the agent before the issue. Keep the same order when
      // queueing a new run so a simultaneous desktop claim cannot deadlock.
      const [reviewHint] = await tx.select({ sourceAgentId: issueCompletionReviews.sourceAgentId })
        .from(issueCompletionReviews).where(and(
          eq(issueCompletionReviews.companyId, input.companyId),
          eq(issueCompletionReviews.issueId, input.issueId),
          eq(issueCompletionReviews.id, input.reviewId),
        )).limit(1);
      if (!reviewHint) throw conflict("Completion review is missing");
      const [sourceAgent] = await tx.select().from(agents).where(and(
        eq(agents.id, reviewHint.sourceAgentId), eq(agents.companyId, input.companyId),
      )).for("update");
      if (!sourceAgent || sourceAgent.runtimeConfig?.executionMode !== "client_pull" ||
        ["terminated", "pending_approval"].includes(sourceAgent.status)) {
        throw unprocessable("Source agent is not available for a local retry");
      }
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
      )).for("update");
      if (!issue) throw conflict("Review issue no longer belongs to this company");
      const [review] = await tx.select().from(issueCompletionReviews).where(and(
        eq(issueCompletionReviews.companyId, input.companyId),
        eq(issueCompletionReviews.issueId, input.issueId),
        eq(issueCompletionReviews.id, input.reviewId),
      )).for("update");
      if (!review || review.sourceAgentId !== sourceAgent.id ||
        review.reviewerAgentId !== input.actorAgentId ||
        review.sourceKind !== "client_pull" ||
        review.clientPullLeaseRunId !== review.sourceRunId) {
        throw conflict("Review actor or source changed");
      }
      const [card] = await tx.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.id, review.interactionId),
      )).for("update");
      if (!card) throw conflict("Review confirmation card is missing");
      if (review.state !== "pending") {
        const saved = record(review.decisionReceipt);
        if (review.state === "rejected" && review.decisionRequestId === input.requestId &&
          review.decisionRequestDigest === normalized.digest &&
          saved.reviewerRuntimeMode === "client_pull" &&
          card.status === "rejected" && card.resolvedByAgentId === input.actorAgentId &&
          card.resolvedByRunId === input.actorRunId) {
          const [lockedRun] = await tx.select({ id: heartbeatRuns.id,
            companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
          }).from(heartbeatRuns).where(eq(heartbeatRuns.id, input.actorRunId))
            .for("update", { skipLocked: true });
          if (!lockedRun || lockedRun.status !== "running") {
            throw conflict("Reviewer run changed; retry after refreshing the review");
          }
          await assertClientPullReviewProof(tx as unknown as Db, input, lockedRun);
          const [wake] = await tx.select({ id: agentWakeupRequests.id,
            runId: agentWakeupRequests.runId }).from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, input.companyId),
            eq(agentWakeupRequests.idempotencyKey, completionReviewRejectedWakeKey(review.id)),
          )).limit(1);
          if (!wake || wake.id !== saved.wakeupRequestId || wake.runId !== saved.sourceRetryRunId) {
            throw conflict("Source retry receipt changed");
          }
          return review.decisionReceipt;
        }
        throw conflict("Completion review was already decided with different content");
      }
      const payload = record(card.payload);
      const target = record(payload.target);
      if (issue.status !== "in_review" || issue.statusVersion !== review.issueStatusVersion ||
        issue.assigneeAgentId !== sourceAgent.id || issue.executionRunId !== null ||
        card.status !== "pending" || card.kind !== "request_confirmation" ||
        card.effectiveResolverPolicy !== "not_creator" ||
        card.addresseeAgentId !== input.actorAgentId || card.addresseeUserId !== null ||
        card.createdByAgentId !== sourceAgent.id || card.sourceRunId !== review.sourceRunId ||
        target.type !== "custom" || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
        target.revisionId !== review.id || payload.toolAction !== undefined ||
        payload.secretProposal !== undefined) {
        throw conflict("Completion review revision or confirmation card is stale");
      }
      const [reviewerRun] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.actorRunId))
        .for("update", { skipLocked: true });
      const context = record(reviewerRun?.contextSnapshot);
      if (!reviewerRun || reviewerRun.companyId !== input.companyId ||
        reviewerRun.agentId !== input.actorAgentId || reviewerRun.status !== "running" ||
        reviewerRun.runtimeMode !== "client_pull" || context.issueId !== issue.id ||
        context.reviewId !== review.id || context.interactionId !== card.id) {
        throw conflict("Reviewer run is unavailable or changing; retry after refreshing the review");
      }
      await assertClientPullReviewProof(tx as unknown as Db, input, reviewerRun);
      await assertClientPullReviewEventContext(tx as unknown as Db, { run: reviewerRun, issue });
      await testHooks.afterReviewerRunLocked?.();
      const wakeKey = completionReviewRejectedWakeKey(review.id);
      const [oldWake] = await tx.select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.idempotencyKey, wakeKey),
        )).limit(1);
      if (oldWake) throw conflict("Source retry wake key is already occupied");

      const decidedAt = new Date();
      const wakeId = randomUUID(), runId = randomUUID();
      const [savedReview] = await tx.update(issueCompletionReviews).set({
        state: "rejected", decidedAt, decisionRequestId: input.requestId,
        decisionRequestDigest: normalized.digest, decisionSummary: normalized.summary,
        decisionReceipt: { schemaVersion: 1, reviewId: review.id,
          requestId: input.requestId, outcome: "rejected", summary: normalized.summary,
          issueId: issue.id, interactionId: card.id, reviewerRuntimeMode: "client_pull",
          wakeupRequestId: wakeId, sourceRetryRunId: runId,
          decidedAt: decidedAt.toISOString() },
      }).where(and(eq(issueCompletionReviews.id, review.id),
        eq(issueCompletionReviews.state, "pending"))).returning();
      if (!savedReview) throw conflict("Completion review changed during decision");
      const [savedCard] = await tx.update(issueThreadInteractions).set({
        status: "rejected", result: { version: 1, outcome: "rejected" },
        resolvedByAgentId: input.actorAgentId, resolvedByRunId: input.actorRunId,
        resolvedAt: decidedAt, updatedAt: decidedAt,
      }).where(and(eq(issueThreadInteractions.id, card.id),
        eq(issueThreadInteractions.status, "pending"))).returning();
      if (!savedCard) throw conflict("Confirmation card changed during decision");
      const updated = await issueService(db).update(issue.id, {
        companyGuard: input.companyId, status: "todo", actorAgentId: input.actorAgentId,
      }, tx, publications, postCommitActions);
      if (!updated || updated.status !== "todo" || updated.assigneeAgentId !== sourceAgent.id) {
        throw conflict("Rejected task did not return to the source agent");
      }
      // The ordinary status transition increments this fencing version. Do
      // not count the same rejection twice or overwrite a human revision.
      if (updated.statusVersion !== review.issueStatusVersion + 1) {
        throw conflict("Rejected task version changed");
      }
      const comment = await issueService(db).addComment(issue.id,
        `验收未通过：${normalized.summary}`,
        { agentId: input.actorAgentId, runId: input.actorRunId },
        { clientRequestId: input.requestId, authorizationReason: "completion_review_rejected" }, tx);
      const wakePayload = { issueId: issue.id, reviewId: review.id,
        interactionId: card.id, decisionRequestId: input.requestId,
        reviewCommentId: comment.id, issueStatusVersion: updated.statusVersion };
      const [wake] = await tx.insert(agentWakeupRequests).values({
        id: wakeId, companyId: input.companyId, agentId: sourceAgent.id,
        source: "automation", triggerDetail: "system",
        reason: "issue_completion_review_rejected", payload: wakePayload,
        status: "queued", idempotencyKey: wakeKey,
        requestedByActorType: "agent", requestedByActorId: input.actorAgentId,
      }).returning();
      const [sourceRun] = await tx.insert(heartbeatRuns).values({
        id: runId, companyId: input.companyId, agentId: sourceAgent.id,
        invocationSource: "automation", triggerDetail: "system",
        status: "queued", runtimeMode: "client_pull", wakeupRequestId: wake.id,
        responsibleUserId: reviewerRun.contextSnapshot?.responsibleUserId as string | undefined,
        contextSnapshot: { ...wakePayload, taskId: issue.id,
          wakeReason: "issue_completion_review_rejected",
          source: "issue.completion_review.rejected", forceFreshSession: true },
      }).returning();
      await tx.update(agentWakeupRequests).set({ runId: sourceRun.id,
        updatedAt: sql`now()` }).where(eq(agentWakeupRequests.id, wake.id));
      await logActivity(tx as unknown as Db, {
        companyId: input.companyId, actorType: "agent", actorId: input.actorAgentId,
        agentId: input.actorAgentId, runId: input.actorRunId,
        action: "issue.completion_review_rejected", entityType: "issue",
        entityId: issue.id, issueId: issue.id,
        details: { reviewId: review.id, interactionId: card.id,
          requestId: input.requestId, commentId: comment.id,
          sourceRetryRunId: sourceRun.id },
      }, publications);
      if (postCommitActions.length > 0) {
        throw unprocessable("Completion review requires an unsupported post-commit action");
      }
      await recordLocalReviewDecisionReceipt(tx as unknown as Db, input, "rejected");
      return savedReview.decisionReceipt;
    });
    for (const publication of publications) publishActivity(publication);
    return receipt;
  }

  return { accept, reject };
}
