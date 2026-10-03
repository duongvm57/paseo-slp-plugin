---
version: '11'
owner: 'duongvm (Human)'
applies_to: 'paseo-slp source repository'
last_reviewed: '2026-10-03'
package_version: '0.4.0'
template_sha256: 'c5b6db392e3d9646d931cda658c3364fe64287caf1f9717ad323681f2e860ad1'
template_source: 'source checkout; unreleased working candidate'
template_provenance: 'template_sha256 retains historical rendering provenance; current_source_template_sha256 records the amended source template basis'
current_source_template_sha256: '93009c554bd28d8da782fc33d8ef7e0b5cca0cc5bb3b34bd078d8c84828688a2'
current_source_template_measured_at: '2026-10-03'
review_selection_decided_by: 'duongvm (Human)'
review_selection_decided_at: '2026-10-03'
review_selection_authority: '/tmp/paseo-slp-review-selection-20261003/assignment.md; Human-approved selection and source-protocol budget change'
routing_intent: 'pinned'
supervisor_notebook: '.paseo-slp/notebook.md (owner: Supervisor)'
decided_by: 'duongvm (Human)'
decided_at: '2026-09-30'
---

# Workspace Protocol

Repo-specific tactics choose WHEN / WHY / WHO; the assignment supplies outcome,
scope, authority and required proof. Installed role policy owns role invariants.
The repository Harness owns execution mechanics; use repository and task
instructions for commands, E2E and delivery. SLP is a replaceable methodology,
not a product or task-engine contract.

## Tactic

- Human may assign a bounded outcome directly to Lead. Supervisor is optional for
  governance, steering and continuity; it is not Lead's technical superior. Lead
  routes work and issues the binding verdict within assignment authority.
- Lead chooses the minimum sufficient topology. Peer is one profile; Lead assigns
  a runtime mandate for outcome, scope, authority and proof. Mandate labels imply
  no persistent local role templates, topology or workflow. Lead does not
  pre-solve implementation; Peer keeps independent judgment and may return a
  provisional plan.
- Direct bounded work may go to one Engineer. Add an Architect when material
  uncertainty remains about a system boundary, ownership, lifecycle, migration,
  cross-module dependency or hard-to-reverse contract. Architecture is a conditional
  route, not a required Feature phase.
- Independent review follows material decision-changing risk, uncertain proof,
  a hard-to-reverse decision or an explicit Human/assignment/protocol obligation.
  Lead selects the minimum sufficient independent mandates; one seat may cover
  related questions, and added seats address distinct unresolved risk or separation
  needs. Reviewers are distinct from writer and accepting owner. Spec/Standards
  are optional descriptive lenses, not reserved seats; no count or family quota
  applies. For this repository, triggers include role authority/delegation,
  runtime binding/transport, installation/upgrade/rollback, or package behavior
  whose proof is uncertain. No material question/trigger → explicit reasoned
  not-required selection + candidate + adequate proof + Lead verdict. Tiny labels
  waive no required review. Lead adjudicates each material finding with reasons,
  evidence/counterevidence and residual risk within authority.
- An uncertain premise or contract goes to investigation or
  `REOPEN_REQUEST`; a missing owner or prerequisite to `DEPENDENCY_REQUEST`; missing
  authority or capability to `BLOCKED`. Resume dependent writes after Lead resolves
  the request.
- Proof and regression scope follow acceptance and material blast radius, not
  changed files alone. Executable tests verify settled behavior; they must not
  decide unresolved contracts. Settle material API/object/persistence/ownership/
  lifecycle/dependency questions before encoding them in executable tests. Test
  pass is evidence for Lead, not a verdict. Reuse valid candidate-bound evidence;
  full-chain checks need a proof question or repository gate.
- Corrections target the accepted finding and affected surface. Re-review the full
  candidate when a new material risk appears, evidence is invalidated or the
  contract/acceptance changes. Repeated same-class findings call for root-mechanism
  analysis, not an unbounded point-fix loop.
