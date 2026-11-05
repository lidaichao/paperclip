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

  it("derives the task scope from verified identity for the real inbox-lite shape", async () => {
    const client = new AliceClient({
      apiBase: "http://alice.test",
      token: "pc_agent_secret_1234567890",
      fetch: async (url) => String(url).endsWith("/api/agents/me")
        ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
        : jsonResponse([{
          id: "issue-a",
          projectId: null,
          identifier: "PAP-1",
          title: "实现功能",
          status: "todo",
          priority: "high",
          updatedAt: "2026-11-03T10:00:00.000Z",
          activeRun: null,
          dependencyReady: true,
        }]),
    });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const rows = await client.listInbox(AGENT_ID, COMPANY_ID);
    expect(rows.map((row) => row.identifier)).toEqual(["PAP-1"]);
    expect(rows[0]).toMatchObject({ companyId: COMPANY_ID, assigneeAgentId: AGENT_ID });
  });

  it("does not poll before identity verification", async () => {
    const client = new AliceClient({
      apiBase: "http://alice.test",
      token: "pc_agent_secret_1234567890",
      fetch: async () => { throw new Error("should not fetch"); },
    });
    await expect(client.listInbox(AGENT_ID, COMPANY_ID)).rejects.toThrow("identity must be verified");
  });

  it("rejects a conflicting scope if a server starts returning scope fields", async () => {
    const client = new AliceClient({
      apiBase: "http://alice.test",
      token: "pc_agent_secret_1234567890",
      fetch: async (url) => String(url).endsWith("/api/agents/me")
        ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
        : jsonResponse([{
          id: "issue-a",
          identifier: "PAP-1",
          title: "实现功能",
          status: "todo",
          priority: "high",
          updatedAt: "2026-11-03T10:00:00.000Z",
          assigneeAgentId: "different-agent",
        }]),
    });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    await expect(client.listInbox(AGENT_ID, COMPANY_ID)).rejects.toThrow("conflicts with the verified identity");
  });
});

