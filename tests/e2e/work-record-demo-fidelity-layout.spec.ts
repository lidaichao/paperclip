import { expect, test, type APIResponse, type Locator, type Page, type TestInfo } from "@playwright/test";

type Viewport = { width: number; height: number; label: string };

const viewports: Viewport[] = [
  { width: 1319, height: 1012, label: "1319x1012" },
  { width: 1540, height: 1117, label: "1540x1117" },
  { width: 1574, height: 1038, label: "1574x1038" },
];

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function box(locator: Locator, label: string) {
  await expect(locator, label).toBeVisible();
  await expect.poll(async () => locator.boundingBox(), {
    message: `${label} 应有可测量的布局边界`,
    timeout: 5_000,
  }).not.toBeNull();
  const value = await locator.boundingBox();
  if (!value) throw new Error(`${label} 在读取布局边界时被重新渲染`);
  return value;
}

async function readWorkspaceAnchors(page: Page, projectName: string) {
  return {
    title: await box(page.getByRole("heading", { name: projectName, exact: true }), "项目标题"),
    tabs: await box(page.getByRole("tab", { name: "计划", exact: true }), "项目页签锚点"),
    tree: await box(page.getByTestId("version-iteration-tree"), "版本迭代栏"),
    main: await box(page.getByTestId("work-records-main"), "业务主区"),
    rail: await box(page.getByTestId("work-record-rail-shell"), "版本迭代栏容器"),
    content: await box(page.getByTestId("work-record-workspace-content"), "业务内容区"),
  };
}

function expectStableAnchors(
  actual: Awaited<ReturnType<typeof readWorkspaceAnchors>>,
  expected: Awaited<ReturnType<typeof readWorkspaceAnchors>>,
) {
  for (const key of ["title", "tabs", "tree", "main", "rail", "content"] as const) {
    expect(Math.abs(actual[key].x - expected[key].x), `${key} 切页后横向位移`).toBeLessThanOrEqual(1);
    expect(Math.abs(actual[key].y - expected[key].y), `${key} 切页后纵向位移`).toBeLessThanOrEqual(1);
  }
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

test("Demo fidelity keeps plan, gantt and defect workspace anchors stable", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const projectName = "Demo 还原布局基线";
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `Demo fidelity ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: projectName } }),
    "create project",
  );
  const version = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/versions`, { data: { name: "V1" } }),
    "create version",
  );
  const iteration = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/iterations`, {
      data: { versionId: version.id, name: "11月" },
    }),
    "create iteration",
  );
  await json(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "plan",
        title: "布局基线任务",
        iterationId: iteration.id,
        plannedStartDate: "2026-11-10",
        plannedCompletionDate: "2026-11-12",
        predecessorRecordIds: [],
      },
    }),
    "create plan record",
  );
  await json(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "defect",
        title: "布局基线缺陷",
        iterationId: iteration.id,
        predecessorRecordIds: [],
      },
    }),
    "create defect record",
  );

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
    await expect(page.getByTestId("work-records-main")).toHaveAttribute("data-kind", "plan");
    const plan = await readWorkspaceAnchors(page, projectName);
    expect(Math.abs(plan.rail.width - 210), `${viewport.label} 展开侧栏应为 210px`).toBeLessThanOrEqual(1);

    const recordsBeforeDrawer = await json<unknown[]>(
      await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
      "read records before opening drawer",
    );
    await page.getByRole("button", { name: "新建计划", exact: true }).click();
    await expect(page.getByTestId("work-record-detail-drawer")).toBeVisible();
    const contentWithDrawer = await box(page.getByTestId("work-record-workspace-content"), "抽屉打开后的业务内容区");
    expect(Math.abs(contentWithDrawer.x - plan.content.x), "抽屉不应横向推动业务内容").toBeLessThanOrEqual(1);
    expect(Math.abs(contentWithDrawer.width - plan.content.width), "抽屉不应压缩业务内容").toBeLessThanOrEqual(1);
    expect(await json<unknown[]>(
      await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
      "read records after opening drawer",
    )).toHaveLength(recordsBeforeDrawer.length);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("work-record-detail-drawer")).toHaveCount(0);

    const railToggle = page.getByTestId("work-record-rail-toggle");
    await expect(railToggle).toHaveAttribute("aria-expanded", "true");
    await railToggle.click();
    await expect(page.getByTestId("work-record-workspace-grid")).toHaveAttribute("data-rail-open", "false");
    await expect(railToggle).toHaveAttribute("aria-expanded", "false");
    const collapsedPlanContent = await box(page.getByTestId("work-record-workspace-content"), "收起后的计划内容区");

    await page.getByRole("tab", { name: "甘特", exact: true }).click();
    await expect(page).toHaveURL(/\/gantt$/);
    await expect(page.getByTestId("work-records-main")).toHaveAttribute("data-view-mode", "gantt");
    await expect(page.getByTestId("work-record-workspace-grid")).toHaveAttribute("data-rail-open", "false");
    const ganttContent = await box(page.getByTestId("work-record-workspace-content"), "收起后的甘特内容区");
    expect(Math.abs(ganttContent.x - collapsedPlanContent.x), "计划切甘特时内容不应位移").toBeLessThanOrEqual(1);

    await page.getByRole("tab", { name: "缺陷", exact: true }).click();
    await expect(page).toHaveURL(/\/defects$/);
    await expect(page.getByTestId("work-records-main")).toHaveAttribute("data-kind", "defect");
    await expect(page.getByTestId("work-record-workspace-grid")).toHaveAttribute("data-rail-open", "false");
    const defectContent = await box(page.getByTestId("work-record-workspace-content"), "收起后的缺陷内容区");
    expect(Math.abs(defectContent.x - collapsedPlanContent.x), "甘特切缺陷时内容不应位移").toBeLessThanOrEqual(1);

    await page.getByTestId("work-record-rail-toggle").click();
    await expect(page.getByTestId("work-record-workspace-grid")).toHaveAttribute("data-rail-open", "true");
    expectStableAnchors(await readWorkspaceAnchors(page, projectName), plan);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot(page, info, `demo-fidelity-${viewport.label}`);
  }
});
