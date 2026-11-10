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

const migrationFile = "0328_work_record_business_numbers.sql";
const migrationSql = await readFile(
  new URL(`./migrations/${migrationFile}`, import.meta.url),
  "utf8",
);
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const rollbackSql = await readFile(
  new URL(
    "./migrations/rollback/0328_work_record_business_numbers.down.sql",
    import.meta.url,
  ),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function applyStatements(sql: postgres.Sql, source: string) {
  for (const statement of source
    .split(/-->\s*statement-breakpoint/g)
    .map((part) => part.trim())
    .filter(Boolean)) {
    await sql.unsafe(statement);
  }
}

async function businessNumberContract(sql: postgres.Sql) {
  const columns = await sql<{ column_name: string; is_nullable: string }[]>`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_records'
      AND column_name = 'record_number'
  `;
  const counterTable = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'work_record_counters'
  `;
  const constraints = await sql<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conname IN (
      'work_records_record_number_positive_check',
      'work_records_company_project_kind_record_number_unique',
      'work_record_counters_next_number_positive_check',
      'work_record_counters_pkey'
    )
    ORDER BY conname
  `;
  return {
    columns,
    counterTable,
    constraints: constraints.map((row) => row.conname),
  };
}

describePostgres("work-record business number migration", () => {
  it("deterministically backfills scoped sequences, initializes counters, rolls back, and reapplies", async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "paperclip-work-record-business-number-",
    );
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await businessNumberContract(sql)).toEqual({
        columns: [{ column_name: "record_number", is_nullable: "NO" }],
        counterTable: [{ table_name: "work_record_counters" }],
        constraints: [
          "work_record_counters_next_number_positive_check",
          "work_record_counters_pkey",
          "work_records_company_project_kind_record_number_unique",
          "work_records_record_number_positive_check",
        ],
      });

      await applyStatements(sql, rollbackSql);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await businessNumberContract(sql)).toEqual({
        columns: [],
        counterTable: [],
        constraints: [],
      });

      const companyId = randomUUID();
      const projectA = randomUUID();
      const projectB = randomUUID();
      const planFirst = "00000000-0000-4000-8000-000000000001";
      const planSecond = "00000000-0000-4000-8000-000000000002";
      const defect = randomUUID();
      const otherProjectPlan = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix, issue_counter)
        VALUES (${companyId}, 'Business number migration', ${`BN${Math.floor(Math.random() * 1_000_000)}`}, 27)`;
      await sql`INSERT INTO projects (id, company_id, name)
        VALUES
          (${projectA}, ${companyId}, 'Project A'),
          (${projectB}, ${companyId}, 'Project B')`;
      await sql`INSERT INTO work_records (id, company_id, project_id, kind, title, created_at)
        VALUES
          (${planSecond}, ${companyId}, ${projectA}, 'plan', 'Plan second by id', '2026-01-01T00:00:00Z'),
          (${planFirst}, ${companyId}, ${projectA}, 'plan', 'Plan first by id', '2026-01-01T00:00:00Z'),
          (${defect}, ${companyId}, ${projectA}, 'defect', 'Defect', '2026-01-02T00:00:00Z'),
          (${otherProjectPlan}, ${companyId}, ${projectB}, 'plan', 'Other project', '2026-01-02T00:00:00Z')`;

      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });
      await applyPendingMigrations(database.connectionString);

      expect(await sql<{ id: string; record_number: number }[]>`
        SELECT id, record_number
        FROM work_records
        WHERE id IN (${planFirst}, ${planSecond}, ${defect}, ${otherProjectPlan})
        ORDER BY id
      `).toEqual([
        { id: planFirst, record_number: 1 },
        { id: planSecond, record_number: 2 },
        { id: defect, record_number: 1 },
        { id: otherProjectPlan, record_number: 1 },
      ].sort((a, b) => a.id.localeCompare(b.id)));
      expect(await sql<{ project_id: string; kind: string; next_number: number }[]>`
        SELECT project_id, kind, next_number
        FROM work_record_counters
        WHERE company_id = ${companyId}
        ORDER BY project_id, kind
      `).toEqual([
        { project_id: projectA, kind: "defect", next_number: 2 },
        { project_id: projectA, kind: "plan", next_number: 3 },
        { project_id: projectB, kind: "plan", next_number: 2 },
      ].sort((a, b) => `${a.project_id}:${a.kind}`.localeCompare(`${b.project_id}:${b.kind}`)));
      expect((await sql<{ issue_counter: number }[]>`
        SELECT issue_counter FROM companies WHERE id = ${companyId}
      `)[0]?.issue_counter).toBe(27);
      await expect(sql`INSERT INTO work_records
        (id, company_id, project_id, kind, record_number, title)
        VALUES (${randomUUID()}, ${companyId}, ${projectA}, 'plan', 1, 'Duplicate plan number')`)
        .rejects.toMatchObject({
          code: "23505",
          constraint_name: "work_records_company_project_kind_record_number_unique",
        });
      expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
