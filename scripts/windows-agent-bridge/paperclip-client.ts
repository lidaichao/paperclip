import type {
  BridgeInboxItem,
  BridgeIssuePriority,
  BridgeIssueStatus,
} from "./types.js";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import type { LocalFinishIntent } from "./claim-state.js";

const ISSUE_STATUSES = new Set<BridgeIssueStatus>([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
]);
const ISSUE_PRIORITIES = new Set<BridgeIssuePriority>(["critical", "high", "medium", "low"]);

export interface AliceClientLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface AliceClientOptions {
  apiBase: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  logger?: AliceClientLogger;
  timeoutMs?: number;
}

interface RemoteAgentIdentity {
  id: string;
  companyId: string;
  name: string;
}

export interface LocalRunClaim {
  runId: string;
  issueId: string;
  agentId: string;
  leaseId: string;
  generation: number;
  leaseExpiresAt: string;
  leaseDeadlineMonotonicMs: number;
  wakeReason: string;
  workspacePolicy: "agent_home";
}

export interface LocalRunLease {
  deviceId: string;
  runId: string;
  leaseId: string;
  generation: number;
}

function leaseOwnerBody(lease: LocalRunLease) {
  return { deviceId: lease.deviceId, leaseId: lease.leaseId, generation: lease.generation };
}

export interface LocalReviewContext {
  issue: BridgeInboxItem & { description: string | null; statusVersion: number };
  review: { id: string; interactionId: string; sourceRunId: string;
    sourceAgentId: string; reviewerAgentId: string; issueStatusVersion: number;
    prompt: string; handoffSummary: string };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

function leaseTtlMs(record: Record<string, unknown>, label: string): number {
  const value = record.leaseTtlMs;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 300_000) {
    throw new Error(`${label}.leaseTtlMs is invalid`);
  }
  return Number(value);
}

