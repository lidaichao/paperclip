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
  it("backs up and restores A/B/C named views across rollback and replay", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-work-record-view-pref-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await contract(sql)).toEqual(expected);
      const companyId = "10000000-0000-4000-8000-000000000001";
      const projectId = "20000000-0000-4000-8000-000000000001";
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Migration company', 'MIG')`;
      await sql`INSERT INTO projects (id, company_id, name) VALUES (${projectId}, ${companyId}, 'Migration project')`;
      for (const [index, name] of ["A", "B", "C"].entries()) {
        await sql`
          INSERT INTO work_record_view_preferences
            (company_id, project_id, user_id, view_kind, name, config, revision)
          VALUES
            (${companyId}, ${projectId}, 'user-1', 'plan', ${name}, ${sql.json({ marker: name })}, ${index + 1})
        `;
      }

      await sql.unsafe(rollbackSql);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await contract(sql)).toEqual(legacyExpected);
      const legacyRows = await sql<{ marker: string }[]>`
        SELECT config ->> 'marker' AS marker
        FROM work_record_view_preferences
        WHERE company_id = ${companyId} AND project_id = ${projectId}
          AND user_id = 'user-1' AND view_kind = 'plan'
      `;
      expect(legacyRows).toHaveLength(1);
      const backupRows = await sql<{ name: string; marker: string }[]>`
        SELECT name, config ->> 'marker' AS marker
        FROM work_record_view_preferences_0320_rollback_backup
        WHERE company_id = ${companyId} AND project_id = ${projectId}
          AND user_id = 'user-1' AND view_kind = 'plan'
        ORDER BY name
      `;
      expect(backupRows).toEqual([
        { name: "A", marker: "A" },
        { name: "B", marker: "B" },
        { name: "C", marker: "C" },
      ]);
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });
      await applyPendingMigrations(database.connectionString);
      expect(await contract(sql)).toEqual(expected);
      const restoredRows = await sql<{ name: string; marker: string; revision: number }[]>`
        SELECT name, config ->> 'marker' AS marker, revision
        FROM work_record_view_preferences
        WHERE company_id = ${companyId} AND project_id = ${projectId}
          AND user_id = 'user-1' AND view_kind = 'plan'
        ORDER BY name
      `;
      expect(restoredRows).toEqual([
        { name: "A", marker: "A", revision: 1 },
        { name: "B", marker: "B", revision: 2 },
        { name: "C", marker: "C", revision: 3 },
      ]);
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
