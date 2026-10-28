import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  issues,
  issueRelations,
  workRecords,
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
import {
  WORK_PACKAGE_MAX_DEPTH,
  WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED_BY_DEFAULT,
  classifyWorkRecordCommandReplay,
  classifyWorkRecordWorkflowEvent,
  validateWorkPackageBoundaries,
  type PrepareWorkPackageDispatch,
  type PreviewWorkPackageDispatch,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { budgetService } from "./budgets.js";
import { issueService, listUnfinalizedExecutionWorkspaceIds } from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | DbTransaction;
type Actor = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
};
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

function writesEnabledFromEnv() {
  const value = process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
  if (value === undefined) return WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED_BY_DEFAULT;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
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
  const writesEnabled = options.writesEnabled ?? writesEnabledFromEnv();

  function assertWritesEnabled() {
    if (!writesEnabled) {
      throw forbidden(
        "Work-package workflow v2 writes are disabled",
        details("work_record_workflow_v2_disabled"),
      );
    }
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
    for (const record of scoped) {
      if (record.assigneeAgentId) {
        await assertAssignableAgent(database as Db, companyId, record.assigneeAgentId, { kind: "work" });
      }
      if (record.kind === "defect") {
        if (record.qaAssigneeAgentId && record.qaAssigneeAgentId !== record.assigneeAgentId) {
          await assertAssignableAgent(database as Db, companyId, record.qaAssigneeAgentId, { kind: "work" });
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
      eligibility: scope.eligibility,
    };
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
    assertWritesEnabled();
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

  async function governanceReady(
    companyId: string,
    projectId: string,
    issue: typeof issues.$inferSelect,
    intentKind: typeof workRecordExecutionIntents.$inferSelect.kind,
  ) {
    if (!issue.assigneeAgentId || issue.executionRunId) return false;
    const admissibleStatus = ["backlog", "todo"].includes(issue.status)
      || (intentKind === "rework_release" && issue.status === "in_progress");
    if (!admissibleStatus) return false;
    const agent = await db.select().from(agents).where(and(
      eq(agents.companyId, companyId), eq(agents.id, issue.assigneeAgentId),
    )).then((rows) => rows[0] ?? null);
    if (!agent || !(await evaluateAgentInvokabilityFromDb(db, agent)).invokable) return false;
    if (!isHeartbeatWakeOnDemandEnabled(agent)) return false;
    if (await treeControl.getActivePauseHoldGate(companyId, issue.id)) return false;
    return !(await budgets.getInvocationBlock(companyId, issue.assigneeAgentId, { issueId: issue.id, projectId }));
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
      if (!(await governanceReady(companyId, projectId, issue, intent.kind))) {
        await db.update(workRecordExecutionIntents).set({ state: "waiting_governance", waitingReason: "governance_pending", updatedAt: new Date() })
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
    assertWritesEnabled();
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

  async function reconcileAll(limit = 25) {
    if (!writesEnabled) return 0;
    const batches = await db.select({ companyId: workRecordDispatchBatches.companyId, projectId: workRecordDispatchBatches.projectId, id: workRecordDispatchBatches.id })
      .from(workRecordDispatchBatches)
      .where(inArray(workRecordDispatchBatches.state, ["preparing", "prepared", "blocked"]))
      .orderBy(asc(workRecordDispatchBatches.updatedAt), asc(workRecordDispatchBatches.id))
      .limit(limit);
    for (const batch of batches) {
      await reconcile(batch.companyId, batch.projectId, batch.id, { actorType: "system", actorId: "work-package-reconciler" });
    }
    return batches.length;
  }

  async function processOutbox(wakeup: Wakeup, limit = 25) {
    if (!writesEnabled) return 0;
    const events = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.workflowVersion, 2),
      inArray(workRecordOutbox.state, ["pending", "retry", "processing"]),
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
        const staleIssueRevision = Boolean(intent && issue && !existingWinner &&
          issue.statusVersion !== intent.expectedIssueStatusVersion);
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
        if (failedIntent?.issueId && admissionReason) {
          const readiness = await issueSvc.getDependencyReadiness(failedIntent.issueId);
          await db.update(workRecordExecutionIntents).set({
            state: readiness.isDependencyReady ? "waiting_governance" : "waiting_dependencies",
            waitingReason: admissionReason,
            updatedAt: new Date(),
          }).where(eq(workRecordExecutionIntents.id, failedIntent.id));
        }
        await db.update(workRecordOutbox).set({
          state: "retry",
          lastError: admissionReason ?? (error instanceof Error ? error.message : String(error)),
          attemptCount: claimed.attemptCount + 1,
          availableAt: new Date(Date.now() + 2_000),
          updatedAt: new Date(),
        }).where(eq(workRecordOutbox.id, claimed.id));
      }
    }
    return processed;
  }

  async function assignmentEscalationTarget(companyId: string) {
    return db.select({ id: agents.id }).from(agents).where(and(
      eq(agents.companyId, companyId),
      eq(agents.role, "ceo"),
      ne(agents.status, "terminated"),
    )).orderBy(asc(agents.createdAt), asc(agents.id)).then((rows) => rows[0]?.id ?? null);
  }

  return { preview, prepare, getBatch: batchView, reconcile, reconcileAll, processOutbox, assignmentEscalationTarget, writesEnabled };
}
