# Repository configuration

Use one common protocol. Fill settings from repository evidence and the Human
assignment; these are not repo types or alternate workflow templates.

| Setting | Resolve from evidence or ask |
|---|---|
| Execution | Repo/base, remote, scopes, environments, writer/reviewer capacity and authority boundaries |
| Delivery | Evidence, PR or execution report; destination, publication authority and completion point |
| Work state | Existing assigned location; the installed plugin's desk task queue when an assignment needs durable task decomposition — record it as the checkpoint pointer, no external tracker required |
| Shared state | For applicable phases: executor, rehearsal, recovery and reconciliation |
| Topology | One Lead selects recipes; split only for authority/capacity needs with a Human mandate |
| Review selection | Material decision-changing questions and required Human/protocol obligations; explicit mandates or reasoned not-required selection; any waiver needs authority |
| Effort and stop | Task-selected correction/review/challenge stop conditions and authorized resource bounds; unresolved prerequisites or exhaustion pause dependent work, never imply acceptance |

External connectors/MCP, credentials, pull cadence and queue bookkeeping belong
to the repo harness. For example, the repo can supply Backlog MCP and ask its
Supervisor to pull tasks and delegate them to Lead. SLP onboarding does not
configure or validate that integration. Lead receives the task, assesses
outcome/risk and dependencies, and chooses or combines recipes.

A new pricing feature with a database backfill uses Feature plus Transition
under the same Lead when within mandate. Opening a PR does not grant production
execution. Independent Lean tasks can run concurrently with one Engineer each
and required review seats, subject to ownership and capacity.

## Protocol and references

The protocol states orchestration tactics; `.paseo-slp/references/` holds the
facts they use.
A repository with backend and frontend checks might carry:

| File | Holds | Protocol keeps |
|---|---|---|
| `references/check-commands.md` | Per-component commands with working directory and the behavior each proves; CI gates and disabled switches; path hazards such as spaces or mixed Unicode normalization | Established checks are named per assignment; which checks gate acceptance; pointer line |
| `references/skill-layout.md` | Where project skills live and how each provider sees them, e.g. `.claude/skills/<name>` symlinks into `.agents/skills/` | Single skill source; assignments name the `SKILL.md` path; pointer line |

Each file names the protocol section it serves and the date its facts were
verified. A statement that says what agents must or may do is a rule and stays
in the protocol. Materialize carries `.paseo-slp/references/` into worktrees
with the protocol.

## Engineering examples

The examples below illustrate engineering decisions, not mandatory setup steps.

| Example | Owner, next step, evidence and stop |
|---|---|
| Clear date-filter fix | Lead briefs one Engineer; inner loop → frozen candidate + proof → reasoned review selection → Lead verdict. No material question/trigger permits not-required; a selected independent mandate may cover related risks. Findings return to the same owner/seats within task-selected bounds. |
| Expense approval feature | Lead resolves acceptance; Architect resolves state/permissions; Engineers build slices; authorized integration writer combines; gate integrated behavior. Backfill uses Transition with its own execution grant. |
| Scope grows into shared API | Engineer pauses affected writes with REOPEN_REQUEST; Lead reclassifies before widening work. Beyond mandate → Supervisor/Human. |
| B depends on A; C independent | Lead waits B until accepted A is on B's base; C may run separately within writer/reviewer capacity. |
| Data backfill | Migrator rehearses idempotent runbook/recovery; gate preparation; phase grant before execution; reconcile business invariants before outcome verdict. Failed invariant halts. |
| Unknown incident cause | Contain only within grant, investigate, then separately authorize repair; fix gate and execution checkpoint precede reconciled recovery. |
| Ownership handoff | Follow authorized handoff with candidate, open findings, decisions, dependencies and resource receipts; settle old writers before successor writes. |
