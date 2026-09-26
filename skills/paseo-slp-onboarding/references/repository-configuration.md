# Repository configuration

Use one common protocol. Fill settings from repository evidence and the Human
assignment; these are not repo types or alternate workflow templates.

| Setting | Resolve from evidence or ask |
|---|---|
| Execution | Repo/base, remote, scopes, environments, writer/reviewer capacity and authority boundaries |
| Delivery | Evidence, PR or execution report; destination, publication authority and completion point |
| Work state | Existing assigned location; beads only when enabled |
| Shared state | For applicable phases: executor, rehearsal, recovery and reconciliation |
| Topology | One Lead selects recipes; split only for authority/capacity needs with a Human mandate |

External connectors/MCP, credentials, pull cadence and queue bookkeeping belong
to the repo harness. For example, the repo can supply Backlog MCP and ask its
Supervisor to pull tasks and delegate them to Lead. SLP onboarding does not
configure or validate that integration. Lead receives the task, assesses
outcome/risk and dependencies, and chooses or combines recipes. Enabled beads
can record work state under the existing work-tracking policy; it is optional.

A new pricing feature with a database backfill uses Feature plus Transition
under the same Lead when within mandate. Opening a PR does not grant production
execution. Independent Lean tasks can run concurrently with one Engineer each
and required review seats, subject to ownership and capacity.

## Protocol and references

The protocol states rules; `.paseo-slp/references/` holds the facts they use.
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
| Clear date-filter fix | Lead briefs one Engineer; self-loop → frozen candidate → Spec/Standards → verdict; findings return to same owner/seats. Stop at assigned completion. |
| Expense approval feature | Lead resolves acceptance; Architect resolves state/permissions; Engineers build slices; authorized integration writer combines; gate integrated behavior. Backfill uses Transition with its own execution grant. |
| Scope grows into shared API | Engineer pauses affected writes with REOPEN_REQUEST; Lead reclassifies before widening work. Beyond mandate → Supervisor/Human. |
| B depends on A; C independent | Lead waits B until accepted A is on B's base; C may run separately within writer/reviewer capacity. |
| Data backfill | Migrator rehearses idempotent runbook/recovery; gate preparation; phase grant before execution; reconcile business invariants before outcome verdict. Failed invariant halts. |
| Unknown incident cause | Contain only within grant, investigate, then separately authorize repair; fix gate and execution checkpoint precede reconciled recovery. |
| Ownership handoff | Follow authorized handoff with candidate, open findings, decisions, dependencies and resource receipts; settle old writers before successor writes. |