- Correction, re-review and challenge use a task-selected stop condition and
  authorized effort/resource bound, recorded before continued work. Lead rules as
  soon as proof is sufficient.
  Stop dependent work when a premise/prerequisite remains unresolved or the bound
  is exhausted; report findings, proof and options to the authority owner for a
  strategy, dependency or resource decision. Exhaustion is not ACCEPT. Changing
  candidate, seat or session does not create more authority or erase obligations.
  Council and root-mechanism work stay within the same authorized bound; repeated
  mechanisms reopen the premise/strategy instead of an unbounded point-fix loop.
- Parallelize independent, merge-safe scopes when dependencies and capacity allow.
  One moving write scope has one writer and integration has one owner. Sequence or
  worktree choice is a Lead tactic, not an SLP requirement.
- Handoff before context loss affects judgment: transfer assignment/authority,
  decisions, candidate/proof, findings, dependencies, next action and resources.
  The receiving session confirms ownership before the old session is archived.
  Keep an idle session only for assigned rework with an expiry. Monitoring needs
  an assignment, owner and stop condition.

## Gate

Independent review is selected from the material questions and explicit obligations
above. Record the mandates, authority/rule source, reason and operative
brief/scope/plan revision before the candidate round. New declarations choose an
explicit review plan; `reviewPlan: null` is a deliberate legacy Spec/Standards
compatibility opt-in, not a new-work fallback. Omitted redeclaration plans retain
the prior decision. A reasoned `not-required` selection is not an `exempt` waiver
of required review; waiver needs explicit authority and exemption class. Source
references remain claims, not grant authentication. Required Human/protocol gates
are never weakened for unavailable seats or adverse findings; missing required
proof/constraints cannot be accepted as recorded risk. Neutral briefs include
objective, acceptance, actual constraints, candidate, mandate, sources and unknowns.
Findings stay visible; Lead rules with reason, counterevidence and residual risk,
without unanimity or reproduction-only acceptance. Brief/mandate changes invalidate
standing reviews, never rewrite historical candidate/round receipts.

Mutation evidence has an additional binding rule from `AGENTS.md`:

- **R1:** every mutation log, including the acceptance owner's replay, contains
  verbatim `sha256sum <test file>` output captured immediately before mutation,
  plus product-file hashes before/after and candidate identity. A declared meta
  hash alone is insufficient.
- **R2:** the replayed, pinned log is the evidence of record; the Engineer's log
  supports it. A mismatch among log, meta and handback candidate voids the claim.

Mutation evidence must show a real assertion on the driven input and fixture,
that removing the guarded behavior makes the test fail, and that spies/hooks are
installed before the scenario without a filter that hides relevant behavior.
Include the temporary mutation, red log and confirmed revert when demonstrating
mutation sensitivity. These duties apply when mutation evidence is used; they do
not turn mutation testing into a check for every task.

Mutation evidence does not itself establish acceptance. Lead decides whether the
candidate and proof satisfy the assignment and records ACCEPT, CHANGES_REQUESTED
or BLOCKED with remaining risks/resources. Delivery follows the grant; repository
release actions remain Human authority.

## Repository configuration

| Scope | Decision |
|---|---|
| Lead topology | One Lead; split only for authority or capacity under a Human formation mandate |
| Release | Release actions reserved in `AGENTS.md`; Human authority |
| Work state | Lead timeline; durable notes under `.local-checks/` |
| Delivery/completion | Artifact and evidence for Human acceptance unless the assignment specifies otherwise |

## Repository references

| Topic | Path | Read when |
|---|---|---|
| Skill layout | `.paseo-slp/references/skill-layout.md` | Adding, moving or assigning a skill |
| Upstream baseline | `.paseo-slp/references/upstream-baseline.md` | Running `paseo-slp-upstream-sync` |
