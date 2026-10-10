# Operate the desk

Use when the installed session exposes these tools and the assignment needs
durable coordination or supervised task effects. Read slp_status first for
membership, desk availability and assignments; use advertised input schemas.
Tool presence alone proves no ready binding. Missing/unreadable capability
blocks only the dependent path; small Lean work needs no queue enrollment.

## Shared state and scope

Lead registers/attaches the authorized assignment with
slp_assignment_register/attach, writes its operative brief with
slp_assignment_amend and material decisions with slp_decision_append.
Read slp_workflow_get for current brief, ownership, decisions, reviews,
evidence and tasks. Use returned revisions/cursors; omissions mean partial
context. Do not maintain a competing ledger in notes. Explain judgments and
notify affected owners: the store preserves claims, not their semantic truth
or actual delivery. Human retains authority over the content of the grant.

Declare actual writer, paths/resources/state owners and review decision with
slp_scope_declare. For a stable observed candidate, use
slp_scope_transition to submit-for-review; each independent reviewer records
its selected mandate with slp_scope_review. The owner advances the gate
through legal transitions after adjudication. Runtime enforces declared
membership/overlap, plan, independent actor and candidate/revision pins.
It neither detects undeclared shell writes nor chooses sufficient mandates.
Use review-gates.md for those decisions; never reduce a required gate merely
to admit a transition.

slp_handback_submit validates/stores a claim and separately captures the
bound checkout; inspect observedCandidateId and gaps. Record/check refs
remain claims and may be unreadable. report-records.md owns reporting limits.
Use slp_check_declare/run and rollout tools only for their advertised
allowlisted classes: ledger-integrity, repo-payload-check, repo-git-head.
They measure candidate freshness and preserve actual results; they do not
run arbitrary tests or prove feature behavior. Existing integration proof
recipes are separately owner-pinned bounded commands. Inspect measured
output/class/candidate rather than repeat already valid execution; supplement
it for uncovered outcome questions. Shell-reported checks need independent
verification. Rollout transitions perform no deployment.

## Tasks and effects

Lead chooses outcomes, dependencies, scope/review, proof policy, separate
operation grants, allowed runtime and effort bounds. slp_task_deliver composes
declaration, fresh-worker bootstrap and send for one new bounded outcome.
Supply the semantic task body, runtime pins, text and current assignment CAS;
shared caller checkout/workspace is the default placement. It internally uses
the same Core/dispatch admissions, immutable subrequests and current pins.
Read its result/phases/current view for partial failures; outer ok only means
the operation receipt was read. Exact replay/slp_operation_get never resumes
unfinished effects or declares another task. A pending seat needs explicit
reconciliation followed by separately authorized dispatch send, never a new
deliver call for the same outcome.

slp_task_get targets one task and optional exact attempt, returning current
identity/CAS, readiness and compact effect/resource markers without paging
unrelated assignment history. Workflow pages still own complete historical
proof, decisions and qualification context. Neither view establishes acceptance.
For task amendments, phased work or continuation, keep slp_task_define and
the explicit dispatch phases below. The runtime computes qualified results from
current pins; consume its reasons rather than reconstruct the state machine.
A qualified task is no project verdict. Scope is still the moving writer.
A task ID/dispatch.reuse never determines the Peer outcome boundary or
authenticates grantRef; apply orchestration.md's Session continuity.

| Need | Tool action |
|---|---|
| New worker | slp_task_dispatch bootstrap with selected pool option/hash and placement. It reserves, materializes/verifies, creates without work, observes and binds the exact registered membership/scope. |
| Same-outcome continuation or explicit Human exception | dispatch reuse after the semantic continuity decision; runtime verifies the existing seat but grants no exception. |
| Deliver work | Use returned current pins or slp_task_get, then dispatch send with the neutral brief. seat-pending/sent:false requires slp_task_reconcile of the observed create/registration, then fresh pins; no second create. |
| Output, question, delivery duty | Bound seat uses slp_task_result, slp_task_hold or slp_task_acknowledge. Attach actual evidence, distinguish claims from measurements and return the report to its owner. |
| Ruling | Current owner uses slp_task_rule or hold ruling with evidence/counterevidence and risks. Reopened prerequisites stay visible; history is not rewritten. |
| Integration | slp_task_integrate stage → check → land under the exact integration grant, target and recipe IDs. Runtime preserves unrelated target work and pins staged/final proof. Drift or missing proof blocks landing. |
| Uncertain effect/resource or cleanup | slp_task_reconcile for recorded identities; integration reconcile/discharge for its admitted resources. Read disposition/gaps and supply an authorized explicit release ruling. Cleanup is separately admitted; commit/push/deploy are no automatic effects. |

Supply returned identities and operation-specific revision pins; refresh after
REVISION_CONFLICT or ROUTE_DRIFT before a new authorized operation. Replaying
the identical requestId retrieves its recorded result, never re-executes a
host effect. EXECUTION_UNKNOWN/uncertain means reconcile that original
identity, not retry with another ID. A host timeout can still complete later.
Capacity/retry limits preserve stop/recovery headroom; exhaustion requires
an owner decision, not another worker or policy workaround.

## Stop, succession and capability gaps

slp_task_stop prevents new task effects. It does not cancel a live turn:
use authorized host controls and reconcile outstanding effects/delivery/
resources. Archive, idle, revocation, turn end or absent listings prove no
process quiescence; unsupported proof leaves reservations retained.
Internal stopped-attempt cleanup is proof-gated and grants no approval.

slp_assignment_offer/accept transfers desk custody to an exact nominee
with acknowledgment/resources; it does not reparent sessions, settle old
writers or authenticate the Human grant. Coordinate actual host control under
governance.md. No-offer cold loss is an authority gap; this seam has no
Human RPC principal or invented attribution for missing SDK actors.
Use slp_settlement_record/export for receiving-owner attestations and the
record sink under report-records.md; the mirror proves no cleanup by itself.

These protections cover guarded desk operations and their admitted effects,
not arbitrary filesystem/shell work. Ordinary role creation can remain
unbound if desk mint/registration fails; Lean/direct delegation follows its
own formation/compatibility procedure. Preserve semantic authority, independent judgment,
actual writer pause, subjective acceptance and unsupported-state gaps.
Source tests prove implementation, not installation/reload or live E2E.
