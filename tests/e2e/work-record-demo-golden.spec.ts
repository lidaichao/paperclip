import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expect, test, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import {
  DEMO_VIEWPORTS as viewports,
  geometryRect as rect,
  screenshotDifference,
  type DemoSurface as Surface,
  type DemoViewport as Viewport,
  type GeometryRect as Rect,
} from "./fixtures/demo-geometry-contract.js";

const surfaces: Surface[] = ["plan", "gantt", "defect", "mine"];
const approvedWorkspaceDifferenceRatio: Record<Surface, Record<string, number>> = {
  plan: { "1024x768": 0.194, "1319x1012": 0.14, "1540x1117": 0.121, "1574x1038": 0.13 },
  gantt: { "1024x768": 0.18, "1319x1012": 0.151, "1540x1117": 0.126, "1574x1038": 0.134 },
  defect: { "1024x768": 0.132, "1319x1012": 0.081, "1540x1117": 0.066, "1574x1038": 0.07 },
  mine: { "1024x768": 0.091, "1319x1012": 0.062, "1540x1117": 0.049, "1574x1038": 0.048 },
};
const allowedVisualRegression = 0.008;
const demoUrl = pathToFileURL("H:/project/Papercilp/prototype/index.html").href;
const windowsChrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";

if (
  process.platform === "win32" &&
  !process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH &&
  !process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL &&
  existsSync(windowsChrome)
) {
  test.use({ launchOptions: { executablePath: windowsChrome } });
}

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function demoGeometry(page: Page, surface: Surface) {
  if (surface === "mine") {
    return {
      groupHeading: await rect(page.locator(".my-work-group-heading").first(), "mine Demo 分组标题"),
      row: await rect(page.locator("li.my-work-row").first(), "mine Demo 首条待办"),
    };
  }
  const geometry: Record<string, Rect> = {
    workspace: await rect(page.locator("#app .schedule-workspace"), `${surface} Demo 工作区`),
    content: await rect(page.locator("#app .schedule-main"), `${surface} Demo 内容区`),
  };
  const rail = page.locator("#schedule-rail");
  if (await rail.count()) geometry.rail = await rect(rail, `${surface} Demo 版本栏`);
  return geometry;
}

async function implementationGeometry(page: Page, surface: Surface) {
  if (surface === "mine") {
    const group = page.getByTestId("my-todos-plan");
    return {
      groupHeading: await rect(group.locator(":scope > div").first(), "实装仪表盘待办分组标题"),
      row: await rect(group.locator("li").first(), "实装仪表盘首条待办"),
    };
  }
  return {
    workspace: await rect(page.locator('[data-testid="work-records-main"]:visible'), `${surface} 实装工作区`),
    content: await rect(page.getByTestId("work-record-workspace-content"), `${surface} 实装内容区`),
    rail: await rect(page.getByTestId("work-record-rail-shell"), `${surface} 实装版本栏`),
  };
}

function compareGeometry(surface: Surface, viewport: Viewport, demo: Record<string, Rect>, implementation: Record<string, Rect>) {
  for (const key of Object.keys(demo).filter((candidate) => implementation[candidate])) {
    for (const field of ["x", "y", "width", "height"] as const) {
      if (surface === "mine" && field !== "height") continue;
      const delta = Math.abs(demo[key][field] - implementation[key][field]);
      expect.soft(delta, `${surface} ${viewport.label} ${key}.${field} 与 Demo 的误差`).toBeLessThanOrEqual(1);
    }
  }
}

async function attachPair(info: TestInfo, surface: Surface, viewport: Viewport, reference: Buffer, implementation: Buffer, heatmap: Buffer, geometry: object) {
  writeFileSync(info.outputPath(`demo-${surface}-${viewport.label}.png`), reference);
  writeFileSync(info.outputPath(`implementation-${surface}-${viewport.label}.png`), implementation);
  writeFileSync(info.outputPath(`difference-${surface}-${viewport.label}.png`), heatmap);
  writeFileSync(info.outputPath(`geometry-${surface}-${viewport.label}.json`), JSON.stringify(geometry, null, 2));
  await info.attach(`demo-${surface}-${viewport.label}`, { body: reference, contentType: "image/png" });
  await info.attach(`implementation-${surface}-${viewport.label}`, { body: implementation, contentType: "image/png" });
  await info.attach(`difference-${surface}-${viewport.label}`, { body: heatmap, contentType: "image/png" });
  await info.attach(`geometry-${surface}-${viewport.label}`, {
    body: Buffer.from(JSON.stringify(geometry, null, 2)),
    contentType: "application/json",
  });
}

async function comparisonRegion(page: Page, surface: Surface, implementation: boolean): Promise<Rect> {
  if (surface !== "mine") {
    const target = implementation
      ? page.locator('[data-testid="work-records-main"]:visible')
      : page.locator("#app .schedule-workspace");
    return rect(target, `${surface} ${implementation ? "实装" : "Demo"} 比较区域`);
  }
  const heading = implementation
    ? page.getByTestId("my-todos-plan").locator(":scope > div").first()
    : page.locator(".my-work-group-heading").first();
  const row = implementation
    ? page.getByTestId("my-todos-plan").locator("li").first()
    : page.locator("li.my-work-row").first();
  const [headingBox, rowBox] = await Promise.all([rect(heading, "待办分组标题"), rect(row, "待办首行")]);
  return {
    x: Math.min(headingBox.x, rowBox.x),
    y: headingBox.y,
    width: Math.max(headingBox.x + headingBox.width, rowBox.x + rowBox.width) - Math.min(headingBox.x, rowBox.x),
    height: rowBox.y + rowBox.height - headingBox.y,
  };
}

