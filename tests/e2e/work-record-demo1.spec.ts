import { expect, test, type APIResponse } from "@playwright/test";

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

test("Demo 1 keeps plan and defect routes stable while save remains non-executing", async ({ page, request }) => {
  await page.setViewportSize({ width: 1319, height: 1012 });
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `Demo 1 ${Date.now()}` } }),
    "create company",
  );
  const project = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Demo 1 路由与密度" } }),
    "create project",
  );

  for (let index = 1; index <= 14; index += 1) {
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
  const rows = page.getByTestId("work-record-row");
  await expect(rows).toHaveCount(14);
  await expect(page.getByText("缺陷 01", { exact: true })).toHaveCount(0);
  const twelfthRow = await rows.nth(11).boundingBox();
  expect(twelfthRow && twelfthRow.y + twelfthRow.height).toBeLessThanOrEqual(1012);

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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/${company.issuePrefix}/projects/${project.id}/defects`);
  await expect(page.getByText("缺陷 01", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
});
