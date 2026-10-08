# Operations

Day-to-day reference for running Paseo SLP: activation, upgrades, removal,
profiles, repository setup, the Peer pool and the optional capabilities.
The [README](../README.md) is the short tour; command details live in
[cli.md](cli.md).

## Requirements

- Paseo `>=0.10.3` with `pluginsEnabled: true` in the daemon's
  `config.json`.
- A POSIX daemon host (Linux/macOS) with Node 22.x from 22.18, or Node 23.6+
  (the plugin resolves a stable ordinary Node —
  not the Electron binary — at activation).
- The Codex/Pi/Devin/Claude CLIs matching the provider families you want to
  use, plus each family's credentials on the daemon host.
- Pi needs repeatable `--append-system-prompt` support (the tested Pi build
  has it).
- The daemon's effective `mcp.enabled` must be `true` for activation.

## Installation sources

The pack ships as a Paseo plugin. Install it on the daemon that runs the
work:

```bash
# From the repo — the plugin lives in the repo's plugin/ subdirectory:
paseo plugin install duongvm57/paseo-slp-plugin:plugin

# Pin to a specific release:
paseo plugin install duongvm57/paseo-slp-plugin:plugin --ref v0.2.0

# From a local checkout (development):
paseo plugin install /absolute/path/to/paseo-slp/plugin
```

