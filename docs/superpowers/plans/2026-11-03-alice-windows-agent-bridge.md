# Alice Windows Agent Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Alice server at `http://192.168.72.157:3100` dispatch assigned Paperclip work to the existing Windows-hosted Luna team agents without SSH tunnels, visible terminal windows, or duplicate execution.

**Architecture:** A single Windows-side bridge polls each configured remote agent inbox over authenticated Paperclip APIs. It reuses the existing Codex/Cursor local adapter implementations to execute in the member's local workspace, persists an atomic dispatch ledger before every launch, and sends run output only through the normal Paperclip task API used by the agent. Installation is explicit and separate from implementation; no task in this plan starts the bridge automatically.

**Tech Stack:** Node.js 24, TypeScript, existing `@paperclipai/adapter-codex-local` and `@paperclipai/adapter-cursor-local`, Vitest, PowerShell 7, Windows DPAPI.

## Implementation Status (2026-11-03)

- Tasks 1-4 are implemented and covered by unit tests.
- Task 5 installation, rollback, doctor, and operator documentation are implemented and covered by static safety tests.
- The bridge is intentionally not installed or started. Live doctor, credential creation, one-task acceptance, and activation remain gated on explicit operator confirmation.

## Global Constraints

- Alice remains hosted at `192.168.72.157`; agent processes remain on the Windows workstation.
- The bridge opens outbound HTTP(S) connections only. It must not create SSH tunnels or listeners.
- Every spawned process uses `windowsHide: true`; installation must never open a visible console loop.
- One task can have only one active local execution lease; retries use bounded exponential backoff.
- API keys never appear in arguments, prompts, logs, state files, or source control.
- Agent identities remain isolated by agent ID, workspace, instructions file, runtime session, and credential reference.
- The bridge is implemented and tested first; activation requires a separate explicit operator action.

---

## File Structure

- `scripts/windows-agent-bridge/types.ts` — bridge configuration, inbox item, dispatch ledger, and adapter contracts.
- `scripts/windows-agent-bridge/config.ts` — strict configuration loading and validation.
- `scripts/windows-agent-bridge/credentials.ts` — DPAPI credential loading through a hidden PowerShell child process.
- `scripts/windows-agent-bridge/paperclip-client.ts` — authenticated read-only inbox and identity requests.
- `scripts/windows-agent-bridge/state-store.ts` — atomic ledger persistence and crash recovery.
- `scripts/windows-agent-bridge/dispatcher.ts` — deterministic task selection, lease acquisition, and retry policy.
- `scripts/windows-agent-bridge/adapter-runtime.ts` — existing Codex/Cursor adapter invocation with Alice environment injection.
- `scripts/windows-agent-bridge/main.ts` — single-instance lifecycle and polling loop.
- `scripts/windows-agent-bridge/credential-helper.ps1` — CurrentUser DPAPI encrypt/decrypt helper.
- `scripts/windows-agent-bridge/install.ps1` — explicit hidden startup registration; never run as part of tests/build.
- `scripts/windows-agent-bridge/uninstall.ps1` — stop and remove only the exact registered bridge entry.
- `scripts/windows-agent-bridge/*.test.ts` — focused unit and integration tests.
- `docs/deploy/windows-agent-bridge.md` — operator procedure, status checks, rollback, and troubleshooting.

### Task 1: Configuration and secret boundary

**Files:**
- Create: `scripts/windows-agent-bridge/types.ts`
- Create: `scripts/windows-agent-bridge/config.ts`
- Create: `scripts/windows-agent-bridge/credentials.ts`
- Create: `scripts/windows-agent-bridge/credential-helper.ps1`
- Test: `scripts/windows-agent-bridge/config.test.ts`
- Test: `scripts/windows-agent-bridge/credentials.test.ts`

