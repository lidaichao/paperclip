import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests, agents, companies, heartbeatRuns, issueCommandDeliveries,
  issueCompletionReviews, issues, issueThreadInteractions, localAgentRunLeases,
} from "@paperclipai/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { HttpError, conflict, notFound } from "../errors.js";
import { ISSUE_COMPLETION_REVIEW_TARGET_KEY } from "./issue-completion-review-contract.js";
import { CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON,
  clientPullCompletionReviewWakeKey } from "./local-agent-review-claim.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/**
 * Dedicated producer. The bounded execution-control sweep calls sweepReady();
 * the wake receipt and queued client-pull run commit with the intent. This
 * service never launches a model process on the control-plane server.
 */
export function localAgentReviewDeliveryService(db: Db) {
  async function deliver(id: string) {
    const [scope] = await db.select({ companyId: issueCommandDeliveries.companyId,
      issueId: issueCommandDeliveries.issueId,
      targetAgentId: issueCommandDeliveries.targetAgentId,
    }).from(issueCommandDeliveries).where(eq(issueCommandDeliveries.id, id));
    if (!scope) throw notFound("Dedicated review delivery not found");
    return db.transaction(async (tx) => {
      // Align with local claim's agent-first ordering. Issue status changes
      // take issue->delivery->review->card and never lock reviewer agent.
      const [agent] = await tx.select().from(agents).where(and(
        eq(agents.id, scope.targetAgentId), eq(agents.companyId, scope.companyId),
      )).for("update");
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, scope.issueId), eq(issues.companyId, scope.companyId),
      )).for("update");
      const [intent] = await tx.select().from(issueCommandDeliveries).where(and(
        eq(issueCommandDeliveries.id, id), eq(issueCommandDeliveries.companyId, scope.companyId),
      )).for("update");
      if (!agent || !issue || !intent || intent.targetAgentId !== agent.id ||
        intent.issueId !== issue.id || intent.kind !== "completion_review" || !intent.reviewId) {
        throw conflict("Dedicated review delivery scope changed");
      }
      const [review] = await tx.select().from(issueCompletionReviews).where(and(
        eq(issueCompletionReviews.id, intent.reviewId),
        eq(issueCompletionReviews.companyId, intent.companyId),
        eq(issueCompletionReviews.issueId, intent.issueId),
      )).for("update");
      const [card] = await tx.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.id, intent.interactionId),
        eq(issueThreadInteractions.companyId, intent.companyId),
        eq(issueThreadInteractions.issueId, intent.issueId),
      )).for("update");
      const target = object(object(card?.payload).target);
      if (!review || !card || review.interactionId !== card.id ||
        review.sourceKind !== "client_pull" ||
        review.clientPullLeaseRunId !== review.sourceRunId ||
        review.sourceRunId !== intent.sourceRunId ||
        review.reviewerAgentId !== agent.id ||
        card.kind !== "request_confirmation" ||
        card.sourceRunId !== review.sourceRunId ||
        card.createdByAgentId !== review.sourceAgentId ||
        card.addresseeAgentId !== agent.id || card.addresseeUserId !== null ||
        card.continuationPolicy !== "wake_assignee" ||
        card.requestedResolverPolicy !== "not_creator" ||
        card.effectiveResolverPolicy !== "not_creator" ||
        target.type !== "custom" || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
        target.revisionId !== review.id) {
        throw conflict("Dedicated review card or revision changed");
      }
      const wakeKey = clientPullCompletionReviewWakeKey(review.id, card.id);
      if (intent.status === "delivered") {
        const [wake] = await tx.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.id, intent.wakeupRequestId!),
          eq(agentWakeupRequests.companyId, intent.companyId),
        ));
        const [run] = wake?.runId ? await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, wake.runId), eq(heartbeatRuns.companyId, intent.companyId),
        )) : [];
        const payload = object(wake?.payload);
        const context = object(run?.contextSnapshot);
        if (!wake || !run || wake.idempotencyKey !== wakeKey ||
          wake.agentId !== agent.id || wake.source !== "automation" ||
          wake.triggerDetail !== "system" ||
          wake.reason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON ||
          wake.requestedByActorType !== "agent" ||
          wake.requestedByActorId !== review.sourceAgentId ||
          payload.issueId !== issue.id || payload.reviewId !== review.id ||
          payload.interactionId !== card.id || payload.sourceRunId !== review.sourceRunId ||
          run.agentId !== agent.id || run.wakeupRequestId !== wake.id ||
          run.runtimeMode !== "client_pull" ||
          context.issueId !== issue.id || context.reviewId !== review.id ||
          context.interactionId !== card.id || context.sourceRunId !== review.sourceRunId ||
          context.wakeReason !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON) {
          throw conflict("Dedicated review wake receipt changed");
        }
        return { delivery: intent, wake, run, replayed: true };
      }
      const [due] = await tx.select({ due: sql<boolean>`${issueCommandDeliveries.nextAttemptAt} <= now()` })
        .from(issueCommandDeliveries).where(eq(issueCommandDeliveries.id, intent.id));
      if (intent.status !== "ready" || !due?.due ||
        review.state !== "pending" || card.status !== "pending" ||
        issue.status !== "in_review" ||
        issue.statusVersion !== review.issueStatusVersion ||
        issue.assigneeAgentId !== review.sourceAgentId || issue.executionRunId !== null ||
        agent.runtimeConfig?.executionMode !== "client_pull" ||
        ["terminated", "pending_approval", "paused"].includes(agent.status) || agent.pausedAt) {
        throw conflict("Dedicated review is not ready for a local reviewer wake");
      }
      const [company] = await tx.select({ status: companies.status }).from(companies)
        .where(eq(companies.id, intent.companyId));
      const [sourceRun] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, review.sourceRunId),
        eq(heartbeatRuns.companyId, intent.companyId),
      ));
      const [sourceLease] = await tx.select().from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.runId, review.sourceRunId),
        eq(localAgentRunLeases.companyId, intent.companyId),
      ));
      const sourceReceipt = object(sourceRun?.resultJson?.localWorkerFinish);
      if (!company || company.status !== "active" ||
        !sourceRun || sourceRun.status !== "succeeded" ||
        sourceRun.agentId !== review.sourceAgentId ||
        sourceRun.runtimeMode !== "client_pull" ||
        !sourceLease || sourceLease.issueId !== issue.id ||
        sourceLease.agentId !== review.sourceAgentId ||
        !sourceLease.releasedAt || !sourceLease.stopAcknowledgedAt ||
        sourceLease.outcome !== "succeeded" ||
        sourceReceipt.disposition !== "ready" ||
        sourceReceipt.reviewId !== review.id ||
        sourceReceipt.deliveryId !== intent.id ||
        sourceReceipt.issueStatus !== "in_review" ||
        sourceReceipt.issueStatusVersion !== review.issueStatusVersion) {
        throw conflict("Source run has not committed the exact review handoff");
      }
      const [priorWake] = await tx.select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, intent.companyId),
          eq(agentWakeupRequests.idempotencyKey, wakeKey),
        )).limit(1);
      if (priorWake) throw conflict("Dedicated review wake key is already occupied");

      const wakeId = randomUUID();
      const runId = randomUUID();
      const wakePayload = { issueId: issue.id, interactionId: card.id,
        reviewId: review.id, sourceRunId: review.sourceRunId };
      const [wake] = await tx.insert(agentWakeupRequests).values({
        id: wakeId, companyId: intent.companyId, agentId: agent.id,
        source: "automation", triggerDetail: "system",
        reason: CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON,
        payload: wakePayload, status: "queued", idempotencyKey: wakeKey,
        requestedByActorType: "agent", requestedByActorId: review.sourceAgentId,
      }).returning();
      const [run] = await tx.insert(heartbeatRuns).values({
        id: runId, companyId: intent.companyId, agentId: agent.id,
        invocationSource: "automation", triggerDetail: "system",
        status: "queued", runtimeMode: "client_pull",
        responsibleUserId: sourceRun.responsibleUserId,
        wakeupRequestId: wake.id,
        contextSnapshot: { ...wakePayload,
          taskId: issue.id,
          wakeReason: CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON,
          source: "issue.completion_review", forceFreshSession: true },
      }).returning();
      await tx.update(agentWakeupRequests).set({ runId: run.id, updatedAt: sql`now()` })
        .where(eq(agentWakeupRequests.id, wake.id));
      const [delivered] = await tx.update(issueCommandDeliveries).set({
        status: "delivered", wakeupRequestId: wake.id,
        deliveredAt: sql`now()`, updatedAt: sql`now()`,
      }).where(and(eq(issueCommandDeliveries.id, intent.id),
        eq(issueCommandDeliveries.status, "ready"))).returning();
      if (!delivered) throw conflict("Dedicated review intent changed before queue commit");
      return { delivery: delivered, wake: { ...wake, runId: run.id }, run, replayed: false };
    });
  }

  /** Dispatch only source-finished reviews; the transaction in deliver owns deduplication. */
  async function sweepReady(limit = 50): Promise<{ scanned: number; delivered: number; deferred: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid review sweep limit");
    const candidates = await db.select({ id: issueCommandDeliveries.id })
      .from(issueCommandDeliveries).where(and(
        eq(issueCommandDeliveries.kind, "completion_review"),
        eq(issueCommandDeliveries.status, "ready"),
        lte(issueCommandDeliveries.nextAttemptAt, sql`now()`),
      )).orderBy(asc(issueCommandDeliveries.nextAttemptAt), asc(issueCommandDeliveries.id))
      .limit(limit);
    let delivered = 0;
    let deferred = 0;
    for (const candidate of candidates) {
      try {
        const result = await deliver(candidate.id);
        if (!result.replayed) delivered++;
      } catch (error) {
        if (!(error instanceof HttpError) || ![404, 409].includes(error.status)) throw error;
        // A concurrent dispatcher may have committed first. Stale or temporarily
        // ineligible reviews back off without blocking later ready deliveries.
        await db.update(issueCommandDeliveries).set({
          nextAttemptAt: sql`now() + interval '1 minute'`,
          attempts: sql`${issueCommandDeliveries.attempts} + 1`,
          lastError: error.message.slice(0, 300), updatedAt: sql`now()`,
        }).where(and(eq(issueCommandDeliveries.id, candidate.id),
          eq(issueCommandDeliveries.status, "ready")));
        deferred++;
      }
    }
    return { scanned: candidates.length, delivered, deferred };
  }
  return { deliver, sweepReady };
}
