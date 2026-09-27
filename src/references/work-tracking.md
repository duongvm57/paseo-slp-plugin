# Work tracking with beads

Read this reference only when session entry says `Work tracker: beads
(enabled in SLP settings)`. When that line is absent the tracker is disabled —
ignore this file entirely and work exactly as the rest of your instructions
describe. When session entry shows a `Work tracker: setting unreadable` gap
line instead, record the gap in your report and continue without the tracker.

Beads (`bd`) is a durable, per-repository issue graph. SLP seats use it to
query work state — issues, assignees, dependencies, comments — instead of
rebuilding that state from conversation, and to recover it after resume or
compaction. It is evidence, not a control plane: Paseo alone owns lifecycle,
parentage, placement, notifications and report routes.

## Probe first

Before any tracked work, run the probe named in session entry:

```
<slp cli> tracker <repository> --paseo-home <home>
```

It prints one JSON object. `state: "ready"` means `bd` works and the
repository is a beads workspace. `unavailable` (no working `bd`) or
`uninitialized` (no beads workspace in the repository) are gaps: record the
state once in your report, then continue without the tracker — a missing or
broken tracker never blocks work, and you must not fix it yourself.

SLP never installs, initializes, upgrades or configures beads. Do not run
`bd init`, `bd setup`, `bd hooks install`, `bd sync`, `bd dolt push` or any
command that writes beads configuration, and do not edit files under
`.beads/`. Installing `bd` and initializing a repository are Human actions;
if the probe reports a gap, report it — do not repair it.

Always pass `--json` when command output feeds a decision.

## Boundaries

- **Evidence, not control plane.** Tracker state never creates, wakes or
  retires a seat. Seat lifecycle stays with Paseo and the assignment.
- **Authority is the assignment.** A claim or assignee field grants no write
  scope, commit, push or external action. A claim without a matching
  assignment is drift evidence — report it.
- **Owners assign; assignees transition.** A Peer never self-assigns with
  `bd ready --claim`; assignments arrive only through the Paseo assignment.
- **Review gates stay SLP gates.** Tracker status never discharges a
  required review, and never substitutes for artifact, candidate identity
  or checks in a handback.
- **Status is a recorded claim, not proof.** `closed` in beads is a note in
  the graph; acceptance still needs the real evidence the assignment names.

## Writers — one writer per scope

| Scope | Writer |
|---|---|
| Root issue for a Human task or intake item | Supervisor, or Lead when no Supervisor is assigned |
| Child issues, dependencies, assignment of children | Lead |
| Status, comments, discovered work on the issue an assignment names | that assignment's seat |

## Identity

Hook-family seats receive `BEADS_ACTOR=slp-<role>-<agent id>` in their
provider environment. If `BEADS_ACTOR` is unset — Devin seats on the wrapper
transport never receive it — pass `--actor slp-<role>-<agent id>` on every
write command so `bd history` attributes the change to your seat. Never
impersonate another seat's actor.

## Procedure

Command syntax below is [verify] — confirm against `bd <command> --help`
before relying on a flag, and record any drift in your report.

- Root owner (Supervisor, or Lead when unassigned): `bd create … --json` for
  the Human task. Intake items carry `--external-ref <source>:<key>` plus
  label `intake`, looked up first with
  `bd search --external-contains <source>:<key> --json` so retries stay
  idempotent. Name the root issue ID in each assignment.
- Lead: `bd create … --parent <root>`, `bd dep add <dependent>
  <prerequisite>` (dependent first), `bd assign <id> slp-peer-<id>`,
  `bd ready --json`, `bd dep tree <root>`, `bd list --assignee … --json`.
  A `must_ask` decision becomes `bd gate create --type human --blocks <id>`
  — only the Human resolves it.
- Assigned seat: `bd show <id> --json`, then `bd update <id> --claim`. A
  claim conflict means someone else holds it — report, never force.
  `bd comments add <id> …` records progress. Out-of-scope work becomes
  `bd create … --deps discovered-from:<id>` plus a report to the assigner.
  `bd close <id> --reason …` only when the assignment makes closing yours.

## Recovery and handback

After resume or compaction, rebuild task state from `bd show <root> --json`
plus its children — the graph complements the Lead checkpoint and Supervisor
notebook, it does not replace them. A lapsed lease or a `bd reclaim` is a
signal, not a transfer: verify owner settlement through Paseo before
reassigning anything.

Every report or handback names all open issue IDs it touched. Settlement
means no claimed-but-abandoned issue and every gate resolved or explicitly
handed off.

When the root issue is the settlement sink, keep the `kind: "settlement"`
`slp-record` in its comment so recovery can rebuild task-to-seat evidence; see
`references/report-records.md` for its fields and fallback sinks.
