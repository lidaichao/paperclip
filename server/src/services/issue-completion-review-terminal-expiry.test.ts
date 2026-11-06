import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRuns, issueCommandDeliveries, issueCompletionReviews,
  issueThreadInteractions, issues, localAgentRunLeases,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { issueService } from "./issues.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.runIf(support.supported)("terminal issue expiry of shared completion reviews (PostgreSQL)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = external ? undefined : await startEmbeddedPostgresTestDatabase("paperclip-review-expiry-");
    db = createDb(external ?? temporary!.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture(withReview = true, withDelivery = false) {
    const companyId = randomUUID(), issueId = randomUUID();
    const sourceAgentId = randomUUID(), reviewerAgentId = randomUUID();
    const sourceRunId = randomUUID(), reviewId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review expiry test",
      issuePrefix: `X${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: sourceAgentId, companyId, name: "Source" },
      { id: reviewerAgentId, companyId, name: "Reviewer" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Reviewable issue",
      status: "in_review", assigneeAgentId: sourceAgentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId,
      agentId: sourceAgentId, status: "running" });
    await db.insert(localAgentRunLeases).values({ runId: sourceRunId, companyId,
      agentId: sourceAgentId, issueId, deviceId: "review-expiry-test",
      idempotencyKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId, issueId, sourceRunId, kind: "request_confirmation", status: "pending",
      createdByAgentId: sourceAgentId, addresseeAgentId: reviewerAgentId,
      payload: { version: 1, prompt: "Review work", target: {
        type: "custom", key: "issue_completion_review", revisionId: reviewId,
      } },
    }).returning();
    if (withReview) {
      await db.insert(issueCompletionReviews).values({ id: reviewId,
        companyId, issueId, sourceRunId, sourceAgentId, reviewerAgentId,
        interactionId: interaction.id, sourceKind: "client_pull",
        clientPullLeaseRunId: sourceRunId, requestId: randomUUID(),
        requestDigest: "sha256:review-expiry", issueStatusVersion: 0,
      });
    }
    if (withDelivery) {
      await db.insert(issueCommandDeliveries).values({ companyId, issueId,
        interactionId: interaction.id, sourceRunId, targetAgentId: reviewerAgentId,
        kind: "interaction_pending", status: "ready" });
    }
    return { companyId, issueId, interactionId: interaction.id, reviewId };
  }

  async function state(f: Awaited<ReturnType<typeof fixture>>) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.interactionId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(and(eq(issueCompletionReviews.companyId, f.companyId),
        eq(issueCompletionReviews.interactionId, f.interactionId)));
    const [delivery] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.interactionId, f.interactionId));
    return { issue, interaction, review, delivery };
  }

  async function closeInTransaction(f: Awaited<ReturnType<typeof fixture>>) {
    return db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return issueThreadInteractionService(tx as unknown as Db).expirePendingInteractionsForTerminalIssue({
        id: f.issueId, companyId: f.companyId, status: "done",
      });
    });
  }

  it("cancels the review and expires its card in the same issue transaction", async () => {
    const f = await fixture(true, true);
    expect(await issueService(db).update(f.issueId, {
      status: "done", companyGuard: f.companyId,
    })).toMatchObject({ status: "done" });
    const result = await state(f);
    expect(result.issue?.status).toBe("done");
    expect(result.interaction?.status).toBe("expired");
    expect(result.review?.state).toBe("cancelled");
    expect(result.delivery?.status).toBe("cancelled");
    expect(result.review?.decidedAt?.getTime()).toBe(result.interaction?.resolvedAt?.getTime());
  });

  for (const status of ["todo", "in_progress", "blocked"] as const) {
    it(`invalidates only the shared completion review when in_review becomes ${status}`, async () => {
      const f = await fixture(true, true);
      const [ordinary] = await db.insert(issueThreadInteractions).values({
        companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation",
        status: "pending", payload: { version: 1, prompt: "Unrelated question" },
      }).returning();
      expect(await issueService(db).update(f.issueId, {
        status, companyGuard: f.companyId,
      })).toMatchObject({ status });
      const result = await state(f);
      expect(result.interaction?.status).toBe("expired");
      expect(result.interaction?.result).toMatchObject({ outcome: "stale_target" });
      expect(result.review?.state).toBe("cancelled");
      expect(result.delivery?.status).toBe("cancelled");
      const [other] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, ordinary.id));
      expect(other.status).toBe("pending");
    });
  }

  it("does not revive an expired review card when the issue returns to in_review", async () => {
    const f = await fixture(true, true);
    await issueService(db).update(f.issueId, { status: "todo", companyGuard: f.companyId });
    await issueService(db).update(f.issueId, { status: "in_review", companyGuard: f.companyId });
    const result = await state(f);
    expect(result.issue?.status).toBe("in_review");
    expect(result.interaction?.status).toBe("expired");
    expect(result.review?.state).toBe("cancelled");
    expect(result.delivery?.status).toBe("cancelled");
  });

  it("clears an unsent claimed delivery token on review invalidation", async () => {
    const f = await fixture(true, true);
    await db.update(issueCommandDeliveries).set({ status: "claimed",
      claimToken: randomUUID(), claimExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(issueCommandDeliveries.interactionId, f.interactionId));
    await issueService(db).update(f.issueId, { status: "blocked", companyGuard: f.companyId });
    const result = await state(f);
    expect(result.delivery?.status).toBe("cancelled");
    expect(result.delivery?.claimToken).toBeNull();
    expect(result.delivery?.claimExpiresAt).toBeNull();
  });

  it("rolls back issue, delivery, review and card when a nonterminal card update fails", async () => {
    const f = await fixture(true, true);
    const triggerName = `review_status_fail_${f.interactionId.replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;
    await db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced card update failure'; END; $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON issue_thread_interactions
      FOR EACH ROW WHEN (OLD.id = '${f.interactionId}') EXECUTE FUNCTION ${functionName}()`));
    try {
      await expect(issueService(db).update(f.issueId, {
        status: "todo", companyGuard: f.companyId,
      })).rejects.toThrow('Failed query: update "issue_thread_interactions"');
      const result = await state(f);
      expect(result.issue?.status).toBe("in_review");
      expect(result.interaction?.status).toBe("pending");
      expect(result.review?.state).toBe("pending");
      expect(result.delivery?.status).toBe("ready");
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${triggerName} ON issue_thread_interactions`));
      await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    }
  });

  it("fails closed when the target has no pending review and rolls back issue closure", async () => {
    const f = await fixture(false);
    await expect(closeInTransaction(f)).rejects.toMatchObject({ status: 409 });
    const result = await state(f);
    expect(result.issue?.status).toBe("in_review");
    expect(result.interaction?.status).toBe("pending");
    expect(result.review).toBeUndefined();
  });

  it("does not cancel a different review revision for the same interaction", async () => {
    const f = await fixture();
    await db.update(issueThreadInteractions).set({ payload: {
      version: 1, prompt: "Review work", target: {
        type: "custom", key: "issue_completion_review", revisionId: randomUUID(),
      },
    } }).where(eq(issueThreadInteractions.id, f.interactionId));
    await expect(closeInTransaction(f)).rejects.toMatchObject({ status: 409 });
    const result = await state(f);
    expect(result.issue?.status).toBe("in_review");
    expect(result.interaction?.status).toBe("pending");
    expect(result.review?.state).toBe("pending");
  });

  it("rolls back the review when the card update fails", async () => {
    const f = await fixture();
    const triggerName = `review_expiry_fail_${f.interactionId.replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;
    await db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced card update failure'; END; $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON issue_thread_interactions
      FOR EACH ROW WHEN (OLD.id = '${f.interactionId}') EXECUTE FUNCTION ${functionName}()`));
    try {
      await expect(closeInTransaction(f)).rejects.toThrow('Failed query: update "issue_thread_interactions"');
      const result = await state(f);
      expect(result.issue?.status).toBe("in_review");
      expect(result.interaction?.status).toBe("pending");
      expect(result.review?.state).toBe("pending");
      expect(result.review?.decidedAt).toBeNull();
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${triggerName} ON issue_thread_interactions`));
      await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    }
  });

  it("rolls back both records if a later audit step rejects the outer transaction", async () => {
    const f = await fixture();
    await expect(db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      await issueThreadInteractionService(tx as unknown as Db).expirePendingInteractionsForTerminalIssue({
        id: f.issueId, companyId: f.companyId, status: "done",
      });
      throw new Error("forced later audit failure");
    })).rejects.toThrow("forced later audit failure");
    const result = await state(f);
    expect(result.issue?.status).toBe("in_review");
    expect(result.interaction?.status).toBe("pending");
    expect(result.review?.state).toBe("pending");
  });
});
