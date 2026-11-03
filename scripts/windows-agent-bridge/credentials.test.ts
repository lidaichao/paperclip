import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentTokens } from "./credentials.js";

const AGENT_A = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const AGENT_B = "b4cb456a-f1c9-4659-8413-7044bdd36d1d";

async function encryptedFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alice-bridge-credentials-"));
  const file = path.join(dir, "credentials.dpapi");
  await writeFile(file, "U2FmZUVuY3J5cHRlZENvbnRlbnQ=", "utf8");
  return file;
}

describe("loadAgentTokens", () => {
  it("returns only configured agent tokens", async () => {
    const file = await encryptedFixture();
    const tokens = await loadAgentTokens(file, [AGENT_A], {
      unprotect: async () => JSON.stringify({ schemaVersion: 1, agents: { [AGENT_A]: "pc_agent_token_1234567890" } }),
    });
    expect(tokens.get(AGENT_A)).toBe("pc_agent_token_1234567890");
  });

  it("rejects unknown agent credentials", async () => {
    const file = await encryptedFixture();
    await expect(loadAgentTokens(file, [AGENT_A], {
      unprotect: async () => JSON.stringify({
        schemaVersion: 1,
        agents: {
          [AGENT_A]: "pc_agent_token_1234567890",
          [AGENT_B]: "pc_agent_token_abcdefghij",
        },
      }),
    })).rejects.toThrow(`unknown agent ${AGENT_B}`);
  });

  it("rejects missing configured credentials", async () => {
    const file = await encryptedFixture();
    await expect(loadAgentTokens(file, [AGENT_A], {
      unprotect: async () => JSON.stringify({ schemaVersion: 1, agents: {} }),
    })).rejects.toThrow(`missing for configured agent ${AGENT_A}`);
  });
});

