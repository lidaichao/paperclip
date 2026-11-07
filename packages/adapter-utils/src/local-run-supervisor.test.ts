import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

const execFileAsync = promisify(execFile);
const windowsRoot = process.env.WINDIR ?? "C:\\Windows";
const compiler = path.join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const suite = process.platform === "win32" && existsSync(compiler) ? describe.sequential : describe.skip;

suite("Windows local run supervisor launch", () => {
  let root: string;
  let supervisor: string;
  let model: string;
  let bridgeCreationFileTime: string;
  let bridgeSessionId: number;
  const inherited = process.env.PAPERCLIP_LOCAL_RUN_SUPERVISOR;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-supervisor-adapter-"));
    supervisor = path.join(root, "PaperclipRunSupervisor.exe");
    model = path.join(root, "TestChild.exe");
    const source = fileURLToPath(new URL("../../../scripts/windows-agent-bridge/supervisor/", import.meta.url));
    for (const [output, file] of [[supervisor, "Supervisor.cs"], [model, "TestChild.cs"]]) {
      await execFileAsync(compiler, ["/nologo", "/target:winexe", "/platform:x64",
        `/out:${output}`, path.join(source, file)], { windowsHide: true });
    }
    const identity = await execFileAsync(supervisor, ["identity", String(process.pid)], {
      windowsHide: true,
    });
    const parts = identity.stdout.trim().split(" ");
    expect(parts).toHaveLength(3);
    expect(Number(parts[0])).toBe(process.pid);
    bridgeCreationFileTime = parts[1]!;
    bridgeSessionId = Number(parts[2]);
  }, 30_000);

  afterEach(() => {
    if (inherited === undefined) delete process.env.PAPERCLIP_LOCAL_RUN_SUPERVISOR;
    else process.env.PAPERCLIP_LOCAL_RUN_SUPERVISOR = inherited;
  });
  afterAll(async () => {
    if (root?.startsWith(os.tmpdir()) && path.basename(root).startsWith("paperclip-supervisor-adapter-")) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  function configure(runId: string, executable = supervisor) {
    process.env.PAPERCLIP_LOCAL_RUN_SUPERVISOR = JSON.stringify({
      executable, runId, leaseId: randomUUID(), deviceId: "device-test-001",
      bridgeCreationFileTime, bridgeSessionId, receiptBaseDir: root,
    });
  }

  it("frames model input through a minimal-env wrapper and verifies a stopped receipt for each spawn", async () => {
    const runId = randomUUID();
    configure(runId);
    const reported: Array<{ pid: number; supervisor?: { nonce: string; receiptDir: string } }> = [];
    const marker = path.join(root, "model-stdin.txt");
    const first = await runChildProcess(runId, model, ["stdin-marker", marker], {
      cwd: root, env: { SUPERVISOR_TEST: "model-only-value" }, stdin: "framed model input",
      timeoutSec: 10, graceSec: 1, onLog: async () => {},
      onSpawn: async (meta) => { reported.push(meta); },
    });
    expect(first.exitCode).toBe(0);
    expect(await fs.readFile(marker, "utf8")).toBe("framed model input");
    expect(reported[0]?.pid).toBe(first.pid);
    const firstDir = reported[0]?.supervisor?.receiptDir;
    expect(firstDir).toBeTruthy();
    expect(path.dirname(firstDir!)).toBe(path.join(await fs.realpath(root), runId));
    const firstReceipt = JSON.parse(await fs.readFile(path.join(firstDir!, `${runId}.stopped.json`), "utf8"));
    expect(firstReceipt).toMatchObject({ runId, activeProcesses: 0,
      nonce: reported[0]?.supervisor?.nonce, bridgePid: process.pid });
    const second = await runChildProcess(runId, model, ["exit", "5"], {
      cwd: root, env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {},
      onSpawn: async (meta) => { reported.push(meta); },
    });
    expect(second.exitCode).toBe(5);
    expect(reported[1]?.supervisor?.nonce).not.toBe(reported[0]?.supervisor?.nonce);
    expect(reported[1]?.supervisor?.receiptDir).not.toBe(firstDir);
  }, 30_000);

  it("rejects missing stop proof and never treats wrapper output as success", async () => {
    const runId = randomUUID();
    configure(runId, path.join(windowsRoot, "System32", "whoami.exe"));
    await expect(runChildProcess(runId, model, ["exit", "0"], {
      cwd: root, env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {},
      onSpawn: async () => {},
    })).rejects.toThrow("receipt verification failed");
  }, 30_000);

  it("rejects a receipt whose device identity does not match the launch", async () => {
    const runId = randomUUID();
    configure(runId);
    const marker = path.join(root, "forged-receipt-model.txt");
    await expect(runChildProcess(runId, model, ["stdin-marker", marker], {
      cwd: root, env: {}, stdin: "must not launch", timeoutSec: 10, graceSec: 1,
      onLog: async () => {},
      onSpawn: async ({ supervisor: launch }) => {
        expect(launch).toBeDefined();
        const forged = {
          runId, leaseId: JSON.parse(process.env.PAPERCLIP_LOCAL_RUN_SUPERVISOR!).leaseId,
          deviceId: "different-device", nonce: launch!.nonce, bridgePid: process.pid,
          bridgeCreationFileTime, bridgeSessionId, modelPid: 42,
          modelCreationFileTime: "1", activeProcesses: 0,
          cause: "model_exit", modelExitCode: 0, completedAtUtc: new Date().toISOString(),
        };
        await fs.writeFile(path.join(launch!.receiptDir, `${runId}.ready.json`), JSON.stringify(forged));
        await fs.writeFile(path.join(launch!.receiptDir, `${runId}.stopped.json`), JSON.stringify(forged));
      },
    })).rejects.toThrow("receipt verification failed");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("stops before model launch when durable wrapper metadata cannot be reported", async () => {
    const runId = randomUUID();
    configure(runId);
    const marker = path.join(root, "must-not-exist.txt");
    await expect(runChildProcess(runId, model, ["stdin-marker", marker], {
      cwd: root, env: {}, stdin: "secret-model-input", timeoutSec: 10, graceSec: 1,
      onLog: async () => {}, onSpawn: async () => { throw new Error("disk unavailable"); },
    })).rejects.toThrow("metadata was not persisted");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("rejects remote or untracked launch before spawning", async () => {
    const runId = randomUUID();
    configure(runId);
    const common = { cwd: root, env: {}, timeoutSec: 10, graceSec: 1,
      onLog: async () => {} };
    await expect(runChildProcess(runId, model, [], { ...common,
      remoteExecution: {} as never, onSpawn: async () => {},
    })).rejects.toThrow("direct local Windows execution target");
    await expect(runChildProcess(runId, model, [], common))
      .rejects.toThrow("durable onSpawn callback");
  });
});
