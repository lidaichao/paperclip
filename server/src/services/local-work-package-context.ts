import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns, issueComments, issues, localAgentRunLeases,
  localIssueCompletionCommands, workRecordIssueLinks, workRecordQualityCycles,
  workRecordQualityItems, workRecordQualityVerdicts, workRecords,
} from "@paperclipai/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { badRequest, conflict, forbidden } from "../errors.js";
import { assertBoundLocalDevice } from "./local-agent-device-bindings.js";
import type { LocalRunOwner } from "./local-agent-run-leases.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read only the currently claimed PO package and its current quality cycle. */
export function localWorkPackageContextService(db: Db) {
  async function read(input: LocalRunOwner, actor: Express.Request["actor"]) {
    if (!UUID.test(input.runId) || !UUID.test(input.leaseId) ||
      !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      !/^[a-zA-Z0-9._:-]{8,128}$/.test(input.deviceId)) {
      throw badRequest("Invalid local run lease identity");
    }
    if (actor.type !== "agent" || actor.source !== "agent_key" ||
      actor.companyId !== input.companyId || actor.agentId !== input.agentId ||
      actor.keyId !== input.keyId || (actor.runId && actor.runId !== input.runId)) {
      throw forbidden("An agent's own local PO run is required");
    }
    const result = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "client_pull"),
      )).for("update");
      const [lease] = await tx.select().from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.runId, input.runId),
        eq(localAgentRunLeases.companyId, input.companyId),
        eq(localAgentRunLeases.agentId, input.agentId),
      )).for("update");
      const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
        .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId));
      if (!run || !lease || run.status !== "running" || !live?.live ||
        lease.deviceId !== input.deviceId || lease.deviceKeyId !== input.keyId ||
        lease.leaseId !== input.leaseId || lease.generation !== input.generation ||
        lease.cancelRequestedAt || lease.releasedAt ||
        run.contextSnapshot?.issueId !== lease.issueId) {
        throw conflict("Local PO run lease is unavailable");
      }
      await assertBoundLocalDevice(tx as unknown as Db, input);
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId),
      )).for("update");
      if (!issue || issue.assigneeAgentId !== input.agentId ||
        issue.executionRunId !== input.runId || issue.status !== "in_progress" ||
        issue.conversationAgentId) {
        throw conflict("Local PO no longer owns the active package task");
      }
      const [linked] = await tx.select({ link: workRecordIssueLinks, record: workRecords })
        .from(workRecordIssueLinks).innerJoin(workRecords, and(
          eq(workRecords.companyId, workRecordIssueLinks.companyId),
          eq(workRecords.id, workRecordIssueLinks.recordId),
        )).where(and(
          eq(workRecordIssueLinks.companyId, input.companyId),
          eq(workRecordIssueLinks.issueId, issue.id),
          eq(workRecordIssueLinks.purpose, "primary"),
        )).limit(1);
      if (!linked || linked.record.kind !== "plan" || linked.record.parentRecordId ||
        linked.record.assigneeAgentId !== input.agentId ||
        linked.record.projectId !== issue.projectId ||
        linked.record.dispatchState === "not_dispatched") {
        throw forbidden("Only the assigned, dispatched parent PO can read this package");
      }
      const [cycle] = await tx.select().from(workRecordQualityCycles).where(and(
        eq(workRecordQualityCycles.companyId, input.companyId),
        eq(workRecordQualityCycles.projectId, linked.record.projectId),
        eq(workRecordQualityCycles.aggregateRecordId, linked.record.id),
        eq(workRecordQualityCycles.kind, "package_acceptance"),
        eq(workRecordQualityCycles.state, "open"),
      )).limit(1);
      if (!cycle) throw conflict("No open package acceptance cycle");
      const items = await tx.select().from(workRecordQualityItems).where(and(
        eq(workRecordQualityItems.companyId, input.companyId),
        eq(workRecordQualityItems.projectId, linked.record.projectId),
        eq(workRecordQualityItems.cycleId, cycle.id),
      ));
      const poItems = items.filter((item) => item.role === "po" && item.recordId === linked.record.id);
      if (poItems.length !== 1 || !["ready", "active", "submitted"].includes(poItems[0]!.state)) {
        throw conflict("Package is not ready for PO acceptance");
      }
      const memberIds = [...new Set(items.filter((item) => item.role !== "po")
        .map((item) => item.recordId))];
      const members = memberIds.length ? await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, input.companyId),
        eq(workRecords.projectId, linked.record.projectId),
        inArray(workRecords.id, memberIds),
      )) : [];
      const links = memberIds.length ? await tx.select().from(workRecordIssueLinks).where(and(
        eq(workRecordIssueLinks.companyId, input.companyId),
        eq(workRecordIssueLinks.projectId, linked.record.projectId),
        inArray(workRecordIssueLinks.recordId, memberIds),
        eq(workRecordIssueLinks.purpose, "primary"),
      )) : [];
      const memberIssueIds = links.map((link) => link.issueId);
      const memberIssues = memberIssueIds.length ? await tx.select().from(issues).where(and(
        eq(issues.companyId, input.companyId), inArray(issues.id, memberIssueIds),
      )) : [];
      const completed = memberIds.length ? await tx.select({
        recordId: localIssueCompletionCommands.recordId,
        issueId: localIssueCompletionCommands.issueId,
        commentId: localIssueCompletionCommands.commentId,
      }).from(localIssueCompletionCommands).where(and(
        eq(localIssueCompletionCommands.companyId, input.companyId),
        inArray(localIssueCompletionCommands.recordId, memberIds),
        eq(localIssueCompletionCommands.state, "completed"),
        gte(localIssueCompletionCommands.createdAt, cycle.createdAt),
      )).orderBy(desc(localIssueCompletionCommands.createdAt)) : [];
      const commentIds = completed.map((row) => row.commentId)
        .filter((id): id is string => id !== null);
      const comments = commentIds.length ? await tx.select({
        id: issueComments.id, issueId: issueComments.issueId, body: issueComments.body,
      }).from(issueComments).where(and(
        eq(issueComments.companyId, input.companyId), inArray(issueComments.id, commentIds),
      )) : [];
      const verdicts = await tx.select().from(workRecordQualityVerdicts).where(and(
        eq(workRecordQualityVerdicts.companyId, input.companyId),
        eq(workRecordQualityVerdicts.projectId, linked.record.projectId),
        eq(workRecordQualityVerdicts.cycleId, cycle.id),
      ));
      return {
        issue: { id: issue.id, identifier: issue.identifier, title: issue.title,
          status: issue.status, statusVersion: issue.statusVersion },
        package: { id: linked.record.id, title: linked.record.title,
          description: linked.record.description, revision: linked.record.revision },
        cycle: { id: cycle.id, number: cycle.cycleNumber, revision: cycle.revision,
          qualityPhase: cycle.qualityPhase, poItemId: poItems[0]!.id },
        members: items.filter((item) => item.role !== "po").map((item) => {
          const record = members.find((row) => row.id === item.recordId);
          const link = links.find((row) => row.recordId === item.recordId);
          const childIssue = memberIssues.find((row) => row.id === link?.issueId);
          const receipt = completed.find((row) => row.recordId === item.recordId &&
            row.issueId === childIssue?.id);
          const comment = comments.find((row) => row.id === receipt?.commentId &&
            row.issueId === childIssue?.id);
          if (!record || !link || !childIssue) throw conflict("Package evidence changed");
          return { itemId: item.id, role: item.role, required: item.required,
            state: item.state, recordId: record.id, title: record.title,
            description: record.description, assigneeAgentId: record.assigneeAgentId,
            issueId: childIssue.id, issueIdentifier: childIssue.identifier,
            issueStatus: childIssue.status, completionSummary: comment?.body ?? null };
        }),
        verdicts: verdicts.map((row) => ({ itemId: row.itemId,
          outcome: row.outcome, reason: row.reason, evidenceRefs: row.evidenceRefs })),
      };
    });
    const redaction = createRunSecretRedactionRegistry(db);
    let safe = await redaction.redactForIssue(input.companyId, result.issue.id, result);
    for (const member of result.members) {
      safe = await redaction.redactForIssue(input.companyId, member.issueId, safe);
    }
    return safe;
  }
  return { read };
}
