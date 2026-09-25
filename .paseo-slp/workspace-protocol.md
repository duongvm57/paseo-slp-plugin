---
version: '5'
owner: 'duongvm (Human)'
applies_to: 'paseo-slp source repository'
last_reviewed: '2026-09-25'
package_version: '0.4.0'
template_sha256: '65d2ad7f32ebd28321fe9035a1d6ab37c71dc4f8b167093ac8d738392e7bab20'
template_source: 'source checkout; unreleased working candidate'
routing_intent: 'pinned'
supervisor_notebook: '.paseo-slp/notebook.md (owner: Supervisor)'
decided_by: 'duongvm (Human)'
decided_at: '2026-09-22'
---

# Workspace Protocol

Supervisor/Lead read on assignment arrival, before dependent replies or actions.
Pass only task-relevant constraints to Peers. Assignment and AGENTS.md govern
scope/authority; missing decisions pause only dependent work. Installed policy
remains authoritative. References below mean `src/references/` in the verified
runtime; reuse unchanged policy already in context under its freshness rules.

## Decide

Lead records recipe, reason and reclassification trigger in one sentence.
Recipes combine within the same outcome/mandate; changing recipe grants no new
scope. Add seats only for distinct artifacts/questions. Every recipe uses Gate.

| Outcome | Procedure |
|---|---|
| Clear, reversible change; clear checks; no authority/delegation/lifecycle/integrity change | Lean below |
| Open acceptance/contract or coordinated parts | Feature below |
| State/data change, rollout or recovery hard to reverse | Transition for that phase |
| Answer, cause or option decision | Investigation below |

Uncertain premise → bounded investigation; new interface/state/ownership,
routing/delegation semantics, lifecycle, migration or security → Architect before
implementation. Owner-reserved contracts, product/priority, subjective acceptance
and irreversible/material-cost trade-offs beyond grant → Human (`must_ask`).
Council: two lenses, one challenge/response round per proposition, Lead decides;
add a lens only for an unresolved decision-changing question. Follow orchestration.md.

## Lean

One Peer Engineer; inline brief/formation/report, no separate ceremony files.

1. Lead briefs outcome/acceptance, owned/excluded scope, authority, base, checks,
   recipient and formation (operation, parent, workspace/cwd, ownership).
2. Delegate through agent-scoped create_agent with verified placement and
   notifyOnFinish; follow delegation-formation.md and provider-routing.md.
3. Engineer edits → checks → reads failure → fixes → rechecks within grant/budget.
   Failed premise/dependency → REOPEN_REQUEST/DEPENDENCY_REQUEST; missing authority
   or capability → BLOCKED; Human stop stops work. Return stable candidate,
   diff/artifact, actual checks/outputs/exit codes, risks/resources; pause writes.
4. Lead inspects and runs Gate. A second implementation owner, design seat or
   transition phase requires reclassification; reviewers do not disqualify Lean.

## Other recipes

- **Feature:** Lead establishes acceptance/exclusions; Architect resolves new
  contracts with alternatives, failure semantics and reversal conditions. Lead
  assigns slices with owner/base/dependencies and one integration writer.
  Engineers use the inner loop above. Integrate only under merge/cherry-pick
  authority; Gate the integrated candidate against end-to-end acceptance.
  Slice approval does not transfer; integration findings belong to its writer.
- **Transition:** Lead/Architect defines impact, owner and reconciliation
  invariants. Migrator prepares runbook, rehearsal and rollback/forward recovery.
  Gate the frozen preparation. Before execution, verify environment, window,
  backup and candidate; require a separate phase grant (Human for production
  unless granted). Execute with receipts; halt on failed invariant. Lead gives
  an outcome verdict from reconciled post-state, including stop/restore results.
  Preparation ACCEPT and exit 0 alone do not accept the outcome.
- **Investigation:** Lead defines question, sufficiency and experiment scope.
  One report owner gathers evidence, rejected hypotheses and limits; when asked,
  recommends alternatives/trade-offs/reversal conditions. Gate the report.
  Insufficient evidence is a valid conclusion. A discovered cause grants no fix;
  implementation needs its own assignment, experiments their own write scope.

## Gate and delivery

