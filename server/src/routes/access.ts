import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs";
import type { IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import type { Request } from "express";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  agentApiKeys,
  authUsers,
  companies,
  companyLogos,
  companyMemberships,
  instanceUserRoles,
  invites,
  joinRequests,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  acceptInviteSchema,
  createCliAuthChallengeSchema,
  claimJoinRequestApiKeySchema,
  createBoardApiKeySchema,
  createCompanyInviteSchema,
  createOpenClawInvitePromptSchema,
  listCompanyInvitesQuerySchema,
  listJoinRequestsQuerySchema,
  resolveCliAuthChallengeSchema,
  searchAdminUsersQuerySchema,
  updateCompanyMemberWithPermissionsSchema,
  updateCompanyMemberSchema,
  archiveCompanyMemberSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
  PERMISSION_KEYS,
  isUuidLike,
} from "@paperclipai/shared";
import type { DeploymentExposure, DeploymentMode, HumanCompanyMembershipRole } from "@paperclipai/shared";
import {
  forbidden,
  conflict,
  notFound,
  unauthorized,
  badRequest,
  tooManyRequests
} from "../errors.js";
import { getHiddenSettings } from "../services/settings-visibility.js";
import { runtimeCanonicalOrigin } from "../services/cloud-runtime-identity.js";

/**
 * Floor: when the hosting operator hides the Instance Access surface
 * (`instance.access` in PAPERCLIP_HIDDEN_SETTINGS), instance-admin user
 * management is rejected alongside it — user administration then belongs to
 * the operator's own control plane. Applies to the Access page's reads too;
 * invite and company-membership routes are company-scoped and stay open.
 */
function assertAccessAdminVisible() {
  if (getHiddenSettings().has("instance.access")) {
    throw forbidden("此实例的用户管理由托管方操作员负责", {
      code: "settings_operator_managed",
    });
  }
}
import {
  createInviteRateLimiter,
  type InviteRateLimiter,
} from "../services/invite-rate-limit.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { collectReachableInterfaceHosts } from "../runtime-api.js";
import {
  accessService,
  agentService,
  boardAuthService,
  deduplicateAgentName,
  logActivity,
  notifyHireApproved
} from "../services/index.js";
import {
  grantsForHumanRole,
  normalizeHumanRole,
  resolveHumanInviteRole,
} from "../services/company-member-roles.js";
import { humanJoinGrantsFromDefaults } from "../services/invite-grants.js";
import {
  collapseDuplicatePendingHumanJoinRequests,
  findReusableHumanJoinRequest,
} from "../lib/join-request-dedupe.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
import {
  claimBoardOwnership,
  inspectBoardClaimChallenge
} from "../board-claim.js";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";
import { getStorageService } from "../storage/index.js";
import { secretService } from "../services/secrets.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const INVITE_TOKEN_PREFIX = "pcp_invite_";
// 32 random bytes = 256 bits of entropy, base64url-encoded (43 chars). The
// invite token is public (anyone with the link can GET/accept the invite), so
// it must not be brute-forceable. The previous 8-char base36 suffix carried only
// ~41 bits, which is online-enumerable. The token is stored hashed (sha256) in
// `invites.tokenHash`; the raw value is only returned once on creation.
const INVITE_TOKEN_ENTROPY_BYTES = 32;
const INVITE_TOKEN_MAX_RETRIES = 5;
const COMPANY_INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const INVITE_RESOLUTION_DNS_TIMEOUT_MS = 3_000;

export function createInviteToken() {
  const suffix = randomBytes(INVITE_TOKEN_ENTROPY_BYTES).toString("base64url");
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

function createClaimSecret() {
  return `pcp_claim_${randomBytes(24).toString("hex")}`;
}

export function companyInviteExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + COMPANY_INVITE_TTL_MS);
}

function tokenHashesMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function requestBaseUrl(req: Request) {
  const forwardedProto = req.header("x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
  const host =
    req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  if (!host) return "";
  return `${proto}://${host}`;
}

function resolveBaseUrl(req: Request, authPublicBaseUrl?: string): string {
  const runtimeOrigin = runtimeCanonicalOrigin();
  if (runtimeOrigin) return runtimeOrigin;
  if (authPublicBaseUrl) return authPublicBaseUrl.replace(/\/+$/, "");
  return requestBaseUrl(req);
}

function buildCliAuthApprovalPath(challengeId: string, token: string) {
  return `/cli-auth/${challengeId}?token=${encodeURIComponent(token)}`;
}

function readSkillMarkdown(skillName: string): string | null {
  const normalized = skillName.trim().toLowerCase();
  if (!isSafeSkillName(normalized)) {
    return null;
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const claudeSkillsDir = resolveClaudeSkillsDir();
  const candidates = [
    claudeSkillsDir ? path.resolve(claudeSkillsDir, normalized, "SKILL.md") : null,
    path.resolve(moduleDir, "../../skills", normalized, "SKILL.md"), // published: dist/routes/ -> <pkg>/skills/
    path.resolve(process.cwd(), "skills", normalized, "SKILL.md"), // cwd (e.g. monorepo root)
    path.resolve(moduleDir, "../../../skills", normalized, "SKILL.md") // dev: src/routes/ -> repo root/skills/
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const skillPath of candidates) {
    try {
      return fs.readFileSync(skillPath, "utf8");
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}

function isSafeSkillName(skillName: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(skillName);
}

/** Resolve the Paperclip repo skills directory (built-in / managed skills). */
function resolvePaperclipSkillsDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../skills"),         // published
    path.resolve(process.cwd(), "skills"),           // cwd (monorepo root)
    path.resolve(moduleDir, "../../../skills"),       // dev
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* skip */ }
  }
  return null;
}

/** Parse YAML frontmatter from a SKILL.md file to extract the description. */
function parseSkillFrontmatter(markdown: string): { description: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { description: "" };
  const yaml = match[1];
  // Extract description — handles both single-line and multi-line YAML values
  const descMatch = yaml.match(
    /^description:\s*(?:>\s*\n((?:\s{2,}[^\n]*\n?)+)|[|]\s*\n((?:\s{2,}[^\n]*\n?)+)|["']?(.*?)["']?\s*$)/m
  );
  if (!descMatch) return { description: "" };
  const raw = descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "";
  return {
    description: raw
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean)
      .join(" ")
      .trim(),
  };
}

interface AvailableSkill {
  name: string;
  description: string;
  isPaperclipManaged: boolean;
}

/** Discover all available Claude Code skills from CLAUDE_HOME or ~/.claude. */
function resolveClaudeSkillsDir(): string {
  const configuredClaudeHome = process.env.CLAUDE_HOME?.trim();
  const claudeHome = configuredClaudeHome
    ? path.resolve(configuredClaudeHome)
    : path.join(process.env.HOME || process.env.USERPROFILE || "", ".claude");
  return path.join(claudeHome, "skills");
}

function listAvailableSkills(): AvailableSkill[] {
  const claudeSkillsDir = resolveClaudeSkillsDir();
  const paperclipSkillsDir = resolvePaperclipSkillsDir();

  // Build set of Paperclip-managed skill names
  const paperclipSkillNames = new Set<string>();
  if (paperclipSkillsDir) {
    try {
      for (const entry of fs.readdirSync(paperclipSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) paperclipSkillNames.add(entry.name);
      }
    } catch { /* skip */ }
  }

  const skills: AvailableSkill[] = [];

  try {
    const entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(claudeSkillsDir, entry.name, "SKILL.md");
      let description = "";
      try {
        const md = fs.readFileSync(skillMdPath, "utf8");
        description = parseSkillFrontmatter(md).description;
      } catch { /* no SKILL.md or unreadable */ }
      skills.push({
        name: entry.name,
        description,
        isPaperclipManaged: paperclipSkillNames.has(entry.name),
      });
    }
  } catch { /* Claude skills directory doesn't exist */ }

  if (paperclipSkillsDir) {
    const existingNames = new Set(skills.map((skill) => skill.name));
    try {
      for (const entry of fs.readdirSync(paperclipSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || existingNames.has(entry.name)) continue;
        const skillMdPath = path.join(paperclipSkillsDir, entry.name, "SKILL.md");
        let description = "";
        try {
          const md = fs.readFileSync(skillMdPath, "utf8");
          description = parseSkillFrontmatter(md).description;
        } catch { /* no SKILL.md or unreadable */ }
        skills.push({
          name: entry.name,
          description,
          isPaperclipManaged: true,
        });
      }
    } catch { /* skip Paperclip skills directory */ }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function toJoinRequestResponse(row: typeof joinRequests.$inferSelect) {
  const { claimSecretHash: _claimSecretHash, ...safe } = row;
  return safe;
}

type JoinDiagnostic = {
  code: string;
  level: "info" | "warn";
  message: string;
  hint?: string;
};

const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    value === "0:0:0:0:0:0:0:1" ||
    value === "127.0.0.1" ||
    /^127(?:\.\d{1,3}){3}$/.test(value)
  );
}

function normalizeHermesGatewayApiBaseUrl(url: URL): URL {
  const normalized = new URL(url.toString());
  const normalizedPath = normalized.pathname.replace(/\/+$/, "") || "/";
  if (
    normalized.port === DEFAULT_HERMES_DASHBOARD_PORT &&
    HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
  ) {
    normalized.pathname = "/api";
  }
  return normalized;
}

function isDefaultHermesDashboardRoot(url: URL): boolean {
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  return (
    url.port === DEFAULT_HERMES_DASHBOARD_PORT &&
    HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
  );
}

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1
      ? trimmed.slice(1, end).toLowerCase()
      : trimmed.toLowerCase();
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon > -1) return trimmed.slice(0, firstColon).toLowerCase();
  return trimmed.toLowerCase();
}

function normalizeHeaderValue(
  value: unknown,
  depth: number = 0
): string | null {
  const direct = nonEmptyTrimmedString(value);
  if (direct) return direct;
  if (!isPlainObject(value) || depth >= 3) return null;

  const candidateKeys = [
    "value",
    "token",
    "secret",
    "apiKey",
    "api_key",
    "auth",
    "authToken",
    "auth_token",
    "accessToken",
    "access_token",
    "authorization",
    "bearer",
    "header",
    "raw",
    "text",
    "string"
  ];
  for (const key of candidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const normalized = normalizeHeaderValue(
      (value as Record<string, unknown>)[key],
      depth + 1
    );
    if (normalized) return normalized;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [singleKey, singleValue] = entries[0];
    const normalizedKey = singleKey.trim().toLowerCase();
    if (
      normalizedKey !== "type" &&
      normalizedKey !== "version" &&
      normalizedKey !== "secretid" &&
      normalizedKey !== "secret_id"
    ) {
      const normalized = normalizeHeaderValue(singleValue, depth + 1);
      if (normalized) return normalized;
    }
  }

  return null;
}

function extractHeaderEntries(input: unknown): Array<[string, unknown]> {
  if (isPlainObject(input)) {
    return Object.entries(input);
  }
  if (!Array.isArray(input)) {
    return [];
  }

  const entries: Array<[string, unknown]> = [];
  for (const item of input) {
    if (Array.isArray(item)) {
      const key = nonEmptyTrimmedString(item[0]);
      if (!key) continue;
      entries.push([key, item[1]]);
      continue;
    }
    if (!isPlainObject(item)) continue;

    const mapped = item as Record<string, unknown>;
    const explicitKey =
      nonEmptyTrimmedString(mapped.key) ??
      nonEmptyTrimmedString(mapped.name) ??
      nonEmptyTrimmedString(mapped.header);
    if (explicitKey) {
      const explicitValue = Object.prototype.hasOwnProperty.call(
        mapped,
        "value"
      )
        ? mapped.value
        : Object.prototype.hasOwnProperty.call(mapped, "token")
        ? mapped.token
        : Object.prototype.hasOwnProperty.call(mapped, "secret")
        ? mapped.secret
        : mapped;
      entries.push([explicitKey, explicitValue]);
      continue;
    }

    const singleEntry = Object.entries(mapped);
    if (singleEntry.length === 1) {
      entries.push(singleEntry[0] as [string, unknown]);
    }
  }

  return entries;
}

