import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { closeRegisteredClients, createDb, inspectMigrations, applyPendingMigrations, runDatabaseRestore } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { expandHomePrefix } from "../config/home.js";
import { readConfig } from "../config/store.js";
import { printPaperclipCliBanner } from "../utils/banner.js";

type DbRestoreOptions = {
  config?: string;
  backup: string;
  expectedSha256: string;
  secretsKeyFile?: string;
  expectedSecretsKeySha256?: string;
  expectedCompanyId?: string;
  apply?: boolean;
  yes?: boolean;
  json?: boolean;
};

function resolveConnectionString(configPath?: string) {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return envUrl;
  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return config.database.connectionString.trim();
  }
  const port = config?.database.embeddedPostgresPort ?? 54329;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

async function sha256File(filename: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function verifyReadableBackup(filename: string) {
  if (!filename.endsWith(".gz")) return;
  await pipeline(
    createReadStream(filename),
    createGunzip(),
    new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
  );
}

function requireSha256(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} 必须是 64 个字符的 SHA-256 摘要。`);
  return normalized;
}

export async function inspectDatabaseRestoreInputs(opts: Pick<
  DbRestoreOptions,
  "backup" | "expectedSha256" | "secretsKeyFile" | "expectedSecretsKeySha256"
>) {
  const backupFile = path.resolve(expandHomePrefix(opts.backup.trim()));
  if (!existsSync(backupFile) || !statSync(backupFile).isFile()) throw new Error("备份文件不存在。");
  const expectedSha256 = requireSha256(opts.expectedSha256, "--expected-sha256");
  const actualSha256 = await sha256File(backupFile);
  if (actualSha256 !== expectedSha256) throw new Error("备份文件的 SHA-256 与已批准清单不一致。");
  await verifyReadableBackup(backupFile);

  let secretsKey: { path: string; sha256: string } | null = null;
  if (opts.secretsKeyFile || opts.expectedSecretsKeySha256) {
    if (!opts.secretsKeyFile || !opts.expectedSecretsKeySha256) {
      throw new Error("必须同时提供 --secrets-key-file 和 --expected-secrets-key-sha256。");
    }
    const keyFile = path.resolve(expandHomePrefix(opts.secretsKeyFile.trim()));
    if (!existsSync(keyFile) || !statSync(keyFile).isFile() || statSync(keyFile).size === 0) {
      throw new Error("密钥主密钥文件缺失或为空。");
    }
    const expectedKeySha256 = requireSha256(opts.expectedSecretsKeySha256, "--expected-secrets-key-sha256");
    const actualKeySha256 = await sha256File(keyFile);
    if (actualKeySha256 !== expectedKeySha256) throw new Error("密钥主密钥文件的 SHA-256 与已批准清单不一致。");
    secretsKey = { path: keyFile, sha256: actualKeySha256 };
  }
  return { backupFile, backupSizeBytes: statSync(backupFile).size, backupSha256: actualSha256, secretsKey };
}

export async function dbRestoreCommand(opts: DbRestoreOptions): Promise<void> {
  const interactiveOutput = !opts.json;
  if (interactiveOutput) {
    printPaperclipCliBanner();
    p.intro(pc.bgCyan(pc.black(" Alice 数据库恢复 ")));
  }
  const inspected = await inspectDatabaseRestoreInputs(opts);
  const connectionString = resolveConnectionString(opts.config);
  const database = createDb(connectionString);
  try {
    const [{ count }] = await database.execute<{ count: number }>(sql`
      select count(*)::int as count
      from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema')
        and not (table_schema = 'drizzle' and table_name = '__drizzle_migrations')
    `);
    if (Number(count) !== 0) throw new Error("恢复目标不为空，拒绝覆盖。");

    if (!opts.apply) {
      const result = { mode: "dry-run", targetEmpty: true, ...inspected };
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      if (interactiveOutput) p.outro(pc.green("恢复预检通过，未写入任何数据。"));
      return;
    }
    if (!opts.yes) throw new Error("批准的停机窗口开始后，--apply 必须同时使用 --yes。");
    await runDatabaseRestore({ connectionString, backupFile: inspected.backupFile });
    const migrationBefore = await inspectMigrations(connectionString);
    if (migrationBefore.status === "needsMigrations") await applyPendingMigrations(connectionString);
    const migrationAfter = await inspectMigrations(connectionString);
    if (migrationAfter.status !== "upToDate") throw new Error("恢复后的数据库迁移记录不是最新状态。");

    let expectedCompanyPresent: boolean | null = null;
    if (opts.expectedCompanyId) {
      const rows = await database.execute<{ present: boolean }>(sql`
        select exists(select 1 from companies where id = ${opts.expectedCompanyId}) as present
      `);
      expectedCompanyPresent = Boolean(rows[0]?.present);
      if (!expectedCompanyPresent) throw new Error("恢复后未找到预期公司。");
    }
    const [workflow] = await database.execute<{ records: number; events: number }>(sql`
      select
        (select count(*)::int from work_records) as records,
        (select count(*)::int from work_record_outbox where workflow_version = 2) as events
    `);
    const result = {
      mode: "applied",
      targetEmptyBeforeRestore: true,
      migrationStatus: migrationAfter.status,
      expectedCompanyPresent,
      workflowRecords: Number(workflow?.records ?? 0),
      workflowV2Events: Number(workflow?.events ?? 0),
      ...inspected,
    };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    if (interactiveOutput) p.outro(pc.green("恢复已执行并验证。"));
  } finally {
    await closeRegisteredClients(connectionString);
  }
}
