import type {
  BridgeInboxItem,
  BridgeIssuePriority,
  BridgeIssueStatus,
} from "./types.js";

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

function parseInboxItem(value: unknown, index: number): BridgeInboxItem {
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

  return {
    id: requiredString(record, "id", label),
    companyId: requiredString(record, "companyId", label),
    projectId: typeof record.projectId === "string" && record.projectId.trim() ? record.projectId.trim() : null,
    identifier,
    title: requiredString(record, "title", label),
    status,
    priority,
    assigneeAgentId: requiredString(record, "assigneeAgentId", label),
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

  constructor(options: AliceClientOptions) {
    this.#apiBase = options.apiBase.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? { info: () => undefined, warn: () => undefined };
    this.#timeoutMs = options.timeoutMs ?? 10_000;
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
        this.#logger.warn(`Alice API ${pathname} returned HTTP ${response.status}`);
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

  async verifyIdentity(expectedAgentId: string, expectedCompanyId: string): Promise<RemoteAgentIdentity> {
    const identity = parseIdentity(await this.#getJson("/api/agents/me"));
    if (identity.id !== expectedAgentId || identity.companyId !== expectedCompanyId) {
      throw new Error("Alice agent identity mismatch");
    }
    this.#logger.info(`Alice identity verified for ${identity.name}`);
    return identity;
  }

  async listInbox(expectedAgentId: string, expectedCompanyId: string): Promise<BridgeInboxItem[]> {
    const raw = await this.#getJson("/api/agents/me/inbox-lite");
    if (!Array.isArray(raw)) throw new Error("Alice agent inbox returned an invalid array");
    return raw
      .map(parseInboxItem)
      .filter((issue) => issue.assigneeAgentId === expectedAgentId && issue.companyId === expectedCompanyId);
  }
}

