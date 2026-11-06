import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalCommentIntentStore, startLocalRunWriteProxy } from "./local-run-write-proxy.js";
import type { LocalRunClaim } from "./paperclip-client.js";

const agentId = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const issueId = "1b9c2019-b811-40a0-bd21-0365977a0001";
const runId = "f2c991f1-b53d-4bb5-b134-8e29d43815d0";
const claim: LocalRunClaim = { agentId, issueId, runId,
  leaseId: "784d88a1-7a05-42d2-a7d8-e714d70f2d0b", generation: 1,
  leaseExpiresAt: "2026-11-06T10:00:00Z", leaseDeadlineMonotonicMs: 60_000,
  wakeReason: "assignment", workspacePolicy: "agent_home" };

async function fixture() {
  const intentFile = path.join(await mkdtemp(path.join(os.tmpdir(), "alice-local-write-")), "intent.json");
  const addLocalRunComment = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ id: "comment-1" }));
  const patchLocalRunIssue = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ id: issueId }));
  const controller = new AbortController();
  const proxy = await startLocalRunWriteProxy({ claim, deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
    signal: controller.signal, intentStore: new LocalCommentIntentStore(intentFile),
    client: {
      readLocalRunIdentity: () => ({ id: agentId, companyId: "company-1", name: "Luna" }),
      readLocalRunIssue: async () => ({ id: issueId, title: "Task" }),
      addLocalRunComment, patchLocalRunIssue,
    },
  });
  const request = (route: string, method = "GET", body?: unknown, bearer = proxy.token) =>
    fetch(`${proxy.apiBase}${route}`, { method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { proxy, controller, request, addLocalRunComment, patchLocalRunIssue, intentFile };
}

describe("fenced local run write capability", () => {
  it("binds reads to one issue and refuses another member's token or any other path", async () => {
    const f = await fixture();
    try {
      expect((await f.request("/api/agents/me")).status).toBe(200);
      expect((await f.request(`/api/issues/${issueId}`)).status).toBe(200);
      expect((await f.request(`/api/issues/${issueId}`, "GET", undefined, "other-member-token")).status).toBe(401);
      expect((await f.request("/api/issues/another-issue")).status).toBe(403);
      expect((await f.request(`/api/issues/${issueId}/attachments`, "POST", {})).status).toBe(403);
    } finally { await f.proxy.close(); }
  });

  it("retries a lost response by ID while treating repeated text as a new comment", async () => {
    const f = await fixture();
    try {
      f.addLocalRunComment.mockRejectedValueOnce(new Error("response lost"));
      const lost = await f.request(`/api/issues/${issueId}/comments`, "POST", { body: "Progress" });
      expect(lost.status).toBe(409);
      const persisted = JSON.parse(await readFile(f.intentFile, "utf8")) as { intents: Array<{ clientRequestId: string }> };
      expect(persisted.intents[0].clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(await lost.json()).toMatchObject({ clientRequestId: persisted.intents[0].clientRequestId });
      const unresolved = await f.request(`/api/issues/${issueId}/comments`, "POST", { body: "Progress" });
      expect(unresolved.status).toBe(409);
      expect(await unresolved.json()).toMatchObject({ clientRequestId: persisted.intents[0].clientRequestId });
      expect((await f.request(`/api/issues/${issueId}/comments`, "POST", {
        body: "Progress", clientRequestId: persisted.intents[0].clientRequestId,
      })).status).toBe(201);
      expect((await f.request(`/api/issues/${issueId}/comments`, "POST", {
        body: "Different", clientRequestId: persisted.intents[0].clientRequestId,
      })).status).toBe(409);
      expect((await f.request(`/api/issues/${issueId}/comments`, "POST", { body: "Progress" })).status).toBe(201);
      expect(f.addLocalRunComment.mock.calls).toHaveLength(3);
      expect(f.addLocalRunComment.mock.calls.slice(0, 2).map((call) => call[3]))
        .toEqual([persisted.intents[0].clientRequestId, persisted.intents[0].clientRequestId]);
      expect(f.addLocalRunComment.mock.calls[2][3]).not.toBe(persisted.intents[0].clientRequestId);
      expect((await f.request(`/api/issues/${issueId}`, "PATCH", { status: "done" })).status).toBe(400);
      expect((await f.request(`/api/issues/${issueId}`, "PATCH", { assigneeAgentId: agentId })).status).toBe(400);
      expect((await f.request(`/api/issues/${issueId}`, "PATCH", { priority: "high" })).status).toBe(200);
      expect(f.patchLocalRunIssue).toHaveBeenCalledTimes(1);
    } finally { await f.proxy.close(); }
  });

  it("refuses a successful run finish when a comment result is unresolved", async () => {
    const f = await fixture();
    f.addLocalRunComment.mockRejectedValueOnce(new Error("response lost"));
    expect((await f.request(`/api/issues/${issueId}/comments`, "POST", { body: "Final result" })).status).toBe(409);
    await expect(f.proxy.close()).rejects.toThrow("manual reconciliation");
    const persisted = JSON.parse(await readFile(f.intentFile, "utf8")) as {
      intents: Array<{ body: string; confirmed: boolean }>;
    };
    expect(persisted.intents).toEqual([expect.objectContaining({ body: "Final result", confirmed: false })]);
  });

  it("waits for an accepted comment write before closing a successful run", async () => {
    const f = await fixture();
    let entered!: () => void;
    let finishWrite!: (value: unknown) => void;
    const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
    f.addLocalRunComment.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { finishWrite = resolve; });
    });
    const response = f.request(`/api/issues/${issueId}/comments`, "POST", { body: "Final result" }).catch(() => null);
    await enteredWrite;
    let settled = false;
    const close = f.proxy.close().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishWrite({ id: "comment-1" });
    await close;
    expect(f.addLocalRunComment).toHaveBeenCalledTimes(1);
    await response;
  });

  it("accepts a completed prior-run intent when the current run has no comment", async () => {
    const f = await fixture();
    const store = new LocalCommentIntentStore(f.intentFile);
    const previous = await store.pending("e154778a-02bb-45d0-8391-d8a1b2a24112", issueId, "Previous result");
    await store.confirmed(previous);
    await expect(f.proxy.close()).resolves.toBeUndefined();
  });

  it("closes the write capability on cancellation before another write", async () => {
    const f = await fixture();
    f.controller.abort();
    await f.request(`/api/issues/${issueId}/comments`, "POST", { body: "Too late" }).catch(() => undefined);
    expect(f.addLocalRunComment).not.toHaveBeenCalled();
    expect(f.patchLocalRunIssue).not.toHaveBeenCalled();
    await f.proxy.close();
  });

  it("aborts an in-flight comment and never starts the queued next write", async () => {
    const f = await fixture();
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    f.addLocalRunComment.mockImplementationOnce(async (...args) => {
      entered();
      const signal = args[4] as AbortSignal;
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const first = f.request(`/api/issues/${issueId}/comments`, "POST", { body: "First" }).catch(() => undefined);
    await firstEntered;
    const second = f.request(`/api/issues/${issueId}/comments`, "POST", { body: "Second" }).catch(() => undefined);
    f.controller.abort();
    await Promise.all([first, second]);
    expect(f.addLocalRunComment).toHaveBeenCalledTimes(1);
    await f.proxy.close();
  });
});
