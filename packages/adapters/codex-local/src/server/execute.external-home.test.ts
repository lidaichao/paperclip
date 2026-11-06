import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { processRun, ensureCommand, resolveCommand, vendCredential, skillSource } = vi.hoisted(() => ({
  processRun: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false,
    stdout: "", stderr: "", pid: 123, startedAt: new Date().toISOString() })),
  ensureCommand: vi.fn(async () => undefined),
  resolveCommand: vi.fn(async () => "codex"),
  vendCredential: vi.fn(async () => "unchanged"),
  skillSource: { path: "" },
}));
vi.mock("./codex-auth-cache.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-auth-cache.js")>("./codex-auth-cache.js");
  return { ...actual, selectVendCredential: vendCredential };
});
vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, readPaperclipRuntimeSkillEntries: vi.fn(async () => [{
    key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: skillSource.path,
  }]) };
});
vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return { ...actual, runAdapterExecutionTargetProcess: processRun,
    ensureAdapterExecutionTargetCommandResolvable: ensureCommand,
    resolveAdapterExecutionTargetCommandForLogs: resolveCommand };
});
import { execute } from "./execute.js";

describe("Codex external home without adapter writes", () => {
  it("preserves shared config, skills and auth while invoking the local CLI", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-external-home-"));
    try {
      const home = path.join(root, "shared");
      const cwd = path.join(root, "member");
      await fs.mkdir(path.join(home, "skills"), { recursive: true });
      await fs.mkdir(cwd);
      skillSource.path = path.join(root, "fixture-skill");
      await fs.mkdir(skillSource.path);
      await fs.writeFile(path.join(skillSource.path, "SKILL.md"), "fixture");
      const configFile = path.join(home, "config.toml");
      const authFile = path.join(home, "auth.json");
      const skillFile = path.join(home, "skills", "sentinel.txt");
      await fs.writeFile(configFile, "# unchanged shared config\n");
      await fs.writeFile(authFile, '{"OPENAI_API_KEY":"test-only"}');
      await fs.writeFile(skillFile, "unchanged skill");
      const before = await Promise.all([configFile, authFile, skillFile].map((file) => fs.readFile(file, "utf8")));
      const writes = vi.spyOn(fs, "writeFile");
      const links = vi.spyOn(fs, "symlink");
      const invoke = async (noManagedWrites: boolean) => execute({
        runId: "test-external-home", agent: { id: "agent-1", companyId: "company-1", name: "Luna",
          adapterType: "codex_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command: "codex", cwd,
          env: { CODEX_HOME: home },
          ...(noManagedWrites ? { externalCodexHomeNoManagedWrites: true } : {}) },
        context: {}, onLog: async () => undefined,
      });
      await invoke(true);
      const after = await Promise.all([configFile, authFile, skillFile].map((file) => fs.readFile(file, "utf8")));
      expect(writes.mock.calls.map(([file]) => String(file))).not.toContain(configFile);
      expect(links).not.toHaveBeenCalled();
      expect(vendCredential).not.toHaveBeenCalled();
      expect(after).toEqual(before);
      expect((await fs.readdir(path.join(home, "skills"))).sort()).toEqual(["sentinel.txt"]);
      expect(processRun).toHaveBeenCalled();
      writes.mockClear();
      links.mockClear();
      await invoke(false);
      expect(writes.mock.calls.map(([file]) => String(file))).toContain(configFile);
      expect(links).toHaveBeenCalled();
      expect(vendCredential).toHaveBeenCalled();
      writes.mockRestore();
      links.mockRestore();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
