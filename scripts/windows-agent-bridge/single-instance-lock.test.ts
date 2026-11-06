import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

function contender(lockPath: string): {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  done: Promise<string>;
} {
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "single-instance-lock.ts")).href;
  const script = `const {acquireSingleInstanceLock}=await import(${JSON.stringify(moduleUrl)});` +
    `process.stdout.write('ready\\n');` +
    `process.stdin.once('data',async()=>{try{const lock=await acquireSingleInstanceLock(${JSON.stringify(lockPath)});` +
    `process.stdout.write(lock?'acquired\\n':'blocked\\n');` +
    `if(lock){await new Promise(r=>setTimeout(r,500));await lock.release();}process.exit(0);}` +
    `catch{process.stdout.write('refused\\n');process.exit(0);}});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let markedReady = false;
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (!markedReady && output.includes("ready\n")) { markedReady = true; readyResolve(); }
  });
  const done = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve(output));
  });
  return { child, ready, done };
}

describe("real Node process lock contention", () => {
  it("never admits two local workers for one state file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "alice-real-lock-"));
    const lockPath = path.join(dir, "claim-state.json.lock");
    const pair = [contender(lockPath), contender(lockPath)];
    const timer = setTimeout(() => pair.forEach(({ child }) => child.kill()), 5_000);
    try {
      await Promise.all(pair.map((item) => item.ready));
      pair.forEach((item) => item.child.stdin.write("go\n"));
      const results = await Promise.all(pair.map((item) => item.done));
      expect(results.filter((line) => line.includes("acquired\n"))).toHaveLength(1);
      expect(results.every((line) => /acquired|blocked|refused/.test(line))).toBe(true);
      await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearTimeout(timer);
      pair.forEach(({ child }) => child.kill());
    }
  });
});
