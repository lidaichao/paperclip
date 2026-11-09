import path from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test, type APIResponse } from "@playwright/test";
import { closeRegisteredClients, companies, createDb, projects } from "../../packages/db/src/index.ts";

const companyId = "a1111111-1111-4111-8111-111111111111";
const projectId = "b2222222-2222-4222-8222-222222222222";

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

test("approved package confirmation creates one native task and repeat confirmation reuses it", async ({ page, request }) => {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  const url = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
  const db = createDb(url);
  try {
    await db.insert(companies).values({ id: companyId, name: "Approved dispatch browser proof", issuePrefix: "WRA" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Allowed package" });
    const agent = await json<{ id: string }>(
      await request.post(`/api/companies/${companyId}/agents`, {
        data: {
          name: "Package process agent",
          role: "engineer",
          adapterType: "process",
          adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        },
      }),
      "create process agent",
    );
    await json(
      await request.post(`/api/companies/${companyId}/work-records`, {
        data: {
          projectId,
          kind: "plan",
          title: "Approved browser package",
          assigneeAgentId: agent.id,
          qaAssigneeAgentId: agent.id,
          predecessorRecordIds: [],
        },
      }),
      "create work record",
    );

    await page.goto(`/WRA/projects/${projectId}/plans`);
    await expect(page.getByRole("button", { name: "Approved browser package", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Approved browser package", exact: true }).click();
    const before = await json<unknown[]>(await request.get(`/api/companies/${companyId}/issues`), "issues before preview");
    await page.getByRole("button", { name: "预览整个工作包", exact: true }).click();
    await expect(page.getByText("派发前范围预览", { exact: true })).toBeVisible();
    expect(await json<unknown[]>(await request.get(`/api/companies/${companyId}/issues`), "issues after preview")).toHaveLength(before.length);

    const confirm = page.getByRole("button", { name: /确认并派发工作包（创建执行任务）/ });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(async () => (
      await json<unknown[]>(await request.get(`/api/companies/${companyId}/issues`), "issues after confirmation")
    ).length).toBe(before.length + 1);
    let nativeIssueId: string | null = null;
    await expect.poll(async () => {
      const recordAfterFirst = await json<Array<{ execution: { issueId: string | null } }>>(
        await request.get(`/api/companies/${companyId}/projects/${projectId}/work-records`),
        "record after first confirmation",
      );
      nativeIssueId = recordAfterFirst[0]?.execution.issueId ?? null;
      return nativeIssueId;
    }, { timeout: 20_000 }).not.toBeNull();
    await expect(page.getByText("最近派发批次", { exact: true })).toBeVisible();
    await confirm.click();
    expect(await json<unknown[]>(await request.get(`/api/companies/${companyId}/issues`), "issues after repeat confirmation")).toHaveLength(before.length + 1);
    const recordAfterRepeat = await json<Array<{ execution: { issueId: string | null } }>>(
      await request.get(`/api/companies/${companyId}/projects/${projectId}/work-records`),
      "record after repeated confirmation",
    );
    expect(recordAfterRepeat[0]?.execution.issueId).toBe(nativeIssueId);
  } finally {
    await closeRegisteredClients(url);
  }
});
