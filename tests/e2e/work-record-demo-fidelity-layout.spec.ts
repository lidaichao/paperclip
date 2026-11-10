import path from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test, type APIResponse, type Locator, type Page, type TestInfo } from "@playwright/test";
import { eq } from "../../server/node_modules/drizzle-orm/index.js";
import {
  agentWakeupRequests,
  closeRegisteredClients,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "../../packages/db/src/index.ts";
import type { WorkRecord } from "@paperclipai/shared";

type Viewport = { width: number; height: number; label: string };

const viewports: Viewport[] = [
  { width: 1319, height: 1012, label: "1319x1012" },
  { width: 1540, height: 1117, label: "1540x1117" },
  { width: 1574, height: 1038, label: "1574x1038" },
];

const minimumVisiblePlanRows: Record<string, number> = {
  "1319x1012": 16,
  "1540x1117": 19,
  "1574x1038": 17,
};

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function box(locator: Locator, label: string) {
  await expect(locator, label).toBeVisible();
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }).catch((error) => {
    throw new Error(`${label} 应有可测量的布局边界`, { cause: error });
  });
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

async function waitForOuterShellToSettle(page: Page, projectName: string) {
  const title = page.getByRole("heading", { name: projectName, exact: true });
  let previousX: number | null = null;
  await expect.poll(async () => {
    const currentX = (await title.evaluate((element) => element.getBoundingClientRect().x));
    const stable = previousX !== null && Math.abs(currentX - previousX) <= 1;
    previousX = currentX;
    return stable;
  }, {
    message: "Paperclip 外层侧栏完成响应式布局后再记录业务区锚点",
    intervals: [100, 150, 200],
    timeout: 3_000,
  }).toBe(true);
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

async function connectToE2eDatabase() {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  const url = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
  return { db: createDb(url), url };
}

async function nativeSideEffectCounts(db: ReturnType<typeof createDb>, companyId: string) {
  return {
    issues: (await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId))).length,
    comments: (await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.companyId, companyId))).length,
    runs: (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).length,
    wakes: (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).length,
  };
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
  const independentIteration = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/iterations`, {
      data: { versionId: version.id, name: "独立排期" },
    }),
    "create independent iteration",
  );
  const changedIteration = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/iterations`, {
      data: { versionId: version.id, name: "父级调整后" },
    }),
    "create changed iteration",
  );
  const planRecord = await json<WorkRecord>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "plan",
        title: "布局基线任务",
        iterationAssignmentMode: "independent",
        iterationId: iteration.id,
        plannedStartDate: "2026-11-10",
        plannedCompletionDate: "2026-11-12",
        predecessorRecordIds: [],
      },
    }),
    "create plan record",
  );
  const childPlanRecord = await json<WorkRecord>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "plan",
        title: "布局子任务",
        parentRecordId: planRecord.id,
        iterationAssignmentMode: "inherit_parent",
        predecessorRecordIds: [],
      },
    }),
    "create child plan record",
  );
  const grandchildPlanRecord = await json<WorkRecord>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "plan",
        title: "布局孙任务",
        parentRecordId: childPlanRecord.id,
        iterationAssignmentMode: "inherit_parent",
        predecessorRecordIds: [],
      },
    }),
    "create grandchild plan record",
  );
  const independentChild = await json<WorkRecord>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "plan",
        title: "独立排期子树",
        parentRecordId: planRecord.id,
        iterationAssignmentMode: "independent",
        iterationId: independentIteration.id,
        predecessorRecordIds: [],
      },
    }),
    "create independent child",
  );
  const independentGrandchild = await json<WorkRecord>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "plan",
        title: "独立边界内孙任务",
        parentRecordId: independentChild.id,
        iterationAssignmentMode: "inherit_parent",
        predecessorRecordIds: [],
      },
    }),
    "create independent grandchild",
  );
  const moveTarget = await json<WorkRecord>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: project.id,
        kind: "plan",
        title: "换父目标",
        iterationAssignmentMode: "independent",
        iterationId: independentIteration.id,
        predecessorRecordIds: [],
      },
    }),
    "create move target",
  );
  for (let index = 0; index < 14; index += 1) {
    await json<WorkRecord>(
      await request.post(`/api/companies/${company.id}/work-records`, {
        data: {
          projectId: project.id,
          kind: "plan",
          title: `首屏密度任务 ${index + 1}`,
          iterationAssignmentMode: "independent",
          iterationId: iteration.id,
          predecessorRecordIds: [],
        },
      }),
      `create density record ${index + 1}`,
    );
  }
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
    await waitForOuterShellToSettle(page, projectName);
    const plan = await readWorkspaceAnchors(page, projectName);
    expect(Math.abs(plan.rail.width - 210), `${viewport.label} 展开侧栏应为 210px`).toBeLessThanOrEqual(1);
    await expect(page.locator(`[data-record-id="${planRecord.id}"]`)).toHaveAttribute("data-tree-depth", "0");
    await expect(page.locator(`[data-record-id="${childPlanRecord.id}"]`)).toHaveAttribute("data-tree-depth", "1");
    await expect(page.locator(`[data-record-id="${grandchildPlanRecord.id}"]`)).toHaveAttribute("data-tree-depth", "2");
    await page.getByRole("button", { name: "收起 布局基线任务", exact: true }).click();
    await expect(page.locator(`[data-record-id="${childPlanRecord.id}"]`)).toHaveCount(0);
    await page.getByRole("button", { name: "展开 布局基线任务", exact: true }).click();
    await expect(page.locator(`[data-record-id="${childPlanRecord.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-record-id="${grandchildPlanRecord.id}"]`)).toBeVisible();
    const planRows = page.getByTestId("work-record-table-row");
    await expect(planRows).toHaveCount(20);
    const table = await box(page.getByTestId("work-record-table-scroller"), "计划高密度表格");
    expect(table.y - plan.content.y, `${viewport.label} 表格应在业务区首屏直接出现`).toBeLessThanOrEqual(250);
    const firstRow = await box(planRows.first(), "计划首行");
    expect(firstRow.height, `${viewport.label} 紧凑行高`).toBeLessThanOrEqual(33);
    const visibleRowCount = await planRows.evaluateAll((rows) => rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }).length);
    expect(visibleRowCount, `${viewport.label} 首屏任务容量应达到 Demo 实测基线`).toBeGreaterThanOrEqual(minimumVisiblePlanRows[viewport.label]);
    await screenshot(page, info, `demo-fidelity-plan-wbs-${viewport.label}`);

    await page.getByRole("button", { name: "版本与迭代管理", exact: true }).click();
    await expect(page.getByTestId("version-iteration-tree")).toBeVisible();
    const containerAdmin = page.getByTestId("container-admin-view");
    await expect(containerAdmin).toBeVisible();
    await expect(containerAdmin.getByText("11月", { exact: true })).toHaveCount(0);
    await containerAdmin.getByRole("button", { name: "管理版本 V1", exact: true }).click();
    await expect(containerAdmin.getByText("11月", { exact: true })).toBeVisible();
    await screenshot(page, info, `demo-fidelity-container-admin-${viewport.label}`);
    await containerAdmin.getByRole("button", { name: "返回版本管理", exact: true }).click();
    await containerAdmin.getByRole("button", { name: "返回需求池", exact: true }).click();
    await expect(planRows).toHaveCount(20);

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

  const { db, url } = await connectToE2eDatabase();
  try {
  const beforeNativeCounts = await nativeSideEffectCounts(db, company.id);
  const expectNoNativeSideEffects = async (label: string) => {
    expect(await nativeSideEffectCounts(db, company.id), label).toEqual(beforeNativeCounts);
  };
  const preserved = {
    businessStatus: childPlanRecord.businessStatus,
    assigneeAgentId: childPlanRecord.assigneeAgentId,
    qaAssigneeAgentId: childPlanRecord.qaAssigneeAgentId,
    plannedStartDate: childPlanRecord.plannedStartDate,
    plannedCompletionDate: childPlanRecord.plannedCompletionDate,
    dispatchState: childPlanRecord.dispatchState,
    dependencies: childPlanRecord.dependencies,
  };

  await json<WorkRecord>(
    await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${planRecord.id}`, {
      data: { expectedRevision: planRecord.revision, iterationId: changedIteration.id },
    }),
    "change parent iteration",
  );
  let records = await json<WorkRecord[]>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
    "read records after parent iteration change",
  );
  let byId = new Map(records.map((record) => [record.id, record]));
  expect(byId.get(childPlanRecord.id)).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: changedIteration.id });
  expect(byId.get(grandchildPlanRecord.id)).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: changedIteration.id });
  expect(byId.get(independentChild.id)?.iterationId).toBe(independentIteration.id);
  expect(byId.get(independentGrandchild.id)?.iterationId).toBe(independentIteration.id);
  await expectNoNativeSideEffects("调整父任务迭代不得创建原生任务、评论、运行或唤醒请求");

  const moved = await json<WorkRecord>(
    await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${childPlanRecord.id}`, {
      data: { expectedRevision: byId.get(childPlanRecord.id)!.revision, parentRecordId: moveTarget.id },
    }),
    "move inherited child",
  );
  expect(moved).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: independentIteration.id });
  await expectNoNativeSideEffects("移动继承任务不得创建原生任务、评论、运行或唤醒请求");
  const detached = await json<WorkRecord>(
    await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${childPlanRecord.id}`, {
      data: { expectedRevision: moved.revision, parentRecordId: null },
    }),
    "detach inherited child",
  );
  expect(detached).toMatchObject({ parentRecordId: null, iterationAssignmentMode: "independent", iterationId: independentIteration.id });
  expect(detached).toMatchObject(preserved);
  await expectNoNativeSideEffects("解除父级不得创建原生任务、评论、运行或唤醒请求");

  records = await json<WorkRecord[]>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
    "read records after detach",
  );
  byId = new Map(records.map((record) => [record.id, record]));
  expect(byId.get(grandchildPlanRecord.id)).toMatchObject({
    parentRecordId: childPlanRecord.id,
    iterationAssignmentMode: "inherit_parent",
    iterationId: independentIteration.id,
  });

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/plans`);
  await page.reload();
  await expect(page.locator(`[data-record-id="${childPlanRecord.id}"]`)).toHaveAttribute("data-tree-depth", "0");
  await expect(page.locator(`[data-record-id="${grandchildPlanRecord.id}"]`)).toHaveAttribute("data-tree-depth", "1");
  await expect(page.locator(`[data-record-id="${grandchildPlanRecord.id}"]`)).toContainText("继承 · V1 / 独立排期");
  await screenshot(page, info, "demo-fidelity-iteration-inheritance-after-refresh");

  await expectNoNativeSideEffects("刷新页面后仍不得出现原生副作用");
  } finally {
    await closeRegisteredClients(url);
  }
});
