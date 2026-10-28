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

1. `outbox.deadLetter > 0`.
2. `outbox.oldestActionableAgeSeconds > 60` for two consecutive samples.
3. `outbox.attemptP95 >= 3` or cost exceeds the project's approved budget.
4. `rollback.safeForOldBinary` is false during a rollback window.

The worker also emits a structured debug log named
`work_record_workflow_tick`; it contains duration, page counts, delivery counts,
and cursor-wrap facts. This is local observability, not first-party telemetry.

## Dead-letter recovery

Workflow-v2 delivery stops after five failed attempts. Recovery is a
compare-and-set update on the existing outbox row; it does not create a second
event. Record the observed attempt count and a reason:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{"expectedAttemptCount":5,"reason":"operator verified dependency recovery"}' \
  "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/projects/$PROJECT_ID/work-record-workflow/outbox/$EVENT_ID/recover"
```

Only a non-viewer board operator can call this endpoint. A stale attempt count
returns 409. Recovery resets attempts to zero, increments `recoveryCount`,
records `lastRecoveredAt`, and preserves the event ID. Check the operations
endpoint after the worker delivers it.

## Backup and restore drill

Never run the drill against the active 3100 instance. Point `DATABASE_URL` at
an isolated database and create a backup:

```sh
pnpm db:backup
```

The restore target must be empty and must use the same Paperclip encryption-key
material as the source when encrypted data is present. The automated drill
uses the exported `runDatabaseRestore` function against a new isolated database
and verifies the workflow-v2 event ID, state, recovery count, and recovery
timestamp:

```sh
pnpm exec vitest run server/src/__tests__/work-record-m2e-hardening.test.ts \
  -t "backs up and restores workflow-v2 recovery facts"
```

Fresh and M1-upgrade migration proof:

```sh
pnpm exec vitest run packages/db/src/work-record-workflow-v2-migration.test.ts \
  packages/db/src/migration-snapshot-drift.test.ts
```

The migration suite contains a dedicated `0294 -> 0295` case. It removes only
the 0295 journal row and 0295 schema additions, verifies 0295 is the sole
pending migration, reapplies it, and compares the pre-existing outbox row
before and after the upgrade.

## Gray rollout and rollback gate

1. Keep `PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED` unset or `false`
   while applying migrations and observing read-only preview/metrics.
2. Back up the isolated/approved target, then enable the flag only for the
   approved gray cohort and restart the current binary.
3. Watch the monitoring gates above; disabling the flag stops new workflow-v2
   prepare/reconcile/outbox writes while leaving inspection available.
4. Before an old binary starts, require
   `rollback.safeForOldBinary=true`. Pending, retrying, processing, or
   dead-letter events and active intents all block old-binary rollback.
5. Migration 0295 is additive. Do not reverse the database migration during an
   application rollback; drain the new state first, retain the backup, and use
   the old binary only after the preflight passes.

No command in this runbook authorizes production gray rollout or deployment.
