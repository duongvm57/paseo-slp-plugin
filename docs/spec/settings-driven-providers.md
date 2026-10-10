# Settings-driven role providers and hook injection — post-v1 direction

Status: Phase 0 probes **ran on the live daemon 2026-09-19** — all gates
passed (results below). Phase 1 (settings-driven generation, `f3465cc`) and
Phase 2 (hook injection + sentinel-gated thin aliases) are implemented on
branch `feat/slp-paseo-plugin`. Phase 3 (mixed-artifact operations) remains
open. Not part of the Option A v1 contract
([paseo-plugin-implementation.md](paseo-plugin-implementation.md)).
Builds on the B0/B2 hook-seam findings in
[paseo-plugin-feasibility.md](paseo-plugin-feasibility.md).

## Phase 0 probe results (2026-09-19, daemon home ~/.paseo, Paseo 0.8.0)

Probe vehicle: one throwaway directory plugin `slp-probe`
(`.local-checks/slp-probe/`), registering `agent.create` + `agent.session_open`
before-hooks that dump hook-visible payloads to JSONL and inject a sentinel
`systemPrompt` on agents titled `slp-probe-*`. Removed after the probes; the
managed `paseo-slp` entries were never touched.

| Probe | Result | Evidence |
|---|---|---|
| S3 hook inject | **PASS** — all three hook families | Hook-set `config.systemPrompt` reached real seats: codex `f51582fe` echoed the sentinel at create and again on turn 2; pi `7abb3fe8` and claude `69d9288c` echoed at create. Turn-level persistence verified on codex; a process-level `session/load` resume was not exercised (limitation). |
| Config marker | **PASS** | `settings.features {slp_role:"probe-peer"}` arrived intact in hook-visible `config.featureValues` — arbitrary keys survive `create_agent` → `agent.create`. Hook-visible config keys observed: `cwd, featureValues, modeId, model, provider, thinkingOptionId, title` (+`systemPrompt`, `providerOptions`, `mcpServers`, `internal` when set). No `profileId`, `initialPrompt`, `labels`, or `env` (spawn env). |
| Model enumeration | **PASS** | `providers.listModels` live: codex=5, pi=473, claude=15 — the shipped `catalog` RPC already wraps this; a model picker inside the SLP UI is viable. |
| Sentinel | **PASS** — primitives proven, guard required | `agent.session_open` env reaches the provider process env (`SLP_PROBE_GRANT` visible in the codex seat's shell and on an `slp-codex-peer` seat alongside provider-entry env `SLP_MANAGED_RUNTIME`); hook env overlays provider env (`createProviderEnvSpec` applies `runtimeSettings.env` then launch overlays). With the plugin **disabled**, a spawn fired no hooks and started unroled — fail-open confirmed, so a sentinel guard (grant-check gate or marker command + hook `config.provider` rewrite — both viable per `lifecycle/index.js` which only forbids `cwd` changes) is mandatory for thin aliases. |
| Devin reconfirm | **PASS (as expected)** | Live negative control: the devin seat answered `NO-SENTINEL` although the hook set `systemPrompt` — the 0.8.0 ACP adapter still drops it (`acp-agent.js` `session/new` sends only `{cwd, mcpServers}`). Devin keeps the wrapper. |

Consequences: Phase 2 hook injection is **green-lit** for codex/pi/claude; the
config-marker pass makes the 4-provider variant (role via `featureValues`
marker, e.g. `slp_role`) implementable, with 12 thin aliases as fallback;
fail-closed during a hook gap requires a sentinel guard on every hook-family
entry; the devin path is unchanged.

## 1. Goal

Move role→provider choice out of the provider list and into plugin
settings, and use the `agent.create` hook seam where the contract proves it.

User-facing:

- The SLP surface shows one card per role: **Supervisor → [family] [model]**,
  **Lead → [family] [model]**, Peer → pool-driven (informational).
- Users pick *native* family names (`devin`, `codex`, `pi`, `claude`) and a
  model. They never see `slp-*` provider IDs or twelve provider entries.

Daemon-facing:

- Activation generates only the entries the settings use — typically 4–8
  providers instead of twelve. Hook-injectable families become thin aliases
  (`extends`, no shim/wrapper); devin keeps the full shim + wrapper.
- The plugin writes the two saved profiles already bound to the chosen
  provider and model — the Human no longer edits `slp-*` IDs in the Paseo
  profile editor.

Behavior contract (must stay uniform regardless of mechanism):

- Every managed seat receives byte-identical `roleBundle()` output whether
  it arrived through the hook path or the wrapper path.
- Failure surface is uniform: fail-closed with an actionable error. No
  silent bare spawn in a hook gap.

## 2. Why providers exist at all — constraint recap

The provider entry is the only seam Paseo gives a plugin inside the spawn
path; something must carry the role down to the injection point. The
candidate channels:

| Channel | Status |
|---|---|
| Provider ID → shim/argv (v1) | Proven — each entry owns its command/env |
| `config` marker via profile settings/features | Unverified — arbitrary keys may not survive profile→config, and the hook must be able to read them |
| `initialPrompt` marker | Rejected — visible in the tab, and profiles cannot set initialPrompt |

The `agent.create` hook adds a new *injection* seam (it can write
`config.systemPrompt`; source-proven for codex/pi/claude) but not a new
*signaling* seam: the hook sees only `config` + `env` — no `profileId`, no
`initialPrompt`, no labels. So even under hook injection, role identity
still has to arrive through `config` — normally the provider ID. Thin
aliases keep that signal; the config-marker probe (Phase 0) decides whether
four providers suffice instead of twelve.

Devin/ACP is the exception the design must absorb: the 0.8.0 ACP adapter
drops `systemPrompt` outright (`session/new` sends only `{cwd,
mcpServers}`), so devin keeps the wrapper transport under any variant.

## 3. Target architecture

```
SLP surface ── role cards (family + model per role)
      │ set-role-routing RPC
      ▼
slp-runtime/state/role-routing.json      {supervisor:{family,model,…}, lead:{…}}
      │ consumed at activation
      ▼
desiredProviderEntries(settings) ──► only chosen combos + peers
      │                              thin alias | shim+wrapper (devin)
      ▼
config.json ──► profiles slp-supervisor/slp-lead bound to chosen provider+model
```

Injection paths at runtime:

```
hook family (codex/pi/claude): create_agent → agent.create hook
      → config.provider / marker → roleBundle() → systemPrompt → native CLI
devin:                          create_agent → provider entry → shim
      → verify → role wrapper → roleBundle() → ACP transport
```

`roleBundle()` stays the single render point for both paths — parity is a
tested invariant, not a convention.

## 4. Phase 0 — contract probes (gate)

| Probe | Question | Pass → | Fail → |
|---|---|---|---|
| S3 hook inject | Does an `agent.create` hook-set `systemPrompt` reach a real codex/pi seat at session start and on resume? | Hook path viable | Keep A1 wrappers for all families; Phase 1 still ships |
| Config marker | Do profile settings/features reach hook-visible `config` intact? | 4 providers (role via marker) | 12 thin aliases (role via provider ID) |
| Model enumeration | Can the plugin RPC surface list models per provider? | Model picker inside SLP UI | Model/thinking stays in Paseo profile editor; settings pick family only |
| Sentinel | Can a thin alias + hook fail closed during a hook gap (reload/disable)? | B0 safe to build | Hook path needs another guard or is dropped |
| Devin reconfirm | Does the current build's ACP adapter still drop `systemPrompt`? | (expected) wrapper stays | Revisit devin via hook |

## 5. Phase 1 — settings-driven generation (independent of hook)

Valuable even if the hook path dies.

- `slp-runtime/state/role-routing.json` + `get-role-routing` /
  `set-role-routing` RPCs (same pattern as `communication-language`).
- `desiredProviderEntries` reads settings and generates only chosen
  supervisor/lead combos plus the four peer providers (peers stay
  pool-driven; gating peers by enabled families is a documented option but
  couples repo pools to daemon settings — default is all four).
- Plugin writes both profiles bound to the chosen provider (+model when
  enumeration proves out); reconcile defines who wins between
  settings-driven regeneration and the existing profile bound-edit flow.
- Surface: role cards with pickers; migration path rebinds existing v1
  installs through one re-activation.

## 6. Phase 2 — hook injection (implemented)

As built on `feat/slp-paseo-plugin`:

- `plugin/index.server.ts` registers two `server.before` hooks, implemented
  in `plugin/server/role-injection.ts`:
  - `agent.create` resolves the role from an owned
    `slp-(codex|pi|claude)-(supervisor|lead|peer)` provider id (or the
    `featureValues.slp_role` marker on an un-suffixed `slp-*` id), reads the
    active binding from the journal receipt, re-verifies the published
    candidate via the materializer's `verifyPublished` (cached once per
    candidate sha per plugin process; failures evict so a repaired
    candidate re-verifies), then dynamically imports the materialized
    candidate's `plugin/server/runtime/cli/role-bundle.ts` (cached per candidate sha) and writes
    `config.systemPrompt` — role bundle first, a pre-existing prompt
    appended after it. Foreign providers and `slp-devin-*` pass through
    untouched; an `slp-*` provider whose role, binding or candidate cannot
    be resolved — or whose candidate fails verification — aborts the
    create (fail-closed). `config.provider` is never rewritten. The
    per-create verification also covers `bin/slp-gate.mjs` transitively:
    the gate launcher execs it after this hook in the same launch flow.
  - `agent.session_open` overlays a non-empty per-open
    `SLP_SESSION_OPEN_GRANT` onto the provider env for hook-family ids —
    every open reason (create/resume/refresh/import).
