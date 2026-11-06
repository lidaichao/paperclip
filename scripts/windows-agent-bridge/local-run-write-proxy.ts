import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AliceClient, LocalRunClaim, LocalRunLease } from "./paperclip-client.js";

interface PendingComment { runId: string; issueId: string; body: string; clientRequestId: string; confirmed: boolean }
interface CommentIntentDocument { runId: string; issueId: string; intents: PendingComment[] }
const MAX_BODY_BYTES = 64 * 1024;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY_BYTES) throw new Error("request too large");
    chunks.push(data);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}

/** Durable per-run comment intentions. A lost response always replays the original UUID. */
export class LocalCommentIntentStore {
  constructor(private readonly filePath: string) {}

  private async read(): Promise<CommentIntentDocument | null> {
    try { return JSON.parse(await readFile(this.filePath, "utf8")) as CommentIntentDocument; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async save(document: CommentIntentDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(document)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, this.filePath);
  }

  async pending(runId: string, issueId: string, body: string): Promise<PendingComment> {
    const saved = await this.read();
    if (saved && (saved.runId !== runId || saved.issueId !== issueId)) {
      if (saved.intents.some((intent) => !intent.confirmed)) {
        throw new Error("unresolved comment intent must be reconciled before another run");
      }
    }
    const document: CommentIntentDocument = saved?.runId === runId && saved.issueId === issueId
      ? saved : { runId, issueId, intents: [] };
    const existing = document.intents.find((intent) => intent.body === body);
    if (existing) {
      if (!/^[0-9a-f-]{36}$/i.test(existing.clientRequestId)) throw new Error("invalid saved comment intent");
      return existing;
    }
    if (document.intents.some((intent) => !intent.confirmed) || document.intents.length >= 200) {
      throw new Error("unresolved comment intent must be reconciled before another write");
    }
    const intent = { runId, issueId, body, clientRequestId: randomUUID(), confirmed: false };
    document.intents.push(intent);
    await this.save(document);
    return intent;
  }

  async confirmed(intent: PendingComment): Promise<void> {
    const current = await this.read();
    const saved = current?.intents.find((entry) => entry.clientRequestId === intent.clientRequestId);
    if (!saved || current?.runId !== intent.runId || current.issueId !== intent.issueId || saved.body !== intent.body) {
      throw new Error("comment intent changed before confirmation");
    }
    if (!saved.confirmed) { saved.confirmed = true; await this.save(current); }
  }
}

/** Per-run loopback capability. It never exposes the agent key or lease to the model. */
export async function startLocalRunWriteProxy(input: {
  client: Pick<AliceClient, "readLocalRunIdentity" | "readLocalRunIssue" | "addLocalRunComment" | "patchLocalRunIssue">;
  claim: LocalRunClaim;
  deviceId: string;
  signal: AbortSignal;
  intentStore: LocalCommentIntentStore;
}): Promise<{ apiBase: string; token: string; close(): Promise<void> }> {
  if (input.signal.aborted) throw new Error("local run already cancelled");
  const token = randomBytes(32).toString("hex");
  const issuePath = `/api/issues/${input.claim.issueId}`;
  const lease: LocalRunLease = { deviceId: input.deviceId, runId: input.claim.runId,
    leaseId: input.claim.leaseId, generation: input.claim.generation };
  let closed = false;
  let writeQueue = Promise.resolve();
  const server = createServer(async (req, res) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /i, "") ?? "";
    const supplied = Buffer.from(bearer);
    if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) {
      json(res, 401, { error: "unauthorized" }); return;
    }
    if (closed || input.signal.aborted) { json(res, 409, { error: "local run cancelled" }); return; }
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    try {
      if (req.method === "GET" && pathname === "/api/agents/me") {
        json(res, 200, input.client.readLocalRunIdentity()); return;
      }
      if (req.method === "GET" && pathname === issuePath) {
        json(res, 200, await input.client.readLocalRunIssue(input.claim)); return;
      }
      if (req.method === "POST" && pathname === `${issuePath}/comments`) {
        const body = await bodyOf(req);
        if (Object.keys(body).some((key) => key !== "body") || typeof body.body !== "string" || !body.body.trim()) {
          json(res, 400, { error: "unsupported comment payload" }); return;
        }
        const perform = async () => {
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          const intent = await input.intentStore.pending(input.claim.runId, input.claim.issueId, body.body as string);
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          const saved = await input.client.addLocalRunComment(lease, input.claim.issueId, intent.body,
            intent.clientRequestId, input.signal);
          await input.intentStore.confirmed(intent);
          return saved;
        };
        const next = writeQueue.then(perform);
        writeQueue = next.then(() => undefined, () => undefined);
        json(res, 201, await next); return;
      }
      if (req.method === "PATCH" && pathname === issuePath) {
        const patch = await bodyOf(req);
        if (!Object.keys(patch).length || Object.keys(patch).some((key) => !["title", "description", "priority"].includes(key))) {
          json(res, 400, { error: "unsupported issue field" }); return;
        }
        if (closed || input.signal.aborted) throw new Error("local run cancelled");
        json(res, 200, await input.client.patchLocalRunIssue(lease, input.claim.issueId, patch, input.signal)); return;
      }
      json(res, 403, { error: "operation unavailable for local run" });
    } catch {
      json(res, 409, { error: "local run write unavailable" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const onAbort = () => { closed = true; server.closeAllConnections(); server.close(); };
  input.signal.addEventListener("abort", onAbort, { once: true });
  return {
    apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    async close() {
      closed = true;
      input.signal.removeEventListener("abort", onAbort);
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