`duongvm57/paseo-slp-plugin` is GitHub shorthand; the source argument takes
anything `git clone` accepts, including a full HTTPS/SSH URL or
`file:///absolute/path/to/paseo-slp` for a local clone. The `:plugin` suffix
selects the subdirectory. Without `--ref` the plugin follows the default
branch and `paseo plugin update` pulls newer commits; pass `--ref` with a tag
from [Releases](https://github.com/duongvm57/paseo-slp-plugin/releases) to
pin a specific version instead — tags and commits pin, branches move. The
daemon checks out
the ref into a managed directory under `$PASEO_HOME/plugins/paseo-slp/<id>/`
and runs the manifest's `build` step (`npm install` inside `plugin/`) before
loading it. Verify with `paseo plugin ls` — the plugin should reach
`running`.

Installing registers the plugin; it does not change your agent
configuration yet. Activation is a separate, explicit step (below). The
plugin manages the runtime installation and host configuration.

## Activation

Open **SLP** in the sidebar (or "Open SLP manager" from the command palette) —
or call the `activate` RPC. The surface asks for the daemon home to manage,
confirms the host/home mapping, and
requires the exclusive administrative edit window: while an operation runs,
no other writer should edit `config.json` — the plugin verifies this
precondition and reports conflicts rather than racing.

Activation:

- Materializes the embedded payload to
  `<paseo-home>/slp-runtime/<candidate-sha256>/` — immutable per release.
- Resolves stable Node plus the five provider-family executables (real
  `--version` probes; unresolved families fail closed).
- Writes launch shims under `slp-runtime/launchers/<launchset-sha256>/` —
  the stable paths the providers reference, so runtime swaps never break
  running sessions.
- Patches `config.json` with up to fifteen providers
  `slp-{codex,pi,devin,claude,opencode}-{supervisor,lead,peer}`, the two saved
  profiles **SLP Supervisor** and **SLP Lead**, and enables MCP injection.
  Saved role routing generates only the chosen Supervisor/Lead providers
  and all five Peer providers; absent routing keeps all fifteen.
- Records a receipt in `slp-runtime/state/receipt.json` — the journal of
  every operation, used for drift detection and recovery.

The surface's **Inspect** button is read-only — use it to inspect state
(`INACTIVE`/`ACTIVE`/`RECOVERY_REQUIRED`), the current binding, family
availability and conflicts before changing anything.

- No agent is created during install or activation. The three roles stay
  intact.
- **Peers need no saved profile** — the Lead picks each Peer's runtime from
  the Peer pool (the user-scope `slp-runtime/state/peer-pool.json`, or a
  repo-pinned `.paseo-slp/slp-routing.json`).
- Repos keep their tactics in `.paseo-slp/workspace-protocol.md`; onboarding
  guides you through both files.
- If a pre-existing entry owns an SLP provider/profile ID, activation fails
  with `COLLISION` and leaves it untouched — `adoptIdentical` only adopts
  entries that already match exactly.
- If raw and live config disagree, or an owned entry was modified outside
  the journal, the state moves to `RECOVERY_REQUIRED`; run **Reconcile →
  inspect** to re-verify and resolve before retrying.

## Getting started

Setup is one-time; per task only steps 4–5 repeat.

1. Install and activate the plugin ([Installation sources](#installation-sources), [Activation](#activation)).
2. Set explicit Supervisor/Lead models in **SLP → Role profiles**, save and
   apply them with the activation action ([Agent profiles](#agent-profiles)).
   Prepare suitable enabled options in the shared **Peer pool**, or choose a
   repo-pinned pool during onboarding. Optional, once: the **Communication language** card
   sets the language managed seats use for everything they write to each
   other — prompts, reports, handbacks, briefs between agents and the
   notebook. Direct replies to you
   still mirror your current conversation language. Toggle on, enter e.g.
   `English`, Apply — the value
   lives in plugin state, is injected into each new session, and needs no
   re-activation. Leave it off and each model follows the prompt's own
   language; nothing is injected.
3. Initialize each work repo once and onboard it (below).
4. Per task: **New agent** in the repo's workspace → profile
   **SLP Supervisor** → title `Supervisor — <task>` → an objective:

   ```text
   <task — e.g. fix bug A, add feature B, review change C>
   ```

   e.g. a long task that also asks for a heartbeat — the safety net that
   periodically wakes the Supervisor to check on a stalled team:

   ```text
   Migrate the billing module to the new API. Report back with verdict
   and the checks you ran.
   Heartbeat: sweep every 30m until handback.
   ```

5. Send, then keep chatting in that session — it is the whole interface.
   The Supervisor asks there when it needs you and reports the outcome
   there when the work settles.

   Behind the prompt, the seat already carries its role contract,
   delegation rules and spawn kit (see
   [Plugin architecture](architecture.md)): it observes or creates a
   Lead, and the Lead picks Peers from the repo pool. You never name the
   child seats — they are ordinary Paseo agents you can open if curious.

A few optional prompt lines are cheap insurance, not requirements:

- `Repository:` — the seat resolves the repo itself from its workspace;
  include the line when the session's workspace may not be the target, or
  the task spans repos.
- `Report back…` — the handback has nowhere else to go; the line marks
  the prompt as a bounded assignment with a deliverable rather than an
  open conversation, so an idle seat reads as "waiting on the Lead", not
  "done".
- `Heartbeat:` — e.g. `Heartbeat: sweep every 30m until handback` — asks
  the Supervisor to arm a bounded task-local wake on its own session per
  its monitoring reference. Naming cadence and bound up front avoids a
  follow-up prompt once the team is running; leave it out for short work —
  the protocol default is no heartbeat.

**SLP Lead** also works when you want to hand work straight to a Lead —
same flow, one less layer. Supervisor and Lead already carry the
procedures for picking child profiles, keeping parentage and using
finish notifications.

## Upgrading

How an update reaches the daemon depends on how the plugin was installed —
`paseo plugin ls` shows the source kind per plugin.

**Git source following the default branch** — installed as
`paseo plugin install duongvm57/paseo-slp-plugin:plugin` without `--ref` —
updates through Paseo:

```bash
paseo plugin update paseo-slp          # review and apply
paseo plugin update paseo-slp --check  # show available updates without installing
paseo plugin update paseo-slp --yes    # apply without asking
```

The daemon fetches the source, builds the checkout and reloads the plugin.

**Git source pinned to a ref** — installed with `--ref v0.2.0` — stays on
that tag or commit; a plain `update` has nothing newer to offer because the
pin does not move. Pick the new ref explicitly:

```bash
paseo plugin update paseo-slp --ref v0.3.0
```

**Directory install** — `paseo plugin install /absolute/path/to/plugin` —
points at that checkout instead of a managed copy. New code lands when the
checkout itself changes (pull, merge, your own edits); rebuild and reload to
run it:

```bash
paseo plugin reload paseo-slp
```

Reactivating rebinds the current candidate and rebuilds its launchers. Running
sessions keep their provider process until they finish; launch shim paths stay
stable across candidates. Rebinding is idempotent: a repeat activation is a
`no-op` when the candidate, configuration and resolved Node/provider
executables (paths, versions and availability) are unchanged.

Family binaries follow verified stable CLI aliases from the daemon's PATH.
Codex, Pi, Devin, Claude and OpenCode updates behind those aliases reach future managed
launches without changing SLP's provider entries. The model picker refreshes
the host's provider catalog when it loads or opens. An older SLP binding that
stored a versioned binary path needs one reactivation to move onto the alias;
an administrator-supplied direct release path intentionally pins that
activation. Saved Supervisor/Lead choices and Peer pool model IDs remain
Human-controlled; discovering a new model does not select it automatically.

## Deactivation and removal

**Deactivate** (Settings → SLP screen, or the `deactivate` RPC) detaches the
pack: it removes its managed providers and two profiles and restores the MCP
injection flag to its pre-activation value, while preserving everything else
in `config.json`. Runtime files, launchers and the receipt are **retained**
under `slp-runtime/` so in-flight sessions keep working — deactivation never
deletes them. A changed MCP `enabled` value or a managed entry modified
outside the journal blocks deactivation instead of being silently
overwritten.

After deactivation (or for a fresh install that never activated), remove the
plugin registration with:

```bash
paseo plugin remove paseo-slp
```

`remove` deletes the plugin configuration only — it never touches
`slp-runtime/`, `.paseo-slp/` repo state, or the managed checkout.

## Skills

The onboarding skill teaches your agent how to set up this pack for a repo.

```bash
npx skills add duongvm57/paseo-slp-plugin --skill paseo-slp-onboarding
```

- `paseo-slp-onboarding` — inspects the repo and recommends a protocol
  with assignment, execution and delivery settings. External connectors and pull
  automation belong to the repo harness. Product work, tracker
  tasks and controlled data changes share that protocol; Lead chooses workflows
  per task. Separate Leads are optional when authority or capacity requires them.
  It asks for missing decisions, shows the complete proposed diff, and
  configures the Peer pool within setup authority. A fully custom process
  gets a deeper interview. Once installed it auto-triggers when you ask an
  agent to onboard/set up SLP.

(`paseo-slp-e2e` is not installed — it runs from a source checkout; see
[E2E](development.md#e2e).)

No skills installed? Paste this into any agent:

```text
Help me understand and set up Paseo SLP. Read
https://raw.githubusercontent.com/duongvm57/paseo-slp-plugin/main/docs/agent-guide.md
first, then walk me through it step by step.
```

## Agent profiles

To set per-role model and reasoning:

1. Activate the plugin first, then open **SLP → Role profiles**.
2. For **Supervisor** and **Lead**, choose the family, an explicit **Model**,
   **Thinking**, **Mode** and features where the provider offers them.
3. Choose **Save**, then run the activation action again (**Re-verify binding**
   or **Rebind**) to apply the saved routing. Save changes the routing file;
   it does not activate or rewrite the live profiles. The card reports when
   stored choices differ from the live binding.
4. When creating a session directly, pick the saved profile in the model
   picker. For Peers, use onboarding to set up the repo pool; the Lead picks
   a suitable option from the pool and passes that provider/model/settings
   into `create_agent`.

**Thinking** is reasoning effort; **Mode** is the permission/approval level —
two separate settings. Pick values the provider/model actually offers. Agents
use `list_profiles`, `list_models` and `inspect_provider` for discovery; the
profile's `thinkingOptionId` is passed through as
`settings.thinkingOptionId` when creating the agent.

Set explicit models before delegation; fresh profiles have no model, and Devin
bindings require `swe-2`. Applying role choices affects future launches; it
does not update a running session. Paseo's **Settings → the host running the
work → Agents → Agent profiles** also exposes the live profiles; the Manager's
stored role routing drives the next activation. For a live session, Paseo
offers `update_agent` to change
model/thinking within the same provider when supported. The profile keeps its
own default for future sessions. See
[Paseo agent profiles](https://paseo.sh/docs/agent-profiles.md).

## Repository setup

Initialize each work repo once. The CLI lives inside the materialized
runtime — the active binding's `runtimePath` from the SLP screen/status is
`<paseo-home>/slp-runtime/<candidate-sha256>`:

```bash
SLP_RT="$HOME/.paseo/slp-runtime/<candidate-sha256>"
node "$SLP_RT/bin/slp.mjs" init /absolute/job-repo --apply
```

Init only creates missing files and never overwrites existing ones:

- `.paseo-slp/workspace-protocol.md`: operating procedure, risk levels,
  proof gates, budget and fallback authority.
- `.paseo-slp/notebook.md`: the default Supervisor notebook; the protocol
  records its owner and the actual retrieval method (this file or
  `timeline:<agentId>`).

Init writes no routing catalog. While a repo has no
`.paseo-slp/slp-routing.json`, the runtime reads the plugin-owned user-scope
pool `$PASEO_HOME/slp-runtime/state/peer-pool.json` (default `~/.paseo`) —
the SLP Manager's Peer pool card is its sole writer, seeding seats from an
archetype list and taking model/mode values from the live provider catalog.
A repository catalog is a deliberate pin, created only by
`init --routing-from` (below).

### Onboarding

The onboarding skill is installed separately so agents can auto-trigger it.
From a repo you want to use, install it project-locally (creates
`.agents/skills/paseo-slp-onboarding`, committable with the repo):

```bash
npx skills@latest add /absolute/path/to/paseo-slp \
  --skill paseo-slp-onboarding --copy --yes
```

Or install it globally for all of the user's repos:

```bash
npx skills@latest add /absolute/path/to/paseo-slp \
  --skill paseo-slp-onboarding --global --copy --yes
```

Once the package is published to GitHub, replace the local path with the
published URL/repository, e.g. `duongvm57/paseo-slp-plugin`. Use project
mode or add `--global` as above; pass `--agent <name>` to target one agent instead of
every detected one. Project skills land in `.agents/skills`, global skills
in `~/.agents/skills`; Codex and Pi discover both scopes directly, and the
installer also links them into each agent's own skills directory (e.g.
`.claude/skills`), so Claude picks them up the same way. Verify with
`npx skills@latest list` or add `--global` for user scope. Open a fresh session after installing, then
ask to onboard/set up SLP for the repo; the skill description triggers the
workflow. See the [source skill](../skills/paseo-slp-onboarding/SKILL.md).

Protocol and catalog are separate files: the protocol is operating guidance
and the JSON is machine-checkable routing data. Do not embed JSON inside
Markdown. The Lead reads both before every Peer delegation, chooses an option
by task and budget, then passes the relevant constraints into the assignment.
Each worktree reads its own configuration.

### Creating a repo-pinned catalog

To give a repository its own catalog instead of the shared pool, import a
catalog file once:

```bash
node "$SLP_RT/bin/slp.mjs" init /absolute/job-repo \
  --routing-from /absolute/path/to/catalog.json --apply
```

Import only creates a catalog when none exists; it does not overwrite, merge
silently or keep a link to the source file. Afterwards the Human edits the
repo copy — the plugin never writes repository catalogs. A repo with no
catalog reads the user-scope pool
`$PASEO_HOME/slp-runtime/state/peer-pool.json`; an empty catalog in the repo
is still authoritative (it blocks delegation, and keeps blocking even if the
shared pool is later emptied) until removed. A repo never reads
another repo's catalog.

## How the roles work

The protocol picks topology and proof gates by risk: a small task may use a
single Engineer; architecture/lifecycle-sensitive work gets an Architect, an
independent review gate or several lanes. The Peer role receives its disposition
through the assignment, independent of the runtime option. The Lead keeps
integration and technical acceptance; the Supervisor keeps observation and
relays Human decisions.

Supervisor/Lead prefer events first; a heartbeat is the safety net for what
events can't cover — a stalled seat never finishes, so no finish
notification ever arrives. Mechanically it is a scheduled wake-up the
observing seat sets on its own session (host `create_heartbeat`: a cron
plus a prompt); each fire wakes that seat for one bounded inspection pass
over the team's material deltas, then it returns to waiting — an alarm
clock for the observer, not a worker or a status poller. Every task
heartbeat is bounded: max runs and/or expiry, a recorded receipt, deletion
at handback or stop. Cadence and stop conditions belong to the
protocol/assignment — request one in the objective via the `Heartbeat:`
line above for long work. The installed references cover creating/removing
heartbeats on the right session, keeping a causal notebook, recovery and
the 20 anti-patterns from the guide. Roles read references per situation;
Peers receive the relevant constraints through assignments. This is a
policy pack for agents using Paseo primitives — there is no monitoring
daemon or semantic detector in the package; `monitor` (below) is a
caller-invoked, delta-only signal scan.

What the shim injects at session entry — and how to verify it reached a
seat — is documented in
[Plugin architecture](architecture.md#the-hidden-channel).

## Peer runtime pool

**Runtime sources:** Supervisor/Lead use the two saved profiles the Human
configures in Paseo. Peers use the repo pool `.paseo-slp/slp-routing.json`,
or the plugin-owned user-scope pool
`$PASEO_HOME/slp-runtime/state/peer-pool.json` when the repo has none — the
Manager's Peer pool card is its sole writer. Each option carries a
`pi`/`codex`/`devin`/`claude` provider, model, settings,
`suitableFor`, `avoidFor`, `notes` and an
`enabled`/`availability` state. The Lead chooses per task — Engineer,
Architect and Reviewer are not hard-mapped to models. Two Peers can differ in
provider/model/effort without any extra saved profile. The card's archetype
list shows the shape: each of the 12 standard seats names a kind of work and
carries the package's `axis:value` suitability tokens (reserved ids,
read-only on the form — see `docs/spec/routing-criteria.md`); custom seats
are free-form, and provider/`model` stay blank until picked from live
discovery on the host.

The Lead reads the current pool, records its choice rationale and validates
option/hash via `prepare` before launching (when Jev routing is armed, the
rationale trail is the receipt's recorded distribution instead — see
[Jev-assisted routing](#jev-assisted-routing-optional)). With no valid pool/option at
either scope, finish onboarding first; there is no fallback to `slp-peer`, to
the Lead's own settings, or to another repo's catalog.

### Peer quota fallback

Configure it in the pool (the Manager's Peer pool card, or
`.paseo-slp/slp-routing.json` for a repo-pinned pool):

```json
"quotaFallback": { "enabled": true, "optionId": "luna-code" }
```

`optionId` names one designated pool option — no list, no order. It must
exist in `options`; use the repo's real ID. By default (or when
misconfigured) a branch stops when its quota runs out. On a quota error the
Lead may make one retry on the designated option; `prepare` additionally
accepts `route.quotaFallbackFrom`, the ID of the option that ran out of
quota. Do not switch models outside the pool via `update_agent`, do not use
a provider default, and do not treat another model on the same account as
fresh quota. When the designated option is not viable or quota fails again,
report BLOCKED; keep ownership and evidence before handing off.

### Jev-assisted routing (optional)

Jev is a bounded decision primitive — TypeSafe's System One, served through
either provider kind: `openrouter` (the OpenRouter Decisions API with the
pinned model `typesafe/jev-1.13`) or `typesafe` (the first-party System One
API at `https://api.typesafe.ai/v1/systemone` with the pinned model
`jev-1.13.0`; `baseUrl` may point at a custom https endpoint/proxy carrying
an origin+path prefix). It is
**not** an ACP provider and never becomes an agent seat; it answers one typed
choice question over a caller-supplied state and returns a calibrated answer.
It runs only through the explicit `route-decide` helper — never in a
background loop, a schedule, or inside `prepare`.

Configuration is per daemon, via the SLP Manager's **Jev** card
(`<daemonHome>/slp-runtime/state/jev.json` + a write-only `jev-<kind>.key`,
0600 — `jev-openrouter.key` or `jev-typesafe.key` per the selected kind).
All toggles default off, evaluated at preparation time — toggling
never mutates running seats, and disabling keeps the stored key. Two modes:

- **Shadow** (`enabled` on, `capabilities.routing` off): `route-decide`
  emits a receipt but the Lead's own pick stays binding; `prepare` verifies
  the receipt and records both picks (`routing.jev.jevChoice`, `.declined`)
  in the plan.
- **Armed** (`enabled` and `capabilities.routing` both on): the receipt is
  required and binding — `route.optionId` must equal its choice.

Shadow evaluation precedes arming: run route-decide on each delegation,
prepare with the Lead's pick plus the receipt, and let the paired records
accumulate; the Human pre-registers exit criteria — agreement rate and the
asymmetric error class — and arms the capability only once the pairs satisfy
them. The toggle stays off until that data exists.

The flow in either mode: the Lead authors a routing `brief` (never raw
`assignmentFile` bytes) and runs `route-decide <request.json>`; the helper
computes the eligible candidate set deterministically — the same exclusion
tokens `prepare` enforces — plus an explicit `no-suitable-option` sentinel,
and emits `{optionId, catalogSha256, declined, warnings, decision}`. `prepare` takes
`route.decision` and verifies it offline (internal hash, pinned model,
catalog hash, candidate membership — plus answer match when armed); a
supplied receipt is verified even with Jev off. The receipt records the full
answer, probabilities and confidence — confidence is evidence, never a
routing threshold. Receipts prove consistency, not authenticity. In armed
mode the reason trail is that recorded distribution, not Lead prose; in
shadow mode the Lead's prose rationale still applies alongside the receipt.

Every failure is closed: missing config/key, an OpenRouter or TypeSafe
outage, timeout, empty eligible set, out-of-set choice or stale catalog hash
all refuse rather than guess. A decline emits its receipt and exits nonzero —
the pool is Human-owned, so escalate rather than retry. Controlled
degradation: while armed an outage blocks only the dependent delegation; the
Human disables the capability in the Manager card and Lead judgment resumes.

### Communication supervision (optional)

Supervision is a second opt-in capability, configured in the
**Supervision** section inside the SLP Manager's **Jev** tab
(`<daemonHome>/slp-runtime/state/supervision.json`, file schema 3, 0600, sha256
CAS). It is off by default — configuring Jev alone never enables
observation. The card has one **Supervision** switch (the Jev
`supervision` capability; turning it on shows what is sent and what it
costs first), then two plain choices:

- **Which Leads** — *All SLP Leads* (daemon defaults: every SLP Lead the
  plugin discovers, an exact `slp-<family>-lead` seen in a lifecycle event or
  verified by refresh; unchecked Leads are left out) or *Selected Leads*
  (one explicit route per checked Lead; an explicit route always wins over
  defaults). Leads are picked by name from the app's agent list. Each
  Lead's room stays separate.
- **When an issue is found** — *Record only* (`shadow`: assess and record) or
  *Record and alert a Supervisor* (`notify`: also prompt the Supervisor you
  pick from the list).
- **Advanced** — the daemon-wide confidence threshold (0.5–1, default 0.9)
  and the wait before alerting.

If the plugin cannot look an agent up when you save (seen live on host
0.9.1), the save still lands and the card says so; that Lead is watched
only once its next turn is seen in the expected workspace.

Each Peer handback is assessed as soon as it lands, through Jev's rubric-3
questions (obligations are per turn: a closure-only message such as an
accepted-and-closed notice needs only a fitting acknowledgment, while a bare
"ACK"/"Done" never answers a message that still asks for work): does the Lead's brief carry the obligations this task needs,
does the handback answer what was asked (complete/missing/failed/unverified,
ownership, blocker needs), and did the Lead's later communication dispose of
the obligation the handback raised — including through another Peer or an
escalation to the Supervisor, or `no_action_required` for an informational
result. The case is re-assessed when new confirmed messages arrive. A
handling disposition or mishandling must be linked by Jev to one specific
confirmed message the code offered; silence, acknowledgment or elapsed time
never becomes a finding. Findings are independent per axis and immutable:
a later message resolves a finding only when Jev links it as the specific
correction. The pending delay is a checkpoint — brief/handback findings are
delivered only after it, giving the Lead time to correct first.

The detector judges communication only — it never infers authority,
certifies artifacts, accepts work or mutates assignments, and a missing or
unverifiable input keeps that axis `unknown`. In `notify` mode a code-generated
alert ("Suspected communication issue — review required") with bounded,
untrusted excerpts goes to the route's Supervisor (or the default
recipient), at most once per finding and recipient. Before every send the
Supervisor is refreshed (exact SLP Supervisor, not archived, active) and the
route rechecked; a changed route cancels, never falls back. The attempt is
recorded before the send (a corrupt or unreadable attempt history blocks
delivery until repaired, never reset); a failure or timeout is reported
`notification delivery uncertain` and never retried. A running Supervisor is
not prompted — delivery waits until it is idle, but a prompt that lands as a
turn starts interrupts that turn (the SDK exposes no queue option). A bell
in the Supervisor's workspace offers **Open supervision settings** and
**Turn off alerts** (notify → shadow) through the same server-side CAS
writer.

External data and cost: shadow and notify send the brief, handback, the
Lead's confirmed post-handback messages to this Peer, to its other direct
Peers and to the Supervisor, and the Peer's confirmed sends to the
configured Jev endpoint; unconfirmed sends go as ids only. Each assessment
is a billable call (at most six per case). Provider coverage (per axis,
from real observed timelines): Codex, Claude Code and Pi — brief, handback
and Lead messages (Lead-role live runs not done yet); Devin — brief and
handback only, because the Devin provider emits no result for its sends, so
a Devin Lead's handling is never judged. A mixed room is judged per axis, never
blocked by one family. Upgrading to this coverage turns existing supervision
settings off until you re-save them in the Manager (Restore). The report route is not machine-readable on this host
(`report-route-unverifiable` is disclosed, not a gate). Open cases and the
queue are process-local: a restart does not replay missed turns; only the
bounded metadata rings survive (`state/supervision-cases.json` and
`state/supervision-deliveries.json`, ≤200 entries or 30 days, no bodies).
A schema-1 file from an earlier version reads with every route off until the
Human re-enables it — an upgrade never widens transmission or turns on
delivery. Live end-to-end validation and model evaluation have not run; see
[docs/spec/supervision-integration.md](spec/supervision-integration.md).

### Desk bridge availability

The `slp_desk` stdio MCP stays alive across plugin reloads and socket outages
while its stdin remains open. It reconnects over the Unix socket with backoff
capped at 1600 ms and repeats its pinned hello on every connection. A valid
persisted membership handle can reconnect after plugin restart; all five
dispatch guards still run. Windows remains a `CAPABILITY_GAP`; there is no TCP
fallback.

At startup stdin stays paused until the first positive hello ACK, so an
immediate MCP `initialize` waits in the pipe and receives the real reply.
Startup holds for up to 11500 ms even when the socket is absent or refusing
connections. Dials and transient hello failures retry throughout that budget
with 100/200/400/800/1600 ms backoff; the last delay repeats. Each hello is
bounded by 10000 ms and the remaining startup budget. Only budget expiry or a
permanent hello rejection (invalid record, pin mismatch or authority refusal)
releases held requests as typed errors; reconnecting continues while stdin is
open.

After a socket drop the relay holds unsent requests for 700 ms, the first
three backoff delays (100+200+400 ms). This window starts at the drop and is
never renewed by another dial. An ACK within the window forwards held
requests in order. After expiry, held and arriving requests receive JSON-RPC
errors with `error.data.slpCode: CAPABILITY_GAP` until connected. Expired input
keeps that error disposition if a late ACK arrives behind stdout pressure. Holding
pauses the source and preserves the splitter remainder under existing buffer
bounds. A request accepted by the old socket but left unanswered receives
`EXECUTION_UNKNOWN` once: it may have executed and is never replayed
automatically. Inspect the durable desk result before deciding whether another
request is warranted. EOF ends the relay after held input and stdout flush.
During a hold, stdin destroy/close is terminal: the relay exits without
answering held bytes because the stdin reader is gone; previously accepted
stdout writes still flush. A vanished stdout is terminal. Raw lines remain
capped at 262144 bytes in
both directions, flow control persists, and stderr diagnostics stop after 32
records. Outstanding request IDs are bounded to 4096 entries/1 MiB; excess
requests receive a typed capacity error rather than growing memory.

The stable root must be owned by one PID namespace. Sharing it across PID
namespaces, including separate WSL distros or containers, is unsupported:
ESRCH is namespace-relative and cannot establish another namespace's holder
liveness. This is an explicit deployment assumption, not a detectable guard.

After an unclean daemon exit, plugin startup automatically recovers only its
reserved bridge lock when ESRCH or a recorded Linux/WSL boot/start identity
mismatch proves the old holder dead. Recovery uses the same serialized,
fsynced pre-unlink audit as operator recovery, with actor `plugin:desk-bridge`,
then competes for the lifecycle lock with `O_EXCL` before binding `desk.sock`.
A live holder, unreadable lock or uncertain identity stays untouched. Hosts
without a process-start probe use ESRCH only; a live PID in an old-format lock
cannot prove PID reuse from its nonce or wall-clock timestamp alone.

If the plugin dies after creating `recover.lock` but before cleaning it up,
a later start can report `recover-lock-orphan` and `RECOVERY_REQUIRED`. This
also applies to the automatic recovery path: it never removes an orphaned
`recover.lock` itself.

The operator recovery route is `node bin/slp.mjs desk-recover --bridge` under
maintenance authority and the selected isolated/served `PASEO_HOME`. If it
reports `recover-lock-orphan`, inspect that reserved namespace's `recover.lock`
and remove it manually only after confirming no recoverer is running, then
rerun the command. Operator recovery remains ESRCH-only and may also refuse
holder uncertainty. Repository transaction locks retain operator-only
recovery. Local restart fixtures do not establish live daemon or provider
acceptance.

### External work state

Use [the repository desk](work-coordination.md) for registered assignments,
briefs, scopes, review and candidate/check evidence. External trackers and
project-specific automation belong to the workspace/harness; they do not
supply desk authority or discharge review obligations.

The plugin does not expose a tracker card, tracker RPC or tracker probe, and
adds no tracker prompt or environment settings. Existing tracker data and
legacy settings are retained without being consulted. New managed sessions use
the current bound runtime; retained candidates and already running sessions
keep their original bytes until an authorized update and handoff.

## Lead provider handoff

To choose Pi for future Lead sessions, change the **SLP Lead** profile's
provider, model and available settings, Save, then apply the binding action
the Manager offers. Existing sessions retain their provider and instructions.
Changing model/thinking within one provider can use `update_agent`, subject
to provider capability.

For an active registered assignment, use the [planned continuity
procedure](work-continuity.md): the current owner offers responsibility to an
exact receiving Lead membership, and that Lead reads the latest work and
accepts under revision checks. This keeps the assignment and its history;
it does not reparent Peers, stop the old process, settle resources or accept
the project. Check descendants, wake ownership and outstanding work as part
of the handoff account.

An unavailable owner without a usable prior offer cannot be replaced through
the native desk handoff. Preserve artifacts and report the authority gap;
a chat summary or claimed Human pointer does not grant fresh owner commands.
Human-authorized recovery may establish a separate bounded assignment, with
its scope and remaining obligations explicitly reconciled.

Automatic provider fallback requires an explicit budget/authority rule in
the workspace protocol. A quota error alone grants no provider-switch or
ownership-transfer authority.

## Agent naming

Agent naming uses `Supervisor — <task>`, `Lead — <task>` and
`Peer — <Disposition> — <task>`. For example `Peer — Engineer — checkout
totals` and `Peer — Reviewer — checkout totals` distinguish two jobs sharing
the Peer role. Pass `taskLabel` and `disposition` into `prepare`; with
multiple reviewers, add a scope to the taskLabel, e.g. `checkout totals /
API`. When omitted, taskLabel falls back to the repo directory name and the
disposition shows `General`. Resume keeps the name; a handed-off session adds
`Handoff`. The agent ID remains the identifier used for ownership and
reporting.
