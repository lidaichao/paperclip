# Work-record workflow v2 operations

This runbook covers the M2 workflow-v2 capacity, recovery, monitoring, backup,
and rollback gates. The write path remains **off by default**. Do not enable it
on a production instance without the product-approved gray rollout.

## Runtime boundaries

- One preview/prepare scope accepts at most 200 records, depth 8, and 2,000
  dependency edges. Each boundary is inclusive; 201, 9, or 2,001 returns 422
  without creating a dispatch batch.
- `GET /api/companies/:companyId/projects/:projectId/work-records?limit=100`
  returns `{items,nextCursor,limit}`. Pass `afterId=<nextCursor>` until null.
  Omitting both pagination parameters preserves the legacy array response.
- Background reconciliation uses stable UUID keyset pages and wraps after the
  last page. Per 2-second tick it checks at most 100 records, 25 quality cycles,
  and 25 packages.

## Monitoring

With board read access, inspect one project:

```sh
: "${PAPERCLIP_API_URL:?set the Paperclip API base URL}"
: "${BOARD_API_KEY:?export a named board API key for the operator account}"
: "${COMPANY_ID:?set the company ID}"
: "${PROJECT_ID:?set the project ID}"

curl -fsS \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/projects/$PROJECT_ID/work-record-workflow/operations"
```

The response includes feature-flag state, outbox counts/age, consistency and
projection lag, per-intent duplicate wake/run alarms, PO/QA/cancellation wait,
governance waits, 403/409/422 rejection classes, attributed cost, scan budget,
and the old-binary rollback preflight. `outbox.attemptP95` is deliberately
limited to pending/retry/processing rows whose `updatedAt` falls within the
reported 24-hour window; completed historical rows cannot keep that alarm
raised forever. Dead-letter and oldest-actionable-age alarms remain unbounded
until an operator resolves the underlying row. Alert when any of these is true:

Metric definitions are intentionally exact:

- Effective wakes have status `queued`, `claimed`, or `completed`; effective
  runs have status `queued`, `running`, or `succeeded`. Failed, cancelled,
  skipped, interrupted, timed-out, coalesced, and scheduled-retry history does
  not create a duplicate-effective-execution alarm. Raw and effective totals
  are both returned under `execution`.
- `consistency.staleEvents` counts only superseded outbox rows whose reason is
  `stale_issue_revision`; unknown-event failures remain superseded errors but
  are not stale events. Scope-digest mismatch counts require the dedicated
  `scope_digest_mismatch` audit classification, not any stale revision.
- `quality.qaWait` includes open `qa_initial` and `qa_retest` cycles. Governance
  waits use explicit reason sets rather than substring matching.
- `rejections.roleDenied` counts only
  `work_record_workflow_role_denied`; `crossScope` counts only the explicit
  `work_record_workflow_project_boundary` code. All 403/409/422 totals remain
  available separately under `rejections.byStatus`.

1. `outbox.deadLetter > 0`.
2. `outbox.oldestActionableAgeSeconds > 60` for two consecutive samples.
3. `outbox.attemptP95 >= 3` or cost exceeds the project's approved budget.
4. `rollback.safeForOldBinary` is false during a rollback window.

The worker also emits a structured debug log named
`work_record_workflow_tick`; it contains duration, page counts, delivery counts,
and cursor-wrap facts. This is local observability, not first-party telemetry.

## Dead-letter recovery

Workflow-v2 delivery stops after five **delivery** failures. Governance waits
(cohort, approval, budget, company/agent/task pause, or source hold) retain the
same event, do not increment `attemptCount`, and never enter dead-letter.
They are rechecked on the bounded worker interval after the gate is removed.
Recovery is a
compare-and-set update on the existing outbox row; it does not create a second
event. Record the observed attempt count and an allowlisted reason code. The
deprecated free-text `reason` field is accepted for older clients but is
discarded: it is never written to activity, run log, telemetry, or the response.

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{"expectedAttemptCount":5,"reasonCode":"delivery_dependency_repaired"}' \
  "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/projects/$PROJECT_ID/work-record-workflow/outbox/$EVENT_ID/recover"
