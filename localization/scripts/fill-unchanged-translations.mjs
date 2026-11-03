import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot as root } from "./paths.mjs";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const proxyArg = process.argv.find((arg) => arg.startsWith("--proxy="));
const proxy = proxyArg?.slice("--proxy=".length) || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";

const uiEnPath = path.join(root, "ui/src/i18n/locales/en.json");
const uiZhPath = path.join(root, "ui/src/i18n/locales/zh-CN.json");
const catalogZhPath = path.join(root, "localization/locale/zh-CN/catalog.json");
const checkpointPath = path.join(root, "localization/integration/translation-checkpoint.json");

const [uiEn, uiZh, catalogZh] = await Promise.all(
  [uiEnPath, uiZhPath, catalogZhPath].map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))),
);

const manualOverrides = {
  assignee_5e20d20e: "负责人",
  connectors_c3d2e79e: "连接器",
  loading_organization_0dc16abf: "正在加载组织",
  loading_organization_access_d853e542: "正在加载组织权限……",
  loading_organizations_a47e333d: "正在加载组织……",
  originating_28d9df90: "发起人",
  share_feedback_2af56867: "反馈",
  app_id_3c2f1e20: "应用 ID",
  client_id_8726db01: "客户端 ID",
  client_secret_ae21cf6d: "客户端密钥",
  in_telegram_df102afb: "在 Telegram 中",
  signing_secret_f5e81453: "签名密钥",
};

const exactPreserve = new Set([
  "Alice",
  "AgentMail",
  "API",
  "AWS",
  "Azure",
  "Claude",
  "Codex",
  "CSV",
  "Cursor",
  "Discord",
  "Docker",
  "GitHub",
  "GitLab",
  "Gmail",
  "Google",
  "Hermes",
  "HTML",
  "HTTP",
  "HTTPS",
  "Jira",
  "JSON",
  "Kubernetes",
  "Markdown",
  "MCP",
  "Notion",
  "OAuth",
  "OpenAI",
  "OpenClaw",
  "OpenCode",
  "PDF",
  "PostgreSQL",
  "Python",
  "Redis",
  "S3",
  "SDK",
  "Slack",
  "SQL",
  "SSH",
  "Telegram",
  "Teams",
  "TypeScript",
  "URL",
  "UUID",
  "WebSocket",
  "Windows",
  "XML",
  "YAML",
  "ZIP",
  "ACPX Claude",
  "AWS AgentCore",
  "Claude (ACPX)",
  "Claude CLI",
  "Esc",
  "Gemini CLI",
  "GitHub ID",
  "GitHub Webhook",
  "HTTP Webhook",
  "IssueReferencePill",
  "Linux",
  "macOS",
  "OpenCode 1.18.32",
  "Pi",
  "Webhook",
  "g f",
]);

const protectedTerms = [
  ...exactPreserve,
  "Application ID",
  "App ID",
  "Client ID",
  "Client Secret",
  "Tenant ID",
  "Bot Token",
  "Signing Secret",
  "Paperclip Runner",
].sort((a, b) => b.length - a.length);

function visibleEnglish(value) {
  return value
    .replace(/\{\{[^{}]+\}\}/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\b[A-Z][A-Z0-9_]{1,}\b/g, "")
    .replace(/[ZXQV\d_{}$@./:+-]/g, "");
}

function shouldTranslate(value) {
  if (typeof value !== "string" || uiEn.local === undefined) return false;
  const trimmed = value.trim();
  if (!trimmed || exactPreserve.has(trimmed)) return false;
  const letters = visibleEnglish(trimmed).match(/[A-Za-z]/g) ?? [];
  if (letters.length < 2) return false;
  if (/^(?:https?:|mailto:|artifact:|[A-Za-z]:\\|\.?\.?\/|~\/)/.test(trimmed)) return false;
  if (/^(?:bash|pnpm|POST|ssh[. ])\b/.test(trimmed)) return false;
  if (/^[A-Z0-9_./:+-]{2,}$/.test(trimmed)) return false;
  if (/^<[^>]+>$/.test(trimmed)) return false;
  if (/^[-\w./:@{}$]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|sh|ps1|css|html|png|svg|zip)$/i.test(trimmed)) return false;
  if (/^[a-z][a-z0-9_.:/-]*$/.test(trimmed) && !new Set([
    "active", "add", "all", "allow", "archive", "back", "blocked", "cancel", "close",
    "completed", "connected", "continue", "copy", "create", "delete", "disabled", "done",
    "edit", "enabled", "error", "failed", "healthy", "loading", "new", "next", "none",
    "open", "paused", "pending", "remove", "retry", "run", "running", "save", "search",
    "settings", "skip", "stop", "success", "update", "view",
  ]).has(trimmed)) return false;
  return true;
}

