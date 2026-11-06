import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** A durable, exclusive owner for a run executed on an agent's own computer. */
export const localAgentRunLeases = pgTable(
  "local_agent_run_leases",
  {
    runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    // Keep the UUID for run audit after an issue is deleted. A foreign key here
    // would make historical leases silently disable the existing delete action.
    issueId: uuid("issue_id").notNull(),
    deviceId: text("device_id").notNull(),
    leaseId: uuid("lease_id").notNull().defaultRandom(),
    generation: integer("generation").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastRenewedAt: timestamp("last_renewed_at", { withTimezone: true }).notNull().defaultNow(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    stopAcknowledgedAt: timestamp("stop_acknowledged_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeAgentUq: uniqueIndex("local_agent_run_leases_active_agent_uq")
      .on(table.companyId, table.agentId)
      .where(sql`${table.releasedAt} is null`),
    activeIssueUq: uniqueIndex("local_agent_run_leases_active_issue_uq")
      .on(table.companyId, table.issueId)
      .where(sql`${table.releasedAt} is null`),
    claimIdempotencyUq: uniqueIndex("local_agent_run_leases_claim_idempotency_uq")
      .on(table.companyId, table.agentId, table.idempotencyKey),
    companyExpiryIdx: index("local_agent_run_leases_company_expiry_idx")
      .on(table.companyId, table.expiresAt),
    generationCheck: check("local_agent_run_leases_generation_check", sql`${table.generation} >= 1`),
    outcomeCheck: check("local_agent_run_leases_outcome_check", sql`${table.outcome} is null or ${table.outcome} in ('succeeded', 'failed', 'cancelled')`),
  }),
);
