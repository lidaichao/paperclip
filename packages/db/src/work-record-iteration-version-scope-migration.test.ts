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

const migrationFile = "0329_work_record_iteration_version_scope.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const rollbackSql = await readFile(
  new URL("./migrations/rollback/0329_work_record_iteration_version_scope.down.sql", import.meta.url),
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

async function iterationContract(sql: postgres.Sql) {
  const [column] = await sql<{ is_nullable: string }[]>`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_iterations' AND column_name = 'version_id'
  `;
  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'project_iterations'
      AND indexname IN ('project_iterations_project_name_uq', 'project_iterations_version_name_uq')
    ORDER BY indexname
  `;
  const [foreignKey] = await sql<{ confdeltype: string }[]>`
    SELECT confdeltype FROM pg_constraint
    WHERE conname = 'project_iterations_version_id_project_versions_id_fk'
  `;
  return {
    nullable: column?.is_nullable,
    indexes: indexes.map((row) => row.indexname),
    deleteAction: foreignKey?.confdeltype,
  };
}

describePostgres("FID-05 iteration version-scope migration", () => {
  it("backfills orphan iterations, enforces version-scoped names, rolls back, and reapplies", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-iteration-version-scope-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await iterationContract(sql)).toEqual({
        nullable: "NO",
        indexes: ["project_iterations_version_name_uq"],
        deleteAction: "a",
      });

      await applyStatements(sql, rollbackSql);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await iterationContract(sql)).toEqual({
        nullable: "YES",
        indexes: ["project_iterations_project_name_uq"],
        deleteAction: "n",
      });

      const companyId = randomUUID();
      const projectId = randomUUID();
      const orphanA = randomUUID();
      const orphanB = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'FID-05 migration', ${`F${Math.floor(Math.random() * 1_000_000)}`})`;
      await sql`INSERT INTO projects (id, company_id, name)
        VALUES (${projectId}, ${companyId}, 'Legacy iterations')`;
      await sql`INSERT INTO project_iterations (id, company_id, project_id, version_id, name)
        VALUES
          (${orphanA}, ${companyId}, ${projectId}, NULL, 'Sprint 1'),
          (${orphanB}, ${companyId}, ${projectId}, NULL, 'Sprint 2')`;

      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });
      await applyPendingMigrations(database.connectionString);

      const legacyVersion = (await sql<{ id: string }[]>`
        SELECT id FROM project_versions
        WHERE company_id = ${companyId} AND project_id = ${projectId} AND name = '历史未归属版本'
      `)[0];
      expect(legacyVersion?.id).toBeTruthy();
      expect(await sql<{ id: string; version_id: string }[]>`
        SELECT id, version_id FROM project_iterations
        WHERE id IN (${orphanA}, ${orphanB}) ORDER BY id
      `).toEqual([
        { id: orphanA, version_id: legacyVersion!.id },
        { id: orphanB, version_id: legacyVersion!.id },
      ].sort((a, b) => a.id.localeCompare(b.id)));

      const secondVersion = randomUUID();
      await sql`INSERT INTO project_versions (id, company_id, project_id, name)
        VALUES (${secondVersion}, ${companyId}, ${projectId}, 'V2')`;
      await sql`INSERT INTO project_iterations (id, company_id, project_id, version_id, name)
        VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${secondVersion}, 'Sprint 1')`;
      await expect(sql`INSERT INTO project_iterations (id, company_id, project_id, version_id, name)
        VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${legacyVersion!.id}, 'Sprint 1')`)
        .rejects.toMatchObject({ code: "23505", constraint_name: "project_iterations_version_name_uq" });

      await applyStatements(sql, rollbackSql);
      expect(await iterationContract(sql)).toEqual({
        nullable: "YES",
        indexes: ["project_iterations_project_name_uq"],
        deleteAction: "n",
      });
      expect((await sql<{ count: string }[]>`
        SELECT count(*) FROM (
          SELECT company_id, project_id, name FROM project_iterations
          GROUP BY company_id, project_id, name HAVING count(*) > 1
        ) duplicates
      `)[0]?.count).toBe("0");

      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      await applyPendingMigrations(database.connectionString);
      expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
