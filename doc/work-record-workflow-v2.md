# Work-record workflow v2 data contract

Status: schema and shared contract only; user-facing M2 behavior is disabled.

The workflow-v2 tables are additive sidecars around the existing work-record to
native-issue to heartbeat chain. They do not create another scheduler, start an
agent, or make package dispatch, PO review, or QA review available. New write and
claim paths must remain behind a default-off feature flag until later M2 stages
implement and independently verify them.

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

## Safe rollback

Rollback means disabling workflow-v2 writes and claims while preserving reads.
Do not delete the new tables, delete verdicts, remove new issue/link facts, or
rewrite historical state. Before running an older binary, first stop v2 claims
and prove there are no pending workflow-version-2 outbox events. Native issues
already running continue to obey the existing approval, budget, pause, source
hold, execution-lock, and heartbeat controls.

Schema presence is not an availability claim. Whole/partial package dispatch,
PO/QA pages and commands, automatic release, real agent launch, deployment, and
data backfill remain outside this phase.
