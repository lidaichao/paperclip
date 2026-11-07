import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

/** Append-only proof of the exact client intent committed by a local command. */
export const localRunWriteReceipts = pgTable("local_run_write_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  deviceId: text("device_id").notNull(),
  clientRequestId: uuid("client_request_id").notNull(),
  kind: text("kind").notNull(),
  requestDigest: text("request_digest").notNull(),
  sourceReceiptId: uuid("source_receipt_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  requestUq: uniqueIndex("local_run_write_receipts_request_uq")
    .on(table.companyId, table.runId, table.clientRequestId),
  kindCheck: check("local_run_write_receipts_kind_check", sql`${table.kind} in (
    'child_complete', 'defect_repair_handoff', 'po_verdict',
    'defect_qa_verdict', 'completion_review_handoff')`),
  digestCheck: check("local_run_write_receipts_digest_check",
    sql`${table.requestDigest} ~ '^[a-f0-9]{64}$'`),
}));
