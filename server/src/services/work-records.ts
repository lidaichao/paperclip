import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companyMemberships,
  heartbeatRuns,
  issues,
  issueRelations,
  projectIterations,
  projectVersions,
  projects,
  workRecordCounters,
  workRecords,
  workRecordUserResponsibilities,
  workRecordAssignmentCommands,
  workRecordDependencies,
  workRecordQaCoverage,
  workRecordDispatchBatchItems,
  workRecordDispatchBatches,
  workRecordDispatchCommands,
  workRecordDescriptionDeliveries,
  workRecordExecutionHolds,
  workRecordExecutionIntents,
  workRecordExecutionProjections,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecordQualityCycles,
  workRecordQualityLinks,
} from "@paperclipai/db";
import { reconcileCandidatesIndependently } from "./work-record-candidate-scan.js";
import type {
  CreateWorkRecord,
  CreateProjectIteration,
  CreateProjectVersion,
  DispatchWorkRecord,
  FillWorkRecordAssignmentGap,
  MutateWorkRecordDependency,
  UpdateWorkRecord,
  UpdateProjectIteration,
  UpdateProjectVersion,
  WorkRecord,
  WorkRecordUserResponsibility,
  WorkRecordDispatchResult,
  WorkRecordDispatchRequestResult,
  WorkRecordHoldReason,
} from "@paperclipai/shared";
import {
  WORK_RECORD_LIST_DEFAULT_LIMIT,
  WORK_RECORD_LIST_MAX_LIMIT,
  classifyWorkRecordCommandReplay,
  workRecordIdentifier,
} from "@paperclipai/shared";
import { HttpError, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { issueService, listUnfinalizedExecutionWorkspaceIds } from "./issues.js";
import { resolveWorkRecordWorkflowV2Rollout } from "./work-record-workflow-v2-rollout.js";

type Actor = { actorType: "agent" | "user" | "system" | "plugin"; actorId: string; agentId?: string | null; userId?: string | null; runId?: string | null };
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type WorkRecordWakeupOptions = {
  source: "assignment" | "automation"; triggerDetail: "system"; reason: string; payload: Record<string, unknown>;
  idempotencyKey: string; allowRunCoalescing: boolean; requestedByActorType: "user" | "agent" | "system";
  requestedByActorId: string | null; contextSnapshot: Record<string, unknown>;
};
type Wakeup = (agentId: string, options: WorkRecordWakeupOptions) => Promise<unknown>;
type DescriptionRevisionAdmission = (agentId: string, options: WorkRecordWakeupOptions) =>
  Promise<{ sourceRunId: string | null; successorRunId: string; wakeupRequestId: string; stopConfirmedAt: Date | null }>;
const ACTIVE_WAKE_STATUSES = ["queued", "claimed", "running", "completed"];

function descriptionIntentKey(recordId: string, descriptionRevision: number) {
  return `work-record-description:${recordId}:${descriptionRevision}`;
}

function descriptionDeliveryView(row: typeof workRecordDescriptionDeliveries.$inferSelect | null | undefined) {
  return {
    descriptionRevision: row?.descriptionRevision ?? null,
    intentKey: row?.intentKey ?? null,
    state: (row?.state ?? null) as WorkRecord["descriptionDelivery"]["state"],
    commentId: row?.commentId ?? null,
    attemptCount: row?.attemptCount ?? 0,
    sourceRunId: row?.sourceRunId ?? null,
    successorRunId: row?.successorRunId ?? null,
    wakeupRequestId: row?.wakeupRequestId ?? null,
    stopConfirmedAt: row?.stopConfirmedAt ?? null,
    queuedAt: row?.queuedAt ?? null,
    modelVisibleAt: row?.modelVisibleAt ?? null,
    confirmedAt: row?.confirmedAt ?? null,
    deliveredAt: row?.deliveredAt ?? null,
    acknowledgedAt: row?.acknowledgedAt ?? null,
    acknowledgedByAgentId: row?.acknowledgedByAgentId ?? null,
    acknowledgedByRunId: row?.acknowledgedByRunId ?? null,
    lastError: row?.lastError ?? null,
  };
}

export interface WorkRecordServiceOptions {
  writesEnabled?: boolean;
}

function releaseEventKey(record: typeof workRecords.$inferSelect) {
  return `${record.id}:${record.dispatchRound}:${record.dependencySetRevision}:${record.blockedCycle}`;
}

function workRecordLockKey(recordId: string) {
  return `work-record:${recordId}`;
}

function workRecordProjectLockKey(companyId: string, projectId: string) {
  return `work-record-project:${companyId}:${projectId}`;
}

function isManagedDispatchState(state: string) {
  return state !== "not_dispatched" && state !== "external";
}

type WorkRecordRow = typeof workRecords.$inferSelect;

function validateWorkRecordParent(
  projectRecords: WorkRecordRow[],
  recordId: string,
  parentRecordId: string | null,
) {
  if (!parentRecordId) return null;
  const recordById = new Map(projectRecords.map((record) => [record.id, record]));
  const parent = recordById.get(parentRecordId) ?? null;
  if (!parent) throw unprocessable("Parent record must belong to the same company and project");
  const seen = new Set<string>();
  let cursor: string | null = parentRecordId;
  while (cursor) {
    if (cursor === recordId) throw unprocessable("Parent update would create a cycle");
    if (seen.has(cursor)) throw unprocessable("Parent hierarchy already contains a cycle");
    seen.add(cursor);
    cursor = recordById.get(cursor)?.parentRecordId ?? null;
  }
  return parent;
}

async function cascadeInheritedIterations(
  tx: DbTransaction,
  companyId: string,
  projectId: string,
  projectRecords: WorkRecordRow[],
  rootRecordId: string,
  rootIterationId: string | null,
) {
  const childrenByParent = new Map<string, WorkRecordRow[]>();
  for (const record of projectRecords) {
    if (!record.parentRecordId || record.id === rootRecordId) continue;
    childrenByParent.set(record.parentRecordId, [
      ...(childrenByParent.get(record.parentRecordId) ?? []),
      record,
    ]);
  }
  const pending = [{ id: rootRecordId, iterationId: rootIterationId }];
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const child of childrenByParent.get(parent.id) ?? []) {
      if (child.iterationAssignmentMode !== "inherit_parent") continue;
      if (child.iterationId !== parent.iterationId) {
        // Hierarchy changes are serialized by the project lock, while ordinary
        // field edits only take the record lock. Take the same record lock here
        // before changing a descendant so a concurrent title/description edit
        // cannot collapse two successful writes into the same revision.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(child.id)}, 0))`);
        await tx.update(workRecords).set({
          iterationId: parent.iterationId,
          revision: sql`${workRecords.revision} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(workRecords.companyId, companyId),
          eq(workRecords.projectId, projectId),
          eq(workRecords.id, child.id),
        ));
      }
      child.iterationId = parent.iterationId;
      pending.push({ id: child.id, iterationId: parent.iterationId });
    }
  }
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

export function workRecordService(db: Db, options: WorkRecordServiceOptions = {}) {
  const issuesSvc = issueService(db);
  const currentRollout = () => resolveWorkRecordWorkflowV2Rollout({ writesEnabled: options.writesEnabled });
  const isWorkflowV2WritesEnabled = (companyId: string, projectId: string) =>
    currentRollout().decision(companyId, projectId).scopeEnabled;

  async function assertProject(companyId: string, projectId: string) {
    const row = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, projectId))).then((rows) => rows[0]);
    if (!row) throw notFound("Project not found");
  }

  async function assertActiveVersion(
    tx: DbTransaction,
    companyId: string,
    projectId: string,
    versionId?: string | null,
  ) {
    if (!versionId) throw unprocessable("Iteration must belong to a version");
    const version = await tx.select().from(projectVersions).where(and(
      eq(projectVersions.companyId, companyId),
      eq(projectVersions.projectId, projectId),
      eq(projectVersions.id, versionId),
    )).then((rows) => rows[0]);
    if (!version) throw unprocessable("Version must belong to the same company and project");
    if (version.archivedAt) throw conflict("Archived version cannot accept iterations");
  }

  async function assertVersionScope(
    tx: DbTransaction,
    companyId: string,
    projectId: string,
    versionId?: string | null,
  ) {
    if (!versionId) return;
    const version = await tx.select({ id: projectVersions.id }).from(projectVersions).where(and(
      eq(projectVersions.companyId, companyId),
      eq(projectVersions.projectId, projectId),
      eq(projectVersions.id, versionId),
    )).then((rows) => rows[0]);
    if (!version) throw unprocessable("Discovery version must belong to the same company and project");
  }

  async function assertIterationNameAvailable(
    tx: DbTransaction,
    companyId: string,
    projectId: string,
    versionId: string,
    name: string,
    excludeIterationId?: string,
  ) {
    const existing = await tx.select({ id: projectIterations.id }).from(projectIterations).where(
      excludeIterationId
        ? and(
          eq(projectIterations.companyId, companyId),
          eq(projectIterations.projectId, projectId),
          eq(projectIterations.versionId, versionId),
          eq(projectIterations.name, name),
          ne(projectIterations.id, excludeIterationId),
        )
        : and(
          eq(projectIterations.companyId, companyId),
          eq(projectIterations.projectId, projectId),
          eq(projectIterations.versionId, versionId),
          eq(projectIterations.name, name),
        ),
    ).limit(1).then((rows) => rows[0]);
    if (existing) throw conflict("Iteration name already exists in this version", { versionId, name });
  }

  async function assertActiveIteration(
    tx: DbTransaction,
    companyId: string,
    projectId: string,
    iterationId?: string | null,
  ) {
    if (!iterationId) return;
    const iteration = await tx.select().from(projectIterations).where(and(
      eq(projectIterations.companyId, companyId),
      eq(projectIterations.projectId, projectId),
      eq(projectIterations.id, iterationId),
    )).then((rows) => rows[0]);
    if (!iteration) throw unprocessable("Iteration must belong to the same company and project");
    if (iteration.archivedAt) throw conflict("Archived iteration cannot accept records");
    if (iteration.versionId) {
      const version = await tx.select({ archivedAt: projectVersions.archivedAt }).from(projectVersions).where(and(
        eq(projectVersions.companyId, companyId),
        eq(projectVersions.projectId, projectId),
        eq(projectVersions.id, iteration.versionId),
      )).then((rows) => rows[0]);
      if (!version || version.archivedAt) throw conflict("Iteration belongs to an archived version");
    }
  }

  async function listVersions(companyId: string, projectId: string) {
    await assertProject(companyId, projectId);
    return db.select().from(projectVersions).where(and(
      eq(projectVersions.companyId, companyId),
      eq(projectVersions.projectId, projectId),
    )).orderBy(asc(projectVersions.createdAt), asc(projectVersions.id));
  }

  async function createVersion(companyId: string, projectId: string, input: CreateProjectVersion) {
    await assertProject(companyId, projectId);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      return tx.insert(projectVersions).values({
        companyId,
        projectId,
        name: input.name,
        targetDate: input.targetDate ?? null,
      }).returning().then((rows) => rows[0]);
    });
  }

  async function updateVersion(companyId: string, projectId: string, versionId: string, input: UpdateProjectVersion) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      const [updated] = await tx.update(projectVersions).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
        revision: sql`${projectVersions.revision} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(projectVersions.companyId, companyId),
        eq(projectVersions.projectId, projectId),
        eq(projectVersions.id, versionId),
        eq(projectVersions.revision, input.expectedRevision),
      )).returning();
      if (updated) return updated;
      const exists = await tx.select({ id: projectVersions.id }).from(projectVersions).where(and(
        eq(projectVersions.companyId, companyId), eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId),
      )).then((rows) => rows[0]);
      if (!exists) throw notFound("Project version not found");
      throw conflict("Project version changed", { versionId });
    });
  }

  async function setVersionArchived(companyId: string, projectId: string, versionId: string, expectedRevision: number, archived: boolean) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      const [updated] = await tx.update(projectVersions).set({
        archivedAt: archived ? new Date() : null,
        revision: sql`${projectVersions.revision} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(projectVersions.companyId, companyId), eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId),
        eq(projectVersions.revision, expectedRevision),
      )).returning();
      if (updated) return updated;
      const exists = await tx.select({ id: projectVersions.id }).from(projectVersions).where(and(
        eq(projectVersions.companyId, companyId), eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId),
      )).then((rows) => rows[0]);
      if (!exists) throw notFound("Project version not found");
      throw conflict("Project version changed", { versionId });
    });
  }

  async function deleteVersion(companyId: string, projectId: string, versionId: string, expectedRevision: number) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      const version = await tx.select().from(projectVersions).where(and(
        eq(projectVersions.companyId, companyId), eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId),
      )).then((rows) => rows[0]);
      if (!version) throw notFound("Project version not found");
      if (version.revision !== expectedRevision) throw conflict("Project version changed", { versionId, currentRevision: version.revision });
      const child = await tx.select({ id: projectIterations.id }).from(projectIterations).where(and(
        eq(projectIterations.companyId, companyId), eq(projectIterations.projectId, projectId), eq(projectIterations.versionId, versionId),
      )).limit(1).then((rows) => rows[0]);
      if (child) throw conflict("Only an empty version can be deleted");
      const discoveredDefect = await tx.select({ id: workRecords.id }).from(workRecords).where(and(
        eq(workRecords.companyId, companyId),
        eq(workRecords.projectId, projectId),
        eq(workRecords.foundInVersionId, versionId),
      )).limit(1).then((rows) => rows[0]);
      if (discoveredDefect) throw conflict("A version referenced by defects cannot be deleted");
      await tx.delete(projectVersions).where(eq(projectVersions.id, versionId));
      return { id: versionId, deleted: true as const };
    });
  }

  async function listIterations(companyId: string, projectId: string) {
    await assertProject(companyId, projectId);
    const [iterations, progressRows] = await Promise.all([
      db.select().from(projectIterations).where(and(
      eq(projectIterations.companyId, companyId), eq(projectIterations.projectId, projectId),
      )).orderBy(asc(projectIterations.createdAt), asc(projectIterations.id)),
      db.select({
        iterationId: workRecords.iterationId,
        completed: sql<number>`count(*) filter (where ${workRecords.businessStatus} = 'done')::int`,
        total: sql<number>`count(*)::int`,
      }).from(workRecords).where(and(
        eq(workRecords.companyId, companyId),
        eq(workRecords.projectId, projectId),
        eq(workRecords.kind, "plan"),
        isNotNull(workRecords.iterationId),
      )).groupBy(workRecords.iterationId),
    ]);
    const progressByIteration = new Map(progressRows.map((row) => [row.iterationId, row]));
    return iterations.map((iteration) => {
      const progress = progressByIteration.get(iteration.id);
      const completed = progress?.completed ?? 0;
      const total = progress?.total ?? 0;
      return {
        ...iteration,
        progress: {
          completed,
          total,
          percent: total === 0 ? 0 : Math.round((completed / total) * 100),
        },
      };
    });
  }

  async function createIteration(companyId: string, projectId: string, input: CreateProjectIteration) {
    await assertProject(companyId, projectId);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      await assertActiveVersion(tx, companyId, projectId, input.versionId);
      await assertIterationNameAvailable(tx, companyId, projectId, input.versionId, input.name);
      return tx.insert(projectIterations).values({
        companyId, projectId, versionId: input.versionId, name: input.name,
        startsOn: input.startsOn ?? null, endsOn: input.endsOn ?? null,
      }).returning().then((rows) => rows[0]);
    });
  }

  async function updateIteration(companyId: string, projectId: string, iterationId: string, input: UpdateProjectIteration) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      const current = await tx.select().from(projectIterations).where(and(
        eq(projectIterations.companyId, companyId), eq(projectIterations.projectId, projectId), eq(projectIterations.id, iterationId),
      )).then((rows) => rows[0]);
      if (!current) throw notFound("Project iteration not found");
      if (current.revision !== input.expectedRevision) throw conflict("Project iteration changed", { iterationId, currentRevision: current.revision });
      await assertActiveVersion(tx, companyId, projectId, input.versionId);
      const nextName = input.name ?? current.name;
      await assertIterationNameAvailable(tx, companyId, projectId, input.versionId, nextName, iterationId);
      const startsOn = input.startsOn === undefined ? current.startsOn : input.startsOn;
      const endsOn = input.endsOn === undefined ? current.endsOn : input.endsOn;
      if (startsOn && endsOn && startsOn > endsOn) throw unprocessable("Iteration start date must not be after its end date");
      return tx.update(projectIterations).set({
        versionId: input.versionId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.startsOn !== undefined ? { startsOn: input.startsOn } : {}),
        ...(input.endsOn !== undefined ? { endsOn: input.endsOn } : {}),
        revision: current.revision + 1,
        updatedAt: new Date(),
      }).where(eq(projectIterations.id, iterationId)).returning().then((rows) => rows[0]);
    });
  }

  async function setIterationArchived(companyId: string, projectId: string, iterationId: string, expectedRevision: number, archived: boolean) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      const current = await tx.select().from(projectIterations).where(and(
        eq(projectIterations.companyId, companyId),
        eq(projectIterations.projectId, projectId),
        eq(projectIterations.id, iterationId),
      )).then((rows) => rows[0]);
      if (!current) throw notFound("Project iteration not found");
      if (current.revision !== expectedRevision) {
        throw conflict("Project iteration changed", { iterationId, currentRevision: current.revision });
      }
      if (!archived) await assertActiveVersion(tx, companyId, projectId, current.versionId);
      const [updated] = await tx.update(projectIterations).set({
        archivedAt: archived ? new Date() : null,
        revision: sql`${projectIterations.revision} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(projectIterations.companyId, companyId), eq(projectIterations.projectId, projectId), eq(projectIterations.id, iterationId),
        eq(projectIterations.revision, expectedRevision),
      )).returning();
      if (updated) return updated;
      throw conflict("Project iteration changed", { iterationId });
    });
  }

  async function deleteIteration(companyId: string, projectId: string, iterationId: string, expectedRevision: number) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      const iteration = await tx.select().from(projectIterations).where(and(
        eq(projectIterations.companyId, companyId), eq(projectIterations.projectId, projectId), eq(projectIterations.id, iterationId),
      )).then((rows) => rows[0]);
      if (!iteration) throw notFound("Project iteration not found");
      if (iteration.revision !== expectedRevision) throw conflict("Project iteration changed", { iterationId, currentRevision: iteration.revision });
      const record = await tx.select({ id: workRecords.id }).from(workRecords).where(and(
        eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.iterationId, iterationId),
      )).limit(1).then((rows) => rows[0]);
      if (record) throw conflict("Only an empty iteration can be deleted");
      await tx.delete(projectIterations).where(eq(projectIterations.id, iterationId));
      return { id: iterationId, deleted: true as const };
    });
  }

  async function assertAssignee(companyId: string, agentId?: string | null) {
    if (!agentId) return;
    const row = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).then((rows) => rows[0]);
    if (!row) throw unprocessable("Assignee is not available in this company");
  }

  async function validateUserResponsibilities(
    tx: DbTransaction,
    companyId: string,
    responsibilities: WorkRecordUserResponsibility[],
  ) {
    const pairs = responsibilities.map(({ userId, role }) => `${userId}\u0000${role}`);
    if (new Set(pairs).size !== pairs.length) throw unprocessable("Duplicate user responsibility");
    const userIds = [...new Set(responsibilities.map(({ userId }) => userId))];
    if (!userIds.length) return;
    const members = await tx.select({
      principalId: companyMemberships.principalId,
      membershipRole: companyMemberships.membershipRole,
    }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      inArray(companyMemberships.principalId, userIds),
    ));
    if (members.length !== userIds.length || members.some((member) => member.membershipRole === "viewer")) {
      throw unprocessable("Every responsible user must be an active, writable member of this company");
    }
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
    const userResponsibilities = await db.select({
      recordId: workRecordUserResponsibilities.recordId,
      userId: workRecordUserResponsibilities.userId,
      role: workRecordUserResponsibilities.role,
    }).from(workRecordUserResponsibilities).where(and(
      eq(workRecordUserResponsibilities.companyId, companyId),
      inArray(workRecordUserResponsibilities.recordId, recordIds),
    ));
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
      eventKey: workRecordOutbox.eventKey,
      executionIntentId: workRecordOutbox.executionIntentId,
      state: workRecordOutbox.state,
      attemptCount: workRecordOutbox.attemptCount,
      recoveryCount: workRecordOutbox.recoveryCount,
      deliveredAt: workRecordOutbox.deliveredAt,
      deadLetteredAt: workRecordOutbox.deadLetteredAt,
      lastRecoveredAt: workRecordOutbox.lastRecoveredAt,
      lastError: workRecordOutbox.lastError,
      updatedAt: workRecordOutbox.updatedAt,
    }).from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, companyId), inArray(workRecordOutbox.recordId, recordIds),
    )).orderBy(desc(workRecordOutbox.createdAt));
    const descriptionDeliveryRows = await db.select().from(workRecordDescriptionDeliveries).where(and(
      eq(workRecordDescriptionDeliveries.companyId, companyId),
      inArray(workRecordDescriptionDeliveries.recordId, recordIds),
    )).orderBy(desc(workRecordDescriptionDeliveries.descriptionRevision));
    const commandRows = await db.select({
      recordId: workRecordDispatchCommands.recordId,
      state: workRecordDispatchCommands.state,
      error: workRecordDispatchCommands.error,
      updatedAt: workRecordDispatchCommands.updatedAt,
    }).from(workRecordDispatchCommands).where(and(
      eq(workRecordDispatchCommands.companyId, companyId), inArray(workRecordDispatchCommands.recordId, recordIds),
    )).orderBy(desc(workRecordDispatchCommands.createdAt));
    const qualityCycles = await db.select({
      id: workRecordQualityCycles.id,
      aggregateRecordId: workRecordQualityCycles.aggregateRecordId,
      cycleNumber: workRecordQualityCycles.cycleNumber,
      revision: workRecordQualityCycles.revision,
      phase: workRecordQualityCycles.qualityPhase,
    }).from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, companyId),
      inArray(workRecordQualityCycles.aggregateRecordId, recordIds),
    )).orderBy(desc(workRecordQualityCycles.cycleNumber), desc(workRecordQualityCycles.createdAt));
    const qualityLinks = await db.select({
      packageRecordId: workRecordQualityLinks.packageRecordId,
    }).from(workRecordQualityLinks).where(and(
      eq(workRecordQualityLinks.companyId, companyId),
      inArray(workRecordQualityLinks.packageRecordId, recordIds),
    ));
    const qaCoverage = await db.select({
      executionRecordId: workRecordQaCoverage.executionRecordId,
      qaRecordId: workRecordQaCoverage.qaRecordId,
    }).from(workRecordQaCoverage).where(and(
      eq(workRecordQaCoverage.companyId, companyId),
      inArray(workRecordQaCoverage.executionRecordId, recordIds),
    ));
    const holdMap = new Map(holds.map((hold) => [`${hold.dependentId}:${hold.blockingId}`, hold.reason]));
    const projectionMap = new Map(projections.map((projection) => [projection.recordId, projection]));
    const outboxMap = new Map<string, (typeof outboxRows)[number]>();
    for (const row of outboxRows) if (!outboxMap.has(row.recordId)) outboxMap.set(row.recordId, row);
    const intentIds = [...new Set([...outboxMap.values()].flatMap((row) => row.executionIntentId ? [row.executionIntentId] : []))];
    const intentRows = intentIds.length > 0 ? await db.select({
      id: workRecordExecutionIntents.id,
      generation: workRecordExecutionIntents.generation,
    }).from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, companyId),
      inArray(workRecordExecutionIntents.id, intentIds),
    )) : [];
    const intentMap = new Map(intentRows.map((intent) => [intent.id, intent]));
    const wakeKeyForOutbox = (row: (typeof outboxRows)[number]) => {
      const intent = row.executionIntentId ? intentMap.get(row.executionIntentId) : null;
      return intent ? `work-record-intent:${intent.id}:${intent.generation}` : `work-record-release:${row.eventKey}`;
    };
    const wakeKeys = [...new Set([...outboxMap.values()].map(wakeKeyForOutbox))];
    const wakeRows = wakeKeys.length > 0 ? await db.select({
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      claimedAt: agentWakeupRequests.claimedAt,
      runId: agentWakeupRequests.runId,
    }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      inArray(agentWakeupRequests.idempotencyKey, wakeKeys),
    )).orderBy(desc(agentWakeupRequests.requestedAt)) : [];
    const wakeMap = new Map<string, (typeof wakeRows)[number]>();
    for (const row of wakeRows) {
      if (row.idempotencyKey && !wakeMap.has(row.idempotencyKey)) wakeMap.set(row.idempotencyKey, row);
    }
    const commandMap = new Map<string, (typeof commandRows)[number]>();
    for (const row of commandRows) if (!commandMap.has(row.recordId)) commandMap.set(row.recordId, row);
    const descriptionDeliveryMap = new Map<string, (typeof descriptionDeliveryRows)[number]>();
    for (const row of descriptionDeliveryRows) if (!descriptionDeliveryMap.has(row.recordId)) descriptionDeliveryMap.set(row.recordId, row);
    const qualityCycleMap = new Map<string, (typeof qualityCycles)[number]>();
    for (const cycle of qualityCycles) if (!qualityCycleMap.has(cycle.aggregateRecordId)) qualityCycleMap.set(cycle.aggregateRecordId, cycle);
    const defectCountMap = new Map<string, number>();
    for (const link of qualityLinks) {
      if (!link.packageRecordId) continue;
      defectCountMap.set(link.packageRecordId, (defectCountMap.get(link.packageRecordId) ?? 0) + 1);
    }
    return rows.map((row) => {
      const projection = projectionMap.get(row.id);
      const outbox = outboxMap.get(row.id);
      const wake = outbox ? wakeMap.get(wakeKeyForOutbox(outbox)) : null;
      const command = commandMap.get(row.id);
      const recovery = projection?.syncState === "error"
        ? { code: "projection_error" as const, message: projection.syncError, canReconcile: true, lastConfirmedAt: projection.projectedAt }
        : projection?.syncState === "stale"
          ? { code: "projection_stale" as const, message: "projection_stale", canReconcile: true, lastConfirmedAt: projection.projectedAt }
        : outbox?.state === "dead_letter"
          ? { code: "release_dead_letter" as const, message: outbox.lastError, canReconcile: false, lastConfirmedAt: outbox.deadLetteredAt ?? outbox.updatedAt }
        : outbox?.state === "retry"
          ? { code: "release_failed" as const, message: outbox.lastError, canReconcile: true, lastConfirmedAt: outbox.updatedAt }
          : command?.state === "failed"
            ? { code: "dispatch_failed" as const, message: command.error, canReconcile: false, lastConfirmedAt: command.updatedAt }
            : outbox && ["pending", "processing"].includes(outbox.state)
              ? { code: "release_pending" as const, message: "Release is waiting for durable delivery", canReconcile: true, lastConfirmedAt: outbox.updatedAt }
              : { code: null, message: null, canReconcile: false, lastConfirmedAt: projection?.projectedAt ?? outbox?.updatedAt ?? command?.updatedAt ?? null };
      return {
        ...row,
        recordIdentifier: workRecordIdentifier(row.kind as WorkRecord["kind"], row.recordNumber),
        kind: row.kind as WorkRecord["kind"],
        businessStatus: row.businessStatus as WorkRecord["businessStatus"],
        dispatchState: row.dispatchState as WorkRecord["dispatchState"],
        userResponsibilities: userResponsibilities.filter((item) => item.recordId === row.id)
          .map(({ userId, role }) => ({ userId, role }))
          .sort((a, b) => a.userId.localeCompare(b.userId) || ["execution", "qa", "po"].indexOf(a.role) - ["execution", "qa", "po"].indexOf(b.role)),
        qaCoverageRecordIds: qaCoverage.filter((coverage) => coverage.executionRecordId === row.id).map((coverage) => coverage.qaRecordId),
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
        delivery: {
          eventKey: outbox?.eventKey ?? null,
          deliveryState: outbox?.state ?? null,
          deliveredAt: outbox?.deliveredAt ?? null,
          attemptCount: outbox?.attemptCount ?? 0,
          recoveryCount: outbox?.recoveryCount ?? 0,
          deadLetteredAt: outbox?.deadLetteredAt ?? null,
          lastRecoveredAt: outbox?.lastRecoveredAt ?? null,
          lastError: outbox?.lastError ?? null,
          wakeRequestId: wake?.id ?? null,
          wakeStatus: wake?.status ?? null,
          acknowledgedAt: wake?.claimedAt ?? null,
          runId: wake?.runId ?? null,
        },
        descriptionDelivery: descriptionDeliveryView(descriptionDeliveryMap.get(row.id)),
        quality: {
          cycleId: qualityCycleMap.get(row.id)?.id ?? null,
          cycleNumber: qualityCycleMap.get(row.id)?.cycleNumber ?? null,
          cycleRevision: qualityCycleMap.get(row.id)?.revision ?? null,
          phase: (qualityCycleMap.get(row.id)?.phase ?? "not_started") as WorkRecord["quality"]["phase"],
          defectCount: defectCountMap.get(row.id) ?? 0,
        },
      };
    });
  }

  async function list(companyId: string, projectId: string) {
    await assertProject(companyId, projectId);
    const rows = await db.select().from(workRecords).where(and(eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId))).orderBy(asc(workRecords.createdAt));
    return hydrate(companyId, rows);
  }

  async function listPage(
    companyId: string,
    projectId: string,
    input: { limit?: number; afterId?: string | null } = {},
  ) {
    await assertProject(companyId, projectId);
    const limit = Math.max(1, Math.min(input.limit ?? WORK_RECORD_LIST_DEFAULT_LIMIT, WORK_RECORD_LIST_MAX_LIMIT));
    const rows = await db.select().from(workRecords).where(and(
      eq(workRecords.companyId, companyId),
      eq(workRecords.projectId, projectId),
      input.afterId ? gt(workRecords.id, input.afterId) : undefined,
    )).orderBy(asc(workRecords.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: await hydrate(companyId, pageRows),
      nextCursor: hasMore ? pageRows.at(-1)?.id ?? null : null,
      limit,
    };
  }

  async function adoptNativeIssues(companyId: string, projectId: string) {
    await assertProject(companyId, projectId);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);

      const nativeIssues = await tx.select().from(issues).where(and(
        eq(issues.companyId, companyId),
        eq(issues.projectId, projectId),
        eq(issues.originKind, "manual"),
        isNull(issues.hiddenAt),
      )).orderBy(asc(issues.createdAt));
      if (!nativeIssues.length) return { adoptedCount: 0, existingCount: 0 };

      const issueIds = nativeIssues.map((issue) => issue.id);
      const existingLinks = await tx.select({
        issueId: workRecordIssueLinks.issueId,
        recordId: workRecordIssueLinks.recordId,
      }).from(workRecordIssueLinks).where(and(
        eq(workRecordIssueLinks.companyId, companyId),
        eq(workRecordIssueLinks.projectId, projectId),
        eq(workRecordIssueLinks.purpose, "primary"),
        inArray(workRecordIssueLinks.issueId, issueIds),
      ));
      const recordIdByIssueId = new Map(existingLinks.map((link) => [link.issueId, link.recordId]));
      const adoptedIssueIds = new Set<string>();

      for (const nativeIssue of nativeIssues) {
        if (recordIdByIssueId.has(nativeIssue.id)) continue;
        const [allocated] = await tx.insert(workRecordCounters).values({
          companyId,
          projectId,
          kind: "plan",
          nextNumber: 2,
        }).onConflictDoUpdate({
          target: [workRecordCounters.companyId, workRecordCounters.projectId, workRecordCounters.kind],
          set: {
            nextNumber: sql`${workRecordCounters.nextNumber} + 1`,
            updatedAt: new Date(),
          },
        }).returning({ recordNumber: sql<number>`${workRecordCounters.nextNumber} - 1` });
        const [record] = await tx.insert(workRecords).values({
          companyId,
          projectId,
          kind: "plan",
          recordNumber: allocated.recordNumber,
          title: nativeIssue.title,
          description: nativeIssue.description,
          priority: nativeIssue.priority as WorkRecordRow["priority"],
          assigneeAgentId: nativeIssue.assigneeAgentId,
          businessStatus: nativeIssue.status,
          statusVersion: nativeIssue.statusVersion,
          dispatchState: "external",
          dispatchRound: 0,
          createdByAgentId: nativeIssue.createdByAgentId,
          createdByUserId: nativeIssue.createdByUserId,
        }).returning();
        await tx.insert(workRecordIssueLinks).values({
          companyId,
          projectId,
          recordId: record.id,
          issueId: nativeIssue.id,
          purpose: "primary",
          dispatchRound: 0,
        });
        await tx.insert(workRecordExecutionProjections).values({
          companyId,
          projectId,
          recordId: record.id,
          issueId: nativeIssue.id,
          issueStatus: nativeIssue.status,
          issueStatusVersion: nativeIssue.statusVersion,
          lastRunId: nativeIssue.executionRunId,
          syncState: "current",
        });
        recordIdByIssueId.set(nativeIssue.id, record.id);
        adoptedIssueIds.add(nativeIssue.id);
      }

      for (const nativeIssue of nativeIssues) {
        if (!adoptedIssueIds.has(nativeIssue.id) || !nativeIssue.parentId) continue;
        const recordId = recordIdByIssueId.get(nativeIssue.id);
        const parentRecordId = recordIdByIssueId.get(nativeIssue.parentId);
        if (!recordId || !parentRecordId || recordId === parentRecordId) continue;
        await tx.update(workRecords).set({ parentRecordId, updatedAt: new Date() }).where(and(
          eq(workRecords.companyId, companyId),
          eq(workRecords.projectId, projectId),
          eq(workRecords.id, recordId),
        ));
      }

      const relations = await tx.select().from(issueRelations).where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.issueId, issueIds),
        inArray(issueRelations.relatedIssueId, issueIds),
      ));
      const dependencyRows = relations.flatMap((relation) => {
        const predecessorRecordId = recordIdByIssueId.get(relation.issueId);
        const successorRecordId = recordIdByIssueId.get(relation.relatedIssueId);
        return predecessorRecordId && successorRecordId && predecessorRecordId !== successorRecordId
          ? [{ companyId, projectId, predecessorRecordId, successorRecordId }]
          : [];
      });
      if (dependencyRows.length) {
        await tx.insert(workRecordDependencies).values(dependencyRows).onConflictDoNothing();
      }

      return {
        adoptedCount: adoptedIssueIds.size,
        existingCount: existingLinks.length,
      };
    });
  }

  async function adoptUnlinkedNativeIssuesPage(limit = 100) {
    const candidates = await db.select({
      companyId: issues.companyId,
      projectId: issues.projectId,
    }).from(issues).leftJoin(workRecordIssueLinks, and(
      eq(workRecordIssueLinks.companyId, issues.companyId),
      eq(workRecordIssueLinks.issueId, issues.id),
      eq(workRecordIssueLinks.purpose, "primary"),
    )).where(and(
      eq(issues.originKind, "manual"),
      isNull(issues.hiddenAt),
      isNotNull(issues.projectId),
      isNull(workRecordIssueLinks.id),
    )).orderBy(asc(issues.createdAt)).limit(Math.max(1, Math.min(limit, 500)));
    const projectScopes = new Map<string, { companyId: string; projectId: string }>();
    for (const candidate of candidates) {
      if (!candidate.projectId) continue;
      projectScopes.set(`${candidate.companyId}:${candidate.projectId}`, {
        companyId: candidate.companyId,
        projectId: candidate.projectId,
      });
    }
    let adoptedCount = 0;
    for (const scope of projectScopes.values()) {
      const result = await adoptNativeIssues(scope.companyId, scope.projectId);
      adoptedCount += result.adoptedCount;
    }
    return { adoptedCount, projectCount: projectScopes.size };
  }

  async function syncAdoptedNativeIssuesPage(limit = 100, afterIssueId: string | null = null) {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = await db.select({
      issueId: issues.id,
      issueTitle: issues.title,
      issueDescription: issues.description,
      issuePriority: issues.priority,
      issueAssigneeAgentId: issues.assigneeAgentId,
      issueStatus: issues.status,
      issueStatusVersion: issues.statusVersion,
      issueRunId: issues.executionRunId,
      recordId: workRecords.id,
      recordTitle: workRecords.title,
      recordDescription: workRecords.description,
      recordPriority: workRecords.priority,
      recordAssigneeAgentId: workRecords.assigneeAgentId,
      recordStatus: workRecords.businessStatus,
      recordStatusVersion: workRecords.statusVersion,
    }).from(workRecordIssueLinks)
      .innerJoin(workRecords, and(
        eq(workRecords.companyId, workRecordIssueLinks.companyId),
        eq(workRecords.projectId, workRecordIssueLinks.projectId),
        eq(workRecords.id, workRecordIssueLinks.recordId),
      ))
      .innerJoin(issues, and(
        eq(issues.companyId, workRecordIssueLinks.companyId),
        eq(issues.id, workRecordIssueLinks.issueId),
      ))
      .where(and(
        eq(workRecordIssueLinks.purpose, "primary"),
        eq(workRecordIssueLinks.dispatchRound, 0),
        eq(workRecords.dispatchState, "external"),
        afterIssueId ? gt(issues.id, afterIssueId) : undefined,
      ))
      .orderBy(asc(issues.id))
      .limit(boundedLimit + 1);
    const hasMore = rows.length > boundedLimit;
    const candidates = hasMore ? rows.slice(0, boundedLimit) : rows;
    let updatedCount = 0;
    await db.transaction(async (tx) => {
      for (const row of candidates) {
        const changed = row.recordTitle !== row.issueTitle
          || row.recordDescription !== row.issueDescription
          || row.recordPriority !== row.issuePriority
          || row.recordAssigneeAgentId !== row.issueAssigneeAgentId
          || row.recordStatus !== row.issueStatus
          || row.recordStatusVersion !== row.issueStatusVersion;
        if (changed) {
          await tx.update(workRecords).set({
            title: row.issueTitle,
            description: row.issueDescription,
            priority: row.issuePriority as WorkRecordRow["priority"],
            assigneeAgentId: row.issueAssigneeAgentId,
            businessStatus: row.issueStatus,
            statusVersion: row.issueStatusVersion,
            updatedAt: new Date(),
          }).where(eq(workRecords.id, row.recordId));
          updatedCount += 1;
        }
        await tx.update(workRecordExecutionProjections).set({
          issueStatus: row.issueStatus,
          issueStatusVersion: row.issueStatusVersion,
          lastRunId: row.issueRunId,
          syncState: "current",
          syncError: null,
          projectedAt: new Date(),
          updatedAt: new Date(),
        }).where(and(
          eq(workRecordExecutionProjections.recordId, row.recordId),
          eq(workRecordExecutionProjections.issueId, row.issueId),
        ));
      }
    });
    return {
      processed: candidates.length,
      updatedCount,
      nextAfterIssueId: hasMore ? candidates.at(-1)?.issueId ?? null : null,
    };
  }

  async function create(companyId: string, input: CreateWorkRecord, actor: Actor) {
    const hasDefectDetails = input.defectSeverity != null || input.foundInVersionId != null;
    if (input.kind !== "defect" && hasDefectDetails) {
      throw unprocessable("Defect fields require a defect record");
    }
    if (input.plannedStartDate && input.plannedCompletionDate && input.plannedStartDate > input.plannedCompletionDate) {
      throw unprocessable("Planned start date must not be after planned completion date");
    }
    if (input.packageQaRole && (!input.parentRecordId || input.kind !== "plan")) {
      throw unprocessable("Package QA role requires a plan child");
    }
    if (input.qaRetestExemptionReason && (!input.parentRecordId || input.kind !== "plan" || input.packageQaRole === "qa")) {
      throw unprocessable("QA retest exemption requires an execution child");
    }
    await assertProject(companyId, input.projectId);
    await assertAssignee(companyId, input.assigneeAgentId);
    await assertAssignee(companyId, input.qaAssigneeAgentId);
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, input.projectId)}, 0))`);
      const parent = input.parentRecordId
        ? await tx.select().from(workRecords).where(and(
            eq(workRecords.companyId, companyId),
            eq(workRecords.projectId, input.projectId),
            eq(workRecords.id, input.parentRecordId),
          )).then((rows) => rows[0] ?? null)
        : null;
      if (input.parentRecordId && !parent) {
        throw unprocessable("Parent record must belong to the same company and project");
      }
      const iterationAssignmentMode = input.iterationAssignmentMode
        ?? (parent ? "inherit_parent" : "independent");
      if (iterationAssignmentMode === "inherit_parent" && !parent) {
        throw unprocessable("Iteration inheritance requires a parent record");
      }
      if (iterationAssignmentMode === "inherit_parent" && input.iterationId != null) {
        throw unprocessable("Inherited records cannot set an iteration directly");
      }
      const iterationId = iterationAssignmentMode === "inherit_parent"
        ? parent!.iterationId
        : input.iterationId ?? null;
      if (iterationAssignmentMode === "independent") {
        await assertActiveIteration(tx, companyId, input.projectId, iterationId);
      }
      await assertVersionScope(tx, companyId, input.projectId, input.foundInVersionId);
      await validateUserResponsibilities(tx, companyId, input.userResponsibilities ?? []);
      const predecessorIds = await assertDependencies(tx, companyId, input.projectId, null, input.predecessorRecordIds ?? []);
      const [allocated] = await tx.insert(workRecordCounters).values({
        companyId,
        projectId: input.projectId,
        kind: input.kind,
        nextNumber: 2,
      }).onConflictDoUpdate({
        target: [workRecordCounters.companyId, workRecordCounters.projectId, workRecordCounters.kind],
        set: {
          nextNumber: sql`${workRecordCounters.nextNumber} + 1`,
          updatedAt: new Date(),
        },
      }).returning({ recordNumber: sql<number>`${workRecordCounters.nextNumber} - 1` });
      const [record] = await tx.insert(workRecords).values({
        companyId, projectId: input.projectId, kind: input.kind, recordNumber: allocated.recordNumber,
        title: input.title, priority: input.priority ?? "medium", description: input.description ?? null,
        parentRecordId: input.parentRecordId ?? null, iterationId, iterationAssignmentMode,
        plannedStartDate: input.plannedStartDate ?? null, plannedCompletionDate: input.plannedCompletionDate ?? null,
        defectSeverity: input.defectSeverity ?? null, foundInVersionId: input.foundInVersionId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null, qaAssigneeAgentId: input.qaAssigneeAgentId ?? null,
        packageQaRole: input.kind === "plan" && input.parentRecordId ? input.packageQaRole ?? "execution" : null,
        qaRetestExemptionReason: input.qaRetestExemptionReason ?? null,
        createdByAgentId: actor.agentId ?? null, createdByUserId: actor.userId ?? null,
      }).returning();
      if (input.userResponsibilities?.length) await tx.insert(workRecordUserResponsibilities).values(
        input.userResponsibilities.map(({ userId, role }) => ({ companyId, projectId: input.projectId, recordId: record.id, userId, role })),
      );
      if (predecessorIds.length) await tx.insert(workRecordDependencies).values(predecessorIds.map((predecessorRecordId) => ({
        companyId, projectId: input.projectId, predecessorRecordId, successorRecordId: record.id,
      })));
      return record;
    });
    return hydrate(companyId, [created]).then((result) => result[0]);
  }

  async function update(companyId: string, projectId: string, recordId: string, input: UpdateWorkRecord) {
    const workflowV2WritesEnabled = isWorkflowV2WritesEnabled(companyId, projectId);
    if (workflowV2WritesEnabled && input.assigneeAgentId !== undefined) {
      throw unprocessable(
        "Work-record assignee changes require the dedicated assignment command",
        { code: "work_record_assignment_command_required", workflowVersion: 2 },
      );
    }
    if (input.assigneeAgentId !== undefined) await assertAssignee(companyId, input.assigneeAgentId);
    if (input.qaAssigneeAgentId !== undefined) await assertAssignee(companyId, input.qaAssigneeAgentId);
    const updated = await db.transaction(async (tx) => {
      const updatesHierarchy = input.parentRecordId !== undefined
        || input.iterationId !== undefined
        || input.iterationAssignmentMode !== undefined;
      if (input.predecessorRecordIds !== undefined || input.qaCoverageRecordIds !== undefined || updatesHierarchy) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(recordId)}, 0))`);
      const locked = await tx.select().from(workRecords).where(and(eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.id, recordId))).then((rows) => rows[0]);
      if (!locked) throw notFound("Work record not found");
      if (locked.revision !== input.expectedRevision) throw conflict("Work record revision changed", { currentRevision: locked.revision });
      if (input.userResponsibilities !== undefined) await validateUserResponsibilities(tx, companyId, input.userResponsibilities);
      if (input.predecessorRecordIds !== undefined && input.dependencySetRevision !== locked.dependencySetRevision) {
        throw conflict("Work record dependency set changed", {
          code: "work_record_dependency_revision_changed",
          currentDependencySetRevision: locked.dependencySetRevision,
        });
      }
      const plannedStartDate = input.plannedStartDate === undefined ? locked.plannedStartDate : input.plannedStartDate;
      const plannedCompletionDate = input.plannedCompletionDate === undefined ? locked.plannedCompletionDate : input.plannedCompletionDate;
      if (plannedStartDate && plannedCompletionDate && plannedStartDate > plannedCompletionDate) {
        throw unprocessable("Planned start date must not be after planned completion date");
      }
      const updatesDefectDetails = input.defectSeverity !== undefined || input.foundInVersionId !== undefined;
      const leavesDefectDetails = (input.defectSeverity === undefined ? locked.defectSeverity : input.defectSeverity) != null
        || (input.foundInVersionId === undefined ? locked.foundInVersionId : input.foundInVersionId) != null;
      if (locked.kind !== "defect" && updatesDefectDetails && leavesDefectDetails) {
        throw unprocessable("Defect fields require a defect record");
      }
      if (input.foundInVersionId !== undefined) {
        await assertVersionScope(tx, companyId, projectId, input.foundInVersionId);
      }
      let nextParentRecordId = locked.parentRecordId;
      let nextIterationAssignmentMode = locked.iterationAssignmentMode;
      let nextIterationId = locked.iterationId;
      let projectRecords: Array<typeof workRecords.$inferSelect> | null = null;
      if (updatesHierarchy) {
        projectRecords = await tx.select().from(workRecords).where(and(
          eq(workRecords.companyId, companyId),
          eq(workRecords.projectId, projectId),
        ));
        nextParentRecordId = input.parentRecordId === undefined ? locked.parentRecordId : input.parentRecordId;
        nextIterationAssignmentMode = input.iterationAssignmentMode ?? locked.iterationAssignmentMode;
        if (input.parentRecordId === null
          && input.iterationAssignmentMode === undefined
          && locked.iterationAssignmentMode === "inherit_parent") {
          nextIterationAssignmentMode = "independent";
        }
        const parent = validateWorkRecordParent(projectRecords, recordId, nextParentRecordId);
        if (nextIterationAssignmentMode === "inherit_parent") {
          if (!parent) throw unprocessable("Iteration inheritance requires a parent record");
          if (input.iterationId != null) throw unprocessable("Inherited records cannot set an iteration directly");
          nextIterationId = parent.iterationId;
        } else {
          nextIterationId = input.iterationId === undefined ? locked.iterationId : input.iterationId;
          if (input.iterationId !== undefined) {
            await assertActiveIteration(tx, companyId, projectId, nextIterationId);
          }
        }
      }
      if (input.packageQaRole !== undefined || input.qaRetestExemptionReason !== undefined) {
        if (locked.kind !== "plan" || !locked.parentRecordId) throw unprocessable("Package QA settings require a plan child");
        if ((input.qaRetestExemptionReason ?? locked.qaRetestExemptionReason) &&
          (input.packageQaRole ?? locked.packageQaRole) === "qa" && input.qaRetestExemptionReason !== null) {
          throw unprocessable("QA task cannot have a retest exemption");
        }
      }
      if (input.qaCoverageRecordIds !== undefined && input.predecessorRecordIds !== undefined) {
        throw unprocessable("Update QA coverage and dependencies in separate revisions");
      }
      const predecessorIds = input.predecessorRecordIds === undefined
        ? null
        : await assertDependencies(tx, companyId, projectId, recordId, input.predecessorRecordIds);
      if (predecessorIds !== null) {
        const activeExecution = await tx.select({ id: workRecordExecutionIntents.id }).from(workRecordExecutionIntents).where(and(
          eq(workRecordExecutionIntents.companyId, companyId),
          eq(workRecordExecutionIntents.projectId, projectId),
          eq(workRecordExecutionIntents.recordId, recordId),
          eq(workRecordExecutionIntents.state, "running"),
        )).limit(1).then((rows) => rows[0] ?? null);
        if (activeExecution) throw conflict("Dependencies cannot change while the record is running", {
          code: "work_record_dependency_running",
          recordId,
        });
      }
      if (
        isManagedDispatchState(locked.dispatchState) &&
        ((!workflowV2WritesEnabled && predecessorIds !== null) || input.assigneeAgentId !== undefined || input.qaAssigneeAgentId !== undefined || input.businessStatus !== undefined || input.parentRecordId !== undefined || input.packageQaRole !== undefined || input.qaRetestExemptionReason !== undefined || input.qaCoverageRecordIds !== undefined)
      ) throw conflict("Dispatched record routing and business status are controlled by execution");
      if (input.qaCoverageRecordIds !== undefined) {
        if (locked.packageQaRole !== "execution" || !locked.parentRecordId) {
          throw unprocessable("QA coverage requires an execution child");
        }
        const qaIds = [...new Set(input.qaCoverageRecordIds)];
        const qaRecords = qaIds.length ? await tx.select().from(workRecords).where(and(
          eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), inArray(workRecords.id, qaIds),
        )) : [];
        if (qaRecords.length !== qaIds.length || qaRecords.some((qa) =>
          qa.id === recordId || qa.parentRecordId !== locked.parentRecordId || qa.packageQaRole !== "qa" || !qa.assigneeAgentId
        )) throw unprocessable("QA coverage must point to assigned original QA children in the same package");
        if (qaIds.length) {
          const sameParent = await tx.select({ id: workRecords.id }).from(workRecords).where(and(
            eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId),
            eq(workRecords.parentRecordId, locked.parentRecordId),
          ));
          const inPackage = new Set(sameParent.map((record) => record.id));
          const edges = await tx.select().from(workRecordDependencies).where(and(
            eq(workRecordDependencies.companyId, companyId), eq(workRecordDependencies.projectId, projectId),
          ));
          const outgoing = new Map<string, string[]>();
          for (const edge of edges) if (inPackage.has(edge.predecessorRecordId) && inPackage.has(edge.successorRecordId)) {
            outgoing.set(edge.predecessorRecordId, [...(outgoing.get(edge.predecessorRecordId) ?? []), edge.successorRecordId]);
          }
          const reachable = new Set<string>();
          const pending = [recordId];
          while (pending.length) {
            const id = pending.pop()!;
            for (const next of outgoing.get(id) ?? []) if (!reachable.has(next)) { reachable.add(next); pending.push(next); }
          }
          if (qaIds.some((id) => !reachable.has(id))) throw unprocessable("QA coverage requires a dependency path from execution to QA");
        }
        await tx.delete(workRecordQaCoverage).where(and(
          eq(workRecordQaCoverage.companyId, companyId), eq(workRecordQaCoverage.projectId, projectId),
          eq(workRecordQaCoverage.executionRecordId, recordId),
        ));
        if (qaIds.length) await tx.insert(workRecordQaCoverage).values(qaIds.map((qaRecordId) => ({
          companyId, projectId, executionRecordId: recordId, qaRecordId,
        })));
      }
      if (predecessorIds) {
        await tx.delete(workRecordDependencies).where(and(eq(workRecordDependencies.companyId, companyId), eq(workRecordDependencies.successorRecordId, recordId)));
        if (predecessorIds.length) await tx.insert(workRecordDependencies).values(predecessorIds.map((predecessorRecordId) => ({ companyId, projectId, predecessorRecordId, successorRecordId: recordId })));
      }
      const descriptionChanged = input.description !== undefined && input.description !== locked.description;
      const nextDescriptionRevision = locked.descriptionRevision + (descriptionChanged ? 1 : 0);
      const primaryLink = descriptionChanged && isManagedDispatchState(locked.dispatchState)
        ? await tx.select().from(workRecordIssueLinks).where(and(
            eq(workRecordIssueLinks.companyId, companyId),
            eq(workRecordIssueLinks.projectId, projectId),
            eq(workRecordIssueLinks.recordId, recordId),
            eq(workRecordIssueLinks.purpose, "primary"),
          )).then((rows) => rows[0] ?? null)
        : null;
      const [row] = await tx.update(workRecords).set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.description !== undefined ? { description: input.description, descriptionRevision: nextDescriptionRevision } : {}),
        ...(input.businessStatus !== undefined ? { businessStatus: input.businessStatus, statusVersion: locked.statusVersion + 1 } : {}),
        ...(updatesHierarchy ? {
          parentRecordId: nextParentRecordId,
          iterationId: nextIterationId,
          iterationAssignmentMode: nextIterationAssignmentMode,
        } : {}),
        ...(input.plannedStartDate !== undefined ? { plannedStartDate: input.plannedStartDate } : {}),
        ...(input.plannedCompletionDate !== undefined ? { plannedCompletionDate: input.plannedCompletionDate } : {}),
        ...(input.defectSeverity !== undefined ? { defectSeverity: input.defectSeverity } : {}),
        ...(input.foundInVersionId !== undefined ? { foundInVersionId: input.foundInVersionId } : {}),
        ...(input.assigneeAgentId !== undefined ? { assigneeAgentId: input.assigneeAgentId } : {}),
        ...(input.qaAssigneeAgentId !== undefined ? { qaAssigneeAgentId: input.qaAssigneeAgentId } : {}),
        ...(input.packageQaRole !== undefined ? { packageQaRole: input.packageQaRole } : {}),
        ...(input.qaRetestExemptionReason !== undefined ? { qaRetestExemptionReason: input.qaRetestExemptionReason } : {}),
        ...(predecessorIds ? { dependencySetRevision: locked.dependencySetRevision + 1 } : {}),
        revision: locked.revision + 1, updatedAt: new Date(),
      }).where(eq(workRecords.id, recordId)).returning();
      if (locked.dispatchState === "external") {
        const externalLink = await tx.select({ issueId: workRecordIssueLinks.issueId }).from(workRecordIssueLinks).where(and(
          eq(workRecordIssueLinks.companyId, companyId),
          eq(workRecordIssueLinks.projectId, projectId),
          eq(workRecordIssueLinks.recordId, recordId),
          eq(workRecordIssueLinks.purpose, "primary"),
          eq(workRecordIssueLinks.dispatchRound, 0),
        )).then((rows) => rows[0] ?? null);
        if (!externalLink) throw conflict("External work record lost its native task link");
        const parentIssueId = nextParentRecordId
          ? await tx.select({ issueId: workRecordIssueLinks.issueId }).from(workRecordIssueLinks).where(and(
              eq(workRecordIssueLinks.companyId, companyId),
              eq(workRecordIssueLinks.projectId, projectId),
              eq(workRecordIssueLinks.recordId, nextParentRecordId),
              eq(workRecordIssueLinks.purpose, "primary"),
            )).then((rows) => rows[0]?.issueId ?? null)
          : null;
        await issuesSvc.update(externalLink.issueId, {
          companyGuard: companyId,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.businessStatus !== undefined ? { status: input.businessStatus } : {}),
          ...(input.assigneeAgentId !== undefined ? { assigneeAgentId: input.assigneeAgentId } : {}),
          ...(input.parentRecordId !== undefined ? { parentId: parentIssueId } : {}),
        }, tx);
      }
      if (updatesHierarchy && projectRecords) {
        await cascadeInheritedIterations(
          tx,
          companyId,
          projectId,
          projectRecords,
          recordId,
          nextIterationId,
        );
      }
      if (input.userResponsibilities !== undefined) {
        await tx.delete(workRecordUserResponsibilities).where(and(
          eq(workRecordUserResponsibilities.companyId, companyId),
          eq(workRecordUserResponsibilities.projectId, projectId),
          eq(workRecordUserResponsibilities.recordId, recordId),
        ));
        if (input.userResponsibilities.length) await tx.insert(workRecordUserResponsibilities).values(
          input.userResponsibilities.map(({ userId, role }) => ({ companyId, projectId, recordId, userId, role })),
        );
      }
      if (descriptionChanged && primaryLink) {
        const issue = await issuesSvc.update(primaryLink.issueId, {
          description: input.description ?? null,
          companyGuard: companyId,
        }, tx);
        if (!issue) throw notFound("Linked native issue not found");
        const intentKey = descriptionIntentKey(recordId, nextDescriptionRevision);
        const body = [
          `Work-record description updated to revision ${nextDescriptionRevision}.`,
          "",
          input.description?.length ? input.description : "(description cleared)",
          "",
          `Receipt intent: ${intentKey}`,
        ].join("\n");
        const comment = await issuesSvc.addComment(primaryLink.issueId, body, {}, { authorType: "system" }, tx);
        const payloadDigest = createHash("sha256").update(JSON.stringify({
          issueId: primaryLink.issueId,
          commentId: comment.id,
          recordId,
          descriptionRevision: nextDescriptionRevision,
          description: input.description ?? null,
        })).digest("hex");
        await tx.insert(workRecordDescriptionDeliveries).values({
          companyId,
          projectId,
          recordId,
          issueId: primaryLink.issueId,
          commentId: comment.id,
          descriptionRevision: nextDescriptionRevision,
          intentKey,
          payloadDigest,
        });
      }
      if (isManagedDispatchState(locked.dispatchState) && workflowV2WritesEnabled && predecessorIds !== null) {
        const activeIntents = await tx.select({ id: workRecordExecutionIntents.id }).from(workRecordExecutionIntents).where(and(
          eq(workRecordExecutionIntents.companyId, companyId),
          eq(workRecordExecutionIntents.projectId, projectId),
          eq(workRecordExecutionIntents.recordId, recordId),
          inArray(workRecordExecutionIntents.state, ["pending", "waiting_dependencies", "waiting_governance", "ready", "queued", "running", "failed"]),
        ));
        const now = new Date();
        if (activeIntents.length > 0) {
          await tx.update(workRecordExecutionIntents).set({
            state: "superseded",
            waitingReason: "dependency_revision_changed",
            supersededAt: now,
            updatedAt: now,
          }).where(inArray(workRecordExecutionIntents.id, activeIntents.map((intent) => intent.id)));
          await tx.update(workRecordOutbox).set({ state: "superseded", updatedAt: now }).where(and(
            eq(workRecordOutbox.companyId, companyId),
            eq(workRecordOutbox.workflowVersion, 2),
            inArray(workRecordOutbox.executionIntentId, activeIntents.map((intent) => intent.id)),
          ));
        }
        const activeBatches = await tx.select({
          id: workRecordDispatchBatchItems.batchId,
          rootRecordId: workRecordDispatchBatches.rootRecordId,
        }).from(workRecordDispatchBatchItems)
          .innerJoin(workRecordDispatchBatches, and(
            eq(workRecordDispatchBatches.companyId, workRecordDispatchBatchItems.companyId),
            eq(workRecordDispatchBatches.id, workRecordDispatchBatchItems.batchId),
          ))
          .where(and(
            eq(workRecordDispatchBatchItems.companyId, companyId),
            eq(workRecordDispatchBatchItems.projectId, projectId),
            eq(workRecordDispatchBatchItems.recordId, recordId),
            inArray(workRecordDispatchBatches.state, ["preparing", "prepared", "blocked", "failed"]),
          ));
        if (activeBatches.length > 0) {
          await tx.update(workRecordDispatchBatches).set({
            state: "superseded",
            errorCode: "work_record_workflow_stale_revision",
            updatedAt: now,
          }).where(inArray(workRecordDispatchBatches.id, [...new Set(activeBatches.map((batch) => batch.id))]));
          const aggregateIds = [...new Set(activeBatches.map((batch) => batch.rootRecordId).filter((id): id is string => Boolean(id)))];
          if (aggregateIds.length > 0) {
            await tx.update(workRecordQualityCycles).set({
              state: "superseded",
              reason: "dependency_revision_changed",
              closedAt: now,
              updatedAt: now,
            }).where(and(
              eq(workRecordQualityCycles.companyId, companyId),
              eq(workRecordQualityCycles.projectId, projectId),
              inArray(workRecordQualityCycles.aggregateRecordId, aggregateIds),
              eq(workRecordQualityCycles.state, "open"),
            ));
          }
        }
      }
      return row;
    });
    return hydrate(companyId, [updated]).then((result) => result[0]);
  }

  async function mutateDependency(companyId: string, projectId: string, input: MutateWorkRecordDependency,
    audit?: (tx: Db, affectedRecordIds: string[]) => Promise<void>) {
    const affectedSuccessorIds = [...new Set([
      input.successorRecordId,
      ...(input.replacementSuccessorRecordId ? [input.replacementSuccessorRecordId] : []),
    ])].sort();
    const expectedById = new Map(input.expectedRecords.map((item) => [item.recordId, item]));
    const affected = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordProjectLockKey(companyId, projectId)}, 0))`);
      const projectRecords = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId),
      ));
      const byId = new Map(projectRecords.map((record) => [record.id, record]));
      const referencedIds = [input.predecessorRecordId, input.successorRecordId,
        input.replacementPredecessorRecordId, input.replacementSuccessorRecordId].filter((id): id is string => Boolean(id));
      if (referencedIds.some((id) => !byId.has(id))) {
        throw unprocessable("Every dependency endpoint must belong to the same company and project");
      }
      for (const successorId of affectedSuccessorIds) {
        const record = byId.get(successorId)!;
        const expected = expectedById.get(successorId)!;
        if (record.revision !== expected.expectedRevision) {
          throw conflict("Work record revision changed", { recordId: successorId, currentRevision: record.revision });
        }
        if (record.dependencySetRevision !== expected.expectedDependencySetRevision) {
          throw conflict("Work record dependency set changed", {
            code: "work_record_dependency_revision_changed", recordId: successorId,
            currentDependencySetRevision: record.dependencySetRevision,
          });
        }
        if (isManagedDispatchState(record.dispatchState) && !isWorkflowV2WritesEnabled(companyId, projectId)) {
          throw conflict("Dispatched record dependencies are controlled by execution");
        }
      }
      const running = await tx.select({ recordId: workRecordExecutionIntents.recordId }).from(workRecordExecutionIntents).where(and(
        eq(workRecordExecutionIntents.companyId, companyId), eq(workRecordExecutionIntents.projectId, projectId),
        inArray(workRecordExecutionIntents.recordId, affectedSuccessorIds), eq(workRecordExecutionIntents.state, "running"),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (running) throw conflict("Dependencies cannot change while the record is running", {
        code: "work_record_dependency_running", recordId: running.recordId,
      });

      const edges = await tx.select().from(workRecordDependencies).where(and(
        eq(workRecordDependencies.companyId, companyId), eq(workRecordDependencies.projectId, projectId),
      ));
      const edgeKey = (predecessorId: string, successorId: string) => `${predecessorId}:${successorId}`;
      const finalEdges = new Map(edges.map((edge) => [edgeKey(edge.predecessorRecordId, edge.successorRecordId), {
        predecessorRecordId: edge.predecessorRecordId, successorRecordId: edge.successorRecordId,
      }]));
      const originalKey = edgeKey(input.predecessorRecordId, input.successorRecordId);
      const isCreate = input.operation === "add";
      if (isCreate && finalEdges.has(originalKey)) throw unprocessable("Dependency already exists");
      if (!isCreate && !finalEdges.has(originalKey)) throw conflict("Dependency edge no longer exists", { code: "work_record_dependency_missing" });
      if (!isCreate) finalEdges.delete(originalKey);
      const nextPredecessorId = input.replacementPredecessorRecordId ?? input.predecessorRecordId;
      const nextSuccessorId = input.replacementSuccessorRecordId ?? input.successorRecordId;
      const nextKey = edgeKey(nextPredecessorId, nextSuccessorId);
      const isDelete = input.operation === "remove";
      if (!isDelete) {
        if (nextPredecessorId === nextSuccessorId) throw unprocessable("A record cannot depend on itself");
        if (finalEdges.has(nextKey)) throw unprocessable("Dependency already exists");
        finalEdges.set(nextKey, { predecessorRecordId: nextPredecessorId, successorRecordId: nextSuccessorId });
      }
      const outgoing = new Map<string, string[]>();
      for (const edge of finalEdges.values()) outgoing.set(edge.predecessorRecordId, [...(outgoing.get(edge.predecessorRecordId) ?? []), edge.successorRecordId]);
      const visiting = new Set<string>(); const visited = new Set<string>();
      const hasCycle = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;
        visiting.add(id);
        for (const next of outgoing.get(id) ?? []) if (hasCycle(next)) return true;
        visiting.delete(id); visited.add(id); return false;
      };
      if (projectRecords.some((record) => hasCycle(record.id))) throw unprocessable("Dependency update would create a cycle");

      await tx.delete(workRecordDependencies).where(and(
        eq(workRecordDependencies.companyId, companyId), eq(workRecordDependencies.projectId, projectId),
        inArray(workRecordDependencies.successorRecordId, affectedSuccessorIds),
      ));
      const replacementEdges = [...finalEdges.values()].filter((edge) => affectedSuccessorIds.includes(edge.successorRecordId));
      if (replacementEdges.length) await tx.insert(workRecordDependencies).values(replacementEdges.map((edge) => ({ companyId, projectId, ...edge })));
      const rows = [];
      for (const successorId of affectedSuccessorIds) {
        const [row] = await tx.update(workRecords).set({
          revision: byId.get(successorId)!.revision + 1,
          dependencySetRevision: byId.get(successorId)!.dependencySetRevision + 1,
          updatedAt: new Date(),
        }).where(and(eq(workRecords.companyId, companyId), eq(workRecords.projectId, projectId), eq(workRecords.id, successorId))).returning();
        rows.push(row);
      }
      await audit?.(tx as unknown as Db, rows.map((row) => row.id));
      return rows;
    });
    return hydrate(companyId, affected);
  }

  async function getDescriptionDelivery(
    companyId: string,
    projectId: string,
    recordId: string,
    descriptionRevision: number,
  ) {
    await raw(companyId, projectId, recordId);
    const row = await db.select().from(workRecordDescriptionDeliveries).where(and(
      eq(workRecordDescriptionDeliveries.companyId, companyId),
      eq(workRecordDescriptionDeliveries.projectId, projectId),
      eq(workRecordDescriptionDeliveries.recordId, recordId),
      eq(workRecordDescriptionDeliveries.descriptionRevision, descriptionRevision),
    )).then((rows) => rows[0]);
    if (!row) throw notFound("Description delivery not found");
    return descriptionDeliveryView(row);
  }

  async function deliverDescriptionRevision(
    companyId: string,
    projectId: string,
    recordId: string,
    descriptionRevision: number,
    admit: DescriptionRevisionAdmission,
  ) {
    let claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(recordId)}, 0))`);
      const row = await tx.select().from(workRecordDescriptionDeliveries).where(and(
        eq(workRecordDescriptionDeliveries.companyId, companyId),
        eq(workRecordDescriptionDeliveries.projectId, projectId),
        eq(workRecordDescriptionDeliveries.recordId, recordId),
        eq(workRecordDescriptionDeliveries.descriptionRevision, descriptionRevision),
      )).then((rows) => rows[0]);
      if (!row) throw notFound("Description delivery not found");
      if (row.state === "queued" || row.state === "confirmed") return row;
      return tx.update(workRecordDescriptionDeliveries).set({
        state: "stopping",
        attemptCount: row.attemptCount + 1,
        lastAttemptAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(workRecordDescriptionDeliveries.id, row.id)).returning().then((rows) => rows[0]);
    });
    if (claimed.state === "queued" || claimed.state === "confirmed") return descriptionDeliveryView(claimed);

    const linked = await db.select({
      assigneeAgentId: issues.assigneeAgentId,
      executionRunId: issues.executionRunId,
    }).from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.id, claimed.issueId),
    )).then((rows) => rows[0]);
    if (!linked?.assigneeAgentId) {
      const [failed] = await db.update(workRecordDescriptionDeliveries).set({
        state: "retry", lastError: "Linked native issue has no assignee", updatedAt: new Date(),
      }).where(eq(workRecordDescriptionDeliveries.id, claimed.id)).returning();
      return descriptionDeliveryView(failed);
    }
    if (!claimed.sourceRunId && linked.executionRunId) {
      claimed = await db.update(workRecordDescriptionDeliveries).set({
        sourceRunId: linked.executionRunId,
        updatedAt: new Date(),
      }).where(and(
        eq(workRecordDescriptionDeliveries.id, claimed.id),
        isNull(workRecordDescriptionDeliveries.sourceRunId),
      )).returning().then((rows) => rows[0] ?? claimed);
    }
    const findWinner = () => db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, claimed.intentKey),
    )).orderBy(desc(agentWakeupRequests.requestedAt)).then((rows) => rows.find((row) => !["skipped", "failed", "cancelled"].includes(row.status)) ?? null);
    try {
      let winner = await findWinner();
      let admission: Awaited<ReturnType<DescriptionRevisionAdmission>> | null = null;
      if (!winner) {
        try {
          admission = await admit(linked.assigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "work_record_description_updated",
            payload: {
              issueId: claimed.issueId,
              commentId: claimed.commentId,
              recordId,
              descriptionRevision,
              intentKey: claimed.intentKey,
              sourceRunId: claimed.sourceRunId,
            },
            idempotencyKey: claimed.intentKey,
            allowRunCoalescing: false,
            requestedByActorType: "system",
            requestedByActorId: "work-record-description-delivery",
            contextSnapshot: {
              issueId: claimed.issueId,
              taskId: claimed.issueId,
              commentId: claimed.commentId,
              wakeCommentId: claimed.commentId,
              wakeReason: "work_record_description_updated",
              source: "work_record.description",
              recordId,
              descriptionRevision,
              intentKey: claimed.intentKey,
              sourceRunId: claimed.sourceRunId,
            },
          });
        } catch (error) {
          winner = await findWinner();
          if (!winner) throw error;
        }
        winner ??= await findWinner();
      }
      if (!winner) throw new Error("Description delivery was not durably admitted");
      if (!winner.runId) throw new Error("Description continuation has no successor run");
      if (admission && (admission.successorRunId !== winner.runId || admission.wakeupRequestId !== winner.id)) {
        throw new Error("Description continuation receipt does not match durable admission");
      }
      const [queued] = await db.update(workRecordDescriptionDeliveries).set({
        state: "queued",
        sourceRunId: admission?.sourceRunId ?? claimed.sourceRunId,
        successorRunId: winner.runId,
        wakeupRequestId: winner.id,
        stopConfirmedAt: admission?.stopConfirmedAt ?? claimed.stopConfirmedAt,
        queuedAt: claimed.queuedAt ?? new Date(),
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(workRecordDescriptionDeliveries.id, claimed.id)).returning();
      return descriptionDeliveryView(queued);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const [failed] = await db.update(workRecordDescriptionDeliveries).set({
        state: "retry", lastError: message, updatedAt: new Date(),
      }).where(eq(workRecordDescriptionDeliveries.id, claimed.id)).returning();
      return descriptionDeliveryView(failed);
    }
  }

  async function acknowledgeDescriptionRevision(
    companyId: string,
    projectId: string,
    recordId: string,
    descriptionRevision: number,
    intentKey: string,
    actor: { agentId: string; runId: string | null },
  ) {
    if (!actor.runId) throw forbidden("A running agent is required to acknowledge description delivery");
    const runId = actor.runId;
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(recordId)}, 0))`);
      const delivery = await tx.select().from(workRecordDescriptionDeliveries).where(and(
        eq(workRecordDescriptionDeliveries.companyId, companyId),
        eq(workRecordDescriptionDeliveries.projectId, projectId),
        eq(workRecordDescriptionDeliveries.recordId, recordId),
        eq(workRecordDescriptionDeliveries.descriptionRevision, descriptionRevision),
      )).then((rows) => rows[0]);
      if (!delivery) throw notFound("Description delivery not found");
      if (delivery.intentKey !== intentKey) throw conflict("Description delivery intent changed");
      const issue = await tx.select({
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
      }).from(issues).where(and(
        eq(issues.companyId, companyId), eq(issues.id, delivery.issueId),
      )).then((rows) => rows[0]);
      if (issue?.assigneeAgentId !== actor.agentId) throw forbidden("Only the current native issue agent can acknowledge description delivery");
      const run = await tx.select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.agentId, actor.agentId),
      )).then((rows) => rows[0]);
      if (!run || run.status !== "running" || issue.executionRunId !== runId) {
        throw forbidden("Acknowledgement requires the currently running linked native issue run");
      }
      const context = run.contextSnapshot && typeof run.contextSnapshot === "object"
        ? run.contextSnapshot as Record<string, unknown>
        : {};
      if (
        delivery.successorRunId !== runId ||
        delivery.wakeupRequestId !== run.wakeupRequestId ||
        context.issueId !== delivery.issueId ||
        context.recordId !== recordId ||
        context.descriptionRevision !== descriptionRevision ||
        context.intentKey !== intentKey
      ) {
        throw forbidden("Acknowledgement run did not receive this description revision intent");
      }
      const wake = run.wakeupRequestId ? await tx.select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.id, run.wakeupRequestId),
        eq(agentWakeupRequests.agentId, actor.agentId),
      )).then((rows) => rows[0]) : null;
      if (!wake || wake.idempotencyKey !== intentKey) {
        throw forbidden("Acknowledgement wake did not carry this description revision intent");
      }
      if (delivery.state === "confirmed") {
        if (delivery.acknowledgedByAgentId !== actor.agentId) throw conflict("Description delivery was acknowledged by another agent");
        return descriptionDeliveryView(delivery);
      }
      if (delivery.state !== "queued") throw conflict("Description revision is not queued for model confirmation");
      const now = new Date();
      const [confirmed] = await tx.update(workRecordDescriptionDeliveries).set({
        state: "confirmed",
        modelVisibleAt: now,
        confirmedAt: now,
        deliveredAt: now,
        acknowledgedAt: now,
        acknowledgedByAgentId: actor.agentId,
        acknowledgedByRunId: runId,
        updatedAt: now,
      }).where(eq(workRecordDescriptionDeliveries.id, delivery.id)).returning();
      return descriptionDeliveryView(confirmed);
    });
  }

  async function fillAssignmentGap(
    companyId: string,
    projectId: string,
    recordId: string,
    input: FillWorkRecordAssignmentGap,
    actor: Actor,
  ) {
    if (!isWorkflowV2WritesEnabled(companyId, projectId)) {
      const rollout = currentRollout();
      throw forbidden("Work-record workflow v2 writes are disabled", {
        code: rollout.globalEnabled
          ? "work_record_workflow_v2_scope_denied"
          : "work_record_workflow_v2_disabled",
        workflowVersion: 2,
      });
    }
    if (input.recordId !== recordId) {
      throw unprocessable("Assignment command record does not match the route", {
        code: "work_record_assignment_target_invalid",
        workflowVersion: 2,
      });
    }

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workRecordLockKey(recordId)}, 0))`);

      const prior = await tx.select().from(workRecordAssignmentCommands).where(and(
        eq(workRecordAssignmentCommands.companyId, companyId),
        eq(workRecordAssignmentCommands.recordId, recordId),
        eq(workRecordAssignmentCommands.clientRequestId, input.clientRequestId),
      )).then((rows) => rows[0] ?? null);
      if (prior) {
        const replay = classifyWorkRecordCommandReplay(prior.requestPayloadDigest, input.requestPayloadDigest);
        if (replay.outcome === "conflict") {
          throw conflict("Client request key was already used with a different assignment command", {
            code: replay.code,
            workflowVersion: 2,
            commandId: prior.id,
          });
        }
        const record = await tx.select().from(workRecords).where(and(
          eq(workRecords.companyId, companyId),
          eq(workRecords.projectId, projectId),
          eq(workRecords.id, recordId),
        )).then((rows) => rows[0] ?? null);
        if (!record) throw notFound("Work record not found");
        return { command: prior, record, replayed: true };
      }

      const record = await tx.select().from(workRecords).where(and(
        eq(workRecords.companyId, companyId),
        eq(workRecords.projectId, projectId),
        eq(workRecords.id, recordId),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!record) throw notFound("Work record not found");
      if (record.revision !== input.expectedRecordRevision) {
        throw conflict("Work record revision changed", {
          code: "work_record_workflow_stale_revision",
          workflowVersion: 2,
          currentRevision: record.revision,
        });
      }
      if (record.assigneeAgentId !== input.expectedAssigneeAgentId) {
        throw conflict("Work record assignee changed", {
          code: "work_record_assignment_compare_failed",
          workflowVersion: 2,
          currentRevision: record.revision,
        });
      }

      if (actor.actorType === "agent") {
        const ceo = actor.agentId ? await tx.select({
          id: agents.id,
          role: agents.role,
          status: agents.status,
        }).from(agents).where(and(
          eq(agents.companyId, companyId),
          eq(agents.id, actor.agentId),
        )).then((rows) => rows[0] ?? null) : null;
        if (!ceo || ceo.role.trim().toLowerCase() !== "ceo" || !["active", "idle", "running"].includes(ceo.status)) {
          throw forbidden("Assignment command is restricted to the current available CEO or board", {
            code: "work_record_assignment_role_denied",
            workflowVersion: 2,
          });
        }
      } else if (actor.actorType !== "user") {
        throw forbidden("Assignment command is restricted to the current available CEO or board", {
          code: "work_record_assignment_role_denied",
          workflowVersion: 2,
        });
      }

      const assignee = await tx.select({ id: agents.id, status: agents.status }).from(agents).where(and(
        eq(agents.companyId, companyId),
        eq(agents.id, input.assigneeAgentId),
      )).then((rows) => rows[0] ?? null);
      if (!assignee || ["paused", "terminated", "pending_approval", "error"].includes(assignee.status)) {
        throw unprocessable("Assignee is not available in this company", {
          code: "work_record_assignment_target_invalid",
          workflowVersion: 2,
        });
      }

      if (input.expectedAssigneeAgentId !== null) {
        const approval = input.approvalId ? await tx.select().from(approvals).where(and(
          eq(approvals.companyId, companyId),
          eq(approvals.id, input.approvalId),
        )).then((rows) => rows[0] ?? null) : null;
        const payload = approval?.payload ?? {};
        const validApproval = approval?.type === "request_board_approval" &&
          approval.status === "approved" &&
          Boolean(approval.decidedByUserId) &&
          Boolean(approval.decidedAt) &&
          payload.action === "work_record.replace_assignee" &&
          payload.companyId === companyId &&
          payload.projectId === projectId &&
          payload.recordId === recordId &&
          payload.recordRevision === input.expectedRecordRevision &&
          payload.fromAssigneeAgentId === input.expectedAssigneeAgentId &&
          payload.toAssigneeAgentId === input.assigneeAgentId;
        if (!validApproval) {
          throw forbidden("Replacing an existing assignee requires a current board approval", {
            code: "work_record_assignment_approval_required",
            workflowVersion: 2,
          });
        }
      }

      const updated = await tx.update(workRecords).set({
        assigneeAgentId: input.assigneeAgentId,
        revision: record.revision + 1,
        updatedAt: new Date(),
      }).where(and(
        eq(workRecords.companyId, companyId),
        eq(workRecords.projectId, projectId),
        eq(workRecords.id, recordId),
        eq(workRecords.revision, record.revision),
      )).returning().then((rows) => rows[0] ?? null);
      if (!updated) {
        throw conflict("Work record revision changed", {
          code: "work_record_workflow_stale_revision",
          workflowVersion: 2,
        });
      }
      const command = await tx.insert(workRecordAssignmentCommands).values({
        companyId,
        projectId,
        recordId,
        clientRequestId: input.clientRequestId,
        requestPayloadDigest: input.requestPayloadDigest,
        expectedRecordRevision: input.expectedRecordRevision,
        expectedAssigneeAgentId: input.expectedAssigneeAgentId,
        assigneeAgentId: input.assigneeAgentId,
        approvalId: input.approvalId ?? null,
        previousRevision: record.revision,
        resultingRevision: updated.revision,
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.userId ?? null,
        actorRunId: actor.runId ?? null,
      }).returning().then((rows) => rows[0]);
      return { command, record: updated, replayed: false };
    });

    const hydrated = await hydrate(companyId, [result.record]).then((rows) => rows[0]);
    return { ...result, record: hydrated };
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
        : dependency.issueStatus === "cancelled"
          ? "prerequisite_cancelled_impact_pending"
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
      const missingFields = [
        ...(!record.assigneeAgentId ? [{ field: "assigneeAgentId", label: record.kind === "defect" ? "修复人" : "执行人" }] : []),
        ...(record.kind === "defect" && !record.qaAssigneeAgentId ? [{ field: "qaAssigneeAgentId", label: "QA" }] : []),
      ];
      if (missingFields.length > 0) {
        throw unprocessable(`派发前需补齐：${missingFields.map((item) => item.label).join("、")}`, {
          code: "work_record_dispatch_assignments_missing",
          missingFields,
        });
      }
      const round = record.dispatchRound + 1;
      const command = existingCommand ?? await tx.insert(workRecordDispatchCommands).values({
        companyId, projectId, recordId, clientRequestId: input.clientRequestId, recordRevision: record.revision, dispatchRound: round,
      }).returning().then((rows) => rows[0]);
      const createdIssue = await issuesSvc.create(companyId, {
        projectId, title: record.title, description: record.description, status: "todo", priority: record.priority,
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
    if (result.replayed) {
      const replayedRecord = await raw(companyId, projectId, recordId);
      if (isManagedDispatchState(replayedRecord.dispatchState)) await reconcileRecord(companyId, projectId, recordId);
    }
    const record = await raw(companyId, projectId, recordId).then((row) => hydrate(companyId, [row])).then((rows) => rows[0]);
    return { ...result, record };
  }

  async function reconcilePage(limit = 100, afterId: string | null = null) {
    const rows = await db.select({ companyId: workRecords.companyId, projectId: workRecords.projectId, id: workRecords.id })
      .from(workRecords)
      .where(and(
        inArray(workRecords.dispatchState, ["preparing", "blocked", "linked", "queued", "failed"]),
        afterId ? gt(workRecords.id, afterId) : undefined,
      ))
      .orderBy(asc(workRecords.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const candidates = hasMore ? rows.slice(0, limit) : rows;
    const settled = await reconcileCandidatesIndependently(candidates, (row) =>
      reconcileRecord(row.companyId, row.projectId, row.id));
    return {
      processed: candidates.length,
      succeeded: settled.succeeded,
      failures: settled.failures,
      nextAfterId: hasMore ? candidates.at(-1)?.id ?? null : null,
    };
  }

  async function reconcileAll(limit = 100) {
    return (await reconcilePage(limit)).processed;
  }

  async function processOutbox(wakeup: Wakeup, limit = 25) {
    const pending = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.workflowVersion, 1),
      or(eq(workRecordOutbox.state, "pending"), eq(workRecordOutbox.state, "retry"), eq(workRecordOutbox.state, "processing")),
      sql`${workRecordOutbox.availableAt} <= now()`,
    )).orderBy(asc(workRecordOutbox.createdAt)).limit(limit);
    let processed = 0;
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
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx.update(workRecordOutbox).set({
            state: "retry",
            lastError: message,
            attemptCount: event.attemptCount + 1,
            availableAt: new Date(Date.now() + 2_000),
            updatedAt: now,
          }).where(eq(workRecordOutbox.id, event.id));
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
    return processed;
  }

  async function assertNoSourceHoldStatusBypass(companyId: string, issueId: string, status?: string) {
    if (!status || !["in_progress", "done"].includes(status)) return;
    const hold = await db.select({ id: workRecordExecutionHolds.id, reason: workRecordExecutionHolds.reason }).from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.companyId, companyId), eq(workRecordExecutionHolds.dependentIssueId, issueId), isNull(workRecordExecutionHolds.resolvedAt),
    )).then((rows) => rows[0]);
    if (hold) throw conflict("Source prerequisites are not ready", { holdId: hold.id, reason: hold.reason });
  }

  return {
    listVersions,
    createVersion,
    updateVersion,
    archiveVersion: (companyId: string, projectId: string, versionId: string, expectedRevision: number) => setVersionArchived(companyId, projectId, versionId, expectedRevision, true),
    restoreVersion: (companyId: string, projectId: string, versionId: string, expectedRevision: number) => setVersionArchived(companyId, projectId, versionId, expectedRevision, false),
    deleteVersion,
    listIterations,
    createIteration,
    updateIteration,
    archiveIteration: (companyId: string, projectId: string, iterationId: string, expectedRevision: number) => setIterationArchived(companyId, projectId, iterationId, expectedRevision, true),
    restoreIteration: (companyId: string, projectId: string, iterationId: string, expectedRevision: number) => setIterationArchived(companyId, projectId, iterationId, expectedRevision, false),
    deleteIteration,
    list,
    listPage,
    adoptNativeIssues,
    adoptUnlinkedNativeIssuesPage,
    syncAdoptedNativeIssuesPage,
    create,
    update,
    mutateDependency,
    getDescriptionDelivery,
    deliverDescriptionRevision,
    acknowledgeDescriptionRevision,
    fillAssignmentGap,
    dispatch,
    getDispatchRequest,
    reconcileRecord,
    reconcileRecordView,
    recoverRecord,
    reconcileAll,
    reconcilePage,
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
