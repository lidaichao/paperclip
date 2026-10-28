import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import { and, eq, inArray, sql } from "../../server/node_modules/drizzle-orm/index.js";
import {
  agentWakeupRequests,
  closeRegisteredClients,
  createDb,
  heartbeatRuns,
  workRecordDispatchBatches,
  workRecordDispatchBatchItems,
  workRecordExecutionIntents,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecords,
} from "../../packages/db/src/index.ts";

type Failpoint =
  | "after_partial_materialization"
  | "after_outbox_commit"
  | "before_projection_update";

type Scenario = {
  failpoint: Failpoint;
  companyId: string;
  companyPrefix: string;
  projectId: string;
  recordIds: string[];
  recordTitles: string[];
  clientRequestId: string;
};

type Layer = {
  ids: string[];
  states: Array<string | null>;
  effectiveCount: number;
};

const activeWorkers = new Set<ChildProcess>();

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function e2eDatabaseUrl() {
  const external = process.env.PAPERCLIP_M2_R05_DATABASE_URL_OVERRIDE?.trim();
  if (external) return external;
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8")) as {
    database: { embeddedPostgresDataDir: string };
  };
  const pidFile = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  return `postgres://paperclip:paperclip@127.0.0.1:${pidFile.split("\n")[3]}/paperclip`;
}

async function seedScenario(request: APIRequestContext, failpoint: Failpoint): Promise<Scenario> {
  const slug = failpoint.replaceAll("_", "-");
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `M2 R05 ${slug} ${Date.now()}` } }),
    `create ${slug} company`,
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: `M2 R05 ${slug}` } }),
    `create ${slug} project`,
  );
  const count = failpoint === "after_partial_materialization" ? 2 : 1;
  const agents = [] as Array<{ id: string }>;
  for (let index = 0; index < count; index += 1) {
    agents.push(await json<{ id: string }>(
      await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: `M2 R05 ${slug} worker ${index + 1}`,
          role: "engineer",
          adapterType: "process",
          adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
          runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
        },
      }),
      `create ${slug} agent ${index + 1}`,
    ));
  }
  const records = [] as Array<{ id: string; title: string }>;
  for (let index = 0; index < count; index += 1) {
    const title = `M2 R05 ${slug} record ${index + 1}`;
    const record = await json<{ id: string }>(
      await request.post(`/api/companies/${company.id}/work-records`, {
        data: {
          projectId: project.id,
          kind: "plan",
          title,
          assigneeAgentId: agents[index].id,
          predecessorRecordIds: [],
        },
      }),
      `create ${slug} record ${index + 1}`,
    );
    records.push({ id: record.id, title });
  }
  return {
    failpoint,
    companyId: company.id,
    companyPrefix: company.issuePrefix,
    projectId: project.id,
    recordIds: records.map((record) => record.id),
    recordTitles: records.map((record) => record.title),
    clientRequestId: `m2-r05-${slug}-${Date.now()}`,
  };
}