function polishTranslation(english, chinese) {
  let value = chinese;
  if (/\bagents?\b/i.test(english)) value = value.replaceAll("代理商", "智能体").replaceAll("代理人", "智能体").replaceAll("代理", "智能体");
  if (/\bsecrets?\b/i.test(english)) value = value.replaceAll("秘密", "密钥");
  if (/\bboards?\b/i.test(english)) value = value.replaceAll("董事会", "管理方");
  if (/\bworkspaces?\b/i.test(english)) value = value.replaceAll("工作空间", "工作区");
  if (/\btokens?\b/i.test(english)) value = value.replaceAll("代币", "令牌").replaceAll("不记名令牌", "Bearer 令牌");
  if (/\bpull requests?\b/i.test(english)) value = value.replaceAll("拉取请求", "PR");
  if (/\bPR\b/.test(english)) value = value.replaceAll("公关", "PR");
  if (/\bchannels?\b/i.test(english)) value = value.replaceAll("通道", "频道");
  return value;
}

function protect(value) {
  const tokens = [];
  const tokenMarker = (index) => {
    let current = index;
    let letters = "";
    do {
      letters = String.fromCharCode(65 + (current % 26)) + letters;
      current = Math.floor(current / 26) - 1;
    } while (current >= 0);
    return `ZXQTK${letters}KQZ`;
  };
  const keep = (text) => {
    const marker = tokenMarker(tokens.length);
    tokens.push(text);
    return marker;
  };

  let result = value
    .replace(/\{\{[^{}]+\}\}/g, keep)
    .replace(/`[^`]*`/g, keep)
    .replace(/https?:\/\/[^\s)\]}]+/g, keep)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, keep);

  for (const term of protectedTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "g"), keep);
  }
  return { result, tokens, tokenMarker };
}

function restore(value, tokens, tokenMarker) {
  let result = value;
  tokens.forEach((token, index) => {
    result = result.replaceAll(tokenMarker(index), token);
  });
  return result.trimEnd();
}

const interpolationTokens = (value) => [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]).sort();

function translationIsSafe(source, translated) {
  if (typeof translated !== "string" || (source.trim() && !translated.trim())) return false;
  if (/ZXQ(?:ROW|TOKEN|TK)/.test(translated)) return false;
  if (!source.includes("\n") && translated.includes("\n")) return false;
  return JSON.stringify(interpolationTokens(source)) === JSON.stringify(interpolationTokens(translated));
}

function translateOne({ key, value }) {
  const { result, tokens, tokenMarker } = protect(value);
  const translated = restore(curlTranslate(result), tokens, tokenMarker);
  if (!translationIsSafe(value, translated)) throw new Error(`unsafe single-row translation for ${key}`);
  return { key, value: translated };
}

function curlTranslateFrom(query, endpoint) {
  const curlArgs = [
    "--silent", "--show-error", "--ssl-no-revoke",
    "--http1.1", "--connect-timeout", "8", "--max-time", "25",
    "--retry", "2", "--retry-all-errors", "--retry-delay", "1",
  ];
  if (proxy) curlArgs.push("-x", proxy);
  curlArgs.push(
    "--get",
    "--data-urlencode", "client=gtx",
    "--data-urlencode", "sl=en",
    "--data-urlencode", "tl=zh-CN",
    "--data-urlencode", "dt=t",
    "--data-urlencode", `q=${query}`,
    endpoint,
  );

  const result = spawnSync(process.platform === "win32" ? "curl.exe" : "curl", curlArgs, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || `curl exited ${result.status}`);
  const payload = JSON.parse(result.stdout);
  return payload[0].map((segment) => segment[0]).join("");
}

function curlTranslate(query) {
  const endpoints = [
    "https://translate.google.com/translate_a/single",
    "https://translate.googleapis.com/translate_a/single",
  ];
  const failures = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const endpoint = endpoints[attempt % endpoints.length];
    try {
      return curlTranslateFrom(query, endpoint);
    } catch (error) {
      failures.push(`${new URL(endpoint).hostname}: ${error.message.trim()}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 * (attempt + 1));
    }
  }
  throw new Error(failures.join(" | "));
}

