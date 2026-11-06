import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, companies, completionContracts, createDb, heartbeatRuns,
  issueCompletionReviews, issueThreadInteractions, issues, localAgentRunLeases,
  nativeRunResults, statusDecisions, workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { validateCompletionReviewContract } from "./issue-completion-review-contract.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.runIf(support.supported)("inert completion review contract (PostgreSQL)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = external ? undefined : await startEmbeddedPostgresTestDatabase("paperclip-review-contract-");
    db = createDb(external ?? temporary!.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID(), sourceAgentId = randomUUID();
    const reviewerAgentId = randomUUID(), sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review contract test",
      issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: sourceAgentId, companyId, name: "Source" },
      { id: reviewerAgentId, companyId, name: "Reviewer" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Completed work",
      status: "in_review", statusVersion: 4, assigneeAgentId: sourceAgentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId,
      agentId: sourceAgentId, status: "running" });
    await db.insert(localAgentRunLeases).values({ runId: sourceRunId, companyId,
      agentId: sourceAgentId, issueId, deviceId: "device-review-test",
      idempotencyKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId, issueId, sourceRunId, kind: "request_confirmation", status: "pending",
      createdByAgentId: sourceAgentId, addresseeAgentId: reviewerAgentId,
      payload: { version: 1, prompt: "Review work" },
    }).returning();
    const row = { companyId, issueId, sourceRunId, sourceAgentId,
      reviewerAgentId, interactionId: interaction.id, sourceKind: "client_pull" as const,
      clientPullLeaseRunId: sourceRunId, nativeDecisionId: null,
      requestId: randomUUID(), requestDigest: "sha256:review-request",
      issueStatusVersion: 4 };
    return row;
  }

  it("accepts a reviewer different from the task assignee and prevents duplicate requests", async () => {
    const row = await fixture();
    const [saved] = await db.insert(issueCompletionReviews).values(row).returning();
    expect(saved.state).toBe("pending");
    const [secondInteraction] = await db.insert(issueThreadInteractions).values({
      companyId: row.companyId, issueId: row.issueId, sourceRunId: row.sourceRunId,
      kind: "request_confirmation", status: "pending", createdByAgentId: row.sourceAgentId,
      addresseeAgentId: row.reviewerAgentId,
      payload: { version: 1, prompt: "Second review" },
    }).returning();
    await expect(db.insert(issueCompletionReviews).values({ ...row,
      id: randomUUID(), interactionId: secondInteraction.id,
    })).rejects.toThrow();
  });

  it("rejects wrong company, issue, and missing source evidence", async () => {
    const row = await fixture();
    const other = await fixture();
    await expect(db.insert(issueCompletionReviews).values({ ...row,
      reviewerAgentId: other.reviewerAgentId })).rejects.toThrow();
    await expect(db.insert(issueCompletionReviews).values({ ...row,
      clientPullLeaseRunId: other.sourceRunId, sourceRunId: other.sourceRunId,
    })).rejects.toThrow();
    await expect(db.insert(issueCompletionReviews).values({ ...row,
      sourceKind: "native", nativeDecisionId: randomUUID(), clientPullLeaseRunId: null,
    })).rejects.toThrow();
  });

  it("accepts a native review only with a real result, assessment, and applied decision", async () => {
    const base = await fixture();
    const runId = randomUUID(), contractId = randomUUID(), resultId = randomUUID();
    const assessmentId = randomUUID(), decisionId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId,
      companyId: base.companyId, issueId: base.issueId, revision: 1,
      schemaVersion: "1", policyVersion: "1", risk: "low",
      completionAuthority: "reviewer", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: randomUUID(),
      createdByActorType: "agent", createdByActorId: base.sourceAgentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: base.companyId,
      agentId: base.sourceAgentId, nativeIssueId: base.issueId,
      completionContractId: contractId, status: "succeeded" });
    await db.insert(nativeRunResults).values({ id: resultId, companyId: base.companyId,
      issueId: base.issueId, runId, completionContractId: contractId,
      serverFingerprint: randomUUID(), schemaStatus: "valid", resultJson: {},
      canonicalSha256: randomUUID() });
    await db.insert(workAssessments).values({ id: assessmentId,
      companyId: base.companyId, issueId: base.issueId, runId,
      contractId, resultId, triggerKind: "run_finished",
      triggerActorCompanyId: base.companyId, priorIssueStatus: "in_progress",
      priorStatusVersion: 3, policyVersion: "1", assessmentJson: {},
      inputDigest: randomUUID() });
    await db.insert(statusDecisions).values({ id: decisionId,
      companyId: base.companyId, issueId: base.issueId, runId,
      assessmentId, decisionVersion: 1, policyVersion: "1",
      fromStatus: "in_progress", toStatus: "in_review",
      reasonCode: "review_required", decisionJson: {},
      decisionDigest: randomUUID(), applicationState: "applied" });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId: base.companyId, issueId: base.issueId, sourceRunId: runId,
      kind: "request_confirmation", status: "pending",
      createdByAgentId: base.sourceAgentId, addresseeAgentId: base.reviewerAgentId,
      payload: { version: 1, prompt: "Native review", target: {
        type: "custom", key: "native_completion_review", revisionId: decisionId } },
    }).returning();
    const [saved] = await db.insert(issueCompletionReviews).values({
      ...base, sourceRunId: runId, interactionId: interaction.id,
      sourceKind: "native", nativeDecisionId: decisionId,
      clientPullLeaseRunId: null, requestId: randomUUID(),
    }).returning();
    expect(saved.nativeDecisionId).toBe(decisionId);
    await expect(db.insert(issueCompletionReviews).values({
      ...base, sourceRunId: base.sourceRunId, interactionId: interaction.id,
      sourceKind: "native", nativeDecisionId: decisionId,
      clientPullLeaseRunId: null, requestId: randomUUID(),
    })).rejects.toThrow();
  });

  it("enforces evidence kind, reviewer separation, and immutable decision shape", async () => {
    const row = await fixture();
    await expect(db.insert(issueCompletionReviews).values({ ...row,
      clientPullLeaseRunId: null })).rejects.toThrow();
    await expect(db.insert(issueCompletionReviews).values({ ...row,
      reviewerAgentId: row.sourceAgentId })).rejects.toThrow();
    await expect(db.insert(issueCompletionReviews).values({ ...row,
      state: "accepted", decidedAt: null })).rejects.toThrow();
    const [saved] = await db.insert(issueCompletionReviews).values(row).returning();
    await expect(db.delete(issues).where(eq(issues.id, row.issueId))).rejects.toThrow();
    expect((await db.select().from(issueCompletionReviews).where(eq(issueCompletionReviews.id,
      saved.id)))).toHaveLength(1);
  });

  it("purely rejects stale versions or false source agents and replays exact requests", async () => {
    const row = await fixture();
    const request = { companyId: row.companyId, issueId: row.issueId,
      sourceRunId: row.sourceRunId, sourceAgentId: row.sourceAgentId,
      reviewerAgentId: row.reviewerAgentId, interactionId: row.interactionId,
      sourceKind: row.sourceKind, requestId: row.requestId,
      requestDigest: row.requestDigest, expectedStatusVersion: row.issueStatusVersion };
    const issue = { companyId: row.companyId, issueId: row.issueId,
      status: "in_review", statusVersion: 4, assigneeAgentId: row.sourceAgentId,
      lastStatusDecisionId: null };
    const interaction = { companyId: row.companyId, issueId: row.issueId,
      id: row.interactionId, status: "pending", addresseeAgentId: row.reviewerAgentId,
      createdByAgentId: row.sourceAgentId, sourceRunId: row.sourceRunId };
    const reviewer = { companyId: row.companyId, id: row.reviewerAgentId,
      status: "idle", executionMode: "client_pull" };
    const evidence = { companyId: row.companyId, issueId: row.issueId,
      runId: row.sourceRunId, agentId: row.sourceAgentId, kind: "client_pull" as const,
      id: row.sourceRunId, expiresAt: new Date(Date.now() + 60_000) };
    const facts = { request, issue, interaction, reviewer, evidence, now: new Date() };
    expect(validateCompletionReviewContract(facts)).toEqual({ kind: "new" });
    expect(() => validateCompletionReviewContract({ ...facts,
      issue: { ...issue, statusVersion: 5 } })).toThrow();
    expect(() => validateCompletionReviewContract({ ...facts,
      evidence: { ...evidence, agentId: randomUUID() } })).toThrow();
    expect(() => validateCompletionReviewContract({ ...facts,
      evidence: { ...evidence, cancelRequestedAt: new Date() } })).toThrow();
    expect(() => validateCompletionReviewContract({ ...facts,
      reviewer: { ...reviewer, pausedAt: new Date() } })).toThrow();
    const existing = { ...request, id: randomUUID(), state: "accepted" };
    expect(validateCompletionReviewContract({ ...facts, existing,
      issue: { ...issue, status: "done", statusVersion: 5 } })).toEqual({
        kind: "replay", reviewId: existing.id });
    expect(() => validateCompletionReviewContract({ ...facts,
      existing: { ...existing, requestDigest: "other" } })).toThrow();
  });
});

