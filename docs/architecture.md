# Architecture — how SLP rides on Paseo

SLP is a way of organizing agents: a Supervisor watches, a Lead owns the
project's technical calls, Peers do bounded work. The plugin's whole job is
to make that organization exist **on a stock Paseo daemon** — using only
the primitives Paseo already has (custom providers, agent profiles,
`config.patch`, workspaces, agent parentage) plus one ingredient Paseo does
not have: a hidden instruction channel into each session.

This document draws that architecture. For requirements and file-level
contracts see [contract.md](contract.md); for the implementation spec see
[spec/paseo-plugin-implementation.md](spec/paseo-plugin-implementation.md).

## Why this shape

Paseo already supplies agent creation, workspaces, parentage and
timelines — it solves *process creation*. It does not decide ownership,
independent judgment, coordination or acceptance. The failure modes this
design exists to prevent are the ordinary ones of multi-agent coding:

- **Authority gradient** — a parent that presents the answer gets
  agreement back, not a check of the premise.
- **Perfect-plan trap** — the coordinator pre-selects files, APIs and
  lifecycle; the worker becomes a typing bot and real dependencies
  surface late as compatibility patches.
- **Attention dilution** — a coordinator that also implements and
  explains local details loses the project-wide view of ownership and
  lifecycle.
- **Unsafe parallelism** — two agents sharing one checkout overwrite the
  same moving files; an agent or workspace ID is not filesystem
  isolation.
- **Biased or stale review** — a reviewer that inherits the author's
  framing, or reviews files that are still moving, approves a candidate
  that no longer exists.
- **False completion** — `finished`, `idle`, "done" and passing tests are
  attention signals, not proof the right artifact was reviewed by the
  right authority.
- **Split control planes** — workers spawning their own untracked workers
  leave no single system that knows who owns the task, the workspace,
  the correction or the cleanup.

Five ideas carry the design:

1. **Lead is a binding arbiter, not a plan-authoring bot-herder.** It
   owns framing, routing, ownership, dependencies, integration and the
   project verdict — not a pre-solved implementation handed to Peers as
   a typing job.
2. **Peer is an independent co-worker, not a function call.** One thin
   peer provider per family; the assignment's disposition makes the seat
   an Engineer, Architect, Reviewer or Scout.
3. **Supervisor is governance, outside the execution flow.** It observes
   Lead–Peer work for bias, lost momentum and anti-patterns, and relays
   Human decisions. It never owns implementation or acceptance.
4. **Three instruction layers, not one fat prompt.** Role bundle →
   workspace protocol → assignment. Precedence is one-way: a lower layer
   narrows but never widens a higher layer.
5. **Paseo is the only control plane.** The plugin adds policy bytes and
   managed configuration — not another scheduler or agent database.

## The role model

```
                        Human
                    owner authority
                          │
            ┌─────────────┴─────────────┐
            │                           │
       Supervisor                   Project Lead
   observation, governance      technical authority,
   anti-patterns, momentum      topology, acceptance
            │                           │
            └─────── observes ──────────┤
                                        │
                                     Peer(s)
                        Engineer / Architect / Reviewer / Scout
                              (disposition per task)
```

This is not a hard `Supervisor > Lead` chain of command — the two roles
hold different *kinds* of authority. The Lead is the authority inside its
project; the Supervisor stays outside the execution stream so it can see
bias the Lead cannot, relay Human decisions, and recover momentum. A Peer
is an independent co-worker: the same `slp-*-peer` provider can be an
Engineer, Architect, Reviewer or Scout depending on the assignment it is
born with. Peers never spawn agents.

**Human — owner.** Keeps product intent and priority, irreversible
trade-offs, protocol and authority changes, external effects, material
cost or risk, and final acceptance. Creates the Supervisor and Lead
seats; may converse mainly with the Supervisor to keep the Lead's
coordination attention free.

**Supervisor — governance observer.** Protects the quality of the
*workflow and reasoning process*: bias, repeated failure, lost momentum,
drifting scope, weak evidence. It may observe assigned workspaces, ask
the bound Lead why a strategy was chosen, report risk to the Human, relay
a recorded Human decision, propose profile or protocol revisions, and
record causal evidence in the notebook. It does not hold implementation
scope, architecture or acceptance; it messages only a bound Lead — never
Peers — and never acts as a substitute Lead.

