import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { BridgeAgentConfig, BridgeConfig } from "./types.js";

/** Read only. This checks private auth presence, not whether a subscription is still valid. */
export async function assertPrivateModelAuthReady(config: BridgeConfig, agent: BridgeAgentConfig): Promise<void> {
  const home = await realpath(config.workerHome);
  if (!(await lstat(config.workerHome)).isDirectory()) throw new Error("private worker home is invalid");
  const privateDirectory = agent.adapterType === "codex_local"
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
  if (!resolved.startsWith(`${home}${path.sep}`)) throw new Error("member model login escapes private worker home");
  const raw = await readFile(privateFile, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("member model login file is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("member model login file is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("member model login file is invalid");
  }
  if (agent.adapterType === "cursor" && !("authInfo" in parsed)) {
    throw new Error("member Cursor login is missing from private worker home");
  }
}
