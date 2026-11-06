import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BridgeAgentConfig, BridgeConfig } from "./types.js";

/** Read only. Never copies subscription auth; shape does not prove network validity. */
export async function assertPrivateModelAuthReady(config: BridgeConfig, agent: BridgeAgentConfig,
  userHome = os.userInfo().homedir): Promise<void> {
  const home = await realpath(config.workerHome);
  if (!(await lstat(config.workerHome)).isDirectory()) throw new Error("private worker home is invalid");
  const sharedCodex = config.modelAuthMode === "shared_user_codex";
  const sharedCursor = config.modelAuthMode === "shared_user_cursor";
  if (sharedCodex && agent.adapterType !== "codex_local") throw new Error("shared user model login is Codex only");
  if (sharedCursor && agent.adapterType !== "cursor") throw new Error("shared user model login is Cursor only");
  const privateDirectory = sharedCodex ? path.join(userHome, ".codex") : sharedCursor
    ? path.join(userHome, ".cursor") : agent.adapterType === "codex_local"
    ? path.join(config.workerHome, "codex-home")
    : path.join(config.workerHome, "home", ".cursor");
  const privateFile = agent.adapterType === "codex_local"
    ? path.join(privateDirectory, "auth.json")
    : path.join(privateDirectory, "cli-config.json");
  const directoryStat = await lstat(privateDirectory).catch(() => null);
  const fileStat = await lstat(privateFile).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink() || !fileStat?.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("member model login is missing from private worker home");
  }
  const resolved = await realpath(privateFile);
  if (!sharedCodex && !sharedCursor && !resolved.startsWith(`${home}${path.sep}`)) {
    throw new Error("member model login escapes private worker home");
  }
  const raw = await readFile(privateFile, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("member model login file is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("member model login file is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("member model login file is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (agent.adapterType === "codex_local") {
    const tokens = record.tokens && typeof record.tokens === "object" && !Array.isArray(record.tokens)
      ? record.tokens as Record<string, unknown> : null;
    const hasApiKey = typeof record.OPENAI_API_KEY === "string" && Boolean(record.OPENAI_API_KEY.trim());
    const hasSubscription = Boolean(tokens && typeof tokens.account_id === "string" && tokens.account_id.trim() &&
      ["id_token", "access_token", "refresh_token"].some((key) =>
        typeof tokens[key] === "string" && Boolean((tokens[key] as string).trim())));
    if (!hasApiKey && !hasSubscription) throw new Error("member Codex login is missing from private worker home");
  } else {
    const auth = record.authInfo && typeof record.authInfo === "object" && !Array.isArray(record.authInfo)
      ? record.authInfo as Record<string, unknown> : null;
    if (!auth || !["email", "displayName", "userId"].some((key) =>
      typeof auth[key] === "string" && Boolean((auth[key] as string).trim()) ||
      key === "userId" && typeof auth[key] === "number")) {
      throw new Error("member Cursor login is missing from private worker home");
    }
  }
}
