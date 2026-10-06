# Plan: Session-State Harness Trial

**Created:** 2026-10-06
**Status:** decision made — session-state adopted

## Objective

Trial the course-model session-state harness on this repo and decide whether
it becomes the repo's session protocol (feat-003 in `feature_list.json`).

## Scope

- In: harness artifacts, docs structure for decisions/plans/specs
- Out: fixing the 76 pre-existing base-branch test failures (other workstream),
  changing runtime/policy code, merging either harness PR

## Steps

1. [x] Install core artifacts (`init.sh`, `feature_list.json`, `progress.md`,
   `session-handoff.md`, AGENTS.md sections)
2. [x] Add docs structure (design-docs, exec-plans, product-specs, references)
3. [x] Human picked session-state (PR #41 closed)
4. [ ] Route harness entry points from `docs/contract.md` (feat-004)
5. [ ] First real use: a cold session executes one `feature_list.json` item
   end-to-end using only the harness files — that is the actual acceptance test

## Open Decisions

- ~~Single model vs layered~~ decided: session-state (`docs/design-docs/harness-model-choice.md`)

## Verification

- `validate-harness.mjs` = 100/100
- `./init.sh` green through `check:plugin-payload`; `npm test` blocked by
  base WIP (75/76 baseline fails, strict subset — zero new)
