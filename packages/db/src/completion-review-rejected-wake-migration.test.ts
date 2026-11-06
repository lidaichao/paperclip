import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("rejected completion review source wake migration", () => {
  it("keeps a rejection wake unique across all statuses and rejects historical duplicates", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("pc-rejected-review-wake-");
    const sql = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const reviewId = randomUUID();
      const key = `completion-review-rejected:${reviewId}`;
      await sql`INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Rejected review wake test', ${`RR${companyId.slice(0, 6)}`})`;
      await sql`INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type")
        VALUES (${agentId}, ${companyId}, 'Source agent', 'engineer', 'process')`;

      await sql`INSERT INTO "agent_wakeup_requests" ("company_id", "agent_id", "source", "status", "idempotency_key")
        VALUES (${companyId}, ${agentId}, 'test', 'failed', ${key})`;
      await expect(sql`INSERT INTO "agent_wakeup_requests" ("company_id", "agent_id", "source", "status", "idempotency_key")
        VALUES (${companyId}, ${agentId}, 'test', 'queued', ${key})`).rejects.toMatchObject({
        code: "23505",
        constraint_name: "agent_wakeup_requests_review_rejected_idempotency_uq",
      });
      await sql`INSERT INTO "agent_wakeup_requests" ("company_id", "agent_id", "source", "status", "idempotency_key")
        VALUES (${companyId}, ${agentId}, 'test', 'queued', ${`completion-review-rejected:${randomUUID()}`})`;

      await sql.unsafe('DROP INDEX "agent_wakeup_requests_review_rejected_idempotency_uq"');
      await sql`INSERT INTO "agent_wakeup_requests" ("company_id", "agent_id", "source", "status", "idempotency_key")
        VALUES (${companyId}, ${agentId}, 'test', 'cancelled', ${key})`;
      const migration = await readFile(new URL("./migrations/0303_rejected_source_wake.sql", import.meta.url), "utf8");
      await expect(sql.unsafe(migration.split("--> statement-breakpoint")[0]!)).rejects.toMatchObject({
        code: "23505",
        message: expect.stringContaining("duplicate dedicated rejected completion review wake keys"),
      });
    } finally {
      await sql.end();
      await temporary.cleanup();
    }
  }, 90_000);
});
