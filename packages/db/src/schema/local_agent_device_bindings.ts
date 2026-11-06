import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** A credential-to-device approval; IDs survive agent/key hard deletion for audit. */
export const localAgentDeviceBindings = pgTable("local_agent_device_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull(),
  keyId: uuid("key_id").notNull(),
  deviceId: text("device_id").notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: text("revoked_by_user_id"),
}, (table) => ({
  keyUq: uniqueIndex("local_agent_device_bindings_key_uq").on(table.keyId),
  activeDeviceUq: uniqueIndex("local_agent_device_bindings_active_device_uq")
    .on(table.companyId, table.agentId, table.deviceId)
    .where(sql`${table.revokedAt} is null`),
  agentIdx: index("local_agent_device_bindings_agent_idx").on(table.companyId, table.agentId),
}));
