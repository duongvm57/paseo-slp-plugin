# Communication supervision

This spec owns capture, assessment and notification invariants for the opt-in
supervision capability. Local checks cover these interfaces; current live E2E
acceptance and model calibration require separate evidence.
[Operations](../operations.md#communication-supervision-optional) owns the
operator procedure. Installing or upgrading never enables transmission.

## Decision

Supervision is an **opt-in capability of the existing `paseo-slp` plugin**.
The reference plugin and SLP target the same workflow: a Lead briefs a Peer,
the Peer hands work back, and the Lead disposes of the obligation the
handback raises. Supervision judges whether that communication was adequate
and tells a Supervisor when it looks wrong.

It stays optional and off by default. Configuring Jev only makes it
available. Observation starts only when Jev is enabled with
`capabilities.supervision` **and** the Human selects `shadow` or `notify`
for a Lead — through daemon defaults for discovered SLP Leads or an explicit
per-Lead route. Turning it off stops new capture, assessment and delivery
without changing other Jev uses, provider setup, role injection, routing or
on-demand `monitor`.

The output is always a **suspected communication issue for review**. It is
never artifact acceptance, a Lead verdict, authority, permission to alter an
assignment, or an automatic Peer follow-up. `notify` only prompts the chosen
Supervisor, who decides within its own assignment.

## Ownership and data flow

```mermaid
flowchart LR
    UI[Manager card / bell] -->|CAS RPC| Store[Private supervision.json]
    Hooks[Paseo lifecycle hooks] --> Capture[Provider-aware capture]
    Store --> Gate[Effective route + Jev capability gate]
    Capture --> Gate
    Gate -->|bounded packet| Jev[Jev decision transport]
    Jev --> Judge[Strict parse + per-axis gates + findings]
    Judge --> Ring[Metadata ring for review]
    Judge -->|notify| Deliver[Revalidate, reserve, send]
    Deliver --> Sup[Verified Supervisor]
```

| File | Responsibility |
| --- | --- |
| `plugin/shared/supervision.ts` | Role predicates, schema-3 store, schema-1/2 migration view, effective-route resolution, observation/finding/delivery metadata, RPC contracts. |
| `plugin/server/supervision/state.ts` | Served-home binding, the single CAS writer, SDK validation with pending verification, served-home actions (status, disable notifications). |
| `plugin/server/supervision/capture.ts` | The capture module: one entry point, per-family adapters inside; returns brief/handback evidence, per-call send input and outcome, send coverage and issues. |
| `plugin/server/supervision/assessment.ts` | Rubric-2 questions, link questions, strict parsing, local gates, per-axis judgment. |
| `plugin/server/supervision/observer.ts` | Hooks, discovery, chronology, cases, queue, archive generations, packets, findings, closure, dispatch pass. |
| `plugin/server/supervision/delivery.ts` | Attempt store (mark-before-send), recipient predicate, alert template. |
| `plugin/client/cards/supervision.tsx`, `plugin/client/supervision-form.ts` | Manager card and its view model (scope, pickers, plain-English text, findings summary). |
| `plugin/client/supervision-controls.ts` | The recipient-workspace bell. |

No observer code lives in the immutable `bin/`/`src/` runtime payload.
[`plugin/server/runtime/cli/monitor.ts`](../../plugin/server/runtime/cli/monitor.ts) stays a separate on-demand tool.

### Host evidence boundary

The observed provider envelopes and their provenance live with the
[supervision fixtures](../../tests/fixtures/supervision/README.md).
Only observed normalized shapes open a transmission lane; derived examples
are not positive evidence. Devin send outcomes and OpenCode/Antigravity capture remain
unknown where no emitted result/verified shape exists. The detector never
reads assignment pointer files or infers report-recipient authority.

## Configuration and authority

The store is `<daemonHome>/slp-runtime/state/supervision.json`, schema 3:

```json
{
  "schemaVersion": 3,
  "confidenceThreshold": 0.9,
  "defaults": { "mode": "off", "supervisorAgentId": null, "supervisorWorkspaceId": null, "pendingDelayMs": 60000 },
  "routes": [{ "leadAgentId": "…", "leadWorkspaceId": "…", "supervisorAgentId": "…", "supervisorWorkspaceId": "…", "mode": "shadow", "pendingDelayMs": 60000 }]
}
```

- **Modes.** `off` captures and sends nothing. `shadow` captures, sends the
  packet to Jev and records findings. `notify` is shadow plus Supervisor
  delivery. `notify` requires a Supervisor id (route or default).
- **Resolution.** An explicit route decides alone — an explicit `off` keeps
  that Lead unobserved. Otherwise a **discovered** SLP Lead follows active
  defaults. A Lead is discovered only from a lifecycle record whose provider
  is an exact `slp-<family>-lead`, or from a refresh that proves it (a Peer
  event of an undiscovered parent triggers that refresh). An explicit active
  route also needs discovery, with the discovered workspace equal to the
  route's `leadWorkspaceId`; until then its gate reads `lead-not-seen-yet`
  (or `lead-workspace-mismatch`) and nothing is observed. The default
  Supervisor is never observed as its own Lead.
- **Threshold.** `confidenceThreshold` applies to every axis behind a finding
  and to delivery. It is model concentration, not measured accuracy.
- **Pending delay.** 0–24 h, default 60 s. A checkpoint for delivering
  brief/handback findings, never a deadline that turns silence into drift.
- **Validation (save time).** Every named agent is refreshed. When the host
  returns a snapshot it must match exactly: an explicit active route's Lead
  is an active exact SLP Lead in the declared workspace; a named Supervisor
  (route or default) is an active exact SLP Supervisor (status
  `initializing`/`idle`/`running`) in any workspace, and its workspace is
  recorded server-side (`supervisorWorkspaceId`; it places the bell). When
  the refresh returns nothing or throws, the save still lands and the
  response lists the agent in `unverified` with the reason; a Supervisor
  then keeps the workspace the Manager's picker supplied. This is safe
  because an unverified Lead's route observes nothing until host evidence
  arrives, and delivery re-checks the recipient before every send. With
  defaults off, an unchanged default recipient keeps its recorded workspace
  without a liveness check. Off routes need no liveness. No inference from
  title, cwd or workspace; no fallback recipient. A route written before
  `supervisorWorkspaceId` existed reads it as null and places its bell in the
  Lead's workspace.
- **CAS.** The token is the sha256 of the raw file bytes (no separate
  revision or route-generation field exists). `set-supervision` must present
  the token it read; every writer rechecks it after its awaited SDK
  validation and writes atomically (0600). The served-home action
  `disable-supervision-notifications` reads and writes in one call through
  the same writer; disabling is a pure reduction
  (notify → shadow) and re-validates nothing, so it succeeds even when an
  unrelated route's Lead is gone. An invalid or unreadable file is **off with
  a visible error**, never an empty config; open cases close
  `config-invalid` (distinct from `route-removed`).
- **Served home.** State binds to the daemon home this plugin process serves
  (exported `PASEO_HOME`); a UI target or a default-guessed home that cannot
  be verified is refused and recorded as a host capability gap.
- **Migration.** A schema-1 file (routes only) or schema-2 file is read as
  schema 3 with **every route and the defaults off**, recipients and other
  fields kept, and the previously enabled routes and defaults listed
  (`migration.disabledRoutes`, `migration.disabledDefaults`) for the Manager's
  Restore. Each upgrade widened what can leave the host (schema 2: cross-Peer
  bodies and delivery; schema 3: Claude Code and Devin message content), so
  an upgrade must not widen an earlier choice. The file is untouched until
  the Human saves; writes are always schema 3; the delivery attempt history
  is not reset.
- **Gate failure.** A failed Jev capability/key/target gate pauses capture
  daemon-wide, drops retained bodies and spends nothing. An unavailable
  notify recipient blocks delivery for that Lead with a visible reason while
  observation continues.

## Observation and correlation

1. **Membership.** Observe only Leads resolved above and their direct Peers,
   using `parentAgentId` from hooks and the daemon parent label on refreshed
   snapshots. A Peer is admitted only after a refresh verifies its parent;
   `agent.created` payloads are persisted claims, not creation proof. Common
   cwd or workspace is never parentage.
2. **Hooks.** `agent.created`, `agent.archived`, `agent.turn_started`,
   `agent.turn_ended` capture the minimal normalized boundary synchronously
   and return. SDK refresh, Jev HTTP and delivery run on one plugin-lifetime
   queue. Archive generations are monotonic; a tombstoned id cannot re-enter
   until a refresh verifies restoration.
3. **Capture evidence.** `capture.ts` is the one module that reads provider
   shapes; the observer and assessment never name a family. For each ended
   turn it returns, separately:
   - **brief / handback** — `verified` (the family's message mapping has a
     real normalized fixture and the item matches it), `missing` (the turn
     region is known and the message is not there), or `unverified` with a
     cause (`unsupported-family` for a non-registry provider, `turn-boundary-unverified` when no
     delivered input opens the slice, `role-prefix-unrecognized`). Host 0.12
     projects agent-originated inputs into completed `tool_call` rows named
     `agent_message`. Capture validates their semantic `agentMessage` payload
     and passes its decoded text through the existing family message adapter;
     presentation text is never a fallback. A malformed projected input fences
     off older evidence. The latest delivered input is the brief and the last
     `assistant_message` the handback. When that message starts with the
     compact SLP launch envelope (`SLP role`, `Launch binding`, `Assignment`),
     capture validates the role against the actor and the bound provider
     family, then keeps only the assignment body; runtime binding metadata is not sent as communication
     evidence. This envelope is observed in the Codex, Claude and Devin
     fixtures; the Pi path is covered with the real launch builder synthetically
     because the live Pi message had no wrapper. A Devin message is read
     strictly whenever it carries ANY fixed structural line of the SLP
     transport anywhere in the text — the role line, either half of the
     role-prefix terminal line, the recovery and snapshot lines, the
     onboarding locator, the managed-runtime helper block, the
     communication-language line, the carrier block
     or a launch binding (pinned to the renderer sources by a test) — exactly one recognized
     wrapper for the captured actor's role, or `role-prefix-unrecognized`; a
     Devin message with no trace at all is captured verbatim as a plain
     follow-up (`devin-plain-message-v1`, seen live in r4) — its role comes
     from the host-verified provider, never from the text. Free policy prose
     from the role files is not a fixed line, so a fragment made only of such
     prose would read as plain — a disclosed residual. A line with optional
     leading spaces/tabs, `Assignment file:`, optional spaces/tabs, and a
     non-whitespace value is a content fact (`brief-references-assignment-file`)
     in pointer mode; the renderer's suffix is not required and the daemon never
     reads the path. `Assignment snapshot:` does not match that pointer syntax.

     This is a communication slice, not proof of a lifecycle turn boundary:
     agent messages can steer an active turn. Sends before its latest input
     are conservatively excluded. Structured `finished` notifications qualify
     end-only chronology only with the expected sender ID and exact legacy
     status-line/handback-body correlation. Other events and bare reports do
     not anchor. Metadata does not authenticate a client-supplied sender ID.
   - **each send** — input (`verified` recipient + prompt, or unverified with
     a reason) and outcome: `accepted` needs the semantic success of exactly
     that call in a verified shape; `rejected` needs an explicit failure
     result tied to the call (`success:false`, `isError`, a failed status
     with an error and no success payload); everything else is `unknown`
     (running, canceled — a canceled call may still have delivered — missing
     output, prose, an unverified shape, or contradictory envelopes
     `send-result-contradictory`). A body leaves capture only for a verified
     input with an accepted outcome.
   - **send coverage** — whether the family's send shapes are recognized and
     their outcomes decodable; a call naming `send_agent_prompt` that no
     adapter recognizes makes the turn's coverage unverified
     (`send-shape-unverified`). An MCP proxy surface (`mcp__paseo`, bare
     `mcp`) whose target tool cannot be read — input not an object, a detail
     type other than `unknown`, or no `tool` — does the same (fail-closed;
     never a send, never a body); only the bare proxy's observed discovery
     inputs (search/list/connect/describe) are exempt. A shell command is
     never read as a send.
   Accepted Peer sends are kept as delivered reports; a Peer send receipt
   never removes the brief/handback axes.
4. **Lead sends.** Accepted sends count, including on failed/canceled turns.
   Recipients are refreshed: a verified direct Peer of the same Lead is room
   communication (this Peer, or cross-Peer); the route's Supervisor is the
   report class. **Scope of an unproven send.** Every case of a Lead has the
   same disposition-carrying set — the Lead's verified direct Peers and the
   route Supervisor — because a cross-Peer message or an escalation may
   dispose of any case's obligation. A send into that set whose outcome is
   rejected or unknown therefore leaves every case of that Lead with an
   incomplete candidate set: it is kept ids-only in each case's uncertain
   lane with its reason, and handling stays unknown for all of them (never a
   candidate, never a body). A send to anyone outside the set — another
   Lead's Peer, an unrelated agent — touches no case. An unverified input
   (recipient unknown) might be inside the set, so it gates every case of
   that Lead too. Narrowing to the recipient's own case would let case A be
   judged — and alert on drift — while a possibly-correcting message to Peer
   B is unobservable. The Lead's family send
   coverage is looked up from the Lead snapshot every evaluation refreshes
   (a verified host record — never inferred from the Peer); an unverified
   family (`send-coverage-unverified` for devin, `unsupported-family` for a
   non-registry provider, `lead-provider-unknown` without a record) leaves handling unusable
   from the first assessment. Final prose and wrapper text prove nothing.
   Direct Lead action with no observable communication stays pending, never
   drift.
5. **Chronology.** A Lead send follows the handback when its matching
   non-null turn-start was observed strictly after the handback, or — when no
   usable start reached this observer — when the turn slice opens with this
   case's finish-notification envelope (peer id at the status-line position,
   handback in the response section). The envelope is text correlation, not
   an authenticated sender; a bare report body, an older slice, or a foreign
   status line never anchors. Chronology is judged per case and only for a
   turn that laned a send into that case. Non-qualifying sends land in the
   uncertain lane; overlap and missing starts gate handling only.

