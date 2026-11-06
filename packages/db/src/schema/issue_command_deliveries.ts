import { sql } from "drizzle-orm";
import {
  check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";
import { issueCompletionReviews } from "./issue_completion_reviews.js";

/**
 * Durable intent to notify a named reviewer after a fenced issue handoff.
 * This table is inert until a policy-aware dispatcher is implemented.
 */
export const issueCommandDeliveries = pgTable("issue_command_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull(),
  interactionId: uuid("interaction_id").notNull(),
  reviewId: uuid("review_id"),
  sourceRunId: uuid("source_run_id").notNull(),
  targetAgentId: uuid("target_agent_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("awaiting_handoff"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  claimToken: uuid("claim_token"),
  wakeupRequestId: uuid("wakeup_request_id"),
  lastError: text("last_error"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  interactionScopeFk: foreignKey({
    columns: [table.companyId, table.issueId, table.interactionId],
    foreignColumns: [issueThreadInteractions.companyId, issueThreadInteractions.issueId,
      issueThreadInteractions.id],
    name: "issue_command_deliveries_interaction_scope_fk",
  }).onDelete("cascade"),
  targetAgentScopeFk: foreignKey({
    columns: [table.companyId, table.targetAgentId],
    foreignColumns: [agents.companyId, agents.id],
    name: "issue_command_deliveries_target_agent_scope_fk",
  }).onDelete("cascade"),
  reviewScopeFk: foreignKey({
    columns: [table.companyId, table.issueId, table.interactionId, table.reviewId],
    foreignColumns: [issueCompletionReviews.companyId, issueCompletionReviews.issueId,
      issueCompletionReviews.interactionId, issueCompletionReviews.id],
    name: "issue_command_deliveries_review_scope_fk",
  }),
  interactionKindUq: uniqueIndex("issue_command_deliveries_interaction_kind_uq")
    .on(table.companyId, table.interactionId, table.kind),
  wakeupReceiptUq: uniqueIndex("issue_command_deliveries_wakeup_receipt_uq")
    .on(table.wakeupRequestId).where(sql`${table.wakeupRequestId} is not null`),
  pendingIdx: index("issue_command_deliveries_pending_idx")
    .on(table.status, table.nextAttemptAt),
  agentStatusIdx: index("issue_command_deliveries_agent_status_idx")
    .on(table.companyId, table.targetAgentId, table.status),
  kindCheck: check("issue_command_deliveries_kind_check",
    sql`(${table.kind} = 'interaction_pending' and ${table.reviewId} is null)
      or (${table.kind} = 'completion_review' and ${table.reviewId} is not null)`),
  statusCheck: check("issue_command_deliveries_status_check",
    sql`${table.status} in ('awaiting_handoff','ready','claimed','delivered','deferred','cancelled')`),
  attemptsCheck: check("issue_command_deliveries_attempts_check",
    sql`${table.attempts} >= 0`),
  claimCheck: check("issue_command_deliveries_claim_check",
    sql`(${table.status} = 'claimed') = (${table.claimToken} is not null and ${table.claimExpiresAt} is not null)`),
  receiptCheck: check("issue_command_deliveries_receipt_check",
    sql`${table.status} <> 'delivered' or (${table.deliveredAt} is not null and ${table.wakeupRequestId} is not null)`),
}));
