import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { Command } from "commander";
import type { Company, FeedbackTrace, FeedbackTraceBundle } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

interface FeedbackFilterOptions extends BaseClientOptions {
  targetType?: string;
  vote?: string;
  status?: string;
  projectId?: string;
  issueId?: string;
  from?: string;
  to?: string;
  sharedOnly?: boolean;
}

export interface FeedbackTraceQueryOptions {
  targetType?: string;
  vote?: string;
  status?: string;
  projectId?: string;
  issueId?: string;
  from?: string;
  to?: string;
  sharedOnly?: boolean;
}

interface FeedbackReportOptions extends FeedbackFilterOptions {
  payloads?: boolean;
}

interface FeedbackExportOptions extends FeedbackFilterOptions {
  out?: string;
}

interface FeedbackSummary {
  total: number;
  thumbsUp: number;
  thumbsDown: number;
  withReason: number;
  statuses: Record<string, number>;
}

interface FeedbackExportManifest {
  exportedAt: string;
  serverUrl: string;
  companyId: string;
  summary: FeedbackSummary & {
    uniqueIssues: number;
    issues: string[];
  };
  files: {
    votes: string[];
    traces: string[];
    fullTraces: string[];
    zip: string;
  };
}

interface FeedbackExportResult {
  outputDir: string;
  zipPath: string;
  manifest: FeedbackExportManifest;
}

