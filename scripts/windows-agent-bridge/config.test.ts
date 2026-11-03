import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBridgeConfig } from "./config.js";

const COMPANY_ID = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";
const LOCAL_COMPANY_ID = "832910ae-5efa-4b9f-9992-1d70b281be1e";
const AGENT_A = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const AGENT_B = "b4cb456a-f1c9-4659-8413-7044bdd36d1d";

function agent(id = AGENT_A, name = "Luna") {
  return {
    remoteAgentId: id,
    remoteAgentName: name,
    localAgentName: name,
    adapterType: "codex_local",
    maxConcurrentRuns: 1,
  };
}

function validConfig() {
  return {
    schemaVersion: 1,
    apiBase: "http://192.168.72.157:3100/",
    companyId: COMPANY_ID,
    localApiBase: "http://127.0.0.1:3100",
    localCompanyId: LOCAL_COMPANY_ID,
    credentialsFile: "credentials.dpapi",
    stateFile: "state.json",
    pollIntervalMs: 10_000,
    agents: [agent()],
  };
}

async function fixture(value: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alice-bridge-config-"));
  const file = path.join(dir, "bridge.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

describe("loadBridgeConfig", () => {
  it("normalizes the Alice origin and resolves local file paths", async () => {
    const file = await fixture(validConfig());
    const config = await loadBridgeConfig(file);
    expect(config.apiBase).toBe("http://192.168.72.157:3100");
    expect(config.credentialsFile).toBe(path.join(path.dirname(file), "credentials.dpapi"));
    expect(config.stateFile).toBe(path.join(path.dirname(file), "state.json"));
  });

  it("rejects non-http origins", async () => {
    const input = validConfig();
    input.apiBase = "file:///tmp/alice";
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("http or https");
  });

  it("rejects duplicate agent ids", async () => {
    const input = validConfig();
    input.agents = [agent(AGENT_A, "Luna"), agent(AGENT_A, "Rabbit")];
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("duplicate remoteAgentId");
  });

  it("rejects inline tokens before unknown-key validation", async () => {
    const input = validConfig() as ReturnType<typeof validConfig> & { apiKey?: string };
    input.apiKey = "must-not-be-here";
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("credentialsFile");
  });

  it("rejects duplicate local identities", async () => {
    const input = validConfig();
    input.agents = [agent(AGENT_A, "Luna"), { ...agent(AGENT_B, "Rabbit"), localAgentName: "Luna" }];
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("duplicate localAgentName");
  });
});

