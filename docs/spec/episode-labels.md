# Episode labels for retrospective analysis

Status: implementation candidate. Requested by the Human on 2026-10-15;
revised the same day: root seats created directly by the Human do not need
episode labels.
Consumer: an offline, read-only retrospective analyzer of finished SLP
episodes (referred to below as "the analyzer").

## Context

The analyzer looks for coordination steps (ceremony, reviews, messages) that
cost a lot but rarely change outcomes, and proposes cuts that keep reliability
intact. It runs after the episode has finished and only reads what the episode
left behind:

- Paseo agent records, including labels;
- provider transcripts;
- desk events;
- plugin episode metadata under `<stableRoot>/state/episodes/`;
- the git history of the analyzed repository.

It cannot ask the agents anything. Whatever the plugin does not record, the
analyzer has to infer, and those inferences can be wrong.

**Episode.** The tree of SLP seats that carries out **one root assignment from
the Human**, from assignment to handback, including successors via handoff. A
long-lived seat that receives several Human assignments (a Supervisor, or a
Lead the Human talks to directly) contains several episodes.

**Root.** The seat that receives the root assignment from the Human: the
Supervisor when there is one, otherwise the Lead. The Human usually creates it
directly, often from the Paseo UI, so the plugin is not involved in creating it
and it carries **no episode labels**. That is valid and expected.

### What the analyzer has to guess today

1. **Which seats belong to which episode.** The analyzer walks
   `paseo.parent-agent-id` and asks the Human to pick the root. Under a
   long-lived Supervisor or Lead, the children created for different Human
   assignments all share the same parent. The analyzer cannot tell them apart,
   so it falls back to heuristics that split the tree by time and asks the
   Human again. It can merge two episodes into one.
2. **Handoff.** When no handoff label exists, the analyzer guesses the
   successor from timing and title, and marks the result as inferred until the
   Human confirms it. The current plugin does not write a handoff label at all.
   (An older version wrote `slp.handoff-from`, and the analyzer still reads it.)
3. **Episode start and end.** The analyzer uses the first and last turn in the
   tree. A late heartbeat or a turn after handback pushes the end later. The end
   marks the start of the follow-up window used to detect escaped defects, so a
   wrong end misclassifies commits as in-episode or follow-up.
4. **Seat role and disposition.** These are parsed from the agent **title**
   (for example "Peer — Reviewer — …") and are therefore only inferred.
   Disposition is the main signal for review rounds, whose cost and value the
   analyzer measures. A custom or reformatted title breaks the guess.
5. **Runtime and protocol version at execution time.** Deciding whether a step
   was mandatory under the protocol needs the exact SLP runtime and workspace
   protocol in force when the episode ran. Today the analyzer searches
   transcripts for a runtime hash: seats where none is found have no hash, and
   the "current" runtime is picked by on-disk mtime. The protocol is
   reconstructed from git history. Comparing against the wrong version produces
   wrong "mandatory step" findings, and reliability is a hard constraint for
   the analyzer.

### Why this belongs in the plugin

When it creates a seat, the plugin server already knows all of the above: who
created the seat, its role and disposition, the resolved runtime pin, the
protocol in use, and the formation identity. It just does not write them where
the analyzer can read them.

Labels use the existing create call. First/new episode context also needs
bounded durable metadata IO, measured separately below. Agents do no extra
self-reporting, because the server writes the data. This
matters because the analyzer's purpose is to reduce ceremony. The fix must not
ask agents to self-report more.

### Goal and non-goals

**Goal.** Group the agents **the plugin creates** by episode, and link each
group to its root through the root's **agent ID**, which the plugin already
knows at creation time. The analyzer reaches the root through that ID; the root
does not need labels of its own.

**Non-goals.**

- Labelling the root.
- Updating labels after creation.
- Host changes.
- Extra tool calls or ceremony whose only purpose is labelling.

### What the plugin already writes

- `slp_seat_create` sets `slp.formation` to the canonical formation identity
  hash (`plugin/server/desk-formation.ts`). That value is also the
  `idempotencyKey`/`requestId` and appears in the `create-issued` receipt phase.
  It already links a seat to its formation receipt, so no new request-id label
  is needed.
- Desk task dispatch sets `slp.repo`, `slp.assignment`, `slp.task`,
  `slp.attempt` and `slp.create-action` (`plugin/server/desk-task-execution.ts`).
  When an episode runs through desk tasks, `slp.assignment` already groups its
  seats.
