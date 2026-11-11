import { expect, test, type APIResponse, type Dialog, type Locator, type Page } from "@playwright/test";
import { createDemo1Sandbox } from "./fixtures/demo1-regression-sandbox.js";

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function answerDialogs(page: Page, answers: boolean[], action: () => Promise<unknown>) {
  const messages: string[] = [];
  const handler = async (dialog: Dialog) => {
    const answer = answers[messages.length];
    messages.push(dialog.message());
    if (answer) await dialog.accept();
    else await dialog.dismiss();
  };
  page.on("dialog", handler);
  try {
    await action();
    await expect.poll(() => messages.length).toBeGreaterThanOrEqual(answers.length);
    await page.waitForTimeout(200);
    if (messages.length !== answers.length) throw new Error(`Unexpected dialogs: ${JSON.stringify(messages)}`);
  } finally {
    page.off("dialog", handler);
  }
  return messages;
}

async function resolveBusinessDraft(page: Page, action: "save" | "discard" | "stay") {
  const decision = page.getByTestId("business-draft-decision");
  await expect(decision).toBeVisible();
  const name = action === "save" ? "保存并继续" : action === "discard" ? "放弃并继续" : "留在此处";
  await decision.getByRole("button", { name, exact: true }).click();
  await expect(decision).toHaveCount(0);
}

