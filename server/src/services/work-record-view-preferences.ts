import { and, asc, eq } from "drizzle-orm";
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
import { isUniqueViolation } from "../db-errors.js";

const LEGACY_VIEW_NAME = "个人视图";

type LegacyViewConfig = Partial<WorkRecordViewConfig> & {
  schemaVersion?: number;
};

function normalizeConfig(viewKind: WorkRecordViewKind, config: LegacyViewConfig): WorkRecordViewConfig {
  const defaults = defaultWorkRecordViewConfig(viewKind);
  if (config.schemaVersion === 2) return config as WorkRecordViewConfig;
  return {
    ...defaults,
    visibleFields: ["id", ...((config.visibleFields ?? defaults.visibleFields).filter((field) => field !== "id"))],
    columnOrder: ["id", ...((config.columnOrder ?? defaults.columnOrder).filter((field) => field !== "id"))],
    columnWidths: config.columnWidths ?? defaults.columnWidths,
    density: config.density ?? defaults.density,
  };
}

function view(row: typeof workRecordViewPreferences.$inferSelect): WorkRecordViewPreference {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    userId: row.userId,
    viewKind: row.viewKind,
    name: row.name,
    isBuiltin: false,
    config: normalizeConfig(row.viewKind, row.config as LegacyViewConfig),
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
        eq(workRecordViewPreferences.name, LEGACY_VIEW_NAME),
      ),
    });
    if (row) return view(row);
    return {
      companyId,
      projectId,
      userId,
      viewKind,
      id: `builtin:${viewKind}`,
      name: viewKind === "plan" ? "全部计划" : "全部缺陷",
      isBuiltin: true,
      config: defaultWorkRecordViewConfig(viewKind),
      revision: 0,
      updatedAt: null,
    } satisfies WorkRecordViewPreference;
  }

  async function list(companyId: string, projectId: string, userId: string, viewKind: WorkRecordViewKind) {
    await assertProject(companyId, projectId);
    const rows = await db.select().from(workRecordViewPreferences).where(and(
      eq(workRecordViewPreferences.companyId, companyId),
      eq(workRecordViewPreferences.projectId, projectId),
      eq(workRecordViewPreferences.userId, userId),
      eq(workRecordViewPreferences.viewKind, viewKind),
    )).orderBy(asc(workRecordViewPreferences.name));
    return [{
      id: `builtin:${viewKind}`,
      companyId,
      projectId,
      userId,
      viewKind,
      name: viewKind === "plan" ? "全部计划" : "全部缺陷",
      isBuiltin: true,
      config: defaultWorkRecordViewConfig(viewKind),
      revision: 0,
      updatedAt: null,
    } satisfies WorkRecordViewPreference, ...rows.map(view)];
  }

  async function create(companyId: string, projectId: string, userId: string, viewKind: WorkRecordViewKind, name: string, config: WorkRecordViewConfig) {
    await assertProject(companyId, projectId);
    validateWorkRecordViewConfig(viewKind, config);
    try {
      const row = await db.insert(workRecordViewPreferences).values({
        companyId, projectId, userId, viewKind, name: name.trim(), config, revision: 1,
      }).returning().then((rows) => rows[0]);
      return view(row);
    } catch (error) {
      if (isUniqueViolation(error, "work_record_view_preferences_scope_uq")) throw conflict("View name already exists");
      throw error;
    }
  }

  async function update(companyId: string, projectId: string, userId: string, viewKind: WorkRecordViewKind, id: string, expectedRevision: number, input: { name?: string; config?: WorkRecordViewConfig }) {
    await assertProject(companyId, projectId);
    if (input.config) validateWorkRecordViewConfig(viewKind, input.config);
    try {
      const row = await db.update(workRecordViewPreferences).set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}),
        revision: expectedRevision + 1,
        updatedAt: new Date(),
      }).where(and(
        eq(workRecordViewPreferences.id, id),
        eq(workRecordViewPreferences.companyId, companyId),
        eq(workRecordViewPreferences.projectId, projectId),
        eq(workRecordViewPreferences.userId, userId),
        eq(workRecordViewPreferences.viewKind, viewKind),
        eq(workRecordViewPreferences.revision, expectedRevision),
      )).returning().then((rows) => rows[0]);
      if (row) return view(row);
    } catch (error) {
      if (isUniqueViolation(error, "work_record_view_preferences_scope_uq")) throw conflict("View name already exists");
      throw error;
    }
    const exists = await db.query.workRecordViewPreferences.findFirst({ where: and(
      eq(workRecordViewPreferences.id, id), eq(workRecordViewPreferences.companyId, companyId),
      eq(workRecordViewPreferences.projectId, projectId), eq(workRecordViewPreferences.userId, userId),
      eq(workRecordViewPreferences.viewKind, viewKind),
    ) });
    if (!exists) throw notFound("View not found");
    throw conflict("Work-record view changed", { currentRevision: exists.revision });
  }

  async function remove(companyId: string, projectId: string, userId: string, viewKind: WorkRecordViewKind, id: string, expectedRevision: number) {
    await assertProject(companyId, projectId);
    if (id.startsWith("builtin:")) throw unprocessable("Built-in views cannot be deleted");
    const row = await db.delete(workRecordViewPreferences).where(and(
      eq(workRecordViewPreferences.id, id), eq(workRecordViewPreferences.companyId, companyId),
      eq(workRecordViewPreferences.projectId, projectId), eq(workRecordViewPreferences.userId, userId),
      eq(workRecordViewPreferences.viewKind, viewKind), eq(workRecordViewPreferences.revision, expectedRevision),
    )).returning().then((rows) => rows[0]);
    if (row) return { id, deleted: true as const };
    const exists = await db.query.workRecordViewPreferences.findFirst({ where: and(
      eq(workRecordViewPreferences.id, id), eq(workRecordViewPreferences.companyId, companyId),
      eq(workRecordViewPreferences.projectId, projectId), eq(workRecordViewPreferences.userId, userId),
      eq(workRecordViewPreferences.viewKind, viewKind),
    ) });
    if (!exists) return { id, deleted: true as const, replayed: true as const };
    if (exists.revision === expectedRevision) return { id, deleted: true as const, replayed: true as const };
    throw conflict("Work-record view changed", { currentRevision: exists.revision });
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
        companyId, projectId, userId, viewKind, name: LEGACY_VIEW_NAME, config, revision: 1, updatedAt: now,
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
        eq(workRecordViewPreferences.name, LEGACY_VIEW_NAME),
        eq(workRecordViewPreferences.revision, expectedRevision),
      )).returning();
      if (updated[0]) return view(updated[0]);
    }
    const current = await get(companyId, projectId, userId, viewKind);
    throw conflict("Work-record view preference changed", { currentRevision: current.revision });
  }

  return { get, list, create, update, remove, put };
}
