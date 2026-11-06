import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRuns, issueCompletionReviews,
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

  async function fixture(withReview = true) {
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
    return { companyId, issueId, interactionId: interaction.id, reviewId };
  }

  async function state(f: Awaited<ReturnType<typeof fixture>>) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.interactionId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(and(eq(issueCompletionReviews.companyId, f.companyId),
        eq(issueCompletionReviews.interactionId, f.interactionId)));
    return { issue, interaction, review };
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
    const f = await fixture();
    expect(await issueService(db).update(f.issueId, {
      status: "done", companyGuard: f.companyId,
    })).toMatchObject({ status: "done" });
    const result = await state(f);
    expect(result.issue?.status).toBe("done");
    expect(result.interaction?.status).toBe("expired");
    expect(result.review?.state).toBe("cancelled");
    expect(result.review?.decidedAt?.getTime()).toBe(result.interaction?.resolvedAt?.getTime());
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
