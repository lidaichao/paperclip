import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { LocalRunClaim } from "./paperclip-client.js";

interface ClaimState {
  schemaVersion: 1;
  deviceId: string;
  agentId: string;
  idempotencyKey: string;
  activeClaim: LocalRunClaim | null;
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
      if (state.schemaVersion !== 1 || state.deviceId !== this.#deviceId || state.agentId !== this.#agentId ||
        !UUID.test(state.idempotencyKey) ||
        (state.activeClaim !== null && (!state.activeClaim || !UUID.test(state.activeClaim.runId) ||
          state.activeClaim.agentId !== this.#agentId))) {
        throw new Error("claim state identity or format mismatch; manual recovery required");
      }
      this.#state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#state = {
        schemaVersion: 1, deviceId: this.#deviceId, agentId: this.#agentId,
        idempotencyKey: randomUUID(), activeClaim: null,
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

  async markClaimed(claim: LocalRunClaim): Promise<void> {
    await this.claimKey();
    if (claim.agentId !== this.#agentId) throw new Error("claim agent identity mismatch");
    this.#state!.activeClaim = structuredClone(claim);
    await this.#persist();
  }

  async markFinished(runId: string): Promise<void> {
    await this.load();
    if (this.#state!.activeClaim?.runId !== runId) throw new Error("finished run identity mismatch");
    this.#state!.activeClaim = null;
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