- `verifySeat` compares the labels it was given against the created agent. Any
  new label written at create time must be added to the same verification, or
  verification will either fail or stop covering it.

## Contract

All labels and events are written by the server. Values contain IDs, hashes,
declared role/disposition tokens, timestamps or bounded outcome/basis/warning
tokens; they never contain assignment text, report text or project names. If a
value cannot be obtained, leave that label empty, record a warning in the
receipt, and create the seat anyway. Do not guess.

### Creator classification

At each `slp_seat_create`, the server classifies the **creator** (the calling
seat) from data it already holds. It makes no extra calls (see Performance).

| Class | Condition | Meaning |
|---|---|---|
| **Labelled** | The creator has `slp.episode-id` and `slp.episode-root` | A plugin-created seat with an episode context. |
| **Root** | The creator has no episode labels, **and** no `slp.formation`, **and** no observed `paseo.parent-agent-id` | A seat created outside the plugin, typically by the Human. It is the root of the episodes it opens. This is **not** an error. |
| **Missing context** | The creator has no episode labels, but it has `slp.formation` or an observed `paseo.parent-agent-id`, or its labels cannot be read | A plugin-created or agent-created seat without episode context (for example a seat created before this change, or a read failure). |

Rules:

- **Missing context** means: write **no** episode labels on the new seat and
  record the warning `episode-context-missing` in the receipt. Never treat the
  creator or the new seat as a root in this case. The rule "the parent has no
  label, so the child is a root" is forbidden: it would assign the wrong root.
- A Root classification depends on a missing parent label. The parent label is
  mutable and can be absent on some hosts (a known visibility gap noted in
  `plugin/server/desk-seat.ts`), so its absence is not proof. Record the basis
  `creator-unlabelled-unformed` in the receipt so the analyzer can check it
  against the agent record.

### Task 1: episode labels on plugin-created seats

`slp_seat_create`, and the compatibility create path if the plugin controls
it, writes:

| Label | Value |
|---|---|
| `slp.episode-id` | UUID of the episode the new seat belongs to |
| `slp.episode-root` | Agent ID of the root of that episode, i.e. the seat that received the Human root assignment |

Values by creator class:

- **Labelled creator, `inherit`:** use an explicit current episode opened by
  that creator if present; otherwise copy both labels from the creator. This
  allows a former child to receive later Human root assignments without
  changing its original labels.
- **Labelled creator, `new`:** new `episode-id`; `episode-root` is the
  **creator** (it is receiving a new root assignment).
- **Root creator:** `episode-root` is the **creator's agent ID**, even though
  the root carries no labels. `episode-id` is the root's **current episode**
  (Task 2). With `new`, a new episode is opened.
- **Missing-context creator:** no episode labels, warning (see above).

The root itself is never labelled by this change. In particular, there is no
post-create update and no extra call to label it.

### Task 2: `episode: "inherit" | "new"` and the root's current episode (required)

- Add an optional parameter to `slp_seat_create`, defaulting to `inherit`.
- `new` opens a new episode whose `episode-root` is the creator.
- **Root's current episode.** A root carries no labels, so the plugin cannot
  inherit from it. The server keeps the **current episode per creator agent
  ID** in isolated plugin metadata under
  `<stableRoot>/state/episodes/<sha256-of-agent-id>.jsonl`:
  - a root's first `slp_seat_create` opens an episode;
  - `new` opens a new one;
  - `episode-closed` (Task 7) closes it;
  - `inherit` from a root uses its open episode, and opens one if none is open.

  Creation uses the existing verified creator snapshot, never a host lookup.
  First/new episodes append a bounded checksum-chained JSONL record and synchronizes
  file data/length (`fdatasync`); creation also fsyncs its directory. Inheritance does not write it.
  A torn append is a visible metadata gap; no repair discards prior evidence. A short exclusive metadata lock has no retries or waits;
  unavailable/corrupt/locked/full metadata produces a warning and no guessed
  episode. This metadata cannot degrade the work ledger or change authority.

  Invariant and ownership: one server-selected context must survive restart
  and serialize concurrent creates without agent self-reporting. Protocol or
  repository harness cannot observe/control those server-side creates without
  extra ceremony; the plugin owns this advisory state. It lives outside the
  repository and is not a task ledger or an acceptance source.

  One unambiguous open registered assignment supplies its episode without a
  metadata write. A pointer may be read to honor a newer explicit Lean opening.
  Multiple applicable registered episodes make `inherit` report
  `episode-context-ambiguous`; `new` opens a separate explicit root episode.
  A pointer records its verified desk head. A later root registration by the
  holder, once closed, invalidates that older pointer; closing an assignment
  registered before the pointer does not invalidate it. A later attachment as
  somebody else's managed seat does not supersede the holder's own Lean pointer.
  Missing/cross-desk anchors warn `episode-history-unavailable`; `new` reanchors
  if the current desk history is verified. Unverified history omits episode
  labels even for a labelled creator; parent lineage remains available.
  Managed registration captures optional metadata IO before its transaction;
  selection against the verified decide snapshot is pure.
