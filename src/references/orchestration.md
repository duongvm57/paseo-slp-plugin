# Topology, independent judgment and handback

Lead reads this procedure for project framing, session continuity, topology,
independent review, design reconciliation or dependency splitting. Repository thresholds and routing belong
to .paseo-slp/workspace-protocol.md; these branches describe how to execute a selected method.
All creation uses the installed delegation procedure and current task authority.

## Frame and select

Establish outcome, ownership, exclusions, evidence standard and open decisions.
Build project context from the assignment and relevant repository evidence:
product objective, current behavior, architecture and module boundaries, recorded
decisions, dependencies, existing work and authority. Read the relevant docs/code
before delegating; distinguish verified facts from assumptions and unresolved
questions. An unclear boundary blocks only the work that depends on that decision.
Keep a concise project checkpoint in the task's permitted notes or session:
decisions and rationale, evidence paths, candidate, owner/agent IDs, dependencies,
open findings and next actions — and, when a review gate applies, the required
gate, its axis→seat IDs and the rule source or exception relied on. Update it at
material decisions and handbacks; after resume/compaction reconcile it with
current repository and actor state. The checkpoint indexes decisions made; it is
neither a substitute policy source nor proof of compliance — a checkpoint that
survives without its rules sends you back to the references, never around them.
Pass each Peer the relevant objective, contracts and constraints, plus evidence
references; retain project-wide integration context in Lead. Context gathering
does not authorize implementation, broaden scope or require reading the whole repo.
For foundation work in an unfamiliar domain, expose missing domain framing and
owner boundaries before committing to a representation. Human may use an advisory
session to clarify them. Keep file/API plans provisional as vertical slices reveal
new lifecycle or dependency facts.

Use the smallest topology that supplies the required independent judgment:

| Task need | Execution and handback |
|---|---|
| Tiny, tightly coupled | One Peer Engineer under Lead; use the repository protocol's tiny procedure, focused proof and Lead artifact inspection. |
| Bounded implementation | Engineer owns writes and proof; Lead inspects; independent review gate if risk/protocol requires. |
| Cross-module ownership or lifecycle | Read-only Architect reconstructs boundaries; Lead records design decision; Engineer implements; independent review gate falsifies the stable result when required. |
| Multiple plausible foundations or costly lock-in | Independent design lenses or sealed council; Lead reconciles material propositions before implementation. |
| Large dependency branch | Bounded Peer/lane or dependency Lead, with scope and handback separate from the main objective. |

Engineer, Architect, Reviewer and Scout use the same Peer role. Assign each a
self-contained question and disposition-specific output (defined in Peer policy).
Read-only reports stay in the session unless a separate report write scope is
granted. When a review gate is required, structure it per
references/review-gates.md: parallel seats on split axes — a single reviewer is
a degenerate gate, not the default. A protocol can make review gates stricter;
inability to supply a required gate is BLOCKED, not permission to skip it.

## Session continuity

Within an ongoing assignment, reuse a suitable existing Peer to preserve its
context. Send authorized corrections to the same Engineer. Ask the same independent
Reviewer to recheck the new stable candidate and affected findings; reviewing an
earlier version does not make that Reviewer its implementer. Supply the new
candidate identity, changes and prior findings, and require current evidence for
closure and regression assessment. Prior approval never transfers automatically.

Reuse reaches only seats this team created through agent-scoped create_agent —
the creation that gives the host the parent link, report route and sidebar
tree. Prompting a standalone session can observe work it already owns, but it
cannot carry a new delegation: without the parent link the seat has no report
route and sits outside the Human-inspectable tree.

Before reuse, verify the Peer ID, owner/parent relation, owned scope,
availability, authority, independence and current runtime against the project
routing policy. Resume through Paseo follow-up; reuse does not authorize a
model switch or bypass quota fallback/ownership settlement.
Record why a new session is needed: a new independent lens or sealed seat,
implementation involvement that invalidates review independence, a distinct scope
needing separate ownership, or an authorized recovery. A separate session
supplies independent judgment; it does not by itself require a separate
workspace — placement follows the delegation procedure's workspace pin, and
only a declared worktree, repository or lane-isolation need splits it. Scope
changes require an explicit assignment; they do not automatically require
discarding useful context.
An Engineer cannot become the independent Reviewer of its own changes. Lead owns
the reuse/new-session choice within protocol, budget and Human constraints.

## Independent design and council

1. Give fresh sessions the problem, evidence and neutral constraints. Withhold the
   Lead's preferred answer while framing is unresolved. Assign distinct lenses
   such as ownership/lifecycle versus failure/migration; allow alternatives beyond
   the Lead's options. Two or three lenses are choices by risk, not fixed counts.