```

Only a non-viewer board operator can call this endpoint. A stale attempt count
returns 409. Recovery resets attempts to zero, increments `recoveryCount`,
records `lastRecoveredAt`, and preserves the event ID. Check the operations
endpoint after the worker delivers it.

Allowed codes are `operator_retry`, `delivery_dependency_repaired`,
`governance_released`, `rollback_recovery`, and `other`. Put detailed incident
notes in an access-controlled work product; do not paste tokens, provider
payloads, customer text, or attachments into this endpoint.

## Authenticated backup and restore closure

Owner: the authorized instance operator. Approver: Jack (or the named incident
approver). Stop if the backup/key checksum differs, the target is not empty,
the expected company is absent, migrations are not current, or authenticated
login and the M1/v2 smoke do not pass. Never use the active 3100 instance for a
drill.

Before the outage window, record the database backup and the local encrypted
secrets key in the approved manifest. A database dump without the matching key
cannot restore encrypted credentials.

POSIX shell:

```sh
export DATABASE_URL='postgres://paperclip:paperclip@127.0.0.1:55432/source'
export BACKUP_DIR='/approved/paperclip-backups'
export KEY_FILE='/approved/paperclip-secrets/master.key'

npx paperclipai db:backup --dir "$BACKUP_DIR" --filename-prefix workflow-v2 --json > backup.json
export BACKUP_FILE="$(node -p "JSON.parse(require('fs').readFileSync('backup.json','utf8')).backupFile")"
sha256sum "$BACKUP_FILE" "$KEY_FILE" | tee restore-manifest.sha256
```

PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://paperclip:paperclip@127.0.0.1:55432/source'
$backupDir = 'C:\approved\paperclip-backups'
$keyFile = 'C:\approved\paperclip-secrets\master.key'

npx paperclipai db:backup --dir $backupDir --filename-prefix workflow-v2 --json |
  Set-Content -LiteralPath .\backup.json
$backupFile = (Get-Content -LiteralPath .\backup.json -Raw | ConvertFrom-Json).backupFile
Get-FileHash -Algorithm SHA256 -LiteralPath $backupFile, $keyFile |
  ConvertTo-Json | Set-Content -LiteralPath .\restore-manifest.sha256.json
```

Create a new empty PostgreSQL database. Point `DATABASE_URL` at that target and
run the non-mutating preflight first. Replace the example digests and company ID
with the approved manifest values. `db:restore` refuses a non-empty target.

```sh
export DATABASE_URL='postgres://paperclip:paperclip@127.0.0.1:55433/restored'
npx paperclipai db:restore \
  --backup "$BACKUP_FILE" \
  --expected-sha256 "$BACKUP_SHA256" \
  --secrets-key-file "$KEY_FILE" \
  --expected-secrets-key-sha256 "$KEY_SHA256" \
  --expected-company-id "$COMPANY_ID" \
  --json

npx paperclipai db:restore \
  --backup "$BACKUP_FILE" \
  --expected-sha256 "$BACKUP_SHA256" \
  --secrets-key-file "$KEY_FILE" \
  --expected-secrets-key-sha256 "$KEY_SHA256" \
  --expected-company-id "$COMPANY_ID" \
  --apply --yes --json | tee restore-result.json
```

PowerShell uses the same arguments and `Tee-Object -FilePath
.\restore-result.json`. Restore the approved key file to the configured
`secrets.localEncrypted.keyFilePath` before starting the restored process.
Start the new binary on an isolated port, require `/api/health` to report
`status=ok` and `startupRecovery.phase=ready`, sign in through the authenticated
mode, then verify the operations endpoint plus one retained M1 record and one
workflow-v2 event/recovery row. If any check fails, stop the restored process,
retain `restore-result.json` and logs, discard the empty-target database, and
restart the unchanged source process; never restore over the source database.
The official Windows drill sends loopback requests with connection reuse disabled
and retries only bounded `ENOTCONN`/`ECONNRESET`-class transport failures. It
persists source and target server logs even when the drill fails; an HTTP denial
or failed data assertion is never retried into a pass.

Repeatable proof commands:

```sh
pnpm exec vitest run cli/src/__tests__/db-restore.test.ts \
  server/src/__tests__/work-record-m2e-hardening.test.ts \
  packages/db/src/work-record-workflow-v2-migration.test.ts \
  packages/db/src/migration-snapshot-drift.test.ts
```

## Gray rollout and rollback gate

1. Keep `PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED` unset or `false`
   while applying migrations and observing read-only preview/metrics.
2. Back up the isolated/approved target. Set the global flag and the exact
   approved company/project JSON cohort, then restart the current binary:

   ```sh
   export PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED=true
   export PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS='[{"companyId":"<uuid>","projectIds":["<uuid>"]}]'
   ```

   ```powershell
   $env:PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = 'true'
   $env:PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS = '[{"companyId":"<uuid>","projectIds":["<uuid>"]}]'
   ```

   Missing, malformed, cross-company, or unlisted scopes fail closed. The
   operations response must show `rollout.scopeEnabled=true` for the approved
   project and `false` for a control project before any write traffic is sent.
