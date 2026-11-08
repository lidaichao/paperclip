import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAP17_G2_IDS } from "./pap17-g2-fixture-ids.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("PAP-17 G2 live fixture", () => {
  it("uses stable native IDs for evidence rebinding", () => {
    expect(new Set(Object.values(PAP17_G2_IDS)).size).toBe(Object.keys(PAP17_G2_IDS).length);
    expect(PAP17_G2_IDS.repairRunId).toBe("17000000-0000-4000-8000-000000000701");
    expect(PAP17_G2_IDS.qaItemId).toBe("17000000-0000-4000-8000-000000001102");
  });

  it("prepares only the isolated service and leaves both bridge phases to the outer driver", async () => {
    const script = await readFile(path.join(here, "prepare-pap17-g2-fixture.ps1"), "utf8");
    expect(script).toContain("bridgeStartedByPrepare = $false");
    expect(script).toContain("modelStartedByPrepare = $false");
    expect(script).toContain("HEARTBEAT_SCHEDULER_ENABLED = 'false'");
    expect(script).not.toMatch(/192\.168\.72\.157:3100/);
    expect(script).toContain("-Phase repair");
    expect(script).toContain("-Phase qa");
  });

  it("requires a confirmed service and PostgreSQL stop before cleanup", async () => {
    const stop = await readFile(path.join(here, "stop-pap17-g2-fixture.ps1"), "utf8");
    const remove = await readFile(path.join(here, "remove-pap17-g2-fixture.ps1"), "utf8");
    expect(stop).toContain("databasePortClosed");
    expect(stop).toContain("serviceProcessAbsent");
    expect(remove).toContain("$stopped.confirmed -ne $true");
    expect(remove).toContain("(Split-Path -Leaf $root) -ne 'g2-live-fixture'");
  });
});
