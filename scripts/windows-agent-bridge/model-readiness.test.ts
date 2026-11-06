import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPrivateModelAuthReady } from "./model-readiness.js";
import type { BridgeConfig } from "./types.js";

function fixture(workerHome: string, adapterType: "codex_local" | "cursor"): BridgeConfig {
  return { schemaVersion: 3, deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
    workerHome, apiBase: "http://alice.test", companyId: "af8e9089-b0bb-43ac-ade3-c029c73b96e6",
    credentialsFile: path.join(workerHome, "credentials.dpapi"), stateFile: path.join(workerHome, "state.json"),
    pollIntervalMs: 10000, agents: [{ remoteAgentId: "38a5808c-47f3-4029-bdfe-0d84504bdc8a",
      remoteAgentName: "Luna", localAgentName: "Luna", gbrainEnvRef: "GBRAIN_LUNA_TOKEN",
      adapterType, localAdapterConfig: { cwd: "H:/AIagent/Luna", command: "C:/tools/agent.exe" }, maxConcurrentRuns: 1 }],
  };
}

describe("private member model login preflight", () => {
  it("requires Codex login in the isolated CODEX_HOME", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "model-auth-"));
    const config = fixture(home, "codex_local");
    await expect(assertPrivateModelAuthReady(config, config.agents[0])).rejects.toThrow("missing");
    await mkdir(path.join(home, "codex-home"));
    await writeFile(path.join(home, "codex-home", "auth.json"), "{}");
    await expect(assertPrivateModelAuthReady(config, config.agents[0])).rejects.toThrow("Codex login");
    await writeFile(path.join(home, "codex-home", "auth.json"), '{"OPENAI_API_KEY":"test-only"}');
    await expect(assertPrivateModelAuthReady(config, config.agents[0])).resolves.toBeUndefined();
  });

  it("requires Cursor login in the isolated HOME", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "model-auth-"));
    const config = fixture(home, "cursor");
    await mkdir(path.join(home, "home", ".cursor"), { recursive: true });
    await writeFile(path.join(home, "home", ".cursor", "cli-config.json"), "{}");
    await expect(assertPrivateModelAuthReady(config, config.agents[0])).rejects.toThrow("Cursor login");
    await writeFile(path.join(home, "home", ".cursor", "cli-config.json"), '{"authInfo":{"email":"example.test"}}');
    await expect(assertPrivateModelAuthReady(config, config.agents[0])).resolves.toBeUndefined();
  });

  it("accepts a shared Codex subscription without copying it into the worker home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-auth-shared-"));
    const workerHome = path.join(root, "worker");
    const userHome = path.join(root, "user");
    const config = { ...fixture(workerHome, "codex_local"), modelAuthMode: "shared_user_codex" as const };
    await mkdir(workerHome);
    await mkdir(path.join(userHome, ".codex"), { recursive: true });
    await writeFile(path.join(userHome, ".codex", "auth.json"),
      '{"tokens":{"account_id":"test","refresh_token":"test-only"}}');
    await expect(assertPrivateModelAuthReady(config, config.agents[0], userHome)).resolves.toBeUndefined();
    await expect(assertPrivateModelAuthReady(config, config.agents[0], path.join(root, "other")))
      .rejects.toThrow("missing");
  });

  it("accepts shared Cursor auth only from the current user's config directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-auth-shared-"));
    const workerHome = path.join(root, "worker");
    const userHome = path.join(root, "user");
    const config = { ...fixture(workerHome, "cursor"), modelAuthMode: "shared_user_cursor" as const };
    await mkdir(workerHome);
    await mkdir(path.join(userHome, ".cursor"), { recursive: true });
    await writeFile(path.join(userHome, ".cursor", "cli-config.json"),
      '{"authInfo":{"email":"example.test"}}');
    await expect(assertPrivateModelAuthReady(config, config.agents[0], userHome)).resolves.toBeUndefined();
    await expect(assertPrivateModelAuthReady(config, config.agents[0], path.join(root, "other")))
      .rejects.toThrow("missing");
  });
});