- Thin aliases diverge from the "no command" sketch: a pure `extends` alias
  cannot fail closed (Phase 0 sentinel probe), so each hook-family entry
  keeps its `slp-*` identity + native `extends` and runs a generated
  gate launcher as its single-element `command`, with env carrying the
  managed backstop (`SLP_MANAGED_RUNTIME`, `SLP_NODE_BIN`,
  `SLP_RUNTIME_ROOT`, `SLP_DAEMON_HOME`, `PASEO_HOME`, the family's
  `SLP_*_BIN`) plus `SLP_SESSION_OPEN_GRANT: ""` and
  `SLP_FAMILY_BIN: <resolved binary>`. The gate launcher is a trivial
  `#!/bin/sh` exec script that bakes the verified Node path and exports
  the frozen `SLP_FAMILY_BIN`, then `exec`s
  `<candidate>/bin/slp-gate.mjs "$@"` — required because the host's
  availability probe runs `command[0] --version` with the command tail
  *and* provider env dropped (`resolveBinaryVersion`,
  `diagnostic-utils.js`), so argv0 must be a self-contained executable;
  a two-element `[node, gate]` command would measure Node's version, and
  a wrapper reading env vars cannot resolve them during the probe. The
  gate (`bin/slp-gate.mjs`, shipped in the embedded payload) distinguishes
  launches by `PASEO_AGENT_ID`, which the daemon stamps into
  `launchContext.env` on real session opens (create/resume/refresh/import)
  and nothing else (`agent-manager.js` `buildLaunchContext`). Only a
  session spawn requires the grant: a `PASEO_AGENT_ID` launch whose grant
  stayed empty — the exact hook-gap case — fails closed; launches without
  it pass through, because the host runs the same provider binary + argv
  for capability snapshots and model enumeration outside any session, and
  refusing those leaves the provider permanently unready (first live-smoke
  finding, 2026-09-19: snapshot probes through `provider-snapshot-manager`
  died on the gate and `resolveCreateConfig` rejected every hook-family
  create). The bare `--version` probe answers through the real binary in
  every grant state (host availability probes run outside any session
  open).
