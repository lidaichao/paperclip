# Windows local run supervisor

This directory contains a standalone Windows-subsystem executable. The TypeScript
bridge and local adapter path now verify matching stopped receipts. The bridge's
installation and direct-run hard gate remains closed pending real CLI and 192
pilot validation. Build with `./build.ps1` and run
the fake-process checks with `./test.ps1`. Both scripts require Windows and the
64-bit .NET Framework 4 `csc.exe`; the runtime does not require the .NET SDK.

## Protocol v1

`PaperclipRunSupervisor.exe identity <bridgePid>` writes one line to redirected
stdout: `<pid> <GetProcessTimes creation FILETIME as decimal> <sessionId>`.
The caller captures these three values for the launch frame. PID alone is not
an identity.

`PaperclipRunSupervisor.exe run` accepts a single binary frame on redirected
stdin, then the model's raw stdin bytes until EOF:

1. Four-byte little-endian signed length for the UTF-8 JSON header (1 to 4 MiB).
2. JSON header with `runId`, `leaseId`, `deviceId`, `nonce` (UUIDs except the
   device ID), `bridgePid`, `bridgeCreationFileTime` (decimal string),
   `bridgeSessionId`, `receiptDir`, `cwd`, `executable`, `args` (string array),
   and `env` (complete string map).
3. Raw model stdin, at most 64 MiB. Close stdin after writing it.

The three paths must be absolute local-drive paths, `executable` must be an
existing `.exe`, and the receipt directory must already exist. The model
receives only the explicit `env` map. Model command, arguments, environment,
and stdin are absent from the supervisor's command line and receipts. Model
stdout and stderr use the supervisor's redirected stdout and stderr handles.
The caller must still keep secrets out of the model's own command-line args.

`<receiptDir>/<runId>.ready.json` is created only after `CreateProcessW` has
assigned the model to the Job. It contains `runId`, `leaseId`, `deviceId`,
`nonce`, bridge PID/creation FILETIME/session, model PID/creation FILETIME, and
`cancelEvent`. Reusing a run ID with an existing ready or stopped file fails.
The bridge may request cancellation with
`PaperclipRunSupervisor.exe cancel <ready.cancelEvent>`.

`<receiptDir>/<runId>.stopped.json` repeats the identity fields and contains
`cause`, `modelExitCode`, `activeProcesses: 0`, and `completedAtUtc`. It is
written through a flushed temporary file and same-directory rename only after
`QueryInformationJobObject` reports zero active processes. Causes are
`model_exit`, `cancelled`, `bridge_exit`, `descendant_timeout`, or
`input_failure`. A normal model exit forwards its 0–255 exit code; other proven
stops return 2. An unproven stop or invalid launch returns 70 and has no
stopped receipt. Missing or mismatched receipts must never become
`processStopped: true`.

## Boundaries for integration

- The supervisor is outside the model Job and holds its only Job handle. The
  Job handle is noninheritable; the model inherits only three explicit standard
  handles. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates members if the
  supervisor crashes. A supervisor crash has **no stopped receipt**, so a
  restarted bridge must keep the run blocked for reconciliation.
- The supervisor holds a process handle to the verified bridge PID. Bridge
  termination signals that handle; it then terminates and drains the Job.
  Bridge PID, creation FILETIME, and Windows session must match before launch.
- Job assignment is part of `CreateProcessW` through
  `PROC_THREAD_ATTRIBUTE_JOB_LIST`. A failure to configure this attribute or
  create the process aborts before model execution. Neither breakaway limit is
  enabled. Existing enclosing Jobs may still make assignment fail; reject that
  environment rather than launching outside the Job.
- The documented Job inheritance covers ordinary `CreateProcess` descendants.
  Microsoft explicitly excludes children created with `Win32_Process.Create`.
  Actual Codex/Cursor behavior must be checked before claiming complete tree
  coverage. The stopped receipt proves only the Job population drained.
- The TypeScript bridge verifies the run, lease, device, nonce, bridge and model
  identities in both receipts, checks the wrapper result, and preserves the
  existing server lease fence. A ready file alone is not stop proof.

Microsoft references: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[atomic Job assignment](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute),
[Job accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information),
[process creation times](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes).
