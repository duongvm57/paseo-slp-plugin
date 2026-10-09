# Native task execution

The repository desk can retain and execute a decomposed assignment without an
external task tracker. The owning Lead declares bounded outcomes, dependencies,
write scopes, proof requirements and operation grants. It chooses when to
dispatch or integrate. There is no background scheduler.

Use this workflow when several outcomes must survive interruption or depend on
one another. A small assignment can still use a single bounded handback without
creating a task queue.

## Work and evidence

| Record | Responsibility |
|---|---|
| Assignment and brief | Overall objective, acceptance, authority, current constraints and ownership. |
| Task | One outcome, its prerequisite outputs, scope template, proof policy and operation grants. |
| Attempt | One reservation, runtime selection, placement, exact worker membership and scope binding. |
| Result | Candidate or artifacts, handback provenance, check/review references and consumed prerequisites. |
| Adjudication | The owner's explicit judgment on an exact result and its proof/dependency revisions. |
| Hold and control | Open questions, findings and stop requests that prevent dependent execution. |
| Action | Intent before a host or filesystem effect, then an observation, failure or uncertainty. |
| Delivery and resource | Responsibility acknowledgments and outstanding lifecycle/cleanup obligations. |

These records are immutable revisions in one ledger. Scope still owns moving
write authority and independent review; task state does not copy the scope or
rollout state machines. A green check, scope approval, captured handback or idle
worker is not an accepted task result. Dependency use requires a current owner
adjudication and applicable proof, plus measured availability in the consumer's
actual checkout or intended Git base.

## Execute a bounded task

1. Register the assignment and operative brief using the existing desk tools.
   Define tasks with their outcome, dependencies, scope and proof policy.
   Unknown dependencies, cycles, conflicting reservations and stale pins are
   rejected. Changes retain task identity and previous evidence.
2. Read the **Tasks** section or a task recap. The shared resolver reports
   readiness and its reasons. This is a ledger judgment; dispatch also obtains
   fresh host, artifact and placement evidence before admission.
3. Select a fresh eligible Peer-pool option and its catalog hash. Native
   dispatch uses the bound runtime's routing rules, including required Jev
   receipts. It does not accept raw provider overrides as a missing-pool fallback.
4. Invoke one supervised bootstrap or reuse phase. A reservation and action
   intent precede placement and creation. Bootstrap creates a worker without a
   work prompt. The registered membership, applied runtime, parent, workspace
   and checkout must match before the worker can bind a moving scope.
5. Send the bounded work only after that binding. Delivery acceptance,
   responsibility acknowledgment and handling remain separate. A lost response
   leaves a recorded uncertainty; replaying the request never blindly sends
   again or creates a replacement worker.
6. Record the output, obtain the selected review and required checks, and have
   the owner adjudicate the pinned result. Reopening a prerequisite invalidates
   dependent eligibility while preserving the earlier consumed pins and
   outstanding attempts for reconciliation.

If registration arrives after bootstrap, an unbound send returns
`seat-pending` without changing the ledger or sending work. Reconcile the
known attempt once its exact registration can be positively verified. That
step attaches the worker and claims its scope atomically. Read the new revisions
before sending; the original send pins remain stale and are refused.

Managed bootstrap consumes an issued-create ticket through the native
configuration/environment hook. The ledger retains its digest and membership
claim, while post-create checks verify the actual worker and reserved labels.
If the ticket or returned desk handle is lost, the attempt remains retained;
replay does not generate another secret or resubmit creation. A known created
worker can be reconciled only with positive identity and registration evidence.

Shared checkout placement records the actual base, including relevant dirty
work. Isolated placement uses a desk-owned Git worktree. Before reserving an
isolated dependent task, a bounded read-only Git-reference measurement checks
its intended base. The materialized worktree is checked again before worker
creation or delivery. Git tree modes express executable class; they are not
proof of every filesystem permission bit. A materialization mismatch holds the
attempt and keeps the worktree accounted for.

### Repository binding

