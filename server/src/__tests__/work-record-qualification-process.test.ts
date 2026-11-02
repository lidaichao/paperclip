import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureQualifiedServerProcess,
  requireM2eTestedCommit,
  stopAndVerifyQualifiedServer,
} from "../../../tests/e2e/work-record-qualification-process.js";

const COMMIT = "a".repeat(40);

const SERVER_EVIDENCE = {
  tsxLauncherPid: 101,
  actualListenerPid: 202,
  actualListenerParentPid: 101,
  actualListenerPort: 43101,
  listenerIsTsxLauncher: false,
  listenerOwnedByTsxLauncher: true,
  tsxLauncherAliveAfterReady: true,
  actualListenerAliveAfterReady: true,
};

describe("M2-E qualification evidence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires the M2-E commit variable and ignores the retired M2-B variable", () => {
    expect(() => requireM2eTestedCommit({
      repoRoot: ".",
      env: { PAPERCLIP_M2B_TESTED_COMMIT: COMMIT },
      currentCommit: COMMIT,
    })).toThrow("PAPERCLIP_M2E_TESTED_COMMIT is required");

    expect(requireM2eTestedCommit({
      repoRoot: ".",
      env: {
        PAPERCLIP_M2E_TESTED_COMMIT: COMMIT,
        PAPERCLIP_M2B_TESTED_COMMIT: "b".repeat(40),
      },
      currentCommit: COMMIT,
    })).toBe(COMMIT);
  });

  it("rejects an empty, abbreviated, or different tested commit", () => {
    expect(() => requireM2eTestedCommit({ repoRoot: ".", env: {}, currentCommit: COMMIT }))
      .toThrow("is required");
    expect(() => requireM2eTestedCommit({
      repoRoot: ".",
      env: { PAPERCLIP_M2E_TESTED_COMMIT: "abc123" },
      currentCommit: COMMIT,
    })).toThrow("full 40-character");
    expect(() => requireM2eTestedCommit({
      repoRoot: ".",
      env: { PAPERCLIP_M2E_TESTED_COMMIT: COMMIT },
      currentCommit: "b".repeat(40),
    })).toThrow("does not match current commit");
  });

  it("does not fall back to process.env when an env object is explicitly provided", () => {
    vi.stubEnv("PAPERCLIP_M2E_TESTED_COMMIT", COMMIT);

    expect(() => requireM2eTestedCommit({
      repoRoot: ".",
      env: {},
      currentCommit: COMMIT,
    })).toThrow("PAPERCLIP_M2E_TESTED_COMMIT is required");

    expect(requireM2eTestedCommit({
      repoRoot: ".",
      currentCommit: COMMIT,
    })).toBe(COMMIT);
  });

  it("records the real listener separately from its tsx launcher", async () => {
    await expect(captureQualifiedServerProcess(
      { tsxLauncherPid: 101, port: 43101 },
      {
        readPortOwner: async () => 202,
        readParentPid: async () => 101,
        isOwnedBy: async () => true,
        isAlive: () => true,
      },
    )).resolves.toEqual({
      tsxLauncherPid: 101,
      actualListenerPid: 202,
      actualListenerParentPid: 101,
      actualListenerPort: 43101,
      listenerIsTsxLauncher: false,
      listenerOwnedByTsxLauncher: true,
      tsxLauncherAliveAfterReady: true,
      actualListenerAliveAfterReady: true,
    });
  });

  it("rejects a listener that is not descended from the launched tsx process", async () => {
    await expect(captureQualifiedServerProcess(
      { tsxLauncherPid: 101, port: 43101 },
      {
        readPortOwner: async () => 303,
        readParentPid: async () => 1,
        isOwnedBy: async () => false,
        isAlive: () => true,
      },
    )).rejects.toThrow("is not owned by tsx launcher");
  });

  it("stops a qualified server and reports a clean exit", async () => {
    const alivePids = new Set([SERVER_EVIDENCE.tsxLauncherPid, SERVER_EVIDENCE.actualListenerPid]);
    const killPid = vi.fn((pid: number) => {
      alivePids.delete(pid);
    });

    await expect(stopAndVerifyQualifiedServer(SERVER_EVIDENCE, {
      readPortOwner: async () => (
        alivePids.has(SERVER_EVIDENCE.actualListenerPid)
          ? SERVER_EVIDENCE.actualListenerPid
          : null
      ),
      isAlive: (pid) => alivePids.has(pid),
      killPid,
      waitForStopped: async () => undefined,
    })).resolves.toEqual({
      tsxLauncherAliveAfterExit: false,
      actualListenerAliveAfterExit: false,
      portOwnerPidAfterExit: null,
      noResidualListener: true,
    });
    expect(killPid.mock.calls).toEqual([
      [SERVER_EVIDENCE.actualListenerPid, "SIGTERM"],
      [SERVER_EVIDENCE.tsxLauncherPid, "SIGTERM"],
    ]);
  });

  it("fails when the qualified server leaves residual processes and a listener", async () => {
    const killPid = vi.fn();

    await expect(stopAndVerifyQualifiedServer(SERVER_EVIDENCE, {
      readPortOwner: async () => SERVER_EVIDENCE.actualListenerPid,
      isAlive: () => true,
      killPid,
      waitForStopped: async () => undefined,
    })).rejects.toThrow("Qualified server left a residual process");
    expect(killPid.mock.calls).toEqual([
      [SERVER_EVIDENCE.actualListenerPid, "SIGTERM"],
      [SERVER_EVIDENCE.tsxLauncherPid, "SIGTERM"],
      [SERVER_EVIDENCE.actualListenerPid, "SIGKILL"],
      [SERVER_EVIDENCE.tsxLauncherPid, "SIGKILL"],
    ]);
  });
});
