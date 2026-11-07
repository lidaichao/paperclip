import { check, pgTable, text, timestamp, uniqueIndex, uuid, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** One immutable finish acknowledgement for a local run, including legacy no-request finishes. */
export const localRunFinishReceipts = pgTable("local_run_finish_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  // Like the historical lease, retain the issue identity when its task is deleted.
  issueId: uuid("issue_id").notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),
  leaseId: uuid("lease_id").notNull(),
  generation: integer("generation").notNull(),
  clientRequestId: uuid("client_request_id"),
  requestDigest: text("request_digest"),
  outcome: text("outcome").notNull(),
  exitCode: integer("exit_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runUq: uniqueIndex("local_run_finish_receipts_run_uq").on(table.companyId, table.runId),
  requestPairCheck: check("local_run_finish_receipts_request_pair_check", sql`
    (${table.clientRequestId} IS NULL AND ${table.requestDigest} IS NULL) OR
    (${table.clientRequestId} IS NOT NULL AND ${table.requestDigest} ~ '^[a-f0-9]{64}$')`),
  outcomeCheck: check("local_run_finish_receipts_outcome_check",
    sql`${table.outcome} IN ('succeeded','failed','cancelled')`),
}));