**Lead — project authority.** Turns an objective into a trustworthy
project-level result: framing, topology, decomposition, ownership,
dependencies, checkpoints, review, integration, verdict. It reconstructs
the task without pre-solving it, assigns exactly one owner per moving
scope, writes neutral bounded briefs, and grants Peers the right to
reopen, request dependencies or stop blocked. Tiny, tightly-coupled work
may be Lead self-work; bounded implementation goes to a Peer Engineer;
difficult acceptance goes to a Reviewer that did not implement;
subjective or product decisions go to the Human with evidence, not a
simulated proof.

**Peer — bounded independent worker.** Owns one bounded outcome and
forms independent technical judgment. It works only in the assigned
scope, preserves unrelated work, never self-expands scope, challenges
the premise with evidence, verifies its own writes but never
self-accepts a difficult change. It talks only to the route its
assignment names — `send_agent_prompt` to the report-recipient — and
never spawns or manages agents.

Three separate layers carry three separate concerns:

| Layer | Lifetime | Holds | Must not hold |
|---|---|---|---|
| Role bundle (injected) | durable, cross-repo | identity, authority, invariants, anti-pattern guards | one repo's tactics |
| Workspace protocol (`.paseo-slp/workspace-protocol.md`) | durable per repo | topology, model/effort policy, review gates, escalation | one task's detail |
| Assignment (visible prompt) | one task | objective, scope, ownership, exclusions, verification, handback | the organization manual |

Precedence is one-way: a lower layer narrows but never widens a higher
layer, and omission grants nothing. Peers never receive the whole
protocol — the Lead extracts the relevant constraints into each
assignment. The protocol itself evolves like the work it governs: a new
anti-pattern is a hypothesis, then causal evidence, then a
Human-confirmed revision applied to new work.

## Operating principles

Six rules fall out of the role model and shape everything below:

- **One control plane.** Within a task, only Paseo owns agent lifecycle,
  workspace, parentage and timeline. Seats create children through
  agent-scoped `create_agent` so the host records who spawned whom; a
  Peer's role contract forbids it from spawning or managing agents. If
  seats could create their own untracked workers, two control planes
  would share no ledger and review/cleanup would become unreliable.
- **Independent judgment needs an independent seat.** A reviewer created
  from the author's context inherits its framing. Reviewers are fresh
  seats briefed neutrally against an exact candidate — the split-axis
  gate (a spec reviewer and a standards reviewer in parallel) is the
  default for work that needs review, and a required gate never
  collapses into one seat.
- **Workspace isolation is explicit.** One workspace ID is not
  filesystem isolation. The minimum safe rule is one writer per moving
  scope; same-team seats share the assignment workspace by default, and
  separate worktrees are an option for concurrent writers — declared
  with a reason, not used silently.
- **Providers are discovered, not assumed.** Role policy never
  hard-codes a model ID. The protocol carries selection principles; the
  routing catalog and saved profiles carry concrete picks; the Lead
  inspects live providers/models before routing. Two models agreeing
  does not make an unevidenced conclusion true.
- **Acceptance needs evidence.** `idle`, `finished`, "done" and exit
  code 0 are attention signals, not acceptance. Acceptance requires the
  exact artifact, a stable candidate identity, verification output,
  independent review when required, and an owner with the authority to
  accept. A correction produces a new candidate and invalidates reviews
  tied to the old one.
- **Human decision boundaries are recorded, not remembered.** The
  protocol states up front which work needs independent review, what may
  be edited, committed, pushed or deployed, which scope changes the Lead
  may decide, which decisions require the Human, the model budget, and
  the evidence level for acceptance.

## What the plugin adds to Paseo

