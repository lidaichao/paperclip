import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentApiKeys, agentWakeupRequests, agents, companies, createDb,
  heartbeatRuns, issueCompletionReviews, issues, issueThreadInteractions,
  localAgentDeviceBindings, localAgentRunLeases,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { assertClientPullReviewClaimCandidate,
  CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON as reviewWake,
  clientPullCompletionReviewWakeKey,
  retireStaleClientPullReviewQueuedRun,
  STALE_REVIEW_CLAIM_CODE } from "./local-agent-review-claim.js";
import type { Db } from "@paperclipai/db";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.runIf(support.supported)("inert local completion reviewer claim candidate (PostgreSQL)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = external ? undefined : await startEmbeddedPostgresTestDatabase("paperclip-review-claim-");
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
    const reviewId = randomUUID(), interactionId = randomUUID(), wakeId = randomUUID();
    const keyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reviewer claim test",
      issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: sourceAgentId, companyId, name: "Source agent",
        adapterType: "codex_local", runtimeConfig: { executionMode: "client_pull" } },
      { id: reviewerAgentId, companyId, name: "Reviewer agent",
        adapterType: "codex_local", runtimeConfig: { executionMode: "client_pull" } },
    ]);
    await db.insert(agentApiKeys).values({ id: keyId, companyId,
      agentId: reviewerAgentId, name: "Reviewer device", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId,
      agentId: reviewerAgentId, keyId, deviceId: "reviewer-desktop-001" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review me",
      status: "in_review", statusVersion: 4, assigneeAgentId: sourceAgentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId,
      agentId: sourceAgentId, status: "succeeded", runtimeMode: "client_pull",
      contextSnapshot: { issueId } });
    await db.insert(localAgentRunLeases).values({ runId: sourceRunId, companyId,
      agentId: sourceAgentId, issueId, deviceId: "source-desktop-001",
      idempotencyKey: randomUUID(), expiresAt: new Date(Date.now() - 1000),
      releasedAt: new Date(), stopAcknowledgedAt: new Date(), outcome: "succeeded" });
    await db.insert(issueThreadInteractions).values({ id: interactionId,
      companyId, issueId, sourceRunId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "not_creator",
      effectiveResolverPolicy: "not_creator", createdByAgentId: sourceAgentId,
      addresseeAgentId: reviewerAgentId, addresseeUserId: null,
      payload: { version: 1, prompt: "Verify delivery", target: {
        type: "custom", key: "issue_completion_review", revisionId: reviewId,
      } },
    });
    await db.insert(issueCompletionReviews).values({ id: reviewId, companyId,
      issueId, sourceRunId, sourceAgentId, reviewerAgentId, interactionId,
      sourceKind: "client_pull", clientPullLeaseRunId: sourceRunId,
      requestId: randomUUID(), requestDigest: "sha256:review-claim-test",
      issueStatusVersion: 4 });
    const context = { issueId, interactionId, reviewId, sourceRunId, wakeReason: reviewWake };
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId,
      agentId: reviewerAgentId, source: "automation", reason: reviewWake,
      status: "queued", runId: reviewerRunId,
      idempotencyKey: clientPullCompletionReviewWakeKey(reviewId, interactionId),
      payload: { issueId, interactionId, reviewId, sourceRunId } });
    await db.insert(heartbeatRuns).values({ id: reviewerRunId, companyId,
      agentId: reviewerAgentId, status: "queued", runtimeMode: "client_pull",
      wakeupRequestId: wakeId,
      contextSnapshot: context });
    return { companyId, issueId, sourceAgentId, reviewerAgentId,
      sourceRunId, reviewerRunId, reviewId, interactionId, wakeId, keyId };
  }

  async function validate(f: Awaited<ReturnType<typeof fixture>>) {
    return db.transaction(async (tx) => {
      const [agent] = await tx.select().from(agents)
        .where(eq(agents.id, f.reviewerAgentId)).for("update");
      await tx.select().from(agentApiKeys).where(eq(agentApiKeys.id, f.keyId)).for("update");
      const [run] = await tx.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, f.reviewerRunId)).for("update");
      const [issue] = await tx.select().from(issues)
        .where(eq(issues.id, f.issueId)).for("update");
      return assertClientPullReviewClaimCandidate(db, tx as unknown as Db,
        { agent, run, issue });
    });
  }

  it("accepts only an exact pending review candidate without changing the source task", async () => {
    const f = await fixture();
    expect(clientPullCompletionReviewWakeKey(f.reviewId, f.interactionId))
      .toBe(`interaction:${f.interactionId}:completion-review:${f.reviewId}`);
    expect(await validate(f)).toMatchObject({ reviewId: f.reviewId,
      interactionId: f.interactionId, sourceRunId: f.sourceRunId });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.reviewerRunId));
    expect(issue.assigneeAgentId).toBe(f.sourceAgentId);
    expect(issue.executionRunId).toBeNull();
    expect(run.status).toBe("queued");
  });

  it("rejects stale review revisions and unrelated wake receipts", async () => {
    const stale = await fixture();
    await db.update(issues).set({ statusVersion: 5 }).where(eq(issues.id, stale.issueId));
    await expect(validate(stale)).rejects.toMatchObject({ status: 409,
      details: { code: STALE_REVIEW_CLAIM_CODE } });
    const wrongCard = await fixture();
    await db.update(issueThreadInteractions).set({ payload: {
      version: 1, prompt: "Verify delivery", target: { type: "custom", key: "issue_completion_review",
        revisionId: randomUUID() },
    } }).where(eq(issueThreadInteractions.id, wrongCard.interactionId));
    await expect(validate(wrongCard)).rejects.toMatchObject({ status: 409 });
    const wrongWake = await fixture();
    await db.update(agentWakeupRequests).set({ payload: { issueId: wrongWake.issueId,
      interactionId: wrongWake.interactionId, reviewId: randomUUID(),
      sourceRunId: wrongWake.sourceRunId } })
      .where(eq(agentWakeupRequests.id, wrongWake.wakeId));
    await expect(validate(wrongWake)).rejects.toMatchObject({ status: 409 });
  });

  it("retires a permanently stale reviewer run and its wake receipt", async () => {
    const f = await fixture();
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.reviewerRunId));
    await db.transaction((tx) => retireStaleClientPullReviewQueuedRun(tx as unknown as Db, run));
    const [retired] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.reviewerRunId));
    const [wake] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, f.wakeId));
    expect(retired.status).toBe("cancelled");
    expect(wake.status).toBe("cancelled");
    expect(wake.error).toBe("dedicated_review_stale");
  });

  it("refuses a still-running source or unreleased source lease", async () => {
    const running = await fixture();
    await db.update(heartbeatRuns).set({ status: "running" })
      .where(eq(heartbeatRuns.id, running.sourceRunId));
    await expect(validate(running)).rejects.toMatchObject({ status: 409 });
    const unreleased = await fixture();
    await db.update(localAgentRunLeases).set({ releasedAt: null,
      stopAcknowledgedAt: null, outcome: null })
      .where(eq(localAgentRunLeases.runId, unreleased.sourceRunId));
    await expect(validate(unreleased)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a reviewer that owns the issue or cannot run locally", async () => {
    const wrongAssignee = await fixture();
    await db.update(issues).set({ assigneeAgentId: wrongAssignee.reviewerAgentId })
      .where(eq(issues.id, wrongAssignee.issueId));
    await expect(validate(wrongAssignee)).rejects.toMatchObject({ status: 409 });
    const paused = await fixture();
    await db.update(agents).set({ status: "paused" })
      .where(eq(agents.id, paused.reviewerAgentId));
    await expect(validate(paused)).rejects.toMatchObject({ status: 409 });
  });
});
