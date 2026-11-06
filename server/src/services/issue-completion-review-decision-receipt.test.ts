import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRuns, issueCompletionReviews,
  issueThreadInteractions, issues, localAgentRunLeases,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.runIf(support.supported)("inert completion review decision receipts (PostgreSQL)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = external ? undefined : await startEmbeddedPostgresTestDatabase("paperclip-review-receipt-");
    db = createDb(external ?? temporary!.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture(existingCompanyId?: string) {
    const companyId = existingCompanyId ?? randomUUID(), issueId = randomUUID();
    const sourceAgentId = randomUUID(), reviewerAgentId = randomUUID();
    const sourceRunId = randomUUID(), reviewId = randomUUID();
    if (!existingCompanyId) {
      await db.insert(companies).values({ id: companyId, name: "Review receipt test",
        issuePrefix: `R${companyId.slice(0, 7)}` });
    }
    await db.insert(agents).values([
      { id: sourceAgentId, companyId, name: "Source" },
      { id: reviewerAgentId, companyId, name: "Reviewer" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Review receipt issue",
      status: "in_review", assigneeAgentId: sourceAgentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId,
      agentId: sourceAgentId, status: "running" });
    await db.insert(localAgentRunLeases).values({ runId: sourceRunId, companyId,
      agentId: sourceAgentId, issueId, deviceId: "review-receipt-test",
      idempotencyKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId, issueId, sourceRunId, kind: "request_confirmation", status: "pending",
      createdByAgentId: sourceAgentId, addresseeAgentId: reviewerAgentId,
      payload: { version: 1, prompt: "Review work", target: {
        type: "custom", key: "issue_completion_review", revisionId: reviewId,
      } },
    }).returning();
    await db.insert(issueCompletionReviews).values({ id: reviewId,
      companyId, issueId, sourceRunId, sourceAgentId, reviewerAgentId,
      interactionId: interaction.id, sourceKind: "client_pull",
      clientPullLeaseRunId: sourceRunId, requestId: randomUUID(),
      requestDigest: "sha256:creation-request", issueStatusVersion: 0,
    });
    return { companyId, reviewId, reviewerAgentId };
  }

  function decision(reviewId: string, outcome: "accepted" | "rejected", requestId = randomUUID()) {
    return { state: outcome, decidedAt: new Date(), decisionRequestId: requestId,
      decisionRequestDigest: "a".repeat(64), decisionSummary: "Reviewed against the requirement",
      decisionReceipt: { schemaVersion: 1, reviewId, requestId, outcome },
    };
  }

  it("persists separate accepted and rejected receipts and enforces company-scoped request uniqueness", async () => {
    const first = await fixture();
    const second = await fixture(first.companyId);
    const requestId = randomUUID();
    const [accepted] = await db.update(issueCompletionReviews)
      .set(decision(first.reviewId, "accepted", requestId))
      .where(eq(issueCompletionReviews.id, first.reviewId)).returning();
    expect(accepted.state).toBe("accepted");
    expect(accepted.decisionReceipt).toMatchObject({ reviewId: first.reviewId, requestId,
      outcome: "accepted" });
    await expect(db.update(issueCompletionReviews)
      .set(decision(second.reviewId, "rejected", requestId))
      .where(eq(issueCompletionReviews.id, second.reviewId))).rejects.toThrow();
    const [stillPending] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, second.reviewId));
    expect(stillPending.state).toBe("pending");
    const [rejected] = await db.update(issueCompletionReviews)
      .set(decision(second.reviewId, "rejected"))
      .where(eq(issueCompletionReviews.id, second.reviewId)).returning();
    expect(rejected.state).toBe("rejected");
  });

  it("rejects every missing decision field and malformed or incomplete receipt", async () => {
    const review = await fixture();
    const valid = decision(review.reviewId, "accepted");
    for (const field of ["decisionRequestId", "decisionRequestDigest",
      "decisionSummary", "decisionReceipt"] as const) {
      await expect(db.update(issueCompletionReviews).set({ ...valid, [field]: null })
        .where(eq(issueCompletionReviews.id, review.reviewId))).rejects.toThrow();
    }
    for (const decisionReceipt of [{},
      { schemaVersion: 1, requestId: valid.decisionRequestId, outcome: "accepted" },
      { schemaVersion: 1, reviewId: review.reviewId, outcome: "accepted" },
      { schemaVersion: 1, reviewId: review.reviewId, requestId: valid.decisionRequestId },
      { schemaVersion: 1, reviewId: randomUUID(), requestId: valid.decisionRequestId,
        outcome: "accepted" },
      { schemaVersion: "1", reviewId: review.reviewId,
        requestId: valid.decisionRequestId, outcome: "accepted" },
    ]) {
      await expect(db.update(issueCompletionReviews).set({ ...valid, decisionReceipt })
        .where(eq(issueCompletionReviews.id, review.reviewId))).rejects.toThrow();
    }
    await expect(db.update(issueCompletionReviews).set({ ...valid,
      decisionRequestDigest: "not-a-sha256" })
      .where(eq(issueCompletionReviews.id, review.reviewId))).rejects.toThrow();
    await expect(db.update(issueCompletionReviews).set({ ...valid, decisionSummary: "  " })
      .where(eq(issueCompletionReviews.id, review.reviewId))).rejects.toThrow();
  });

  it("keeps pending and system-cancelled rows free of reviewer receipts", async () => {
    const pending = await fixture();
    const valid = decision(pending.reviewId, "accepted");
    await expect(db.update(issueCompletionReviews).set({ state: "pending",
      decisionRequestId: valid.decisionRequestId })
      .where(eq(issueCompletionReviews.id, pending.reviewId))).rejects.toThrow();
    await expect(db.update(issueCompletionReviews).set({ ...valid, state: "cancelled" })
      .where(eq(issueCompletionReviews.id, pending.reviewId))).rejects.toThrow();
    const [cancelled] = await db.update(issueCompletionReviews)
      .set({ state: "cancelled", decidedAt: new Date() })
      .where(eq(issueCompletionReviews.id, pending.reviewId)).returning();
    expect(cancelled.decisionRequestId).toBeNull();
    expect(cancelled.decisionReceipt).toBeNull();
  });

  it("rejects cross-company reviewer ownership while deciding a review", async () => {
    const own = await fixture(), foreign = await fixture();
    await expect(db.update(issueCompletionReviews).set({
      ...decision(own.reviewId, "accepted"), reviewerAgentId: foreign.reviewerAgentId,
    }).where(eq(issueCompletionReviews.id, own.reviewId))).rejects.toThrow();
    const [row] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, own.reviewId));
    expect(row.state).toBe("pending");
  });

  it("aborts migration before adding receipt columns if an old decided row exists", async () => {
    const migration = await readFile(new URL(
      "../../../packages/db/src/migrations/0300_medical_garia.sql", import.meta.url,
    ), "utf8");
    const preflight = migration.split("--> statement-breakpoint")[0];
    expect(preflight).toContain("contains decided rows without decision receipts");
    expect(migration.indexOf("DO $$")).toBeLessThan(migration.indexOf("ADD COLUMN"));
    const review = await fixture();
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql.raw(`ALTER TABLE issue_completion_reviews
        DROP CONSTRAINT issue_completion_reviews_decision_receipt_check`));
      await tx.update(issueCompletionReviews).set({ state: "accepted", decidedAt: new Date() })
        .where(eq(issueCompletionReviews.id, review.reviewId));
      let cause: unknown;
      try { await tx.execute(sql.raw(preflight)); } catch (error) { cause = error; }
      expect(String((cause as { cause?: Error } | undefined)?.cause?.message))
        .toContain("contains decided rows without decision receipts");
      throw new Error("roll back legacy fixture");
    })).rejects.toThrow("roll back legacy fixture");
    const [stillPending] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, review.reviewId));
    expect(stillPending.state).toBe("pending");
  });
});
