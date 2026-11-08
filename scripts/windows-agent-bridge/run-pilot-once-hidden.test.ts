import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("one-shot hidden pilot driver", () => {
  it("stays serial, hidden, bounded and evidence-producing", async () => {
    const script = await readFile(new URL("./run-pilot-once-hidden.ps1", import.meta.url), "utf8");

    expect(script).toContain("'--pilot-once'");
    expect(script).toContain("-WindowStyle Hidden");
    expect(script).toContain("Bridge lock exists; finish the current member run");
    expect(script).toContain("Active claim exists; finish run");
    expect(script).toContain("launcherExitCode");
    expect(script).toContain("supervisorPid");
    expect(script).toContain("modelPid");
    expect(script).toContain("cwd =");
    expect(script).toContain("stateClaimCleared");
    expect(script).toContain("activeProcesses");
    expect(script).toContain("process-evidence.json");
    expect(script).not.toMatch(/Register-ScheduledTask|schtasks(?:\.exe)?|while\s*\(\s*\$true\s*\)/i);
  });
});