test("Demo and implementation share one geometric and visual contract", async ({ page, request }, info) => {
  test.setTimeout(240_000);
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `Demo golden ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "星海计划" } }),
    "create project",
  );
  await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "Golden fixture agent",
    role: "engineer",
    adapterType: "process",
    adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  } }), "create inert agent");
  const version = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/versions`, { data: { name: "首个可用版本" } }),
    "create version",
  );
  const iteration = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/iterations`, {
      data: { versionId: version.id, name: "首局引导" },
    }),
    "create iteration",
  );

  const planSeeds = [
    ["完成首局引导", "in_progress", "2026-09-24", "2026-09-30"],
    ["整理首局引导交互方案", "done", "2026-09-24", "2026-09-25"],
    ["实现首局引导页面", "backlog", "2026-09-26", "2026-09-28"],
    ["验证首局引导完整流程", "backlog", "2026-09-29", "2026-09-30"],
    ["编写活动奖励配置说明", "todo", "2026-09-24", "2026-09-27"],
    ["适配活动页窄屏布局", "in_progress", "2026-09-25", "2026-09-28"],
    ["整理版本回归验证清单", "in_review", "2026-09-25", "2026-09-27"],
    ["验证低端设备加载表现", "blocked", "2026-09-26", "2026-09-29"],
    ["制作旧版引导过渡页", "cancelled", null, null],
  ] as const;
  for (const [title, businessStatus, plannedStartDate, plannedCompletionDate] of planSeeds) {
    const record = await json<{ id: string; revision: number }>(
      await request.post(`/api/companies/${company.id}/work-records`, { data: {
        projectId: project.id,
        kind: "plan",
        title,
        iterationId: iteration.id,
        plannedStartDate,
        plannedCompletionDate,
        predecessorRecordIds: [],
        userResponsibilities: [{ userId: "local-board", role: "execution" }],
      } }),
      `create ${title}`,
    );
    if (businessStatus !== "backlog") {
      await json(await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${record.id}`, {
        data: { expectedRevision: record.revision, businessStatus },
      }), `set ${title} status`);
    }
  }
  const defectSeeds = [
    ["登录失败提示不明确", "critical", "todo"],
    ["安卓设备偶发音效丢失", "high", "in_review"],
    ["关卡入口加载异常", "high", "blocked"],
  ] as const;
  for (const [title, defectSeverity, businessStatus] of defectSeeds) {
    const record = await json<{ id: string; revision: number }>(
      await request.post(`/api/companies/${company.id}/work-records`, { data: {
        projectId: project.id,
        kind: "defect",
        title,
        iterationId: iteration.id,
        defectSeverity,
        foundInVersionId: version.id,
        plannedCompletionDate: "2026-09-27",
        predecessorRecordIds: [],
        userResponsibilities: [{ userId: "local-board", role: "execution" }],
      } }),
      `create ${title}`,
    );
    await json(await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${record.id}`, {
      data: { expectedRevision: record.revision, businessStatus },
    }), `set ${title} status`);
  }

  const demo = await page.context().newPage();
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await demo.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const surface of surfaces) {
      const demoRoute = surface === "defect" ? "defects" : surface;
      await demo.goto(`${demoUrl}#project/${encodeURIComponent("星海计划")}/${demoRoute}`);
      await expect(demo.locator("#app .schedule-workspace"), `${surface} Demo 已渲染`).toBeVisible();

      if (surface === "mine") {
        await page.goto(`/${company.issuePrefix}/dashboard`);
        await page.getByRole("tab", { name: "我的待办", exact: true }).click();
        await expect(page.getByTestId("dashboard-my-todos")).toBeVisible();
      } else {
        const route = surface === "defect" ? "defects" : surface === "plan" ? "plans" : "gantt";
        await page.goto(`/${company.issuePrefix}/projects/${project.id}/${route}`);
        await expect(page.getByTestId("work-records-main")).toBeVisible();
      }

      const demoRects = await demoGeometry(demo, surface);
      const implementationRects = await implementationGeometry(page, surface);
      const demoRegion = await comparisonRegion(demo, surface, false);
      const implementationRegion = await comparisonRegion(page, surface, true);
      const sharedWidth = Math.floor(Math.min(demoRegion.width, implementationRegion.width));
      const sharedHeight = Math.floor(Math.min(demoRegion.height, implementationRegion.height));
      const reference = await demo.screenshot({
        animations: "disabled",
        clip: { x: demoRegion.x, y: demoRegion.y, width: sharedWidth, height: sharedHeight },
      });
      const implementation = await page.screenshot({
        animations: "disabled",
        clip: { x: implementationRegion.x, y: implementationRegion.y, width: sharedWidth, height: sharedHeight },
      });
      const pixels = await screenshotDifference(page, reference, implementation);
      await attachPair(info, surface, viewport, reference, implementation, pixels.heatmap, {
        demo: demoRects,
        implementation: implementationRects,
        pixels: { dimensionsMatch: pixels.dimensionsMatch, differenceRatio: pixels.differenceRatio },
      });

      compareGeometry(surface, viewport, demoRects, implementationRects);
      expect.soft(pixels.dimensionsMatch, `${surface} ${viewport.label} 两侧截图尺寸一致`).toBe(true);
      expect.soft(
        pixels.differenceRatio,
        `${surface} ${viewport.label} 与已批准 Demo 基线相比不得新增超过 0.8% 差异像素`,
      ).toBeLessThanOrEqual(approvedWorkspaceDifferenceRatio[surface][viewport.label] + allowedVisualRegression);
    }
  }
  await demo.close();
});