function normalizeHeaderMap(
  input: unknown
): Record<string, string> | undefined {
  const entries = extractHeaderEntries(input);
  if (entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const normalizedValue = normalizeHeaderValue(value);
    if (!normalizedValue) continue;
    const trimmedKey = key.trim();
    const trimmedValue = normalizedValue.trim();
    if (!trimmedKey || !trimmedValue) continue;
    out[trimmedKey] = trimmedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function nonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function headerMapHasKeyIgnoreCase(
  headers: Record<string, string>,
  targetKey: string
): boolean {
  const normalizedTarget = targetKey.trim().toLowerCase();
  return Object.keys(headers).some(
    (key) => key.trim().toLowerCase() === normalizedTarget
  );
}

function headerMapGetIgnoreCase(
  headers: Record<string, string>,
  targetKey: string
): string | null {
  const normalizedTarget = targetKey.trim().toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.trim().toLowerCase() === normalizedTarget
  );
  if (!key) return null;
  const value = headers[key];
  return typeof value === "string" ? value : null;
}

function tokenFromAuthorizationHeader(rawHeader: string | null): string | null {
  const trimmed = nonEmptyTrimmedString(rawHeader);
  if (!trimmed) return null;
  const bearerMatch = trimmed.match(/^bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return nonEmptyTrimmedString(bearerMatch[1]);
  }
  return trimmed;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function generateEd25519PrivateKeyPem(): string {
  const generated = generateKeyPairSync("ed25519");
  return generated.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}

export function buildJoinDefaultsPayloadForAccept(input: {
  adapterType: string | null;
  defaultsPayload: unknown;
  paperclipApiUrl?: unknown;
  inboundOpenClawAuthHeader?: string | null;
  inboundOpenClawTokenHeader?: string | null;
}): unknown {
  if (input.adapterType !== "openclaw_gateway") {
    return input.defaultsPayload;
  }

  const merged = isPlainObject(input.defaultsPayload)
    ? { ...(input.defaultsPayload as Record<string, unknown>) }
    : ({} as Record<string, unknown>);

  if (!nonEmptyTrimmedString(merged.paperclipApiUrl)) {
    const legacyPaperclipApiUrl = nonEmptyTrimmedString(input.paperclipApiUrl);
    if (legacyPaperclipApiUrl) merged.paperclipApiUrl = legacyPaperclipApiUrl;
  }
  const mergedHeaders = normalizeHeaderMap(merged.headers) ?? {};

  const inboundOpenClawAuthHeader = nonEmptyTrimmedString(
    input.inboundOpenClawAuthHeader
  );
  const inboundOpenClawTokenHeader = nonEmptyTrimmedString(
    input.inboundOpenClawTokenHeader
  );
  if (
    inboundOpenClawTokenHeader &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-token")
  ) {
    mergedHeaders["x-openclaw-token"] = inboundOpenClawTokenHeader;
  }
  if (
    inboundOpenClawAuthHeader &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-auth")
  ) {
    mergedHeaders["x-openclaw-auth"] = inboundOpenClawAuthHeader;
  }

  if (Object.keys(mergedHeaders).length > 0) {
    merged.headers = mergedHeaders;
  } else {
    delete merged.headers;
  }

  const discoveredToken =
    headerMapGetIgnoreCase(mergedHeaders, "x-openclaw-token") ??
    headerMapGetIgnoreCase(mergedHeaders, "x-openclaw-auth") ??
    tokenFromAuthorizationHeader(
      headerMapGetIgnoreCase(mergedHeaders, "authorization")
    );
  if (
    discoveredToken &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-token")
  ) {
    mergedHeaders["x-openclaw-token"] = discoveredToken;
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

export function mergeJoinDefaultsPayloadForReplay(
  existingDefaultsPayload: unknown,
  nextDefaultsPayload: unknown
): unknown {
  if (
    !isPlainObject(existingDefaultsPayload) &&
    !isPlainObject(nextDefaultsPayload)
  ) {
    return nextDefaultsPayload ?? existingDefaultsPayload;
  }
  if (!isPlainObject(existingDefaultsPayload)) {
    return nextDefaultsPayload;
  }
  if (!isPlainObject(nextDefaultsPayload)) {
    return existingDefaultsPayload;
  }

  const merged: Record<string, unknown> = {
    ...(existingDefaultsPayload as Record<string, unknown>),
    ...(nextDefaultsPayload as Record<string, unknown>)
  };

  const existingHeaders = normalizeHeaderMap(
    (existingDefaultsPayload as Record<string, unknown>).headers
  );
  const nextHeaders = normalizeHeaderMap(
    (nextDefaultsPayload as Record<string, unknown>).headers
  );
  if (existingHeaders || nextHeaders) {
    merged.headers = {
      ...(existingHeaders ?? {}),
      ...(nextHeaders ?? {})
    };
  } else if (Object.prototype.hasOwnProperty.call(merged, "headers")) {
    delete merged.headers;
  }

  return merged;
}

export function canReplayOpenClawGatewayInviteAccept(input: {
  requestType: "human" | "agent";
  adapterType: string | null;
  existingJoinRequest: Pick<
    typeof joinRequests.$inferSelect,
    "requestType" | "adapterType" | "status"
  > | null;
}): boolean {
  if (
    input.requestType !== "agent" ||
    input.adapterType !== "openclaw_gateway"
  ) {
    return false;
  }
  if (!input.existingJoinRequest) {
    return false;
  }
  if (
    input.existingJoinRequest.requestType !== "agent" ||
    input.existingJoinRequest.adapterType !== "openclaw_gateway"
  ) {
    return false;
  }
  return (
    input.existingJoinRequest.status === "pending_approval" ||
    input.existingJoinRequest.status === "approved"
  );
}

export function assertLegacyAgentInviteAdapterType(
  adapterType: string | null | undefined,
) {
  if (adapterType === "paperclip_runner") {
    throw badRequest(
      "Alice Runner 暂不支持通过智能体邀请流程接入。",
      { code: "paperclip_runner_invite_onboarding_disabled" },
    );
  }
}

function summarizeSecretForLog(
  value: unknown
): { present: true; length: number; sha256Prefix: string } | null {
  const trimmed = nonEmptyTrimmedString(value);
  if (!trimmed) return null;
  return {
    present: true,
    length: trimmed.length,
    sha256Prefix: hashToken(trimmed).slice(0, 12)
  };
}

function summarizeOpenClawGatewayDefaultsForLog(defaultsPayload: unknown) {
  const defaults = isPlainObject(defaultsPayload)
    ? (defaultsPayload as Record<string, unknown>)
    : null;
  const headers = defaults ? normalizeHeaderMap(defaults.headers) : undefined;
  const gatewayTokenValue = headers
    ? headerMapGetIgnoreCase(headers, "x-openclaw-token") ??
      headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
      tokenFromAuthorizationHeader(
        headerMapGetIgnoreCase(headers, "authorization")
      )
    : null;
  return {
    present: Boolean(defaults),
    keys: defaults ? Object.keys(defaults).sort() : [],
    url: defaults ? nonEmptyTrimmedString(defaults.url) : null,
    paperclipApiUrl: defaults
      ? nonEmptyTrimmedString(defaults.paperclipApiUrl)
      : null,
    headerKeys: headers ? Object.keys(headers).sort() : [],
    sessionKeyStrategy: defaults
      ? nonEmptyTrimmedString(defaults.sessionKeyStrategy)
      : null,
    disableDeviceAuth: defaults
      ? parseBooleanLike(defaults.disableDeviceAuth)
      : null,
    waitTimeoutMs:
      defaults && typeof defaults.waitTimeoutMs === "number"
        ? defaults.waitTimeoutMs
        : null,
    devicePrivateKeyPem: defaults
      ? summarizeSecretForLog(defaults.devicePrivateKeyPem)
      : null,
    gatewayToken: summarizeSecretForLog(gatewayTokenValue)
  };
}

export function normalizeAgentDefaultsForJoin(input: {
  adapterType: string | null;
  defaultsPayload: unknown;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}) {
  const fatalErrors: string[] = [];
  const diagnostics: JoinDiagnostic[] = [];
  if (input.adapterType === "hermes_gateway") {
    if (!isPlainObject(input.defaultsPayload)) {
      diagnostics.push({
        code: "hermes_gateway_defaults_missing",
        level: "warn",
        message: "agentDefaultsPayload 中未提供 Hermes 网关配置。",
        hint: "Hermes 网关接入需要提供 agentDefaultsPayload.apiBaseUrl 和 agentDefaultsPayload.apiKey。",
      });
      fatalErrors.push("adapterType=hermes_gateway 时必须提供 agentDefaultsPayload");
      return { normalized: null as Record<string, unknown> | null, diagnostics, fatalErrors };
    }

    const defaults = input.defaultsPayload as Record<string, unknown>;
    const normalized = { ...defaults };
    const rawApiBaseUrl = nonEmptyTrimmedString(defaults.apiBaseUrl ?? defaults.url);
    if (!rawApiBaseUrl) {
      diagnostics.push({
        code: "hermes_gateway_api_base_url_missing",
        level: "warn",
        message: "Hermes 网关缺少 apiBaseUrl。",
        hint: "请将 agentDefaultsPayload.apiBaseUrl 设为 Hermes API 服务地址。支持端口 9119 的默认仪表盘根地址或聊天地址，并会自动映射到 /api。",
      });
      fatalErrors.push("必须提供 agentDefaultsPayload.apiBaseUrl");
    } else {
      try {
        const rawParsedApiBaseUrl = new URL(rawApiBaseUrl);
        const mappedDefaultDashboardRoot = isDefaultHermesDashboardRoot(rawParsedApiBaseUrl);
        const apiBaseUrl = normalizeHermesGatewayApiBaseUrl(rawParsedApiBaseUrl);
        if (apiBaseUrl.protocol !== "http:" && apiBaseUrl.protocol !== "https:") {
          diagnostics.push({
            code: "hermes_gateway_api_base_url_protocol",
            level: "warn",
            message: `Hermes 网关 apiBaseUrl 必须使用 http:// 或 https://（当前为 ${apiBaseUrl.protocol}）。`,
          });
          fatalErrors.push("hermes_gateway 的 agentDefaultsPayload.apiBaseUrl 必须使用 http:// 或 https://");
        } else if (
          apiBaseUrl.protocol === "http:" &&
          !isLoopbackHost(apiBaseUrl.hostname) &&
          parseBooleanLike(defaults.dangerouslyAllowInsecureRemoteHttp) !== true
        ) {
          diagnostics.push({
            code: "hermes_gateway_plain_http_remote_denied",
            level: "warn",
            message: "默认拒绝通过明文 HTTP 访问远程 Hermes 网关。",
            hint: "请使用 https://。只有在明确接受风险的本地开发环境中，才可设置 agentDefaultsPayload.dangerouslyAllowInsecureRemoteHttp=true。",
          });
          fatalErrors.push(
            "agentDefaultsPayload.apiBaseUrl 正在使用远程明文 HTTP；请改用 HTTPS，或仅在接受风险的本地开发中设置 dangerouslyAllowInsecureRemoteHttp=true",
          );
        } else {
          normalized.apiBaseUrl = apiBaseUrl.toString();
          if (mappedDefaultDashboardRoot) {
            diagnostics.push({
              code: "hermes_gateway_dashboard_root_mapped",
              level: "info",
              message: `Hermes 默认仪表盘根地址已映射到 API 地址 ${apiBaseUrl.toString()}`,
              hint: "Hermes 仪表盘和 /chat 是浏览器界面路由；Alice 网关调用使用 /api/health 和 /api/v1/runs。",
            });
          }
          if (apiBaseUrl.protocol === "http:" && !isLoopbackHost(apiBaseUrl.hostname)) {
            diagnostics.push({
              code: "hermes_gateway_plain_http_remote_unsafe_allowed",
              level: "warn",
              message: "已允许非回环地址的 HTTP Hermes 流量；此开发选项存在安全风险。",
            });
          } else {
            diagnostics.push({
              code: "hermes_gateway_api_base_url_configured",
              level: "info",
              message: `Hermes 网关端点已设为 ${apiBaseUrl.toString()}`,
            });
          }
        }
      } catch {
        diagnostics.push({
          code: "hermes_gateway_api_base_url_invalid",
          level: "warn",
          message: `Hermes 网关 apiBaseUrl 无效：${rawApiBaseUrl}`,
        });
        fatalErrors.push("agentDefaultsPayload.apiBaseUrl 不是有效 URL");
      }
    }

    if (!nonEmptyTrimmedString(defaults.apiKey)) {
      diagnostics.push({
        code: "hermes_gateway_api_key_missing",
        level: "warn",
        message: "Hermes 网关缺少 API 密钥。",
        hint: "请将 agentDefaultsPayload.apiKey 设为 Hermes 的 API_SERVER_KEY 值。",
      });
      fatalErrors.push("必须提供 agentDefaultsPayload.apiKey");
    }

    return { normalized, diagnostics, fatalErrors };
  }
  if (input.adapterType !== "openclaw_gateway") {
    const normalized = isPlainObject(input.defaultsPayload)
      ? (input.defaultsPayload as Record<string, unknown>)
      : null;
    return { normalized, diagnostics, fatalErrors };
  }

  if (!isPlainObject(input.defaultsPayload)) {
    diagnostics.push({
      code: "openclaw_gateway_defaults_missing",
      level: "warn",
      message:
        "agentDefaultsPayload 中未提供 OpenClaw 网关配置。",
      hint:
        "OpenClaw 网关接入需要提供 agentDefaultsPayload.url 和 headers.x-openclaw-token。"
    });
    fatalErrors.push(
      "adapterType=openclaw_gateway 时必须提供 agentDefaultsPayload"
    );
    return {
      normalized: null as Record<string, unknown> | null,
      diagnostics,
      fatalErrors
    };
  }

  const defaults = input.defaultsPayload as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  let gatewayUrl: URL | null = null;
  const rawGatewayUrl = nonEmptyTrimmedString(defaults.url);
  if (!rawGatewayUrl) {
    diagnostics.push({
      code: "openclaw_gateway_url_missing",
      level: "warn",
      message: "OpenClaw 网关缺少 URL。",
      hint: "请将 agentDefaultsPayload.url 设为 ws:// 或 wss:// 网关地址。"
    });
    fatalErrors.push("必须提供 agentDefaultsPayload.url");
  } else {
    try {
      gatewayUrl = new URL(rawGatewayUrl);
      if (gatewayUrl.protocol !== "ws:" && gatewayUrl.protocol !== "wss:") {
        diagnostics.push({
          code: "openclaw_gateway_url_protocol",
          level: "warn",
          message: `OpenClaw 网关 URL 必须使用 ws:// 或 wss://（当前为 ${gatewayUrl.protocol}）。`
        });
        fatalErrors.push(
          "openclaw_gateway 的 agentDefaultsPayload.url 必须使用 ws:// 或 wss://"
        );
      } else {
        normalized.url = gatewayUrl.toString();
        diagnostics.push({
          code: "openclaw_gateway_url_configured",
          level: "info",
          message: `网关端点已设为 ${gatewayUrl.toString()}`
        });
      }
    } catch {
      diagnostics.push({
        code: "openclaw_gateway_url_invalid",
        level: "warn",
        message: `OpenClaw 网关 URL 无效：${rawGatewayUrl}`
      });
      fatalErrors.push("agentDefaultsPayload.url 不是有效 URL");
    }
  }

  const headers = normalizeHeaderMap(defaults.headers) ?? {};
  const gatewayToken =
    headerMapGetIgnoreCase(headers, "x-openclaw-token") ??
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    tokenFromAuthorizationHeader(headerMapGetIgnoreCase(headers, "authorization"));
  if (gatewayToken && !headerMapHasKeyIgnoreCase(headers, "x-openclaw-token")) {
    headers["x-openclaw-token"] = gatewayToken;
  }
  if (Object.keys(headers).length > 0) {
    normalized.headers = headers;
  }

  if (!gatewayToken) {
    diagnostics.push({
      code: "openclaw_gateway_auth_header_missing",
      level: "warn",
      message: "智能体默认配置中缺少网关身份验证令牌。",
      hint:
        "请设置 agentDefaultsPayload.headers.x-openclaw-token（或旧版 x-openclaw-auth）。"
    });
    fatalErrors.push(
      "必须提供 agentDefaultsPayload.headers.x-openclaw-token（或 x-openclaw-auth）"
    );
  } else if (gatewayToken.trim().length < 16) {
    diagnostics.push({
      code: "openclaw_gateway_auth_header_too_short",
      level: "warn",
      message: `网关身份验证令牌似乎过短（${gatewayToken.trim().length} 个字符）。`,
      hint:
        "请使用 ~/.openclaw/openclaw.json 中的完整网关身份验证令牌（通常是一段较长的随机字符串）。"
    });
    fatalErrors.push(
      "agentDefaultsPayload.headers.x-openclaw-token 过短；应提供完整网关令牌"
    );
  } else {
    diagnostics.push({
      code: "openclaw_gateway_auth_header_configured",
      level: "info",
      message: "网关身份验证令牌已配置。"
    });
  }

  if (isPlainObject(defaults.payloadTemplate)) {
    normalized.payloadTemplate = defaults.payloadTemplate;
  }

  const parsedDisableDeviceAuth = parseBooleanLike(defaults.disableDeviceAuth);
  const disableDeviceAuth = parsedDisableDeviceAuth === true;
  if (parsedDisableDeviceAuth !== null) {
    normalized.disableDeviceAuth = parsedDisableDeviceAuth;
  }

  const configuredDevicePrivateKeyPem = nonEmptyTrimmedString(
    defaults.devicePrivateKeyPem
  );
  if (configuredDevicePrivateKeyPem) {
    normalized.devicePrivateKeyPem = configuredDevicePrivateKeyPem;
    diagnostics.push({
      code: "openclaw_gateway_device_key_configured",
      level: "info",
      message:
        "网关设备密钥已配置；该智能体的配对授权将持续有效。"
    });
  } else if (!disableDeviceAuth) {
    try {
      normalized.devicePrivateKeyPem = generateEd25519PrivateKeyPem();
      diagnostics.push({
        code: "openclaw_gateway_device_key_generated",
        level: "info",
        message:
          "已为本次接入生成持久化网关设备密钥；该智能体的配对授权将持续有效。"
      });
    } catch (err) {
      diagnostics.push({
        code: "openclaw_gateway_device_key_generate_failed",
        level: "warn",
        message: `生成网关设备密钥失败：${
          err instanceof Error ? err.message : String(err)
        }`,
        hint:
          "请明确设置 agentDefaultsPayload.devicePrivateKeyPem，或设置 disableDeviceAuth=true。"
      });
      fatalErrors.push(
        "生成网关设备密钥失败。请设置 devicePrivateKeyPem，或设置 disableDeviceAuth=true。"
      );
    }
  }

  const waitTimeoutMs =
    typeof defaults.waitTimeoutMs === "number" &&
    Number.isFinite(defaults.waitTimeoutMs)
      ? Math.floor(defaults.waitTimeoutMs)
      : typeof defaults.waitTimeoutMs === "string"
      ? Number.parseInt(defaults.waitTimeoutMs.trim(), 10)
      : NaN;
  if (Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0) {
    normalized.waitTimeoutMs = waitTimeoutMs;
  }

  const timeoutSec =
    typeof defaults.timeoutSec === "number" && Number.isFinite(defaults.timeoutSec)
      ? Math.floor(defaults.timeoutSec)
      : typeof defaults.timeoutSec === "string"
      ? Number.parseInt(defaults.timeoutSec.trim(), 10)
      : NaN;
  if (Number.isFinite(timeoutSec) && timeoutSec > 0) {
    normalized.timeoutSec = timeoutSec;
  }

  const sessionKeyStrategy = nonEmptyTrimmedString(defaults.sessionKeyStrategy);
  if (
    sessionKeyStrategy === "fixed" ||
    sessionKeyStrategy === "issue" ||
    sessionKeyStrategy === "run"
  ) {
    normalized.sessionKeyStrategy = sessionKeyStrategy;
  }

  const sessionKey = nonEmptyTrimmedString(defaults.sessionKey);
  if (sessionKey) {
    normalized.sessionKey = sessionKey;
  }

  const role = nonEmptyTrimmedString(defaults.role);
  if (role) {
    normalized.role = role;
  }

  if (Array.isArray(defaults.scopes)) {
    const scopes = defaults.scopes
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (scopes.length > 0) {
      normalized.scopes = scopes;
    }
  }

  const rawPaperclipApiUrl =
    typeof defaults.paperclipApiUrl === "string"
      ? defaults.paperclipApiUrl.trim()
      : "";
  if (rawPaperclipApiUrl) {
    try {
      const parsedPaperclipApiUrl = new URL(rawPaperclipApiUrl);
      if (
        parsedPaperclipApiUrl.protocol !== "http:" &&
        parsedPaperclipApiUrl.protocol !== "https:"
      ) {
        diagnostics.push({
          code: "openclaw_gateway_paperclip_api_url_protocol",
          level: "warn",
          message: `paperclipApiUrl 必须使用 http:// 或 https://（当前为 ${parsedPaperclipApiUrl.protocol}）。`
        });
      } else {
        normalized.paperclipApiUrl = parsedPaperclipApiUrl.toString();
        diagnostics.push({
          code: "openclaw_gateway_paperclip_api_url_configured",
          level: "info",
          message: `paperclipApiUrl 已设为 ${parsedPaperclipApiUrl.toString()}`
        });
      }
    } catch {
      diagnostics.push({
        code: "openclaw_gateway_paperclip_api_url_invalid",
        level: "warn",
        message: `paperclipApiUrl 无效：${rawPaperclipApiUrl}`
      });
    }
  }

  return { normalized, diagnostics, fatalErrors };
}

export async function prepareAgentDefaultsPayloadForJoinPersistence(input: {
  db: Db;
  companyId: string;
  adapterType: string | null;
  normalized: Record<string, unknown> | null;
  actor?: { userId?: string | null; agentId?: string | null };
}): Promise<Record<string, unknown> | null> {
  if (input.adapterType !== "hermes_gateway" || !input.normalized) {
    return input.normalized;
  }

  return secretService(input.db).normalizeAdapterConfigForPersistence(
    input.companyId,
    input.normalized,
    { adapterType: input.adapterType, actor: input.actor },
  );
}

function toInviteSummaryResponse(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  company:
    | string
    | {
      name: string | null;
      logoUrl: string | null;
    }
    | null = null,
  authPublicBaseUrl?: string
) {
  const companyInfo = typeof company === "string"
    ? { name: company, logoUrl: null }
    : company;
  const baseUrl = resolveBaseUrl(req, authPublicBaseUrl);
  const invitePath = `/invite/${token}`;
  const onboardingPath = `/api/invites/${token}/onboarding`;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const skillIndexPath = `/api/invites/${token}/skills/index`;
  const inviteMessage = extractInviteMessage(invite);
  return {
    id: invite.id,
    companyId: invite.companyId,
    companyName: companyInfo?.name ?? null,
    companyLogoUrl: companyInfo?.logoUrl ?? null,
    inviteType: invite.inviteType,
    allowedJoinTypes: invite.allowedJoinTypes,
    humanRole: extractInviteHumanRole(invite),
    expiresAt: invite.expiresAt,
    invitePath,
    inviteUrl: baseUrl ? `${baseUrl}${invitePath}` : invitePath,
    onboardingPath,
    onboardingUrl: baseUrl ? `${baseUrl}${onboardingPath}` : onboardingPath,
    onboardingTextPath,
    onboardingTextUrl: baseUrl
      ? `${baseUrl}${onboardingTextPath}`
      : onboardingTextPath,
    skillIndexPath,
    skillIndexUrl: baseUrl
      ? `${baseUrl}${skillIndexPath}`
      : skillIndexPath,
    inviteMessage
  };
}

function actorHasActiveUserMembership(req: Request, companyId: string) {
  return (
    req.actor.type === "board" &&
    typeof req.actor.userId === "string" &&
    Array.isArray(req.actor.memberships) &&
    req.actor.memberships.some(
      (membership) =>
        membership.companyId === companyId && membership.status === "active",
    )
  );
}

async function loadUsersById(db: Db, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, ReturnType<typeof toUserProfile>>();
  const rows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(inArray(authUsers.id, userIds));
  return new Map(rows.map((row) => [row.id, toUserProfile(row)]));
}

async function loadCompanyAccessSummary(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
) {
  if (req.actor.type !== "board") {
    return {
      currentUserRole: null,
      canManageMembers: false,
      canInviteUsers: false,
      canApproveJoinRequests: false,
    };
  }
  if (isLocalImplicit(req)) {
    return {
      currentUserRole: "owner" as const,
      canManageMembers: true,
      canInviteUsers: true,
      canApproveJoinRequests: true,
    };
  }
  const userId = req.actor.userId ?? null;
  const membership =
    userId ? await access.getMembership(companyId, "user", userId) : null;
  const [canManageMembers, canInviteUsers, canApproveJoinRequests] =
    await Promise.all([
      access.canUser(companyId, userId, "users:manage_permissions"),
      access.canUser(companyId, userId, "users:invite"),
      access.canUser(companyId, userId, "joins:approve"),
    ]);

  return {
    currentUserRole:
      membership?.status === "active" && membership.membershipRole
        ? normalizeHumanRole(membership.membershipRole, "operator")
        : null,
    canManageMembers,
    canInviteUsers,
    canApproveJoinRequests,
  };
}

async function loadCompanyMemberRecords(
  db: Db,
  companyId: string,
  options: { includeArchived?: boolean } = {},
) {
  const members = await db
    .select()
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        options.includeArchived ? undefined : ne(companyMemberships.status, "archived"),
      ),
    )
    .orderBy(desc(companyMemberships.updatedAt));

  const userIds = [...new Set(members.map((member) => member.principalId))];
  const [userMap, grants] = await Promise.all([
    loadUsersById(db, userIds),
    userIds.length > 0
      ? db
          .select()
          .from(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, companyId),
              eq(principalPermissionGrants.principalType, "user"),
              inArray(principalPermissionGrants.principalId, userIds),
            ),
          )
      : Promise.resolve([]),
  ]);

  const grantsByPrincipalId = new Map<string, typeof grants>();
  for (const grant of grants) {
    const existing = grantsByPrincipalId.get(grant.principalId) ?? [];
    existing.push(grant);
    grantsByPrincipalId.set(grant.principalId, existing);
  }

  return members.map((member) => ({
    ...member,
    principalType: "user" as const,
    membershipRole: member.membershipRole
      ? normalizeHumanRole(member.membershipRole, "operator")
      : null,
    user: userMap.get(member.principalId) ?? null,
    grants: grantsByPrincipalId.get(member.principalId) ?? [],
  }));
}

