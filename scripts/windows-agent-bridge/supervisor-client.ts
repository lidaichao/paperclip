import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LocalRunClaim } from "./paperclip-client.js";
import type { ReportedLocalProcess } from "./claim-state.js";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupervisorBinding {
  executable: string;
  receiptBaseDir: string;
  runId: string;
  leaseId: string;
  deviceId: string;
  bridgeCreationFileTime: string;
  bridgeSessionId: number;
}

async function command(executable: string, args: string[]): Promise<string> {
  const result = await execFileAsync(executable, args, { windowsHide: true, timeout: 5_000 });
  return result.stdout.trim();
}

export async function readSupervisorBridgeIdentity(executable: string): Promise<{
  bridgeCreationFileTime: string; bridgeSessionId: number;
}> {
  if (process.platform !== "win32" || !path.isAbsolute(executable) ||
    !executable.toLowerCase().endsWith(".exe")) {
    throw new Error("Windows supervisor executable is required before local execution");
  }
  const parts = (await command(executable, ["identity", String(process.pid)])).split(" ");
  const bridgeSessionId = Number(parts[2]);
  if (parts.length !== 3 || parts[0] !== String(process.pid) ||
    !/^\d+$/.test(parts[1] ?? "") || !Number.isSafeInteger(bridgeSessionId) ||
    bridgeSessionId < 0) {
    throw new Error("Windows supervisor bridge identity is invalid");
  }
  return { bridgeCreationFileTime: parts[1]!, bridgeSessionId };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Windows supervisor receipt is invalid");
  }
  return value as Record<string, unknown>;
}

export function supervisedReceiptDir(binding: SupervisorBinding, process: ReportedLocalProcess): string {
  const meta = process.supervisor;
  if (!meta || !UUID.test(meta.nonce)) throw new Error("Windows supervisor process metadata is missing");
  const expected = path.resolve(binding.receiptBaseDir, binding.runId, meta.nonce);
  if (path.resolve(meta.receiptDir).toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Windows supervisor receipt directory identity changed");
  }
  return expected;
}

export async function assertNoUnreportedSupervisors(binding: SupervisorBinding,
  processes: readonly ReportedLocalProcess[]): Promise<void> {
  const runDirectory = path.resolve(binding.receiptBaseDir, binding.runId);
  let entries: Dirent[];
  try { entries = await readdir(runDirectory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && processes.length === 0) return;
    throw error;
  }
  const reported = new Set(processes.map((process) => process.supervisor?.nonce.toLowerCase()));
  if (entries.some((entry) => !entry.isDirectory() || !UUID.test(entry.name) ||
    !reported.has(entry.name.toLowerCase())) || entries.length !== reported.size) {
    throw new Error("Windows supervisor launch exists without a matching process report");
  }
}

export async function verifySupervisorStopped(binding: SupervisorBinding,
  process: ReportedLocalProcess): Promise<void> {
  const directory = supervisedReceiptDir(binding, process);
  const ready = record(JSON.parse(await readFile(path.join(directory, `${binding.runId}.ready.json`), "utf8")));
  const stopped = record(JSON.parse(await readFile(path.join(directory, `${binding.runId}.stopped.json`), "utf8")));
  const shared = ["runId", "leaseId", "deviceId", "nonce", "bridgePid",
    "bridgeCreationFileTime", "bridgeSessionId", "modelPid", "modelCreationFileTime"] as const;
  for (const field of shared) {
    if (ready[field] !== stopped[field]) throw new Error(`Windows supervisor ${field} changed before stop`);
  }
  if (ready.runId !== binding.runId || ready.leaseId !== binding.leaseId ||
    ready.deviceId !== binding.deviceId || ready.nonce !== process.supervisor!.nonce ||
    ready.bridgePid !== globalThis.process.pid ||
    ready.bridgeCreationFileTime !== binding.bridgeCreationFileTime ||
    ready.bridgeSessionId !== binding.bridgeSessionId ||
    !Number.isSafeInteger(ready.modelPid) || Number(ready.modelPid) <= 0 ||
    typeof ready.modelCreationFileTime !== "string" ||
    !["model_exit", "cancelled", "bridge_exit", "descendant_timeout"].includes(String(stopped.cause)) ||
    !Number.isSafeInteger(stopped.modelExitCode) ||
    stopped.activeProcesses !== 0 || typeof stopped.completedAtUtc !== "string" ||
    Number.isNaN(Date.parse(stopped.completedAtUtc))) {
    throw new Error("Windows supervisor stopped receipt does not match the claimed run");
  }
}

export async function cancelSupervisor(binding: SupervisorBinding,
  process: ReportedLocalProcess): Promise<void> {
  const directory = supervisedReceiptDir(binding, process);
  let ready: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      ready = record(JSON.parse(await readFile(path.join(directory, `${binding.runId}.ready.json`), "utf8")));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) throw new Error("Windows supervisor launch marker was not confirmed");
  if (ready.runId !== binding.runId || ready.leaseId !== binding.leaseId ||
    ready.deviceId !== binding.deviceId || ready.nonce !== process.supervisor!.nonce ||
    typeof ready.cancelEvent !== "string" ||
    !ready.cancelEvent.startsWith("Local\\PaperclipCancel-")) {
    throw new Error("Windows supervisor cancel identity is invalid");
  }
  await command(binding.executable, ["cancel", ready.cancelEvent]);
}

export function bindingForClaim(input: { executable: string; receiptBaseDir: string;
  bridgeCreationFileTime: string; bridgeSessionId: number },
  claim: LocalRunClaim, deviceId: string): SupervisorBinding {
  return { ...input, runId: claim.runId, leaseId: claim.leaseId, deviceId };
}
