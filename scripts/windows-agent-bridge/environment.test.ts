import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertWorkerEnvironment, buildLocalAdapterConfig, buildWorkerEnvironment } from "./environment.js";
import { resolveCursorSkillsHome } from "../../packages/adapters/cursor-local/src/server/skills.js";
import type { BridgeConfig } from "./types.js";

const agentId = "38a5808c-47f3-4029-bdfe-0d84504bdc8a";
const workerHome = path.join(path.resolve("."), "isolated-test", agentId);
const config: BridgeConfig = {
  schemaVersion: 3, deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
  workerHome, apiBase: "http://alice.test", companyId: "af8e9089-b0bb-43ac-ade3-c029c73b96e6",
  credentialsFile: path.join(workerHome, "credentials.dpapi"),
  stateFile: path.join(workerHome, "claim-state.json"), pollIntervalMs: 10_000,
  agents: [{ remoteAgentId: agentId, remoteAgentName: "Luna", localAgentName: "Luna",
    gbrainEnvRef: "GBRAIN_LUNA_TOKEN", adapterType: "codex_local",
    localAdapterConfig: { cwd: "H:/AIagent/Luna", command: "C:/tools/codex.exe" }, maxConcurrentRuns: 1 }],
};

describe("single-member worker environment", () => {
  it("passes only OS keys, isolated homes and the selected member credential keys", () => {
    const source = {
      Path: "C:/Windows/System32", SystemRoot: "C:/Windows",
      GBRAIN_LUNA_TOKEN: "placeholder-one", GBRAIN_RABBIT_TOKEN: "placeholder-two",
      GBRAIN_AGENT_TOKEN: "placeholder-other", PAPERCLIP_API_KEY: "placeholder-other",
      PAPERCLIP_RUN_ID: "placeholder-other", OPENAI_API_KEY: "placeholder-other",
      CURSOR_API_KEY: "placeholder-other", NODE_OPTIONS: "placeholder-other",
      HTTP_PROXY: "http://untrusted.example:8080", HTTPS_PROXY: "http://untrusted.example:8080",
    };
    const worker = buildWorkerEnvironment(source, config);
    expect(Object.keys(worker).sort()).toEqual([
      "APPDATA", "CODEX_HOME", "CURSOR_HOME", "GBRAIN_AGENT_TOKEN", "GBRAIN_LUNA_TOKEN", "HOME", "LOCALAPPDATA",
      "PAPERCLIP_HOME", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "XDG_CONFIG_HOME",
    ].sort());
    expect(() => assertWorkerEnvironment(worker, config)).not.toThrow();
    expect(() => assertWorkerEnvironment(source, config)).toThrow("mismatched");
    expect(() => assertWorkerEnvironment({ ...worker, GBRAIN_RABBIT_TOKEN: "placeholder" }, config))
      .toThrow("unapproved key GBRAIN_RABBIT_TOKEN");
    expect(() => assertWorkerEnvironment({ ...worker, USERPROFILE: "C:/Users/Shared" }, config))
      .toThrow("worker home identity is mismatched");
    expect(() => assertWorkerEnvironment({ ...worker, HTTPS_PROXY: "http://127.0.0.1:7897" }, config))
      .toThrow("worker proxy was not explicitly configured");
  });

  it("passes only a configured loopback proxy and bypasses the control plane", () => {
    const proxied = { ...config, localProxyUrl: "http://127.0.0.1:7897" };
    const worker = buildWorkerEnvironment({ GBRAIN_LUNA_TOKEN: "placeholder-one",
      HTTPS_PROXY: "http://other.example:8080" }, proxied);
    expect(worker.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(worker.HTTP_PROXY).toBe(worker.HTTPS_PROXY);
    expect(worker.ALL_PROXY).toBe(worker.HTTPS_PROXY);
    expect(worker.NO_PROXY?.split(",")).toContain("alice.test");
    expect(() => assertWorkerEnvironment(worker, proxied)).not.toThrow();
    expect(() => assertWorkerEnvironment({ ...worker, HTTPS_PROXY: "http://other.example:8080" }, proxied))
      .toThrow("worker proxy configuration is mismatched");
  });

  it("refuses to build an environment when the member reference is absent", () => {
    expect(() => buildWorkerEnvironment({ GBRAIN_RABBIT_TOKEN: "placeholder" }, config))
      .toThrow("credential reference GBRAIN_LUNA_TOKEN is unavailable");
  });

  it("shares only the user's Codex login directory, not another member's keys", () => {
    const shared = { ...config, modelAuthMode: "shared_user_codex" as const };
    const worker = buildWorkerEnvironment({ GBRAIN_LUNA_TOKEN: "own-only",
      GBRAIN_RABBIT_TOKEN: "other", PAPERCLIP_API_KEY: "other" }, shared);
    expect(worker.CODEX_HOME).toMatch(/[\\/]\.codex$/);
    expect(worker.HOME).toBe(path.join(workerHome, "home"));
    expect(worker.APPDATA).toBe(path.join(workerHome, "appdata"));
    expect(worker.GBRAIN_RABBIT_TOKEN).toBeUndefined();
    expect(worker.PAPERCLIP_API_KEY).toBeUndefined();
    expect(() => assertWorkerEnvironment(worker, shared)).not.toThrow();
    expect(buildLocalAdapterConfig(shared.agents[0], shared, worker)).toEqual({
      ...shared.agents[0].localAdapterConfig, env: { CODEX_HOME: worker.CODEX_HOME },
      externalCodexHomeNoManagedWrites: true,
    });
  });

  it("routes Cursor subscription config to the shared user but skills and identity to the member", () => {
    const cursorAgent = { ...config.agents[0], adapterType: "cursor" as const,
      localAdapterConfig: { cwd: "H:/AIagent/Belle", command: "C:/tools/agent.exe", model: "auto" } };
    const shared: BridgeConfig = { ...config, modelAuthMode: "shared_user_cursor", agents: [cursorAgent] };
    const worker = buildWorkerEnvironment({ GBRAIN_LUNA_TOKEN: "own-only",
      GBRAIN_RABBIT_TOKEN: "other", CURSOR_API_KEY: "other", PAPERCLIP_API_KEY: "other" }, shared);
    expect(worker.CURSOR_CONFIG_DIR).toMatch(/[\\/]\.cursor$/);
    expect(worker.CURSOR_HOME).toBe(worker.CURSOR_CONFIG_DIR);
    expect(worker.HOME).toBe(path.join(workerHome, "home"));
    expect(worker.USERPROFILE).toBe(worker.HOME);
    expect(worker.APPDATA).toBe(path.join(workerHome, "appdata"));
    expect(worker.GBRAIN_RABBIT_TOKEN).toBeUndefined();
    expect(worker.CURSOR_API_KEY).toBeUndefined();
    expect(worker.PAPERCLIP_API_KEY).toBeUndefined();
    expect(() => assertWorkerEnvironment(worker, shared)).not.toThrow();
    const localConfig = buildLocalAdapterConfig(cursorAgent, shared, worker);
    expect(localConfig.env).toEqual({ HOME: worker.HOME, CURSOR_HOME: worker.CURSOR_HOME,
      CURSOR_CONFIG_DIR: worker.CURSOR_CONFIG_DIR });
    expect(resolveCursorSkillsHome(localConfig)).toBe(path.join(workerHome, "home", ".cursor", "skills"));
    expect(() => assertWorkerEnvironment({ ...worker, CURSOR_CONFIG_DIR: path.join(workerHome, "home") }, shared))
      .toThrow("Cursor config directory is mismatched");
  });
});
