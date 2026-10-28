import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeRegisteredClients,
  companies,
  createDb,
  ensurePostgresDatabase,
  runDatabaseBackup,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { dbRestoreCommand, inspectDatabaseRestoreInputs } from "../commands/db-restore.js";

const roots: string[] = [];
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("db:restore preflight", () => {
  it("verifies the approved backup and secrets-key digests without exposing key material", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-db-restore-"));
    roots.push(root);
    const backup = gzipSync("select 1;\n");
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    const backupFile = path.join(root, "approved.sql.gz");
    const keyFile = path.join(root, "master.key");
    await writeFile(backupFile, backup);
    await writeFile(keyFile, key);

    const result = await inspectDatabaseRestoreInputs({
      backup: backupFile,
      expectedSha256: sha256(backup),
      secretsKeyFile: keyFile,
      expectedSecretsKeySha256: sha256(key),
    });
    expect(result).toMatchObject({ backupFile, backupSha256: sha256(backup) });
    expect(JSON.stringify(result)).not.toContain(key.toString("utf8"));
  });

  it("fails closed on checksum drift and incomplete key evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-db-restore-"));
    roots.push(root);
    const backupFile = path.join(root, "approved.sql.gz");
    await writeFile(backupFile, gzipSync("select 1;\n"));
    await expect(inspectDatabaseRestoreInputs({
      backup: backupFile,
      expectedSha256: "0".repeat(64),
    })).rejects.toThrow(/SHA-256/);
    await expect(inspectDatabaseRestoreInputs({
      backup: backupFile,
      expectedSha256: sha256(gzipSync("select 1;\n")),
      secretsKeyFile: path.join(root, "missing.key"),
    })).rejects.toThrow(/supplied together/);
  });

  it("restores an authenticated company backup into an empty isolated PostgreSQL database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-db-restore-"));
    roots.push(root);
    const database = await startEmbeddedPostgresTestDatabase("paperclip-cli-restore-");
    const sourceUrl = new URL(database.connectionString);
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    const targetName = `restore_${randomUUID().replaceAll("-", "")}`;
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = `/${targetName}`;
    const sourceDb = createDb(sourceUrl.toString());
    const company = await sourceDb.insert(companies).values({
      name: "Authenticated restore proof",
      issuePrefix: `R${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]);
    const backup = await runDatabaseBackup({
      connectionString: sourceUrl.toString(),
      backupDir: root,
      filenamePrefix: "authenticated-restore",
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
      backupEngine: "javascript",
    });
    await ensurePostgresDatabase(adminUrl.toString(), targetName);
    const keyFile = path.join(root, "master.key");
    const key = Buffer.from("fedcba9876543210fedcba9876543210", "utf8");
    await writeFile(keyFile, key);
    const backupBody = await readFile(backup.backupFile);
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = targetUrl.toString();
    try {
      await dbRestoreCommand({
        backup: backup.backupFile,
        expectedSha256: sha256(backupBody),
        secretsKeyFile: keyFile,
        expectedSecretsKeySha256: sha256(key),
        expectedCompanyId: company.id,
        apply: true,
        yes: true,
        json: true,
      });
      const restored = createDb(targetUrl.toString());
      expect(await restored.select().from(companies)).toEqual([
        expect.objectContaining({ id: company.id, name: "Authenticated restore proof" }),
      ]);
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      await closeRegisteredClients(targetUrl.toString()).catch(() => {});
      await database.cleanup();
    }
  }, 120_000);
});
