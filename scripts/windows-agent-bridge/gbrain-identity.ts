import type { BridgeAgentConfig } from "./types.js";

const IDENTITIES: Record<string, { ref: string; clientName: string; sourceId: string }> = {
  Luna: { ref: "GBRAIN_LUNA_TOKEN", clientName: "luna-governed", sourceId: "member-luna-drafts" },
  Rabbit: { ref: "GBRAIN_RABBIT_TOKEN", clientName: "rabbit-governed", sourceId: "member-rabbit-drafts" },
  "卡罗尔": { ref: "GBRAIN_CARROLL_TOKEN", clientName: "carroll-governed", sourceId: "member-carroll-drafts" },
  Carroll: { ref: "GBRAIN_CARROLL_TOKEN", clientName: "carroll-governed", sourceId: "member-carroll-drafts" },
  Belle: { ref: "GBRAIN_BELLE_TOKEN", clientName: "belle-governed", sourceId: "member-belle-drafts" },
  Ada: { ref: "GBRAIN_ADA_TOKEN", clientName: "ada-governed", sourceId: "member-ada-drafts" },
  Miya: { ref: "GBRAIN_MIYA_TOKEN", clientName: "miya-governed", sourceId: "miya-governed-workspace" },
  Monet: { ref: "GBRAIN_MONET_TOKEN", clientName: "monet-governed", sourceId: "monet-governed-workspace" },
};

export function expectedGbrainIdentity(agent: BridgeAgentConfig) {
  const expected = IDENTITIES[agent.remoteAgentName];
  if (!expected || agent.localAgentName !== agent.remoteAgentName || agent.gbrainEnvRef !== expected.ref) {
    throw new Error("GBrain gbrainEnvRef does not match the Paperclip agent");
  }
  return expected;
}

function mcpResult(raw: string): Record<string, unknown> {
  const data = raw.split(/\r?\n/).find((line) => line.startsWith("data:"));
  const parsed: unknown = JSON.parse(data ? data.slice(5).trim() : raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid GBrain MCP response");
  return parsed as Record<string, unknown>;
}

/** Read-only identity handshake. The token and response body never enter errors or logs. */
export async function verifyGbrainIdentity(input: {
  agent: BridgeAgentConfig;
  endpoint: string | undefined;
  token: string | undefined;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<void> {
  const expected = expectedGbrainIdentity(input.agent);
  if (!input.token || !input.endpoint) throw new Error("GBrain identity endpoint or credential is missing");
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); }
  catch { throw new Error("GBrain MCP endpoint is invalid"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash || !endpoint.pathname.endsWith("/mcp")) {
    throw new Error("GBrain MCP endpoint is invalid");
  }
  const fetcher = input.fetch ?? globalThis.fetch;
  let session: string | null = null;
  const rpc = async (method: string, params: Record<string, unknown>, id?: number) => {
    const response = await fetcher(endpoint, {
      method: "POST", signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json",
        accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) }),
    });
    if (!response.ok) throw new Error(`GBrain whoami unavailable: HTTP ${response.status}`);
    session = response.headers.get("mcp-session-id") ?? session;
    const raw = await response.text();
    return id === undefined && !raw.trim() ? null : mcpResult(raw);
  };
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "paperclip-local-identity-check", version: "1" } }, 1);
    await rpc("notifications/initialized", {});
    const reply = await rpc("tools/call", { name: "whoami", arguments: {} }, 2);
    const result = reply?.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const text = result?.content?.find((entry) => entry.type === "text")?.text;
    const identity = JSON.parse(text ?? "{}") as { client_name?: string; source_id?: string };
    if (identity.client_name !== expected.clientName || identity.source_id !== expected.sourceId) {
      throw new Error("GBrain whoami identity mismatch");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GBrain ")) throw error;
    throw new Error("GBrain whoami verification failed");
  }
}
