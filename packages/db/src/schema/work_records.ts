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
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { approvals } from "./approvals.js";
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
    qaAssigneeAgentId: uuid("qa_assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
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
    qaAssigneeScopeFk: foreignKey({
      columns: [table.companyId, table.qaAssigneeAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "work_records_qa_assignee_scope_fk",
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

export const workRecordAssignmentCommands = pgTable(
  "work_record_assignment_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    clientRequestId: text("client_request_id").notNull(),
    requestPayloadDigest: text("request_payload_digest").notNull(),
    expectedRecordRevision: integer("expected_record_revision").notNull(),
    expectedAssigneeAgentId: uuid("expected_assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    assigneeAgentId: uuid("assignee_agent_id").notNull().references(() => agents.id),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    previousRevision: integer("previous_revision").notNull(),
    resultingRevision: integer("resulting_revision").notNull(),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id"),
    actorRunId: uuid("actor_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    recordScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.recordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_assignment_commands_record_scope_fk",
    }).onDelete("cascade"),
    assigneeScopeFk: foreignKey({
      columns: [table.companyId, table.assigneeAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "work_record_assignment_commands_assignee_scope_fk",
    }),
    expectedAssigneeScopeFk: foreignKey({
      columns: [table.companyId, table.expectedAssigneeAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "work_record_assignment_commands_expected_assignee_scope_fk",
    }),
    requestUq: uniqueIndex("work_record_assignment_commands_request_uq").on(
      table.companyId,
      table.recordId,
      table.clientRequestId,
    ),
  }),
);

export const workRecordAssignmentGapEscalations = pgTable(
  "work_record_assignment_gap_escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    rootRecordId: uuid("root_record_id").references(() => workRecords.id, { onDelete: "cascade" }),
    scopeKind: text("scope_kind").notNull(),
    scopeDigest: text("scope_digest").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    requestPayloadDigest: text("request_payload_digest").notNull(),
    blockers: jsonb("blockers").$type<Array<{
      code: "missing_po" | "missing_assignee" | "missing_qa";
      recordId: string;
      title: string;
      requiredRole: "PO" | "执行人" | "QA";
    }>>().notNull(),
    missingRecordIds: jsonb("missing_record_ids").$type<string[]>().notNull(),
    targetCeoAgentId: uuid("target_ceo_agent_id").references(() => agents.id, { onDelete: "set null" }),
    state: text("state").notNull().default("pending"),
    deliveryAttempt: integer("delivery_attempt").notNull().default(0),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id, { onDelete: "set null" }),
    wakeStatus: text("wake_status"),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    runStatus: text("run_status"),
    deliveryErrorCode: text("delivery_error_code"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id"),
    actorRunId: uuid("actor_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rootScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.rootRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_assignment_gap_escalations_root_scope_fk",
    }).onDelete("cascade"),
    targetCeoScopeFk: foreignKey({
      columns: [table.companyId, table.targetCeoAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "work_record_assignment_gap_escalations_target_ceo_scope_fk",
    }),
    requestUq: uniqueIndex("work_record_assignment_gap_escalations_request_uq")
      .on(table.companyId, table.clientRequestId),
    scopeUq: uniqueIndex("work_record_assignment_gap_escalations_scope_uq")
      .on(table.companyId, table.projectId, table.scopeDigest),
    rootCreatedIdx: index("work_record_assignment_gap_escalations_root_created_idx")
      .on(table.companyId, table.projectId, table.rootRecordId, table.createdAt),
    stateCheck: check("work_record_assignment_gap_escalations_state_check", sql`${table.state} IN ('pending', 'delivering', 'queued', 'delivered', 'acknowledged', 'ceo_unavailable', 'delivery_failed')`),
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
    companyProjectIdUq: unique("work_record_issue_links_company_project_id_uq").on(
      table.companyId,
      table.projectId,
      table.id,
    ),
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

/**
 * Workflow-v2 sidecars are additive planning and quality facts. They never
 * replace native issues, heartbeat runs, or their execution locks.
 */
export const workRecordDispatchBatches = pgTable(
  "work_record_dispatch_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    rootRecordId: uuid("root_record_id").references(() => workRecords.id, { onDelete: "cascade" }),
    clientRequestId: text("client_request_id").notNull(),
    requestPayloadDigest: text("request_payload_digest").notNull(),
    scopeKind: text("scope_kind").$type<"whole_package" | "selected_records">().notNull(),
    scopeDigest: text("scope_digest").notNull(),
    rootRecordRevision: integer("root_record_revision").notNull(),
    dependencySetRevision: integer("dependency_set_revision").notNull(),
    workflowVersion: integer("workflow_version").notNull().default(2),
    state: text("state").notNull().default("preparing"),
    errorCode: text("error_code"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdUq: unique("work_record_dispatch_batches_company_project_id_uq").on(
      table.companyId,
      table.projectId,
      table.id,
    ),
    projectScopeFk: foreignKey({
      columns: [table.companyId, table.projectId],
      foreignColumns: [projects.companyId, projects.id],
      name: "work_record_dispatch_batches_project_scope_fk",
    }).onDelete("cascade"),
    rootRecordScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.rootRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_dispatch_batches_root_record_scope_fk",
    }).onDelete("cascade"),
    requestUq: uniqueIndex("work_record_dispatch_batches_request_uq").on(
      table.companyId,
      table.clientRequestId,
    ),
    projectStateIdx: index("work_record_dispatch_batches_project_state_idx").on(
      table.companyId,
      table.projectId,
      table.state,
      table.updatedAt,
    ),
    workflowVersionCheck: check(
      "work_record_dispatch_batches_workflow_version_check",
      sql`${table.workflowVersion} = 2`,
    ),
    revisionCheck: check(
      "work_record_dispatch_batches_revision_check",
      sql`${table.rootRecordRevision} > 0 AND ${table.dependencySetRevision} > 0`,
    ),
  }),
);

export const workRecordDispatchBatchItems = pgTable(
  "work_record_dispatch_batch_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").notNull().references(() => workRecordDispatchBatches.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    recordRevision: integer("record_revision").notNull(),
    inclusionReason: text("inclusion_reason").notNull(),
    materializationState: text("materialization_state").notNull().default("pending"),
    primaryIssueLinkId: uuid("primary_issue_link_id").references(() => workRecordIssueLinks.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdUq: unique("work_record_dispatch_batch_items_company_project_id_uq").on(
      table.companyId,
      table.projectId,
      table.id,
    ),
    batchScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.batchId],
      foreignColumns: [
        workRecordDispatchBatches.companyId,
        workRecordDispatchBatches.projectId,
        workRecordDispatchBatches.id,
      ],
      name: "work_record_dispatch_batch_items_batch_scope_fk",
    }).onDelete("cascade"),
    recordScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.recordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_dispatch_batch_items_record_scope_fk",
    }).onDelete("cascade"),
    issueLinkScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.primaryIssueLinkId],
      foreignColumns: [
        workRecordIssueLinks.companyId,
        workRecordIssueLinks.projectId,
        workRecordIssueLinks.id,
      ],
      name: "work_record_dispatch_batch_items_issue_link_scope_fk",
    }),
    recordUq: uniqueIndex("work_record_dispatch_batch_items_record_uq").on(
      table.companyId,
      table.projectId,
      table.batchId,
      table.recordId,
    ),
    batchStateIdx: index("work_record_dispatch_batch_items_batch_state_idx").on(
      table.companyId,
      table.batchId,
      table.materializationState,
    ),
    recordRevisionCheck: check(
      "work_record_dispatch_batch_items_record_revision_check",
      sql`${table.recordRevision} > 0`,
    ),
  }),
);

