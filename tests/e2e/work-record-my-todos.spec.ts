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
  await page.getByRole("button", { name: "编辑视图" }).click();
  const settings = page.getByTestId("my-todo-settings");
  await settings.getByRole("checkbox", { name: "项目" }).uncheck();
  await settings.getByRole("combobox", { name: "行密度" }).selectOption("comfortable");
  await settings.getByRole("combobox", { name: "默认项目" }).selectOption(project.id);
  await settings.getByRole("button", { name: "计划完成上移" }).click();
  await settings.getByRole("button", { name: "保存视图" }).click();
  await expect(settings).toHaveCount(0);
  const preference = await body<{ revision: number; config: { visibleFields: string[]; columnOrder: string[]; density: string; defaultProjectId: string | null } }>(
    await request.get(`/api/companies/${company.id}/work-records/my-todo-preference`), "saved preference",
  );
  expect(preference.revision).toBe(1);
  expect(preference.config).toMatchObject({ visibleFields: ["roles", "status", "due"], density: "comfortable", defaultProjectId: project.id });
  expect(preference.config.columnOrder).toEqual(["project", "roles", "due", "status"]);
  await page.reload();
  await page.getByRole("tab", { name: "我的待办" }).click();
  await expect(page.getByRole("combobox", { name: "待办项目" })).toHaveValue(project.id);
  await expect(page.getByTestId("my-todos-plan").getByRole("listitem")).toHaveCount(20);
  await expect(page.getByTestId("my-todos-plan").getByText("项目：Todo project")).toHaveCount(0);
  await page.setViewportSize({ width: 640, height: 720 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 640);
  await page.screenshot({ path: info.outputPath("my-todos-640.png"), fullPage: true });

  await page.evaluate(() => localStorage.setItem("paperclip.locale", "en"));
  await page.reload();
  await page.getByRole("tab", { name: "My to-dos" }).click();
  await expect(page.getByRole("heading", { name: "My to-dos" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit view" })).toBeVisible();
  await expect(page.getByTestId("my-todos-plan").getByRole("listitem")).toHaveCount(20);
  await page.screenshot({ path: info.outputPath("my-todos-en.png"), fullPage: true });
});
