import { describe, expect, it } from "vitest";
import { AliceClient } from "./paperclip-client.js";

const AGENT_ID = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const COMPANY_ID = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";
const RUN_ID = "f2c991f1-b53d-4bb5-b134-8e29d43815d0";
const ISSUE_ID = "1b9c2019-b811-40a0-bd21-0365977a0001";
const LEASE_ID = "784d88a1-7a05-42d2-a7d8-e714d70f2d0b";
const DEVICE_ID = "8da47d3b-0a6e-49d4-9c26-17bc76de470f";
const KEY_ID = "fd7a78df-9781-4070-9974-7f7a7e051330";

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

  it("claims a server-issued run with a stable idempotency key and validates ownership", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AliceClient({
      apiBase: "http://alice.test", token: "secret",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/api/agents/me")) return jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" });
        return jsonResponse({ runId: RUN_ID, issueId: ISSUE_ID, agentId: AGENT_ID, leaseId: LEASE_ID, generation: 1,
          leaseExpiresAt: "2026-11-06T04:00:00Z", wakeReason: "assignment", workspacePolicy: "agent_home" });
      },
    });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const claim = await client.claimLocalRun(DEVICE_ID, KEY_ID);
    expect(claim?.runId).toBe(RUN_ID);
    expect(new Headers(calls[1]?.init?.headers).get("idempotency-key")).toBe(KEY_ID);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ deviceId: DEVICE_ID });
  });

  it("treats no queued work as no claim, and rejects a forged ownership response", async () => {
    let claimStatus = 204;
    const client = new AliceClient({
      apiBase: "http://alice.test", token: "secret",
      fetch: async (url) => String(url).endsWith("/api/agents/me")
        ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
        : claimStatus === 204 ? new Response(null, { status: 204 })
          : jsonResponse({ runId: RUN_ID, issueId: ISSUE_ID, agentId: DEVICE_ID, leaseId: LEASE_ID, generation: 1,
            leaseExpiresAt: "2026-11-06T04:00:00Z", wakeReason: "assignment", workspacePolicy: "agent_home" }),
    });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    expect(await client.claimLocalRun(DEVICE_ID, KEY_ID)).toBeNull();
    claimStatus = 200;
    await expect(client.claimLocalRun(DEVICE_ID, KEY_ID)).rejects.toThrow("identity mismatch");
  });

  it("rejects renewal after the server fences an expired or cancelled lease", async () => {
    const client = new AliceClient({
      apiBase: "http://alice.test", token: "secret",
      fetch: async (url) => String(url).endsWith("/api/agents/me")
        ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
        : jsonResponse({ error: "lease_expired" }, 409),
    });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    await expect(client.renewLocalRun({ deviceId: DEVICE_ID, runId: RUN_ID, leaseId: LEASE_ID, generation: 1 }))
      .rejects.toThrow("HTTP 409");
  });

  it("loads only the claimed issue and refuses a changed assignee", async () => {
    let assignee = AGENT_ID;
    let executionRunId = RUN_ID;
    const client = new AliceClient({
      apiBase: "http://alice.test", token: "secret",
      fetch: async (url) => String(url).endsWith("/api/agents/me")
        ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
        : jsonResponse({ id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: assignee, executionRunId,
          projectId: null, identifier: "PAP-20", title: "只读验收", status: "in_progress",
          priority: "medium", updatedAt: "2026-11-06T03:00:00Z" }),
    });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const claim = { runId: RUN_ID, issueId: ISSUE_ID, agentId: AGENT_ID, leaseId: LEASE_ID,
      generation: 1, leaseExpiresAt: "2026-11-06T04:00:00Z", wakeReason: "assignment", workspacePolicy: "agent_home" as const };
    expect((await client.getClaimedIssue(claim)).activeRunId).toBe(RUN_ID);
    assignee = DEVICE_ID;
    await expect(client.getClaimedIssue(claim)).rejects.toThrow("ownership mismatch");
    assignee = AGENT_ID;
    executionRunId = DEVICE_ID;
    await expect(client.getClaimedIssue(claim)).rejects.toThrow("ownership mismatch");
  });

  it("sends the current lease on renew, control and finish without printing it", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const logs: string[] = [];
    const client = new AliceClient({
      apiBase: "http://alice.test", token: "secret",
      logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/api/agents/me")) return jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" });
        if (String(url).includes("/renew")) return jsonResponse({ leaseExpiresAt: "2026-11-06T04:01:00Z", cancelRequested: false });
        if (String(url).includes("/control")) return jsonResponse({ action: "continue", generation: 1, leaseExpiresAt: "2026-11-06T04:01:00Z" });
        return jsonResponse({ runId: RUN_ID, status: "succeeded" });
      },
    });
    const lease = { deviceId: DEVICE_ID, runId: RUN_ID, leaseId: LEASE_ID, generation: 1 };
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    expect((await client.renewLocalRun(lease)).cancelRequested).toBe(false);
    expect((await client.controlLocalRun(lease)).action).toBe("continue");
    expect(await client.finishLocalRun(lease, "succeeded", 0)).toBe("succeeded");
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ deviceId: DEVICE_ID, leaseId: LEASE_ID, generation: 1 });
    expect(calls[2]?.url).toContain(`leaseId=${LEASE_ID}`);
    expect(JSON.parse(String(calls[3]?.init?.body))).toMatchObject({ deviceId: DEVICE_ID, leaseId: LEASE_ID, generation: 1, processStopped: true });
    expect(logs.join("\n")).not.toContain(LEASE_ID);
  });
});

