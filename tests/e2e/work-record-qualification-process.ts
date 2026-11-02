import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  isLocalServiceProcessOwnedBy,
  readLocalServicePortOwner,
} from "../../server/src/services/local-service-supervisor.js";

const execFileAsync = promisify(execFile);

export type QualifiedServerProcess = {
  tsxLauncherPid: number;
  actualListenerPid: number;
  actualListenerParentPid: number | null;
  actualListenerPort: number;
  listenerIsTsxLauncher: boolean;
  listenerOwnedByTsxLauncher: boolean;
  tsxLauncherAliveAfterReady: boolean;
  actualListenerAliveAfterReady: boolean;
};

export type QualifiedServerExit = {
  tsxLauncherAliveAfterExit: boolean;
  actualListenerAliveAfterExit: boolean;
  portOwnerPidAfterExit: number | null;
  noResidualListener: boolean;
};

type ProcessEvidenceDependencies = {
  readPortOwner: (port: number) => Promise<number | null>;
  readParentPid: (pid: number) => Promise<number | null>;
  isOwnedBy: (pid: number, ownerPid: number) => Promise<boolean>;
  isAlive: (pid: number) => boolean;
};

const defaultDependencies: ProcessEvidenceDependencies = {
  readPortOwner: readLocalServicePortOwner,
  readParentPid: readParentProcessId,
  isOwnedBy: isLocalServiceProcessOwnedBy,
  isAlive: isProcessAlive,
};

export function requireM2eTestedCommit(input: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  currentCommit?: string;
}) {
  const env = input.env === undefined ? process.env : input.env;
  const testedCommit = env.PAPERCLIP_M2E_TESTED_COMMIT?.trim();
  if (!testedCommit) {
    throw new Error("PAPERCLIP_M2E_TESTED_COMMIT is required");
  }
  if (!/^[0-9a-f]{40}$/i.test(testedCommit)) {
    throw new Error("PAPERCLIP_M2E_TESTED_COMMIT must be a full 40-character git commit");
  }
  const currentCommit = input.currentCommit ?? execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: input.repoRoot, encoding: "utf8" },
  ).trim();
  if (testedCommit.toLowerCase() !== currentCommit.toLowerCase()) {
    throw new Error(
      `PAPERCLIP_M2E_TESTED_COMMIT ${testedCommit} does not match current commit ${currentCommit}`,
    );
  }
  return testedCommit;
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readParentProcessId(pid: number) {
  try {
    if (process.platform === "win32") {
      const script = [
        `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue`,
        "if ($null -ne $process) { Write-Output ([int]$process.ParentProcessId) }",
      ].join("\n");
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);
      const parsed = Number.parseInt(stdout.trim(), 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function captureQualifiedServerProcess(
  input: { tsxLauncherPid: number; port: number },
  dependencies: ProcessEvidenceDependencies = defaultDependencies,
): Promise<QualifiedServerProcess> {
  const actualListenerPid = await dependencies.readPortOwner(input.port);
  if (!actualListenerPid) {
    throw new Error(`No actual listener PID found for qualified server port ${input.port}`);
  }
  const listenerOwnedByTsxLauncher = await dependencies.isOwnedBy(
    actualListenerPid,
    input.tsxLauncherPid,
  );
  if (!listenerOwnedByTsxLauncher) {
    throw new Error(
      `Listener PID ${actualListenerPid} on port ${input.port} is not owned by tsx launcher ${input.tsxLauncherPid}`,
    );
  }
  const actualListenerParentPid = await dependencies.readParentPid(actualListenerPid);
  if (!actualListenerParentPid) {
    throw new Error(`Could not resolve parent PID for listener ${actualListenerPid}`);
  }
  const tsxLauncherAliveAfterReady = dependencies.isAlive(input.tsxLauncherPid);
  const actualListenerAliveAfterReady = dependencies.isAlive(actualListenerPid);
  if (!tsxLauncherAliveAfterReady || !actualListenerAliveAfterReady) {
    throw new Error(
      `Qualified server process was not live after ready health: ${JSON.stringify({
        tsxLauncherPid: input.tsxLauncherPid,
        tsxLauncherAliveAfterReady,
        actualListenerPid,
        actualListenerAliveAfterReady,
      })}`,
    );
  }
  return {
    tsxLauncherPid: input.tsxLauncherPid,
    actualListenerPid,
    actualListenerParentPid,
    actualListenerPort: input.port,
    listenerIsTsxLauncher: actualListenerPid === input.tsxLauncherPid,
    listenerOwnedByTsxLauncher,
    tsxLauncherAliveAfterReady,
    actualListenerAliveAfterReady,
  };
}

async function waitForStopped(
  evidence: QualifiedServerProcess,
  timeoutMs: number,
  dependencies: Pick<ProcessEvidenceDependencies, "readPortOwner" | "isAlive">,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const portOwner = await dependencies.readPortOwner(evidence.actualListenerPort);
    if (
      !dependencies.isAlive(evidence.tsxLauncherPid)
      && !dependencies.isAlive(evidence.actualListenerPid)
      && portOwner === null
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
}

function killPid(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!["ESRCH", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

type StopServerDependencies = Pick<
  ProcessEvidenceDependencies,
  "readPortOwner" | "isAlive"
> & {
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  waitForStopped: typeof waitForStopped;
};

const defaultStopServerDependencies: StopServerDependencies = {
  readPortOwner: defaultDependencies.readPortOwner,
  isAlive: defaultDependencies.isAlive,
  killPid,
  waitForStopped,
};

export async function stopAndVerifyQualifiedServer(
  evidence: QualifiedServerProcess,
  dependencies: StopServerDependencies = defaultStopServerDependencies,
): Promise<QualifiedServerExit> {
  dependencies.killPid(evidence.actualListenerPid, "SIGTERM");
  if (!evidence.listenerIsTsxLauncher) {
    dependencies.killPid(evidence.tsxLauncherPid, "SIGTERM");
  }
  await dependencies.waitForStopped(evidence, 5_000, dependencies);

  const ownerBeforeForce = await dependencies.readPortOwner(evidence.actualListenerPort);
  if (ownerBeforeForce === evidence.actualListenerPid && dependencies.isAlive(evidence.actualListenerPid)) {
    dependencies.killPid(evidence.actualListenerPid, "SIGKILL");
  }
  if (dependencies.isAlive(evidence.tsxLauncherPid)) {
    dependencies.killPid(evidence.tsxLauncherPid, "SIGKILL");
  }
  await dependencies.waitForStopped(evidence, 2_000, dependencies);

  const portOwnerPidAfterExit = await dependencies.readPortOwner(evidence.actualListenerPort);
  const result: QualifiedServerExit = {
    tsxLauncherAliveAfterExit: dependencies.isAlive(evidence.tsxLauncherPid),
    actualListenerAliveAfterExit: dependencies.isAlive(evidence.actualListenerPid),
    portOwnerPidAfterExit,
    noResidualListener: portOwnerPidAfterExit === null,
  };
  if (
    result.tsxLauncherAliveAfterExit
    || result.actualListenerAliveAfterExit
    || !result.noResidualListener
  ) {
    throw new Error(`Qualified server left a residual process: ${JSON.stringify(result)}`);
  }
  return result;
}
