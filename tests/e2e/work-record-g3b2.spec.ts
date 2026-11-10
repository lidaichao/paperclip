import { expect, test, type APIResponse, type Page, type TestInfo } from "@playwright/test";

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

test("G3B2 keeps version iteration progress, tabs and complete details stable", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `G3B2 browser ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "G3B2 local proof" } }),
    "create project",
  );
  const version = await json<{ id: string; revision: number }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/versions`, { data: { name: "V1" } }),
    "create version",
  );
  const iteration = await json<{ id: string; revision: number }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/iterations`, { data: { versionId: version.id, name: "迭代一" } }),
    "create iteration",
  );
  await json<{ id: string; revision: number }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/iterations`, { data: { versionId: version.id, name: "空迭代" } }),
    "create empty iteration",
  );
  const statuses = ["done", "done", "cancelled", "todo", "in_progress"] as const;
  for (const [index, businessStatus] of statuses.entries()) {
    const record = await json<{ id: string; revision: number }>(
      await request.post(`/api/companies/${company.id}/work-records`, { data: {
        projectId: project.id,
        iterationId: iteration.id,
        kind: "plan",
        title: index === 0 ? "完整计划详情" : `计划 ${index + 1}`,
        description: index === 0 ? "唯一说明字段" : null,
        plannedStartDate: "2026-11-08",
        plannedCompletionDate: "2026-11-15",
        predecessorRecordIds: [],
      } }),
      "create plan",
    );
    await json(await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${record.id}`, { data: { expectedRevision: record.revision, businessStatus } }), "update status");
  }
  const defect = await json<{ id: string; revision: number }>(await request.post(`/api/companies/${company.id}/work-records`, { data: {
    projectId: project.id,
    iterationId: iteration.id,
    kind: "defect",
    title: "完整缺陷详情",
    description: "复现：打开页面。预期：稳定。实际：曾错位。",
    defectSeverity: "high",
    plannedStartDate: "2026-11-08",
    plannedCompletionDate: "2026-11-10",
    predecessorRecordIds: [],
  } }), "create defect");
  await json(await request.post(`/api/companies/${company.id}/work-records`, { data: {
    projectId: project.id,
    iterationId: iteration.id,
    kind: "defect",
    title: "第二个缺陷",
    description: "用于切记录保护",
    predecessorRecordIds: [],
  } }), "create second defect");

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/gantt`);
  await expect(page).toHaveURL(/\/gantt$/);
  await expect(page.getByTestId("work-records-main")).toHaveAttribute("data-view-mode", "gantt");

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
  await expect(page.getByRole("tab", { name: "计划", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "甘特图", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "缺陷", exact: true })).toBeVisible();
  await expect(page.getByTestId("version-iteration-tree")).toContainText("V1");
  await expect(page.getByTestId("version-iteration-tree")).toContainText("2/5 · 40%");

  const versionEdit = page.getByRole("button", { name: "编辑版本 V1" });
  await versionEdit.focus();
  await versionEdit.press("Enter");
  const containerForm = page.getByTestId("container-edit-form");
  await containerForm.getByLabel("名称").fill("V1 我的修改");
  await containerForm.getByLabel("目标日期").fill("2026-12-31");
  await json(await request.patch(`/api/companies/${company.id}/projects/${project.id}/versions/${version.id}`, { data: {
    expectedRevision: version.revision,
    name: "V1 远端修改",
  } }), "concurrent version update");
  await containerForm.getByRole("button", { name: "保存", exact: true }).click();
  await expect(containerForm.getByRole("alert")).toContainText("你的输入仍保留");
  await expect(containerForm.getByLabel("名称")).toHaveValue("V1 我的修改");
  await containerForm.getByRole("button", { name: "复制我的修改后重试" }).click();
  await expect(containerForm).toHaveCount(0);
  await expect(page.getByTestId("version-iteration-tree")).toContainText("V1 我的修改");

  const iterationEdit = page.getByRole("button", { name: "编辑迭代 迭代一" });
  await iterationEdit.focus();
  await iterationEdit.press("Enter");
  await page.getByTestId("container-edit-form").getByLabel("名称").fill("迭代一已更新");
  await page.getByTestId("container-edit-form").getByLabel("开始日期").fill("2026-11-02");
  await page.getByTestId("container-edit-form").getByLabel("结束日期").fill("2026-11-20");
  await page.getByTestId("container-edit-form").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("version-iteration-tree")).toContainText("迭代一已更新");

  await page.getByRole("button", { name: "版本与迭代管理", exact: true }).click();
  const containerAdmin = page.getByTestId("container-admin-view");
  await containerAdmin.getByRole("button", { name: "管理版本 V1 我的修改", exact: true }).click();
  const emptyDelete = containerAdmin.getByRole("button", { name: "删除迭代 空迭代", exact: true });
  await emptyDelete.focus();
  await expect(emptyDelete).toBeFocused();
  await emptyDelete.press("Enter");
  const deleteDialog = page.getByTestId("container-delete-confirmation");
  await expect(deleteDialog.getByRole("button", { name: "取消" })).toBeFocused();
  await deleteDialog.getByRole("button", { name: "取消" }).click();
  await expect(containerAdmin).toContainText("空迭代");
  await emptyDelete.click();
  await deleteDialog.getByLabel(/对象名称/).fill("空迭代");
  await deleteDialog.getByRole("button", { name: "确认删除" }).click();
  await expect(containerAdmin).not.toContainText("空迭代");
  await containerAdmin.getByRole("button", { name: "返回版本管理", exact: true }).click();
  await containerAdmin.getByRole("button", { name: "返回需求池", exact: true }).click();

  const detailButton = page.getByRole("button", { name: "完整计划详情", exact: true }).first();
  await detailButton.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByTestId("work-record-detail-drawer");
  await expect(drawer.getByLabel("描述")).toHaveValue("唯一说明字段");
  await expect(drawer.getByLabel("计划开始")).toHaveValue("2026-11-08");
  await expect(drawer.getByLabel("计划完成")).toHaveValue("2026-11-15");
  await drawer.focus();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(detailButton).toBeFocused();

  await detailButton.click();
  const recordEditor = page.getByRole("dialog", { name: /编辑计划/ });
  await recordEditor.getByLabel("标题").fill("计划详情未保存");
  await page.getByRole("button", { name: "计划 2", exact: true }).click({ position: { x: 8, y: 8 } });
  const decision = page.getByTestId("business-draft-decision");
  await expect(decision.getByRole("button", { name: "留在此处" })).toBeFocused();
  await decision.getByRole("button", { name: "留在此处" }).click();
  await expect(recordEditor.getByLabel("标题")).toHaveValue("计划详情未保存");
  await page.getByRole("button", { name: "计划 2", exact: true }).click({ position: { x: 8, y: 8 } });
  await decision.getByRole("button", { name: "放弃并继续" }).click();
  await expect(page.getByTestId("work-record-detail-drawer").getByLabel("标题")).toHaveValue("计划 2");

  await page.getByRole("dialog", { name: /编辑计划/ }).getByLabel("标题").fill("计划 2 保存后切页");
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await decision.getByRole("button", { name: "保存并继续" }).click();
  await expect(page).toHaveURL(/\/defects$/);

  const defectRow = page.getByRole("button", { name: "完整缺陷详情", exact: true }).first();
  await defectRow.click();
  const defectDrawer = page.getByTestId("work-record-detail-drawer");
  const defectEditor = page.getByRole("dialog", { name: /编辑缺陷/ });
  await defectEditor.getByLabel("描述").fill("复现：键盘切页。预期：保留。实际：已修复。");
  await defectEditor.getByLabel("严重度").selectOption("critical");
  await defectEditor.getByLabel("计划完成").fill("2026-11-12");
  await page.getByRole("tab", { name: "计划", exact: true }).click();
  await expect(page).toHaveURL(/\/plans$/);
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await expect(page).toHaveURL(/\/defects$/);
  await defectRow.click();
  await expect(page.getByTestId("work-record-detail-drawer").getByLabel("描述")).toHaveValue("复现：键盘切页。预期：保留。实际：已修复。");
  await expect(page.getByTestId("work-record-detail-drawer").getByLabel("严重度")).toHaveValue("critical");
  await expect(page.getByTestId("work-record-detail-drawer").getByLabel("计划完成")).toHaveValue("2026-11-12");

  let rejectNextSave = true;
  await page.route(`**/api/companies/${company.id}/projects/${project.id}/work-records/${defect.id}`, async (route) => {
    if (rejectNextSave && route.request().method() === "PATCH") {
      rejectNextSave = false;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "测试保存失败" }) });
      return;
    }
    await route.continue();
  });
  const failedDraft = page.getByRole("dialog", { name: /编辑缺陷/ }).getByLabel("描述");
  await failedDraft.fill("保存失败仍保留的输入");
  await page.getByRole("tab", { name: "计划", exact: true }).click();
  await decision.getByRole("button", { name: "保存并继续" }).click();
  await expect(page).toHaveURL(/\/defects$/);
  await expect(failedDraft).toHaveValue("保存失败仍保留的输入");
  await expect(page.getByRole("dialog", { name: /编辑缺陷/ }).getByRole("alert")).toContainText("测试保存失败");
  await page.getByRole("dialog", { name: /编辑缺陷/ }).getByRole("button", { name: "取消" }).click();
  await decision.getByRole("button", { name: "放弃并继续" }).click();
  await page.unroute(`**/api/companies/${company.id}/projects/${project.id}/work-records/${defect.id}`);

  await page.getByRole("tab", { name: "甘特图", exact: true }).click();
  await expect(page).toHaveURL(/\/gantt$/);
  await expect(page.getByTestId("work-records-main")).toHaveAttribute("data-view-mode", "gantt");
  await page.goBack();
  await expect(page).toHaveURL(/\/defects$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/gantt$/);
  await page.getByRole("tab", { name: "计划", exact: true }).click();
  await expect(page).toHaveURL(/\/plans$/);

  const anchorSnapshot = async (kind: "plan" | "defect", mode: "table" | "gantt") => {
    const visibleMain = page.locator(`[data-testid="work-records-main"][data-kind="${kind}"][data-view-mode="${mode}"]`);
    const position = (locator: typeof visibleMain) => locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    });
    const [title, tabs, main] = await Promise.all([
      position(page.getByRole("heading", { name: "G3B2 local proof", exact: true })),
      position(page.getByTestId("work-record-top-navigation").getByRole("tablist")),
      position(visibleMain),
    ]);
    return { title, tabsY: tabs.y, main };
  };
  const verifyAnchorsAcrossTabs = async () => {
    await page.getByRole("tab", { name: "计划", exact: true }).click();
    await expect(page.locator('[data-testid="work-records-main"][data-kind="plan"][data-view-mode="table"]')).toBeVisible();
    const baseline = await anchorSnapshot("plan", "table");
    for (const [tab, kind, mode] of [["甘特图", "plan", "gantt"], ["缺陷", "defect", "table"]] as const) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(page.locator(`[data-testid="work-records-main"][data-kind="${kind}"][data-view-mode="${mode}"]`)).toBeVisible();
      expect(await anchorSnapshot(kind, mode)).toEqual(baseline);
    }
    await page.getByRole("tab", { name: "计划", exact: true }).click();
  };

  for (const [name, width, height] of [["1574x1038", 1574, 1038], ["1319x1012", 1319, 1012], ["1024x768", 1024, 768]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => { document.documentElement.style.zoom = "100%"; });
    await verifyAnchorsAcrossTabs();
    await expect(page.getByTestId("version-iteration-tree")).toBeVisible();
    await page.getByRole("button", { name: "编辑版本 V1 我的修改" }).focus();
    await screenshot(page, info, `g3b2-${name}`);
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(() => { document.documentElement.style.zoom = "200%"; });
  await verifyAnchorsAcrossTabs();
  await expect(page.getByRole("tab", { name: "计划", exact: true })).toBeVisible();
  await expect(page.getByTestId("version-iteration-tree")).toBeVisible();
  const rect = (selector: string) => page.getByTestId(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  const [railBox, recordsBox] = await Promise.all([
    rect("work-record-rail-shell"),
    rect("work-record-workspace-content"),
  ]);
  expect(
    railBox.x + railBox.width <= recordsBox.x
      || recordsBox.x + recordsBox.width <= railBox.x
      || railBox.y + railBox.height <= recordsBox.y
      || recordsBox.y + recordsBox.height <= railBox.y,
  ).toBe(true);
  await page.getByRole("button", { name: "编辑版本 V1 我的修改" }).focus();
  await screenshot(page, info, "g3b2-200-percent");

  const readOnlyCapabilities = Object.fromEntries([
    "manageContainers", "editRecords", "preparePackage", "escalateAssignmentGaps", "recordPoVerdict", "recordQaVerdict", "linkDefect", "reconcile",
  ].map((key) => [key, { allowed: false, reason: "只读成员只能查看" }]));
  await page.route(`**/api/companies/${company.id}/projects/${project.id}/work-record-capabilities`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(readOnlyCapabilities) }));
  await page.reload();
  await expect(page.getByTestId("version-iteration-tree")).toContainText("只读");
  await expect(page.getByRole("button", { name: /^编辑版本/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /操作菜单$/ })).toHaveCount(0);
  await expect(page.getByLabel("新版本名称")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建计划" })).toBeDisabled();
});
