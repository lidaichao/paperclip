import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeCredentialsDocument } from "./types.js";

const MAX_HELPER_OUTPUT_BYTES = 1_048_576;

export interface CredentialLoaderDependencies {
  unprotect?: (encryptedBase64: string) => Promise<string>;
}

function helperPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "credential-helper.ps1");
}

async function runUnprotectHelper(encryptedBase64: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Alice Windows agent credentials can only be decrypted on Windows");
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", helperPath(), "unprotect"],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderrBytes = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_HELPER_OUTPUT_BYTES) child.kill();
    });
    child.once("error", () => reject(new Error("credential helper could not start")));
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error("credential helper failed"));
      if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
        return reject(new Error("credential helper output exceeded the safety limit"));
      }
      resolve(stdout.trim());
    });
    child.stdin.end(encryptedBase64, "utf8");
  });
}

function parseCredentialDocument(raw: string): BridgeCredentialsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("decrypted credential document is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("decrypted credential document is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !record.agents || typeof record.agents !== "object" || Array.isArray(record.agents)) {
    throw new Error("decrypted credential document is invalid");
  }
  const agents: Record<string, string> = {};
  for (const [agentId, token] of Object.entries(record.agents as Record<string, unknown>)) {
    if (typeof token !== "string" || token.trim().length < 16) {
      throw new Error(`credential for agent ${agentId} is missing or invalid`);
    }
    agents[agentId] = token.trim();
  }
  return { schemaVersion: 1, agents };
}

export async function loadAgentTokens(
  encryptedPath: string,
  expectedAgentIds: readonly string[] = [],
  dependencies: CredentialLoaderDependencies = {},
): Promise<Map<string, string>> {
  const encryptedBase64 = (await readFile(encryptedPath, "utf8")).trim();
  if (!encryptedBase64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(encryptedBase64)) {
    throw new Error("encrypted credential file is invalid");
  }
  const decrypted = await (dependencies.unprotect ?? runUnprotectHelper)(encryptedBase64);
  const document = parseCredentialDocument(decrypted);
  const expected = new Set(expectedAgentIds);
  const actual = new Set(Object.keys(document.agents));
  for (const agentId of expected) {
    if (!actual.has(agentId)) throw new Error(`credential is missing for configured agent ${agentId}`);
  }
  for (const agentId of actual) {
    if (expected.size > 0 && !expected.has(agentId)) {
      throw new Error(`credential file contains unknown agent ${agentId}`);
    }
  }
  return new Map(Object.entries(document.agents));
}

