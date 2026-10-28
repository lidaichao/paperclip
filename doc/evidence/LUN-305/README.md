# LUN-305 M2-E engineering evidence

All dynamic checks ran against temporary embedded PostgreSQL clusters. The
active port-3100 instance was not read, restarted, migrated, or modified.

## Proven boundaries and performance

The 200-record, depth-8, 2,000-edge fixture passed 30 preview samples. The
isolated sample recorded p50 6.44 ms, p95 11.82 ms, and max 12.62 ms. Adding
one record, level, or edge produced the expected 422 code and created zero
dispatch batches.

## Proven recovery and continuity

- Stable record pagination retained the legacy unpaginated response and
  traversed all records without duplicates.
- Package candidate reconciliation advanced through two keyset pages instead
  of repeatedly selecting the first page.
- Five injected workflow-v2 delivery failures moved one row to `dead_letter`.
  A stale compare-and-set and viewer recovery were rejected; the authorized
  recovery reused the same row, reset attempts, incremented recovery count,
  and delivered without a duplicate wake.
- Operations output attributed one run and a 37-cent cost event and blocked
  old-binary rollback while an active intent remained.
- A JavaScript-engine backup restored into a new empty database and preserved
  the delivered event ID, workflow version, recovery count, and timestamp.

## Verification commands

```sh
pnpm exec vitest run server/src/__tests__/work-record-m2e-hardening.test.ts
pnpm exec vitest run packages/shared/src/work-record-workflows.test.ts
pnpm exec vitest run packages/db/src/work-record-workflow-v2-migration.test.ts packages/db/src/migration-snapshot-drift.test.ts
pnpm exec tsc -p server/tsconfig.json --noEmit
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/db typecheck
```

Machine-readable run artifacts are uploaded to the LUN-305 Paperclip issue.
The fixed commit and final broader regression results are recorded in the issue
comment and commit work product.