```
┌────────────────────────── Paseo daemon ──────────────────────────┐
│                                                                  │
│   config.json                                                    │
│     agents.providers:                                            │
│       slp-claude-supervisor  slp-codex-supervisor                │
│       slp-pi-supervisor      slp-devin-supervisor   ─┐           │
│       slp-claude-lead        slp-codex-lead          │ up to 12  │
│       slp-pi-lead            slp-devin-lead          │ entries — │
│       slp-claude-peer        slp-codex-peer          │ settings- │
│       slp-pi-peer            slp-devin-peer         ─┘ driven    │
│     agentProfiles:                                               │
│       slp-supervisor → one slp-*-supervisor provider             │
│       slp-lead       → one slp-*-lead provider                   │
│                                                                  │
│   slp-runtime/                         ← plugin-managed          │
│     <candidateSha>/    immutable SLP payload (policy bytes,        │
│                        shims, role wrappers, gate, transports,    │
│                        helpers)                                  │
│     launchers/<sha>/   per-provider argv0 launchers — gate        │
│                        launchers for codex/pi/claude, shim        │
│                        launchers for devin                      │
│     state/receipt.json what the plugin believes it owns           │
│     state/communication-language                                   │
│                            optional injected language (toggleable) │
│     state/role-routing.json                                      │
│                            optional supervisor/lead family+model  │
│                            picks (settings-driven generation)     │
│     state/jev.json       optional Jev decision-primitive toggles  │
│     state/jev-*.key      per-daemon provider key (0600,           │
│                          write-only; status reports hasKey only)  │
│     state/supervision.json                                        │
│                          opt-in supervision defaults + per-Lead   │
│                          routes (0600, sha256 CAS; one writer)    │
│     state/supervision-cases.json                                  │
│                          bounded metadata ring written by the     │
│                          observer (≤200/30d — no bodies)          │
│     state/supervision-deliveries.json                             │
│                          notify attempts, written before each     │
│                          send (≤200/30d — no bodies)              │
│     state/peer-pool.json the user-scope Peer pool — catalog-      │
│                          shaped, written whole-file under a       │
│                          sha256 CAS; sole writer is the Peer      │
│                          pool card (a repo's own                  │
│                          .paseo-slp/slp-routing.json wins)        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

The plugin is a **manager**, not an agent feature. It exposes a small set
of administrative operations (`status`, `activate`, `reconcile`,
`deactivate`, `local-target`, `catalog`) that a human drives from the SLP
sidebar. Agents never see these. Activation writes the provider entries
(up to twelve — all twelve without routing; the chosen supervisor/lead
combos plus all four peers when `role-routing.json` is set) and 2 profiles
into `config.json` atomically through `config.patch`,
materializes the SLP payload into an immutable `slp-runtime/<sha>` tree,
and records a receipt. Nothing changes on the daemon until a human
explicitly activates.

Two saved profiles are the only doors in: **SLP Supervisor** and **SLP
Lead**. Peers never get saved profiles — the Lead chooses a peer provider
per task from the routing pool: a repository's `.paseo-slp/slp-routing.json`
when pinned, else the user-scope `state/peer-pool.json` above. Either scope
is what lets one project mix e.g. a Codex Lead with Devin peers.

## Two lifecycles

Everything above is the **control plane**: it runs when a human clicks,
and it only ever touches `config.json` + `slp-runtime/`.

The **runtime plane** is what those config entries do afterwards, every
time an agent is created. Since Phase 2 there are two transports — both
render the same `roleBundle()` bytes from the same candidate:

```
hook families (codex / pi / claude) — thin alias + hooks

human or agent calls create_agent(profile/provider, prompt)
        │
        ▼
agent.create before-hook (plugin) reads the binding, resolves the role
from the slp-* provider id (or the slp_role feature marker), re-verifies
the published candidate (cached once per candidate sha per process —
transitively covers the gate bytes the launcher is about to exec),
renders roleBundle() from the materialized candidate and writes
config.systemPrompt — role bytes first, any pre-existing prompt appended
        │
        ▼
agent.session_open before-hook overlays a non-empty
SLP_SESSION_OPEN_GRANT onto the provider env
        │
        ▼
provider entry command: <launchers>/<sha>/slp-<family>-<role> <argv>
        │  generated gate launcher exports the frozen SLP_FAMILY_BIN
        │  and execs <candidate>/bin/slp-gate.mjs under the frozen Node —
        │  gate verifies the grant is live — fails closed in a hook gap —
        ▼  then execs the real family binary
provider session begins with SLP instructions already in its
durable context


devin — shim + role wrapper (unchanged)

human or agent calls create_agent(profile/provider, prompt)
        │
        ▼
Paseo resolves the slp-devin-* provider entry
        │
        ▼
