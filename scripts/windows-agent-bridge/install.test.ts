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
  });

  it("blocks scheduled-task installation while the server run contract is missing", async () => {
    const doctor = await readFile(path.join(root, "doctor.ps1"), "utf8");
    const install = await readFile(path.join(root, "install.ps1"), "utf8");
    expect(doctor).toContain("禁止安装");
    expect(install.indexOf("doctor.ps1")).toBeLessThan(install.indexOf("Register-ScheduledTask"));
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
