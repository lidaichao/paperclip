import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  workRecords,
  workRecordDispatchBatchItems,
  workRecordDispatchBatches,
  workRecordExecutionHolds,
  workRecordExecutionIntents,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecordQualityCycles,
  workRecordQualityItems,
  workRecordQualityLinks,
  workRecordQualityVerdicts,
} from "@paperclipai/db";
import {
  WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED_BY_DEFAULT,
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

function writesEnabledFromEnv() {
  const value = process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
  if (value === undefined) return WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED_BY_DEFAULT;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function details(code: string, extra: Record<string, unknown> = {}) {
  return { code, workflowVersion: 2, ...extra };
}

function aggregateLockKey(companyId: string, aggregateRecordId: string) {
  return `work-record-quality:${companyId}:${aggregateRecordId}`;
}

export function workRecordQualityService(db: Db, options: WorkRecordQualityOptions = {}) {
  const issueSvc = issueService(db);
  const writesEnabled = options.writesEnabled ?? writesEnabledFromEnv();
  const maxReviewRounds = options.maxReviewRounds ?? 3;

  function assertWritesEnabled() {
    if (!writesEnabled) {
      throw forbidden("Work-record workflow v2 writes are disabled", details("work_record_workflow_v2_disabled"));
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
    const cycle = await db.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, companyId),
      eq(workRecordQualityCycles.projectId, projectId),
      eq(workRecordQualityCycles.aggregateRecordId, aggregateRecordId),
      eq(workRecordQualityCycles.state, "open"),
    )).then((rows) => rows[0] ?? null);
    const items = cycle ? await db.select().from(workRecordQualityItems).where(and(
      eq(workRecordQualityItems.companyId, companyId),
      eq(workRecordQualityItems.cycleId, cycle.id),
    )).orderBy(asc(workRecordQualityItems.createdAt), asc(workRecordQualityItems.id)) : [];
    const verdicts = cycle ? await db.select().from(workRecordQualityVerdicts).where(and(
      eq(workRecordQualityVerdicts.companyId, companyId),
      eq(workRecordQualityVerdicts.cycleId, cycle.id),
    )).orderBy(asc(workRecordQualityVerdicts.createdAt), asc(workRecordQualityVerdicts.id)) : [];
    const links = await db.select().from(workRecordQualityLinks).where(and(
      eq(workRecordQualityLinks.companyId, companyId),
      eq(workRecordQualityLinks.projectId, projectId),
      eq(workRecordQualityLinks.packageRecordId, aggregateRecordId),
    )).orderBy(asc(workRecordQualityLinks.createdAt), asc(workRecordQualityLinks.id));
    return { aggregate, cycle, items, verdicts, links };
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
    kind: "rework_release" | "qa_retest_release";
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
    kind: "rework_release" | "qa_retest_release";
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
      businessStatus: "todo",
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
    const qaRecordIds = [...new Set(links.map((link) => link.qaRecordId).filter((id): id is string => Boolean(id)))];
    const qaRecords = qaRecordIds.length > 0 ? await tx.select().from(workRecords).where(and(
      eq(workRecords.companyId, input.companyId),
      eq(workRecords.projectId, input.projectId),
      inArray(workRecords.id, qaRecordIds),
    )) : [];
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

  async function recordPoVerdict(companyId: string, projectId: string, aggregateRecordId: string, input: RecordPoQualityVerdict, actor: Actor) {
    assertWritesEnabled();
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${aggregateLockKey(companyId, aggregateRecordId)}, 0))`);
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
    });
    return { ...result, quality: await currentView(companyId, projectId, aggregateRecordId) };
  }

  async function linkPackageDefect(companyId: string, projectId: string, input: LinkWorkPackageDefect, actor: Actor) {
    assertWritesEnabled();
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
      const qaRecord = records.find((record) => record.id === input.qaRecordId)!;
      assertRole(actor, qaRecord.assigneeAgentId, "QA");
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
    assertWritesEnabled();
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
        if (cycle.cycleNumber >= maxReviewRounds || escalated) {
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
    if (!writesEnabled) return false;
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
      const qaItems = refreshed.filter((item) => item.role === "qa" && item.required);
      if (qaItems.length > 0) {
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

  async function reconcileAll(limit = 25) {
    if (!writesEnabled) return 0;
    const cycles = await db.select({
      id: workRecordQualityCycles.id,
      companyId: workRecordQualityCycles.companyId,
      projectId: workRecordQualityCycles.projectId,
    }).from(workRecordQualityCycles).where(eq(workRecordQualityCycles.state, "open"))
      .orderBy(asc(workRecordQualityCycles.updatedAt), asc(workRecordQualityCycles.id)).limit(limit);
    for (const cycle of cycles) await reconcileCycle(cycle.companyId, cycle.projectId, cycle.id);
    return cycles.length;
  }

  return {
    get: currentView,
    recordPoVerdict,
    recordQaVerdict,
    linkPackageDefect,
    reconcileCycle,
    reconcileAll,
    writesEnabled,
  };
}