Task checkout access compares canonical Git common-directory identities, not
whether the checkout path sits below the Lead's directory. Worktrees of the
bound repository can live outside that directory. A nested Git repository and
its worktrees have a different identity and are rejected, even when their
source checkout is inside the Lead's directory.

Dispatch or delivery reports `CAPABILITY_GAP` with **different Git repository**
when those identities differ. It names the `expected` bound repository and
`actual` probed repository, for example `expected repo "hbl" (a1b2c3d4e5f6),
actual repo "fe" (b2c3d4e5f6a1)`. Each fingerprint is the first 12 hexadecimal
characters of SHA-256 over the canonical common-directory path (UTF-8, without
a trailing newline). The display name is the source checkout's last directory
component for a conventional `.git`; bare/nonstandard Git directories use their
metadata name. Names are hints, not authority: only the full canonical identities
decide access, even when names or short fingerprints collide.

Names have controls and line separators removed, known credential-shaped names
redacted before truncation, and a 24-code-point bound; full paths are not echoed.
Both names and fingerprints survive the bridge's bounded diagnostic. Bind the
Lead to the task's Git repository or form its seat in that repository's workspace
under the assignment. Preserve outstanding effects for reconciliation. Moving
the checkout or bypassing task tools does not widen repository authority.

## Integrate a result

Integration has explicit **stage → check → land** phases, followed by
reconciliation or separately admitted discharge. It requires a current qualified
result, an integration grant naming target and paths, and the task's pinned proof
recipes. It does not commit, push or deploy the repository.

The adapter computes the delta from the worker's original measured base to its
result. A three-way comparison against the actual target preserves unrelated
dirty work and reports conflicting changes. The combined candidate is staged
outside the target and checked there before application. Unsupported snapshot
shapes or incomplete measurements fail closed.

Recipes are named bounded argument lists recorded in the task's proof policy;
an integration call selects recipe IDs rather than supplying a new command.
Preparation, when declared, runs only in the owned stage. Missing dependencies,
failed checks or changed stage/source/target bytes block landing. There is no
automatic dependency installation.

Landing records durable intent before applying the verified delta and measures
the final target. A crash or missing observation requires reconciliation of that
exact action, not a repeated apply. Backups and referenced base/result proof maps
remain accounted for. Discharging stage or backup directories requires a separate
grant and does not remove maps still needed to verify dependent results.

Before application, the landing intent pins the original target, expected
combined content, backup manifest and owned resource paths. Reconciliation
compares the complete target with those pins. Only a verified full application
reconstructs a landed result; an unchanged target, partial application or unknown
state stays distinct. Partial or unverified recovery blocks discharge and keeps
the target reserved. Reconciliation does not automatically reapply or restore
bytes. Backup integrity is checked before use, including file and symlink
content, without deriving backup filenames from the original path.

### Discharge owned resources

Cleanup progresses through separate owner-invoked calls. A recorded positive
landing receipt can supply the source proof for verification directly. A missing
receipt or unresolved application first requires reconciliation of that action.
Then invoke discharge with fresh revisions and the cleanup grant:

1. Verify and persist a complete account before removing anything. It binds
   the original proof, current target, source evidence and resource inventories.
   An unused stage can use a stage-only account only when no landing was issued.
2. Remove the stage under its own issued permit. A failure keeps the backup
   untouched and requires reconciliation before any continuation.
3. Remove the backup under a separate permit after the stage is positively
   accounted for. The target reservation ends only when every admitted resource
   is released.

Each call performs one verification or one resource-removal cycle. An unfinished
response requires rereading revisions and another explicitly granted call.
Each account and resource has at most two total cycles, including the initial
one; changing the request or owner does not reset that bound. Exhaustion retains
the unresolved account rather than retrying automatically.

If a cleanup receipt is lost or removal stops partway, reconciliation checks
surviving entries against the verified inventory. Missing entries count as
authorized cleanup progress only under that resource's previously issued
permit. This does not prove who removed them, current backup integrity or a new
landed result. Unexpected absence, changed survivors, source/target drift or
missing provenance blocks further removal. Proof maps and the verified account
remain outside removable stage/backup directories.

