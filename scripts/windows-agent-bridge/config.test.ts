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
    gbrainEnvRef: `GBRAIN_${name.toUpperCase()}_TOKEN`,
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
    schemaVersion: 3,
    deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
    workerHome: path.join(os.tmpdir(), AGENT_A),
    apiBase: "http://192.168.72.157:3100/",
    companyId: COMPANY_ID,
    credentialsFile: "credentials.dpapi",
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
  it("opts into shared Codex subscription only for Codex agents", async () => {
    expect((await loadBridgeConfig(await fixture(validConfig()))).modelAuthMode).toBe("private");
    expect((await loadBridgeConfig(await fixture({ ...validConfig(), modelAuthMode: "shared_user_codex" }))).modelAuthMode)
      .toBe("shared_user_codex");
    await expect(loadBridgeConfig(await fixture({ ...validConfig(), modelAuthMode: "shared_system" })))
      .rejects.toThrow("modelAuthMode");
    const cursor = validConfig();
    cursor.agents[0].adapterType = "cursor";
    cursor.agents[0].localAdapterConfig.model = "test";
    cursor.agents[0].localAdapterConfig.mode = "agent";
    await expect(loadBridgeConfig(await fixture(cursor))).rejects.toThrow("omit it for Cursor agent mode");
    delete cursor.agents[0].localAdapterConfig.mode;
    await expect(loadBridgeConfig(await fixture({ ...cursor, modelAuthMode: "shared_user_codex" })))
      .rejects.toThrow("codex_local");
    expect((await loadBridgeConfig(await fixture({ ...cursor, modelAuthMode: "shared_user_cursor" }))).modelAuthMode)
      .toBe("shared_user_cursor");
    await expect(loadBridgeConfig(await fixture({ ...validConfig(), modelAuthMode: "shared_user_cursor" })))
      .rejects.toThrow("cursor agents");
  });
  it("admits Hermes only with its own named profile and explicit model", async () => {
    const hermes = validConfig();
    hermes.agents[0] = { ...agent(AGENT_A, "Ada"), adapterType: "hermes_local",
      localAdapterConfig: { cwd: "H:/AIagent/Ada", command: "C:/tools/hermes.exe",
        model: "tencent-deepseek-v4.1-flash", provider: "custom:aihub", quiet: true } };
    const profile = path.join(os.tmpdir(), "hermes", "profiles", "ada");
    const accepted = await loadBridgeConfig(await fixture({ ...hermes,
      modelAuthMode: "shared_user_hermes", hermesHome: profile }));
    expect(accepted.agents[0].adapterType).toBe("hermes_local");
    expect(accepted.hermesHome).toBe(profile);
    await expect(loadBridgeConfig(await fixture({ ...hermes, modelAuthMode: "shared_user_hermes",
      hermesHome: path.join(os.tmpdir(), "hermes", "profiles", "luna") })))
      .rejects.toThrow("this member's Hermes profile");
    await expect(loadBridgeConfig(await fixture({ ...hermes, modelAuthMode: "shared_user_codex" })))
      .rejects.toThrow("codex_local");
    const carroll = structuredClone(hermes);
    carroll.agents[0].remoteAgentName = "卡罗尔";
    carroll.agents[0].localAgentName = "卡罗尔";
    carroll.agents[0].gbrainEnvRef = "GBRAIN_CARROLL_TOKEN";
    expect((await loadBridgeConfig(await fixture({ ...carroll,
      modelAuthMode: "shared_user_hermes",
      hermesHome: path.join(os.tmpdir(), "hermes", "profiles", "carroll") })))
      .agents[0].localAgentName).toBe("卡罗尔");
    await expect(loadBridgeConfig(await fixture({ ...carroll,
      modelAuthMode: "shared_user_hermes",
      hermesHome: path.join(os.tmpdir(), "hermes", "profiles", "ada") })))
      .rejects.toThrow("this member's Hermes profile");
  });
  it("normalizes the Alice origin and resolves local file paths", async () => {
    const file = await fixture(validConfig());
    const config = await loadBridgeConfig(file);
    expect(config.apiBase).toBe("http://192.168.72.157:3100");
    expect(config.credentialsFile).toBe(path.join(path.dirname(file), "credentials.dpapi"));
    expect(config.stateFile).toBe(path.join(config.workerHome, "claim-state.json"));
    expect(config.agents[0].localAdapterConfig.cwd).toBe("H:/AIagent/Luna");
  });

  it("rejects non-http origins", async () => {
    const input = validConfig();
    input.apiBase = "file:///tmp/alice";
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("http or https");
  });

  it("accepts only an explicit uncredentialed IPv4 loopback proxy", async () => {
    const good = { ...validConfig(), localProxyUrl: "http://127.0.0.1:7897/" };
    expect((await loadBridgeConfig(await fixture(good))).localProxyUrl).toBe("http://127.0.0.1:7897");
    for (const localProxyUrl of ["http://localhost:7897", "http://192.168.72.157:7897",
      "http://user:pass@127.0.0.1:7897", "https://127.0.0.1:7897", "http://127.0.0.1",
      "http://127.0.0.1:7897/other", "http://127.0.0.1:7897?key=x"]) {
      await expect(loadBridgeConfig(await fixture({ ...validConfig(), localProxyUrl })))
        .rejects.toThrow("localProxyUrl");
    }
  });

  it("rejects multiple agents in one process", async () => {
    const input = validConfig();
    input.agents = [agent(AGENT_A, "Luna"), agent(AGENT_A, "Rabbit")];
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("exactly one agent");
  });

  it("rejects inline tokens before unknown-key validation", async () => {
    const input = validConfig() as ReturnType<typeof validConfig> & { apiKey?: string };
    input.apiKey = "must-not-be-here";
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("credentialsFile");
  });

  it("binds the private worker home to the configured agent", async () => {
    const input = validConfig();
    input.workerHome = path.join(os.tmpdir(), AGENT_B);
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("workerHome must end");
  });

  it("requires an absolute worker home and derives its own state file", async () => {
    const input = validConfig();
    input.workerHome = AGENT_A;
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("workerHome must be an absolute local path");
  });

  it("accepts only a member-specific GBrain environment reference", async () => {
    const input = validConfig();
    input.agents[0].gbrainEnvRef = "GBRAIN_AGENT_TOKEN";
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("gbrainEnvRef");
  });

  it("refuses a valid but different member's GBrain reference", async () => {
    const input = validConfig();
    input.agents[0].gbrainEnvRef = "GBRAIN_RABBIT_TOKEN";
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("gbrainEnvRef does not match");
  });

  it("accepts an absolute private credential file reference without inlining its token", async () => {
    const input = validConfig();
    Object.assign(input.agents[0], { gbrainCredentialFile: "H:/AIagent/Luna/.paperclip/gbrain-luna-192.json" });
    const config = await loadBridgeConfig(await fixture(input));
    expect(config.agents[0].gbrainCredentialFile).toContain("gbrain-luna-192.json");
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
    await expect(loadBridgeConfig(await fixture(withArgs))).rejects.toThrow("approved codex_local arguments");
    withArgs.agents[0].localAdapterConfig.extraArgs = ["--ignore-user-config", "--ephemeral"];
    expect((await loadBridgeConfig(await fixture(withArgs))).agents[0].localAdapterConfig.extraArgs)
      .toEqual(["--ignore-user-config", "--ephemeral"]);
    withArgs.agents[0].localAdapterConfig.extraArgs = ["--ignore-user-config", "--ephemeral", "--config=unsafe=true"];
    await expect(loadBridgeConfig(await fixture(withArgs))).rejects.toThrow("approved codex_local arguments");
    const cursor = validConfig();
    cursor.agents[0].adapterType = "cursor";
    cursor.agents[0].localAdapterConfig.extraArgs = ["--trust"];
    expect((await loadBridgeConfig(await fixture(cursor))).agents[0].localAdapterConfig.extraArgs)
      .toEqual(["--trust"]);
    cursor.agents[0].localAdapterConfig.extraArgs = ["--trust", "--auto-review"];
    expect((await loadBridgeConfig(await fixture(cursor))).agents[0].localAdapterConfig.extraArgs)
      .toEqual(["--trust", "--auto-review"]);
  });

  it("requires absolute local workspace and executable paths", async () => {
    const input = validConfig();
    input.agents[0].localAdapterConfig = { cwd: "relative/path", command: "codex.exe" };
    await expect(loadBridgeConfig(await fixture(input))).rejects.toThrow("cwd must be an absolute local path");
  });
});