### Provider coverage

What each family can contribute today (packet 3, capture `slp-capture-7`).
"Verified" means a sanitized normalized fixture observed on a real timeline
backs the shape; it certifies extraction, not content or authorship.

| Family | Brief / handback (as Peer) | Send input | Send outcome | Handling of its Peers (as Lead) |
| --- | --- | --- | --- | --- |
| codex | verified (live compact launch envelope; only the assignment body is captured) | verified (`paseo.send_agent_prompt`, object input; alias and string input unverified) | verified (`structuredContent.success`, `isError`) | judgeable |
| claude | verified (live compact launch envelope; only the assignment body is captured) | verified (`mcp__paseo__send_agent_prompt`) | verified (`output.output.success`; failed/denied = rejected) | judgeable (send shape observed on a Peer; Lead-role live run not done) |
| devin | verified for the two observed prompt wrappers — the full ACP role bundle (sometimes wrapping the compact launch envelope) or the direct compact envelope, checked against the actor's role; capture keeps only the assignment body — and for a plain follow-up with no transport trace (captured verbatim). Any trace in another form (wrong role, merged, truncated, embedded) is unverified | verified (ACP title `Calling send_agent_prompt from paseo`) | unknown — the provider emits no result | never judged (`send-coverage-unverified`) |
| pi | verified (live message had no role prefix — the policy rides `--append-system-prompt`; compact launch envelope uses the shared parser, covered synthetically) | verified (proxy tool `mcp__paseo`, `input.tool = "paseo_send_agent_prompt"`, object `args`; the bare `mcp` proxy, `paseo.send_agent_prompt` and string args stay unverified; `mcp` search/list/connect/describe calls are not sends; a proxy call with an unreadable target makes coverage unverified) | verified (`details.{mode:"call", tool:"send_agent_prompt"}.mcpResult.structuredContent.success`, `isError`; the `content[].text` copy is never parsed) | judgeable (send shape observed on a Peer; no `slp-pi-lead` provider exists, Lead-role live run not done) |

