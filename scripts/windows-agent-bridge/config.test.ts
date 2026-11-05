import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBridgeConfig } from "./config.js";

const COMPANY_ID = "af8e9089-b0bb-43ac-ade3-c029c73b96e6";
const AGENT_A = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const AGENT_B = "b4cb456a-f1c9-4659-8413-7044bdd36d1d";

function agent(id = AGENT_A, name = "Luna") {
  return {
    remoteAgentId: id,
    remoteAgentName: name,
    localAgentName: name,
    adapterType: "codex_local",
    localAdapterConfig: {
      cwd: `H:/AIagent/${name}`,
      command: "C:/tools/codex.exe",
      model: "gpt-5.6-sol",
    } as Record<string, unknown>,
    maxConcurrentRuns: 1,
  };
}

function validConfig() {
  return {
    schemaVersion: 2,
    deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
    apiBase: "http://192.168.72.157:3100/",
    companyId: COMPANY_ID,
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
    expect(config.agents[0].localAdapterConfig.cwd).toBe("H:/AIagent/Luna");
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

  it("rejects obsolete 127 Paperclip settings", async () => {
    const input = { ...validConfig(), localApiBase: "http://127.0.0.1:3100" };
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("unknown keys: localApiBase");
  });

  it("rejects inline GBrain credentials and unrestricted adapter arguments", async () => {
    const withToken = validConfig();
    withToken.agents[0].localAdapterConfig = {
      ...withToken.agents[0].localAdapterConfig,
      env: { GBRAIN_AGENT_TOKEN: "inline-secret" },
    };
    await expect(loadBridgeConfig(await fixture(withToken))).rejects.toThrow("credentialsFile");

    const withArgs = validConfig();
    withArgs.agents[0].localAdapterConfig = {
      ...withArgs.agents[0].localAdapterConfig,
      extraArgs: ["--api-key=inline-secret"],
    };
    await expect(loadBridgeConfig(await fixture(withArgs))).rejects.toThrow("unknown keys: extraArgs");
  });

  it("requires absolute local workspace and executable paths", async () => {
    const input = validConfig();
    input.agents[0].localAdapterConfig = { cwd: "relative/path", command: "codex.exe" };
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("cwd must be an absolute local path");
  });
});

