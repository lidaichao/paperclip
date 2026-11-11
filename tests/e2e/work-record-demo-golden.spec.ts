import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type TestInfo } from "@playwright/test";
import { DEMO_AUTHORITATIVE_FIXTURE as fixture } from "./fixtures/demo-authoritative-fixture.js";
import {
  DEMO_VIEWPORTS,
  expectGeometryWithin,
  geometryRect,
  screenshotDifference,
  type DemoSurface as Surface,
  type DemoViewport as Viewport,
  type GeometrySnapshot,
} from "./fixtures/demo-geometry-contract.js";

const requestedSurface = process.env.PAPERCLIP_DEMO_SURFACE as Surface | undefined;
const requestedViewport = process.env.PAPERCLIP_DEMO_VIEWPORT;
const surfaces: Surface[] = requestedSurface ? [requestedSurface] : ["plan", "gantt", "defect", "mine"];
const viewports = requestedViewport
  ? DEMO_VIEWPORTS.filter((viewport) => viewport.label === requestedViewport)
  : DEMO_VIEWPORTS;
const DEMO_VISUAL_MAX_DIFFERENCE_RATIO = 0.005;
const demoUrl = pathToFileURL("H:/project/Papercilp/prototype/index.html").href;
const windowsChrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";

if (requestedSurface && !["plan", "gantt", "defect", "mine"].includes(requestedSurface)) {
  throw new Error(`PAPERCLIP_DEMO_SURFACE 不支持 ${requestedSurface}`);
}
if (requestedViewport && viewports.length === 0) {
  throw new Error(`PAPERCLIP_DEMO_VIEWPORT 不支持 ${requestedViewport}`);
}

if (
  process.platform === "win32" &&
  !process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH &&
  !process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL &&
  existsSync(windowsChrome)
) {
  test.use({ launchOptions: { executablePath: windowsChrome } });
}

