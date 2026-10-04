# Task execution queue

Read when an assignment runs through the desk's native task queue: a large
objective the Lead decomposes into dependency-ordered tasks whose attempts,
results, rulings and resource obligations must stay durable across turns,
context loss and ownership succession. Small tasks keep the ordinary Lean
procedure — do not register queue entries for work a single bounded handback
settles. The queue is the desk's own ledger: it needs no external tracker,
and external intake connectors remain the repository harness's bookkeeping,
not task execution.

## What the queue is

The desk ledger carries one append-only task entry stream per assignment.
Every committed entry is stamped with its entry, entity and task identity,
the request and actor membership that committed it, and the ledger, brief and
ownership revisions in force at commit. Current task state derives from the
contiguous stream; there is no mutable current pointer to disagree with it.

- **Declaration** — the task's outcome, scope, declared dependency pins and
  proof policy. The effective owner registers and amends declarations; an
  amendment or withdrawal is a new entry, never a rewrite.
- **Attempt** — a reserved execution attempt: seat pins, placement, measured
  source base and reservation keys. No host effect precedes its reservation.
  Its task revision, owner tuple, placement, bound scope and reserved paths,
  resources and state owners remain pinned to that attempt. A task amendment
  changes future admission; it does not narrow or rewrite an existing
  reservation. Retain a stale attempt for explicit reconciliation against
  its original reservation instead of substituting the amended scope or
  silently transferring its obligations.
- **Result** — the reported output with its provenance (supplied claim or
  measured), captures and evidence refs.
- **Adjudication** — the current owner's explicit ruling over a result.
  Whether a ruling is current depends on the task, result, proof-policy and
  dependency pins it was issued under — the newest ruling is not
  automatically the operative one, and superseded rulings remain readable.
- **Hold** — a declared block with a typed reason (question, decision,
  finding or manual). An open hold stays open across brief and ownership
  changes; it is released only by a current-owner ruling naming release,
  retain or withdraw — never by drift.
- **Action** — an issued host action (place, create, send, archive or an
  integration step) recorded intended, issued, observed, uncertain, failed,
  held or abandoned. An uncertain effect blocks same-class retry until a
  bounded reconciliation resolves it by positive identity; absence of a
  listing or an unrelated turn event never proves an effect did not happen.
  Integration actions additionally carry the source-to-result delta, target
  pins, stage and check evidence and the final observed target; their
  receipt establishes availability at the pinned target, not project
  acceptance.
- **Delivery obligation** — a recorded delivery flag: pending,
  host-accepted, responsibility-acknowledged or handled. None is settlement,
  and none is project acceptance.
- **Resource** — a retained obligation (agent, workspace, worktree, process,
  target, scratch, artifact or membership) with its required disposition
  evidence. Archive, membership revocation, idle or turn end alone never
  releases one; release needs an explicit current-owner reconciliation
  naming the actual disposition.
- **Control** — a stop request or resume ruling with its outstanding action
  and resource ids. Stop blocks new effects; already-issued effects stay
  obligations to reconcile.

## Queue state and readiness

Read the queue through the tasks section of the desk work view; seats reach
it through the participant workflow read and the Human panel shows the same
section read-only. The projection includes full-ledger counts of current task
identities; those counts are distinct from the page's count of history rows.
A supported empty queue has zero counts, while an absent or unreadable desk
does not claim an empty queue.

Each task history row marks whether it is the latest row for that entity. The
task's full readiness, current result qualification and nullable current
ruling come from the same resolvers used by the command gates; the row marker
does not decide whether a ruling still qualifies. Historical rows remain
visible when a task's brief or owner changes. Such drift does not release an
open hold, resource, effect or delivery obligation.

The shared result qualification may report `terminal-approved-round` only for
the exact result-pinned ordinary review round that moved from approved to
closed, while task/result/brief/declaration/mandate/candidate and independent
reviewer pins still qualify. It never searches for any historical approval;
task cancellation, rejection or stale pins do not qualify.

A task recap is the participant-authorized, revision-and-page-pinned shared
tasks projection with its full-ledger counts. It keeps the exact rows, typed
readiness/qualification/ruling, owner pins and omission counts from that
projection. Its unresolved ID lists include only current entity rows; older
superseded obligations remain in the displayed history. Omitted rows make the
context partial. The recap performs no host or filesystem read and establishes
neither effect quiescence, resource settlement, recipient acknowledgment nor
project acceptance. Its request pins assignment/request identity and the
expected ledger and brief revisions, with the ownership revision when
supplied and a tasks-section cursor/limit; it has no task-id filter or offset
shortcut.

