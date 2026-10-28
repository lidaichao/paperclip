import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startEmbeddedPostgresTestDatabase } from "../../packages/db/src/test-embedded-postgres.js";

async function availableLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate an E2E loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
let lastDatabaseError: unknown;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  try {
    database = await startEmbeddedPostgresTestDatabase(`paperclip-m2-r05-e2e-${attempt}-`);
    break;
  } catch (error) {
    lastDatabaseError = error;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (!database) throw lastDatabaseError;
const port = process.env.PAPERCLIP_E2E_PORT
  ? Number(process.env.PAPERCLIP_E2E_PORT)
  : await availableLoopbackPort();
const playwrightCli = path.join(root, "node_modules", "@playwright", "test", "cli.js");

let playwrightExitCode = 1;
try {
  const child = spawn(
    process.execPath,
    [
      playwrightCli,
      "test",
      "--config",
      "tests/e2e/playwright.config.ts",
      "tests/e2e/work-package-process-recovery.spec.ts",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: database.connectionString,
        PAPERCLIP_M2_R05_DATABASE_URL_OVERRIDE: database.connectionString,
        PAPERCLIP_M2_R05_SOURCE_SHA: sourceSha,
        PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED: "false",
        PAPERCLIP_E2E_OWNS_WORK_RECORD_TICK: "true",
        PAPERCLIP_E2E_PORT: String(port),
        PAPERCLIP_PLAYWRIGHT_CHANNEL: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL ?? "chrome",
      },
    },
  );
  playwrightExitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await database.cleanup();
}

if (playwrightExitCode !== 0) {
  throw new Error(`M2-R05 Playwright run failed with exit code ${playwrightExitCode}`);
}
