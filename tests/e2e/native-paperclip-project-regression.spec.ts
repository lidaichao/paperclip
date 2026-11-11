import { expect, test, type APIResponse, type Page } from "@playwright/test";

type Company = { id: string; issuePrefix: string };
type Project = { id: string; name: string };

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function expectNativePage(page: Page, expectedPath: RegExp) {
  await expect(page).toHaveURL(expectedPath, { timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText(/Application error|Internal Server Error/i);
  await expect(page.getByRole("button", { name: /打开账户菜单|Open account menu/i }))
    .toBeVisible({ timeout: 30_000 });
}

test("native project tabs remain reachable beside plans, gantt and defects", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = Date.now();
  const company = await json<Company>(
    await request.post("/api/companies", { data: { name: `Native project routes ${suffix}` } }),
    "create project-route company",
  );
  const project = await json<Project>(
    await request.post(`/api/companies/${company.id}/projects`, {
      data: { name: `Native route project ${suffix}` },
    }),
    "create project-route project",
  );

  await page.goto(`/${company.issuePrefix}/projects/${project.id}/issues`, { waitUntil: "domcontentloaded" });
  await expectNativePage(page, /\/projects\/[^/]+\/issues$/);
  for (const name of [/任务|Tasks/i, /配置|Configuration/i, /预算|Budget/i, "计划", "甘特图", "缺陷"]) {
    await expect(page.getByRole("tab", { name, exact: typeof name === "string" })).toBeVisible();
  }

  const routes = [
    { suffix: "configuration", selected: /配置|Configuration/i },
    { suffix: "budget", selected: /预算|Budget/i },
    { suffix: "plans", selected: "计划" },
    { suffix: "gantt", selected: "甘特图" },
    { suffix: "defects", selected: "缺陷" },
    { suffix: "issues", selected: /任务|Tasks/i },
  ] as const;
  for (const route of routes) {
    await page.goto(`/${company.issuePrefix}/projects/${project.id}/${route.suffix}`, { waitUntil: "domcontentloaded" });
    await expectNativePage(page, new RegExp(`/projects/[^/]+/${route.suffix}$`));
    await expect(page.getByRole("tab", { name: route.selected, exact: typeof route.selected === "string" }))
      .toHaveAttribute("aria-selected", "true");
  }
});

test("native team, skills, connections and audit routes are not replaced by Demo routes", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = Date.now();
  const company = await json<Company>(
    await request.post("/api/companies", { data: { name: `Native global routes ${suffix}` } }),
    "create global-route company",
  );
  const routes = ["agents/all", "skills", "apps", "activity/timeline"] as const;

  for (const route of routes) {
    await page.goto(`/${company.issuePrefix}/${route}`, { waitUntil: "domcontentloaded" });
    await expectNativePage(page, new RegExp(`/${route.replace("/", "\\/")}$`));
    await expect(page).not.toHaveURL(/\/projects\/[^/]+\/(plans|gantt|defects)$/);
  }
});
