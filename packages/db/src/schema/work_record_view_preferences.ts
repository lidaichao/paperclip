import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { WorkRecordViewConfig, WorkRecordViewKind } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const workRecordViewPreferences = pgTable(
  "work_record_view_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    viewKind: text("view_kind").$type<WorkRecordViewKind>().notNull(),
    config: jsonb("config").$type<WorkRecordViewConfig>().notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectScopeFk: foreignKey({
      columns: [table.companyId, table.projectId],
      foreignColumns: [projects.companyId, projects.id],
      name: "work_record_view_preferences_project_scope_fk",
    }).onDelete("cascade"),
    scopeUq: uniqueIndex("work_record_view_preferences_scope_uq").on(
      table.companyId,
      table.projectId,
      table.userId,
      table.viewKind,
    ),
    userProjectIdx: index("work_record_view_preferences_user_project_idx").on(table.userId, table.projectId),
    viewKindCheck: check("work_record_view_preferences_view_kind_check", sql`${table.viewKind} IN ('plan', 'defect')`),
    revisionCheck: check("work_record_view_preferences_revision_check", sql`${table.revision} > 0`),
  }),
);