**Interfaces:**
- Produces: `loadBridgeConfig(path: string): Promise<BridgeConfig>`.
- Produces: `loadAgentTokens(path: string): Promise<Map<string, string>>`.
- `BridgeConfig.agents[]` binds `remoteAgentId`, `remoteAgentName`, `localAgentName`, `adapterType`, and `pollIntervalMs`.

- [ ] **Step 1: Write failing configuration tests**

```ts
it("rejects non-Alice origins and duplicate agent ids", async () => {
  await expect(loadBridgeConfig(fixture({ apiBase: "file:///tmp" }))).rejects.toThrow("http or https");
  await expect(loadBridgeConfig(fixture({ agents: [agent("a"), agent("a")] }))).rejects.toThrow("duplicate remoteAgentId");
});

it("never accepts inline tokens", async () => {
  await expect(loadBridgeConfig(fixture({ agents: [{ ...agent("a"), apiKey: "secret" }] })))
    .rejects.toThrow("credentialsFile");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm exec vitest run scripts/windows-agent-bridge/config.test.ts scripts/windows-agent-bridge/credentials.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement strict config types and parser**

```ts
export interface BridgeAgentConfig {
  remoteAgentId: string;
  remoteAgentName: string;
  localAgentName: string;
  adapterType: "codex_local" | "cursor";
  maxConcurrentRuns: 1;
}

export interface BridgeConfig {
  schemaVersion: 1;
  apiBase: string;
  companyId: string;
  localApiBase: "http://127.0.0.1:3100";
  localCompanyId: string;
  credentialsFile: string;
  stateFile: string;
  pollIntervalMs: number;
  agents: BridgeAgentConfig[];
}
```

The parser must normalize a trailing slash, allow only `http:`/`https:`, require `pollIntervalMs` between 5,000 and 300,000, reject unknown keys, reject duplicate remote IDs/names, and forbid `apiKey`, `token`, and `secret` keys at every nesting level.

- [ ] **Step 4: Implement DPAPI helper and hidden loader**

`credential-helper.ps1` accepts only `protect` or `unprotect`, uses `[Security.Cryptography.ProtectedData]` with `DataProtectionScope::CurrentUser`, reads plaintext JSON from stdin, and writes only encrypted base64 or decrypted JSON to stdout. `credentials.ts` invokes PowerShell with `windowsHide: true`, `shell: false`, piped stdio, and rejects output containing unknown agent IDs.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm exec vitest run scripts/windows-agent-bridge/config.test.ts scripts/windows-agent-bridge/credentials.test.ts`

Expected: PASS.

Commit: `feat(bridge): add validated Windows bridge configuration`

### Task 2: Read-only Alice client and atomic dispatch ledger

**Files:**
- Create: `scripts/windows-agent-bridge/paperclip-client.ts`
- Create: `scripts/windows-agent-bridge/state-store.ts`
- Test: `scripts/windows-agent-bridge/paperclip-client.test.ts`
- Test: `scripts/windows-agent-bridge/state-store.test.ts`

**Interfaces:**
- Consumes: `BridgeConfig`, per-agent token map.
- Produces: `AliceClient.verifyIdentity()`, `AliceClient.listInbox()`.
- Produces: `StateStore.tryAcquire(issue, agentId)`, `markRunning`, `markFinished`, `markRetryable`, and `recoverOrphans`.

- [ ] **Step 1: Write failing API contract tests**

```ts
it("sends bearer auth but never logs it", async () => {
  const client = new AliceClient({ apiBase, token: "pc_secret", fetch: fakeFetch });
  await client.verifyIdentity("agent-a", "company-a");
  expect(fakeFetch.last.headers.authorization).toBe("Bearer pc_secret");
  expect(logger.lines.join("\n")).not.toContain("pc_secret");
});

it("rejects an identity mismatch before polling", async () => {
  fakeFetch.reply({ id: "agent-b", companyId: "company-a" });
  await expect(client.verifyIdentity("agent-a", "company-a")).rejects.toThrow("identity mismatch");
});
```

- [ ] **Step 2: Write failing atomic state tests**

