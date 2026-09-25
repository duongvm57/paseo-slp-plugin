---
version: '1'
owner: ''
applies_to: ''
last_reviewed: ''
package_version: ''
template_sha256: ''
routing_intent: ''
agent_mode: ''
supervisor_notebook: ''
decided_by: ''
decided_at: ''
---

# Workspace Protocol

Supervisor and Lead read this file when the assignment lands — before any
reply or decision that depends on repository tactics, not only before
delegation. Supervisor also reads it when assigned a protocol audit. Lead
passes only task-relevant constraints to the Peer.

This file is the repository's one effective protocol. The Human's current
assignment controls authority; installed role policy holds the invariants no
protocol relaxes. Complete unknown fields from repository evidence and the
assignment before the decision that depends on them; a blank is an open
decision, never a grant. The files listed under Repository references carry
operational facts, not additional rules.

The frontmatter is the single source for owner, version, review date, scope,
routing intent and the Supervisor notebook — update it when decisions change.
`package_version` and `template_sha256` record the
package and common template this file was rendered from. Onboarding examples
are setup guidance, never read at runtime. `agent_mode` records the intended
Paseo modeId for agents spawned here (for example `bypass`); empty falls back to
the spawn bundle's own modeId, and the spawner asks only when neither is set
rather than letting agents inherit the host default.

## Context recovery