function translateBatch(batch) {
  const prepared = batch.map(({ key, value }, index) => {
    const { result, tokens, tokenMarker } = protect(value);
    return { key, value, index, tokens, tokenMarker, line: `ZXQROW${String(index).padStart(4, "0")}ZXQ ${result}` };
  });
  const translated = curlTranslate(prepared.map((entry) => entry.line).join("\n"));
  const found = new Map();
  const pattern = /ZXQROW(\d{4})ZXQ\s*([\s\S]*?)(?=ZXQROW\d{4}ZXQ|$)/g;
  for (const match of translated.matchAll(pattern)) found.set(Number(match[1]), match[2].replace(/^\s+/, "").replace(/\s+$/, ""));
  if (found.size !== prepared.length) throw new Error(`batch marker mismatch: expected ${prepared.length}, received ${found.size}`);
  return prepared.map((entry) => {
    const value = restore(found.get(entry.index), entry.tokens, entry.tokenMarker);
    return translationIsSafe(entry.value, value) ? { key: entry.key, value } : translateOne(entry);
  });
}

const repairedKeys = [];
for (const key of Object.keys(uiEn.local)) {
  const translatedValue = uiZh.local[key];
  if (typeof translatedValue !== "string") continue;
  const hasLeakedMarker = /ZXQ(?:ROW|TOKEN|TK)/.test(translatedValue);
  const placeholdersMatch = JSON.stringify(interpolationTokens(uiEn.local[key])) === JSON.stringify(interpolationTokens(translatedValue));
  if (!hasLeakedMarker && placeholdersMatch) continue;
  uiZh.local[key] = uiEn.local[key];
  catalogZh[`local.${key}`] = uiEn.local[key];
  repairedKeys.push(key);
}

const rows = Object.keys(uiEn.local)
  .filter((key) => uiEn.local[key] === uiZh.local[key] && shouldTranslate(uiEn.local[key]))
  .map((key) => ({ key, value: uiEn.local[key] }));

let checkpoint = {};
try {
  checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const translated = new Map([...Object.entries(checkpoint), ...Object.entries(manualOverrides)]);
const pending = rows.filter(({ key }) => !translated.has(key));

if (!apply) {
  console.log(JSON.stringify({ unchanged: Object.keys(uiEn.local).filter((key) => uiEn.local[key] === uiZh.local[key]).length, candidates: rows.length, repairedKeys: repairedKeys.length, checkpointed: Object.keys(checkpoint).length, manualOverrides: Object.keys(manualOverrides).length, pending: pending.length }, null, 2));
  process.exit(0);
}

let cursor = 0;
while (cursor < pending.length) {
  const batch = [];
  let characters = 0;
  while (cursor < pending.length && batch.length < 20) {
    const row = pending[cursor];
    if (batch.length > 0 && characters + row.value.length > 2800) break;
    batch.push(row);
    characters += row.value.length;
    cursor += 1;
  }

  let results;
  try {
    results = translateBatch(batch);
  } catch (error) {
    console.warn(`Batch failed at ${cursor - batch.length}: ${error.message}; retrying one row at a time.`);
    results = batch.map((row) => translateOne(row));
  }
  for (const entry of results) translated.set(entry.key, entry.value);
  await fs.writeFile(checkpointPath, `${JSON.stringify(Object.fromEntries(translated), null, 2)}\n`);
  if (cursor % 200 < batch.length || cursor === pending.length) console.log(`translated ${cursor}/${pending.length}`);
}

for (const [key, value] of translated) {
  if (!(key in uiZh.local)) continue;
  uiZh.local[key] = value;
  catalogZh[`local.${key}`] = value;
}

let polished = 0;
for (const key of Object.keys(uiEn.local)) {
  if (typeof uiZh.local[key] !== "string") continue;
  const next = polishTranslation(uiEn.local[key], uiZh.local[key]);
  if (next === uiZh.local[key]) continue;
  uiZh.local[key] = next;
  catalogZh[`local.${key}`] = next;
  polished += 1;
}

await Promise.all([
  fs.writeFile(uiZhPath, `${JSON.stringify(uiZh, null, 2)}\n`),
  fs.writeFile(catalogZhPath, `${JSON.stringify(catalogZh, null, 2)}\n`),
]);
await fs.rm(checkpointPath, { force: true });

console.log(JSON.stringify({ applied: translated.size, machineTranslated: translated.size - Object.keys(manualOverrides).length, manualOverrides: Object.keys(manualOverrides).length, repairedKeys: repairedKeys.length, polished }, null, 2));
