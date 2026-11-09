import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type TestInfo } from "@playwright/test";

type RecordView = {
  id: string;
  title: string;
  revision: number;
  dependencySetRevision: number;
  plannedStartDate: string | null;
  plannedCompletionDate: string | null;
  dependencies: Array<{ predecessorRecordId: string }>;
};

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

async function records(request: APIRequestContext, companyId: string, projectId: string) {
  return json<RecordView[]>(
    await request.get(`/api/companies/${companyId}/projects/${projectId}/work-records`),
    "list records",
  );
}

async function drag(page: Page, source: Locator, target: Locator, targetOffset = { x: 20, y: 20 }) {
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const targetBox = await target.evaluate((element) => element.getBoundingClientRect().toJSON());
  await source.hover();
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetOffset.x, targetBox.y + targetOffset.y, { steps: 8 });
  await page.mouse.up();
}

async function clickSvgPath(page: Page, path: Locator) {
  const point = await path.evaluate((element) => {
    const svgPath = element as SVGPathElement;
    const local = svgPath.getPointAtLength(svgPath.getTotalLength() / 2);
    const screen = new DOMPoint(local.x, local.y).matrixTransform(svgPath.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
}

async function dragBy(page: Page, source: Locator, deltaX: number) {
  await expect(source).toBeVisible();
  const sourceBox = await source.evaluate((element) => element.getBoundingClientRect().toJSON());
  const x = sourceBox.x + sourceBox.width / 2;
  const y = sourceBox.y + sourceBox.height / 2;
  await source.hover();
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 6 });
  await page.mouse.up();
}

test("G3B3 validates real gantt drags, dependency rewires, undo and dirty-container focus", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(12_000);

  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `G3B3 browser ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "G3B3 local proof" } }),
    "create project",
  );
  const version = await json<{ id: string; revision: number }>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/versions`, { data: { name: "V1" } }),
    "create version",
  );
  const create = async (title: string, start: string | null, end: string | null, predecessorRecordIds: string[] = []) =>
    json<RecordView>(await request.post(`/api/companies/${company.id}/work-records`, { data: {
      projectId: project.id,
      kind: "plan",
      title,
      plannedStartDate: start,
      plannedCompletionDate: end,
      predecessorRecordIds,
    } }), `create ${title}`);
  const a = await create("前置 A", "2026-11-08", "2026-11-09");
  const c = await create("前置 C", "2026-11-08", "2026-11-10");
  const d = await create("候选 D", "2026-11-09", "2026-11-11");
  const e = await create("新前置 E", "2026-11-07", "2026-11-08");
  const b = await create("后置 B", "2026-11-12", "2026-11-14", [a.id, c.id]);
  const undated = await create("无日期任务", null, null);

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/gantt`);
  const gantt = page.getByTestId("work-record-gantt");
  await expect(gantt).toBeVisible();

  const bTimeline = gantt.locator(`[data-gantt-timeline="${b.id}"]`);
  const createDependency = gantt.getByRole("button", { name: "从 新前置 E 建立依赖" });
  await createDependency.focus();
  await createDependency.press("Enter");
  await bTimeline.click({ position: { x: 20, y: 20 } });
  await expect.poll(async () => (await records(request, company.id, project.id))
    .find((record) => record.id === b.id)?.dependencies.map((edge) => edge.predecessorRecordId).sort())
    .toEqual([a.id, c.id, e.id].sort());

  const aEdge = gantt.getByRole("button", { name: "前置 A 到 后置 B 的依赖线" });
  await clickSvgPath(page, aEdge);
  await drag(page, gantt.getByRole("button", { name: "拖动依赖源端改连" }), gantt.locator(`[data-gantt-timeline="${d.id}"]`));
  await expect.poll(async () => (await records(request, company.id, project.id))
    .find((record) => record.id === b.id)?.dependencies.map((edge) => edge.predecessorRecordId).sort())
    .toEqual([c.id, d.id, e.id].sort());

  const dToB = gantt.getByRole("button", { name: "候选 D 到 后置 B 的依赖线" });
  await clickSvgPath(page, dToB);
  await drag(page, gantt.getByRole("button", { name: "拖动依赖目标端改连" }), gantt.locator(`[data-gantt-timeline="${a.id}"]`));
  await expect.poll(async () => {
    const current = await records(request, company.id, project.id);
    return {
      a: current.find((record) => record.id === a.id)?.dependencies.map((edge) => edge.predecessorRecordId),
      b: current.find((record) => record.id === b.id)?.dependencies.map((edge) => edge.predecessorRecordId).sort(),
    };
  }).toEqual({ a: [d.id], b: [c.id, e.id].sort() });

  const dToA = gantt.getByRole("button", { name: "候选 D 到 前置 A 的依赖线" });
  await dToA.focus();
  await dToA.press("Delete");
  await expect.poll(async () => (await records(request, company.id, project.id))
    .find((record) => record.id === a.id)?.dependencies).toEqual([]);
  await gantt.getByRole("button", { name: /撤销/ }).click();
  await expect.poll(async () => (await records(request, company.id, project.id))
    .find((record) => record.id === a.id)?.dependencies.map((edge) => edge.predecessorRecordId)).toEqual([d.id]);

  const undatedTrack = gantt.getByRole("button", { name: "无日期任务 空日期轨道" });
  const undatedTimeline = gantt.locator(`[data-gantt-timeline="${undated.id}"]`);
  const trackBox = await undatedTrack.boundingBox();
  expect(trackBox).not.toBeNull();
  await page.mouse.move(trackBox!.x + trackBox!.width * 0.3, trackBox!.y + trackBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(trackBox!.x + trackBox!.width * 0.5, trackBox!.y + trackBox!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await records(request, company.id, project.id))
    .find((record) => record.id === undated.id)?.plannedStartDate).not.toBeNull();

  let currentA = (await records(request, company.id, project.id)).find((record) => record.id === a.id)!;
  const originalA = { start: currentA.plannedStartDate, end: currentA.plannedCompletionDate };
  const aBar = gantt.getByRole("button", { name: /前置 A，/ });
  const barBox = await aBar.boundingBox();
  expect(barBox).not.toBeNull();
  await page.mouse.move(barBox!.x + barBox!.width / 2, barBox!.y + barBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(barBox!.x + barBox!.width / 2 + 48, barBox!.y + barBox!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await records(request, company.id, project.id))
    .find((record) => record.id === a.id)?.plannedStartDate).not.toBe(originalA.start);

  currentA = (await records(request, company.id, project.id)).find((record) => record.id === a.id)!;
  await dragBy(page, gantt.getByRole("button", { name: "调整开始日期" }).first(), 32);
  await expect.poll(async () => (await records(request, company.id, project.id))
    .find((record) => record.id === a.id)?.plannedStartDate).not.toBe(currentA.plannedStartDate);
  currentA = (await records(request, company.id, project.id)).find((record) => record.id === a.id)!;
  await dragBy(page, gantt.getByRole("button", { name: "调整完成日期" }).first(), 32);
  await expect.poll(async () => (await records(request, company.id, project.id))
    .find((record) => record.id === a.id)?.plannedCompletionDate).not.toBe(currentA.plannedCompletionDate);

  currentA = (await records(request, company.id, project.id)).find((record) => record.id === a.id)!;
  const cancelBar = gantt.getByRole("button", { name: /前置 A，/ });
  const cancelBox = await cancelBar.boundingBox();
  await page.mouse.move(cancelBox!.x + cancelBox!.width / 2, cancelBox!.y + cancelBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBox!.x + cancelBox!.width / 2 + 72, cancelBox!.y + cancelBox!.height / 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await gantt.locator(".relative.grid").first().dispatchEvent("pointercancel", { pointerId: 1 });
  const cancelledA = (await records(request, company.id, project.id)).find((record) => record.id === a.id)!;
  expect({ start: cancelledA.plannedStartDate, end: cancelledA.plannedCompletionDate }).toEqual({
    start: currentA.plannedStartDate,
    end: currentA.plannedCompletionDate,
  });

  await gantt.getByRole("button", { name: "专注" }).click();
  await expect(gantt.getByRole("button", { name: "退出专注" })).toHaveAttribute("aria-pressed", "true");
  await gantt.getByRole("button", { name: /后置 B，/ }).click();
  await expect(page.getByTestId("work-record-detail-drawer")).toContainText("后置 B");
  await gantt.getByRole("button", { name: "退出专注" }).click();
  await expect(page.getByTestId("work-record-detail-drawer")).toContainText("后置 B");

  await page.getByRole("tab", { name: "计划", exact: true }).click();
  const editVersion = page.getByRole("button", { name: "编辑版本 V1" });
  await editVersion.click();
  const edit = page.getByTestId("container-edit-form");
  await edit.getByLabel("名称").fill("V1 脏草稿");
  await edit.press("Escape");
  const confirm = page.getByTestId("container-discard-confirmation");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "继续编辑" })).toBeFocused();
  await confirm.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(edit.getByLabel("名称")).toHaveValue("V1 脏草稿");
  await expect(edit.getByLabel("名称")).toBeFocused();
  await edit.getByRole("button", { name: "Close" }).click();
  await confirm.getByRole("button", { name: "放弃修改" }).click();
  await expect(editVersion).toBeFocused();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "甘特", exact: true }).click();
  await screenshot(page, info, "g3b3-wide");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(gantt).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, info, "g3b3-narrow");
});
