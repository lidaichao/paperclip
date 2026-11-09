import { and, eq, sql } from "drizzle-orm";
import { companyUserMyTodoPreferences, projects, type Db } from "@paperclipai/db";
import { DEFAULT_MY_TODO_VIEW_CONFIG, type MyTodoViewConfig, type MyTodoViewPreference } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";

export function myTodoPreferenceService(db: Db) {
  return {
    async get(companyId: string, userId: string): Promise<MyTodoViewPreference> {
      const row = await db.query.companyUserMyTodoPreferences.findFirst({
        where: and(eq(companyUserMyTodoPreferences.companyId, companyId), eq(companyUserMyTodoPreferences.userId, userId)),
      });
      return row
        ? { config: row.config, revision: row.revision, updatedAt: row.updatedAt }
        : { config: DEFAULT_MY_TODO_VIEW_CONFIG, revision: 0, updatedAt: null };
    },
    async put(companyId: string, userId: string, expectedRevision: number, config: MyTodoViewConfig): Promise<MyTodoViewPreference> {
      if (config.defaultProjectId) {
        const project = await db.query.projects.findFirst({
          where: and(eq(projects.companyId, companyId), eq(projects.id, config.defaultProjectId)),
          columns: { id: true },
        });
        if (!project) throw unprocessable("默认项目不属于当前公司");
      }
      const now = new Date();
      if (expectedRevision === 0) {
        const [row] = await db.insert(companyUserMyTodoPreferences).values({ companyId, userId, config, updatedAt: now })
          .onConflictDoNothing({ target: [companyUserMyTodoPreferences.companyId, companyUserMyTodoPreferences.userId] }).returning();
        if (!row) throw conflict("个人待办视图已变化，请刷新后重试");
        return { config: row.config, revision: row.revision, updatedAt: row.updatedAt };
      }
      const [row] = await db.update(companyUserMyTodoPreferences).set({
        config, revision: sql`${companyUserMyTodoPreferences.revision} + 1`, updatedAt: now,
      }).where(and(
        eq(companyUserMyTodoPreferences.companyId, companyId),
        eq(companyUserMyTodoPreferences.userId, userId),
        eq(companyUserMyTodoPreferences.revision, expectedRevision),
      )).returning();
      if (!row) throw conflict("个人待办视图已变化，请刷新后重试");
      return { config: row.config, revision: row.revision, updatedAt: row.updatedAt };
    },
  };
}