Readiness comes from one resolver shared by the view and the command gates.
Buckets: backlog, ready, held, running, integrating, settled, superseded —
plus typed reason codes and the brief, task and dependency revision pins the
answer was computed under. A migrated desk with no task entries is a
supported empty queue; an unreadable or absent desk reports unavailable —
an empty listing never stands in for an unread desk.

A task is eligible only when its declared dependencies hold current explicit
rulings on the pinned revisions, its artifact and target availability are
measured, and no hold, stop, stale membership, changed brief or changed
owner blocks it. Dependents consume the exact result and ruling revisions
they were admitted under; reopening a dependency invalidates not-started
descendants and holds running attempts under their original pins.

## Commands and authority

Queue commands ride the desk tool surface under operation-specific actor,
capability and revision checks. Define, rule, dispatch, stop, reconcile and
integrate are owner-only; result, hold and acknowledgment belong to the
exact attached participant; the recap reader is any current participant.
CAS fields are operation-specific: define requires ledger, brief, ownership
and task revisions; result and rule require the task revision while their
ledger/brief/ownership pins are optional; hold, acknowledgment and reconcile
compatibility shapes also allow optional CAS pins. Stop and reconcile permit
a null task reference, and reconcile may omit it. The server checks supplied
pins and still enforces each operation's exact live actor, owner, bound-member
or recipient authority and target identity. Public dispatch phases require
their strict ledger/brief/ownership/task/attempt pins; integration phases
require their strict ledger/result/adjudication pins and continuation action
pins. Every command replays by request id — a retry of the identical request
returns its recorded receipt. A replayed receipt is proof of the original
commit, never permission to issue new host effects; reissuing requires a fresh
admission under current pins.

Dispatch reserves one non-settled attempt per task before any host effect.
Bootstrap creates a provisional seat without a work prompt; the attempt
becomes writable only after the registered membership tuple and a valid
moving write scope bind under the ledger lock. Send correlates only positive
message identity — a bare turn-start proves nothing.

For a newly created seat whose registration is delayed, send on the unbound
attempt returns `state: "seat-pending", sent: false` with recovery through
`slp_task_reconcile` for that attempt and its action observation. That send
invocation makes no bind, ledger write or host send; registration alone does
not authorize or trigger work. The current owner must explicitly reconcile a
positive observed create and the exact live registered membership.
Reconciliation atomically attaches and binds that membership and, when
declared, declares and claims the attempt's exact scope. Then reload the public
view and send with fresh ledger, brief, ownership, task and attempt CAS pins;
the bound scope is checked against those current pins.

## Deferred and unsupported capabilities

State these honestly; do not work around them silently:

- **Automatic cancellation is not available.** The plugin API exposes no
  turn-cancel operation. A persisted stop blocks new effects immediately and
  the obligations stay recorded, but stopping a live in-flight turn goes
  through the authorized host lifecycle route and is correlated by its real
  receipt — the plugin neither claims nor fabricates that path.
- **Stopped-attempt scope cleanup is internal and proof-gated.** After the
  current owner records a same-request stopped attempt and stop-observed
  control under the current brief, with no outstanding effects, deliveries or
  resources and either positive quiescence observations or supported proof
  the attempt never authorized work, the internal `task-cancel` path may close
  only that attempt's exact old bound scope. This is cleanup, not review
  approval. The ordinary public `scope.close` route remains current-gated.
- **Quiescence is unproven until reconciled.** An archive acknowledgment,
  turn end, idle or membership revocation never proves a writer, process,
  worktree or scratch obligation is gone. Without a quiescence seam the
  resource stays retained with its gap visible; no replacement writer is
  started on absence.
- **Cold recovery has no shortcut.** Owner succession uses the ordinary
  offer/accept path and carries every reservation, action, resource and
  dependency pin to the new owner. A loss with no offer in flight remains an
  authority gap; late effects by a former owner are not reattributed.
- **No authenticated Human caller exists at this seam.** Human stops and
  rulings arrive through the existing authorized routes — the Human
  lifecycle UI and the owning Lead's commands — never through an invented
  principal or a pointer treated as a grant.
- **Unproven actor attribution stays pending.** Where the SDK cannot prove
  which actor produced a host observation or hook event, the attempt stays
  recorded and pending explicit owner reconciliation — no invented caller
  identity.

## Boundaries

- Task adjudication, captures, gate approvals, checks and settlement are
  distinct evidence categories; the view and the recap keep them separate.
  None alone is project acceptance, which stays with the Lead's acceptance
  authority and this package's review gates.
- Independent review selection is unchanged — material questions or required
  obligations pick minimum sufficient mandates; no reviewer count or queue
  ceremony is added.
- The queue does not create a second lifecycle: seat parentage, report
  routes, membership binding and scope rules are the existing desk
  mechanisms observed by the same procedures.
