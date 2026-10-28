import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
  issueRelations,
  projects,
  workRecords,
  workRecordAssignmentGapEscalations,
  workRecordDependencies,
  workRecordDependencySnapshots,
  workRecordDispatchBatchItems,
  workRecordDispatchBatches,
  workRecordExecutionHolds,
  workRecordExecutionIntents,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecordQualityCycles,
  workRecordQualityItems,
} from "@paperclipai/db";
import { reconcileCandidatesIndependently } from "./work-record-candidate-scan.js";
import {
  WORK_PACKAGE_MAX_DEPTH,
  WORK_RECORD_LIST_DEFAULT_LIMIT,
  WORK_RECORD_LIST_MAX_LIMIT,
  WORK_RECORD_OUTBOX_MAX_ATTEMPTS,
  classifyWorkRecordCommandReplay,
  classifyWorkRecordWorkflowEvent,
  validateWorkPackageBoundaries,
  type PrepareWorkPackageDispatch,
  type PreviewWorkPackageDispatch,
  type EscalateWorkPackageAssignmentGaps,
  type RecoverWorkRecordOutbox,
  type WorkPackageAssignmentEscalationReceipt,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { budgetService } from "./budgets.js";
import { issueService, listUnfinalizedExecutionWorkspaceIds } from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";
import { resolveWorkRecordWorkflowV2Rollout } from "./work-record-workflow-v2-rollout.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | DbTransaction;
type Actor = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};
type AssignmentGapDelivery = (input: {
  escalationId: string;
  targetCeoAgentId: string;
  companyId: string;
  projectId: string;
  rootRecordId: string | null;
  scopeDigest: string;
  missingRecordIds: string[];
  deliveryAttempt: number;
  actor: Actor;
}) => Promise<{
  wakeupRequestId: string;
  wakeStatus: string;
  runId: string | null;
  claimedAt: Date | null;
  finishedAt: Date | null;
}>;
type Wakeup = (agentId: string, options: {
  source: "assignment";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  allowRunCoalescing: boolean;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

export type WorkPackageFailpoint =
  | "before_batch_commit"
  | "after_partial_materialization"
  | "after_outbox_commit"
  | "before_projection_update";

export interface WorkPackageDispatchOptions {
  writesEnabled?: boolean;
  failpoint?: (name: WorkPackageFailpoint) => void | Promise<void>;
}

type ScopeRecord = typeof workRecords.$inferSelect & { depth: number };
type ScopeEdge = typeof workRecordDependencies.$inferSelect;

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const ASSIGNMENT_GAP_DELIVERY_STALE_MS = 60_000;
const WORK_RECORD_OPERATIONS_WINDOW_HOURS = 24;
const FAILED_WAKE_STATUSES = new Set(["skipped", "failed", "cancelled"]);
const FAILED_RUN_STATUSES = new Set(["failed", "cancelled", "timed_out"]);
const WORK_RECORD_GOVERNANCE_RECHECK_MS = 30_000;

function isIntentIssueStatusAdmissible(
  issue: typeof issues.$inferSelect,
  intentKind: typeof workRecordExecutionIntents.$inferSelect.kind,
) {
  return ["backlog", "todo"].includes(issue.status)
    || (intentKind === "rework_release" && issue.status === "in_progress");
}

function projectLockKey(companyId: string, projectId: string) {
  return `work-package-dispatch:${companyId}:${projectId}`;
}

function details(code: string, extra: Record<string, unknown> = {}) {
  return { code, workflowVersion: 2, ...extra };
}

export function workPackageDispatchService(db: Db, options: WorkPackageDispatchOptions = {}) {
  const issueSvc = issueService(db);
  const budgets = budgetService(db);
  const treeControl = issueTreeControlService(db);
  const rollout = resolveWorkRecordWorkflowV2Rollout({ writesEnabled: options.writesEnabled });
  const writesEnabled = rollout.globalEnabled;

  function assertWritesEnabled(companyId: string, projectId: string) {
    const decision = rollout.decision(companyId, projectId);
    if (!decision.scopeEnabled) {
      throw forbidden(
        decision.globalEnabled
          ? "Work-package workflow v2 writes are not approved for this cohort"
          : "Work-package workflow v2 writes are disabled",
        details(
          decision.globalEnabled
            ? "work_record_workflow_v2_scope_denied"
            : "work_record_workflow_v2_disabled",
          { rollout: decision.reason },
        ),
      );
    }
  }

  function rolloutPredicate(
    companyColumn: PgColumn,
    projectColumn: PgColumn,
  ) {
    if (rollout.allScopes) return undefined;
    if (rollout.scopes.length === 0) return sql`false`;
    return or(...rollout.scopes.map((scope) => and(
      eq(companyColumn, scope.companyId),
      eq(projectColumn, scope.projectId),
    )));
  }

  async function computeScope(
    database: DbLike,
    companyId: string,
    projectId: string,
    input: PreviewWorkPackageDispatch,
    lock = false,
  ) {
    if (input.projectId !== projectId) {
      throw unprocessable("Project does not match request path", details("work_record_workflow_project_boundary"));
    }

    const allRecords = await database
      .select()
      .from(workRecords)
      .where(and(eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId)))
      .orderBy(asc(workRecords.id));
    const byId = new Map(allRecords.map((record) => [record.id, record]));
    let scoped: ScopeRecord[] = [];

    if (input.scopeKind === "selected_records") {
      const selected = new Set(input.selectedRecordIds);
      scoped = allRecords
        .filter((record) => selected.has(record.id))
        .map((record) => ({ ...record, depth: 0 }));
      if (scoped.length !== selected.size) {
        throw notFound("One or more selected work records were not found");
      }
    } else {
      const rootId = input.rootRecordId!;
      const root = byId.get(rootId);
      if (!root) throw notFound("Root work record not found");
      const children = new Map<string, typeof allRecords>();
      for (const record of allRecords) {
        if (!record.parentRecordId) continue;
        const list = children.get(record.parentRecordId) ?? [];
        list.push(record);
        children.set(record.parentRecordId, list);
      }
      const queue: Array<{ record: typeof root; depth: number }> = [{ record: root, depth: 0 }];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (seen.has(current.record.id)) {
          throw unprocessable("Work-record hierarchy contains a cycle", details("work_package_dependency_cycle"));
        }
        seen.add(current.record.id);
        scoped.push({ ...current.record, depth: current.depth });
        for (const child of children.get(current.record.id) ?? []) {
          queue.push({ record: child, depth: current.depth + 1 });
        }
      }
    }

    if (lock && scoped.length > 0) {
      await database
        .select({ id: workRecords.id })
        .from(workRecords)
        .where(and(
          eq(workRecords.companyId, companyId),
          eq(workRecords.projectId, projectId),
          inArray(workRecords.id, scoped.map((record) => record.id)),
        ))
        .orderBy(asc(workRecords.id))
        .for("update");
    }

    const recordIds = scoped.map((record) => record.id);
    const allEdges: ScopeEdge[] = await database
      .select()
      .from(workRecordDependencies)
      .where(and(
        eq(workRecordDependencies.companyId, companyId),
        eq(workRecordDependencies.projectId, projectId),
      ))
      .orderBy(asc(workRecordDependencies.predecessorRecordId), asc(workRecordDependencies.successorRecordId));
    const selectedIds = new Set(recordIds);
    const edges = allEdges.filter((edge) => selectedIds.has(edge.successorRecordId));

    const color = new Map<string, 0 | 1 | 2>();
    const outgoing = new Map<string, string[]>();
    for (const edge of allEdges) {
      const list = outgoing.get(edge.predecessorRecordId) ?? [];
      list.push(edge.successorRecordId);
      outgoing.set(edge.predecessorRecordId, list);
    }
    const visit = (id: string): boolean => {
      if (color.get(id) === 1) return false;
      if (color.get(id) === 2) return true;
      color.set(id, 1);
      for (const next of outgoing.get(id) ?? []) if (!visit(next)) return false;
      color.set(id, 2);
      return true;
    };
    for (const record of allRecords) {
      if (!visit(record.id)) {
        throw unprocessable("Work-record dependencies contain a cycle", details("work_package_dependency_cycle"));
      }
    }

    const maxDepth = scoped.reduce((maximum, record) => Math.max(maximum, record.depth), 0);
    const boundary = validateWorkPackageBoundaries({
      recordCount: scoped.length,
      depth: maxDepth,
      edgeCount: edges.length,
    });
    if (!boundary.ok) {
      throw unprocessable("Work-package boundary exceeded", details(boundary.code, {
        limit: boundary.limit,
        actual: boundary.actual,
      }));
    }

    const blockers = scoped.flatMap((record) => {
      const result: Array<{
        code: "missing_po" | "missing_assignee" | "missing_qa";
        recordId: string;
        title: string;
        requiredRole: "PO" | "执行人" | "QA";
      }> = [];
      if (!record.assigneeAgentId) {
        const rootPo = input.scopeKind === "whole_package" && record.id === input.rootRecordId;
        result.push({
          code: rootPo ? "missing_po" : "missing_assignee",
          recordId: record.id,
          title: record.title,
          requiredRole: rootPo ? "PO" : "执行人",
        });
      }
      if (record.kind === "defect" && (!record.qaAssigneeAgentId || record.qaAssigneeAgentId === record.assigneeAgentId)) {
        result.push({ code: "missing_qa", recordId: record.id, title: record.title, requiredRole: "QA" });
      }
      return result;
    });
    const validatedAgentIds = new Set<string>();
    for (const record of scoped) {
      if (record.assigneeAgentId && !validatedAgentIds.has(record.assigneeAgentId)) {
        await assertAssignableAgent(database as Db, companyId, record.assigneeAgentId, { kind: "work" });
        validatedAgentIds.add(record.assigneeAgentId);
      }
      if (record.kind === "defect") {
        if (record.qaAssigneeAgentId && !validatedAgentIds.has(record.qaAssigneeAgentId)) {
          await assertAssignableAgent(database as Db, companyId, record.qaAssigneeAgentId, { kind: "work" });
          validatedAgentIds.add(record.qaAssigneeAgentId);
        }
      }
    }

    const scopeDigest = digest({
      scopeKind: input.scopeKind,
      rootRecordId: input.rootRecordId,
      records: scoped.map((record) => [
        record.id,
        record.revision,
        record.parentRecordId,
        record.assigneeAgentId,
        record.qaAssigneeAgentId,
      ]),
      edges: edges.map((edge) => [edge.predecessorRecordId, edge.successorRecordId]),
    });
    const root = input.rootRecordId ? byId.get(input.rootRecordId) ?? null : scoped[0] ?? null;
    const dependencySetRevision = Math.max(1, ...scoped.map((record) => record.dependencySetRevision));
    return {
      workflowVersion: 2 as const,
      projectId,
      rootRecordId: input.rootRecordId,
      scopeKind: input.scopeKind,
      scopeDigest,
      rootRevision: root?.revision ?? 1,
      dependencySetRevision,
      recordCount: scoped.length,
      edgeCount: edges.length,
      maxDepth: Math.min(maxDepth, WORK_PACKAGE_MAX_DEPTH),
      records: scoped,
      edges,
      eligibility: { canPrepare: blockers.length === 0, blockers },
    };
  }

  async function preview(companyId: string, projectId: string, input: PreviewWorkPackageDispatch) {
    const scope = await computeScope(db, companyId, projectId, input);
    const persistedEscalation = await db.select().from(workRecordAssignmentGapEscalations).where(and(
      eq(workRecordAssignmentGapEscalations.companyId, companyId),
      eq(workRecordAssignmentGapEscalations.projectId, projectId),
      eq(workRecordAssignmentGapEscalations.scopeDigest, scope.scopeDigest),
    )).then((rows) => rows[0] ?? null);
    const escalation = persistedEscalation
      ? await reconcileAssignmentEscalation(persistedEscalation)
      : null;
    return {
      ...scope,
      records: scope.records.map((record) => ({
        id: record.id,
        title: record.title,
        revision: record.revision,
        dependencySetRevision: record.dependencySetRevision,
        parentRecordId: record.parentRecordId,
        assigneeAgentId: record.assigneeAgentId,
        qaAssigneeAgentId: record.qaAssigneeAgentId,
        depth: record.depth,
      })),
      edges: scope.edges.map((edge) => ({
        predecessorRecordId: edge.predecessorRecordId,
        successorRecordId: edge.successorRecordId,
      })),
      eligibility: {
        ...scope.eligibility,
        escalation: escalation ? assignmentEscalationReceipt(escalation, false) : null,
      },
    };
  }

  function assignmentEscalationReceipt(
    row: typeof workRecordAssignmentGapEscalations.$inferSelect,
    replayed: boolean,
  ): WorkPackageAssignmentEscalationReceipt {
    return {
      id: row.id,
      clientRequestId: row.clientRequestId,
      scopeDigest: row.scopeDigest,
      targetCeoAgentId: row.targetCeoAgentId,
      state: row.state as WorkPackageAssignmentEscalationReceipt["state"],
      deliveryAttempt: row.deliveryAttempt,
      wakeupRequestId: row.wakeupRequestId,
      wakeStatus: row.wakeStatus,
      runId: row.runId,
      runStatus: row.runStatus,
      deliveryErrorCode: row.deliveryErrorCode,
      deliveredAt: row.deliveredAt,
      acknowledgedAt: row.acknowledgedAt,
      recordedAt: row.createdAt,
      updatedAt: row.updatedAt,
      missingRecordIds: row.missingRecordIds,
      replayed,
    };
  }

  async function reconcileAssignmentEscalation(
    row: typeof workRecordAssignmentGapEscalations.$inferSelect,
  ) {
    const storedWake = row.wakeupRequestId
      ? await db.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, row.companyId),
          eq(agentWakeupRequests.id, row.wakeupRequestId),
        )).then((rows) => rows[0] ?? null)
      : null;
    // A process can stop after heartbeat.wakeup commits but before this receipt
    // stores wakeupRequestId. Recover that exact attempt before allowing retry.
    const wakeCandidates = !storedWake && row.deliveryAttempt > 0 && row.targetCeoAgentId
      ? await db.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, row.companyId),
          eq(agentWakeupRequests.agentId, row.targetCeoAgentId),
          eq(agentWakeupRequests.idempotencyKey, `work-record-assignment-gap:${row.id}:${row.deliveryAttempt}`),
        )).orderBy(desc(agentWakeupRequests.createdAt))
      : [];
    const wake = storedWake
      ?? wakeCandidates.find((candidate) => !FAILED_WAKE_STATUSES.has(candidate.status))
      ?? wakeCandidates[0]
      ?? null;
    const run = wake?.runId
      ? await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, row.companyId),
          eq(heartbeatRuns.id, wake.runId),
        )).then((rows) => rows[0] ?? null)
      : wake
        ? await db.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, row.companyId),
            eq(heartbeatRuns.wakeupRequestId, wake.id),
          )).orderBy(desc(heartbeatRuns.createdAt)).then((rows) => rows[0] ?? null)
        : null;

    let state = row.state;
    let deliveryErrorCode = row.deliveryErrorCode;
    let deliveredAt = row.deliveredAt;
    let acknowledgedAt = row.acknowledgedAt;
    if (wake) {
      if (FAILED_WAKE_STATUSES.has(wake.status) || (run && FAILED_RUN_STATUSES.has(run.status))) {
        state = "delivery_failed";
        deliveryErrorCode = run && FAILED_RUN_STATUSES.has(run.status)
          ? `ceo_run_${run.status}`
          : `ceo_wakeup_${wake.status}`;
      } else if (wake.status === "completed" || run?.status === "succeeded" || run?.status === "completed") {
        state = "acknowledged";
        deliveryErrorCode = null;
        deliveredAt ??= wake.claimedAt ?? run?.startedAt ?? new Date();
        acknowledgedAt ??= wake.finishedAt ?? run?.finishedAt ?? new Date();
      } else if (wake.status === "claimed" || run?.status === "running") {
        state = "delivered";
        deliveryErrorCode = null;
        deliveredAt ??= wake.claimedAt ?? run?.startedAt ?? new Date();
      } else {
        state = "queued";
        deliveryErrorCode = null;
      }
    } else if (
      row.state === "delivering"
      && Date.now() - row.updatedAt.getTime() >= ASSIGNMENT_GAP_DELIVERY_STALE_MS
    ) {
      state = "delivery_failed";
      deliveryErrorCode = "ceo_wakeup_timeout";
    }

    const wakeupRequestId = wake?.id ?? row.wakeupRequestId;
    const runId = run?.id ?? wake?.runId ?? row.runId;
    const wakeStatus = wake?.status ?? row.wakeStatus;
    const runStatus = run?.status ?? row.runStatus;
    const changed = state !== row.state
      || wakeupRequestId !== row.wakeupRequestId
      || deliveryErrorCode !== row.deliveryErrorCode
      || deliveredAt?.getTime() !== row.deliveredAt?.getTime()
      || acknowledgedAt?.getTime() !== row.acknowledgedAt?.getTime()
      || wakeStatus !== row.wakeStatus
      || runId !== row.runId
      || runStatus !== row.runStatus;
    if (!changed) return row;
    const updated = await db.update(workRecordAssignmentGapEscalations).set({
      state,
      wakeupRequestId,
      wakeStatus,
      runId,
      runStatus,
      deliveryErrorCode,
      deliveredAt,
      acknowledgedAt,
      updatedAt: new Date(),
    }).where(and(
      eq(workRecordAssignmentGapEscalations.id, row.id),
      eq(workRecordAssignmentGapEscalations.deliveryAttempt, row.deliveryAttempt),
    )).returning().then((rows) => rows[0] ?? null);
    return updated ?? db.select().from(workRecordAssignmentGapEscalations)
      .where(eq(workRecordAssignmentGapEscalations.id, row.id)).then((rows) => rows[0]);
  }

  async function latestAssignmentEscalation(
    companyId: string,
    projectId: string,
    rootRecordId: string,
  ) {
    const current = await preview(companyId, projectId, {
      workflowVersion: 2,
      projectId,
      scopeKind: "whole_package",
      rootRecordId,
      selectedRecordIds: [],
    });
    return current.eligibility.escalation;
  }

  async function escalateAssignmentGaps(
    companyId: string,
    projectId: string,
    input: EscalateWorkPackageAssignmentGaps,
    actor: Actor,
    deliver: AssignmentGapDelivery,
  ) {
    assertWritesEnabled(companyId, projectId);
    const persisted = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${projectLockKey(companyId, projectId)}, 0))`);
      const existingRequest = await tx.select().from(workRecordAssignmentGapEscalations).where(and(
        eq(workRecordAssignmentGapEscalations.companyId, companyId),
        eq(workRecordAssignmentGapEscalations.clientRequestId, input.clientRequestId),
      )).then((rows) => rows[0] ?? null);
      if (existingRequest) {
        const replay = classifyWorkRecordCommandReplay(existingRequest.requestPayloadDigest, input.requestPayloadDigest);
        if (replay.outcome === "conflict") {
          throw conflict("Client request key was already used with a different payload", details(replay.code, {
            escalationId: existingRequest.id,
          }));
        }
        if (existingRequest.projectId !== projectId) {
          throw conflict("Client request key belongs to another project", details("work_record_workflow_project_boundary"));
        }
        return { row: existingRequest, replayed: true };
      }

      const scope = await computeScope(tx, companyId, projectId, input, true);
      if (scope.scopeDigest !== input.expectedScopeDigest) {
        throw conflict("Work-package scope changed after preview", details("work_record_workflow_stale_revision", {
          expectedScopeDigest: input.expectedScopeDigest,
          currentScopeDigest: scope.scopeDigest,
        }));
      }
      if (scope.eligibility.canPrepare) {
        throw unprocessable("Work-package has no ownership gaps to escalate", details("work_package_assignment_gap_missing"));
      }
      const existingScope = await tx.select().from(workRecordAssignmentGapEscalations).where(and(
        eq(workRecordAssignmentGapEscalations.companyId, companyId),
        eq(workRecordAssignmentGapEscalations.projectId, projectId),
        eq(workRecordAssignmentGapEscalations.scopeDigest, scope.scopeDigest),
      )).then((rows) => rows[0] ?? null);
      if (existingScope) return { row: existingScope, replayed: true };

      const targetCeoAgentId = await assignmentEscalationTarget(companyId, tx);
      const missingRecordIds = [...new Set(scope.eligibility.blockers.map((blocker) => blocker.recordId))];
      const row = await tx.insert(workRecordAssignmentGapEscalations).values({
        companyId,
        projectId,
        rootRecordId: scope.rootRecordId,
        scopeKind: scope.scopeKind,
        scopeDigest: scope.scopeDigest,
        clientRequestId: input.clientRequestId,
        requestPayloadDigest: input.requestPayloadDigest,
        blockers: scope.eligibility.blockers,
        missingRecordIds,
        targetCeoAgentId,
        state: targetCeoAgentId ? "pending" : "ceo_unavailable",
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.userId ?? null,
        actorRunId: actor.runId ?? null,
      }).returning().then((rows) => rows[0]);
      return { row, replayed: false };
    });

    const current = await reconcileAssignmentEscalation(persisted.row);
    if (!["pending", "ceo_unavailable", "delivery_failed"].includes(current.state)) {
      return assignmentEscalationReceipt(current, persisted.replayed);
    }
    const targetCeoAgentId = current.state === "pending" && current.targetCeoAgentId
      ? current.targetCeoAgentId
      : await assignmentEscalationTarget(companyId, db);
    if (!targetCeoAgentId) {
      const unavailable = current.state === "ceo_unavailable"
        ? current
        : await db.update(workRecordAssignmentGapEscalations).set({
            state: "ceo_unavailable",
            targetCeoAgentId: null,
            updatedAt: new Date(),
          }).where(eq(workRecordAssignmentGapEscalations.id, current.id)).returning().then((rows) => rows[0]);
      return assignmentEscalationReceipt(unavailable, persisted.replayed);
    }

    const claimed = await db.update(workRecordAssignmentGapEscalations).set({
      state: "delivering",
      targetCeoAgentId,
      deliveryAttempt: sql`${workRecordAssignmentGapEscalations.deliveryAttempt} + 1`,
      wakeupRequestId: null,
      wakeStatus: null,
      runId: null,
      runStatus: null,
      deliveryErrorCode: null,
      deliveredAt: null,
      acknowledgedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(workRecordAssignmentGapEscalations.id, current.id),
      inArray(workRecordAssignmentGapEscalations.state, ["pending", "ceo_unavailable", "delivery_failed"]),
    )).returning().then((rows) => rows[0] ?? null);
    if (!claimed) {
      const current = await db.select().from(workRecordAssignmentGapEscalations)
        .where(eq(workRecordAssignmentGapEscalations.id, persisted.row.id))
        .then((rows) => rows[0]);
      return assignmentEscalationReceipt(current, true);
    }

    let delivered: typeof claimed;
    try {
      const result = await deliver({
        escalationId: claimed.id,
        targetCeoAgentId: claimed.targetCeoAgentId!,
        companyId,
        projectId,
        rootRecordId: claimed.rootRecordId,
        scopeDigest: claimed.scopeDigest,
        missingRecordIds: claimed.missingRecordIds,
        deliveryAttempt: claimed.deliveryAttempt,
        actor,
      });
      const failed = FAILED_WAKE_STATUSES.has(result.wakeStatus);
      const acknowledged = result.wakeStatus === "completed";
      const accepted = result.wakeStatus === "claimed";
      delivered = await db.update(workRecordAssignmentGapEscalations).set({
        state: failed ? "delivery_failed" : acknowledged ? "acknowledged" : accepted ? "delivered" : "queued",
        wakeupRequestId: result.wakeupRequestId,
        wakeStatus: result.wakeStatus,
        runId: result.runId,
        deliveryErrorCode: failed ? `ceo_wakeup_${result.wakeStatus}` : null,
        deliveredAt: accepted || acknowledged ? result.claimedAt ?? new Date() : null,
        acknowledgedAt: acknowledged ? result.finishedAt ?? new Date() : null,
        updatedAt: new Date(),
      }).where(eq(workRecordAssignmentGapEscalations.id, claimed.id)).returning().then((rows) => rows[0]);
    } catch {
      delivered = await db.update(workRecordAssignmentGapEscalations).set({
        state: "delivery_failed",
        deliveryErrorCode: "ceo_wakeup_failed",
        updatedAt: new Date(),
      }).where(eq(workRecordAssignmentGapEscalations.id, claimed.id)).returning().then((rows) => rows[0]);
    }
    return assignmentEscalationReceipt(await reconcileAssignmentEscalation(delivered), persisted.replayed);
  }

  async function batchView(companyId: string, projectId: string, batchId: string) {
    const batch = await db.select().from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, companyId),
      eq(workRecordDispatchBatches.projectId, projectId),
      eq(workRecordDispatchBatches.id, batchId),
    )).then((rows) => rows[0] ?? null);
    if (!batch) throw notFound("Work-package dispatch batch not found");
    const items = await db.select().from(workRecordDispatchBatchItems).where(and(
      eq(workRecordDispatchBatchItems.companyId, companyId),
      eq(workRecordDispatchBatchItems.batchId, batchId),
    )).orderBy(asc(workRecordDispatchBatchItems.createdAt), asc(workRecordDispatchBatchItems.id));
    return { batch, items };
  }

  async function prepare(companyId: string, projectId: string, input: PrepareWorkPackageDispatch, actor: Actor) {
    assertWritesEnabled(companyId, projectId);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${projectLockKey(companyId, projectId)}, 0))`);
      const existing = await tx.select().from(workRecordDispatchBatches).where(and(
        eq(workRecordDispatchBatches.companyId, companyId),
        eq(workRecordDispatchBatches.clientRequestId, input.clientRequestId),
      )).then((rows) => rows[0] ?? null);
      if (existing) {
        const replay = classifyWorkRecordCommandReplay(existing.requestPayloadDigest, input.requestPayloadDigest);
        if (replay.outcome === "conflict") {
          throw conflict("Client request key was already used with a different payload", details(replay.code, {
            batchId: existing.id,
          }));
        }
        if (existing.projectId !== projectId) {
          throw conflict("Client request key belongs to another project", details("work_record_workflow_project_boundary"));
        }
        return { batchId: existing.id, replayed: true };
      }

      const scope = await computeScope(tx, companyId, projectId, input, true);
      if (!scope.eligibility.canPrepare) {
        throw unprocessable("Work-package ownership gaps must be resolved before dispatch", details(
          "work_package_assignment_required",
          {
            recordIds: [...new Set(scope.eligibility.blockers.map((blocker) => blocker.recordId))],
            blockers: scope.eligibility.blockers,
          },
        ));
      }
      if (input.expectedScopeDigest !== undefined && scope.scopeDigest !== input.expectedScopeDigest) {
        throw conflict("Work-package scope changed after preview", details("work_record_workflow_stale_revision", {
          expectedScopeDigest: input.expectedScopeDigest,
          currentScopeDigest: scope.scopeDigest,
        }));
      }
      if (scope.rootRevision !== input.expectedRootRevision ||
          scope.dependencySetRevision !== input.expectedDependencySetRevision) {
        throw conflict("Work-package revision changed after preview", details("work_record_workflow_stale_revision", {
          currentRootRevision: scope.rootRevision,
          currentDependencySetRevision: scope.dependencySetRevision,
        }));
      }

      const batch = await tx.insert(workRecordDispatchBatches).values({
        companyId,
        projectId,
        rootRecordId: input.rootRecordId,
        clientRequestId: input.clientRequestId,
        requestPayloadDigest: input.requestPayloadDigest,
        scopeKind: input.scopeKind,
        scopeDigest: scope.scopeDigest,
        rootRecordRevision: scope.rootRevision,
        dependencySetRevision: scope.dependencySetRevision,
        workflowVersion: 2,
        state: "preparing",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      }).returning().then((rows) => rows[0]);

      const items = await tx.insert(workRecordDispatchBatchItems).values(scope.records.map((record) => ({
        companyId,
        projectId,
        batchId: batch.id,
        recordId: record.id,
        recordRevision: record.revision,
        inclusionReason: input.scopeKind === "whole_package"
          ? record.id === input.rootRecordId ? "root" : "descendant"
          : "selected",
      }))).returning();

      if (scope.edges.length > 0) {
        const byId = new Map(scope.records.map((record) => [record.id, record]));
        const externalPredecessors = await tx.select().from(workRecords).where(and(
          eq(workRecords.companyId, companyId),
          eq(workRecords.projectId, projectId),
          inArray(workRecords.id, [...new Set(scope.edges.map((edge) => edge.predecessorRecordId))]),
        ));
        for (const record of externalPredecessors) byId.set(record.id, { ...record, depth: 0 });
        await tx.insert(workRecordDependencySnapshots).values(scope.edges.map((edge) => ({
          companyId,
          projectId,
          batchId: batch.id,
          predecessorRecordId: edge.predecessorRecordId,
          successorRecordId: edge.successorRecordId,
          predecessorRevision: byId.get(edge.predecessorRecordId)!.revision,
          successorRevision: byId.get(edge.successorRecordId)!.revision,
        })));
      }

      const itemByRecord = new Map(items.map((item) => [item.recordId, item]));
      const rootId = input.scopeKind === "whole_package" ? input.rootRecordId : null;
      const descendantIds = scope.records.filter((record) => record.id !== rootId).map((record) => record.id);
      let poQualityItemId: string | null = null;
      if (rootId && descendantIds.length > 0) {
        const cycle = await tx.insert(workRecordQualityCycles).values({
          companyId,
          projectId,
          aggregateRecordId: rootId,
          cycleNumber: 1,
          kind: "package_acceptance",
          state: "open",
          qualityPhase: "waiting_children",
          scopeDigest: scope.scopeDigest,
          openedByAgentId: actor.agentId ?? null,
          openedByUserId: actor.userId ?? null,
        }).returning().then((rows) => rows[0]);
        poQualityItemId = await tx.insert(workRecordQualityItems).values({
          companyId,
          projectId,
          cycleId: cycle.id,
          recordId: rootId,
          role: "po",
          required: true,
          state: "waiting",
        }).returning({ id: workRecordQualityItems.id }).then((rows) => rows[0].id);
        await tx.insert(workRecordQualityItems).values(
          scope.records
            .filter((record) => record.id !== rootId)
            .map((record) => ({
              companyId,
              projectId,
              cycleId: cycle.id,
              recordId: record.id,
              role: "repair" as const,
              required: true,
              state: "waiting",
            })),
        );
      }

      if (input.scopeKind === "selected_records") {
        for (const record of scope.records.filter((candidate) => candidate.kind === "defect")) {
          const cycle = await tx.insert(workRecordQualityCycles).values({
            companyId,
            projectId,
            aggregateRecordId: record.id,
            cycleNumber: 1,
            kind: "independent_defect",
            state: "open",
            qualityPhase: "waiting_fix",
            scopeDigest: scope.scopeDigest,
            openedByAgentId: actor.agentId ?? null,
            openedByUserId: actor.userId ?? null,
          }).returning().then((rows) => rows[0]);
          await tx.insert(workRecordQualityItems).values([
            {
              companyId,
              projectId,
              cycleId: cycle.id,
              recordId: record.id,
              defectRecordId: record.id,
              role: "repair",
              required: true,
              state: "ready",
            },
            {
              companyId,
              projectId,
              cycleId: cycle.id,
              recordId: record.id,
              defectRecordId: record.id,
              role: "qa",
              required: true,
              state: "blocked",
            },
          ]);
        }
      }

      for (const record of scope.records) {
        const isPo = record.id === rootId && descendantIds.length > 0;
        const sourceId = isPo ? poQualityItemId : itemByRecord.get(record.id)!.id;
        await tx.insert(workRecordExecutionIntents).values({
          companyId,
          projectId,
          recordId: record.id,
          issueId: null,
          batchItemId: isPo ? null : sourceId,
          qualityItemId: isPo ? sourceId : null,
          intentKey: `work-package:${batch.id}:${isPo ? "po" : record.id}`,
          requestPayloadDigest: digest({ batchId: batch.id, recordId: record.id, kind: isPo ? "po_acceptance_release" : "initial_release" }),
          kind: isPo ? "po_acceptance_release" : "initial_release",
          generation: 1,
          expectedIssueStatusVersion: 0,
          state: "waiting_dependencies",
          waitingReason: isPo ? "children_pending" : "materialization_pending",
        });
      }

      await options.failpoint?.("before_batch_commit");
      return { batchId: batch.id, replayed: false };
    });

    const reconciled = await reconcile(companyId, projectId, result.batchId, actor);
    return { ...reconciled, replayed: result.replayed };
  }

  async function materializeItem(
    companyId: string,
    projectId: string,
    batchId: string,
    item: typeof workRecordDispatchBatchItems.$inferSelect,
    actor: Actor,
  ) {
    return db.transaction(async (tx) => {
      const locked = await tx.select().from(workRecordDispatchBatchItems).where(and(
        eq(workRecordDispatchBatchItems.companyId, companyId),
        eq(workRecordDispatchBatchItems.id, item.id),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!locked || locked.materializationState === "materialized" || locked.materializationState === "reused") return;
      const record = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId),
        eq(workRecords.projectId, projectId),
        eq(workRecords.id, locked.recordId),
      )).then((rows) => rows[0] ?? null);
      if (!record || record.revision !== locked.recordRevision) {
        await tx.update(workRecordDispatchBatchItems).set({ materializationState: "blocked", updatedAt: new Date() })
          .where(eq(workRecordDispatchBatchItems.id, locked.id));
        return;
      }
      const existing = await tx.select().from(workRecordIssueLinks).where(and(
        eq(workRecordIssueLinks.companyId, companyId),
        eq(workRecordIssueLinks.recordId, record.id),
        eq(workRecordIssueLinks.purpose, "primary"),
      )).then((rows) => rows[0] ?? null);
      let link = existing;
      if (!link) {
        const parentLink = record.parentRecordId
          ? await tx.select().from(workRecordIssueLinks).where(and(
              eq(workRecordIssueLinks.companyId, companyId),
              eq(workRecordIssueLinks.recordId, record.parentRecordId),
              eq(workRecordIssueLinks.purpose, "primary"),
            )).then((rows) => rows[0] ?? null)
          : null;
        const createdIssue = await issueSvc.create(companyId, {
          projectId,
          parentId: parentLink?.issueId ?? null,
          title: record.title,
          description: record.description,
          status: "todo",
          priority: "medium",
          assigneeAgentId: record.assigneeAgentId,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          originKind: "work_record",
          originId: record.id,
          ...(record.kind === "defect" && record.qaAssigneeAgentId
            ? {
                executionPolicy: {
                  mode: "normal",
                  commentRequired: true,
                  maxReviewRounds: 3,
                  stages: [{
                    id: randomUUID(),
                    type: "review",
                    approvalsNeeded: 1,
                    participants: [{
                      id: randomUUID(),
                      type: "agent",
                      agentId: record.qaAssigneeAgentId,
                    }],
                  }],
                },
              }
            : {}),
          idempotencyKey: `work-package-batch-item:${locked.id}`,
          allowDuplicate: true,
        }, tx);
        link = await tx.insert(workRecordIssueLinks).values({
          companyId,
          projectId,
          recordId: record.id,
          issueId: createdIssue.id,
          purpose: "primary",
          dispatchRound: record.dispatchRound + 1,
        }).onConflictDoNothing().returning().then((rows) => rows[0] ?? null);
        if (!link) {
          link = await tx.select().from(workRecordIssueLinks).where(and(
            eq(workRecordIssueLinks.companyId, companyId),
            eq(workRecordIssueLinks.recordId, record.id),
            eq(workRecordIssueLinks.purpose, "primary"),
          )).then((rows) => rows[0]);
        }
        await tx.update(workRecords).set({
          dispatchRound: link.dispatchRound,
          dispatchState: "preparing",
          updatedAt: new Date(),
        }).where(eq(workRecords.id, record.id));
      }
      const linkedIssue = await tx.select({ statusVersion: issues.statusVersion }).from(issues).where(and(
        eq(issues.companyId, companyId), eq(issues.id, link.issueId),
      )).then((rows) => rows[0]);
      await tx.update(workRecordDispatchBatchItems).set({
        primaryIssueLinkId: link.id,
        materializationState: existing ? "reused" : "materialized",
        updatedAt: new Date(),
      }).where(eq(workRecordDispatchBatchItems.id, locked.id));
      await tx.update(workRecordExecutionIntents).set({
        issueId: link.issueId,
        expectedIssueStatusVersion: linkedIssue.statusVersion,
        waitingReason: null,
        updatedAt: new Date(),
      }).where(and(
        eq(workRecordExecutionIntents.companyId, companyId),
        eq(workRecordExecutionIntents.recordId, record.id),
        or(eq(workRecordExecutionIntents.batchItemId, locked.id), isNull(workRecordExecutionIntents.batchItemId)),
        ne(workRecordExecutionIntents.state, "superseded"),
      ));
      await tx.update(workRecordQualityItems).set({ issueLinkId: link.id, updatedAt: new Date() }).where(and(
        eq(workRecordQualityItems.companyId, companyId),
        eq(workRecordQualityItems.recordId, record.id),
        isNull(workRecordQualityItems.issueLinkId),
      ));
    });
  }

  async function governanceWaitReason(
    companyId: string,
    projectId: string,
    issue: typeof issues.$inferSelect,
    intentKind: typeof workRecordExecutionIntents.$inferSelect.kind,
  ) {
    const rolloutDecision = rollout.decision(companyId, projectId);
    if (!rolloutDecision.scopeEnabled) return `rollout.${rolloutDecision.reason}`;
    if (!issue.assigneeAgentId) return "issue.unassigned";
    if (issue.executionRunId) return "issue.execution_active";
    const admissibleStatus = isIntentIssueStatusAdmissible(issue, intentKind);
    if (!admissibleStatus) return issue.status === "in_review" ? "approval_pending" : "issue.status_not_admissible";
    const agent = await db.select().from(agents).where(and(
      eq(agents.companyId, companyId), eq(agents.id, issue.assigneeAgentId),
    )).then((rows) => rows[0] ?? null);
    const invokability = await evaluateAgentInvokabilityFromDb(db, agent);
    if (!invokability.invokable) {
      return invokability.reason === "paused" ? "agent_paused" : `agent.${invokability.reason}`;
    }
    if (!isHeartbeatWakeOnDemandEnabled(agent!)) return "agent.heartbeat_disabled";
    if (await treeControl.getActivePauseHoldGate(companyId, issue.id)) return "issue_pause_hold";
    const budgetBlock = await budgets.getInvocationBlock(companyId, issue.assigneeAgentId, {
      issueId: issue.id,
      projectId,
    });
    if (budgetBlock) {
      return budgetBlock.reason.includes("paused") && budgetBlock.scopeType === "company"
        ? "company_paused"
        : "budget.blocked";
    }
    return null;
  }

  async function finalizeBatch(companyId: string, projectId: string, batchId: string) {
    return db.transaction(async (tx) => {
      const batch = await tx.select().from(workRecordDispatchBatches).where(and(
        eq(workRecordDispatchBatches.companyId, companyId),
        eq(workRecordDispatchBatches.projectId, projectId),
        eq(workRecordDispatchBatches.id, batchId),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!batch) throw notFound("Work-package dispatch batch not found");
      if (batch.state === "superseded" || batch.state === "failed") return batch;
      const items = await tx.select().from(workRecordDispatchBatchItems).where(and(
        eq(workRecordDispatchBatchItems.companyId, companyId), eq(workRecordDispatchBatchItems.batchId, batchId),
      ));
      if (items.some((item) => !["materialized", "reused"].includes(item.materializationState))) return batch;

      const itemByRecord = new Map(items.map((item) => [item.recordId, item]));
      const snapshots = await tx.select().from(workRecordDependencySnapshots).where(and(
        eq(workRecordDependencySnapshots.companyId, companyId), eq(workRecordDependencySnapshots.batchId, batchId),
      ));
      const involvedIds = [...new Set([
        ...items.map((item) => item.recordId),
        ...snapshots.flatMap((edge) => [edge.predecessorRecordId, edge.successorRecordId]),
      ])];
      const links = involvedIds.length === 0 ? [] : await tx.select().from(workRecordIssueLinks).where(and(
        eq(workRecordIssueLinks.companyId, companyId),
        inArray(workRecordIssueLinks.recordId, involvedIds),
        eq(workRecordIssueLinks.purpose, "primary"),
      ));
      const linkByRecord = new Map(links.map((link) => [link.recordId, link]));
      const linkedIssues = links.length === 0 ? [] : await tx.select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, links.map((link) => link.issueId))));
      const statusByIssue = new Map(linkedIssues.map((issue) => [issue.id, issue.status]));
      const scopedRecords = items.length === 0 ? [] : await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId), inArray(workRecords.id, items.map((item) => item.recordId)),
      ));
      const recordById = new Map(scopedRecords.map((record) => [record.id, record]));
      for (const snapshot of snapshots) {
        const predecessor = linkByRecord.get(snapshot.predecessorRecordId) ?? null;
        const successor = linkByRecord.get(snapshot.successorRecordId) ?? null;
        await tx.update(workRecordDependencySnapshots).set({
          predecessorIssueLinkId: predecessor?.id ?? null,
          successorIssueLinkId: successor?.id ?? null,
        }).where(eq(workRecordDependencySnapshots.id, snapshot.id));
        if (predecessor && successor) {
          await tx.insert(issueRelations).values({
            companyId,
            issueId: predecessor.issueId,
            relatedIssueId: successor.issueId,
            type: "blocks",
          }).onConflictDoNothing();
        }
        if (successor) {
          const successorRecord = recordById.get(snapshot.successorRecordId);
          if (successorRecord) {
            const predecessorStatus = predecessor ? statusByIssue.get(predecessor.issueId) ?? null : null;
            const reason = !predecessor
              ? "prerequisite_not_dispatched"
              : predecessorStatus === "cancelled"
                ? "prerequisite_cancelled_impact_pending"
                : predecessorStatus === "done"
                  ? null
                  : "prerequisite_not_completed";
            if (reason) {
              await tx.insert(workRecordExecutionHolds).values({
                companyId,
                projectId,
                dependentRecordId: snapshot.successorRecordId,
                dependentIssueId: successor.issueId,
                blockingRecordId: snapshot.predecessorRecordId,
                reason,
                dispatchRound: successorRecord.dispatchRound,
                dependencySetRevision: successorRecord.dependencySetRevision,
                blockedCycle: successorRecord.blockedCycle,
              }).onConflictDoNothing();
            }
          }
        }
      }

      if (batch.rootRecordId) {
        const parentLink = linkByRecord.get(batch.rootRecordId) ?? null;
        if (parentLink) {
          for (const item of items.filter((candidate) => candidate.recordId !== batch.rootRecordId)) {
            const childLink = linkByRecord.get(item.recordId);
            if (!childLink) continue;
            await tx.insert(workRecordExecutionHolds).values({
              companyId,
              projectId,
              dependentRecordId: batch.rootRecordId,
              dependentIssueId: parentLink.issueId,
              blockingRecordId: item.recordId,
              reason: "prerequisite_not_completed",
              dispatchRound: linkByRecord.get(batch.rootRecordId)?.dispatchRound ?? 1,
              dependencySetRevision: batch.dependencySetRevision,
              blockedCycle: 0,
            }).onConflictDoNothing();
          }
        }
      }

      const now = new Date();
      await tx.update(workRecordDispatchBatches).set({ state: "prepared", errorCode: null, updatedAt: now })
        .where(eq(workRecordDispatchBatches.id, batch.id));
      await tx.update(workRecords).set({ dispatchState: "linked", updatedAt: now }).where(and(
        eq(workRecords.companyId, companyId),
        inArray(workRecords.id, items.map((item) => item.recordId)),
      ));
      return { ...batch, state: "prepared" };
    });
  }

  async function refreshIntents(companyId: string, projectId: string, batchId: string) {
    const batch = await db.select().from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, companyId),
      eq(workRecordDispatchBatches.projectId, projectId),
      eq(workRecordDispatchBatches.id, batchId),
      eq(workRecordDispatchBatches.state, "prepared"),
    )).then((rows) => rows[0] ?? null);
    if (!batch) return;
    const batchItems = await db.select({ recordId: workRecordDispatchBatchItems.recordId })
      .from(workRecordDispatchBatchItems)
      .where(and(
        eq(workRecordDispatchBatchItems.companyId, companyId),
        eq(workRecordDispatchBatchItems.batchId, batchId),
      ));
    const aggregateRecordIds = batchItems.map((item) => item.recordId);
    const intents = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, companyId),
      inArray(workRecordExecutionIntents.state, ["pending", "waiting_dependencies", "waiting_governance", "ready"]),
      or(
        inArray(workRecordExecutionIntents.batchItemId, db.select({ id: workRecordDispatchBatchItems.id }).from(workRecordDispatchBatchItems).where(eq(workRecordDispatchBatchItems.batchId, batchId))),
        inArray(workRecordExecutionIntents.qualityItemId, db.select({ id: workRecordQualityItems.id }).from(workRecordQualityItems).innerJoin(workRecordQualityCycles, eq(workRecordQualityItems.cycleId, workRecordQualityCycles.id)).where(inArray(
          workRecordQualityCycles.aggregateRecordId,
          aggregateRecordIds.length > 0 ? aggregateRecordIds : ["00000000-0000-0000-0000-000000000000"],
        ))),
      ),
    ));
    for (const intent of intents) {
      if (!intent.issueId) continue;
      const issue = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, intent.issueId)))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.statusVersion !== intent.expectedIssueStatusVersion) {
        await db.update(workRecordExecutionIntents).set({ state: "superseded", supersededAt: new Date(), waitingReason: "stale_issue_revision", updatedAt: new Date() })
          .where(eq(workRecordExecutionIntents.id, intent.id));
        await db.update(workRecordOutbox).set({ state: "superseded", updatedAt: new Date() })
          .where(eq(workRecordOutbox.executionIntentId, intent.id));
        continue;
      }
      const readiness = await issueSvc.getDependencyReadiness(issue.id);
      if (!readiness.isDependencyReady) {
        await db.update(workRecordExecutionIntents).set({ state: "waiting_dependencies", waitingReason: "dependencies_pending", updatedAt: new Date() })
          .where(eq(workRecordExecutionIntents.id, intent.id));
        continue;
      }
      const governanceReason = await governanceWaitReason(companyId, projectId, issue, intent.kind);
      if (governanceReason) {
        await db.update(workRecordExecutionIntents).set({ state: "waiting_governance", waitingReason: governanceReason, updatedAt: new Date() })
          .where(eq(workRecordExecutionIntents.id, intent.id));
        continue;
      }
      const eventKey = `work-record-v2:${intent.id}:${intent.generation}`;
      // During a rolling M1 -> v2 transition both workflows can observe the
      // same undispatched release. Persist the legacy wake key in the v2 event
      // so either outbox processor wins the same heartbeat admission instead
      // of serially creating two real runs.
      const legacyRelease = await db.select({ eventKey: workRecordOutbox.eventKey })
        .from(workRecordOutbox)
        .where(and(
          eq(workRecordOutbox.companyId, companyId),
          eq(workRecordOutbox.projectId, projectId),
          eq(workRecordOutbox.recordId, intent.recordId),
          eq(workRecordOutbox.issueId, issue.id),
          eq(workRecordOutbox.workflowVersion, 1),
          inArray(workRecordOutbox.state, ["pending", "retry", "processing"]),
        ))
        .orderBy(asc(workRecordOutbox.createdAt))
        .then((rows) => rows[0] ?? null);
      const payload = {
        issueId: issue.id,
        recordId: intent.recordId,
        batchId,
        executionIntentId: intent.id,
        generation: intent.generation,
        ...(legacyRelease
          ? { compatibilityWakeKey: `work-record-release:${legacyRelease.eventKey}` }
          : {}),
      };
      await db.transaction(async (tx) => {
        await tx.update(workRecordExecutionIntents).set({ state: "ready", waitingReason: null, activatedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(workRecordExecutionIntents.id, intent.id), inArray(workRecordExecutionIntents.state, ["pending", "waiting_dependencies", "waiting_governance", "ready"])));
        await tx.insert(workRecordOutbox).values({
          companyId,
          projectId,
          recordId: intent.recordId,
          issueId: issue.id,
          workflowVersion: 2,
          batchId,
          executionIntentId: intent.id,
          eventKey,
          eventType: intent.kind,
          dispatchRound: 0,
          dependencySetRevision: batch.dependencySetRevision,
          blockedCycle: 0,
          payload,
          payloadDigest: digest(payload),
          state: "pending",
        }).onConflictDoNothing();
      });
    }
  }

  async function refreshPackageHolds(companyId: string, projectId: string, batchId: string) {
    const batch = await db.select().from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, companyId),
      eq(workRecordDispatchBatches.projectId, projectId),
      eq(workRecordDispatchBatches.id, batchId),
      eq(workRecordDispatchBatches.state, "prepared"),
    )).then((rows) => rows[0] ?? null);
    if (!batch?.rootRecordId) return;
    const cancelledPackageChild = await db.select({ id: issues.id }).from(workRecordDispatchBatchItems)
      .innerJoin(workRecordIssueLinks, and(
        eq(workRecordIssueLinks.companyId, workRecordDispatchBatchItems.companyId),
        eq(workRecordIssueLinks.id, workRecordDispatchBatchItems.primaryIssueLinkId),
      ))
      .innerJoin(issues, and(
        eq(issues.companyId, workRecordIssueLinks.companyId),
        eq(issues.id, workRecordIssueLinks.issueId),
      ))
      .where(and(
        eq(workRecordDispatchBatchItems.companyId, companyId),
        eq(workRecordDispatchBatchItems.batchId, batchId),
        ne(workRecordDispatchBatchItems.recordId, batch.rootRecordId),
        eq(issues.status, "cancelled"),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (cancelledPackageChild) {
      await db.update(workRecordQualityCycles).set({
        qualityPhase: "impact_review",
        reason: "prerequisite_cancelled_impact_pending",
        revision: sql`${workRecordQualityCycles.revision} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(workRecordQualityCycles.companyId, companyId),
        eq(workRecordQualityCycles.projectId, projectId),
        eq(workRecordQualityCycles.aggregateRecordId, batch.rootRecordId),
        eq(workRecordQualityCycles.state, "open"),
        ne(workRecordQualityCycles.qualityPhase, "impact_review"),
      ));
    }
    const holds = await db.select().from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.companyId, companyId),
      eq(workRecordExecutionHolds.projectId, projectId),
      eq(workRecordExecutionHolds.dependentRecordId, batch.rootRecordId),
      eq(workRecordExecutionHolds.dependencySetRevision, batch.dependencySetRevision),
      isNull(workRecordExecutionHolds.resolvedAt),
    ));
    if (holds.length === 0) return;
    const childLinks = await db.select({
      recordId: workRecordIssueLinks.recordId,
      status: issues.status,
      workspaceId: issues.executionWorkspaceId,
    }).from(workRecordIssueLinks).innerJoin(issues, and(
      eq(issues.companyId, workRecordIssueLinks.companyId),
      eq(issues.id, workRecordIssueLinks.issueId),
    )).where(and(
      eq(workRecordIssueLinks.companyId, companyId),
      inArray(workRecordIssueLinks.recordId, holds.map((hold) => hold.blockingRecordId)),
      eq(workRecordIssueLinks.purpose, "primary"),
    ));
    const byRecord = new Map(childLinks.map((row) => [row.recordId, row]));
    const workspaceIds = childLinks.map((row) => row.workspaceId).filter((id): id is string => Boolean(id));
    const unfinalized = await listUnfinalizedExecutionWorkspaceIds(db, companyId, workspaceIds);
    let cancelled = Boolean(cancelledPackageChild);
    for (const hold of holds) {
      const child = byRecord.get(hold.blockingRecordId);
      if (child?.status === "cancelled") {
        cancelled = true;
        await db.update(workRecordExecutionHolds).set({
          reason: "prerequisite_cancelled_impact_pending",
          resolvedAt: null,
          updatedAt: new Date(),
        }).where(eq(workRecordExecutionHolds.id, hold.id));
      } else if (child?.status === "done" && (!child.workspaceId || !unfinalized.has(child.workspaceId))) {
        await db.update(workRecordExecutionHolds).set({ resolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(workRecordExecutionHolds.id, hold.id));
      } else {
        await db.update(workRecordExecutionHolds).set({
          reason: child?.status === "done" ? "delivery_sync_pending" : "prerequisite_not_completed",
          resolvedAt: null,
          updatedAt: new Date(),
        }).where(eq(workRecordExecutionHolds.id, hold.id));
      }
    }
    if (cancelled) {
      await db.update(workRecordQualityCycles).set({
        qualityPhase: "impact_review",
        reason: "prerequisite_cancelled_impact_pending",
        revision: sql`${workRecordQualityCycles.revision} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(workRecordQualityCycles.companyId, companyId),
        eq(workRecordQualityCycles.projectId, projectId),
        eq(workRecordQualityCycles.aggregateRecordId, batch.rootRecordId),
        eq(workRecordQualityCycles.state, "open"),
        ne(workRecordQualityCycles.qualityPhase, "impact_review"),
      ));
    }
  }

  async function reconcile(companyId: string, projectId: string, batchId: string, actor: Actor) {
    assertWritesEnabled(companyId, projectId);
    const view = await batchView(companyId, projectId, batchId);
    if (["failed", "superseded"].includes(view.batch.state)) return { ...view, recovered: false };
    const records = await db.select({ id: workRecords.id, parentRecordId: workRecords.parentRecordId }).from(workRecords).where(and(
      eq(workRecords.companyId, companyId),
      inArray(workRecords.id, view.items.map((item) => item.recordId)),
    ));
    const depth = (recordId: string) => {
      let value = 0;
      let current = records.find((record) => record.id === recordId);
      const seen = new Set<string>();
      while (current?.parentRecordId && !seen.has(current.id)) {
        seen.add(current.id);
        value += 1;
        current = records.find((record) => record.id === current!.parentRecordId);
      }
      return value;
    };
    const ordered = [...view.items].sort((left, right) => depth(left.recordId) - depth(right.recordId) || left.id.localeCompare(right.id));
    let completed = 0;
    for (const item of ordered) {
      await materializeItem(companyId, projectId, batchId, item, actor);
      completed += 1;
      if (completed === 1 && ordered.length > 1) await options.failpoint?.("after_partial_materialization");
    }
    await finalizeBatch(companyId, projectId, batchId);
    await refreshPackageHolds(companyId, projectId, batchId);
    await refreshIntents(companyId, projectId, batchId);
    return { ...(await batchView(companyId, projectId, batchId)), recovered: true };
  }

  async function reconcilePage(limit = 25, afterId: string | null = null) {
    if (!writesEnabled) return { processed: 0, succeeded: 0, failures: [], nextAfterId: null };
    const batches = await db.select({ companyId: workRecordDispatchBatches.companyId, projectId: workRecordDispatchBatches.projectId, id: workRecordDispatchBatches.id })
      .from(workRecordDispatchBatches)
      .where(and(
        inArray(workRecordDispatchBatches.state, ["preparing", "prepared", "blocked"]),
        rolloutPredicate(workRecordDispatchBatches.companyId, workRecordDispatchBatches.projectId),
        afterId ? gt(workRecordDispatchBatches.id, afterId) : undefined,
      ))
      .orderBy(asc(workRecordDispatchBatches.id))
      .limit(limit + 1);
    const hasMore = batches.length > limit;
    const candidates = hasMore ? batches.slice(0, limit) : batches;
    const settled = await reconcileCandidatesIndependently(candidates, (batch) =>
      reconcile(batch.companyId, batch.projectId, batch.id, { actorType: "system", actorId: "work-package-reconciler" }));
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

  async function processOutbox(wakeup: Wakeup, limit = 25) {
    if (!writesEnabled) return 0;
    const events = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.workflowVersion, 2),
      inArray(workRecordOutbox.state, ["pending", "retry", "processing"]),
      rolloutPredicate(workRecordOutbox.companyId, workRecordOutbox.projectId),
      sql`${workRecordOutbox.availableAt} <= now()`,
    )).orderBy(asc(workRecordOutbox.createdAt)).limit(limit);
    let processed = 0;
    for (const event of events) {
      const claimed = await db.update(workRecordOutbox).set({ state: "processing", availableAt: new Date(Date.now() + 30_000), updatedAt: new Date() }).where(and(
        eq(workRecordOutbox.id, event.id),
        eq(workRecordOutbox.workflowVersion, 2),
        inArray(workRecordOutbox.state, ["pending", "retry", "processing"]),
        sql`${workRecordOutbox.availableAt} <= now()`,
      )).returning().then((rows) => rows[0] ?? null);
      if (!claimed || !claimed.executionIntentId) continue;
      try {
        try {
          classifyWorkRecordWorkflowEvent(claimed.workflowVersion, claimed.eventType);
        } catch (error) {
          await db.update(workRecordOutbox).set({
            state: "superseded",
            lastError: error instanceof Error ? error.message : "work_record_workflow_unknown_event",
            updatedAt: new Date(),
          }).where(eq(workRecordOutbox.id, claimed.id));
          continue;
        }
        const intent = await db.select().from(workRecordExecutionIntents).where(and(
          eq(workRecordExecutionIntents.companyId, claimed.companyId),
          eq(workRecordExecutionIntents.id, claimed.executionIntentId),
        )).then((rows) => rows[0] ?? null);
        const batch = claimed.batchId ? await db.select().from(workRecordDispatchBatches).where(and(
          eq(workRecordDispatchBatches.companyId, claimed.companyId),
          eq(workRecordDispatchBatches.id, claimed.batchId),
        )).then((rows) => rows[0] ?? null) : null;
        const issue = intent?.issueId ? await db.select().from(issues).where(and(
          eq(issues.companyId, claimed.companyId), eq(issues.id, intent.issueId),
        )).then((rows) => rows[0] ?? null) : null;
        const compatibilityWakeKey = typeof claimed.payload?.compatibilityWakeKey === "string"
          ? claimed.payload.compatibilityWakeKey
          : null;
        const idempotencyKey = compatibilityWakeKey ?? (intent
          ? `work-record-intent:${intent.id}:${intent.generation}`
          : null);
        const winner = async () => idempotencyKey
          ? db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
              eq(agentWakeupRequests.companyId, claimed.companyId),
              eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
              inArray(agentWakeupRequests.status, ["queued", "claimed", "running", "completed"]),
            )).then((rows) => rows[0] ?? null)
          : null;
        const existingWinner = await winner();
        const approvalWaitRevision = Boolean(intent && issue && !existingWinner &&
          issue.statusVersion !== intent.expectedIssueStatusVersion &&
          issue.status === "in_review" && issue.executionState?.status === "pending");
        const approvalReleaseRevision = Boolean(intent && issue && !existingWinner &&
          issue.statusVersion !== intent.expectedIssueStatusVersion &&
          intent.state === "waiting_governance" && intent.waitingReason === "approval_pending" &&
          isIntentIssueStatusAdmissible(issue, intent.kind));
        const staleIssueRevision = Boolean(intent && issue && !existingWinner &&
          issue.statusVersion !== intent.expectedIssueStatusVersion &&
          !approvalWaitRevision && !approvalReleaseRevision);
        if (intent && issue && (approvalWaitRevision || approvalReleaseRevision)) {
          await db.update(workRecordExecutionIntents).set({
            expectedIssueStatusVersion: issue.statusVersion,
            updatedAt: new Date(),
          }).where(eq(workRecordExecutionIntents.id, intent.id));
        }
        if (!intent || !batch || batch.state !== "prepared" ||
            !["ready", "waiting_dependencies", "waiting_governance"].includes(intent.state) || !issue ||
            staleIssueRevision) {
          await db.update(workRecordOutbox).set({
            state: "superseded",
            lastError: staleIssueRevision ? "stale_issue_revision" : null,
            updatedAt: new Date(),
          })
            .where(eq(workRecordOutbox.id, claimed.id));
          if (intent && !["superseded", "cancelled", "succeeded"].includes(intent.state)) {
            await db.update(workRecordExecutionIntents).set({
              state: "superseded",
              waitingReason: staleIssueRevision ? "stale_issue_revision" : intent.waitingReason,
              supersededAt: new Date(),
              updatedAt: new Date(),
            })
              .where(eq(workRecordExecutionIntents.id, intent.id));
          }
          continue;
        }
        if (!existingWinner) {
          const readiness = await issueSvc.getDependencyReadiness(issue.id);
          const governanceReason = readiness.isDependencyReady
            ? await governanceWaitReason(claimed.companyId, claimed.projectId, issue, intent.kind)
            : "issue_dependencies_blocked";
          if (governanceReason) {
            await db.transaction(async (tx) => {
              await tx.update(workRecordExecutionIntents).set({
                state: readiness.isDependencyReady ? "waiting_governance" : "waiting_dependencies",
                waitingReason: governanceReason,
                updatedAt: new Date(),
              }).where(eq(workRecordExecutionIntents.id, intent.id));
              await tx.update(workRecordOutbox).set({
                state: "retry",
                lastError: governanceReason,
                availableAt: new Date(Date.now() + WORK_RECORD_GOVERNANCE_RECHECK_MS),
                deadLetteredAt: null,
                updatedAt: new Date(),
              }).where(eq(workRecordOutbox.id, claimed.id));
            });
            continue;
          }
          if (!issue.assigneeAgentId) throw new Error("Materialized issue has no assignee");
          await wakeup(issue.assigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "work_record_workflow_v2_released",
            payload: claimed.payload ?? {},
            idempotencyKey: idempotencyKey!,
            allowRunCoalescing: false,
            requestedByActorType: "system",
            requestedByActorId: "work-record-v2-outbox",
            contextSnapshot: { issueId: issue.id, source: "work_record_workflow_v2", executionIntentId: intent.id },
          });
          await options.failpoint?.("after_outbox_commit");
          if (!await winner()) throw new Error("Heartbeat admission deferred the workflow-v2 release");
        }
        // The wake receipt/run are authoritative execution facts.  Keep a
        // separate failpoint after those facts exist but before the workflow
        // projection catches up so recovery can prove that a targeted outbox
        // retry only repairs projections and never creates another execution.
        await options.failpoint?.("before_projection_update");
        await db.transaction(async (tx) => {
          await tx.update(workRecordOutbox).set({ state: "delivered", deliveredAt: new Date(), lastError: null, attemptCount: claimed.attemptCount + 1, updatedAt: new Date() })
            .where(eq(workRecordOutbox.id, claimed.id));
          await tx.update(workRecordExecutionIntents).set({ state: "queued", waitingReason: null, updatedAt: new Date() })
            .where(eq(workRecordExecutionIntents.id, intent.id));
          await tx.update(workRecords).set({ dispatchState: "queued", updatedAt: new Date() })
            .where(eq(workRecords.id, intent.recordId));
        });
        processed += 1;
      } catch (error) {
        const failedIntent = claimed.executionIntentId
          ? await db.select().from(workRecordExecutionIntents).where(and(
              eq(workRecordExecutionIntents.companyId, claimed.companyId),
              eq(workRecordExecutionIntents.id, claimed.executionIntentId),
            )).then((rows) => rows[0] ?? null)
          : null;
        const failedCompatibilityWakeKey = typeof claimed.payload?.compatibilityWakeKey === "string"
          ? claimed.payload.compatibilityWakeKey
          : null;
        const admissionKey = failedCompatibilityWakeKey ?? (failedIntent
          ? `work-record-intent:${failedIntent.id}:${failedIntent.generation}`
          : null);
        const admissionReceipts = admissionKey
          ? await db.select().from(agentWakeupRequests).where(and(
              eq(agentWakeupRequests.companyId, claimed.companyId),
              eq(agentWakeupRequests.idempotencyKey, admissionKey),
            )).orderBy(asc(agentWakeupRequests.requestedAt))
          : [];
        const activeReceipt = admissionReceipts.find((receipt) =>
          ["queued", "claimed", "running", "completed"].includes(receipt.status));
        const admissionReceipt = admissionReceipts.at(-1) ?? null;
        const admissionReason = !activeReceipt && admissionReceipt
          ? admissionReceipt.reason ?? admissionReceipt.error ?? null
          : null;
        const governanceAdmission = Boolean(
          admissionReason && admissionReceipt &&
          ["skipped", "deferred_issue_execution"].includes(admissionReceipt.status),
        );
        if (failedIntent?.issueId && governanceAdmission) {
          const readiness = await issueSvc.getDependencyReadiness(failedIntent.issueId);
          await db.update(workRecordExecutionIntents).set({
            state: readiness.isDependencyReady ? "waiting_governance" : "waiting_dependencies",
            waitingReason: admissionReason,
            updatedAt: new Date(),
          }).where(eq(workRecordExecutionIntents.id, failedIntent.id));
        }
        if (governanceAdmission) {
          await db.update(workRecordOutbox).set({
            state: "retry",
            lastError: admissionReason,
            availableAt: new Date(Date.now() + WORK_RECORD_GOVERNANCE_RECHECK_MS),
            deadLetteredAt: null,
            updatedAt: new Date(),
          }).where(eq(workRecordOutbox.id, claimed.id));
          continue;
        }
        const nextAttemptCount = claimed.attemptCount + 1;
        const deadLetter = nextAttemptCount >= WORK_RECORD_OUTBOX_MAX_ATTEMPTS;
        await db.update(workRecordOutbox).set({
          state: deadLetter ? "dead_letter" : "retry",
          lastError: admissionReason ?? (error instanceof Error ? error.message : String(error)),
          attemptCount: nextAttemptCount,
          availableAt: deadLetter ? new Date() : new Date(Date.now() + 2_000),
          deadLetteredAt: deadLetter ? new Date() : null,
          updatedAt: new Date(),
        }).where(eq(workRecordOutbox.id, claimed.id));
      }
    }
    return processed;
  }

  async function recoverOutboxEvent(
    companyId: string,
    projectId: string,
    eventId: string,
    input: RecoverWorkRecordOutbox,
  ) {
    assertWritesEnabled(companyId, projectId);
    const now = new Date();
    const recovered = await db.transaction(async (tx) => {
      const row = await tx.update(workRecordOutbox).set({
        state: "pending",
        attemptCount: 0,
        recoveryCount: sql`${workRecordOutbox.recoveryCount} + 1`,
        availableAt: now,
        deadLetteredAt: null,
        lastRecoveredAt: now,
        lastError: null,
        updatedAt: now,
      }).where(and(
        eq(workRecordOutbox.companyId, companyId),
        eq(workRecordOutbox.projectId, projectId),
        eq(workRecordOutbox.id, eventId),
        eq(workRecordOutbox.workflowVersion, 2),
        eq(workRecordOutbox.state, "dead_letter"),
        eq(workRecordOutbox.attemptCount, input.expectedAttemptCount),
      )).returning().then((rows) => rows[0] ?? null);
      if (!row) return null;
      await tx.update(workRecords).set({ dispatchState: "linked", updatedAt: now }).where(and(
        eq(workRecords.companyId, companyId),
        eq(workRecords.projectId, projectId),
        eq(workRecords.id, row.recordId),
      ));
      return row;
    });
    if (recovered) return recovered;
    const existing = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, companyId),
      eq(workRecordOutbox.projectId, projectId),
      eq(workRecordOutbox.id, eventId),
      eq(workRecordOutbox.workflowVersion, 2),
    )).then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Workflow outbox event not found");
    if (existing.state !== "dead_letter") {
      throw conflict("Workflow outbox event is not dead-lettered", details("work_record_outbox_not_dead_letter", {
        state: existing.state,
      }));
    }
    throw conflict("Workflow outbox attempt count changed", details("work_record_outbox_attempt_conflict", {
      expectedAttemptCount: input.expectedAttemptCount,
      actualAttemptCount: existing.attemptCount,
    }));
  }

  async function operationsMetrics(companyId: string, projectId: string) {
    const project = await db.select({ id: projects.id }).from(projects).where(and(
      eq(projects.companyId, companyId),
      eq(projects.id, projectId),
    )).then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");

    const [outbox] = await db.execute<{
      pending_count: number; retry_count: number; processing_count: number; dead_letter_count: number;
      oldest_actionable_age_seconds: number | null; attempt_p95: number | null;
      lease_reclaim_count: number; superseded_count: number;
    }>(sql`
      select
        count(*) filter (where state = 'pending')::int as pending_count,
        count(*) filter (where state = 'retry')::int as retry_count,
        count(*) filter (where state = 'processing')::int as processing_count,
        count(*) filter (where state = 'dead_letter')::int as dead_letter_count,
        extract(epoch from (now() - min(created_at) filter (where state in ('pending', 'retry', 'processing'))))::float8 as oldest_actionable_age_seconds,
        percentile_cont(0.95) within group (order by attempt_count)
          filter (where state in ('pending', 'retry', 'processing') and updated_at >= now() - interval '24 hours')::float8 as attempt_p95,
        count(*) filter (where recovery_count > 0)::int as lease_reclaim_count,
        count(*) filter (where state = 'superseded')::int as superseded_count
      from work_record_outbox
      where company_id = ${companyId} and project_id = ${projectId} and workflow_version = 2
    `);

    const [execution] = await db.execute<{
      intent_count: number; active_intent_count: number; wake_count: number; run_count: number;
      effective_wake_count: number; effective_run_count: number;
      cost_event_count: number; cost_cents: number; duplicate_wake_intent_count: number;
      duplicate_run_intent_count: number; duplicate_active_intent_issue_count: number;
      duplicate_active_run_issue_count: number;
    }>(sql`
      with scoped_intents as (
        select * from work_record_execution_intents
        where company_id = ${companyId} and project_id = ${projectId}
      ), intent_facts as (
        select i.id, i.state, i.issue_id,
          count(distinct w.id)::int as wake_count,
          count(distinct r.id)::int as run_count,
          count(distinct w.id) filter (where w.status in ('queued', 'claimed', 'completed'))::int as effective_wake_count,
          count(distinct r.id) filter (where r.status in ('queued', 'running', 'succeeded'))::int as effective_run_count,
          count(distinct c.id)::int as cost_event_count,
          coalesce(sum(c.cost_cents), 0)::int as cost_cents
        from scoped_intents i
        left join agent_wakeup_requests w
          on w.company_id = i.company_id
         and w.idempotency_key = ('work-record-intent:' || i.id::text || ':' || i.generation::text)
        left join heartbeat_runs r on r.company_id = i.company_id and r.wakeup_request_id = w.id
        left join cost_events c on c.company_id = i.company_id and c.heartbeat_run_id = r.id
        group by i.id, i.state, i.issue_id
      ), active_intent_issues as (
        select issue_id from scoped_intents
        where issue_id is not null
          and state in ('pending', 'waiting_dependencies', 'waiting_governance', 'ready', 'queued', 'running')
        group by issue_id having count(*) > 1
      ), active_run_issues as (
        select f.issue_id from intent_facts f
        join scoped_intents i on i.id = f.id
        join agent_wakeup_requests w
          on w.company_id = i.company_id
         and w.idempotency_key = ('work-record-intent:' || i.id::text || ':' || i.generation::text)
        join heartbeat_runs r on r.company_id = i.company_id and r.wakeup_request_id = w.id
        where f.issue_id is not null and r.status in ('queued', 'running')
        group by f.issue_id having count(distinct r.id) > 1
      )
      select count(*)::int as intent_count,
        count(*) filter (where f.state in ('pending', 'waiting_dependencies', 'waiting_governance', 'ready', 'queued', 'running'))::int as active_intent_count,
        coalesce(sum(f.wake_count), 0)::int as wake_count,
        coalesce(sum(f.run_count), 0)::int as run_count,
        coalesce(sum(f.effective_wake_count), 0)::int as effective_wake_count,
        coalesce(sum(f.effective_run_count), 0)::int as effective_run_count,
        coalesce(sum(f.cost_event_count), 0)::int as cost_event_count,
        coalesce(sum(f.cost_cents), 0)::int as cost_cents,
        count(*) filter (where f.effective_wake_count > 1)::int as duplicate_wake_intent_count,
        count(*) filter (where f.effective_run_count > 1)::int as duplicate_run_intent_count,
        (select count(*)::int from active_intent_issues) as duplicate_active_intent_issue_count,
        (select count(*)::int from active_run_issues) as duplicate_active_run_issue_count
      from intent_facts f
    `);

    const [consistency] = await db.execute<{
      stale_event_count: number; projection_lag_count: number; projection_lag_max_seconds: number | null;
      reconcile_repair_count: number; orphan_link_count: number; orphan_intent_count: number;
      scope_digest_mismatch_count: number;
    }>(sql`
      select
        (select count(*)::int from work_record_outbox
          where company_id = ${companyId} and project_id = ${projectId} and workflow_version = 2
            and state = 'superseded' and last_error = 'stale_issue_revision') as stale_event_count,
        (select count(*)::int from work_record_execution_projections p
          join issues i on i.company_id = p.company_id and i.id = p.issue_id
          where p.company_id = ${companyId} and p.project_id = ${projectId}
            and (p.sync_state <> 'current' or p.issue_status_version < i.status_version)) as projection_lag_count,
        (select extract(epoch from max(now() - p.projected_at))::float8 from work_record_execution_projections p
          join issues i on i.company_id = p.company_id and i.id = p.issue_id
          where p.company_id = ${companyId} and p.project_id = ${projectId}
            and (p.sync_state <> 'current' or p.issue_status_version < i.status_version)) as projection_lag_max_seconds,
        (select count(*)::int from activity_log a
          where a.company_id = ${companyId}
            and a.action in ('work_record.reconciled', 'work_package.dispatch_reconciled')
            and a.created_at >= now() - interval '24 hours'
            and a.details ->> 'projectId' = ${projectId}) as reconcile_repair_count,
        (select count(*)::int from work_records r
          where r.company_id = ${companyId} and r.project_id = ${projectId}
            and r.dispatch_state <> 'not_dispatched'
            and not exists (select 1 from work_record_issue_links l
              where l.company_id = r.company_id and l.project_id = r.project_id
                and l.record_id = r.id and l.purpose = 'primary')) as orphan_link_count,
        (select count(*)::int from work_record_execution_intents i
          where i.company_id = ${companyId} and i.project_id = ${projectId}
            and i.state in ('pending', 'waiting_dependencies', 'waiting_governance', 'ready', 'queued', 'running')
            and i.issue_id is null) as orphan_intent_count,
        (select count(*)::int from activity_log a
          where a.company_id = ${companyId} and a.created_at >= now() - interval '24 hours'
            and a.details ->> 'projectId' = ${projectId}
            and a.details -> 'error' ->> 'classification' = 'scope_digest_mismatch') as scope_digest_mismatch_count
    `);

    const [quality] = await db.execute<{
      po_wait_count: number; po_wait_oldest_seconds: number | null; qa_wait_count: number;
      qa_wait_oldest_seconds: number | null; max_rework_round: number; impact_wait_count: number;
      impact_wait_oldest_seconds: number | null; unverified_defect_count: number;
    }>(sql`
      select
        count(*) filter (where c.state = 'open' and c.quality_phase = 'po_acceptance')::int as po_wait_count,
        extract(epoch from (now() - min(c.updated_at) filter (where c.state = 'open' and c.quality_phase = 'po_acceptance')))::float8 as po_wait_oldest_seconds,
        count(*) filter (where c.state = 'open' and c.quality_phase in ('qa_initial', 'qa_retest'))::int as qa_wait_count,
        extract(epoch from (now() - min(c.updated_at) filter (where c.state = 'open' and c.quality_phase in ('qa_initial', 'qa_retest'))))::float8 as qa_wait_oldest_seconds,
        coalesce(max(c.cycle_number), 0)::int as max_rework_round,
        count(*) filter (where c.state = 'open' and c.quality_phase = 'impact_review')::int as impact_wait_count,
        extract(epoch from (now() - min(c.updated_at) filter (where c.state = 'open' and c.quality_phase = 'impact_review')))::float8 as impact_wait_oldest_seconds,
        (select count(distinct l.defect_record_id)::int from work_record_quality_links l
          where l.company_id = ${companyId} and l.project_id = ${projectId}
            and not exists (select 1 from work_record_quality_verdicts v
              where v.company_id = l.company_id and v.project_id = l.project_id
                and v.defect_record_id = l.defect_record_id and v.outcome = 'pass')) as unverified_defect_count
      from work_record_quality_cycles c
      where c.company_id = ${companyId} and c.project_id = ${projectId}
    `);

    const [governance] = await db.execute<{
      total_wait_count: number; oldest_wait_seconds: number | null; budget_wait_count: number;
      pause_wait_count: number; approval_wait_count: number; other_wait_count: number;
    }>(sql`
      select count(*)::int as total_wait_count,
        extract(epoch from (now() - min(updated_at)))::float8 as oldest_wait_seconds,
        count(*) filter (where waiting_reason in ('budget.blocked', 'budget_hard_stop'))::int as budget_wait_count,
        count(*) filter (where waiting_reason in ('company.inactive', 'agent.not_invokable', 'company_paused', 'agent_paused'))::int as pause_wait_count,
        count(*) filter (where waiting_reason in ('approval_pending', 'approval_revision_requested', 'governance_pending'))::int as approval_wait_count,
        count(*) filter (where coalesce(waiting_reason, '') not in (
          'budget.blocked', 'budget_hard_stop',
          'company.inactive', 'agent.not_invokable', 'company_paused', 'agent_paused',
          'approval_pending', 'approval_revision_requested', 'governance_pending'
        ))::int as other_wait_count
      from work_record_execution_intents
      where company_id = ${companyId} and project_id = ${projectId} and state = 'waiting_governance'
    `);

    const [rejections] = await db.execute<{
      forbidden_count: number; conflict_count: number; unprocessable_count: number; other_count: number;
      role_denied_count: number; cross_scope_count: number;
    }>(sql`
      select
        count(*) filter (where a.details -> 'error' ->> 'status' = '403')::int as forbidden_count,
        count(*) filter (where a.details -> 'error' ->> 'status' = '409')::int as conflict_count,
        count(*) filter (where a.details -> 'error' ->> 'status' = '422')::int as unprocessable_count,
        count(*) filter (where a.details -> 'error' ->> 'status' not in ('403', '409', '422'))::int as other_count,
        count(*) filter (where a.details -> 'error' ->> 'code' = 'work_record_workflow_role_denied')::int as role_denied_count,
        count(*) filter (where a.details -> 'error' ->> 'code' = 'work_record_workflow_project_boundary')::int as cross_scope_count
      from activity_log a
      where a.company_id = ${companyId}
        and a.action in ('work_record.quality_command', 'work_record.dispatch_command')
        and a.created_at >= now() - interval '24 hours'
        and a.details ->> 'projectId' = ${projectId}
        and a.details ->> 'outcome' in ('conflict', 'rejected')
    `);

    const actionableOutboxEvents = Number(outbox?.pending_count ?? 0) + Number(outbox?.retry_count ?? 0) +
      Number(outbox?.processing_count ?? 0) + Number(outbox?.dead_letter_count ?? 0);
    const activeIntents = Number(execution?.active_intent_count ?? 0);
    const rolloutDecision = rollout.decision(companyId, projectId);
    return {
      workflowVersion: 2,
      featureFlagEnabled: writesEnabled,
      rollout: {
        globalEnabled: rolloutDecision.globalEnabled,
        scopeEnabled: rolloutDecision.scopeEnabled,
        configured: rolloutDecision.configured,
        source: rolloutDecision.source,
        reason: rolloutDecision.reason,
        scope: { companyId, projectId },
      },
      outbox: {
        pending: Number(outbox?.pending_count ?? 0), retry: Number(outbox?.retry_count ?? 0),
        processing: Number(outbox?.processing_count ?? 0), deadLetter: Number(outbox?.dead_letter_count ?? 0),
        oldestActionableAgeSeconds: outbox?.oldest_actionable_age_seconds == null ? null : Number(outbox.oldest_actionable_age_seconds),
        attemptP95: outbox?.attempt_p95 == null ? null : Number(outbox.attempt_p95),
        attemptWindow: { hours: WORK_RECORD_OPERATIONS_WINDOW_HOURS, states: ["pending", "retry", "processing"], timestampField: "updatedAt" },
        recoveredEventCount: Number(outbox?.lease_reclaim_count ?? 0), maxAttempts: WORK_RECORD_OUTBOX_MAX_ATTEMPTS,
      },
      execution: {
        intents: Number(execution?.intent_count ?? 0), activeIntents,
        wakes: Number(execution?.wake_count ?? 0), runs: Number(execution?.run_count ?? 0),
        effectiveWakes: Number(execution?.effective_wake_count ?? 0),
        effectiveRuns: Number(execution?.effective_run_count ?? 0),
        costEvents: Number(execution?.cost_event_count ?? 0), costCents: Number(execution?.cost_cents ?? 0),
      },
      consistency: {
        supersededEvents: Number(outbox?.superseded_count ?? 0), staleEvents: Number(consistency?.stale_event_count ?? 0),
        projectionLag: { count: Number(consistency?.projection_lag_count ?? 0), maxSeconds: consistency?.projection_lag_max_seconds == null ? null : Number(consistency.projection_lag_max_seconds) },
        reconcileRepairsLast24Hours: Number(consistency?.reconcile_repair_count ?? 0),
        orphanLinks: Number(consistency?.orphan_link_count ?? 0), orphanIntents: Number(consistency?.orphan_intent_count ?? 0),
        scopeDigestMismatchesLast24Hours: Number(consistency?.scope_digest_mismatch_count ?? 0),
      },
      runtimeSafety: {
        duplicateWakeIntents: Number(execution?.duplicate_wake_intent_count ?? 0),
        duplicateRunIntents: Number(execution?.duplicate_run_intent_count ?? 0),
        effectiveWakeStatuses: ["queued", "claimed", "completed"],
        effectiveRunStatuses: ["queued", "running", "succeeded"],
        issuesWithMultipleActiveIntents: Number(execution?.duplicate_active_intent_issue_count ?? 0),
        issuesWithMultipleActiveRuns: Number(execution?.duplicate_active_run_issue_count ?? 0),
      },
      quality: {
        poWait: { count: Number(quality?.po_wait_count ?? 0), oldestSeconds: quality?.po_wait_oldest_seconds == null ? null : Number(quality.po_wait_oldest_seconds) },
        qaWait: { count: Number(quality?.qa_wait_count ?? 0), oldestSeconds: quality?.qa_wait_oldest_seconds == null ? null : Number(quality.qa_wait_oldest_seconds) },
        maxReworkRound: Number(quality?.max_rework_round ?? 0),
        cancellationImpactWait: { count: Number(quality?.impact_wait_count ?? 0), oldestSeconds: quality?.impact_wait_oldest_seconds == null ? null : Number(quality.impact_wait_oldest_seconds) },
        unverifiedDefects: Number(quality?.unverified_defect_count ?? 0),
      },
      governance: {
        totalWait: Number(governance?.total_wait_count ?? 0),
        oldestWaitSeconds: governance?.oldest_wait_seconds == null ? null : Number(governance.oldest_wait_seconds),
        budgetWait: Number(governance?.budget_wait_count ?? 0), pauseWait: Number(governance?.pause_wait_count ?? 0),
        approvalWait: Number(governance?.approval_wait_count ?? 0), otherWait: Number(governance?.other_wait_count ?? 0),
      },
      rejections: {
        windowHours: WORK_RECORD_OPERATIONS_WINDOW_HOURS,
        byStatus: { forbidden403: Number(rejections?.forbidden_count ?? 0), conflict409: Number(rejections?.conflict_count ?? 0), unprocessable422: Number(rejections?.unprocessable_count ?? 0), other: Number(rejections?.other_count ?? 0) },
        roleDenied: Number(rejections?.role_denied_count ?? 0), crossScope: Number(rejections?.cross_scope_count ?? 0),
      },
      scanBudget: {
        intervalMs: 2_000, recordCandidatesPerTick: WORK_RECORD_LIST_DEFAULT_LIMIT,
        packageCandidatesPerTick: 25, qualityCandidatesPerTick: 25,
        maxListPageSize: WORK_RECORD_LIST_MAX_LIMIT, upperBoundCandidateChecksPerMinute: 4_500,
      },
      rollback: {
        safeForOldBinary: actionableOutboxEvents === 0 && activeIntents === 0,
        actionableOutboxEvents, activeIntents,
        restriction: "Disable workflow-v2 writes and drain or resolve every active intent and actionable/dead-letter outbox event before starting an old binary.",
      },
      generatedAt: new Date(),
    };
  }

  async function assignmentEscalationTarget(companyId: string, database: DbLike = db) {
    return database.select({ id: agents.id }).from(agents).where(and(
      eq(agents.companyId, companyId),
      eq(agents.role, "ceo"),
      ne(agents.status, "terminated"),
    )).orderBy(asc(agents.createdAt), asc(agents.id)).then((rows) => rows[0]?.id ?? null);
  }

  return {
    preview,
    prepare,
    getBatch: batchView,
    reconcile,
    reconcileAll,
    reconcilePage,
    processOutbox,
    recoverOutboxEvent,
    operationsMetrics,
    assignmentEscalationTarget,
    latestAssignmentEscalation,
    escalateAssignmentGaps,
    writesEnabled,
  };
}
