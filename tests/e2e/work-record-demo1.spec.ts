import { expect, test, type APIResponse } from "@playwright/test";

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

test("G3B1 keeps dense plan and defect views stable while saves remain non-executing", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1319, height: 1012 });
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `Demo 1 ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Demo 1 路由与密度" } }),
    "create project",
  );

  for (let index = 1; index <= 20; index += 1) {
    await json(await request.post(`/api/companies/${company.id}/work-records`, {
      data: { projectId: project.id, kind: "plan", title: `计划 ${String(index).padStart(2, "0")}`, predecessorRecordIds: [] },
    }), `create plan ${index}`);
  }
  for (let index = 1; index <= 2; index += 1) {
    await json(await request.post(`/api/companies/${company.id}/work-records`, {
      data: { projectId: project.id, kind: "defect", title: `缺陷 ${String(index).padStart(2, "0")}`, predecessorRecordIds: [] },
    }), `create defect ${index}`);
  }

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
  const rows = page.getByTestId("work-record-table-row");
  const denseTable = page.getByTestId("work-record-dense-table");
  await expect(rows).toHaveCount(20);
  await expect(page.getByText("缺陷 01", { exact: true })).toHaveCount(0);
  await denseTable.getByLabel("密度").selectOption("compact");
  await expect(denseTable).toHaveAttribute("data-density", "compact");
  expect((await rows.first().boundingBox())?.height).toBeLessThanOrEqual(32);
  await page.getByText("列设置", { exact: true }).click();
  await page.getByRole("checkbox", { name: "描述", exact: true }).uncheck();
  await expect(page.getByRole("columnheader", { name: "描述", exact: true })).toHaveCount(0);
  const ownerWidthBefore = (await page.getByRole("columnheader", { name: "负责人", exact: true }).boundingBox())?.width ?? 0;
  await page.getByRole("button", { name: "负责人加宽", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowRight");
  const ownerWidthAfter = (await page.getByRole("columnheader", { name: "负责人", exact: true }).boundingBox())?.width ?? 0;
  expect(ownerWidthAfter).toBeGreaterThan(ownerWidthBefore);
  await page.getByRole("button", { name: "负责人上移", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.getByRole("checkbox", { name: "业务状态冻结", exact: true }).check();

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("prompt");
    await dialog.accept("  扫描视图  ");
  });
  await page.getByRole("button", { name: "另存为", exact: true }).first().click();
  await expect(denseTable.getByLabel("视图")).toHaveValue(/^[0-9a-f-]{36}$/);
  await expect(denseTable.getByLabel("视图").locator("option:checked")).toHaveText("个人 · 扫描视图");
  await page.reload();
  await denseTable.getByLabel("视图").selectOption({ label: "个人 · 扫描视图" });
  await expect(denseTable).toHaveAttribute("data-density", "compact");
  await expect(page.getByRole("columnheader", { name: "描述", exact: true })).toHaveCount(0);
  const projectTitleBefore = await page.getByRole("heading", { name: "Demo 1 路由与密度", exact: true }).boundingBox();
  const tabsBefore = await page.getByRole("tab", { name: "计划", exact: true }).boundingBox();
  const mainBefore = await page.getByTestId("work-records-main").boundingBox();
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/defects$/);
  await expect(rows).toHaveCount(2);
  await expect(page.getByText("计划 01", { exact: true })).toHaveCount(0);
  const projectTitleAfter = await page.getByRole("heading", { name: "Demo 1 路由与密度", exact: true }).boundingBox();
  const tabsAfter = await page.getByRole("tab", { name: "缺陷", exact: true }).boundingBox();
  const mainAfter = await page.getByTestId("work-records-main").boundingBox();
  expect(projectTitleAfter?.y).toBe(projectTitleBefore?.y);
  expect(tabsAfter?.y).toBe(tabsBefore?.y);
  expect(mainAfter?.y).toBe(mainBefore?.y);

  await page.getByRole("tab", { name: "计划", exact: true }).click();
  const issuesBefore = await json<unknown[]>(await request.get(`/api/companies/${company.id}/issues`), "read issues before save");
  const runsBefore = await json<unknown[]>(await request.get(`/api/companies/${company.id}/live-runs`), "read runs before save");
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await page.getByPlaceholder("例如：完成发布说明").fill("浏览器安全保存");
  await page.getByPlaceholder("写明范围、约束和验收标准").fill("保存时不得产生执行对象");
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByText("浏览器安全保存", { exact: true })).toBeVisible();
  const issuesAfter = await json<unknown[]>(await request.get(`/api/companies/${company.id}/issues`), "read issues after save");
  const runsAfter = await json<unknown[]>(await request.get(`/api/companies/${company.id}/live-runs`), "read runs after save");
  expect(issuesAfter).toHaveLength(issuesBefore.length);
  expect(runsAfter).toHaveLength(runsBefore.length);

  const stored = await json<Array<{ title: string; execution: { issueId: string | null; lastRunId: string | null } }>>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
    "read saved work records",
  );
  expect(stored.find((record) => record.title === "浏览器安全保存")?.execution).toEqual(expect.objectContaining({ issueId: null, lastRunId: null }));
  await denseTable.screenshot({ path: testInfo.outputPath("g3b1-20-row-table.png") });
  await page.screenshot({ path: testInfo.outputPath("g3b1-20-row-compact.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/${company.issuePrefix}/projects/${project.id}/defects`);
  await expect(page.getByText("缺陷 01", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("g3b1-narrow-defects.png"), fullPage: true });
});

