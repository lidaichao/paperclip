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

const migrationFile = "0289_green_lady_deathstrike.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function seedBase(sql: postgres.Sql) {
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const crossCompanyProjectId = randomUUID();
  const recordId = randomUUID();
  const siblingRecordId = randomUUID();
  const otherProjectRecordId = randomUUID();
  const crossCompanyRecordId = randomUUID();
  const issueId = randomUUID();
  const issueLinkId = randomUUID();

  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES
    (${companyId}, 'Workflow v2', ${`WF${Math.floor(Math.random() * 1_000_000)}`}),
    (${otherCompanyId}, 'Other company', ${`OC${Math.floor(Math.random() * 1_000_000)}`})`;
  await sql`INSERT INTO projects (id, company_id, name) VALUES
    (${projectId}, ${companyId}, 'Primary project'),
    (${otherProjectId}, ${companyId}, 'Other project'),
    (${crossCompanyProjectId}, ${otherCompanyId}, 'Cross-company project')`;
  await sql`INSERT INTO work_records (id, company_id, project_id, kind, title) VALUES
    (${recordId}, ${companyId}, ${projectId}, 'plan', 'Package'),
    (${siblingRecordId}, ${companyId}, ${projectId}, 'plan', 'Sibling'),
    (${otherProjectRecordId}, ${companyId}, ${otherProjectId}, 'plan', 'Other project record'),
    (${crossCompanyRecordId}, ${otherCompanyId}, ${crossCompanyProjectId}, 'plan', 'Cross-company record')`;
  await sql`INSERT INTO issues (id, company_id, project_id, title) VALUES
    (${issueId}, ${companyId}, ${projectId}, 'Primary issue')`;
  await sql`INSERT INTO work_record_issue_links
    (id, company_id, project_id, record_id, issue_id, purpose, dispatch_round)
    VALUES (${issueLinkId}, ${companyId}, ${projectId}, ${recordId}, ${issueId}, 'primary', 1)`;

  return {
    companyId,
    otherCompanyId,
    projectId,
    otherProjectId,
    crossCompanyProjectId,
    recordId,
    siblingRecordId,
    otherProjectRecordId,
    crossCompanyRecordId,
    issueId,
    issueLinkId,
  };
}

async function insertLegacyOutbox(sql: postgres.Sql, row: Awaited<ReturnType<typeof seedBase>>) {
  const outboxId = randomUUID();
  await sql`INSERT INTO work_record_outbox
    (id, company_id, project_id, record_id, issue_id, event_key, event_type,
     dispatch_round, dependency_set_revision, blocked_cycle, payload_digest)
    VALUES (${outboxId}, ${row.companyId}, ${row.projectId}, ${row.recordId}, ${row.issueId},
      ${`legacy:${outboxId}`}, 'release', 1, 1, 0, 'legacy-digest')`;
  return outboxId;
}

describePostgres("work-record workflow v2 migration", () => {
  it("enforces unique active cycles/intents, project boundaries, append-only verdicts, and version checks", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-workflow-v2-fresh-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 2, onnotice: () => {} });
    try {
      const row = await seedBase(sql);
      const legacyOutboxId = await insertLegacyOutbox(sql, row);
      const [legacyOutbox] = await sql`SELECT workflow_version, execution_intent_id
        FROM work_record_outbox WHERE id = ${legacyOutboxId}`;
      expect(legacyOutbox).toEqual({ workflow_version: 1, execution_intent_id: null });

      const batchId = randomUUID();
      await sql`INSERT INTO work_record_dispatch_batches
        (id, company_id, project_id, root_record_id, client_request_id, request_payload_digest,
         scope_kind, scope_digest, root_record_revision, dependency_set_revision)
        VALUES (${batchId}, ${row.companyId}, ${row.projectId}, ${row.recordId}, 'request-1',
          'payload-1', 'whole_package', 'scope-1', 1, 1)`;
      await expect(sql`INSERT INTO work_record_dispatch_batches
        (company_id, project_id, root_record_id, client_request_id, request_payload_digest,
         scope_kind, scope_digest, root_record_revision, dependency_set_revision)
        VALUES (${row.companyId}, ${row.projectId}, ${row.recordId}, 'request-1',
          'different-payload', 'whole_package', 'scope-1', 1, 1)`)
        .rejects.toMatchObject({ code: "23505", constraint_name: "work_record_dispatch_batches_request_uq" });

      await expect(sql`INSERT INTO work_record_dispatch_batches
        (company_id, project_id, root_record_id, client_request_id, request_payload_digest,
         scope_kind, scope_digest, root_record_revision, dependency_set_revision)
        VALUES (${row.companyId}, ${row.projectId}, ${row.otherProjectRecordId}, 'cross-project',
          'payload-cross-project', 'whole_package', 'scope-cross-project', 1, 1)`)
        .rejects.toMatchObject({ code: "23503" });
      await expect(sql`INSERT INTO work_record_dispatch_batches
        (company_id, project_id, root_record_id, client_request_id, request_payload_digest,
         scope_kind, scope_digest, root_record_revision, dependency_set_revision)
        VALUES (${row.companyId}, ${row.projectId}, ${row.crossCompanyRecordId}, 'cross-company',
          'payload-cross-company', 'whole_package', 'scope-cross-company', 1, 1)`)
        .rejects.toMatchObject({ code: "23503" });

      const batchItemId = randomUUID();
      await sql`INSERT INTO work_record_dispatch_batch_items
        (id, company_id, project_id, batch_id, record_id, record_revision, inclusion_reason)
        VALUES (${batchItemId}, ${row.companyId}, ${row.projectId}, ${batchId}, ${row.recordId}, 1, 'root')`;

      const cycleId = randomUUID();
      await sql`INSERT INTO work_record_quality_cycles
        (id, company_id, project_id, aggregate_record_id, cycle_number, kind, scope_digest)
        VALUES (${cycleId}, ${row.companyId}, ${row.projectId}, ${row.recordId}, 1,
          'package_acceptance', 'quality-scope-1')`;
      await expect(sql`INSERT INTO work_record_quality_cycles
        (company_id, project_id, aggregate_record_id, cycle_number, kind, scope_digest)
        VALUES (${row.companyId}, ${row.projectId}, ${row.recordId}, 2,
          'package_rework', 'quality-scope-2')`)
        .rejects.toMatchObject({ code: "23505", constraint_name: "work_record_quality_cycles_active_uq" });

      const itemId = randomUUID();
      await sql`INSERT INTO work_record_quality_items
        (id, company_id, project_id, cycle_id, record_id, role)
        VALUES (${itemId}, ${row.companyId}, ${row.projectId}, ${cycleId}, ${row.recordId}, 'po')`;
      await expect(sql`INSERT INTO work_record_quality_items
        (company_id, project_id, cycle_id, record_id, role)
        VALUES (${row.companyId}, ${row.projectId}, ${cycleId}, ${row.otherProjectRecordId}, 'qa')`)
        .rejects.toMatchObject({ code: "23503" });

      const intentId = randomUUID();
      await sql`INSERT INTO work_record_execution_intents
        (id, company_id, project_id, record_id, issue_id, batch_item_id, intent_key,
         request_payload_digest, kind, expected_issue_status_version)
        VALUES (${intentId}, ${row.companyId}, ${row.projectId}, ${row.recordId}, ${row.issueId},
          ${batchItemId}, 'intent-1', 'intent-payload-1', 'initial_release', 0)`;
      await expect(sql`INSERT INTO work_record_execution_intents
        (company_id, project_id, record_id, issue_id, quality_item_id, intent_key,
         request_payload_digest, kind, expected_issue_status_version)
        VALUES (${row.companyId}, ${row.projectId}, ${row.recordId}, ${row.issueId},
          ${itemId}, 'intent-2', 'intent-payload-2', 'po_acceptance_release', 0)`)
        .rejects.toMatchObject({ code: "23505", constraint_name: "work_record_execution_intents_active_issue_uq" });

      const verdictId = randomUUID();
      await sql`INSERT INTO work_record_quality_verdicts
        (id, company_id, project_id, cycle_id, item_id, client_request_id,
         request_payload_digest, outcome, reason)
        VALUES (${verdictId}, ${row.companyId}, ${row.projectId}, ${cycleId}, ${itemId},
          'verdict-1', 'verdict-payload-1', 'approve', 'Accepted')`;
      await expect(sql`UPDATE work_record_quality_verdicts SET reason = 'rewritten' WHERE id = ${verdictId}`)
        .rejects.toMatchObject({ code: "55000" });
      await expect(sql`DELETE FROM work_record_quality_verdicts WHERE id = ${verdictId}`)
        .rejects.toMatchObject({ code: "55000" });

      await expect(sql`INSERT INTO work_record_outbox
        (company_id, project_id, record_id, issue_id, workflow_version, event_key, event_type,
         dispatch_round, dependency_set_revision, blocked_cycle, payload_digest)
        VALUES (${row.companyId}, ${row.projectId}, ${row.recordId}, ${row.issueId}, 3,
          'unknown-version', 'release', 1, 1, 0, 'unknown')`)
        .rejects.toMatchObject({ code: "23514" });
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("upgrades an M1-shaped database without rewriting its records, links, issues, or outbox", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-workflow-v2-upgrade-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`
        DROP TABLE work_record_quality_verdicts,
          work_record_quality_links,
          work_record_execution_intents,
          work_record_dependency_snapshots,
          work_record_dispatch_batch_items,
          work_record_dispatch_batches,
          work_record_quality_items,
          work_record_quality_cycles CASCADE;
        DROP FUNCTION reject_work_record_quality_verdict_mutation();
        DROP INDEX IF EXISTS work_record_outbox_release_uq;
        ALTER TABLE work_record_outbox
          DROP COLUMN workflow_version,
          DROP COLUMN batch_id,
          DROP COLUMN quality_cycle_id,
          DROP COLUMN quality_item_id,
          DROP COLUMN execution_intent_id;
        ALTER TABLE work_record_issue_links
          DROP CONSTRAINT work_record_issue_links_company_project_id_uq;
        CREATE UNIQUE INDEX work_record_outbox_release_uq
          ON work_record_outbox
          (company_id, record_id, dispatch_round, dependency_set_revision, blocked_cycle, event_type);
      `);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;

      const row = await seedBase(sql);
      const outboxId = await insertLegacyOutbox(sql, row);
      const beforeRecord = await sql`SELECT * FROM work_records WHERE id = ${row.recordId}`;
      const beforeIssue = await sql`SELECT * FROM issues WHERE id = ${row.issueId}`;
      const beforeLink = await sql`SELECT * FROM work_record_issue_links WHERE id = ${row.issueLinkId}`;
      const beforeOutbox = await sql`SELECT * FROM work_record_outbox WHERE id = ${outboxId}`;

      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });
      await applyPendingMigrations(database.connectionString);

      expect(await sql`SELECT * FROM work_records WHERE id = ${row.recordId}`).toEqual(beforeRecord);
      expect(await sql`SELECT * FROM issues WHERE id = ${row.issueId}`).toEqual(beforeIssue);
      expect(await sql`SELECT * FROM work_record_issue_links WHERE id = ${row.issueLinkId}`).toEqual(beforeLink);
      const [upgradedOutbox] = await sql`SELECT * FROM work_record_outbox WHERE id = ${outboxId}`;
      expect(upgradedOutbox).toMatchObject({
        ...beforeOutbox[0],
        workflow_version: 1,
        batch_id: null,
        quality_cycle_id: null,
        quality_item_id: null,
        execution_intent_id: null,
      });
      expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
