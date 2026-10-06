# Session Harness Layer

**Status:** Accepted
**Date:** 2026-10-06
**PR:** #42

## Decision

Adopt the course-model session-state harness (`init.sh`, `feature_list.json`,
`progress.md`, `session-handoff.md`, `AGENTS.md` workflow sections) as the
repo's session protocol (repository-harness alternative dropped, PR #41
closed).

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

## Boundary with the plugin itself

This repo also self-installs the plugin (`.paseo-slp/` is present and managed).
Verified write-surface split — no path conflicts:

- **Plugin-owned**: `.paseo-slp/` (workspace-protocol.md, slp-routing.json,
  notebook.md — gitignored Supervisor state), the install destination
  (`installed.json`, `paseo-binding.json`, payload copy). `stageEntries`
  uses `wx` + preserve — the plugin never overwrites existing repo files.
- **Harness-owned**: root session-state files + `docs/` structure.
- **Near-name pairs** (same idea, different layer — do not merge):
  `session-handoff.md` (session file) vs `docs/work-continuity.md` (desk
  receipt ownership transfer); `progress.md` (committed session log) vs
  `.paseo-slp/notebook.md` (gitignored Supervisor state); `init.sh` (verify
  path) vs `install.sh` (plugin installer entry).
- **Footgun**: `materialize --include` can stage arbitrary repo-relative
  paths — never point it at harness files, or stale copies propagate into
  worktrees (it preserves existing files, so the copy would silently win in a
  fresh checkout that lacks the real one).
