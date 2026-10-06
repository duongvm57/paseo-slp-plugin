# Quality Score

How this repo measures its own quality — mechanically, not by review opinion.

| Gate | Mechanism | Where |
|---|---|---|
| Policy doctrine | `tests/policy-doctrine.test.mjs` pins exact phrases in `src/` role policy | `npm test` |
| Payload integrity | byte-compare committed vs regenerated payload, incl. modes | `npm run check:plugin-payload` |
| Types | `tsc --noEmit` | `npm run typecheck` |
| Behavioral suite | 2063 tests, `node --test tests/*.test.mjs` | `npm test` |
| E2E | `e2e/` scenarios per `skills/paseo-slp-e2e` | manual/dogfood |

## Current state (2026-10-06)

- `feat/enforcement-mechanization` carries ~76 pre-existing WIP failures
  (~3 under CI Node 22) — baseline, not regression. See
  `docs/exec-plans/tech-debt-tracker.md`.
- Everything the harness PRs touch is green.

## Rule

A quality claim is a command + output on a stable candidate. "Looks right" is
not a score; R2 evidence rules apply (see `AGENTS.md`).