Mixed rooms are judged per axis: a devin Peer under a codex, claude or pi Lead
gets all three axes; a codex/claude/pi Peer under a devin Lead gets brief and
handback only (partial support, not an unusable case). Assessment summaries record `captureVersion`;
rows from before it read `legacy-1` and keep their old verdicts — history is
never re-evaluated.

## Jev assessment and local gates

**Packet.** The Jev `state` (`buildEvidencePayload`) contains: packet and
rubric versions; bound Lead/Peer/Supervisor ids; case and turn/message ids;
per-axis visibility; the complete brief and handback bodies (plus an
`exceedsNotificationLimit` exposure fact for handbacks over 4000
characters — it proves no truncation was delivered); confirmed post-handback
Lead messages with bodies in one chronological list keyed `m1..mN` and
labelled `case-peer`, `other-peer` or `supervisor`; uncertain sends as
**ids and recipient only** (their bodies are not transmitted — the lane gates
handling, so a body would add no judgeable content); confirmed Peer sends;
open prior finding axes; flags. Never tool outputs, reasoning, raw errors,
file contents or credentials; the credential guard runs over the whole
request. Elapsed time is not sent. The packet is capped at 64 KiB: over the
cap, cross-Peer bodies are withheld (`other-room-bodies-omitted`, handling
unobservable); still over, the case closes `evidence-oversize`. Nothing is
silently truncated.