async function expectKeyboardFocusVisible(locator: Locator) {
  await expect(locator).toBeFocused();
  expect(await locator.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
}

async function expectRowValues(row: Locator, values: string[]) {
  await expect(row).toHaveCount(1);
  for (const value of values) await expect(row).toContainText(value);
}

async function readNarrowAnchors(page: Page, projectName: string) {
  const [title, tab, main] = await Promise.all([
    page.getByRole("heading", { name: projectName, exact: true }).boundingBox(),
    page.getByLabel("页面分区").boundingBox(),
    page.getByTestId("work-records-main").boundingBox(),
  ]);
  expect(title).not.toBeNull();
  expect(tab).not.toBeNull();
  expect(main).not.toBeNull();
  return { title, tab, main, scrollY: await page.evaluate(() => window.scrollY) };
}

async function expectMobileNavigationOffscreen(page: Page) {
  const navigation = page.getByRole("navigation", { name: "移动端导航" });
  await expect(navigation).toHaveClass(/translate-y-full/);
  const [box, viewportHeight] = await Promise.all([
    navigation.boundingBox(),
    page.evaluate(() => window.innerHeight),
  ]);
  expect(box === null || box.y >= viewportHeight).toBe(true);
}

function expectAnchorsStable(
  actual: Awaited<ReturnType<typeof readNarrowAnchors>>,
  expected: Awaited<ReturnType<typeof readNarrowAnchors>>,
) {
  for (const key of ["title", "tab", "main"] as const) {
    expect(actual[key]?.x).toBe(expected[key]?.x);
    expect(actual[key]?.y).toBe(expected[key]?.y);
  }
  expect(actual.scrollY).toBe(expected.scrollY);
  expect(actual.scrollY).toBeGreaterThan(0);
}

test("G3B1 keeps dense plan and defect views stable while saves remain non-executing", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1319, height: 1012 });
  const sandbox = await createDemo1Sandbox(request, `density-${Date.now()}`, {
    seedRecords: false,
    companyName: `Demo 1 ${Date.now()}`,
    projectName: "Demo 1 路由与密度",
    agentName: "Ada 开发",
  });
  const { company, project } = sandbox;

  const owners = [sandbox.agents.worker, await json<{ id: string; name: string }>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Belle 质检",
        role: "qa",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
    "create Belle 质检",
  )];
  const statuses = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"] as const;

  for (let index = 1; index <= 20; index += 1) {
    const record = await json<{ id: string; revision: number }>(
      await request.post(`/api/companies/${company.id}/work-records`, {
        data: {
          projectId: project.id,
          kind: "plan",
          title: `计划 ${String(index).padStart(2, "0")}`,
          assigneeAgentId: owners[(index - 1) % owners.length].id,
          qaAssigneeAgentId: owners[1].id,
          plannedStartDate: `2026-11-${String(index).padStart(2, "0")}`,
          plannedCompletionDate: `2026-11-${String(index + 5).padStart(2, "0")}`,
          predecessorRecordIds: [],
        },
      }),
      `create plan ${index}`,
    );
    await json(await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${record.id}`, {
      data: { expectedRevision: record.revision, businessStatus: statuses[(index - 1) % statuses.length] },
    }), `set plan ${index} status`);
  }
  for (let index = 1; index <= 20; index += 1) {
    const record = await json<{ id: string; revision: number }>(
      await request.post(`/api/companies/${company.id}/work-records`, {
        data: {
          projectId: project.id,
          kind: "defect",
          title: `缺陷 ${String(index).padStart(2, "0")}`,
          defectSeverity: (["critical", "high", "medium", "low"] as const)[(index - 1) % 4],
          assigneeAgentId: owners[index % owners.length].id,
          qaAssigneeAgentId: owners[1].id,
          plannedStartDate: `2026-11-${String(index).padStart(2, "0")}`,
          plannedCompletionDate: `2026-11-${String(index + 5).padStart(2, "0")}`,
          predecessorRecordIds: [],
        },
      }),
      `create defect ${index}`,
    );
    await json(await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${record.id}`, {
      data: { expectedRevision: record.revision, businessStatus: statuses[(20 - index) % statuses.length] },
    }), `set defect ${index} status`);
  }

  const issuesBaseline = await json<unknown[]>(await request.get(`/api/companies/${company.id}/issues`), "read issue baseline");
  const runsBaseline = await json<unknown[]>(await request.get(`/api/companies/${company.id}/heartbeat-runs`), "read run baseline");

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
  const rows = page.getByTestId("work-record-table-row");
  const denseTable = page.getByTestId("work-record-dense-table");
  await expect(rows).toHaveCount(20);
  await expect(page.getByText("缺陷 01", { exact: true })).toHaveCount(0);
  const searchInput = denseTable.getByLabel("搜索记录");
  await searchInput.fill("计划");
  await denseTable.getByLabel("密度").selectOption("compact");
  const taskSort = denseTable.getByRole("button", { name: "按任务排序", exact: true });
  const taskHeader = taskSort.locator("xpath=ancestor::th");
  await taskSort.focus();
  await taskSort.press("Enter");
  await expect(taskHeader).toHaveAttribute("aria-sort", "ascending");
  await expectKeyboardFocusVisible(taskSort);
  await expect(rows.first()).toContainText("计划 01");
  await taskSort.press("Enter");
  await expect(taskHeader).toHaveAttribute("aria-sort", "descending");
  await expectKeyboardFocusVisible(taskSort);
  await expect(rows.first()).toContainText("计划 20");
  await denseTable.getByLabel("分组字段").selectOption("businessStatus");
  await denseTable.getByLabel("分组字段").selectOption("");
  await denseTable.getByRole("button", { name: "筛选业务状态", exact: true }).click();
  await page.getByLabel("业务状态筛选条件", { exact: true }).selectOption("is");
  await page.getByLabel("业务状态筛选值", { exact: true }).fill("done");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("计划 20");
  await expect(rows.nth(1)).toContainText("计划 13");
  await expect(rows.nth(2)).toContainText("计划 06");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(searchInput).toHaveValue("计划");
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(20);
  await expect(denseTable).toHaveAttribute("data-density", "compact");
  expect((await rows.first().boundingBox())?.height).toBeLessThanOrEqual(32);
  const columnSettings = denseTable.getByRole("button", { name: "列", exact: true });
  await columnSettings.focus();
  await columnSettings.press("Enter");
  for (const column of ["描述", "迭代", "QA", "派发状态", "前置"]) {
    await page.getByRole("checkbox", { name: column, exact: true }).uncheck();
  }
  await expect(denseTable.getByRole("button", { name: "按描述排序", exact: true })).toHaveCount(0);
  const ownerHeader = denseTable.getByRole("button", { name: "按负责人排序", exact: true }).locator("xpath=ancestor::th");
  const ownerWidthBefore = (await ownerHeader.boundingBox())?.width ?? 0;
  await page.getByRole("button", { name: "负责人加宽", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowRight");
  const ownerWidthAfter = (await ownerHeader.boundingBox())?.width ?? 0;
  expect(ownerWidthAfter).toBeGreaterThan(ownerWidthBefore);
  await page.getByRole("button", { name: "负责人上移", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  const statusFreeze = page.getByRole("checkbox", { name: "业务状态冻结", exact: true });
  await statusFreeze.focus();
  await statusFreeze.press("Space");
  await expect(statusFreeze).toBeChecked();
  await expectKeyboardFocusVisible(statusFreeze);
  const businessStatusHeader = denseTable.getByRole("button", { name: "按业务状态排序", exact: true }).locator("xpath=ancestor::th");
  await expect(businessStatusHeader).toHaveClass(/sticky/);
  await expect(searchInput).toHaveValue("计划");

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("prompt");
    await dialog.accept("  扫描视图  ");
  });
  await page.getByRole("button", { name: "另存为", exact: true }).first().click();
  await expect(denseTable.getByRole("button", { name: "扫描视图", exact: true })).toBeVisible();
  const savedViews = await json<Array<{ name: string; revision: number; config: Record<string, unknown> }>>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-record-views/plan`),
    "read saved plan views",
  );
  expect(savedViews.find((view) => view.name === "扫描视图")).toMatchObject({
    revision: 1,
    config: {
      schemaVersion: 2,
      containerId: null,
      visibleFields: ["id", "title", "businessStatus", "assignee", "priority", "plannedStartDate", "plannedCompletionDate", "version"],
      columnOrder: ["id", "title", "assignee", "businessStatus", "priority", "plannedStartDate", "plannedCompletionDate", "version", "iteration", "qaAssignee", "dispatchState", "dependencies", "description"],
      columnWidths: { assignee: 176 },
      density: "compact",
      filters: [],
      search: "计划",
      sort: [{ field: "title", direction: "desc" }],
      groupBy: null,
      frozenFields: ["id", "title", "businessStatus"],
    },
  });
  expect(await json<unknown[]>(await request.get(`/api/companies/${company.id}/issues`), "issues after view save")).toHaveLength(issuesBaseline.length);
  expect(await json<unknown[]>(await request.get(`/api/companies/${company.id}/heartbeat-runs`), "runs after view save")).toHaveLength(runsBaseline.length);
  await page.reload();
  await denseTable.getByRole("button", { name: "扫描视图", exact: true }).click();
  await expect(denseTable).toHaveAttribute("data-density", "compact");
  await expect(denseTable.getByLabel("搜索记录")).toHaveValue("计划");
  await expect(taskHeader).toHaveAttribute("aria-sort", "descending");
  await expect(denseTable.getByLabel("分组字段")).toHaveValue("");
  await expect(denseTable.getByRole("button", { name: "按描述排序", exact: true })).toHaveCount(0);
  await expect(rows).toHaveCount(20);
  await expectRowValues(rows.filter({ hasText: "计划 20" }), ["计划 20", "Belle 质检", "2026-11-20", "2026-11-25", "已完成"]);
  await expectRowValues(rows.filter({ hasText: "计划 19" }), ["计划 19", "Ada 开发", "2026-11-19", "2026-11-24", "受阻"]);

  await page.setViewportSize({ width: 1800, height: 1600 });
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last()).toBeInViewport();
  await denseTable.screenshot({ path: testInfo.outputPath("g3b1-20-row-readable.png") });
  await page.setViewportSize({ width: 1319, height: 1012 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const projectTitleBefore = await page.getByRole("heading", { name: "Demo 1 路由与密度", exact: true }).boundingBox();
  const tabsBefore = await page.getByRole("tab", { name: "计划", exact: true }).boundingBox();
  const mainBefore = await page.getByTestId("work-records-main").boundingBox();
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/defects$/);
  await expect(rows).toHaveCount(20);
  await expect(page.getByText("计划 01", { exact: true })).toHaveCount(0);
  await expect(denseTable.getByLabel("搜索记录")).toHaveValue("");
  await expect(denseTable.getByRole("tab", { name: "全部缺陷", exact: true })).toHaveAttribute("aria-selected", "true");
  const defectViews = await json<Array<{ isBuiltin: boolean; config: { search: string; filters: unknown[] } }>>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-record-views/defect`),
    "read isolated defect views",
  );
  expect(defectViews).toEqual([expect.objectContaining({ isBuiltin: true, config: expect.objectContaining({ search: "", filters: [] }) })]);
  const projectTitleAfter = await page.getByRole("heading", { name: "Demo 1 路由与密度", exact: true }).boundingBox();
  const tabsAfter = await page.getByRole("tab", { name: "缺陷", exact: true }).boundingBox();
  const mainAfter = await page.getByTestId("work-records-main").boundingBox();
  expect(projectTitleAfter?.y).toBe(projectTitleBefore?.y);
  expect(tabsAfter?.y).toBe(tabsBefore?.y);
  expect(mainAfter?.y).toBe(mainBefore?.y);

  await page.getByRole("tab", { name: "计划", exact: true }).click();
  await expectRowValues(rows.filter({ hasText: "计划 20" }), ["计划 20", "Belle 质检", "2026-11-20", "2026-11-25", "已完成"]);
  await page.reload();
  await denseTable.getByRole("button", { name: "扫描视图", exact: true }).click();
  await expectRowValues(rows.filter({ hasText: "计划 20" }), ["计划 20", "Belle 质检", "2026-11-20", "2026-11-25", "已完成"]);
  await denseTable.getByRole("tab", { name: "全部任务", exact: true }).click();

  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await page.getByPlaceholder("例如：完成发布说明").fill("浏览器安全保存");
  await page.getByPlaceholder("写明范围、约束和验收标准").fill("保存时不得产生执行对象");
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByText("浏览器安全保存", { exact: true })).toBeVisible();
  const issuesAfter = await json<unknown[]>(await request.get(`/api/companies/${company.id}/issues`), "read issues after save");
  const runsAfter = await json<unknown[]>(await request.get(`/api/companies/${company.id}/heartbeat-runs`), "read runs after save");
  expect(issuesAfter).toHaveLength(issuesBaseline.length);
  expect(runsAfter).toHaveLength(runsBaseline.length);

  const stored = await json<Array<{ title: string; execution: { issueId: string | null; lastRunId: string | null } }>>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
    "read saved work records",
  );
  expect(stored.find((record) => record.title === "浏览器安全保存")?.execution).toEqual(expect.objectContaining({ issueId: null, lastRunId: null }));
  await page.screenshot({ path: testInfo.outputPath("g3b1-20-row-compact.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
  await expectRowValues(page.getByTestId("work-record-table-row").filter({ hasText: "计划 20" }), ["计划 20", "Belle 质检"]);
  await expect(page.getByRole("navigation", { name: "移动端导航" })).toHaveClass(/translate-y-full/);
  const narrowTable = page.getByTestId("work-record-dense-table");
  await expect(narrowTable.getByRole("tab", { name: "全部任务", exact: true })).toBeVisible();
  await expect.poll(async () => {
    try {
      await narrowTable.getByRole("button", { name: "列", exact: true }).scrollIntoViewIfNeeded();
      return true;
    } catch {
      return false;
    }
  }).toBe(true);
  const narrowColumnSettings = narrowTable.getByRole("button", { name: "列", exact: true });
  await expect(narrowColumnSettings).toBeVisible();
  const filterBox = await narrowTable.getByRole("tab", { name: "全部任务", exact: true }).boundingBox();
  const columnSettingsBox = await narrowColumnSettings.boundingBox();
  expect(filterBox?.y ?? 844).toBeLessThan(844);
  expect((columnSettingsBox?.y ?? 844) + (columnSettingsBox?.height ?? 0)).toBeLessThanOrEqual(844);
  const mobileNavigationBox = await page.getByRole("navigation", { name: "移动端导航" }).boundingBox();
  expect(mobileNavigationBox === null || (mobileNavigationBox.y >= 844 && mobileNavigationBox.y >= (columnSettingsBox?.y ?? 0) + (columnSettingsBox?.height ?? 0))).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 48));
  const pageSection = page.getByLabel("页面分区");
  const planAnchors = await readNarrowAnchors(page, "Demo 1 路由与密度");
  await expectMobileNavigationOffscreen(page);
  await pageSection.selectOption("defects");
  await expect(page).toHaveURL(/\/projects\/[^/]+\/defects$/);
  await expect(rows).toHaveCount(20);
  await expect(pageSection).toHaveValue("defects");
  const defectAnchors = await readNarrowAnchors(page, "Demo 1 路由与密度");
  expectAnchorsStable(defectAnchors, planAnchors);
  await expectMobileNavigationOffscreen(page);
  const narrowDefectRow = rows.filter({ hasText: "缺陷 01" });
  await expectRowValues(narrowDefectRow, ["缺陷 01", "Belle 质检", "2026-11-06"]);
  await expect(narrowDefectRow).not.toContainText("2026-11-01");
  await page.screenshot({ path: testInfo.outputPath("g3b1-narrow-defects.png") });
  await pageSection.selectOption("plans");
  await expect(page).toHaveURL(/\/projects\/[^/]+\/plans$/);
  await expect(pageSection).toHaveValue("plans");
  const returnedPlanAnchors = await readNarrowAnchors(page, "Demo 1 路由与密度");
  expectAnchorsStable(returnedPlanAnchors, planAnchors);
  await expectMobileNavigationOffscreen(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("g3b1-narrow-plans-returned.png") });
});