Independent Spec + Standards seats are mandatory for each recipe's code,
behavior, doctrine or decision artifact. No single-seat exceptions. Follow
review-gates.md for neutral briefs, corrections and repeated-finding escalation.

1. Pause writers. Lead reruns relevant checks and pins the candidate before/after
   review. Both axes review that same candidate, independently of the writer.
2. Findings return to the artifact owner; corrections and re-review keep the
   same seats per orchestration.md session continuity. Changed candidate → gate again.
3. Lead records ACVERDICT: ACCEPT / CHANGES_REQUESTED / BLOCKED, candidate,
   proof, separate axis results and remaining risks/resources.
4. Authorized actor delivers with receipt. Default: artifact/evidence for Human
   acceptance; assignment defines completion. PR-open, merged and execution
   complete differ. Acceptance alone does not close the team's assignment.

Reviewer taskLabel: `Peer — Reviewer — <task> / Spec` or `/ Std`; retain existing
seat titles. Keep accepted seats idle for rework until assignment settlement;
Human stop is immediate. Follow monitoring.md for cleanup.

## Ownership and external input

Supervisor delegates to its verified child/team Lead or uses authorized handoff.
Lead owns technical triage/dependencies: independent writers use separate
worktrees/non-overlapping scopes; serialize overlaps. A dependent task waits
for accepted prerequisites on its base. Count reviewers in concurrency budget.
Record formation, parent/workspace/worktree, scope and receipts in the owner's
timeline; durable notes use authorized `.local-checks/` paths.

Separate Leads need an authority/capacity reason and formation mandate. Shared
contracts need one owner/integrator. Out-of-mandate work returns with evidence;
settle old writers before transfer under governance.md/provider-routing.md.
Repo harness owns external MCP/connectors, credentials, polling and queue state.
Supervisor pulls only when assigned, then delegates. Beads is optional; when
enabled follow work-tracking.md. Neither source nor tracker status grants work.

## Runtime and pool

Use verified managed helpers/runtime root; otherwise resolve via local-target.
prepare/prepare-handoff use the installed CLI, not the source checkout.
Before delegation/fallback, read provider-routing.md: saved Supervisor/Lead
profiles, pinned `.paseo-slp/slp-routing.json` for Peers, live capability checks
and Jev off/shadow/armed behavior. Missing/ineligible pool blocks delegation;
use onboarding. Only Human changes eligibility/models; Lead selects ready
options. quotaFallback remains off unless Human enables it. Runtime handoff
needs separate authority. Pool membership is not replacement authority.

Catalog hints, never forced bindings: Scout → lightweight-recon; Architect and
Spec → deep-reasoning; runtime/UI Engineer and Standards → standard-coding;
Proof Auditor → independent-second-opinion. Use eligible alternatives if unbound.
Host Verifier requires explicit install/live-check authority. Lead uses macro
skills, Peer micro skills; doctrine tasks use writing-for-agents, test-authoring
uses a test-design skill when available.
Skill homes, payload shipping and provider symlinks: `.paseo-slp/references/skill-layout.md`.

## Verification and monitoring

Read package.json for current checks. High-impact routing/delegation, plugin
mirrors/contracts, shipped doctrine, this protocol, packaging/payload or release
work requires full test output + candidate identity + ACVERDICT. Judge actual
risk, not path alone; a qualifying tiny edit may stay Lean. Dry-run doctrine on
relevant scenarios. UI-only presentation follows ordinary risk judgment.

Run tests with a fresh temporary PASEO_HOME and isolated managed SLP_* variables;
ambient host routing/runtime state can fake failures. Clean up the temporary home.
Match checks to behavior/risk; local checks are not E2E acceptance. E2E requests
follow AGENTS.md and e2e/workspace-protocol.md. Report actual evidence and gaps.

Use finish/error/permission events first; short bounded work needs no heartbeat.
For long work or missing events, read monitoring.md before a fallback heartbeat:
record observer, report route, cadence/timezone, expiry/run bound, live checkpoint
and stop condition. Preserve pre-existing monitoring. Report material decisions,
reopen/dependency and risk changes to Supervisor. Repeated identical failures
require mechanism/prerequisite diagnosis before retrying.

Keep only effective decisions here. Rationale, history and observed-pattern
analysis belong in Git or authorized audit artifacts; update version/review date
when decisions change. Preserve existing Human choices during onboarding.
