import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type APIResponse, type Locator, type Page, type TestInfo } from "@playwright/test";
import { and, eq } from "../../server/node_modules/drizzle-orm/index.js";
import {
  closeRegisteredClients,
  createDb,
  heartbeatRuns,
  issues,
  workRecordExecutionProjections,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecords,
} from "../../packages/db/src/index.ts";

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function connectToE2eDatabase() {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  const url = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
  return { db: createDb(url), url };
}

function evidenceDirectory(info: TestInfo, scenario: string) {
  const configured = process.env.LUN285_EVIDENCE_DIR?.trim();
  return configured
    ? path.join(path.resolve(configured), scenario)
    : info.outputPath("lun-285", scenario);
}

async function captureBrowserEvidence(
  page: Page,
  status: Locator,
  info: TestInfo,
  scenario: string,
  extra: Record<string, unknown> = {},
) {
  const directory = evidenceDirectory(info, scenario);
  await mkdir(directory, { recursive: true });
  const screenshotPath = path.join(directory, "page.png");
  const domPath = path.join(directory, "dom.json");
  const dom = await status.evaluate((root) => {
    const animation = root.querySelector<HTMLElement>('span[aria-hidden="true"] > span');
    const rect = root.getBoundingClientRect();
    return {
      online: navigator.onLine,
      statusText: root.textContent?.trim() ?? null,
      state: root.dataset.state ?? null,
      animated: root.dataset.animated ?? null,
      animationName: animation ? getComputedStyle(animation).animationName : null,
      activeAnimations: animation?.getAnimations().length ?? 0,
      statusRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    };
  });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(domPath, `${JSON.stringify({ ...dom, ...extra }, null, 2)}\n`, "utf8");
  await info.attach(`${scenario}-dom`, { path: domPath, contentType: "application/json" });
  await info.attach(`${scenario}-screenshot`, { path: screenshotPath, contentType: "image/png" });
  return dom;
}

function recordRow(page: Page, title: string) {
  return page.getByTestId("work-record-table-row").filter({
    has: page.getByRole("button", { name: title, exact: true }),
  });
}

async function openRecord(page: Page, title: string) {
  const row = recordRow(page, title);
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: title, exact: true }).click();
  const detail = page.getByTestId("work-record-detail-drawer").filter({
    has: page.getByRole("heading", { name: title, level: 3, exact: true }),
  });
  await expect(detail).toBeVisible();
  return detail;
}

function statValue(detail: Locator, label: string) {
  return detail.getByText(label, { exact: true }).locator("..").locator("dd");
}

