---
name: paseo-slp-onboarding
description: Set up or revise a repository's Paseo SLP protocol and Peer runtime pool, and verify its Supervisor/Lead profiles. Use when asked to onboard, set up or reconfigure SLP for a repo; skip ordinary Peer implementation.
---

# Repository onboarding

Produce one `.paseo-slp/workspace-protocol.md` of rules and decisions, any
`.paseo-slp/references/` files it points to, a Peer pool decision and verified
Supervisor/Lead profiles. Recommend from repo evidence; ask only missing decisions.
Preserve Human customizations. External MCP/connectors, credentials, polling and
queue bookkeeping belong to the repo harness. Do not
add tracker setup questions or activation gates to ordinary onboarding.

## 1. Inspect

Locate the installed CLI/package. Read AGENTS.md, existing `.paseo-slp/` files
(including `references/`), `src/templates/workspace-protocol.md`, project
checks/CI, delivery conventions
and state-changing surfaces. The template must contain `## Repository configuration`
and `template_sha256`; otherwise report the upgrade prerequisite. Setup grants
no installation or host edits.

Done: cite evidence or absence for work mix, checks, delivery and shared state;
record the package version.

## 2. Verify profiles

Use list_profiles/list_providers and live model/settings discovery to verify
slp-supervisor/slp-lead against their installed role providers. Report exact
mismatches. Human fixes them in Settings → host → Agents → Agent profiles:
matching `slp-{family}-{role}`, model, thinking and mode. Never hand-edit daemon
config or require slp-peer; Peers use a pool.

Done: both profiles verified, or each gap has Human fix steps.

## 3. Propose

Fill the template from evidence using
[configuration examples](references/repository-configuration.md); combine every applicable setting.
Lead chooses recipes per task; external input implies no separate Lead. Keep
all recipes unless Human decides otherwise; a removed recipe needs an explicit
route for that work. Preserve installed invariants and review requirements.
Record current deviations in Overrides, with decider/date; keep history outside
runtime protocol.

Keep rules and decisions in the protocol. Put operational facts — exact check
commands and what each proves, CI gates/switches, skill or tool installation
mechanics, path/environment hazards — in `.paseo-slp/references/<topic>.md`,
list each under Repository references and point to it in one line from the
section that applies it ([split example](references/repository-configuration.md#protocol-and-references)).
Create a reference only when it has content; a short fact may stay inline. The
split is configuration, not an Override. An existing protocol carrying inline
detail gets the split as a proposed diff, never silently.

Only a fully custom process needs [custom interview](references/custom-interview.md).

For existing protocols, preserve every Human decision/custom section. Reapply
known overrides; absent provenance means differences may be customizations.
Surface conflicts for Human decision. Legacy profile provenance belongs in
migration evidence, not an accumulating runtime history.

Present the full effective file and diff, evidence, inferred proposals and open
authority/budget/delivery/work-state decisions. Resolve questions one at a time.
Record package_version and template_sha256 from the installed template.

Done: each field is confirmed or explicitly open; Human has seen the full target.

## 4. Decide pool

Choose `inherit` (shared Manager pool), `pinned` (repo catalog), or `empty`
(deliberately suppress delegation). Preserve existing intent; ask if undecided.
Record routing_intent, decider/date; option IDs stay in the catalog. Follow
[pool setup](references/peer-pool.md) using discovered runtimes only.

Done: source chosen and populated, or its delegation gap recorded.

## 5. Write

Present the exact complete diff of every target file (protocol and references)
and consequences; obtain direct Human confirmation. Verify each base is
unchanged, write, re-read and compare target bytes. Drift blocks the write.
For a new repo, confirm absent → final bytes, verify absence, then write before
init. Revisions bump version/last_reviewed.
Set supervisor_notebook to its owned path or timeline:<agentId> with retrieval
instructions. Keep role bytes out of protocol.

Preview `node <slp-cli> init <absolute-repo>`; apply within setup authority.
Init preserves existing files. Import a chosen catalog with --routing-from only
at this step; init has no protocol selector. Reconcile layout collisions before
moves. Install this skill separately in native scope, outside `.paseo-slp/`.

Beads already enabled → installed work-tracking policy. Human requests beads
setup → [work tracker](references/work-tracker.md). Otherwise preserve its toggle.

Done: confirmed bytes match; init preview shows protocol preserved.

## 6. Validate

Walk a clear task, uncertain feature and dependency through owner, next step,
unlocking evidence and authority; include Transition for shared-state repos.
Every protocol pointer resolves to an existing reference.
Fix gaps, then validate the pool per its reference. Report exact changed files,
profile/provider evidence, eligible choices, pool-maintenance/fallback authority
and unresolved decisions. Distinguish an empty pool from provider unavailability.
Live launches need task authority; local preparation is not E2E acceptance.