type CompanyMemberRecord = Awaited<ReturnType<typeof loadCompanyMemberRecords>>[number];

const humanRoleRank: Record<HumanCompanyMembershipRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
  owner: 4,
};

async function resolveActorHumanRole(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
): Promise<HumanCompanyMembershipRole | null> {
  if (req.actor.type !== "board") return null;
  if (isLocalImplicit(req) || req.actor.isInstanceAdmin) return "owner";
  const userId = req.actor.userId ?? null;
  if (!userId) return null;
  const membership = await access.getMembership(companyId, "user", userId);
  if (membership?.status !== "active" || !membership.membershipRole) return null;
  return normalizeHumanRole(membership.membershipRole, "operator");
}

async function getProtectedMemberReason(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
  member: { principalId: string; principalType: string; membershipRole: string | null },
  opts?: {
    actorRole?: HumanCompanyMembershipRole | null;
    instanceAdminUserIds?: ReadonlySet<string>;
    operation?: "archive" | "update";
  },
): Promise<string | null> {
  if (member.principalType !== "user") return "只能移除公司中的人类成员。";
  if (req.actor.type !== "board") return "移除成员需要管理端权限。";
  if (member.principalId === req.actor.userId) return "不能移除自己。";
  const isTargetInstanceAdmin = opts?.instanceAdminUserIds
    ? opts.instanceAdminUserIds.has(member.principalId)
    : await access.isInstanceAdmin(member.principalId);
  if (isTargetInstanceAdmin) {
    return "不能从公司访问权限中移除实例管理员。";
  }

  const targetRole = member.membershipRole
    ? normalizeHumanRole(member.membershipRole, "operator")
    : "operator";
  if (opts?.operation === "archive") {
    if (targetRole === "owner") return "不能从公司访问权限中移除管理端所有者。";
    if (targetRole === "admin") return "不能从公司访问权限中移除公司管理员。";
  }

  const actorRole = opts?.actorRole ?? await resolveActorHumanRole(req, access, companyId);
  if (!actorRole) return "只有有效的公司成员才能移除用户。";
  if (humanRoleRank[targetRole] >= humanRoleRank[actorRole]) {
    return "只能移除公司角色级别低于自己的用户。";
  }

  return null;
}

async function assertCanManageCompanyMember(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
  member: { principalId: string; principalType: string; membershipRole: string | null },
  operation: "archive" | "update" = "update",
) {
  const reason = await getProtectedMemberReason(req, access, companyId, member, { operation });
  if (reason) throw forbidden(reason);
}

async function addCompanyMemberRemovalAccess(
  req: Request,
  db: Db,
  access: ReturnType<typeof accessService>,
  companyId: string,
  members: CompanyMemberRecord[],
) {
  const actorRole = await resolveActorHumanRole(req, access, companyId);
  const userIds = [...new Set(members
    .filter((member) => member.principalType === "user")
    .map((member) => member.principalId))];
  const instanceAdminUserIds = userIds.length > 0
    ? new Set(
      await db
        .select({ userId: instanceUserRoles.userId })
        .from(instanceUserRoles)
        .where(and(inArray(instanceUserRoles.userId, userIds), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows.map((row) => row.userId)),
    )
    : new Set<string>();
  return Promise.all(
    members.map(async (member) => {
      const reason = await getProtectedMemberReason(req, access, companyId, member, {
        actorRole,
        instanceAdminUserIds,
        operation: "archive",
      });
      return {
        ...member,
        removal: {
          canArchive: !reason,
          reason,
        },
      };
    }),
  );
}

async function loadCompanyUserDirectory(db: Db, companyId: string) {
  const members = await db
    .select({
      principalId: companyMemberships.principalId,
      status: companyMemberships.status,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    )
    .orderBy(desc(companyMemberships.updatedAt));

  const userIds = [...new Set(members.map((member) => member.principalId))];
  const userMap = await loadUsersById(db, userIds);

  return members.map((member) => ({
    principalId: member.principalId,
    status: "active" as const,
    user: userMap.get(member.principalId) ?? null,
  }));
}

function inviteStateWhereClause(
  state: "active" | "accepted" | "expired" | "revoked" | undefined,
) {
  const now = new Date();
  switch (state) {
    case "active":
      return and(
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now),
      );
    case "accepted":
      return isNotNull(invites.acceptedAt);
    case "expired":
      return and(
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        lte(invites.expiresAt, now),
      );
    case "revoked":
      return isNotNull(invites.revokedAt);
    default:
      return undefined;
  }
}

async function loadCompanyInviteRecords(
  db: Db,
  companyId: string,
  options: {
    state?: "active" | "accepted" | "expired" | "revoked";
    limit: number;
    offset: number;
  },
) {
  const whereClause = inviteStateWhereClause(options.state);
  const rows = await db
    .select()
    .from(invites)
    .where(whereClause ? and(eq(invites.companyId, companyId), whereClause) : eq(invites.companyId, companyId))
    .orderBy(desc(invites.createdAt))
    .limit(options.limit + 1)
    .offset(options.offset);
  const hasMore = rows.length > options.limit;
  const visibleRows = hasMore ? rows.slice(0, options.limit) : rows;
  const userIds = [
    ...new Set(
      visibleRows
        .map((invite) => invite.invitedByUserId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const [userMap, joinRows, companyName] = await Promise.all([
    loadUsersById(db, userIds),
    visibleRows.length
      ? db
          .select({ id: joinRequests.id, inviteId: joinRequests.inviteId })
          .from(joinRequests)
          .where(
            and(
              eq(joinRequests.companyId, companyId),
              inArray(
                joinRequests.inviteId,
                visibleRows.map((invite) => invite.id),
              ),
            ),
          )
      : Promise.resolve([]),
    db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((companyRows) => companyRows[0]?.name ?? null),
  ]);
  const joinRequestIdByInviteId = new Map(
    joinRows.map((row: { inviteId: string; id: string }) => [row.inviteId, row.id]),
  );

  return {
    invites: visibleRows.map((invite) => ({
      ...invite,
      companyName,
      humanRole: extractInviteHumanRole(invite),
      inviteMessage: extractInviteMessage(invite),
      state: inviteState(invite),
      invitedByUser: invite.invitedByUserId
        ? userMap.get(invite.invitedByUserId) ?? null
        : null,
      relatedJoinRequestId: joinRequestIdByInviteId.get(invite.id) ?? null,
    })),
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
}

async function loadJoinRequestRecords(db: Db, companyId: string) {
  const rows = collapseDuplicatePendingHumanJoinRequests(
    await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId))
      .orderBy(desc(joinRequests.createdAt))
  );
  const inviteIds = [...new Set(rows.map((row) => row.inviteId))];
  const inviteRows = inviteIds.length
    ? await db
        .select()
        .from(invites)
        .where(inArray(invites.id, inviteIds))
    : [];
  const userIds = [
    ...new Set(
      [
        ...rows.map((row) => row.requestingUserId),
        ...rows.map((row) => row.approvedByUserId),
        ...rows.map((row) => row.rejectedByUserId),
        ...inviteRows.map((invite) => invite.invitedByUserId),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  const userMap = await loadUsersById(db, userIds);
  const inviteMap = new Map(inviteRows.map((invite) => [invite.id, invite]));

  return rows.map((row) => {
    const invite = inviteMap.get(row.inviteId) ?? null;
    return {
      ...toJoinRequestResponse(row),
      requesterUser: row.requestingUserId
        ? userMap.get(row.requestingUserId) ?? null
        : null,
      approvedByUser: row.approvedByUserId
        ? userMap.get(row.approvedByUserId) ?? null
        : null,
      rejectedByUser: row.rejectedByUserId
        ? userMap.get(row.rejectedByUserId) ?? null
        : null,
      invite: invite
        ? {
            id: invite.id,
            inviteType: invite.inviteType,
            allowedJoinTypes: invite.allowedJoinTypes,
            humanRole: extractInviteHumanRole(invite),
            inviteMessage: extractInviteMessage(invite),
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            revokedAt: invite.revokedAt,
            acceptedAt: invite.acceptedAt,
            invitedByUser: invite.invitedByUserId
              ? userMap.get(invite.invitedByUserId) ?? null
              : null,
          }
        : null,
    };
  });
}

async function loadUserCompanyAccessResponse(
  db: Db,
  access: ReturnType<typeof accessService>,
  userId: string,
) {
  const [memberships, user, isInstanceAdmin] = await Promise.all([
    access.listUserCompanyAccess(userId),
    db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0] ?? null),
    access.isInstanceAdmin(userId),
  ]);
  const companyIds = [...new Set(memberships.map((membership) => membership.companyId))];
  const companyRows = companyIds.length
    ? await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
        })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const companyMap = new Map(companyRows.map((company) => [company.id, company]));

  return {
    user: user
      ? {
          ...toUserProfile(user),
          isInstanceAdmin,
        }
      : null,
    companyAccess: memberships.map((membership) => {
      const company = companyMap.get(membership.companyId) ?? null;
      return {
        ...membership,
        principalType: "user" as const,
        companyName: company?.name ?? null,
        companyStatus: company?.status ?? null,
      };
    }),
  };
}

function buildOnboardingDiscoveryDiagnostics(input: {
  apiBaseUrl: string;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}): JoinDiagnostic[] {
  const diagnostics: JoinDiagnostic[] = [];
  let apiHost: string | null = null;
  if (input.apiBaseUrl) {
    try {
      apiHost = normalizeHostname(new URL(input.apiBaseUrl).hostname);
    } catch {
      apiHost = null;
    }
  }

  const bindHost = normalizeHostname(input.bindHost);
  const allowSet = new Set(
    input.allowedHostnames
      .map((entry) => normalizeHostname(entry))
      .filter((entry): entry is string => Boolean(entry))
  );

  if (apiHost && isLoopbackHost(apiHost)) {
    diagnostics.push({
      code: "openclaw_onboarding_api_loopback",
      level: "warn",
      message:
        "接入 URL 指向回环主机名；远程 OpenClaw 智能体无法访问 Alice 主机上的 localhost。",
      hint: "请使用可访问的主机名或 IP，例如 Tailscale 主机名、Docker 主机别名或公网域名。"
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    (!bindHost || isLoopbackHost(bindHost))
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_loopback_bind",
      level: "warn",
      message: "Alice 在身份验证/私有模式下绑定到了回环地址。",
      hint: "私有网络接入请使用可访问的绑定模式，例如 `pnpm dev --bind lan` 或 `pnpm dev --bind tailnet`。"
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    apiHost &&
    !isLoopbackHost(apiHost) &&
    allowSet.size > 0 &&
    !allowSet.has(apiHost)
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_host_not_allowed",
      level: "warn",
      message: `接入主机“${apiHost}”不在身份验证/私有模式允许的主机名列表中。`,
      // `apiHost` comes from the request base URL, so a requester controls it.
      // Never put that value into the guidance command. An operator or an agent
      // can paste the command into a shell, and that outer shell evaluates a
      // metacharacter span in the host before any CLI receives argv. A
      // direct-exec form such as `npx` does not stop the outer shell. Emit
      // a static `<host>` placeholder and keep the raw host in the message only.
      hint: `请运行 npx paperclipai allowed-hostname <host>`
    });
  }

  return diagnostics;
}

function buildOnboardingConnectionCandidates(input: {
  apiBaseUrl: string;
  bindHost: string;
  allowedHostnames: string[];
}): string[] {
  let base: URL | null = null;
  try {
    if (input.apiBaseUrl) {
      base = new URL(input.apiBaseUrl);
    }
  } catch {
    base = null;
  }

  const protocol = base?.protocol ?? "http:";
  const port = base?.port ? `:${base.port}` : "";
  const candidates = new Set<string>();

  if (base) {
    candidates.add(base.origin);
  }

  const bindHost = normalizeHostname(input.bindHost);
  if (bindHost && !isLoopbackHost(bindHost)) {
    candidates.add(`${protocol}//${bindHost}${port}`);
  }

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHostname(rawHost);
    if (!host) continue;
    candidates.add(`${protocol}//${host}${port}`);
  }

  if (base && isLoopbackHost(base.hostname)) {
    candidates.add(`${protocol}//host.docker.internal${port}`);
  }

  for (const host of collectReachableInterfaceHosts()) {
    const formattedHost = host.includes(":") && !host.startsWith("[") && !host.endsWith("]") ? `[${host}]` : host;
    candidates.add(`${protocol}//${formattedHost}${port}`);
  }

  return Array.from(candidates);
}

function buildInviteOnboardingManifest(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    companyName?: string | null;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
    authPublicBaseUrl?: string;
  }
) {
  const baseUrl = resolveBaseUrl(req, opts.authPublicBaseUrl);
  const skillPath = `/api/invites/${token}/skills/paperclip`;
  const skillUrl = baseUrl ? `${baseUrl}${skillPath}` : skillPath;
  const registrationEndpointPath = `/api/invites/${token}/accept`;
  const registrationEndpointUrl = baseUrl
    ? `${baseUrl}${registrationEndpointPath}`
    : registrationEndpointPath;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const onboardingTextUrl = baseUrl
    ? `${baseUrl}${onboardingTextPath}`
    : onboardingTextPath;
  const discoveryDiagnostics = buildOnboardingDiscoveryDiagnostics({
    apiBaseUrl: baseUrl,
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });
  const connectionCandidates = buildOnboardingConnectionCandidates({
    apiBaseUrl: baseUrl,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });

  return {
    invite: toInviteSummaryResponse(
      req,
      token,
      invite,
      opts.companyName ?? null,
      opts.authPublicBaseUrl
    ),
    onboarding: {
      instructions:
        "以外部 Alice 智能体身份接入：保存一次性认领密钥，等待管理端批准，再通过标准认领端点领取 Alice API 密钥。使用 requestType='agent'，填写 agentName 和 capabilities，并按运行环境设置 adapterType 与 agentDefaultsPayload。Hermes Gateway 智能体必须使用 adapterType='hermes_gateway'；在全新 Hermes 安装中设置 API_SERVER_ENABLED=true 和新的 API_SERVER_KEY，再运行 `hermes gateway run --replace --accept-hooks`。将 Hermes 网关地址填入 agentDefaultsPayload.apiBaseUrl，将 API_SERVER_KEY 的准确值填入 agentDefaultsPayload.apiKey，并将 Hermes 可访问的 Alice 地址填入 agentDefaultsPayload.paperclipApiUrl。若使用端口 9119 的默认 Hermes 仪表盘根地址或 /chat 地址，Alice 会自动映射到 /api。OpenClaw Gateway 智能体必须使用 adapterType='openclaw_gateway'，将 agentDefaultsPayload.url 设为 ws:// 或 wss:// 网关端点，并提供 agentDefaultsPayload.headers.x-openclaw-token。",
      inviteMessage: extractInviteMessage(invite),
      recommendedAdapterType: null,
      requiredFields: {
        requestType: "agent",
        agentName: "该智能体的显示名称",
        adapterType:
          "当前运行环境的适配器类型。只有 OpenClaw Gateway 智能体使用 'openclaw_gateway'；只有 Hermes Gateway 智能体使用 'hermes_gateway'。",
        capabilities: "可选的能力摘要",
        agentDefaultsPayload:
          "运行环境专用的适配器配置。OpenClaw Gateway 智能体必须提供 url（ws:// 或 wss://）和 headers.x-openclaw-token。Hermes Gateway 智能体必须提供 apiBaseUrl、设为 Hermes API_SERVER_KEY 的 apiKey，以及 paperclipApiUrl。支持默认 Hermes 仪表盘根地址或 /chat 地址（例如 http://127.0.0.1:9119/chat），并会映射到 /api。其他运行环境请提供对应适配器所需的配置。"
      },
      registrationEndpoint: {
        method: "POST",
        path: registrationEndpointPath,
        url: registrationEndpointUrl
      },
      claimEndpointTemplate: {
        method: "POST",
        path: "/api/join-requests/{requestId}/claim-api-key",
        body: {
          claimSecret:
            "创建接入请求时返回的一次性认领密钥"
        }
      },
      connectivity: {
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bindHost: opts.bindHost,
        allowedHostnames: opts.allowedHostnames,
        connectionCandidates,
        diagnostics: discoveryDiagnostics,
        guidance:
          opts.deploymentMode === "authenticated" &&
          opts.deploymentExposure === "private"
            ? "如果 OpenClaw 运行在其他机器上，请确保 Alice 主机名可访问，并已通过 `npx paperclipai allowed-hostname <host>` 加入允许列表。"
            : "请确保 OpenClaw 能访问此 Alice API 根地址，以完成邀请、认领和技能初始化调用。"
      },
      textInstructions: {
        path: onboardingTextPath,
        url: onboardingTextUrl,
        contentType: "text/plain"
      },
      skill: {
        name: "paperclip",
        path: skillPath,
        url: skillUrl,
        installPath: "运行环境专用的 Alice 技能目录"
      }
    }
  };
}

