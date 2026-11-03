import type { BridgeAgentConfig, BridgeInboxItem } from "./types.js";
import { dispatchLeaseKey, StateStore } from "./state-store.js";

const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

export interface DispatcherClient {
  listInbox(agentId: string, companyId: string): Promise<BridgeInboxItem[]>;
}

export interface DispatcherRuntimeResult {
  succeeded: boolean;
  errorCode: string | null;
}

export interface DispatcherDependencies {
  clientFor(agent: BridgeAgentConfig): DispatcherClient;
  run(input: {
    agent: BridgeAgentConfig;
    issue: BridgeInboxItem;
    onSpawn(meta: { pid: number; startedAt: string }): Promise<void>;
  }): Promise<DispatcherRuntimeResult>;
  now?: () => Date;
}

export interface DispatchCycleResult {
  launched: string[];
  skipped: string[];
}

export function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1) - 1, RETRY_DELAYS_MS.length - 1)];
}

export function selectEligibleIssues(items: BridgeInboxItem[]): BridgeInboxItem[] {
  return items
    .filter((item) => (item.status === "todo" || item.status === "in_progress") && !item.activeRunId)
    .sort((left, right) =>
      PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority]
      || left.updatedAt.localeCompare(right.updatedAt)
      || left.identifier.localeCompare(right.identifier),
    );
}

export class Dispatcher {
  readonly #companyId: string;
  readonly #agents: BridgeAgentConfig[];
  readonly #state: StateStore;
  readonly #dependencies: DispatcherDependencies;
  readonly #running = new Map<string, Promise<void>>();
  #cursor = 0;

  constructor(input: {
    companyId: string;
    agents: BridgeAgentConfig[];
    state: StateStore;
    dependencies: DispatcherDependencies;
  }) {
    this.#companyId = input.companyId;
    this.#agents = [...input.agents];
    this.#state = input.state;
    this.#dependencies = input.dependencies;
  }

  get activeCount(): number {
    return this.#running.size;
  }

  async cycle(): Promise<DispatchCycleResult> {
    const result: DispatchCycleResult = { launched: [], skipped: [] };
    if (this.#agents.length === 0) return result;
    const ordered = this.#agents.map((_, index) => this.#agents[(this.#cursor + index) % this.#agents.length]);
    this.#cursor = (this.#cursor + 1) % this.#agents.length;

    for (const agent of ordered) {
      if (this.#running.has(agent.remoteAgentId)) {
        result.skipped.push(agent.remoteAgentName);
        continue;
      }
      const inbox = await this.#dependencies.clientFor(agent).listInbox(agent.remoteAgentId, this.#companyId);
      const issue = selectEligibleIssues(inbox)[0];
      if (!issue || !(await this.#state.tryAcquire(issue, agent.remoteAgentId))) continue;
      const leaseKey = dispatchLeaseKey(issue, agent.remoteAgentId);
      const execution = this.#execute(agent, issue, leaseKey).finally(() => this.#running.delete(agent.remoteAgentId));
      this.#running.set(agent.remoteAgentId, execution);
      result.launched.push(issue.identifier);
    }
    return result;
  }

  async #execute(agent: BridgeAgentConfig, issue: BridgeInboxItem, leaseKey: string): Promise<void> {
    try {
      const runResult = await this.#dependencies.run({
        agent,
        issue,
        onSpawn: async ({ pid, startedAt }) => this.#state.markRunning(leaseKey, { pid, startedAt }),
      });
      if (runResult.succeeded) {
        await this.#state.markFinished(leaseKey, { outcome: "succeeded" });
        return;
      }
      await this.#scheduleRetry(leaseKey, runResult.errorCode ?? "adapter_failed");
    } catch {
      await this.#scheduleRetry(leaseKey, "adapter_execution_failed");
    }
  }

  async #scheduleRetry(leaseKey: string, errorCode: string): Promise<void> {
    const record = this.#state.snapshot().records[leaseKey];
    const delay = retryDelayMs(record?.attempt ?? 1);
    const nextAttemptAt = new Date((this.#dependencies.now?.() ?? new Date()).getTime() + delay).toISOString();
    await this.#state.markRetryable(leaseKey, { nextAttemptAt, errorCode });
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }
}
