# Work-record workflow v2 data contract

Status: M2-C server/API quality-cycle path implemented behind a default-off
write flag; no user-facing or production capability is enabled. Independent
QA verification remains a separate release gate.

The workflow-v2 tables are additive sidecars around the existing work-record to
native-issue to heartbeat chain. They do not create another scheduler. Package,
PO, QA, and rework releases all reuse the existing two-second work-record
heartbeat tick and native heartbeat admission. New write and claim paths remain
behind the default-off feature flag until independent M2 verification passes.

## M2-B API and feature flag

Set `PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED=true` only in an isolated
company/project and isolated database. When unset, preview remains read-only and
all prepare/reconcile/claim writes return `403` with
`work_record_workflow_v2_disabled`.

- `POST /api/companies/:companyId/projects/:projectId/work-package-dispatch/preview`
- `GET /api/companies/:companyId/projects/:projectId/work-record-capabilities`
- `POST /api/companies/:companyId/projects/:projectId/work-package-dispatch/assignment-gap-escalations`
- `POST /api/companies/:companyId/projects/:projectId/work-package-dispatch/prepare`
- `GET /api/companies/:companyId/projects/:projectId/work-package-dispatch/:batchId`
- `POST /api/companies/:companyId/projects/:projectId/work-package-dispatch/:batchId/reconcile`
- `GET /api/companies/:companyId/projects/:projectId/work-records/:recordId/quality`
- `POST /api/companies/:companyId/projects/:projectId/work-records/:recordId/assignment`
- `POST /api/companies/:companyId/projects/:projectId/work-records/:recordId/quality/po-verdicts`
- `POST /api/companies/:companyId/projects/:projectId/work-records/:recordId/quality/qa-verdicts`
- `POST /api/companies/:companyId/projects/:projectId/work-record-quality/defect-links`

Preview computes the current whole-package descendant closure or the exact
selected-record set. It remains readable for Viewer members and returns every
missing PO, execution owner, and independent QA owner in `eligibility.blockers`.
Any blocker disables prepare for the entire scope. The assignment-gap escalation
route records the full blocker set and available CEO target in the activity log;
it never changes an assignment. Existing owners can only change through the
separate compare-and-set assignment command. The capabilities endpoint lets the
UI fail closed and explain the required role before any write request. Prepare
always binds root/dependency revisions and may
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

The process-level M2-R05 proof lives in
`tests/e2e/work-package-process-recovery.spec.ts`. It starts a real isolated
Paperclip server, PostgreSQL database, API, and Chromium UI, then launches a
separate workflow worker. The parent sends `SIGKILL` only after the worker
reports `after_partial_materialization`, `after_outbox_commit`, or
`before_projection_update`, restarts a new worker against the same database,
and retains DB/API snapshots plus final UI screenshots. Set
`PAPERCLIP_M2_R05_EVIDENCE_DIR` to keep the JSON and PNG evidence outside the
default Playwright result directory. Run the isolated proof with
`node cli/node_modules/tsx/dist/cli.mjs tests/e2e/run-work-package-process-recovery.ts`;
the wrapper uses the repository PostgreSQL test helper so Windows does not
depend on Playwright onboarding's fixed embedded-database bootstrap port. The
wrapper also sets the E2E-only `PAPERCLIP_E2E_OWNS_WORK_RECORD_TICK=true`
switch: the API/UI process remains an observer while each killed/restarted
child is the sole owner of reconciliation and outbox delivery.

