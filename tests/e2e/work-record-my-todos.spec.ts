import { expect, test, type APIResponse } from "@playwright/test";

async function body<T>(response: APIResponse, label: string): Promise<T> {
  const text = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

test("dashboard keeps task and defect filters separate and opens the source record", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const company = await body<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `My todos ${Date.now()}` } }), "company",
  );
  const project = await body<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Todo project" } }), "project",
  );
  // A fresh company without agents opens the product onboarding overlay on the dashboard.
  // Seed an inert local agent so this test can exercise the dashboard itself.
  await body(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "Dashboard test agent", role: "engineer", adapterType: "process",
    adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  } }), "agent");
  const create = async (kind: "plan" | "defect", title: string) => body<{ id: string; revision: number }>(
    await request.post(`/api/companies/${company.id}/work-records`, { data: {
      projectId: project.id, kind, title, predecessorRecordIds: [],
      userResponsibilities: [{ userId: "local-board", role: "execution" }],
    } }), `create ${title}`,
  );
  for (let index = 0; index < 21; index++) await create("plan", `任务 ${index}`);
  const defect = await create("defect", "缺陷一");
  await body(await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${defect.id}`, {
    data: { expectedRevision: defect.revision, businessStatus: "todo" },
  }), "set defect todo");

  await page.goto(`/${company.issuePrefix}/dashboard`);
  await page.getByRole("tab", { name: "我的待办" }).click();
  const tasks = page.getByTestId("my-todos-plan");
  const defects = page.getByTestId("my-todos-defect");
  await expect(tasks.getByRole("listitem")).toHaveCount(21);
  await expect(defects.getByRole("listitem")).toHaveCount(1);
  await tasks.getByRole("combobox", { name: "任务状态" }).selectOption("done");
  await expect(tasks.getByRole("listitem")).toHaveCount(0);
  await expect(defects.getByRole("listitem")).toHaveCount(1);
  await tasks.getByRole("combobox", { name: "任务状态" }).selectOption("");
  await expect(tasks.getByRole("listitem")).toHaveCount(21);
  await page.screenshot({ path: info.outputPath("my-todos-wide.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("my-todos-narrow.png"), fullPage: true });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await tasks.getByRole("link", { name: "查看任务 任务 0" }).click();
  const drawer = page.getByTestId("work-record-detail-drawer");
  await expect(drawer.getByRole("textbox", { name: "标题" })).toHaveValue("任务 0");
  await drawer.getByRole("group", { name: "人员责任" }).getByRole("group", { name: "执行" }).getByRole("checkbox", { name: "Board" }).uncheck();
  await drawer.getByRole("button", { name: "保存计划" }).click();
  await page.goto(`/${company.issuePrefix}/dashboard`);
  await page.getByRole("tab", { name: "我的待办" }).click();
  await expect(page.getByTestId("my-todos-plan").getByRole("listitem")).toHaveCount(20);
});