3. Watch the monitoring gates above; disabling the flag stops new workflow-v2
   prepare/reconcile/outbox writes while leaving inspection available.
4. Before an old binary starts, require
   `rollback.safeForOldBinary=true`. Pending, retrying, processing, or
   dead-letter events and active intents all block old-binary rollback.
5. Migration hashes are not a stable cross-checkout identity: LF/CRLF conversion
   changes the SHA-256 bytes even when the migration name and SQL are otherwise
   unchanged. Drain first, create a final backup, and restore it into a **new
   empty rollback database**. In one transaction on that copy, add `name` to
   `drizzle.__drizzle_migrations` when absent and backfill every row with its full
   `.sql` filename from the current committed journal's unique
   `created_at`/migration-name mapping. Verify
   every row is named exactly once and 0295 remains the latest row. Both the
   frozen and current migration inspectors prefer `name`, so this removes the
   line-ending dependency without hiding a genuinely pending migration.

The frozen rollback baseline for this M2-E sequence is commit
`65b3d9ae48d02abdeb8f310500e93fcf30105a2d`. The authorized operator records
the current candidate commit/image digest and this old commit in the change
manifest. Disable both rollout variables, stop the current process, and retain
its database unchanged. Restore the final backup into a new rollback database;
the official drill adds and audits the stable migration-name identity while
leaving all 0295 columns, constraints, indexes, data and journal rows intact.
It then requires the frozen checkout's own `inspectMigrations` to return
`upToDate` without repair or auto-apply and starts the frozen server against that
same 0295 copy. A transaction failure must leave the restored copy byte-for-byte
at its original migration-schema state; discard/reset that failed target. If the
old server produces concrete schema incompatibility after the stable-name check,
the drill exits nonzero and retains the evidence. Schema downgrade is a separate
reviewed recovery action and is not performed automatically or inferred from a
hash mismatch.
Start the old checkout with migration auto-apply disabled. Require a live old PID,
`status=ok`, `startupRecovery.phase=ready`, the retained M1 record, archived
recovery audit facts, and no increase in workflow-v2 effective wakes or runs. If
old startup or smoke fails, stop it, discard the rollback target, and restart the
recorded current candidate against the unchanged source database with both rollout
variables still disabled.

The isolated real-process drill is:

```sh
git worktree add "$PAPERCLIP_OLD_BINARY_ROOT" 65b3d9ae48d02abdeb8f310500e93fcf30105a2d
corepack pnpm@9.15.4 --dir "$PAPERCLIP_OLD_BINARY_ROOT" install --frozen-lockfile
corepack pnpm@9.15.4 --dir "$PAPERCLIP_OLD_BINARY_ROOT" --filter @paperclipai/shared exec tsc
corepack pnpm@9.15.4 --dir "$PAPERCLIP_OLD_BINARY_ROOT/packages/plugins/sdk" exec tsc
PAPERCLIP_OLD_BINARY_COMMIT=65b3d9ae48d02abdeb8f310500e93fcf30105a2d \
PAPERCLIP_M2E_EVIDENCE_DIR="$PAPERCLIP_RUN_SCRATCH_DIR/m2e" \
pnpm exec tsx tests/e2e/run-work-record-old-binary-rollback.ts
```

PowerShell:

```powershell
git worktree add $env:PAPERCLIP_OLD_BINARY_ROOT 65b3d9ae48d02abdeb8f310500e93fcf30105a2d
corepack pnpm@9.15.4 --dir $env:PAPERCLIP_OLD_BINARY_ROOT install --frozen-lockfile
corepack pnpm@9.15.4 --dir $env:PAPERCLIP_OLD_BINARY_ROOT --filter @paperclipai/shared exec tsc
corepack pnpm@9.15.4 --dir (Join-Path $env:PAPERCLIP_OLD_BINARY_ROOT 'packages/plugins/sdk') exec tsc
$env:PAPERCLIP_OLD_BINARY_COMMIT = '65b3d9ae48d02abdeb8f310500e93fcf30105a2d'
$env:PAPERCLIP_M2E_EVIDENCE_DIR = Join-Path $env:PAPERCLIP_RUN_SCRATCH_DIR 'm2e'
pnpm exec tsx tests/e2e/run-work-record-old-binary-rollback.ts
```

For qualification, run the authenticated restore and old-binary drill three
times each with a fresh evidence directory. Every invocation must exit `0`.
Retain each JSON result and the raw `source-server.log`, `target-server.log`, or
`old-binary-server.log`. A failed invocation is evidence of a closed gate; do
not rerun over the same rollback database or waive it with a later success.

No command in this runbook authorizes production gray rollout or deployment.
