# Contributor contract

For this repository, delegate through Paseo `create_agent` so the Human can
inspect and chat with each agent. Codex internal sub-agents are disabled; do not
use native spawn/delegation tools, including when a skill requests sub-agents.

Paseo SLP is an independent SLP policy package for Paseo. Before changing role
behavior, read docs/contract.md. The Human’s current assignment determines task
authority.

Keep one writer per moving scope and preserve unrelated work. Report exact
artifacts and actual checks on a stable candidate; local checks are not E2E
acceptance. Record missing host capabilities before adding workarounds.
Keep repository tactics in workspace-protocol.md, outside global roles.
Runtime installation, host configuration, live agents, commit and push require
task authority. Other repositories are read-only unless explicitly authorized.

Mutation evidence follows protocol §Gate. R1 binds every mutation log,
including the acceptance owner's replay: beyond the meta file, the log
carries the verbatim `sha256sum <test file>` output captured immediately
before the mutant runs, so readers see the sha without trusting a declared
field. R2 then makes that replayed, pinned log the evidence of record; the
engineer's log is supporting material only, and any sha mismatch between
log, meta and the handback candidate voids the log's claim — no intent needs
proving. These evidence-reliability rules bind every contributor, not just
repo ceremony.

## Ceremony boundary

Global policy owns authority, delegation, ownership and review invariants;
workspace protocol owns repo ceremony. Repo harness owns external MCP/connectors,
credentials and polling. Supervisor uses supplied tools under its
assignment; Lead chooses workflows. External work-state tools belong to the workspace/harness and imply no Lead
type. Before adding a plugin setting, gate or onboarding step, name
its invariant and why protocol/harness cannot own it. Keep optional integrations
out of default ceremony; preserve required review and authority checks.

When asked to run E2E or dogfood this package, read
skills/paseo-slp-e2e/SKILL.md and execute the requested scenarios from this session
(the whole manifest for a full-suite request). Resume an existing run when requested;
report every scenario, including blocked and unrun branches. Repository E2E tactics
live in e2e/workspace-protocol.md.

## Commits and releases

Commit messages must be conventional (`feat:`, `fix:`, `docs:`, `chore:`,
`refactor:`, `perf:`; optional scope; `!` suffix or `BREAKING CHANGE:` footer
for breaking changes). release-please generates CHANGELOG.md and version bumps
from these messages — never edit CHANGELOG.md release sections or the
package.json version field by hand, and never create git tags or GitHub
releases. Tags and releases are Human authority.

## Session Harness

Sections below are the session-state harness layer. The contributor contract
above outranks them on any conflict.

## Startup Workflow

Before writing code:

1. Confirm the repo root with `pwd`.
2. Read this file completely — contract first, harness sections second.
3. Read `docs/contract.md` before touching role or policy behavior.
4. Run `./init.sh` to verify the environment is healthy.
5. Read `feature_list.json` for current feature state.
6. Review `git log --oneline -5` for recent context.

If baseline verification is failing, repair the baseline before adding scope —
or record the pre-existing failure in `progress.md` when the failing scope
belongs to another workstream.

## Working Rules

- **One feature at a time**: pick exactly one unfinished feature from `feature_list.json`
- **Stay in scope**: do not modify files unrelated to the active feature
- **Verification required**: never claim done without running the verification commands
- **Update artifacts**: update `progress.md` and `feature_list.json` before ending a session
- **Leave clean state**: the next session must be able to run `./init.sh` immediately

## Required Artifacts

- `feature_list.json` — feature state tracker (source of truth for scope and status)
- `progress.md` — session continuity log
- `session-handoff.md` — optional, for multi-session work
- `init.sh` — standard startup and verification path (mirrors CI `validate`)

## Definition of Done

A feature is done only when all of the following are true:

- target behavior is implemented
- required verification actually ran and passed
- evidence is recorded in `feature_list.json` or `progress.md`
- the repository remains restartable from `./init.sh`

## End of Session

Before ending a session:

1. Update `progress.md` with current state, blockers, and evidence.
2. Update `feature_list.json` statuses.
3. Commit with a conventional message once work is in a safe state.
4. Leave the repo restartable — `./init.sh` must run on a clean checkout.

## Verification Commands

```bash
# Full verification (recommended) — mirrors CI validate
./init.sh
```

Required checks:

- `npm ci`
- `npm run typecheck`
- `npm run check` — `bin/slp.mjs identity`
- `npm run check:plugin-payload` — byte-compares committed runtime payload
- `npm test` — `node --test tests/*.test.mjs`, run with isolated `PASEO_HOME`
