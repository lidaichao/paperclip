import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { startServer } from "../../server/src/index.js";

const fixtureRoot = process.argv[2];
if (!fixtureRoot || !path.isAbsolute(fixtureRoot)) {
  throw new Error("usage: pap17-g2-fixture-server.ts <absolute-fixture-root>");
}

async function writeJson(name: string, value: unknown): Promise<void> {
  const target = path.join(fixtureRoot, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

await mkdir(fixtureRoot, { recursive: true });
const startedAt = new Date().toISOString();
const started = await startServer();
await writeJson("service-runtime.json", {
  schemaVersion: 1,
  pid: process.pid,
  startedAt,
  apiUrl: started.apiUrl,
  databaseUrl: started.databaseUrl,
});

const stopRequest = path.join(fixtureRoot, "stop-request.json");
while (true) {
  try {
    JSON.parse(await readFile(stopRequest, "utf8"));
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

await started.shutdown("SIGTERM");
await writeJson("service-stopped.json", {
  schemaVersion: 1,
  pid: process.pid,
  startedAt,
  stoppedAt: new Date().toISOString(),
  apiUrl: started.apiUrl,
});
process.exit(0);