export const workRecordDependencySnapshots = pgTable(
  "work_record_dependency_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").notNull().references(() => workRecordDispatchBatches.id, { onDelete: "cascade" }),
    predecessorRecordId: uuid("predecessor_record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    successorRecordId: uuid("successor_record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    predecessorRevision: integer("predecessor_revision").notNull(),
    successorRevision: integer("successor_revision").notNull(),
    predecessorIssueLinkId: uuid("predecessor_issue_link_id").references(() => workRecordIssueLinks.id, { onDelete: "set null" }),
    successorIssueLinkId: uuid("successor_issue_link_id").references(() => workRecordIssueLinks.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    batchScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.batchId],
      foreignColumns: [
        workRecordDispatchBatches.companyId,
        workRecordDispatchBatches.projectId,
        workRecordDispatchBatches.id,
      ],
      name: "work_record_dependency_snapshots_batch_scope_fk",
    }).onDelete("cascade"),
    predecessorScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.predecessorRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_dependency_snapshots_predecessor_scope_fk",
    }).onDelete("cascade"),
    successorScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.successorRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_dependency_snapshots_successor_scope_fk",
    }).onDelete("cascade"),
    predecessorLinkScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.predecessorIssueLinkId],
      foreignColumns: [workRecordIssueLinks.companyId, workRecordIssueLinks.projectId, workRecordIssueLinks.id],
      name: "work_record_dependency_snapshots_predecessor_link_scope_fk",
    }),
    successorLinkScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.successorIssueLinkId],
      foreignColumns: [workRecordIssueLinks.companyId, workRecordIssueLinks.projectId, workRecordIssueLinks.id],
      name: "work_record_dependency_snapshots_successor_link_scope_fk",
    }),
    edgeUq: uniqueIndex("work_record_dependency_snapshots_edge_uq").on(
      table.companyId,
      table.projectId,
      table.batchId,
      table.predecessorRecordId,
      table.successorRecordId,
    ),
    batchIdx: index("work_record_dependency_snapshots_batch_idx").on(table.companyId, table.batchId),
    noSelf: check(
      "work_record_dependency_snapshots_not_self",
      sql`${table.predecessorRecordId} <> ${table.successorRecordId}`,
    ),
  }),
);

