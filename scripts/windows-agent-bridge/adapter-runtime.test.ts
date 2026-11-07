import { describe, expect, it } from "vitest";
import { runLocalAgent } from "./adapter-runtime.js";
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

describe("runLocalAgent", () => {
  it("passes the token only through authToken and redacts adapter logs", async () => {
    const previousApiBase = process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_URL;
    const token = "pc_agent_secret_1234567890";
    let captured: AdapterExecutionContext | null = null;
    const lines: string[] = [];
    const events: string[] = [];
    try {
      const result = await runLocalAgent({
        runId: SERVER_RUN_ID,
        apiBase: "http://127.0.0.1:43123",
        remoteCompanyId: REMOTE_COMPANY_ID,
        remoteAgentId: REMOTE_AGENT_ID,
        remoteAgentName: "Luna",
        issue: issue(),
        token,
        localAgent: localAgent(),
        onLog: async (_stream, chunk) => { lines.push(chunk); },
        onEvent: async (event) => { events.push(event.message ?? ""); },
        dependencies: {
          codexExecute: async (ctx) => {
            captured = ctx;
            await ctx.onLog("stdout", `safe ${token} text`);
            await ctx.onEvent?.({ eventType: "progress", message: `event ${token}` });
            return { exitCode: 0, signal: null, timedOut: false, summary: `summary ${token}` };
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
      expect(String(invocation.config.promptTemplate)).toContain("completion-review-handoff");
      expect(String(invocation.config.promptTemplate)).toContain(
        "only to ordinary native tasks");
      expect(String(invocation.config.promptTemplate)).toContain(
        "child-complete");
      expect(String(invocation.config.promptTemplate)).toContain(
        "defect-repair-handoff");
      expect(JSON.stringify(invocation.context)).not.toContain(token);
      expect(JSON.stringify(invocation.config)).not.toContain(token);
      expect(lines.join("\n")).not.toContain(token);
      expect(lines.join("\n")).toContain("[redacted]");
      expect(events.join("\n")).not.toContain(token);
      expect(result.summary).not.toContain(token);
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

  it("uses a dedicated review prompt without treating the reviewer as the source assignee", async () => {
    const task = issue();
    task.assigneeAgentId = "source-agent";
    task.status = "in_review";
    const reviewContext = { issue: { ...task, description: "Original requirement",
      statusVersion: 3 },
      review: { id: "review-1", interactionId: "interaction-1",
        sourceRunId: "source-run-1", sourceAgentId: "source-agent",
        reviewerAgentId: REMOTE_AGENT_ID, issueStatusVersion: 3,
        prompt: "Verify behavior", handoffSummary: "Ready to check" } };
    let captured: AdapterExecutionContext | undefined;
    await runLocalAgent({ runId: SERVER_RUN_ID,
      wakeReason: "issue_completion_review", apiBase: "http://127.0.0.1:43123",
      remoteCompanyId: REMOTE_COMPANY_ID, remoteAgentId: REMOTE_AGENT_ID,
      remoteAgentName: "Luna", issue: task, reviewContext,
      token: "review-capability", localAgent: localAgent(),
      dependencies: { codexExecute: async (ctx) => {
        captured = ctx;
        return { exitCode: 0, signal: null, timedOut: false };
      } },
    });
    expect(String(captured?.config.promptTemplate)).toContain("review-decision");
    expect(String(captured?.context.paperclipTaskMarkdown)).toContain("Verify behavior");
    expect(captured?.agent.id).toBe(REMOTE_AGENT_ID);
    await expect(runLocalAgent({ runId: SERVER_RUN_ID,
      wakeReason: "issue_completion_review", apiBase: "http://127.0.0.1:43123",
      remoteCompanyId: REMOTE_COMPANY_ID, remoteAgentId: REMOTE_AGENT_ID,
      remoteAgentName: "Luna", issue: task,
      token: "review-capability", localAgent: localAgent(),
    })).rejects.toThrow("review lease");
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

