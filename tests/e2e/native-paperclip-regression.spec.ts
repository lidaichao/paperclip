import { expect, test, type APIResponse, type Page } from "@playwright/test";

type Company = {
  id: string;
  issuePrefix: string;
};

type Issue = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  createdByUserId: string | null;
};

type IssueComment = {
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
};

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function sendComment(page: Page, body: string) {
  await page
    .getByTestId("task-chat-composer-input")
    .last()
    .locator('[contenteditable="true"],textarea')
    .first()
    .fill(body);
  await page.getByTestId("task-chat-composer-send").last().click();
}

test.use({ serviceWorkers: "allow", trace: "retain-on-failure" });

test("native task create, comment and status persistence survive Demo workspace changes", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = Date.now();
  const title = `原生回归任务 ${suffix}`;
  const commentBody = `原生对话持久化 ${suffix}`;

  const company = await json<Company>(
    await request.post("/api/companies", { data: { name: `原生回归 ${suffix}` } }),
    "create company",
  );

  await page.goto(`/${company.issuePrefix}/issues`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
  await page.getByPlaceholder("任务标题").fill(title);
  await expect(page.getByTestId("new-issue-creator-identity-note")).toBeVisible();
  await page.getByRole("button", { name: "创建任务", exact: true }).click();

  let issue: Issue | undefined;
  await expect.poll(async () => {
    const issues = await json<Issue[]>(
      await request.get(`/api/companies/${company.id}/issues`),
      "list company issues",
    );
    issue = issues.find((candidate) => candidate.title === title);
    return issue?.identifier ?? null;
  }, { timeout: 15_000 }).not.toBeNull();

  expect(issue?.createdByUserId, "浏览器创建的任务应保留真实用户作者").toBeTruthy();
  const route = `/${company.issuePrefix}/issues/${issue!.identifier}`;
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout: 30_000 });

  await sendComment(page, commentBody);
  await expect(page.getByText(commentBody, { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const comments = await json<IssueComment[]>(
      await request.get(`/api/issues/${issue!.id}/comments`),
      "list issue comments",
    );
    return comments.some((comment) =>
      comment.body === commentBody
      && comment.authorAgentId === null
      && Boolean(comment.authorUserId),
    );
  }, { timeout: 15_000 }).toBe(true);

  await page.getByRole("button", { name: /更改状态（当前：/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "已完成 已完成", exact: true }).click();
  await expect.poll(async () => {
    const persisted = await json<Issue>(
      await request.get(`/api/issues/${issue!.id}`),
      "read updated issue",
    );
    return persisted.status;
  }, { timeout: 15_000 }).toBe("done");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(commentBody, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "更改状态（当前：已完成）" }).first()).toBeVisible();

  expect(
    await json<unknown[]>(await request.get(`/api/issues/${issue!.id}/runs`), "list issue runs"),
    "未派发的普通任务不应启动 Agent",
  ).toEqual([]);
});