- Launch sets publish all fifteen launchers: the nine hook-family gate
  launchers plus six ACP shim dispatchers for Devin and OpenCode. The launch manifest
  still records all five family resolutions for shim validation, and new
  manifests carry `launcherFamilies` (all five families) plus
  `gateFamilies` (codex/pi/claude) so verify replays the right script per
  file (pre-Phase-2 manifests without the fields replay the legacy
  all-shim 12-launcher plan).
- Byte-parity test between hook-rendered and wrapper-rendered bundles
  across all fifteen owned ids (tests/plugin-role-injection.test.mjs).
- Devin wrapper path untouched.
- Live-daemon smoke ran 2026-09-19 (candidate `97a179eb`, commit `390820b`):
  it immediately caught the capability-probe refusal described above —
  fixed the same day. Verified live after the fix: codex seat `af398549`
  spawned through `slp-codex-peer` and echoed `SLP role=peer` (agent.create
  hook injection reached a real seat); `PASEO_AGENT_ID` in the provider
  process env proves the grant path, not passthrough; the grant itself is
  stripped before exec. Plugin disabled → session spawn refused with
  "managed session launched without live SLP hook grant" — fail-closed
  holds on a real hook gap. Settings-driven generation verified live:
  `{supervisor: pi, lead: devin}` routing → one re-activation → six
  entries (chosen combos + four peers), profiles repointed, non-chosen
  combos removed; restored to the devin pair cleanly. Pi/claude seats not
  live-spawned (same hook/gate path; their launchContext.env overlay is
  verified in daemon source); resume/refresh opens not exercised.

