import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq, sql } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  agents,
  closeRegisteredClients,
  companies,
  createDb,
  ensurePostgresDatabase,
  projects,
  resetPostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
  startEmbeddedPostgresTestDatabase,
  workRecordExecutionIntents,
  workRecordOutbox,
} from "../../packages/db/src/index.js";
import type { PreviewWorkPackageDispatch } from "../../packages/shared/src/index.js";
import { workPackageDispatchService } from "../../server/src/services/work-package-dispatch.js";
import { workRecordService } from "../../server/src/services/work-records.js";
import {
  captureQualifiedServerProcess,
  requireM2eTestedCommit,
  stopAndVerifyQualifiedServer,
} from "./work-record-qualification-process.js";

const ROLLBACK_MIGRATION = "0295_serious_swordsman";
const ROLLBACK_MIGRATION_CREATED_AT = 1_793_194_458_579;
const OLD_BINARY_LAST_MIGRATION = "0294_lively_rhino";

type ProcessLog = { stdout: string; stderr: string; pipeErrors: string[] };
type MigrationJournalEntry = { tag: string; when: number };
type MigrationJournalRow = { id: number; hash: string; created_at: string | number; name?: string | null };

async function availableLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a rollback drill port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Old binary exited before health check: ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers: { connection: "close" } });
      if (response.ok) {
        const health = await response.json() as { status?: string; startupRecovery?: { phase?: string } };
        if (health.status === "ok" && health.startupRecovery?.phase === "ready") return health;
      }
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Old binary health check timed out: ${output()}`);
}

async function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      resolve();
    }, 5_000);
    timer.unref?.();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function errorChain(error: unknown) {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { message?: unknown; code?: unknown; cause?: unknown };
    messages.push(`${typeof candidate.code === "string" ? `${candidate.code}: ` : ""}${String(candidate.message ?? current)}`);
    current = candidate.cause;
  }
  return messages.join(" <- ");
}

async function ensureStableMigrationIdentity(
  connectionString: string,
  journalEntries: MigrationJournalEntry[],
  injectFailure = false,
) {
  const database = createDb(connectionString);
  try {
    return await database.transaction(async (tx) => {
      const [gate] = await tx.execute<{ actionable_outbox: number; active_intents: number }>(sql`
        select
          (select count(*)::int from work_record_outbox
            where workflow_version = 2 and state in ('pending', 'retry', 'processing', 'dead_letter')) as actionable_outbox,
          (select count(*)::int from work_record_execution_intents
            where state in ('pending', 'waiting_dependencies', 'waiting_governance', 'ready', 'queued', 'running')) as active_intents
      `);
      if (Number(gate?.actionable_outbox ?? 0) !== 0 || Number(gate?.active_intents ?? 0) !== 0) {
        throw new Error("Stable migration identity refused: workflow-v2 state is not drained");
      }

      const rows = await tx.execute<MigrationJournalRow>(sql`
        select id, hash, created_at from drizzle.__drizzle_migrations order by id
      `);
      const entriesByCreatedAt = new Map<number, MigrationJournalEntry>();
      for (const entry of journalEntries) {
        if (entriesByCreatedAt.has(entry.when)) {
          throw new Error(`Migration journal has duplicate timestamp ${entry.when}`);
        }
        entriesByCreatedAt.set(entry.when, entry);
      }
      const mappings = Array.from(rows, (row) => ({
        id: Number(row.id),
        hash: row.hash,
        createdAt: Number(row.created_at),
        entry: entriesByCreatedAt.get(Number(row.created_at)),
      }));
      const unmapped = mappings.filter((row) => !row.entry);
      if (unmapped.length > 0) {
        throw new Error(`Stable migration identity could not map journal rows: ${JSON.stringify(unmapped.slice(0, 10))}`);
      }

      await tx.execute(sql`alter table drizzle.__drizzle_migrations add column if not exists name text`);
      for (const row of mappings) {
        await tx.execute(sql`
          update drizzle.__drizzle_migrations set name = ${`${row.entry!.tag}.sql`} where id = ${row.id}
        `);
      }
      const [verified] = await tx.execute<{
        total: number;
        named: number;
        distinct_names: number;
        latest_name: string | null;
        latest_created_at: string | number | null;
      }>(sql`
        select count(*)::int as total,
          count(name)::int as named,
          count(distinct name)::int as distinct_names,
          (array_agg(name order by id desc))[1] as latest_name,
          max(created_at) as latest_created_at
        from drizzle.__drizzle_migrations
      `);
      if (
        Number(verified?.total ?? 0) !== mappings.length
        || Number(verified?.named ?? 0) !== mappings.length
        || Number(verified?.distinct_names ?? 0) !== mappings.length
        || verified?.latest_name !== `${ROLLBACK_MIGRATION}.sql`
        || Number(verified?.latest_created_at ?? -1) !== ROLLBACK_MIGRATION_CREATED_AT
      ) {
        throw new Error(`Stable migration identity verification failed: ${JSON.stringify(verified)}`);
      }

      const details = JSON.stringify({
        schemaVersion: 1,
        namedMigrationRows: mappings.length,
        latestMigration: `${ROLLBACK_MIGRATION}.sql`,
        latestCreatedAt: ROLLBACK_MIGRATION_CREATED_AT,
        schemaDowngradeApplied: false,
      });
      await tx.execute(sql`
        insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
        select id, 'system', 'm2e-old-binary-rollback',
          'migration_journal.stable_identity_backfilled', 'company', id::text, cast(${details} as jsonb)
        from companies
      `);

      if (injectFailure) throw new Error("Injected stable migration identity failure");
      return {
        namedMigrationRows: mappings.length,
        latestMigration: verified!.latest_name!,
        latestCreatedAt: Number(verified!.latest_created_at),
      };
    });
  } finally {
    await closeRegisteredClients(connectionString);
  }
}

async function compatibilityState(connectionString: string) {
  const database = createDb(connectionString);
  try {
    const [nameColumn] = await database.execute<{ exists: boolean }>(sql`
      select exists(select 1 from information_schema.columns
        where table_schema = 'drizzle' and table_name = '__drizzle_migrations' and column_name = 'name') as exists
    `);
    const [nameState] = nameColumn?.exists
      ? await database.execute<{ latest_name: string | null; named: number; distinct_names: number }>(sql`
          select (array_agg(name order by id desc))[1] as latest_name,
            count(name) filter (where btrim(name) <> '')::int as named,
            count(distinct name) filter (where btrim(name) <> '')::int as distinct_names
          from drizzle.__drizzle_migrations
        `)
      : [{ latest_name: null, named: 0, distinct_names: 0 }];
    const [state] = await database.execute<{
      latest_created_at: string | number | null;
      migration_rows: number;
      rollback_columns: number;
      rollback_indexes: number;
      rollback_constraints: number;
      identity_audit_facts: number;
      retained_records: number;
    }>(sql`
      select
        (select max(created_at) from drizzle.__drizzle_migrations) as latest_created_at,
        (select count(*)::int from drizzle.__drizzle_migrations) as migration_rows,
        (select count(*)::int from information_schema.columns
          where table_schema = 'public' and table_name = 'work_record_outbox'
            and column_name in ('recovery_count', 'dead_lettered_at', 'last_recovered_at')) as rollback_columns,
        (select count(*)::int from pg_indexes
          where schemaname = 'public' and indexname = 'work_record_outbox_project_state_idx') as rollback_indexes,
        (select count(*)::int
          from pg_constraint constraint_definition
          join pg_class relation on relation.oid = constraint_definition.conrelid
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'public'
            and relation.relname = 'work_record_outbox'
            and constraint_definition.conname = 'work_record_outbox_state_check') as rollback_constraints,
        (select count(*)::int from activity_log
          where action = 'migration_journal.stable_identity_backfilled') as identity_audit_facts,
        (select count(*)::int from work_records) as retained_records
    `);
    return {
      latestCreatedAt: Number(state?.latest_created_at ?? -1),
      latestName: nameState?.latest_name ?? null,
      migrationRows: Number(state?.migration_rows ?? 0),
      migrationNameColumn: Boolean(nameColumn?.exists),
      namedMigrationRows: Number(nameState?.named ?? 0),
      distinctMigrationNames: Number(nameState?.distinct_names ?? 0),
      rollbackColumns: Number(state?.rollback_columns ?? 0),
      rollbackIndexes: Number(state?.rollback_indexes ?? 0),
      rollbackConstraints: Number(state?.rollback_constraints ?? 0),
      identityAuditFacts: Number(state?.identity_audit_facts ?? 0),
      retainedRecords: Number(state?.retained_records ?? 0),
    };
  } finally {
    await closeRegisteredClients(connectionString);
  }
}

async function oldCheckoutHashMismatches(
  connectionString: string,
  oldRoot: string,
  journalEntries: MigrationJournalEntry[],
) {
  const database = createDb(connectionString);
  try {
    const rows = await database.execute<MigrationJournalRow>(sql`
      select id, hash, created_at, name from drizzle.__drizzle_migrations order by id
    `);
    const availableOldMigrations = new Set(
      JSON.parse(await readFile(path.join(oldRoot, "packages", "db", "src", "migrations", "meta", "_journal.json"), "utf8"))
        .entries.map((entry: { tag: string }) => `${entry.tag}.sql`),
    );
    const tagsByCreatedAt = new Map(journalEntries.map((entry) => [entry.when, `${entry.tag}.sql`]));
    const mismatches: Array<{ migration: string; databaseHash: string; oldCheckoutHash: string }> = [];
    for (const row of rows) {
      const migration = row.name ?? tagsByCreatedAt.get(Number(row.created_at));
      if (!migration || !availableOldMigrations.has(migration)) continue;
      const oldCheckoutHash = sha256(await readFile(path.join(oldRoot, "packages", "db", "src", "migrations", migration)));
      if (oldCheckoutHash !== row.hash) mismatches.push({ migration, databaseHash: row.hash, oldCheckoutHash });
    }
    return mismatches;
  } finally {
    await closeRegisteredClients(connectionString);
  }
}

async function effectiveWorkflowExecution(connectionString: string) {
  const database = createDb(connectionString);
  try {
    const [counts] = await database.execute<{ effective_wakes: number; effective_runs: number }>(sql`
      select
        count(distinct w.id) filter (where w.status in ('queued', 'claimed', 'completed'))::int as effective_wakes,
        count(distinct r.id) filter (where r.status in ('queued', 'running', 'succeeded'))::int as effective_runs
      from work_record_execution_intents i
      left join agent_wakeup_requests w
        on w.company_id = i.company_id
       and w.idempotency_key = ('work-record-intent:' || i.id::text || ':' || i.generation::text)
      left join heartbeat_runs r on r.company_id = i.company_id and r.wakeup_request_id = w.id
    `);
    return {
      effectiveWakes: Number(counts?.effective_wakes ?? 0),
      effectiveRuns: Number(counts?.effective_runs ?? 0),
    };
  } finally {
    await closeRegisteredClients(connectionString);
  }
}

async function inspectWithOldCheckout(connectionString: string, oldRoot: string, evidenceDir: string) {
  const inspectScript = path.join(evidenceDir, "inspect-old-migrations.mts");
  const oldDbEntry = pathToFileURL(path.join(oldRoot, "packages", "db", "src", "index.ts")).href;
  await writeFile(inspectScript, [
    `import { inspectMigrations } from ${JSON.stringify(oldDbEntry)};`,
    "const state = await inspectMigrations(process.env.DATABASE_URL!);",
    "process.stdout.write(JSON.stringify(state));",
  ].join("\n"), "utf8");
  const tsxCli = path.join(oldRoot, "server", "node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync(process.execPath, [tsxCli, inspectScript], {
    cwd: oldRoot,
    env: { ...process.env, DATABASE_URL: connectionString, FORCE_COLOR: "0", NO_COLOR: "1" },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Old checkout migration inspection failed: ${result.stderr || result.stdout}`);
  const state = JSON.parse(result.stdout) as { status?: string; pendingMigrations?: string[] };
  if (state.status !== "upToDate") {
    throw new Error(`Old checkout did not accept the rollback schema without repair or auto-apply: ${result.stdout}`);
  }
  return state;
}

