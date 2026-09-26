<h1 align="center">Paseo SLP</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">An independent Supervisor–Lead–Peer role pack for Paseo.</p>

Install the plugin, activate it on your daemon, pick **SLP Supervisor** in
Paseo and hand it an objective. Role instructions load automatically; the
Supervisor observes an existing Lead or creates one per assignment, and the
Lead delegates to Peers through Paseo. You can keep chatting in the existing
Supervisor session — no need to re-enter the role prompt.

In addition to the prompt you type, each seat receives its role contract,
delegation rules, spawn kit, sha256 policy locators and managed runtime
helpers — injected at session entry and not shown in the agent tab.
Details in [Plugin architecture](docs/architecture.md).

## Why subagents are not enough

A subagent API solves process creation. It does not solve ownership,
independent judgment, coordination, or acceptance. In practice,
multi-agent coding commonly fails in these ways:

- Authority gradient: when a parent already presents the answer, the
  child tends to agree and optimize that answer instead of checking
  whether its premise is wrong.
- Perfect-plan trap: the coordinator pre-selects files, APIs, and
  lifecycle before implementation. The worker becomes a typing bot,
  while real dependencies surface late as compatibility patches.
- Attention dilution: when the coordinator also implements, debugs, and
  repeatedly explains local details, it loses the project-wide view of
  ownership, dependencies, and agent lifecycle.
- Unsafe parallelism: two agents can share one checkout and overwrite
  the same moving files. A workspace or agent ID does not provide
  filesystem isolation.
- Biased or stale review: a reviewer forked from the author inherits the
  same framing, while a reviewer reading changing files may approve a
  candidate that no longer exists.
- False completion: finished, idle, "done," and passing tests are
  signals—not proof that the right artifact was reviewed by the right
  authority.
- Split control planes: if workers create their own untracked workers,
  no single system knows who owns the task, workspace, correction, or
  cleanup.

More agents can therefore increase confidence and activity without
increasing correctness.

## Why SLP

Paseo already creates agents, workspaces, parentage and timelines — the
process-creation half. SLP answers the rest by separating *kinds of
judgment* rather than building a rigid `Supervisor > Lead > Peer`
hierarchy:

![Paseo SLP role model: Human owns intent, boundaries and final acceptance; a Supervisor observes the Lead's workflow without joining execution; the Lead coordinates the project and delegates bounded outcomes to independent Engineer, Architect, Reviewer and Scout Peers, which return evidence, challenges, dependency requests or blocked work; two optional Jev advisory instruments — a routing advisory tapping the delegation channel and a supervision assessment tapping the evidence-return channel — are never team seats.](docs/images/slp-role-model.svg)

- **Human** keeps owner authority: intent, important trade-offs,
  exceptional grants, protocol changes and final acceptance.
- **Supervisor** protects the quality of the workflow and reasoning —
  bias, repeated failure, lost momentum, drifting scope, weak evidence.
  It does not implement or accept the project.
- **Lead** owns framing, routing, dependencies, integration and the
  project verdict. It does not pre-solve difficult work and hand Peers a
  typing job.
- **Peer** is an independent co-worker owning one bounded outcome. It may
  challenge the premise, request a dependency or stop as blocked —
  disagreement is reconciled with evidence, not treated as disobedience.

Use this pack when those boundaries matter; for a small single-agent
task, a plain agent is simpler. The deep dive — role model, design
rationale, and how the plugin carries it on stock Paseo primitives — is
in the architecture doc linked above.

## Requirements

- Paseo `>=0.8.0 <0.10.0` with `pluginsEnabled: true` in the daemon's
  `config.json`.
- Node >=22 on the daemon host (the plugin resolves a stable ordinary Node —
  not the Electron binary — at activation).
- The Codex/Pi/Devin/Claude CLIs matching the provider families you want to
  use, plus each family's credentials on the daemon host.
- Pi needs repeatable `--append-system-prompt` support (the tested Pi build
  has it).
- The daemon's effective `mcp.enabled` must be `true` for activation.

## Installation

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
- Resolves stable Node plus the four provider-family executables (real
  `--version` probes; unresolved families fail closed).
- Writes launch shims under `slp-runtime/launchers/<launchset-sha256>/` —
  the stable paths the providers reference, so runtime swaps never break
  running sessions.
- Patches `config.json` with the twelve providers
  `slp-{codex,pi,devin,claude}-{supervisor,lead,peer}`, the two saved
  profiles **SLP Supervisor** and **SLP Lead**, and enables MCP injection.
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
stable across candidates. Rebinding is idempotent: activating the same
candidate twice is a `no-op`.

Family binaries follow verified stable CLI aliases from the daemon's PATH.
Codex, Pi, Devin and Claude updates behind those aliases reach future managed
launches without changing SLP's provider entries. The model picker refreshes
the host's provider catalog when it loads or opens. An older SLP binding that
stored a versioned binary path needs one reactivation to move onto the alias;
an administrator-supplied direct release path intentionally pins that
activation. Saved Supervisor/Lead choices and Peer pool model IDs remain
Human-controlled; discovering a new model does not select it automatically.

## Deactivation and removal

**Deactivate** (Settings → SLP screen, or the `deactivate` RPC) detaches the
pack: it removes the twelve providers and two profiles and restores the MCP
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

## Getting started

Setup is one-time; per task only steps 4–5 repeat.

1. Install and activate the plugin (above).
2. Optional, once: on the SLP surface, the **Communication language** card
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
   [Plugin architecture](docs/architecture.md)): it observes or creates a
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
[E2E](#e2e).)

No skills installed? Paste this into any agent:

```text
Help me understand and set up Paseo SLP. Read
https://raw.githubusercontent.com/duongvm57/paseo-slp-plugin/main/docs/agent-guide.md
first, then walk me through it step by step.
```

## Agent profiles

To set per-role model and reasoning:

1. Open **Settings → the host running the work → Agents → Agent profiles**.
2. Edit **SLP Supervisor** or **SLP Lead**.
3. Pick the matching `slp-codex-{role}`, `slp-pi-{role}`, `slp-devin-{role}`
   or `slp-claude-{role}` provider, then choose **Model**, **Thinking**, **Mode**
   where the provider offers them, plus features, then **Save**.
4. When creating a session directly, pick the saved profile in the model
   picker. For Peers, use onboarding to set up the repo pool; the Lead picks
   a suitable option from the pool and passes that provider/model/settings
   into `create_agent`.

**Thinking** is reasoning effort; **Mode** is the permission/approval level —
two separate settings. Pick values the provider/model actually offers. Agents
use `list_profiles`, `list_models` and `inspect_provider` for discovery; the
profile's `thinkingOptionId` is passed through as
`settings.thinkingOptionId` when creating the agent.

Editing a profile affects the next selection/launch; it does not update a
running session. For a live session, Paseo offers `update_agent` to change
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
workflow. See the [source skill](skills/paseo-slp-onboarding/SKILL.md).

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
[Plugin architecture](docs/architecture.md#the-hidden-channel).

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
(`<daemonHome>/slp-runtime/state/supervision.json`, schema 2, 0600, sha256
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
[docs/spec/supervision-integration.md](docs/spec/supervision-integration.md).

### Work tracker (optional)

The work tracker gives seats an optional durable work graph — beads
(`bd`), a per-repository issue database — so they query task state
(issues, assignees, dependencies, comments) instead of rebuilding it from
conversation, and read it back after resume or compaction. It is
evidence, never a control plane: Paseo alone owns lifecycle, parentage,
notifications and report routes; a claim or assignee grants no write
scope; tracker status never discharges a required review gate; a `closed`
status is a recorded claim, not acceptance proof.

Enable it on the SLP Manager's **Work tracker** card — the toggle writes
`<daemonHome>/slp-runtime/state/work-tracker.json` (atomic, 0600; an
absent file means disabled) and takes effect at the next session entry,
no re-activation. The card also reports the `bd` it detects on the daemon
PATH. **Detect, never install:** installing `bd` on the machine
(`brew install beads`, `npm i -g @beads/bd`, or upstream `install.sh`)
and initializing a repository (`bd init`) are Human actions — nothing in
SLP downloads, installs, initializes, upgrades or configures beads, and a
missing or broken tracker surfaces as a recorded gap, never a spawn
blocker.

When enabled, managed session entries gain a `Work tracker:` line naming
the policy reference `src/references/work-tracking.md` (boundaries, the
writers table — Supervisor owns the root issue, Lead owns children and
assignment, each seat owns status on its named issue — and procedure) and
the probe command below. Hook-family seats additionally receive the env
overlay `BEADS_ACTOR=slp-<role>-<agent id>` plus defaults
`BD_AGENT_PROFILE=conservative` and `BD_DISABLE_METRICS=1` (caller env
wins); Devin seats bypass that env path and attribute writes with
`--actor` per the reference. Disabled, absent or corrupt settings change
nothing else — a corrupt file is a surfaced gap line, and a disabled
render is byte-identical to a pre-feature one.

Full design, boundaries and the verify-on-real-`bd` checklist:
[docs/spec/beads-work-tracker.md](docs/spec/beads-work-tracker.md).

## Lead provider handoff

Switching a Lead to Pi when Codex runs out of quota: change the **SLP Lead**
profile's provider to `slp-pi-lead`, pick the matching model/thinking and
Save for later launches. To move work already running, tell the Supervisor:
"Codex is out of quota — move this Lead to Pi, keep the current scope and
hand off per the saved profile." The Supervisor checks the old Lead has
stopped orchestrating, collects state/evidence and creates a new Lead with
the same policy on Pi. If the old Lead cannot respond, the Supervisor pulls
state from the timeline/artifacts; no need to call the out-of-quota model
just for a summary. Without a Supervisor, the Human moves the handoff to a
new Lead session and confirms ownership.

This is a handoff to a new session: the host does not switch providers in
place and does not reparent Peers. The procedure preserves Peer
IDs/ownership, handles descendant access and wake sources; the new Lead takes
over after checking the handover state. If you want automatic standby
provider selection, record the fallback plus budget/authority in the protocol
beforehand; a quota error alone does not grant provider-switch authority.
Changing model/thinking within the same provider can use `update_agent`,
subject to provider capability.

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

## CLI reference

### `prepare` / `prepare-handoff`

The optional offline path: `prepare` accepts role, repository, workspaceId
and assignment. Supervisor/Lead additionally take the `profiles`/`providers`
inventory; a Peer takes `providers` and `route: {optionId, catalogSha256}`
from `routes`. Profiles may accompany a Peer request for discovery, but they
never replace the pool. Two more optional fields, both also honored by
`prepare-handoff`:

- `inventoryFile`: absolute path to a JSON object carrying
  `providers`/`profiles`; these arrays only fill request fields that are not
  inline — an explicit inline array (even `[]`) always wins. Generate it with
  `inventory --paseo-home <absolute-home>` (below); under a managed runtime
  its providers are `provenance: "configured"` and are refused as launch
  evidence — pass live `list_providers` output from the same daemon inline as
  `providers` instead.
- `assignmentFile`: absolute path to the full assignment brief (must exist,
  be a regular file and be readable). The prompt keeps `assignment` as a
  short brief and appends `Assignment file: <path> — read it first; it is
  authoritative for scope details.`; the file content is not inlined.

An option decides the whole bundle and maps to
`slp-pi-peer`/`slp-codex-peer`/`slp-devin-peer`/`slp-claude-peer`; a model containing `/` is
kept verbatim. An explicit `binding` without profiles only supports
Supervisor/Lead when the Human authorizes it. Peers must always pick a pool
option, including during handoff and recovery.

The plan also surfaces the spawn's intended mode — top-level `modeId`
mirroring `create.settings.modeId`, plus `warnings` when the binding lacks
one — and two locator payloads carried inside `create.initialPrompt` (the
prompt-side carrier is omitted only for a live-verified canonical role
wrapper, which injects it at session entry) so the spawned seat actually
receives them: `spawnKit`, role-scoped approximate
Paseo MCP tool signatures (verify against live `mcp_list_tools`), and
`orientation`, policy-byte locators (`path`, `bytes`, `sha256`, or
`missing` for receipt-declared files absent on disk; the set derives from
the install receipt, so source-only documents are never declared). Locators
only — interpretation stays with the seat.

`prepare-handoff <request.json>` adds the snapshot and handoff packet to the
create_agent arguments; see the
[handoff example](examples/provider-handoff.request.json).
Both commands only prepare arguments; Supervisor/Lead use Paseo to actually
create the agent.

Three modes support request authoring — all side-effect free:

- `prepare --schema` prints the request contract (required keys per role,
  binding sources, minimal examples with placeholders) straight from a source
  checkout — no request file, install receipt or daemon needed.
  `prepare-handoff --schema` adds the settlement-evidence fields.
- `prepare <request.json> --check` runs the planner's own validation stages
  and reports each named failure — missing profile/provider/model,
  incompatible settings, stale catalog hash — distinguishing a complete
  profile from a live-verified provider. Exits 1 when any stage fails; nothing
  is created.
- `prepare <request.json> --emit create` prints an audit artifact:
  `{ modeId, modeIdSource, create }` — `create` is exactly the `create` member
  (the create_agent argument record, untrimmed) for callers that pass it
  through directly, and the mode fields record the resolved mode plus its
  provenance so a saved emit file is self-describing. Note the host gap:
  Paseo has no plan-file consumer today, so pasting or parsing `create` into
  `create_agent` remains a manual mitigation with a cross-check — it does not
  eliminate the risk of an altered record reaching the host. `--out <path>`
  writes whichever result a command produced to a file — the response, never
  the request file.

A complete request carries: `taskLabel` (or the repo name is used), the role
(and `disposition` for Peer), the real `repository` path and `workspaceId`,
an `assignment` naming scope, authority, the report-recipient agent ID and
the verification/handback expectations, plus one binding source. For longer
briefs use `assignmentFile` — a separate file per seat, referenced read-first
rather than inlined. Before any create_agent call, Lead records why the chosen
topology (which seats, which pool options) fits the assignment — under armed
Jev routing that reason trail is the decision receipt's distribution, not
prose.

### `route-decide`

`route-decide <request.json> [--schema] [--out <path>] [--paseo-home <absolute-home>]`
is the only path
that calls Jev — see [Jev-assisted routing](#jev-assisted-routing-optional)
for what it is and when it applies. The request carries `repository`, an
optional `role` (default `peer`) and a Lead-authored `brief` — a nonempty
string of raw task/assignment text and the only task context Jev sees;
carry the task description, risk/effort signals, constraints and
dependencies — a starved brief drifts toward chance-level answers.
Structured forms are refused (`jev-request-invalid`): a `signals` field or
object/array let the caller pre-classify the task with Jev's own decision
vocabulary — inline the facts as prose instead. Standard `axis:value`
tokens quoted inside the text are flagged as unverified mentions in the
output `warnings`. Output is `{schemaVersion, optionId,
catalogSha256, declined, role, tokenConflicts, warnings, poolDrift, decision}`;
`poolDrift` plus a `warnings` line report any divergence between the
repository catalog and the live user-scope pool (advisory — the catalog
still binds, nothing is reconciled). Feed `optionId`/`catalogSha256`/
`decision` into `route.*` of a `prepare` request. A `no-suitable-option`
answer still prints its receipt but exits 1. The command fails closed before
any network when the daemon's Jev config or key is missing/disabled, and a
source checkout invocation needs a daemon home carrying that config (`--paseo-home`
or `PASEO_HOME`). `--schema` prints the request contract without a request
file or daemon; `--out` persists the response bytes, never the request.

### `routes`

`routes <repository> [--paseo-home <absolute-home>] [--out <path>]` prints
the repository's effective routing catalog — the same read `prepare`
validates against:

```bash
node "$SLP_RT/bin/slp.mjs" routes /absolute/repository [--paseo-home /absolute/paseo-home]
```

The repository catalog `.paseo-slp/slp-routing.json` wins when present;
otherwise the user-scope pool
`<paseoHome>/slp-runtime/state/peer-pool.json` is the declared fallback —
a malformed repository file is an authoring error, never a fallback
trigger. Output carries the catalog fields plus `path`, `scope`, `sha256`
and `tokenConflicts` — feed an option's `id` and the `catalogSha256` into
a `prepare` request's `route.*`. When the repository catalog wins while a
live user pool exists, `userPool` plus an advisory `poolDrift` report
evidence the two sources disagreeing (nothing is reconciled).
`jevRouting` reports the daemon's Jev routing mode for the resolved home —
`unconfigured`, `off`, `shadow`, `armed`, or `error` for a
configured-but-unreadable config — so a Lead sees whether a
`route-decide` receipt would bind, merely record, or be unavailable
before planning a delegation. `--out` writes the response bytes to a
file, never the request.

### `inventory` / `agents`

Two read-only commands support discovery and work offline (no daemon or
`paseo` on PATH required):

```bash
node "$SLP_RT/bin/slp.mjs" inventory [--paseo-home /absolute/paseo-home]
node "$SLP_RT/bin/slp.mjs" agents [--paseo-home /absolute/paseo-home]
```

`inventory` prints `{providers, profiles, source}` in exactly the shape
`prepare` consumes — the intended pipeline is
`inventory --paseo-home <absolute-home> > inventory.json`, then
`"inventoryFile": "/absolute/path/to/inventory.json"` in the request (see
[`prepare`](#prepare--prepare-handoff) above). It only calls `paseo provider ls --json` when the given
home's `paseo.pid` names a live process; otherwise it reads
`agents.providers` from that home's own `config.json` — it never takes
providers from another daemon and never creates directories. Under a managed
runtime (`SLP_MANAGED_RUNTIME=1`) the CLI listing is never invoked and every
provider is labeled `provenance: "configured"` — static config, refused as
launch evidence. Either way the inventory proves configuration completeness,
not provider health; a listed entry can be stale and is not a readiness
stamp. Live providers
are normalized to `{id, enabled, status}` (`enabled` may be `null` when the
state is unrecognized), while config yields `{id, enabled, extends}`;
profiles always come from `daemon.agentProfiles`. On multi-daemon hosts, the
live listing reflects whichever daemon the `paseo` CLI reaches. `agents`
lists `<home>/agents/*/<id>.json` as `{id, title, provider, cwd,
workspaceId, status, lastActivityAt, nativeHandle, attach}`; `attach` is a shell-quoted `cd
<cwd> && devin -r <nativeHandle>` hint for devin providers with a handle.
Because `paseo inspect`/`ls` do not return `persistence.nativeHandle`, this
command reads daemon persistence — a host detail, best-effort, not a
contract.

### `snapshot`

`snapshot <repo>` records a work snapshot covering HEAD, tracked/untracked
non-ignored paths, contents, symlinks, permission modes and deleted markers.
An untracked directory that is the root of a nested Git repo is snapshotted
recursively and recorded under `nested` (each sub-repo gets its own `{path,
head, sha256, files}` and may carry its own `nested`, all counted in the
overall sha256). Listed directories that are not repos remain unsupported.

An index gitlink (submodule entry, mode 160000) snapshots as
`{path, kind:"gitlink", indexOid, headOid, state}` — pointer plus observed
state, never a descent into submodule content. `indexOid` is the stage-0
index OID: the one staging-intent exception, because for a gitlink the index
entry itself is the identity object (no working-tree bytes represent the
pointer); regular files still hash worktree bytes only. A conflicted index
(stages 1–3) records `indexOid:null` and `state:"conflicted"` rather than
picking a stage. `headOid` is the submodule's own HEAD resolved read-only;
`state` is `missing`, `uninitialized`, `clean`, `dirty` or `conflicted`. Any
non-clean state adds the path to top-level `incomplete` — that submodule scope
is unproven content: `prepare-handoff` carries the list into the handoff
packet and tells the new seat not to claim full-candidate coverage for it.

### `materialize`

`.paseo-slp/` is per-repo operating state. A repository may commit
`workspace-protocol.md` and `slp-routing.json` (this one does) or keep the
directory gitignored — `notebook.md` stays untracked Supervisor state
either way. A fresh worktree can still lack the protocol: gitignored
files never travel with git, a committed copy may postdate the checkout,
and an older copy may carry absolute source-root paths in its frontmatter.
`materialize` clones the current files from an existing checkout:

```bash
node "$SLP_RT/bin/slp.mjs" materialize /absolute/target-repo --from /absolute/source-repo \
  [--include <repo-relative-path>]... [--paseo-home <absolute-home>]
# dry-run by default; add --apply to write
```

It copies `.paseo-slp/workspace-protocol.md`, and `.paseo-slp/slp-routing.json`
(validated) only when the source actually pins one — a source that never
created a catalog materializes the protocol alone, and the target resolves
the user-scope pool exactly like the source does. `.paseo-slp/references/`
— the operational facts the protocol points to — is copied recursively when
present (symlinks and non-regular entries are refused). `notebook.md` is
Supervisor-owned state and is never copied. Repeatable `--include` stages
extra repository-relative files verbatim — untracked spec or evidence the
seat must read; paths are validated before anything is staged (absolute,
drive-prefixed, backslash, `.`/`..`/empty-segment, NUL, `.paseo-slp`,
symlink and non-regular entries are refused), deduped by target path, and
preserved when already present. `--paseo-home` enables the advisory
catalog↔live-pool drift report on the result (`poolDrift`). Absolute
source-root paths inside
the protocol's YAML frontmatter are rebased to the target root (a longer
sibling path like `<source>-old` is not a boundary match and stays put). Like
`init`, existing target files are preserved rather than overwritten; each
file reports `preserved`/`applied`, plus `sha256` for files it would write.
The protocol entry also reports `rebased`, and a written copy that found no
source-root path carries a `warning` instead of silently keeping stale paths.
There is no fallback to the user-scope catalog or a package template — the
source checkout is explicit.

### `monitor`

`monitor` is an on-demand signal scan for an observing Supervisor/Lead —
one invocation is one scan, not a daemon, and it emits candidates, never
verdicts:

```bash
node "$SLP_RT/bin/slp.mjs" monitor /absolute/request.json
```

The request names `agents` (`id`, optional `cwd` — falls back to the state
file's `cwd` — and optional `scope` prefix/glob list), plus optional
`paseoHome` (default `$PASEO_HOME`/`~/.paseo`), `devinSessionsDb` (absolute
path, opt-in), `thresholds` (`idleMinutes`, `churnScans`; `toolWindow`
default 20, `toolShare` default 0.8 and `cadenceEdits` default 3 for the
sessions-db signals), a `signals` subset and a `stateFile` checkpoint path.
Evidence comes from `<paseoHome>/agents/*/<id>.json` and `git
status`/`git log` in each `cwd`; a missing or non-repo `cwd` is recorded as
an evidence gap instead of crashing. With `devinSessionsDb` it also probes
that devin CLI sessions db (read-only; typically
`~/.local/share/devin/cli/sessions.db`) for devin-provider agents; a missing
or unreadable db is a gap entry, not an error. Signal kinds: `attention`
(only when `requiresAttention` is true — a stale `attentionReason` is just
evidence), `follow-up-round` (user bumps without an intervening commit),
`idle-dirty`, `scope-drift`, `test-mirror`, `file-churn` (the same dirty
path edited again across scans, tracked by mtime), `tool-mix` and
`correction-cadence` (sessions-db candidates, require `devinSessionsDb`). With `stateFile`, only new
fingerprints are emitted and the checkpoint — the command's only write — is
rewritten atomically every run; without it the scan is flagged `stateless`
and emits everything detectable. Rendered `paseo logs` output is never
parsed; `get_agent_activity` returns only a curated, `limit`-bounded tail
(long sessions truncate into overflow files), so a complete structured
timeline stays a recorded host gap.

### `notebook`

`notebook` locates the governance notebook for a repository when the active
run lives in another checkout — a worktree Supervisor's record sits at
`<its-checkout>/.paseo-slp/notebook.md`, invisible from the main checkout:

```bash
node "$SLP_RT/bin/slp.mjs" notebook /absolute/repository [--paseo-home /absolute/paseo-home]
```

It resolves the repository's git common dir — the property linking a
worktree back to its repository — then lists Supervisor agents (provider
containing `supervisor`, or a `Supervisor`-titled state file) whose `cwd`
shares it. Output is candidates only: `{agentId, title, status, cwd,
lastActivityAt, notebook, notebookExists}` sorted by most recent activity,
plus `gaps` for agent cwds that fail the git probe. Read-only — it never
copies, merges or edits notebook content, and picks no authoritative
candidate; where governance lives stays per-checkout.

### `status` / `local-target`

The plugin's RPC surface (status, local-target, …) has no agent-facing
invoke path — `paseo plugin` is lifecycle-only and the paseo MCP exposes no
invoke tool (host gap H13). These probes recompute what local files can
prove and mark the rest as gaps, never guesses:

```bash
node "$SLP_RT/bin/slp.mjs" local-target [--paseo-home /absolute/paseo-home]
node "$SLP_RT/bin/slp.mjs" status       [--paseo-home /absolute/paseo-home]
```

`local-target` reports the daemon home this process would serve
(`--paseo-home` > managed binding env > `PASEO_HOME` > `~/.paseo`).
`status` reads `<daemonHome>/slp-runtime/state/` (receipt, role-routing,
communication-language) plus `config.json` and reports: receipt state,
binding summary, the managed profiles the activation injected, recorded
operation journal entries, and local checks — target match, bound-runtime
integrity (`verifyInstall` + recorded candidate hash), launcher byte hashes,
and a presence-only drift scan for the injected `slp-*` providers/profiles.
A missing receipt yields `INACTIVE`, or `RECOVERY_REQUIRED` when orphaned
`slp-*` config entries remain; a corrupt receipt/config fails closed instead
of guessing a clean state. Live-conflict recomputation and family
availability probes are daemon-only views and are reported under `gaps`.
Mutation RPCs (activate/reconcile/deactivate/set-language/set-role-routing)
stay Human-authority and are not exposed. These probes retire when the host
ships `paseo plugin invoke` or MCP `invoke_plugin_rpc`.

### `tracker`

`tracker <repository> [--paseo-home <absolute-home>]` is the read-only
beads probe — the command a managed session-entry line names when the
work tracker is enabled (see
[Work tracker](#work-tracker-optional)):

```bash
node "$SLP_RT/bin/slp.mjs" tracker /absolute/repository [--paseo-home /absolute/paseo-home]
```

It prints `{tracker, repository, enabled, state, bd, workspace, gaps}`.
`state` is `ready` (a working `bd` and the repository is a beads
workspace), `uninitialized` (no beads workspace in the repository) or
`unavailable` (no working `bd` on PATH); `bd` reports `{path, version}`
when found and `workspace` reports `{path, prefix, redirectedFrom}`.
Gaps are data — the command exits 0 even when the state is not `ready`,
and without `--paseo-home` the enablement setting is not read
(`enabled: null`). The probe runs `bd version` and `bd where --json`
with `BD_DISABLE_METRICS=1` forced, a 5 s timeout and a bounded buffer;
it never installs, initializes or repairs anything — a missing or broken
tracker is a gap to report, not a fault to fix.

## Testing

```bash
npm test
npm run check
```

Inside a managed session, isolate the suite from ambient runtime env —
`env -i HOME="$HOME" PATH="$PATH" PASEO_HOME="$(mktemp -d)" npm test`, or
unset the full `SLP_*` set (`SLP_DAEMON_HOME SLP_MANAGED_RUNTIME
SLP_RUNTIME_ROOT SLP_NODE_BIN`); a partial unset leaks the runtime into
the suite and fakes failures.

Local checks cover the manager's transaction/recovery logic, the
materializer, launch-shim generation, config preservation, protocol and the
stdio adapter; they do not prove role compliance with the operating guide.
The plugin has additionally been verified live on a real Paseo 0.8.0 daemon:
Git-source install, management surface, activate/deactivate/reconcile RPCs,
provider/profile patching, collision and drift refusals, and recovery
classification — see `.local-checks/` for the evidence ledger. Roles are
behavioral instructions, not a filesystem/MCP sandbox. The transport supports
Codex, Pi, Devin and Claude; routing, adapter and handoff have local checks.
Live provider switching, heartbeat, council and the full E2E manifest are
not yet E2E-accepted. Capability and policy-load paths are recorded in the
trace table below.

## E2E

To dogfood from an open session on this **source checkout**, ask: **"run the
package's full E2E"**. The [E2E skill](skills/paseo-slp-e2e/SKILL.md) walks
the session through the whole [scenario manifest](e2e/scenarios.mjs), using
child sessions on a real Paseo, collecting evidence, reviewing independently
and cleaning up, then returns one combined report. Granted permissions, host
and budget are reused; branches missing prerequisites are recorded BLOCKED.
`npm run e2e` only prints the session entrypoint (exit 2, does not run live);
the fixture/evidence/verdict subcommands are described in the
[E2E guide](e2e/README.md). This harness has no live acceptance yet; adding
the entrypoint does not change the unverified E2E states above.

To run a `basic-*` scenario, configure the two Supervisor/Lead
profiles and the fixture's Peer pool for the matching family. The coordinator
prepares fixture/protocol, pool and baseline; the Supervisor creates a Lead
per the saved profile, the Lead picks the Peer option itself. There is no
pre-launch confirmer for basic. U2 cross-checks profiles for Supervisor/Lead
and option/hash for the Peer. `mixed-peer` checks a pool containing both
Codex/Pi — no extra saved profile needed and no forcing the Lead's family per
Peer. Scenarios outside the scope stay NOT_RUN.

The offline CLI's `prepare <request.json>` emits `create_agent` arguments with
a role envelope. It registers no profile and creates no agent itself.

## Documentation

How it works:

- [Plugin architecture](docs/architecture.md) — the role model, what the
  plugin adds to Paseo, the hidden injection channel, the delegation loop
- [File map and contract](docs/contract.md)
- [Agent setup guide](docs/agent-guide.md)
- [Independent acceptance checklist](docs/review-checklist.md)

Implementation specification:

- [Plugin implementation spec](docs/spec/paseo-plugin-implementation.md)
- [Plugin feasibility audit](docs/spec/paseo-plugin-feasibility.md)
- [Settings-driven providers + hook injection](docs/spec/settings-driven-providers.md) —
  design exploration
- [Jev-assisted routing](docs/spec/jev-routing-investigation.md) and
  [routing criteria](docs/spec/routing-criteria.md)
- [Communication supervision](docs/spec/supervision-integration.md)
- [Beads work tracker](docs/spec/beads-work-tracker.md)

Reports and investigations:

- [Guide → policy, procedure and protocol trace](docs/reports/guide-coverage.md)

Referenced host mechanisms:
[custom providers](https://paseo.sh/docs/custom-providers.md),
[agent profiles](https://paseo.sh/docs/agent-profiles.md),
[Codex app-server](https://learn.chatgpt.com/docs/app-server#threads).
