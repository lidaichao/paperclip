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

const migrationFiles = [
  "0317_work_record_description_deliveries.sql",
  "0318_open_johnny_blaze.sql",
] as const;
const migrationHashes = await Promise.all(migrationFiles.map(async (migrationFile) =>
  createHash("sha256").update(await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8")).digest("hex"),
));
const rollback0317Sql = await readFile(
  new URL("./migrations/rollback/0317_work_record_description_deliveries.down.sql", import.meta.url),
  "utf8",
);
const rollback0318Sql = await readFile(
  new URL("./migrations/rollback/0318_open_johnny_blaze.down.sql", import.meta.url),
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
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_record_description_deliveries'
      AND column_name IN ('source_run_id', 'successor_run_id', 'wakeup_request_id', 'stop_confirmed_at', 'queued_at', 'model_visible_at', 'confirmed_at')
    ORDER BY column_name
  `;
  return {
    tables: tables.map((row) => row.table_name),
    indexes: indexes.map((row) => row.indexname),
    columns: columns.map((row) => row.column_name),
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
  columns: [
    "confirmed_at",
    "model_visible_at",
    "queued_at",
    "source_run_id",
    "stop_confirmed_at",
    "successor_run_id",
    "wakeup_request_id",
  ],
};

describePostgres("G1 work-record description delivery migration", () => {
  it("applies, rolls back, and reapplies the durable delivery contract on a real database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-work-record-description-delivery-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await deliveryContract(sql)).toEqual(expectedContract);
      for (const statement of rollback0318Sql.split(/-->\s*statement-breakpoint/g).map((part) => part.trim()).filter(Boolean)) {
        await sql.unsafe(statement);
      }
      for (const statement of rollback0317Sql.split(/-->\s*statement-breakpoint/g).map((part) => part.trim()).filter(Boolean)) {
        await sql.unsafe(statement);
      }
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN ${sql(migrationHashes)}`;
      expect(await deliveryContract(sql)).toEqual({ tables: [], indexes: [], columns: [] });
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: migrationFiles,
      });
      await applyPendingMigrations(database.connectionString);
      expect(await deliveryContract(sql)).toEqual(expectedContract);
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
