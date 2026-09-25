# Candidate contract and file map

This revision provides persistent role installation and SLP operating policy for
task-specific topology, supervision and evidence-based acceptance.
Behavioral authority is the operating guide and current Human assignment.
Local installation/transport checks do not constitute workflow acceptance.

| Files | Responsibility |
|---|---|
| install.sh | One-command local install into the selected destination and Paseo home; reload configuration. |
| src/paseo-install.mjs | Merge owned provider/profile entries, preserve existing preferences, record rollback binding, initialize repository protocol and Supervisor notebook scaffold; materialize clones a source checkout's protocol, catalog and protocol references into a target checkout with frontmatter paths rebased (Supervisor notebook excluded). |
| src/host-config.mjs | Sole reader/writer of the Paseo host configuration; one rule each for owned provider and owned profile verification and the two MCP flags. |
| src/role-process.mjs | Shared child-process lifecycle, signal/exit propagation, NDJSON framing and backpressure; adapters select protocol mode, instruction transforms and unchanged-frame serialization. |
| bin/codex-role.mjs, src/role-transport.mjs | Transparent Codex stdio adapter; append installed role instructions at start/resume and existing turn overrides. |
| bin/pi-role.mjs, src/role-transport.mjs | Pi native append-system-prompt adapter; preserve RPC bytes, host extensions and session/model/thinking arguments. |
| bin/devin-role.mjs, src/role-transport.mjs | Generic ACP adapter; prepend role core, recovery pointer and current managed communication-language state on every session prompt. First prompts and prompts re-armed by load/resume/fork also carry session-entry helpers and the full measured carrier; no compaction event is required. |
| bin/claude-role.mjs, src/role-transport.mjs | Claude Agent SDK stream-json adapter; append installed role instructions to the initialize control request's system-prompt append field; all other frames pass through. |
| src/common.md, src/roles/*.md | Authority, role behavior, conditional policy-text reuse and context-recovery rules; no repository tactics or model IDs. |
| src/delegation.md | Always-loaded Supervisor/Lead delegation core: required review-gate, parentage/placement and ambiguous-create invariants, with conditional pointers to formation and execution procedures. |
| src/references/delegation-formation.md | Conditional delegation classification and formation record: new team, continuation or observe-existing. |
| src/references/delegation-execution.md | Conditional delegation preparation, runtime selection, creation verification, ambiguous-create recovery, notification and report retrieval. |
| src/references/orchestration.md | Lead's conditional topology, independent review/council, dependency and integration procedure. |
| src/references/monitoring.md | Supervisor/Lead event observation, heartbeat ownership and resource settlement. |
| src/references/governance.md | Supervisor scope, causal notebook, authorized recovery and policy evolution. |
| src/references/anti-patterns.md | All 20 guide §9 hypotheses with evidence, questions and bounded responses; reached on audit/drift triggers. |
| src/references/provider-routing.md | Supervisor/Lead profile selection, Peer pool selection, validation and handoff procedure. |
| src/references/review-gates.md | Review gate structure: parallel axis-split seats (Spec vs Standards; cross-family seat optional, never required), Lead-owned verification distinct from review seats, smell baseline, neutral briefs, non-merged aggregation and the repeated-class correction-loop escalation. |
| src/references/work-tracking.md | Conditional beads (`bd`) work-graph doctrine — self-gates on the session-entry `Work tracker: beads (enabled in SLP settings)` pointer: probe first, unavailable/uninitialized is a recorded gap never a block, evidence-not-control-plane boundaries, the one-writer-per-scope table (Supervisor roots / Lead children / a seat's own issue), `BEADS_ACTOR`/`--actor` attribution, and recovery/handback rules. SLP never installs, initializes or configures beads. |
| src/routing.mjs | Resolve the repository catalog, falling back to the plugin-owned user-scope pool at `<paseoHome>/slp-runtime/state/peer-pool.json` when absent; bind a Lead-selected option with fresh hash and availability checks. `optionExclusions` is the single eligibility predicate — closed-vocabulary tokens (`disabled`, `availability:<state>`, `role-not-listed`) shared by enforcement and Jev candidate generation. `validateCatalog` stays shape-only apart from normalizing the legacy `optionIds` quota-fallback list in place on read (≤1 → `optionId`, >1 fails closed — wave 6) and refusing the Jev decline sentinel as an option id — a shape-level collision; the semantic layer reports a reserved standard-seat id whose tokens diverge from the package set as a Token conflict on every read, and `catalogBinding` refuses to bind one. `catalogBinding` verifies a supplied Jev receipt offline — including the vocabulary version it was issued under — and requires one when the daemon arms `jev.capabilities.routing`. |
| src/routing-vocabulary.mjs | Canonical routing-criteria vocabulary (docs/spec/routing-criteria.md): the four axes, the 16 standard `axis:value` tokens with definitions, the 12 reserved standard-seat ids with package token sets, the §4 reading helpers and the English Jev guidance — all versioned under `ROUTING_VOCABULARY_VERSION`. `plugin/shared/routing-vocabulary.ts` is its Manager-side mirror; neither side can import the other, so tests pin identical data. |
| src/jev.mjs | Jev (TypeSafe System One) bounded-decision transport — never an ACP provider. Per-daemon config/key resolution (fail closed, all toggles default off) over two provider kinds: `openrouter` (Decisions API, pinned `typesafe/jev-1.13`, `provider.allow_fallbacks: false` on the wire) and `typesafe` (first-party `POST {baseUrl}/v1/systemone`, pinned `jev-1.13.0`, no provider field; baseUrl may be a custom https origin+path prefix) — each with its own model pin and baseUrl rule, calls with ~5s timeout and at most one bounded retry, typed-answer validation, credential-shaped-string redaction before send, and decision-receipt build/verify with the pin chosen by the receipt's provider kind. Receipts prove consistency, not authenticity; confidence is recorded, never a threshold. |
| src/jev-routing.mjs | First Jev consumer: `route-decide` computes the deterministic eligible set from `optionExclusions`, drops Token-conflicted seats from candidates (reporting every catalog conflict on the receipt), sends the Lead-authored brief as state plus the versioned English suitability guidance and the compact per-token glossary (never raw assignmentFile bytes; catalog `notes` withheld) and emits the option id plus receipt. The per-option surface is fixed-shape — `id`, `provider`, `model`, `thinkingOptionId` (explicit `null` when absent), `suitableFor`, `avoidFor`. Decline exits nonzero; `jev-no-candidates` when no usable seat remains. Runs only on explicit invocation — no loops, schedules or prepare-time calls. |
| skills/paseo-slp-onboarding/SKILL.md | Repo discovery and protocol recommendation before asking for missing decisions, keeping rules in the protocol and operational facts in `.paseo-slp/references/`; custom-process interview, confirmed protocol diff and Peer pool setup with Supervisor/Lead profile verification. Supporting resources disclose setup details. Skill installation remains independent from repo initialization. |
| src/templates/workspace-protocol.md | Common repository tactics and outcome/risk-based workflow recipes, including a protocol-owned Tiny procedure with independent review. Onboarding fills assignment, execution and delivery settings in one effective repo protocol, whose Repository references section points to operational facts (check commands, skill layout) kept in `.paseo-slp/references/`; filling configuration and references is not an Override; init still uses this default and preserves existing files. The `agent_mode` field records intended spawn mode for direct launches (empty falls back to the bundle's `modeId`, then asks). |
| src/binding.mjs | Every rule a Binding must satisfy: setting patterns, the route override deny-lists and the single provider-health check. Imports nothing from the package. |
| src/role-bundle.mjs | Which policy bytes each role receives at session entry, and their order; the load-path contract traced in reports/guide-coverage.md. Session-entry instructions also carry the carrier block (spawn kit plus policy-byte locators) so profile/provider launches receive the same payload prepare places in initialPrompt. Managed session entry injects the plugin-set communication language (slp-runtime/state/communication-language) when present. ACP delivery freezes the verified candidate core and carrier at adapter startup, reads language per prompt, and explicitly clears earlier runtime language instructions when unset; other transports retain entry-time language semantics. |
| src/launch.mjs, src/profiles.mjs | Select one Binding source (saved profiles, catalog routing or an explicit binding), then compose the create_agent argument record. launchPlan and handoffPlan share one builder; preparation state and validation operations also serve launchCheck, preserving each path's diagnostic order and fresh final revalidation; nothing edits the create record afterwards. Handoff adds explicit authority, old-owner evidence, resources and current work snapshot; no lifecycle mutations. request.inventoryFile fills providers/profiles the request did not inline; request.assignmentFile appends a read-first pointer to the emitted prompt without inlining file bytes. The plan also surfaces the intended `modeId` (with a warning when the binding lacks one), a `spawnKit` of role-appropriate MCP tool signatures, and an `orientation` manifest of policy-byte locators (path/bytes/sha256, `missing` for receipt-declared files absent on disk; the set derives from the install receipt, so source-only documents are never declared) — locators only, never interpretation; the same payload is carried inside `create.initialPrompt`, the only field create_agent transmits, so the spawned seat actually receives it. The prompt-side carrier is omitted only when the binding targets the canonical `slp-<family>-<role>` wrapper and the request's live provider inventory observed it — the wrapper injects the carrier at session entry; unverified targets keep the prompt fallback. |
| src/inventory.mjs | Provider/profile inventory in the exact shapes prepare consumes: `paseo provider ls --json` only when the requested home's paseo.pid names a live process, else that home's own config.json `agents.providers` — never another daemon's providers, no directory materialization; provider `enabled` may be null for unrecognized states; profiles always from `daemon.agentProfiles`. Read-only; on multi-daemon hosts the live listing reflects whichever daemon the paseo CLI reaches. |
| src/agent-state.mjs | Shared read-only discovery of daemon persistence (`<paseoHome>/agents/*/<id>.json`) for agent listing and monitoring. A missing root yields no records; other root errors propagate; broken groups and records are skipped. Preserves filesystem read order and duplicate IDs, leaving projection and duplicate resolution to callers. |
| src/agents.mjs | Agent listing projected from `src/agent-state.mjs`, sorted by id with duplicate records retained, with shell-quoted devin-family `devin -r` attach hints; works around `paseo inspect`/`ls` not surfacing `persistence.nativeHandle`. Read-only, best-effort host detail. |
| src/spawn-kit.mjs | Package-owned approximation of the Paseo MCP tool surface per role (orchestrating vs peer), emitted in prepare plans so seats skip live schema re-derivation; marked approximate pending live `mcp_list_tools` verification. |
| src/monitor.mjs | On-demand signal scan over daemon-owned agent state discovered by `src/agent-state.mjs` (last record per id wins) plus each declared worktree's git status; emits `{agentId, kind, evidence, observedAt}` candidates (attention, follow-up-round, idle-dirty, scope-drift, test-mirror, file-churn, tool-mix, correction-cadence) only for new fingerprints when a stateFile checkpoint is supplied — that checkpoint is the only write. Never a verdict, daemon or rendered-log parse; broken cwd becomes an evidence gap. An opt-in `devinSessionsDb` request field probes the devin CLI sessions.db read-only for devin-family agents (joined by `persistence.nativeHandle` = `sessions.id`; a missing or unmatched handle is a gap — never a cwd guess) to derive tool-mix and correction-cadence candidates; every failure is an evidence gap, not a crash. |
| src/notebook.mjs | Read-only locator for a repository's active governance notebook: resolves the repository's git common dir — the property linking a worktree back to its repository — then lists Supervisor agents (provider containing `supervisor`, or a Supervisor-titled state file) whose `cwd` shares it. Output is candidates only, sorted by lastActivityAt, each with notebook path and `notebookExists`; broken agent cwds become gaps. Never copies or mutates notebook content, and picks no authoritative candidate — governance stays per-checkout. |
| src/package.mjs | Package identity, exclusive staging, integrity checks and stable Git work snapshot; untracked nested Git work-tree roots are snapshotted recursively under `nested`, sub-repos can carry their own `nested`, and index gitlinks record `{path, kind:"gitlink", indexOid, headOid, state}` with non-clean states listed in top-level `incomplete`. |
| src/runtime-state.mjs | Read-only plugin-state probes (H13 workaround): `localTarget` mirrors the plugin's daemon-home detection; `runtimeStatus` recomputes the file-derivable parts of the daemon `status` view — receipt, owned providers/profiles, runtime and launcher integrity, config-drift presence — and reports daemon-only views (live conflicts, family availability) as gaps, never guesses. The Jev probe reports `hasKey`/`keyPermissionsOk` only — key material never enters output. Fails closed on corrupt plugin state. Mutation RPCs are Human-authority and are not exposed. Retire when the host ships `paseo plugin invoke` or MCP `invoke_plugin_rpc`. |
| src/work-tracker.mjs | Beads (`bd`) detection and enablement — read-only probes only (`bd version`, `bd where --json` with forced `BD_DISABLE_METRICS=1`, 5 s timeout, 64 KiB cap): never installs, initializes, upgrades or configures beads, and a missing or broken tracker is a gap in the result, never a throw or a spawn blocker. `readWorkTrackerSetting` reads `<daemonHome>/slp-runtime/state/work-tracker.json` (mirrored by `plugin/server/work-tracker.ts` — absent = disabled, corrupt/foreign = disabled plus a surfaced error, non-ENOENT errors propagate). `workTrackerBlock` renders the managed session-entry pointer (silent when disabled, one gap line when unreadable); `beadsSeatEnv` supplies the hook-family `BEADS_ACTOR`/BD_* overlay. |
| bin/slp.mjs | Install/upgrade/preview, verify/uninstall, init, materialize, routes, prepare/handoff, inventory, agents, monitor, notebook, identity, snapshot, instructions (raw session-entry bundle bytes on stdout, provenance on stderr), route-decide (the only path that calls Jev — explicit invocation, network, emits a receipt; prepare and prepare --check stay offline), status and local-target (read-only plugin-state probes), and tracker (the read-only beads probe — prints the probe JSON and exits 0 even when not `ready`) entrypoints. |
| skills/paseo-slp-e2e/SKILL.md | Single-session full-suite execution procedure; requires the source checkout and authorized Paseo actors. |
| e2e/evidence.mjs | One contract per evidence kind: what may enter the ledger and what discharges the kind's requirement at seal. |
| e2e/criteria.mjs | U1–U7 as code, each naming the evidence kinds that can support it; the mapping a reviewer previously held in their head. |
| e2e/collector.mjs | Frozen evidence ledger and review history; verify assessment byte identities and original-review links before summaries, addenda or review-dependent launch gates. |
| e2e/ledger.mjs, e2e/report.mjs | The ledger owns evidence storage, byte verification and per-kind discharge inspection, including the run context and capture provenance; reports consume that inspection to render attempt status, run summaries and the cross-run index without opening evidence records. |
| e2e/ | Development-only scenario manifest, fixture, external outcome check, evidence collector and repository E2E protocol. Collector commands do not create agents or judge behavioral evidence. |
| tests/helpers.mjs | Synthetic E2E fixture construction and evidence-kind dispatch; collectAll can omit kinds under test, while tests keep raw/invalid capture and provenance assertions explicit. |
| tests/*.test.mjs, tests/helpers/plugin-doubles.mjs | Local installer, rollback, transport, envelope, snapshot and plugin checks; the shared plugin doubles own temporary daemon/binary fixtures and their matching dependency wiring, including named recovery fault points that concentrate characterized UUID sequencing; tests own manager creation, explicit filesystem blocker choice and durable-phase assertions. |

The install unit is package.json, install.sh, bin/, skills/ and src/. installed.json binds their
exact bytes. The standalone Paseo installer also binds paseo-binding.json, containing
only owned entries and prior MCP values, never credentials. The Option A plugin
keeps its receipt and operation intents in a private per-daemon-home sidecar
outside immutable candidates and plugin settings; its payload manifest
additionally verifies file modes. The shell installer and installed CLI share
the standalone installation code. The plugin uses the documented config.patch
transaction and stable executable shims.

Managed family binaries use validated daemon PATH aliases when available, so
Codex, Pi, Devin and Claude updates can reach future launches. Existing
version-pinned bindings migrate on the next authorized activation; the SLP
picker refreshes the host catalog before presenting models.

Three roles remain Supervisor, Lead and Peer. Only two saved profiles are managed:
slp-supervisor and slp-lead. The twelve providers remain slp-codex-{role},
slp-pi-{role}, slp-devin-{role} and slp-claude-{role}; Peer chooses runtime from
the project pool, not a saved profile. Devin bindings accept swe-2 models only.
Peer disposition belongs to the assignment, independent of pool option choice.
Standalone installation refuses collisions with owned provider and Supervisor/Lead
profile IDs. Plugin activation may adopt existing entries only by explicit
request and exact persisted-schema equality. A surviving receipt preserves the
original restoration baseline; adoption without that receipt records the
observed baseline and cannot recover earlier shared values. Unrelated
configuration is preserved within the documented exclusive administrative edit
window.

Installation performs no agent creation. Reload changes host configuration for
future launches. Uninstall requires unchanged managed entries and package files;
it preserves unrelated config edits and refuses removal with extra files. Existing
sessions may still depend on installed paths: finish them before uninstall.
A repeat install of identical bytes preserves profile setting edits. Replacing a
different candidate requires explicit upgrade into a new directory. Upgrade preserves
current profile preferences and unrelated config, adds new bundles and rebinds owned
providers to the new directory while retaining the old installation for active sessions.
Owned slp-peer and legacy disposition profiles are removed from host profiles and archived exactly
in paseo-binding.json retiredProfiles for review. Other profiles remain untouched.
The user-scope Peer pool is plugin-owned mutable state at
<paseo-home>/slp-runtime/state/peer-pool.json (mode 0600, atomic
whole-file writes under a sha256 compare-and-swap; the manager surface is
its sole writer). The beads work-tracker toggle is plugin-owned mutable
state of the same class at
<paseo-home>/slp-runtime/state/work-tracker.json (mode 0600, atomic
whole-file write; the manager surface via `set-work-tracker` is its sole
writer). An absent file means disabled — upgrading SLP never changes the
behavior of an existing installation — and a corrupt or foreign file
degrades to disabled plus a surfaced gap, never a spawn block. Standalone host install/upgrade/uninstall and plugin
activation/deactivation create, edit, and delete no routing catalogs —
a repository catalog exists only where `init --routing-from` imported an
explicitly chosen file. A legacy <paseo-home>/slp-routing.json is read for
a one-time import into the pool and is never deleted automatically.
Populating routing choices and migrating repository catalogs require
explicit onboarding or migration authority.
The old retained binding
no longer owns current host entries and cannot uninstall those entries. Runtime cutover
still requires task authority; neither install nor upgrade creates replacement sessions.

Option A plugin deactivation restores shared configuration semantics, not
original JSON bytes or absent-key shape. It removes unchanged owned
provider/profile entries and restores the recorded effective injectIntoAgents
value; an originally absent value may become explicit false and an absent
profile array may become empty. It never patches mcp.enabled, which must
already be enabled. Human profile preferences are preserved during rebind and
may be acknowledged by reconcile; conflicting managed entries stop
deactivation.

SLP management operations are administrator-only and require an exclusive
administrative edit window for the selected daemon. Do not edit daemon
configuration through the app, another plugin, a CLI, or a file while
activate, reconcile, or deactivate is in progress. The plugin serializes its
own operations and verifies persisted and live results. Paseo 0.8.0 provides
no compare-and-swap for these patches; this plugin cannot guarantee
preservation against concurrent external writers. A detected mismatch stops
automatic mutation and requires reconciliation.

Plugin disable/remove is not SLP deactivation. Raw removal leaves verified
stable transports operational and correctly roled, with ownership recoverable
by reinstalling the same plugin ID and reconciling its retained receipt.
Deactivate before removing the manager when detachment is intended. Neither
lifecycle cleanup nor deactivate deletes stable runtime or launcher
directories. These directories belong to the per-daemon SLP store and remain
available to existing sessions; deletion requires separate maintenance
authority after dependencies have ended. Provider commands and policy/helper
paths must never reference managed plugin checkouts.

Policy is injected independently of the ordinary task prompt. Provider labels
and agent self-reports are not proof of loading: E2E evidence must correlate the
provider command, installed bytes, actual session instructions and host parentage.
Permissions and role boundaries remain distinct: policy is not tool isolation.

Assignment supplies objective, repository/workspace, owned/excluded scope,
authority, verification and handback. Supervisor and Lead read the repository
protocol when the assignment lands — before decisions that depend on its
tactics, not only before delegation. Lead passes only relevant constraints to
Peer. No global role is written to AGENTS.md.

Common/role instructions and the Supervisor/Lead delegation core load at
session entry. Formation and execution procedures are disclosed through explicit
decision-triggered pointers, not inlined in every session. They point to conditional references under the installed src/
directory. The recursive install unit includes all those references; the full
operating guide stays a source document, not a prompt broadcast to every role.
Load-bearing decision rules — the required review gate and agent-scoped seat
creation — sit in that always-loaded layer, and Lead re-reads the conditional
references at the decisions that apply them, including after resume or
compaction.
The carrier block (spawn-kit signatures plus policy-byte locators) reaches a
seat through two channels: session-entry bundle injection for profile/provider
launches, and `create.initialPrompt` for the prepare path — the only field
create_agent transmits, so plan-level `spawnKit`/`orientation` fields alone
would never arrive. The captions differ on purpose: session-entry locators are
measured when the bundle loads, plan locators where prepare ran. The kit is an
approximation to verify against live `mcp_list_tools`; locators are integrity
evidence, not policy content. The source contract reviewers use is this file —
`docs/contract.md` lives in the repository and is deliberately outside the
install unit, so locator sets never declare it.
Protocol defaults select tactics; global roles no longer impose a single Engineer
or prohibit heartbeat for every assignment. Assignment supplies Peer disposition,
read/write authority and output; independent review uses sessions separate from
implementation and exact candidates; a required gate is parallel seats on split
axes — never one merged seat — and seats that cannot be supplied make it
BLOCKED rather than skipped. Within one assignment, Lead normally reuses
the Engineer for corrections and the same independent review seats for re-review on the new
stable candidate. New independent seats and recovery remain explicit choices.
Lead builds relevant project context from repository evidence and maintains a
decision/ownership checkpoint across handbacks and resume; Peers receive only
the context needed for their bounded assignments.

The policy describes monitoring, council, recovery and parallel ownership, but these
paths are not E2E-qualified by this revision. Heartbeat uses discovered host wake
primitives; `slp.mjs monitor` adds a caller-invoked, delta-only signal scan that
emits candidates without verdicts — it is not a semantic detector, and no
lifecycle runner, tool filter or schedule adapter is added. Missing capabilities remain explicit before any fallback. See
[guide coverage](reports/guide-coverage.md) for requirement mapping, load paths and host gaps.

Codex, Pi, Devin and Claude share role bytes through their respective adapters. Human configures
slp-supervisor/slp-lead with matching role providers and chosen models/settings.
Supervisor/Lead launches refresh these saved profiles and copy their complete
provider/model/mode/thinking/features bundles; `modeId` alone follows the
delegation precedence — plan binding, then protocol `agent_mode` for direct
spawns, then the bundle's own — rather than verbatim copy. Missing or
incompatible settings require Human configuration before the dependent launch.

Peer delegation resolves the assigned repository's .paseo-slp/slp-routing.json
first; when the repository has no catalog, the plugin-owned user-scope pool
($PASEO_HOME/slp-runtime/state/peer-pool.json, default ~/.paseo) is the
declared fallback. Onboarding prepares a pool of complete provider/model/settings
options with suitableFor, avoidFor, notes and explicit eligibility — authored in
the manager surface, where model/mode values come from the live provider
catalog. The 12 standard archetype ids are reserved: on them the package owns
the closed `axis:value` suitability vocabulary (docs/spec/routing-criteria.md)
and the fields are read-only; any other id is a custom seat with free strings,
and a reserved id carrying divergent tokens is a Token conflict that cannot be
saved or routed until resolved. Lead reads the pool,
selects an option per task/budget, explains why it fits and validates its fresh hash
with prepare. Provider pi/codex/devin/claude maps to the matching installed Peer wrapper; policy
and disposition stay separate from runtime choice. Neither the Lead's family nor
a saved slp-peer limits the pool. No catalog in either scope, or an
empty/no-eligible pool, blocks Peer creation until setup is completed — never a
saved profile, another repository's catalog or inherited Lead settings. An empty
repository catalog remains authoritative and disables the fallback.

Jev-assisted routing is an opt-in per-daemon capability, configured under
<daemonHome>/slp-runtime/state/jev.json with the provider key beside it in
jev-<kind>.key (write-only, 0600; status surfaces hasKey only). Jev is a
bounded decision primitive over either the OpenRouter Decisions API (pinned
typesafe/jev-1.13) or the first-party TypeSafe System One API (pinned
jev-1.13.0, custom https baseUrl allowed), never
an ACP provider or agent seat, and runs only through the explicit
route-decide helper — no loops, schedules or prepare-time calls; prepare and
prepare --check remain offline and merely verify the supplied receipt. Two
modes: shadow (enabled without capabilities.routing — route-decide emits a
receipt, the Lead still chooses, the plan records both picks for agreement
measurement) and armed (capabilities.routing=true — the receipt is required
and binding, including optionId matching the recorded choice); when supplied
a receipt is always verified, toggles apply at preparation time and never
mutate running seats. Shadow evaluation precedes arming: the Human
pre-registers exit criteria (agreement rate and the asymmetric error class)
and arms only once the recorded pairs satisfy them. In armed mode the
suitability reason trail is the receipt's recorded distribution, not Lead
prose. Eligibility stays deterministic and precomputed (the same
optionExclusions tokens enforcement uses), Jev may only pick inside the
eligible set plus the explicit no-suitable-option sentinel, and every
configuration, transport, validation or receipt error fails closed. An
OpenRouter/TypeSafe outage therefore blocks only the dependent Peer
delegation while armed — controlled degradation is the Human disabling the
capability and Lead judgment resuming; disabling keeps the stored key.
Confidence lands on the receipt as evidence, never as a routing threshold,
and receipts prove consistency, not cryptographic authenticity. Accepted
risk (recorded): the key file is 0600 inside the daemon home, yet any
same-user process can read it — daemon-home integrity is the boundary.

Communication supervision is a second opt-in capability, bound per Lead
route in <daemonHome>/slp-runtime/state/supervision.json (0600, whole-file
sha256 CAS through the supervision card — its sole writer). Off by default;
configuring Jev never enables a route, and a route enables nothing until
mode is explicitly shadow. When enabled, the plugin's lifecycle hooks
(agent.created/archived/turn_started/turn_ended) synchronously capture
normalized send_agent_prompt evidence for the bound Lead's direct Peers,
and a serialized plugin-owned queue evaluates each Peer handback through
Jev's three-question assessment — a second Jev consumer that requires
capabilities.supervision in addition to enabled. The detector observes
communication only: it never infers authority, certifies artifacts,
mutates assignments, or prompts any agent, and every missing or
unverifiable input resolves to unknown rather than drift. Persisted output
is a bounded metadata ring (state/supervision-cases.json, ≤200 entries,
≤30 days — fingerprints, ids, counts, flags, assessment summaries; never
message bodies or keys); open cases and the queue are process-local and
are not replayed after a restart. External data/cost: shadow evaluation
sends captured brief/handback/room-message content to the configured Jev
endpoint, so communication leaves the host and each evaluation is a paid
provider call. Mode notify is schema-valid but has no delivery
implementation — notification is a separate Human gate. Provider coverage:
only the codex normalized send shape is verified against a real timeline;
pi/devin/claude fixtures are mapper-derived, so their sends stay uncertain
(family-shape-unverified) and their cases resolve unknown until real
fixtures exist — devin additionally drops the MCP result body upstream.
Because no machine-readable report-recipient signal exists on this host,
report-route-unverifiable is set on every case, so all cases currently
resolve unknown before any Jev call — accepted, pending the structured
report-recipient decision. Live E2E validation has not run; see
docs/spec/supervision-integration.md.

prepare accepts repository, workspaceId, assignment and role. Supervisor/Lead use
fresh profiles/providers; Peer uses providers and route.optionId/catalogSha256.
A profiles inventory can accompany Peer discovery but does not select its runtime;
an inventoryFile path fills providers/profiles the request did not inline (explicit
inline arrays win, including `[]`), and an assignmentFile path appends a
read-first pointer to the emitted prompt while keeping file bytes out of it. Both
fields apply to prepare-handoff through the shared plan builder.
Catalog settings cannot be overlaid via route runtime/profile overrides. Explicit
binding without profiles remains a separate Human-authorized offline/handoff path,
not an ordinary missing-pool fallback. Helpers emit create arguments only; Paseo
owns lifecycle and actual settings. The three layers stay distinct: launch
planning pins repository/workspaceId/binding and renders the create record;
the calling Supervisor or Lead owns executing agent-scoped create_agent as the
recorded parent; the host owns the resulting parentage, placement and report
routing. A plan documents intended arguments — it is not proof the team
formed, so the caller verifies the returned child's actual parent, workspace
and report route against host evidence. request.workspaceId stays a required
plan input copied into create.workspaceId; a direct agent-scoped create_agent
may omit workspaceId to inherit the caller's workspace, but prepare keeps
emitting the resolved value. New seats are created through agent-scoped
create_agent so the host records parentage, the report route and the sidebar
tree; prompting a standalone session observes work it already owns and cannot
carry a new delegation. Same-team seats share the assignment's pinned
workspace unless a declared worktree, repository or lane-isolation reason is
recorded with its paths — a second workspace on the same checkout is not
isolation. Source selection is shared by prepare-handoff.

init creates missing protocol and Supervisor notebook files
without overwriting existing files, and writes .paseo-slp/slp-routing.json only
when --routing-from names an explicitly chosen catalog — a repository without
its own catalog resolves the user-scope pool. Host upgrade archives retired Peer
profiles but neither creates
nor edits project catalogs, so setup never silently imports host choices.

New basic manifests use runtimeSource=profiles-and-peer-pool. Supervisor/Lead
profiles and eligible Peer options match the selected basic family. begin records
settings.roles for the two profiles and settings.peerPool for the proposed pool;
Lead selects the actual Peer option, not the coordinator. U2 compares each launch
with its relevant saved profile or option/hash. mixed-peer can use Pi and Codex
Peer options under either Lead family without requiring extra saved profiles or
both basic runs. Old frozen manifests retain their original criteria and results.

New reviews and each addendum record an independent byte digest, and each addendum
binds the original review plus its own sequence position. Summary and
review-dependent gates verify the surviving assessment history, including superseded
addenda; deleting a record and its digest removes it from that set, so complete
local rollback stays outside this protection. New manifests require this identity
protection; missing, mismatched, noncanonical or out-of-sequence records/digests
fail closed. Historical assessments without recorded identity remain
readable as UNVERIFIED_LEGACY without automatic resealing. Their verdicts remain
visible but do not qualify dependency or retry gates. A new addendum cannot
retroactively verify an unsigned original. Summary exposes gateReady separately
from historical status; its CLI returns success only for a fully qualified PASS.

Provider switching creates a new session: prepare-handoff requires old-owner settlement
evidence and transfers state/resources without inventing new parentage or acceptance.
Supervisor/Human still verifies host state and performs the authorized Paseo lifecycle
operations. Quota alone is not switch authority; a Human request or standing fallback
policy supplies it. Actual live transfer remains separate E2E evidence.

A work snapshot includes HEAD, tracked/untracked nonignored paths, content,
symlink targets, permission modes and deleted markers. It excludes ignored build
outputs, staging intent, external artifacts and processes; relevant external
proof must be recorded separately. An untracked directory that is itself a Git
work-tree root is snapshotted recursively and recorded under `nested` with its
own HEAD/sha256/files (a sub-repo can itself carry `nested`); the top-level
sha256 covers nested content. An index gitlink (mode 160000) records
`{path, kind:"gitlink", indexOid, headOid, state}`: indexOid is the stage-0
pointer — the single staging-intent exception, because a gitlink's index entry
is itself the identity object and no working-tree bytes represent it; a
conflicted index (stages 1–3) records `indexOid:null` and `state:"conflicted"`
rather than picking a stage. headOid is the submodule's own HEAD, resolved
read-only (never fetch/init/update); state is `missing` (no directory on disk),
`uninitialized` (no resolvable HEAD), `clean` (HEAD resolves, empty porcelain),
`dirty` or `conflicted`. Any non-clean state lists the path in top-level
`incomplete` — that submodule scope is unproven content, so handoff packets
record it as an evidence gap instead of claiming full-candidate coverage.
Listed directories that are not repositories remain unsupported. Before/after
snapshots detect drift while Peer is paused, not transient or malicious writes.

Peer quota fallback is configured by catalog quotaFallback.enabled and optionId —
one designated option, not an ordered list. Missing/disabled means stop; the
target must be an existing eligible pool bundle.
prepare validates route.quotaFallbackFrom against this authorization and fresh hash.
Raw Paseo create/update calls remain host capabilities: the package supplies policy
and validation, not a host security boundary. Evidence must verify actual settings
on start/resume/update; availability flags alone do not prove quota recovery.

### ACP context recovery

ACP role delivery is conversation text, not a persistent system-instruction channel.
The adapter reasserts the same role core on every session/prompt; it does not infer
compaction from a timeline record or invent a session/compact event. Entry/re-arm
also supplies helpers and full SHA-256 policy locators. Recurring anchors omit the
carrier but retain the verified runtime recovery command. Core bytes stay tied to
the adapter's verified startup candidate; managed language is read at each prompt.
An unset language state supersedes earlier runtime language settings without
replacing the current assignment. Non-ENOENT language read errors propagate.
Task context must be recovered from evidence: role recovery never guesses an
assignment or restores missing ownership. Transport tests prove delivered bytes;
actual compaction resilience requires separate live provider evidence.

### Tiny procedure and policy-text reuse

Lead classifies clear, reversible work with clear verification and no change to
authority/delegation/lifecycle/integrity as tiny, recording its reason. Workspace
protocol owns the ceremony: the shipped template supplies one Peer Engineer, an inline
brief/formation, in-session proof, independent review and Lead artifact inspection/verdict.
The template requires review even for Tiny work; this is a template default,
not a new global requirement for every custom protocol. A required review gate
still uses separate Spec and Standards seats under the installed review policy.
Growing scope/risk requires Lead to reassess the workflow before affected work. Missing or
older protocols grant no implicit exemption; record the gap and propose a change.
Where authority permits the task still runs through one Peer Engineer — only the
step needing an exemption waits for a decision — without automatically migrating
repository tactics or blocking unrelated work.

Policy read/re-read requirements permit reuse of the full relevant text still
in context when its source is known unchanged. A summary is not a substitute;
changed sources, lost context or uncertainty require a new read. The initial
full workspace-protocol read remains required. Runtime freshness checks for the
catalog, eligibility, provider availability and Jev receipts are unaffected.
