# Work record safe dispatch

This document describes the M1 vertical path from a project business record to an agent run. A work record is intentionally separate from an issue: saving, editing, assigning, or adding predecessors never creates an issue, wake request, or heartbeat run.

## API

- `GET /api/companies/:companyId/projects/:projectId/work-records`
- `POST /api/companies/:companyId/work-records`
- `PATCH /api/companies/:companyId/projects/:projectId/work-records/:recordId`
- `POST /api/companies/:companyId/projects/:projectId/work-records/:recordId/dispatch`

All reads and writes require company access. The service additionally scopes every record and predecessor lookup to the same company and project. Composite database foreign keys enforce those boundaries for dependencies, dispatch commands, primary issue links, holds, outbox rows, and projections.

## Transaction and delivery contract

Dependency validation and replacement run under one project-scoped transaction advisory lock. This serializes graph writers for a company/project, so concurrent opposite-edge updates cannot both pass cycle detection and commit. Dispatch separately takes the same per-record transaction lock used by editing and reconciliation. Its transaction creates or reuses the idempotent dispatch command, creates the primary issue, writes the permanent primary link, materializes source holds and available native issue blocker edges, creates the execution projection, writes the first release outbox row when already ready, and records the dispatch round. No issue/link can commit before its source hold or ready outbox state. Database constraints allow only one `primary` link per record and only one record to claim an issue as its primary execution target; `reference` links intentionally remain many-to-one. The UI also preserves its `clientRequestId` in session storage until a response succeeds.

Readiness reconciliation writes one unresolved source hold per predecessor and dispatch cycle. A predecessor is ready only after its primary issue is `done` and its latest execution-workspace operation is a successful `workspace_finalize` (or no workspace operations exist). These holds participate in the existing central issue dependency readiness function, so heartbeat admission, run dispatch, comments, recovery wakes, and direct status updates cannot bypass them.

When all source holds resolve, reconciliation inserts a unique release event and payload digest into the transactional outbox. The worker atomically claims the event, rechecks the current dispatch tuple and central readiness, and invokes the existing heartbeat wake path with a `work-record-release:` idempotency key. Expired processing leases are reclaimable after a worker crash, while stale-round events become `superseded`. The outbox tuple and the partial unique wake-request index provide at-least-once delivery with at most one effective wake/run.

The background loop is non-overlapping and bounded: one tick scans at most 100 dispatched records and claims at most 25 ready outbox rows every 2 seconds. Oldest `updated_at` records are considered first, and reconciliation advances that cursor, giving a nominal ceiling of 50 record reconciliations and 12.5 deliveries per second before database/runtime latency. This is the M1 development-team envelope. Replace the polling scan with a durable event/cursor worker if the ready backlog stays above 500 rows for five minutes or the tick p95 exceeds 1.5 seconds; either condition means a 2-second cycle can no longer provide predictable headroom.

## State layers

- Business status belongs to the work record.
- Dispatch state is `not_dispatched`, `preparing`, `blocked`, `linked`, `queued`, or `failed`.
- Execution projection stores the linked issue status/version and last run reference.
- Live run state comes only from the heartbeat live-runs API.

The UI animates only an observed `running` live run. A queued run is not animated, a live-query failure is shown as unknown, and a terminal business status combined with a running live run is shown as a conflict.

## Verification

`server/src/__tests__/work-record-safe-dispatch.test.ts` automates SD-01 through SD-11, dual-writer cycle prevention, retry/concurrency behavior, company/project isolation, partial primary-link uniqueness, status-bypass rejection, workspace delivery readiness, stale-event rejection, processing-lease recovery, bounded scans, and non-overlapping ticks. Its outbox cases invoke the real heartbeat service separately for a paused company, an exceeded project budget hard-stop, and an agent awaiting approval; each native gate writes a skipped wake receipt, creates no run, and leaves the release retryable.
