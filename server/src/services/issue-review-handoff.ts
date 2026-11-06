import type { Db } from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../errors.js";
import { logActivity, issueReferenceService, issueService, type ActivityPublication } from "./index.js";
import { assertInReviewReviewPath } from "./issue-review-path.js";
import { resolveActorSourceTrustForIssue } from "./source-trust.js";

type IssueService = ReturnType<typeof issueService>;
type IssueUpdate = Parameters<IssueService["update"]>[1];
type ExistingIssue = NonNullable<Awaited<ReturnType<IssueService["getByIdForUpdate"]>>>;

/**
 * One deliberately narrow review handoff shared by the ordinary PATCH route
 * and the fenced desktop route. The caller owns the transaction and any lease
 * locks. It deliberately does not send a wake: this agent's active run is the
 * comment author and a same-run pending confirmation already owns review.
 */
export async function executeReviewHandoff(input: {
  db: Db;
  tx: Db;
  existing: ExistingIssue;
  patch: IssueUpdate;
  commentBody: string;
  clientRequestId?: string;
  reviewInteractionId: string;
  actor: {
    agentId: string;
    runId: string;
    agentApiKeyId?: string | null;
    responsibleUserId?: string | null;
  };
  authorizationReason: string;
  publications: ActivityPublication[];
}) {
  const { db, tx, existing, actor } = input;
  if (existing.status !== "in_progress" || input.patch.status !== "in_review") {
    throw conflict("Review handoff requires an in-progress task");
  }
  if (!input.commentBody.trim() || /@|https?:\/\//i.test(input.commentBody)) {
    throw badRequest("Review handoff requires a plain comment without mentions or external links");
  }
  const reviewInteractionId = await assertInReviewReviewPath(tx, {
    existing, updateFields: { status: "in_review" },
    actorType: "agent", actorId: actor.agentId, actorAgentId: actor.agentId,
    actorRunId: actor.runId, reviewInteractionId: input.reviewInteractionId,
  });
  if (reviewInteractionId !== input.reviewInteractionId) {
    throw conflict("The designated review interaction is no longer pending");
  }

  const references = issueReferenceService(db);
  const previousReferences = await references.listIssueReferenceSummary(existing.id, tx);
  const updated = await issueService(db).update(existing.id, input.patch, tx);
  if (!updated) throw notFound("Issue not found");
  const comment = await issueService(db).addComment(existing.id, input.commentBody,
    { agentId: actor.agentId, runId: actor.runId,
      onBehalfOfUserId: actor.responsibleUserId ?? undefined },
    { authorizationReason: input.authorizationReason,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      sourceTrust: await resolveActorSourceTrustForIssue({
        db: tx, issue: updated,
        actor: { actorType: "agent", actorId: actor.agentId,
          agentId: actor.agentId, runId: actor.runId },
      }) }, tx);
  await references.syncComment(comment.id, tx);
  const nextReferences = await references.listIssueReferenceSummary(existing.id, tx);
  const referenceDiff = references.diffIssueReferenceSummary(previousReferences, nextReferences);
  const relation = (value: { id: string; identifier: string | null; title: string }) => ({
    id: value.id, identifier: value.identifier, title: value.title,
  });
  const referenceDetails = {
    ...(referenceDiff.addedReferencedIssues.length
      ? { addedReferencedIssues: referenceDiff.addedReferencedIssues.map(relation) } : {}),
    ...(referenceDiff.removedReferencedIssues.length
      ? { removedReferencedIssues: referenceDiff.removedReferencedIssues.map(relation) } : {}),
    ...(referenceDiff.currentReferencedIssues.length
      ? { currentReferencedIssues: referenceDiff.currentReferencedIssues.map(relation) } : {}),
  };
  const changes = updated.changes ?? {};
  await logActivity(tx, {
    companyId: updated.companyId, actorType: "agent", actorId: actor.agentId,
    agentId: actor.agentId, runId: actor.runId, agentApiKeyId: actor.agentApiKeyId ?? null,
    responsibleUserIdOverride: actor.responsibleUserId ?? null,
    action: "issue.updated", entityType: "issue", entityId: updated.id,
    details: {
      status: "in_review", identifier: updated.identifier,
      authorizationReason: input.authorizationReason,
      changes, reviewInteractionId: input.reviewInteractionId,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      source: "comment",
      _previous: Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.from])),
    },
  }, input.publications);
  await logActivity(tx, {
    companyId: updated.companyId, actorType: "agent", actorId: actor.agentId,
    agentId: actor.agentId, runId: actor.runId, agentApiKeyId: actor.agentApiKeyId ?? null,
    responsibleUserIdOverride: actor.responsibleUserId ?? null,
    action: "issue.comment_added", entityType: "issue", entityId: updated.id,
    details: {
      commentId: comment.id, bodySnippet: comment.body.slice(0, 120),
      identifier: updated.identifier, issueTitle: updated.title,
      authorizationReason: input.authorizationReason, updated: true,
      ...referenceDetails,
    },
  }, input.publications);
  return { issue: updated, comment };
}
