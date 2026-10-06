# Harness Model Choice

**Status:** Proposed — needs Human authority
**Date:** 2026-10-06

## Question

Two harness philosophies now exist on parallel branches of
`feat/enforcement-mechanization`:

| | Session-state harness (PR #42) | repository-harness (PR #41) |
|---|---|---|
| Model | session-state files + workflow gates | repo-as-record, no orchestration lifecycle |
| Artifacts | `init.sh`, `feature_list.json`, `progress.md`, `session-handoff.md` | `docs/decisions/`, `docs/plans/`, `.agents/skills/`, provenance + 3-way update CLI |
| Task tracking | `feature_list.json` statuses | none by design (consumer owns workflow) |
| Structural score (course rubric) | 100/100 | 32/100 (model mismatch — it rejects what the rubric measures) |
| Maintenance | none needed | `harness update` 3-way merge with upstream |

## Options

1. **Keep session-state (this PR)** — simplest; matches the rubric and the
   course model; nothing to maintain.
2. **Keep repository-harness (PR #41)** — ADR rigor + safe upstream updates;
   must still answer "how does a cold session resume" separately.
3. **Keep both, layered** — repository-harness owns docs/decisions/provenance,
   session-state files own per-session protocol. Requires a demarcation note
   so `docs/plans/` vs `docs/exec-plans/` don't conflict.

## Open points

- Whether `feature_list.json` duplicates or complements `docs/plans/`.
- Whether provenance/update machinery is worth keeping for a hand-maintained
  layer.
