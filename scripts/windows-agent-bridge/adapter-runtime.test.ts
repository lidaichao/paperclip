import { describe, expect, it } from "vitest";
import { loadLocalAgentRuntimeConfig, runLocalAgent } from "./adapter-runtime.js";
import type { AdapterExecutionContext } from "../../packages/adapter-utils/src/types.js";
import type { BridgeInboxItem, LocalAgentRuntimeConfig } from "./types.js";

const REMOTE_COMPANY_ID = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";
const REMOTE_AGENT_ID = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const LOCAL_COMPANY_ID = "832910ae-5efa-4b9f-9992-1d70b281be1e";
const SERVER_RUN_ID = "a0bd96c2-5497-4c78-a78b-f1d59703e623";

function issue(): BridgeInboxItem {
  return {
    id: "issue-1",
    companyId: REMOTE_COMPANY_ID,
    projectId: null,
    identifier: "PAP-1",
    title: "实现功能",
    status: "todo",
    priority: "high",
    assigneeAgentId: REMOTE_AGENT_ID,
    updatedAt: "2026-11-03T10:00:00.000Z",
    activeRunId: null,
  };
}

function localAgent(): LocalAgentRuntimeConfig {
  return {
    id: "local-agent-1",
    companyId: LOCAL_COMPANY_ID,
    name: "Luna",
    adapterType: "codex_local",
    adapterConfig: {
      cwd: "H:/AIagent/Luna",
      command: "C:/tools/codex.exe",
      model: "gpt-5.6-sol",
    },
  };
}

describe("loadLocalAgentRuntimeConfig", () => {
  it("refuses unresolved environment bindings instead of silently dropping GR identity", async () => {
    const pending = loadLocalAgentRuntimeConfig({
      localApiBase: "http://127.0.0.1:3100",
      localCompanyId: LOCAL_COMPANY_ID,
      localAgentName: "Luna",
      expectedAdapterType: "codex_local",
      fetch: async () => new Response(JSON.stringify([{
        id: "local-agent-1",
        companyId: LOCAL_COMPANY_ID,
        name: "Luna",
        adapterType: "codex_local",
        adapterConfig: {
          cwd: "H:/AIagent/Luna",
          command: "C:/tools/codex.exe",
          model: "gpt-5.6-sol",
          env: { GBRAIN_AGENT_TOKEN: { type: "secret_ref", secretId: "secret-id" } },
        },
      }]), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(pending).rejects.toThrow("verified secret-resolution path");
  });
});

describe("runLocalAgent", () => {
  it("passes the token only through authToken and redacts adapter logs", async () => {
    const previousApiBase = process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_URL;
    const token = "pc_agent_secret_1234567890";
    let captured: AdapterExecutionContext | null = null;
    const lines: string[] = [];
    try {
      const result = await runLocalAgent({
        runId: SERVER_RUN_ID,
        apiBase: "http://192.168.72.157:3100",
        remoteCompanyId: REMOTE_COMPANY_ID,
        remoteAgentId: REMOTE_AGENT_ID,
        remoteAgentName: "Luna",
        issue: issue(),
        token,
        localAgent: localAgent(),
        onLog: async (_stream, chunk) => { lines.push(chunk); },
        dependencies: {
          codexExecute: async (ctx) => {
            captured = ctx;
            await ctx.onLog("stdout", `safe ${token} text`);
            return { exitCode: 0, signal: null, timedOut: false };
          },
        },
      });
      expect(result.succeeded).toBe(true);
      expect(result.runId).toBe(SERVER_RUN_ID);
      const invocation = captured as AdapterExecutionContext | null;
      expect(invocation).not.toBeNull();
      if (!invocation) throw new Error("adapter invocation was not captured");
      expect(invocation.authToken).toBe(token);
      expect(invocation.runId).toBe(SERVER_RUN_ID);
      expect(JSON.stringify(invocation.context)).not.toContain(token);
      expect(JSON.stringify(invocation.config)).not.toContain(token);
      expect(lines.join("\n")).not.toContain(token);
      expect(lines.join("\n")).toContain("[redacted]");
    } finally {
      if (previousApiBase === undefined) delete process.env.PAPERCLIP_API_URL;
      else process.env.PAPERCLIP_API_URL = previousApiBase;
    }
  });

  it("refuses tasks assigned to another agent", async () => {
    const task = issue();
    task.assigneeAgentId = "different-agent";
    await expect(runLocalAgent({
      runId: SERVER_RUN_ID,
      apiBase: "http://192.168.72.157:3100",
      remoteCompanyId: REMOTE_COMPANY_ID,
      remoteAgentId: REMOTE_AGENT_ID,
      remoteAgentName: "Luna",
      issue: task,
      token: "pc_agent_secret_1234567890",
      localAgent: localAgent(),
    })).rejects.toThrow("different Alice identity");
  });

  it("never launches an adapter without a server-issued run id", async () => {
    let launched = false;
    await expect(runLocalAgent({
      runId: "",
      apiBase: "http://192.168.72.157:3100",
      remoteCompanyId: REMOTE_COMPANY_ID,
      remoteAgentId: REMOTE_AGENT_ID,
      remoteAgentName: "Luna",
      issue: issue(),
      token: "pc_agent_secret_1234567890",
      localAgent: localAgent(),
      dependencies: {
        codexExecute: async () => {
          launched = true;
          return { exitCode: 0, signal: null, timedOut: false };
        },
      },
    })).rejects.toThrow("valid server-issued Paperclip run id is required");
    expect(launched).toBe(false);
  });

  it("rejects an arbitrary local run label before invoking the adapter", async () => {
    await expect(runLocalAgent({
      runId: "local-run-1",
      apiBase: "http://192.168.72.157:3100",
      remoteCompanyId: REMOTE_COMPANY_ID,
      remoteAgentId: REMOTE_AGENT_ID,
      remoteAgentName: "Luna",
      issue: issue(),
      token: "pc_agent_secret_1234567890",
      localAgent: localAgent(),
    })).rejects.toThrow("valid server-issued Paperclip run id is required");
  });
});