## 7. Phase 3 — mixed-artifact operations

- Reconcile/inspect understands both entry kinds (alias vs shim+env).
- Status surfaces mechanism per family only for diagnostics — the user
  contract stays uniform.
- Recovery semantics for agents spawned in a hook gap. The deferred
  failure mode: if the `agent.create` hook is down but the launch itself
  somehow proceeds past the gate (e.g. a spawn path that bypasses the
  sentinel), the seat is created without role bytes — and nothing marks
  it. A later resume/reload of that agent re-opens the session through
  `agent.session_open`, which only supplies the grant; the role-injection
  hook does not re-fire on resume, and the gate cannot tell that the
  seat's durable context is missing its role. Such an agent resumes
  permanently unroled. Phase 3 must decide how to detect and handle these
  gap-spawned seats (e.g. marking creates with a durable role marker the
  gate or reconcile can check on resume).
- Drift/receipt/journal entries record which mechanism each entry uses.
- Gate self-verification: the create-hook's per-sha `verifyPublished` covers
  `bin/slp-gate.mjs` transitively on the normal create→open path, but a
  launch that reaches the gate without a preceding `agent.create` hook (a
  spawn path outside the hook flow) runs unverified bytes. Embedding a
  sha256 check in the shell gate launchers was considered and deferred —
  per-spawn cost plus `sha256sum` availability on minimal environments.

## 8. Explicit non-changes

Peer selection stays repo-pool + Lead judgment per delegation. Delegation
loop, role policies, `initialPrompt` as the visible channel, and the whole
Option A management plane (exclusive window, journal, receipt, reconcile,
immutable candidates) are unchanged. This is a distribution/UX refactor of
how role→provider is chosen and how instructions reach three of the four
families — not a behavior redesign.

## 9. Family registry and consolidated routing surface (implemented)

Post-refactor, `plugin/shared/runtime/families.ts` is the single source of truth
for the family domain. Every family list, label map, provider-id regex,
hook/wrapper classification, `extends` target, binary env name, zod enum
and picker order in `plugin/`, plus CLI family/role lists, provider IDs and
transport targets in `src/`, derive from that one table. The registry is pure data plus derived
constants with zero imports, so the client bundle can import it under the
same host-compiler boundary as `contracts.ts` (no node builtins).

Registry entry shape (chosen over the brief's minimal
`{id, label, transport, binEnv}` sketch):

```ts
{ id, label, transport: "hook" | "wrapper", binEnv, extends, pickerRank }
```

- `extends` records the base provider a generated `slp-*` entry extends
  (devin extends `acp`; the others extend their own id) — it was already
  duplicated across config-view and the OwnedProvider schema domain.
