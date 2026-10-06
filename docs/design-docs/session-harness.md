# Session Harness Layer

**Status:** Accepted (as trial)
**Date:** 2026-10-06
**PR:** #42

## Decision

Adopt the course-model session-state harness (`init.sh`, `feature_list.json`,
`progress.md`, `session-handoff.md`, `AGENTS.md` workflow sections) as an
additive layer for a trial period.

## Rationale

- The contributor contract governs *what may be done*; it does not give a
  cold agent session a restartable procedure. The harness supplies startup
  workflow, scoped feature tracking, verification gates, and handoff.
- `./init.sh` encodes the CI `validate` job verbatim, so "healthy baseline"
  means the same thing locally and in CI.

## Constraints

- The contract outranks the harness on any conflict (stated in `AGENTS.md`).
- Harness files must never enter `installUnitPaths` — payload stays clean.
- `progress.md` is a *current-state snapshot*, not an append-only log; durable
  history lives in `docs/exec-plans/` (dated files, archived when done).
