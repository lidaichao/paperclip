import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const migrationFile = "0317_work_record_description_deliveries.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const rollbackSql = await readFile(
  new URL("./migrations/rollback/0317_work_record_description_deliveries.down.sql", import.meta.url),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function deliveryContract(sql: postgres.Sql) {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'work_record_description_deliveries'
  `;
  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname IN (
      'work_record_description_deliveries_revision_uq',
      'work_record_description_deliveries_intent_uq',
      'work_record_description_deliveries_pending_idx',
      'agent_wakeup_requests_work_record_description_delivery_uq'
    ) ORDER BY indexname
  `;
  return {
    tables: tables.map((row) => row.table_name),
    indexes: indexes.map((row) => row.indexname),
  };
}

const expectedContract = {
  tables: ["work_record_description_deliveries"],
  indexes: [
    "agent_wakeup_requests_work_record_description_delivery_uq",
    "work_record_description_deliveries_intent_uq",
    "work_record_description_deliveries_pending_idx",
    "work_record_description_deliveries_revision_uq",
  ],
};

describePostgres("G1 work-record description delivery migration", () => {
  it("applies, rolls back, and reapplies the durable delivery contract on a real database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-work-record-description-delivery-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await deliveryContract(sql)).toEqual(expectedContract);
      for (const statement of rollbackSql.split(/-->\s*statement-breakpoint/g).map((part) => part.trim()).filter(Boolean)) {
        await sql.unsafe(statement);
      }
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await deliveryContract(sql)).toEqual({ tables: [], indexes: [] });
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });
      await applyPendingMigrations(database.connectionString);
      expect(await deliveryContract(sql)).toEqual(expectedContract);
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