export function buildInviteOnboardingTextDocument(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    companyName?: string | null;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
    authPublicBaseUrl?: string;
  }
) {
  const manifest = buildInviteOnboardingManifest(req, token, invite, opts);
  const onboarding = manifest.onboarding as {
    inviteMessage?: string | null;
    registrationEndpoint: { method: string; path: string; url: string };
    claimEndpointTemplate: { method: string; path: string };
    textInstructions: { path: string; url: string };
    skill: { path: string; url: string; installPath: string };
    connectivity: {
      diagnostics?: JoinDiagnostic[];
      guidance?: string;
      connectionCandidates?: string[];
      testResolutionEndpoint?: { method?: string; path?: string; url?: string };
    };
  };
  const diagnostics = Array.isArray(onboarding.connectivity?.diagnostics)
    ? onboarding.connectivity.diagnostics
    : [];

  const lines: string[] = [];
  const appendBlock = (block: string) => {
    const trimmed = block.replace(/^\n/, "").replace(/\n\s*$/, "");
    const lineIndentation = trimmed
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.match(/^(\s*)/)?.[0].length ?? 0);
    const minIndent =
      lineIndentation.length > 0 ? Math.min(...lineIndentation) : 0;
    for (const line of trimmed.split("\n")) {
      lines.push(line.slice(minIndent));
    }
  };

  appendBlock(`
    # Alice 智能体接入

    本文档供人类和智能体共同阅读。

    ## 邀请信息
    - inviteType: ${invite.inviteType}
    - allowedJoinTypes: ${invite.allowedJoinTypes}
    - expiresAt: ${invite.expiresAt.toISOString()}
  `);

  if (manifest.invite.companyName) {
    lines.push(`- companyName: ${manifest.invite.companyName}`);
  }

  if (onboarding.inviteMessage) {
    appendBlock(`
      ## 邀请者留言
      ${onboarding.inviteMessage}
    `);
  }

  appendBlock(`
    ## 第 0 步

    确认哪种 Alice 适配器类型与你的运行环境匹配。

    只有存在匹配的 Alice 适配器时才设置 adapterType；运行环境专用配置放入 agentDefaultsPayload。

    ## 第 1 步：提交智能体接入请求
    ${onboarding.registrationEndpoint.method} ${
    onboarding.registrationEndpoint.url
  }

    请求体（JSON）：
    {
      "requestType": "agent",
      "agentName": "我的智能体",
      "adapterType": "adapter_type_for_this_runtime",
      "capabilities": "该智能体能力的简短说明",
      "agentDefaultsPayload": {}
    }

    OpenClaw Gateway 请求体示例：
    {
      "requestType": "agent",
      "agentName": "我的 OpenClaw 智能体",
      "adapterType": "openclaw_gateway",
      "capabilities": "OpenClaw 网关智能体",
      "agentDefaultsPayload": {
        "url": "wss://your-openclaw-gateway.example",
        "paperclipApiUrl": "https://paperclip-hostname-your-agent-can-reach:3100",
        "headers": { "x-openclaw-token": "replace-me" },
        "waitTimeoutMs": 120000,
        "sessionKeyStrategy": "issue",
        "role": "operator",
        "scopes": ["operator.admin"]
      }
    }

    使用 OpenClaw Gateway 时，请在 agentDefaultsPayload.headers.x-openclaw-token 中提供网关令牌。也兼容旧版 x-openclaw-auth，但优先使用 x-openclaw-token。此网关接入流程不得使用 /v1/responses 或 /hooks/*。

    Hermes Gateway 配置：
    - adapterType: "hermes_gateway"
    - 对全新 Hermes 安装生成新的随机网关密钥，并使用 API_SERVER_ENABLED=true 和 API_SERVER_KEY=<随机网关密钥> 启动 Hermes。
    - 运行：hermes gateway run --replace --accept-hooks
    - Hermes API 服务默认端口：8642。
    - 将 agentDefaultsPayload.apiBaseUrl 设为 Alice 能访问的 Hermes 网关地址。
    - 将 agentDefaultsPayload.apiKey 设为与 API_SERVER_KEY 完全相同的值。这是 Hermes 网关密钥，不是 Alice 密钥。
    - 若只有默认 Hermes 仪表盘或聊天地址，也可使用 http://127.0.0.1:9119 或 http://127.0.0.1:9119/chat，系统会自动映射到 /api。
    - 注意：/chat 和仪表盘根地址是浏览器界面路由。Alice 映射为 API 根地址后，会探测 /api/health，并通过 /api/v1/runs 启动运行。
    - 将 agentDefaultsPayload.paperclipApiUrl 设为 Hermes 能访问的 Alice 根地址。
    - 若需由 Alice 在本机启动 Hermes，请使用 hermes_local。
    - 若需由 Alice 调用已经运行的 Hermes API 服务，请使用 hermes_gateway。
    - 管理端批准后，通过下方认领端点一次性领取 Alice API 密钥，并保存为 PAPERCLIP_API_KEY。打印或摘要前，先从原始 HTTP JSON 响应中提取 token 字段并存入私密位置；不要从聊天、转录或工具输出预览中复制令牌。包含字面量 ... 或 [redacted] 的值是经过遮罩的预览，不是有效密钥。不要手动轮换或编造 Alice 密钥。
    - Hermes 调用 Alice API，指的是批准并认领密钥后，Hermes 使用 PAPERCLIP_API_URL 和 PAPERCLIP_API_KEY 调用 Alice。不要与 agentDefaultsPayload.apiBaseUrl 混淆；后者是 Alice 调用 Hermes 的地址。

    Hermes Gateway 请求体示例：
    {
      "requestType": "agent",
      "agentName": "我的 Hermes Gateway 智能体",
      "adapterType": "hermes_gateway",
      "capabilities": "Hermes 网关智能体",
      "agentDefaultsPayload": {
        "apiBaseUrl": "http://127.0.0.1:8642",
        "apiKey": "<same-value-as-API_SERVER_KEY>",
        "paperclipApiUrl": "http://localhost:3100"
      }
    }

    Hermes Gateway 网络示例：
    - 本机回环 API 服务：agentDefaultsPayload.apiBaseUrl = "http://127.0.0.1:8642"，agentDefaultsPayload.paperclipApiUrl = "http://127.0.0.1:3100"。
    - 本机回环仪表盘根地址或聊天地址：agentDefaultsPayload.apiBaseUrl = "http://127.0.0.1:9119" 或 "http://127.0.0.1:9119/chat"；Alice 会将两者映射为 "http://127.0.0.1:9119/api"。
    - 局域网/私有网络：使用可访问的私有地址，例如 agentDefaultsPayload.apiBaseUrl = "http://192.168.1.25:8642"，agentDefaultsPayload.paperclipApiUrl = "http://192.168.1.10:3100"。
    - 私有覆盖网络：使用覆盖网络 DNS 名称，例如 agentDefaultsPayload.apiBaseUrl = "http://hermes-host.tailnet-name.ts.net:8642"，agentDefaultsPayload.paperclipApiUrl = "http://paperclip-host.tailnet-name.ts.net:3100"。
    - Docker：若 Alice 在 Docker 中运行、Hermes 在宿主机运行，使用 agentDefaultsPayload.apiBaseUrl = "http://host.docker.internal:8642"；若两者都在 Compose 中运行，使用 Hermes 服务名。
    - 反向代理/TLS：使用 HTTPS 来源，例如 agentDefaultsPayload.apiBaseUrl = "https://hermes-gateway.example"，agentDefaultsPayload.paperclipApiUrl = "https://alice.example"。

    预期响应包含：
    - 请求 ID
    - 一次性 claimSecret
    - claimApiKeyPath

    ## 第 2 步：等待管理端批准
    只有管理端在 Alice 中批准接入请求后，才能认领密钥。

    ## 第 3 步：一次性认领 API 密钥
    ${
      onboarding.claimEndpointTemplate.method
    } /api/join-requests/{requestId}/claim-api-key

    请求体（JSON）：
    {
      "claimSecret": "<one-time-claim-secret>"
    }

    认领成功后，将完整 JSON 响应保存到运行环境的私密位置，并设置 PAPERCLIP_API_KEY 和 PAPERCLIP_API_URL，供后续 Alice API 调用使用。响应体只会返回一次完整令牌；运行环境显示和工具摘要可能会遮罩或截断它。记录任何日志前，先将原始响应中的令牌直接写入私密存储，再通过一次已验证身份的 Alice API 调用进行核验。不要保存包含字面量 ... 或 [redacted] 的显示预览。

    重要事项：
    - 认领密钥会过期
    - 认领密钥只能使用一次
    - 管理端批准前无法认领

    ## 第 4 步：安装 Alice 技能
    GET ${onboarding.skill.url}
    安装路径：${onboarding.skill.installPath}

    请使用当前运行环境常规的技能或指令安装路径。

    ## 文本接入说明 URL
    ${onboarding.textInstructions.url}

    ## 连接指引
    ${
      onboarding.connectivity?.guidance ??
      "请确保 OpenClaw 运行环境能够访问 Alice。"
    }
  `);

  const connectionCandidates = Array.isArray(
    onboarding.connectivity?.connectionCandidates
  )
    ? onboarding.connectivity.connectionCandidates.filter(
        (entry): entry is string => Boolean(entry)
      )
    : [];

  if (connectionCandidates.length > 0) {
    lines.push("## 建议尝试的 Alice 根地址");
    for (const candidate of connectionCandidates) {
      lines.push(`- ${candidate}`);
    }
    appendBlock(`

      按以下方式测试每个候选地址：
      - GET <candidate>/api/health
      - 提交接入请求时，将第一个可访问的候选地址设为 agentDefaultsPayload.paperclipApiUrl

      若所有候选地址均不可访问：请向人类操作员索取可访问的主机名或地址，并协助更新网络配置。
      身份验证/私有模式可能需要：
      - npx paperclipai allowed-hostname <host>
      - 然后重启 Alice 并重新尝试接入。
    `);
  }

  if (diagnostics.length > 0) {
    lines.push("## 连接诊断");
    for (const diag of diagnostics) {
      lines.push(`- [${diag.level}] ${diag.message}`);
      if (diag.hint) lines.push(`  提示：${diag.hint}`);
    }
  }

  appendBlock(`

    ## 常用端点
    ${onboarding.registrationEndpoint.path}
    ${onboarding.claimEndpointTemplate.path}
    ${onboarding.skill.path}
    ${manifest.invite.onboardingPath}
  `);

  return `${lines.join("\n")}\n`;
}

function extractInviteMessage(
  invite: typeof invites.$inferSelect
): string | null {
  const rawDefaults = invite.defaultsPayload;
  if (
    !rawDefaults ||
    typeof rawDefaults !== "object" ||
    Array.isArray(rawDefaults)
  ) {
    return null;
  }
  const rawMessage = (rawDefaults as Record<string, unknown>).agentMessage;
  if (typeof rawMessage !== "string") {
    return null;
  }
  const trimmed = rawMessage.trim();
  return trimmed.length ? trimmed : null;
}

function mergeInviteDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  agentMessage: string | null,
  humanRole: "owner" | "admin" | "operator" | "viewer" | null = null,
): Record<string, unknown> | null {
  const merged =
    defaultsPayload && typeof defaultsPayload === "object"
      ? { ...defaultsPayload }
      : {};
  if (humanRole) {
    const existingHuman =
      isPlainObject(merged.human) ? { ...(merged.human as Record<string, unknown>) } : {};
    merged.human = {
      ...existingHuman,
      role: humanRole,
      grants: grantsForHumanRole(humanRole),
    };
  }
  if (agentMessage) {
    merged.agentMessage = agentMessage;
  }
  return Object.keys(merged).length ? merged : null;
}

function requestIp(req: Request) {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || "unknown";
}

function inviteExpired(invite: typeof invites.$inferSelect) {
  return invite.expiresAt.getTime() <= Date.now();
}

function inviteState(invite: typeof invites.$inferSelect) {
  if (invite.revokedAt) return "revoked" as const;
  if (invite.acceptedAt) return "accepted" as const;
  if (inviteExpired(invite)) return "expired" as const;
  return "active" as const;
}

function extractInviteHumanRole(invite: typeof invites.$inferSelect) {
  if (invite.allowedJoinTypes === "agent") return null;
  return resolveHumanInviteRole(
    invite.defaultsPayload as Record<string, unknown> | null | undefined,
  );
}

function isLocalImplicit(req: Request) {
  return req.actor.type === "board" && req.actor.source === "local_implicit";
}

function toUserProfile(
  user:
    | {
      id: string;
      email: string | null;
      name: string | null;
      image?: string | null;
    }
    | null
    | undefined,
) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  };
}

async function resolveActorEmail(db: Db, req: Request): Promise<string | null> {
  if (isLocalImplicit(req)) return "local@paperclip.local";
  const userId = req.actor.userId;
  if (!userId) return null;
  const user = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  return user?.email ?? null;
}

async function resolveAcceptedInviteJoinRequest(
  db: Db,
  req: Request,
  invite: typeof invites.$inferSelect | null,
) {
  if (!invite?.acceptedAt) return null;

  const directJoinRequest = await db
    .select({
      requestType: joinRequests.requestType,
      status: joinRequests.status,
      requestingUserId: joinRequests.requestingUserId,
      requestEmailSnapshot: joinRequests.requestEmailSnapshot,
    })
    .from(joinRequests)
    .where(eq(joinRequests.inviteId, invite.id))
    .then((rows) => rows[0] ?? null);
  if (directJoinRequest) return directJoinRequest;

  if (!invite.companyId) return null;

  const actorRequestingUserId = isLocalImplicit(req)
    ? "local-board"
    : req.actor.userId ?? null;
  const actorEmail = await resolveActorEmail(db, req);
  if (!actorRequestingUserId && !actorEmail) return null;

  return findReusableHumanJoinRequest(
    await db
      .select({
        id: joinRequests.id,
        requestType: joinRequests.requestType,
        status: joinRequests.status,
        requestingUserId: joinRequests.requestingUserId,
        requestEmailSnapshot: joinRequests.requestEmailSnapshot,
      })
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.companyId, invite.companyId),
          eq(joinRequests.requestType, "human"),
        ),
      )
      .orderBy(desc(joinRequests.createdAt)),
    {
      requestingUserId: actorRequestingUserId,
      requestEmailSnapshot: actorEmail,
    },
  );
}

function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent"
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return [];
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return [];
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return [];
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: Array<{
    permissionKey: (typeof PERMISSION_KEYS)[number];
    scope: Record<string, unknown> | null;
  }> = [];
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    result.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        record.scope &&
        typeof record.scope === "object" &&
        !Array.isArray(record.scope)
          ? (record.scope as Record<string, unknown>)
          : null
    });
  }
  return result;
}

export function agentJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  const grants = grantsFromDefaults(defaultsPayload, "agent");
  if (grants.some((grant) => grant.permissionKey === "tasks:assign")) {
    return grants;
  }
  return [
    ...grants,
    {
      permissionKey: "tasks:assign",
      scope: null
    }
  ];
}

type JoinRequestManagerCandidate = {
  id: string;
  role: string;
  reportsTo: string | null;
};

export function resolveJoinRequestAgentManagerId(
  candidates: JoinRequestManagerCandidate[]
): string | null {
  const ceoCandidates = candidates.filter(
    (candidate) => candidate.role === "ceo"
  );
  if (ceoCandidates.length === 0) return null;
  const rootCeo = ceoCandidates.find(
    (candidate) => candidate.reportsTo === null
  );
  return (rootCeo ?? ceoCandidates[0] ?? null)?.id ?? null;
}

function isInviteTokenHashCollisionError(error: unknown) {
  const candidates = [
    error,
    (error as { cause?: unknown } | null)?.cause ?? null
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const code =
      "code" in candidate && typeof candidate.code === "string"
        ? candidate.code
        : null;
    const message =
      "message" in candidate && typeof candidate.message === "string"
        ? candidate.message
        : "";
    const constraint =
      "constraint" in candidate && typeof candidate.constraint === "string"
        ? candidate.constraint
        : null;
    if (code !== "23505") continue;
    if (constraint === "invites_token_hash_unique_idx") return true;
    if (message.includes("invites_token_hash_unique_idx")) return true;
  }
  return false;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

type InviteResolutionProbe = {
  status: "reachable" | "timeout" | "unreachable";
  method: "HEAD";
  durationMs: number;
  httpStatus: number | null;
  message: string;
};

type InviteResolutionLookupResult = {
  address: string;
  family?: number;
};

type ResolvedInviteResolutionTarget = {
  url: URL;
  resolvedAddress: string;
  resolvedAddresses: string[];
  hostHeader: string;
  tlsServername?: string;
};

type InviteResolutionHeadResponse = {
  httpStatus: number | null;
};

type InviteResolutionNetwork = {
  lookup(hostname: string): Promise<InviteResolutionLookupResult[]>;
  requestHead(
    target: ResolvedInviteResolutionTarget,
    timeoutMs: number
  ): Promise<InviteResolutionHeadResponse>;
};

function parseIpv4Address(address: string) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN;
    return Number(part);
  });
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parsed as [number, number, number, number];
}

function isPrivateOrReservedIpv4(address: string) {
  const octets = parseIpv4Address(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseMappedIpv4Hex(address: string) {
  const match = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const hi = Number.parseInt(match[1]!, 16);
  const lo = Number.parseInt(match[2]!, 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateOrReservedIpv6(address: string) {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4?.[1]) return isPrivateOrReservedIpv4(mappedIpv4[1]);
    const mappedIpv4Hex = parseMappedIpv4Hex(lower);
    if (mappedIpv4Hex) return isPrivateOrReservedIpv4(mappedIpv4Hex);
    return true;
  }
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith("ff")) return true;
  if (lower === "100::" || lower.startsWith("100:")) return true;
  if (lower.startsWith("2001:db8:") || lower === "2001:db8::") return true;
  if (lower.startsWith("2001:2:") || lower === "2001:2::") return true;
  if (lower.startsWith("2002:")) return true;
  if (lower.startsWith("64:ff9b:")) return true;
  return false;
}

function isPublicIpAddress(address: string) {
  const ipVersion = isIP(address);
  if (ipVersion === 4) return !isPrivateOrReservedIpv4(address);
  if (ipVersion === 6) return !isPrivateOrReservedIpv6(address);
  return false;
}

function hostnameForResolution(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "");
}

async function defaultInviteResolutionLookup(
  hostname: string
): Promise<InviteResolutionLookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function defaultInviteResolutionHeadRequest(
  target: ResolvedInviteResolutionTarget,
  timeoutMs: number
): Promise<InviteResolutionHeadResponse> {
  return new Promise((resolve, reject) => {
    const url = target.url;
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options: HttpRequestOptions & { servername?: string } = {
      protocol: url.protocol,
      hostname: target.resolvedAddress,
      port: url.port || undefined,
      method: "HEAD",
      path: `${url.pathname}${url.search}`,
      headers: {
        Host: target.hostHeader
      }
    };
    if (target.tlsServername) {
      options.servername = target.tlsServername;
    }

    let settled = false;
    const req = request(options, (response: IncomingMessage) => {
      settled = true;
      response.resume();
      resolve({ httpStatus: response.statusCode ?? null });
    });
    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      const error = new Error("邀请地址解析探测超时");
      error.name = "AbortError";
      req.destroy(error);
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.end();
  });
}

const defaultInviteResolutionNetwork: InviteResolutionNetwork = {
  lookup: defaultInviteResolutionLookup,
  requestHead: defaultInviteResolutionHeadRequest
};

let inviteResolutionNetwork = defaultInviteResolutionNetwork;

export function setInviteResolutionNetworkForTest(
  network: Partial<InviteResolutionNetwork> | null
) {
  inviteResolutionNetwork = network
    ? { ...defaultInviteResolutionNetwork, ...network }
    : defaultInviteResolutionNetwork;
}

async function lookupInviteResolutionHostname(
  hostname: string,
  network: InviteResolutionNetwork = inviteResolutionNetwork
) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      network.lookup(hostname),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              badRequest(
                `url hostname DNS lookup timed out after ${INVITE_RESOLUTION_DNS_TIMEOUT_MS}ms`
              )
            ),
          INVITE_RESOLUTION_DNS_TIMEOUT_MS
        );
      })
    ]);
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw badRequest("无法解析 URL 主机名");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function resolveInviteResolutionTarget(
  url: URL,
  network: InviteResolutionNetwork = inviteResolutionNetwork
): Promise<ResolvedInviteResolutionTarget> {
  const hostname = hostnameForResolution(url);
  if (parseIpv4Address(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw badRequest(
        "url resolves to a private, local, multicast, or reserved address"
      );
    }
    return {
      url,
      resolvedAddress: hostname,
      resolvedAddresses: [hostname],
      hostHeader: url.host,
      tlsServername: undefined,
    };
  }
  const literalIpVersion = isIP(hostname);
  if (literalIpVersion !== 0) {
    if (!isPublicIpAddress(hostname)) {
      throw badRequest(
        "url resolves to a private, local, multicast, or reserved address"
      );
    }
    return {
      url,
      resolvedAddress: hostname,
      resolvedAddresses: [hostname],
      hostHeader: url.host,
      tlsServername: undefined,
    };
  }
  const results = await lookupInviteResolutionHostname(hostname, network);
  if (results.length === 0) {
    throw badRequest("URL 主机名未解析到任何地址");
  }

  const resolvedAddresses = results.map((result) => result.address);
  const unsafeAddress = resolvedAddresses.find((address) => !isPublicIpAddress(address));
  if (unsafeAddress) {
    throw badRequest(
      "url resolves to a private, local, multicast, or reserved address"
    );
  }

  return {
    url,
    resolvedAddress: resolvedAddresses[0]!,
    resolvedAddresses,
    hostHeader: url.host,
    tlsServername: url.protocol === "https:" && isIP(hostname) === 0
      ? hostname
      : undefined
  };
}

