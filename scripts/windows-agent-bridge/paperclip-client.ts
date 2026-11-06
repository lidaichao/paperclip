import type {
  BridgeInboxItem,
  BridgeIssuePriority,
  BridgeIssueStatus,
} from "./types.js";
import { performance } from "node:perf_hooks";

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

  async #postJson(pathname: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.#fetch(`${this.#apiBase}${pathname}`, {
        method: "POST",
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
    }
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

  async finishLocalRun(lease: LocalRunLease, outcome: "succeeded" | "failed" | "cancelled", exitCode: number | null): Promise<string> {
    this.#requireVerifiedIdentity();
    this.#validateLease(lease);
    if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error("exitCode must be an integer or null");
    const response = await this.#postJson(`/api/agents/me/local-runs/${lease.runId}/finish`, {
      deviceId: lease.deviceId, leaseId: lease.leaseId, generation: lease.generation,
      outcome, exitCode, processStopped: true,
    });
    const record = asRecord(response.body, "local run finish");
    if (record.runId !== lease.runId) throw new Error("local run finish identity mismatch");
    return requiredString(record, "status", "local run finish");
  }

  #validateLease(lease: LocalRunLease): void {
    requireUuid(lease.deviceId, "deviceId");
    requireUuid(lease.runId, "runId");
    requireUuid(lease.leaseId, "leaseId");
    if (!Number.isInteger(lease.generation) || lease.generation < 1) throw new Error("generation is invalid");
  }

  async verifyIdentity(expectedAgentId: string, expectedCompanyId: string): Promise<RemoteAgentIdentity> {
    this.#verifiedIdentity = null;
    const identity = parseIdentity(await this.#getJson("/api/agents/me"));
    if (identity.id !== expectedAgentId || identity.companyId !== expectedCompanyId) {
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

