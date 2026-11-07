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

const migrationFile = "0315_work_record_container_revisions.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const rollbackSql = await readFile(
  new URL("./migrations/rollback/0315_work_record_container_revisions.down.sql", import.meta.url),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function revisionColumns(sql: postgres.Sql) {
  return sql<{ table_name: string; column_default: string; is_nullable: string }[]>`
    SELECT table_name, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('project_versions', 'project_iterations')
      AND column_name = 'revision'
    ORDER BY table_name
  `;
}

describePostgres("G1 work-record container migration", () => {
  it("applies, rolls back, and reapplies the optimistic revision columns on a real database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-work-record-g1-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      expect(await revisionColumns(sql)).toEqual([
        { table_name: "project_iterations", column_default: "1", is_nullable: "NO" },
        { table_name: "project_versions", column_default: "1", is_nullable: "NO" },
      ]);

      for (const statement of rollbackSql.split(/-->\s*statement-breakpoint/g).map((part) => part.trim()).filter(Boolean)) {
        await sql.unsafe(statement);
      }
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      expect(await revisionColumns(sql)).toEqual([]);
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });

      await applyPendingMigrations(database.connectionString);
      expect(await revisionColumns(sql)).toEqual([
        { table_name: "project_iterations", column_default: "1", is_nullable: "NO" },
        { table_name: "project_versions", column_default: "1", is_nullable: "NO" },
      ]);
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
