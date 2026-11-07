import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AliceClient, LocalReviewContext, LocalRunClaim, LocalRunLease } from "./paperclip-client.js";

interface PendingComment { runId: string; issueId: string; body: string; clientRequestId: string; confirmed: boolean }
interface CommentIntentDocument { runId: string; issueId: string; intents: PendingComment[] }
const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class UnresolvedCommentIntentError extends Error {
  constructor(readonly clientRequestId: string) {
    super("unresolved comment intent requires an explicit retry ID");
  }
}

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

  async pending(runId: string, issueId: string, body: string, requestId?: string): Promise<PendingComment> {
    if (requestId !== undefined && !UUID.test(requestId)) throw new Error("invalid comment request ID");
    const saved = await this.read();
    if (saved && (saved.runId !== runId || saved.issueId !== issueId)) {
      if (saved.intents.some((intent) => !intent.confirmed)) {
        throw new Error("unresolved comment intent must be reconciled before another run");
      }
    }
    const document: CommentIntentDocument = saved?.runId === runId && saved.issueId === issueId
      ? saved : { runId, issueId, intents: [] };
    const existing = requestId === undefined ? undefined
      : document.intents.find((intent) => intent.clientRequestId === requestId);
    if (existing) {
      if (existing.body !== body) throw new Error("comment request ID reused with different body");
      return existing;
    }
    const unresolved = document.intents.find((intent) => !intent.confirmed);
    if (unresolved) throw new UnresolvedCommentIntentError(unresolved.clientRequestId);
    if (document.intents.length >= 200) throw new Error("comment intent limit reached");
    const intent = { runId, issueId, body, clientRequestId: requestId ?? randomUUID(), confirmed: false };
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

  async assertNoPending(): Promise<void> {
    const saved = await this.read();
    if (!saved) return;
    if (saved.intents.some((intent) => !intent.confirmed)) {
      throw new Error("unresolved comment intent requires manual reconciliation");
    }
  }
}

