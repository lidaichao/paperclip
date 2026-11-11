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
  priority?: string;
  projectId?: string | null;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  createdByUserId: string | null;
};

type IssueComment = {
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
};

type Project = { id: string; name: string };
type Agent = { id: string; name: string };
type Attachment = {
  id: string;
  originalFilename: string | null;
  contentPath: string;
};
type Activity = { action: string; entityId: string | null };
type Interaction = { id: string; status: string };

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

test("native task fields, hierarchy, search, attachments and audit remain durable", async ({ request }) => {
  test.setTimeout(90_000);
  const suffix = Date.now();
  const company = await json<Company>(
    await request.post("/api/companies", { data: { name: `Native durable fields ${suffix}` } }),
    "create durable-fields company",
  );
  const project = await json<Project>(
    await request.post(`/api/companies/${company.id}/projects`, {
      data: { name: `Native project ${suffix}` },
    }),
    "create durable-fields project",
  );
  const agent = await json<Agent>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: `Native assignee ${suffix}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
    "create durable-fields agent",
  );
  const parent = await json<Issue>(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: {
        title: `Native parent ${suffix}`,
        projectId: project.id,
        status: "backlog",
      },
    }),
    "create durable-fields parent",
  );
  const child = await json<Issue>(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: {
        title: `Native searchable child ${suffix}`,
        status: "backlog",
      },
    }),
    "create durable-fields child",
  );

  await json<Issue>(
    await request.patch(`/api/issues/${child.id}`, {
      data: {
        priority: "high",
        projectId: project.id,
        parentId: parent.id,
        assigneeAgentId: agent.id,
      },
    }),
    "update native fields",
  );
  const persisted = await json<Issue>(
    await request.get(`/api/issues/${child.id}`),
    "reload native fields",
  );
  expect(persisted).toMatchObject({
    id: child.id,
    priority: "high",
    projectId: project.id,
    parentId: parent.id,
    assigneeAgentId: agent.id,
  });

  const searchResults = await json<Issue[]>(
    await request.get(`/api/companies/${company.id}/issues`, {
      params: { q: `searchable child ${suffix}` },
    }),
    "search native task",
  );
  expect(searchResults).toContainEqual(expect.objectContaining({ id: child.id }));

  const file = Buffer.from(`Paperclip native attachment ${suffix}`, "utf8");
  const attachment = await json<Attachment>(
    await request.post(`/api/companies/${company.id}/issues/${child.id}/attachments`, {
      multipart: {
        file: {
          name: `native-${suffix}.txt`,
          mimeType: "text/plain",
          buffer: file,
        },
      },
    }),
    "upload native attachment",
  );
  expect(attachment.originalFilename).toBe(`native-${suffix}.txt`);
  expect(await (await request.get(attachment.contentPath)).body()).toEqual(file);
  expect(await json<Attachment[]>(
    await request.get(`/api/issues/${child.id}/attachments`),
    "reload native attachments",
  )).toContainEqual(expect.objectContaining({ id: attachment.id }));

  await json<{ ok: true }>(
    await request.delete(`/api/attachments/${attachment.id}`),
    "delete native attachment",
  );
  expect(await json<Attachment[]>(
    await request.get(`/api/issues/${child.id}/attachments`),
    "reload attachments after delete",
  )).toEqual([]);

  const activity = await json<Activity[]>(
    await request.get(`/api/companies/${company.id}/activity`, {
      params: { entityType: "issue", entityId: child.id, limit: "100" },
    }),
    "read native audit activity",
  );
  expect(activity.map((event) => event.action)).toEqual(expect.arrayContaining([
    "issue.created",
    "issue.updated",
    "issue.attachment_added",
    "issue.attachment_removed",
  ]));
  expect(
    await json<unknown[]>(await request.get(`/api/issues/${child.id}/runs`), "list durable-fields runs"),
    "field edits and attachments must not dispatch the assigned Agent",
  ).toEqual([]);
});

test("pending confirmation lets the board return to comments without resolving the decision", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = Date.now();
  const company = await json<Company>(
    await request.post("/api/companies", { data: { name: `Native confirmation comments ${suffix}` } }),
    "create confirmation company",
  );
  const issue = await json<Issue>(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: `Native pending confirmation ${suffix}`, status: "in_review" },
    }),
    "create confirmation issue",
  );
  const interaction = await json<Interaction>(
    await request.post(`/api/issues/${issue.id}/interactions`, {
      data: {
        kind: "request_confirmation",
        idempotencyKey: `native-confirmation-${suffix}`,
        title: "确认原生任务结果",
        summary: "确认面板不能阻断普通评论。",
        continuationPolicy: "none",
        payload: {
          version: 1,
          prompt: "请确认这次原生任务结果。",
          detailsMarkdown: "评论后仍必须保留批准或拒绝操作。",
          acceptLabel: "批准原生结果",
          rejectLabel: "拒绝原生结果",
          rejectRequiresReason: false,
          supersedeOnUserComment: false,
        },
      },
    }),
    "create pending confirmation",
  );
  expect(interaction.status).toBe("pending");

  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "批准原生结果", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "拒绝原生结果", exact: true })).toBeVisible();
  await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
  await expect(page.getByTestId("task-chat-composer-return-to-comment")).toHaveCount(0);

  const commentBody = `确认期间的普通评论 ${suffix}`;
  await sendComment(page, commentBody);
  await expect(page.getByText(commentBody, { exact: true })).toBeVisible();

  const interactions = await json<Interaction[]>(
    await request.get(`/api/issues/${issue.id}/interactions`),
    "reload pending confirmation",
  );
  expect(interactions).toContainEqual(expect.objectContaining({
    id: interaction.id,
    status: "pending",
  }));
  await expect(page.getByRole("button", { name: "批准原生结果", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "拒绝原生结果", exact: true })).toBeVisible();
});
