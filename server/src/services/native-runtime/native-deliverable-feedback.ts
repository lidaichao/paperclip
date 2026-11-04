import { and, eq } from "drizzle-orm";
import { assets, issueAttachments, issueWorkProducts, type Db } from "@paperclipai/db";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

function evidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && typeof entry.ref === "string") return [entry.ref];
    return [];
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function hasCurrentPublicationReceipt(db: Db, companyId: string, receipts: unknown, attachment: {
  id: string; filename: string | null; byteSize: number; sha256: string;
}): Promise<boolean> {
  for (const value of Object.values(record(receipts))) {
    const receipt = record(value);
    const input = record(receipt.input);
    const result = record(receipt.result);
    if ((result.disposition !== "applied" && result.disposition !== "duplicate") ||
        !Array.isArray(result.entityRefs) || result.entityRefs[0] !== attachment.id) continue;
    if (receipt.operationId === "register_deliverable" &&
        result.commandId === `deliverable-prepared:${attachment.id}` &&
        typeof input.filename === "string" && input.filename.trim() === attachment.filename &&
        input.byteSize === attachment.byteSize &&
        typeof input.sha256 === "string" && input.sha256.trim().toLowerCase() === attachment.sha256.toLowerCase()) return true;
    if (receipt.operationId !== "reuse_chat_attachment" ||
        result.commandId !== `chat-attachment-reused:${attachment.id}`) continue;
    const prepared = record(result.prepared);
    const source = record(result.source);
    if (prepared.attachmentId !== attachment.id ||
        source.attachmentId !== input.attachmentId || source.commentId !== input.sourceCommentId ||
        typeof prepared.sha256 !== "string" || prepared.sha256.toLowerCase() !== attachment.sha256.toLowerCase() ||
        typeof source.sha256 !== "string" || source.sha256.toLowerCase() !== attachment.sha256.toLowerCase()) continue;
    if ("filename" in prepared || "byteSize" in prepared) {
      if (prepared.filename === attachment.filename && prepared.byteSize === attachment.byteSize) return true;
      continue;
    }
    // Older committed reuse receipts contain the authenticated source and hash,
    // but not its filename/size. Only an intact, matching source can supply those
    // missing facts; this does not authorize a new reuse or bypass its tool gate.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    if (typeof source.attachmentId !== "string" || !uuid.test(source.attachmentId) ||
        typeof source.commentId !== "string" || !uuid.test(source.commentId)) continue;
    const [original] = await db.select({ filename: assets.originalFilename, byteSize: assets.byteSize, sha256: assets.sha256 })
      .from(issueAttachments).innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, companyId)))
      .where(and(eq(issueAttachments.id, source.attachmentId), eq(issueAttachments.companyId, companyId),
        eq(issueAttachments.issueCommentId, source.commentId))).limit(1);
    if (original?.filename === attachment.filename && original.byteSize === attachment.byteSize &&
        original.sha256.toLowerCase() === attachment.sha256.toLowerCase()) return true;
  }
  return false;
}

/** Recognize explicit output requests, not incidental mentions of source files.
 * The current server-bound objective is authoritative; summaries cannot invent
 * an output requirement or erase a user's request for a file.
 */