function spawnWorker(databaseUrl: string, scenario: Scenario, operation: "crash" | "recover") {
  const child = spawn(
    process.execPath,
    ["cli/node_modules/tsx/dist/cli.mjs", "tests/e2e/fixtures/work-package-process-recovery-worker.ts"],
    {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        PAPERCLIP_M2_R05_DATABASE_URL: databaseUrl,
        PAPERCLIP_M2_R05_OPERATION: operation,
        PAPERCLIP_M2_R05_FAILPOINT: operation === "crash" ? scenario.failpoint : "",
        PAPERCLIP_M2_R05_INPUT: JSON.stringify({
          companyId: scenario.companyId,
          projectId: scenario.projectId,
          recordIds: scenario.recordIds,
          clientRequestId: scenario.clientRequestId,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  activeWorkers.add(child);
  child.once("exit", () => activeWorkers.delete(child));
  return child;
}

async function waitForMarker(child: ChildProcess, marker: string, timeoutMs = 30_000) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(marker));
    if (line) return { line, stdout, stderr };
    if (child.exitCode !== null) {
      throw new Error(`M2-R05 worker exited before ${marker}: ${stdout}\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${marker}: ${stdout}\n${stderr}`);
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Worker did not exit")), timeoutMs)),
  ]);
}

function killWorker(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
}

function layer<T extends { id: string }>(
  rows: T[],
  state: (row: T) => string | null,
  effective: (row: T) => boolean = () => true,
): Layer {
  return {
    ids: rows.map((row) => row.id).sort(),
    states: rows.map(state).sort((left, right) => String(left).localeCompare(String(right))),
    effectiveCount: rows.filter(effective).length,
  };
}

async function databaseSnapshot(db: ReturnType<typeof createDb>, scenario: Scenario) {
  const [postgresIdentity] = await db.execute<{
    database: string;
    port: string;
    serverStartedAt: string;
  }>(sql`
    select
      current_database() as database,
      current_setting('port') as port,
      pg_postmaster_start_time()::text as "serverStartedAt"
  `);
  const records = await db.select().from(workRecords).where(inArray(workRecords.id, scenario.recordIds));
  const items = await db.select().from(workRecordDispatchBatchItems).where(and(
    eq(workRecordDispatchBatchItems.companyId, scenario.companyId),
    inArray(workRecordDispatchBatchItems.recordId, scenario.recordIds),
  ));
  const batches = await db.select().from(workRecordDispatchBatches).where(and(
    eq(workRecordDispatchBatches.companyId, scenario.companyId),
    eq(workRecordDispatchBatches.clientRequestId, scenario.clientRequestId),
  ));
  const links = await db.select().from(workRecordIssueLinks).where(and(
    eq(workRecordIssueLinks.companyId, scenario.companyId),
    inArray(workRecordIssueLinks.recordId, scenario.recordIds),
  ));
  const intents = await db.select().from(workRecordExecutionIntents).where(and(
    eq(workRecordExecutionIntents.companyId, scenario.companyId),
    inArray(workRecordExecutionIntents.recordId, scenario.recordIds),
  ));
  const outbox = await db.select().from(workRecordOutbox).where(and(
    eq(workRecordOutbox.companyId, scenario.companyId),
    inArray(workRecordOutbox.recordId, scenario.recordIds),
  ));
  const intentById = new Map(intents.map((intent) => [intent.id, intent]));
  const outboxDetails = outbox.map((event) => {
    const intent = event.executionIntentId ? intentById.get(event.executionIntentId) : null;
    const compatibilityWakeKey = event.payload && typeof event.payload === "object"
      && "compatibilityWakeKey" in event.payload
      && typeof event.payload.compatibilityWakeKey === "string"
      ? event.payload.compatibilityWakeKey
      : null;
    return {
      id: event.id,
      recordId: event.recordId,
      workflowVersion: event.workflowVersion,
      eventKey: event.eventKey,
      executionIntentId: event.executionIntentId,
      state: event.state,
      wakeKey: event.workflowVersion === 1
        ? `work-record-release:${event.eventKey}`
        : compatibilityWakeKey ?? (intent ? `work-record-intent:${intent.id}:${intent.generation}` : null),
    };
  });
  const wakeKeys = [...new Set(outboxDetails.map((event) => event.wakeKey).filter((key): key is string => Boolean(key)))];
  const wakes = wakeKeys.length === 0 ? [] : await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, scenario.companyId),
    inArray(agentWakeupRequests.idempotencyKey, wakeKeys),
  ));
  const runs = wakes.length === 0 ? [] : await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scenario.companyId),
    inArray(heartbeatRuns.wakeupRequestId, wakes.map((wake) => wake.id)),
  ));
  return {
    postgresIdentity,
    record: layer(records, (row) => row.businessStatus),
    batch: layer(batches, (row) => row.state, (row) => !["failed", "superseded"].includes(row.state)),
    item: layer(items, (row) => row.materializationState, (row) => !["failed", "blocked"].includes(row.materializationState)),
    link: layer(links, () => null),
    intent: layer(intents, (row) => row.state, (row) => !["superseded", "cancelled"].includes(row.state)),
    outbox: layer(outbox, (row) => row.state, (row) => !["superseded", "failed"].includes(row.state)),
    wake: layer(wakes, (row) => row.status, (row) => ["queued", "claimed", "running", "completed"].includes(row.status)),
    run: layer(runs, (row) => row.status, (row) => ["queued", "starting", "running", "succeeded"].includes(row.status)),
    retryAvailableAt: outbox.map((row) => row.availableAt?.toISOString() ?? null),
    outboxDetails,
    wakeDetails: wakes.map((wake) => ({ id: wake.id, idempotencyKey: wake.idempotencyKey, status: wake.status })),
    runDetails: runs.map((run) => ({ id: run.id, wakeupRequestId: run.wakeupRequestId, status: run.status })),
  };
}

