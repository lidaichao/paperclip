import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests, issueCommandDeliveries, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../errors.js";

type Delivery = typeof issueCommandDeliveries.$inferSelect;
type Scope = { companyId: string; issueId: string; interactionId: string; sourceRunId: string };
type Claim = { delivery: Delivery; claimToken: string; creatorAgentId: string;
  sourceCommentId: string | null };

const acceptedWakeStatuses = ["queued", "claimed", "coalesced", "completed"];
const errorCodePattern = /^[a-z][a-z0-9_:-]{0,79}$/;

export function interactionWakeKey(interactionId: string) {
  // The existing agent_wakeup_requests interaction:% partial unique index
  // prevents two active receipts for this key across worker processes.
  return `interaction:${interactionId}:pending`;
}

/** Inert, transaction-friendly state machine. No worker, route or timer invokes it yet. */
export function issueCommandDeliveryService(db: Db) {
  async function assertCurrentInteraction(tx: Db, input: Scope & { targetAgentId: string },
    expectedIssueStatus: "in_progress" | "in_review") {
    const [issue] = await tx.select({ status: issues.status }).from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
    )).for("update");
    const [interaction] = await tx.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.id, input.interactionId),
    )).for("update");
    if (!issue || issue.status !== expectedIssueStatus || !interaction ||
      interaction.kind !== "request_confirmation" || interaction.status !== "pending" ||
      interaction.sourceRunId !== input.sourceRunId ||
      interaction.addresseeAgentId !== input.targetAgentId ||
      !interaction.createdByAgentId || interaction.createdByAgentId === input.targetAgentId) {
      throw conflict("Review delivery no longer matches a pending named-agent interaction");
    }
    return interaction;
  }

  /** Caller owns the run→lease→issue write fence and transaction. */
  async function enqueue(tx: Db, input: Scope & { targetAgentId: string }) {
    await assertCurrentInteraction(tx, input, "in_progress");
    const [existing] = await tx.select().from(issueCommandDeliveries).where(and(
      eq(issueCommandDeliveries.companyId, input.companyId),
      eq(issueCommandDeliveries.interactionId, input.interactionId),
      eq(issueCommandDeliveries.kind, "interaction_pending"),
    )).for("update");
    if (existing) {
      if (existing.issueId !== input.issueId || existing.sourceRunId !== input.sourceRunId ||
        existing.targetAgentId !== input.targetAgentId) {
        throw conflict("Review delivery identity differs from the committed intent");
      }
      return existing;
    }
    const [created] = await tx.insert(issueCommandDeliveries).values({
      ...input, kind: "interaction_pending", status: "awaiting_handoff",
    }).returning();
    return created;
  }

  /** Called only inside the same fenced transaction that commits the review handoff. */
  async function ready(tx: Db, input: Scope) {
    const [snapshot] = await tx.select().from(issueCommandDeliveries).where(and(
      eq(issueCommandDeliveries.companyId, input.companyId),
      eq(issueCommandDeliveries.interactionId, input.interactionId),
      eq(issueCommandDeliveries.kind, "interaction_pending"),
    ));
    if (!snapshot || snapshot.issueId !== input.issueId || snapshot.sourceRunId !== input.sourceRunId) {
      throw notFound("Review delivery intent not found");
    }
    await assertCurrentInteraction(tx, { ...input, targetAgentId: snapshot.targetAgentId }, "in_review");
    const [intent] = await tx.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, snapshot.id)).for("update");
    if (!intent || intent.targetAgentId !== snapshot.targetAgentId) throw conflict("Review delivery changed");
    if (intent.status === "ready") return intent;
    if (intent.status !== "awaiting_handoff") throw conflict("Review delivery cannot enter ready twice");
    const [updated] = await tx.update(issueCommandDeliveries)
      .set({ status: "ready", nextAttemptAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(issueCommandDeliveries.id, intent.id)).returning();
    return updated;
  }

  function wakeupRequest(claim: Claim) {
    return {
      agentId: claim.delivery.targetAgentId,
      options: {
        source: "automation" as const,
        triggerDetail: "system" as const,
        reason: "interaction_pending",
        payload: {
          issueId: claim.delivery.issueId,
          interactionId: claim.delivery.interactionId,
          interactionKind: "request_confirmation",
          sourceCommentId: claim.sourceCommentId,
          sourceRunId: claim.delivery.sourceRunId,
          mutation: "interaction",
        },
        idempotencyKey: interactionWakeKey(claim.delivery.interactionId),
        requestedByActorType: "agent" as const,
        requestedByActorId: claim.creatorAgentId,
        contextSnapshot: {
          issueId: claim.delivery.issueId,
          taskId: claim.delivery.issueId,
          interactionId: claim.delivery.interactionId,
          interactionKind: "request_confirmation",
          sourceCommentId: claim.sourceCommentId,
          sourceRunId: claim.delivery.sourceRunId,
          wakeReason: "interaction_pending",
          source: "issue.interaction.created",
        },
      },
    };
  }

  async function acceptedReceipt(tx: Db, intent: Delivery, receiptId?: string) {
    const [interaction] = await tx.select({ createdByAgentId: issueThreadInteractions.createdByAgentId,
      sourceCommentId: issueThreadInteractions.sourceCommentId })
      .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, intent.interactionId));
    if (!interaction?.createdByAgentId) throw conflict("Review interaction creator is unavailable");
    const receipts = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, intent.companyId),
      eq(agentWakeupRequests.idempotencyKey, interactionWakeKey(intent.interactionId)),
      receiptId ? eq(agentWakeupRequests.id, receiptId) : undefined,
    ));
    for (const receipt of receipts) {
      if (receipt.agentId !== intent.targetAgentId || receipt.source !== "automation" ||
        receipt.triggerDetail !== "system" || receipt.reason !== "interaction_pending" ||
        receipt.requestedByActorType !== "agent" ||
        receipt.requestedByActorId !== interaction.createdByAgentId ||
        receipt.payload?.issueId !== intent.issueId ||
        receipt.payload?.interactionId !== intent.interactionId ||
        receipt.payload?.interactionKind !== "request_confirmation" ||
        (receipt.payload?.sourceCommentId ?? null) !== interaction.sourceCommentId ||
        receipt.payload?.sourceRunId !== intent.sourceRunId) {
        throw conflict("Wake receipt does not match the review delivery");
      }
    }
    return {
      accepted: receipts.find((receipt) => acceptedWakeStatuses.includes(receipt.status)) ?? null,
      unresolved: receipts.some((receipt) => !acceptedWakeStatuses.includes(receipt.status) &&
        !["skipped", "failed", "cancelled"].includes(receipt.status)),
    };
  }

  async function claim(input: { companyId?: string; leaseMs?: number } = {}): Promise<Claim | null> {
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw badRequest("Delivery claim lease must be 1–300 seconds");
    }
    let cursor: { nextAttemptAt: Date; id: string } | null = null;
    for (;;) {
      const page = await db.select({ id: issueCommandDeliveries.id,
        companyId: issueCommandDeliveries.companyId, issueId: issueCommandDeliveries.issueId,
        nextAttemptAt: issueCommandDeliveries.nextAttemptAt })
        .from(issueCommandDeliveries).where(and(
          input.companyId ? eq(issueCommandDeliveries.companyId, input.companyId) : undefined,
          inArray(issueCommandDeliveries.status, ["ready", "deferred"]),
          lte(issueCommandDeliveries.nextAttemptAt, sql`now()`),
          cursor ? or(gt(issueCommandDeliveries.nextAttemptAt, cursor.nextAttemptAt),
            and(eq(issueCommandDeliveries.nextAttemptAt, cursor.nextAttemptAt),
              gt(issueCommandDeliveries.id, cursor.id))) : undefined,
        )).orderBy(asc(issueCommandDeliveries.nextAttemptAt), asc(issueCommandDeliveries.id)).limit(50);
      if (page.length === 0) return null;
      for (const candidate of page) {
      const result = await db.transaction(async (tx) => {
        // Issue first, then delivery: the same lock order as handoff/cancel.
        const [issue] = await tx.select({ status: issues.status }).from(issues)
          .where(and(eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.issueId)))
          .for("update", { skipLocked: true });
        if (!issue) return null;
        const [intent] = await tx.select().from(issueCommandDeliveries)
          .where(eq(issueCommandDeliveries.id, candidate.id))
          .for("update", { skipLocked: true });
        if (!intent || !["ready", "deferred"].includes(intent.status)) return null;
        const [due] = await tx.select({ due: sql<boolean>`${issueCommandDeliveries.nextAttemptAt} <= now()` })
          .from(issueCommandDeliveries).where(eq(issueCommandDeliveries.id, intent.id));
        if (!due?.due) return null;
        const [interaction] = await tx.select().from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, intent.interactionId));
        if (issue.status !== "in_review" || interaction?.companyId !== intent.companyId ||
          interaction.issueId !== intent.issueId || interaction.kind !== "request_confirmation" ||
          interaction.status !== "pending" || !interaction.createdByAgentId ||
          interaction.createdByAgentId === intent.targetAgentId ||
          interaction.addresseeAgentId !== intent.targetAgentId ||
          interaction.sourceRunId !== intent.sourceRunId) {
          await tx.update(issueCommandDeliveries).set({ status: "cancelled", updatedAt: sql`now()` })
            .where(eq(issueCommandDeliveries.id, intent.id));
          return null;
        }
        const receipts = await acceptedReceipt(tx as unknown as Db, intent);
        if (receipts.accepted) {
          await tx.update(issueCommandDeliveries).set({ status: "delivered",
            wakeupRequestId: receipts.accepted.id, deliveredAt: sql`now()`,
            lastError: null, updatedAt: sql`now()` }).where(eq(issueCommandDeliveries.id, intent.id));
          return null;
        }
        if (receipts.unresolved) {
          await tx.update(issueCommandDeliveries).set({ status: "deferred",
            nextAttemptAt: sql`now() + interval '1 minute'`, updatedAt: sql`now()` })
            .where(eq(issueCommandDeliveries.id, intent.id));
          return null;
        }
        const claimToken = randomUUID();
        const [delivery] = await tx.update(issueCommandDeliveries).set({
          status: "claimed", claimToken, claimedAt: sql`now()`,
          claimExpiresAt: sql`now() + ${leaseMs} * interval '1 millisecond'`,
          attempts: sql`${issueCommandDeliveries.attempts} + 1`, updatedAt: sql`now()`,
        }).where(eq(issueCommandDeliveries.id, intent.id)).returning();
        return { delivery, claimToken, creatorAgentId: interaction.createdByAgentId!,
          sourceCommentId: interaction.sourceCommentId };
      });
      if (result) return result;
      }
      cursor = page.at(-1)!;
    }
  }

  async function lockedLiveClaim(tx: Db, input: { id: string; claimToken: string }) {
    const [intent] = await tx.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, input.id)).for("update");
    const [live] = intent ? await tx.select({ live: sql<boolean>`
      ${issueCommandDeliveries.claimExpiresAt} > now()` }).from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, intent.id)) : [];
    if (!intent || intent.status !== "claimed" || intent.claimToken !== input.claimToken || !live?.live) {
      throw conflict("Review delivery claim is stale");
    }
    return intent;
  }

  async function ack(input: { id: string; claimToken: string; wakeupRequestId: string }) {
    return db.transaction(async (tx) => {
      const intent = await lockedLiveClaim(tx as unknown as Db, input);
      const receipt = (await acceptedReceipt(tx as unknown as Db, intent, input.wakeupRequestId)).accepted;
      if (!receipt) throw conflict("Wake receipt has not been accepted");
      const [updated] = await tx.update(issueCommandDeliveries).set({
        status: "delivered", wakeupRequestId: receipt.id, deliveredAt: sql`now()`,
        claimToken: null, claimExpiresAt: null, lastError: null, updatedAt: sql`now()`,
      }).where(eq(issueCommandDeliveries.id, intent.id)).returning();
      return updated;
    });
  }

  async function defer(input: { id: string; claimToken: string; errorCode: string; delayMs: number }) {
    if (!errorCodePattern.test(input.errorCode) || !Number.isSafeInteger(input.delayMs) ||
      input.delayMs < 1_000 || input.delayMs > 3_600_000) {
      throw badRequest("Use a safe error code and a 1–3600 second retry delay");
    }
    return db.transaction(async (tx) => {
      const intent = await lockedLiveClaim(tx as unknown as Db, input);
      const [updated] = await tx.update(issueCommandDeliveries).set({
        status: "deferred", claimToken: null, claimExpiresAt: null,
        nextAttemptAt: sql`now() + ${input.delayMs} * interval '1 millisecond'`,
        lastError: input.errorCode, updatedAt: sql`now()`,
      }).where(eq(issueCommandDeliveries.id, intent.id)).returning();
      return updated;
    });
  }

  /** Caller holds the issue lock; delivered wakes are historical facts and cannot be unsent. */
  async function cancel(tx: Db, input: { companyId: string; interactionId: string }) {
    const [intent] = await tx.select().from(issueCommandDeliveries).where(and(
      eq(issueCommandDeliveries.companyId, input.companyId),
      eq(issueCommandDeliveries.interactionId, input.interactionId),
      eq(issueCommandDeliveries.kind, "interaction_pending"),
    )).for("update");
    if (!intent || ["cancelled", "delivered"].includes(intent.status)) return intent ?? null;
    const [updated] = await tx.update(issueCommandDeliveries).set({
      status: "cancelled", claimToken: null, claimExpiresAt: null, updatedAt: sql`now()`,
    }).where(eq(issueCommandDeliveries.id, intent.id)).returning();
    return updated;
  }

  /** Recover one expired claim after a process crash, before any new dispatch. */
  async function recover(id: string) {
    const [scope] = await db.select({ companyId: issueCommandDeliveries.companyId,
      issueId: issueCommandDeliveries.issueId }).from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, id));
    if (!scope) return null;
    return db.transaction(async (tx) => {
      const [issue] = await tx.select({ status: issues.status }).from(issues).where(and(
        eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId),
      )).for("update");
      const [intent] = await tx.select().from(issueCommandDeliveries)
        .where(eq(issueCommandDeliveries.id, id)).for("update");
      const [expired] = intent ? await tx.select({ expired: sql<boolean>`
        ${issueCommandDeliveries.claimExpiresAt} <= now()` }).from(issueCommandDeliveries)
        .where(eq(issueCommandDeliveries.id, id)) : [];
      if (!intent || intent.status !== "claimed" || !expired?.expired) return intent ?? null;
      const receipts = await acceptedReceipt(tx as unknown as Db, intent);
      if (receipts.accepted) {
        const [updated] = await tx.update(issueCommandDeliveries).set({
          status: "delivered", wakeupRequestId: receipts.accepted.id, deliveredAt: sql`now()`,
          claimToken: null, claimExpiresAt: null, lastError: null, updatedAt: sql`now()`,
        }).where(eq(issueCommandDeliveries.id, id)).returning();
        return updated;
      }
      const [interaction] = await tx.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, intent.interactionId));
      const eligible = issue?.status === "in_review" &&
        interaction?.companyId === intent.companyId && interaction.issueId === intent.issueId &&
        interaction.kind === "request_confirmation" && interaction.status === "pending" &&
        Boolean(interaction.createdByAgentId) && interaction.createdByAgentId !== intent.targetAgentId &&
        interaction.addresseeAgentId === intent.targetAgentId &&
        interaction.sourceRunId === intent.sourceRunId;
      const [updated] = await tx.update(issueCommandDeliveries).set({
        status: eligible ? receipts.unresolved ? "deferred" : "ready" : "cancelled", claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: receipts.unresolved ? sql`now() + interval '1 minute'` : sql`now()`,
        updatedAt: sql`now()`,
      }).where(eq(issueCommandDeliveries.id, id)).returning();
      return updated;
    });
  }

  return { enqueue, ready, claim, wakeupRequest, ack, defer, cancel, recover };
}
