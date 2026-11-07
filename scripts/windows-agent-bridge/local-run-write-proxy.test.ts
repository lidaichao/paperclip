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
  const createLocalCompletionReviewHandoff = vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => ({ reviewId: "807c65f2-11aa-4e37-a6f8-ae5896363e88" }));
  const completeLocalChildWorkRecord = vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => ({ receiptId: "38a5808c-47f3-4029-bdfe-0d84504bdc8a", statusVersion: 4 }));
  const readLocalWorkPackageContext = vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => ({ issue: { id: issueId }, cycle: { id: "cycle-1" }, members: [] }));
  const prepareLocalPoVerdict = vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => ({ receiptId: "87953994-acd5-4f9d-8fc8-5bf46e1c83f7", disposition: "prepared" }));
  const controller = new AbortController();
  const proxy = await startLocalRunWriteProxy({ claim, deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
    signal: controller.signal, intentStore: new LocalCommentIntentStore(intentFile),
    client: {
      readLocalRunIdentity: () => ({ id: agentId, companyId: "company-1", name: "Luna" }),
      readLocalRunIssue: async () => ({ id: issueId, title: "Task" }),
      addLocalRunComment, patchLocalRunIssue, createLocalCompletionReviewHandoff,
      completeLocalChildWorkRecord, readLocalWorkPackageContext, prepareLocalPoVerdict,
    },
  });
  const request = (route: string, method = "GET", body?: unknown, bearer = proxy.token) =>
    fetch(`${proxy.apiBase}${route}`, { method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { proxy, controller, request, addLocalRunComment, patchLocalRunIssue,
    createLocalCompletionReviewHandoff, completeLocalChildWorkRecord,
    readLocalWorkPackageContext, prepareLocalPoVerdict, intentFile };
}

describe("fenced local run write capability", () => {
  it("exposes only this task's PO context through the loopback lease", async () => {
    const f = await fixture();
    try {
      const response = await f.request(`/api/issues/${issueId}/work-package-context`);
      expect(response.status).toBe(200);
      expect((await response.json()).cycle.id).toBe("cycle-1");
      expect(f.readLocalWorkPackageContext).toHaveBeenCalledWith(claim,
        "8da47d3b-0a6e-49d4-9c26-17bc76de470f");
      expect((await f.request(`/api/issues/${agentId}/work-package-context`)).status).toBe(403);
      expect((await f.request(`/api/issues/${issueId}/work-package-context`,
        "GET", undefined, "wrong-token")).status).toBe(401);
    } finally { await f.proxy.close(); }
  });
  it("prepares one PO verdict and blocks a later conflicting source write", async () => {
    const f = await fixture();
    try {
      const decision = { expectedStatusVersion: 3,
        cycleId: "87953994-acd5-4f9d-8fc8-5bf46e1c83f7",
        itemId: "6dbca282-4e89-4c79-9707-93cff72ba24c",
        expectedCycleRevision: 2, outcome: "return", reason: "QA found an issue",
        evidenceRefs: [], targetRecordIds: ["cb89252d-be31-4dc0-8e84-07169e3ce4bc"] };
      const response = await f.request(`/api/issues/${issueId}/po-verdict`, "POST", decision);
      expect(response.status).toBe(201);
      expect(f.prepareLocalPoVerdict).toHaveBeenCalledTimes(1);
      expect(f.prepareLocalPoVerdict.mock.calls[0]?.[1]).toMatchObject({
        issueId, ...decision, clientRequestId: expect.any(String),
      });
      expect((await f.request(`/api/issues/${issueId}`, "PATCH", { title: "Late" })).status)
        .toBe(409);
      expect((await f.request(`/api/issues/${issueId}/child-complete`, "POST", {
        summary: "Different disposition", expectedStatusVersion: 3 })).status).toBe(409);
    } finally { await f.proxy.close(); }
  });
  it("completes a child once and rejects a second source mutation", async () => {
    const f = await fixture();
    try {
      const response = await f.request(`/api/issues/${issueId}/child-complete`, "POST", {
        expectedStatusVersion: 3, summary: "Child delivery verified",
      });
      expect(response.status).toBe(201);
      expect(f.completeLocalChildWorkRecord).toHaveBeenCalledTimes(1);
      expect(f.completeLocalChildWorkRecord.mock.calls[0]?.[1]).toMatchObject({
        issueId, expectedStatusVersion: 3, summary: "Child delivery verified",
        clientRequestId: expect.any(String),
      });
      expect((await f.request(`/api/issues/${issueId}/comments`, "POST",
        { body: "Late edit" })).status).toBe(409);
      expect((await f.request(`/api/issues/${issueId}/completion-review-handoff`, "POST", {
        reviewerAgentId: agentId, prompt: "Review", body: "Late",
      })).status).toBe(409);
    } finally { await f.proxy.close(); }
  });
  it("hands source work to one named reviewer and blocks later source edits", async () => {
    const f = await fixture();
    const reviewerAgentId = "420ed639-455c-4617-9a36-18b46dfbb141";
    try {
      const response = await f.request(`/api/issues/${issueId}/completion-review-handoff`, "POST", {
        reviewerAgentId, prompt: "Verify acceptance criteria", body: "Work is ready",
      });
      expect(response.status).toBe(201);
      expect(f.createLocalCompletionReviewHandoff).toHaveBeenCalledTimes(1);
      expect(f.createLocalCompletionReviewHandoff.mock.calls[0]?.[1]).toMatchObject({
        issueId, reviewerAgentId, prompt: "Verify acceptance criteria",
        body: "Work is ready", clientRequestId: expect.any(String),
      });
      expect((await f.request(`/api/issues/${issueId}/comments`, "POST",
        { body: "Late comment" })).status).toBe(409);
      expect((await f.request(`/api/issues/${issueId}`, "PATCH",
        { title: "Late edit" })).status).toBe(409);
      expect((await f.request(`/api/issues/${issueId}/completion-review-handoff`, "POST", {
        reviewerAgentId, prompt: "Another", body: "Later",
      })).status).toBe(409);
    } finally { await f.proxy.close(); }
  });
  it("gives a reviewer only the redacted review and one fenced decision", async () => {
    const intentFile = path.join(await mkdtemp(path.join(os.tmpdir(), "alice-review-proxy-")), "intent.json");
    const sourceId = "420ed639-455c-4617-9a36-18b46dfbb141";
    const reviewId = "807c65f2-11aa-4e37-a6f8-ae5896363e88";
    const reviewClaim = { ...claim, wakeReason: "issue_completion_review" };
    const accept = vi.fn(async () => ({ issueId, reviewId, outcome: "accepted" as const }));
    const reject = vi.fn(async () => ({ issueId, reviewId, outcome: "rejected" as const }));
    const readOrdinary = vi.fn(async () => { throw new Error("ordinary issue read forbidden"); });
    const proxy = await startLocalRunWriteProxy({ claim: reviewClaim,
      deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
      signal: new AbortController().signal,
      intentStore: new LocalCommentIntentStore(intentFile),
      reviewContext: {
        issue: { id: issueId, companyId: "company-1", projectId: null,
          identifier: "PAP-1", title: "Review task", description: "Acceptance criteria",
          status: "in_review", priority: "medium", assigneeAgentId: sourceId,
          activeRunId: runId, updatedAt: "2026-11-07T00:00:00Z", statusVersion: 3 },
        review: { id: reviewId, interactionId: "87953994-acd5-4f9d-8fc8-5bf46e1c83f7",
          sourceRunId: "6dbca282-4e89-4c79-9707-93cff72ba24c",
          sourceAgentId: sourceId, reviewerAgentId: agentId,
          issueStatusVersion: 3, prompt: "Verify feature", handoffSummary: "Ready" },
      },
      client: { readLocalRunIdentity: () => ({ id: agentId, companyId: "company-1", name: "Luna" }),
        readLocalRunIssue: readOrdinary, addLocalRunComment: vi.fn(),
        patchLocalRunIssue: vi.fn(), acceptLocalCompletionReview: accept,
        rejectLocalCompletionReview: reject },
    });
    const request = (route: string, method = "GET", body?: unknown) =>
      fetch(`${proxy.apiBase}${route}`, { method,
        headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      const detail = await request(`/api/issues/${issueId}`);
      expect((await detail.json()).completionReview).toMatchObject({ id: reviewId,
        prompt: "Verify feature" });
      expect(readOrdinary).not.toHaveBeenCalled();
      expect((await request(`/api/issues/${issueId}/comments`, "POST", { body: "Not allowed" })).status)
        .toBe(403);
      expect((await request(`/api/issues/${issueId}`, "PATCH", { title: "Not allowed" })).status)
        .toBe(403);
      const decided = await request(`/api/issues/${issueId}/review-decision`, "POST",
        { outcome: "rejected", summary: "Missing acceptance criterion" });
      expect(decided.status).toBe(200);
      expect(reject).toHaveBeenCalledTimes(1);
      expect(accept).not.toHaveBeenCalled();
      expect(reject.mock.calls[0]?.[1]).toMatchObject({ issueId, reviewId,
        summary: "Missing acceptance criterion", clientRequestId: expect.any(String) });
      expect((await request(`/api/issues/${issueId}/review-decision`, "POST",
        { outcome: "accepted", summary: "Changed mind" })).status).toBe(409);
    } finally { await proxy.close(); }
  });

  it("reports that a reviewer exited without a durable decision", async () => {
    const intentFile = path.join(await mkdtemp(path.join(os.tmpdir(), "alice-review-proxy-")), "intent.json");
    const reviewClaim = { ...claim, wakeReason: "issue_completion_review" };
    const proxy = await startLocalRunWriteProxy({ claim: reviewClaim,
      deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
      signal: new AbortController().signal,
      intentStore: new LocalCommentIntentStore(intentFile),
      reviewContext: { issue: { id: issueId, companyId: "company-1", projectId: null,
        identifier: "PAP-1", title: "Review task", description: null,
        status: "in_review", priority: "medium", assigneeAgentId: "420ed639-455c-4617-9a36-18b46dfbb141",
        activeRunId: runId, updatedAt: "2026-11-07T00:00:00Z", statusVersion: 3 },
        review: { id: "807c65f2-11aa-4e37-a6f8-ae5896363e88",
          interactionId: "87953994-acd5-4f9d-8fc8-5bf46e1c83f7",
          sourceRunId: "6dbca282-4e89-4c79-9707-93cff72ba24c",
          sourceAgentId: "420ed639-455c-4617-9a36-18b46dfbb141",
          reviewerAgentId: agentId, issueStatusVersion: 3,
          prompt: "Verify", handoffSummary: "Ready" } },
      client: { readLocalRunIdentity: () => ({ id: agentId, companyId: "company-1", name: "Luna" }),
        readLocalRunIssue: vi.fn(), addLocalRunComment: vi.fn(), patchLocalRunIssue: vi.fn(),
        acceptLocalCompletionReview: vi.fn(), rejectLocalCompletionReview: vi.fn() },
    });
    expect(proxy.decisionConfirmed()).toBe(false);
    await expect(proxy.close()).resolves.toBeUndefined();
  });
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

  it("waits for an in-flight field edit before closing a successful run", async () => {
    const f = await fixture();
    let entered!: () => void;
    let finishWrite!: (value: unknown) => void;
    const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
    f.patchLocalRunIssue.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { finishWrite = resolve; });
    });
    const response = f.request(`/api/issues/${issueId}`, "PATCH", { priority: "high" }).catch(() => null);
    await enteredWrite;
    let settled = false;
    const close = f.proxy.close().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishWrite({ id: issueId, priority: "high" });
    await close;
    expect(f.patchLocalRunIssue).toHaveBeenCalledTimes(1);
    await response;
  });

  it("refuses a successful finish after a field edit failed", async () => {
    const f = await fixture();
    f.patchLocalRunIssue.mockRejectedValueOnce(new Error("server rejected edit"));
    expect((await f.request(`/api/issues/${issueId}`, "PATCH", { priority: "high" })).status).toBe(409);
    expect(f.proxy.writeFailed()).toBe(true);
    await expect(f.proxy.close()).resolves.toBeUndefined();
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
