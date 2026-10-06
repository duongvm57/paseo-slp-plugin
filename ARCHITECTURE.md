# Architecture

Canonical architecture documentation: `docs/architecture.md`.
Contract-level file ownership and behavioral authority: `docs/contract.md`.

## System Map (entry points)

| Area | Path | Role |
|---|---|---|
| CLI entrypoints | `bin/` | `slp.mjs`, `slp-gate.mjs`, role wrappers |
| Role policy source | `src/` | `common.md`, `delegation.md`, `roles/*.md`, `references/*` |
| Plugin runtime | `plugin/server/runtime/`, `plugin/shared/runtime/` | Paseo server integration, payload units |
| Embedded payload | `plugin/server/generated/runtime-payload.ts` | byte-compared by `check:plugin-payload` |
| Tests | `tests/*.test.mjs` | `npm test` = `node --test tests/*.test.mjs` |
| E2E | `e2e/` | workspace-protocol tactics, see `skills/paseo-slp-e2e` |

## Design Invariants (from contract)

- Delegate through Paseo `create_agent` — no native sub-agent spawn.
- Mutation evidence: R1 binds mutation logs (verbatim `sha256sum` pre-mutant), R2 makes the replayed pinned log the evidence of record.
- release-please owns CHANGELOG/version/tags.

Deep design reasoning: `docs/DESIGN.md` → `docs/design-docs/`.