- `pickerRank` records the UI picker's display order separately from the
  canonical declaration order, because the two orders differed before the
  refactor and both were load-bearing.

### Adding a family

OpenCode uses `transport: wrapper`, `extends: acp` for both managed and
standalone installation. Its managed shim additionally requires the enabled
session-open hook grant before launching the per-client ACP child, so a
plugin-disabled create cannot bypass the boundary. Native OpenCode V2 is
unsupported after actual lifecycle proof exposed its shared-runtime gate
bypass. See [OpenCode support](../opencode.md) for version and proof limits.

The three runtime mechanics follow below. Persisted-family expansion also
requires explicit historical-domain, hash, ownership and CAS compatibility
review; registry derivation does not authorize normalization of old records.

1. **Registry entry** — append one entry to `FAMILIES` in
   `plugin/shared/runtime/families.ts`. Every downstream list, regex, schema
   enum, env map and picker derives automatically; the derivation tests
   in `tests/plugin-families.test.mjs` verify that claim.
2. **Executable detection** — teach the resolver the new binary:
   `plugin/server/executables.ts` probe/recognition logic (binary name,
   version probe, any wrapper quirks).
3. **Payload and bootstrap** — the registry ships as exact source bytes.
   The shim keeps its family/role sets so it can validate argv and reject
   unsupported Node before importing TypeScript; its manifest checks stay
   independent. Update those sets and add
   the payload-side role wrapper/gate handling as needed, then run
   `npm run generate:plugin-payload` so
   `plugin/server/generated/runtime-payload.ts` is rebuilt and
   `npm run check:plugin-payload` passes.

### Either/or decisions taken

- **Registry filename** — `plugin/shared/runtime/families.ts`, in the
  dependency-free shared tier included in the CLI install unit and both
  host bundles. There is no facade at the old path.
- **Canonical `FAMILIES` home** — the registry itself. `launchers.ts`,
  `executables.ts` and `config-view.ts` re-export `FAMILIES`/`ROLES`/
  `OWNED_PROVIDER_IDS`/`PROVIDER_EXTENDS` under their historical names
  so existing consumers keep one import site; nothing defines a literal.
- **Peer note placement** — inside the "Role profiles" card, not a
  separate card: the note scopes what routing does not configure and a
  separate card would orphan one line of disclosure.
- **Routing surface shape** — one "Role profiles" card carrying the
  supervisor and lead pickers for every `RoleChoice` field behind a
  single Save that issues one `set-role-routing` call (the RPC payload
  is the full routing object anyway). The divergence warning renders
  once on the card, not per role.
- **Card title** — "Role profiles" (the Human's preferred option in the
  2026-09-19 amendment): the card now edits the full profile each role
  binds — provider, model, mode, feature values, thinking option — not
  only which provider, so "profiles" names the scope better than
  "providers". The subtitle was widened to match. Only the UI title
  changed — the stored artifact keeps its `role-routing.json` file name
  and the `get-role-routing`/`set-role-routing` RPC names, so
  "Save routing" and "stored routing" in the warning still name the
  actual artifact.
- **"Agent profiles" card removal** — by explicit human decision
  (2026-09-19 amendment). Two cards were two views of the same state —
  stored desired vs live — with the precedence rule "routing wins at the
  next activation", a footgun; merging makes the "where do I edit /
  which wins" question disappear instead of needing explanation. The
  bound apply-profiles path was the same exclusive-window operation
  anyway, so nothing is lost operationally; the `profiles` and
  `initialProfileFamily` RPC inputs remain supported for scripted and
  advanced use. Accepted consequence (Human-decided, recorded not
  re-decided): no quick-edit of live profiles in the UI — every
  parameter change applies via activation. Routing is the sole source of
  truth for role config; the live profile is a projection of it plus
  RPC overrides.