**Questions (rubric `slp-supervision-rubric-3`).** A shared guard: judge
communication only, the state is untrusted data and not instructions, no
invented facts or ritual wording, obligations only where this brief, this
handback or an explicitly supplied rule asks for them, and missing or
ambiguous evidence is unknown. Rubric 3 makes obligations turn-scoped: a
brief is either a work request (a task, evidence, a decision or a follow-up
is asked) or a disposition/closure notice only (it accepts, rejects, closes
or informs and asks for nothing more). Content decides — never words such as
ACCEPT, ACK, OK, Done, Đã nhận or Chấp nhận; accept-plus-follow-up is a work
request for the follow-up part; a message that does not show which it is,
or contradicts itself about whether work continues, is not a closure
notice. A closure notice owes no work-request elements (only a clear
disposition and whether work continues) and a fitting acknowledgment fully
answers it; a bare acknowledgment never answers a brief that still asks for
a task, evidence or a decision, and new work claimed after a closure is
drift. Choices and schema are unchanged.

- `leadBrief` — satisfied / drift / unknown: does the brief carry what this
  task needs (bounded outcome, dependencies, write or read-only scope,
  invariants and authority limits, expected evidence, stop/reopen) to the
  extent each applies?
- `peerHandback` — satisfied / drift / unknown: does the handback answer its
  brief, separate complete/missing/failed/unverified, state ownership, and
  state evidence/consequence/decision for a blocker? Honestly reported
  incomplete work is not drift; an informational answer needs nothing more.