function parseClaim(value: unknown, expectedAgentId: string, requestStartedAt: number): LocalRunClaim {
  const record = asRecord(value, "local run claim");
  const agentId = requireUuid(record.agentId, "local run claim.agentId");
  if (agentId !== expectedAgentId) throw new Error("local run claim agent identity mismatch");
  if (!Number.isInteger(record.generation) || Number(record.generation) < 1) throw new Error("local run claim.generation is invalid");
  if (record.workspacePolicy !== "agent_home") throw new Error("local run claim.workspacePolicy is invalid");
  const leaseExpiresAt = requiredString(record, "leaseExpiresAt", "local run claim");
  if (Number.isNaN(Date.parse(leaseExpiresAt))) throw new Error("local run claim.leaseExpiresAt is invalid");
  return {
    runId: requireUuid(record.runId, "local run claim.runId"),
    issueId: requireUuid(record.issueId, "local run claim.issueId"),
    agentId,
    leaseId: requireUuid(record.leaseId, "local run claim.leaseId"),
    generation: Number(record.generation),
    leaseExpiresAt,
    leaseDeadlineMonotonicMs: requestStartedAt + leaseTtlMs(record, "local run claim"),
    wakeReason: requiredString(record, "wakeReason", "local run claim"),
    workspacePolicy: "agent_home",
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}.${key} is missing`);
  }
  return value.trim();
}

function parseIdentity(value: unknown): RemoteAgentIdentity {
  const record = asRecord(value, "agent identity");
  return {
    id: requiredString(record, "id", "agent identity"),
    companyId: requiredString(record, "companyId", "agent identity"),
    name: requiredString(record, "name", "agent identity"),
  };
}

function parseInboxItem(value: unknown, index: number, identity: RemoteAgentIdentity): BridgeInboxItem {
  const label = `agent inbox[${index}]`;
  const record = asRecord(value, label);
  const status = requiredString(record, "status", label) as BridgeIssueStatus;
  const priority = requiredString(record, "priority", label) as BridgeIssuePriority;
  if (!ISSUE_STATUSES.has(status)) throw new Error(`${label}.status is unsupported`);
  if (!ISSUE_PRIORITIES.has(priority)) throw new Error(`${label}.priority is unsupported`);
  const identifier = typeof record.identifier === "string" && record.identifier.trim()
    ? record.identifier.trim()
    : requiredString(record, "id", label);
  const activeRun = record.activeRun && typeof record.activeRun === "object" && !Array.isArray(record.activeRun)
    ? record.activeRun as Record<string, unknown>
    : null;
  // inbox-lite is scoped by the authenticated agent; its rows do not repeat
  // companyId or assigneeAgentId. Reject unexpected conflicting values rather
  // than trusting them or requiring fields the server does not send.
  if (record.companyId != null && record.companyId !== identity.companyId) {
    throw new Error(`${label}.companyId conflicts with the verified identity`);
  }
  if (record.assigneeAgentId != null && record.assigneeAgentId !== identity.id) {
    throw new Error(`${label}.assigneeAgentId conflicts with the verified identity`);
  }

  return {
    id: requiredString(record, "id", label),
    companyId: identity.companyId,
    projectId: typeof record.projectId === "string" && record.projectId.trim() ? record.projectId.trim() : null,
    identifier,
    title: requiredString(record, "title", label),
    status,
    priority,
    assigneeAgentId: identity.id,
    updatedAt: requiredString(record, "updatedAt", label),
    activeRunId: activeRun && typeof activeRun.id === "string" ? activeRun.id : null,
  };
}

export class AliceClient {
  readonly #apiBase: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #logger: AliceClientLogger;
  readonly #timeoutMs: number;
  #verifiedIdentity: RemoteAgentIdentity | null = null;

  constructor(options: AliceClientOptions) {
    this.#apiBase = options.apiBase.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? { info: () => undefined, warn: () => undefined };
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  get apiBase(): string {
    return this.#apiBase;
  }

  async #getJson(pathname: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.#fetch(`${this.#apiBase}${pathname}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.#logger.warn(`Alice API ${pathname.split("?", 1)[0]} returned HTTP ${response.status}`);
        throw new Error(`Alice API request failed with HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Alice API request timed out after ${this.#timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #writeJson(method: "POST" | "PATCH", pathname: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref?.();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await this.#fetch(`${this.#apiBase}${pathname}`, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.#token}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.#logger.warn(`Alice API ${pathname} returned HTTP ${response.status}`);
        if (response.status === 409 && pathname.endsWith("/finish")) {
          const body = await response.json().catch(() => null);
          if (body && typeof body === "object" && "error" in body &&
            body.error === "Cancelled or expired run cannot report success") {
            throw new Error("Alice API finish rejected: Cancelled or expired run cannot report success (HTTP 409)");
          }
        }
        throw new Error(`Alice API request failed with HTTP ${response.status}`);
      }
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Alice API request timed out after ${this.#timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async #postJson(pathname: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    return this.#writeJson("POST", pathname, body, extraHeaders);
  }

  #requireVerifiedIdentity(): RemoteAgentIdentity {
    if (!this.#verifiedIdentity) throw new Error("Alice identity must be verified before local run operations");
    return this.#verifiedIdentity;
  }

  async claimLocalRun(deviceId: string, idempotencyKey: string): Promise<LocalRunClaim | null> {
    const identity = this.#requireVerifiedIdentity();
    requireUuid(deviceId, "deviceId");
    requireUuid(idempotencyKey, "idempotencyKey");
    const requestStartedAt = performance.now();
    const response = await this.#postJson("/api/agents/me/local-runs/claim", { deviceId }, { "Idempotency-Key": idempotencyKey });
    return response.status === 204 ? null : parseClaim(response.body, identity.id, requestStartedAt);
  }

  async readLocalWriteReceipt(input: {
    runId: string; issueId: string; agentId: string; deviceId: string;
    leaseId: string; generation: number; kind: string;
    clientRequestId: string; requestDigest: string;
  }): Promise<"committed" | "unknown" | "unsupported"> {
    const identity = this.#requireVerifiedIdentity();
    if (input.agentId !== identity.id) throw new Error("local write receipt agent mismatch");
    requireUuid(input.runId, "runId");
    requireUuid(input.issueId, "issueId");
    requireUuid(input.clientRequestId, "clientRequestId");
    if (!/^[a-f0-9]{64}$/.test(input.requestDigest)) {
      throw new Error("invalid local write receipt digest");
    }
    this.#validateLease(input);
    const query = new URLSearchParams({ deviceId: input.deviceId,
      leaseId: input.leaseId, generation: String(input.generation),
      issueId: input.issueId, kind: input.kind,
      clientRequestId: input.clientRequestId,
      requestDigest: input.requestDigest });
    const record = asRecord(await this.#getJson(
      `/api/agents/me/local-runs/${input.runId}/write-receipt?${query}`),
    "local write receipt");
    if (!["committed", "unknown", "unsupported"].includes(String(record.state)) ||
      (record.state === "committed" &&
        (record.kind !== input.kind || typeof record.receiptId !== "string"))) {
      throw new Error("local write receipt identity or state mismatch");
    }
    return record.state as "committed" | "unknown" | "unsupported";
  }

  async readLocalFinishReceipt(claim: LocalRunClaim, deviceId: string,
    intent: LocalFinishIntent): Promise<"committed" | "not_committed" | "unknown"> {
    const identity = this.#requireVerifiedIdentity();
    if (claim.agentId !== identity.id) throw new Error("local finish receipt agent mismatch");
    requireUuid(claim.runId, "runId");
    requireUuid(claim.issueId, "issueId");
    requireUuid(intent.clientRequestId, "finish clientRequestId");
    const lease = { runId: claim.runId, deviceId, leaseId: claim.leaseId,
      generation: claim.generation };
    this.#validateLease(lease);
    const canonicalContent = JSON.stringify({ outcome: intent.outcome,
      exitCode: intent.exitCode, processStopped: true, summary: intent.summary ?? null });
    const requestDigest = createHash("sha256").update(JSON.stringify({
      kind: "finish", runId: claim.runId, issueId: claim.issueId,
      agentId: claim.agentId, deviceId, canonicalContent,
    })).digest("hex");
    const query = new URLSearchParams({ deviceId, leaseId: claim.leaseId,
      generation: String(claim.generation), issueId: claim.issueId,
      clientRequestId: intent.clientRequestId, requestDigest });
    const record = asRecord(await this.#getJson(
      `/api/agents/me/local-runs/${claim.runId}/finish-receipt?${query}`),
    "local finish receipt");
    if (!["committed", "not_committed", "unknown"].includes(String(record.state)) ||
      typeof record.leaseReleased !== "boolean" ||
      (record.state === "committed" &&
        (record.outcome !== intent.outcome || record.leaseReleased !== true ||
          typeof record.receiptId !== "string" || typeof record.runStatus !== "string"))) {
      throw new Error("local finish receipt identity or state mismatch");
    }
    return record.state as "committed" | "not_committed" | "unknown";
  }

  async getClaimedIssue(claim: LocalRunClaim): Promise<BridgeInboxItem> {
    const identity = this.#requireVerifiedIdentity();
    if (claim.agentId !== identity.id) throw new Error("claimed issue agent identity mismatch");
    const record = asRecord(await this.#getJson(`/api/issues/${claim.issueId}`), "claimed issue");
    if (record.id !== claim.issueId || record.companyId !== identity.companyId ||
      record.assigneeAgentId !== identity.id || record.executionRunId !== claim.runId) {
      throw new Error("claimed issue ownership mismatch");
    }
    const status = requiredString(record, "status", "claimed issue") as BridgeIssueStatus;
    const priority = requiredString(record, "priority", "claimed issue") as BridgeIssuePriority;
    if (!ISSUE_STATUSES.has(status) || !ISSUE_PRIORITIES.has(priority)) throw new Error("claimed issue has unsupported status or priority");
    return {
      id: claim.issueId,
      companyId: identity.companyId,
      projectId: typeof record.projectId === "string" ? record.projectId : null,
      identifier: requiredString(record, "identifier", "claimed issue"),
      title: requiredString(record, "title", "claimed issue"),
      status,
      priority,
      assigneeAgentId: identity.id,
      updatedAt: requiredString(record, "updatedAt", "claimed issue"),
      activeRunId: claim.runId,
    };
  }

  async readLocalRunIssue(claim: LocalRunClaim): Promise<unknown> {
    const identity = this.#requireVerifiedIdentity();
    if (claim.agentId !== identity.id) throw new Error("local run identity mismatch");
    const record = asRecord(await this.#getJson(`/api/issues/${claim.issueId}`), "local run issue");
    if (record.id !== claim.issueId || record.companyId !== identity.companyId ||
      record.assigneeAgentId !== identity.id || record.executionRunId !== claim.runId) {
      throw new Error("local run issue ownership mismatch");
    }
    return record;
  }

  /** PO evidence is scoped by the server to this exact local run and device. */
  async readLocalWorkPackageContext(claim: LocalRunClaim, deviceId: string): Promise<unknown> {
    const identity = this.#requireVerifiedIdentity();
    if (claim.agentId !== identity.id) throw new Error("local PO claim identity mismatch");
    const lease = { runId: claim.runId, leaseId: claim.leaseId,
      generation: claim.generation, deviceId };
    this.#validateLease(lease);
    const query = new URLSearchParams({ deviceId, leaseId: claim.leaseId,
      generation: String(claim.generation) });
    const record = asRecord(await this.#getJson(
      `/api/agents/me/local-runs/${claim.runId}/work-package-context?${query}`),
    "local work package context");
    const issue = asRecord(record.issue, "local PO issue");
    const parent = asRecord(record.package, "local PO package");
    const cycle = asRecord(record.cycle, "local PO cycle");
    if (issue.id !== claim.issueId || issue.status !== "in_progress" ||
      !Number.isSafeInteger(issue.statusVersion) ||
      !Array.isArray(record.members) ||
      !Array.isArray(record.verdicts) ||
      typeof parent.id !== "string" ||
      typeof cycle.id !== "string" ||
      typeof cycle.poItemId !== "string") {
      throw new Error("local work package context identity or shape mismatch");
    }
    return record;
  }

  /** Independent defect QA can inspect only the quality item tied to this lease. */
  async readLocalDefectQaContext(claim: LocalRunClaim, deviceId: string): Promise<unknown> {
    const identity = this.#requireVerifiedIdentity();
    if (claim.agentId !== identity.id || claim.wakeReason !== "independent_defect_qa") {
      throw new Error("local defect QA claim identity mismatch");
    }
    const lease = { runId: claim.runId, leaseId: claim.leaseId,
      generation: claim.generation, deviceId };
    this.#validateLease(lease);
    const query = new URLSearchParams({ deviceId, leaseId: claim.leaseId,
      generation: String(claim.generation) });
    const record = asRecord(await this.#getJson(
      `/api/agents/me/local-runs/${claim.runId}/defect-qa-context?${query}`),
    "local defect QA context");
    if (record.issueId !== claim.issueId ||
      !Number.isSafeInteger(record.expectedStatusVersion) ||
      !Number.isSafeInteger(record.expectedCycleRevision) ||
      !Number.isSafeInteger(record.expectedItemRevision)) {
      throw new Error("local defect QA context identity or revision mismatch");
    }
    for (const key of ["cycleId", "itemId", "defectRecordId", "repairRecordId", "handoffId"] as const) {
      requireUuid(record[key], `local defect QA context.${key}`);
    }
    return record;
  }

  /** Dedicated review is read with the current device lease, never via generic issue ownership. */
  async readLocalReviewContext(claim: LocalRunClaim, deviceId: string): Promise<LocalReviewContext> {
    const identity = this.#requireVerifiedIdentity();
    if (claim.agentId !== identity.id || claim.wakeReason !== "issue_completion_review") {
      throw new Error("local review claim identity or wake reason mismatch");
    }
    const lease = { runId: claim.runId, leaseId: claim.leaseId,
      generation: claim.generation, deviceId };
    this.#validateLease(lease);
    const query = new URLSearchParams({ deviceId, leaseId: claim.leaseId,
      generation: String(claim.generation) });
    const response = asRecord(await this.#getJson(
      `/api/agents/me/local-runs/${claim.runId}/review-context?${query}`), "local review context");
    const issue = asRecord(response.issue, "local review issue");
    const review = asRecord(response.review, "local review decision");
    const status = requiredString(issue, "status", "local review issue") as BridgeIssueStatus;
    const priority = requiredString(issue, "priority", "local review issue") as BridgeIssuePriority;
    const assigneeAgentId = requireUuid(issue.assigneeAgentId, "local review issue.assigneeAgentId");
    if (issue.id !== claim.issueId || issue.companyId !== identity.companyId ||
      assigneeAgentId === identity.id || status !== "in_review" ||
      !ISSUE_PRIORITIES.has(priority) || !Number.isSafeInteger(issue.statusVersion) ||
      Number(issue.statusVersion) < 1 ||
      review.reviewerAgentId !== identity.id ||
      review.sourceAgentId !== issue.assigneeAgentId ||
      review.issueStatusVersion !== issue.statusVersion) {
      throw new Error("local review context identity or revision mismatch");
    }
    const parsedReview = {
      id: requireUuid(review.id, "local review id"),
      interactionId: requireUuid(review.interactionId, "local review interactionId"),
      sourceRunId: requireUuid(review.sourceRunId, "local review sourceRunId"),
      sourceAgentId: requireUuid(review.sourceAgentId, "local review sourceAgentId"),
      reviewerAgentId: identity.id,
      issueStatusVersion: Number(review.issueStatusVersion),
      prompt: requiredString(review, "prompt", "local review"),
      handoffSummary: requiredString(review, "handoffSummary", "local review"),
    };
    return {
      issue: {
        id: claim.issueId, companyId: identity.companyId,
        projectId: typeof issue.projectId === "string" ? issue.projectId : null,
        identifier: requiredString(issue, "identifier", "local review issue"),
        title: requiredString(issue, "title", "local review issue"),
        description: typeof issue.description === "string" ? issue.description : null,
        status, priority, assigneeAgentId,
        updatedAt: requiredString(issue, "updatedAt", "local review issue"),
        activeRunId: null, statusVersion: Number(issue.statusVersion),
      },
      review: parsedReview,
    };
  }

  readLocalRunIdentity(): { id: string; companyId: string; name: string } {
    return { ...this.#requireVerifiedIdentity() };
  }

  async renewLocalRun(lease: LocalRunLease): Promise<
    { leaseExpiresAt: string; cancelRequested: true } |
    { leaseExpiresAt: string; cancelRequested: false; leaseDeadlineMonotonicMs: number }
  > {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    const requestStartedAt = performance.now();
    const response = await this.#postJson(`/api/agents/me/local-runs/${lease.runId}/renew`, {
      deviceId: lease.deviceId, leaseId: lease.leaseId, generation: lease.generation,
    });
    const record = asRecord(response.body, "local run renewal");
    const leaseExpiresAt = requiredString(record, "leaseExpiresAt", "local run renewal");
    if (Number.isNaN(Date.parse(leaseExpiresAt)) || typeof record.cancelRequested !== "boolean") {
      throw new Error("local run renewal response is invalid");
    }
    if (record.cancelRequested) return { leaseExpiresAt, cancelRequested: true };
    return { leaseExpiresAt, cancelRequested: false,
      leaseDeadlineMonotonicMs: requestStartedAt + leaseTtlMs(record, "local run renewal") };
  }

  async controlLocalRun(lease: LocalRunLease): Promise<{ action: "continue" | "cancel"; generation: number; leaseExpiresAt: string }> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    const query = new URLSearchParams({ deviceId: lease.deviceId, leaseId: lease.leaseId, generation: String(lease.generation) });
    const record = asRecord(await this.#getJson(`/api/agents/me/local-runs/${lease.runId}/control?${query}`), "local run control");
    if (record.action !== "continue" && record.action !== "cancel") throw new Error("local run control action is invalid");
    if (record.generation !== lease.generation) throw new Error("local run control generation mismatch");
    const leaseExpiresAt = requiredString(record, "leaseExpiresAt", "local run control");
    if (Number.isNaN(Date.parse(leaseExpiresAt))) throw new Error("local run control expiry is invalid");
    return { action: record.action, generation: lease.generation, leaseExpiresAt };
  }

  async finishLocalRun(lease: LocalRunLease, outcome: "succeeded" | "failed" | "cancelled", exitCode: number | null,
    report?: { clientRequestId: string; summary?: string }): Promise<string> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error("exitCode must be an integer or null");
    if (report) {
      requireUuid(report.clientRequestId, "finish clientRequestId");
      if (report.summary && Buffer.byteLength(report.summary, "utf8") > 4 * 1024) throw new Error("finish summary is too large");
    }
    const payload = {
      deviceId: lease.deviceId, leaseId: lease.leaseId, generation: lease.generation,
      outcome, exitCode, processStopped: true, ...report,
    };
    const pathname = `/api/agents/me/local-runs/${lease.runId}/finish`;
    let response: { status: number; body: unknown };
    try { response = await this.#postJson(pathname, payload); }
    catch (error) {
      if (!report || (error instanceof Error && error.message.includes("HTTP "))) throw error;
      // A lost response may hide a committed finish. Replay the same UUID and
      // identical payload exactly once; the server resolves it idempotently.
      response = await this.#postJson(pathname, payload);
    }
    const record = asRecord(response.body, "local run finish");
    if (record.runId !== lease.runId) throw new Error("local run finish identity mismatch");
    return requiredString(record, "status", "local run finish");
  }

  async postLocalRunEvent(lease: LocalRunLease, issueId: string, event: {
    clientRequestId: string; stream: "stdout" | "stderr" | "system";
    level: "info" | "warn" | "error"; message: string;
  }, signal?: AbortSignal): Promise<unknown> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(issueId, "issueId");
    requireUuid(event.clientRequestId, "event clientRequestId");
    if (!["stdout", "stderr", "system"].includes(event.stream) ||
      !["info", "warn", "error"].includes(event.level) || !event.message.trim() ||
      Buffer.byteLength(event.message, "utf8") > 8 * 1024) throw new Error("invalid local run event");
    const response = await this.#writeJson("POST", `/api/agents/me/local-runs/${lease.runId}/events`, {
      ...leaseOwnerBody(lease), issueId, ...event,
    }, {}, signal);
    return response.body;
  }

  async addLocalRunComment(lease: LocalRunLease, issueId: string, body: string, clientRequestId: string, signal?: AbortSignal): Promise<unknown> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(issueId, "issueId");
    requireUuid(clientRequestId, "clientRequestId");
    if (!body.trim()) throw new Error("comment body is required");
    const response = await this.#writeJson("POST", `/api/agents/me/local-runs/${lease.runId}/comments`, {
      ...leaseOwnerBody(lease), issueId, body, clientRequestId,
    }, {}, signal);
    return response.body;
  }

  /** Narrow human confirmation only. Agent reviewer handoff remains gated. */
  async createLocalReviewConfirmation(lease: LocalRunLease, issueId: string, prompt: string,
    clientRequestId: string, signal?: AbortSignal): Promise<unknown> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(issueId, "issueId");
    requireUuid(clientRequestId, "clientRequestId");
    if (!prompt.trim() || prompt.length > 1000) throw new Error("review prompt must be 1–1000 characters");
    const response = await this.#writeJson("POST", `/api/agents/me/local-runs/${lease.runId}/issue/review-confirmation`, {
      ...leaseOwnerBody(lease), issueId, prompt, clientRequestId,
    }, {}, signal);
    return response.body;
  }

  async handoffLocalReview(lease: LocalRunLease, issueId: string, body: string,
    reviewInteractionId: string, clientRequestId: string, signal?: AbortSignal): Promise<unknown> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(issueId, "issueId");
    requireUuid(reviewInteractionId, "reviewInteractionId");
    requireUuid(clientRequestId, "clientRequestId");
    if (!body.trim() || /@|https?:\/\//i.test(body)) throw new Error("review handoff requires plain text");
    const response = await this.#writeJson("POST", `/api/agents/me/local-runs/${lease.runId}/issue/review-handoff`, {
      ...leaseOwnerBody(lease), issueId, body, reviewInteractionId, clientRequestId,
    }, {}, signal);
    return response.body;
  }

  async createLocalCompletionReviewHandoff(lease: LocalRunLease, input: {
    issueId: string; reviewerAgentId: string; prompt: string;
    body: string; clientRequestId: string;
  }, signal?: AbortSignal): Promise<{ reviewId: string; interactionId: string; deliveryId: string }> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(input.issueId, "issueId");
    requireUuid(input.reviewerAgentId, "reviewerAgentId");
    requireUuid(input.clientRequestId, "clientRequestId");
    if (!input.prompt.trim() || input.prompt.length > 1000 || !input.body.trim() ||
      /@|https?:\/\/|www\./i.test(input.body)) {
      throw new Error("completion review requires a prompt and plain handoff summary");
    }
    const response = await this.#writeJson("POST",
      `/api/agents/me/local-runs/${lease.runId}/issue/completion-review-handoff`,
      { ...leaseOwnerBody(lease), ...input }, {}, signal);
    const record = asRecord(response.body, "completion review handoff");
    if (record.issueId !== input.issueId || record.status !== "in_review") {
      throw new Error("completion review handoff identity mismatch");
    }
    return { reviewId: requireUuid(record.reviewId, "reviewId"),
      interactionId: requireUuid(record.interactionId, "interactionId"),
      deliveryId: requireUuid(record.deliveryId, "deliveryId") };
  }

  async completeLocalChildWorkRecord(lease: LocalRunLease, input: {
    issueId: string; expectedStatusVersion: number;
    summary: string; clientRequestId: string;
  }, signal?: AbortSignal): Promise<{ receiptId: string; statusVersion: number }> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(input.issueId, "issueId");
    requireUuid(input.clientRequestId, "clientRequestId");
    if (!Number.isSafeInteger(input.expectedStatusVersion) ||
      input.expectedStatusVersion < 0 || !input.summary.trim() ||
      Buffer.byteLength(input.summary, "utf8") > 4096) {
      throw new Error("child completion requires a valid revision and summary");
    }
    const response = await this.#writeJson("POST",
      `/api/agents/me/local-runs/${lease.runId}/issue/child-complete`,
      { ...leaseOwnerBody(lease), ...input }, {}, signal);
    const record = asRecord(response.body, "child completion");
    if (record.issueId !== input.issueId || record.status !== "in_progress" ||
      record.disposition !== "prepared" ||
      !Number.isSafeInteger(record.statusVersion) ||
      Number(record.statusVersion) !== input.expectedStatusVersion) {
      throw new Error("child completion receipt changed");
    }
    return { receiptId: requireUuid(record.receiptId, "receiptId"),
      statusVersion: Number(record.statusVersion) };
  }

  async prepareLocalDefectRepairHandoff(lease: LocalRunLease, input: {
    issueId: string; expectedStatusVersion: number;
    summary: string; clientRequestId: string;
  }, signal?: AbortSignal): Promise<{ receiptId: string; statusVersion: number }> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(input.issueId, "issueId");
    requireUuid(input.clientRequestId, "clientRequestId");
    if (!Number.isSafeInteger(input.expectedStatusVersion) ||
      input.expectedStatusVersion < 0 || !input.summary.trim() ||
      Buffer.byteLength(input.summary, "utf8") > 4096 ||
      /@|(?:[a-z][a-z0-9+.-]*:\/\/)|\bwww\./i.test(input.summary)) {
      throw new Error("defect repair handoff requires a plain summary and valid revision");
    }
    const response = await this.#writeJson("POST",
      `/api/agents/me/local-runs/${lease.runId}/issue/defect-repair-handoff`,
      { ...leaseOwnerBody(lease), ...input }, {}, signal);
    const record = asRecord(response.body, "defect repair handoff");
    if (record.issueId !== input.issueId || record.status !== "in_progress" ||
      record.disposition !== "prepared" ||
      Number(record.statusVersion) !== input.expectedStatusVersion) {
      throw new Error("defect repair handoff receipt changed");
    }
    return { receiptId: requireUuid(record.receiptId, "receiptId"),
      statusVersion: Number(record.statusVersion) };
  }

  async prepareLocalDefectQaVerdict(lease: LocalRunLease, input: {
    issueId: string; expectedStatusVersion: number; cycleId: string; itemId: string;
    expectedCycleRevision: number; expectedItemRevision: number;
    outcome: "pass" | "return"; summary: string; evidenceRefs: string[];
    clientRequestId: string;
  }, signal?: AbortSignal): Promise<{ receiptId: string; disposition: "prepared" }> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    for (const key of ["issueId", "cycleId", "itemId", "clientRequestId"] as const) {
      requireUuid(input[key], key);
    }
    if (![input.expectedStatusVersion, input.expectedCycleRevision,
      input.expectedItemRevision].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !["pass", "return"].includes(input.outcome) ||
      !input.summary.trim() || Buffer.byteLength(input.summary, "utf8") > 4096 ||
      /@|(?:[a-z][a-z0-9+.-]*:\/\/)|\bwww\./i.test(input.summary) ||
      !Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 20 ||
      !input.evidenceRefs.every((value) => typeof value === "string" &&
        value.trim() && value.length <= 512)) {
      throw new Error("local defect QA verdict requires a valid quality item and plain evidence");
    }
    const response = await this.#writeJson("POST",
      `/api/agents/me/local-runs/${lease.runId}/issue/defect-qa-verdict`,
      { ...leaseOwnerBody(lease), ...input }, {}, signal);
    const record = asRecord(response.body, "local defect QA verdict preparation");
    if (record.issueId !== input.issueId || record.status !== "in_review" ||
      Number(record.statusVersion) !== input.expectedStatusVersion ||
      record.disposition !== "prepared") {
      throw new Error("local defect QA verdict receipt changed");
    }
    return { receiptId: requireUuid(record.receiptId, "receiptId"), disposition: "prepared" };
  }

  async prepareLocalPoVerdict(lease: LocalRunLease, input: {
    issueId: string; expectedStatusVersion: number; clientRequestId: string;
    cycleId: string; itemId: string; expectedCycleRevision: number;
    outcome: "approve" | "return"; reason: string;
    evidenceRefs: string[]; targetRecordIds: string[];
  }, signal?: AbortSignal): Promise<{ receiptId: string; disposition: "prepared" }> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(input.issueId, "issueId");
    requireUuid(input.clientRequestId, "clientRequestId");
    requireUuid(input.cycleId, "cycleId");
    requireUuid(input.itemId, "itemId");
    if (!Number.isSafeInteger(input.expectedStatusVersion) ||
      !Number.isSafeInteger(input.expectedCycleRevision) ||
      !["approve", "return"].includes(input.outcome) ||
      !input.reason?.trim() || !Array.isArray(input.evidenceRefs) ||
      !Array.isArray(input.targetRecordIds)) {
      throw new Error("local PO verdict requires a valid cycle and decision");
    }
    const response = await this.#writeJson("POST",
      `/api/agents/me/local-runs/${lease.runId}/issue/po-verdict`,
      { ...leaseOwnerBody(lease), ...input }, {}, signal);
    const record = asRecord(response.body, "local PO verdict preparation");
    if (record.disposition !== "prepared") {
      throw new Error("local PO verdict preparation was not confirmed");
    }
    return { receiptId: requireUuid(record.receiptId, "PO receiptId"),
      disposition: "prepared" };
  }

  async acceptLocalCompletionReview(lease: LocalRunLease, input: {
    issueId: string; reviewId: string; summary: string; clientRequestId: string;
  }, signal?: AbortSignal): Promise<{ reviewId: string; requestId: string; outcome: "accepted" }> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(input.issueId, "issueId");
    requireUuid(input.reviewId, "reviewId");
    requireUuid(input.clientRequestId, "clientRequestId");
    if (!input.summary.trim() || input.summary.length > 4096) {
      throw new Error("review decision summary must be 1–4096 characters");
    }
    const response = await this.#writeJson("POST",
      `/api/agents/me/local-runs/${lease.runId}/review-accept`,
      { ...leaseOwnerBody(lease), ...input }, {}, signal);
    const record = asRecord(response.body, "completion review acceptance");
    if (record.issueId !== input.issueId || record.reviewId !== input.reviewId ||
      record.requestId !== input.clientRequestId || record.outcome !== "accepted") {
      throw new Error("completion review acceptance receipt mismatch");
    }
    return { reviewId: input.reviewId, requestId: input.clientRequestId, outcome: "accepted" };
  }

  async rejectLocalCompletionReview(lease: LocalRunLease, input: {
    issueId: string; reviewId: string; summary: string; clientRequestId: string;
  }, signal?: AbortSignal): Promise<{ reviewId: string; requestId: string; outcome: "rejected" }> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(input.issueId, "issueId");
    requireUuid(input.reviewId, "reviewId");
    requireUuid(input.clientRequestId, "clientRequestId");
    if (!input.summary.trim() || input.summary.length > 4096) {
      throw new Error("review decision summary must be 1–4096 characters");
    }
    const response = await this.#writeJson("POST",
      `/api/agents/me/local-runs/${lease.runId}/review-reject`,
      { ...leaseOwnerBody(lease), ...input }, {}, signal);
    const record = asRecord(response.body, "completion review rejection");
    if (record.issueId !== input.issueId || record.reviewId !== input.reviewId ||
      record.requestId !== input.clientRequestId || record.outcome !== "rejected") {
      throw new Error("completion review rejection receipt mismatch");
    }
    return { reviewId: input.reviewId, requestId: input.clientRequestId, outcome: "rejected" };
  }

  async patchLocalRunIssue(lease: LocalRunLease, issueId: string, patch: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    requireUuid(issueId, "issueId");
    if (!Object.keys(patch).length || Object.keys(patch).some((key) => !["title", "description", "priority"].includes(key))) {
      throw new Error("unsupported local run issue field");
    }
    const response = await this.#writeJson("PATCH", `/api/agents/me/local-runs/${lease.runId}/issue`, {
      ...leaseOwnerBody(lease), issueId, ...patch,
    }, {}, signal);
    return response.body;
  }

  #validateLease(lease: LocalRunLease): void {
    requireUuid(lease.deviceId, "deviceId");
    requireUuid(lease.runId, "runId");
    requireUuid(lease.leaseId, "leaseId");
    if (!Number.isInteger(lease.generation) || lease.generation < 1) throw new Error("generation is invalid");
  }

  async verifyIdentity(expectedAgentId: string, expectedCompanyId: string, expectedName?: string): Promise<RemoteAgentIdentity> {
    this.#verifiedIdentity = null;
    const identity = parseIdentity(await this.#getJson("/api/agents/me"));
    if (identity.id !== expectedAgentId || identity.companyId !== expectedCompanyId ||
      (expectedName && identity.name !== expectedName)) {
      throw new Error("Alice agent identity mismatch");
    }
    this.#verifiedIdentity = identity;
    this.#logger.info(`Alice identity verified for ${identity.name}`);
    return identity;
  }

  async listInbox(expectedAgentId: string, expectedCompanyId: string): Promise<BridgeInboxItem[]> {
    const identity = this.#verifiedIdentity;
    if (!identity || identity.id !== expectedAgentId || identity.companyId !== expectedCompanyId) {
      throw new Error("Alice identity must be verified before polling the inbox");
    }
    const raw = await this.#getJson("/api/agents/me/inbox-lite");
    if (!Array.isArray(raw)) throw new Error("Alice agent inbox returned an invalid array");
    return raw.map((item, index) => parseInboxItem(item, index, identity));
  }
}

