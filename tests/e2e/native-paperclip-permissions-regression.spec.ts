import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { expect, request as playwrightRequest, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { closeRegisteredClients, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";

type Company = { id: string; issuePrefix: string };
type Project = { id: string };
type Agent = { id: string; name: string };
type AgentKey = { token: string };
type Issue = {
  id: string;
  identifier: string;
  title: string;
  assigneeAgentId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
};
type IssueComment = {
  id: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
};

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function agentClient(
  board: APIRequestContext,
  baseURL: string,
  agent: Agent,
): Promise<APIRequestContext> {
  const key = await json<AgentKey>(
    await board.post(`/api/agents/${agent.id}/keys`, { data: { name: `native-regression-${agent.name}` } }),
    `create key for ${agent.name}`,
  );
  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { authorization: `Bearer ${key.token}` },
  });
}

async function connectToE2eDatabase() {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  const url = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
  return { db: createDb(url), url };
}

test("NATIVE-IDENTITY-01 agents create tasks and comments as themselves, never as the board administrator", async ({ request }, testInfo) => {
  const suffix = Date.now();
  const company = await json<Company>(
    await request.post("/api/companies", { data: { name: `Native identity ${suffix}` } }),
    "create identity company",
  );
  const project = await json<Project>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: `Identity project ${suffix}` } }),
    "create identity project",
  );
  const agents = await Promise.all(["Rabbit", "Belle"].map(async (name) => json<Agent>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name,
        role: name === "Belle" ? "qa" : "engineer",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
    `create ${name}`,
  )));

  const baseURL = String(testInfo.project.use.baseURL);
  const clients = await Promise.all(agents.map((agent) => agentClient(request, baseURL, agent)));
  const { db, url } = await connectToE2eDatabase();
  try {
    for (const [index, agent] of agents.entries()) {
      const client = clients[index]!;
      const issue = await json<Issue>(
        await client.post(`/api/companies/${company.id}/issues`, {
          data: {
            title: `${agent.name} 自建任务 ${suffix}`,
            projectId: project.id,
            assigneeAgentId: agent.id,
            priority: "medium",
          },
        }),
        `${agent.name} creates issue`,
      );
      expect(issue).toMatchObject({
        assigneeAgentId: agent.id,
        createdByAgentId: agent.id,
        createdByUserId: null,
      });

      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        invocationSource: "assignment",
        contextSnapshot: { issueId: issue.id },
      });
      const commentBody = `${agent.name} 自己发送的任务消息 ${suffix}`;
      const comment = await json<IssueComment>(
        await client.post(`/api/issues/${issue.id}/comments`, {
          headers: { "x-paperclip-run-id": runId },
          data: { body: commentBody, clientRequestId: randomUUID() },
        }),
        `${agent.name} sends issue comment`,
      );
      expect(comment).toMatchObject({
        body: commentBody,
        authorAgentId: agent.id,
        authorUserId: null,
      });

      const persisted = await json<IssueComment[]>(
        await request.get(`/api/issues/${issue.id}/comments`),
        `read ${agent.name} persisted comments`,
      );
      expect(persisted).toContainEqual(expect.objectContaining({
        id: comment.id,
        body: commentBody,
        authorAgentId: agent.id,
        authorUserId: null,
      }));
    }
  } finally {
    await Promise.all(clients.map((client) => client.dispose()));
    await closeRegisteredClients(url);
  }
});

test("NATIVE-PERMISSION-01 an agent cannot spoof a human creator or commenter identity", async ({ request }, testInfo) => {
  const suffix = Date.now();
  const company = await json<Company>(
    await request.post("/api/companies", { data: { name: `Native spoof guard ${suffix}` } }),
    "create spoof company",
  );
  const agent = await json<Agent>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Ada",
        role: "pm",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
    "create spoof guard agent",
  );
  const client = await agentClient(request, String(testInfo.project.use.baseURL), agent);
  try {
    const sanitized = await json<Issue>(
      await client.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: `伪造署名应被服务端清洗 ${suffix}`,
          assigneeAgentId: agent.id,
          createdByUserId: "local-board",
        },
      }),
      "sanitize spoofed creator identity",
    );
    expect(sanitized).toMatchObject({
      createdByAgentId: agent.id,
      createdByUserId: null,
    });

    const ordinary = await json<Issue>(
      await client.post(`/api/companies/${company.id}/issues`, {
        data: { title: `正常智能体任务 ${suffix}`, assigneeAgentId: agent.id },
      }),
      "create ordinary agent issue",
    );
    const comment = await client.post(`/api/issues/${ordinary.id}/comments`, {
      data: {
        body: "伪造管理员评论应被拒绝",
        clientRequestId: randomUUID(),
        onBehalfOfUserId: randomUUID(),
      },
    });
    expect([403, 422], "spoofed commenter identity must be rejected before persistence")
      .toContain(comment.status());
    expect(await json<IssueComment[]>(
      await request.get(`/api/issues/${ordinary.id}/comments`),
      "verify spoof comment did not persist",
    )).toEqual([]);
  } finally {
    await client.dispose();
  }
});