/** Per-run loopback capability. It never exposes the agent key or lease to the model. */
export async function startLocalRunWriteProxy(input: {
  client: Pick<AliceClient, "readLocalRunIdentity" | "readLocalRunIssue" | "addLocalRunComment" | "patchLocalRunIssue"> &
    Partial<Pick<AliceClient, "acceptLocalCompletionReview" | "rejectLocalCompletionReview" |
      "createLocalCompletionReviewHandoff" | "completeLocalChildWorkRecord" |
      "readLocalWorkPackageContext" | "prepareLocalPoVerdict">>;
  claim: LocalRunClaim;
  deviceId: string;
  signal: AbortSignal;
  intentStore: LocalCommentIntentStore;
  reviewContext?: LocalReviewContext;
}): Promise<{ apiBase: string; token: string; decisionConfirmed(): boolean;
  writeFailed(): boolean;
  close(): Promise<void> }> {
  if (input.signal.aborted) throw new Error("local run already cancelled");
  const review = input.claim.wakeReason === "issue_completion_review";
  if (review !== Boolean(input.reviewContext) ||
    (review && (input.reviewContext?.issue.id !== input.claim.issueId ||
      input.reviewContext?.review.reviewerAgentId !== input.claim.agentId ||
      input.reviewContext?.review.sourceAgentId !== input.reviewContext?.issue.assigneeAgentId ||
      input.reviewContext?.issue.status !== "in_review" ||
      !input.client.acceptLocalCompletionReview || !input.client.rejectLocalCompletionReview))) {
    throw new Error("review capability does not match the claimed run");
  }
  const token = randomBytes(32).toString("hex");
  const issuePath = `/api/issues/${input.claim.issueId}`;
  const lease: LocalRunLease = { deviceId: input.deviceId, runId: input.claim.runId,
    leaseId: input.claim.leaseId, generation: input.claim.generation };
  let closed = false;
  let closing = false;
  let failedFieldWrite = false;
  let reviewDecisionConfirmed = false;
  let sourceDispositionConfirmed = false;
  let writeQueue = Promise.resolve();
  const server = createServer(async (req, res) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /i, "") ?? "";
    const supplied = Buffer.from(bearer);
    if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) {
      json(res, 401, { error: "unauthorized" }); return;
    }
    if (closed || closing || input.signal.aborted) { json(res, 409, { error: "local run cancelled" }); return; }
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    try {
      if (req.method === "GET" && pathname === "/api/agents/me") {
        json(res, 200, input.client.readLocalRunIdentity()); return;
      }
      if (req.method === "GET" && pathname === issuePath) {
        json(res, 200, review ? {
          ...input.reviewContext!.issue,
          completionReview: input.reviewContext!.review,
        } : await input.client.readLocalRunIssue(input.claim)); return;
      }
      if (!review && req.method === "GET" && pathname === `${issuePath}/work-package-context`) {
        if (!input.client.readLocalWorkPackageContext) {
          json(res, 503, { error: "work package context unavailable" }); return;
        }
        json(res, 200, await input.client.readLocalWorkPackageContext(input.claim, input.deviceId));
        return;
      }
      if (!review && sourceDispositionConfirmed && req.method !== "GET") {
        json(res, 409, { error: "source run already completed or handed off" }); return;
      }
      if (review && req.method === "POST" && pathname === `${issuePath}/review-decision`) {
        const decision = await bodyOf(req);
        if (Object.keys(decision).some((key) => !["outcome", "summary", "clientRequestId"].includes(key)) ||
          !["accepted", "rejected"].includes(String(decision.outcome)) ||
          typeof decision.summary !== "string" || !decision.summary.trim() ||
          decision.summary.length > 4096 ||
          (decision.clientRequestId !== undefined &&
            (typeof decision.clientRequestId !== "string" || !UUID.test(decision.clientRequestId)))) {
          json(res, 400, { error: "unsupported review decision" }); return;
        }
        const perform = async () => {
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          if (reviewDecisionConfirmed) throw new Error("review already decided in this run");
          const canonical = JSON.stringify({ outcome: decision.outcome, summary: decision.summary });
          const intent = await input.intentStore.pending(input.claim.runId, input.claim.issueId,
            canonical, decision.clientRequestId as string | undefined);
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          let saved: unknown;
          try {
            const command = { issueId: input.claim.issueId,
              reviewId: input.reviewContext!.review.id,
              summary: decision.summary as string,
              clientRequestId: intent.clientRequestId };
            saved = decision.outcome === "accepted"
              ? await input.client.acceptLocalCompletionReview!(lease, command, input.signal)
              : await input.client.rejectLocalCompletionReview!(lease, command, input.signal);
          } catch {
            throw new UnresolvedCommentIntentError(intent.clientRequestId);
          }
          await input.intentStore.confirmed(intent);
          reviewDecisionConfirmed = true;
          return saved;
        };
        const next = writeQueue.then(perform);
        writeQueue = next.then(() => undefined, () => undefined);
        json(res, 200, await next); return;
      }
      if (review) { json(res, 403, { error: "operation unavailable for reviewer" }); return; }
      if (req.method === "POST" && pathname === `${issuePath}/po-verdict`) {
        const decision = await bodyOf(req);
        if (Object.keys(decision).some((key) => ![
          "expectedStatusVersion", "cycleId", "itemId", "expectedCycleRevision",
          "outcome", "reason", "evidenceRefs", "targetRecordIds", "clientRequestId",
        ].includes(key)) ||
          !Number.isSafeInteger(decision.expectedStatusVersion) ||
          !Number.isSafeInteger(decision.expectedCycleRevision) ||
          typeof decision.cycleId !== "string" || !UUID.test(decision.cycleId) ||
          typeof decision.itemId !== "string" || !UUID.test(decision.itemId) ||
          !["approve", "return"].includes(String(decision.outcome)) ||
          typeof decision.reason !== "string" || !decision.reason.trim() ||
          !Array.isArray(decision.evidenceRefs) ||
          !Array.isArray(decision.targetRecordIds) ||
          (decision.clientRequestId !== undefined &&
            (typeof decision.clientRequestId !== "string" || !UUID.test(decision.clientRequestId)))) {
          json(res, 400, { error: "unsupported PO verdict" }); return;
        }
        const perform = async () => {
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          if (sourceDispositionConfirmed) throw new Error("source run already decided");
          if (!input.client.prepareLocalPoVerdict) throw new Error("PO verdict unavailable");
          const canonical = JSON.stringify({
            expectedStatusVersion: decision.expectedStatusVersion,
            cycleId: decision.cycleId, itemId: decision.itemId,
            expectedCycleRevision: decision.expectedCycleRevision,
            outcome: decision.outcome, reason: decision.reason,
            evidenceRefs: decision.evidenceRefs,
            targetRecordIds: decision.targetRecordIds,
          });
          const intent = await input.intentStore.pending(input.claim.runId,
            input.claim.issueId, canonical, decision.clientRequestId as string | undefined);
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          let saved: unknown;
          try {
            saved = await input.client.prepareLocalPoVerdict(lease, {
              issueId: input.claim.issueId,
              expectedStatusVersion: Number(decision.expectedStatusVersion),
              cycleId: decision.cycleId as string, itemId: decision.itemId as string,
              expectedCycleRevision: Number(decision.expectedCycleRevision),
              outcome: decision.outcome as "approve" | "return",
              reason: decision.reason as string,
              evidenceRefs: decision.evidenceRefs as string[],
              targetRecordIds: decision.targetRecordIds as string[],
              clientRequestId: intent.clientRequestId,
            }, input.signal);
          } catch {
            throw new UnresolvedCommentIntentError(intent.clientRequestId);
          }
          await input.intentStore.confirmed(intent);
          sourceDispositionConfirmed = true;
          return saved;
        };
        const next = writeQueue.then(perform);
        writeQueue = next.then(() => undefined, () => undefined);
        json(res, 201, await next); return;
      }
      if (req.method === "POST" && pathname === `${issuePath}/child-complete`) {
        const completion = await bodyOf(req);
        if (Object.keys(completion).some((key) =>
          !["summary", "expectedStatusVersion", "clientRequestId"].includes(key)) ||
          typeof completion.summary !== "string" || !completion.summary.trim() ||
          Buffer.byteLength(completion.summary, "utf8") > 4096 ||
          /@|https?:\/\/|www\./i.test(completion.summary) ||
          !Number.isSafeInteger(completion.expectedStatusVersion) ||
          Number(completion.expectedStatusVersion) < 0 ||
          (completion.clientRequestId !== undefined &&
            (typeof completion.clientRequestId !== "string" || !UUID.test(completion.clientRequestId)))) {
          json(res, 400, { error: "unsupported child completion" }); return;
        }
        const perform = async () => {
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          if (sourceDispositionConfirmed) throw new Error("source run already completed or handed off");
          if (!input.client.completeLocalChildWorkRecord) {
            throw new Error("child completion is unavailable");
          }
          const canonical = JSON.stringify({ expectedStatusVersion: completion.expectedStatusVersion,
            summary: completion.summary });
          const intent = await input.intentStore.pending(input.claim.runId,
            input.claim.issueId, canonical, completion.clientRequestId as string | undefined);
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          let saved: unknown;
          try {
            saved = await input.client.completeLocalChildWorkRecord(lease, {
              issueId: input.claim.issueId,
              expectedStatusVersion: Number(completion.expectedStatusVersion),
              summary: completion.summary as string,
              clientRequestId: intent.clientRequestId,
            }, input.signal);
          } catch {
            throw new UnresolvedCommentIntentError(intent.clientRequestId);
          }
          await input.intentStore.confirmed(intent);
          sourceDispositionConfirmed = true;
          return saved;
        };
        const next = writeQueue.then(perform);
        writeQueue = next.then(() => undefined, () => undefined);
        json(res, 201, await next); return;
      }
      if (req.method === "POST" && pathname === `${issuePath}/completion-review-handoff`) {
        const handoff = await bodyOf(req);
        if (Object.keys(handoff).some((key) => !["reviewerAgentId", "prompt", "body", "clientRequestId"].includes(key)) ||
          typeof handoff.reviewerAgentId !== "string" || !UUID.test(handoff.reviewerAgentId) ||
          typeof handoff.prompt !== "string" || !handoff.prompt.trim() || handoff.prompt.length > 1000 ||
          typeof handoff.body !== "string" || !handoff.body.trim() ||
          /@|https?:\/\/|www\./i.test(handoff.body) ||
          (handoff.clientRequestId !== undefined &&
            (typeof handoff.clientRequestId !== "string" || !UUID.test(handoff.clientRequestId)))) {
          json(res, 400, { error: "unsupported completion review handoff" }); return;
        }
        const perform = async () => {
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          if (sourceDispositionConfirmed) throw new Error("source run already completed or handed off");
          if (!input.client.createLocalCompletionReviewHandoff) {
            throw new Error("completion review handoff is unavailable");
          }
          const canonical = JSON.stringify({ reviewerAgentId: handoff.reviewerAgentId,
            prompt: handoff.prompt, body: handoff.body });
          const intent = await input.intentStore.pending(input.claim.runId, input.claim.issueId,
            canonical, handoff.clientRequestId as string | undefined);
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          let saved: unknown;
          try {
            saved = await input.client.createLocalCompletionReviewHandoff(lease, {
              issueId: input.claim.issueId, reviewerAgentId: handoff.reviewerAgentId as string,
              prompt: handoff.prompt as string, body: handoff.body as string,
              clientRequestId: intent.clientRequestId,
            }, input.signal);
          } catch {
            throw new UnresolvedCommentIntentError(intent.clientRequestId);
          }
          await input.intentStore.confirmed(intent);
          sourceDispositionConfirmed = true;
          return saved;
        };
        const next = writeQueue.then(perform);
        writeQueue = next.then(() => undefined, () => undefined);
        json(res, 201, await next); return;
      }
      if (req.method === "POST" && pathname === `${issuePath}/comments`) {
        const body = await bodyOf(req);
        if (Object.keys(body).some((key) => key !== "body" && key !== "clientRequestId")
          || typeof body.body !== "string" || !body.body.trim()
          || (body.clientRequestId !== undefined && (typeof body.clientRequestId !== "string" || !UUID.test(body.clientRequestId)))) {
          json(res, 400, { error: "unsupported comment payload" }); return;
        }
        const perform = async () => {
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          if (sourceDispositionConfirmed) throw new Error("source run already completed or handed off");
          const intent = await input.intentStore.pending(input.claim.runId, input.claim.issueId,
            body.body as string, body.clientRequestId as string | undefined);
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          let saved: unknown;
          try {
            saved = await input.client.addLocalRunComment(lease, input.claim.issueId, intent.body,
              intent.clientRequestId, input.signal);
          } catch {
            throw new UnresolvedCommentIntentError(intent.clientRequestId);
          }
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
        const perform = async () => {
          if (closed || input.signal.aborted) throw new Error("local run cancelled");
          if (sourceDispositionConfirmed) throw new Error("source run already completed or handed off");
          return input.client.patchLocalRunIssue(lease, input.claim.issueId, patch, input.signal);
        };
        const next = writeQueue.then(perform);
        void next.catch(() => { failedFieldWrite = true; });
        writeQueue = next.then(() => undefined, () => undefined);
        json(res, 200, await next); return;
      }
      json(res, 403, { error: "operation unavailable for local run" });
    } catch (error) {
      if (error instanceof UnresolvedCommentIntentError) {
        json(res, 409, { error: error.message, clientRequestId: error.clientRequestId }); return;
      }
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
    decisionConfirmed: () => reviewDecisionConfirmed,
    writeFailed: () => failedFieldWrite,
    async close() {
      closing = true;
      try {
        // A model may exit before its final comment receives a response. Let
        // already accepted writes settle before the run reports success.
        if (!input.signal.aborted) {
          await writeQueue;
          await input.intentStore.assertNoPending();
        }
      } finally {
        closed = true;
        input.signal.removeEventListener("abort", onAbort);
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