```ts
it("does not acquire the same task twice", async () => {
  expect(await store.tryAcquire(issue, "agent-a")).toBe(true);
  expect(await store.tryAcquire(issue, "agent-a")).toBe(false);
});

it("recovers a running record only when its pid is gone", async () => {
  await store.markRunning(issue.id, { pid: 4123, startedAt });
  expect(await store.recoverOrphans(() => false)).toEqual([issue.id]);
});
```

- [ ] **Step 3: Implement the client**

Use `GET /api/agents/me` for identity and `GET /api/agents/me/inbox` for assigned work. Accept only tasks assigned to the configured agent and normalize `todo`/`in_progress` records into `BridgeInboxItem`. Apply a 10-second request timeout, redact authorization headers from errors, and make no mutation request.

- [ ] **Step 4: Implement the state store**

Write `schemaVersion: 1` JSON to an unpredictable sibling file, flush it, atomically rename it, and retain at most 500 terminal records. The lease key is `${agentId}:${issueId}:${issue.updatedAt}`. A current `running` lease blocks duplicates until the tracked PID is absent.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm exec vitest run scripts/windows-agent-bridge/paperclip-client.test.ts scripts/windows-agent-bridge/state-store.test.ts`

Expected: PASS.

Commit: `feat(bridge): add Alice inbox client and dispatch ledger`

### Task 3: Local Codex/Cursor execution

**Files:**
- Create: `scripts/windows-agent-bridge/adapter-runtime.ts`
- Test: `scripts/windows-agent-bridge/adapter-runtime.test.ts`
- Modify: `packages/adapter-utils/src/server-utils.ts`
- Test: `packages/adapter-utils/src/server-utils.test.ts`

**Interfaces:**
- Consumes: remote identity, task ID, token, and redacted local adapter configuration.
- Produces: `runLocalAgent(input: LocalAgentRunInput): Promise<LocalAgentRunResult>`.

- [ ] **Step 1: Add a Windows hidden-process regression test**

Mock `child_process.spawn` and assert that `runChildProcess` passes:

```ts
expect(spawn).toHaveBeenCalledWith(command, args, expect.objectContaining({
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
}));
```

- [ ] **Step 2: Implement hidden child creation**

Add `windowsHide: true` to the existing `spawn` options in `runChildProcess`. Keep `detached: process.platform !== "win32"` and all existing process-group cleanup unchanged.

- [ ] **Step 3: Write adapter-runtime tests**

Verify that Codex and Cursor calls receive `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, and `PAPERCLIP_TASK_ID` through environment/context only. Assert that the token is absent from prompt, logs, invocation metadata, and thrown errors.

- [ ] **Step 4: Implement adapter dispatch**

Call the existing adapter `execute()` functions with a locally generated run UUID, local workspace/config, remote agent identity, `context.taskId`, `context.wakeReason = "assignment"`, and `authToken`. Persist `onSpawn` metadata before returning control. Cap log files at 10 MiB per run and retain only the latest 20 runs per agent.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts scripts/windows-agent-bridge/adapter-runtime.test.ts`

Expected: PASS.

Commit: `feat(bridge): execute Alice agents through hidden local adapters`

### Task 4: Poller, backoff, and single-instance lifecycle

**Files:**
- Create: `scripts/windows-agent-bridge/dispatcher.ts`
- Create: `scripts/windows-agent-bridge/main.ts`
- Test: `scripts/windows-agent-bridge/dispatcher.test.ts`
- Test: `scripts/windows-agent-bridge/main.test.ts`

**Interfaces:**
- Consumes: client, state store, runtime, configuration, and tokens.
- Produces: one long-lived local bridge process with deterministic shutdown.

- [ ] **Step 1: Write scheduling tests**

Test one active task per agent, fair round-robin across agents, no relaunch of unchanged terminal tasks, a 5-second/15-second/45-second/2-minute retry schedule capped at 5 minutes, and immediate cancellation on SIGTERM.

- [ ] **Step 2: Implement deterministic selection**

Order eligible tasks by `priority desc`, `updatedAt asc`, then `identifier asc`. Acquire the ledger before launch. Do not execute completed, cancelled, blocked, or unassigned tasks. A task updated after a failed run becomes eligible with a new lease key.

- [ ] **Step 3: Implement single-instance locking**

Create an exclusive lock file containing PID and start time. If a healthy PID owns it, exit with code 0 and one log line. If stale, atomically replace it. On shutdown, abort polling, wait up to 20 seconds for child cleanup, write final ledger state, then release the lock.

- [ ] **Step 4: Add health output**

Write `health.json` atomically with `connected`, `lastSuccessfulPollAt`, each agent's `idle|running|backoff|disabled` state, active task identifier, and redacted last error. Never include command arguments, environment, or credentials.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm exec vitest run scripts/windows-agent-bridge/dispatcher.test.ts scripts/windows-agent-bridge/main.test.ts`

