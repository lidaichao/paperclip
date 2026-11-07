import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests, agents, companies, heartbeatRuns, issueCompletionReviews,
  issueThreadInteractions, issues, localAgentRunLeases, localDefectRepairHandoffs,
  workRecordIssueLinks, workRecordQualityCycles, workRecordQualityItems, workRecords,
} from "@paperclipai/db";
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { HttpError, conflict } from "../errors.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { issueService } from "./issues.js";
import { ISSUE_COMPLETION_REVIEW_TARGET_KEY } from "./issue-completion-review-contract.js";

export const CLIENT_PULL_DEFECT_QA_WAKE_REASON = "independent_defect_qa";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function defectQaWakeKey(handoffId: string, generation = 1) {
  return `defect-qa:${handoffId}${generation === 1 ? "" : `:${generation}`}`;
}

type Agent = typeof agents.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;

/** The aggregate lock matches recordQaVerdict's cycle→item→issue order. */
async function loadLockedQa(tx: Db, companyId: string, handoffId: string,
  qaAgentId: string, claimedRunId: string | null) {
  const [scope] = await tx.select().from(localDefectRepairHandoffs).where(and(
    eq(localDefectRepairHandoffs.id, handoffId),
    eq(localDefectRepairHandoffs.companyId, companyId),
  )).limit(1);
  if (!scope || scope.qaAgentId !== qaAgentId || scope.state !== "submitted") return null;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`work-record-quality:${companyId}:${scope.recordId}`}, 0))`);
  const [cycle] = await tx.select().from(workRecordQualityCycles).where(and(
    eq(workRecordQualityCycles.id, scope.cycleId),
    eq(workRecordQualityCycles.companyId, companyId),
  )).for("update");
  const [repair] = await tx.select().from(workRecordQualityItems)
    .where(eq(workRecordQualityItems.id, scope.repairItemId)).for("update");
  const [qa] = await tx.select().from(workRecordQualityItems)
    .where(eq(workRecordQualityItems.id, scope.qaItemId)).for("update");
  const [issue] = await tx.select().from(issues).where(and(
    eq(issues.id, scope.issueId), eq(issues.companyId, companyId),
  )).for("update");
  const [handoff] = await tx.select().from(localDefectRepairHandoffs)
    .where(eq(localDefectRepairHandoffs.id, handoffId)).for("update");
  const [record] = await tx.select().from(workRecords).where(and(
    eq(workRecords.id, scope.recordId), eq(workRecords.companyId, companyId),
  ));
  const [link] = await tx.select().from(workRecordIssueLinks).where(and(
    eq(workRecordIssueLinks.companyId, companyId),
    eq(workRecordIssueLinks.recordId, scope.recordId),
    eq(workRecordIssueLinks.issueId, scope.issueId),
    eq(workRecordIssueLinks.purpose, "primary"),
  )).limit(1);
  const [company] = await tx.select({ status: companies.status }).from(companies)
    .where(eq(companies.id, companyId));
  const [sourceRun] = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, companyId),
  ));
  const [sourceLease] = await tx.select().from(localAgentRunLeases)
    .where(eq(localAgentRunLeases.runId, scope.runId));
  const [oldReview] = await tx.select({ id: issueCompletionReviews.id })
    .from(issueCompletionReviews).where(and(
      eq(issueCompletionReviews.companyId, companyId),
      eq(issueCompletionReviews.issueId, scope.issueId),
      eq(issueCompletionReviews.state, "pending"),
    )).limit(1);
  const [oldCard] = await tx.select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, scope.issueId),
      eq(issueThreadInteractions.status, "pending"),
      sql`${issueThreadInteractions.payload}->'target'->>'key' = ${ISSUE_COMPLETION_REVIEW_TARGET_KEY}`,
    )).limit(1);
  const sourceReceipt = object(sourceRun?.resultJson?.localWorkerFinish);
  const participant = object(issue?.executionState?.currentParticipant);
  if (!handoff || handoff.state !== "submitted" || handoff.qaAgentId !== qaAgentId ||
    handoff.companyId !== scope.companyId || handoff.projectId !== scope.projectId ||
    handoff.issueId !== scope.issueId || handoff.recordId !== scope.recordId ||
    handoff.cycleId !== scope.cycleId || handoff.repairItemId !== scope.repairItemId ||
    handoff.qaItemId !== scope.qaItemId || handoff.runId !== scope.runId ||
    handoff.preparedCycleRevision !== scope.preparedCycleRevision ||
    handoff.submittedStatusVersion !== scope.submittedStatusVersion ||
    !cycle || cycle.projectId !== scope.projectId ||
    cycle.aggregateRecordId !== scope.recordId || cycle.kind !== "independent_defect" ||
    cycle.state !== "open" || cycle.qualityPhase !== "qa_retest" ||
    cycle.revision !== scope.preparedCycleRevision + 1 ||
    !repair || repair.cycleId !== cycle.id || repair.role !== "repair" ||
    repair.state !== "accepted" || repair.issueLinkId !== link?.id ||
    !qa || qa.cycleId !== cycle.id || qa.role !== "qa" || qa.state !== "active" ||
    qa.recordId !== scope.recordId || qa.defectRecordId !== scope.recordId ||
    qa.issueLinkId !== link?.id || !qa.required ||
    !record || record.kind !== "defect" || record.parentRecordId ||
    record.projectId !== scope.projectId || record.qaAssigneeAgentId !== qaAgentId ||
    record.dispatchState === "not_dispatched" || !link ||
    !issue || issue.projectId !== scope.projectId || issue.status !== "in_review" ||
    issue.statusVersion !== scope.submittedStatusVersion ||
    issue.assigneeAgentId !== qaAgentId || issue.executionRunId !== claimedRunId ||
    issue.conversationAgentId || issue.executionState?.status !== "pending" ||
    participant.type !== "agent" || participant.agentId !== qaAgentId ||
    !company || company.status !== "active" ||
    !sourceRun || sourceRun.status !== "succeeded" ||
    sourceRun.runtimeMode !== "client_pull" ||
    record.assigneeAgentId !== sourceRun.agentId ||
    !sourceLease || sourceLease.runId !== sourceRun.id ||
    sourceLease.issueId !== issue.id || sourceLease.agentId !== sourceRun.agentId ||
    !sourceLease.releasedAt || !sourceLease.stopAcknowledgedAt ||
    sourceLease.outcome !== "succeeded" ||
    sourceReceipt.defectHandoffId !== handoff.id ||
    sourceReceipt.defectHandoffDisposition !== "submitted" ||
    sourceReceipt.defectSubmittedStatusVersion !== issue.statusVersion ||
    oldReview || oldCard) return null;
  return { handoff, cycle, qa, issue, sourceRun };
}

/** The QA bridge's normal claim poll is the durable delivery trigger. */
export async function deliverPendingDefectQaForAgent(tx: Db, agent: Agent) {
  let cursor: { createdAt: Date; id: string } | null = null;
  while (true) {
    const candidates: Array<{ id: string; createdAt: Date }> = await tx.select({
      id: localDefectRepairHandoffs.id,
      createdAt: localDefectRepairHandoffs.createdAt,
    }).from(localDefectRepairHandoffs).where(and(
      eq(localDefectRepairHandoffs.companyId, agent.companyId),
      eq(localDefectRepairHandoffs.qaAgentId, agent.id),
      eq(localDefectRepairHandoffs.state, "submitted"),
      isNull(localDefectRepairHandoffs.qaWakeupRequestId),
      cursor ? or(gt(localDefectRepairHandoffs.createdAt, cursor.createdAt),
        and(eq(localDefectRepairHandoffs.createdAt, cursor.createdAt),
          gt(localDefectRepairHandoffs.id, cursor.id))) : undefined,
    )).orderBy(asc(localDefectRepairHandoffs.createdAt),
      asc(localDefectRepairHandoffs.id)).limit(20);
    if (candidates.length === 0) return;
    for (const candidate of candidates) {
    const ready = await loadLockedQa(tx, agent.companyId, candidate.id, agent.id, null);
    if (!ready || ready.handoff.qaWakeupRequestId || ready.handoff.qaDeliveredAt) continue;
    const key = defectQaWakeKey(ready.handoff.id, ready.handoff.qaDeliveryGeneration);
    const [occupied] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, agent.companyId),
        eq(agentWakeupRequests.idempotencyKey, key))).limit(1);
    if (occupied) throw conflict("Independent defect QA wake key is occupied");
    const payload = { issueId: ready.issue.id, handoffId: ready.handoff.id,
      cycleId: ready.cycle.id, qaItemId: ready.qa.id,
      sourceRunId: ready.sourceRun.id,
      issueStatusVersion: ready.issue.statusVersion,
      cycleRevision: ready.cycle.revision, qaItemRevision: ready.qa.revision,
      deliveryGeneration: ready.handoff.qaDeliveryGeneration };
    const [wake] = await tx.insert(agentWakeupRequests).values({
      id: randomUUID(), companyId: agent.companyId, agentId: agent.id,
      source: "automation", triggerDetail: "system",
      reason: CLIENT_PULL_DEFECT_QA_WAKE_REASON,
      payload, status: "queued", idempotencyKey: key,
      requestedByActorType: "agent", requestedByActorId: ready.sourceRun.agentId,
    }).returning();
    const [run] = await tx.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: agent.companyId, agentId: agent.id,
      status: "queued", runtimeMode: "client_pull",
      invocationSource: "automation", triggerDetail: "system",
      responsibleUserId: ready.sourceRun.responsibleUserId,
      wakeupRequestId: wake.id,
      contextSnapshot: { ...payload, taskId: ready.issue.id,
        wakeReason: CLIENT_PULL_DEFECT_QA_WAKE_REASON,
        source: "work_record.independent_defect_qa", forceFreshSession: true },
    }).returning();
    await tx.update(agentWakeupRequests).set({ runId: run.id, updatedAt: sql`now()` })
      .where(eq(agentWakeupRequests.id, wake.id));
    const [delivered] = await tx.update(localDefectRepairHandoffs).set({
      qaWakeupRequestId: wake.id, qaDeliveredAt: sql`now()`,
    }).where(and(eq(localDefectRepairHandoffs.id, ready.handoff.id),
      isNull(localDefectRepairHandoffs.qaWakeupRequestId))).returning();
    if (!delivered) throw conflict("Independent defect QA delivery changed");
    }
    const last = candidates[candidates.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (candidates.length < 20) return;
  }
}

export async function assertDefectQaClaimCandidate(db: Db, tx: Db, input: {
  agent: Agent; run: Run;
}) {
  const { agent, run } = input;
  const context = object(run.contextSnapshot);
  if (run.status !== "queued" || run.runtimeMode !== "client_pull" ||
    run.companyId !== agent.companyId || run.agentId !== agent.id ||
    context.wakeReason !== CLIENT_PULL_DEFECT_QA_WAKE_REASON ||
    typeof context.handoffId !== "string" || !run.wakeupRequestId) {
    return { kind: "stale" as const };
  }
  const ready = await loadLockedQa(tx, agent.companyId, context.handoffId, agent.id, null);
  if (!ready) return { kind: "stale" as const };
  const [wake] = await tx.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, run.wakeupRequestId)).for("update");
  const payload = object(wake?.payload);
  if (!wake || !ready.handoff.qaDeliveredAt ||
    ready.handoff.qaWakeupRequestId !== wake.id ||
    wake.companyId !== agent.companyId || wake.agentId !== agent.id ||
    wake.runId !== run.id || wake.status !== "queued" ||
    wake.reason !== CLIENT_PULL_DEFECT_QA_WAKE_REASON ||
    wake.idempotencyKey !== defectQaWakeKey(ready.handoff.id,
      ready.handoff.qaDeliveryGeneration) ||
    context.issueId !== ready.issue.id || context.cycleId !== ready.cycle.id ||
    context.qaItemId !== ready.qa.id || context.sourceRunId !== ready.sourceRun.id ||
    context.issueStatusVersion !== ready.issue.statusVersion ||
    context.cycleRevision !== ready.cycle.revision ||
    context.qaItemRevision !== ready.qa.revision ||
    (context.deliveryGeneration ?? 1) !== ready.handoff.qaDeliveryGeneration ||
    payload.issueId !== context.issueId || payload.handoffId !== context.handoffId ||
    payload.cycleId !== context.cycleId || payload.qaItemId !== context.qaItemId ||
    payload.sourceRunId !== context.sourceRunId ||
    payload.issueStatusVersion !== context.issueStatusVersion ||
    payload.cycleRevision !== context.cycleRevision ||
    payload.qaItemRevision !== context.qaItemRevision ||
    (payload.deliveryGeneration ?? 1) !== (context.deliveryGeneration ?? 1)) {
    return { kind: "stale" as const };
  }
  const [otherRunning] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, agent.companyId),
      eq(heartbeatRuns.status, "running"), ne(heartbeatRuns.id, run.id),
       sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${ready.issue.id}`)).limit(1);
  const [otherLease] = await tx.select({ runId: localAgentRunLeases.runId })
    .from(localAgentRunLeases).where(and(
      eq(localAgentRunLeases.companyId, agent.companyId),
      eq(localAgentRunLeases.issueId, ready.issue.id),
      isNull(localAgentRunLeases.releasedAt),
    )).limit(1);
  const dependency = await issueService(db).getDependencyReadiness(ready.issue.id, tx);
  if (otherRunning || otherLease || !dependency.isDependencyReady ||
    await getExecutionBlocker(tx, agent.companyId, ready.issue.id)) {
    return { kind: "blocked" as const };
  }
  const { heartbeatService } = await import("./heartbeat.js");
  try {
    await heartbeatService(db).assertClientPullClaimAdmission(run, agent, ready.issue, tx);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) return { kind: "blocked" as const };
    throw error;
  }
  return { kind: "ready" as const, issue: ready.issue, wake };
}