it("pure validation refuses a paused reviewer or cancelled source lease without PostgreSQL", () => {
  const companyId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
  const sourceAgentId = randomUUID(), reviewerAgentId = randomUUID(), interactionId = randomUUID();
  const facts = {
    request: { companyId, issueId, sourceRunId, sourceAgentId, reviewerAgentId,
      interactionId, sourceKind: "client_pull" as const, requestId: randomUUID(),
      requestDigest: "sha256:request", expectedStatusVersion: 4 },
    issue: { companyId, issueId, status: "in_review", statusVersion: 4,
      assigneeAgentId: sourceAgentId, lastStatusDecisionId: null },
    interaction: { companyId, issueId, id: interactionId, status: "pending",
      addresseeAgentId: reviewerAgentId, createdByAgentId: sourceAgentId, sourceRunId },
    reviewer: { companyId, id: reviewerAgentId, status: "idle",
      executionMode: "client_pull" },
    evidence: { companyId, issueId, runId: sourceRunId, agentId: sourceAgentId,
      kind: "client_pull" as const, id: sourceRunId,
      expiresAt: new Date(Date.now() + 60_000) },
    now: new Date(),
  };
  expect(validateCompletionReviewContract(facts)).toEqual({ kind: "new" });
  expect(() => validateCompletionReviewContract({ ...facts,
    reviewer: { ...facts.reviewer, pausedAt: new Date() } })).toThrow();
  expect(() => validateCompletionReviewContract({ ...facts,
    evidence: { ...facts.evidence, cancelRequestedAt: new Date() } })).toThrow();
  expect(() => validateCompletionReviewContract({ ...facts,
    evidence: { ...facts.evidence, agentId: randomUUID() } })).toThrow();
  expect(() => validateCompletionReviewContract({ ...facts,
    issue: { ...facts.issue, statusVersion: 5 } })).toThrow();
});
