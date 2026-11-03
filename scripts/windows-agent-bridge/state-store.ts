import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BridgeDispatchRecord,
  BridgeInboxItem,
  BridgeStateDocument,
} from "./types.js";

const MAX_TERMINAL_RECORDS = 500;

function emptyState(): BridgeStateDocument {
  return { schemaVersion: 1, records: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseState(value: unknown): BridgeStateDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.records)) {
    throw new Error("bridge state file is invalid");
  }
  return value as unknown as BridgeStateDocument;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

export function dispatchLeaseKey(issue: BridgeInboxItem, agentId: string): string {
  return `${agentId}:${issue.id}:${issue.updatedAt}`;
}

export class StateStore {
  readonly #filePath: string;
  readonly #now: () => Date;
  #state: BridgeStateDocument | null = null;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: { now?: () => Date } = {}) {
    this.#filePath = path.resolve(filePath);
    this.#now = options.now ?? (() => new Date());
  }

  async load(): Promise<BridgeStateDocument> {
    if (this.#state) return this.snapshot();
    try {
      const raw = JSON.parse(await readFile(this.#filePath, "utf8"));
      this.#state = parseState(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.#state = emptyState();
      else throw error;
    }
    return this.snapshot();
  }

  snapshot(): BridgeStateDocument {
    if (!this.#state) throw new Error("state store must be loaded first");
    return structuredClone(this.#state);
  }

  async #persist(): Promise<void> {
    if (!this.#state) throw new Error("state store must be loaded first");
    const body = `${JSON.stringify(this.#state, null, 2)}\n`;
    const tempPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, this.#filePath);
  }

  async #mutate(mutator: (state: BridgeStateDocument) => void): Promise<void> {
    await this.load();
    this.#writeChain = this.#writeChain.then(async () => {
      if (!this.#state) throw new Error("state store must be loaded first");
      mutator(this.#state);
      this.#prune();
      await this.#persist();
    });
    await this.#writeChain;
  }

  #prune(): void {
    if (!this.#state) return;
    const terminal = Object.values(this.#state.records)
      .filter((record) => record.status === "finished")
      .sort((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""));
    for (const record of terminal.slice(MAX_TERMINAL_RECORDS)) {
      delete this.#state.records[record.leaseKey];
    }
  }

  async tryAcquire(issue: BridgeInboxItem, agentId: string): Promise<boolean> {
    await this.load();
    const leaseKey = dispatchLeaseKey(issue, agentId);
    let acquired = false;
    await this.#mutate((state) => {
      const existing = state.records[leaseKey];
      if (existing) {
        if (existing.status !== "retryable") return;
        if (existing.nextAttemptAt && existing.nextAttemptAt > nowIso(this.#now)) return;
      }
      const timestamp = nowIso(this.#now);
      state.records[leaseKey] = {
        leaseKey,
        agentId,
        issueId: issue.id,
        issueUpdatedAt: issue.updatedAt,
        identifier: issue.identifier,
        status: "acquired",
        attempt: (existing?.attempt ?? 0) + 1,
        acquiredAt: timestamp,
        startedAt: null,
        finishedAt: null,
        nextAttemptAt: null,
        pid: null,
        outcome: null,
        errorCode: null,
      };
      acquired = true;
    });
    return acquired;
  }

  async markRunning(leaseKey: string, input: { pid: number; startedAt?: string }): Promise<void> {
    await this.#mutate((state) => {
      const record = state.records[leaseKey];
      if (!record) throw new Error(`unknown dispatch lease ${leaseKey}`);
      record.status = "running";
      record.pid = input.pid;
      record.startedAt = input.startedAt ?? nowIso(this.#now);
    });
  }

  async markFinished(
    leaseKey: string,
    input: { outcome: "succeeded" | "failed"; errorCode?: string | null },
  ): Promise<void> {
    await this.#mutate((state) => {
      const record = state.records[leaseKey];
      if (!record) throw new Error(`unknown dispatch lease ${leaseKey}`);
      record.status = "finished";
      record.outcome = input.outcome;
      record.errorCode = input.errorCode ?? null;
      record.finishedAt = nowIso(this.#now);
      record.nextAttemptAt = null;
      record.pid = null;
    });
  }

  async markRetryable(
    leaseKey: string,
    input: { nextAttemptAt: string; outcome?: "failed" | "orphaned"; errorCode?: string | null },
  ): Promise<void> {
    await this.#mutate((state) => {
      const record = state.records[leaseKey];
      if (!record) throw new Error(`unknown dispatch lease ${leaseKey}`);
      record.status = "retryable";
      record.outcome = input.outcome ?? "failed";
      record.errorCode = input.errorCode ?? null;
      record.nextAttemptAt = input.nextAttemptAt;
      record.finishedAt = nowIso(this.#now);
      record.pid = null;
    });
  }

  async recoverOrphans(isProcessAlive: (pid: number) => boolean): Promise<string[]> {
    const orphaned: string[] = [];
    await this.#mutate((state) => {
      const timestamp = nowIso(this.#now);
      for (const record of Object.values(state.records)) {
        if (record.status !== "running" || !record.pid || isProcessAlive(record.pid)) continue;
        record.status = "retryable";
        record.outcome = "orphaned";
        record.errorCode = "bridge_process_missing";
        record.nextAttemptAt = timestamp;
        record.finishedAt = timestamp;
        record.pid = null;
        orphaned.push(record.issueId);
      }
    });
    return orphaned;
  }
}

