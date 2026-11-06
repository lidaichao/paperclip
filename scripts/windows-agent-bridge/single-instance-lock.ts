import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

interface LockDocument { pid: number; startedAt: string; token: string }

export interface BridgeLock {
  path: string;
  document: LockDocument;
  release(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Atomic wx acquisition. A stale lock is never auto-reaped by contenders. */
export async function acquireSingleInstanceLock(
  lockPath: string,
  options: { pid?: number; now?: () => Date; alive?: (pid: number) => boolean } = {},
): Promise<BridgeLock | null> {
  const resolved = path.resolve(lockPath);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const alive = options.alive ?? isProcessAlive;
  const document: LockDocument = { pid, startedAt: now().toISOString(), token: randomUUID() };
  await mkdir(path.dirname(resolved), { recursive: true });

  try {
    const handle = await open(resolved, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: Partial<LockDocument> = {};
    try { existing = JSON.parse(await readFile(resolved, "utf8")); }
    catch { throw new Error("corrupt bridge lock requires manual recovery"); }
    if (typeof existing.pid === "number" && alive(existing.pid)) return null;
    throw new Error("stale bridge lock requires manual recovery");
  }

  return {
    path: resolved,
    document,
    async release() {
      try {
        const current = JSON.parse(await readFile(resolved, "utf8")) as Partial<LockDocument>;
        if (current.token === document.token && current.pid === document.pid) await rm(resolved, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
