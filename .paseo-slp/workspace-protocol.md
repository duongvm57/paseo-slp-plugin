---
version: '6'
owner: 'duongvm (Human)'
applies_to: 'paseo-slp source repository'
last_reviewed: '2026-09-27'
package_version: '0.4.0'
template_sha256: '784f2d970841e95b984a9d37b717c2a4ec6241a09fbc4a117a3b85885ab71f43'
template_source: 'source checkout; unreleased working candidate'
routing_intent: 'pinned'
supervisor_notebook: '.paseo-slp/notebook.md (owner: Supervisor)'
decided_by: 'duongvm (Human)'
decided_at: '2026-09-22'
---

# Workspace Protocol

Orchestration tactics for this repository. Installed role policy holds the
invariants; the assignment holds scope and authority.

## Choose a recipe

Lead records recipe, reason and reclassification trigger in one sentence per
task. Recipes chain and nest within one mandate; a new recipe grants no new
scope. Add a seat only for a distinct artifact or question.

| Outcome | Recipe |
|---|---|
| Clear, reversible change with clear checks; no authority, delegation, lifecycle or integrity change | Lean |
| Open acceptance or contract, or coordinated parts | Feature |
| Hard-to-reverse state/data change, rollout or recovery | Transition, for that phase |
| An answer, a cause or a choice among options | Investigation |

Uncertain premise → bounded investigation first. New interface, state,
ownership, routing/delegation semantics, lifecycle, migration or security →
Architect before implementation. Council: two lenses, one challenge/response
round per proposition, Lead decides; add a lens only for an unresolved
decision-changing question.

## Lean

The tiny procedure: one Peer Engineer; brief and formation stay inline.

1. Lead briefs outcome/acceptance, owned/excluded scope, authority, base,
   checks, recipient and formation (operation, parent, workspace/cwd).
2. Delegate through agent-scoped create_agent with verified placement and
   notifyOnFinish.
3. Engineer loops edit → check → fix within grant to a stable candidate,
   returns diff, candidate identity, checks with outputs and exit codes, risks
   and resources, then pauses writes.
4. Lead inspects, then runs Gate.

A second implementation owner, a design seat or a transition phase leaves
Lean; reviewer seats keep it.

## Other recipes

- **Feature:** Lead sets acceptance and exclusions; Architect settles new
  contracts with alternatives, failure semantics and reversal conditions.
  Slices get owner, base and predecessor and run the Lean loop; one
  integration writer holds merge authority. Gate the integrated candidate;
  slice approvals do not transfer.
- **Transition:** Lead/Architect set reconciliation invariants; Migrator
  prepares runbook, rehearsal and recovery. Gate the frozen preparation.
  Execution needs its own phase grant (Human for production) and a matching
  environment, window, backup and candidate; halt on a failed invariant. The
  outcome verdict comes from reconciled post-state.
- **Investigation:** Lead frames question, sufficiency and experiment scope;
  one report owner returns evidence, rejected hypotheses and limits.
  "Insufficient evidence" is a valid conclusion; a found cause becomes a new
  assignment.

## Gate

Every recipe's code, behavior, doctrine or decision artifact passes
independent Spec + Standards seats; no single-seat classes.

1. Pause writers. Lead reruns the relevant checks and pins the candidate
   before and after review; both seats review that candidate.
2. Findings return to the artifact owner; re-review keeps the same seats. A
   changed candidate is gated again.
3. Lead records ACCEPT / CHANGES_REQUESTED / BLOCKED with candidate, proof,
   both axis results and remaining risks/resources.
4. The delivery-grant holder delivers with a receipt.

Seat taskLabels: `Peer — Reviewer — <task> / Spec` and `Peer — Reviewer —
<task> / Standard`; running seats keep their titles. Accepted seats stay idle
for rework until the team's assignment settles.

## Team formation

Seats share the assignment's workspace; concurrent writers get separate
worktrees and non-overlapping scopes, and overlaps serialize. A dependent task
starts once its prerequisite is accepted on its base. Reviewer seats count
toward capacity. Record the team → parent → workspace → worktree map and
creation receipts in the owner's timeline.

## Routing and skills

Catalog hints: Scout → lightweight-recon; Architect and Spec → deep-reasoning;
runtime/UI Engineer and Standards → standard-coding; Proof Auditor →
independent-second-opinion; an unbound hint takes an eligible alternative.
Host Verifier needs explicit install/live-check authority. Doctrine tasks name
writing-for-agents; test-authoring names a test-design skill when available.

## Verification

Checks are the `package.json` scripts. Routing/delegation, plugin
mirrors/contracts, shipped doctrine, this protocol, packaging/payload and
release work gate on full test output; a qualifying tiny edit still stays
Lean. Dry-run doctrine changes on the scenarios they affect.

Run tests with a fresh temporary PASEO_HOME and isolated SLP_* variables, then
remove it; ambient host state fakes failures. prepare/prepare-handoff run the
installed CLI; the checkout's `bin/slp.mjs` is the candidate under test.

## Repository configuration

| Field | Value |
|---|---|
| Additional must_ask | Release actions reserved in AGENTS.md |
| Lead topology | One Lead; split only for authority or capacity under a Human formation mandate |
| quotaFallback | Off |
| Work state | Lead timeline; durable notes under `.local-checks/` |
| Delivery and completion point | Artifact and evidence for Human acceptance unless the assignment states otherwise |

## References

| Topic | Path | Read when |
|---|---|---|
| Skill layout | `.paseo-slp/references/skill-layout.md` | Adding, moving or assigning a skill |
| Upstream baseline | `.paseo-slp/references/upstream-baseline.md` | Running paseo-slp-upstream-sync |

## Overrides

None; sections condense the template without changing its meaning.