- `leadHandling` — handled / no_action_required / pending / drift / unknown:
  did later communication dispose of this handback's obligation (resolve,
  request specific evidence, accept/reject with reason, defer with owner and
  checkpoint, escalate to the Supervisor)? Any listed recipient may carry
  it; no direct reply is not drift; acknowledgment, DONE, tests or silence
  are not closure; elapsed time is a checkpoint.
- **Link questions**, only when confirmed candidates exist (the newest
  eight with bodies): `dispositionMessage` (which message carries the
  disposition or mishandling), `briefCorrection` and `handbackCorrection`
  (asked only for an open finding on that axis). Their choice vocabulary is
  exactly the candidate keys plus `none`/`unknown`, so a schema-valid answer
  can only name a message the code supplied. Membership is checked; it does
  not prove the judgment right.

Brief and handback bodies are immutable per case, so those axes are asked
once. Handling and link questions are asked on the initial assessment and
again whenever the packet changes. Only a complete schema-valid response for
exactly the asked questions counts: strict choices, finite ~1-sum
distributions with a unique maximum, and a response model within the
configured pin rule. A failed or malformed call proves nothing and is never
retried automatically.

**Local gates.**

| Scope | Flags | Effect |
| --- | --- | --- |
| Case | `capture-paused`, `credential-shaped-content`, `evidence-oversize`, `peer-turn-not-completed`, `no-observable-communication` (brief and handback both missing — an unverified message is communication, not silence) | Close unknown before any Jev call. |
| Brief | brief `missing`/`unverified`, empty, or `brief-references-assignment-file` (pointer mode only) | Brief unusable; handback unusable too (request-relative judgment needs the request) and **handling unusable** with the brief's reason (packet 3: the obligation's request must be readable). A validated inline snapshot is ordinary brief text and does not add this flag. |
| Handback | handback `missing`/`unverified` or empty | Handback and handling unusable. |
| Handling | `lead-start-unmatched`, uncertain sends, Lead send reasons (`send-not-completed`, `send-input-unparsed`, `send-result-unobservable`, `send-result-unsuccessful`, `send-result-contradictory`, `send-shape-unverified`, `recipient-refresh-failed`, `recipient-inactive`), Lead coverage (`send-coverage-unverified` for devin, `unsupported-family`, `lead-provider-unknown`; `family-shape-unverified` only on older rows), `queue-overflow`, `other-room-bodies-omitted` | Handling unusable; brief/handback still judged. |
| None | `report-route-unverifiable` (completed Peer cases only), `lead-start-end-derived`, `lead-turn-not-completed` | Disclosed only. |