During permitted partial worktree cleanup, the adapter can restore an absent
`.git` pointer before asking Git to finish removal. The earlier issued permit
must account for its loss, and the restored bytes and mode must exactly match
the verified original inventory. Creation is exclusive inside the owned stage;
an existing or changed leaf is refused. Restoration uses the same removal cycle.
A crash after restoration retains the account for reconciliation and does not
authorize another automatic removal or a third cycle.

Task output judgment does not accept the resulting project candidate. The Lead
still verifies the integrated outcome and reports its project verdict under the
assignment's acceptance authority.

## Stop, reconcile and continue

`slp_task_stop` records a stop and prevents new effect issuance. It does not
cancel a running host turn. Archive is a separately granted lifecycle operation,
and its acknowledgment alone does not prove writer or process quiescence.

Reconciliation observes known effects and resources by positive identity. The
owner supplies revision-bound release or attempt rulings; evidence pointers are
claims, while the server checks applicable disposition evidence. Unknown state
keeps the obligation retained. A missing agent listing, idle status, revoked
membership or turn end alone cannot release a reservation or permit a second
writer.

A task amendment does not shrink an earlier attempt's reservation. A new
attempt, including rework on the same surfaces, stays blocked while the prior
writer's disposition remains unresolved. The current adapter cannot
independently establish quiescence of arbitrary worker subprocesses.

Settling a canceled attempt can close its claimed scope only through the
task-specific cancellation path, after outstanding effects, deliveries and
resources are resolved and applicable quiescence evidence is available. This
closure records cancellation, not approval. A completed result can retain its
qualified review proof after an ordinary approved scope closure; changes to
its current brief, declaration, candidate, mandate or reviewer independence
still invalidate that proof.

Planned owner handoff uses the existing offer/accept protocol. It preserves task,
attempt, delivery and resource history; it does not reparent workers or change
their report routes. Owner loss without an offer remains an authority gap.
See [assignment continuity](work-continuity.md).

## Tools and inspection

| Tool | Use |
|---|---|
| `slp_task_define` | Define, amend, reopen or withdraw a bounded task declaration. |
| `slp_task_dispatch` | One bootstrap, reuse, send or separately granted archive phase. |
| `slp_task_result` / `slp_task_rule` | Record output and adjudicate its exact revisions. |
| `slp_task_hold` / `slp_task_stop` | Raise or rule on a hold; block further effect issuance. |
| `slp_task_acknowledge` | Record the exact recipient's responsibility or handling acknowledgment. |
| `slp_task_reconcile` | Observe known effects and account for retained resources and attempt rulings. |
| `slp_task_integrate` | Stage, check, land, reconcile or discharge an integration. |
| `slp_task_recap` | Read an authorized, pinned task-history page with full-ledger counts. |

Open **Read SLP work → Tasks** to inspect the queue. Counts describe current task
identities and obligations; page totals count history entries. Rows distinguish
current entity revisions from superseded history and carry the same readiness
and result qualification used by the gates. Assignment-level obligations are
included even when they are not attached to a task.

Recaps preserve the complete shared page, ownership and revision pins, counts
and omission information. A partial page does not pretend to summarize omitted
obligations. Reads are bounded; an oversized complete record is refused rather
than clipped into apparently complete proof. Reload after a ledger change.

## Operational limits

The desk has bounded history and admission capacity, with recovery headroom.
Admission reserves the remaining requests, records, membership slots, scope
transitions and serialized bytes across the supported continuation. Ordinary
ledger writes cannot spend those reserved credits. It does not prune referenced
proof or promise an unlimited queue. Unattended
dispatch/retry/landing, generic process cancellation, cold owner takeover and
general garbage collection are outside this workflow.

The plugin SDK supplies no authenticated Human caller or turn-cancel method at
this boundary. A pointer cannot manufacture either capability. Local store,
SDK fixture, Git and socket checks establish source behavior; they do not prove
live host delivery or constitute project acceptance.
