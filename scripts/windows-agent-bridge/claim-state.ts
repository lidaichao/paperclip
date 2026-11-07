import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { LocalRunClaim } from "./paperclip-client.js";

export interface ReportedLocalProcess {
  pid: number;
  startedAt: string;
}

export interface LocalFinishIntent {
  clientRequestId: string;
  outcome: "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  summary?: string;
}

interface ClaimState {
  schemaVersion: 2;
  deviceId: string;
  agentId: string;
  idempotencyKey: string;
  activeClaim: LocalRunClaim | null;
  executionMayHaveStarted: boolean;
  reportedProcesses: ReportedLocalProcess[];
  finishIntent: LocalFinishIntent | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A claim key is durable before the POST; an unfinished claim blocks restart. */
export class ClaimStateStore {
  readonly #filePath: string;
  readonly #deviceId: string;
  readonly #agentId: string;
  #state: ClaimState | null = null;

  constructor(filePath: string, deviceId: string, agentId: string) {
    this.#filePath = path.resolve(filePath);
    this.#deviceId = deviceId;
    this.#agentId = agentId;
  }

  async load(): Promise<void> {
    if (this.#state) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid claim state");
      const state = raw as ClaimState;
      if ((state as { schemaVersion: number }).schemaVersion === 1 && state.activeClaim === null &&
        state.deviceId === this.#deviceId && state.agentId === this.#agentId && UUID.test(state.idempotencyKey)) {
        this.#state = { ...state, schemaVersion: 2, executionMayHaveStarted: false,
          reportedProcesses: [], finishIntent: null };
        await this.#persist();
        return;
      }
      if (state.schemaVersion !== 2 || state.deviceId !== this.#deviceId || state.agentId !== this.#agentId ||
        !UUID.test(state.idempotencyKey) ||
        (state.activeClaim !== null && (!state.activeClaim || !UUID.test(state.activeClaim.runId) ||
          state.activeClaim.agentId !== this.#agentId)) ||
        typeof state.executionMayHaveStarted !== "boolean" || !Array.isArray(state.reportedProcesses) ||
        !state.reportedProcesses.every((process) => Number.isSafeInteger(process.pid) && process.pid > 0 &&
          typeof process.startedAt === "string" && !Number.isNaN(Date.parse(process.startedAt))) ||
        (state.finishIntent !== null && (!state.finishIntent ||
          !UUID.test(state.finishIntent.clientRequestId) ||
          !["succeeded", "failed", "cancelled"].includes(state.finishIntent.outcome) ||
          (state.finishIntent.exitCode !== null && !Number.isSafeInteger(state.finishIntent.exitCode)) ||
          (state.finishIntent.summary !== undefined && typeof state.finishIntent.summary !== "string"))) ||
        (!state.activeClaim && (state.executionMayHaveStarted || state.reportedProcesses.length > 0 || state.finishIntent))) {
        throw new Error("claim state identity or format mismatch; manual recovery required");
      }
      this.#state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#state = {
        schemaVersion: 2, deviceId: this.#deviceId, agentId: this.#agentId,
        idempotencyKey: randomUUID(), activeClaim: null,
        executionMayHaveStarted: false, reportedProcesses: [], finishIntent: null,
      };
      await this.#persist();
    }
  }

  async claimKey(): Promise<string> {
    await this.load();
    if (this.#state!.activeClaim) {
      throw new Error("prior local run has no confirmed finish; manual recovery required");
    }
    return this.#state!.idempotencyKey;
  }

  async currentClaim(): Promise<LocalRunClaim | null> {
    await this.load();
    return this.#state!.activeClaim ? structuredClone(this.#state!.activeClaim) : null;
  }

  async markClaimed(claim: LocalRunClaim): Promise<void> {
    await this.claimKey();
    if (claim.agentId !== this.#agentId) throw new Error("claim agent identity mismatch");
    this.#state!.activeClaim = structuredClone(claim);
    await this.#persist();
  }

  async markExecutionStarting(runId: string): Promise<void> {
    await this.#assertActiveRun(runId);
    this.#state!.executionMayHaveStarted = true;
    await this.#persist();
  }

  async markProcessReported(runId: string, process: ReportedLocalProcess): Promise<void> {
    await this.#assertActiveRun(runId);
    if (!this.#state!.executionMayHaveStarted || !Number.isSafeInteger(process.pid) || process.pid <= 0 ||
      Number.isNaN(Date.parse(process.startedAt))) throw new Error("invalid local process report");
    this.#state!.reportedProcesses.push({ ...process });
    await this.#persist();
  }

  async markFinishIntent(runId: string, intent: LocalFinishIntent): Promise<void> {
    await this.#assertActiveRun(runId);
    if (!UUID.test(intent.clientRequestId) || !["succeeded", "failed", "cancelled"].includes(intent.outcome) ||
      (intent.exitCode !== null && !Number.isSafeInteger(intent.exitCode)) ||
      (intent.summary !== undefined && typeof intent.summary !== "string")) {
      throw new Error("invalid local finish intent");
    }
    this.#state!.finishIntent = { ...intent };
    await this.#persist();
  }

  async recoveryState(): Promise<Readonly<ClaimState>> {
    await this.load();
    return structuredClone(this.#state!);
  }

  async #assertActiveRun(runId: string): Promise<void> {
    await this.load();
    if (this.#state!.activeClaim?.runId !== runId) throw new Error("local run identity mismatch");
  }

  async markFinished(runId: string): Promise<void> {
    await this.load();
    if (this.#state!.activeClaim?.runId !== runId) throw new Error("finished run identity mismatch");
    this.#state!.activeClaim = null;
    this.#state!.executionMayHaveStarted = false;
    this.#state!.reportedProcesses = [];
    this.#state!.finishIntent = null;
    this.#state!.idempotencyKey = randomUUID();
    await this.#persist();
  }

  async #persist(): Promise<void> {
    if (!this.#state) throw new Error("claim state is not loaded");
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(this.#state, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, this.#filePath);
  }
}
