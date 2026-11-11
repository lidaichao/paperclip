import { and, asc, desc, eq, gt, ilike, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, projects, workRecords, workRecordExecutionProjections, workRecordUserResponsibilities } from "@paperclipai/db";
import { workRecordIdentifier, type WorkRecordBusinessStatus, type WorkRecordKind, type WorkRecordMyTodo, type WorkRecordUserRole } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type Filter = {
  kind?: WorkRecordKind;
  status?: WorkRecordBusinessStatus | "all";
  projectId?: string;
  limit?: number;
  cursor?: string;
  q?: string;
  dueBefore?: string;
  sort?: "updated" | "due";
};

type Cursor = { updatedAt: string; id: string; sort: "updated" | "due"; dueKey?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

function readCursor(encoded: string | undefined, sort: "updated" | "due"): Cursor | null {
  if (!encoded) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Cursor;
    if (!value || !UUID.test(value.id) || !Number.isFinite(Date.parse(value.updatedAt)) || value.sort !== sort
      || (sort === "due" && (!value.dueKey || !DATE.test(value.dueKey)))) throw new Error("invalid cursor");
    return value;
  } catch {
    throw unprocessable("Invalid my-todos cursor");
  }
}

export function workRecordMyTodoService(db: Db) {
  return {
    async list(companyId: string, userId: string, filter: Filter = {}): Promise<{ items: WorkRecordMyTodo[]; nextCursor: string | null }> {
      const limit = filter.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw unprocessable("limit must be an integer from 1 to 100");
      const sort = filter.sort ?? "updated";
      const cursor = readCursor(filter.cursor, sort);
      const dueKey = sql<string>`coalesce(${workRecords.plannedCompletionDate}, '9999-12-31'::date)`;
      const assignedRecordIds = db.select({ recordId: workRecordUserResponsibilities.recordId })
        .from(workRecordUserResponsibilities).where(and(
          eq(workRecordUserResponsibilities.companyId, companyId),
          eq(workRecordUserResponsibilities.userId, userId),
        ));
      const rows = await db.select({
        id: workRecords.id,
        recordNumber: workRecords.recordNumber,
        companyId: workRecords.companyId,
        projectId: workRecords.projectId,
        projectName: projects.name,
        kind: workRecords.kind,
        title: workRecords.title,
        priority: workRecords.priority,
        businessStatus: workRecords.businessStatus,
        plannedCompletionDate: workRecords.plannedCompletionDate,
        updatedAt: workRecords.updatedAt,
      }).from(workRecords).innerJoin(projects, and(
        eq(projects.id, workRecords.projectId), eq(projects.companyId, companyId),
      )).where(and(
        eq(workRecords.companyId, companyId),
        inArray(workRecords.id, assignedRecordIds),
        filter.kind ? eq(workRecords.kind, filter.kind) : undefined,
        filter.projectId ? eq(workRecords.projectId, filter.projectId) : undefined,
        filter.q?.trim() ? ilike(workRecords.title, `%${escapeLike(filter.q.trim())}%`) : undefined,
        filter.dueBefore ? lte(workRecords.plannedCompletionDate, filter.dueBefore) : undefined,
        filter.status === "all" ? undefined : filter.status
          ? eq(workRecords.businessStatus, filter.status)
          : notInArray(workRecords.businessStatus, ["done", "cancelled"]),
        cursor ? sort === "due" ? or(
          gt(dueKey, cursor.dueKey!),
          and(eq(dueKey, cursor.dueKey!), lt(workRecords.updatedAt, new Date(cursor.updatedAt))),
          and(eq(dueKey, cursor.dueKey!), eq(workRecords.updatedAt, new Date(cursor.updatedAt)), lt(workRecords.id, cursor.id)),
        ) : or(
          lt(workRecords.updatedAt, new Date(cursor.updatedAt)),
          and(eq(workRecords.updatedAt, new Date(cursor.updatedAt)), lt(workRecords.id, cursor.id)),
        ) : undefined,
      )).orderBy(...(sort === "due" ? [asc(dueKey), desc(workRecords.updatedAt), desc(workRecords.id)] : [desc(workRecords.updatedAt), desc(workRecords.id)])).limit(limit + 1);
      const page = rows.slice(0, limit);
      if (!page.length) return { items: [], nextCursor: null };
      const ids = page.map((row) => row.id);
      const [assignments, projections] = await Promise.all([
        db.select({ recordId: workRecordUserResponsibilities.recordId, role: workRecordUserResponsibilities.role })
          .from(workRecordUserResponsibilities).where(and(
            eq(workRecordUserResponsibilities.companyId, companyId),
            eq(workRecordUserResponsibilities.userId, userId),
            inArray(workRecordUserResponsibilities.recordId, ids),
          )),
        db.select({
          recordId: workRecordExecutionProjections.recordId,
          syncState: workRecordExecutionProjections.syncState,
          runStatus: heartbeatRuns.status,
          runFinishedAt: heartbeatRuns.finishedAt,
        }).from(workRecordExecutionProjections)
          .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, workRecordExecutionProjections.lastRunId))
          .where(and(eq(workRecordExecutionProjections.companyId, companyId), inArray(workRecordExecutionProjections.recordId, ids))),
      ]);
      const rolesById = new Map<string, WorkRecordUserRole[]>();
      for (const assignment of assignments) rolesById.set(assignment.recordId, [...(rolesById.get(assignment.recordId) ?? []), assignment.role]);
      const projectionById = new Map(projections.map((projection) => [projection.recordId, projection]));
      const items: WorkRecordMyTodo[] = page.map((row) => {
        const projection = projectionById.get(row.id);
        const executionState = !projection ? "idle" as const
          : projection.syncState !== "current" ? "unknown" as const
            : !projection.runFinishedAt && ["claimed", "running"].includes(projection.runStatus ?? "")
              ? "active" as const : "idle" as const;
        return {
          ...row,
          recordIdentifier: workRecordIdentifier(row.kind as WorkRecordKind, row.recordNumber),
          kind: row.kind as WorkRecordKind,
          businessStatus: row.businessStatus as WorkRecordBusinessStatus,
          roles: (rolesById.get(row.id) ?? []).sort((a, b) => ["execution", "qa", "po"].indexOf(a) - ["execution", "qa", "po"].indexOf(b)),
          executionState,
        };
      });
      const last = page.at(-1)!;
      return {
        items,
        nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({
          updatedAt: last.updatedAt.toISOString(), id: last.id, sort,
          ...(sort === "due" ? { dueKey: last.plannedCompletionDate ?? "9999-12-31" } : {}),
        })).toString("base64url") : null,
      };
    },
  };
}
