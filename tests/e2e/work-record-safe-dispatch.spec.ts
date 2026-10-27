import path from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
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

test("work record shows four trustworthy layers and clears queued after the real run ends", async ({ page, request }) => {
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
        predecessorRecordIds: [],
      },
    }),
    "create work record",
  );

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/records`);
  await expect(page.locator('[data-slot="card-title"]', { hasText: "Browser status truth" })).toBeVisible();
  for (const label of ["业务状态", "派发状态", "执行投影", "实时运行"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "明确派发", exact: true }).click();
  await expect(page.getByText("已派发，等待调度", { exact: true }).first()).toBeVisible();

  await expect.poll(async () => {
    const records = await json<Array<{ id: string; execution: { lastRunStatus: string | null } }>>(
      await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
      "poll work records",
    );
    return records.find((item) => item.id === record.id)?.execution.lastRunStatus ?? null;
  }, { timeout: 20_000 }).toBe("succeeded");

  await page.reload();
  await expect(page.getByText("投影异常", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("已结束 · 成功", { exact: true })).toBeVisible();
  await expect(page.getByText("已排队", { exact: true })).toHaveCount(0);
  await page.getByText("记录详情", { exact: true }).click();
  await expect(page.getByRole("link", { name: /打开原生任务/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "打开最近一次运行" })).toBeVisible();

  const screenshotPath = process.env.LUN277_SCREENSHOT_PATH
    ? path.resolve(process.env.LUN277_SCREENSHOT_PATH)
    : test.info().outputPath("work-record-state-layers.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
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

    await page.goto(`/${company.issuePrefix}/projects/${project.id}/records`);
    const staleCard = page.locator('[data-slot="card"]', { hasText: "Stale projection proof" });
    const conflictCard = page.locator('[data-slot="card"]', { hasText: "Conflict projection proof" });
    await expect(staleCard.getByText("投影已过期", { exact: true })).toBeVisible();
    await expect(conflictCard.getByText("状态冲突", { exact: true })).toBeVisible();
    await expect(staleCard.getByRole("button", { name: "重新核对状态" })).toBeEnabled();
    await expect(conflictCard.getByRole("button", { name: "重新核对状态" })).toBeEnabled();
    await expect(staleCard.getByRole("button", { name: "核对同一请求" })).toHaveCount(0);
    await expect(conflictCard.getByRole("button", { name: "核对同一请求" })).toHaveCount(0);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/work-records/${staleRecord.id}/reconcile`) && response.ok()),
      staleCard.getByRole("button", { name: "重新核对状态" }).click(),
    ]);
    await expect(staleCard.getByText("投影已过期", { exact: true })).toHaveCount(0);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/work-records/${conflictRecord.id}/reconcile`) && response.ok()),
      conflictCard.getByRole("button", { name: "重新核对状态" }).click(),
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
