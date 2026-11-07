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

const migrationFile = "0316_work_record_g1_fields.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const rollbackSql = await readFile(
  new URL("./migrations/rollback/0316_work_record_g1_fields.down.sql", import.meta.url),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function g1FieldContract(sql: postgres.Sql) {
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_records'
      AND column_name IN (
        'planned_start_date', 'planned_completion_date', 'defect_severity',
        'defect_reproduction_steps', 'defect_expected_result', 'defect_actual_result'
      )
    ORDER BY column_name
  `;
  const constraints = await sql<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conname IN (
      'work_records_planned_dates_check',
      'work_records_defect_severity_check',
      'work_records_defect_fields_check'
    )
    ORDER BY conname
  `;
  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'work_records_project_planned_dates_idx',
        'work_records_project_defect_severity_idx'
      )
    ORDER BY indexname
  `;
  return {
    columns: columns.map((row) => row.column_name),
    constraints: constraints.map((row) => row.conname),
    indexes: indexes.map((row) => row.indexname),
  };
}

const expectedContract = {
  columns: [
    "defect_actual_result",
    "defect_expected_result",
    "defect_reproduction_steps",
    "defect_severity",
    "planned_completion_date",
    "planned_start_date",
  ],
  constraints: [
    "work_records_defect_fields_check",
    "work_records_defect_severity_check",
    "work_records_planned_dates_check",
  ],
  indexes: [
    "work_records_project_defect_severity_idx",
    "work_records_project_planned_dates_idx",
  ],
};

describePostgres("G1 work-record planning and defect field migration", () => {
  it("applies, rolls back, and reapplies the field contract on a real database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-work-record-g1-fields-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await g1FieldContract(sql)).toEqual(expectedContract);
      for (const statement of rollbackSql.split(/-->\s*statement-breakpoint/g).map((part) => part.trim()).filter(Boolean)) {
        await sql.unsafe(statement);
      }
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await g1FieldContract(sql)).toEqual({ columns: [], constraints: [], indexes: [] });
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });
      await applyPendingMigrations(database.connectionString);
      expect(await g1FieldContract(sql)).toEqual(expectedContract);
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
