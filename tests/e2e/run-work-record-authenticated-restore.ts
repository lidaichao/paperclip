import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import {
  agents,
  authUsers,
  closeRegisteredClients,
  companies,
  companyMemberships,
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  instanceUserRoles,
  projects,
  startEmbeddedPostgresTestDatabase,
  workRecordExecutionIntents,
  workRecordOutbox,
} from "../../packages/db/src/index.js";
import type { PreviewWorkPackageDispatch } from "../../packages/shared/src/index.js";
import { createBetterAuthInstance } from "../../server/src/auth/better-auth.js";
import type { Config } from "../../server/src/config.js";
import { workPackageDispatchService } from "../../server/src/services/work-package-dispatch.js";
import { workRecordService } from "../../server/src/services/work-records.js";
import {
  captureQualifiedServerProcess,
  requireM2eTestedCommit,
  stopAndVerifyQualifiedServer,
} from "./work-record-qualification-process.js";

type CliResult = {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunningServer = {
  child: ChildProcess;
  baseUrl: string;
  output: () => string;
  pipeErrors: () => string[];
};

const evidenceDir = process.env.PAPERCLIP_M2E_EVIDENCE_DIR?.trim();
if (!evidenceDir) throw new Error("PAPERCLIP_M2E_EVIDENCE_DIR is required");

const repoRoot = process.cwd();
const testedCommit = requireM2eTestedCommit({ repoRoot });
const cliTsx = path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs");
const serverTsx = path.join(repoRoot, "server", "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = path.join(repoRoot, "cli", "src", "index.ts");
const serverEntry = path.join(repoRoot, "server", "src", "index.ts");
const authSecret = `m2e-auth-${randomUUID()}-${randomUUID()}`;
const email = `m2e-restore-${randomUUID()}@paperclip.test`;
const password = `m2e-password-${randomUUID()}`;

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filename: string) {
  return sha256(await readFile(filename));
}

async function availableLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate an isolated port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function runCli(args: string[], databaseUrl: string): CliResult {
  const result = spawnSync(process.execPath, [cliTsx, cliEntry, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    args,
    exitCode: result.status ?? -1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function parsePureJson(result: CliResult) {
  if (result.exitCode !== 0) {
    throw new Error(`CLI command failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`CLI stdout was not pure JSON: ${result.stdout}`, { cause: error });
  }
}

function startServer(input: {
  connectionString: string;
  keyFile: string;
  instanceId: string;
  home: string;
  port: number;
  logFile: string;
}): RunningServer {
  const baseUrl = `http://127.0.0.1:${input.port}`;
  const logFd = openSync(input.logFile, "w");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [serverTsx, serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: input.connectionString,
        PORT: String(input.port),
        HOST: "127.0.0.1",
        PAPERCLIP_HOME: input.home,
        PAPERCLIP_INSTANCE_ID: input.instanceId,
        PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
        PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
        PAPERCLIP_AUTH_BASE_URL_MODE: "explicit",
        PAPERCLIP_PUBLIC_URL: baseUrl,
        BETTER_AUTH_URL: baseUrl,
        BETTER_AUTH_SECRET: authSecret,
        PAPERCLIP_AUTH_RATE_LIMIT_ENABLED: "false",
        PAPERCLIP_SECRETS_MASTER_KEY_FILE: input.keyFile,
        PAPERCLIP_SECRETS_STRICT_MODE: "true",
        PAPERCLIP_DB_BACKUP_ENABLED: "false",
        PAPERCLIP_MIGRATION_PROMPT: "never",
        PAPERCLIP_MIGRATION_AUTO_APPLY: "false",
        PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED: "false",
        PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS: "",
        PAPERCLIP_E2E_OWNS_WORK_RECORD_TICK: "true",
        HEARTBEAT_SCHEDULER_ENABLED: "false",
        PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
  return {
    child,
    baseUrl,
    output: () => {
      try {
        return readFileSync(input.logFile, "utf8");
      } catch (error) {
        return `Could not read server log: ${String(error)}`;
      }
    },
    pipeErrors: () => [],
  };
}

async function stopServer(server: RunningServer | null) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (server.child.pid) {
        try {
          process.kill(server.child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      resolve();
    }, 5_000);
    timer.unref?.();
    server.child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function isRetryableLoopbackError(error: unknown) {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown; message?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code : "";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (["ECONNRESET", "ENOTCONN", "ECONNREFUSED", "UND_ERR_SOCKET"].includes(code)) return true;
    if (/ECONNRESET|ENOTCONN|fetch failed|other side closed/i.test(message)) return true;
    current = candidate.cause;
  }
  return false;
}

async function fetchLoopback(
  url: string,
  init?: RequestInit,
  attempts: Array<{ url: string; attempt: number; outcome: string }> = [],
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...init?.headers, connection: "close" },
      });
      attempts.push({ url: new URL(url).pathname, attempt, outcome: `http_${response.status}` });
      return response;
    } catch (error) {
      lastError = error;
      attempts.push({
        url: new URL(url).pathname,
        attempt,
        outcome: isRetryableLoopbackError(error) ? "retryable_transport_error" : "transport_error",
      });
      if (!isRetryableLoopbackError(error) || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  throw lastError;
}

async function waitForHealth(server: RunningServer) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`Server exited before health: ${server.output()}`);
    try {
      const response = await fetch(`${server.baseUrl}/api/health`);
      if (response.ok) {
        const health = await response.json() as { status?: string; startupRecovery?: { phase?: string } };
        if (health.status === "ok" && (!health.startupRecovery || health.startupRecovery.phase === "ready")) return health;
      }
    } catch {
      // The isolated process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server health timed out: ${server.output()}`);
}

async function authenticatedSmoke(
  server: RunningServer,
  companyId: string,
  projectId: string,
  legacyRecordId: string,
  expectedKeyFile: string,
) {
  const attempts: Array<{ url: string; attempt: number; outcome: string }> = [];
  await waitForHealth(server);
  const signIn = await fetchLoopback(`${server.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.baseUrl },
    body: JSON.stringify({ email, password }),
  }, attempts);
  const signInBody = await signIn.text();
  if (!signIn.ok) throw new Error(`Authenticated sign-in failed (${signIn.status}): ${signInBody}`);
  const getSetCookie = (signIn.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.bind(signIn.headers);
  const cookieHeaders = getSetCookie ? getSetCookie() : [signIn.headers.get("set-cookie") ?? ""];
  const cookie = cookieHeaders.filter(Boolean).map((value) => value.split(";", 1)[0]).join("; ");
  if (!cookie) throw new Error("Authenticated sign-in did not return a session cookie");
  const headers = { cookie };

  const healthResponse = await fetchLoopback(`${server.baseUrl}/api/health`, { headers }, attempts);
  if (!healthResponse.ok) throw new Error(`Authenticated health failed: ${healthResponse.status}`);
  const health = await healthResponse.json() as { status?: string; startupRecovery?: { phase?: string } };
  if (health.status !== "ok" || health.startupRecovery?.phase !== "ready") {
    throw new Error(`Authenticated health did not prove ready startup recovery: ${JSON.stringify(health)}`);
  }

  const recordsResponse = await fetchLoopback(
    `${server.baseUrl}/api/companies/${companyId}/projects/${projectId}/work-records`,
    { headers },
    attempts,
  );
  if (!recordsResponse.ok) throw new Error(`M1 record smoke failed: ${recordsResponse.status} ${await recordsResponse.text()}`);
  const listed = await recordsResponse.json() as Array<{ id: string }>;
  if (!listed.some((record) => record.id === legacyRecordId)) throw new Error("M1 record was not retained");

  const operationsResponse = await fetchLoopback(
    `${server.baseUrl}/api/companies/${companyId}/projects/${projectId}/work-record-workflow/operations`,
    { headers },
    attempts,
  );
  if (!operationsResponse.ok) throw new Error(`Workflow operations smoke failed: ${operationsResponse.status} ${await operationsResponse.text()}`);
  const operations = await operationsResponse.json() as {
    outbox?: { recoveredEventCount?: number };
    execution?: { intents?: number };
  };
  if ((operations.outbox?.recoveredEventCount ?? 0) < 1) throw new Error("Recovered workflow-v2 event was not retained");

  const providerResponse = await fetchLoopback(
    `${server.baseUrl}/api/companies/${companyId}/secret-providers/health`,
    { headers },
    attempts,
  );
  if (!providerResponse.ok) throw new Error(`Secret-provider health failed: ${providerResponse.status} ${await providerResponse.text()}`);
  const providerHealth = await providerResponse.json() as {
    providers?: Array<{
      provider?: string;
      status?: string;
      details?: { keySource?: string; keyFilePath?: string };
    }>;
  };
  const localProvider = providerHealth.providers?.find((provider) => provider.provider === "local_encrypted");
  if (!localProvider || localProvider.status === "error") {
    throw new Error("Matching local encrypted-secrets key was not healthy");
  }
  const loadedKeyFile = localProvider.details?.keyFilePath;
  if (
    localProvider.details?.keySource !== "file"
    || !loadedKeyFile
    || path.resolve(loadedKeyFile).toLowerCase() !== path.resolve(expectedKeyFile).toLowerCase()
  ) {
    throw new Error("Authenticated server did not load the expected local encrypted-secrets key file");
  }

  return {
    health,
    signInStatus: signIn.status,
    listedRecordCount: listed.length,
    retainedLegacyRecordId: legacyRecordId,
    workflow: {
      recoveryEventCount: operations.outbox?.recoveredEventCount ?? 0,
      intentCount: operations.execution?.intents ?? 0,
    },
    secretProvider: localProvider,
    requestAttempts: attempts,
    pipeErrors: server.pipeErrors(),
  };
}

const workRoot = path.join(evidenceDir, "authenticated-restore-work");
const backupDir = path.join(workRoot, "backups");
const sourceHome = path.join(workRoot, "source-home");
const targetHome = path.join(workRoot, "target-home");
const sourceKeyFile = path.join(sourceHome, "secrets", "master.key");
const targetKeyFile = path.join(targetHome, "secrets", "master.key");
await mkdir(path.dirname(sourceKeyFile), { recursive: true });
await mkdir(path.dirname(targetKeyFile), { recursive: true });
await mkdir(backupDir, { recursive: true });
const keyMaterial = randomBytes(32);
await writeFile(sourceKeyFile, keyMaterial.toString("base64"), { mode: 0o600 });

const previousAuthSecret = process.env.BETTER_AUTH_SECRET;
process.env.BETTER_AUTH_SECRET = authSecret;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
let sourceServer: RunningServer | null = null;
let targetServer: RunningServer | null = null;
let sourceServerLog = "";
let targetServerLog = "";

try {
  let databaseError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      database = await startEmbeddedPostgresTestDatabase(`paperclip-m2e-authenticated-restore-${attempt}-`);
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
  const targetName = `m2e_restore_${randomUUID().replaceAll("-", "")}`;
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${targetName}`;
  await ensurePostgresDatabase(adminUrl.toString(), targetName);

  const sourceDb = createDb(sourceUrl.toString());
  const signupOrigin = `http://127.0.0.1:${await availableLoopbackPort()}`;
  const auth = createBetterAuthInstance(sourceDb, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: signupOrigin,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: Number(new URL(signupOrigin).port),
  } as unknown as Config, [signupOrigin]);
  const signup = await auth.handler(new Request(`${signupOrigin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: signupOrigin },
    body: JSON.stringify({ email, password, name: "M2-E Restore Operator" }),
  }));
  if (!signup.ok) throw new Error(`Credential signup failed (${signup.status}): ${await signup.text()}`);
  const user = await sourceDb.select().from(authUsers)
    .then((rows) => rows.find((row) => row.email === email));
  if (!user) throw new Error("Credential signup did not persist the user");
  await sourceDb.insert(instanceUserRoles).values({ userId: user.id, role: "instance_admin" });

  const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  const company = await sourceDb.insert(companies).values({ name: `M2-E authenticated restore ${suffix}`, issuePrefix: `A${suffix}` })
    .returning().then((rows) => rows[0]);
  await sourceDb.insert(companyMemberships).values({
    companyId: company.id,
    principalType: "user",
    principalId: user.id,
    status: "active",
    membershipRole: "owner",
  });
  const project = await sourceDb.insert(projects).values({ companyId: company.id, name: "Authenticated restore drill" })
    .returning().then((rows) => rows[0]);
  const agent = await sourceDb.insert(agents).values({
    companyId: company.id,
    name: "Restore drill agent",
    status: "idle",
    adapterType: "process",
    adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 60, wakeOnDemand: true } },
  }).returning().then((rows) => rows[0]);
  const records = workRecordService(sourceDb);
  const legacyRecord = await records.create(company.id, {
    projectId: project.id,
    kind: "plan",
    title: "M1 retained authenticated record",
    assigneeAgentId: agent.id,
  }, { actorType: "system", actorId: "m2e-authenticated-restore" });
  const v2Record = await records.create(company.id, {
    projectId: project.id,
    kind: "plan",
    title: "Workflow-v2 retained recovery record",
    assigneeAgentId: agent.id,
  }, { actorType: "system", actorId: "m2e-authenticated-restore" });
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
    clientRequestId: "m2e-authenticated-restore",
    requestPayloadDigest: "m2e-authenticated-restore",
    expectedScopeDigest: preview.scopeDigest,
    expectedRootRevision: preview.rootRevision,
    expectedDependencySetRevision: preview.dependencySetRevision,
  }, { actorType: "system", actorId: "m2e-authenticated-restore" });
  const intent = await sourceDb.select().from(workRecordExecutionIntents)
    .then((rows) => rows.find((row) => row.recordId === v2Record.id));
  if (!intent) throw new Error("Workflow-v2 intent was not created");
  const event = await sourceDb.select().from(workRecordOutbox)
    .then((rows) => rows.find((row) => row.executionIntentId === intent.id));
  if (!event) throw new Error("Workflow-v2 event was not created");
  await sourceDb.update(workRecordOutbox).set({
    state: "dead_letter",
    attemptCount: 5,
    deadLetteredAt: new Date(),
    updatedAt: new Date(),
  });
  const recovered = await packages.recoverOutboxEvent(company.id, project.id, event.id, {
    expectedAttemptCount: 5,
    reasonCode: "operator_retry",
  });
  if (recovered.id !== event.id || recovered.recoveryCount !== 1) throw new Error("Recovery facts were not persisted");

  const backupCommand = runCli([
    "db:backup",
    "--dir", backupDir,
    "--filename-prefix", "workflow-v2",
    "--json",
  ], sourceUrl.toString());
  const backupJson = parsePureJson(backupCommand);
  const backupFile = String(backupJson.backupFile ?? "");
  if (!backupFile) throw new Error("Backup JSON did not contain backupFile");
  await writeFile(path.join(workRoot, "backup.json"), `${backupCommand.stdout}\n`, "utf8");
  const backupSha256 = await sha256File(backupFile);
  const sourceKeySha256 = await sha256File(sourceKeyFile);

  const commonRestoreArgs = [
    "db:restore",
    "--backup", backupFile,
    "--secrets-key-file", sourceKeyFile,
    "--expected-secrets-key-sha256", sourceKeySha256,
    "--expected-company-id", company.id,
    "--json",
  ];
  const failedPreflight = runCli([
    ...commonRestoreArgs.slice(0, 3),
    "--expected-sha256", "0".repeat(64),
    ...commonRestoreArgs.slice(3),
  ], targetUrl.toString());
  if (failedPreflight.exitCode === 0) throw new Error("Checksum-drift preflight unexpectedly succeeded");
  const targetAfterFailedPreflight = await inspectMigrations(targetUrl.toString());
  if (targetAfterFailedPreflight.tableCount !== 0) throw new Error("Failed preflight mutated the empty target");

  const sourcePort = await availableLoopbackPort();
  sourceServer = startServer({
    connectionString: sourceUrl.toString(),
    keyFile: sourceKeyFile,
    instanceId: `m2e-source-${suffix.toLowerCase()}`,
    home: sourceHome,
    port: sourcePort,
    logFile: path.join(workRoot, "source-server.raw.log"),
  });
  const sourceFallbackSmoke = await authenticatedSmoke(
    sourceServer,
    company.id,
    project.id,
    legacyRecord.id,
    sourceKeyFile,
  );
  if (!sourceServer.child.pid) throw new Error("Source tsx launcher PID was unavailable");
  const sourceProcess = await captureQualifiedServerProcess({
    tsxLauncherPid: sourceServer.child.pid,
    port: sourcePort,
  });
  const sourceExit = await stopAndVerifyQualifiedServer(sourceProcess);
  sourceServerLog = `${sourceServer.output()}\npipeErrors=${JSON.stringify(sourceServer.pipeErrors())}\n`;
  sourceServer = null;

  const preflightCommand = runCli([
    ...commonRestoreArgs.slice(0, 3),
    "--expected-sha256", backupSha256,
    ...commonRestoreArgs.slice(3),
  ], targetUrl.toString());
  const preflightJson = parsePureJson(preflightCommand);
  const applyCommand = runCli([
    ...commonRestoreArgs.slice(0, 3),
    "--expected-sha256", backupSha256,
    ...commonRestoreArgs.slice(3),
    "--apply",
    "--yes",
  ], targetUrl.toString());
  const applyJson = parsePureJson(applyCommand);
  await writeFile(path.join(workRoot, "restore-result.json"), `${applyCommand.stdout}\n`, "utf8");

  await writeFile(targetKeyFile, await readFile(sourceKeyFile), { mode: 0o600 });
  const targetKeySha256 = await sha256File(targetKeyFile);
  if (targetKeySha256 !== sourceKeySha256) throw new Error("Restored secrets key does not match the approved key");
  const targetPort = await availableLoopbackPort();
  targetServer = startServer({
    connectionString: targetUrl.toString(),
    keyFile: targetKeyFile,
    instanceId: `m2e-target-${suffix.toLowerCase()}`,
    home: targetHome,
    port: targetPort,
    logFile: path.join(workRoot, "target-server.raw.log"),
  });
  const restoredSmoke = await authenticatedSmoke(
    targetServer,
    company.id,
    project.id,
    legacyRecord.id,
    targetKeyFile,
  );
  if (!targetServer.child.pid) throw new Error("Target tsx launcher PID was unavailable");
  const targetProcess = await captureQualifiedServerProcess({
    tsxLauncherPid: targetServer.child.pid,
    port: targetPort,
  });
  const targetExit = await stopAndVerifyQualifiedServer(targetProcess);
  targetServerLog = `${targetServer.output()}\npipeErrors=${JSON.stringify(targetServer.pipeErrors())}\n`;
  targetServer = null;

  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "authenticated-backup-restore.json"), `${JSON.stringify({
    schemaVersion: 2,
    testedCommit,
    database: {
      sourceIdentity: sourceUrl.pathname,
      targetIdentity: targetUrl.pathname,
      sameDatabaseAfterRestore: false,
      backupFilename: path.basename(backupFile),
      backupSha256,
      sourceKeySha256,
      targetKeySha256,
      matchingKeyMaterial: sourceKeySha256 === targetKeySha256,
    },
    commands: {
      backup: { args: backupCommand.args, exitCode: backupCommand.exitCode, pureJson: true },
      failedChecksumPreflight: {
        args: failedPreflight.args,
        exitCode: failedPreflight.exitCode,
        error: failedPreflight.stderr,
        targetTableCountAfterFailure: targetAfterFailedPreflight.tableCount,
      },
      preflight: { args: preflightCommand.args, exitCode: preflightCommand.exitCode, result: preflightJson },
      apply: { args: applyCommand.args, exitCode: applyCommand.exitCode, result: applyJson },
    },
    failureWithdrawal: {
      checksumFailureLeftTargetEmpty: targetAfterFailedPreflight.tableCount === 0,
      unchangedSourceProcessRestarted: true,
      sourceSmoke: sourceFallbackSmoke,
      sourceProcess: {
        ...sourceProcess,
        exit: sourceExit,
      },
    },
    restoredProcess: {
      ...targetProcess,
      exit: targetExit,
      smoke: restoredSmoke,
    },
    retainedData: {
      companyId: company.id,
      authenticatedUserId: user.id,
      legacyRecordId: legacyRecord.id,
      workflowV2EventId: recovered.id,
      recoveryCount: recovered.recoveryCount,
      lastRecoveredAt: recovered.lastRecoveredAt,
    },
  }, null, 2)}\n`, "utf8");
} finally {
  await stopServer(targetServer);
  await stopServer(sourceServer);
  if (sourceServer) sourceServerLog = `${sourceServer.output()}\npipeErrors=${JSON.stringify(sourceServer.pipeErrors())}\n`;
  if (targetServer) targetServerLog = `${targetServer.output()}\npipeErrors=${JSON.stringify(targetServer.pipeErrors())}\n`;
  await mkdir(workRoot, { recursive: true }).catch(() => {});
  await writeFile(path.join(workRoot, "source-server.log"), sourceServerLog, "utf8").catch(() => {});
  await writeFile(path.join(workRoot, "target-server.log"), targetServerLog, "utf8").catch(() => {});
  if (database) {
    await closeRegisteredClients(database.connectionString).catch(() => {});
    await database.cleanup();
  }
  if (previousAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = previousAuthSecret;
}