export const workRecordQualityCycles = pgTable(
  "work_record_quality_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    aggregateRecordId: uuid("aggregate_record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    cycleNumber: integer("cycle_number").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("open"),
    qualityPhase: text("quality_phase").notNull().default("not_started"),
    reason: text("reason"),
    scopeDigest: text("scope_digest").notNull(),
    revision: integer("revision").notNull().default(1),
    openedByAgentId: uuid("opened_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    openedByUserId: text("opened_by_user_id"),
    closedByAgentId: uuid("closed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    closedByUserId: text("closed_by_user_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdUq: unique("work_record_quality_cycles_company_project_id_uq").on(
      table.companyId,
      table.projectId,
      table.id,
    ),
    aggregateScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.aggregateRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_quality_cycles_aggregate_scope_fk",
    }).onDelete("cascade"),
    cycleUq: uniqueIndex("work_record_quality_cycles_number_uq").on(
      table.companyId,
      table.projectId,
      table.aggregateRecordId,
      table.cycleNumber,
    ),
    activeCycleUq: uniqueIndex("work_record_quality_cycles_active_uq")
      .on(table.companyId, table.projectId, table.aggregateRecordId)
      .where(sql`${table.state} = 'open'`),
    projectPhaseIdx: index("work_record_quality_cycles_project_phase_idx").on(
      table.companyId,
      table.projectId,
      table.qualityPhase,
      table.updatedAt,
    ),
    cycleNumberCheck: check("work_record_quality_cycles_number_check", sql`${table.cycleNumber} > 0`),
    revisionCheck: check("work_record_quality_cycles_revision_check", sql`${table.revision} > 0`),
  }),
);

export const workRecordQualityItems = pgTable(
  "work_record_quality_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    cycleId: uuid("cycle_id").notNull().references(() => workRecordQualityCycles.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    defectRecordId: uuid("defect_record_id").references(() => workRecords.id, { onDelete: "cascade" }),
    role: text("role").$type<"repair" | "qa" | "po">().notNull(),
    required: boolean("required").notNull().default(true),
    state: text("state").notNull().default("waiting"),
    issueLinkId: uuid("issue_link_id").references(() => workRecordIssueLinks.id, { onDelete: "set null" }),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdUq: unique("work_record_quality_items_company_project_id_uq").on(
      table.companyId,
      table.projectId,
      table.id,
    ),
    cycleScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.cycleId],
      foreignColumns: [workRecordQualityCycles.companyId, workRecordQualityCycles.projectId, workRecordQualityCycles.id],
      name: "work_record_quality_items_cycle_scope_fk",
    }).onDelete("cascade"),
    recordScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.recordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_quality_items_record_scope_fk",
    }).onDelete("cascade"),
    defectScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.defectRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_quality_items_defect_scope_fk",
    }).onDelete("cascade"),
    issueLinkScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.issueLinkId],
      foreignColumns: [workRecordIssueLinks.companyId, workRecordIssueLinks.projectId, workRecordIssueLinks.id],
      name: "work_record_quality_items_issue_link_scope_fk",
    }),
    cycleRecordRoleUq: uniqueIndex("work_record_quality_items_cycle_record_role_uq").on(
      table.companyId,
      table.projectId,
      table.cycleId,
      table.recordId,
      table.role,
    ),
    readinessIdx: index("work_record_quality_items_readiness_idx").on(
      table.companyId,
      table.cycleId,
      table.required,
      table.state,
    ),
    revisionCheck: check("work_record_quality_items_revision_check", sql`${table.revision} > 0`),
  }),
);