**Judgment and findings.** Per axis, below the threshold, `unknown`, or an
unobservable axis yields no finding. A confident brief or handback `drift`
records a finding. `handled` counts only with a linked disposition message;
`drift` counts as a handling finding only when linked to the message that
mishandles the obligation — silence can never be mishandling.
`no_action_required` settles handling without any message; `pending` keeps
the case open at any elapsed time. Findings are immutable records (axis,
choice, confidence, linked call id). A later message resolves a brief or
handback finding only when Jev links it as that finding's specific
correction; a handling finding is resolved only by a linked disposition
whose message was appended to the case strictly after the mishandling
message (both must be in the case's confirmed lanes — a missing order proves
nothing). A clean handling disposition never repairs an unrelated gap.

**Closure.** Without open findings a case closes `evaluated` when handling is
settled and both body axes were judged or are unobservable, `unknown` with
the gate reason when handling is permanently gated (every gate input only
accumulates), or `unknown` at the assessment ceiling. With open findings it
closes as suspected drift once handling is settled (or the ceiling is
reached), the checkpoint has passed and any notify delivery has settled; a
permanently gated handling axis keeps it open until expiry so a linked
correction can still arrive. `no_action_required` closes the observer case
only — never the task, never acceptance.

**Cache and invalidation.** The sha256 of state plus questions is stored
with the answers; an identical rebuilt packet re-derives the verdict without
a call. New bodies or flags change the packet and need a fresh bounded call.
Every in-flight assessment carries an evaluation basis (per-Lead queued
jobs, per-case evidence version, archive generations, gate-down purges,
config and gate file stamps); any change discards the paid answer before it
is used.

