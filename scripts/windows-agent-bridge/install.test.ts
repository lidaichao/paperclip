import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertModelAuthLaunchReady } from "./launcher.js";

const root = path.resolve(import.meta.dirname);

describe("installation safety", () => {
  it("contains no tunnel, console loop, broad deletion, or startup registry mutation", async () => {
    const names = ["install.ps1", "uninstall.ps1", "run-hidden.ps1", "doctor.ps1"];
    const body = (await Promise.all(names.map((name) => readFile(path.join(root, name), "utf8")))).join("\n");
    expect(body).not.toMatch(/while\s*\(\s*\$true\s*\)/i);
    expect(body).not.toMatch(/\bssh(?:\.exe)?\b/i);
    expect(body).not.toMatch(/CurrentVersion\\Run/i);
    expect(body).not.toMatch(/Get-ScheduledTask\s*\|/i);
    expect(body).not.toMatch(/Unregister-ScheduledTask(?![^\n]*-TaskName)/i);
  });

  it("hides every explicitly started process and uses one exact scheduled-task name", async () => {
    const runner = await readFile(path.join(root, "run-hidden.ps1"), "utf8");
    const install = await readFile(path.join(root, "install.ps1"), "utf8");
    expect(runner).toMatch(/Start-Process[\s\S]*-WindowStyle Hidden/);
    expect(install).toContain("$taskName = 'AliceWorker_' + $bridgeConfig.agents[0].remoteAgentId");
    expect(install).toContain("-WindowStyle Hidden");
    expect(runner).toContain("launcher.bundle.mjs");
    expect(install).not.toContain("-RestartCount");
    expect(install).toContain("GetFolderPath('Startup')");
    expect(install).toContain("$shortcut.WindowStyle = 7");
    expect(install).toContain("-ErrorAction Stop");
  });

  it("installs a self-contained hashed runtime instead of pointing startup at a worktree", async () => {
    const install = await readFile(path.join(root, "install.ps1"), "utf8");
    expect(install).toContain("Get-FileHash");
    expect(install).toContain("$bridgeHash");
    expect(install).toContain("$launcherHash-$bridgeHash-$supervisorHash");
    expect(install).toContain("runtime-config.json");
    expect(install).toContain("runtime");
    expect(install).toContain("Copy-Item");
    expect(install).toContain("RepairExisting");
    expect(install).not.toContain("$shortcut.WorkingDirectory = $PSScriptRoot");
  });

  it("copies every runtime resource required by the bundled bridge", async () => {
    const install = await readFile(path.join(root, "install.ps1"), "utf8");
    expect(install).toContain("codex-auth-merge-extract.sh");
    expect(install).toContain("codex-auth-merge-decision.cjs");
    expect(install).toContain("credential-helper.ps1");
  });

  it("preflights the bridge before scheduled-task installation", async () => {
    const doctor = await readFile(path.join(root, "doctor.ps1"), "utf8");
    const install = await readFile(path.join(root, "install.ps1"), "utf8");
    expect(doctor).toContain("/api/health");
    expect(doctor).toContain("supervisorExecutable");
    expect(install.indexOf("doctor.ps1")).toBeLessThan(install.indexOf("Register-ScheduledTask"));
  });

  it("starts only the explicit hidden service mode", async () => {
    const runner = await readFile(path.join(root, "run-hidden.ps1"), "utf8");
    expect(runner).toContain("'--service'");
    expect(runner).toMatch(/Get-Content[^\n]+-Encoding UTF8/);
  });

  it("does not start a private login for explicit shared Codex mode", async () => {
    const script = await readFile(path.join(root, "model-login-once.ps1"), "utf8");
    expect(script).toContain("$config.modelAuthMode -eq 'shared_user_codex'");
    expect(script.indexOf("if ($Login -or $Probe)")).toBeLessThan(script.indexOf("& $command login"));
    expect(script).toContain("$config.modelAuthMode -eq 'shared_user_cursor'");
    expect(() => assertModelAuthLaunchReady({ modelAuthMode: "shared_user_cursor" } as never))
      .toThrow("disabled until CLI writes");
    expect(() => assertModelAuthLaunchReady({ modelAuthMode: "private" } as never)).not.toThrow();
  });
});