type SeededRecord = { id: string; revision: number };
type SeededFixture = {
  company: { id: string; issuePrefix: string };
  project: { id: string };
  records: Map<string, SeededRecord>;
};

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function seedAuthoritativeFixture(request: APIRequestContext, baseUrl: string): Promise<SeededFixture> {
  const api = (pathname: string) => new URL(pathname, baseUrl).toString();
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post(api("/api/companies"), { data: { name: `Demo visual contract ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(api(`/api/companies/${company.id}/projects`), { data: { name: fixture.projectName } }),
    "create project",
  );
  const agents = new Map<string, string>();
  for (const name of fixture.agents) {
    const agent = await json<{ id: string }>(
      await request.post(api(`/api/companies/${company.id}/agents`), { data: {
        name,
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      } }),
      `create ${name} fixture agent`,
    );
    agents.set(name, agent.id);
  }
  const version = await json<{ id: string }>(
    await request.post(api(`/api/companies/${company.id}/projects/${project.id}/versions`), { data: fixture.version }),
    "create authoritative version",
  );
  const iteration = await json<{ id: string }>(
    await request.post(api(`/api/companies/${company.id}/projects/${project.id}/iterations`), {
      data: { versionId: version.id, ...fixture.iteration },
    }),
    "create authoritative iteration",
  );
  const records = new Map<string, SeededRecord>();

  for (const seed of fixture.plan) {
    const record = await json<SeededRecord>(
      await request.post(api(`/api/companies/${company.id}/work-records`), { data: {
        projectId: project.id,
        kind: "plan",
        title: seed.title,
        description: seed.description,
        parentRecordId: seed.parentKey ? records.get(seed.parentKey)?.id : null,
        iterationAssignmentMode: "independent",
        iterationId: seed.iteration ? iteration.id : null,
        plannedStartDate: seed.plannedStartDate,
        plannedCompletionDate: seed.plannedCompletionDate,
        priority: seed.priority,
        assigneeAgentId: agents.get(seed.assignee),
        predecessorRecordIds: seed.predecessorKeys.map((key) => {
          const predecessor = records.get(key);
          if (!predecessor) throw new Error(`${seed.key} 缺少前置夹具 ${key}`);
          return predecessor.id;
        }),
        userResponsibilities: seed.belongsToCurrentUser ? [{ userId: "local-board", role: "execution" }] : [],
      } }),
      `create authoritative plan ${seed.key}`,
    );
    records.set(seed.key, record);
    if (seed.businessStatus !== "backlog") {
      const updated = await json<SeededRecord>(
        await request.patch(api(`/api/companies/${company.id}/projects/${project.id}/work-records/${record.id}`), {
          data: { expectedRevision: record.revision, businessStatus: seed.businessStatus },
        }),
        `set authoritative plan ${seed.key} status`,
      );
      records.set(seed.key, updated);
    }
  }

  for (const seed of fixture.defects) {
    const record = await json<SeededRecord>(
      await request.post(api(`/api/companies/${company.id}/work-records`), { data: {
        projectId: project.id,
        kind: "defect",
        title: seed.title,
        description: seed.description,
        priority: seed.priority,
        defectSeverity: seed.defectSeverity,
        plannedCompletionDate: seed.plannedCompletionDate,
        assigneeAgentId: agents.get(seed.assignee),
        qaAssigneeAgentId: agents.get(seed.qaAssignee),
        predecessorRecordIds: [],
        userResponsibilities: [],
      } }),
      `create authoritative defect ${seed.key}`,
    );
    records.set(seed.key, record);
    if (seed.businessStatus !== "backlog") {
      const updated = await json<SeededRecord>(
        await request.patch(api(`/api/companies/${company.id}/projects/${project.id}/work-records/${record.id}`), {
          data: { expectedRevision: record.revision, businessStatus: seed.businessStatus },
        }),
        `set authoritative defect ${seed.key} status`,
      );
      records.set(seed.key, updated);
    }
  }

  return { company, project, records };
}

function internalAnchorLocators(page: Page, surface: Surface, implementation: boolean): Record<string, Locator> {
  if (surface === "mine") {
    const group = implementation ? page.getByTestId("my-todos-plan") : page.locator(".my-work-group").first();
    const heading = implementation ? group.locator(".my-todo-group-heading") : group.locator(".my-work-group-heading");
    const columns = implementation ? group.locator(".my-todo-columns") : group.locator(".my-work-columns");
    const firstRow = implementation ? group.locator(".my-todo-row").first() : group.locator("li.my-work-row").first();
    return {
      group,
      groupHeading: heading,
      headingButton: heading.locator("button").first(),
      headingCount: implementation ? heading.locator(".my-todo-count") : heading.locator(".my-work-count"),
      headingFold: implementation ? heading.locator(".my-todo-fold-mark") : heading.locator(".my-work-fold-mark"),
      headingLabel: heading.locator("label"),
      headingSelect: heading.locator("select"),
      columns,
      columnTitle: columns.locator("span").nth(1),
      columnPriority: columns.locator("span").nth(2),
      columnDue: columns.locator("span").nth(3),
      columnStatus: columns.locator("span").nth(4),
      firstRow,
      firstTitle: implementation ? firstRow.locator(".my-todo-title") : firstRow.locator(".my-work-title"),
      firstPriority: implementation ? firstRow.locator(".my-todo-priority") : firstRow.locator(".my-work-priority"),
      firstDue: implementation ? firstRow.locator(".my-todo-due") : firstRow.locator(".my-work-date"),
      firstStatus: implementation ? firstRow.locator(".my-todo-status") : firstRow.locator("select"),
    };
  }
  if (surface === "gantt") {
    const gantt = page.getByTestId("work-record-gantt");
    return implementation ? {
      workspace: page.locator('[data-testid="work-records-main"]:visible'),
      rail: page.getByTestId("work-record-rail-shell"),
      content: page.getByTestId("work-record-workspace-content"),
      heading: gantt.locator(":scope > div").nth(0),
      toolbar: gantt.locator(":scope > div").nth(1),
      toolbarSearch: gantt.getByLabel("搜索甘特任务"),
      toolbarStatus: gantt.getByLabel("甘特状态筛选"),
      toolbarColumns: gantt.locator(".work-record-gantt-fields > summary"),
      toolbarScale: gantt.getByLabel("时间粒度"),
      toolbarFit: gantt.getByRole("button", { name: "适应排期范围" }),
      toolbarToday: gantt.getByRole("button", { name: "定位今天" }),
      timelineHeader: page.getByTestId("gantt-month-header"),
      firstMonth: page.getByTestId("gantt-month-header").locator(":scope > div").first().locator("span").first(),
      secondMonth: page.getByTestId("gantt-month-header").locator(":scope > div").first().locator("span").nth(1),
      firstDay: page.getByTestId("gantt-month-header").locator(":scope > div").nth(1).locator("span").first(),
      firstRow: page.locator("[data-gantt-record-id]").first(),
      firstTitle: page.locator("[data-gantt-record-id]").first().locator(".work-record-gantt-title-cell button"),
      firstBar: page.locator(".work-record-gantt-bar").first(),
      parentBar: page.locator(".work-record-gantt-parent-bar").first(),
      firstDependencyHandle: page.locator(".work-record-gantt-create-dependency").first(),
    } : {
      workspace: page.locator("#app .schedule-workspace"),
      rail: page.locator("#schedule-rail"),
      content: page.locator("#app .schedule-main"),
      heading: page.locator(".gantt-heading"),
      toolbar: page.locator(".gantt-toolbar"),
      toolbarSearch: page.locator("#gantt-search"),
      toolbarStatus: page.locator("#gantt-status"),
      toolbarColumns: page.locator("#gantt-columns"),
      toolbarScale: page.locator("#gantt-zoom"),
      toolbarFit: page.locator("#gantt-fit"),
      toolbarToday: page.locator("#gantt-today"),
      timelineHeader: page.locator(".gantt-axis"),
      firstMonth: page.locator(".gantt-months span").first(),
      secondMonth: page.locator(".gantt-months span").nth(1),
      firstDay: page.locator(".gantt-day").first(),
      firstRow: page.locator(".gantt-row .gantt-task").first(),
      firstTitle: page.locator(".gantt-row .gantt-task-title").first(),
      firstBar: page.locator(".gantt-bar").first(),
      parentBar: page.locator(".gantt-parent-bar").first(),
      firstDependencyHandle: page.locator(".gantt-dep-handle").first(),
    };
  }
  if (surface === "plan") {
    const headers = implementation
      ? page.getByTestId("work-record-table-scroller").locator("thead th")
      : page.locator(".plan-table thead th");
    return {
      workspace: implementation ? page.locator('[data-testid="work-records-main"]:visible') : page.locator("#app .schedule-workspace"),
      rail: implementation ? page.getByTestId("work-record-rail-shell") : page.locator("#schedule-rail"),
      content: implementation ? page.getByTestId("work-record-workspace-content") : page.locator("#app .schedule-main"),
      heading: implementation
        ? page.getByTestId("work-record-workspace-content").getByRole("heading", { name: "需求池", exact: true })
        : page.locator(".schedule-context h3"),
      viewToolbar: implementation ? page.getByTestId("work-record-view-toolbar") : page.locator(".plan-compact-top"),
      filterToolbar: implementation ? page.getByTestId("work-record-filter-toolbar") : page.locator(".sheet-toolbar"),
      tableHeader: implementation ? page.getByTestId("work-record-table-scroller").locator("thead") : page.locator(".plan-table thead"),
      firstRow: implementation ? page.getByTestId("work-record-table-row").first() : page.locator(".plan-table tbody tr").first(),
      firstRowId: implementation
        ? page.getByTestId("work-record-table-row").first().locator("td").nth(1)
        : page.locator(".plan-table tbody tr").first().locator("td").nth(1),
      firstRowTitle: implementation
        ? page.getByTestId("work-record-table-row").first().locator("td").nth(2)
        : page.locator(".plan-table tbody tr").first().locator("td").nth(2),
      selectHeader: headers.nth(0),
      idHeader: headers.nth(1),
      titleHeader: headers.nth(2),
      statusHeader: headers.nth(3),
      assigneeHeader: headers.nth(4),
      priorityHeader: headers.nth(5),
      startHeader: headers.nth(6),
      completionHeader: headers.nth(7),
    };
  }
  return implementation ? {
    workspace: page.locator('[data-testid="work-records-main"]:visible'),
    rail: page.getByTestId("work-record-rail-shell"),
    content: page.getByTestId("work-record-workspace-content"),
    heading: page.getByTestId("work-record-workspace-content").getByRole("heading", { name: surface === "plan" ? "需求池" : "缺陷池", exact: true }),
    viewToolbar: page.getByTestId("work-record-view-toolbar"),
    filterToolbar: page.getByTestId("work-record-filter-toolbar"),
    tableHeader: page.getByTestId("work-record-table-scroller").locator("thead"),
    firstRow: page.getByTestId("work-record-table-row").first(),
  } : {
    workspace: page.locator("#app .schedule-workspace"),
    rail: page.locator("#schedule-rail"),
    content: page.locator("#app .schedule-main"),
    heading: page.locator(".schedule-context h3"),
    viewToolbar: page.locator(".plan-compact-top"),
    filterToolbar: page.locator(".sheet-toolbar"),
    tableHeader: page.locator(".plan-table thead"),
    firstRow: page.locator(".plan-table tbody tr").first(),
  };
}

async function readGeometry(page: Page, surface: Surface, implementation: boolean): Promise<GeometrySnapshot> {
  const result: GeometrySnapshot = {};
  for (const [key, locator] of Object.entries(internalAnchorLocators(page, surface, implementation))) {
    result[key] = await locator.isVisible()
      ? await geometryRect(locator, `${surface} ${implementation ? "实装" : "Demo"} ${key}`)
      : { x: 0, y: 0, width: 0, height: 0 };
  }
  return result;
}

async function readVisualStyle(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      textRendering: style.textRendering,
      webkitFontSmoothing: style.getPropertyValue("-webkit-font-smoothing"),
      color: style.color,
      backgroundColor: style.backgroundColor,
      padding: style.padding,
      border: style.border,
    };
  });
}

async function readPlatformFonts(page: Page, selector: string) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) return [];
    const result = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    return result.fonts;
  } finally {
    await session.detach();
  }
}

async function readPlanVisualStyles(page: Page, implementation: boolean) {
  const row = implementation
    ? page.getByTestId("work-record-table-row").first()
    : page.locator(".plan-table tbody tr").first();
  return {
    workspace: await readVisualStyle(implementation ? page.getByTestId("work-record-workspace-grid") : page.locator("#app .schedule-workspace")),
    header: await readVisualStyle(implementation ? page.getByTestId("work-record-table-scroller").locator("thead th").nth(1) : page.locator(".plan-table thead th").nth(1)),
    title: await readVisualStyle(row.locator("td").nth(2).getByRole("button").last()),
    status: await readVisualStyle(row.locator("td").nth(3).locator("select")),
    date: await readVisualStyle(row.locator("td").nth(6).locator('input[type="date"]')),
  };
}

async function readMineVisualStyles(page: Page, implementation: boolean) {
  const group = implementation ? page.getByTestId("my-todos-plan") : page.locator(".my-work-group").first();
  const row = implementation ? group.locator(".my-todo-row").first() : group.locator("li.my-work-row").first();
  return {
    heading: await readVisualStyle(implementation ? group.locator(".my-todo-group-heading > button") : group.locator("[data-work-fold]") ),
    columns: await readVisualStyle(implementation ? group.locator(".my-todo-columns") : group.locator(".my-work-columns")),
    title: await readVisualStyle(implementation ? row.locator(".my-todo-title") : row.locator(".my-work-title")),
    priority: await readVisualStyle(implementation ? row.locator(".my-todo-priority") : row.locator(".my-work-priority")),
    due: await readVisualStyle(implementation ? row.locator(".my-todo-due") : row.locator(".my-work-date")),
    status: await readVisualStyle(implementation ? row.locator(".my-todo-status") : row.locator("select")),
  };
}

async function readGanttVisualStyles(page: Page, implementation: boolean) {
  const title = implementation ? page.locator(".work-record-gantt-task-title").first() : page.locator(".gantt-task-title").first();
  const toolbar = implementation ? page.locator(".work-record-gantt-toolbar") : page.locator(".gantt-toolbar");
  const bar = implementation ? page.locator(".work-record-gantt-bar").first() : page.locator(".gantt-bar").first();
  return {
    workspace: await readVisualStyle(implementation ? page.getByTestId("work-record-workspace-grid") : page.locator("#app .schedule-workspace")),
    toolbar: await readVisualStyle(toolbar),
    title: await readVisualStyle(title),
    bar: await readVisualStyle(bar),
    titlePlatformFonts: await readPlatformFonts(page, implementation ? ".work-record-gantt-task-title" : ".gantt-task-title"),
    toolbarPlatformFonts: await readPlatformFonts(page, implementation ? ".work-record-gantt-toolbar" : ".gantt-toolbar"),
  };
}

async function expectAuthoritativeStructure(page: Page, demo: Page, surface: Surface, records: Map<string, SeededRecord>) {
  if (surface !== "mine") {
    for (const value of [fixture.version.name, fixture.iteration.name]) {
      await expect.soft(demo.locator("#schedule-rail").getByText(value, { exact: true }).first(), `Demo 侧栏包含 ${value}`).toBeVisible();
      await expect.soft(page.getByTestId("version-iteration-tree").getByText(value, { exact: true }).first(), `实装侧栏包含 ${value}`).toBeVisible();
    }
  }
  if (surface === "plan") {
    await expect.soft(demo.locator("[data-plan-select]"), "Demo 计划记录数").toHaveCount(fixture.plan.length);
    await expect.soft(page.getByTestId("work-record-table-row"), "实装计划记录数").toHaveCount(fixture.plan.length);
    await expect.soft(demo.locator(".plan-table tbody tr.child-row"), "Demo 子任务层级数").toHaveCount(3);
    for (const key of ["201", "202", "203"]) {
      const id = records.get(key)?.id;
      expect(id, `${key} 已被夹具创建`).toBeTruthy();
      await expect.soft(page.locator(`[data-record-id="${id}"]`), `实装 ${key} 子任务层级`).toHaveAttribute("data-tree-depth", "1");
    }
  } else if (surface === "gantt") {
    await expect.soft(demo.locator("[data-gantt-row]"), "Demo 甘特记录数").toHaveCount(fixture.plan.length);
    await expect.soft(page.locator("[data-gantt-record-id]"), "实装甘特记录数").toHaveCount(fixture.plan.length);
    for (const key of ["201", "202", "203"]) {
      const id = records.get(key)?.id;
      if (id) await expect.soft(page.locator(`[data-gantt-record-id="${id}"]`), `实装甘特 ${key} 子任务层级`).toHaveAttribute("data-tree-depth", "1");
    }
  } else if (surface === "defect") {
    await expect.soft(demo.locator("[data-defect-select]"), "Demo 缺陷记录数").toHaveCount(fixture.defects.length);
    await expect.soft(page.getByTestId("work-record-table-row"), "实装缺陷记录数").toHaveCount(fixture.defects.length);
  } else {
    const expectedMine = fixture.plan.filter((record) => record.belongsToCurrentUser);
    await expect.soft(demo.locator('[data-work-row^="task:"]'), "Demo 我的任务数").toHaveCount(expectedMine.length);
    await expect.soft(demo.locator('[data-work-row^="defect:"]'), "Demo 我的缺陷数").toHaveCount(0);
    await expect.soft(page.getByTestId("my-todos-plan").locator("li"), "实装我的任务数").toHaveCount(expectedMine.length);
    await expect.soft(page.getByTestId("my-todos-defect").locator("li"), "实装我的缺陷数").toHaveCount(0);
  }

  const expectedTitles = surface === "defect"
    ? fixture.defects.map((record) => record.title)
    : surface === "mine"
      ? fixture.plan.filter((record) => record.belongsToCurrentUser).map((record) => record.title)
      : fixture.plan.map((record) => record.title);
  for (const title of expectedTitles) {
    await expect.soft(demo.getByText(title, { exact: true }).first(), `Demo 包含「${title}」`).toBeVisible();
    await expect.soft(page.getByText(title, { exact: true }).first(), `实装包含「${title}」`).toBeVisible();
  }
}

async function waitForRows(page: Page, demo: Page, surface: Surface) {
  if (surface === "plan") {
    await expect(demo.locator("[data-plan-select]")).toHaveCount(fixture.plan.length);
    await expect(page.getByTestId("work-record-table-row")).toHaveCount(fixture.plan.length);
  } else if (surface === "gantt") {
    await expect(demo.locator("[data-gantt-row]")).toHaveCount(fixture.plan.length);
    await expect(page.locator("[data-gantt-record-id]")).toHaveCount(fixture.plan.length);
  } else if (surface === "defect") {
    await expect(demo.locator("[data-defect-select]")).toHaveCount(fixture.defects.length);
    await expect(page.getByTestId("work-record-table-row")).toHaveCount(fixture.defects.length);
  } else {
    const count = fixture.plan.filter((record) => record.belongsToCurrentUser).length;
    await expect(demo.locator('[data-work-row^="task:"]')).toHaveCount(count);
    await expect(page.getByTestId("my-todos-plan").locator("li")).toHaveCount(count);
  }
}

function comparisonLocator(page: Page, surface: Surface, implementation: boolean) {
  if (surface !== "mine") {
    return implementation
      ? page.locator('[data-testid="work-records-main"]:visible')
      : page.locator("#app .schedule-workspace");
  }
  return implementation ? page.getByTestId("my-todos-plan") : page.locator(".my-work-group").first();
}

function dynamicMasks(page: Page, surface: Surface, implementation: boolean): Locator[] {
  if (surface === "plan") {
    return [implementation
      ? page.getByTestId("work-record-table-row").locator("td:nth-child(2)")
      : page.locator(".plan-table tbody .task-id-col")];
  }
  if (surface === "defect") {
    return [implementation
      ? page.getByTestId("work-record-table-row").locator("td:nth-child(2)")
      : page.locator(".defect-table tbody tr td:nth-child(2)")];
  }
  if (surface === "mine") {
    return [implementation
      ? page.getByTestId("my-todos-plan").locator(".my-todo-id")
      : page.locator(".my-work-group").first().locator(".my-work-id")];
  }
  return [];
}

async function attachPair(
  info: TestInfo,
  surface: Surface,
  viewport: Viewport,
  reference: Buffer,
  implementation: Buffer,
  heatmap: Buffer,
  geometry: object,
) {
  writeFileSync(info.outputPath(`demo-${surface}-${viewport.label}.png`), reference);
  writeFileSync(info.outputPath(`implementation-${surface}-${viewport.label}.png`), implementation);
  writeFileSync(info.outputPath(`geometry-${surface}-${viewport.label}.json`), JSON.stringify(geometry, null, 2));
  await info.attach(`demo-${surface}-${viewport.label}`, { body: reference, contentType: "image/png" });
  await info.attach(`implementation-${surface}-${viewport.label}`, { body: implementation, contentType: "image/png" });
  if (heatmap.length > 0) {
    writeFileSync(info.outputPath(`difference-${surface}-${viewport.label}.png`), heatmap);
    await info.attach(`difference-${surface}-${viewport.label}`, { body: heatmap, contentType: "image/png" });
  }
  await info.attach(`geometry-${surface}-${viewport.label}`, {
    body: Buffer.from(JSON.stringify(geometry, null, 2)),
    contentType: "application/json",
  });
}

test("Demo and implementation share one authoritative structural, geometric and visual contract", async ({ page, request }, info) => {
  test.setTimeout(300_000);
  const baseUrl = info.project.use.baseURL;
  expect(baseUrl, "Playwright 项目必须配置 baseURL").toBeTruthy();
  const seeded = await seedAuthoritativeFixture(request, String(baseUrl));
  const demo = await page.context().newPage();
  await demo.addInitScript((keys) => {
    for (const key of keys) localStorage.removeItem(key);
  }, fixture.prototypeStorageKeys);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await demo.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const surface of surfaces) {
      const demoRoute = surface === "defect" ? "defects" : surface;
      console.log(`[golden] ${surface} ${viewport.label}: open demo`);
      await demo.goto(`${demoUrl}#project/${encodeURIComponent(fixture.projectName)}/${demoRoute}`);
      await expect(demo.locator("#app .schedule-workspace"), `${surface} Demo 已渲染`).toBeVisible();

      if (surface === "mine") {
        console.log(`[golden] ${surface} ${viewport.label}: open implementation`);
        await page.goto(`/${seeded.company.issuePrefix}/dashboard`);
        await page.getByRole("tab", { name: "我的待办", exact: true }).click();
        await expect(page.getByTestId("dashboard-my-todos")).toBeVisible();
      } else {
        const route = surface === "defect" ? "defects" : surface === "plan" ? "plans" : "gantt";
        await page.goto(`/${seeded.company.issuePrefix}/projects/${seeded.project.id}/${route}`);
        await expect(page.getByTestId("work-records-main")).toBeVisible();
      }

      console.log(`[golden] ${surface} ${viewport.label}: wait rows`);
      await waitForRows(page, demo, surface);
      console.log(`[golden] ${surface} ${viewport.label}: structure`);
      await expectAuthoritativeStructure(page, demo, surface, seeded.records);
      console.log(`[golden] ${surface} ${viewport.label}: fonts`);
      await Promise.all([
        page.evaluate(async () => { await document.fonts.ready; }),
        demo.evaluate(async () => { await document.fonts.ready; }),
      ]);
      await Promise.all([page.mouse.move(0, 0), demo.mouse.move(0, 0)]);
      await Promise.all([
        page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()),
        demo.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()),
      ]);
      console.log(`[golden] ${surface} ${viewport.label}: geometry`);
      const demoGeometry = await readGeometry(demo, surface, false);
      const implementationGeometry = await readGeometry(page, surface, true);
      expectGeometryWithin(implementationGeometry, demoGeometry, `${surface} ${viewport.label} 内部锚点`, 1);

      const demoRegion = await geometryRect(comparisonLocator(demo, surface, false), `${surface} Demo 比较区域`);
      const implementationRegion = await geometryRect(comparisonLocator(page, surface, true), `${surface} 实装比较区域`);
      expect.soft(Math.abs(demoRegion.width - implementationRegion.width), `${surface} ${viewport.label} 比较区域宽度`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(demoRegion.height - implementationRegion.height), `${surface} ${viewport.label} 比较区域高度`).toBeLessThanOrEqual(1);

      const reference = await demo.screenshot({
        animations: "disabled",
        caret: "hide",
        clip: {
          x: demoRegion.x,
          y: demoRegion.y,
          width: Math.floor(demoRegion.width),
          height: Math.floor(demoRegion.height),
        },
        mask: dynamicMasks(demo, surface, false),
        maskColor: "#ff00ff",
      });
      const implementation = await page.screenshot({
        animations: "disabled",
        caret: "hide",
        clip: {
          x: implementationRegion.x,
          y: implementationRegion.y,
          width: Math.floor(implementationRegion.width),
          height: Math.floor(implementationRegion.height),
        },
        mask: dynamicMasks(page, surface, true),
        maskColor: "#ff00ff",
      });
      console.log(`[golden] ${surface} ${viewport.label}: diff`);
      const pixels = await screenshotDifference(page, reference, implementation);
      const styles = surface === "plan" ? {
        demo: await readPlanVisualStyles(demo, false),
        implementation: await readPlanVisualStyles(page, true),
      } : surface === "gantt" ? {
        demo: await readGanttVisualStyles(demo, false),
        implementation: await readGanttVisualStyles(page, true),
      } : surface === "mine" ? {
        demo: {
          ...(await readMineVisualStyles(demo, false)),
          platformFonts: await readPlatformFonts(demo, ".my-work-title"),
        },
        implementation: {
          ...(await readMineVisualStyles(page, true)),
          platformFonts: await readPlatformFonts(page, ".my-todo-title"),
        },
      } : undefined;
      await attachPair(info, surface, viewport, reference, implementation, pixels.heatmap, {
        demo: demoGeometry,
        implementation: implementationGeometry,
        regions: { demo: demoRegion, implementation: implementationRegion },
        pixels: {
          dimensionsMatch: pixels.dimensionsMatch,
          rawDifferenceRatio: pixels.rawDifferenceRatio,
          differenceRatio: pixels.differenceRatio,
        },
        styles,
      });

      expect.soft(pixels.dimensionsMatch, `${surface} ${viewport.label} 两侧截图尺寸一致`).toBe(true);
      expect.soft(
        pixels.differenceRatio,
        `${surface} ${viewport.label} 与权威 Demo 的差异像素必须不超过 0.5%`,
      ).toBeLessThanOrEqual(DEMO_VISUAL_MAX_DIFFERENCE_RATIO);
    }
  }
  await demo.close();
});