const oldRoot = process.env.PAPERCLIP_OLD_BINARY_ROOT?.trim();
const approvedOldCommit = process.env.PAPERCLIP_OLD_BINARY_COMMIT?.trim();
const evidenceDir = process.env.PAPERCLIP_M2E_EVIDENCE_DIR?.trim();
if (!oldRoot) throw new Error("PAPERCLIP_OLD_BINARY_ROOT is required");
if (!approvedOldCommit) throw new Error("PAPERCLIP_OLD_BINARY_COMMIT is required");
if (!evidenceDir) throw new Error("PAPERCLIP_M2E_EVIDENCE_DIR is required");
const testedCommit = requireM2eTestedCommit({ repoRoot: process.cwd() });

const oldCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: oldRoot, encoding: "utf8" }).trim();
if (oldCommit !== approvedOldCommit) {
  throw new Error(`Old binary commit ${oldCommit} does not match approved rollback commit ${approvedOldCommit}`);
}
const oldJournal = JSON.parse(await readFile(path.join(oldRoot, "packages", "db", "src", "migrations", "meta", "_journal.json"), "utf8")) as {
  entries?: Array<{ tag?: string; when?: number }>;
};
const oldLastMigration = oldJournal.entries?.at(-1)?.tag;
if (oldLastMigration !== OLD_BINARY_LAST_MIGRATION || oldJournal.entries?.some((entry) => entry.tag === ROLLBACK_MIGRATION)) {
  throw new Error(`Approved old checkout migration boundary is not ${OLD_BINARY_LAST_MIGRATION}`);
}
const currentJournal = JSON.parse(await readFile(
  path.join(process.cwd(), "packages", "db", "src", "migrations", "meta", "_journal.json"),
  "utf8",
)) as { entries?: Array<{ tag?: string; when?: number }> };
const currentJournalEntries = (currentJournal.entries ?? []).map((entry) => {
  if (!entry.tag || !Number.isFinite(entry.when)) throw new Error(`Current migration journal contains an invalid entry: ${JSON.stringify(entry)}`);
  return { tag: entry.tag, when: entry.when! };
});
if (currentJournalEntries.at(-1)?.tag !== ROLLBACK_MIGRATION) {
  throw new Error(`Current checkout migration boundary is not ${ROLLBACK_MIGRATION}`);
}
const requireFromOldServer = createRequire(path.join(oldRoot, "server", "package.json"));
const resolvedOldDb = requireFromOldServer.resolve("@paperclipai/db");
if (!path.resolve(resolvedOldDb).toLowerCase().startsWith(path.resolve(oldRoot).toLowerCase())) {
  throw new Error(`Old checkout dependencies are not self-contained: @paperclipai/db resolved to ${resolvedOldDb}`);
}
const workflowV2FeatureFlagEvidence = execFileSync("git", [
  "grep",
  "-n",
  "PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED",
  "HEAD",
  "--",
  "server/src",
], { cwd: oldRoot, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
await mkdir(evidenceDir, { recursive: true });
const backupDir = path.join(evidenceDir, "backups");
await mkdir(backupDir, { recursive: true });
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
let databaseError: unknown;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  try {
    database = await startEmbeddedPostgresTestDatabase(`paperclip-m2e-old-binary-${attempt}-`);
    break;
  } catch (error) {
    databaseError = error;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (!database) throw databaseError;
const sourceUrl = new URL(database.connectionString);
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const targetName = `m2e_old_${randomUUID().replaceAll("-", "")}`;
const failedTargetName = `m2e_old_fail_${randomUUID().replaceAll("-", "")}`;
const targetUrl = new URL(sourceUrl);
targetUrl.pathname = `/${targetName}`;
const failedTargetUrl = new URL(sourceUrl);
failedTargetUrl.pathname = `/${failedTargetName}`;
let child: ChildProcess | null = null;
const processLog: ProcessLog = { stdout: "", stderr: "", pipeErrors: [] };

try {
  await ensurePostgresDatabase(adminUrl.toString(), targetName);
  await ensurePostgresDatabase(adminUrl.toString(), failedTargetName);
  const sourceDb = createDb(sourceUrl.toString());
  const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  const company = await sourceDb.insert(companies).values({ name: `M2-E rollback ${suffix}`, issuePrefix: `R${suffix}` })
    .returning().then((rows) => rows[0]);
  const project = await sourceDb.insert(projects).values({ companyId: company.id, name: "Old binary rollback drill" })
    .returning().then((rows) => rows[0]);
  const agent = await sourceDb.insert(agents).values({
    companyId: company.id,
    name: "Rollback drill agent",
    status: "idle",
    adapterType: "process",
    adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 60, wakeOnDemand: true } },
  }).returning().then((rows) => rows[0]);
  const records = workRecordService(sourceDb);
  const legacyRecord = await records.create(company.id, {
    projectId: project.id,
    kind: "plan",
    title: "M1-compatible retained record",
    assigneeAgentId: agent.id,
  }, { actorType: "system", actorId: "m2e-old-binary-drill" });
  const v2Record = await records.create(company.id, {
    projectId: project.id,
    kind: "plan",
    title: "Workflow-v2 rollback gate record",
    assigneeAgentId: agent.id,
  }, { actorType: "system", actorId: "m2e-old-binary-drill" });
  const packages = workPackageDispatchService(sourceDb, { writesEnabled: true });
  const command: PreviewWorkPackageDispatch = {
    workflowVersion: 2,
    projectId: project.id,
    scopeKind: "selected_records",
    rootRecordId: null,
    selectedRecordIds: [v2Record.id],
  };
  const preview = await packages.preview(company.id, project.id, command);
  await packages.prepare(company.id, project.id, {
    ...command,
    clientRequestId: "m2e-old-binary-rollback",
    requestPayloadDigest: "m2e-old-binary-rollback",
    expectedScopeDigest: preview.scopeDigest,
    expectedRootRevision: preview.rootRevision,
    expectedDependencySetRevision: preview.dependencySetRevision,
  }, { actorType: "system", actorId: "m2e-old-binary-drill" });
  const blockedPreflight = await packages.operationsMetrics(company.id, project.id);
  if (blockedPreflight.rollback.safeForOldBinary) throw new Error("Old binary gate unexpectedly allowed active workflow-v2 state");

  const [intent] = await sourceDb.select().from(workRecordExecutionIntents).where(eq(workRecordExecutionIntents.recordId, v2Record.id));
  if (!intent) throw new Error("Workflow-v2 rollback intent was not created");
  const [event] = await sourceDb.select().from(workRecordOutbox).where(eq(workRecordOutbox.executionIntentId, intent.id));
  if (!event) throw new Error("Workflow-v2 rollback event was not created");
  await sourceDb.update(workRecordOutbox).set({ state: "dead_letter", attemptCount: 5, deadLetteredAt: new Date(), updatedAt: new Date() })
    .where(eq(workRecordOutbox.id, event.id));
  const recovered = await packages.recoverOutboxEvent(company.id, project.id, event.id, {
    expectedAttemptCount: 5,
    reasonCode: "rollback_recovery",
  });
  await sourceDb.update(workRecordOutbox).set({ state: "superseded", updatedAt: new Date() });
  await sourceDb.update(workRecordExecutionIntents).set({ state: "superseded", supersededAt: new Date(), updatedAt: new Date() });
  const drainedPreflight = await packages.operationsMetrics(company.id, project.id);
  if (!drainedPreflight.rollback.safeForOldBinary) throw new Error("Old binary gate remained closed after the isolated drain");
  const sourceStateBefore = await compatibilityState(sourceUrl.toString());

  const backup = await runDatabaseBackup({
    connectionString: sourceUrl.toString(),
    backupDir,
    retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
    filenamePrefix: "workflow-v2-old-binary",
  });
  const backupSha256 = sha256(await readFile(backup.backupFile));

  await runDatabaseRestore({ connectionString: failedTargetUrl.toString(), backupFile: backup.backupFile });
  const failureStateBefore = await compatibilityState(failedTargetUrl.toString());
  let injectedFailure = "";
  try {
    await ensureStableMigrationIdentity(
      failedTargetUrl.toString(),
      currentJournalEntries,
      true,
    );
  } catch (error) {
    injectedFailure = errorChain(error);
  }
  if (!injectedFailure.includes("Injected stable migration identity failure")) {
    throw new Error(`Stable migration identity failure probe did not fail as expected: ${injectedFailure}`);
  }
  const failureState = await compatibilityState(failedTargetUrl.toString());
  if (JSON.stringify(failureState) !== JSON.stringify(failureStateBefore)) {
    throw new Error(`Injected identity failure left a half-mutated database: ${JSON.stringify({ failureStateBefore, failureState })}`);
  }
  await resetPostgresDatabase(adminUrl.toString(), failedTargetName);

  await runDatabaseRestore({ connectionString: targetUrl.toString(), backupFile: backup.backupFile });
  const targetStateBefore = await compatibilityState(targetUrl.toString());
  const stableIdentity = await ensureStableMigrationIdentity(targetUrl.toString(), currentJournalEntries);
  const compatibleState = await compatibilityState(targetUrl.toString());
  if (
    compatibleState.latestCreatedAt !== ROLLBACK_MIGRATION_CREATED_AT
    || compatibleState.latestName !== `${ROLLBACK_MIGRATION}.sql`
    || !compatibleState.migrationNameColumn
    || compatibleState.namedMigrationRows !== compatibleState.migrationRows
    || compatibleState.distinctMigrationNames !== compatibleState.migrationRows
    || compatibleState.rollbackColumns !== 3
    || compatibleState.rollbackIndexes !== 1
    || compatibleState.rollbackConstraints !== 1
    || compatibleState.rollbackColumns !== targetStateBefore.rollbackColumns
    || compatibleState.rollbackIndexes !== targetStateBefore.rollbackIndexes
    || compatibleState.rollbackConstraints !== targetStateBefore.rollbackConstraints
    || compatibleState.identityAuditFacts < 1
    || compatibleState.retainedRecords < 2
  ) {
    throw new Error(`Stable-identity rollback target did not preserve ${ROLLBACK_MIGRATION}: ${JSON.stringify(compatibleState)}`);
  }
  const hashMismatches = await oldCheckoutHashMismatches(targetUrl.toString(), oldRoot, currentJournalEntries);
  const oldMigrationState = await inspectWithOldCheckout(targetUrl.toString(), oldRoot, evidenceDir);
  const executionBefore = await effectiveWorkflowExecution(targetUrl.toString());

  const port = await availableLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tsxCli = path.join(oldRoot, "server", "node_modules", "tsx", "dist", "cli.mjs");
  child = spawn(process.execPath, [tsxCli, path.join(oldRoot, "server", "src", "index.ts")], {
    cwd: oldRoot,
    env: {
      ...process.env,
      DATABASE_URL: targetUrl.toString(),
      PORT: String(port),
      HOST: "127.0.0.1",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_MIGRATION_PROMPT: "never",
      PAPERCLIP_MIGRATION_AUTO_APPLY: "false",
      PAPERCLIP_INSTANCE_ID: `m2e-old-binary-${suffix.toLowerCase()}`,
      PAPERCLIP_DB_BACKUP_ENABLED: "false",
      PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED: "false",
      PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS: "",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const runningChild = child;
  runningChild.stdout?.on("data", (chunk) => { processLog.stdout += String(chunk); });
  runningChild.stderr?.on("data", (chunk) => { processLog.stderr += String(chunk); });
  for (const stream of [runningChild.stdout, runningChild.stderr]) {
    stream?.on("error", (error: NodeJS.ErrnoException) => {
      processLog.pipeErrors.push(`${error.code ?? "stream_error"}: ${error.message}`);
    });
  }
  const health = await waitForHealth(baseUrl, runningChild, () => `${processLog.stdout}\n${processLog.stderr}`);
  if (!runningChild.pid || runningChild.exitCode !== null || runningChild.signalCode !== null) {
    throw new Error("Old binary tsx launcher PID was not live after ready health");
  }
  const oldBinaryProcess = await captureQualifiedServerProcess({
    tsxLauncherPid: runningChild.pid,
    port,
  });
  const listResponse = await fetch(`${baseUrl}/api/companies/${company.id}/projects/${project.id}/work-records`, {
    headers: { connection: "close" },
  });
  if (!listResponse.ok) throw new Error(`Old binary list failed: ${listResponse.status} ${await listResponse.text()}`);
  const listed = await listResponse.json() as Array<{ id: string }>;
  if (!listed.some((record) => record.id === legacyRecord.id)) throw new Error("Old binary did not retain the M1-compatible record");
  const executionAfter = await effectiveWorkflowExecution(targetUrl.toString());
  if (executionAfter.effectiveWakes !== executionBefore.effectiveWakes || executionAfter.effectiveRuns !== executionBefore.effectiveRuns) {
    throw new Error(`Old binary created workflow-v2 execution: ${JSON.stringify({ executionBefore, executionAfter })}`);
  }
  const sourceStateAfter = await compatibilityState(sourceUrl.toString());
  if (JSON.stringify(sourceStateAfter) !== JSON.stringify(sourceStateBefore)) {
    throw new Error(`Source database changed during rollback drill: ${JSON.stringify({ sourceStateBefore, sourceStateAfter })}`);
  }
  const oldBinaryExit = await stopAndVerifyQualifiedServer(oldBinaryProcess);
  child = null;

  await writeFile(path.join(evidenceDir, "old-binary-rollback.json"), `${JSON.stringify({
    schemaVersion: 4,
    testedCommit,
    oldBinaryCommit: oldCommit,
    sourceDatabaseIdentity: sourceUrl.pathname,
    rollbackDatabaseIdentity: targetUrl.pathname,
    isolatedPort: port,
    blockedPreflight: blockedPreflight.rollback,
    drainedPreflight: drainedPreflight.rollback,
    backup: { filename: path.basename(backup.backupFile), sha256: backupSha256, sizeBytes: backup.sizeBytes },
    failureWithdrawal: {
      injectedFailure,
      transactionRestoredOriginalState: true,
      stateBeforeFailure: failureStateBefore,
      stateAfterFailure: failureState,
      failedTargetResetToEmpty: true,
    },
    compatibility: {
      stableIdentity,
      preservedMigration: ROLLBACK_MIGRATION,
      schemaDowngradeApplied: false,
      oldCheckoutHashMismatchCount: hashMismatches.length,
      oldCheckoutHashMismatches: hashMismatches,
      oldCheckoutMigrationState: oldMigrationState,
      stateBeforeStableIdentity: targetStateBefore,
      state: compatibleState,
      recoveryAudit: {
        eventId: recovered.id,
        recoveryCount: recovered.recoveryCount,
        lastRecoveredAt: recovered.lastRecoveredAt,
        retained0295RecoveryColumns: compatibleState.rollbackColumns,
      },
    },
    reversibility: {
      sourceDatabaseUnchanged: true,
      sourceStateBefore,
      sourceStateAfter,
      rollbackTargetCanBeDiscarded: true,
    },
    oldBinary: {
      pid: oldBinaryProcess.actualListenerPid,
      launcherPid: oldBinaryProcess.tsxLauncherPid,
      process: oldBinaryProcess,
      exit: oldBinaryExit,
      health,
      listedRecordCount: listed.length,
      retainedLegacyRecordId: legacyRecord.id,
      workflowV2FeatureFlagPresentByCommit: workflowV2FeatureFlagEvidence.length > 0,
      workflowV2FeatureFlagEvidence,
      executionBefore,
      executionAfter,
    },
  }, null, 2)}\n`, "utf8");
} finally {
  await stopChild(child);
  await writeFile(path.join(evidenceDir, "old-binary-server.log"), [
    processLog.stdout,
    processLog.stderr,
    `pipeErrors=${JSON.stringify(processLog.pipeErrors)}`,
    "",
  ].join("\n"), "utf8").catch(() => {});
  await closeRegisteredClients(targetUrl.toString()).catch(() => {});
  await closeRegisteredClients(failedTargetUrl.toString()).catch(() => {});
  await closeRegisteredClients(sourceUrl.toString()).catch(() => {});
  await database.cleanup();
}
