import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const migrationFile = "0330_work_record_defect_fields.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const rollbackSql = await readFile(
  new URL("./migrations/rollback/0330_work_record_defect_fields.down.sql", import.meta.url),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function applyStatements(sql: postgres.Sql, source: string) {
  for (const statement of source.split(/-->\s*statement-breakpoint/g).map((part) => part.trim()).filter(Boolean)) {
    await sql.unsafe(statement);
  }
}

async function contract(sql: postgres.Sql) {
  const columns = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'work_records'
      AND column_name IN ('priority', 'found_in_version_id')
    ORDER BY column_name
  `;
  const [foreignKey] = await sql<{ confdeltype: string }[]>`
    SELECT confdeltype FROM pg_constraint
    WHERE conname = 'work_records_found_in_version_scope_fk'
  `;
  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'work_records'
      AND indexname = 'work_records_project_found_in_version_idx'
  `;
  const checks = await sql<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'work_records'::regclass
      AND conname IN ('work_records_priority_check', 'work_records_defect_fields_check')
    ORDER BY conname
  `;
  return {
    columns,
    foreignKeyDelete: foreignKey?.confdeltype ?? null,
    indexes: indexes.map((row) => row.indexname),
    checks: checks.map((row) => row.conname),
  };
}

describePostgres("FID-13 work-record defect fields migration", () => {
  it("defaults priority, scopes discovery versions, protects referenced versions, rolls back, and reapplies", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-defect-fields-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await contract(sql)).toMatchObject({
        columns: [
          { column_name: "found_in_version_id", is_nullable: "YES", column_default: null },
          { column_name: "priority", is_nullable: "NO", column_default: "'medium'::text" },
        ],
        foreignKeyDelete: "a",
        indexes: ["work_records_project_found_in_version_idx"],
        checks: ["work_records_defect_fields_check", "work_records_priority_check"],
      });

      await applyStatements(sql, rollbackSql);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await contract(sql)).toMatchObject({ columns: [], foreignKeyDelete: null, indexes: [], checks: ["work_records_defect_fields_check"] });

      const companyId = randomUUID();
      const projectA = randomUUID();
      const projectB = randomUUID();
      const versionA = randomUUID();
      const versionB = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'FID-13 migration', ${`D${Math.floor(Math.random() * 1_000_000)}`})`;
      await sql`INSERT INTO projects (id, company_id, name) VALUES (${projectA}, ${companyId}, 'Project A'), (${projectB}, ${companyId}, 'Project B')`;
      await sql`INSERT INTO project_versions (id, company_id, project_id, name) VALUES (${versionA}, ${companyId}, ${projectA}, 'A 1.0'), (${versionB}, ${companyId}, ${projectB}, 'B 1.0')`;
      await sql`INSERT INTO work_records (company_id, project_id, kind, record_number, title) VALUES (${companyId}, ${projectA}, 'defect', 1, 'Legacy defect')`;

      expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "needsMigrations", pendingMigrations: [migrationFile] });
      await applyPendingMigrations(database.connectionString);
      expect((await sql<{ priority: string }[]>`SELECT priority FROM work_records WHERE project_id = ${projectA}`)[0])
        .toEqual({ priority: "medium" });

      const defectId = randomUUID();
      await sql`INSERT INTO work_records (id, company_id, project_id, kind, record_number, title, priority, found_in_version_id)
        VALUES (${defectId}, ${companyId}, ${projectA}, 'defect', 2, 'Version defect', 'critical', ${versionA})`;
      await expect(sql`INSERT INTO work_records (company_id, project_id, kind, record_number, title, found_in_version_id)
        VALUES (${companyId}, ${projectA}, 'plan', 1, 'Invalid plan', ${versionA})`)
        .rejects.toMatchObject({ code: "23514", constraint_name: "work_records_defect_fields_check" });
      await expect(sql`INSERT INTO work_records (company_id, project_id, kind, record_number, title, found_in_version_id)
        VALUES (${companyId}, ${projectA}, 'defect', 3, 'Cross-project defect', ${versionB})`)
        .rejects.toMatchObject({ code: "23503", constraint_name: "work_records_found_in_version_scope_fk" });
      await expect(sql`DELETE FROM project_versions WHERE id = ${versionA}`)
        .rejects.toMatchObject({ code: "23503", constraint_name: "work_records_found_in_version_scope_fk" });

      await sql`DELETE FROM work_records WHERE id = ${defectId}`;
      await applyStatements(sql, rollbackSql);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      await applyPendingMigrations(database.connectionString);
      expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