export function registerFeedbackCommands(program: Command): void {
  const feedback = program.command("feedback").description("查看并导出本地反馈记录");

  addCommonClientOptions(
    feedback
      .command("report")
      .description("在终端生成公司反馈记录报告")
      .option("-C, --company-id <id>", "公司 ID（覆盖上下文默认值）")
      .option("--target-type <type>", "按目标类型筛选")
      .option("--vote <vote>", "按评价结果筛选")
      .option("--status <status>", "按记录状态筛选")
      .option("--project-id <id>", "按项目 ID 筛选")
      .option("--issue-id <id>", "按任务 ID 筛选")
      .option("--from <iso8601>", "只包含此时间及之后创建的记录")
      .option("--to <iso8601>", "只包含此时间及之前创建的记录")
      .option("--shared-only", "只包含允许共享或导出的记录")
      .option("--payloads", "在终端报告中包含原始数据", false)
      .action(async (opts: FeedbackReportOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const companyId = await resolveFeedbackCompanyId(ctx, opts.companyId);
          const traces = await fetchCompanyFeedbackTraces(ctx, companyId, opts);
          const summary = summarizeFeedbackTraces(traces);
          if (ctx.json) {
            printOutput(
              {
                apiBase: ctx.api.apiBase,
                companyId,
                summary,
                traces,
              },
              { json: true },
            );
            return;
          }
          console.log(renderFeedbackReport({
            apiBase: ctx.api.apiBase,
            companyId,
            traces,
            summary,
            includePayloads: Boolean(opts.payloads),
          }));
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    feedback
      .command("export")
      .description("将反馈评价和原始记录包导出到文件夹及压缩包")
      .option("-C, --company-id <id>", "公司 ID（覆盖上下文默认值）")
      .option("--target-type <type>", "按目标类型筛选")
      .option("--vote <vote>", "按评价结果筛选")
      .option("--status <status>", "按记录状态筛选")
      .option("--project-id <id>", "按项目 ID 筛选")
      .option("--issue-id <id>", "按任务 ID 筛选")
      .option("--from <iso8601>", "只包含此时间及之后创建的记录")
      .option("--to <iso8601>", "只包含此时间及之前创建的记录")
      .option("--shared-only", "只包含允许共享或导出的记录")
      .option("--out <path>", "输出目录（默认：./feedback-export-<时间戳>）")
      .action(async (opts: FeedbackExportOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const companyId = await resolveFeedbackCompanyId(ctx, opts.companyId);
          const traces = await fetchCompanyFeedbackTraces(ctx, companyId, opts);
          const outputDir = path.resolve(opts.out?.trim() || defaultFeedbackExportDirName());
          const exported = await writeFeedbackExportBundle({
            apiBase: ctx.api.apiBase,
            companyId,
            traces,
            outputDir,
            traceBundleFetcher: (trace) => fetchFeedbackTraceBundle(ctx, trace.id),
          });
          if (ctx.json) {
            printOutput(
              {
                companyId,
                outputDir: exported.outputDir,
                zipPath: exported.zipPath,
                summary: exported.manifest.summary,
              },
              { json: true },
            );
            return;
          }
          console.log(renderFeedbackExportSummary(exported));
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    feedback
      .command("trace")
      .description("获取一条反馈记录")
      .argument("<traceId>", "反馈记录 ID")
      .action(async (traceId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/feedback-traces/${traceId}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    feedback
      .command("bundle")
      .description("获取反馈记录包")
      .argument("<traceId>", "反馈记录 ID")
      .action(async (traceId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/feedback-traces/${traceId}/bundle`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

export async function resolveFeedbackCompanyId(
  ctx: ResolvedClientContext,
  explicitCompanyId?: string,
): Promise<string> {
  const direct = explicitCompanyId?.trim() || ctx.companyId?.trim();
  if (direct) return direct;
  const companies = (await ctx.api.get<Company[]>("/api/companies")) ?? [];
  const companyId = companies[0]?.id?.trim();
  if (!companyId) {
    throw new Error(
      "必须提供公司 ID。请传入 --company-id、设置 PAPERCLIP_COMPANY_ID，或配置命令行上下文默认值。",
    );
  }
  return companyId;
}

export function buildFeedbackTraceQuery(opts: FeedbackTraceQueryOptions, includePayload = true): string {
  const params = new URLSearchParams();
  if (opts.targetType) params.set("targetType", opts.targetType);
  if (opts.vote) params.set("vote", opts.vote);
  if (opts.status) params.set("status", opts.status);
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (opts.issueId) params.set("issueId", opts.issueId);
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  if (opts.sharedOnly) params.set("sharedOnly", "true");
  if (includePayload) params.set("includePayload", "true");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function normalizeFeedbackTraceExportFormat(value: string | undefined): "json" | "ndjson" {
  if (!value || value === "ndjson") return "ndjson";
  if (value === "json") return "json";
  throw new Error(`不支持的导出格式：${value}`);
}

export function serializeFeedbackTraces(traces: FeedbackTrace[], format: string | undefined): string {
  if (normalizeFeedbackTraceExportFormat(format) === "json") {
    return JSON.stringify(traces, null, 2);
  }
  return traces.map((trace) => JSON.stringify(trace)).join("\n");
}

export async function fetchCompanyFeedbackTraces(
  ctx: ResolvedClientContext,
  companyId: string,
  opts: FeedbackFilterOptions,
): Promise<FeedbackTrace[]> {
  return (
    (await ctx.api.get<FeedbackTrace[]>(
      `${apiPath`/api/companies/${companyId}/feedback-traces`}${buildFeedbackTraceQuery(opts, true)}`,
    )) ?? []
  );
}

export async function fetchFeedbackTraceBundle(
  ctx: ResolvedClientContext,
  traceId: string,
): Promise<FeedbackTraceBundle> {
  const bundle = await ctx.api.get<FeedbackTraceBundle>(apiPath`/api/feedback-traces/${traceId}/bundle`);
  if (!bundle) {
    throw new Error(`未找到反馈记录包 ${traceId}`);
  }
  return bundle;
}

export function summarizeFeedbackTraces(traces: FeedbackTrace[]): FeedbackSummary {
  const statuses: Record<string, number> = {};
  let thumbsUp = 0;
  let thumbsDown = 0;
  let withReason = 0;

  for (const trace of traces) {
    if (trace.vote === "up") thumbsUp += 1;
    if (trace.vote === "down") thumbsDown += 1;
    if (readFeedbackReason(trace)) withReason += 1;
    statuses[trace.status] = (statuses[trace.status] ?? 0) + 1;
  }

  return {
    total: traces.length,
    thumbsUp,
    thumbsDown,
    withReason,
    statuses,
  };
}

export function renderFeedbackReport(input: {
  apiBase: string;
  companyId: string;
  traces: FeedbackTrace[];
  summary: FeedbackSummary;
  includePayloads: boolean;
}): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(pc.bold(pc.magenta("Alice 反馈报告")));
  lines.push(pc.dim(new Date().toISOString()));
  lines.push(horizontalRule());
  lines.push(`${pc.dim("服务器：")} ${input.apiBase}`);
  lines.push(`${pc.dim("公司：")}   ${input.companyId}`);
  lines.push("");

  if (input.traces.length === 0) {
    lines.push(pc.yellow("[!!] 未找到反馈记录。"));
    lines.push("");
    return lines.join("\n");
  }

  lines.push(pc.bold(pc.cyan("汇总")));
  lines.push(horizontalRule());
  lines.push(`  ${pc.green(pc.bold(String(input.summary.thumbsUp)))}  好评`);
  lines.push(`  ${pc.red(pc.bold(String(input.summary.thumbsDown)))}  差评`);
  lines.push(`  ${pc.yellow(pc.bold(String(input.summary.withReason)))}  附带原因的差评`);
  lines.push(`  ${pc.bold(String(input.summary.total))}  记录总数`);
  lines.push("");
  lines.push(pc.dim("导出状态："));
  for (const [status, label] of [["pending", "待处理"], ["sent", "已发送"], ["local_only", "仅本地"], ["failed", "失败"]] as const) {
    lines.push(`  ${padRight(label, 10)} ${input.summary.statuses[status] ?? 0}`);
  }
  lines.push("");
  lines.push(pc.bold(pc.cyan("记录详情")));
  lines.push(horizontalRule());

  for (const trace of input.traces) {
    const voteColor = trace.vote === "up" ? pc.green : pc.red;
    const voteIcon = trace.vote === "up" ? "^" : "v";
    const issueRef = trace.issueIdentifier ?? trace.issueId;
    const label = trace.targetSummary.label?.trim() || trace.targetType;
    const excerpt = compactText(trace.targetSummary.excerpt);
    const reason = readFeedbackReason(trace);
    lines.push(
      `  ${voteColor(voteIcon)} ${pc.bold(issueRef)} ${pc.dim(compactText(trace.issueTitle, 64))}`,
    );
    lines.push(
      `    ${pc.dim("记录：")} ${trace.id.slice(0, 8)}  ${pc.dim("状态：")} ${trace.status}  ${pc.dim("日期：")} ${formatTimestamp(trace.createdAt)}`,
    );
    lines.push(`    ${pc.dim("目标：")} ${label}`);
    if (excerpt) {
      lines.push(`    ${pc.dim("摘要：")} ${excerpt}`);
    }
    if (reason) {
      lines.push(`    ${pc.yellow(pc.bold("原因："))} ${pc.yellow(reason)}`);
    }
    lines.push("");
  }

  if (input.includePayloads) {
    lines.push(pc.bold(pc.cyan("原始数据")));
    lines.push(horizontalRule());
    for (const trace of input.traces) {
      if (!trace.payloadSnapshot) continue;
      const issueRef = trace.issueIdentifier ?? trace.issueId;
      lines.push(`  ${pc.bold(`${issueRef} (${trace.id.slice(0, 8)})`)}`);
      const body = JSON.stringify(trace.payloadSnapshot, null, 2)?.split("\n") ?? [];
      for (const line of body) {
        lines.push(`    ${pc.dim(line)}`);
      }
      lines.push("");
    }
  }

  lines.push(horizontalRule());
  lines.push(pc.dim(`报告生成完成，共显示 ${input.traces.length} 条记录。`));
  lines.push("");
  return lines.join("\n");
}

export async function writeFeedbackExportBundle(input: {
  apiBase: string;
  companyId: string;
  traces: FeedbackTrace[];
  outputDir: string;
  traceBundleFetcher?: (trace: FeedbackTrace) => Promise<FeedbackTraceBundle>;
}): Promise<FeedbackExportResult> {
  await ensureEmptyOutputDirectory(input.outputDir);
  await mkdir(path.join(input.outputDir, "votes"), { recursive: true });
  await mkdir(path.join(input.outputDir, "traces"), { recursive: true });
  await mkdir(path.join(input.outputDir, "full-traces"), { recursive: true });

  const summary = summarizeFeedbackTraces(input.traces);
  const voteFiles: string[] = [];
  const traceFiles: string[] = [];
  const fullTraceDirs: string[] = [];
  const fullTraceFiles: string[] = [];
  const issueSet = new Set<string>();

  for (const trace of input.traces) {
    const issueRef = sanitizeFileSegment(trace.issueIdentifier ?? trace.issueId);
    const voteRecord = buildFeedbackVoteRecord(trace);
    const voteFileName = `${issueRef}-${trace.feedbackVoteId.slice(0, 8)}.json`;
    const traceFileName = `${issueRef}-${trace.id.slice(0, 8)}.json`;
    voteFiles.push(voteFileName);
    traceFiles.push(traceFileName);
    issueSet.add(trace.issueIdentifier ?? trace.issueId);
    await writeFile(
      path.join(input.outputDir, "votes", voteFileName),
      `${JSON.stringify(voteRecord, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(input.outputDir, "traces", traceFileName),
      `${JSON.stringify(trace, null, 2)}\n`,
      "utf8",
    );

    if (input.traceBundleFetcher) {
      const bundle = await input.traceBundleFetcher(trace);
      const bundleDirName = `${issueRef}-${trace.id.slice(0, 8)}`;
      const bundleDir = path.join(input.outputDir, "full-traces", bundleDirName);
      await mkdir(bundleDir, { recursive: true });
      fullTraceDirs.push(bundleDirName);
      await writeFile(
        path.join(bundleDir, "bundle.json"),
        `${JSON.stringify(bundle, null, 2)}\n`,
        "utf8",
      );
      fullTraceFiles.push(path.posix.join("full-traces", bundleDirName, "bundle.json"));
      for (const file of bundle.files) {
        const targetPath = path.join(bundleDir, file.path);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, file.contents, "utf8");
        fullTraceFiles.push(path.posix.join("full-traces", bundleDirName, file.path.replace(/\\/g, "/")));
      }
    }
  }

  const zipPath = `${input.outputDir}.zip`;
  const manifest: FeedbackExportManifest = {
    exportedAt: new Date().toISOString(),
    serverUrl: input.apiBase,
    companyId: input.companyId,
    summary: {
      ...summary,
      uniqueIssues: issueSet.size,
      issues: Array.from(issueSet).sort((left, right) => left.localeCompare(right)),
    },
    files: {
      votes: voteFiles.slice().sort((left, right) => left.localeCompare(right)),
      traces: traceFiles.slice().sort((left, right) => left.localeCompare(right)),
      fullTraces: fullTraceDirs.slice().sort((left, right) => left.localeCompare(right)),
      zip: path.basename(zipPath),
    },
  };

  await writeFile(
    path.join(input.outputDir, "index.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const archiveFiles = await collectJsonFilesForArchive(input.outputDir, [
    "index.json",
    ...manifest.files.votes.map((file) => path.posix.join("votes", file)),
    ...manifest.files.traces.map((file) => path.posix.join("traces", file)),
    ...fullTraceFiles,
  ]);
  await writeFile(zipPath, createStoredZipArchive(archiveFiles, path.basename(input.outputDir)));

  return {
    outputDir: input.outputDir,
    zipPath,
    manifest,
  };
}

export function renderFeedbackExportSummary(exported: FeedbackExportResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(pc.bold(pc.magenta("Alice 反馈导出")));
  lines.push(pc.dim(exported.manifest.exportedAt));
  lines.push(horizontalRule());
  lines.push(`${pc.dim("公司：")}   ${exported.manifest.companyId}`);
  lines.push(`${pc.dim("输出：")}   ${exported.outputDir}`);
  lines.push(`${pc.dim("压缩包：")} ${exported.zipPath}`);
  lines.push("");
  lines.push(pc.bold("导出汇总"));
  lines.push(horizontalRule());
  lines.push(`  ${pc.green(pc.bold(String(exported.manifest.summary.thumbsUp)))}  好评`);
  lines.push(`  ${pc.red(pc.bold(String(exported.manifest.summary.thumbsDown)))}  差评`);
  lines.push(`  ${pc.yellow(pc.bold(String(exported.manifest.summary.withReason)))}  附带原因`);
  lines.push(`  ${pc.bold(String(exported.manifest.summary.uniqueIssues))}  个不同任务`);
  lines.push("");
  lines.push(pc.dim("文件："));
  lines.push(`  ${path.join(exported.outputDir, "index.json")}`);
  lines.push(`  ${path.join(exported.outputDir, "votes")}（${exported.manifest.files.votes.length} 个文件）`);
  lines.push(`  ${path.join(exported.outputDir, "traces")}（${exported.manifest.files.traces.length} 个文件）`);
  lines.push(`  ${path.join(exported.outputDir, "full-traces")}（${exported.manifest.files.fullTraces.length} 个记录包）`);
  lines.push(`  ${exported.zipPath}`);
  lines.push("");
  return lines.join("\n");
}

function readFeedbackReason(trace: FeedbackTrace): string | null {
  const payload = asRecord(trace.payloadSnapshot);
  const vote = asRecord(payload?.vote);
  const reason = vote?.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

function buildFeedbackVoteRecord(trace: FeedbackTrace) {
  return {
    voteId: trace.feedbackVoteId,
    traceId: trace.id,
    issueId: trace.issueId,
    issueIdentifier: trace.issueIdentifier,
    issueTitle: trace.issueTitle,
    vote: trace.vote,
    targetType: trace.targetType,
    targetId: trace.targetId,
    targetSummary: trace.targetSummary,
    status: trace.status,
    consentVersion: trace.consentVersion,
    createdAt: trace.createdAt,
    updatedAt: trace.updatedAt,
    reason: readFeedbackReason(trace),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactText(value: string | null | undefined, maxLength = 88): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function formatTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  if (typeof value === "string") return value.slice(0, 19).replace("T", " ");
  return "-";
}

function horizontalRule(): string {
  return pc.dim("-".repeat(72));
}

function padRight(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - value.length))}`;
}

function defaultFeedbackExportDirName(): string {
  const iso = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `feedback-export-${iso}`;
}

async function ensureEmptyOutputDirectory(outputDir: string): Promise<void> {
  try {
    const info = await stat(outputDir);
    if (!info.isDirectory()) {
      throw new Error(`输出路径已存在且不是目录：${outputDir}`);
    }
    const entries = await readdir(outputDir);
    if (entries.length > 0) {
      throw new Error(`输出目录已存在且不为空：${outputDir}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/ENOENT/.test(message)) {
      await mkdir(outputDir, { recursive: true });
      return;
    }
    throw error;
  }
}

async function collectJsonFilesForArchive(
  outputDir: string,
  relativePaths: string[],
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const relativePath of relativePaths) {
    const normalized = relativePath.replace(/\\/g, "/");
    files[normalized] = await readFile(path.join(outputDir, normalized), "utf8");
  }
  return files;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "feedback";
}

function writeUint16(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZipArchive(files: Record<string, string>, rootPath: string): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;
  let entryCount = 0;

  for (const [relativePath, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    const fileName = encoder.encode(`${rootPath}/${relativePath}`);
    const body = encoder.encode(content);
    const checksum = crc32(body);

    const localHeader = new Uint8Array(30 + fileName.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, body.length);
    writeUint32(localHeader, 22, body.length);
    writeUint16(localHeader, 26, fileName.length);
    localHeader.set(fileName, 30);

    const centralHeader = new Uint8Array(46 + fileName.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 0);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, body.length);
    writeUint32(centralHeader, 24, body.length);
    writeUint16(centralHeader, 28, fileName.length);
    writeUint32(centralHeader, 42, localOffset);
    centralHeader.set(fileName, 46);

    localChunks.push(localHeader, body);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + body.length;
    entryCount += 1;
  }

  const centralDirectoryLength = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(
    localChunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralDirectoryLength + 22,
  );
  let offset = 0;
  for (const chunk of localChunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  const centralDirectoryOffset = offset;
  for (const chunk of centralChunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  writeUint32(archive, offset, 0x06054b50);
  writeUint16(archive, offset + 8, entryCount);
  writeUint16(archive, offset + 10, entryCount);
  writeUint32(archive, offset + 12, centralDirectoryLength);
  writeUint32(archive, offset + 16, centralDirectoryOffset);
  return archive;
}
