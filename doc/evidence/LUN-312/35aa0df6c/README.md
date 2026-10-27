# LUN-312 M2-B rework evidence

## Fixed revisions

- Baseline under review: `6fdd60d393c828f3a1500f78c10503e0badd1451`
- Tested implementation: `35aa0df6c3a67f72c89cf0eb10319c640f1d7b0b`
- Scope: server workflow-v2 dispatch, recovery, compatibility, and test evidence only; no UI, deployment, push, or production access.

## Reproduction

From the repository root on a machine with the test PostgreSQL fixture available:

```powershell
$env:PAPERCLIP_M2B_EVIDENCE_DIR = "$PWD/doc/evidence/LUN-312/35aa0df6c"
$env:PAPERCLIP_M2B_TESTED_COMMIT = "35aa0df6c3a67f72c89cf0eb10319c640f1d7b0b"
& 'server/node_modules/.bin/vitest.CMD' run server/src/__tests__/work-package-dispatch.test.ts --reporter=dot
```

Observed result on 2026-10-27: exit code `0`; 11/11 tests passed in 67.98 seconds.

The broader targeted regression command was:

```powershell
& 'server/node_modules/.bin/vitest.CMD' run `
  server/src/__tests__/work-package-dispatch.test.ts `
  server/src/__tests__/work-record-routes-authz.test.ts `
  server/src/__tests__/work-record-safe-dispatch.test.ts `
  server/src/__tests__/work-record-process-adapter.test.ts `
  server/src/services/recovery/successful-run-handoff.test.ts `
  packages/shared/src/work-record-workflows.test.ts `
  --reporter=dot
```

Observed result: exit code `0`; 85/85 tests passed in 111.33 seconds. Direct TypeScript checks for `packages/shared`, `packages/db`, and `server` also returned exit code `0`.

## Evidence index

- `o01-eight-layer-ledger.json`: 50 real PostgreSQL two-client rounds; every round has one effective record, batch, item, link, intent, outbox, wake, and run, plus replay winner and conflict code. Validation found 0 invalid rounds.
- `final-admission-matrix.json`: 11 API/admission cases covering company/project boundary, viewer, approval pending/stale/reject, budget hard-stop, company pause, agent pause, source hold, and issue execution lock. Every case has zero effective wake/run.
- `recovery-failpoint-snapshots.json`: before/after eight-layer snapshots for commit-before, partial materialization, wake response loss, projection-not-updated, and out-of-order old event; 5 cases and 10 snapshots.
- `api-contract.json`: real preview/prepare/get/reconcile responses, double-client winner/replay, `409` conflict, viewer denial, and default-off behavior.

## SHA-256

```text
api-contract.json                 05EDA1BE2441FE55703416FD9040DA25D99A329798228EAD615463EE2BD904D2
final-admission-matrix.json       CF188EBAE6C3B1841C5C7E653D9B59AC2265E0F7EDEE954330489B1E6DD6C707
o01-eight-layer-ledger.json       723EE71DC32E4B293051A1A42FC2400821D22507FCBECC61590266FD71ED311D
recovery-failpoint-snapshots.json 8CD0F688A0144AC7C89F750C770EDBD8DD63EBA4E62490C1FD1D13FA559F9708
```

The process-adapter fixture emits a non-failing `CONNECTION_ENDED` warning while late child-process metadata races test-database teardown. Assertions, exit codes, wake/run ledgers, and exported evidence are complete; this warning is not treated as a passing assertion.
