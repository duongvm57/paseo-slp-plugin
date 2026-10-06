# Repo harness boundary with the plugin

- Status: Accepted
- Date: 2026-10-06
- Decided by: Human (duongvm)
- Source: Human decision in Lead session 2026-10-06 (Human-directed); PR #42 rejected by Human, closure performed by Human
- Supersedes: none

## Context

PR #42 added a harness (`feature_list.json`, `progress.md`,
`session-handoff.md`, `init.sh`) that duplicated what the Paseo SLP plugin
already does for work in flight. Two owners for the same fields drift apart.

## Decision

Each field has one owner, and no file is written by several lanes.

- **Plugin, Lead and Paseo** own running work: scope, owner, decision, review,
  acceptance, agent lifecycle and handoff. Role policy is injected at run time
  and the desk ledger lives under the runtime state directory, outside the repo.
- **The repo harness** owns only the product side: instructions (`AGENTS.md`),
  environment, checks (`docs/development.md#testing`, CI) and durable decisions
  (`docs/decisions/`). Repo tactics stay in `.paseo-slp/workspace-protocol.md`.
- Deliberately absent: `feature_list.json`, `progress.md`, `session-handoff.md`,
  `init.sh`, `verification.md`, `roadmap.md`, task ledgers and status/done files.
- The rule runs both ways. Before adding a plugin setting or gate, name its
  invariant and why protocol/harness cannot own it (existing). Before adding
  state, a workflow or a gate to the repo harness, name its invariant and why
  the plugin or protocol does not already cover it.

Recording decisions:

1. When a Lead reports BLOCKED and the Supervisor or Human rules (including a
   Supervisor deciding on the Human's behalf), create no ADR yet. Put the ruling
   into shared state at once: Lead uses a desk decision if there is a desk,
   otherwise the Lead timeline. A deciding Supervisor also notes it in its notebook.
2. A PR lists every in-task ruling (who, what, why, risk) under "Decisions in
   this task". This step is always required.
3. Only a **durable** ruling becomes an ADR, written in the same candidate/PR
   before final review, never afterwards. Durable means it outlives the task:
   architecture, contract, authority/delegation, roadmap or repo rules. Lead
   proposes it in the handback; Supervisor/Human confirm at PR review.

## Consequences

The repo gains no second task tracker. Settlement rules also appear in the
workspace protocol and the PR template. Revisit if the plugin ships its own
harness-coverage view.
