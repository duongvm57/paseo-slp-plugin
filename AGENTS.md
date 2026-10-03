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