export const workRecordQualityLinks = pgTable(
  "work_record_quality_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    linkKey: text("link_key").notNull(),
    requestPayloadDigest: text("request_payload_digest").notNull(),
    linkKind: text("link_kind").notNull(),
    defectRecordId: uuid("defect_record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    packageRecordId: uuid("package_record_id").references(() => workRecords.id, { onDelete: "cascade" }),
    repairRecordId: uuid("repair_record_id").references(() => workRecords.id, { onDelete: "cascade" }),
    qaRecordId: uuid("qa_record_id").references(() => workRecords.id, { onDelete: "cascade" }),
    validFromCycleNumber: integer("valid_from_cycle_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    defectScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.defectRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_quality_links_defect_scope_fk",
    }).onDelete("cascade"),
    packageScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.packageRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_quality_links_package_scope_fk",
    }).onDelete("cascade"),
    repairScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.repairRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_quality_links_repair_scope_fk",
    }).onDelete("cascade"),
    qaScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.qaRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_quality_links_qa_scope_fk",
    }).onDelete("cascade"),
    linkKeyUq: uniqueIndex("work_record_quality_links_key_uq").on(table.companyId, table.linkKey),
    defectIdx: index("work_record_quality_links_defect_idx").on(table.companyId, table.projectId, table.defectRecordId),
    targetCheck: check(
      "work_record_quality_links_target_check",
      sql`${table.packageRecordId} IS NOT NULL OR ${table.repairRecordId} IS NOT NULL OR ${table.qaRecordId} IS NOT NULL`,
    ),
    cycleNumberCheck: check(
      "work_record_quality_links_cycle_number_check",
      sql`${table.validFromCycleNumber} > 0`,
    ),
  }),
);

export const workRecordQualityVerdicts = pgTable(
  "work_record_quality_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    cycleId: uuid("cycle_id").notNull().references(() => workRecordQualityCycles.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").notNull().references(() => workRecordQualityItems.id, { onDelete: "cascade" }),
    defectRecordId: uuid("defect_record_id").references(() => workRecords.id, { onDelete: "cascade" }),
    clientRequestId: text("client_request_id").notNull(),
    requestPayloadDigest: text("request_payload_digest").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id"),
    actorRunId: uuid("actor_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cycleScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.cycleId],
      foreignColumns: [workRecordQualityCycles.companyId, workRecordQualityCycles.projectId, workRecordQualityCycles.id],
      name: "work_record_quality_verdicts_cycle_scope_fk",
    }).onDelete("cascade"),
    itemScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.itemId],
      foreignColumns: [workRecordQualityItems.companyId, workRecordQualityItems.projectId, workRecordQualityItems.id],
      name: "work_record_quality_verdicts_item_scope_fk",
    }).onDelete("cascade"),
    defectScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.defectRecordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_quality_verdicts_defect_scope_fk",
    }).onDelete("cascade"),
    requestUq: uniqueIndex("work_record_quality_verdicts_request_uq").on(
      table.companyId,
      table.clientRequestId,
    ),
    itemCreatedIdx: index("work_record_quality_verdicts_item_created_idx").on(
      table.companyId,
      table.itemId,
      table.createdAt,
    ),
  }),
);