- If the desk already knows that a new Human root assignment has started (for
  example through `slp_assignment_register`), derive `new` from that instead of
  relying on the agent.
- Otherwise add one sentence to the delegation reference, not to the always
  loaded role policy (see Performance): the first seat created for a new Human
  assignment uses `episode: "new"`.

### Task 3: handoff keeps the episode

- A successor keeps the predecessor's `slp.episode-id` and `slp.episode-root`
  when the predecessor has them.
- When the predecessor is a root (no labels), the successor becomes the new
  holder of the root's current episode. Its `episode-root` stays the original
  root ID, and `slp.handoff-from` records the link.
- Explicit `prepare-handoff` writes `slp.handoff-from` with the predecessor's
  agent ID and preserves optional existing `handoff.episode` context. This
  offline input is caller-asserted; missing/invalid context produces a warning
  and no episode labels. It does not infer lineage from a title or read host
  state. Raw host creates outside this path remain an observation gap.

### Task 4: role labels

| Label | Value |
|---|---|
| `slp.role` | `supervisor` / `lead` / `peer`, as already known by the server |
| `slp.disposition` | The `disposition` passed at creation. Leave empty when none was passed; do not infer it. |

### Task 5: version labels

| Label | Value |
|---|---|
| `slp.runtime-sha` | The installed binding's `candidateSha256` (the installed manifest's candidate sha for CLI preparation), never formation `runtimePin` or the newest bundle on disk. |
| `slp.protocol-sha` | SHA-256 of exact protocol file bytes in the qualified effective protocol source checkout. Missing/unreadable files omit the label and warn. Existing placement pins hash canonical JSON strings and cannot be reused as raw-byte hashes. |

### Task 6: formation link (already present)

Keep `slp.formation` stable and documented as the join key between a seat, its
formation receipt and its desk events. No new label. It is also an input to
creator classification.

### Task 7: episode open/close events (required)

| Event kind | When | Payload |
|---|---|---|
| `episode-opened` | When an episode is opened: a root's first seat creation, a creator passing `new`, or the desk registering a new root assignment | `episodeId`, `rootAgentId`, `at` |
| `episode-closed` | When the desk closes the root assignment | `episodeId`, `rootAgentId`, `at`, `outcome` (`handback` / `cancelled` / `unknown`) |

These events are the **time boundaries** the analyzer uses to split a root's
own turns into episodes, because the root carries no labels. Payloads never
contain content.

Ordinary `episode-opened` events live in the bounded per-creator metadata
append-only JSONL file (with per-entry chain digests); the formation receipt records the selected
episode and its basis. Managed root registration/close events share their
existing desk transactions and hash chain. Their `at` is the event envelope's
commit timestamp. A descendant assignment records its existing episode
association but does not open or close its root's episode. Explicit close
uses outcome `unknown`, since that tool carries no handback/cancellation kind.

These times are server observation times. Delegated work before the first
create, and handback outside the desk, remain inference gaps. No turn-ended
or child handback signal is promoted into a root close.

### Open gaps (not solved by this change)

Not labelling the root removes a requirement; it does not decide which episode
a long-lived root is working on. The following remain open. Implement them only
after a decision, and do not claim them as solved:

1. **Unavailable metadata.** Task 2's isolated state resolves normal root
   inheritance. If it cannot be read or committed, omit episode labels and
   record `episode-state-unavailable`; never overwrite corrupt history or
   repair a retained metadata lock automatically. Existing work continues.
2. **Concurrent assignments on one root.** A root working on two Human
   assignments at once makes "current episode" ambiguous. Neither `inherit`
   nor timestamps can resolve it. Resolving it would need an explicit episode
   reference at creation (an extra parameter the agent must choose), which is
   a ceremony trade-off for the Human to decide. Until then the analyzer treats
   such roots as ambiguous and asks the Human. The automatic current pointer
   represents sequential Lean assignments; it is not proof that only one
   Human assignment exists. Multiple registered episodes are detectable and
   therefore omit ambiguous episode labels.