async function markDefectQaAttention(tx: Db, run: Run, reason: string) {
  const handoffId = object(run.contextSnapshot).handoffId;
  if (typeof handoffId !== "string") return false;
  const [scope] = await tx.select().from(localDefectRepairHandoffs).where(and(
    eq(localDefectRepairHandoffs.id, handoffId),
    eq(localDefectRepairHandoffs.companyId, run.companyId),
  ));
  if (!scope || scope.qaAgentId !== run.agentId) return false;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`work-record-quality:${run.companyId}:${scope.recordId}`}, 0))`);
  const [cycle] = await tx.select().from(workRecordQualityCycles)
    .where(eq(workRecordQualityCycles.id, scope.cycleId)).for("update");
  const [issue] = await tx.select().from(issues)
    .where(eq(issues.id, scope.issueId)).for("update");
  const [handoff] = await tx.select().from(localDefectRepairHandoffs)
    .where(eq(localDefectRepairHandoffs.id, scope.id)).for("update");
  if (!handoff || handoff.qaWakeupRequestId !== run.wakeupRequestId ||
    handoff.qaAgentId !== run.agentId || handoff.issueId !== scope.issueId) return false;
  if (issue?.status === "in_review" && cycle?.state === "open" &&
    cycle.kind === "independent_defect" && cycle.aggregateRecordId === scope.recordId &&
    cycle.qualityPhase !== "attention_required") {
    await tx.update(workRecordQualityCycles).set({
      qualityPhase: "attention_required", reason,
      revision: cycle.revision + 1, updatedAt: new Date(),
    }).where(eq(workRecordQualityCycles.id, cycle.id));
    return true;
  }
  return cycle?.qualityPhase === "attention_required";
}

/** A stopped failed QA run gets one replacement; a second failure becomes visible. */
export async function settleFailedDefectQaRun(tx: Db, run: Run,
  lease: typeof localAgentRunLeases.$inferSelect) {
  const ready = await readClaimedDefectQaContext(tx, run, lease);
  if (ready && ready.handoff.qaDeliveryGeneration === 1) {
    const [retry] = await tx.update(localDefectRepairHandoffs).set({
      qaWakeupRequestId: null, qaDeliveredAt: null, qaDeliveryGeneration: 2,
    }).where(and(eq(localDefectRepairHandoffs.id, ready.handoff.id),
      eq(localDefectRepairHandoffs.qaWakeupRequestId, run.wakeupRequestId!)))
      .returning({ id: localDefectRepairHandoffs.id });
    if (!retry) throw conflict("Independent defect QA retry gate changed");
    return { disposition: "retry_ready" as const };
  }
  if (!await markDefectQaAttention(tx, run, ready
    ? "qa_local_retry_exhausted" : "qa_local_context_changed")) {
    throw conflict("Independent defect QA failure cannot be reconciled to a visible quality state");
  }
  return { disposition: "attention_required" as const };
}

/** Retire a permanently stale queued run so it cannot monopolize the inbox. */
export async function retireStaleDefectQaQueuedRun(tx: Db, run: Run) {
  await markDefectQaAttention(tx, run, "qa_local_queue_stale");
  const [retired] = await tx.update(heartbeatRuns).set({
    status: "cancelled", finishedAt: sql`now()`, updatedAt: sql`now()`,
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
    .returning({ id: heartbeatRuns.id });
  if (!retired) throw conflict("Independent defect QA queued run changed before retirement");
  if (run.wakeupRequestId) {
    await tx.update(agentWakeupRequests).set({
      status: "cancelled", finishedAt: sql`now()`,
      error: "independent_defect_qa_stale", updatedAt: sql`now()`,
    }).where(and(eq(agentWakeupRequests.id, run.wakeupRequestId),
      eq(agentWakeupRequests.status, "queued")));
  }
}

export async function readClaimedDefectQaContext(tx: Db, run: Run,
  lease: typeof localAgentRunLeases.$inferSelect) {
  const context = object(run.contextSnapshot);
  if (context.wakeReason !== CLIENT_PULL_DEFECT_QA_WAKE_REASON ||
    typeof context.handoffId !== "string" || !run.wakeupRequestId) return null;
  const ready = await loadLockedQa(tx, run.companyId, context.handoffId,
    run.agentId, run.id);
  const [wake] = await tx.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, run.wakeupRequestId)).for("update");
  const payload = object(wake?.payload);
  if (!ready || !wake || lease.issueId !== ready.issue.id ||
    ready.handoff.qaWakeupRequestId !== wake.id ||
    wake.runId !== run.id || wake.status !== "claimed" ||
    wake.agentId !== run.agentId ||
    wake.companyId !== run.companyId || wake.source !== "automation" ||
    wake.triggerDetail !== "system" ||
    wake.reason !== CLIENT_PULL_DEFECT_QA_WAKE_REASON ||
    wake.idempotencyKey !== defectQaWakeKey(ready.handoff.id,
      ready.handoff.qaDeliveryGeneration) ||
    context.issueId !== ready.issue.id || context.cycleId !== ready.cycle.id ||
    context.qaItemId !== ready.qa.id || context.sourceRunId !== ready.sourceRun.id ||
    context.issueStatusVersion !== ready.issue.statusVersion ||
    context.cycleRevision !== ready.cycle.revision ||
    context.qaItemRevision !== ready.qa.revision ||
    (context.deliveryGeneration ?? 1) !== ready.handoff.qaDeliveryGeneration ||
    payload.issueId !== context.issueId || payload.handoffId !== context.handoffId ||
    payload.cycleId !== context.cycleId || payload.qaItemId !== context.qaItemId ||
    payload.sourceRunId !== context.sourceRunId ||
    payload.issueStatusVersion !== context.issueStatusVersion ||
    payload.cycleRevision !== context.cycleRevision ||
    payload.qaItemRevision !== context.qaItemRevision ||
    (payload.deliveryGeneration ?? 1) !== (context.deliveryGeneration ?? 1)) return null;
  return ready;
}

export async function defectQaRunChanged(tx: Db, run: Run,
  lease: typeof localAgentRunLeases.$inferSelect) {
  if (object(run.contextSnapshot).wakeReason !== CLIENT_PULL_DEFECT_QA_WAKE_REASON) return false;
  return !(await readClaimedDefectQaContext(tx, run, lease));
}
