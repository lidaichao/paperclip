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

const migrationFile = "0327_work_record_iteration_assignment.sql";
const migrationSql = await readFile(
  new URL(`./migrations/${migrationFile}`, import.meta.url),
  "utf8",
);
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const rollbackSql = await readFile(
  new URL(
    "./migrations/rollback/0327_work_record_iteration_assignment.down.sql",
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

async function assignmentContract(sql: postgres.Sql) {
  const columns = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_records'
      AND column_name = 'iteration_assignment_mode'
  `;
  const constraints = await sql<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conname IN (
      'work_records_iteration_assignment_mode_check',
      'work_records_iteration_inheritance_parent_check'
    )
    ORDER BY conname
  `;
  return {
    columns,
    constraints: constraints.map((row) => row.conname),
  };
}

describePostgres("work-record iteration assignment migration", () => {
  it("backfills legacy rows, enforces inheritance constraints, rolls back, and reapplies", async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "paperclip-work-record-iteration-assignment-",
    );
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const initialContract = await assignmentContract(sql);
      expect(initialContract.columns).toHaveLength(1);
      expect(initialContract.columns[0]).toMatchObject({
        column_name: "iteration_assignment_mode",
        is_nullable: "NO",
      });
      expect(initialContract.columns[0]?.column_default).toContain("independent");
      expect(initialContract.constraints).toEqual([
        "work_records_iteration_assignment_mode_check",
        "work_records_iteration_inheritance_parent_check",
      ]);

      await applyStatements(sql, rollbackSql);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await assignmentContract(sql)).toEqual({ columns: [], constraints: [] });

      const companyId = randomUUID();
      const projectId = randomUUID();
      const parentId = randomUUID();
      const childId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'Iteration assignment migration', ${`IA${Math.floor(Math.random() * 1_000_000)}`})`;
      await sql`INSERT INTO projects (id, company_id, name)
        VALUES (${projectId}, ${companyId}, 'Migration project')`;
      await sql`INSERT INTO work_records (id, company_id, project_id, kind, title, parent_record_id)
        VALUES
          (${parentId}, ${companyId}, ${projectId}, 'plan', 'Legacy parent', NULL),
          (${childId}, ${companyId}, ${projectId}, 'plan', 'Legacy child', ${parentId})`;

      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });
      await applyPendingMigrations(database.connectionString);

      expect(await sql<{ id: string; iteration_assignment_mode: string }[]>`
        SELECT id, iteration_assignment_mode
        FROM work_records
        WHERE id IN (${parentId}, ${childId})
        ORDER BY id
      `).toEqual([
        { id: [childId, parentId].sort()[0], iteration_assignment_mode: "independent" },
        { id: [childId, parentId].sort()[1], iteration_assignment_mode: "independent" },
      ]);

      await expect(sql`UPDATE work_records
        SET iteration_assignment_mode = 'inherit_parent'
        WHERE id = ${parentId}`)
        .rejects.toMatchObject({
          code: "23514",
          constraint_name: "work_records_iteration_inheritance_parent_check",
        });
      await sql`UPDATE work_records
        SET iteration_assignment_mode = 'inherit_parent'
        WHERE id = ${childId}`;
      expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
