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
});
