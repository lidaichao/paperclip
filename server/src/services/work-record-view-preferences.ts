import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projects, workRecordViewPreferences } from "@paperclipai/db";
import {
  defaultWorkRecordViewConfig,
  validateWorkRecordViewConfig,
  type WorkRecordViewConfig,
  type WorkRecordViewKind,
  type WorkRecordViewPreference,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

function view(row: typeof workRecordViewPreferences.$inferSelect): WorkRecordViewPreference {
  return {
    companyId: row.companyId,
    projectId: row.projectId,
    userId: row.userId,
    viewKind: row.viewKind,
    config: row.config,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

export function workRecordViewPreferenceService(db: Db) {
  async function assertProject(companyId: string, projectId: string) {
    const found = await db.select({ id: projects.id }).from(projects).where(and(
      eq(projects.companyId, companyId),
      eq(projects.id, projectId),
    )).then((rows) => rows[0]);
    if (!found) throw notFound("Project not found");
  }

  async function get(companyId: string, projectId: string, userId: string, viewKind: WorkRecordViewKind) {
    await assertProject(companyId, projectId);
    const row = await db.query.workRecordViewPreferences.findFirst({
      where: and(
        eq(workRecordViewPreferences.companyId, companyId),
        eq(workRecordViewPreferences.projectId, projectId),
        eq(workRecordViewPreferences.userId, userId),
        eq(workRecordViewPreferences.viewKind, viewKind),
      ),
    });
    if (row) return view(row);
    return {
      companyId,
      projectId,
      userId,
      viewKind,
      config: defaultWorkRecordViewConfig(viewKind),
      revision: 0,
      updatedAt: null,
    } satisfies WorkRecordViewPreference;
  }

  async function put(
    companyId: string,
    projectId: string,
    userId: string,
    viewKind: WorkRecordViewKind,
    expectedRevision: number,
    config: WorkRecordViewConfig,
  ) {
    await assertProject(companyId, projectId);
    try {
      validateWorkRecordViewConfig(viewKind, config);
    } catch (error) {
      throw unprocessable(error instanceof Error ? error.message : "Invalid view configuration");
    }
    const now = new Date();
    if (expectedRevision === 0) {
      const inserted = await db.insert(workRecordViewPreferences).values({
        companyId, projectId, userId, viewKind, config, revision: 1, updatedAt: now,
      }).onConflictDoNothing().returning();
      if (inserted[0]) return view(inserted[0]);
    } else {
      const updated = await db.update(workRecordViewPreferences).set({
        config,
        revision: expectedRevision + 1,
        updatedAt: now,
      }).where(and(
        eq(workRecordViewPreferences.companyId, companyId),
        eq(workRecordViewPreferences.projectId, projectId),
        eq(workRecordViewPreferences.userId, userId),
        eq(workRecordViewPreferences.viewKind, viewKind),
        eq(workRecordViewPreferences.revision, expectedRevision),
      )).returning();
      if (updated[0]) return view(updated[0]);
    }
    const current = await get(companyId, projectId, userId, viewKind);
    throw conflict("Work-record view preference changed", { currentRevision: current.revision });
  }

  return { get, put };
}