2. For sealed work, collect each report before exposing any seat's conclusions to
   another. Do not fork the Lead or share its prior reasoning as a substitute for
   independence. If visibility leaks, record the limitation and restore independent
   judgment when that gate requires it. Do not label contaminated work sealed.
3. Extract material propositions, verify decision-changing claims and use bounded
   cross-challenge where disagreement matters. The protocol sets debate limits;
   adding seats or taking a popularity vote supplies no technical authority.
4. Lead records one binding decision, supporting evidence, alternatives, strongest
   counterargument, reversal conditions and unresolved risks. Escalate owner-only
   product/cost/irreversible decisions with that evidence. Engineering starts when
   the contract needed by the slice is decided, not when every future detail is known.

## Ownership, isolation and integration

Record agent, disposition, repository/worktree, owned scope, dependencies,
integration owner and acceptance owner for every lane. One moving scope has one
writer. Concurrent writers require separate worktrees even if their workspace IDs
differ. Use discovered Paseo create_workspace with isolation=worktree and a known
source/base, then give create_agent the returned workspaceId; verify actual paths.
Worktrees branching from a commit do not carry unrelated uncommitted work: identify
the intended base and required changes explicitly before the lane starts.

Overlapping scopes require serial ownership transfer or decomposition. Read-only
review also needs a frozen candidate. Have writers acknowledge handback and pause;
an idle lifecycle label alone is insufficient. The receiving owner inspects the
candidate and dependencies before accepting transfer. Keep integration itself under
one write owner; Lead retains the decision even when a Peer performs integration.
Merging/cherry-picking commits and any commit/push still require applicable authority.
Review the resulting integrated candidate; branch reviews do not prove integration.

## Reopen, dependencies and recovery boundaries

For REOPEN_REQUEST, identify the failed premise and its behavioral consequences;
stop the incompatible patch, investigate and record the revised contract. Precision,
cadence, API shape or failure semantics changes that alter requirements are design
decisions even if discovered in implementation. Tests verify decided behavior;
they must not invent a field, adapter or mock shape to settle an unknown contract.

For DEPENDENCY_REQUEST, determine the actual owner and minimum interface/result
needed. A large new domain can go to a separate Lead through Paseo when authority
allows. Define its objective, exclusions, contract, stable result, proof and return
recipient. Keep the original Lead on its trajectory as integration/acceptance owner.
Escalate cross-project authority before assigning writes in another repository.
For cross-project relay, follow references/governance.md; without an explicit grant
and a verified recipient route, keep the dependent branch BLOCKED.

For BLOCKED, preserve evidence and state the missing decision, capability or external
prerequisite. Repeated corrections call for a root-mechanism check, not another local
patch by default. Lead answers each request with an authorized continuation, revised
assignment or explicit blocker. Supervisor recovery follows references/governance.md.

## Proof and acceptance

Require exact artifacts/diff (including relevant untracked and pre-existing work),
actual commands/output/exit codes and a stable identity. Use the installed snapshot
helper or an exact commit with all relevant working changes accounted for. Record
external evidence separately; ignored outputs/processes are outside a Git snapshot.
The helper aggregates untracked nested repository roots with per-sub-repo identity; staged gitlinks snapshot as `{path, indexOid, headOid, state}` — any state other than `clean` lands in top-level `incomplete`, and that submodule scope stays unproven until separately agreed evidence covers it.

Keep candidate writers paused during review and verification. A before/after identity
change invalidates that acceptance attempt. Reviewers report severity, evidence,
checks and APPROVE/FINDINGS; Engineer supplies proof; Lead issues the project verdict.
Follow Session continuity for corrections and re-review. Keep unresolved findings visible.
Gate findings repeating one class across consecutive rounds follow
references/review-gates.md's correction-loop escalation — enumeration, an
invariant refactor or a findings committee — not another point-fix brief.

Evidence must address real failure mechanisms and the Human outcome. Use integration,
migration, cancellation, performance or Human product/visual/playtest evidence as
appropriate; unit-test success cannot substitute for an untested outcome. The Human
decides subjective or owner-only trade-offs. Complete with candidate, actual checks,
review evidence, ACCEPT/CHANGES_REQUESTED/BLOCKED and residual risks. Artifact
acceptance is distinct from Delivery and resource settlement: a bounded task settles
after Delivery completes and no correction or re-review remains open. Keep the same
Engineer and independent review seats for open rework, then follow
references/monitoring.md and the repository protocol to reconcile task resources.
Settlement does not itself archive, kill or reparent sessions.