Expected: PASS.

Commit: `feat(bridge): add reliable Windows agent polling lifecycle`

### Task 5: Explicit installation, dry run, and acceptance

**Files:**
- Create: `scripts/windows-agent-bridge/install.ps1`
- Create: `scripts/windows-agent-bridge/uninstall.ps1`
- Create: `scripts/windows-agent-bridge/doctor.ps1`
- Create: `docs/deploy/windows-agent-bridge.md`
- Test: `scripts/windows-agent-bridge/install.test.ts`

**Interfaces:**
- Produces: installation/rollback commands that act only when invoked explicitly.
- Produces: a dry-run doctor that performs no task execution.

- [ ] **Step 1: Write installation safety tests**

Inspect scripts as text and assert there is no `while ($true)`, no SSH command, no Run registry mutation, no broad scheduled-task deletion, and every process start includes `-WindowStyle Hidden` or `windowsHide: true`.

- [ ] **Step 2: Implement explicit installation**

Register one exact task named `AliceWindowsAgentBridge` for the current user with a 60-second restart delay and a maximum of 3 restarts per hour. The action launches a hidden PowerShell wrapper which starts Node with redirected log files. Installation first runs `doctor.ps1`; any failed identity, credential, executable, workspace, or 192 health check aborts without registering anything.

- [ ] **Step 3: Implement exact rollback**

`uninstall.ps1` stops only the recorded bridge PID after verifying executable path and command line, removes only `AliceWindowsAgentBridge`, and leaves config, encrypted credentials, logs, Alice, and local 127 Paperclip untouched.

- [ ] **Step 4: Run non-activating acceptance**

Run: `pnpm exec vitest run scripts/windows-agent-bridge/*.test.ts`

Run: `pwsh -NoProfile -File scripts/windows-agent-bridge/doctor.ps1 -Config <path> -DryRun`

Expected: all tests pass; doctor reports server/identity/workspace readiness; no bridge process, scheduled task, SSH process, or visible terminal is created.

- [ ] **Step 5: Document activation gate and commit**

The operator document must state: implementation completion does not authorize installation; activation requires explicit confirmation, creation of remote per-agent keys through official Paperclip API/CLI, one controlled test task, and rollback verification.

Commit: `docs(bridge): add safe install and rollback procedure`

## Self-Review

- **Spec coverage:** local agents stay local; Alice stays on 192; no SSH; no visible terminal; Codex and Cursor supported; agent/task deduplication, crash recovery, backoff, secret isolation, health, and rollback all have implementation tasks.
- **Placeholder scan:** no TBD/TODO/"implement later" markers remain.
- **Type consistency:** `BridgeConfig`, `BridgeAgentConfig`, `AliceClient`, `StateStore`, and `runLocalAgent` are defined before downstream use and keep the same names throughout.
- **Activation boundary:** no plan step silently installs or starts the bridge; the only activation procedure is an explicit operator action after acceptance.