**Retention of process state.** Capture and send dedupe windows are pruned
after 24 h (a duplicate hook delivery arrives within moments); an archived
Lead's send dedupe is dropped at archive, since its dead-era captures fail
the generation compare. A Lead turn-start whose end never arrives is pruned
after 24 h (that turn then reads unmatched — the conservative outcome).
Drained per-Lead queue counters are deleted; per-Lead gate reasons are kept
only for explicit routes, discovered Leads and Leads with open cases; Peer
membership and discovered Leads are removed at archive. Archive generations
and tombstones are deliberately never pruned: they are the archive/ABA
authority for queued work and late events, one small entry per archived id
for the process lifetime. The in-memory metadata ring holds exactly the ≤200
rows written to disk.

**Bounds.** One serialized evaluator; 64 open cases; 128 queued events;
64 KiB packet; **six** Jev assessments per case (the initial assessment plus
re-assessments on changed packets — the former four assumed a single delayed
assessment); 24 h case lifetime; 5 s single-shot HTTP; 15 s SDK waits.
Exceeding a bound becomes unknown with a metadata diagnostic.

## Notification delivery

`notify` runs the same observer and evaluator as `shadow`, then a dispatch
pass after each drain:

- **Eligibility.** Open findings whose confidence meets the *current*
  threshold and that were not yet attempted for this recipient. Handling
  mishandling is eligible immediately; brief/handback findings only after
  the pending-delay checkpoint, so a Lead correction linked before it
  prevents the alert. `pending` is never eligible.
- **Revalidation.** Before any attempt the recipient is refreshed and must
  be the exact id, an exact `slp-<family>-supervisor`, not archived, and in
  a deliverable status. After the await the case, gate, effective route
  (mode, recipient, source) and archive state must be unchanged; otherwise
  the dispatch is canceled and never redirected. An unavailable recipient
  blocks delivery with a visible reason (`notify-recipient-…`).
- **Recipient probe (display only).** While a notify route has an open
  case past its pending-delay checkpoint, a non-null unblocked recipient
  and no eligible finding, the dispatch pass refreshes the recipient at most once per Lead and recipient
  every 5 min (bounded, abortable) and runs the same predicate: unusable →
  gate reason `notify-<reason>` (refresh failure
  `notify-recipient-refresh-failed`); usable → a `notify-` reason is
  cleared. The result is revalidated after the await like a dispatch. The
  probe never sends, reserves an attempt, changes the case's delivery,
  creates a finding or changes the recipient. `notify-…` reasons are bound
  to the recipient they were recorded for — the gate view shows one only while the Lead's route still notifies that same recipient (a pure read, independent of any pass): they survive case evaluation and
  clear on a successful check, or at once (dispatch pass, evaluation or
  retention sweep) when the route names another recipient or stops
  notifying — never carried to the new recipient. While a reason is
  displayed, the scheduler re-probes after the throttle window without
  needing another host event. Limit: only open cases are probed, so a
  Lead with no open case past its checkpoint is not checked; and a
  recipient that goes bad before any case reaches a checkpoint shows
  nothing until then. An assessment that stays inconclusive (confidence below
  the threshold or `unknown`) keeps `assessment-inconclusive` /
  `handling-pending` as the case reason across Lead turn-end and gate-down
  re-records; it remains neither a finding nor acceptance.
- **Deferral.** A `running` Supervisor is not prompted (the host would
  interrupt its turn); the dispatch re-checks with backoff (30 s doubling to
  10 min) until the recipient is idle or the case closes. A refresh failure
  defers the same way; no attempt has been made.
