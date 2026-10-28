import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import {
  agents,
  closeRegisteredClients,
  companies,
  createDb,
  projects,
  startEmbeddedPostgresTestDatabase,
  workRecordExecutionIntents,
  workRecordOutbox,
} from "../../packages/db/src/index.js";
import type { PreviewWorkPackageDispatch } from "../../packages/shared/src/index.js";
import { workPackageDispatchService } from "../../server/src/services/work-package-dispatch.js";
import { workRecordService } from "../../server/src/services/work-records.js";

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
    if (child.exitCode !== null) throw new Error(`Old binary exited before health check: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const health = await response.json() as {
          status?: string;
          startupRecovery?: { phase?: string };
        };
        if (health.status === "ok" && health.startupRecovery?.phase === "ready") return health;
      }
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Old binary health check timed out: ${output()}`);
}

const oldRoot = process.env.PAPERCLIP_OLD_BINARY_ROOT?.trim();
const evidenceDir = process.env.PAPERCLIP_M2E_EVIDENCE_DIR?.trim();
if (!oldRoot) throw new Error("PAPERCLIP_OLD_BINARY_ROOT is required");
if (!evidenceDir) throw new Error("PAPERCLIP_M2E_EVIDENCE_DIR is required");

const oldCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: oldRoot, encoding: "utf8" }).trim();
const workflowV2FeatureFlagEvidence = execFileSync("git", [
  "grep",
  "-n",
  "PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED",
  "HEAD",
  "--",
  "server/src",
], { cwd: oldRoot, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
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
const db = createDb(database.connectionString);
let child: ChildProcess | null = null;
let stdout = "";
let stderr = "";

try {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  const company = await db.insert(companies).values({ name: `M2-E rollback ${suffix}`, issuePrefix: `R${suffix}` })
    .returning().then((rows) => rows[0]);
  const project = await db.insert(projects).values({ companyId: company.id, name: "Old binary rollback drill" })
    .returning().then((rows) => rows[0]);
  const agent = await db.insert(agents).values({
    companyId: company.id,
    name: "Rollback drill agent",
    status: "idle",
    adapterType: "process",
    adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
  }).returning().then((rows) => rows[0]);
  const records = workRecordService(db);
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
  const packages = workPackageDispatchService(db, { writesEnabled: true });
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

  await db.update(workRecordOutbox).set({ state: "superseded", updatedAt: new Date() });
  await db.update(workRecordExecutionIntents).set({ state: "superseded", supersededAt: new Date(), updatedAt: new Date() });
  const drainedPreflight = await packages.operationsMetrics(company.id, project.id);
  if (!drainedPreflight.rollback.safeForOldBinary) throw new Error("Old binary gate remained closed after the isolated drain");

  const port = await availableLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tsxCli = path.join(oldRoot, "server", "node_modules", "tsx", "dist", "cli.mjs");
  child = spawn(process.execPath, [tsxCli, path.join(oldRoot, "server", "src", "index.ts")], {
    cwd: oldRoot,
    env: {
      ...process.env,
      DATABASE_URL: database.connectionString,
      PORT: String(port),
      HOST: "127.0.0.1",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_MIGRATION_PROMPT: "never",
      PAPERCLIP_MIGRATION_AUTO_APPLY: "false",
      PAPERCLIP_INSTANCE_ID: `m2e-old-binary-${suffix.toLowerCase()}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const health = await waitForHealth(baseUrl, child, () => `${stdout}\n${stderr}`);
  const listResponse = await fetch(`${baseUrl}/api/companies/${company.id}/projects/${project.id}/work-records`);
  if (!listResponse.ok) throw new Error(`Old binary list failed: ${listResponse.status} ${await listResponse.text()}`);
  const listed = await listResponse.json() as Array<{ id: string }>;
  if (!listed.some((record) => record.id === legacyRecord.id)) throw new Error("Old binary did not retain the M1-compatible record");

  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "old-binary-rollback.json"), `${JSON.stringify({
    schemaVersion: 1,
    testedCommit: process.env.PAPERCLIP_M2E_TESTED_COMMIT ?? null,
    oldBinaryCommit: oldCommit,
    isolatedPort: port,
    databaseIdentity: new URL(database.connectionString).pathname,
    blockedPreflight: blockedPreflight.rollback,
    drainedPreflight: drainedPreflight.rollback,
    oldBinary: {
      health,
      listedRecordCount: listed.length,
      retainedLegacyRecordId: legacyRecord.id,
      workflowV2FeatureFlagPresentByCommit: workflowV2FeatureFlagEvidence.length > 0,
      workflowV2FeatureFlagEvidence,
    },
  }, null, 2)}\n`, "utf8");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child?.pid) process.kill(child.pid, "SIGKILL");
        resolve();
      }, 5_000);
      timer.unref?.();
      child!.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  await closeRegisteredClients(database.connectionString);
  await database.cleanup();
}
