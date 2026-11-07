import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { RecordQaQualityVerdict } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { localDefectRepairHandoffs } from "./local_defect_repair_handoffs.js";
import { workRecords, workRecordQualityCycles, workRecordQualityItems,
  workRecordQualityVerdicts } from "./work_records.js";

/** Immutable leased QA decision, applied only by the stopped-run finish transaction. */
export const localDefectQaVerdictCommands = pgTable("local_defect_qa_verdict_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
  cycleId: uuid("cycle_id").notNull().references(() => workRecordQualityCycles.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => workRecordQualityItems.id, { onDelete: "cascade" }),
  handoffId: uuid("handoff_id").notNull().references(() => localDefectRepairHandoffs.id, { onDelete: "cascade" }),
  qaAgentId: uuid("qa_agent_id").notNull().references(() => agents.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  clientRequestId: uuid("client_request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  payload: jsonb("payload").$type<RecordQaQualityVerdict>().notNull(),
  preparedStatusVersion: bigint("prepared_status_version", { mode: "number" }).notNull(),
  preparedCycleRevision: bigint("prepared_cycle_revision", { mode: "number" }).notNull(),
  preparedItemRevision: bigint("prepared_item_revision", { mode: "number" }).notNull(),
  state: text("state").$type<"prepared" | "committed" | "aborted">().notNull().default("prepared"),
  verdictId: uuid("verdict_id").references(() => workRecordQualityVerdicts.id, { onDelete: "set null" }),
  escalated: boolean("escalated").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
}, (table) => ({
  runUq: uniqueIndex("local_defect_qa_verdict_commands_run_uq").on(table.companyId, table.runId),
  requestUq: uniqueIndex("local_defect_qa_verdict_commands_request_uq")
    .on(table.companyId, table.clientRequestId),
  handoffIdx: index("local_defect_qa_verdict_commands_handoff_idx")
    .on(table.companyId, table.handoffId, table.createdAt),
  stateCheck: check("local_defect_qa_verdict_commands_state_check", sql`
    (${table.state} = 'prepared' AND ${table.verdictId} IS NULL AND ${table.committedAt} IS NULL) OR
    (${table.state} = 'committed' AND ${table.verdictId} IS NOT NULL AND ${table.committedAt} IS NOT NULL) OR
    (${table.state} = 'aborted' AND ${table.verdictId} IS NULL AND ${table.committedAt} IS NULL)`),
  escalationCheck: check("local_defect_qa_verdict_commands_escalation_check", sql`
    NOT ${table.escalated} OR ${table.state} = 'committed'`),
}));