export function explicitlyRequestsFileOutput(objective: string): boolean {
  return objective.split(/(?:[.!?](?:\s|$)|\n|[;,]|\bbut\b)/iu).some(clause => {
    const file = /\b(?:files?|attachments?|downloads?|pdf|spreadsheets?|workbooks?|slide decks?|powerpoints?|docx|xlsx|csv)\b|\b[^\s/]+\.(?:md|txt|pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|svg|zip)\b/giu;
    const create = /\b(?:create|make|write|save|export|attach|send|generate|produce|prepare|provide|give|return|build)\b/iu.exec(clause);
    if (create && /\b(?:do not|don't|never|no need to)\s*$/iu.test(clause.slice(0, create.index))) return false;
    const output = create ? clause.slice(create.index + create[0].length) : "";
    const fileObject = [...output.matchAll(file)].some(match => {
      const prefix = output.slice(0, match.index);
      const suffix = output.slice(match.index + match[0].length);
      // "Create no files" is a prohibition, even though it contains a creation
      // verb. Negate this object only; another explicit output can still count.
      if (/\b(?:no|zero|without(?:\s+any)?)\s+(?:(?:new|temporary|downloadable|attached|additional)\s+)*$/iu.test(prefix)) return false;
      // "Write a summary of this PDF" names input, not a requested file.
      // Explicit export destinations still count after such input references.
      const destination = /\b(?:as|into|to)\s+(?:(?:a|an|the|new|separate|markdown|word|excel)\s+)*$/iu.test(prefix);
      if (!destination && /\b(?:of|about|on|from|using|for|with)\b/iu.test(prefix)) return false;
      if (/^files?$/iu.test(match[0]) && /^\s+(?:permissions?|systems?|formats?|names?|paths?|types?|sizes?|descriptors?)\b/iu.test(suffix)) return false;
      return true;
    });
    return fileObject ||
      (!/\b(?:no|without)\s+(?:downloadable|attached)/iu.test(clause) && /\b(?:downloadable|attached)\s+(?:file|report|document|checklist|draft)\b/iu.test(clause));
  });
}

/** Files cited as completed output must be reachable outside the agent workspace. */
export async function validateNativeDeliverableEvidence(
  db: Db,
  binding: { companyId: string; issueId: string; runId: string; objective: string; semanticToolReceipts: unknown },
  result: PrpStructuredRunResult,
): Promise<void> {
  if (result.reportedWorkDisposition !== "done") return;
  const fileRequested = explicitlyRequestsFileOutput(binding.objective);
  const artifactRefs = new Set(evidenceRefs(result.artifacts));
  const refs = new Set([
    ...evidenceRefs(result.evidence),
    ...artifactRefs,
    ...result.completionClaim.criteria.flatMap(({ evidenceRefs }) => evidenceRefs),
  ]);
  let registeredAttachment = false;
  for (const value of refs) {
    if (typeof value !== "string") continue;
    const ref = value.trim();
    const attachmentPath = /^\/api\/attachments\/([^/?#]+)\/content(?:[?#].*)?$/u.exec(ref);
    if (ref.startsWith("deliverable:") || attachmentPath) {
      const id = attachmentPath?.[1] ?? ref.slice("deliverable:".length);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
      const [attachment] = uuid.test(id)
        ? await db.select({ id: issueAttachments.id, originatingRunId: issueAttachments.originatingRunId,
            filename: assets.originalFilename, byteSize: assets.byteSize, sha256: assets.sha256 }).from(issueAttachments)
            .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, binding.companyId)))
            .where(and(eq(issueAttachments.id, id), eq(issueAttachments.companyId, binding.companyId), eq(issueAttachments.issueId, binding.issueId)))
            .limit(1)
        : [];
      if (!attachment) {
        throw new Error("完成报告引用的附件未登记在此任务中。请对请求的文件使用 register_deliverable，并引用回执中的 deliverable:<attachmentId>。Alice 未创建人工完成审批。");
      }
      // A prior output (or user input) can be useful context, but does not prove
      // this run published the newly requested output. The receipt survives a
      // controller restart of this run; a replacement can re-register preserved
      // workspace bytes internally rather than asking the user to confirm them.
      if (fileRequested && attachment.originatingRunId !== binding.runId) continue;
      if (fileRequested && !await hasCurrentPublicationReceipt(db, binding.companyId, binding.semanticToolReceipts, attachment)) {
        throw new Error("此附件没有与本次运行请求输出匹配的已验证发布回执。请检查保留的文件，并使用 register_deliverable 验证其当前文件名、大小和 SHA-256，然后引用新回执。Alice 未创建人工完成审批。");
      }
      registeredAttachment = true;
      continue;
    }
    // URLs and typed durable refs are not workspace paths. Verification commands
    // belong in verification; do not scan prose or upload files named by a model.
    const localFile = /^(?:file:|\.{0,2}\/|[a-z]:[\\/])/iu.test(ref)
      || (!/^[a-z][a-z0-9+.-]*:/iu.test(ref) && /^[^\r\n]+\.[a-z0-9]{1,16}(?::\d+(?::\d+)?)?$/iu.test(ref));
    if (localFile && (fileRequested || artifactRefs.has(value))) {
      throw new Error("完成报告引用了用户无法下载的工作区内部文件。结束前，请对请求的文件输出使用 register_deliverable，引用回执中的 deliverable:<attachmentId>，并以 /api/attachments/<attachmentId>/content 作为下载链接。仓库变更应改为引用可访问的 PR 或已登记工作产物。Alice 未创建人工完成审批。");
    }
  }
  if (fileRequested && !registeredAttachment) {
    const products = refs.size ? await db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, binding.companyId), eq(issueWorkProducts.issueId, binding.issueId),
    )) : [];
    const accessibleProduct = products.some(product => {
      if (product.createdByRunId !== binding.runId) return false;
      if (["failed", "cancelled", "archived"].includes(product.status)) return false;
      // A workspace_file resource is only a locator: registration neither checks
      // its current bytes nor keeps them alive after workspace cleanup. Requested
      // files need a published URL or the verified attachment receipt above.
      const accessible = typeof product.url === "string" && /^https?:\/\//iu.test(product.url);
      return accessible && [product.url, `work_product:${product.id}`, `work-product:${product.id}`, `artifact:${product.id}`]
        .some(ref => typeof ref === "string" && refs.has(ref));
    });
    if (!accessibleProduct) throw new Error("请求的文件没有可访问的交付证据。请使用 register_deliverable 并引用 deliverable:<attachmentId>，或引用本次运行在此任务中登记的可访问工作产物。空证据、先前运行的输出和验证结果都不能替代请求的文件。请继续发布，或报告具体阻碍；Alice 未创建人工完成审批。");
  }
}
