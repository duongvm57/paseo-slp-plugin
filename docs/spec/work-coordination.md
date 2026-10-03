# Work coordination

This revision makes the operative assignment and its material changes
retrievable across sessions. It supports SLP's distinction between objective,
real constraint and provisional design, and keeps evidence attached to the
candidate actually being judged. The Human's current assignment authorizes
implementation; repository review and delivery rules continue to apply.

The [assignment continuity guide](../work-continuity.md) specifies the native
offer/accept sequence and its authority and evidence boundaries.

## Authority and ownership

The registration tuple remains immutable. The current effective owner alone
can amend its brief, reconcile a material decision or change its declared
ownership/review plan. Planned succession appends an exact nominated Lead's
acknowledgment under ownership, ledger and brief CAS; it preserves the
assignment identity and all existing work streams. Offering grants only
usable-nominee read access, never mutation authority or execution-cohort entry.
Acceptance works before or after the former owner retires and atomically denies
that owner's fresh writes. Exact live prior owners and attached seats retain
participant reads. Revoked, rebound or otherwise foreign callers cannot use
historical ownership as authority. No prior offer means no native succession.
Claims about authority retain their source pointers; storing a pointer does
not verify the grant or expand it.

The runtime owns checks that require one transaction over durable state:
current owner identity, immutable revision/CAS, declared overlap and review
freshness. Policy and repository tactics choose the work and gate; they cannot
make a stale adapter request current or repair an invalid historical chain.
The proof-copy harness remains outside the installed runtime. This revision
adds no setting, mandatory onboarding step or external tracker dependency.

One moving scope has one write owner. Agent ownership, state ownership,
dependency edges and notification recipients are distinct declarations.
Declared path/resource overlap must be rejected while two active scopes
claim the same moving surface. The check covers declared surfaces, not all
possible semantic dependency or shared runtime effects. Lead still chooses
merge-safe decomposition and integration ownership. Repository isolation
tactics remain in the effective protocol.

## Operative brief and decisions

A brief distinguishes the outcome and acceptance criteria, constraints with
their authority sources, current design/assumptions, unknowns and proof,
owned/excluded surfaces, dependencies and notification recipients. Existing
assignments without this structured brief remain readable; the missing
semantic context is visible rather than reconstructed from guesses.

An amendment appends an immutable revision under an expected-current-revision
check. It records its reason, authority source and affected owners. A material
decision records the proposition, ruling and reason, supporting and contrary
evidence, unresolved risk, affected brief revision and owners, notification
references and outcome references. Acknowledgment or a message promise is
not evidence of an actual work change. Recorded claims and runtime-observed
candidates/checks retain separate provenance.

The read path exposes current and bounded historical state. Omitted history
is counted with a continuation/retrieval path. It must not silently shorten a
constraint, decision or evidence pointer and pass that as complete. Retention
must preserve committed historical integrity; no tip cache, pruning of
hash-chained events or automatic deletion of accepted evidence is introduced.

## Review mandates

Lead selects the minimum sufficient independent mandates for questions that
could materially change the decision, including review required by the Human
or effective protocol. Spec and Standards are possible lenses, without an
automatic pair, reviewer count or provider-family requirement. One independent
mandate may cover related questions; additional seats address distinct questions
or required separation. An optional Auditor investigates a specific proof gap.

The owner records one review decision before the candidate round:

- `required`: nonempty named lenses with their authority and rule.
- `not-required`: no applicable review trigger, with authority, rule and reason;
  zero lenses and no exemption class. This does not waive a mandatory review.
- `exempt`: an authorized exception to a required review, with authority, rule,
  reason and exemption class; zero lenses.

A new scope must supply its decision explicitly. Omission is rejected; explicit
`reviewPlan: null` deliberately selects the legacy Spec/Standards rule for
compatibility. Redeclaration with an omitted plan retains the prior decision.
Exact retries keep their original effective plan and result after later changes.
Stored legacy declarations and rounds retain their original obligations.

A transition request cannot provide a smaller required set. Changing a brief,
scope or plan invalidates dependent review freshness; a new round must bind the
current declaration and measured candidate. A no-trigger decision or exemption
still requires current candidate proof and valid approval/rollout history.
The owner cannot drop mandates after adverse findings to evade an obligation.
The runtime verifies the stored choice and its pins; authority pointers and the
risk assessment remain claims for Lead/Human adjudication.

Each observation belongs to one mandate and exactly one assignment, scope
revision and candidate. The writer and accepting owner cannot supply the
required independent observation themselves. Missing required observations
block the dependent transition. Findings and disagreement remain visible to
the Lead, who adjudicates; review observations, scope completion and a green
check never become project acceptance by themselves.

A neutral initial review includes the objective, acceptance, real constraints,
candidate, mandate, relevant source/evidence and unknowns. It withholds the
desired verdict and previous reviewers' conclusions. A proof audit may run
bounded probes on a separately owned candidate copy. Hypotheses and confirmed
findings have different meanings; confirmation may establish a missing proof
obligation through source evidence without inventing a reproduced runtime bug.
Provider diversity is optional and supplies no independence proof.

The Human has authorized this source repository to use selected mandates and
task-specific stop conditions and resource bounds. No universal correction-round
quota applies. Re-review addresses affected obligations on the current candidate;
repeated mechanisms reopen the premise or strategy. Unresolved prerequisites or
an exhausted budget require a disclosed disposition, never automatic acceptance.
Other repositories retain their effective protocols until an authorized change.

## Reports and continuity

An optional structured report augments the existing v1 evidence envelope.
Selecting a report format requires meaningful content for that format:
execution result and unfinished work, review mandate/findings and evidence,
or the Lead's adjudication and unresolved decisions. Evidence fields keep
their original validation and provenance. `read`, `ran` and declared checks
remain self-reports; Lead/CI replay is still required where the assignment
requires it. A renderer preserves the semantic report and its evidence block.
Legacy reports remain valid without invented semantic fields.

A structured handoff retains assignment/authority, decisions and assumptions,
ownership/dependencies, candidate and proof, findings, next action and resource
owners. Legacy free text stays supported with a disclosed structure gap.
Preparation emits context/arguments, not host lifecycle actions. Old-owner
settlement and receiving-owner acknowledgment still need actual host/task
evidence. No automatic reparenting, agent replacement, cancellation, delivery,
merge or deployment is added.

## Human retrieval

A read-only workspace view shows the operative brief and authority sources,
material decisions, unresolved disagreement, owners/dependencies and candidate
or outcome evidence. It binds the selected workspace to the verified served
daemon home, reports unreadable/absent/incomplete sources and preserves
claimed-versus-observed distinctions. Switching workspace/host invalidates
old async completions. The view adds no mutation authority and does not claim
that Human steering changed work without outcome evidence.

## Proof

Verification covers legacy reads and additive migration, owner/seat isolation,
CAS conflicts and idempotent replay, immutable historical revisions, declared
overlap/dependency errors, explicit required/not-required/exempt decisions,
legacy compatibility, omitted-plan rejection and inheritance, replay after
amendments, self-review and stale-candidate rejection, meaningful structured
reports and handoff warnings,
bounded Human retrieval and stale-result rejection. Assertions use independent
contract oracles. Full-chain integrity, payload freshness, install-tier
dependencies and installed candidate ABI remain required.

Local checks establish these interfaces and their error states. Live host
delivery, model compliance, subjective workflow value and E2E acceptance need
separate observed evidence. No cleanup of pre-existing scratch files or report
commit is part of this revision.
