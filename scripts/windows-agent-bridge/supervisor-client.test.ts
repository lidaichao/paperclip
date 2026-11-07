import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoUnreportedSupervisors, cancelSupervisor, verifySupervisorStopped,
  type SupervisorBinding } from "./supervisor-client.js";

const runId = "f2c991f1-b53d-4bb5-b134-8e29d43815d0";
const leaseId = "784d88a1-7a05-42d2-a7d8-e714d70f2d0b";
const deviceId = "8da47d3b-0a6e-49d4-9c26-17bc76de470f";
const nonce = "7c6b4410-0c4c-4384-b36a-127fb015d7fd";

describe("supervised model stop proof", () => {
  it("accepts only matching ready and stopped Job receipts", async () => {
    const receiptBaseDir = await mkdtemp(path.join(os.tmpdir(), "alice-supervisor-proof-"));
    const receiptDir = path.join(receiptBaseDir, runId, nonce);
    await mkdir(receiptDir, { recursive: true });
    const binding: SupervisorBinding = { executable: "C:\\tools\\PaperclipRunSupervisor.exe",
      receiptBaseDir, runId, leaseId, deviceId,
      bridgeCreationFileTime: "134071200000000000", bridgeSessionId: 1 };
    const reported = { pid: 9021, startedAt: "2026-11-07T12:00:00Z",
      supervisor: { nonce, receiptDir } };
    const shared = { runId, leaseId, deviceId, nonce, bridgePid: process.pid,
      bridgeCreationFileTime: binding.bridgeCreationFileTime, bridgeSessionId: 1,
      modelPid: 9022, modelCreationFileTime: "134071200000000001" };
    await writeFile(path.join(receiptDir, `${runId}.ready.json`), JSON.stringify({
      ...shared, cancelEvent: "Local\\PaperclipCancel-test" }));
    const stoppedFile = path.join(receiptDir, `${runId}.stopped.json`);
    await writeFile(stoppedFile, JSON.stringify({ ...shared, cause: "model_exit",
      modelExitCode: 0, activeProcesses: 0, completedAtUtc: "2026-11-07T12:01:00Z" }));
    await expect(verifySupervisorStopped(binding, reported)).resolves.toBeUndefined();
    await expect(cancelSupervisor(binding, reported)).rejects.toThrow("cancel identity is invalid");
    await expect(assertNoUnreportedSupervisors(binding, [reported])).resolves.toBeUndefined();
    await mkdir(path.join(receiptBaseDir, runId, "fbb60174-4ed8-4302-85ac-12ca356cc02e"));
    await expect(assertNoUnreportedSupervisors(binding, [reported]))
      .rejects.toThrow("without a matching process report");
    await writeFile(stoppedFile, JSON.stringify({ ...shared, cause: "model_exit",
      modelExitCode: 0, activeProcesses: 1, completedAtUtc: "2026-11-07T12:01:00Z" }));
    await expect(verifySupervisorStopped(binding, reported)).rejects.toThrow("does not match");
  });
});