test("G3B1 resolves business and view drafts independently in all four states", async ({ page, request }) => {
  const { company, project } = await createDemo1Sandbox(request, `drafts-${Date.now()}`, {
    seedRecords: false,
    companyName: `G3B1 drafts ${Date.now()}`,
    projectName: "双草稿四态",
  });
  await json(await request.post(`/api/companies/${company.id}/work-records`, {
    data: { projectId: project.id, kind: "plan", title: "四态计划", predecessorRecordIds: [] },
  }), "create plan");

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
  await expect(page.getByText("四态计划", { exact: true })).toBeVisible();
  const denseTable = page.getByTestId("work-record-dense-table");

  // clean / clean: navigation has no decision dialog.
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await expect(page).toHaveURL(/\/defects$/);
  await page.getByRole("tab", { name: "计划", exact: true }).click();

  // business dirty / view clean: save business, then continue without a view decision.
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await page.getByPlaceholder("例如：完成发布说明").fill("只脏业务已保存");
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await resolveBusinessDraft(page, "save");
  await expect(page).toHaveURL(/\/defects$/);
  const afterBusinessSave = await json<Array<{ title: string }>>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
    "business-only save",
  );
  expect(afterBusinessSave.map((record) => record.title)).toContain("只脏业务已保存");
  await page.getByRole("tab", { name: "计划", exact: true }).click();

  // Create a personal view used by the remaining combinations.
  await denseTable.getByLabel("密度").selectOption("compact");
  page.once("dialog", (dialog) => dialog.accept("四态视图"));
  await denseTable.getByRole("button", { name: "视图操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "另存为", exact: true }).click();
  await expect(denseTable.getByRole("button", { name: "四态视图", exact: true })).toBeVisible();

  // view dirty / business clean: save, then separately discard, without touching records.
  await denseTable.getByLabel("密度").selectOption("comfortable");
  const savedViewMessages = await answerDialogs(page, [true], () => denseTable.getByRole("tab", { name: "全部任务", exact: true }).click());
  expect(savedViewMessages[0]).toContain("视图配置");
  await expect(denseTable.getByRole("tab", { name: "全部任务", exact: true })).toHaveAttribute("aria-selected", "true");
  await denseTable.getByRole("button", { name: "四态视图", exact: true }).click();
  await expect(denseTable).toHaveAttribute("data-density", "comfortable");
  await denseTable.getByLabel("密度").selectOption("compact");
  const discardedViewMessages = await answerDialogs(page, [false, true], () => denseTable.getByRole("tab", { name: "全部任务", exact: true }).click());
  expect(discardedViewMessages[1]).toContain("放弃视图调整");
  await denseTable.getByRole("button", { name: "四态视图", exact: true }).click();
  await expect(denseTable).toHaveAttribute("data-density", "comfortable");

  // both dirty: saving business leaves the view draft intact when view resolution is cancelled.
  await denseTable.getByLabel("密度").selectOption("compact");
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await page.getByPlaceholder("例如：完成发布说明").fill("双脏先存业务");
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  const bothSaveMessages = await answerDialogs(page, [false, false], () => resolveBusinessDraft(page, "save"));
  await expect(page).toHaveURL(/\/plans$/);
  expect(bothSaveMessages[0]).toContain("视图配置");
  await expect(page.getByText("未保存配置", { exact: true })).toBeVisible();
  expect((await json<Array<{ title: string }>>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
    "both-dirty business save",
  )).map((record) => record.title)).toContain("双脏先存业务");

  // both dirty: discarding business also leaves the view draft intact when view resolution is cancelled.
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await page.getByPlaceholder("例如：完成发布说明").fill("双脏放弃业务");
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  const bothDiscardMessages = await answerDialogs(page, [false, false], () => resolveBusinessDraft(page, "discard"));
  await expect(page).toHaveURL(/\/plans$/);
  expect(bothDiscardMessages[0]).toContain("视图配置");
  await expect(page.getByText("未保存配置", { exact: true })).toBeVisible();
  expect((await json<Array<{ title: string }>>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
    "both-dirty business discard",
  )).map((record) => record.title)).not.toContain("双脏放弃业务");

  // Saving the view directly must not close or rewrite the business draft.
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  const titleInput = page.getByPlaceholder("例如：完成发布说明");
  await titleInput.fill("保存视图后业务仍在");
  await page.getByRole("button", { name: "保存修改", exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByText("未保存配置", { exact: true })).toHaveCount(0);
  await expect(titleInput).toHaveValue("保存视图后业务仍在");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await resolveBusinessDraft(page, "discard");

  // Switching records asks about the business draft and does not overwrite it when cancelled.
  await page.getByRole("button", { name: "四态计划", exact: true }).click();
  await titleInput.fill("切记录草稿");
  const otherRecordButton = page.getByRole("button", { name: "双脏先存业务", exact: true });
  await otherRecordButton.evaluate((button) => (button as HTMLButtonElement).click());
  await resolveBusinessDraft(page, "stay");
  await expect(titleInput).toHaveValue("切记录草稿");
  await otherRecordButton.evaluate((button) => (button as HTMLButtonElement).click());
  await resolveBusinessDraft(page, "discard");
  await expect(titleInput).toHaveValue("双脏先存业务");
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  // Refresh protection keeps an unsaved business draft when the native leave is cancelled.
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await titleInput.fill("刷新仍保留");
  const reloadMessages = await answerDialogs(page, [false], () => {
    void page.reload().catch(() => null);
    return Promise.resolve();
  });
  expect(reloadMessages).toHaveLength(1);
  await expect(titleInput).toHaveValue("刷新仍保留");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await resolveBusinessDraft(page, "discard");

  // Back navigation uses the same business-first guard; cancel keeps the draft, discard allows leaving.
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await expect(page).toHaveURL(/\/defects$/);
  await page.getByRole("tab", { name: "计划", exact: true }).click();
  await expect(page).toHaveURL(/\/plans$/);
  await page.getByRole("button", { name: "新建计划", exact: true }).click();
  await titleInput.fill("后退仍保留");
  void page.goBack();
  await resolveBusinessDraft(page, "stay");
  await expect(page).toHaveURL(/\/plans$/);
  await expect(titleInput).toHaveValue("后退仍保留");
  void page.goBack();
  await resolveBusinessDraft(page, "discard");
  await expect(page).toHaveURL(/\/defects$/);
});