The M2-C ledger lives in
`server/src/__tests__/work-record-quality-cycle.test.ts`. Set
`PAPERCLIP_M2C_EVIDENCE_DIR` to retain `quality-cycle-evidence.json`,
`assignment-command-evidence.json`, and
`quality-audit-canary-evidence.json`. The separate
`work-record-dynamic-evidence.test.ts` suite retains
`dynamic-http-postgres-evidence.json`; it exercises the assignment and quality
commands over a real loopback TCP listener with signed run JWTs and isolated
PostgreSQL, then scans persisted activity, run-event, process-log, telemetry,
and Sentry sink artifacts. It records
the package, repair, QA, defect, cycle, intent, issue, and real heartbeat-run
IDs for the shared-repair, review-limit, and independent-defect paths. The
shared-repair path executes repair, original-QA retest, and PO acceptance through
outbox wakes and real process-adapter runs; the next PO run exists only after
every required defect verdict passes. The independent path executes two real
process-adapter runs and proves agent pause plus project budget hard-stop deny
the rework release before final admission.

## M2-C quality behavior

- CEO assignment uses a dedicated compare-and-set command. `NULL` to a named,
  available company agent needs the current record revision; replacing a named
  assignee additionally needs an approved board approval bound to the exact
  company, project, record, revision, and before/after agent pair. PO, QA,
  viewer, stale-revision, and generic PATCH attempts cannot dispatch work.
- Every quality command records one sanitized activity/run-log audit for
  success, replay, refusal, or conflict. The envelope carries company, project,
  record, cycle, item, related intent IDs, actor/run, request key, before/after
  revisions, outcome, and a bounded error code. Reasons, evidence bodies,
  credentials, and tokens are excluded. HTTP failure logging also replaces
  `reason` and `evidenceRefs` with redaction markers for these routes. No
  first-party telemetry event is emitted.

- A whole-package cycle reaches `po_acceptance` only after every required child
  and QA item is accepted. PO approval alone closes the package.
- A PO or QA return appends a verdict and opens the next cycle. It reopens the
  original record and primary issue, then creates a new intent/run; it never
  creates a parallel repair task.
- When repair completes, affected defect records move to `in_review`. A
  package returns to `po_acceptance` only after its QA items and source holds
  clear; that transition reopens the original PO issue and creates exactly one
  `po_acceptance_release` intent for the new cycle.
- Package defects use typed links to the package, original repair record, and
  original QA record. Multiple defects sharing those records share one repair
  item and one QA item while retaining one verdict per defect. Unknown repair
  ownership leaves the cycle in `attention_required`: the reporting QA may not
  resolve it, and only the package's assigned PO agent (or a board operator) may
  select the original repair task. No rework intent or run is created before
  that adjudication.
- A package QA verdict must bind the defect's QA record, that record's primary
  issue link, and the matching QA item. An item owned by another QA task cannot
  carry the verdict even when both tasks belong to the same package.
- Independent defects require distinct repair and QA agents before prepare.
  Their native issue execution policy hands successful repair to QA in
  `in_review`; only the named QA can pass or return it, and only QA pass reaches
  `done`. Package and independent QA returns stop at the configured review
  round limit and enter `attention_required` without creating another rework
  intent. The native policy and quality service both enforce the cap.

## Frozen implementation contracts

1. `quality cycle`, `quality item`, and `execution intent` use their own state
   machines. They are not aliases for the seven work-record business statuses or
   for heartbeat run status. Illegal state transitions fail closed.
2. One synchronous package scope is limited to 200 records, 8 nested levels,
   and 2,000 dependency edges. Any exceeded limit returns `422` and must leave no
   partial batch, item, intent, outbox, wake, or run facts.
3. PO, QA, and CEO actions use dedicated commands bound to the current revision.
   CEO assignment changes are compare-and-set; replacing a non-empty assignee
   also requires an approved board approval bound to that exact transition.
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

Migration `0291_sleepy_corsair.sql` adds the nullable independent-defect QA
assignee and the quality-link request digest used for replay/conflict checks.

Migration `0292_wooden_micromax.sql` adds dedicated CEO assignment command
receipts, including the compare-and-set revisions, actor/run attribution, and
optional board approval reference. It does not create an execution intent,
outbox event, wake, or heartbeat run.

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
off by default. Product UI, notification confirmation, production deployment,
and data backfill remain outside M2-C.
