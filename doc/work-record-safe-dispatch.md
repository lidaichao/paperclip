# Work record safe dispatch

This document describes the M1 vertical path from a project business record to an agent run. A work record is intentionally separate from an issue: saving, editing, assigning, or adding predecessors never creates an issue, wake request, or heartbeat run.

## API

- `GET /api/companies/:companyId/projects/:projectId/work-records`
- `POST /api/companies/:companyId/work-records`
- `PATCH /api/companies/:companyId/projects/:projectId/work-records/:recordId`
- `POST /api/companies/:companyId/projects/:projectId/work-records/:recordId/dispatch`

All reads and writes require company access. The service additionally scopes every record and predecessor lookup to the same company and project. Composite database foreign keys enforce those boundaries for dependencies, dispatch commands, primary issue links, holds, outbox rows, and projections.

## Transaction and delivery contract

Explicit dispatch takes the same per-record transaction lock used by editing and reconciliation. The transaction creates or reuses the idempotent dispatch command, creates the primary issue, writes the permanent primary link, materializes source holds and available native issue blocker edges, creates the execution projection, writes the first release outbox row when already ready, and records the dispatch round. No issue/link can commit before its source hold or ready outbox state. A unique primary-link constraint makes retries and concurrent requests converge on the same issue; the UI also preserves its `clientRequestId` in session storage until a response succeeds.

Readiness reconciliation writes one unresolved source hold per predecessor and dispatch cycle. A predecessor is ready only after its primary issue is `done` and its latest execution-workspace operation is a successful `workspace_finalize` (or no workspace operations exist). These holds participate in the existing central issue dependency readiness function, so heartbeat admission, run dispatch, comments, recovery wakes, and direct status updates cannot bypass them.

When all source holds resolve, reconciliation inserts a unique release event and payload digest into the transactional outbox. The worker atomically claims the event, rechecks the current dispatch tuple and central readiness, and invokes the existing heartbeat wake path with a `work-record-release:` idempotency key. Expired processing leases are reclaimable after a worker crash, while stale-round events become `superseded`. The outbox tuple and the partial unique wake-request index provide at-least-once delivery with at most one effective wake/run.

## State layers

- Business status belongs to the work record.
- Dispatch state is `not_dispatched`, `preparing`, `blocked`, `linked`, `queued`, or `failed`.
- Execution projection stores the linked issue status/version and last run reference.
- Live run state comes only from the heartbeat live-runs API.

The UI animates only an observed `running` live run. A queued run is not animated, a live-query failure is shown as unknown, and a terminal business status combined with a running live run is shown as a conflict.

## Verification

`server/src/__tests__/work-record-safe-dispatch.test.ts` automates SD-01 through SD-11, retry/concurrency behavior, company/project isolation, status-bypass rejection, workspace delivery readiness, stale-event rejection, and processing-lease recovery. Existing pause, budget, and approval suites remain authoritative for native heartbeat admission; the outbox test proves their rejection is retained as retryable delivery rather than being converted into a run.
