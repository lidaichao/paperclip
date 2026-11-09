import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentApiKeys } from "./agent_api_keys.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/** Short-lived authority for non-execution writes made outside a heartbeat run. */
export const agentSessionWriteGrants = pgTable("agent_session_write_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  keyId: uuid("key_id").notNull().references(() => agentApiKeys.id, { onDelete: "cascade" }),
  deviceId: text("device_id"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashUq: uniqueIndex("agent_session_write_grants_token_hash_uq").on(table.tokenHash),
  actorExpiryIdx: index("agent_session_write_grants_actor_expiry_idx")
    .on(table.companyId, table.agentId, table.keyId, table.expiresAt),
  tokenHashCheck: check("agent_session_write_grants_token_hash_check", sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
}));

/** Durable replay receipt for a session-authorized mutation. */
export const agentSessionWriteReceipts = pgTable("agent_session_write_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  keyId: uuid("key_id").notNull().references(() => agentApiKeys.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").notNull().references(() => agentSessionWriteGrants.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  requestDigest: text("request_digest").notNull(),
  statusCode: integer("status_code"),
  responseBody: jsonb("response_body").$type<unknown>(),
  processingLeaseExpiresAt: timestamp("processing_lease_expires_at", { withTimezone: true }).notNull().defaultNow(),
  recoveryCount: integer("recovery_count").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  actorKeyUq: uniqueIndex("agent_session_write_receipts_actor_key_uq")
    .on(table.companyId, table.agentId, table.keyId, table.idempotencyKey),
  pendingDigestUq: uniqueIndex("agent_session_write_receipts_pending_digest_uq")
    .on(table.companyId, table.agentId, table.keyId, table.requestDigest)
    .where(sql`${table.completedAt} is null`),
  grantIdx: index("agent_session_write_receipts_grant_idx").on(table.grantId, table.createdAt),
  digestCheck: check("agent_session_write_receipts_digest_check", sql`${table.requestDigest} ~ '^[a-f0-9]{64}$'`),
  statusCheck: check("agent_session_write_receipts_status_check", sql`${table.statusCode} is null or (${table.statusCode} >= 100 and ${table.statusCode} <= 599)`),
}));
