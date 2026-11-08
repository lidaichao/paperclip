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

const migrationFile = "0320_personal_named_work_record_views.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const rollbackSql = await readFile(
  new URL("./migrations/rollback/0320_personal_named_work_record_views.down.sql", import.meta.url),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function contract(sql: postgres.Sql) {
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'work_record_view_preferences'
    ORDER BY ordinal_position
  `;
  const constraints = await sql<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conname IN (
      'work_record_view_preferences_project_scope_fk',
      'work_record_view_preferences_view_kind_check',
      'work_record_view_preferences_revision_check'
    ) ORDER BY conname
  `;
  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname IN (
      'work_record_view_preferences_scope_uq',
      'work_record_view_preferences_user_project_idx'
    ) ORDER BY indexname
  `;
  return {
    columns: columns.map((row) => row.column_name),
    constraints: constraints.map((row) => row.conname),
    indexes: indexes.map((row) => row.indexname),
  };
}

const expected = {
  columns: ["id", "company_id", "project_id", "user_id", "view_kind", "config", "revision", "created_at", "updated_at", "name"],
  constraints: [
    "work_record_view_preferences_project_scope_fk",
    "work_record_view_preferences_revision_check",
    "work_record_view_preferences_view_kind_check",
  ],
  indexes: [
    "work_record_view_preferences_scope_uq",
    "work_record_view_preferences_user_project_idx",
  ],
};

const legacyExpected = { ...expected, columns: expected.columns.filter((column) => column !== "name") };

describePostgres("G3B1 personal named work-record view migration", () => {
  it("applies, rolls back, and reapplies the contract on a real database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-work-record-view-pref-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await contract(sql)).toEqual(expected);
      await sql.unsafe(rollbackSql);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await contract(sql)).toEqual(legacyExpected);
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });
      await applyPendingMigrations(database.connectionString);
      expect(await contract(sql)).toEqual(expected);
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