async function apiSnapshot(request: APIRequestContext, scenario: Scenario, batchId: string) {
  return {
    batch: await json(
      await request.get(`/api/companies/${scenario.companyId}/projects/${scenario.projectId}/work-package-dispatch/${batchId}`),
      `${scenario.failpoint} batch snapshot`,
    ),
    records: await json(
      await request.get(`/api/companies/${scenario.companyId}/projects/${scenario.projectId}/work-records`),
      `${scenario.failpoint} records snapshot`,
    ),
    liveRuns: await json(
      await request.get(`/api/companies/${scenario.companyId}/live-runs`),
      `${scenario.failpoint} live-run snapshot`,
    ),
  };
}

async function waitForOutboxLease(db: ReturnType<typeof createDb>, scenario: Scenario) {
  await expect.poll(async () => {
    const rows = await db.select({ availableAt: workRecordOutbox.availableAt }).from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, scenario.companyId),
      inArray(workRecordOutbox.recordId, scenario.recordIds),
    ));
    return rows.length > 0 && rows.every((row) => row.availableAt.getTime() <= Date.now());
  }, { timeout: 40_000, intervals: [250, 500, 1_000] }).toBe(true);
}

async function assertUiConvergence(page: Page, scenario: Scenario, info: TestInfo, evidenceDir: string) {
  await page.goto(`/${scenario.companyPrefix}/projects/${scenario.projectId}/records`);
  for (const title of scenario.recordTitles) {
    const row = page.getByRole("button", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
    await expect(row).toBeVisible();
    // A fresh mount deliberately fails closed until this component observes a
    // successful live-run read. The 15s production poll must then converge the
    // row without a reload or a false running animation.
    await expect(row).not.toContainText("运行未知", { timeout: 25_000 });
    await expect(row.getByTestId("work-record-running-animation")).toHaveCount(0);
    // The fixture agent exits successfully without completing its assigned
    // issue, so the truthful steady state is linked and awaiting the next
    // schedule rather than a fabricated live run.
    await expect(row).toContainText("等待调度");
  }
  const screenshotPath = path.join(evidenceDir, `${scenario.failpoint}-ui.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await info.attach(`${scenario.failpoint}-ui`, { path: screenshotPath, contentType: "image/png" });
}

test.afterEach(async () => {
  for (const child of activeWorkers) killWorker(child);
  await Promise.all([...activeWorkers].map((child) => waitForExit(child).catch(() => {})));
  activeWorkers.clear();
});

test("M2-R05 converges after process death at all durable work-package boundaries", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const databaseUrl = await e2eDatabaseUrl();
  const db = createDb(databaseUrl);
  const evidenceDir = process.env.PAPERCLIP_M2_R05_EVIDENCE_DIR?.trim()
    ? path.resolve(process.env.PAPERCLIP_M2_R05_EVIDENCE_DIR)
    : info.outputPath("m2-r05-process-recovery");
  await mkdir(evidenceDir, { recursive: true });
  const evidence = [] as Array<Record<string, unknown>>;

  try {
    for (const failpoint of [
      "after_partial_materialization",
      "after_outbox_commit",
      "before_projection_update",
    ] as const) {
      const scenario = await seedScenario(request, failpoint);
      const crashing = spawnWorker(databaseUrl, scenario, "crash");
      const boundary = await waitForMarker(crashing, "M2_R05_FAILPOINT ");
      const killedPid = crashing.pid;
      killWorker(crashing);
      await waitForExit(crashing);
      expect(killedPid).toBeGreaterThan(0);
      expect(crashing.exitCode === 0).toBe(false);

      const beforeDb = await databaseSnapshot(db, scenario);
      const batch = await db.select({ id: workRecordDispatchBatches.id }).from(workRecordDispatchBatches).where(and(
        eq(workRecordDispatchBatches.companyId, scenario.companyId),
        eq(workRecordDispatchBatches.clientRequestId, scenario.clientRequestId),
      )).then((rows) => rows[0]);
      expect(batch?.id).toBeTruthy();
      const beforeApi = await apiSnapshot(request, scenario, batch.id);

      if (failpoint !== "after_partial_materialization") {
        await waitForOutboxLease(db, scenario);
      }
      const recovering = spawnWorker(databaseUrl, scenario, "recover");
      const recovered = await waitForMarker(recovering, "M2_R05_RECOVERED ", 45_000);
      await waitForExit(recovering);
      expect(recovering.exitCode).toBe(0);
      expect(recovering.pid).not.toBe(killedPid);

      await expect.poll(async () => {
        const snapshot = await databaseSnapshot(db, scenario);
        return {
          wakes: snapshot.wake.effectiveCount,
          runs: snapshot.run.effectiveCount,
          live: snapshot.run.states.filter((state) => state !== "succeeded").length,
        };
      }, { timeout: 20_000, intervals: [100, 250, 500] }).toEqual({
        wakes: scenario.recordIds.length,
        runs: scenario.recordIds.length,
        live: 0,
      });
      const afterDb = await databaseSnapshot(db, scenario);
      const afterApi = await apiSnapshot(request, scenario, batch.id);
      const scenarioEvidence = {
        failpoint,
        killedProcess: {
          pid: killedPid,
          marker: boundary.line,
          termination: "SIGKILL",
          exitCode: crashing.exitCode,
          signalCode: crashing.signalCode,
        },
        recoveryProcess: { pid: recovering.pid, marker: recovered.line },
        database: { before: beforeDb, after: afterDb },
        api: { before: beforeApi, after: afterApi },
        ui: { screenshot: `${failpoint}-ui.png`, converged: false },
      };
      expect(afterDb.postgresIdentity).toEqual(beforeDb.postgresIdentity);
      await writeFile(
        path.join(evidenceDir, `${failpoint}.json`),
        `${JSON.stringify({ schemaVersion: 1, ...scenarioEvidence }, null, 2)}\n`,
        "utf8",
      );
      const expectedCount = scenario.recordIds.length;
      for (const name of ["item", "link", "intent", "wake", "run"] as const) {
        expect(
          name === "intent" ? afterDb[name].ids.length : afterDb[name].effectiveCount,
          `${failpoint} ${name}: ${JSON.stringify(afterDb[name])}`,
        ).toBe(expectedCount);
        expect(new Set(afterDb[name].ids).size, `${failpoint} unique ${name}`).toBe(afterDb[name].ids.length);
        for (const id of beforeDb[name].ids) expect(afterDb[name].ids).toContain(id);
      }
      expect(new Set(afterDb.outbox.ids).size, `${failpoint} unique outbox rows`).toBe(afterDb.outbox.ids.length);
      expect(new Set(afterDb.outboxDetails.map((event) => event.eventKey)).size, `${failpoint} unique outbox event keys`)
        .toBe(afterDb.outboxDetails.length);
      expect(afterDb.outboxDetails.every((event) => scenario.recordIds.includes(event.recordId)), `${failpoint} outbox records`)
        .toBe(true);
      expect(afterDb.outboxDetails.every((event) => event.executionIntentId === null
        || afterDb.intent.ids.includes(event.executionIntentId)), `${failpoint} outbox intent references`).toBe(true);
      expect(new Set(afterDb.wakeDetails.map((wake) => wake.idempotencyKey)).size, `${failpoint} unique wake keys`)
        .toBe(afterDb.wakeDetails.length);
      expect(new Set(afterDb.runDetails.map((run) => run.wakeupRequestId)).size, `${failpoint} one run per wake`)
        .toBe(afterDb.runDetails.length);
      expect(afterDb.runDetails.every((run) => afterDb.wake.ids.includes(run.wakeupRequestId)), `${failpoint} run wake references`)
        .toBe(true);
      expect(afterDb.batch.effectiveCount).toBe(1);
      expect(afterDb.outbox.states.every((state) => ["delivered", "superseded"].includes(state ?? ""))).toBe(true);
      expect(afterDb.intent.states.every((state) => ["queued", "superseded"].includes(state ?? ""))).toBe(true);
      expect(afterDb.wake.states).toEqual(Array(expectedCount).fill("completed"));
      expect(afterDb.run.states).toEqual(Array(expectedCount).fill("succeeded"));
      expect(afterApi.liveRuns).toEqual([]);
      await assertUiConvergence(page, scenario, info, evidenceDir);

      scenarioEvidence.ui.converged = true;
      evidence.push(scenarioEvidence);
    }

    const evidencePath = path.join(evidenceDir, "m2-r05-process-recovery.json");
    await writeFile(evidencePath, `${JSON.stringify({
      schemaVersion: 1,
      sourceSha: process.env.PAPERCLIP_M2_R05_SOURCE_SHA ?? null,
      browserChannel: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL ?? "bundled-chromium",
      executedAt: new Date().toISOString(),
      evidence,
    }, null, 2)}\n`, "utf8");
    await info.attach("m2-r05-process-recovery", { path: evidencePath, contentType: "application/json" });
  } finally {
    await closeRegisteredClients(databaseUrl);
  }
});
