# Review selection and gates

Lead selects the minimum sufficient independent mandates for material decision-changing
questions, risks or an explicit Human, assignment or protocol obligation. The selection
is a reasoned task decision, not a risk score, task-size matrix, family quota or fixed
reviewer count. An absent explicit selection is an open decision, not permission to
omit review. With no material review question or trigger, the owner supplies candidate
and adequate proof; Lead records a short reason and issues the verdict.

Required review follows the effective Human, assignment and protocol obligations,
including any explicitly required fixed seats or axes. Required review cannot be
weakened because seats are unavailable or findings are adverse. A required seat that
cannot be supplied makes the dependent gate BLOCKED. Tiny classification is not a
review waiver. Preserve historical obligations and observations at their original
candidate and round.

## Record the selection

Before a candidate round, record the material questions, applicable obligations,
selected mandates or reason for no review, authority/rule source, candidate and
brief/scope/plan revision, effort bound and stop condition in the task's shared state.
New scope declarations choose an explicit review plan:

- `required` names the independent mandates as lenses with authority/rule sources and
  reasons. The declared required set must be discharged on the pinned candidate.
- `not-required` is a reasoned selection decision with `authorityRef`, `ruleRef` and
  `reason`, zero lenses and null `exemptionClass`. It applies only when no material
  question or required trigger applies; it never waives an otherwise required gate.
- `exempt` is an authority-backed waiver of an otherwise required gate, with a
  nonblank `exemptionClass`, sources and reason. Lead cannot invent waiver authority.

For retained compatibility, explicit `reviewPlan: null` selects the legacy Spec and
Standards rule as a compatibility opt-in, never the new-work default. Omitted plans on
redeclaration retain the prior decision. Exact request retries retain their original
effective decision and idempotent result after later amendments. Legacy stored null
plans and historical rounds retain their obligations.

`authorityRef`, `ruleRef` and `reason` remain claims, not proof of grant authenticity or
risk truth. Durable shape and identity validation does not establish either. A
`not-required` or authorized `exempt` decision permits an empty observation set, but
still pins the measured candidate and passes standing and historical approval,
staleness, rollout and full-chain checks. An empty set cannot discharge a required
plan or malformed historical state. Brief, declaration or mandate changes invalidate
dependent standing reviews; historical approvals remain evidence of their original
event. No transition can supply a smaller required set. An authorized requirement
amendment records fresh authority/reason and starts a fresh round; it never rewrites
prior observations. Dropping mandates after adverse findings to evade obligations is
prohibited.

## Independence and availability

Independent reviewer seats are distinct from the writer and accepting owner, with
separate judgment, neutral context and a stable candidate. A single seat may cover
related questions. Additional seats address distinct unresolved risks or separation
needs. Reviewer and Auditor are optional Peer dispositions assigned a bounded
question; neither creates a
permanent seat or default defect-hunting phase.

Provider-family diversity may add a useful lens, but does not
prove independence and is not a default seat. If Human or protocol requires that lens,
its unavailability blocks the gate. An unavailable optional lens does not block an
otherwise adequate selection. Required seats and obligations are preserved.

## Descriptive lenses

Spec and Standards are optional descriptive lenses, or obligations explicitly
required by a specific protocol. They are not reserved seats for every task:

- **Spec** — does the candidate implement the objective and acceptance? Cite the
  requirement for missing, partial, incorrect or excess behavior.
- **Standards** — does the candidate follow documented repository conventions?
  Cite the applicable source; distinguish hard violations from judgment calls and
  skip what tooling already establishes.

A mandate may combine related concerns. Other questions may concern ownership,
lifecycle, failure, migration, authority, integrity or evidence sufficiency. Choose
questions that could change the decision, not labels to fill a roster.

## Verification stays with the Lead

Reviewer judgment, executed verification and Lead ruling are separate. Verification
re-runs the established checks and pins candidate identity before and after review;
it is Lead's duty around the gate, not a council seat. Reviewer probes may support
findings, but neither a reviewer verdict nor passing tests alone accepts the project.
Evidence binds the same frozen candidate the reviewers saw.

## Smell heuristics

When relevant to the selected mandate, consider these heuristics, never hard
violations: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive
Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative
Generality, Message Chains, Middle Man, Refused Bequest. A documented repository
standard overrides a heuristic. This list creates no mandatory hunting phase.

## Seat briefs

Every fresh seat gets a neutral first-review brief with the objective and
acceptance criteria, actual authority constraints, current candidate identity
(snapshot hash or exact commit), reviewer mandate and lens, relevant source paths,
observed facts and unknowns, and focused proof questions. Include enough context
to assess the assignment; do not narrow the brief to the candidate and sources
alone. Withhold the desired verdict, writer identity and prior findings. The seat
verifies candidate identity before reviewing; a changed snapshot invalidates the
attempt.

For re-review within the same assignment, continue the same independent seat
with the new candidate identity, changes and that seat's prior findings so it
can check closure and affected risks; broaden review when new evidence or material
risk requires it. Do not provide another lens's findings or
verdict as an answer key. A fresh replacement receives the neutral first-review
brief, not another reviewer's conclusions.

Reports stay in-session unless artifact writes are assigned. Tie findings to the
mandate and source, distinguishing observed failures from hypotheses and hard
violations from judgment calls. Include evidence, checks and unverifiable claims.

## Adjudication

Preserve each mandate's findings and conflicting observations in shared task state.
Lead adjudicates each material finding with a reason, supporting or contrary
evidence and residual risk within authority: correct it, reject it with
counterevidence, accept a permitted residual risk, or reopen/escalate the decision.
Unanimity, severity alone or successful reproduction is not a verdict rule.
An unreproduced concern may still expose a decision-changing proof gap.
Missing Human-required proof or constraints cannot be accepted as recorded risk.
A material decision beyond Lead authority goes to its owner; unresolved prerequisites
block the dependent acceptance. Review selection, authorized exceptions, verification
and project verdict remain distinct records; findings remain visible after ruling.

Corrections return to the owning writer; re-review returns to the same independent
seat under session continuity on the current candidate, with current closure and
affected-risk evidence. Prior approval does not transfer automatically.

## Correction loops

Consecutive rounds with the same finding class signal a shared mechanism, not a
new point-fix queue. Investigate that mechanism, enumerate affected sites and
refactor the broken invariant where evidence supports it. Follow the correction,
review and challenge bounds in the assignment and effective protocol; establish
an authorized bound before continuing if none is set. Use a task-selected stop
condition and authorized effort/resource bound, not a universal round quota.
Stop when proof is sufficient, a premise/prerequisite remains unresolved or the
bound is exhausted; exhaustion is not ACCEPT. Resolve the missing prerequisite or
escalate a strategy/resource decision before continuing dependent work.

When unresolved risk still needs independent judgment, select mandates for the
remaining decision-changing questions. If the same class returns after mechanism
work, reopen the premise or strategy rather than issue another point-fix brief.
Any repair gets one authorized writer,
Peer by default or Lead only under the bounded direct-write grant in common
policy; the resulting candidate freezes and re-enters the declared gate. A
property or enumeration test may cover the affected matrix when it verifies a
settled invariant.
