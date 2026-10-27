import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
  issueRelations,
  projects,
  workRecords,
  workRecordDependencies,
  workRecordDispatchCommands,
  workRecordExecutionHolds,
  workRecordExecutionProjections,
  workRecordIssueLinks,
  workRecordOutbox,
} from "@paperclipai/db";
import type {
  CreateWorkRecord,
  DispatchWorkRecord,
  UpdateWorkRecord,
  WorkRecord,
  WorkRecordDispatchResult,
  WorkRecordDispatchRequestResult,
  WorkRecordHoldReason,
} from "@paperclipai/shared";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { issueService, listUnfinalizedExecutionWorkspaceIds } from "./issues.js";

type Actor = { actorType: "agent" | "user" | "system" | "plugin"; actorId: string; agentId?: string | null; userId?: string | null };
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Wakeup = (agentId: string, options: {
  source: "assignment"; triggerDetail: "system"; reason: string; payload: Record<string, unknown>;
  idempotencyKey: string; allowRunCoalescing: boolean; requestedByActorType: "user" | "agent" | "system";
  requestedByActorId: string | null; contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;
const ACTIVE_WAKE_STATUSES = ["queued", "claimed", "running", "succeeded"];

function releaseEventKey(record: typeof workRecords.$inferSelect) {
  return `${record.id}:${record.dispatchRound}:${record.dependencySetRevision}:${record.blockedCycle}`;
}

function workRecordLockKey(recordId: string) {
  return `work-record:${recordId}`;
}

function workRecordProjectLockKey(companyId: string, projectId: string) {
  return `work-record-project:${companyId}:${projectId}`;
}

function releasePayload(record: typeof workRecords.$inferSelect, issueId: string) {
  const payload = {
    issueId,
    recordId: record.id,
    dispatchRound: record.dispatchRound,
    dependencySetRevision: record.dependencySetRevision,
    blockedCycle: record.blockedCycle,
  };
  return {
    payload,
    payloadDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

export function workRecordService(db: Db) {
  const issuesSvc = issueService(db);

  async function assertProject(companyId: string, projectId: string) {
    const row = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, projectId))).then((rows) => rows[0]);
    if (!row) throw notFound("Project not found");
  }

  async function assertAssignee(companyId: string, agentId?: string | null) {
    if (!agentId) return;
    const row = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).then((rows) => rows[0]);
    if (!row) throw unprocessable("Assignee is not available in this company");
  }

  async function assertDependencies(
    tx: DbTransaction,
    companyId: string,
    projectId: string,
    recordId: string | null,
    input: string[],
  ) {
    const ids = [...new Set(input)];
    if (recordId && ids.includes(recordId)) throw unprocessable("A record cannot depend on itself");
    if (ids.length === 0) return ids;
    const rows = await tx.select({ id: workRecords.id }).from(workRecords).where(and(
      eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), inArray(workRecords.id, ids),
    ));
    if (rows.length !== ids.length) throw unprocessable("Every predecessor must belong to the same company and project");
    if (recordId) {
      const [cycle] = await tx.execute<{ found: boolean }>(sql`
        with recursive downstream(id) as (
          select successor_record_id from work_record_dependencies
          where company_id = ${companyId} and project_id = ${projectId} and predecessor_record_id = ${recordId}
          union
          select d.successor_record_id from work_record_dependencies d join downstream on d.predecessor_record_id = downstream.id
          where d.company_id = ${companyId} and d.project_id = ${projectId}
        ) select exists(select 1 from downstream where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})) as found
      `);
      if (cycle?.found) throw unprocessable("Dependency update would create a cycle");
    }
    return ids;
  }

  async function raw(companyId: string, projectId: string, recordId: string) {
    const row = await db.select().from(workRecords).where(and(
      eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.id, recordId),
    )).then((rows) => rows[0]);
    if (!row) throw notFound("Work record not found");
    return row;
  }

  async function hydrate(companyId: string, rows: Array<typeof workRecords.$inferSelect>): Promise<WorkRecord[]> {
    if (rows.length === 0) return [];
    const recordIds = rows.map((row) => row.id);
    const deps = await db.select({
      successorId: workRecordDependencies.successorRecordId,
      predecessorId: workRecords.id,
      title: workRecords.title,
      businessStatus: workRecords.businessStatus,
      dispatchState: workRecords.dispatchState,
    }).from(workRecordDependencies).innerJoin(workRecords, eq(workRecordDependencies.predecessorRecordId, workRecords.id)).where(and(
      eq(workRecordDependencies.companyId, companyId), inArray(workRecordDependencies.successorRecordId, recordIds),
    ));
    const holds = await db.select({
      dependentId: workRecordExecutionHolds.dependentRecordId,
      blockingId: workRecordExecutionHolds.blockingRecordId,
      reason: workRecordExecutionHolds.reason,
    }).from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.companyId, companyId), inArray(workRecordExecutionHolds.dependentRecordId, recordIds), isNull(workRecordExecutionHolds.resolvedAt),
    ));
    const projections = await db.select({
      recordId: workRecordExecutionProjections.recordId,
      issueId: issues.id,
      identifier: issues.identifier,
      status: workRecordExecutionProjections.issueStatus,
      statusVersion: workRecordExecutionProjections.issueStatusVersion,
      runId: workRecordExecutionProjections.lastRunId,
      syncState: workRecordExecutionProjections.syncState,
      syncError: workRecordExecutionProjections.syncError,
      projectedAt: workRecordExecutionProjections.projectedAt,
      runStatus: heartbeatRuns.status,
      runAgentId: heartbeatRuns.agentId,
      runStartedAt: heartbeatRuns.startedAt,
      runEndedAt: heartbeatRuns.finishedAt,
    }).from(workRecordExecutionProjections)
      .innerJoin(issues, eq(workRecordExecutionProjections.issueId, issues.id))
      .leftJoin(heartbeatRuns, eq(workRecordExecutionProjections.lastRunId, heartbeatRuns.id)).where(and(
      eq(workRecordExecutionProjections.companyId, companyId), inArray(workRecordExecutionProjections.recordId, recordIds),
    ));
    const outboxRows = await db.select({
      recordId: workRecordOutbox.recordId,
      state: workRecordOutbox.state,
      lastError: workRecordOutbox.lastError,
      updatedAt: workRecordOutbox.updatedAt,
    }).from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, companyId), inArray(workRecordOutbox.recordId, recordIds),
    )).orderBy(desc(workRecordOutbox.createdAt));
    const commandRows = await db.select({
      recordId: workRecordDispatchCommands.recordId,
      state: workRecordDispatchCommands.state,
      error: workRecordDispatchCommands.error,
      updatedAt: workRecordDispatchCommands.updatedAt,
    }).from(workRecordDispatchCommands).where(and(
      eq(workRecordDispatchCommands.companyId, companyId), inArray(workRecordDispatchCommands.recordId, recordIds),
    )).orderBy(desc(workRecordDispatchCommands.createdAt));
    const holdMap = new Map(holds.map((hold) => [`${hold.dependentId}:${hold.blockingId}`, hold.reason]));
    const projectionMap = new Map(projections.map((projection) => [projection.recordId, projection]));
    const outboxMap = new Map<string, (typeof outboxRows)[number]>();
    for (const row of outboxRows) if (!outboxMap.has(row.recordId)) outboxMap.set(row.recordId, row);
    const commandMap = new Map<string, (typeof commandRows)[number]>();
    for (const row of commandRows) if (!commandMap.has(row.recordId)) commandMap.set(row.recordId, row);
    return rows.map((row) => {
      const projection = projectionMap.get(row.id);
      const outbox = outboxMap.get(row.id);
      const command = commandMap.get(row.id);
      const recovery = projection?.syncState === "error"
        ? { code: "projection_error" as const, message: projection.syncError, canReconcile: true, lastConfirmedAt: projection.projectedAt }
        : projection?.syncState === "stale"
          ? { code: "projection_stale" as const, message: "projection_stale", canReconcile: true, lastConfirmedAt: projection.projectedAt }
        : outbox?.state === "retry"
          ? { code: "release_failed" as const, message: outbox.lastError, canReconcile: true, lastConfirmedAt: outbox.updatedAt }
          : command?.state === "failed"
            ? { code: "dispatch_failed" as const, message: command.error, canReconcile: false, lastConfirmedAt: command.updatedAt }
            : outbox && ["pending", "processing"].includes(outbox.state)
              ? { code: "release_pending" as const, message: "Release is waiting for durable delivery", canReconcile: true, lastConfirmedAt: outbox.updatedAt }
              : { code: null, message: null, canReconcile: false, lastConfirmedAt: projection?.projectedAt ?? outbox?.updatedAt ?? command?.updatedAt ?? null };
      return {
        ...row,
        kind: row.kind as WorkRecord["kind"],
        businessStatus: row.businessStatus as WorkRecord["businessStatus"],
        dispatchState: row.dispatchState as WorkRecord["dispatchState"],
        dependencies: deps.filter((dependency) => dependency.successorId === row.id).map((dependency) => ({
          predecessorRecordId: dependency.predecessorId,
          title: dependency.title,
          businessStatus: dependency.businessStatus as WorkRecord["businessStatus"],
          dispatchState: dependency.dispatchState as WorkRecord["dispatchState"],
          holdReason: (holdMap.get(`${row.id}:${dependency.predecessorId}`) ?? null) as WorkRecordHoldReason | null,
        })),
        execution: projection ? {
          issueId: projection.issueId, issueIdentifier: projection.identifier, issueStatus: projection.status,
          issueStatusVersion: projection.statusVersion, lastRunId: projection.runId,
          lastRunStatus: projection.runStatus, lastRunAgentId: projection.runAgentId,
          lastRunStartedAt: projection.runStartedAt, lastRunEndedAt: projection.runEndedAt,
          projectionState: projection.syncState === "error" ? "error" as const : projection.syncState === "stale" ? "stale" as const : "current" as const,
          projectionError: projection.syncError, projectedAt: projection.projectedAt,
        } : {
          issueId: null, issueIdentifier: null, issueStatus: null, issueStatusVersion: null, lastRunId: null,
          lastRunStatus: null, lastRunAgentId: null, lastRunStartedAt: null, lastRunEndedAt: null,
          projectionState: "none" as const, projectionError: null, projectedAt: null,
        },
        recovery,
      };
    });
  }

  async function list(companyId: string, projectId: string) {
    await assertProject(companyId, projectId);
    const rows = await db.select().from(workRecords).where(and(eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId))).orderBy(asc(workRecords.createdAt));
    return hydrate(companyId, rows);
  }

  async function create(companyId: string, input: CreateWorkRecord, actor: Actor) {
    await assertProject(companyId, input.projectId);
    await assertAssignee(companyId, input.assigneeAgentId);
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, input.projectId)}, 0))`);
      const predecessorIds = await assertDependencies(tx, companyId, input.projectId, null, input.predecessorRecordIds);
      const [record] = await tx.insert(workRecords).values({
        companyId, projectId: input.projectId, kind: input.kind, title: input.title, description: input.description ?? null,
        parentRecordId: input.parentRecordId ?? null, iterationId: input.iterationId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null, createdByAgentId: actor.agentId ?? null, createdByUserId: actor.userId ?? null,
      }).returning();
      if (predecessorIds.length) await tx.insert(workRecordDependencies).values(predecessorIds.map((predecessorRecordId) => ({
        companyId, projectId: input.projectId, predecessorRecordId, successorRecordId: record.id,
      })));
      return record;
    });
    return hydrate(companyId, [created]).then((result) => result[0]);
  }

  async function update(companyId: string, projectId: string, recordId: string, input: UpdateWorkRecord) {
    if (input.assigneeAgentId !== undefined) await assertAssignee(companyId, input.assigneeAgentId);
    const updated = await db.transaction(async (tx) => {
      if (input.predecessorRecordIds !== undefined) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(recordId)}, 0))`);
      const locked = await tx.select().from(workRecords).where(and(eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.id, recordId))).then((rows) => rows[0]);
      if (!locked) throw notFound("Work record not found");
      if (locked.revision !== input.expectedRevision) throw conflict("Work record revision changed", { currentRevision: locked.revision });
      const predecessorIds = input.predecessorRecordIds === undefined
        ? null
        : await assertDependencies(tx, companyId, projectId, recordId, input.predecessorRecordIds);
      if (
        locked.dispatchState !== "not_dispatched" &&
        (predecessorIds !== null || input.assigneeAgentId !== undefined || input.businessStatus !== undefined)
      ) throw conflict("Dispatched record routing and business status are controlled by execution");
      if (predecessorIds) {
        await tx.delete(workRecordDependencies).where(and(eq(workRecordDependencies.companyId, companyId), eq(workRecordDependencies.successorRecordId, recordId)));
        if (predecessorIds.length) await tx.insert(workRecordDependencies).values(predecessorIds.map((predecessorRecordId) => ({ companyId, projectId, predecessorRecordId, successorRecordId: recordId })));
      }
      const descriptionChanged = input.description !== undefined && input.description !== locked.description;
      const [row] = await tx.update(workRecords).set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description, descriptionRevision: locked.descriptionRevision + (descriptionChanged ? 1 : 0) } : {}),
        ...(input.businessStatus !== undefined ? { businessStatus: input.businessStatus, statusVersion: locked.statusVersion + 1 } : {}),
        ...(input.parentRecordId !== undefined ? { parentRecordId: input.parentRecordId } : {}),
        ...(input.iterationId !== undefined ? { iterationId: input.iterationId } : {}),
        ...(input.assigneeAgentId !== undefined ? { assigneeAgentId: input.assigneeAgentId } : {}),
        ...(predecessorIds ? { dependencySetRevision: locked.dependencySetRevision + 1 } : {}),
        revision: locked.revision + 1, updatedAt: new Date(),
      }).where(eq(workRecords.id, recordId)).returning();
      return row;
    });
    return hydrate(companyId, [updated]).then((result) => result[0]);
  }

  async function reconcileLocked(
    tx: DbTransaction,
    record: typeof workRecords.$inferSelect,
    link: typeof workRecordIssueLinks.$inferSelect,
  ) {
    const { companyId, projectId } = record;
    const dependencies = await tx.select({
      predecessorId: workRecordDependencies.predecessorRecordId,
      issueId: workRecordIssueLinks.issueId,
      issueStatus: issues.status,
      workspaceId: issues.executionWorkspaceId,
    }).from(workRecordDependencies)
      .leftJoin(workRecordIssueLinks, and(
        eq(workRecordIssueLinks.companyId, companyId),
        eq(workRecordIssueLinks.projectId, projectId),
        eq(workRecordIssueLinks.recordId, workRecordDependencies.predecessorRecordId),
        eq(workRecordIssueLinks.purpose, "primary"),
      ))
      .leftJoin(issues, and(eq(issues.companyId, companyId), eq(workRecordIssueLinks.issueId, issues.id)))
      .where(and(
        eq(workRecordDependencies.companyId, companyId),
        eq(workRecordDependencies.projectId, projectId),
        eq(workRecordDependencies.successorRecordId, record.id),
      ));
    const workspaceIds = dependencies.map((dependency) => dependency.workspaceId).filter((value): value is string => Boolean(value));
    const unfinalized = await listUnfinalizedExecutionWorkspaceIds(tx, companyId, workspaceIds);
    const now = new Date();
    const allHolds = await tx.select().from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.companyId, companyId),
      eq(workRecordExecutionHolds.dependentRecordId, record.id),
      isNull(workRecordExecutionHolds.resolvedAt),
    ));
    const currentHolds = new Map<string, typeof workRecordExecutionHolds.$inferSelect>();
    for (const hold of allHolds) {
      const isCurrent = hold.dispatchRound === record.dispatchRound &&
        hold.dependencySetRevision === record.dependencySetRevision &&
        hold.blockedCycle === record.blockedCycle;
      if (isCurrent) currentHolds.set(hold.blockingRecordId, hold);
      else await tx.update(workRecordExecutionHolds).set({ resolvedAt: now, updatedAt: now }).where(eq(workRecordExecutionHolds.id, hold.id));
    }
    for (const dependency of dependencies) {
      const reason: WorkRecordHoldReason | null = !dependency.issueId
        ? "prerequisite_not_dispatched"
        : dependency.issueStatus !== "done"
          ? "prerequisite_not_completed"
          : dependency.workspaceId && unfinalized.has(dependency.workspaceId)
            ? "delivery_sync_pending"
            : null;
      const existing = currentHolds.get(dependency.predecessorId);
      if (reason && existing) {
        await tx.update(workRecordExecutionHolds).set({ reason, resolvedAt: null, updatedAt: now }).where(eq(workRecordExecutionHolds.id, existing.id));
      } else if (reason) {
        await tx.insert(workRecordExecutionHolds).values({
          companyId,
          projectId,
          dependentRecordId: record.id,
          dependentIssueId: link.issueId,
          blockingRecordId: dependency.predecessorId,
          reason,
          dispatchRound: record.dispatchRound,
          dependencySetRevision: record.dependencySetRevision,
          blockedCycle: record.blockedCycle,
        });
      } else if (existing) {
        await tx.update(workRecordExecutionHolds).set({ resolvedAt: now, updatedAt: now }).where(eq(workRecordExecutionHolds.id, existing.id));
      }
    }
    const unresolved = await tx.select({ id: workRecordExecutionHolds.id }).from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.companyId, companyId),
      eq(workRecordExecutionHolds.dependentRecordId, record.id),
      eq(workRecordExecutionHolds.dispatchRound, record.dispatchRound),
      eq(workRecordExecutionHolds.dependencySetRevision, record.dependencySetRevision),
      eq(workRecordExecutionHolds.blockedCycle, record.blockedCycle),
      isNull(workRecordExecutionHolds.resolvedAt),
    ));
    let dispatchState: typeof workRecords.$inferSelect.dispatchState = "blocked";
    if (unresolved.length === 0) {
      const eventKey = releaseEventKey(record);
      const release = releasePayload(record, link.issueId);
      await tx.insert(workRecordOutbox).values({
        companyId,
        projectId,
        recordId: record.id,
        issueId: link.issueId,
        eventKey,
        dispatchRound: record.dispatchRound,
        dependencySetRevision: record.dependencySetRevision,
        blockedCycle: record.blockedCycle,
        payload: release.payload,
        payloadDigest: release.payloadDigest,
      }).onConflictDoNothing();
      const releaseRow = await tx.select({
        state: workRecordOutbox.state,
        lastError: workRecordOutbox.lastError,
      }).from(workRecordOutbox).where(and(
        eq(workRecordOutbox.companyId, companyId),
        eq(workRecordOutbox.eventKey, eventKey),
      )).then((rows) => rows[0]);
      const idempotencyKey = `work-record-release:${eventKey}`;
      const releaseWake = await tx.select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1).then((rows) => rows[0]);
      const releaseRun = releaseWake
        ? await tx.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, companyId),
            releaseWake.runId
              ? or(eq(heartbeatRuns.id, releaseWake.runId), eq(heartbeatRuns.wakeupRequestId, releaseWake.id))
              : eq(heartbeatRuns.wakeupRequestId, releaseWake.id),
          )).orderBy(desc(heartbeatRuns.createdAt)).limit(1).then((rows) => rows[0])
        : null;
      if (releaseRow?.state === "retry") dispatchState = "failed";
      else if (releaseRun?.status === "queued" || ["queued", "claimed", "deferred_issue_execution"].includes(releaseWake?.status ?? "")) {
        dispatchState = "queued";
      } else dispatchState = "linked";

      const linked = await tx.select({
        status: issues.status,
        statusVersion: issues.statusVersion,
        runId: issues.executionRunId,
      }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, link.issueId))).then((rows) => rows[0]);
      if (linked) {
        const previousProjection = await tx.select({
          lastRunId: workRecordExecutionProjections.lastRunId,
        }).from(workRecordExecutionProjections).where(and(
          eq(workRecordExecutionProjections.companyId, companyId),
          eq(workRecordExecutionProjections.recordId, record.id),
        )).then((rows) => rows[0]);
        const failedRun = releaseRun && ["failed", "timed_out", "interrupted", "cancelled"].includes(releaseRun.status);
        const missingDisposition = releaseRun?.status === "succeeded" && linked.status === "in_progress";
        const deliveryMismatch = releaseRow?.state === "delivered" && !releaseWake;
        const syncError = releaseRow?.state === "retry"
          ? releaseRow.lastError ?? "release_failed"
          : failedRun
            ? releaseRun.error ?? `run_${releaseRun.status}`
            : missingDisposition
              ? "successful_run_missing_disposition"
              : deliveryMismatch
                ? "release_delivery_missing_wake"
                : null;
        const syncState = syncError ? "error" : "current";
        const lastRunId = releaseRun?.id ?? linked.runId ?? previousProjection?.lastRunId ?? null;
        await tx.insert(workRecordExecutionProjections).values({
          companyId,
          projectId,
          recordId: record.id,
          issueId: link.issueId,
          issueStatus: linked.status,
          issueStatusVersion: linked.statusVersion,
          lastRunId,
          syncState,
          syncError,
          projectedAt: now,
        }).onConflictDoUpdate({
          target: [workRecordExecutionProjections.companyId, workRecordExecutionProjections.recordId],
          set: {
            issueStatus: linked.status,
            issueStatusVersion: linked.statusVersion,
            lastRunId,
            syncState,
            syncError,
            projectedAt: now,
            updatedAt: now,
          },
        });
        await tx.update(workRecords).set({
          businessStatus: linked.status,
          statusVersion: linked.statusVersion,
          dispatchState,
          updatedAt: now,
        }).where(eq(workRecords.id, record.id));
      } else {
        await tx.update(workRecords).set({ dispatchState, updatedAt: now }).where(eq(workRecords.id, record.id));
      }
    }
    if (unresolved.length > 0) {
      const linked = await tx.select({
        status: issues.status,
        statusVersion: issues.statusVersion,
        runId: issues.executionRunId,
      }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, link.issueId))).then((rows) => rows[0]);
      if (linked) {
        const previousProjection = await tx.select({
          lastRunId: workRecordExecutionProjections.lastRunId,
        }).from(workRecordExecutionProjections).where(and(
          eq(workRecordExecutionProjections.companyId, companyId),
          eq(workRecordExecutionProjections.recordId, record.id),
        )).then((rows) => rows[0]);
        await tx.insert(workRecordExecutionProjections).values({
          companyId,
          projectId,
          recordId: record.id,
          issueId: link.issueId,
          issueStatus: linked.status,
          issueStatusVersion: linked.statusVersion,
          lastRunId: linked.runId ?? previousProjection?.lastRunId ?? null,
          syncState: "current",
          syncError: null,
          projectedAt: now,
        }).onConflictDoUpdate({
          target: [workRecordExecutionProjections.companyId, workRecordExecutionProjections.recordId],
          set: {
            issueStatus: linked.status,
            issueStatusVersion: linked.statusVersion,
            lastRunId: linked.runId ?? previousProjection?.lastRunId ?? null,
            syncState: "current",
            syncError: null,
            projectedAt: now,
            updatedAt: now,
          },
        });
        await tx.update(workRecords).set({
          businessStatus: linked.status,
          statusVersion: linked.statusVersion,
          dispatchState,
          updatedAt: now,
        }).where(eq(workRecords.id, record.id));
      } else {
        await tx.update(workRecords).set({ dispatchState, updatedAt: now }).where(eq(workRecords.id, record.id));
      }
    }
  }

  async function reconcileRecord(companyId: string, projectId: string, recordId: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(recordId)}, 0))`);
      const record = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId),
        eq(workRecords.projectId, projectId),
        eq(workRecords.id, recordId),
      )).then((rows) => rows[0]);
      if (!record) throw notFound("Work record not found");
      const link = await tx.select().from(workRecordIssueLinks).where(and(
        eq(workRecordIssueLinks.companyId, companyId),
        eq(workRecordIssueLinks.projectId, projectId),
        eq(workRecordIssueLinks.recordId, recordId),
        eq(workRecordIssueLinks.purpose, "primary"),
      )).then((rows) => rows[0]);
      if (!link) return record;
      await reconcileLocked(tx, record, link);
      return tx.select().from(workRecords).where(eq(workRecords.id, recordId)).then((rows) => rows[0]);
    });
  }

  async function reconcileRecordView(companyId: string, projectId: string, recordId: string) {
    await reconcileRecord(companyId, projectId, recordId);
    const record = await raw(companyId, projectId, recordId);
    return hydrate(companyId, [record]).then((rows) => rows[0]);
  }

  async function recoverRecord(companyId: string, projectId: string, recordId: string) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(recordId)}, 0))`);
      const record = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId),
        eq(workRecords.projectId, projectId),
        eq(workRecords.id, recordId),
      )).then((rows) => rows[0]);
      if (!record) throw notFound("Work record not found");
      const eventKey = releaseEventKey(record);
      const outbox = await tx.select().from(workRecordOutbox).where(and(
        eq(workRecordOutbox.companyId, companyId),
        eq(workRecordOutbox.eventKey, eventKey),
      )).then((rows) => rows[0]);
      const now = new Date();
      if (outbox?.state === "retry" || (outbox?.state === "processing" && outbox.availableAt <= now)) {
        await tx.update(workRecordOutbox).set({
          state: "pending",
          availableAt: now,
          lastError: null,
          updatedAt: now,
        }).where(eq(workRecordOutbox.id, outbox.id));
      }
    });
    return reconcileRecordView(companyId, projectId, recordId);
  }

  async function getDispatchRequest(
    companyId: string,
    projectId: string,
    recordId: string,
    clientRequestId: string,
  ): Promise<WorkRecordDispatchRequestResult> {
    const record = await raw(companyId, projectId, recordId);
    const command = await db.select().from(workRecordDispatchCommands).where(and(
      eq(workRecordDispatchCommands.companyId, companyId),
      eq(workRecordDispatchCommands.projectId, projectId),
      eq(workRecordDispatchCommands.recordId, recordId),
      eq(workRecordDispatchCommands.clientRequestId, clientRequestId),
    )).then((rows) => rows[0]);
    if (!command) throw notFound("Dispatch request not found");
    const link = command.issueLinkId
      ? await db.select({
          id: workRecordIssueLinks.id,
          issueId: workRecordIssueLinks.issueId,
          issueIdentifier: issues.identifier,
        }).from(workRecordIssueLinks)
          .innerJoin(issues, and(eq(issues.companyId, companyId), eq(issues.id, workRecordIssueLinks.issueId)))
          .where(and(
            eq(workRecordIssueLinks.companyId, companyId),
            eq(workRecordIssueLinks.id, command.issueLinkId),
          )).then((rows) => rows[0])
      : null;
    const hydrated = await hydrate(companyId, [record]).then((rows) => rows[0]);
    return {
      clientRequestId,
      commandId: command.id,
      state: command.state,
      error: command.error,
      issueId: link?.issueId ?? null,
      issueIdentifier: link?.issueIdentifier ?? null,
      issueLinkId: link?.id ?? null,
      record: hydrated,
    };
  }

  async function dispatch(companyId: string, projectId: string, recordId: string, input: DispatchWorkRecord, actor: Actor): Promise<WorkRecordDispatchResult> {
    let result: Omit<WorkRecordDispatchResult, "record">;
    try {
      result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(recordId)}, 0))`);
      const record = await tx.select().from(workRecords).where(and(eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.id, recordId))).then((rows) => rows[0]);
      if (!record) throw notFound("Work record not found");
      const existingLink = await tx.select().from(workRecordIssueLinks).where(and(
        eq(workRecordIssueLinks.companyId, companyId),
        eq(workRecordIssueLinks.projectId, projectId),
        eq(workRecordIssueLinks.recordId, recordId),
        eq(workRecordIssueLinks.purpose, "primary"),
      )).then((rows) => rows[0]);
      const existingCommand = await tx.select().from(workRecordDispatchCommands).where(and(eq(workRecordDispatchCommands.companyId, companyId), eq(workRecordDispatchCommands.recordId, recordId), eq(workRecordDispatchCommands.clientRequestId, input.clientRequestId))).then((rows) => rows[0]);
      if (existingLink) {
        const linked = await tx.select({ identifier: issues.identifier }).from(issues).where(and(
          eq(issues.companyId, companyId),
          eq(issues.id, existingLink.issueId),
        )).then((rows) => rows[0]);
        const command = existingCommand ?? await tx.insert(workRecordDispatchCommands).values({
          companyId, projectId, recordId, clientRequestId: input.clientRequestId, recordRevision: record.revision,
          dispatchRound: existingLink.dispatchRound, state: "linked", issueLinkId: existingLink.id,
        }).returning().then((rows) => rows[0]);
        return { issueId: existingLink.issueId, issueIdentifier: linked?.identifier ?? null, issueLinkId: existingLink.id, commandId: command.id, replayed: true };
      }
      if (record.revision !== input.expectedRevision) throw conflict("Work record revision changed", { currentRevision: record.revision });
      if (!record.assigneeAgentId) throw unprocessable("Choose an assignee before dispatching");
      const round = record.dispatchRound + 1;
      const command = existingCommand ?? await tx.insert(workRecordDispatchCommands).values({
        companyId, projectId, recordId, clientRequestId: input.clientRequestId, recordRevision: record.revision, dispatchRound: round,
      }).returning().then((rows) => rows[0]);
      const createdIssue = await issuesSvc.create(companyId, {
        projectId, title: record.title, description: record.description, status: "todo", priority: "medium",
        assigneeAgentId: record.assigneeAgentId, createdByAgentId: actor.agentId ?? null, createdByUserId: actor.userId ?? null,
        originKind: "work_record", originId: record.id, idempotencyKey: `work-record:${record.id}`, allowDuplicate: true,
      }, tx);
      const link = await tx.insert(workRecordIssueLinks).values({ companyId, projectId, recordId, issueId: createdIssue.id, purpose: "primary", dispatchRound: round }).returning().then((rows) => rows[0]);
      await tx.update(workRecordDispatchCommands).set({ state: "linked", issueLinkId: link.id, updatedAt: new Date() }).where(eq(workRecordDispatchCommands.id, command.id));
      const dispatchedRecord = await tx.update(workRecords).set({
        dispatchState: "preparing",
        dispatchRound: round,
        updatedAt: new Date(),
      }).where(eq(workRecords.id, recordId)).returning().then((rows) => rows[0]);
      const blockers = await tx.select({ issueId: workRecordIssueLinks.issueId }).from(workRecordDependencies).innerJoin(workRecordIssueLinks, and(
        eq(workRecordIssueLinks.companyId, companyId),
        eq(workRecordIssueLinks.projectId, projectId),
        eq(workRecordDependencies.predecessorRecordId, workRecordIssueLinks.recordId),
        eq(workRecordIssueLinks.purpose, "primary"),
      )).where(and(
        eq(workRecordDependencies.companyId, companyId),
        eq(workRecordDependencies.projectId, projectId),
        eq(workRecordDependencies.successorRecordId, recordId),
      ));
      if (blockers.length) await tx.insert(issueRelations).values(blockers.map((blocker) => ({
        companyId, issueId: blocker.issueId, relatedIssueId: createdIssue.id, type: "blocks" as const,
        createdByAgentId: actor.agentId ?? null, createdByUserId: actor.userId ?? null,
      }))).onConflictDoNothing();
      await reconcileLocked(tx, dispatchedRecord, link);
      return { issueId: createdIssue.id, issueIdentifier: createdIssue.identifier, issueLinkId: link.id, commandId: command.id, replayed: false };
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(recordId)}, 0))`);
            const record = await tx.select().from(workRecords).where(and(
              eq(workRecords.companyId, companyId),
              eq(workRecords.projectId, projectId),
              eq(workRecords.id, recordId),
            )).then((rows) => rows[0]);
            if (!record) return;
            const link = await tx.select({ id: workRecordIssueLinks.id }).from(workRecordIssueLinks).where(and(
              eq(workRecordIssueLinks.companyId, companyId),
              eq(workRecordIssueLinks.recordId, recordId),
              eq(workRecordIssueLinks.purpose, "primary"),
            )).then((rows) => rows[0]);
            if (link) return;
            const now = new Date();
            await tx.insert(workRecordDispatchCommands).values({
              companyId,
              projectId,
              recordId,
              clientRequestId: input.clientRequestId,
              recordRevision: record.revision,
              dispatchRound: record.dispatchRound + 1,
              state: "failed",
              error: message,
            }).onConflictDoUpdate({
              target: [
                workRecordDispatchCommands.companyId,
                workRecordDispatchCommands.recordId,
                workRecordDispatchCommands.clientRequestId,
              ],
              set: { state: "failed", error: message, updatedAt: now },
            });
            await tx.update(workRecords).set({ dispatchState: "failed", updatedAt: now }).where(eq(workRecords.id, recordId));
          });
        } catch {
          // Preserve the original dispatch failure when its persistence path is
          // affected by the same infrastructure outage.
        }
      }
      throw error;
    }
    if (result.replayed) await reconcileRecord(companyId, projectId, recordId);
    const record = await raw(companyId, projectId, recordId).then((row) => hydrate(companyId, [row])).then((rows) => rows[0]);
    return { ...result, record };
  }

  async function reconcileAll(limit = 100) {
    const rows = await db.select({ companyId: workRecords.companyId, projectId: workRecords.projectId, id: workRecords.id })
      .from(workRecords)
      .where(ne(workRecords.dispatchState, "not_dispatched"))
      .orderBy(asc(workRecords.updatedAt), asc(workRecords.id))
      .limit(limit);
    for (const row of rows) await reconcileRecord(row.companyId, row.projectId, row.id);
    return rows.length;
  }

  async function processOutbox(wakeup: Wakeup, limit = 25) {
    const pending = await db.select().from(workRecordOutbox).where(and(
      or(eq(workRecordOutbox.state, "pending"), eq(workRecordOutbox.state, "retry"), eq(workRecordOutbox.state, "processing")),
      sql`${workRecordOutbox.availableAt} <= now()`,
    )).orderBy(asc(workRecordOutbox.createdAt)).limit(limit);
    for (const event of pending) {
      try {
        const fresh = await db.update(workRecordOutbox).set({ state: "processing", availableAt: new Date(Date.now() + 30_000), updatedAt: new Date() }).where(and(
          eq(workRecordOutbox.id, event.id),
          or(eq(workRecordOutbox.state, "pending"), eq(workRecordOutbox.state, "retry"), eq(workRecordOutbox.state, "processing")),
          sql`${workRecordOutbox.availableAt} <= now()`,
        )).returning().then((rows) => rows[0]);
        if (!fresh) continue;
        const currentRecord = await db.select({
          dispatchRound: workRecords.dispatchRound,
          dependencySetRevision: workRecords.dependencySetRevision,
          blockedCycle: workRecords.blockedCycle,
          issueId: workRecordIssueLinks.issueId,
        }).from(workRecords).innerJoin(workRecordIssueLinks, and(
          eq(workRecordIssueLinks.companyId, workRecords.companyId),
          eq(workRecordIssueLinks.projectId, workRecords.projectId),
          eq(workRecordIssueLinks.recordId, workRecords.id),
          eq(workRecordIssueLinks.purpose, "primary"),
        )).where(and(
          eq(workRecords.companyId, fresh.companyId),
          eq(workRecords.id, fresh.recordId),
        )).then((rows) => rows[0]);
        const stale = !currentRecord ||
          currentRecord.issueId !== fresh.issueId ||
          currentRecord.dispatchRound !== fresh.dispatchRound ||
          currentRecord.dependencySetRevision !== fresh.dependencySetRevision ||
          currentRecord.blockedCycle !== fresh.blockedCycle;
        if (stale) {
          await db.update(workRecordOutbox).set({ state: "superseded", lastError: null, updatedAt: new Date() }).where(eq(workRecordOutbox.id, fresh.id));
          continue;
        }
        const linked = await db.select().from(issues).where(and(eq(issues.companyId, fresh.companyId), eq(issues.id, fresh.issueId))).then((rows) => rows[0]);
        if (!linked?.assigneeAgentId) throw new Error("Linked issue has no assignee");
        const readiness = await issuesSvc.getDependencyReadiness(fresh.issueId);
        if (!readiness.isDependencyReady) {
          await db.update(workRecordOutbox).set({ state: "pending", availableAt: new Date(Date.now() + 2_000), updatedAt: new Date() }).where(eq(workRecordOutbox.id, fresh.id));
          continue;
        }
        const idempotencyKey = `work-record-release:${fresh.eventKey}`;
        const findWinner = () => db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, fresh.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey), inArray(agentWakeupRequests.status, ACTIVE_WAKE_STATUSES),
        )).then((rows) => rows[0]);
        if (!await findWinner()) {
          try {
            await wakeup(linked.assigneeAgentId, {
              source: "assignment", triggerDetail: "system", reason: "work_record_released",
              payload: { issueId: fresh.issueId, recordId: fresh.recordId, releaseEventKey: fresh.eventKey }, idempotencyKey,
              allowRunCoalescing: false, requestedByActorType: "system", requestedByActorId: "work-record-outbox",
              contextSnapshot: { issueId: fresh.issueId, source: "work_record_release", recordId: fresh.recordId },
            });
            if (!await findWinner()) throw new Error("Heartbeat admission deferred the work-record release");
          } catch (error) { if (!await findWinner()) throw error; }
        }
        await db.transaction(async (tx) => {
          await tx.update(workRecordOutbox).set({ state: "delivered", deliveredAt: new Date(), lastError: null, attemptCount: fresh.attemptCount + 1, updatedAt: new Date() }).where(eq(workRecordOutbox.id, fresh.id));
          await tx.update(workRecords).set({ dispatchState: "queued", updatedAt: new Date() }).where(eq(workRecords.id, fresh.recordId));
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx.update(workRecordOutbox).set({ state: "retry", lastError: message, attemptCount: event.attemptCount + 1, availableAt: new Date(Date.now() + 2_000), updatedAt: now }).where(eq(workRecordOutbox.id, event.id));
          await tx.update(workRecords).set({ dispatchState: "failed", updatedAt: now }).where(and(
            eq(workRecords.companyId, event.companyId),
            eq(workRecords.id, event.recordId),
          ));
          await tx.update(workRecordExecutionProjections).set({
            syncState: "error",
            syncError: message,
            projectedAt: now,
            updatedAt: now,
          }).where(and(
            eq(workRecordExecutionProjections.companyId, event.companyId),
            eq(workRecordExecutionProjections.recordId, event.recordId),
          ));
        });
      }
    }
  }

  async function assertNoSourceHoldStatusBypass(companyId: string, issueId: string, status?: string) {
    if (!status || !["in_progress", "done"].includes(status)) return;
    const hold = await db.select({ id: workRecordExecutionHolds.id, reason: workRecordExecutionHolds.reason }).from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.companyId, companyId), eq(workRecordExecutionHolds.dependentIssueId, issueId), isNull(workRecordExecutionHolds.resolvedAt),
    )).then((rows) => rows[0]);
    if (hold) throw conflict("Source prerequisites are not ready", { holdId: hold.id, reason: hold.reason });
  }

  return {
    list,
    create,
    update,
    dispatch,
    getDispatchRequest,
    reconcileRecord,
    reconcileRecordView,
    recoverRecord,
    reconcileAll,
    processOutbox,
    assertNoSourceHoldStatusBypass,
  };
}

export function createNonOverlappingWorkRecordTick(run: () => Promise<void>) {
  let running = false;
  return async () => {
    if (running) return false;
    running = true;
    try {
      await run();
      return true;
    } finally {
      running = false;
    }
  };
}
