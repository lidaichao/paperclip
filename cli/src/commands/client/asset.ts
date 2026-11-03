import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  inferContentTypeFromPath,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AssetOptions extends BaseClientOptions {
  companyId?: string;
  file?: string;
  namespace?: string;
  alt?: string;
  title?: string;
  out?: string;
}

export function registerAssetCommands(program: Command): void {
  const asset = program.command("asset").description("资源操作");

  addCommonClientOptions(
    asset
      .command("image:upload")
      .description("上传公司图片资源")
      .requiredOption("--file <path>", "图片文件路径")
      .option("-C, --company-id <id>", "公司编号")
      .option("--namespace <value>", "资源命名空间后缀")
      .option("--alt <text>", "替代文本元数据")
      .option("--title <text>", "标题元数据")
      .action(async (opts: AssetOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await uploadAsset(ctx.api.apiBase, ctx.api.apiKey, apiPath`/api/companies/${ctx.companyId}/assets/images`, opts);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    asset
      .command("logo:upload")
      .description("上传公司标志")
      .requiredOption("--file <path>", "标志文件路径")
      .option("-C, --company-id <id>", "公司编号")
      .action(async (opts: AssetOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await uploadAsset(ctx.api.apiBase, ctx.api.apiKey, apiPath`/api/companies/${ctx.companyId}/logo`, opts);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    asset
      .command("content")
      .description("下载资源内容")
      .argument("<assetId>", "资源编号")
      .option("--out <path>", "将内容写入文件，而不是标准输出")
      .action(async (assetId: string, opts: AssetOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const bytes = await downloadAsset(ctx.api.apiBase, ctx.api.apiKey, assetId);
          if (opts.out?.trim()) {
            await writeFile(opts.out, bytes);
            printOutput({ ok: true, out: opts.out, bytes: bytes.length }, { json: ctx.json });
            return;
          }
          process.stdout.write(bytes);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

async function uploadAsset(
  apiBase: string,
  apiKey: string | undefined,
  path: string,
  opts: AssetOptions,
): Promise<unknown> {
  if (!opts.file?.trim()) {
    throw new Error("必须提供 --file");
  }
  const bytes = await readFile(opts.file);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: inferContentTypeFromPath(opts.file) }), opts.file.split(/[\\/]/).pop() ?? "asset");
  if (opts.namespace?.trim()) form.set("namespace", opts.namespace.trim());
  if (opts.alt?.trim()) form.set("alt", opts.alt.trim());
  if (opts.title?.trim()) form.set("title", opts.title.trim());

  const response = await fetch(buildApiUrl(apiBase, path), {
    method: "POST",
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    body: form,
  });
  return parseFetchResponse(response);
}

async function downloadAsset(apiBase: string, apiKey: string | undefined, assetId: string): Promise<Buffer> {
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/assets/${assetId}/content`), {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) {
    await parseFetchResponse(response);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function parseFetchResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = text.trim() ? safeJson(text) : null;
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `请求失败，状态码：${response.status}`;
    throw new ApiRequestError(response.status, message, undefined, parsed);
  }
  return parsed;
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
