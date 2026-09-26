# Protocol writing rules

Read from onboarding step 3 before drafting. Supervisor and Lead read the whole
protocol on every assignment, so each line is context load paid on every task.
Apply every rule to every line; a failing line is cut or moved to its home.

## Scope

- **Tactic test:** a line stays only when Lead or Supervisor would orchestrate
  differently here without it. A sentence the agent already obeys by default
  is a no-op: delete the whole sentence rather than trimming words.
- **Single source of truth:** one meaning lives in one place. Restating role
  policy, AGENTS.md or another section is duplication; it costs tokens and
  inflates that rule's rank. Point to a source only when the pointer adds a
  trigger the source lacks.
- **Environment first:** `package.json` scripts, config files and `--help`
  are sources of truth. Point at them; cache only what lookup cannot reveal —
  the gotcha, the unwritten convention, the reason behind a choice.

## Shape

- **Hierarchy:** steps are ordered actions (a recipe, Gate); reference is
  rules and facts consulted on demand (tables). Inline what every task needs;
  push what only some tasks reach into `.paseo-slp/references/` behind a
  pointer.
- **Co-location:** a concept's rule, exception and caveat sit under one
  heading.
- **Completion criteria:** each step ends on a checkable state (candidate
  pinned, verdict recorded, receipt returned).
- **Pointers:** a Read-when cell or one-line pointer front-loads its trigger,
  with one trigger per distinct case.

## Words

- **Leading words:** reuse the template's terms as tokens — Lean, Feature,
  Transition, Investigation, Gate, candidate, seat, `must_ask`, ACCEPT — with
  their template meaning, one term per concept.
- **Positive phrasing:** state the target behavior. A prohibition earns its
  place only as a hard guardrail, paired with the positive target.

## Pruning

- **Sprawl:** a long protocol thins attention even when every line is live.
  Disclose facts to references and cut no-ops before adding a line.
- **Sediment:** revisions remove stale lines as readily as they add. Rationale
  and history go to Git.

Done: every line passes the tactic test, lives in exactly one place and reads
as a rule, step or fact the workspace uses.