- **Features/thinking editable pre-binding** — the routing card carries
  the catalog-driven feature controls (toggle → switch, select → chips,
  a raw JSON field when the provider declares no defs) plus a
  thinking-option picker, so `featureValues`/`thinkingOptionId` are
  editable before the first binding for the first time — the earlier
  trade-off note (features/thinking only editable post-binding via the
  profiles card) no longer applies. Feature defs are fetched per
  routing-form `family|role|model|modeId` pick. **Corrected record
  (2026-09-19, Run 8):** this bullet previously claimed "`CatalogOutput`
  exposes models/modes/features only — no thinking options — so thinking
  stays a free-text field." That was wrong about the host, not just the
  plugin: `paseo.providers.listModels(provider)` returns the full
  `AgentModelDefinition`, where every model carries
  `thinkingOptions?: {id, label, description?, isDefault?, metadata?}[]`
  and `defaultThinkingOptionId?` (verified live: codex and pi list
  low/medium/high/xhigh/max/ultra with default medium; devin declares an
  empty list — it bakes thinking into model ids). The capability existed
  in the protocol; the plugin's narrowed `ProviderCatalogApi` was
  over-narrowed and stripped the fields in `loadCatalog`. `CatalogModel`
  now extends `CatalogOption` with both optional fields, `loadCatalog`
  passes them through untouched, and the card renders a `ChipSelect`
  when the picked model resolves: an auto entry (value `""`, labelled
  `Provider default (<id>)` when `defaultThinkingOptionId` is known,
  else `Provider default`), each declared option with `(default)`
  appended to its label, plus a `<id> (stored)` escape — same pattern as
  the mode picker — when the stored value isn't in the list.
  **Corrected render contract (wave 9, host parity):** a resolved model
  declaring zero options renders **no thinking control at all** — no
  hint, no `(stored)` chip, matching the host where the control only
  exists when `selectedModel.thinkingOptions.length > 0` — and picking
  such a model clears a stored `thinkingOptionId` from the form via
  `applySettingChange`, so nothing stale reaches Save. A model
  declaring a *different* option set still shows the `(stored)` chip.
  No catalog, no picked model, or a model the catalog doesn't list keeps
  the free-text field — the established degradation path. Save maps
  empty fields to absent keys (`RoleChoice` unset semantics — the live
  value is preserved at activation; `null` is the profiles wire shape
  and is never emitted), declared feature controls win over the raw JSON
  base, undeclared keys are preserved from the base, and an empty
  control drops the key.
  **Corrected catalog source (wave 9b, host parity):** `loadCatalog`
  previously made three legacy calls against the base family —
  `listModels`/`listModes`/`listFeatures`. It now fetches provider data
  the same way the host agent profile does: one
  `paseo.providers.snapshot({cwd})` call, then the entry is picked by
  the managed provider id for the request's role
  (`slp-<family>-supervisor|lead|peer`), falling back to the base family
  entry; neither resolves to an entry → the catalog reports an error
  instead of re-asking legacy endpoints (the daemon just proved
  snapshot-capable). Models filter `isSelectable !== false`; modes come
  from the snapshot entry and ship only when `entry.status === "ready"`
  — no `listModes` call happens on the snapshot path. A picked entry
  still in `status === "loading"` is a warmup transient, not a catalog
  answer: the daemon's snapshot read kicks off warmup fire-and-forget,
  while its per-provider `listModels`/`listModes` await the in-flight
  warmup for that provider — so a loading entry resolves through those
  listings on the picked id rather than returning a status string the
  client would cache as a terminal error until a manual Retry.
  Snapshot entries
  carry no feature definitions, so features still go through
  `listFeatures`, on the RESOLVED provider id
  (`<resolvedProvider>/<model>`), not the bare family. `CatalogInput`
  gains an optional `role`; `CatalogOutput` gains `resolvedProvider`
  (absent on the legacy path). `PaseoApi` exposes no `serverInfo`
  accessor, so capability detection is probe-and-latch: one
  snapshot attempt, and a confirmed-absent RPC — the method missing or
  the daemon's `unknown_schema` "Unknown request" reply — latches
  `snapshotUnsupported` for the plugin process (the daemon version is
  fixed for that lifetime) with a one-line warning; any other failure
  degrades that call to legacy without latching, so the next read
  retries the snapshot. Pre-snapshot daemons keep the legacy
  `listModels`/`listModes`/`listFeatures` path verbatim. The
  ManagerSurface cache keys follow the same scope: catalogs under
  `family|role`, feature defs under `family|role|model|modeId`.
  The current public catalog additionally accepts optional `modelPrefix`
  (case-sensitive literal model-id prefix, 1–256 characters), applied after
  host resolution on all paths, preserving order and full thinking/default
  metadata. With no prefix, the model list is unchanged. Devin responses
  expose optional `modelConstraint: {pattern, description}` with regex source
  `^swe-2($|-)`, including on discovery errors; other families currently omit
  it. The shared runtime model constraint supplies both this hint and the
  pool/binding guards. Catalog remains advisory: a host-listed or matching
  model does not grant admission and writes still validate. These plugin-owned
  fields are strictly checked; extensible host descriptors still strip unknown
  fields. See [consumer recipes](../cli.md#provider-model-discovery-plugin-rpc).
- **Provider label unification** — generated provider entries now emit
  one label template for every transport: `SLP <Family> <Role>`
  (`SLP Codex Peer`, `SLP Pi Peer`, `SLP Claude Code Peer`,
  `SLP Devin Peer`), with `FAMILY_LABEL` from the registry as the single
  display-name source. The templates had diverged: the hook branch wrote
  `<family> — <Role> (SLP)` (`pi — Peer (SLP)`, raw lowercase family id)
  while the wrapper branch already wrote `SLP ${FAMILY_LABEL[family]}
  ${ROLE_DISPLAY[role]}`. `label` sits inside `WRITTEN_PROVIDER_FIELDS`,
  so live entries keep their old labels until the next activation
  rewrites them — no migration, and a pre-existing live entry whose
  label differs simply reads as drift until then.
- **"Preferred provider family" / "Initial profiles"** — removed from
  the Activation card by explicit human decision. Routing is the sole
  UI configurator for role→provider; the `profiles` and
  `initialProfileFamily` RPC inputs remain supported for scripted and
  advanced use.
- **Payload coupling** — `bin/`/`src/` deliberately do not import the
  registry; `npm run check:plugin-payload` verifies the embedded payload
  stays byte-identical unless deliberately regenerated.
- **Activation above Role profiles** — Human decision (2026-09-19,
  round-2 polish, complaint: "chưa active vẫn save được role profile à?
  lại còn đặt cái role profile ở trên cái active/bind, xong rồi bấm save
  mà ko báo lỗi dù chưa active/bind"). Activation is the prerequisite,
  so its card renders above the Role profiles card it feeds, and the
  Communication language card no longer sits between the apply action
  and the "re-activation required" warning that names it. The
  Activation card's pre-bind note now references "the Role profiles
  card" by name — the previous "stored role profiles above" copy went
  spatially stale after the reorder.
- **Save disabled until bound** — Human decision. An unbound save wrote
  `role-routing.json` silently (no live profile to diverge from → a
  dead-looking button), and the unbound prefill falls back to the codex
  default, so a careless save + activate could bind the wrong family.
  The Save button is disabled while `statusView.binding` is absent, with
  an adjacent "Activate first" hint naming the prerequisite. The block
  is UI-only: `set-role-routing` is unchanged and scripted pre-binding
  configuration still works.
- **Fields stay editable when unbound** — Lead decision. Unbound edits
  are draft staging for the supported configure-then-activate flow:
  `routingDirty` keeps staged edits across the activation boundary so
  they can be saved once bound. Locking the whole card would remove the
  draft capability for marginal clarity while the disabled Save is the
  hard guarantee against both cited harms. Accepted residual: staged
  edits on the codex-default prefill persist across activation — the
  user re-sees them when saving post-activation.
- **Bound-case save feedback** — after a successful bound save the card
  shows "Saved — matches the live binding." until the next edit
  (`routingSaved`, cleared when `setRoutingDirty(true)` fires). It is
  suppressed while `routingDiverged` so the divergence warning stays the
  single "what happens next" text; the failure path already surfaces
  `lastError`, and unbound saves cannot happen so no unbound feedback
  string exists.
- **Save label + diff-gate** — Human decision (2026-09-19; complaint:
  "nút Save luôn disable — gate `!routingDirty` chỉ bật khi user edit, còn
  form prefill từ stored/live không tính dirty → form hiển thị config mà
  không save được"). The label is "Save" — the card context already names
  the artifact. The dirty flag no longer gates the button; the gate is a
  diff against the stored routing: enabled while `statusView.binding`
  exists AND the form-built `RoleChoice` differs
  (`buildRoleChoice` → `routingChoiceDiffers` → `roleChoiceEquals`,
  comparing family/model/modeId/thinkingOptionId field-equal with
  absent==unset plus `featureValuesKey`-canonicalized featureValues, so
  `{}` vs absent still differs — an explicit clear is a real change).
  Gate and save share the ONE `routingBuilds` path, so an enabled button
  can never write what the gate did not compare. The matrix: bound +
  form==stored → disabled (a save would be a no-op); bound + stored=null
  + live-prefilled form → enabled (the reported case — the shown config
  is not yet persisted); edit → enabled, editing back to stored →
  disabled; just-saved → disabled because `setRouting(result.routing)`
  stores the server's unchanged parse (the strict schema normalizes
  nothing — verified `set-role-routing` returns `parsed.data.routing`
  verbatim, `featureValues: {}` included). Malformed feature JSON counts
  as differing so the press still reaches the save path, which surfaces
  the build error. `routingDirty` keeps its remaining role: it only
  blocks prefill from overwriting staged edits. Unbound stays disabled
  with the "Activate first" hint — the bound check precedes the diff.
  Residual: a declared select feature whose stored value is non-string
  (e.g. `1`) prefills as its string form `"1"`, so the built choice
  differs and Save enables though nothing was edited — honest, since the
  save would write the string form; accepted.
- **Family switch resets dependents** — defect fix (2026-09-19, Run 9;
  complaint: "switching Provider family leaves stale
  model/mode/thinking/feature values that don't belong to the new family's
  catalog — the thinking row then falls into the free-text fallback because
  `thinkingOptionsFor(codexCatalog, "swe-2-medium")` returns null"). The
  family `ChipSelect` no longer routes through the generic single-field
  `setRoutingField`; a dedicated family-change handler applies
  `applyFamilyChange(form, family, catalog)`, which re-validates dependents
  against the NEW family's catalog under keep-if-present rules: `model`
  keeps only if the `family|role` catalog's models list it, `modeId` only if
  its modes list it (pi declares zero modes, so switching to
  pi always clears it; devin `bypass` is not a codex/claude mode), and
  `thinkingOptionId` only if the KEPT model still declares it via
  `thinkingOptionsFor` — the model resolves first, thinking second.
  `features`/`feature` always clear: feature ids are per-provider and
  undeclared raw-JSON keys persist silently into routing (`auto_accept`
  must not bleed into a codex profile). No auto-pick on clear — no family
  marks a model `isDefault`, so the fields land on the picker
  placeholder/provider default. An unloaded or errored catalog lists
  nothing, so everything dependent clears. Two edges of this are
  deliberate (B20, Human decision): re-pressing the already-active family
  chip still runs the reset — the kept model/mode/thinking survive, but
  `features`/`feature` clear; and switching to a family whose catalog has
  not finished loading clears dependents with no re-prefill when the
  catalog arrives — a deferred re-prefill would race with edits the user
  makes during the load, so clear-and-stay is the safer contract. The
  reset fires only on an explicit user family change — stored prefill and
  the pickers' "(stored)" escape hatches are untouched — and afterwards
  the built choice differs from stored, so the diff-gate enables Save,
  which is the correct gate outcome.
- **impeccable principles applied** — visibility of system status (the
  disabled Save + hint state the prerequisite and the saved line
  confirms the bound save), context switch (binding state lives beside
  the config it governs), and memory bridge (the hint co-locates the
  next action with the blocked control).