launcher process starts  ── env: SLP_MANAGED_RUNTIME, SLP_NODE_BIN,
        │                      SLP_RUNTIME_ROOT, SLP_DAEMON_HOME
        ▼
slp-shim verifies the runtime payload (manifest digest + identity)
        │
        ▼
role wrapper renders the role bundle and rewrites the session/new
request — this is the injection — then starts the real provider
transport (ACP)
        │
        ▼
provider session (devin) begins with SLP
instructions already in its durable context
```

Devin keeps the wrapper transport because its ACP adapter drops
`systemPrompt` outright — the hook path cannot reach it (Phase 0 probe,
2026-09-19). For hook families the plugin is in the loop at session entry
via the two before-hooks, but never afterwards — no proxy, no monitoring
daemon, no session interception. The gate is what makes a hook gap (plugin
disabled or reloading) fail visibly instead of spawning an unroled seat.

Fail-closed reaches further than the gap case: the hooks and the gate are
active from the moment the plugin is installed, so any `slp-*` create is
aborted while no binding exists — a plugin that is installed but never
activated, or whose activation failed, rejects every `slp-*` spawn rather
than producing an unroled seat. The `slp-*` providers only appear in the
config once activation writes them, so in practice this only bites when a
config outlives its binding (e.g. a restored or hand-edited config).

## The hidden channel

A seat's context arrives through **two channels**, and only one is visible
in the UI:

1. **`initialPrompt` — visible.** Whatever the spawner passes to
   `create_agent`: the human's typed text for profile-pick spawns, or the
   planner's assignment block for `prepare`-rendered spawns.
2. **Session-entry injection — hidden.** Bytes appended to the provider's
   durable instruction channel while the session is being built — by the
   `agent.create` hook's `systemPrompt` write for codex/pi/claude, or by
   the role wrapper's `session/new` rewrite for devin. The seat sees it;
   the human does not — it never appears in the agent tab, the
   conversation view, or `initialPrompt`.

```
what the human sees              what the seat's context contains
┌─────────────────────┐          ┌──────────────────────────────────┐
│ initialPrompt:      │          │ SLP role=supervisor              │
│ "điều tra repo X,   │          │ common policy                    │
│  report về <id>"    │    +     │ supervisor role contract         │
└─────────────────────┘          │ delegation rules                 │
                                 │ managed runtime helpers          │
                                 │ communication language (if set)  │
                                 │ spawn kit (MCP signatures)       │
                                 │ policy locators (path + sha256)  │
                                 └──────────────────────────────────┘
                                    ^ injected at session entry — hook
                                      systemPrompt or role wrapper —
                                      invisible in UI
```

For the Devin (ACP) transport this lands in `appendSystemPrompt`; each
family has its own durable channel. The daemon's own global
`daemonAppendSystemPrompt` still applies too — separate owners, both reach
the session.

Why this design: the carrier used to live inside `prepare`-emitted
`initialPrompt`, which meant it was *visible but only existed on the
prepare path* — a profile-picked spawn silently lost its spawn kit and
policy locators. Moving the carrier into session entry makes it
*guaranteed on every `slp-*` launch but invisible*. The trade-off is
deliberate: correctness over transparency-by-default. Verification paths
exist — spawn a probe seat and ask it to enumerate its injected sections,
or render the bundle offline via `roleBundle()`.

What each spawn path puts in the visible prompt:

| Content | `prepare` spawn | Profile-pick spawn |
|---|---|---|
| Role instructions | hidden (injected) | hidden (injected) |
| Spawn kit + policy locators | visible in emitted prompt | hidden (injected) |
| `Launch binding:` record | visible | absent — shim cannot read profile fields |
| Structured assignment | planner-built | whatever the human types |
| Title (`Supervisor — <task>`) | planner-built | human-typed |

## The delegation loop

SLP orchestration is just Paseo primitives used in a disciplined order:

```
Human ──create_agent(profile=slp-supervisor)──▶ Supervisor seat
                                                    │ runs `prepare`
                                                    │ (renders title,
                                                    │  assignment,
                                                    │  binding, kit)
                                                    ▼
                              create_agent(provider=slp-*-lead)
                                                    │
                                                    ▼
                                              Lead seat ──prepare──▶
                              create_agent(provider=slp-*-peer, disposition)
                                                    │
                                                    ▼
                                              Peer seat ──handback──▶ Lead
                                                    │
                                              Lead ──handback──▶ Supervisor
                                                    │
                                              Supervisor ──▶ Human
