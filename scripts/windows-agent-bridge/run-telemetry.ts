import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { LocalRunLease } from "./paperclip-client.js";

export interface RunEvent {
  clientRequestId: string;
  stream: "stdout" | "stderr" | "system";
  level: "info" | "warn" | "error";
  message: string;
  acknowledged: boolean;
}

interface RunTelemetryDocument {
  schemaVersion: 1;
  runId: string;
  issueId: string;
  finishRequestId: string;
  events: RunEvent[];
}

export interface RunEventClient {
  postLocalRunEvent(lease: LocalRunLease, issueId: string, event: Omit<RunEvent, "acknowledged">,
    signal?: AbortSignal): Promise<unknown>;
}

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_EVENTS = 2_000;

export function summarizeRunText(raw: string | null | undefined, secrets: readonly (string | undefined)[]): string | undefined {
  if (!raw) return undefined;
  const text = redactRunText(raw, secrets);
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= 4 * 1024 ? text : `${bytes.subarray(0, 4 * 1024 - 32).toString("utf8")} [truncated]`;
}

export function redactRunText(raw: string, secrets: readonly (string | undefined)[]): string {
  let result = raw;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) result = result.split(secret).join("[redacted]");
  }
  result = result.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\b(?:GBRAIN_[A-Z_]+_TOKEN|PAPERCLIP_API_KEY|OPENAI_API_KEY|CURSOR_API_KEY)\s*[:=]\s*[^\s"']+/gi,
      (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/\b(?:gbrain_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|pc_agent_[A-Za-z0-9_-]{12,})\b/g,
      "[redacted]");
  const bytes = Buffer.from(result, "utf8");
  return bytes.length <= MAX_MESSAGE_BYTES ? result : `${bytes.subarray(0, MAX_MESSAGE_BYTES - 32).toString("utf8")} [truncated]`;
}

/** Private durable event journal. Acknowledged entries remain for safe replay audit. */
export class RunTelemetryStore {
  private document: RunTelemetryDocument | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lines: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  private dropping: Record<"stdout" | "stderr", boolean> = { stdout: false, stderr: false };

  constructor(private readonly filePath: string, private readonly runId: string,
    private readonly issueId: string, private readonly secrets: readonly (string | undefined)[]) {}

  private async load(): Promise<RunTelemetryDocument> {
    if (this.document) return this.document;
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8")) as RunTelemetryDocument;
      if (saved.schemaVersion !== 1 || saved.runId !== this.runId || saved.issueId !== this.issueId ||
        !/^[0-9a-f-]{36}$/i.test(saved.finishRequestId) || !Array.isArray(saved.events)) {
        throw new Error("run telemetry identity mismatch; manual recovery required");
      }
      this.document = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.document = { schemaVersion: 1, runId: this.runId, issueId: this.issueId,
        finishRequestId: randomUUID(), events: [] };
      await this.save(this.document);
    }
    return this.document;
  }

  private async save(document: RunTelemetryDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(document)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, this.filePath);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async finishRequestId(): Promise<string> {
    return this.serialize(async () => (await this.load()).finishRequestId);
  }

  async append(stream: RunEvent["stream"], level: RunEvent["level"], raw: string): Promise<void> {
    return this.serialize(async () => {
      const document = await this.load();
      if (document.events.length >= MAX_EVENTS) throw new Error("local run telemetry limit reached");
      const message = redactRunText(raw, this.secrets);
      if (!message.trim()) return;
      document.events.push({ clientRequestId: randomUUID(), stream, level, message, acknowledged: false });
      await this.save(document);
    });
  }

  async appendLogChunk(stream: "stdout" | "stderr", chunk: string): Promise<void> {
    const parts = chunk.split(/\r?\n/);
    let pending = this.lines[stream] + parts.shift()!;
    for (const part of parts) {
      if (this.dropping[stream]) this.dropping[stream] = false;
      else await this.append(stream, stream === "stderr" ? "warn" : "info", pending);
      pending = part;
    }
    if (Buffer.byteLength(pending, "utf8") > 1024 * 1024) {
      pending = "";
      this.dropping[stream] = true;
      await this.append("system", "warn", "[oversized log line omitted]");
    }
    this.lines[stream] = pending;
  }

  async flushTails(): Promise<void> {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.lines[stream] && !this.dropping[stream]) {
        await this.append(stream, stream === "stderr" ? "warn" : "info", this.lines[stream]);
      }
      this.lines[stream] = "";
      this.dropping[stream] = false;
    }
  }

  async flush(client: RunEventClient, lease: LocalRunLease, signal?: AbortSignal): Promise<void> {
    return this.serialize(async () => {
      const document = await this.load();
      for (const event of document.events) {
        if (event.acknowledged) continue;
        if (signal?.aborted) throw new Error("local run cancelled; event upload stopped");
        await client.postLocalRunEvent(lease, this.issueId, {
          clientRequestId: event.clientRequestId, stream: event.stream, level: event.level, message: event.message,
        }, signal);
        event.acknowledged = true;
        await this.save(document);
      }
    });
  }
}
