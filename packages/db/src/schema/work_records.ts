import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const projectVersions = pgTable(
  "project_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetDate: date("target_date"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectScopeFk: foreignKey({
      columns: [table.companyId, table.projectId],
      foreignColumns: [projects.companyId, projects.id],
      name: "project_versions_project_scope_fk",
    }).onDelete("cascade"),
    companyProjectIdUq: unique("project_versions_company_project_id_uq").on(table.companyId, table.projectId, table.id),
    projectNameUq: uniqueIndex("project_versions_project_name_uq").on(table.companyId, table.projectId, table.name),
    companyProjectIdx: index("project_versions_company_project_idx").on(table.companyId, table.projectId),
  }),
);

export const projectIterations = pgTable(
  "project_iterations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").references(() => projectVersions.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdUq: unique("project_iterations_company_project_id_uq").on(table.companyId, table.projectId, table.id),
    projectScopeFk: foreignKey({
      columns: [table.companyId, table.projectId],
      foreignColumns: [projects.companyId, projects.id],
      name: "project_iterations_project_scope_fk",
    }).onDelete("cascade"),
    versionScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.versionId],
      foreignColumns: [projectVersions.companyId, projectVersions.projectId, projectVersions.id],
      name: "project_iterations_version_scope_fk",
    }),
    projectNameUq: uniqueIndex("project_iterations_project_name_uq").on(table.companyId, table.projectId, table.name),
    companyProjectIdx: index("project_iterations_company_project_idx").on(table.companyId, table.projectId),
  }),
);

export const workRecords = pgTable(
  "work_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    parentRecordId: uuid("parent_record_id"),
    iterationId: uuid("iteration_id").references(() => projectIterations.id, { onDelete: "set null" }),
    kind: text("kind").$type<"plan" | "defect">().notNull(),
    title: text("title").notNull(),
    description: text("description"),
    descriptionRevision: integer("description_revision").notNull().default(1),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    businessStatus: text("business_status").notNull().default("backlog"),
    statusVersion: bigint("status_version", { mode: "number" }).notNull().default(0),
    revision: integer("revision").notNull().default(1),
    dispatchState: text("dispatch_state").notNull().default("not_dispatched"),
    dispatchRound: integer("dispatch_round").notNull().default(0),
    dependencySetRevision: integer("dependency_set_revision").notNull().default(1),
    blockedCycle: integer("blocked_cycle").notNull().default(0),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdUq: unique("work_records_company_project_id_uq").on(table.companyId, table.projectId, table.id),
    projectScopeFk: foreignKey({
      columns: [table.companyId, table.projectId],
      foreignColumns: [projects.companyId, projects.id],
      name: "work_records_project_scope_fk",
    }).onDelete("cascade"),
    iterationScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.iterationId],
      foreignColumns: [projectIterations.companyId, projectIterations.projectId, projectIterations.id],
      name: "work_records_iteration_scope_fk",
    }),
    assigneeScopeFk: foreignKey({
      columns: [table.companyId, table.assigneeAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "work_records_assignee_scope_fk",
    }),
    parentScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.parentRecordId],
      foreignColumns: [table.companyId, table.projectId, table.id],
      name: "work_records_parent_scope_fk",
    }),
    companyProjectIdx: index("work_records_company_project_idx").on(table.companyId, table.projectId, table.createdAt),
    parentCheck: check("work_records_parent_not_self", sql`${table.parentRecordId} IS NULL OR ${table.parentRecordId} <> ${table.id}`),
  }),
);

export const workRecordDependencies = pgTable(
  "work_record_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    predecessorRecordId: uuid("predecessor_record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    successorRecordId: uuid("successor_record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    predecessorScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.predecessorRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_dependencies_predecessor_scope_fk",
    }).onDelete("cascade"),
    successorScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.successorRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_dependencies_successor_scope_fk",
    }).onDelete("cascade"),
    edgeUq: uniqueIndex("work_record_dependencies_edge_uq").on(table.companyId, table.projectId, table.predecessorRecordId, table.successorRecordId),
    successorIdx: index("work_record_dependencies_successor_idx").on(table.companyId, table.successorRecordId),
    noSelf: check("work_record_dependencies_not_self", sql`${table.predecessorRecordId} <> ${table.successorRecordId}`),
  }),
);

