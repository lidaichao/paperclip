import { sql } from "drizzle-orm";
import {
  bigint, check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";
import { localAgentRunLeases } from "./local_agent_run_leases.js";
import { statusDecisions } from "./status_decisions.js";

/**
 * Inert, runtime-neutral review revision. No route or worker may create one
 * until both runtime adapters and the common decision command are verified.
 */
export const issueCompletionReviews = pgTable("issue_completion_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  sourceRunId: uuid("source_run_id").notNull(),
  sourceAgentId: uuid("source_agent_id").notNull(),
  reviewerAgentId: uuid("reviewer_agent_id").notNull(),
  interactionId: uuid("interaction_id").notNull(),
  sourceKind: text("source_kind").notNull(),
  nativeDecisionId: uuid("native_decision_id"),
  clientPullLeaseRunId: uuid("client_pull_lease_run_id"),
  requestId: uuid("request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  issueStatusVersion: bigint("issue_status_version", { mode: "number" }).notNull(),
  state: text("state").notNull().default("pending"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  issueScopeFk: foreignKey({
    columns: [table.companyId, table.issueId],
    foreignColumns: [issues.companyId, issues.id],
    name: "issue_completion_reviews_issue_scope_fk",
  }),
  reviewerScopeFk: foreignKey({
    columns: [table.companyId, table.reviewerAgentId],
    foreignColumns: [agents.companyId, agents.id],
    name: "issue_completion_reviews_reviewer_scope_fk",
  }),
  sourceAgentScopeFk: foreignKey({
    columns: [table.companyId, table.sourceAgentId],
    foreignColumns: [agents.companyId, agents.id],
    name: "issue_completion_reviews_source_agent_scope_fk",
  }),
  interactionScopeFk: foreignKey({
    columns: [table.companyId, table.issueId, table.interactionId],
    foreignColumns: [issueThreadInteractions.companyId, issueThreadInteractions.issueId,
      issueThreadInteractions.id],
    name: "issue_completion_reviews_interaction_scope_fk",
  }),
  nativeDecisionScopeFk: foreignKey({
    columns: [table.companyId, table.issueId, table.sourceRunId, table.nativeDecisionId],
    foreignColumns: [statusDecisions.companyId, statusDecisions.issueId,
      statusDecisions.runId, statusDecisions.id],
    name: "issue_completion_reviews_native_decision_scope_fk",
  }),
  localLeaseScopeFk: foreignKey({
    columns: [table.companyId, table.issueId, table.clientPullLeaseRunId],
    foreignColumns: [localAgentRunLeases.companyId, localAgentRunLeases.issueId,
      localAgentRunLeases.runId],
    name: "issue_completion_reviews_local_lease_scope_fk",
  }),
  requestUq: uniqueIndex("issue_completion_reviews_run_request_uq")
    .on(table.companyId, table.sourceRunId, table.requestId),
  interactionUq: uniqueIndex("issue_completion_reviews_interaction_uq")
    .on(table.companyId, table.interactionId),
  evidenceCheck: check("issue_completion_reviews_evidence_check", sql`
    (${table.sourceKind} = 'native' and ${table.nativeDecisionId} is not null
      and ${table.clientPullLeaseRunId} is null)
    or (${table.sourceKind} = 'client_pull' and ${table.nativeDecisionId} is null
      and ${table.clientPullLeaseRunId} is not null
      and ${table.clientPullLeaseRunId} = ${table.sourceRunId})
  `),
  separateReviewerCheck: check("issue_completion_reviews_separate_reviewer_check",
    sql`${table.sourceAgentId} <> ${table.reviewerAgentId}`),
  requestDigestCheck: check("issue_completion_reviews_request_digest_check",
    sql`length(${table.requestDigest}) > 0`),
  versionCheck: check("issue_completion_reviews_version_check",
    sql`${table.issueStatusVersion} >= 0`),
  stateCheck: check("issue_completion_reviews_state_check",
    sql`${table.state} in ('pending','accepted','rejected','cancelled')`),
  decisionCheck: check("issue_completion_reviews_decision_check", sql`
    (${table.state} = 'pending' and ${table.decidedAt} is null)
    or (${table.state} <> 'pending' and ${table.decidedAt} is not null)
  `),
}));
