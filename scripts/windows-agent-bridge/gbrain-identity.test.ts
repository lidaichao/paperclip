import { describe, expect, it, vi } from "vitest";
import { expectedGbrainIdentity, verifyGbrainIdentity } from "./gbrain-identity.js";
import type { BridgeAgentConfig } from "./types.js";

const agent: BridgeAgentConfig = {
  remoteAgentId: "38a5808c-47f3-4029-bdfe-0d84504bdc8a", remoteAgentName: "Luna", localAgentName: "Luna",
  gbrainEnvRef: "GBRAIN_LUNA_TOKEN", adapterType: "codex_local",
  localAdapterConfig: { cwd: "H:/AIagent/Luna", command: "C:/tools/codex.exe" }, maxConcurrentRuns: 1,
};

describe("GBrain member identity gate", () => {
  it("rejects a different member's named credential before any MCP call", async () => {
    const fetcher = vi.fn();
    await expect(verifyGbrainIdentity({ agent: { ...agent, gbrainEnvRef: "GBRAIN_RABBIT_TOKEN" },
      endpoint: "http://gbrain.test/mcp", token: "private-token", fetch: fetcher }))
      .rejects.toThrow("gbrainEnvRef does not match");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("verifies the actual whoami client and source, without logging the credential", async () => {
    const calls: Array<{ method: string; auth: string }> = [];
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { method: string };
      calls.push({ method: payload.method, auth: new Headers(init?.headers).get("authorization") ?? "" });
      if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: payload.method === "initialize" ? 1 : 2,
        result: payload.method === "initialize" ? {} : { content: [{ type: "text",
          text: JSON.stringify({ client_name: "luna-governed", source_id: "member-luna-drafts" }) }] } });
    });
    await verifyGbrainIdentity({ agent, endpoint: "http://gbrain.test/mcp", token: "private-token", fetch: fetcher });
    expect(calls.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(calls.every((call) => call.auth === "Bearer private-token")).toBe(true);
  });

  it("rejects a token that resolves to another source, including Miya's special source mapping", async () => {
    const miya = { ...agent, remoteAgentName: "Miya", localAgentName: "Miya", gbrainEnvRef: "GBRAIN_MIYA_TOKEN" };
    expect(expectedGbrainIdentity(miya).sourceId).toBe("miya-governed-workspace");
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ result: method === "initialize" ? {} : { content: [{ type: "text",
        text: JSON.stringify({ client_name: "miya-governed", source_id: "member-miya-drafts" }) }] } });
    });
    await expect(verifyGbrainIdentity({ agent: miya, endpoint: "http://gbrain.test/mcp",
      token: "private-token", fetch: fetcher })).rejects.toThrow("identity mismatch");
  });
});
