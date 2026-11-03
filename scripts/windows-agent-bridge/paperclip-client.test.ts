import { describe, expect, it } from "vitest";
import { AliceClient } from "./paperclip-client.js";

const AGENT_ID = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const COMPANY_ID = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AliceClient", () => {
  it("sends bearer auth but never logs it", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const lines: string[] = [];
    const token = "pc_agent_secret_1234567890";
    const client = new AliceClient({
      apiBase: "http://alice.test",
      token,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" });
      },
      logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("rejects an identity mismatch before polling", async () => {
    const client = new AliceClient({
      apiBase: "http://alice.test",
      token: "pc_agent_secret_1234567890",
      fetch: async () => jsonResponse({ id: "different-agent", companyId: COMPANY_ID, name: "Other" }),
    });
    await expect(client.verifyIdentity(AGENT_ID, COMPANY_ID)).rejects.toThrow("identity mismatch");
  });

  it("filters foreign inbox rows", async () => {
    const client = new AliceClient({
      apiBase: "http://alice.test",
      token: "pc_agent_secret_1234567890",
      fetch: async () => jsonResponse([
        {
          id: "issue-a",
          companyId: COMPANY_ID,
          projectId: null,
          identifier: "PAP-1",
          title: "实现功能",
          status: "todo",
          priority: "high",
          assigneeAgentId: AGENT_ID,
          updatedAt: "2026-11-03T10:00:00.000Z",
        },
        {
          id: "issue-b",
          companyId: COMPANY_ID,
          projectId: null,
          identifier: "PAP-2",
          title: "外部任务",
          status: "todo",
          priority: "low",
          assigneeAgentId: "different-agent",
          updatedAt: "2026-11-03T10:00:00.000Z",
        },
      ]),
    });
    const rows = await client.listInbox(AGENT_ID, COMPANY_ID);
    expect(rows.map((row) => row.identifier)).toEqual(["PAP-1"]);
  });
});