3. **Episode start when the root does the work itself.** A root that writes
   directly without creating any seat produces no seat creation, so the plugin
   never sees the new Human message:
   - if the desk has an assignment registration step, emit `episode-opened`
     from it;
   - otherwise the previous `episode-closed` is only a lower bound, and the
     analyzer infers the rest as it does today.
4. **Episode close.** `episode-closed` relies on an existing handback or close
   event. A root that never hands back through the plugin leaves its episode
   open, and the analyzer falls back to the last turn.
5. **Parent-label visibility.** Root classification uses the absence of
   `paseo.parent-agent-id`, which the host may not always expose. The receipt
   records the basis, but the plugin cannot prove the creator is a root.

Do not add a post-create label update, a host change, or an extra tool call to
close these gaps.

### Task 8: regression and documentation

- All existing seat-creation tests still pass.
- Seats created before this change behave as before.
- Plugin documentation lists:
  - the new labels and events, and their meaning;
  - creator classification;
  - the "IDs/hashes only" constraint;
  - the fact that roots are unlabelled;
  - the open gaps.

## Performance constraints (required)

This change may only record data the plugin **already has**. It must not add
round trips, background work or agent tokens.

1. **No extra Paseo calls.**
   - Labels travel in the existing create call (`labels`).
   - Creator classification and inheritance use the creator data
     `slp_seat_create` already has for parent/workspace verification. Do not
     add `get_agent_status` or agent-list calls.
   - Do not update labels after creation, on the new seat or on the root.
2. **No repeated hashing.** `slp.runtime-sha` comes from the resolved candidate.
   Cache the raw-byte protocol hash by file identity (device/inode, ctime,
   mtime and size), including invalidation on same-size/replaced files.
3. **Keep episode persistence off the work path where possible.**
   - Ordinary formation has operation receipts, not a shared desk transaction.
     First/new episode selection may append/synchronize its isolated metadata
     record; inheritance only reads/reuses context. The record is bounded to
     2048 openings / 1 MiB per creator. Retention exhaustion is a warning,
     never silent pruning or a seat-creation gate.
   - `episode-closed` goes with the existing handback or assignment-close event.
   - Managed registration/close reuse existing ledger transactions and their
     already-verified event observations; no extra work-ledger read is added.
   - No background process, polling, heartbeat, or automatic lock recovery.
4. **No extra agent tokens.**
   - The Peer delivery prompt does not change.
   - The `episode: "new"` sentence lives in the delegation reference, which is
     read only when delegating. If it must go into a role policy, keep it to
     one line.
   - If the desk can infer a new root assignment, drop the sentence.
5. **Label failures never block seat creation.** On a missing value (no
   protocol file, unreadable creator labels, missing context), leave the label
   empty, record a warning in the receipt and create the seat. No retries, no
   waiting.
   Native verification reports advisory labels in `metadataMismatches` and
   keeps core formation/task identity labels as blocking identity checks.
6. **Measure before and after.**
   - Time `slp_seat_create` on the same machine, at least 100 runs on each
     side with four warmups and alternating baseline/candidate order. Report
     inheritance and new-episode allocation separately; record whether the
     host is real or a structural double.
   - Accept when p50/p95 grow by no more than 5% **and** no more than 10 ms.
   - The number of Paseo calls per seat creation stays the same, checked by a
     test or by counting in logs.
   - Managed root events add at most an open/close pair to existing ledger
     transactions; ordinary opens grow only the bounded metadata file. Record
     measurements in the task report or PR.

## Acceptance tests

1. **Root without labels is valid.** The Human creates a Lead outside the
   plugin. The Lead has no episode labels. Nothing reports an error, and the
   Lead keeps working normally.
2. **The child references the root.** That unlabelled root Lead creates
   Peer A:
   - Peer A gets a new `episode-id`, and `episode-root` equals the Lead's agent
     ID;
   - `episode-opened` has `rootAgentId` equal to the Lead;
   - the receipt records the basis `creator-unlabelled-unformed`.
3. **Inheritance below the root.** A labelled Lead creates a child, which
   inherits both labels. Peer creation authority is unchanged.
4. **Same episode, second child.** The root Lead creates Peer B with
   `inherit` while the episode is open → Peer B has the same `episode-id` as
   Peer A and the same `episode-root`, including after plugin restart.
