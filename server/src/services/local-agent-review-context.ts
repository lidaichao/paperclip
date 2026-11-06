import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issues, localAgentRunLeases } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { conflict, forbidden } from "../errors.js";
import { assertBoundLocalDevice } from "./local-agent-device-bindings.js";
import type { LocalRunOwner } from "./local-agent-run-leases.js";
import { assertClientPullReviewEventContext } from "./local-agent-review-claim.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A narrow, lease-fenced read for the non-assignee review worker. */
export function localAgentReviewContextService(db: Db) {
  async function read(input: LocalRunOwner, actor: Express.Request["actor"]) {
    if (!UUID.test(input.runId) || !UUID.test(input.leaseId) ||
      !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      actor.type !== "agent" || actor.source !== "agent_key" ||
      actor.companyId !== input.companyId || actor.agentId !== input.agentId ||
      actor.keyId !== input.keyId || (actor.runId && actor.runId !== input.runId)) {
      throw forbidden("Authenticated local reviewer lease is required");
    }
    const result = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.runtimeMode, "client_pull"),
      )).for("update");
      const [lease] = await tx.select().from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.runId, input.runId),
        eq(localAgentRunLeases.companyId, input.companyId),
        eq(localAgentRunLeases.agentId, input.agentId),
      )).for("update");
      if (!run || !lease || run.status !== "running" ||
        lease.deviceId !== input.deviceId || lease.deviceKeyId !== input.keyId ||
        lease.leaseId !== input.leaseId || lease.generation !== input.generation ||
        lease.cancelRequestedAt || lease.releasedAt) {
        throw conflict("Dedicated reviewer lease is unavailable");
      }
      await assertBoundLocalDevice(tx as unknown as Db, input);
      const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
        .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, run.id));
      if (!live?.live) throw conflict("Dedicated reviewer lease expired");
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId),
      )).for("update");
      if (!issue) throw conflict("Dedicated review issue is unavailable");
      const { review, card } = await assertClientPullReviewEventContext(
        tx as unknown as Db, { run, issue });
      const prompt = "prompt" in card.payload ? card.payload.prompt : null;
      if (typeof prompt !== "string" || !prompt.trim()) {
        throw conflict("Dedicated review prompt is unavailable");
      }
      const comments = await tx.select({ body: issueComments.body }).from(issueComments).where(and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, issue.id),
        eq(issueComments.createdByRunId, review.sourceRunId),
        eq(issueComments.authorAgentId, review.sourceAgentId),
        eq(issueComments.clientRequestId, review.requestId),
      )).limit(2);
      if (comments.length !== 1 || !comments[0]?.body) {
        throw conflict("Dedicated review handoff summary is unavailable");
      }
      return {
        issue: { id: issue.id, companyId: issue.companyId,
          projectId: issue.projectId, identifier: issue.identifier,
          title: issue.title, description: issue.description,
          priority: issue.priority, status: issue.status,
          statusVersion: issue.statusVersion,
          assigneeAgentId: issue.assigneeAgentId },
        review: { id: review.id, interactionId: card.id,
          sourceRunId: review.sourceRunId,
          sourceAgentId: review.sourceAgentId,
          reviewerAgentId: review.reviewerAgentId,
          issueStatusVersion: review.issueStatusVersion,
          prompt, handoffSummary: comments[0].body },
      };
    });
    return createRunSecretRedactionRegistry(db)
      .redactForIssue(input.companyId, result.issue.id, result);
  }
  return { read };
}
