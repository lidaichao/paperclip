import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog, agents, companies, createDb, heartbeatRuns, issueCompletionReviews,
  issueThreadInteractions, issues, localAgentRunLeases,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { issueCompletionReviewDecisionService } from "./issue-completion-review-decisions.js";
import { issueService } from "./issues.js";
import type { Db } from "@paperclipai/db";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.runIf(support.supported)("inert shared completion review acceptance (PostgreSQL)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = external ? undefined : await startEmbeddedPostgresTestDatabase("paperclip-review-accept-");
    db = createDb(external ?? temporary!.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID();
    const sourceAgentId = randomUUID(), reviewerAgentId = randomUUID();
    const sourceRunId = randomUUID(), reviewerRunId = randomUUID();
    const reviewId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review acceptance test",
      issuePrefix: `A${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: sourceAgentId, companyId, name: "Source" },
      { id: reviewerAgentId, companyId, name: "Reviewer" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Reviewable work",
      status: "in_review", statusVersion: 4, assigneeAgentId: sourceAgentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId,
      agentId: sourceAgentId, status: "succeeded" });
    await db.insert(localAgentRunLeases).values({ runId: sourceRunId, companyId,
      agentId: sourceAgentId, issueId, deviceId: "review-accept-test",
      idempotencyKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId, issueId, sourceRunId, kind: "request_confirmation", status: "pending",
      effectiveResolverPolicy: "not_creator", createdByAgentId: sourceAgentId,
      addresseeAgentId: reviewerAgentId, addresseeUserId: null,
      payload: { version: 1, prompt: "Review work", target: {
        type: "custom", key: "issue_completion_review", revisionId: reviewId,
      } },
    }).returning();
    await db.insert(issueCompletionReviews).values({ id: reviewId, companyId, issueId,
      sourceRunId, sourceAgentId, reviewerAgentId, interactionId: interaction.id,
      sourceKind: "client_pull", clientPullLeaseRunId: sourceRunId,
      requestId: randomUUID(), requestDigest: "sha256:creation-request", issueStatusVersion: 4 });
    await db.insert(heartbeatRuns).values({ id: reviewerRunId, companyId,
      agentId: reviewerAgentId, status: "running",
      contextSnapshot: { issueId, interactionId: interaction.id } });
    return { companyId, issueId, reviewId, interactionId: interaction.id,
      reviewerAgentId, reviewerRunId };
  }

  function request(f: Awaited<ReturnType<typeof fixture>>) {
    return { companyId: f.companyId, issueId: f.issueId, reviewId: f.reviewId,
      actorAgentId: f.reviewerAgentId, actorRunId: f.reviewerRunId,
      requestId: randomUUID(), summary: "The work meets the requirement" };
  }

  async function state(f: Awaited<ReturnType<typeof fixture>>) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [review] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, f.reviewId));
    const [card] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.interactionId));
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId));
    return { issue, review, card, activities: activities.filter((a) =>
      a.action === "issue.completion_review_accepted") };
  }

  it("accepts atomically, replays the same receipt, and rejects changed content or another run", async () => {
    const f = await fixture(), input = request(f);
    const service = issueCompletionReviewDecisionService(db);
    const first = await service.accept(input);
    expect(first).toMatchObject({ reviewId: f.reviewId, requestId: input.requestId,
      outcome: "accepted" });
    const committed = await state(f);
    expect(committed.issue?.status).toBe("done");
    expect(committed.review?.state).toBe("accepted");
    expect(committed.card?.status).toBe("accepted");
    expect(committed.activities).toHaveLength(1);
    expect(await service.accept(input)).toEqual(first);
    await expect(service.accept({ ...input, summary: "Changed verdict" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.accept({ ...input, actorRunId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    expect((await state(f)).activities).toHaveLength(1);
  });

  it("serializes concurrent identical decisions to one activity and result", async () => {
    const f = await fixture(), input = request(f);
    const service = issueCompletionReviewDecisionService(db);
    const [first, second] = await Promise.all([service.accept(input), service.accept(input)]);
    expect(second).toEqual(first);
    expect((await state(f)).activities).toHaveLength(1);
  });

  it("waits for every pending reviewer before marking the task done", async () => {
    const f = await fixture();
    const secondReviewerAgentId = randomUUID(), secondReviewerRunId = randomUUID();
    const secondReviewId = randomUUID();
    const [sourceReview] = await db.select().from(issueCompletionReviews)
      .where(eq(issueCompletionReviews.id, f.reviewId));
    await db.insert(agents).values({ id: secondReviewerAgentId,
      companyId: f.companyId, name: "Second reviewer" });
    const [secondCard] = await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, sourceRunId: sourceReview.sourceRunId,
      kind: "request_confirmation", status: "pending", effectiveResolverPolicy: "not_creator",
      createdByAgentId: sourceReview.sourceAgentId, addresseeAgentId: secondReviewerAgentId,
      payload: { version: 1, prompt: "Second review", target: {
        type: "custom", key: "issue_completion_review", revisionId: secondReviewId,
      } },
    }).returning();
    await db.insert(issueCompletionReviews).values({ id: secondReviewId,
      companyId: f.companyId, issueId: f.issueId, sourceRunId: sourceReview.sourceRunId,
      sourceAgentId: sourceReview.sourceAgentId, reviewerAgentId: secondReviewerAgentId,
      interactionId: secondCard.id, sourceKind: "client_pull",
      clientPullLeaseRunId: sourceReview.sourceRunId, requestId: randomUUID(),
      requestDigest: "sha256:second-creation", issueStatusVersion: 4 });
    await db.insert(heartbeatRuns).values({ id: secondReviewerRunId,
      companyId: f.companyId, agentId: secondReviewerAgentId, status: "running",
      contextSnapshot: { issueId: f.issueId, interactionId: secondCard.id } });
    const service = issueCompletionReviewDecisionService(db);
    await service.accept(request(f));
    expect((await state(f)).issue?.status).toBe("in_review");
    await service.accept({ companyId: f.companyId, issueId: f.issueId,
      reviewId: secondReviewId, actorAgentId: secondReviewerAgentId,
      actorRunId: secondReviewerRunId, requestId: randomUUID(),
      summary: "Second reviewer accepts" });
    expect((await state(f)).issue?.status).toBe("done");
  });

  it("rejects cancelled reviewer runs before any review mutation", async () => {
    const f = await fixture(), input = request(f);
    await db.update(heartbeatRuns).set({ status: "cancelled" })
      .where(eq(heartbeatRuns.id, f.reviewerRunId));
    await expect(issueCompletionReviewDecisionService(db).accept(input))
      .rejects.toMatchObject({ status: 409 });
    const result = await state(f);
    expect(result.issue?.status).toBe("in_review");
    expect(result.review?.state).toBe("pending");
    expect(result.card?.status).toBe("pending");
    expect(result.activities).toHaveLength(0);
  });

  it("returns a retryable conflict when cancellation already holds the reviewer run", async () => {
    const f = await fixture(), input = request(f);
    let runLocked!: () => void, releaseRun!: () => void;
    const locked = new Promise<void>((resolve) => { runLocked = resolve; });
    const hold = new Promise<void>((resolve) => { releaseRun = resolve; });
    const cancelling = db.transaction(async (tx) => {
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, f.reviewerRunId)).for("update");
      runLocked();
      await hold;
      await tx.update(heartbeatRuns).set({ status: "cancelled" })
        .where(eq(heartbeatRuns.id, f.reviewerRunId));
    });
    await locked;
    try {
      await expect(issueCompletionReviewDecisionService(db).accept(input))
        .rejects.toMatchObject({ status: 409,
          message: expect.stringContaining("retry") });
    } finally {
      releaseRun();
      await cancelling;
    }
    const result = await state(f);
    expect(result.issue?.status).toBe("in_review");
    expect(result.review?.state).toBe("pending");
    expect(result.card?.status).toBe("pending");
  });

  it("holds the reviewer run until an accepted decision commits before cancellation", async () => {
    const f = await fixture(), input = request(f);
    let runLocked!: () => void, releaseRun!: () => void;
    const locked = new Promise<void>((resolve) => { runLocked = resolve; });
    const hold = new Promise<void>((resolve) => { releaseRun = resolve; });
    const accepting = issueCompletionReviewDecisionService(db, {
      afterReviewerRunLocked: async () => { runLocked(); await hold; },
    }).accept(input);
    await locked;
    try {
      await expect(db.transaction(async (tx) => tx.select({ id: heartbeatRuns.id })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, f.reviewerRunId))
        .for("update", { noWait: true }))).rejects.toThrow();
    } finally {
      releaseRun();
    }
    await accepting;
    await db.update(heartbeatRuns).set({ status: "cancelled" })
      .where(eq(heartbeatRuns.id, f.reviewerRunId));
    const result = await state(f);
    expect(result.review?.state).toBe("accepted");
    expect(result.issue?.status).toBe("done");
    expect(result.activities).toHaveLength(1);
  });

  it("keeps client-pull reviewers closed until their lease and device proof can be fenced", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ runtimeMode: "client_pull" })
      .where(eq(heartbeatRuns.id, f.reviewerRunId));
    await expect(issueCompletionReviewDecisionService(db).accept(request(f)))
      .rejects.toMatchObject({ status: 422 });
    expect((await state(f)).review?.state).toBe("pending");
  });

  it("loses a terminal cancellation race without a partial acceptance", async () => {
    const f = await fixture(), input = request(f);
    let issueLocked!: () => void, releaseIssue!: () => void;
    const locked = new Promise<void>((resolve) => { issueLocked = resolve; });
    const hold = new Promise<void>((resolve) => { releaseIssue = resolve; });
    const cancellation = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues)
        .where(eq(issues.id, f.issueId)).for("update");
      issueLocked();
      await hold;
      await issueService(db).update(f.issueId, {
        companyGuard: f.companyId, status: "cancelled",
      }, tx as unknown as Db, [], []);
    });
    await locked;
    const accepting = issueCompletionReviewDecisionService(db).accept(input)
      .then(() => null, (error: unknown) => error);
    releaseIssue();
    await cancellation;
    expect(await accepting).toMatchObject({ status: 409 });
    const result = await state(f);
    expect(result.issue?.status).toBe("cancelled");
    expect(result.review?.state).toBe("cancelled");
    expect(result.card?.status).toBe("expired");
    expect(result.activities).toHaveLength(0);
  });

  it("rolls back task, card, and review if activity persistence fails", async () => {
    const f = await fixture(), input = request(f);
    const triggerName = `review_accept_fail_${f.reviewId.replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;
    await db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced activity failure'; END; $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON activity_log
      FOR EACH ROW WHEN (NEW.action = 'issue.completion_review_accepted'
        AND NEW.entity_id = '${f.issueId}') EXECUTE FUNCTION ${functionName}()`));
    try {
      await expect(issueCompletionReviewDecisionService(db).accept(input))
        .rejects.toThrow('Failed query: insert into "activity_log"');
      const result = await state(f);
      expect(result.issue?.status).toBe("in_review");
      expect(result.review?.state).toBe("pending");
      expect(result.card?.status).toBe("pending");
      expect(result.activities).toHaveLength(0);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${triggerName} ON activity_log`));
      await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    }
  });

  it("keeps rejection fail-closed until a reliable source notification exists", async () => {
    const f = await fixture();
    await expect(issueCompletionReviewDecisionService(db).reject(request(f)))
      .rejects.toMatchObject({ status: 422 });
    expect((await state(f)).review?.state).toBe("pending");
  });
});