test("G3B1 resolves business and view drafts independently in all four states", async ({ page, request }) => {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `G3B1 drafts ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "双草稿四态" } }),
    "create project",
  );
  await json(await request.post(`/api/companies/${company.id}/work-records`, {
    data: { projectId: project.id, kind: "plan", title: "四态计划", predecessorRecordIds: [] },
  }), "create plan");

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
  await expect(page.getByText("四态计划", { exact: true })).toBeVisible();
  const denseTable = page.getByTestId("work-record-dense-table");

  // clean / clean
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await expect(page).toHaveURL(/\/defects$/);
  await page.getByRole("tab", { name: "计划", exact: true }).click();

  // business dirty / view clean: discard business and continue.
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await page.getByPlaceholder("例如：完成发布说明").fill("只脏业务");
  const businessOnlyMessages: string[] = [];
  page.on("dialog", async function businessOnly(dialog) {
    businessOnlyMessages.push(dialog.message());
    if (businessOnlyMessages.length === 1) await dialog.dismiss();
    else { page.off("dialog", businessOnly); await dialog.accept(); }
  });
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await expect(page).toHaveURL(/\/defects$/);
  expect(businessOnlyMessages).toHaveLength(2);
  await page.getByRole("tab", { name: "计划", exact: true }).click();

  // Save a personal view used by the remaining two combinations.
  await denseTable.getByLabel("密度").selectOption("compact");
  page.once("dialog", (dialog) => dialog.accept("四态视图"));
  await page.getByRole("button", { name: "另存为", exact: true }).first().click();
  await expect(denseTable.getByLabel("视图").locator("option:checked")).toHaveText("个人 · 四态视图");

  // view dirty / business clean: discard view only and switch to builtin.
  await denseTable.getByLabel("密度").selectOption("comfortable");
  const viewOnlyMessages: string[] = [];
  page.on("dialog", async function viewOnly(dialog) {
    viewOnlyMessages.push(dialog.message());
    if (viewOnlyMessages.length === 1) await dialog.dismiss();
    else { page.off("dialog", viewOnly); await dialog.accept(); }
  });
  await denseTable.getByLabel("视图").selectOption({ label: "内置 · 全部计划" });
  await expect(denseTable.getByLabel("视图").locator("option:checked")).toHaveText("内置 · 全部计划");

  // business dirty / view dirty: business prompts are resolved before view prompts.
  await denseTable.getByLabel("密度").selectOption("compact");
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await page.getByPlaceholder("例如：完成发布说明").fill("双脏仍保留");
  const bothMessages: string[] = [];
  page.on("dialog", async function both(dialog) {
    bothMessages.push(dialog.message());
    if (bothMessages.length === 1) await dialog.dismiss();
    else if (bothMessages.length === 2) await dialog.accept();
    else if (bothMessages.length === 3) await dialog.dismiss();
    else { page.off("dialog", both); await dialog.dismiss(); }
  });
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await expect(page).toHaveURL(/\/plans$/);
  expect(bothMessages[0]).toContain("业务记录草稿");
  expect(bothMessages[1]).toContain("放弃业务记录草稿");
  expect(bothMessages[2]).toContain("视图配置");
  expect(bothMessages[3]).toContain("放弃视图调整");
});
