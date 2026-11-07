import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  workRecords,
  workRecordDispatchBatchItems,
  workRecordDispatchBatches,
  workRecordQaCoverageSnapshots,
  workRecordExecutionHolds,
  workRecordExecutionIntents,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecordQualityCycles,
  workRecordQualityItems,
  workRecordQualityLinks,
  workRecordQualityVerdicts,
} from "@paperclipai/db";
import { reconcileCandidatesIndependently } from "./work-record-candidate-scan.js";
import {
  classifyWorkRecordCommandReplay,
  type LinkWorkPackageDefect,
  type RecordPoQualityVerdict,
  type RecordQaQualityVerdict,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "./issue-execution-policy.js";
import { issueService, listUnfinalizedExecutionWorkspaceIds } from "./issues.js";
import { resolveWorkRecordWorkflowV2Rollout } from "./work-record-workflow-v2-rollout.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Actor = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

export interface WorkRecordQualityOptions {
  writesEnabled?: boolean;
  maxReviewRounds?: number;
}

function details(code: string, extra: Record<string, unknown> = {}) {
  return { code, workflowVersion: 2, ...extra };
}

function aggregateLockKey(companyId: string, aggregateRecordId: string) {
  return `work-record-quality:${companyId}:${aggregateRecordId}`;
}

export async function lockWorkRecordQualityAggregate(tx: DbTransaction,
  companyId: string, aggregateRecordId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${aggregateLockKey(companyId, aggregateRecordId)}, 0))`);
}

export function workRecordQualityService(db: Db, options: WorkRecordQualityOptions = {}) {
  const issueSvc = issueService(db);
  const rollout = resolveWorkRecordWorkflowV2Rollout({ writesEnabled: options.writesEnabled });
  const writesEnabled = rollout.globalEnabled;
  const maxReviewRounds = options.maxReviewRounds ?? 3;

  function rolloutScopePredicate() {
    if (rollout.allScopes) return undefined;
    if (rollout.scopes.length === 0) return sql`false`;
    return or(...rollout.scopes.map((scope) => and(
      eq(workRecordQualityCycles.companyId, scope.companyId),
      eq(workRecordQualityCycles.projectId, scope.projectId),
    )));
  }

  function assertWritesEnabled(companyId: string, projectId: string) {
    const decision = rollout.decision(companyId, projectId);
    if (!decision.scopeEnabled) {
      throw forbidden(
        decision.globalEnabled
          ? "Work-record workflow v2 writes are not approved for this cohort"
          : "Work-record workflow v2 writes are disabled",
        details(decision.globalEnabled
          ? "work_record_workflow_v2_scope_denied"
          : "work_record_workflow_v2_disabled", { rollout: decision.reason }),
      );
    }
  }

  function assertRole(actor: Actor, expectedAgentId: string | null, role: "PO" | "QA") {
    if (actor.actorType === "user") return;
    if (actor.actorType !== "agent" || !expectedAgentId || actor.agentId !== expectedAgentId) {
      throw forbidden(`${role} quality command is restricted to the current ${role}`, details(
        "work_record_workflow_role_denied",
        { role },
      ));
    }
  }

  async function currentView(companyId: string, projectId: string, aggregateRecordId: string) {
    const aggregate = await db.select().from(workRecords).where(and(
      eq(workRecords.companyId, companyId),
      eq(workRecords.projectId, projectId),
      eq(workRecords.id, aggregateRecordId),
    )).then((rows) => rows[0] ?? null);
    if (!aggregate) throw notFound("Quality aggregate work record not found");
    const cycles = await db.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, companyId),
      eq(workRecordQualityCycles.projectId, projectId),
      eq(workRecordQualityCycles.aggregateRecordId, aggregateRecordId),
    )).orderBy(desc(workRecordQualityCycles.cycleNumber), desc(workRecordQualityCycles.createdAt));
    const cycle = cycles.find((candidate) => candidate.state === "open") ?? null;
    const cycleIds = cycles.map((candidate) => candidate.id);
    const historyItems = cycleIds.length > 0 ? await db.select().from(workRecordQualityItems).where(and(
      eq(workRecordQualityItems.companyId, companyId),
      inArray(workRecordQualityItems.cycleId, cycleIds),
    )).orderBy(asc(workRecordQualityItems.createdAt), asc(workRecordQualityItems.id)) : [];
    const verdicts = cycleIds.length > 0 ? await db.select().from(workRecordQualityVerdicts).where(and(
      eq(workRecordQualityVerdicts.companyId, companyId),
      inArray(workRecordQualityVerdicts.cycleId, cycleIds),
    )).orderBy(asc(workRecordQualityVerdicts.createdAt), asc(workRecordQualityVerdicts.id)) : [];
    const items = cycle ? historyItems.filter((item) => item.cycleId === cycle.id) : [];
    const links = await db.select().from(workRecordQualityLinks).where(and(
      eq(workRecordQualityLinks.companyId, companyId),
      eq(workRecordQualityLinks.projectId, projectId),
      eq(workRecordQualityLinks.packageRecordId, aggregateRecordId),
    )).orderBy(asc(workRecordQualityLinks.createdAt), asc(workRecordQualityLinks.id));
    return {
      aggregate,
      cycle,
      items,
      verdicts: cycle ? verdicts.filter((verdict) => verdict.cycleId === cycle.id) : [],
      links,
      history: { cycles, items: historyItems, verdicts },
    };
  }

  async function nextCycleNumber(tx: DbTransaction, companyId: string, aggregateRecordId: string) {
    return tx.select({ value: sql<number>`coalesce(max(${workRecordQualityCycles.cycleNumber}), 0) + 1` })
      .from(workRecordQualityCycles)
      .where(and(
        eq(workRecordQualityCycles.companyId, companyId),
        eq(workRecordQualityCycles.aggregateRecordId, aggregateRecordId),
      ))
      .then((rows) => Number(rows[0]?.value ?? 1));
  }

  async function assertPackageMembers(
    tx: DbTransaction,
    companyId: string,
    projectId: string,
    packageRecordId: string,
    recordIds: string[],
  ) {
    const uniqueIds = [...new Set(recordIds)];
    if (uniqueIds.length === 0) return;
    const batch = await tx.select({ id: workRecordDispatchBatches.id }).from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, companyId),
      eq(workRecordDispatchBatches.projectId, projectId),
      eq(workRecordDispatchBatches.rootRecordId, packageRecordId),
      eq(workRecordDispatchBatches.scopeKind, "whole_package"),
      eq(workRecordDispatchBatches.state, "prepared"),
    )).orderBy(desc(workRecordDispatchBatches.createdAt), desc(workRecordDispatchBatches.id))
      .then((rows) => rows[0] ?? null);
    if (!batch) {
      throw unprocessable("Package quality target requires a prepared whole-package batch", details(
        "work_record_quality_target_invalid",
      ));
    }
    const members = await tx.select({ recordId: workRecordDispatchBatchItems.recordId })
      .from(workRecordDispatchBatchItems)
      .where(and(
        eq(workRecordDispatchBatchItems.companyId, companyId),
        eq(workRecordDispatchBatchItems.projectId, projectId),
        eq(workRecordDispatchBatchItems.batchId, batch.id),
        inArray(workRecordDispatchBatchItems.recordId, uniqueIds),
      ));
    if (new Set(members.map((member) => member.recordId)).size !== uniqueIds.length) {
      throw unprocessable("Quality target is outside the prepared package", details(
        "work_record_quality_target_invalid",
      ));
    }
  }

  async function primaryIssueForRecord(tx: DbTransaction, companyId: string, projectId: string, recordId: string) {
    return tx.select({
      link: workRecordIssueLinks,
      issue: issues,
    }).from(workRecordIssueLinks).innerJoin(issues, and(
      eq(issues.companyId, workRecordIssueLinks.companyId),
      eq(issues.id, workRecordIssueLinks.issueId),
    )).where(and(
      eq(workRecordIssueLinks.companyId, companyId),
      eq(workRecordIssueLinks.projectId, projectId),
      eq(workRecordIssueLinks.recordId, recordId),
      eq(workRecordIssueLinks.purpose, "primary"),
    )).then((rows) => rows[0] ?? null);
  }

  async function retireActiveIntents(tx: DbTransaction, companyId: string, issueId: string, reason: string) {
    const now = new Date();
    const rows = await tx.update(workRecordExecutionIntents).set({
      state: "succeeded",
      waitingReason: reason,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(workRecordExecutionIntents.companyId, companyId),
      eq(workRecordExecutionIntents.issueId, issueId),
      inArray(workRecordExecutionIntents.state, ["pending", "waiting_dependencies", "waiting_governance", "ready", "queued", "running", "failed"]),
    )).returning({ id: workRecordExecutionIntents.id });
    if (rows.length > 0) {
      await tx.update(workRecordOutbox).set({ state: "delivered", deliveredAt: now, updatedAt: now }).where(and(
        eq(workRecordOutbox.companyId, companyId),
        inArray(workRecordOutbox.executionIntentId, rows.map((row) => row.id)),
        ne(workRecordOutbox.state, "delivered"),
      ));
    }
  }

  async function createQualityIntent(tx: DbTransaction, input: {
    companyId: string;
    projectId: string;
    cycleNumber: number;
    itemId: string;
    recordId: string;
    issueId: string;
    issueStatusVersion: number;
    kind: "rework_release" | "qa_retest_release" | "po_acceptance_release";
  }) {
    const intentKey = `quality:${input.itemId}:${input.kind}:${input.cycleNumber}`;
    await tx.insert(workRecordExecutionIntents).values({
      companyId: input.companyId,
      projectId: input.projectId,
      recordId: input.recordId,
      issueId: input.issueId,
      batchItemId: null,
      qualityItemId: input.itemId,
      intentKey,
      requestPayloadDigest: intentKey,
      kind: input.kind,
      generation: input.cycleNumber,
      expectedIssueStatusVersion: input.issueStatusVersion,
      state: "waiting_dependencies",
      waitingReason: "quality_gate_pending",
    }).onConflictDoNothing();
  }

  async function replayVerdict(tx: DbTransaction, companyId: string, clientRequestId: string, payloadDigest: string) {
    const existing = await tx.select().from(workRecordQualityVerdicts).where(and(
      eq(workRecordQualityVerdicts.companyId, companyId),
      eq(workRecordQualityVerdicts.clientRequestId, clientRequestId),
    )).then((rows) => rows[0] ?? null);
    if (!existing) return null;
    const replay = classifyWorkRecordCommandReplay(existing.requestPayloadDigest, payloadDigest);
    if (replay.outcome === "conflict") {
      throw conflict("Client request key was already used with a different quality verdict", details(replay.code, {
        verdictId: existing.id,
      }));
    }
    return existing;
  }

  async function loadLockedCycleAndItem(tx: DbTransaction, input: {
    companyId: string;
    projectId: string;
    cycleId: string;
    itemId: string;
    expectedCycleRevision: number;
  }) {
    const cycle = await tx.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, input.companyId),
      eq(workRecordQualityCycles.projectId, input.projectId),
      eq(workRecordQualityCycles.id, input.cycleId),
    )).for("update").then((rows) => rows[0] ?? null);
    if (!cycle) throw notFound("Quality cycle not found");
    if (cycle.state !== "open" || cycle.revision !== input.expectedCycleRevision) {
      throw conflict("Quality cycle revision changed", details("work_record_workflow_stale_revision", {
        currentRevision: cycle.revision,
        state: cycle.state,
      }));
    }
    const item = await tx.select().from(workRecordQualityItems).where(and(
      eq(workRecordQualityItems.companyId, input.companyId),
      eq(workRecordQualityItems.projectId, input.projectId),
      eq(workRecordQualityItems.cycleId, cycle.id),
      eq(workRecordQualityItems.id, input.itemId),
    )).for("update").then((rows) => rows[0] ?? null);
    if (!item) throw notFound("Quality item not found");
    return { cycle, item };
  }

  async function reopenRecordForQuality(tx: DbTransaction, input: {
    companyId: string;
    projectId: string;
    record: typeof workRecords.$inferSelect;
    issueRow: typeof issues.$inferSelect;
    itemId: string;
    cycleNumber: number;
    kind: "rework_release" | "qa_retest_release" | "po_acceptance_release";
    recordBusinessStatus?: "todo" | "in_review";
    actor: Actor;
  }) {
    if (input.issueRow.executionRunId || input.issueRow.checkoutRunId) {
      throw conflict("Quality return requires the original task to be stopped", details("work_record_quality_not_ready", {
        issueId: input.issueRow.id,
      }));
    }
    if (input.issueRow.executionWorkspaceId) {
      const unfinalized = await listUnfinalizedExecutionWorkspaceIds(
        tx,
        input.companyId,
        [input.issueRow.executionWorkspaceId],
      );
      if (unfinalized.has(input.issueRow.executionWorkspaceId)) {
        throw conflict("Quality return requires the original workspace to be finalized", details(
          "work_record_quality_not_ready",
          { issueId: input.issueRow.id, reason: "delivery_sync_pending" },
        ));
      }
    }
    await retireActiveIntents(tx, input.companyId, input.issueRow.id, "quality_round_completed");
    const updated = await issueSvc.update(input.issueRow.id, {
      companyGuard: input.companyId,
      status: "todo",
      assigneeAgentId: input.record.assigneeAgentId,
      assigneeUserId: null,
      executionState: null,
      actorAgentId: input.actor.agentId ?? null,
      actorUserId: input.actor.userId ?? null,
    }, tx);
    if (!updated) throw notFound("Original quality task not found");
    await tx.update(workRecords).set({
      businessStatus: input.recordBusinessStatus ?? "todo",
      statusVersion: sql`${workRecords.statusVersion} + 1`,
      dispatchState: "linked",
      updatedAt: new Date(),
    }).where(and(eq(workRecords.companyId, input.companyId), eq(workRecords.id, input.record.id)));
    await createQualityIntent(tx, {
      companyId: input.companyId,
      projectId: input.projectId,
      cycleNumber: input.cycleNumber,
      itemId: input.itemId,
      recordId: input.record.id,
      issueId: updated.id,
      issueStatusVersion: updated.statusVersion,
      kind: input.kind,
    });
    return updated;
  }

  async function createPackageReworkCycle(tx: DbTransaction, input: {
    companyId: string;
    projectId: string;
    previousCycle: typeof workRecordQualityCycles.$inferSelect;
    targetRecordIds: string[];
    reason: string;
    actor: Actor;
  }) {
    const targetIds = [...new Set(input.targetRecordIds)];
    const targets = await tx.select().from(workRecords).where(and(
      eq(workRecords.companyId, input.companyId),
      eq(workRecords.projectId, input.projectId),
      inArray(workRecords.id, targetIds),
    ));
    if (targets.length !== targetIds.length || targets.some((record) => record.id === input.previousCycle.aggregateRecordId)) {
      throw unprocessable("PO return target must be an original package task", details("work_record_quality_target_invalid"));
    }
    await assertPackageMembers(
      tx,
      input.companyId,
      input.projectId,
      input.previousCycle.aggregateRecordId,
      targetIds,
    );
    const targetIssues = await Promise.all(targets.map((record) => primaryIssueForRecord(
      tx, input.companyId, input.projectId, record.id,
    )));
    if (targetIssues.some((row) => !row)) {
      throw unprocessable("Every quality return target requires its original primary issue", details("work_record_quality_target_invalid"));
    }
    const cycleNumber = await nextCycleNumber(tx, input.companyId, input.previousCycle.aggregateRecordId);
    const cycle = await tx.insert(workRecordQualityCycles).values({
      companyId: input.companyId,
      projectId: input.projectId,
      aggregateRecordId: input.previousCycle.aggregateRecordId,
      cycleNumber,
      kind: "package_rework",
      state: "open",
      qualityPhase: "waiting_fix",
      reason: input.reason,
      scopeDigest: input.previousCycle.scopeDigest,
      openedByAgentId: input.actor.agentId ?? null,
      openedByUserId: input.actor.userId ?? null,
    }).returning().then((rows) => rows[0]);
    const poItem = await tx.insert(workRecordQualityItems).values({
      companyId: input.companyId,
      projectId: input.projectId,
      cycleId: cycle.id,
      recordId: cycle.aggregateRecordId,
      role: "po",
      required: true,
      state: "waiting",
    }).returning().then((rows) => rows[0]);
    const links = await tx.select().from(workRecordQualityLinks).where(and(
      eq(workRecordQualityLinks.companyId, input.companyId),
      eq(workRecordQualityLinks.projectId, input.projectId),
      eq(workRecordQualityLinks.packageRecordId, cycle.aggregateRecordId),
      inArray(workRecordQualityLinks.repairRecordId, targetIds),
    ));
    const dispatchedBatch = await tx.select().from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, input.companyId),
      eq(workRecordDispatchBatches.projectId, input.projectId),
      eq(workRecordDispatchBatches.rootRecordId, cycle.aggregateRecordId),
      eq(workRecordDispatchBatches.scopeKind, "whole_package"),
      eq(workRecordDispatchBatches.scopeDigest, cycle.scopeDigest),
      eq(workRecordDispatchBatches.state, "prepared"),
    )).orderBy(desc(workRecordDispatchBatches.createdAt)).then((rows) => rows[0] ?? null);
    if (!dispatchedBatch) throw unprocessable("Original package dispatch snapshot is unavailable", details("work_record_quality_target_invalid"));
    const coverage = await tx.select().from(workRecordQaCoverageSnapshots).where(and(
      eq(workRecordQaCoverageSnapshots.companyId, input.companyId),
      eq(workRecordQaCoverageSnapshots.projectId, input.projectId),
      eq(workRecordQaCoverageSnapshots.batchId, dispatchedBatch.id),
      inArray(workRecordQaCoverageSnapshots.executionRecordId, targetIds),
    ));
    for (const target of targets) {
      if (target.packageQaRole === "execution" && !target.qaRetestExemptionReason &&
        !coverage.some((row) => row.executionRecordId === target.id)) {
        throw unprocessable("Original QA coverage snapshot is unavailable", details("work_record_quality_target_invalid", { recordId: target.id }));
      }
    }
    const defectRecordIds = [...new Set(links.map((link) => link.defectRecordId))];
    if (defectRecordIds.length > 0) {
      await tx.update(workRecords).set({
        businessStatus: "in_progress",
        statusVersion: sql`${workRecords.statusVersion} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(workRecords.companyId, input.companyId),
        eq(workRecords.projectId, input.projectId),
        inArray(workRecords.id, defectRecordIds),
        ne(workRecords.businessStatus, "in_progress"),
      ));
    }
    const qaRecordIds = [...new Set([
      ...coverage.map((row) => row.qaRecordId),
      ...links.map((link) => link.qaRecordId).filter((id): id is string => Boolean(id)),
    ])];
    const qaRecords = qaRecordIds.length > 0 ? await tx.select().from(workRecords).where(and(
      eq(workRecords.companyId, input.companyId),
      eq(workRecords.projectId, input.projectId),
      inArray(workRecords.id, qaRecordIds),
    )) : [];
    const qaById = new Map(qaRecords.map((record) => [record.id, record]));
    const targetById = new Map(targets.map((record) => [record.id, record]));
    for (const pair of coverage) {
      const execution = targetById.get(pair.executionRecordId);
      const qa = qaById.get(pair.qaRecordId);
      if (!execution || execution.packageQaRole !== "execution" || !qa || qa.packageQaRole !== "qa" || qa.parentRecordId !== execution.parentRecordId) {
        throw unprocessable("Original QA coverage no longer points to the same package", details("work_record_quality_target_invalid", { recordId: pair.executionRecordId, qaRecordId: pair.qaRecordId }));
      }
    }
    await assertPackageMembers(tx, input.companyId, input.projectId, cycle.aggregateRecordId, qaRecordIds);
    if (qaRecords.length !== qaRecordIds.length || qaRecords.some((record) =>
      record.businessStatus === "cancelled" || !record.assigneeAgentId
    )) throw unprocessable("Original QA task is unavailable for retest", details("work_record_quality_target_invalid", { qaRecordIds }));
    const qaPrimaries = await Promise.all(qaRecords.map((record) => primaryIssueForRecord(
      tx, input.companyId, input.projectId, record.id,
    )));
    if (qaPrimaries.some((row) => !row)) throw unprocessable("Original QA issue is unavailable for retest", details("work_record_quality_target_invalid", { qaRecordIds }));
    const originalBatchItems = await tx.select().from(workRecordDispatchBatchItems).where(and(
      eq(workRecordDispatchBatchItems.companyId, input.companyId),
      eq(workRecordDispatchBatchItems.projectId, input.projectId),
      eq(workRecordDispatchBatchItems.batchId, dispatchedBatch.id),
      inArray(workRecordDispatchBatchItems.recordId, [...new Set([...targetIds, ...qaRecordIds])]),
    ));
    const originalLinkByRecord = new Map(originalBatchItems.map((item) => [item.recordId, item.primaryIssueLinkId]));
    if ([...targetIssues, ...qaPrimaries].some((row) =>
      !row || row.issue.status === "cancelled" || originalLinkByRecord.get(row.link.recordId) !== row.link.id
    )) throw unprocessable("Original quality issue link changed or was cancelled", details("work_record_quality_target_invalid"));
    const repairItems = await tx.insert(workRecordQualityItems).values(targets.map((record) => ({
      companyId: input.companyId,
      projectId: input.projectId,
      cycleId: cycle.id,
      recordId: record.id,
      role: "repair" as const,
      required: true,
      state: "ready",
      issueLinkId: targetIssues.find((row) => row!.link.recordId === record.id)!.link.id,
    }))).returning();
    const qaItems = qaRecords.length > 0 ? await tx.insert(workRecordQualityItems).values(qaRecords.map((record) => ({
      companyId: input.companyId,
      projectId: input.projectId,
      cycleId: cycle.id,
      recordId: record.id,
      role: "qa" as const,
      required: true,
      state: "blocked",
    }))).returning() : [];
    for (const item of repairItems) {
      const record = targets.find((candidate) => candidate.id === item.recordId)!;
      const row = targetIssues.find((candidate) => candidate!.link.recordId === item.recordId)!;
      await reopenRecordForQuality(tx, {
        companyId: input.companyId,
        projectId: input.projectId,
        record,
        issueRow: row!.issue,
        itemId: item.id,
        cycleNumber,
        kind: "rework_release",
        actor: input.actor,
      });
    }
    return { cycle, poItem, repairItems, qaItems };
  }

  async function commitPoVerdictInTransaction(
    tx: DbTransaction,
    companyId: string,
    projectId: string,
    aggregateRecordId: string,
    input: RecordPoQualityVerdict,
    actor: Actor,
  ) {
    assertWritesEnabled(companyId, projectId);
      await lockWorkRecordQualityAggregate(tx, companyId, aggregateRecordId);
      const replay = await replayVerdict(tx, companyId, input.clientRequestId, input.requestPayloadDigest);
      if (replay) {
        const activeCycle = replay.outcome === "return"
          ? await tx.select({ id: workRecordQualityCycles.id }).from(workRecordQualityCycles).where(and(
              eq(workRecordQualityCycles.companyId, companyId),
              eq(workRecordQualityCycles.projectId, projectId),
              eq(workRecordQualityCycles.aggregateRecordId, aggregateRecordId),
              eq(workRecordQualityCycles.state, "open"),
            )).then((rows) => rows[0] ?? null)
          : null;
        return { verdict: replay, replayed: true, nextCycleId: activeCycle?.id ?? null };
      }
      const { cycle, item } = await loadLockedCycleAndItem(tx, {
        companyId, projectId, cycleId: input.cycleId, itemId: input.itemId,
        expectedCycleRevision: input.expectedCycleRevision,
      });
      if (cycle.aggregateRecordId !== aggregateRecordId || item.role !== "po" || item.recordId !== aggregateRecordId) {
        throw unprocessable("PO verdict is not bound to this package", details("work_record_quality_target_invalid"));
      }
      const aggregate = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.id, aggregateRecordId),
      )).then((rows) => rows[0] ?? null);
      if (!aggregate) throw notFound("Package work record not found");
      assertRole(actor, aggregate.assigneeAgentId, "PO");
      if (item.state !== "ready" && item.state !== "active" && item.state !== "submitted") {
        throw conflict("Package is not ready for PO verdict", details("work_record_quality_not_ready", { itemState: item.state }));
      }
      const verdict = await tx.insert(workRecordQualityVerdicts).values({
        companyId, projectId, cycleId: cycle.id, itemId: item.id,
        clientRequestId: input.clientRequestId, requestPayloadDigest: input.requestPayloadDigest,
        outcome: input.outcome, reason: input.reason, evidenceRefs: input.evidenceRefs,
        actorAgentId: actor.agentId ?? null, actorUserId: actor.userId ?? null, actorRunId: actor.runId ?? null,
      }).returning().then((rows) => rows[0]);
      const now = new Date();
      if (input.outcome === "approve") {
        const unfinished = await tx.select({ id: workRecordQualityItems.id }).from(workRecordQualityItems).where(and(
          eq(workRecordQualityItems.companyId, companyId),
          eq(workRecordQualityItems.cycleId, cycle.id),
          eq(workRecordQualityItems.required, true),
          ne(workRecordQualityItems.role, "po"),
          ne(workRecordQualityItems.state, "accepted"),
        )).limit(1).then((rows) => rows[0] ?? null);
        if (unfinished) throw conflict("Required quality items are not accepted", details("work_record_quality_not_ready"));
        await tx.update(workRecordQualityItems).set({ state: "accepted", revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now })
          .where(eq(workRecordQualityItems.id, item.id));
        await tx.update(workRecordQualityCycles).set({
          state: "accepted", qualityPhase: "accepted", revision: cycle.revision + 1,
          closedByAgentId: actor.agentId ?? null, closedByUserId: actor.userId ?? null, closedAt: now, updatedAt: now,
        }).where(eq(workRecordQualityCycles.id, cycle.id));
        await tx.update(workRecords).set({
          businessStatus: "done", statusVersion: sql`${workRecords.statusVersion} + 1`, updatedAt: now,
        }).where(eq(workRecords.id, aggregateRecordId));
        const primary = await primaryIssueForRecord(tx, companyId, projectId, aggregateRecordId);
        if (primary) {
          await retireActiveIntents(tx, companyId, primary.issue.id, "po_accepted");
          await issueSvc.update(primary.issue.id, {
            companyGuard: companyId, status: "done", actorAgentId: actor.agentId ?? null, actorUserId: actor.userId ?? null,
          }, tx);
        }
        return { verdict, replayed: false, nextCycleId: null as string | null };
      }
      await tx.update(workRecordQualityItems).set({ state: "rejected", revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now })
        .where(eq(workRecordQualityItems.id, item.id));
      await tx.update(workRecordQualityCycles).set({
        state: "superseded", reason: input.reason, revision: cycle.revision + 1,
        closedByAgentId: actor.agentId ?? null, closedByUserId: actor.userId ?? null, closedAt: now, updatedAt: now,
      }).where(eq(workRecordQualityCycles.id, cycle.id));
      const next = await createPackageReworkCycle(tx, {
        companyId, projectId, previousCycle: cycle, targetRecordIds: input.targetRecordIds,
        reason: input.reason, actor,
      });
      const packageIssue = await primaryIssueForRecord(tx, companyId, projectId, aggregateRecordId);
      if (packageIssue) {
        await retireActiveIntents(tx, companyId, packageIssue.issue.id, "po_returned");
        await issueSvc.update(packageIssue.issue.id, {
          companyGuard: companyId, status: "blocked", actorAgentId: actor.agentId ?? null, actorUserId: actor.userId ?? null,
        }, tx);
      }
      await tx.update(workRecords).set({
        businessStatus: "blocked", statusVersion: sql`${workRecords.statusVersion} + 1`, updatedAt: now,
      }).where(eq(workRecords.id, aggregateRecordId));
      return { verdict, replayed: false, nextCycleId: next.cycle.id };
  }

  async function recordPoVerdict(companyId: string, projectId: string, aggregateRecordId: string, input: RecordPoQualityVerdict, actor: Actor) {
    const result = await db.transaction((tx) => commitPoVerdictInTransaction(
      tx, companyId, projectId, aggregateRecordId, input, actor));
    return { ...result, quality: await currentView(companyId, projectId, aggregateRecordId) };
  }

  async function linkPackageDefect(companyId: string, projectId: string, input: LinkWorkPackageDefect, actor: Actor) {
    assertWritesEnabled(companyId, projectId);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${aggregateLockKey(companyId, input.packageRecordId)}, 0))`);
      const linkKey = `quality-defect:${input.clientRequestId}`;
      const existing = await tx.select().from(workRecordQualityLinks).where(and(
        eq(workRecordQualityLinks.companyId, companyId), eq(workRecordQualityLinks.linkKey, linkKey),
      )).then((rows) => rows[0] ?? null);
      if (existing) {
        const replay = classifyWorkRecordCommandReplay(existing.requestPayloadDigest, input.requestPayloadDigest);
        if (replay.outcome === "conflict") throw conflict(
          "Client request key was already used with a different defect link",
          details(replay.code, { qualityLinkId: existing.id }),
        );
        return { link: existing, replayed: true };
      }
      const cycle = await tx.select().from(workRecordQualityCycles).where(and(
        eq(workRecordQualityCycles.companyId, companyId), eq(workRecordQualityCycles.projectId, projectId),
        eq(workRecordQualityCycles.id, input.cycleId), eq(workRecordQualityCycles.aggregateRecordId, input.packageRecordId),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!cycle) throw notFound("Package quality cycle not found");
      if (cycle.state !== "open" || cycle.revision !== input.expectedCycleRevision) {
        throw conflict("Quality cycle revision changed", details("work_record_workflow_stale_revision", { currentRevision: cycle.revision }));
      }
      const ids = [input.defectRecordId, input.packageRecordId, input.qaRecordId, ...(input.repairRecordId ? [input.repairRecordId] : [])];
      const records = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), inArray(workRecords.id, ids),
      ));
      if (records.length !== new Set(ids).size || records.find((record) => record.id === input.defectRecordId)?.kind !== "defect") {
        throw unprocessable("Defect quality link targets must belong to this project", details("work_record_quality_target_invalid"));
      }
      await assertPackageMembers(
        tx,
        companyId,
        projectId,
        input.packageRecordId,
        [input.qaRecordId, ...(input.repairRecordId ? [input.repairRecordId] : [])],
      );
      const packageRecord = records.find((record) => record.id === input.packageRecordId)!;
      const qaRecord = records.find((record) => record.id === input.qaRecordId)!;
      const existingDefectLinks = await tx.select().from(workRecordQualityLinks).where(and(
        eq(workRecordQualityLinks.companyId, companyId),
        eq(workRecordQualityLinks.projectId, projectId),
        eq(workRecordQualityLinks.packageRecordId, input.packageRecordId),
        eq(workRecordQualityLinks.defectRecordId, input.defectRecordId),
      )).orderBy(desc(workRecordQualityLinks.createdAt), desc(workRecordQualityLinks.id));
      const unresolvedLink = existingDefectLinks.find((candidate) => candidate.repairRecordId === null) ?? null;
      const resolvedLink = existingDefectLinks.find((candidate) => candidate.repairRecordId !== null) ?? null;
      if (unresolvedLink) {
        if (!input.repairRecordId) {
          throw conflict("Defect ownership is already awaiting PO adjudication", details(
            "work_record_quality_not_ready",
            { qualityLinkId: unresolvedLink.id },
          ));
        }
        assertRole(actor, packageRecord.assigneeAgentId, "PO");
        if (unresolvedLink.qaRecordId !== input.qaRecordId) {
          throw unprocessable("PO adjudication must preserve the reporting QA task", details(
            "work_record_quality_target_invalid",
            { qualityLinkId: unresolvedLink.id },
          ));
        }
      } else {
        assertRole(actor, qaRecord.assigneeAgentId, "QA");
      }
      if (resolvedLink) {
        throw conflict("Defect ownership has already been adjudicated", details(
          "work_record_quality_not_ready",
          { qualityLinkId: resolvedLink.id },
        ));
      }
      if (await primaryIssueForRecord(tx, companyId, projectId, input.defectRecordId)) {
        throw conflict("Package-linked defects cannot own a parallel primary issue", details("work_record_quality_active_intent_conflict"));
      }
      const link = await tx.insert(workRecordQualityLinks).values({
        companyId, projectId, linkKey, requestPayloadDigest: input.requestPayloadDigest,
        linkKind: input.repairRecordId ? "package_defect" : "package_defect_unassigned",
        defectRecordId: input.defectRecordId, packageRecordId: input.packageRecordId,
        repairRecordId: input.repairRecordId, qaRecordId: input.qaRecordId,
        validFromCycleNumber: cycle.cycleNumber,
      }).returning().then((rows) => rows[0]);
      const now = new Date();
      if (!input.repairRecordId) {
        await tx.update(workRecordQualityCycles).set({
          qualityPhase: "attention_required", reason: "repair_ownership_requires_po",
          revision: cycle.revision + 1, updatedAt: now,
        }).where(eq(workRecordQualityCycles.id, cycle.id));
        await tx.update(workRecords).set({ businessStatus: "blocked", statusVersion: sql`${workRecords.statusVersion} + 1`, updatedAt: now })
          .where(eq(workRecords.id, input.defectRecordId));
        return { link, replayed: false };
      }

      const repairRecord = records.find((record) => record.id === input.repairRecordId)!;
      const repairPrimary = await primaryIssueForRecord(tx, companyId, projectId, repairRecord.id);
      const qaPrimary = await primaryIssueForRecord(tx, companyId, projectId, qaRecord.id);
      if (!repairPrimary || !qaPrimary) {
        throw unprocessable("Package defect must reuse existing repair and QA tasks", details("work_record_quality_target_invalid"));
      }
      let repairItem = await tx.select().from(workRecordQualityItems).where(and(
        eq(workRecordQualityItems.companyId, companyId),
        eq(workRecordQualityItems.cycleId, cycle.id),
        eq(workRecordQualityItems.recordId, repairRecord.id),
        eq(workRecordQualityItems.role, "repair"),
      )).then((rows) => rows[0] ?? null);
      const newRepairItem = !repairItem;
      if (!repairItem) {
        repairItem = await tx.insert(workRecordQualityItems).values({
          companyId,
          projectId,
          cycleId: cycle.id,
          recordId: repairRecord.id,
          role: "repair",
          required: true,
          state: "ready",
          issueLinkId: repairPrimary.link.id,
        }).returning().then((rows) => rows[0]);
      } else if (repairItem.state !== "ready" && repairItem.state !== "active") {
        await tx.update(workRecordQualityItems).set({
          state: "ready",
          issueLinkId: repairPrimary.link.id,
          revision: sql`${workRecordQualityItems.revision} + 1`,
          updatedAt: now,
        }).where(eq(workRecordQualityItems.id, repairItem.id));
      }
      await tx.insert(workRecordQualityItems).values({
        companyId,
        projectId,
        cycleId: cycle.id,
        recordId: qaRecord.id,
        role: "qa",
        required: true,
        state: "blocked",
        issueLinkId: qaPrimary.link.id,
      }).onConflictDoNothing();
      if (newRepairItem || repairPrimary.issue.status === "done" || repairPrimary.issue.status === "in_review") {
        await reopenRecordForQuality(tx, {
          companyId,
          projectId,
          record: repairRecord,
          issueRow: repairPrimary.issue,
          itemId: repairItem.id,
          cycleNumber: cycle.cycleNumber,
          kind: "rework_release",
          actor,
        });
      }
      await tx.update(workRecordQualityCycles).set({
        qualityPhase: "waiting_fix",
        reason: input.reason,
        revision: cycle.revision + 1,
        updatedAt: now,
      }).where(eq(workRecordQualityCycles.id, cycle.id));
      await tx.update(workRecords).set({
        businessStatus: "in_progress",
        statusVersion: sql`${workRecords.statusVersion} + 1`,
        updatedAt: now,
      }).where(eq(workRecords.id, input.defectRecordId));
      return { link, replayed: false };
    });
    return { ...result, quality: await currentView(companyId, projectId, input.packageRecordId) };
  }

  async function recordQaVerdict(companyId: string, projectId: string, aggregateRecordId: string, input: RecordQaQualityVerdict, actor: Actor) {
    assertWritesEnabled(companyId, projectId);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${aggregateLockKey(companyId, aggregateRecordId)}, 0))`);
      const replay = await replayVerdict(tx, companyId, input.clientRequestId, input.requestPayloadDigest);
      if (replay) return { verdict: replay, replayed: true, escalated: false };
      const { cycle, item } = await loadLockedCycleAndItem(tx, {
        companyId, projectId, cycleId: input.cycleId, itemId: input.itemId,
        expectedCycleRevision: input.expectedCycleRevision,
      });
      if (cycle.aggregateRecordId !== aggregateRecordId || item.role !== "qa" || item.defectRecordId && item.defectRecordId !== input.defectRecordId) {
        throw unprocessable("QA verdict is not bound to this quality item", details("work_record_quality_target_invalid"));
      }
      const aggregate = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.id, aggregateRecordId),
      )).then((rows) => rows[0] ?? null);
      const defect = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.id, input.defectRecordId), eq(workRecords.kind, "defect"),
      )).then((rows) => rows[0] ?? null);
      if (!aggregate || !defect) throw notFound("Quality defect not found");
      const independent = aggregate.id === defect.id && cycle.kind === "independent_defect";
      const link = independent ? null : await tx.select().from(workRecordQualityLinks).where(and(
        eq(workRecordQualityLinks.companyId, companyId), eq(workRecordQualityLinks.projectId, projectId),
        eq(workRecordQualityLinks.packageRecordId, aggregateRecordId), eq(workRecordQualityLinks.defectRecordId, defect.id),
      )).orderBy(desc(workRecordQualityLinks.createdAt)).then((rows) => rows[0] ?? null);
      const qaRecord = independent ? defect : link?.qaRecordId ? await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId), eq(workRecords.id, link.qaRecordId),
      )).then((rows) => rows[0] ?? null) : null;
      if (!qaRecord) throw unprocessable("Defect has no QA owner", details("work_record_quality_assignment_required"));
      const qaPrimary = await primaryIssueForRecord(tx, companyId, projectId, qaRecord.id);
      if (item.recordId !== qaRecord.id || !qaPrimary || item.issueLinkId !== qaPrimary.link.id) {
        throw unprocessable("QA verdict is not bound to the defect's QA task", details(
          "work_record_quality_target_invalid",
          { qaRecordId: qaRecord.id, qualityItemId: item.id },
        ));
      }
      assertRole(actor, independent ? defect.qaAssigneeAgentId : qaRecord.assigneeAgentId, "QA");
      if (item.state !== "ready" && item.state !== "active" && item.state !== "submitted") {
        throw conflict("QA item is not ready for a verdict", details("work_record_quality_not_ready", { itemState: item.state }));
      }
      if (input.outcome === "return" && !independent && (!link?.repairRecordId || link.repairRecordId !== input.repairRecordId)) {
        throw unprocessable("QA return must target the permanently linked original repair record", details("work_record_quality_target_invalid"));
      }
      const verdict = await tx.insert(workRecordQualityVerdicts).values({
        companyId, projectId, cycleId: cycle.id, itemId: item.id, defectRecordId: defect.id,
        clientRequestId: input.clientRequestId, requestPayloadDigest: input.requestPayloadDigest,
        outcome: input.outcome, reason: input.reason, evidenceRefs: input.evidenceRefs,
        actorAgentId: actor.agentId ?? null, actorUserId: actor.userId ?? null, actorRunId: actor.runId ?? null,
      }).returning().then((rows) => rows[0]);
      const now = new Date();
      if (input.outcome === "pass") {
        const relevantLinks = independent ? [] : await tx.select().from(workRecordQualityLinks).where(and(
          eq(workRecordQualityLinks.companyId, companyId), eq(workRecordQualityLinks.projectId, projectId),
          eq(workRecordQualityLinks.packageRecordId, aggregateRecordId), eq(workRecordQualityLinks.qaRecordId, qaRecord.id),
        ));
        const currentVerdicts = await tx.select().from(workRecordQualityVerdicts).where(and(
          eq(workRecordQualityVerdicts.companyId, companyId), eq(workRecordQualityVerdicts.cycleId, cycle.id),
          eq(workRecordQualityVerdicts.itemId, item.id),
        ));
        const passedIds = new Set(currentVerdicts.filter((candidate) => candidate.outcome === "pass").map((candidate) => candidate.defectRecordId));
        if (independent || relevantLinks.every((candidate) => passedIds.has(candidate.defectRecordId))) {
          await tx.update(workRecordQualityItems).set({ state: "accepted", revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now })
            .where(eq(workRecordQualityItems.id, item.id));
        }
        await tx.update(workRecords).set({ businessStatus: "done", statusVersion: sql`${workRecords.statusVersion} + 1`, updatedAt: now })
          .where(eq(workRecords.id, defect.id));
        if (independent) {
          const primary = await primaryIssueForRecord(tx, companyId, projectId, defect.id);
          if (!primary || primary.issue.status !== "in_review") {
            throw conflict("Independent defect is not awaiting QA review", details("work_record_quality_not_ready"));
          }
          const policy = normalizeIssueExecutionPolicy(primary.issue.executionPolicy);
          const transition = applyIssueExecutionPolicyTransition({
            issue: primary.issue,
            policy,
            requestedStatus: "done",
            requestedAssigneePatch: {},
            actor: { agentId: actor.agentId ?? null, userId: actor.userId ?? null },
            allowBoardOverride: actor.actorType === "user",
            commentBody: input.reason,
          });
          const updated = await issueSvc.update(primary.issue.id, {
            companyGuard: companyId, status: "done", ...transition.patch,
            actorAgentId: actor.agentId ?? null, actorUserId: actor.userId ?? null,
          }, tx);
          if (!updated) throw notFound("Independent defect issue not found");
          await retireActiveIntents(tx, companyId, updated.id, "qa_passed");
          await tx.update(workRecordQualityCycles).set({
            state: "accepted", qualityPhase: "accepted", revision: cycle.revision + 1,
            closedByAgentId: actor.agentId ?? null, closedByUserId: actor.userId ?? null,
            closedAt: now, updatedAt: now,
          }).where(eq(workRecordQualityCycles.id, cycle.id));
        }
        return { verdict, replayed: false, escalated: false };
      }

      await tx.update(workRecordQualityItems).set({ state: "rejected", revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now })
        .where(eq(workRecordQualityItems.id, item.id));
      if (independent) {
        if (cycle.cycleNumber >= maxReviewRounds) {
          await tx.update(workRecordQualityCycles).set({
            qualityPhase: "attention_required",
            reason: "review_round_limit_reached",
            revision: cycle.revision + 1,
            updatedAt: now,
          }).where(eq(workRecordQualityCycles.id, cycle.id));
          return { verdict, replayed: false, escalated: true };
        }
        const primary = await primaryIssueForRecord(tx, companyId, projectId, defect.id);
        if (!primary || primary.issue.status !== "in_review") {
          throw conflict("Independent defect is not awaiting QA review", details("work_record_quality_not_ready"));
        }
        const policy = normalizeIssueExecutionPolicy(primary.issue.executionPolicy);
        const transition = applyIssueExecutionPolicyTransition({
          issue: primary.issue,
          policy,
          requestedStatus: "in_progress",
          requestedAssigneePatch: {},
          actor: { agentId: actor.agentId ?? null, userId: actor.userId ?? null },
          allowBoardOverride: actor.actorType === "user",
          commentBody: input.reason,
        });
        const updated = await issueSvc.update(primary.issue.id, {
          companyGuard: companyId, status: "in_progress", ...transition.patch,
          actorAgentId: actor.agentId ?? null, actorUserId: actor.userId ?? null,
        }, tx);
        if (!updated) throw notFound("Independent defect issue not found");
        const escalated = updated.status === "in_review";
        if (escalated) {
          await tx.update(workRecordQualityCycles).set({
            qualityPhase: "attention_required", reason: "review_round_limit_reached",
            revision: cycle.revision + 1, updatedAt: now,
          }).where(eq(workRecordQualityCycles.id, cycle.id));
          return { verdict, replayed: false, escalated: true };
        }
        await tx.update(workRecordQualityCycles).set({
          state: "superseded", reason: input.reason, revision: cycle.revision + 1,
          closedByAgentId: actor.agentId ?? null, closedByUserId: actor.userId ?? null,
          closedAt: now, updatedAt: now,
        }).where(eq(workRecordQualityCycles.id, cycle.id));
        const cycleNumber = await nextCycleNumber(tx, companyId, aggregateRecordId);
        const next = await tx.insert(workRecordQualityCycles).values({
          companyId, projectId, aggregateRecordId, cycleNumber, kind: "independent_defect",
          state: "open", qualityPhase: "waiting_fix", reason: input.reason, scopeDigest: cycle.scopeDigest,
          openedByAgentId: actor.agentId ?? null, openedByUserId: actor.userId ?? null,
        }).returning().then((rows) => rows[0]);
        const repairItem = await tx.insert(workRecordQualityItems).values({
          companyId, projectId, cycleId: next.id, recordId: defect.id, defectRecordId: defect.id,
          role: "repair", required: true, state: "ready", issueLinkId: primary.link.id,
        }).returning().then((rows) => rows[0]);
        await tx.insert(workRecordQualityItems).values({
          companyId, projectId, cycleId: next.id, recordId: defect.id, defectRecordId: defect.id,
          role: "qa", required: true, state: "blocked", issueLinkId: primary.link.id,
        });
        await retireActiveIntents(tx, companyId, primary.issue.id, "qa_returned");
        await createQualityIntent(tx, {
          companyId, projectId, cycleNumber, itemId: repairItem.id, recordId: defect.id,
          issueId: updated.id, issueStatusVersion: updated.statusVersion, kind: "rework_release",
        });
        await tx.update(workRecords).set({
          businessStatus: "in_progress", statusVersion: sql`${workRecords.statusVersion} + 1`, updatedAt: now,
        }).where(eq(workRecords.id, defect.id));
        return { verdict, replayed: false, escalated: false };
      }

      if (cycle.cycleNumber >= maxReviewRounds) {
        await tx.update(workRecordQualityCycles).set({
          qualityPhase: "attention_required",
          reason: "review_round_limit_reached",
          revision: cycle.revision + 1,
          updatedAt: now,
        }).where(eq(workRecordQualityCycles.id, cycle.id));
        return { verdict, replayed: false, escalated: true };
      }

      const repairRecord = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.id, input.repairRecordId!),
      )).then((rows) => rows[0] ?? null);
      const repairPrimary = repairRecord ? await primaryIssueForRecord(tx, companyId, projectId, repairRecord.id) : null;
      if (!repairRecord || !repairPrimary) throw unprocessable("Linked repair task is unavailable", details("work_record_quality_target_invalid"));
      await tx.update(workRecordQualityCycles).set({
        state: "superseded",
        reason: input.reason,
        revision: cycle.revision + 1,
        closedByAgentId: actor.agentId ?? null,
        closedByUserId: actor.userId ?? null,
        closedAt: now,
        updatedAt: now,
      }).where(eq(workRecordQualityCycles.id, cycle.id));
      await createPackageReworkCycle(tx, {
        companyId,
        projectId,
        previousCycle: cycle,
        targetRecordIds: [repairRecord.id],
        reason: input.reason,
        actor,
      });
      return { verdict, replayed: false, escalated: false };
    });
    return { ...result, quality: await currentView(companyId, projectId, aggregateRecordId) };
  }

  async function reconcileCycle(companyId: string, projectId: string, cycleId: string) {
    if (!rollout.decision(companyId, projectId).scopeEnabled) return false;
    return db.transaction(async (tx) => {
      const cycle = await tx.select().from(workRecordQualityCycles).where(and(
        eq(workRecordQualityCycles.companyId, companyId), eq(workRecordQualityCycles.projectId, projectId),
        eq(workRecordQualityCycles.id, cycleId), eq(workRecordQualityCycles.state, "open"),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!cycle) return false;
      const items = await tx.select().from(workRecordQualityItems).where(and(
        eq(workRecordQualityItems.companyId, companyId), eq(workRecordQualityItems.cycleId, cycle.id),
      )).orderBy(asc(workRecordQualityItems.createdAt));
      const links = items.map((item) => item.issueLinkId).filter((id): id is string => Boolean(id));
      const linked = links.length > 0 ? await tx.select({ link: workRecordIssueLinks, issue: issues })
        .from(workRecordIssueLinks).innerJoin(issues, and(
          eq(issues.companyId, workRecordIssueLinks.companyId), eq(issues.id, workRecordIssueLinks.issueId),
        )).where(and(eq(workRecordIssueLinks.companyId, companyId), inArray(workRecordIssueLinks.id, links))) : [];
      const byLink = new Map(linked.map((row) => [row.link.id, row.issue]));
      const workspaceIds = linked
        .map((row) => row.issue.executionWorkspaceId)
        .filter((id): id is string => Boolean(id));
      const unfinalizedWorkspaces = await listUnfinalizedExecutionWorkspaceIds(tx, companyId, workspaceIds);
      const now = new Date();
      let changed = false;
      for (const item of items.filter((candidate) => candidate.role === "repair")) {
        const issue = item.issueLinkId ? byLink.get(item.issueLinkId) : null;
        if (!issue) continue;
        const workspaceReady = !issue.executionWorkspaceId || !unfinalizedWorkspaces.has(issue.executionWorkspaceId);
        const completed = workspaceReady && (
          issue.status === "done" || (cycle.kind === "independent_defect" && issue.status === "in_review")
        );
        if (completed && item.state !== "accepted") {
          await tx.update(workRecordQualityItems).set({ state: "accepted", revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now })
            .where(eq(workRecordQualityItems.id, item.id));
          await retireActiveIntents(tx, companyId, issue.id, "quality_repair_completed");
          changed = true;
        }
      }
      const refreshed = await tx.select().from(workRecordQualityItems).where(and(
        eq(workRecordQualityItems.companyId, companyId), eq(workRecordQualityItems.cycleId, cycle.id),
      ));
      if (cycle.kind !== "independent_defect") {
        const defectLinks = await tx.select({
          defectRecordId: workRecordQualityLinks.defectRecordId,
          repairRecordId: workRecordQualityLinks.repairRecordId,
        }).from(workRecordQualityLinks).where(and(
          eq(workRecordQualityLinks.companyId, companyId),
          eq(workRecordQualityLinks.projectId, projectId),
          eq(workRecordQualityLinks.packageRecordId, cycle.aggregateRecordId),
        ));
        const assignedDefectIds = new Set(defectLinks
          .filter((link) => Boolean(link.repairRecordId))
          .map((link) => link.defectRecordId));
        const hasUnassignedDefect = defectLinks.some((link) =>
          !link.repairRecordId && !assignedDefectIds.has(link.defectRecordId));
        if (hasUnassignedDefect) {
          await tx.update(workRecordQualityCycles).set({
            qualityPhase: "attention_required",
            reason: "repair_ownership_requires_po",
            revision: cycle.qualityPhase === "attention_required" ? cycle.revision : cycle.revision + 1,
            updatedAt: now,
          }).where(eq(workRecordQualityCycles.id, cycle.id));
          return true;
        }
      }
      const repairsReady = refreshed.filter((item) => item.role === "repair" && item.required)
        .every((item) => item.state === "accepted");
      if (!repairsReady) return changed;
      if (cycle.kind === "independent_defect") {
        await tx.update(workRecords).set({
          businessStatus: "in_review",
          statusVersion: sql`${workRecords.statusVersion} + 1`,
          updatedAt: now,
        }).where(and(
          eq(workRecords.companyId, companyId),
          eq(workRecords.projectId, projectId),
          eq(workRecords.id, cycle.aggregateRecordId),
          ne(workRecords.businessStatus, "in_review"),
        ));
        await tx.update(workRecordQualityItems).set({ state: "active", revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now }).where(and(
          eq(workRecordQualityItems.companyId, companyId), eq(workRecordQualityItems.cycleId, cycle.id),
          eq(workRecordQualityItems.role, "qa"), inArray(workRecordQualityItems.state, ["waiting", "blocked", "ready"]),
        ));
        if (cycle.qualityPhase !== "qa_retest") {
          await tx.update(workRecordQualityCycles).set({ qualityPhase: "qa_retest", revision: cycle.revision + 1, updatedAt: now })
            .where(eq(workRecordQualityCycles.id, cycle.id));
        }
        return true;
      }
      const repairRecordIds = refreshed
        .filter((item) => item.role === "repair" && item.required)
        .map((item) => item.recordId);
      if (repairRecordIds.length > 0) {
        const defectLinks = await tx.select({ defectRecordId: workRecordQualityLinks.defectRecordId })
          .from(workRecordQualityLinks)
          .where(and(
            eq(workRecordQualityLinks.companyId, companyId),
            eq(workRecordQualityLinks.projectId, projectId),
            eq(workRecordQualityLinks.packageRecordId, cycle.aggregateRecordId),
            inArray(workRecordQualityLinks.repairRecordId, repairRecordIds),
          ));
        const defectRecordIds = [...new Set(defectLinks.map((link) => link.defectRecordId))];
        if (defectRecordIds.length > 0) {
          await tx.update(workRecords).set({
            businessStatus: "in_review",
            statusVersion: sql`${workRecords.statusVersion} + 1`,
            updatedAt: now,
          }).where(and(
            eq(workRecords.companyId, companyId),
            eq(workRecords.projectId, projectId),
            inArray(workRecords.id, defectRecordIds),
            ne(workRecords.businessStatus, "in_review"),
          ));
        }
      }
      const qaItems = refreshed.filter((item) => item.role === "qa" && item.required);
      if (qaItems.length > 0) {
        const sourceBatch = await tx.select({ id: workRecordDispatchBatches.id }).from(workRecordDispatchBatches).where(and(
          eq(workRecordDispatchBatches.companyId, companyId),
          eq(workRecordDispatchBatches.projectId, projectId),
          eq(workRecordDispatchBatches.rootRecordId, cycle.aggregateRecordId),
          eq(workRecordDispatchBatches.scopeKind, "whole_package"),
          eq(workRecordDispatchBatches.scopeDigest, cycle.scopeDigest),
          eq(workRecordDispatchBatches.state, "prepared"),
        )).orderBy(desc(workRecordDispatchBatches.createdAt)).then((rows) => rows[0] ?? null);
        const coveredQaIds = new Set(sourceBatch && repairRecordIds.length ? (await tx.select({ qaRecordId: workRecordQaCoverageSnapshots.qaRecordId })
          .from(workRecordQaCoverageSnapshots).where(and(
            eq(workRecordQaCoverageSnapshots.companyId, companyId),
            eq(workRecordQaCoverageSnapshots.projectId, projectId),
            eq(workRecordQaCoverageSnapshots.batchId, sourceBatch.id),
            inArray(workRecordQaCoverageSnapshots.executionRecordId, repairRecordIds),
          ))).map((row) => row.qaRecordId) : []);
        const defectQaIds = new Set((await tx.select({ qaRecordId: workRecordQualityLinks.qaRecordId })
          .from(workRecordQualityLinks).where(and(
            eq(workRecordQualityLinks.companyId, companyId),
            eq(workRecordQualityLinks.projectId, projectId),
            eq(workRecordQualityLinks.packageRecordId, cycle.aggregateRecordId),
            inArray(workRecordQualityLinks.repairRecordId, repairRecordIds),
          ))).map((link) => link.qaRecordId));
        for (const item of qaItems) {
          if (item.state === "accepted" || !coveredQaIds.has(item.recordId) || defectQaIds.has(item.recordId) || !item.issueLinkId) continue;
          const issue = byLink.get(item.issueLinkId);
          if (issue?.status !== "done" || (issue.executionWorkspaceId && unfinalizedWorkspaces.has(issue.executionWorkspaceId))) continue;
          await tx.update(workRecordQualityItems).set({ state: "accepted", revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now })
            .where(eq(workRecordQualityItems.id, item.id));
          await retireActiveIntents(tx, companyId, issue.id, "quality_qa_completed");
          item.state = "accepted";
          changed = true;
        }
        const pendingQaItems = qaItems.filter((candidate) => candidate.state !== "accepted");
        for (const item of pendingQaItems.filter((candidate) => !["active", "ready"].includes(candidate.state))) {
          const qaPrimary = await primaryIssueForRecord(tx, companyId, projectId, item.recordId);
          const qaRecord = await tx.select().from(workRecords).where(and(
            eq(workRecords.companyId, companyId), eq(workRecords.id, item.recordId),
          )).then((rows) => rows[0] ?? null);
          if (!qaPrimary || !qaRecord) continue;
          const updated = await reopenRecordForQuality(tx, {
            companyId, projectId, record: qaRecord, issueRow: qaPrimary.issue,
            itemId: item.id, cycleNumber: cycle.cycleNumber, kind: "qa_retest_release",
            actor: { actorType: "system", actorId: "work-record-quality-reconciler" },
          });
          await tx.update(workRecordQualityItems).set({
            state: "ready", issueLinkId: qaPrimary.link.id,
            revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now,
          }).where(eq(workRecordQualityItems.id, item.id));
          void updated;
        }
        await tx.update(workRecordQualityCycles).set({ qualityPhase: "qa_retest", revision: cycle.revision + 1, updatedAt: now })
          .where(and(eq(workRecordQualityCycles.id, cycle.id), ne(workRecordQualityCycles.qualityPhase, "qa_retest")));
        if (pendingQaItems.length > 0) return true;
      }
      const unresolvedHolds = await tx.select({ id: workRecordExecutionHolds.id }).from(workRecordExecutionHolds).where(and(
        eq(workRecordExecutionHolds.companyId, companyId), eq(workRecordExecutionHolds.dependentRecordId, cycle.aggregateRecordId),
        isNull(workRecordExecutionHolds.resolvedAt),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (!unresolvedHolds) {
        const poItem = await tx.select().from(workRecordQualityItems).where(and(
          eq(workRecordQualityItems.companyId, companyId),
          eq(workRecordQualityItems.cycleId, cycle.id),
          eq(workRecordQualityItems.role, "po"),
        )).then((rows) => rows[0] ?? null);
        if (poItem && ["waiting", "blocked"].includes(poItem.state)) {
          const existingIntent = await tx.select({ id: workRecordExecutionIntents.id })
            .from(workRecordExecutionIntents)
            .where(and(
              eq(workRecordExecutionIntents.companyId, companyId),
              eq(workRecordExecutionIntents.qualityItemId, poItem.id),
              ne(workRecordExecutionIntents.state, "superseded"),
            ))
            .then((rows) => rows[0] ?? null);
          const aggregate = await tx.select().from(workRecords).where(and(
            eq(workRecords.companyId, companyId),
            eq(workRecords.projectId, projectId),
            eq(workRecords.id, cycle.aggregateRecordId),
          )).then((rows) => rows[0] ?? null);
          const primary = aggregate
            ? await primaryIssueForRecord(tx, companyId, projectId, aggregate.id)
            : null;
          if (!aggregate || !primary) {
            throw unprocessable("PO acceptance requires the original package task", details(
              "work_record_quality_target_invalid",
            ));
          }
          if (existingIntent) {
            await tx.update(workRecords).set({
              businessStatus: "in_review",
              statusVersion: sql`${workRecords.statusVersion} + 1`,
              updatedAt: now,
            }).where(and(
              eq(workRecords.companyId, companyId),
              eq(workRecords.id, aggregate.id),
              ne(workRecords.businessStatus, "in_review"),
            ));
          } else {
            await reopenRecordForQuality(tx, {
              companyId,
              projectId,
              record: aggregate,
              issueRow: primary.issue,
              itemId: poItem.id,
              cycleNumber: cycle.cycleNumber,
              kind: "po_acceptance_release",
              recordBusinessStatus: "in_review",
              actor: { actorType: "system", actorId: "work-record-quality-reconciler" },
            });
          }
        }
        await tx.update(workRecordQualityItems).set({ state: "ready", revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now }).where(and(
          eq(workRecordQualityItems.companyId, companyId), eq(workRecordQualityItems.cycleId, cycle.id),
          eq(workRecordQualityItems.role, "po"), inArray(workRecordQualityItems.state, ["waiting", "blocked"]),
        ));
        await tx.update(workRecordQualityCycles).set({ qualityPhase: "po_acceptance", revision: cycle.revision + 1, updatedAt: now })
          .where(and(eq(workRecordQualityCycles.id, cycle.id), ne(workRecordQualityCycles.qualityPhase, "po_acceptance")));
        changed = true;
      }
      return changed;
    });
  }

  async function reconcilePage(limit = 25, afterId: string | null = null) {
    if (!writesEnabled) return { processed: 0, succeeded: 0, failures: [], nextAfterId: null };
    const cycles = await db.select({
      id: workRecordQualityCycles.id,
      companyId: workRecordQualityCycles.companyId,
      projectId: workRecordQualityCycles.projectId,
    }).from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.state, "open"),
      rolloutScopePredicate(),
      afterId ? gt(workRecordQualityCycles.id, afterId) : undefined,
    )).orderBy(asc(workRecordQualityCycles.id)).limit(limit + 1);
    const hasMore = cycles.length > limit;
    const candidates = hasMore ? cycles.slice(0, limit) : cycles;
    const settled = await reconcileCandidatesIndependently(candidates, (cycle) =>
      reconcileCycle(cycle.companyId, cycle.projectId, cycle.id));
    return {
      processed: candidates.length,
      succeeded: settled.succeeded,
      failures: settled.failures,
      nextAfterId: hasMore ? candidates.at(-1)?.id ?? null : null,
    };
  }

  async function reconcileAll(limit = 25) {
    return (await reconcilePage(limit)).processed;
  }

  async function auditSnapshot(
    companyId: string,
    projectId: string,
    aggregateRecordId: string,
    cycleId: string,
    itemId: string | null,
  ) {
    const [record, cycle, item] = await Promise.all([
      db.select({ revision: workRecords.revision }).from(workRecords).where(and(
        eq(workRecords.companyId, companyId),
        eq(workRecords.projectId, projectId),
        eq(workRecords.id, aggregateRecordId),
      )).then((rows) => rows[0] ?? null),
      db.select({ revision: workRecordQualityCycles.revision }).from(workRecordQualityCycles).where(and(
        eq(workRecordQualityCycles.companyId, companyId),
        eq(workRecordQualityCycles.projectId, projectId),
        eq(workRecordQualityCycles.id, cycleId),
      )).then((rows) => rows[0] ?? null),
      itemId ? db.select({ revision: workRecordQualityItems.revision }).from(workRecordQualityItems).where(and(
        eq(workRecordQualityItems.companyId, companyId),
        eq(workRecordQualityItems.projectId, projectId),
        eq(workRecordQualityItems.cycleId, cycleId),
        eq(workRecordQualityItems.id, itemId),
      )).then((rows) => rows[0] ?? null) : Promise.resolve(null),
    ]);
    const cycleItemIds = itemId ? [itemId] : await db.select({ id: workRecordQualityItems.id })
      .from(workRecordQualityItems)
      .where(and(
        eq(workRecordQualityItems.companyId, companyId),
        eq(workRecordQualityItems.projectId, projectId),
        eq(workRecordQualityItems.cycleId, cycleId),
      )).then((rows) => rows.map((row) => row.id));
    const intentIds = cycleItemIds.length === 0 ? [] : await db.select({ id: workRecordExecutionIntents.id })
      .from(workRecordExecutionIntents)
      .where(and(
        eq(workRecordExecutionIntents.companyId, companyId),
        eq(workRecordExecutionIntents.projectId, projectId),
        inArray(workRecordExecutionIntents.qualityItemId, cycleItemIds),
      )).then((rows) => rows.map((row) => row.id).sort());
    return {
      recordRevision: record?.revision ?? null,
      cycleRevision: cycle?.revision ?? null,
      itemRevision: item?.revision ?? null,
      intentIds,
    };
  }

  return {
    get: currentView,
    auditSnapshot,
    commitPoVerdictInTransaction,
    recordPoVerdict,
    recordQaVerdict,
    linkPackageDefect,
    reconcileCycle,
    reconcileAll,
    reconcilePage,
    writesEnabled,
  };
}
