import { pgTable, uuid, text, bigint, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";

/** Immutable receipt for one lease-owned child work-record completion. */
export const localIssueCompletionCommands = pgTable("local_issue_completion_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  recordId: uuid("record_id").notNull(),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  clientRequestId: uuid("client_request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  preparedStatusVersion: bigint("prepared_status_version", { mode: "number" }).notNull(),
  completedStatusVersion: bigint("completed_status_version", { mode: "number" }),
  state: text("state").notNull().default("prepared"),
  commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  requestUq: uniqueIndex("local_issue_completion_commands_request_uq")
    .on(table.companyId, table.runId, table.clientRequestId),
  issueRunUq: uniqueIndex("local_issue_completion_commands_issue_run_uq")
    .on(table.companyId, table.issueId, table.runId),
  stateCheck: check("local_issue_completion_commands_state_check", sql`
    (${table.state} = 'prepared' AND ${table.completedStatusVersion} IS NULL) OR
    (${table.state} = 'completed' AND ${table.completedStatusVersion} IS NOT NULL) OR
    (${table.state} = 'aborted' AND ${table.completedStatusVersion} IS NULL)`),
}));