If role policy or locators are missing after compaction, run the Policy
recovery command delivered with the role (the verified runtime's `bin/slp.mjs
instructions <role>`) with its recorded Node, runtime root and daemon home — a
source-checkout preview is not the managed session's policy — then recover
assignment, ownership and the work-state checkpoint from task evidence before
applying these tactics.

## Authority

Lead selects methods, routes bounded work, reconciles technical decisions and
accepts project artifacts within the assignment; every implementation write
belongs to a Peer. Human decides product, priority and portfolio changes,
owner-reserved architecture contracts, irreversible or material-cost trade-offs
beyond the grant, external effects and subjective acceptance — each such
boundary is `must_ask`, and the Repository configuration lists this repository's
additions. A missing must_ask answer pauses the dependent work; it never
defaults to Lead. Edits, commits, pushes, deploys, host configuration and other
repositories each follow the applicable authority; profile permissions do not
supply it. Cost and model budget come from explicit assignment boundaries.

## Choosing a workflow

Lead chooses per task from the outcome and evidence, not a ticket label or the
length of a description. Recipes are starting shapes, not role conveyors: add a
seat only for a distinct question or artifact and skip a phase whose evidence
exists — except the review gate, which no recipe skips.

| The outcome is… | Start with |
|---|---|
| A change meeting the tiny conditions of Recipe A | A — Lean |
| A change whose acceptance or contract is open, or that needs coordinated parts | B — Feature |
| Moving state/data, phased rollout, operational change or recovery that is hard to reverse | C — Transition and recovery, for that phase even inside a feature |
| An answer, a cause or a decision among options | D — Investigation; no implementation phase implied |
| Not yet classifiable | Gather bounded evidence or name the missing decision |

Risk triggers inside any recipe: an uncertain premise or contract → an
investigation branch or independent design before tests pin it; cross-module
ownership, lifecycle, migration or security → a read-only Architect first; a
hard-to-reverse choice or unresolved disagreement → distinct design lenses or a
sealed council; overlapping moving scope → serialize, or settle its contract and
integration owner first; a large dependency in another domain → a bounded lane
or dependency Lead with explicit contract, handback and integration owner;
anything beyond the grant → the owner, through the assigned Supervisor or the
Human.

Record one sentence per task naming the recipe, why it fits and what would
change it; reclassify into another recipe before the affected work when scope or
risk grows. Recipes chain and nest — an investigation can end in a Lean task, a
feature can contain a transition phase. The larger outcome keeps its owner; each
next phase needs its own conditions and grant, so a new recipe name never widens
scope.

Council defaults: two distinct lenses, at most one challenge/response round per
material proposition, then Lead records one binding decision. Add a lens only for
an unresolved decision-changing question worth the cost. In a new domain,
establish enough Human framing to locate owner boundaries before foundational
implementation.

## Review gate

This protocol requires an independent review gate for every recipe's code,
behavior, doctrine or decision artifact, before acceptance or execution:
parallel Spec and Standards seats — split-axis seats, never one merged seat — on
the frozen candidate, in sessions separate from the writer and structured by the
installed review-gate rules. Reviewer seats are checkers, not implementation
owners, so they never take a task out of Lean. This template lists no single-seat
change classes; adding one is a Human protocol decision recorded under
Overrides. Seat titles name the seat inside taskLabel —
`Peer — Reviewer — <task> / Spec` and `Peer — Reviewer — <task> / Standard`,
unabbreviated — never an "axis" suffix; seats already running keep their titles.

## Correction, verdict and delivery

Every recipe ends with this procedure:

1. Lead freezes the owner's paused candidate, verifies it — re-runs the
   established checks and pins the snapshot before and after the gate — and runs
   the review gate on it.
2. Findings return to the same owner of that artifact — the Engineer, Migrator
   or report owner — as a correction assignment inside the same task. The
   owner's next stable, paused candidate repeats step 1 with the same seats
   under installed session continuity. Findings repeating one class follow the
   installed correction-loop escalation instead of another point fix.
3. Lead issues ACCEPT, CHANGES_REQUESTED or BLOCKED with candidate identity,
   proof, both axis results side by side and any unresolved risk/resource, on
   the required handback routes.
4. After ACCEPT, the actor holding the delivery grant delivers as the Repository
   profile's Delivery row states and records the receipt. The task completes
   only at that row's completion point; any other receipt is progress.

## Recipe A — Lean (tiny procedure)

Lean is the tiny procedure. A task qualifies only when scope and verification
are clear, the change is easy to reverse and it changes no authority,
delegation, lifecycle or integrity rules; Lead records the reason in one
sentence. Lean saves preparation — one implementation owner, no plan, brief,
formation or report files — never the review gate.

1. Lead supplies one short inline brief: outcome and acceptance, owned/excluded
   scope, authority, base, established checks and report recipient. Record the
   formation in the same brief or timeline entry: operation, parent/child,
   workspace/cwd and ownership. Reuse policy text under the installed core's
   freshness rule; still verify current route/runtime prerequisites.
2. Delegate to one Peer Engineer through agent-scoped create_agent with the pinned
   workspace and notifyOnFinish, verifying parentage and placement.
3. Engineer runs the inner loop — edit, run the checks, read the failure, fix,
   recheck — inside the granted scope until a stable candidate, without handing
   back per failing check. A failed premise, missing dependency, lost authority
   or budget, or Human stop ends it with REOPEN_REQUEST, DEPENDENCY_REQUEST or
   BLOCKED. Engineer returns the artifact/diff, candidate identity, actual checks
   with relevant outputs and exit codes, remaining risks and resources in the
   session, then pauses writes.
4. Lead inspects the artifact and evidence, then runs Correction, verdict and
   delivery.

A second implementation owner, a design seat or a transition phase means the
task has left Lean; reclassify it into B, C or D. A repository may strengthen
this procedure. A missing or older protocol that does not define a tiny
procedure does not silently inherit these exemptions: record the gap and propose
an update within Human authority; package installation/update never rewrites a
repository protocol.

## Recipe B — Feature

Output: one coherent end-to-end behavior, not loose changes for the Human to
assemble.

| Phase | Owner | Unlocks the next phase |
|---|---|---|
| Behavior | Lead; Analyst Peer only for genuinely unclear scenarios | Acceptance scenarios, exclusions, owner questions |
| Contract | Architect Peer for new interface/state/ownership/lifecycle; Lead decides within mandate | Decision record: contract, alternatives, failure semantics, counterargument, reversal conditions |
| Slices | Lead | Owner, base/worktree, predecessor and readiness per slice; one integration owner |
| Build | One Peer Engineer per slice, the Lean inner loop | Slice candidate and proof; independent slices in parallel worktrees |
| Integrate | One integration writer with merge/cherry-pick grant; Test Engineer Peer only for a distinct test/fixture/E2E artifact | Evidence for the acceptance scenarios on the integrated candidate |
| Close | Correction, verdict and delivery on the integrated candidate; findings to the owner of the affected scope (slice Engineer or integration writer) | Feature verdict, delivery receipt and what still depends on the Human |

A slice starts once the contract it needs is decided. Slice approvals never
transfer to the integrated candidate.

## Recipe C — Transition and recovery

Output: state moved and reconciled, or a stop/restore decision with evidence; a
script exiting 0 is not completion.

| Phase | Owner | Condition to proceed |
|---|---|---|
| Impact | Lead; Architect Peer for data/lifecycle contracts | Source/target inventory, reconciliation invariants, compatibility, blast radius, data owner |
| Prepare | Migrator Peer | Runbook, preflight, rehearsal, rollback or forward-fix/restore plan — with no rollback, say so and decide recovery first |
| Gate | Correction, verdict and delivery steps 1–3 on the frozen script/config/runbook and rehearsal evidence; findings return to the Migrator | ACCEPT with explicit stop conditions |
| Execution checkpoint | The authority the assignment names — the Human for production unless granted | Environment, window, backup and candidate match what was accepted; no grant, no execution |
| Execute | The Migrator (or an Operator Peer) under a separate phase assignment | Step receipts and reconciliation checkpoints; stop and return to Lead when an invariant fails |
| Reconcile | Lead | Lead issues the outcome verdict (step 3) on reconciled post-state evidence, including stop/restore results and remaining risks/resources, then delivery step 4; pre-execution ACCEPT does not accept the outcome |

Incident recovery uses the same shape: contain within the grant, diagnose through
Recipe D when the cause is unknown, pass the fix through gate and checkpoint,
then reconcile.

## Recipe D — Investigation and decision

Output: an answer with evidence and limits, or a decision record the owner can
choose from.

| Phase | Owner | Artifact |
|---|---|---|
| Frame | Lead | Question, sufficiency criteria, experiment scope, Human-held decisions |
| Gather | One Researcher, Scout or Investigator Peer matched to the question — the report owner | Sources, observations, rejected hypotheses, unknowns |
| Recommend, when asked | The report owner, or an Architect | Alternatives, trade-offs, recommendation, counterargument, reversal conditions |
| Close | Correction, verdict and delivery; Spec checks question and coverage, Standards checks method and evidence; the report owner revises or lowers certainty | Accepted conclusion, or BLOCKED naming what is missing; decisions beyond mandate go to the Human |

Finding a cause grants no write to fix it; an experiment needs its own write
scope, and implementation is a new assignment into Recipe A, B or C.
"Insufficient evidence" with stated limits is a valid conclusion.

## Assignment routing and optional lanes

By default, the Supervisor routes authorized intake to its Lead, which selects
and combines recipes per task regardless of intake source. A tracker does not
require a separate Task Lead. Without lanes, the Human or Supervisor assignment
forms the team. Split into lanes only for explicit authority or capacity needs
under a Human-granted formation mandate. A lane is a long-lived Lead session holding a standing mandate, such as a tracker task
stream: the mandate authorizes the Lead, and each admitted task is its own
bounded assignment with its own Peer team. Correction and re-review continuity
stay inside that task; the task closes at the Delivery completion point with no
correction open, which is its team's settlement boundary under installed
monitoring rules. Lanes are a repository tactic, not role types: a lane Lead is
an ordinary Lead reading this whole file.

- Supervisor receives or pulls work under the Human assignment using tools
  supplied by the repository harness, then delegates to its verified child Lead
  or current team member, or through an authorized handoff. Observing a Lead is
  not a route for new work. Pulling a request grants none of the actions it
  mentions. Lead chooses the workflow.
- Lead owns workflow and dependencies: admits, chooses the recipe and records
  predecessor and readiness — B waits until A is accepted and B's base contains
  A under the delivery policy, while an independent C runs in parallel. One
  Engineer per Lean task or Feature slice, review seats per gate, separate
  worktrees for concurrent writers; capacity counts review seats too.
- Work beyond an explicitly limited lane mandate returns to the Supervisor
  with reason and evidence; the Supervisor reroutes it under the rule above or
  asks the Human, using the lane Lead's evidence rather than repeating technical
  triage; the old writer settles before a new one starts.
- Two lanes in one repository name the owner of every shared contract and of
  integration; an unresolved owner pauses the dependent task. If coordination
  repeatedly costs more than the context separation helps, propose consolidating
  lanes to the Human.

The repository harness owns external connectors/MCP, credentials, polling or
heartbeat setup, and source-specific queue bookkeeping. This protocol consumes
the resulting assignment; it does not prescribe a tracker integration or intake
pipeline. If the assignment asks Supervisor to pull work, it uses those supplied
tools within the grant and reports missing capabilities. Use beads only when
already enabled, following installed work-tracking policy. Task ownership,
review and delivery acceptance still follow the rules in this protocol.

A lane is continuous responsibility, not an immortal session: when its context
degrades or ownership must change, the Lead proposes a handoff to its Supervisor
or the Human with outcome, state, accepted and rejected decisions, evidence,
dependencies, candidate/review state, remaining work and resource receipts, and
the installed governance and provider-routing procedures run the transfer.
Children keep their parent; each resource settles or is handed off before the
successor assigns writes. No compaction count is a threshold.

## Repository configuration

Onboarding fills these independent settings from repository evidence and Human
decisions. Assignment, delivery and execution controls can coexist; none selects a
workflow or creates a Lead type. All four recipes remain available by default.

| Field | Value |
|---|---|
| Criticality, domain and dominant risks | Not yet established |
| Expensive-to-reverse decisions | Not yet established |
| Additional must_ask boundaries | None recorded |
| Assignment source | Human or Supervisor; external tools and automation belong to the repository harness |
| Execution scope | Per assignment: repo/base, remote, writable scopes, environments and phase grants |
| Capacity | Record parallel task and review-seat limits before admitting concurrent work |
| Lead topology | One Lead handling the assigned work mix; split only for explicit authority or capacity needs under a Human-granted formation mandate |
| Shared-state controls | Before a Transition phase: name executor, environment, rehearsal, backup/restore, window and reconciliation evidence |
| Work state | Lead checkpoint in the owner's timeline or an authorized notes path |
| Delivery and completion point | As each assignment states; the task completes when its assignment's stated outcome is accepted |

## Repository references

This file holds rules and decisions. Operational facts they rely on — exact
check commands and the behavior each proves, CI gates and switches, how project
skills or tools are installed, environment and path hazards — live in
`.paseo-slp/references/<topic>.md`, listed below and pointed to in one line
from the section that applies them; a short fact may stay inline instead. A
reference records facts verified from this repository with the date verified.
It never adds, relaxes or overrides a rule here or in installed policy; a rule
found in a reference moves into this file through a Human decision. Read a
reference at the decision that needs it. Treat a missing, stale or contradicted
reference as an open fact to verify and report, never as a grant. Updating a
reference needs write scope for it, not a protocol decision or version bump.

| Topic | Path | Read when |
|---|---|---|
| — | None recorded | — |

## Ownership and integration

Inspect existing changes and active writers. Record owned/excluded scopes and return
recipients. Concurrent writers require separate worktrees and non-overlapping scope
ownership; otherwise serialize handback. Review only paused, stable candidates.
Assign one integration writer, preserve unrelated changes and reverify the integrated
candidate. Do not infer filesystem isolation from workspace IDs.

Seats join the team only through agent-scoped create_agent; a prompt to a
standalone session carries no new delegation. One team's seats share the
assignment's workspace by default — read-only review seats included; a separate
workspace needs a declared worktree, repository or lane-isolation reason recorded
with its resulting paths. Keep the team→parent→workspace→worktree owner map and
creation receipts in the owner's timeline or an authorized notes path so the
Human can trace every lane.

## Candidate, verification and acceptance

Established checks: the exact commands found in this repository and the
behavior each demonstrates live in its checks reference under Repository
references, or inline when short. Name the relevant ones in each assignment;
never take a command from this template. Run a check that must be isolated from
the session's ambient environment under a whitelist (`env -i` plus the variables it
needs) or with the complete injected variable set unset — a partial `env -u`
leaks runtime variables and can fake failures.

Match evidence to the risk: integration/failure/cancellation/migration checks or
Human visual/playtest/product evaluation where needed. Coverage and mock-only
checks cannot define success. Identify the candidate with the installed
snapshot helper or an exact commit with all relevant working changes accounted
for; record external proof separately. Review and verdict bind to the same
candidate.

Acceptance is not assignment close: keep accepted Peers idle after the accept
sweep so rework keeps its context, and consider a batch archive when the
assignment that formed the team closes and rework has settled. A Human stop
still takes effect immediately; idle retention never runs hidden work or
delays required cleanup.

## Reopen, dependency and blocked handling

Lead reconciles REOPEN_REQUEST (failed premise) and DEPENDENCY_REQUEST (another owner,
API or scope). BLOCKED identifies a missing decision/prerequisite/capability. After
repeated identical failures, inspect the shared mechanism and prerequisite changes
before retrying; any numeric retry threshold is a repository choice. Owner-only
decisions go through the assigned Supervisor or directly to Human. At handback,
record actual proof, unresolved findings and settlement of task-owned resources.

## Routing and skills

Record routing_intent (`inherit`, `pinned`, `empty`), decider/date and pool
maintenance/budget authority; IDs belong in the catalog. Before delegation or
fallback, read the verified runtime's `src/references/provider-routing.md` for
pool precedence, profiles, readiness, Jev receipts and handoff. Missing eligible
runtime blocks that delegation; use onboarding. Human controls pool changes and
quotaFallback. Lead selects within grant; an eligible option grants no handoff.
Name task-relevant micro skills in Peer assignments; Lead keeps macro skills.
How this repository installs or exposes project skills is an operational fact
for Repository references.

## Monitoring and heartbeat

Use finish/error/permission notifications first. Lead reports material decisions,
reopen/dependency requests and significant risk changes to the assigned Supervisor.
Short bounded work with adequate events gets no heartbeat. For long work or
incomplete event coverage, record the observer, reporting route, cron/timezone,
expiry/run bound, evidence checkpoint and stop condition before creating a
fallback heartbeat; its prompt names the live checkpoint or state file to read,
never a snapshot of its contents. There is no universal cadence; receipts,
bounded lifetime and settlement follow the installed monitoring reference, and
pre-existing monitoring outside the task is retained.

## Repo anti-patterns

supervisor_notebook names its owner and durable path or timeline retrieval route.
Writes need scope. Record observed patterns with evidence/counterevidence,
mechanism, impact and outcome in authorized notes; report retrieval gaps.

## Overrides and evolution

List every place this file changes a template rule or its wording, so a later
package upgrade can tell Human decisions from template text. Filling the
frontmatter, Repository configuration, Repository references and the
referenced files is configuration, not an override — including moving
operational detail out of this file into a reference:

| Section | Change | Decided by / date |
|---|---|---|
| — | None | — |

Keep effective decisions here; rationale/history belongs in Git or authorized
audit artifacts. Update version/review date when decisions change; preserve Human
choices during onboarding. Add rules only when evidence shows they help.