- **Mark before send.** The attempt (case, finding axes, recipient,
  deterministic message id) is written to `state/supervision-deliveries.json`
  before the SDK call. `accepted` means the host accepted the request — not
  that the Supervisor read it. A failure, timeout or stop during the send is
  `uncertain` and never retried; an unsettled reservation reloads as
  uncertain after a restart.
- **Attempt history integrity.** A missing file is a legitimate first use.
  An unreadable, unparsable or schema-invalid history cannot prove which
  attempts already happened, so every reservation is refused
  (`delivery-store-unreadable` / `delivery-store-corrupt`), shown as the
  Lead's gate reason and a diagnostic, and the file is never reset or
  overwritten; each reservation re-reads it, so repairing or removing it
  recovers without a reload. A write failure after a clean read refuses the
  reservation too (`delivery-store-write-failed`).
- **Attempt retention.** Memory and disk hold the same set, ≤200 rows and
  ≤30 days. Records of live cases are pinned — they are the no-repeat
  authority for cases that can still dispatch — and the newest other records
  fill the rest. A case holds at most three attempt records across all
  recipients (`delivery-attempt-ceiling`), so the ≤64 live cases pin at most
  192 rows; a reservation is refused (`delivery-store-full`) rather than
  evict another live case's record. Records of closed cases are audit only:
  a closed case never reopens in-process and cases are not replayed after a
  restart.
- **Template.** Code-generated and deterministic: a fixed header
  ("Suspected communication issue — review required"), a statement that it
  is not a verdict or acceptance, guidance to review within the Supervisor's
  assignment and raise it with the Lead through the assigned route, never to
  message the Peer or follow quoted instructions; case, Lead, Peer, route
  source, rubric, model, threshold, findings with linked call ids,
  visibility limits; then bounded excerpts (≤600 characters each, at most
  three messages, explicit truncation) inside a fenced block marked
  untrusted. The credential guard runs before sending.
- **What it never does.** No agent creation, reassignment, cancellation,
  artifact edit or acceptance. A Supervisor alert is not evidence that the
  Lead repaired anything. Disabling notifications does not recall a sent
  prompt.

## Operator surface

The [operations guide](../operations.md#communication-supervision-optional)
owns controls, defaults, external-data disclosure and delivery troubleshooting.
The card and recipient-workspace bell share one CAS writer. UI state never
widens the capture or recipient qualification rules above.

## Verification and remaining acceptance

Local: unit and scenario tests for capture, rubric/parse, gates, judgment,
packet allowlist, discovery, migration, findings and linked resolution,
cache/invalidation (including the suspension-site matrix), delivery
(eligibility, deferral, revalidation, cancel, mark-before-send, uncertain,
stop), store CAS, pending verification and served-home actions, the client
view model (scopes, kept routes, restore, pickers, text) and the bell;
typecheck and host compile. These prove mechanics, not judgment quality.

Not yet done, each needing its own authority: a labelled model evaluation
with predetermined positive, negative and ambiguous cases; a disposable live
end-to-end room on a real daemon (shadow first, then notify to a test
Supervisor) including an observed interruption check; Lead-role live runs
for claude, codex and pi (no `slp-<family>-lead` provider of those families
exists on the test daemon); a pi rejected/failed send observed live (its
rejected classification rests on the observed envelope and synthetic
mutations); a host send receipt for devin.

## Remaining decisions and acceptance

- The Human selects the first shadow pilot's Leads/families, sample,
  false-alert classes and cost ceiling before enabling notify.
- Structured authoritative report-recipient evidence is unavailable; route
  compliance stays outside this detector.
- Delivery defers while the refreshed Supervisor is running. The idle-to-running
  race can still interrupt; the adapter supplies no non-interrupting send mode.
- Rubric 3 judges turn-scoped obligations, including acknowledgment-only turns,
  without keyword filtering. Earlier synthetic evals are diagnostics, not
  calibration or a substitute for a live follow-up on real turns.