async function probeInviteResolutionTarget(
  target: ResolvedInviteResolutionTarget,
  timeoutMs: number,
  network: InviteResolutionNetwork = inviteResolutionNetwork
): Promise<InviteResolutionProbe> {
  const startedAt = Date.now();
  try {
    const response = await network.requestHead(target, timeoutMs);
    const durationMs = Date.now() - startedAt;
    if (
      response.httpStatus !== null &&
      (
        (response.httpStatus >= 200 && response.httpStatus < 300) ||
        response.httpStatus === 401 ||
        response.httpStatus === 403 ||
        response.httpStatus === 404 ||
        response.httpStatus === 405 ||
        response.httpStatus === 422 ||
        response.httpStatus === 500 ||
        response.httpStatus === 501
      )
    ) {
      return {
        status: "reachable",
        method: "HEAD",
        durationMs,
        httpStatus: response.httpStatus,
        message: `Webhook 端点已响应 HEAD 请求，HTTP 状态码为 ${response.httpStatus}。`
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: response.httpStatus,
      message: response.httpStatus === null
        ? "Webhook 端点探测未返回 HTTP 状态码。"
        : `Webhook 端点探测返回 HTTP ${response.httpStatus}。`
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (isAbortError(error)) {
      return {
        status: "timeout",
        method: "HEAD",
        durationMs,
        httpStatus: null,
        message: `Webhook 端点探测在 ${timeoutMs} 毫秒后超时。`
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: null,
      message:
        error instanceof Error
          ? error.message
          : "Webhook 端点探测失败。"
    };
  }
}

export function accessRoutes(
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
    inviteResolutionNetwork?: Partial<InviteResolutionNetwork>;
    inviteRateLimiter?: InviteRateLimiter;
    authPublicBaseUrl?: string;
  }
) {
  const router = Router();
  const access = accessService(db);
  const boardAuth = boardAuthService(db);
  const agents = agentService(db);
  const routeInviteResolutionNetwork = opts.inviteResolutionNetwork
    ? { ...defaultInviteResolutionNetwork, ...opts.inviteResolutionNetwork }
    : inviteResolutionNetwork;

  // Per-IP rate limit for the public, unauthenticated invite-token endpoints
  // (`/invites/:token*`). The token is looked up by hash, so without a limit the
  // token space would be online-enumerable. Applied as a router-level middleware
  // so every current and future `/invites/:token` sub-route is covered.
  //
  // The key is deliberately NOT `requestIp()`: that helper prefers the
  // client-supplied `X-Forwarded-For` header (fine for log/audit fields,
  // but trivially spoofable as a rate-limit key — rotating fake XFF values
  // would mint a fresh budget per request). `req.ip` honors Express's
  // `trust proxy` setting (configured from TRUST_PROXY in app.ts, default:
  // trust nothing), so it is the socket's remote address unless the
  // operator explicitly trusts a proxy — an unforgeable key either way.
  const inviteRateLimiter = opts.inviteRateLimiter ?? createInviteRateLimiter();
  router.use("/invites/:token", (req, res, next) => {
    const result = inviteRateLimiter.consume(
      req.ip || req.socket?.remoteAddress || "unknown",
    );
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      next(
        tooManyRequests("邀请请求过多", {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
      return;
    }
    next();
  });

  async function assertInstanceAdmin(req: Request) {
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.isInstanceAdmin(req.actor.userId);
    if (!allowed) throw forbidden("需要实例管理员权限");
  }

  router.get("/board-claim/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    const code =
      typeof req.query.code === "string" ? req.query.code.trim() : undefined;
    if (!token) throw notFound("未找到管理端认领验证请求");
    const challenge = inspectBoardClaimChallenge(token, code);
    if (challenge.status === "invalid")
      throw notFound("未找到管理端认领验证请求");
    res.json(challenge);
  });

  router.post("/board-claim/:token/claim", async (req, res) => {
    const token = (req.params.token as string).trim();
    const code =
      typeof req.body?.code === "string" ? req.body.code.trim() : undefined;
    if (!token) throw notFound("未找到管理端认领验证请求");
    if (!code) throw badRequest("必须提供认领码");
    if (
      req.actor.type !== "board" ||
      req.actor.source !== "session" ||
      !req.actor.userId
    ) {
      throw unauthorized("请先登录，再认领管理端所有权");
    }

    const claimed = await claimBoardOwnership(db, {
      token,
      code,
      userId: req.actor.userId
    });

    if (claimed.status === "invalid")
      throw notFound("未找到管理端认领验证请求");
    if (claimed.status === "expired")
      throw conflict(
        "管理端认领验证请求已过期。请重启服务器以生成新的验证请求。"
      );
    if (claimed.status === "claimed") {
      res.json({
        claimed: true,
        userId: claimed.claimedByUserId ?? req.actor.userId
      });
      return;
    }

    throw conflict("管理端认领验证请求已不可用");
  });

  router.post("/bootstrap/claim", async (req, res) => {
    if (
      opts.deploymentMode !== "authenticated" ||
      opts.deploymentExposure !== "private"
    ) {
      throw notFound("浏览器首位管理员认领当前不可用");
    }
    if (
      req.actor.type !== "board" ||
      req.actor.source !== "session" ||
      !req.actor.userId
    ) {
      throw unauthorized("请先在浏览器会话中登录，再认领首位管理员");
    }

    const claimed = await claimFirstInstanceAdmin(db, {
      userId: req.actor.userId,
    });
    if (claimed.status === "already_claimed") {
      throw conflict("此实例已被其他人认领");
    }

    res.json({ claimed: true, userId: claimed.userId });
  });

  router.post(
    "/cli-auth/challenges",
    validate(createCliAuthChallengeSchema),
    async (req, res) => {
      const created = await boardAuth.createCliAuthChallenge(req.body);
      const approvalPath = buildCliAuthApprovalPath(
        created.challenge.id,
        created.challengeSecret,
      );
      const baseUrl = requestBaseUrl(req);
      res.status(201).json({
        id: created.challenge.id,
        token: created.challengeSecret,
        boardApiToken: created.pendingBoardToken,
        approvalPath,
        approvalUrl: baseUrl ? `${baseUrl}${approvalPath}` : null,
        pollPath: `/cli-auth/challenges/${created.challenge.id}`,
        expiresAt: created.challenge.expiresAt.toISOString(),
        suggestedPollIntervalMs: 1000,
      });
    },
  );

  router.get("/cli-auth/challenges/:id", async (req, res) => {
    const id = (req.params.id as string).trim();
    const token =
      typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!id || !token) throw notFound("未找到命令行身份验证请求");
    const challenge = await boardAuth.describeCliAuthChallenge(id, token);
    if (!challenge) throw notFound("未找到命令行身份验证请求");

    const isSignedInBoardUser =
      req.actor.type === "board" &&
      (req.actor.source === "session" || isLocalImplicit(req)) &&
      Boolean(req.actor.userId);
    const canApprove =
      isSignedInBoardUser &&
      (challenge.requestedAccess !== "instance_admin_required" ||
        isLocalImplicit(req) ||
        Boolean(req.actor.isInstanceAdmin));

    res.json({
      ...challenge,
      requiresSignIn: !isSignedInBoardUser,
      canApprove,
      currentUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
  });

  router.post(
    "/cli-auth/challenges/:id/approve",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = (req.params.id as string).trim();
      if (
        req.actor.type !== "board" ||
        (!req.actor.userId && !isLocalImplicit(req))
      ) {
        throw unauthorized("请先登录，再批准命令行访问");
      }

      const userId = req.actor.userId ?? "local-board";
      const approved = await boardAuth.approveCliAuthChallenge(
        id,
        req.body.token,
        userId,
      );

      if (approved.status === "approved") {
        const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
          userId,
          requestedCompanyId: approved.challenge.requestedCompanyId,
          boardApiKeyId: approved.challenge.boardApiKeyId,
        });
        for (const companyId of companyIds) {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "board_api_key.created",
            entityType: "user",
            entityId: userId,
            details: {
              boardApiKeyId: approved.challenge.boardApiKeyId,
              requestedAccess: approved.challenge.requestedAccess,
              requestedCompanyId: approved.challenge.requestedCompanyId,
              challengeId: approved.challenge.id,
            },
          });
        }
      }

      res.json({
        approved: approved.status === "approved",
        status: approved.status,
        userId,
        keyId: approved.challenge.boardApiKeyId ?? null,
        expiresAt: approved.challenge.expiresAt.toISOString(),
      });
    },
  );

  router.post(
    "/cli-auth/challenges/:id/cancel",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = (req.params.id as string).trim();
      const cancelled = await boardAuth.cancelCliAuthChallenge(id, req.body.token);
      res.json({
        status: cancelled.status,
        cancelled: cancelled.status === "cancelled",
      });
    },
  );

  router.get("/cli-auth/me", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("需要管理端身份验证");
    }
    const accessSnapshot = await boardAuth.resolveBoardAccess(req.actor.userId);
    res.json({
      user: accessSnapshot.user,
      userId: req.actor.userId,
      isInstanceAdmin: accessSnapshot.isInstanceAdmin,
      companyIds: accessSnapshot.companyIds,
      memberships: accessSnapshot.memberships,
      source: req.actor.source ?? "none",
      keyId: req.actor.source === "board_key" ? req.actor.keyId ?? null : null,
    });
  });

  router.get("/board-api-keys", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("需要管理端身份验证");
    }
    const keys = await boardAuth.listBoardApiKeys(req.actor.userId, {
      includeInactive: req.query.includeInactive === "true",
    });
    res.json(keys);
  });

  router.post(
    "/board-api-keys",
    validate(createBoardApiKeySchema),
    async (req, res) => {
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw unauthorized("需要管理端身份验证");
      }

      if (req.body.requestedCompanyId) {
        assertCompanyAccess(req, req.body.requestedCompanyId);
      }

      const key = await boardAuth.createNamedBoardApiKey({
        userId: req.actor.userId,
        name: req.body.name,
        expiresAt: req.body.expiresAt === undefined ? undefined : req.body.expiresAt,
      });
      const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
        userId: req.actor.userId,
        requestedCompanyId: req.body.requestedCompanyId ?? null,
        boardApiKeyId: key.id,
      });
      for (const companyId of companyIds) {
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId,
          action: "board_api_key.created",
          entityType: "user",
          entityId: req.actor.userId,
          details: {
            boardApiKeyId: key.id,
            name: key.name,
            requestedCompanyId: req.body.requestedCompanyId ?? null,
            expiresAt: key.expiresAt?.toISOString() ?? null,
          },
        });
      }

      res.status(201).json(key);
    },
  );

  router.delete("/board-api-keys/:keyId", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("需要管理端身份验证");
    }
    const keyId = (req.params.keyId as string).trim();
    if (!isUuidLike(keyId)) {
      throw badRequest("管理端 API 密钥 ID 无效");
    }
    const key = await boardAuth.getBoardApiKeyForUser(keyId, req.actor.userId);
    if (!key) throw notFound("未找到管理端 API 密钥");
    const revoked = await boardAuth.revokeBoardApiKey(key.id);
    if (!revoked) throw notFound("未找到管理端 API 密钥");

    const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: req.actor.userId,
      boardApiKeyId: key.id,
    });
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "board_api_key.revoked",
        entityType: "user",
        entityId: req.actor.userId,
        details: {
          boardApiKeyId: key.id,
          name: key.name,
          revokedVia: "board_api_key_lifecycle",
        },
      });
    }

    res.json({ ok: true, keyId: key.id });
  });

  router.post("/cli-auth/revoke-current", async (req, res) => {
    if (req.actor.type !== "board" || req.actor.source !== "board_key") {
      throw badRequest("需要当前管理端 API 密钥上下文");
    }
    const key = await boardAuth.assertCurrentBoardKey(
      req.actor.keyId,
      req.actor.userId,
    );
    await boardAuth.revokeBoardApiKey(key.id);
    const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: key.userId,
      boardApiKeyId: key.id,
    });
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: key.userId,
        action: "board_api_key.revoked",
        entityType: "user",
        entityId: key.userId,
        details: {
          boardApiKeyId: key.id,
          revokedVia: "cli_auth_logout",
        },
      });
    }
    res.json({ revoked: true, keyId: key.id });
  });

  async function assertCompanyPermission(
    req: Request,
    companyId: string,
    permissionKey: any
  ) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden();
      const allowed = await access.hasPermission(
        companyId,
        "agent",
        req.actor.agentId,
        permissionKey
      );
      if (!allowed) throw forbidden("权限不足");
      return;
    }
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.canUser(
      companyId,
      req.actor.userId,
      permissionKey
    );
    if (!allowed) throw forbidden("权限不足");
  }

  async function assertCanGenerateOpenClawInvitePrompt(
    req: Request,
    companyId: string
  ) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("需要智能体身份验证");
      const actorAgent = await agents.getById(req.actor.agentId);
      if (!actorAgent || actorAgent.companyId !== companyId) {
        throw forbidden("智能体密钥不能访问其他公司");
      }
      if (actorAgent.role !== "ceo") {
        throw forbidden("只有 CEO 智能体可以生成 OpenClaw 邀请提示");
      }
      return;
    }
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "users:invite");
    if (!allowed) throw forbidden("权限不足");
  }

  async function createCompanyInviteForCompany(input: {
    req: Request;
    companyId: string;
    allowedJoinTypes: "human" | "agent" | "both";
    humanRole?: "owner" | "admin" | "operator" | "viewer" | null;
    defaultsPayload?: Record<string, unknown> | null;
    agentMessage?: string | null;
  }) {
    const normalizedAgentMessage =
      typeof input.agentMessage === "string"
        ? input.agentMessage.trim() || null
        : null;
    const effectiveHumanRole =
      input.allowedJoinTypes === "agent"
        ? null
        : input.humanRole ?? "operator";
    const insertValues = {
      companyId: input.companyId,
      inviteType: "company_join" as const,
      allowedJoinTypes: input.allowedJoinTypes,
      defaultsPayload: mergeInviteDefaults(
        input.defaultsPayload ?? null,
        normalizedAgentMessage,
        effectiveHumanRole,
      ),
      expiresAt: companyInviteExpiresAt(),
      invitedByUserId: input.req.actor.userId ?? null
    };

    let token: string | null = null;
    let created: typeof invites.$inferSelect | null = null;
    for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
      const candidateToken = createInviteToken();
      try {
        const row = await db
          .insert(invites)
          .values({
            ...insertValues,
            tokenHash: hashToken(candidateToken)
          })
          .returning()
          .then((rows) => rows[0]);
        token = candidateToken;
        created = row;
        break;
      } catch (error) {
        if (!isInviteTokenHashCollisionError(error)) {
          throw error;
        }
      }
    }
    if (!token || !created) {
      throw conflict("生成唯一邀请令牌失败，请重试。");
    }

    return { token, created, normalizedAgentMessage };
  }

  async function approveHumanJoinRequestFromInvite(input: {
    req: Request;
    invite: typeof invites.$inferSelect;
    joinRequest: typeof joinRequests.$inferSelect;
    companyId: string;
  }) {
    if (input.joinRequest.requestType !== "human") {
      throw badRequest("人类成员邀请只能批准人类成员接入请求");
    }
    if (!input.joinRequest.requestingUserId) {
      throw conflict("接入请求缺少用户身份");
    }

    const membershipRole = resolveHumanInviteRole(
      input.invite.defaultsPayload as Record<string, unknown> | null,
    );
    await access.ensureMembership(
      input.companyId,
      "user",
      input.joinRequest.requestingUserId,
      membershipRole,
      "active",
    );
    const grants = humanJoinGrantsFromDefaults(
      input.invite.defaultsPayload as Record<string, unknown> | null,
      membershipRole,
    );
    await access.setPrincipalGrants(
      input.companyId,
      "user",
      input.joinRequest.requestingUserId,
      grants,
      input.invite.invitedByUserId ?? null,
    );

    if (input.joinRequest.status === "approved") {
      return input.joinRequest;
    }

    const approvedAt = new Date();
    const approvedByUserId =
      input.invite.invitedByUserId ?? (isLocalImplicit(input.req) ? "local-board" : null);
    const approved = await db
      .update(joinRequests)
      .set({
        status: "approved",
        approvedByUserId,
        approvedAt,
        updatedAt: approvedAt,
      })
      .where(eq(joinRequests.id, input.joinRequest.id))
      .returning()
      .then((rows) => rows[0] ?? null);

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: approvedByUserId ?? "board",
      action: "join.approved",
      entityType: "join_request",
      entityId: input.joinRequest.id,
      details: {
        requestType: "human",
        inviteId: input.invite.id,
        source: "human_invite_accept",
      },
    });

    return approved ?? {
      ...input.joinRequest,
      status: "approved",
      approvedByUserId,
      approvedAt,
      updatedAt: approvedAt,
    };
  }

  async function getInviteCompanyBranding(
    companyId: string | null,
    inviteToken: string | null = null,
  ): Promise<{
    name: string | null;
    logoAssetId: string | null;
    logoUrl: string | null;
  }> {
    if (!companyId) {
      return { name: null, logoAssetId: null, logoUrl: null };
    }
    const company = await db
      .select({
        name: companies.name,
        logoAssetId: companyLogos.assetId,
      })
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id))
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    let logoUrl: string | null = null;
    if (inviteToken && company?.logoAssetId) {
      const logoAsset = await getInviteLogoAsset(companyId);
      if (logoAsset?.companyId) {
        try {
          const storage = getStorageService();
          const logoObject = await storage.headObject(logoAsset.companyId, logoAsset.objectKey);
          if (logoObject.exists) {
            logoUrl = `/api/invites/${inviteToken}/logo`;
          }
        } catch (err) {
          logger.warn(
            {
              err,
              companyId,
              logoAssetId: company.logoAssetId,
            },
            "invite logo storage check failed",
          );
        }
      }
    }

    return {
      name: company?.name ?? null,
      logoAssetId: company?.logoAssetId ?? null,
      logoUrl,
    };
  }

  async function getInviteLogoAsset(companyId: string | null): Promise<{
    companyId: string | null;
    objectKey: string;
    contentType: string | null;
    byteSize: number | null;
    originalFilename: string | null;
  } | null> {
    if (!companyId) return null;
    const logoAsset = await db
      .select({
        companyId: companies.id,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
      })
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id))
      .leftJoin(assets, eq(assets.id, companyLogos.assetId))
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    if (!logoAsset?.objectKey) return null;
    return {
      companyId: logoAsset.companyId,
      objectKey: logoAsset.objectKey,
      contentType: logoAsset.contentType,
      byteSize: logoAsset.byteSize,
      originalFilename: logoAsset.originalFilename,
    };
  }

  router.get("/skills/available", (req, res) => {
    assertAuthenticated(req);
    res.json({ skills: listAvailableSkills() });
  });

  router.get("/skills/index", (req, res) => {
    assertAuthenticated(req);
    res.json({
      skills: [
        { name: "paperclip", path: "/api/skills/paperclip" },
        {
          name: "para-memory-files",
          path: "/api/skills/para-memory-files"
        },
        {
          name: "paperclip-create-agent",
          path: "/api/skills/paperclip-create-agent"
        },
        {
          name: "paperclip-converting-plans-to-tasks",
          path: "/api/skills/paperclip-converting-plans-to-tasks"
        }
      ]
    });
  });

  router.get("/skills/:skillName", (req, res) => {
    assertAuthenticated(req);
    const skillName = (req.params.skillName as string).trim().toLowerCase();
    const markdown = readSkillMarkdown(skillName);
    if (!markdown) throw notFound("未找到技能");
    res.type("text/markdown").send(markdown);
  });

  router.post(
    "/companies/:companyId/invites",
    validate(createCompanyInviteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(req, companyId, "users:invite");
      const { token, created, normalizedAgentMessage } =
        await createCompanyInviteForCompany({
          req,
          companyId,
          allowedJoinTypes: req.body.allowedJoinTypes,
          humanRole: req.body.humanRole ?? null,
          defaultsPayload: req.body.defaultsPayload ?? null,
          agentMessage: req.body.agentMessage ?? null
        });

      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.created",
        entityType: "invite",
        entityId: created.id,
        details: {
          inviteType: created.inviteType,
          allowedJoinTypes: created.allowedJoinTypes,
          expiresAt: created.expiresAt.toISOString(),
          humanRole: extractInviteHumanRole(created),
          hasAgentMessage: Boolean(normalizedAgentMessage)
        }
      });

      const companyBranding = await getInviteCompanyBranding(created.companyId, token);
      const inviteSummary = toInviteSummaryResponse(
        req,
        token,
        created,
        companyBranding,
        opts.authPublicBaseUrl
      );
      res.status(201).json({
        ...created,
        token,
        invitePath: inviteSummary.invitePath,
        inviteUrl: inviteSummary.inviteUrl,
        companyName: companyBranding.name,
        onboardingTextPath: inviteSummary.onboardingTextPath,
        onboardingTextUrl: inviteSummary.onboardingTextUrl,
        inviteMessage: inviteSummary.inviteMessage
      });
    }
  );

  router.post(
    "/companies/:companyId/openclaw/invite-prompt",
    validate(createOpenClawInvitePromptSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanGenerateOpenClawInvitePrompt(req, companyId);
      const { token, created, normalizedAgentMessage } =
        await createCompanyInviteForCompany({
          req,
          companyId,
          allowedJoinTypes: "agent",
          humanRole: null,
          defaultsPayload: null,
          agentMessage: req.body.agentMessage ?? null
        });

      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.openclaw_prompt_created",
        entityType: "invite",
        entityId: created.id,
        details: {
          inviteType: created.inviteType,
          allowedJoinTypes: created.allowedJoinTypes,
          expiresAt: created.expiresAt.toISOString(),
          hasAgentMessage: Boolean(normalizedAgentMessage)
        }
      });

      const companyBranding = await getInviteCompanyBranding(created.companyId, token);
      const inviteSummary = toInviteSummaryResponse(
        req,
        token,
        created,
        companyBranding,
        opts.authPublicBaseUrl
      );
      res.status(201).json({
        ...created,
        token,
        invitePath: inviteSummary.invitePath,
        inviteUrl: inviteSummary.inviteUrl,
        companyName: companyBranding.name,
        onboardingTextPath: inviteSummary.onboardingTextPath,
        onboardingTextUrl: inviteSummary.onboardingTextUrl,
        inviteMessage: inviteSummary.inviteMessage
      });
    }
  );

  router.get("/invites/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("未找到邀请");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    const inviteJoinRequest = await resolveAcceptedInviteJoinRequest(db, req, invite);
    if (
      !invite ||
      invite.revokedAt ||
      inviteExpired(invite) ||
      (invite.acceptedAt && !inviteJoinRequest)
    ) {
      throw notFound("未找到邀请");
    }

    const companyBranding = await getInviteCompanyBranding(invite.companyId, token);
    const inviterName = invite.invitedByUserId
      ? await loadUsersById(db, [invite.invitedByUserId]).then(
          (m) => m.get(invite.invitedByUserId!)?.name ?? null
        )
      : null;
    res.json({
      ...toInviteSummaryResponse(req, token, invite, companyBranding, opts.authPublicBaseUrl),
      invitedByUserName: inviterName,
      joinRequestStatus: inviteJoinRequest?.status ?? null,
      joinRequestType: inviteJoinRequest?.requestType ?? null,
    });
  });

  router.get("/invites/:token/logo", async (req, res, next) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("未找到邀请");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    const inviteJoinRequest = await resolveAcceptedInviteJoinRequest(db, req, invite);
    if (
      !invite ||
      invite.revokedAt ||
      inviteExpired(invite) ||
      (invite.acceptedAt && !inviteJoinRequest)
    ) {
      throw notFound("未找到邀请");
    }

    const logoAsset = await getInviteLogoAsset(invite.companyId);
    if (!logoAsset || !logoAsset.companyId) {
      throw notFound("未找到邀请标志");
    }
    const companyId = logoAsset.companyId;

    const storage = getStorageService();
    const logoHead = await storage.headObject(companyId, logoAsset.objectKey);
    if (!logoHead.exists) {
      throw notFound("未找到邀请标志");
    }
    const object = await storage.getObject(companyId, logoAsset.objectKey);
    const responseContentType =
      logoAsset.contentType ||
      logoHead.contentType ||
      object.contentType ||
      "application/octet-stream";
    res.setHeader("Content-Type", responseContentType);
    res.setHeader(
      "Content-Length",
      String(logoAsset.byteSize || logoHead.contentLength || object.contentLength || 0),
    );
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === "image/svg+xml") {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = logoAsset.originalFilename ?? "company-logo";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.get("/invites/:token/onboarding", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("未找到邀请");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("未找到邀请");
    }

    const companyBranding = await getInviteCompanyBranding(invite.companyId);
    res.json(buildInviteOnboardingManifest(req, token, invite, {
      ...opts,
      companyName: companyBranding.name
    }));
  });

  router.get("/invites/:token/onboarding.txt", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("未找到邀请");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("未找到邀请");
    }

    const companyBranding = await getInviteCompanyBranding(invite.companyId);
    res
      .type("text/plain; charset=utf-8")
      .send(
        buildInviteOnboardingTextDocument(req, token, invite, {
          ...opts,
          companyName: companyBranding.name
        })
      );
  });

  router.get("/invites/:token/skills/index", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("未找到邀请");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("未找到邀请");
    }

    res.json({
      skills: [
        {
          name: "paperclip",
          path: `/api/invites/${token}/skills/paperclip`,
        },
      ],
    });
  });

  router.get("/invites/:token/skills/:skillName", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("未找到邀请");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("未找到邀请");
    }

    const skillName = (req.params.skillName as string).trim().toLowerCase();
    if (skillName !== "paperclip") throw notFound("未找到技能");
    const markdown = readSkillMarkdown(skillName);
    if (!markdown) throw notFound("未找到技能");
    res.type("text/markdown").send(markdown);
  });

  router.get("/invites/:token/test-resolution", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("未找到邀请");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("未找到邀请");
    }

    const rawUrl =
      typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!rawUrl) throw badRequest("必须提供 url 查询参数");
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      throw badRequest("url 必须是绝对的 http(s) URL");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw badRequest("url 必须使用 http 或 https");
    }

    const parsedTimeoutMs =
      typeof req.query.timeoutMs === "string"
        ? Number(req.query.timeoutMs)
        : NaN;
    const timeoutMs = Number.isFinite(parsedTimeoutMs)
      ? Math.max(1000, Math.min(15000, Math.floor(parsedTimeoutMs)))
      : 5000;
    const resolvedTarget = await resolveInviteResolutionTarget(target, routeInviteResolutionNetwork);
    const probe = await probeInviteResolutionTarget(resolvedTarget, timeoutMs, routeInviteResolutionNetwork);
    res.json({
      inviteId: invite.id,
      testResolutionPath: `/api/invites/${token}/test-resolution`,
      requestedUrl: target.toString(),
      timeoutMs,
      ...probe
    });
  });

  router.post(
    "/invites/:token/accept",
    validate(acceptInviteSchema),
    async (req, res) => {
      const token = (req.params.token as string).trim();
      if (!token) throw notFound("未找到邀请");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, hashToken(token)))
        .then((rows) => rows[0] ?? null);
      if (!invite || invite.revokedAt || inviteExpired(invite)) {
        throw notFound("未找到邀请");
      }
      const inviteAlreadyAccepted = Boolean(invite.acceptedAt);
      const existingJoinRequestForInvite = inviteAlreadyAccepted
        ? await db
            .select()
            .from(joinRequests)
            .where(eq(joinRequests.inviteId, invite.id))
            .then((rows) => rows[0] ?? null)
        : null;

      if (invite.inviteType === "bootstrap_ceo") {
        if (inviteAlreadyAccepted) throw notFound("未找到邀请");
        if (req.body.requestType !== "human") {
          throw badRequest("初始化邀请需要人类成员请求类型");
        }
        if (
          req.actor.type !== "board" ||
          (!req.actor.userId && !isLocalImplicit(req))
        ) {
          throw unauthorized(
            "接受初始化邀请需要已通过身份验证的用户"
          );
        }
        const userId = req.actor.userId ?? "local-board";
        const claimed = await claimFirstInstanceAdmin(db, {
          userId,
          onClaim: async (tx) => {
            const updatedInvite = await tx
              .update(invites)
              .set({ acceptedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(invites.id, invite.id),
                  isNull(invites.acceptedAt),
                  isNull(invites.revokedAt)
                )
              )
              .returning()
              .then((rows) => rows[0] ?? null);
            if (!updatedInvite) {
              throw conflict("初始化邀请已不可用");
            }
            return updatedInvite;
          },
        });
        if (claimed.status === "already_claimed") {
          throw conflict("此实例已被其他人认领");
        }
        const updatedInvite = claimed.value ?? invite;
        res.status(202).json({
          inviteId: updatedInvite.id,
          inviteType: updatedInvite.inviteType,
          bootstrapAccepted: true,
          userId
        });
        return;
      }

      const requestType = req.body.requestType as "human" | "agent";
      const companyId = invite.companyId;
      if (!companyId) throw conflict("邀请缺少公司范围");
      if (
        invite.allowedJoinTypes !== "both" &&
        invite.allowedJoinTypes !== requestType
      ) {
        throw badRequest(`该邀请不允许 ${requestType} 类型接入`);
      }

      if (requestType === "human" && req.actor.type !== "board") {
        throw unauthorized(
          "接受人类成员邀请需要已通过身份验证的用户"
        );
      }
      if (
        requestType === "human" &&
        !req.actor.userId &&
        !isLocalImplicit(req)
      ) {
        throw unauthorized("需要已通过身份验证的用户");
      }
      if (
        requestType === "human" &&
        actorHasActiveUserMembership(req, companyId)
      ) {
        throw conflict("你已经是该公司的成员");
      }
      if (requestType === "agent" && !req.body.agentName) {
        if (
          !inviteAlreadyAccepted ||
          !existingJoinRequestForInvite?.agentName
        ) {
          throw badRequest("智能体接入请求必须提供 agentName");
        }
      }

      const actorEmail =
        requestType === "human" ? await resolveActorEmail(db, req) : null;
      const actorRequestingUserId =
        requestType === "human"
          ? req.actor.userId ?? "local-board"
          : null;
      const canReplayHumanInviteAccept =
        inviteAlreadyAccepted &&
        requestType === "human" &&
        existingJoinRequestForInvite?.requestType === "human" &&
        Boolean(
          findReusableHumanJoinRequest([existingJoinRequestForInvite], {
            requestingUserId: actorRequestingUserId,
            requestEmailSnapshot: actorEmail,
          })
        );
      const adapterType = req.body.adapterType ?? null;
      if (requestType === "agent") {
        assertLegacyAgentInviteAdapterType(
          adapterType ?? existingJoinRequestForInvite?.adapterType ?? null,
        );
      }
      if (
        inviteAlreadyAccepted &&
        !canReplayHumanInviteAccept &&
        !canReplayOpenClawGatewayInviteAccept({
          requestType,
          adapterType,
          existingJoinRequest: existingJoinRequestForInvite
        })
      ) {
        throw notFound("未找到邀请");
      }
      const replayJoinRequestId = inviteAlreadyAccepted
        ? existingJoinRequestForInvite?.id ?? null
        : null;
      if (inviteAlreadyAccepted && !replayJoinRequestId) {
        throw conflict("未找到接入请求");
      }

      const replayMergedDefaults = inviteAlreadyAccepted
        ? mergeJoinDefaultsPayloadForReplay(
            existingJoinRequestForInvite?.agentDefaultsPayload ?? null,
            req.body.agentDefaultsPayload ?? null
          )
        : req.body.agentDefaultsPayload ?? null;

      const gatewayDefaultsPayload =
        requestType === "agent"
          ? buildJoinDefaultsPayloadForAccept({
              adapterType,
              defaultsPayload: replayMergedDefaults,
              paperclipApiUrl: req.body.paperclipApiUrl ?? null,
              inboundOpenClawAuthHeader: req.header("x-openclaw-auth") ?? null,
              inboundOpenClawTokenHeader: req.header("x-openclaw-token") ?? null
            })
          : null;

      const joinDefaults =
        requestType === "agent"
          ? normalizeAgentDefaultsForJoin({
              adapterType,
              defaultsPayload: gatewayDefaultsPayload,
              deploymentMode: opts.deploymentMode,
              deploymentExposure: opts.deploymentExposure,
              bindHost: opts.bindHost,
              allowedHostnames: opts.allowedHostnames
            })
          : {
              normalized: null as Record<string, unknown> | null,
              diagnostics: [] as JoinDiagnostic[],
              fatalErrors: [] as string[]
            };

      if (requestType === "agent" && joinDefaults.fatalErrors.length > 0) {
        throw badRequest(joinDefaults.fatalErrors.join("; "));
      }

      const persistedJoinDefaultsPayload =
        requestType === "agent"
          ? await prepareAgentDefaultsPayloadForJoinPersistence({
              db,
              companyId,
              adapterType,
              normalized: joinDefaults.normalized,
              actor: {
                userId: req.actor.userId ?? null,
                agentId: req.actor.agentId ?? null
              }
            })
          : null;

      if (requestType === "agent" && adapterType === "openclaw_gateway") {
        logger.info(
          {
            inviteId: invite.id,
            joinRequestDiagnostics: joinDefaults.diagnostics.map((diag) => ({
              code: diag.code,
              level: diag.level
            })),
            normalizedAgentDefaults: summarizeOpenClawGatewayDefaultsForLog(
              joinDefaults.normalized
            )
          },
          "invite accept normalized OpenClaw gateway defaults"
        );
      }

      const claimSecret =
        requestType === "agent" && !inviteAlreadyAccepted
          ? createClaimSecret()
          : null;
      const claimSecretHash = claimSecret ? hashToken(claimSecret) : null;
      const claimSecretExpiresAt = claimSecret
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null;

      const existingHumanJoinRequest =
        requestType === "human"
          ? findReusableHumanJoinRequest(
              await db
                .select()
                .from(joinRequests)
                .where(
                  and(
                    eq(joinRequests.companyId, companyId),
                    eq(joinRequests.requestType, "human")
                  )
                )
                .orderBy(desc(joinRequests.createdAt)),
              {
                requestingUserId: actorRequestingUserId,
                requestEmailSnapshot: actorEmail
              }
            )
          : null;
      let created = !inviteAlreadyAccepted
        ? existingHumanJoinRequest
          ? await db.transaction(async (tx) => {
              await tx
                .update(invites)
                .set({ acceptedAt: new Date(), updatedAt: new Date() })
                .where(
                  and(
                    eq(invites.id, invite.id),
                    isNull(invites.acceptedAt),
                    isNull(invites.revokedAt)
                  )
                );
              return existingHumanJoinRequest;
            })
          : await db.transaction(async (tx) => {
              await tx
                .update(invites)
                .set({ acceptedAt: new Date(), updatedAt: new Date() })
                .where(
                  and(
                    eq(invites.id, invite.id),
                    isNull(invites.acceptedAt),
                    isNull(invites.revokedAt)
                  )
                );

              const row = await tx
                .insert(joinRequests)
                .values({
                  inviteId: invite.id,
                  companyId,
                  requestType,
                  status: "pending_approval",
                  requestIp: requestIp(req),
                  requestingUserId:
                    requestType === "human"
                      ? req.actor.userId ?? "local-board"
                      : null,
                  requestEmailSnapshot:
                    requestType === "human" ? actorEmail : null,
                  agentName:
                    requestType === "agent" ? req.body.agentName : null,
                  adapterType: requestType === "agent" ? adapterType : null,
                  capabilities:
                    requestType === "agent"
                      ? req.body.capabilities ?? null
                      : null,
                  agentDefaultsPayload:
                    requestType === "agent" ? persistedJoinDefaultsPayload : null,
                  claimSecretHash,
                  claimSecretExpiresAt
                })
                .returning()
                .then((rows) => rows[0]);
              return row;
            })
        : await db
            .update(joinRequests)
            .set({
              requestIp: requestIp(req),
              agentName:
                requestType === "agent"
                  ? req.body.agentName ??
                    existingJoinRequestForInvite?.agentName ??
                    null
                  : null,
              capabilities:
                requestType === "agent"
                  ? req.body.capabilities ??
                    existingJoinRequestForInvite?.capabilities ??
                    null
                  : null,
              adapterType: requestType === "agent" ? adapterType : null,
              agentDefaultsPayload:
                requestType === "agent" ? persistedJoinDefaultsPayload : null,
              updatedAt: new Date()
            })
            .where(eq(joinRequests.id, replayJoinRequestId as string))
            .returning()
            .then((rows) => rows[0]);

      if (!created) {
        throw conflict("未找到接入请求");
      }

      if (
        inviteAlreadyAccepted &&
        requestType === "agent" &&
        adapterType === "openclaw_gateway" &&
        created.status === "approved" &&
        created.createdAgentId
      ) {
        const existingAgent = await agents.getById(created.createdAgentId);
        if (!existingAgent) {
          throw conflict("未找到已批准接入请求对应的智能体");
        }
        const existingAdapterConfig = isPlainObject(existingAgent.adapterConfig)
          ? (existingAgent.adapterConfig as Record<string, unknown>)
          : {};
        const nextAdapterConfig = {
          ...existingAdapterConfig,
          ...(joinDefaults.normalized ?? {})
        };
        const updatedAgent = await agents.update(created.createdAgentId, {
          adapterType,
          adapterConfig: nextAdapterConfig
        });
        if (!updatedAgent) {
          throw conflict("未找到已批准接入请求对应的智能体");
        }
        await logActivity(db, {
          companyId,
          actorType: req.actor.type === "agent" ? "agent" : "user",
          actorId:
            req.actor.type === "agent"
              ? req.actor.agentId ?? "invite-agent"
              : req.actor.userId ?? "board",
          action: "agent.updated_from_join_replay",
          entityType: "agent",
          entityId: updatedAgent.id,
          details: { inviteId: invite.id, joinRequestId: created.id }
        });
      }

      if (requestType === "agent" && adapterType === "openclaw_gateway") {
        const expectedDefaults = summarizeOpenClawGatewayDefaultsForLog(
          joinDefaults.normalized
        );
        const persistedDefaults = summarizeOpenClawGatewayDefaultsForLog(
          created.agentDefaultsPayload
        );
        const missingPersistedFields: string[] = [];

        if (expectedDefaults.url && !persistedDefaults.url)
          missingPersistedFields.push("url");
        if (
          expectedDefaults.paperclipApiUrl &&
          !persistedDefaults.paperclipApiUrl
        ) {
          missingPersistedFields.push("paperclipApiUrl");
        }
        if (expectedDefaults.gatewayToken && !persistedDefaults.gatewayToken) {
          missingPersistedFields.push("headers.x-openclaw-token");
        }
        if (
          expectedDefaults.devicePrivateKeyPem &&
          !persistedDefaults.devicePrivateKeyPem
        ) {
          missingPersistedFields.push("devicePrivateKeyPem");
        }
        if (
          expectedDefaults.headerKeys.length > 0 &&
          persistedDefaults.headerKeys.length === 0
        ) {
          missingPersistedFields.push("headers");
        }

        logger.info(
          {
            inviteId: invite.id,
            joinRequestId: created.id,
            joinRequestStatus: created.status,
            expectedDefaults,
            persistedDefaults,
            diagnostics: joinDefaults.diagnostics.map((diag) => ({
              code: diag.code,
              level: diag.level,
              message: diag.message,
              hint: diag.hint ?? null
            }))
          },
          "invite accept persisted OpenClaw gateway join request"
        );

        if (missingPersistedFields.length > 0) {
          logger.warn(
            {
              inviteId: invite.id,
              joinRequestId: created.id,
              missingPersistedFields
            },
            "invite accept detected missing persisted OpenClaw gateway defaults"
          );
        }
      }

      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "invite-agent"
            : req.actor.userId ??
              (requestType === "agent" ? "invite-anon" : "board"),
        action: inviteAlreadyAccepted
          ? "join.request_replayed"
          : "join.requested",
        entityType: "join_request",
        entityId: created.id,
        details: {
          requestType,
          requestIp: requestIp(req),
          inviteReplay: inviteAlreadyAccepted,
          reusedExistingJoinRequest:
            Boolean(existingHumanJoinRequest) && !inviteAlreadyAccepted
        }
      });

      if (requestType === "human") {
        created = await approveHumanJoinRequestFromInvite({
          req,
          invite,
          joinRequest: created,
          companyId,
        });
      }

      const response = toJoinRequestResponse(created);
      if (claimSecret) {
        const companyBranding = await getInviteCompanyBranding(invite.companyId);
        const onboardingManifest = buildInviteOnboardingManifest(
          req,
          token,
          invite,
          {
            ...opts,
            companyName: companyBranding.name
          }
        );
        res.status(202).json({
          ...response,
          claimSecret,
          claimApiKeyPath: `/api/join-requests/${created.id}/claim-api-key`,
          onboarding: onboardingManifest.onboarding,
          diagnostics: joinDefaults.diagnostics
        });
        return;
      }
      res.status(202).json({
        ...response,
        ...(joinDefaults.diagnostics.length > 0
          ? { diagnostics: joinDefaults.diagnostics }
          : {})
      });
    }
  );

  router.post("/invites/:inviteId/revoke", async (req, res) => {
    const id = req.params.inviteId as string;
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.id, id))
      .then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("未找到邀请");
    if (invite.inviteType === "bootstrap_ceo") {
      await assertInstanceAdmin(req);
    } else {
      if (!invite.companyId) throw conflict("邀请缺少公司范围");
      await assertCompanyPermission(req, invite.companyId, "users:invite");
    }
    if (invite.acceptedAt) throw conflict("邀请已被使用");
    if (invite.revokedAt) return res.json(invite);

    const revoked = await db
      .update(invites)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(invites.id, id))
      .returning()
      .then((rows) => rows[0]);

    if (invite.companyId) {
      await logActivity(db, {
        companyId: invite.companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.revoked",
        entityType: "invite",
        entityId: id
      });
    }

    res.json(revoked);
  });

  router.get("/companies/:companyId/invites", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "users:invite");
    const query = listCompanyInvitesQuerySchema.parse(req.query);
    const invitesForCompany = await loadCompanyInviteRecords(db, companyId, query);
    res.json(invitesForCompany);
  });

  router.get("/companies/:companyId/join-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "joins:approve");
    const query = listJoinRequestsQuerySchema.parse(req.query);
    const all = await loadJoinRequestRecords(db, companyId);
    const filtered = all.filter((row) => {
      if (query.status && row.status !== query.status) return false;
      if (query.requestType && row.requestType !== query.requestType)
        return false;
      return true;
    });
    res.json(filtered);
  });

  router.post(
    "/companies/:companyId/join-requests/:requestId/approve",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(req, companyId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("未找到接入请求");
      if (existing.status !== "pending_approval")
        throw conflict("接入请求不处于待处理状态");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.id, existing.inviteId))
        .then((rows) => rows[0] ?? null);
      if (!invite) throw notFound("未找到邀请");

      let createdAgentId: string | null = existing.createdAgentId ?? null;
      if (existing.requestType === "human") {
        if (!existing.requestingUserId)
          throw conflict("接入请求缺少用户身份");
        const membershipRole = resolveHumanInviteRole(
          invite.defaultsPayload as Record<string, unknown> | null,
        );
        await access.ensureMembership(
          companyId,
          "user",
          existing.requestingUserId,
          membershipRole,
          "active"
        );
        const grants = humanJoinGrantsFromDefaults(
          invite.defaultsPayload as Record<string, unknown> | null,
          membershipRole
        );
        await access.setPrincipalGrants(
          companyId,
          "user",
          existing.requestingUserId,
          grants,
          req.actor.userId ?? null
        );
      } else {
        assertLegacyAgentInviteAdapterType(existing.adapterType);
        const existingAgents = await agents.list(companyId);
        const managerId = resolveJoinRequestAgentManagerId(existingAgents);
        if (!managerId) {
          throw conflict(
            "该公司没有有效的 CEO，无法批准接入请求"
          );
        }

        const agentName = deduplicateAgentName(
          existing.agentName ?? "新智能体",
          existingAgents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status
          }))
        );

        const created = await agents.create(companyId, {
          name: agentName,
          role: "general",
          title: null,
          status: "idle",
          reportsTo: managerId,
          capabilities: existing.capabilities ?? null,
          adapterType: existing.adapterType ?? "process",
          adapterConfig:
            existing.agentDefaultsPayload &&
            typeof existing.agentDefaultsPayload === "object"
              ? (existing.agentDefaultsPayload as Record<string, unknown>)
              : {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          permissions: {},
          lastHeartbeatAt: null,
          metadata: null
        });
        createdAgentId = created.id;
        await access.ensureMembership(
          companyId,
          "agent",
          created.id,
          "member",
          "active"
        );
        const grants = agentJoinGrantsFromDefaults(
          invite.defaultsPayload as Record<string, unknown> | null
        );
        await access.setPrincipalGrants(
          companyId,
          "agent",
          created.id,
          grants,
          req.actor.userId ?? null
        );
      }

      const approved = await db
        .update(joinRequests)
        .set({
          status: "approved",
          approvedByUserId:
            req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
          approvedAt: new Date(),
          createdAgentId,
          updatedAt: new Date()
        })
        .where(eq(joinRequests.id, requestId))
        .returning()
        .then((rows) => rows[0]);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "join.approved",
        entityType: "join_request",
        entityId: requestId,
        details: { requestType: existing.requestType, createdAgentId }
      });

      if (createdAgentId) {
        void notifyHireApproved(db, {
          companyId,
          agentId: createdAgentId,
          source: "join_request",
          sourceId: requestId,
          approvedAt: new Date()
        }).catch(() => {});
      }

      res.json(toJoinRequestResponse(approved));
    }
  );

  router.post(
    "/companies/:companyId/join-requests/:requestId/reject",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(req, companyId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("未找到接入请求");
      if (existing.status !== "pending_approval")
        throw conflict("接入请求不处于待处理状态");

      const rejected = await db
        .update(joinRequests)
        .set({
          status: "rejected",
          rejectedByUserId:
            req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
          rejectedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(joinRequests.id, requestId))
        .returning()
        .then((rows) => rows[0]);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "join.rejected",
        entityType: "join_request",
        entityId: requestId,
        details: { requestType: existing.requestType }
      });

      res.json(toJoinRequestResponse(rejected));
    }
  );

  router.post(
    "/join-requests/:requestId/claim-api-key",
    validate(claimJoinRequestApiKeySchema),
    async (req, res) => {
      const requestId = req.params.requestId as string;
      const presentedClaimSecretHash = hashToken(req.body.claimSecret);
      const joinRequest = await db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.id, requestId))
        .then((rows) => rows[0] ?? null);
      if (!joinRequest) throw notFound("未找到接入请求");
      if (joinRequest.requestType !== "agent")
        throw badRequest("只有智能体接入请求可以认领 API 密钥");
      if (joinRequest.status !== "approved")
        throw conflict("认领密钥前必须先批准接入请求");
      if (!joinRequest.createdAgentId)
        throw conflict("接入请求尚未创建智能体");
      if (!joinRequest.claimSecretHash)
        throw conflict("接入请求缺少认领密钥元数据");
      if (
        !tokenHashesMatch(joinRequest.claimSecretHash, presentedClaimSecretHash)
      ) {
        throw forbidden("认领密钥无效");
      }
      if (
        joinRequest.claimSecretExpiresAt &&
        joinRequest.claimSecretExpiresAt.getTime() <= Date.now()
      ) {
        throw conflict("认领密钥已过期");
      }
      if (joinRequest.claimSecretConsumedAt)
        throw conflict("认领密钥已被使用");

      const existingKey = await db
        .select({ id: agentApiKeys.id })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, joinRequest.createdAgentId))
        .then((rows) => rows[0] ?? null);
      if (existingKey) throw conflict("API 密钥已被认领");

      const consumed = await db
        .update(joinRequests)
        .set({ claimSecretConsumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(joinRequests.id, requestId),
            isNull(joinRequests.claimSecretConsumedAt)
          )
        )
        .returning({ id: joinRequests.id })
        .then((rows) => rows[0] ?? null);
      if (!consumed) throw conflict("认领密钥已被使用");

      const created = await agents.createApiKey(
        joinRequest.createdAgentId,
        "initial-join-key",
        { kind: "standard" },
        { responsibleUserId: joinRequest.approvedByUserId ?? joinRequest.requestingUserId ?? null },
      );

      await logActivity(db, {
        companyId: joinRequest.companyId,
        actorType: "system",
        actorId: "join-claim",
        action: "agent_api_key.claimed",
        entityType: "agent_api_key",
        entityId: created.id,
        details: {
          agentId: joinRequest.createdAgentId,
          joinRequestId: requestId,
          responsibleUserId: created.responsibleUserId,
        },
      });

      res.status(201).json({
        keyId: created.id,
        token: created.token,
        agentId: joinRequest.createdAgentId,
        createdAt: created.createdAt
      });
    }
  );

  router.get("/companies/:companyId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "users:manage_permissions");
    const [members, currentAccess] = await Promise.all([
      loadCompanyMemberRecords(db, companyId),
      loadCompanyAccessSummary(req, access, companyId),
    ]);
    res.json({
      members: await addCompanyMemberRemovalAccess(req, db, access, companyId, members),
      access: currentAccess,
    });
  });

  router.get("/companies/:companyId/user-directory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const users = await loadCompanyUserDirectory(db, companyId);
    res.json({ users });
  });

  router.patch(
    "/companies/:companyId/members/:memberId",
    validate(updateCompanyMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToUpdate = await access.getMemberById(companyId, memberId);
      if (!memberToUpdate) throw notFound("未找到成员");
      await assertCanManageCompanyMember(req, access, companyId, memberToUpdate);

      const updated = await access.updateMember(companyId, memberId, req.body);
      if (!updated) throw notFound("未找到成员");

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company_member.updated",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          membershipRole: updated.membershipRole,
          status: updated.status,
        },
      });

      const member = (await loadCompanyMemberRecords(db, companyId)).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("未找到成员");
      res.json(member);
    }
  );

  router.patch(
    "/companies/:companyId/members/:memberId/role-and-grants",
    validate(updateCompanyMemberWithPermissionsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToUpdate = await access.getMemberById(companyId, memberId);
      if (!memberToUpdate) throw notFound("未找到成员");
      await assertCanManageCompanyMember(req, access, companyId, memberToUpdate);

      const updated = await access.updateMemberAndPermissions(
        companyId,
        memberId,
        {
          membershipRole: req.body.membershipRole,
          status: req.body.status,
          grants: req.body.grants ?? [],
        },
        req.actor.userId ?? null,
      );
      if (!updated) throw notFound("未找到成员");

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company_member.access_updated",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          membershipRole: updated.membershipRole,
          status: updated.status,
          grantCount: req.body.grants?.length ?? 0,
        },
      });

      const member = (await loadCompanyMemberRecords(db, companyId)).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("未找到成员");
      res.json(member);
    }
  );

  router.post(
    "/companies/:companyId/members/:memberId/archive",
    validate(archiveCompanyMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToArchive = await access.getMemberById(companyId, memberId);
      if (!memberToArchive) throw notFound("未找到成员");
      await assertCanManageCompanyMember(req, access, companyId, memberToArchive, "archive");

      const result = await access.archiveMember(companyId, memberId, {
        reassignment: req.body.reassignment ?? null,
      });
      if (!result) throw notFound("未找到成员");

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company_member.archived",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          principalId: result.member.principalId,
          reassignedIssueCount: result.reassignedIssueCount,
          reassignment: req.body.reassignment ?? null,
        },
      });

      const member = (await loadCompanyMemberRecords(db, companyId, { includeArchived: true })).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("未找到成员");
      res.json({
        member,
        reassignedIssueCount: result.reassignedIssueCount,
      });
    }
  );

  router.patch(
    "/companies/:companyId/members/:memberId/permissions",
    validate(updateMemberPermissionsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToUpdate = await access.getMemberById(companyId, memberId);
      if (!memberToUpdate) throw notFound("未找到成员");
      await assertCanManageCompanyMember(req, access, companyId, memberToUpdate);
      const updated = await access.setMemberPermissions(
        companyId,
        memberId,
        req.body.grants ?? [],
        req.actor.userId ?? null
      );
      if (!updated) throw notFound("未找到成员");
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company_member.permissions_updated",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          grantCount: req.body.grants?.length ?? 0,
        },
      });
      const member = (await loadCompanyMemberRecords(db, companyId)).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("未找到成员");
      res.json(member);
    }
  );

  router.post(
    "/admin/users/:userId/promote-instance-admin",
    async (req, res) => {
      await assertInstanceAdmin(req);
      assertAccessAdminVisible();
      const userId = req.params.userId as string;
      const result = await access.promoteInstanceAdmin(userId);
      res.status(201).json(result);
    }
  );

  router.get("/admin/users", async (req, res) => {
    await assertInstanceAdmin(req);
    assertAccessAdminVisible();
    const query = searchAdminUsersQuerySchema.parse(req.query);
    const needle = query.query.trim().toLowerCase();
    const users = await db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .from(authUsers)
      .orderBy(desc(authUsers.updatedAt));
    const filteredUsers = needle
      ? users.filter((user) =>
          [user.name, user.email]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(needle)),
        )
      : users;
    const userIds = filteredUsers.slice(0, 50).map((user) => user.id);
    const memberships = userIds.length
      ? await db
          .select({
            principalId: companyMemberships.principalId,
          })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              inArray(companyMemberships.principalId, userIds),
            ),
          )
      : [];
    const membershipCountByUserId = new Map<string, number>();
    for (const membership of memberships) {
      membershipCountByUserId.set(
        membership.principalId,
        (membershipCountByUserId.get(membership.principalId) ?? 0) + 1,
      );
    }
    const adminIds = new Set(
      await Promise.all(
        userIds.map(async (userId) =>
          (await access.isInstanceAdmin(userId)) ? userId : null,
        ),
      ).then((values) => values.filter((value): value is string => Boolean(value))),
    );

    res.json(
      filteredUsers.slice(0, 50).map((user) => ({
        ...toUserProfile(user),
        isInstanceAdmin: adminIds.has(user.id),
        activeCompanyMembershipCount:
          membershipCountByUserId.get(user.id) ?? 0,
      })),
    );
  });

  router.post(
    "/admin/users/:userId/demote-instance-admin",
    async (req, res) => {
      await assertInstanceAdmin(req);
      assertAccessAdminVisible();
      const userId = req.params.userId as string;
      const removed = await access.demoteInstanceAdmin(userId);
      if (!removed) throw notFound("未找到实例管理员角色");
      res.json(removed);
    }
  );

  router.get("/admin/users/:userId/company-access", async (req, res) => {
    await assertInstanceAdmin(req);
    assertAccessAdminVisible();
    const userId = req.params.userId as string;
    res.json(await loadUserCompanyAccessResponse(db, access, userId));
  });

  router.put(
    "/admin/users/:userId/company-access",
    validate(updateUserCompanyAccessSchema),
    async (req, res) => {
      await assertInstanceAdmin(req);
      assertAccessAdminVisible();
      const userId = req.params.userId as string;
      await access.setUserCompanyAccess(
        userId,
        req.body.companyIds ?? [],
        { actorUserId: req.actor.userId ?? null },
      );
      res.json(await loadUserCompanyAccessResponse(db, access, userId));
    }
  );

  return router;
}
