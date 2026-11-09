import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { MyTodoViewConfig } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const companyUserMyTodoPreferences = pgTable("company_user_my_todo_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  config: jsonb("config").$type<MyTodoViewConfig>().notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyUserUq: uniqueIndex("company_user_my_todo_preferences_scope_uq").on(table.companyId, table.userId),
  userIdx: index("company_user_my_todo_preferences_user_idx").on(table.userId),
  revisionCheck: check("company_user_my_todo_preferences_revision_check", sql`${table.revision} > 0`),
}));