test("work record preview stays non-executing and the non-cohort gate creates no work", async ({ page, request }, info) => {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `Work record E2E ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Safe dispatch browser proof" } }),
    "create project",
  );
  const agent = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Browser proof process agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 300)"] },
      },
    }),
    "create process agent",
  );
  const record = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "plan",
        title: "Browser status truth",
        assigneeAgentId: agent.id,
        qaAssigneeAgentId: agent.id,
        predecessorRecordIds: [],
      },
    }),
    "create work record",
  );

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
  const detail = await openRecord(page, "Browser status truth");
  for (const label of ["业务状态", "派发状态", "执行投影", "真实运行"]) await expect(detail.getByText(label, { exact: true })).toBeVisible();

  const issuesBefore = await json<unknown[]>(await request.get(`/api/companies/${company.id}/issues`), "issues before preview");
  const runsBefore = await json<unknown[]>(await request.get(`/api/companies/${company.id}/heartbeat-runs`), "runs before preview");
  await page.getByRole("button", { name: "预览整个工作包", exact: true }).click();
  await expect(page.getByText("派发前范围预览", { exact: true })).toBeVisible();
  expect(await json<unknown[]>(await request.get(`/api/companies/${company.id}/issues`), "issues after preview")).toHaveLength(issuesBefore.length);
  expect(await json<unknown[]>(await request.get(`/api/companies/${company.id}/heartbeat-runs`), "runs after preview")).toHaveLength(runsBefore.length);
  const confirm = page.getByRole("button", { name: /确认范围并准备派发/ });
  await expect(confirm).toBeEnabled();
  const deniedPrepare = page.waitForResponse((response) => response.url().includes("/work-package-dispatch/prepare") && response.status() === 403);
  await confirm.click();
  await deniedPrepare;
  await expect(page.getByText(/not approved for this cohort/)).toBeVisible();
  expect(await json<unknown[]>(await request.get(`/api/companies/${company.id}/issues`), "issues after denied confirmation")).toHaveLength(issuesBefore.length);
  expect(await json<unknown[]>(await request.get(`/api/companies/${company.id}/heartbeat-runs`), "runs after denied confirmation")).toHaveLength(runsBefore.length);
  const status = page.getByTestId("work-record-status").first();
  await captureBrowserEvidence(page, status, info, "01-non-cohort-gate", { issuesBefore: issuesBefore.length, runsBefore: runsBefore.length });

  const screenshotPath = process.env.LUN277_SCREENSHOT_PATH
    ? path.resolve(process.env.LUN277_SCREENSHOT_PATH)
    : test.info().outputPath("work-record-state-layers.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
});

test("live running, offline recovery, and reduced motion preserve truthful state", async ({ context, page, request }, info) => {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `Work record resilience E2E ${Date.now()}` } }),
    "create resilience company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Record resilience browser proof" } }),
    "create resilience project",
  );
  const agent = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Resilience proof process agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 60_000)"] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
    "create resilience agent",
  );
  const record = await json<{ id: string; revision: number }>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "plan",
        title: "Live resilience proof",
        assigneeAgentId: agent.id,
        predecessorRecordIds: [],
      },
    }),
    "create resilience record",
  );
  const dispatch = await json<{ issueId: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/work-records/${record.id}/dispatch`, {
      data: { clientRequestId: "resilience-proof", expectedRevision: record.revision },
    }),
    "dispatch resilience record",
  );
  const { db, url } = await connectToE2eDatabase();
  let runId: string | null = null;

  try {
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: dispatch.issueId },
    }).returning().then((rows) => rows[0]);
    runId = run.id;

    await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
    const detail = await openRecord(page, "Live resilience proof");
    const status = page.getByTestId("work-record-status").first();
    const live = statValue(detail, "真实运行");
    const animation = status.locator('span[aria-hidden="true"]');
    await expect(status).toHaveAttribute("data-state", "running", { timeout: 20_000 });
    await expect(status).toHaveText(/运行中/);
    await expect(live).toHaveText("真实运行中");
    await expect(animation).toHaveCount(1);
    const runningAnimation = animation.locator(":scope > span").first();
    await expect.poll(() => runningAnimation.evaluate((element) => getComputedStyle(element).animationName)).not.toBe("none");
    await captureBrowserEvidence(page, status, info, "02-running", {
      apiLiveRuns: await json(await request.get(`/api/companies/${company.id}/live-runs`), "read running live runs"),
      runId,
    });

    const beforeReducedMotion = await status.boundingBox();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(status).toHaveText(/运行中/);
    await expect(live).toHaveText("真实运行中");
    await expect.poll(() => runningAnimation.evaluate((element) => ({
      animationName: getComputedStyle(element).animationName,
      activeAnimations: element.getAnimations().length,
    }))).toEqual({ animationName: "none", activeAnimations: 0 });
    const afterReducedMotion = await status.boundingBox();
    expect(afterReducedMotion).toEqual(beforeReducedMotion);
    await captureBrowserEvidence(page, status, info, "04-reduced-motion", {
      prefersReducedMotion: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      beforeReducedMotion,
      afterReducedMotion,
      runId,
    });

    await context.setOffline(true);
    // Going offline invalidates freshness immediately; cached "running" is not presented as current truth.
    await expect(status).toHaveAttribute("data-state", "unknown");
    await expect(status).toHaveText("运行未知");
    await expect(live).toHaveText("暂不可确认");
    await expect(animation).toHaveCount(0);
    const runningApiWhileOffline = await json<Array<{ id: string; status: string }>>(
      await request.get(`/api/companies/${company.id}/live-runs`),
      "read server live runs while browser is offline",
    );
    expect(runningApiWhileOffline).toEqual(expect.arrayContaining([expect.objectContaining({ id: runId, status: "running" })]));
    await captureBrowserEvidence(page, status, info, "03-offline-reconnect", {
      phase: "offline-after-threshold",
      apiLiveRuns: runningApiWhileOffline,
      runId,
    });

    const reconnectedResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/companies/${company.id}/live-runs`) && response.ok(),
    );
    await context.setOffline(false);
    await reconnectedResponse;
    await expect(status).toHaveAttribute("data-state", "running");
    await expect(live).toHaveText("真实运行中");
    await captureBrowserEvidence(page, status, info, "03-offline-reconnect-restored", {
      phase: "online-restored",
      apiLiveRuns: await json(await request.get(`/api/companies/${company.id}/live-runs`), "read restored live runs"),
      runId,
    });

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await expect.poll(async () => (
      await json<Array<{ id: string }>>(
        await request.get(`/api/companies/${company.id}/live-runs`),
        "poll empty live runs after completion",
      )
    ).length).toBe(0);
    await expect(live).toHaveText("无实时运行");
    await expect(status).not.toHaveAttribute("data-state", "running");
    await expect(animation).toHaveCount(0);
    await captureBrowserEvidence(page, status, info, "02-running-cleared", {
      apiLiveRuns: [],
      runId,
    });
  } finally {
    await context.setOffline(false).catch(() => {});
    if (runId) {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.status, "running"),
      ));
    }
    await closeRegisteredClients(url);
  }
});

test("stale and conflict records reconcile their existing association without creating work", async ({ page, request }) => {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `Work record recovery E2E ${Date.now()}` } }),
    "create recovery company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Record recovery browser proof" } }),
    "create recovery project",
  );
  const agent = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Recovery proof process agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 60_000)"] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
    "create recovery agent",
  );
  const createRecord = async (title: string) => json<{ id: string; revision: number }>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: { projectId: project.id, kind: "plan", title, assigneeAgentId: agent.id, predecessorRecordIds: [] },
    }),
    `create ${title}`,
  );
  const staleRecord = await createRecord("Stale projection proof");
  const conflictRecord = await createRecord("Conflict projection proof");
  const dispatch = async (record: { id: string; revision: number }, requestId: string) => json<{ issueId: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/work-records/${record.id}/dispatch`, {
      data: { clientRequestId: requestId, expectedRevision: record.revision },
    }),
    `dispatch ${requestId}`,
  );
  const staleDispatch = await dispatch(staleRecord, "stale-proof");
  const conflictDispatch = await dispatch(conflictRecord, "conflict-proof");
  const { db, url } = await connectToE2eDatabase();
  let conflictRunId: string | null = null;

  try {
    await db.update(workRecordOutbox).set({ state: "superseded" }).where(and(
      eq(workRecordOutbox.companyId, company.id),
      eq(workRecordOutbox.projectId, project.id),
    ));
    await db.update(workRecordExecutionProjections).set({
      syncState: "stale",
      syncError: null,
      projectedAt: new Date(Date.now() - 60_000),
    }).where(eq(workRecordExecutionProjections.recordId, staleRecord.id));
    await db.update(workRecordExecutionProjections).set({
      syncState: "error",
      syncError: "状态冲突",
      projectedAt: new Date(Date.now() - 60_000),
    }).where(eq(workRecordExecutionProjections.recordId, conflictRecord.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, conflictDispatch.issueId));
    await db.update(workRecords).set({ businessStatus: "done" }).where(eq(workRecords.id, conflictRecord.id));
    const conflictRun = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: conflictDispatch.issueId },
    }).returning().then((rows) => rows[0]);
    conflictRunId = conflictRun.id;

    const countAssociations = async () => ({
      issues: (await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, company.id))).length,
      links: (await db.select({ id: workRecordIssueLinks.id }).from(workRecordIssueLinks).where(eq(workRecordIssueLinks.companyId, company.id))).length,
      runs: (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).length,
    });
    const before = await countAssociations();

    const workRecordsUrl = `**/api/companies/${company.id}/projects/${project.id}/work-records`;
    await page.route(workRecordsUrl, async (route) => {
      const response = await route.fetch();
      const rows = await response.json() as Array<Record<string, unknown> & {
        id: string;
        execution: Record<string, unknown>;
        recovery: Record<string, unknown>;
      }>;
      const browserSnapshot = rows.map((row) => row.id === staleRecord.id ? {
        ...row,
        execution: { ...row.execution, projectionState: "stale", projectionError: null },
        recovery: { ...row.recovery, code: "projection_stale", message: "projection_stale", canReconcile: true },
      } : row);
      await route.fulfill({ response, json: browserSnapshot });
    });
    await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
    const staleDetail = await openRecord(page, "Stale projection proof");
    await expect(staleDetail.getByText("执行投影已过期，请重新核对。", { exact: true })).toBeVisible();
    await expect(staleDetail.getByRole("button", { name: /重新核对/ })).toBeEnabled();
    await expect(staleDetail.getByRole("button", { name: "核对同一请求" })).toHaveCount(0);
    await page.unroute(workRecordsUrl);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/work-records/${staleRecord.id}/reconcile`) && response.ok()),
      staleDetail.getByRole("button", { name: /重新核对/ }).click(),
    ]);
    await expect(staleDetail.getByText("执行投影已过期，请重新核对。", { exact: true })).toHaveCount(0);
    await page.route(workRecordsUrl, async (route) => {
      const response = await route.fetch();
      const rows = await response.json() as Array<Record<string, unknown> & {
        id: string;
        execution: Record<string, unknown>;
        recovery: Record<string, unknown>;
      }>;
      await route.fulfill({ response, json: rows.map((row) => row.id === conflictRecord.id ? {
        ...row,
        execution: { ...row.execution, projectionState: "error", projectionError: "状态冲突" },
        recovery: { ...row.recovery, code: "projection_error", message: "状态冲突", canReconcile: true },
      } : row) });
    });
    const conflictDetail = await openRecord(page, "Conflict projection proof");
    await expect(conflictDetail.getByText("状态冲突", { exact: true })).toBeVisible();
    await expect(conflictDetail.getByRole("button", { name: /重新核对/ })).toBeEnabled();
    await page.unroute(workRecordsUrl);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/work-records/${conflictRecord.id}/reconcile`) && response.ok()),
      conflictDetail.getByRole("button", { name: /重新核对/ }).click(),
    ]);

    expect(await countAssociations()).toEqual(before);
    const linkedIssueIds = await db.select({ issueId: workRecordIssueLinks.issueId }).from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, company.id),
      eq(workRecordIssueLinks.projectId, project.id),
    ));
    expect(linkedIssueIds.map((link) => link.issueId).sort()).toEqual([staleDispatch.issueId, conflictDispatch.issueId].sort());
  } finally {
    if (conflictRunId) {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, conflictRunId));
    }
    await closeRegisteredClients(url);
  }
});