export const workRecordExecutionIntents = pgTable(
  "work_record_execution_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => workRecords.id, { onDelete: "cascade" }),
    // A prepare transaction creates the durable intent before the issue is
    // materialized. Reconciliation binds this field before an outbox event can
    // be emitted; the v2 outbox payload check remains the release fence.
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    batchItemId: uuid("batch_item_id").references(() => workRecordDispatchBatchItems.id, { onDelete: "cascade" }),
    qualityItemId: uuid("quality_item_id").references(() => workRecordQualityItems.id, { onDelete: "cascade" }),
    intentKey: text("intent_key").notNull(),
    requestPayloadDigest: text("request_payload_digest").notNull(),
    kind: text("kind").notNull(),
    generation: integer("generation").notNull().default(1),
    expectedIssueStatusVersion: bigint("expected_issue_status_version", { mode: "number" }).notNull(),
    state: text("state").notNull().default("pending"),
    waitingReason: text("waiting_reason"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdUq: unique("work_record_execution_intents_company_project_id_uq").on(
      table.companyId,
      table.projectId,
      table.id,
    ),
    recordScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.recordId],
      foreignColumns: [workRecords.companyId, workRecords.projectId, workRecords.id],
      name: "work_record_execution_intents_record_scope_fk",
    }).onDelete("cascade"),
    issueScopeFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "work_record_execution_intents_issue_scope_fk",
    }).onDelete("cascade"),
    batchItemScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.batchItemId],
      foreignColumns: [
        workRecordDispatchBatchItems.companyId,
        workRecordDispatchBatchItems.projectId,
        workRecordDispatchBatchItems.id,
      ],
      name: "work_record_execution_intents_batch_item_scope_fk",
    }).onDelete("cascade"),
    qualityItemScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.qualityItemId],
      foreignColumns: [workRecordQualityItems.companyId, workRecordQualityItems.projectId, workRecordQualityItems.id],
      name: "work_record_execution_intents_quality_item_scope_fk",
    }).onDelete("cascade"),
    intentKeyUq: uniqueIndex("work_record_execution_intents_key_uq").on(table.companyId, table.intentKey),
    batchItemUq: uniqueIndex("work_record_execution_intents_batch_item_uq")
      .on(table.companyId, table.batchItemId)
      .where(sql`${table.batchItemId} IS NOT NULL`),
    qualityItemUq: uniqueIndex("work_record_execution_intents_quality_item_uq")
      .on(table.companyId, table.qualityItemId)
      .where(sql`${table.qualityItemId} IS NOT NULL`),
    activeIssueUq: uniqueIndex("work_record_execution_intents_active_issue_uq")
      .on(table.companyId, table.issueId)
      .where(sql`${table.state} IN ('pending', 'waiting_dependencies', 'waiting_governance', 'ready', 'queued', 'running')`),
    stateIdx: index("work_record_execution_intents_state_idx").on(
      table.companyId,
      table.projectId,
      table.state,
      table.updatedAt,
    ),
    sourceCheck: check(
      "work_record_execution_intents_source_check",
      sql`num_nonnulls(${table.batchItemId}, ${table.qualityItemId}) = 1`,
    ),
    generationCheck: check("work_record_execution_intents_generation_check", sql`${table.generation} > 0`),
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
    workflowVersion: integer("workflow_version").notNull().default(1),
    batchId: uuid("batch_id").references(() => workRecordDispatchBatches.id, { onDelete: "cascade" }),
    qualityCycleId: uuid("quality_cycle_id").references(() => workRecordQualityCycles.id, { onDelete: "cascade" }),
    qualityItemId: uuid("quality_item_id").references(() => workRecordQualityItems.id, { onDelete: "cascade" }),
    executionIntentId: uuid("execution_intent_id").references(() => workRecordExecutionIntents.id, { onDelete: "cascade" }),
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
    batchScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.batchId],
      foreignColumns: [
        workRecordDispatchBatches.companyId,
        workRecordDispatchBatches.projectId,
        workRecordDispatchBatches.id,
      ],
      name: "work_record_outbox_batch_scope_fk",
    }).onDelete("cascade"),
    qualityCycleScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.qualityCycleId],
      foreignColumns: [workRecordQualityCycles.companyId, workRecordQualityCycles.projectId, workRecordQualityCycles.id],
      name: "work_record_outbox_quality_cycle_scope_fk",
    }).onDelete("cascade"),
    qualityItemScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.qualityItemId],
      foreignColumns: [workRecordQualityItems.companyId, workRecordQualityItems.projectId, workRecordQualityItems.id],
      name: "work_record_outbox_quality_item_scope_fk",
    }).onDelete("cascade"),
    executionIntentScopeFk: foreignKey({
      columns: [table.companyId, table.projectId, table.executionIntentId],
      foreignColumns: [
        workRecordExecutionIntents.companyId,
        workRecordExecutionIntents.projectId,
        workRecordExecutionIntents.id,
      ],
      name: "work_record_outbox_execution_intent_scope_fk",
    }).onDelete("cascade"),
    eventKeyUq: uniqueIndex("work_record_outbox_event_key_uq").on(table.companyId, table.eventKey),
    releaseUq: uniqueIndex("work_record_outbox_release_uq")
      .on(table.companyId, table.recordId, table.dispatchRound, table.dependencySetRevision, table.blockedCycle, table.eventType)
      .where(sql`${table.workflowVersion} = 1`),
    intentEventUq: uniqueIndex("work_record_outbox_intent_event_uq")
      .on(table.companyId, table.executionIntentId, table.eventType)
      .where(sql`${table.workflowVersion} = 2 AND ${table.executionIntentId} IS NOT NULL`),
    pendingIdx: index("work_record_outbox_pending_idx").on(table.state, table.availableAt),
    workflowVersionCheck: check(
      "work_record_outbox_workflow_version_check",
      sql`${table.workflowVersion} IN (1, 2)`,
    ),
    workflowPayloadCheck: check(
      "work_record_outbox_workflow_payload_check",
      sql`(${table.workflowVersion} = 1 AND ${table.batchId} IS NULL AND ${table.qualityCycleId} IS NULL AND ${table.qualityItemId} IS NULL AND ${table.executionIntentId} IS NULL)
        OR (${table.workflowVersion} = 2 AND ${table.executionIntentId} IS NOT NULL)`,
    ),
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