export const workRecordDispatchCommands = pgTable(
  "work_record_dispatch_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    clientRequestId: text("client_request_id").notNull(),
    recordRevision: integer("record_revision").notNull(),
    dispatchRound: integer("dispatch_round").notNull(),
    state: text("state").notNull().default("preparing"),
    issueLinkId: uuid("issue_link_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    recordScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.recordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_dispatch_commands_record_scope_fk",
    }).onDelete("cascade"),
    requestUq: uniqueIndex("work_record_dispatch_commands_request_uq").on(table.companyId, table.recordId, table.clientRequestId),
  }),
);

export const workRecordIssueLinks = pgTable(
  "work_record_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull().default("primary"),
    dispatchRound: integer("dispatch_round").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    recordScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.recordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_issue_links_record_scope_fk",
    }).onDelete("cascade"),
    issueScopeFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "work_record_issue_links_issue_scope_fk",
    }).onDelete("cascade"),
    recordPurposeUq: uniqueIndex("work_record_issue_links_record_purpose_uq").on(table.companyId, table.recordId, table.purpose),
    primaryIssueUq: uniqueIndex("work_record_issue_links_primary_issue_uq")
      .on(table.companyId, table.issueId)
      .where(sql`${table.purpose} = 'primary'`),
    issuePurposeIdx: index("work_record_issue_links_issue_purpose_idx").on(table.companyId, table.issueId, table.purpose),
  }),
);

export const workRecordExecutionHolds = pgTable(
  "work_record_execution_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    dependentRecordId: uuid("dependent_record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    dependentIssueId: uuid("dependent_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    blockingRecordId: uuid("blocking_record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    dispatchRound: integer("dispatch_round").notNull(),
    dependencySetRevision: integer("dependency_set_revision").notNull(),
    blockedCycle: integer("blocked_cycle").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dependentScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.dependentRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_execution_holds_dependent_scope_fk",
    }).onDelete("cascade"),
    blockingScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.blockingRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_execution_holds_blocking_scope_fk",
    }).onDelete("cascade"),
    issueScopeFk: foreignKey({
      columns: [table.companyId, table.dependentIssueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "work_record_execution_holds_issue_scope_fk",
    }).onDelete("cascade"),
    holdUq: uniqueIndex("work_record_execution_holds_uq").on(table.companyId, table.dependentRecordId, table.blockingRecordId, table.dispatchRound, table.dependencySetRevision, table.blockedCycle),
    issueUnresolvedIdx: index("work_record_execution_holds_issue_unresolved_idx").on(table.companyId, table.dependentIssueId, table.resolvedAt),
  }),
);

export const workRecordOutbox = pgTable(
  "work_record_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull().default("release"),
    dispatchRound: integer("dispatch_round").notNull(),
    dependencySetRevision: integer("dependency_set_revision").notNull(),
    blockedCycle: integer("blocked_cycle").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    payloadDigest: text("payload_digest").notNull(),
    state: text("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    recordScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.recordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_outbox_record_scope_fk",
    }).onDelete("cascade"),
    issueScopeFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "work_record_outbox_issue_scope_fk",
    }).onDelete("cascade"),
    eventKeyUq: uniqueIndex("work_record_outbox_event_key_uq").on(table.companyId, table.eventKey),
    releaseUq: uniqueIndex("work_record_outbox_release_uq").on(table.companyId, table.recordId, table.dispatchRound, table.dependencySetRevision, table.blockedCycle, table.eventType),
    pendingIdx: index("work_record_outbox_pending_idx").on(table.state, table.availableAt),
  }),
);

export const workRecordExecutionProjections = pgTable(
  "work_record_execution_projections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    issueStatus: text("issue_status").notNull(),
    issueStatusVersion: bigint("issue_status_version", { mode: "number" }).notNull().default(0),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    lastEventCursor: bigint("last_event_cursor", { mode: "number" }).notNull().default(0),
    syncState: text("sync_state").notNull().default("current"),
    syncError: text("sync_error"),
    projectedAt: timestamp("projected_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    recordScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.recordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_execution_projections_record_scope_fk",
    }).onDelete("cascade"),
    issueScopeFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "work_record_execution_projections_issue_scope_fk",
    }).onDelete("cascade"),
    recordUq: uniqueIndex("work_record_execution_projections_record_uq").on(table.companyId, table.recordId),
    issueUq: uniqueIndex("work_record_execution_projections_issue_uq").on(table.companyId, table.issueId),
  }),
);

// Physical replay guard: only one effective work-record release may own a live wake.
// Defined on agent_wakeup_requests in its own module so migration generation keeps the
// index next to the table contract.
export const WORK_RECORD_RELEASE_IDEMPOTENCY_PREFIX = "work-record-release:";
