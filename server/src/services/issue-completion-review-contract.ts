import { conflict, unprocessable } from "../errors.js";

type Scope = { companyId: string; issueId: string };
type ReviewRequest = Scope & {
  sourceRunId: string;
  sourceAgentId: string;
  reviewerAgentId: string;
  interactionId: string;
  sourceKind: "native" | "client_pull";
  requestId: string;
  requestDigest: string;
  expectedStatusVersion: number;
};
type ExistingReview = ReviewRequest & { id: string; state: string };

/**
 * Pure facts validation. It neither creates a review nor claims a runtime.
 * The caller must load evidence under its write locks and pass database time.
 */
export function validateCompletionReviewContract(input: {
  request: ReviewRequest;
  existing?: ExistingReview | null;
  issue: Scope & { status: string; statusVersion: number; assigneeAgentId: string | null;
    lastStatusDecisionId: string | null };
  interaction: Scope & { id: string; status: string; addresseeAgentId: string | null;
    createdByAgentId: string | null; sourceRunId: string | null };
  reviewer: { companyId: string; id: string; status: string; pausedAt?: Date | null;
    executionMode: string | null };
  evidence: Scope & { runId: string; agentId: string; kind: "native" | "client_pull";
    id: string; applicationState?: string; releasedAt?: Date | null;
    cancelRequestedAt?: Date | null; expiresAt?: Date };
  now: Date;
}): { kind: "new" } | { kind: "replay"; reviewId: string } {
  const { request: r, issue, interaction, reviewer, evidence } = input;
  if (issue.companyId !== r.companyId || issue.issueId !== r.issueId
    || interaction.companyId !== r.companyId || interaction.issueId !== r.issueId
    || reviewer.companyId !== r.companyId || evidence.companyId !== r.companyId
    || evidence.issueId !== r.issueId) throw conflict("Review scope changed");
  if (reviewer.id !== r.reviewerAgentId || interaction.id !== r.interactionId) {
    throw conflict("Review identity changed");
  }
  if (input.existing) {
    const e = input.existing;
    if (e.companyId !== r.companyId || e.issueId !== r.issueId || e.sourceRunId !== r.sourceRunId
      || e.sourceAgentId !== r.sourceAgentId || e.reviewerAgentId !== r.reviewerAgentId
      || e.interactionId !== r.interactionId || e.sourceKind !== r.sourceKind
      || e.requestId !== r.requestId || e.requestDigest !== r.requestDigest
      || e.expectedStatusVersion !== r.expectedStatusVersion) {
      throw conflict("Review request ID belongs to different content");
    }
    return { kind: "replay", reviewId: e.id };
  }
  if (r.sourceAgentId === r.reviewerAgentId || issue.assigneeAgentId !== r.sourceAgentId
    || reviewer.status === "terminated" || reviewer.status === "paused" || reviewer.pausedAt
    || interaction.addresseeAgentId !== r.reviewerAgentId
    || interaction.createdByAgentId !== r.sourceAgentId
    || interaction.sourceRunId !== r.sourceRunId) throw conflict("Review identity changed");
  if (issue.status !== "in_review" || interaction.status !== "pending"
    || issue.statusVersion !== r.expectedStatusVersion) {
    throw conflict("Review revision is no longer current");
  }
  if (evidence.kind !== r.sourceKind || evidence.runId !== r.sourceRunId
    || evidence.agentId !== r.sourceAgentId) throw conflict("Review source evidence changed");
  if (r.sourceKind === "native") {
    if (evidence.applicationState !== "applied" || issue.lastStatusDecisionId !== evidence.id) {
      throw conflict("Native status decision is not current");
    }
  } else if (evidence.releasedAt || evidence.cancelRequestedAt
    || !evidence.expiresAt || evidence.expiresAt <= input.now
    || reviewer.executionMode !== "client_pull") {
    throw unprocessable("Client-pull review lease or reviewer is unavailable");
  }
  return { kind: "new" };
}
