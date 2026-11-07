import { check, index, pgTable, text, timestamp, uniqueIndex, uuid, bigint, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { RecordPoQualityVerdict } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { workRecords, workRecordQualityVerdicts } from "./work_records.js";

/** A PO decision prepared by the leased local process, committed only after it stops. */
export const localPoVerdictCommands = pgTable("local_po_verdict_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  clientRequestId: uuid("client_request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  payload: jsonb("payload").$type<RecordPoQualityVerdict>().notNull(),
  preparedStatusVersion: bigint("prepared_status_version", { mode: "number" }).notNull(),
  state: text("state").$type<"prepared" | "committed" | "aborted">().notNull().default("prepared"),
  verdictId: uuid("verdict_id").references(() => workRecordQualityVerdicts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
}, (table) => ({
  requestUq: uniqueIndex("local_po_verdict_commands_request_uq")
    .on(table.companyId, table.runId, table.clientRequestId),
  runUq: uniqueIndex("local_po_verdict_commands_run_uq")
    .on(table.companyId, table.runId),
  recordIdx: index("local_po_verdict_commands_record_idx")
    .on(table.companyId, table.recordId, table.createdAt),
  stateCheck: check("local_po_verdict_commands_state_check", sql`
    (${table.state} = 'prepared' AND ${table.verdictId} IS NULL AND ${table.committedAt} IS NULL) OR
    (${table.state} = 'committed' AND ${table.verdictId} IS NOT NULL AND ${table.committedAt} IS NOT NULL) OR
    (${table.state} = 'aborted' AND ${table.verdictId} IS NULL AND ${table.committedAt} IS NULL)`),
}));
