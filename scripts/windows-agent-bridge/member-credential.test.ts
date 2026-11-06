import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkerEnvironment } from "./environment.js";
import { loadMemberGbrainToken } from "./member-credential.js";
import type { BridgeAgentConfig, BridgeConfig } from "./types.js";

const agent: BridgeAgentConfig = { remoteAgentId: "38a5808c-47f3-4029-bdfe-0d84504bdc8a",
  remoteAgentName: "Luna", localAgentName: "Luna", gbrainEnvRef: "GBRAIN_LUNA_TOKEN",
  adapterType: "codex_local", localAdapterConfig: {}, maxConcurrentRuns: 1 };

describe("member-local GBrain credential reference", () => {
  it("takes the latest protected member file over a stale inherited environment", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "alice-gbrain-local-"));
    const file = path.join(dir, "gbrain-luna.json");
    await writeFile(file, JSON.stringify({ access_token: "member-current-placeholder" }), { mode: 0o600 });
    const selected = { ...agent, gbrainCredentialFile: file };
    const token = await loadMemberGbrainToken(selected, { GBRAIN_LUNA_TOKEN: "member-stale-placeholder" });
    const config: BridgeConfig = { schemaVersion: 3, deviceId: "8da47d3b-0a6e-49d4-9c26-17bc76de470f",
      workerHome: path.join(dir, agent.remoteAgentId), apiBase: "http://alice.test",
      companyId: "af8e9089-b0bb-43ac-ade3-c029c73b96e6", credentialsFile: "unused", stateFile: "unused",
      pollIntervalMs: 10_000, agents: [selected] };
    const worker = buildWorkerEnvironment({ GBRAIN_LUNA_TOKEN: "member-stale-placeholder" }, config, token);
    expect(worker.GBRAIN_AGENT_TOKEN).toBe("member-current-placeholder");
    expect(worker.GBRAIN_LUNA_TOKEN).toBe(worker.GBRAIN_AGENT_TOKEN);
  });

  it("rejects a missing local file rather than silently falling back to the old environment", async () => {
    await expect(loadMemberGbrainToken({ ...agent, gbrainCredentialFile: "C:/missing/member.json" },
      { GBRAIN_LUNA_TOKEN: "member-stale-placeholder" })).rejects.toThrow("file is unavailable");
  });

  it("supports an own named environment reference when no private file exists", async () => {
    expect(await loadMemberGbrainToken(agent, { GBRAIN_LUNA_TOKEN: "member-own-placeholder" }))
      .toBe("member-own-placeholder");
    await expect(loadMemberGbrainToken({ ...agent, gbrainEnvRef: "GBRAIN_RABBIT_TOKEN" },
      { GBRAIN_RABBIT_TOKEN: "member-other-placeholder" })).rejects.toThrow("gbrainEnvRef does not match");
  });
});