```

`prepare` is the standalone planner: given a request (role, family, repo,
assignment, report-recipient), it emits the complete `create_agent`
argument record — correct title format, structured assignment, launch
binding, workspace. Orchestrating seats are instructed to route every
spawn through it, which is what keeps the chain consistent when humans
aren't in the loop. The spawn kit in each injected bundle is what lets a
seat call `create_agent`/`send_agent_prompt` without first paying the
MCP schema-discovery tax.

Peers return results by prompting the agent ID named in their assignment
(`report-recipient`) — Paseo agent messaging, no special channel.

Coordination is event-driven, not polled: a seat confirms a spawn
started, then waits for the finish notification or the handback rather
than re-reading timelines to "feel like it is managing". A heartbeat is
the safety net for the one case events cannot cover — a silent stall
produces no finish — and it is an ordinary host primitive, not package
machinery: the observing session calls `create_heartbeat` with a cron
and a prompt on itself, each fire wakes that same session for one
bounded inspection pass over material deltas, and the owner deletes it
at settlement (required bound: max runs and/or expiry, recorded
receipt). This is what discharges the policy's observation rule — an
observer may not end a turn with delegated work outstanding and no wake
path: the finish notification is the primary path, the bounded
self-wake the recorded fallback, and when the host cannot wake a
session (`create_heartbeat` requires an agent-scoped session) the gap
is reported — or the dependent work marked BLOCKED — rather than filled
with invented machinery. The monitoring reference owns the rules once
the choice is made; cadence and stop conditions belong to the protocol
or the assignment, and there is no monitoring daemon.

## Ownership, state and recovery

The plugin treats the daemon home as something it borrows, not owns:

- **Receipt** (`slp-runtime/state/receipt.json`) records what the plugin
  believes it owns: which target, which binding hashes, which baseline.
- **Exclusive window**: mutating RPCs require the caller to assert that no
  other writer is touching the daemon home; concurrent operations get
  `BUSY` rather than a silent interleave.
- **Journal**: an operation's intent is persisted before its effects
  complete, so a crash mid-activate leaves a resumable intent instead of
  silent drift.
- **Reconcile**: `inspect` reports divergence between receipt and live
  config; `complete` finishes an interrupted operation; `restore-before`
  rolls it back. Foreign drift is reported, never auto-overwritten.

Deactivation detaches the owned provider/profile entries and restores the
shared MCP flag — but retains all runtime files, because live sessions may
still be executing from them.

## Boundaries

- The plugin installs and manages; it does **not** orchestrate. No
  agent-facing tools, no `create_agent`, no delegation logic.
- Jev is an explicit helper primitive, not an agent feature: the
  `route-decide` CLI is the only CLI call path (no loops, schedules or
  prepare-time calls), its key lives in per-daemon state, and routing
  stays deterministic — prepare verifies the receipt offline and fails
  closed on any config/transport/validation error. The plugin-side
  supervision observer is the second consumer: it runs only with
  `capabilities.supervision` on and for Leads the Human opted in through
  `state/supervision.json` (explicit routes, or daemon defaults for
  discovered SLP Leads). A serialized queue assesses Peer handbacks and
  persists metadata-only rings; missing evidence becomes `unknown`, never a
  violation. Its only action is `notify`: one code-generated review prompt
  per finding to the verified Supervisor recipient — it never creates,
  reassigns or cancels agents, accepts work or edits artifacts.
- No background watchers — status is computed when asked. The single
  exception is the opt-in observer above: event-driven from lifecycle hooks,
  with timers only for its own cases (the delivery checkpoint, expiry, and a
  bounded backoff re-check while a notify recipient is busy), writing only
  its bounded metadata rings. On the client, the supervision bell re-reads
  the stored notify recipients every 60 s while the app runs — a cheap
  status RPC, not a daemon-side watcher.
- The Supervisor/Lead/Peer intelligence is **policy text + Paseo
  primitives**, not code in the plugin. The plugin's correctness job ends
  at "the right bytes reach the right session through the right channel."
