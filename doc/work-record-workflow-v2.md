# Work-record workflow v2 data contract

Status: M2-B server/API preparation and release path implemented behind a
default-off write flag; no user-facing or production capability is enabled.

The workflow-v2 tables are additive sidecars around the existing work-record to
native-issue to heartbeat chain. They do not create another scheduler, start an
agent, or make package dispatch, PO review, or QA review available. New write and
claim paths must remain behind a default-off feature flag until later M2 stages
implement and independently verify them. M2-B reuses the existing two-second
work-record heartbeat tick and does not add a scheduler.

## M2-B API and feature flag

Set `PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED=true` only in an isolated
company/project and isolated database. When unset, preview remains read-only and
all prepare/reconcile/claim writes return `403` with
`work_record_workflow_v2_disabled`.

- `POST /api/companies/:companyId/projects/:projectId/work-package-dispatch/preview`
- `POST /api/companies/:companyId/projects/:projectId/work-package-dispatch/prepare`
- `GET /api/companies/:companyId/projects/:projectId/work-package-dispatch/:batchId`
- `POST /api/companies/:companyId/projects/:projectId/work-package-dispatch/:batchId/reconcile`

Preview computes the current whole-package descendant closure or the exact
selected-record set. Prepare always binds root/dependency revisions and may
also pin the returned `expectedScopeDigest`; the server recomputes and stores
the digest under the routing lock either way. The client request key replays only the
same payload digest; a different payload returns `409`. Company/project misses
return `404` without disclosing another scope, permission failures return `403`,
stale revisions and request-key conflicts return `409`, and invalid scope,
cycle, owner, or boundary input returns `422` with a stable `details.code`.

All target owners are checked through `tasks:assign` authorization before the
write. Prepare, replay, and reconcile mutations write activity evidence; an
agent-originated command also appends lifecycle evidence to its existing run
log. No first-party telemetry event is added.

## Preparation, materialization, and recovery

The prepare transaction takes the project routing advisory lock, then stable
record row locks, and atomically stores the batch, items, dependency snapshots,
quality facts, and execution intents. No issue or release is created inside
that transaction. Whole-package validation is all-or-nothing; selected scope
never pulls in a parent, sibling, predecessor, or successor.

Reconciliation materializes one item transaction at a time. It reuses an
existing primary issue link or creates an issue with the batch-item idempotency
key, then adds parent and native `blocks` relations where both endpoints exist.
A batch remains `preparing` until every item is materialized or reused. Calling
the reconcile endpoint after a crash or response loss resumes the same batch;
it does not create a second link or intent.

Only a `prepared` batch may produce a workflow-v2 outbox row. Source holds,
native dependency readiness, company/agent pause and invokability, budgets, and
the issue execution lock are checked before claim and remain enforced again by
native heartbeat admission. Cancelled prerequisites stay unresolved as
`prerequisite_cancelled_impact_pending`, put the package quality cycle into
`impact_review`, and cannot trigger a downstream or parent-PO wake. The native
children-completed path also consults unresolved source holds.

The test-only failpoint boundary names are `before_batch_commit`,
`after_partial_materialization`, `after_outbox_commit`, and
`before_projection_update`. The last boundary fires after the real heartbeat
wake/run receipt exists but before the workflow outbox, intent, and record
projections are advanced. Recovery tests must restart reconciliation/claim with
the failpoint removed and assert convergence to one batch, primary link, intent,
outbox event, wake, and run.

The independently rerunnable M2-B ledger lives in
`server/src/__tests__/work-package-dispatch.test.ts`. Set
`PAPERCLIP_M2B_EVIDENCE_DIR` to retain `api-contract.json`,
`final-admission-matrix.json`, `recovery-failpoint-snapshots.json`, and
`o01-eight-layer-ledger.json`; set `PAPERCLIP_M2B_TESTED_COMMIT` to the exact
commit under test. The O01 case uses two PostgreSQL clients, injects a wake
response loss on every one of 50 rounds, calls the real
`heartbeatService.wakeup`, and exports every record→batch→item→link→intent→
outbox→wake→run ID and effective count. The admission matrix retains the real
HTTP response, heartbeat denial reason, and zero-effective-wake/run assertion
for every authorization, governance, pause, hold, budget, and execution-lock
case. Recovery evidence records before/after IDs and counts at each failpoint.

## Frozen implementation contracts

1. `quality cycle`, `quality item`, and `execution intent` use their own state
   machines. They are not aliases for the seven work-record business statuses or
   for heartbeat run status. Illegal state transitions fail closed.
2. One synchronous package scope is limited to 200 records, 8 nested levels,
   and 2,000 dependency edges. Any exceeded limit returns `422` and must leave no
   partial batch, item, intent, outbox, wake, or run facts.
3. PO, QA, and CEO actions use dedicated commands bound to the current revision.
   CEO assignment gap filling is compare-and-set from an empty assignee only.
   Approval, budget, pause, dependency, and source-hold checks remain final
   heartbeat admission gates.
4. Rework and retest reuse the original work record and primary issue. A new
   round adds only cycle, item, verdict, intent, and native run facts. Reusing an
   idempotency key with the same payload replays the result; a different payload
   with that key returns `409`.
5. Outbox workflow version 1 remains readable. Version 2 events require an
   execution intent and use intent-scoped uniqueness. Unknown workflow versions
   and unknown version-2 event types fail closed and must never be claimed as a
   legacy release.

## Data invariants

- Every workflow row has `company_id`; project workflow rows also have
  `project_id` and composite foreign keys to their parent records.
- A record has one primary issue link. Each aggregate has at most one open
  quality cycle, and each native issue has at most one active execution intent.
- Verdicts are append-only. Corrections are later verdicts or a later cycle;
  updates and deletes are rejected by PostgreSQL.
- Batch request keys, verdict request keys, intent keys, and outbox event keys
  are stable idempotency anchors. Payload digests distinguish replay from a
  conflicting request.

## Migration and compatibility

Migration `0289_green_lady_deathstrike.sql` adds workflow-v2 tables and nullable outbox
references. Existing outbox rows receive `workflow_version = 1`; existing M1
records, links, holds, projections, issues, and runs are neither rewritten nor
backfilled. Fresh databases and upgrades therefore produce the same additive
schema while retaining old M1 facts.

Migration `0290_graceful_payback.sql` makes an execution intent's `issue_id`
nullable during `preparing`. Reconciliation must bind the issue and expected
status version before it can insert the required intent-scoped outbox event.

When an undispatched M1 release outbox and a v2 intent coexist during a rolling
transition, the v2 payload persists the M1 heartbeat idempotency key. Either
outbox processor may win, but both converge on one wake and one process-adapter
run. A later v2 dispatch does not reuse an already delivered historical M1 key.

## Safe rollback

Rollback means disabling workflow-v2 writes and claims while preserving reads.
Do not delete the new tables, delete verdicts, remove new issue/link facts, or
rewrite historical state. Before running an older binary, first stop v2 claims
and prove there are no pending workflow-version-2 outbox events. Native issues
already running continue to obey the existing approval, budget, pause, source
hold, execution-lock, and heartbeat controls.

Schema and API presence are not an availability claim. The write flag remains
off by default. PO verdicts, QA/defect quality rounds, product UI, notification
confirmation, production deployment, and data backfill remain outside M2-B.
