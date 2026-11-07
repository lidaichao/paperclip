import { check, index, pgTable, text, timestamp, uniqueIndex, uuid, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { workRecords, workRecordQualityCycles, workRecordQualityItems } from "./work_records.js";

/** A repair handoff prepared by the lease owner and committed only after process stop. */
export const localDefectRepairHandoffs = pgTable("local_defect_repair_handoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
  cycleId: uuid("cycle_id").notNull().references(() => workRecordQualityCycles.id, { onDelete: "cascade" }),
  repairItemId: uuid("repair_item_id").notNull().references(() => workRecordQualityItems.id, { onDelete: "cascade" }),
  qaItemId: uuid("qa_item_id").notNull().references(() => workRecordQualityItems.id, { onDelete: "cascade" }),
  qaAgentId: uuid("qa_agent_id").notNull().references(() => agents.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  clientRequestId: uuid("client_request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  preparedStatusVersion: bigint("prepared_status_version", { mode: "number" }).notNull(),
  preparedCycleRevision: bigint("prepared_cycle_revision", { mode: "number" }).notNull(),
  submittedStatusVersion: bigint("submitted_status_version", { mode: "number" }),
  qaWakeupRequestId: uuid("qa_wakeup_request_id").references(() => agentWakeupRequests.id),
  qaDeliveredAt: timestamp("qa_delivered_at", { withTimezone: true }),
  state: text("state").$type<"prepared" | "submitted" | "aborted">().notNull().default("prepared"),
  commentId: uuid("comment_id").notNull().references(() => issueComments.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runUq: uniqueIndex("local_defect_repair_handoffs_run_uq").on(table.companyId, table.runId),
  requestUq: uniqueIndex("local_defect_repair_handoffs_request_uq")
    .on(table.companyId, table.runId, table.clientRequestId),
  recordIdx: index("local_defect_repair_handoffs_record_idx")
    .on(table.companyId, table.recordId, table.createdAt),
  qaWakeupUq: uniqueIndex("local_defect_repair_handoffs_qa_wakeup_uq")
    .on(table.qaWakeupRequestId).where(sql`${table.qaWakeupRequestId} IS NOT NULL`),
  qaDeliveryCheck: check("local_defect_repair_handoffs_qa_delivery_check", sql`
    (${table.qaWakeupRequestId} IS NULL AND ${table.qaDeliveredAt} IS NULL) OR
    (${table.state} = 'submitted' AND ${table.qaWakeupRequestId} IS NOT NULL AND ${table.qaDeliveredAt} IS NOT NULL)`),
  stateCheck: check("local_defect_repair_handoffs_state_check", sql`
    (${table.state} = 'prepared' AND ${table.submittedStatusVersion} IS NULL) OR
    (${table.state} = 'submitted' AND ${table.submittedStatusVersion} IS NOT NULL) OR
    (${table.state} = 'aborted' AND ${table.submittedStatusVersion} IS NULL)`),
}));
