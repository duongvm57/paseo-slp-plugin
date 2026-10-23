# Episode labels for retrospective analysis

This is the current advisory metadata contract for plugin-created seats.
The consumer is an offline, read-only analyzer of agent records, transcripts,
desk events, plugin episode metadata and repository Git history.
[Operations](../operations.md#retrospective-seat-metadata) owns setup,
warnings and maintenance; the analyzer never asks agents to self-report.

An **episode** is one Human root assignment, including successor seats after
handoff. Its **root** is the Supervisor receiving that assignment, or the
Lead when the Human assigns it directly. Human-created roots need no labels;
their children identify them through the original root agent ID. Long-lived
roots may host several sequential or concurrent episodes.

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
| **Missing context** | The creator has no episode labels, but it has `slp.formation` or an observed `paseo.parent-agent-id`, or its labels cannot be read | A plugin-created or agent-created seat without episode context (for example a seat created without this metadata, or a read failure). |

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

### Episode labels

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
  (see Current episode and explicit opening). With `new`, a new episode is opened.
- **Missing-context creator:** no episode labels, warning (see above).

The root itself is never labelled by this contract. In particular, there is no
post-create update and no extra call to label it.

### Current episode and explicit opening

- `slp_seat_create` accepts optional `episode`, defaulting to `inherit`.
- `new` opens a new episode whose `episode-root` is the creator.
- **Root's current episode.** A root carries no labels, so the plugin cannot
  inherit from it. The server keeps the **current episode per creator agent
  ID** in isolated plugin metadata under
  `<stableRoot>/state/episodes/<sha256-of-agent-id>.jsonl`:
  - a root's first `slp_seat_create` opens an episode;
  - `new` opens a new one;
  - `episode-closed` (see Episode events) closes it;
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
- Without desk registration, the delegation reference directs the first create
  for a new Human assignment to use `episode: "new"`.

### Handoff

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

### Role labels

| Label | Value |
|---|---|
| `slp.role` | `supervisor` / `lead` / `peer`, as already known by the server |
| `slp.disposition` | The `disposition` passed at creation. Leave empty when none was passed; do not infer it. |

### Version labels

| Label | Value |
|---|---|
| `slp.runtime-sha` | The installed binding's `candidateSha256` (the installed manifest's candidate sha for CLI preparation), never formation `runtimePin` or the newest bundle on disk. |
| `slp.protocol-sha` | SHA-256 of exact protocol file bytes in the qualified effective protocol source checkout. Missing/unreadable files omit the label and warn. Existing placement pins hash canonical JSON strings and cannot be reused as raw-byte hashes. |

### Formation link

Keep `slp.formation` stable and documented as the join key between a seat, its
formation receipt and its desk events. No new label. It is also an input to
creator classification.

### Episode events

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

### Open gaps (not solved by this contract)

An unlabelled root does not establish which assignment it is working on.
The following gaps require an explicit decision before extending the contract:

1. **Unavailable metadata.** The isolated metadata state resolves normal root
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

## Performance constraints

Metadata records only data the plugin **already has**. It must not add
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

## Out of scope for the plugin

- **Distinguishing Human messages from agent messages.** Use valid host
  provenance first: Paseo 0.12 projects agent deliveries as `tool_call`
  `agent_message` items with semantic `agentMessage.event`, `sender.id` and
  `text`; notifications have their own events. This identifies delivery source,
  not Human authority or a new assignment/turn. A plain `user_message` is
  **unknown origin** unless independent evidence establishes its source;
  older SDKs, plugin sends, and imported history may use that shape too.
  Correlate recorded Desk deliveries with their message IDs and persisted
  caller; do not classify unmatched inputs as Human by elimination. Never
  use display text, model-written prefixes or a legacy envelope as authenticated
  sender evidence. Episode, role, disposition and policy labels remain needed:
  one sender may participate in several episodes. The analyzer implementation
  is outside this repository; this is its input contract, not an implemented
  analyzer migration.
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
- **`episode-context-missing`, and seats created without this metadata:** the
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

## Verification

`tests/plugin-episode-labels.test.mjs` and `tests/plugin-desk-episode.test.mjs`
exercise classification, persistence, inheritance, handoff, event boundaries,
warning-only failure and metadata-versus-core verification. Formation/bridge
checks cover unchanged host-call counts and absence of post-create updates.
The measured closeout in [performance evidence](../reports/episode-labels-performance.md)
is candidate-specific and does not qualify a new candidate automatically.
