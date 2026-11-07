import { describe, expect, it } from "vitest";
import { AliceClient } from "./paperclip-client.js";

const AGENT_ID = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const COMPANY_ID = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";
const RUN_ID = "f2c991f1-b53d-4bb5-b134-8e29d43815d0";
const ISSUE_ID = "1b9c2019-b811-40a0-bd21-0365977a0001";
const LEASE_ID = "784d88a1-7a05-42d2-a7d8-e714d70f2d0b";
const DEVICE_ID = "8da47d3b-0a6e-49d4-9c26-17bc76de470f";
const KEY_ID = "fd7a78df-9781-4070-9974-7f7a7e051330";
const INTERACTION_ID = "52c1a882-34da-4cd9-a408-38d03c02f457";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AliceClient", () => {
  it("reads PO package evidence only with the exact claimed lease", async () => {
    const calls: string[] = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "server-only-key",
      fetch: async (url) => {
        calls.push(String(url));
        return String(url).endsWith("/api/agents/me")
          ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
          : jsonResponse({ issue: { id: ISSUE_ID, status: "in_progress", statusVersion: 2 },
            package: { id: KEY_ID }, cycle: { id: LEASE_ID, poItemId: KEY_ID },
            members: [], verdicts: [] });
      } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const claim = { runId: RUN_ID, issueId: ISSUE_ID, agentId: AGENT_ID,
      leaseId: LEASE_ID, generation: 1, leaseExpiresAt: "2026-11-07T05:00:00Z",
      leaseDeadlineMonotonicMs: performance.now() + 60_000,
      wakeReason: "assignment", workspacePolicy: "agent_home" as const };
    const context = await client.readLocalWorkPackageContext(claim, DEVICE_ID) as {
      package: { id: string } };
    expect(context.package.id).toBe(KEY_ID);
    expect(calls[1]).toContain(`/api/agents/me/local-runs/${RUN_ID}/work-package-context?`);
    expect(calls[1]).toContain(`leaseId=${LEASE_ID}`);
    await expect(client.readLocalWorkPackageContext({ ...claim, agentId: KEY_ID }, DEVICE_ID))
      .rejects.toThrow("identity mismatch");
  });
  it("prepares a PO decision through the run lease endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "server-only-key",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return String(url).endsWith("/api/agents/me")
          ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
          : jsonResponse({ receiptId: KEY_ID, disposition: "prepared" }, 201);
      } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const lease = { runId: RUN_ID, deviceId: DEVICE_ID,
      leaseId: LEASE_ID, generation: 1 };
    const input = { issueId: ISSUE_ID, expectedStatusVersion: 3,
      clientRequestId: KEY_ID, cycleId: LEASE_ID, itemId: KEY_ID,
      expectedCycleRevision: 2, outcome: "approve" as const,
      reason: "Accepted", evidenceRefs: [], targetRecordIds: [] };
    expect((await client.prepareLocalPoVerdict(lease, input)).disposition).toBe("prepared");
    expect(new URL(calls[1]!.url).pathname)
      .toBe(`/api/agents/me/local-runs/${RUN_ID}/issue/po-verdict`);
    expect(JSON.parse(String(calls[1]!.init?.body))).toMatchObject({ ...lease, ...input });
  });
  it("sends local writes only to the lease-fenced endpoints with the stable comment request ID", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "server-only-key", fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/api/agents/me")
        ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
        : jsonResponse({ id: ISSUE_ID }, 201);
    } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const lease = { runId: RUN_ID, deviceId: DEVICE_ID, leaseId: LEASE_ID, generation: 1 };
    await client.addLocalRunComment(lease, ISSUE_ID, "Progress", KEY_ID);
    await client.patchLocalRunIssue(lease, ISSUE_ID, { priority: "high" });
    expect(calls.slice(1).map((call) => [new URL(call.url).pathname, call.init?.method])).toEqual([
      [`/api/agents/me/local-runs/${RUN_ID}/comments`, "POST"],
      [`/api/agents/me/local-runs/${RUN_ID}/issue`, "PATCH"],
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ ...lease, issueId: ISSUE_ID, clientRequestId: KEY_ID });
    await expect(client.patchLocalRunIssue(lease, ISSUE_ID, { status: "done" })).rejects.toThrow("unsupported");
    expect(calls).toHaveLength(3);
  });
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

  it("uses the fenced same-run endpoints for a human review confirmation and handoff", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "server-only-key", fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/api/agents/me")
        ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
        : jsonResponse({ interaction: { id: INTERACTION_ID }, replayed: false }, 201);
    } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const lease = { runId: RUN_ID, deviceId: DEVICE_ID, leaseId: LEASE_ID, generation: 1 };
    await client.createLocalReviewConfirmation(lease, ISSUE_ID, "Please verify", KEY_ID);
    await client.handoffLocalReview(lease, ISSUE_ID, "Ready for acceptance", INTERACTION_ID, KEY_ID);
    expect(calls.slice(1).map((call) => [new URL(call.url).pathname, call.init?.method])).toEqual([
      [`/api/agents/me/local-runs/${RUN_ID}/issue/review-confirmation`, "POST"],
      [`/api/agents/me/local-runs/${RUN_ID}/issue/review-handoff`, "POST"],
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ ...lease, issueId: ISSUE_ID,
      prompt: "Please verify", clientRequestId: KEY_ID });
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ ...lease, issueId: ISSUE_ID,
      body: "Ready for acceptance", reviewInteractionId: INTERACTION_ID, clientRequestId: KEY_ID });
    await expect(client.createLocalReviewConfirmation(lease, ISSUE_ID, " ", KEY_ID)).rejects.toThrow("prompt");
    await expect(client.handoffLocalReview(lease, ISSUE_ID, "@someone", INTERACTION_ID, KEY_ID))
      .rejects.toThrow("plain text");
    expect(calls).toHaveLength(3);
  });

  it("rejects an identity mismatch before polling", async () => {
    const client = new AliceClient({
      apiBase: "http://alice.test",
      token: "pc_agent_secret_1234567890",
      fetch: async () => jsonResponse({ id: "different-agent", companyId: COMPANY_ID, name: "Other" }),
    });
    await expect(client.verifyIdentity(AGENT_ID, COMPANY_ID)).rejects.toThrow("identity mismatch");
  });

  it("rejects a configured member name that belongs to a different Paperclip agent", async () => {
    const client = new AliceClient({ apiBase: "http://alice.test", token: "server-only-key",
      fetch: async () => jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Rabbit" }) });
    await expect(client.verifyIdentity(AGENT_ID, COMPANY_ID, "Luna")).rejects.toThrow("identity mismatch");
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
          leaseExpiresAt: "2026-11-06T04:00:00Z", leaseTtlMs: 60_000, wakeReason: "assignment", workspacePolicy: "agent_home" });
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
            leaseExpiresAt: "2026-11-06T04:00:00Z", leaseTtlMs: 60_000, wakeReason: "assignment", workspacePolicy: "agent_home" }),
    });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    expect(await client.claimLocalRun(DEVICE_ID, KEY_ID)).toBeNull();
    claimStatus = 200;
    await expect(client.claimLocalRun(DEVICE_ID, KEY_ID)).rejects.toThrow("identity mismatch");
  });

  it("rejects a claim without the server-calculated remaining lease time", async () => {
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret", fetch: async (url) =>
      String(url).endsWith("/api/agents/me")
        ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
        : jsonResponse({ runId: RUN_ID, issueId: ISSUE_ID, agentId: AGENT_ID, leaseId: LEASE_ID,
          generation: 1, leaseExpiresAt: "2026-11-06T04:00:00Z", wakeReason: "assignment", workspacePolicy: "agent_home" }),
    });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    await expect(client.claimLocalRun(DEVICE_ID, KEY_ID)).rejects.toThrow("leaseTtlMs is invalid");
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
      generation: 1, leaseExpiresAt: "2026-11-06T04:00:00Z", leaseDeadlineMonotonicMs: performance.now() + 60_000,
      wakeReason: "assignment", workspacePolicy: "agent_home" as const };
    expect((await client.getClaimedIssue(claim)).activeRunId).toBe(RUN_ID);
    assignee = DEVICE_ID;
    await expect(client.getClaimedIssue(claim)).rejects.toThrow("ownership mismatch");
    assignee = AGENT_ID;
    executionRunId = DEVICE_ID;
    await expect(client.getClaimedIssue(claim)).rejects.toThrow("ownership mismatch");
  });

  it("reads a dedicated non-assignee review only through its fenced context endpoint", async () => {
    const calls: string[] = [];
    let revision = 3;
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret",
      fetch: async (url) => {
        calls.push(String(url));
        return String(url).endsWith("/api/agents/me")
          ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
          : jsonResponse({
            issue: { id: ISSUE_ID, companyId: COMPANY_ID, projectId: null,
              identifier: "PAP-20", title: "Review this", description: "Acceptance criteria",
              status: "in_review", statusVersion: 3, assigneeAgentId: DEVICE_ID,
              priority: "medium", updatedAt: "2026-11-07T04:00:00Z" },
            review: { id: KEY_ID, interactionId: INTERACTION_ID,
              sourceRunId: LEASE_ID, sourceAgentId: DEVICE_ID,
              reviewerAgentId: AGENT_ID, issueStatusVersion: revision,
              prompt: "Verify", handoffSummary: "Delivered" },
          });
      } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const claim = { runId: RUN_ID, issueId: ISSUE_ID, agentId: AGENT_ID,
      leaseId: LEASE_ID, generation: 1, leaseExpiresAt: "2026-11-07T05:00:00Z",
      leaseDeadlineMonotonicMs: performance.now() + 60_000,
      wakeReason: "issue_completion_review", workspacePolicy: "agent_home" as const };
    const context = await client.readLocalReviewContext(claim, DEVICE_ID);
    expect(context.issue.assigneeAgentId).toBe(DEVICE_ID);
    expect(context.review.prompt).toBe("Verify");
    expect(calls[1]).toContain(`/api/agents/me/local-runs/${RUN_ID}/review-context?`);
    expect(calls[1]).toContain(`leaseId=${LEASE_ID}`);
    expect(calls.join("\n")).not.toContain(`/api/issues/${ISSUE_ID}`);
    revision = 4;
    await expect(client.readLocalReviewContext(claim, DEVICE_ID))
      .rejects.toThrow("revision mismatch");
    await expect(client.readLocalReviewContext({ ...claim,
      wakeReason: "assignment" }, DEVICE_ID)).rejects.toThrow("wake reason mismatch");
  });

  it("writes dedicated handoff and both review decisions with the exact lease and request ID", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/api/agents/me")) {
          return jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" });
        }
        if (String(url).endsWith("/completion-review-handoff")) {
          return jsonResponse({ issueId: ISSUE_ID, status: "in_review",
            reviewId: KEY_ID, interactionId: INTERACTION_ID,
            deliveryId: DEVICE_ID }, 201);
        }
        return jsonResponse({ issueId: ISSUE_ID, reviewId: KEY_ID,
          requestId: INTERACTION_ID,
          outcome: String(url).endsWith("/review-reject") ? "rejected" : "accepted" });
      } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const lease = { runId: RUN_ID, deviceId: DEVICE_ID, leaseId: LEASE_ID, generation: 1 };
    expect(await client.createLocalCompletionReviewHandoff(lease, {
      issueId: ISSUE_ID, reviewerAgentId: DEVICE_ID, prompt: "Verify",
      body: "Ready", clientRequestId: KEY_ID,
    })).toMatchObject({ reviewId: KEY_ID, interactionId: INTERACTION_ID });
    expect(await client.acceptLocalCompletionReview(lease, {
      issueId: ISSUE_ID, reviewId: KEY_ID, summary: "Passed",
      clientRequestId: INTERACTION_ID,
    })).toMatchObject({ outcome: "accepted", requestId: INTERACTION_ID });
    expect(await client.rejectLocalCompletionReview(lease, {
      issueId: ISSUE_ID, reviewId: KEY_ID, summary: "Missing behavior",
      clientRequestId: INTERACTION_ID,
    })).toMatchObject({ outcome: "rejected", requestId: INTERACTION_ID });
    expect(calls.slice(1).map((call) => [new URL(call.url).pathname, call.init?.method]))
      .toEqual([
        [`/api/agents/me/local-runs/${RUN_ID}/issue/completion-review-handoff`, "POST"],
        [`/api/agents/me/local-runs/${RUN_ID}/review-accept`, "POST"],
        [`/api/agents/me/local-runs/${RUN_ID}/review-reject`, "POST"],
      ]);
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ ...lease,
      issueId: ISSUE_ID, reviewerAgentId: DEVICE_ID, clientRequestId: KEY_ID });
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ ...lease,
      issueId: ISSUE_ID, reviewId: KEY_ID, clientRequestId: INTERACTION_ID });
    await expect(client.acceptLocalCompletionReview(lease, {
      issueId: ISSUE_ID, reviewId: KEY_ID, summary: " ",
      clientRequestId: INTERACTION_ID,
    })).rejects.toThrow("summary");
    expect(JSON.parse(String(calls[3].init?.body))).toMatchObject({ ...lease,
      issueId: ISSUE_ID, reviewId: KEY_ID, clientRequestId: INTERACTION_ID });
    expect(calls).toHaveLength(4);
  });

  it("validates the child completion receipt and keeps the lease on the request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return String(url).endsWith("/api/agents/me")
          ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
          : jsonResponse({ issueId: ISSUE_ID, status: "in_progress",
              disposition: "prepared", statusVersion: 3, receiptId: KEY_ID }, 201);
      } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const lease = { runId: RUN_ID, deviceId: DEVICE_ID, leaseId: LEASE_ID, generation: 1 };
    expect(await client.completeLocalChildWorkRecord(lease, { issueId: ISSUE_ID,
      expectedStatusVersion: 3, summary: "Delivered", clientRequestId: KEY_ID }))
      .toEqual({ receiptId: KEY_ID, statusVersion: 3 });
    expect(new URL(calls[1].url).pathname)
      .toBe(`/api/agents/me/local-runs/${RUN_ID}/issue/child-complete`);
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ ...lease,
      issueId: ISSUE_ID, expectedStatusVersion: 3, clientRequestId: KEY_ID });
  });

  it("prepares independent defect repair handoff on the same fenced run", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return String(url).endsWith("/api/agents/me")
          ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
          : jsonResponse({ issueId: ISSUE_ID, status: "in_progress",
              disposition: "prepared", statusVersion: 3, receiptId: KEY_ID }, 201);
      } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const lease = { runId: RUN_ID, deviceId: DEVICE_ID, leaseId: LEASE_ID, generation: 1 };
    expect(await client.prepareLocalDefectRepairHandoff(lease, { issueId: ISSUE_ID,
      expectedStatusVersion: 3, summary: "Ready for QA", clientRequestId: KEY_ID }))
      .toEqual({ receiptId: KEY_ID, statusVersion: 3 });
    expect(new URL(calls[1].url).pathname)
      .toBe(`/api/agents/me/local-runs/${RUN_ID}/issue/defect-repair-handoff`);
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ ...lease,
      issueId: ISSUE_ID, expectedStatusVersion: 3, clientRequestId: KEY_ID });
  });

  it("reads the exact QA context and prepares a fenced QA verdict", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const cycleId = "e30c8ff4-9301-4e30-8e8b-8096ca4ea8ce";
    const itemId = "bd1b48c3-8e60-4882-91b2-82b8f68c3cc8";
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/api/agents/me")) {
          return jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" });
        }
        if (String(url).includes("/defect-qa-context?")) {
          return jsonResponse({ issueId: ISSUE_ID, cycleId, itemId,
            defectRecordId: ISSUE_ID, repairRecordId: ISSUE_ID, handoffId: KEY_ID,
            expectedStatusVersion: 3, expectedCycleRevision: 2,
            expectedItemRevision: 1 });
        }
        return jsonResponse({ issueId: ISSUE_ID, status: "in_review",
          statusVersion: 3, disposition: "prepared", receiptId: KEY_ID }, 201);
      } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const claim = { runId: RUN_ID, issueId: ISSUE_ID, agentId: AGENT_ID,
      leaseId: LEASE_ID, generation: 1, leaseExpiresAt: "2026-11-07T12:00:00Z",
      leaseDeadlineMonotonicMs: 60_000, wakeReason: "independent_defect_qa",
      workspacePolicy: "agent_home" as const };
    expect(await client.readLocalDefectQaContext(claim, DEVICE_ID)).toMatchObject({
      issueId: ISSUE_ID, cycleId, itemId });
    expect(new URL(calls[1].url).searchParams.get("leaseId")).toBe(LEASE_ID);
    const lease = { runId: RUN_ID, deviceId: DEVICE_ID, leaseId: LEASE_ID, generation: 1 };
    expect(await client.prepareLocalDefectQaVerdict(lease, { issueId: ISSUE_ID,
      expectedStatusVersion: 3, cycleId, itemId, expectedCycleRevision: 2,
      expectedItemRevision: 1, outcome: "return", summary: "Regression still reproduces",
      evidenceRefs: [], clientRequestId: KEY_ID })).toEqual({
      receiptId: KEY_ID, disposition: "prepared" });
    expect(new URL(calls[2].url).pathname)
      .toBe(`/api/agents/me/local-runs/${RUN_ID}/issue/defect-qa-verdict`);
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ ...lease,
      issueId: ISSUE_ID, cycleId, itemId, clientRequestId: KEY_ID });
  });

  it("reads only the exact scoped local write receipt", async () => {
    const calls: string[] = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret",
      fetch: async (url) => {
        calls.push(String(url));
        return String(url).endsWith("/api/agents/me")
          ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
          : jsonResponse({ state: "committed", kind: "comment", receiptId: KEY_ID });
      } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const digest = "a".repeat(64);
    expect(await client.readLocalWriteReceipt({ runId: RUN_ID,
      issueId: ISSUE_ID, agentId: AGENT_ID, deviceId: DEVICE_ID,
      leaseId: LEASE_ID, generation: 1, kind: "comment",
      clientRequestId: KEY_ID, requestDigest: digest })).toBe("committed");
    const query = new URL(calls[1]);
    expect(query.pathname).toBe(`/api/agents/me/local-runs/${RUN_ID}/write-receipt`);
    expect(query.searchParams.get("requestDigest")).toBe(digest);
    expect(query.searchParams.get("leaseId")).toBe(LEASE_ID);
  });

  it("queries an original finish receipt using the durable request identity", async () => {
    const calls: string[] = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "secret",
      fetch: async (url) => {
        calls.push(String(url));
        return String(url).endsWith("/api/agents/me")
          ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
          : jsonResponse({ state: "committed", runStatus: "succeeded", leaseReleased: true,
            outcome: "succeeded", receiptId: KEY_ID });
      } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const claim = { runId: RUN_ID, issueId: ISSUE_ID, agentId: AGENT_ID,
      leaseId: LEASE_ID, generation: 1, leaseExpiresAt: "2026-11-07T12:00:00Z",
      leaseDeadlineMonotonicMs: 60_000, wakeReason: "assignment",
      workspacePolicy: "agent_home" as const };
    expect(await client.readLocalFinishReceipt(claim, DEVICE_ID, {
      clientRequestId: KEY_ID, outcome: "succeeded", exitCode: 0,
      summary: "completed" })).toBe("committed");
    const query = new URL(calls[1]!);
    expect(query.pathname).toBe(`/api/agents/me/local-runs/${RUN_ID}/finish-receipt`);
    expect(query.searchParams.get("clientRequestId")).toBe(KEY_ID);
    expect(query.searchParams.get("issueId")).toBe(ISSUE_ID);
    expect(query.searchParams.get("leaseId")).toBe(LEASE_ID);
    expect(query.searchParams.get("requestDigest")).toMatch(/^[a-f0-9]{64}$/);
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
        if (String(url).includes("/renew")) return jsonResponse({ leaseExpiresAt: "2026-11-06T04:01:00Z", leaseTtlMs: 60_000, cancelRequested: false });
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

  it("uses fenced event and idempotent finish contracts", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AliceClient({ apiBase: "http://alice.test", token: "server-only-key", fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/api/agents/me")
        ? jsonResponse({ id: AGENT_ID, companyId: COMPANY_ID, name: "Luna" })
        : jsonResponse({ runId: RUN_ID, status: "succeeded" });
    } });
    await client.verifyIdentity(AGENT_ID, COMPANY_ID);
    const lease = { runId: RUN_ID, deviceId: DEVICE_ID, leaseId: LEASE_ID, generation: 1 };
    await client.postLocalRunEvent(lease, ISSUE_ID, { clientRequestId: KEY_ID, stream: "system", level: "info", message: "started" });
    await client.finishLocalRun(lease, "succeeded", 0, { clientRequestId: KEY_ID, summary: "done" });
    expect(calls.slice(1).map((call) => [new URL(call.url).pathname, call.init?.method])).toEqual([
      [`/api/agents/me/local-runs/${RUN_ID}/events`, "POST"],
      [`/api/agents/me/local-runs/${RUN_ID}/finish`, "POST"],
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ issueId: ISSUE_ID, leaseId: LEASE_ID,
      clientRequestId: KEY_ID, message: "started" });
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({ leaseId: LEASE_ID,
      clientRequestId: KEY_ID, summary: "done" });
  });
});

