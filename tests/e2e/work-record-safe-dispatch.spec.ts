import path from "node:path";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
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
