import { readFile } from "node:fs/promises";
import type { BridgeAgentConfig } from "./types.js";
import { expectedGbrainIdentity } from "./gbrain-identity.js";

/** File takes precedence over inherited environment so a stale parent token cannot win. */
export async function loadMemberGbrainToken(agent: BridgeAgentConfig, env: NodeJS.ProcessEnv): Promise<string> {
  expectedGbrainIdentity(agent);
  if (agent.gbrainCredentialFile) {
    let record: unknown;
    try { record = JSON.parse(await readFile(agent.gbrainCredentialFile, "utf8")); }
    catch { throw new Error("member GBrain credential file is unavailable or invalid"); }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("member GBrain credential file is invalid");
    }
    const document = record as Record<string, unknown>;
    const token = document.access_token ?? document.token;
    if (typeof token !== "string" || token.trim().length < 16) {
      throw new Error("member GBrain credential file has no usable token");
    }
    return token.trim();
  }
  const token = env[agent.gbrainEnvRef];
  if (typeof token !== "string" || token.trim().length < 16) {
    throw new Error("member GBrain environment credential is unavailable");
  }
  return token.trim();
}
