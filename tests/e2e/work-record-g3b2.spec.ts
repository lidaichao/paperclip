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
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `G3B2 browser ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "G3B2 local proof" } }),
    "create project",
  );
  const version = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/versions`, { data: { name: "V1" } }),
    "create version",
  );
  const iteration = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/iterations`, { data: { versionId: version.id, name: "迭代一" } }),
    "create iteration",
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
  await json(await request.post(`/api/companies/${company.id}/work-records`, { data: {
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

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
  await expect(page.getByRole("tab", { name: "计划", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "甘特", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "缺陷", exact: true })).toBeVisible();
  await expect(page.getByTestId("version-iteration-tree")).toContainText("V1");
  await expect(page.getByTestId("version-iteration-tree")).toContainText("2/5 · 40%");

  const detailButton = page.getByRole("button", { name: "完整计划详情", exact: true }).first();
  await detailButton.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByTestId("work-record-detail-drawer");
  await expect(drawer).toContainText("唯一说明字段");
  await expect(drawer).toContainText("2026-11-08 至 2026-11-15");
  await drawer.focus();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(detailButton).toBeFocused();

  await page.getByRole("tab", { name: "甘特", exact: true }).click();
  await expect(page).toHaveURL(/\/gantt$/);
  await expect(page.getByTestId("work-records-main")).toHaveAttribute("data-view-mode", "gantt");
  await page.getByRole("tab", { name: "缺陷", exact: true }).click();
  await expect(page).toHaveURL(/\/defects$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/gantt$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/plans$/);

  for (const [name, width, height] of [["1574x1038", 1574, 1038], ["1319x1012", 1319, 1012], ["1024x768", 1024, 768]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId("version-iteration-tree")).toBeVisible();
    await screenshot(page, info, `g3b2-${name}`);
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(() => { document.documentElement.style.zoom = "200%"; });
  await expect(page.getByRole("tab", { name: "计划", exact: true })).toBeVisible();
  await screenshot(page, info, "g3b2-200-percent");
});