5. **Long-lived root, consecutive episodes.**
   - Register a root assignment, create its child, then close the assignment.
   - Register the next root assignment and create Peer C with `inherit` → a
     different `episode-id`, still with `episode-root` equal to the Lead.
   - Closing the second assignment yields two open/close pairs.
   - The Lead still carries no labels.
   - Separately, `new` opens a distinct Lean context without inventing a close
     event for an unregistered assignment.
6. **Supervisor root.** An unlabelled Supervisor creates two Leads with `new`
   → two different `episode-id`s, both with `episode-root` equal to the
   Supervisor. Each Lead's children inherit that Lead's labels.
7. **Missing context does not create a root.** A creator that has
   `slp.formation` (or an observed parent label) but no episode labels, such as
   a pre-change seat, creates a seat:
   - the new seat has **no** episode labels;
   - the receipt warns `episode-context-missing`;
   - neither the creator nor the new seat is recorded as a root, and no
     `episode-opened` is emitted.
8. **Unreadable creator labels.** Simulate a failure to read the creator's
   labels → treated as missing context (as in test 7). The seat is still
   created.
9. **Explicit offline handoff with supplied predecessor episode.**
   - A successor of a labelled seat keeps `episode-id`/`episode-root` and has
     `slp.handoff-from`.
   - A successor of a root keeps the original root ID as `episode-root`.
10. **Role labels.** A Peer created with `disposition: "reviewer"` gets
    `slp.role=peer` and `slp.disposition=reviewer`.
11. **Version labels.** `slp.runtime-sha` matches the bundle in the receipt. A
    workspace without a protocol → no `slp.protocol-sha` label, and a warning.
12. **Formation link.** `slp.formation` matches the formation receipt and desk
    events.
13. **Event payloads.** Each opened episode has exactly one `episode-opened`;
    each desk-closed one has exactly one `episode-closed`, in order. Payloads
    contain no content.
14. **Verification.** `verifySeat` covers the new labels as advisory metadata;
    a missing metadata label warns without preventing assignment delivery.
    Missing core identity labels still block it.
15. **Performance.**
    - The number of Paseo calls per `slp_seat_create` is unchanged, including
      creator classification.
    - A second creation with an unchanged protocol file does not rehash it.
    - The timing stays within the bound above.
    - No label update is issued after creation.
16. **Regression.** All existing seat-creation tests pass.

**Suggested order:** 1 → 2 → 7 → 3 → 4 → 5 → 6 → 8. Tasks 1, 2 and 7 are the
core: without them a long-lived root (a Lead the Human talks to directly, or a
Supervisor) merges all of its episodes. Task 2's metadata persistence is
required because tests 4 and 5 depend on persistent context. Include concurrent
inheritance, corrupt/locked metadata, ledger-close invalidation and exact
operation replay coverage.

## Out of scope for the plugin

- **Distinguishing Human messages from agent messages.** The analyzer infers
  this by elimination today: a message that matches no agent send and is not a
  system or schedule prompt counts as Human. Paseo knows for certain whether a
  prompt came from the UI, from a given agent or from a schedule, so recording
  the sender is a Paseo change. Asking agents to prefix their messages costs
  tokens and is unreliable.
- **Finish notifications truncated by Paseo, stale session-usage index:**
  Paseo or provider side.
- **Review-round anchors on the Lean path:** no extra tool call is needed.
  `slp.disposition=reviewer` plus the prompts sent to the reviewer are enough
  to reconstruct rounds.

## Analyzer side (not plugin work)

- **Roots are unlabelled by design.** The analyzer finds a root through the
  `slp.episode-root` agent ID on its children, never through the root's own
  labels. A root without labels is not a gap.
- **A root's own turns** are split into episodes by the `episode-opened` /
  `episode-closed` events with that `rootAgentId`. Without events, the analyzer
  uses its current time-based split and asks the Human.
- **Labelled seats:** episode membership comes from `slp.episode-id`.
- **`episode-context-missing`, and seats created before this change:** the
  analyzer keeps its current inference (parent chain, Human picks the root). A
  seat without episode labels is never assumed to be a root just because its
  parent is unlabelled.
- **Root basis:** the analyzer checks the receipt basis
  `creator-unlabelled-unformed` against the agent record. If the record shows a
  parent, it records a gap instead of accepting the root.
- **Concurrent assignments on one root** (open gap 2): treated as ambiguous and
  confirmed by the Human.
- **Conflicts:** a label that contradicts the inferred data is recorded as a
  gap; the analyzer does not silently pick one side.
