# One schema migration test file, not one per version

- Status: Accepted
- Date: 2026-10-01
- Decided by: Human (duongvm)
- Source: Supervisor notebook (local, gitignored), entry 2026-10-01 "P5 handback verified, gate dispatched"
- Supersedes: none

## Context

Each desk store schema bump added a `plugin-desk-store-schema-vN` test file.
The chain grew into near-duplicate files the Human called code clutter.

## Decision

Desk store migrations are covered by a single test file
(`tests/plugin-desk-store-migrations.test.mjs`). A new schema version adds its
cases to that file instead of a new file. Per-version coverage must be kept:
merging may not drop a version's assertions.

## Consequences

Fewer test files; one place to read migration behavior. Review of a schema
bump checks that each version still has its own cases. Revisit if the file
becomes too large to review as one unit.
