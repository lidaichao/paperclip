import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { stopWindowsProcessTree } from "./claimed-run.js";

const execFileAsync = promisify(execFile);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("hidden local Windows child tree", () => {
  it.skipIf(process.platform !== "win32")("confirms a controlled parent and child both stop", async () => {
    const script = `const {spawn}=require('node:child_process');` +
      `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],` +
      `{windowsHide:true,shell:false,stdio:'ignore'});` +
      `process.stdout.write(String(child.pid)+'\\n');setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["-e", script], {
      windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"],
    });
    const startedAt = new Date().toISOString();
    let descendantPid = 0;
    try {
      descendantPid = await Promise.race([
        new Promise<number>((resolve, reject) => {
          parent.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString("utf8").trim())));
          parent.once("error", reject);
        }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("child tree did not start")), 5_000)),
      ]);
      if (!parent.pid || !Number.isSafeInteger(descendantPid) || descendantPid <= 0) throw new Error("invalid controlled child PID");
      await stopWindowsProcessTree(parent.pid, startedAt);
      expect(alive(parent.pid)).toBe(false);
      expect(alive(descendantPid)).toBe(false);
    } finally {
      // Only these test-owned process IDs are candidates for cleanup.
      if (parent.pid && alive(parent.pid)) {
        await execFileAsync("taskkill.exe", ["/PID", String(parent.pid), "/T", "/F"],
          { windowsHide: true, timeout: 5_000 }).catch(() => undefined);
      }
      if (descendantPid && alive(descendantPid)) {
        await execFileAsync("taskkill.exe", ["/PID", String(descendantPid), "/F"],
          { windowsHide: true, timeout: 5_000 }).catch(() => undefined);
      }
    }
  }, 15_000);
});
