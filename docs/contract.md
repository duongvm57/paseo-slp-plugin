# Candidate contract and file map

This revision provides persistent role installation and SLP operating policy for
task-specific topology, supervision and evidence-based acceptance.
Behavioral authority comes from the current Human assignment, installed role
policy and effective workspace protocol.
Local installation/transport checks do not constitute workflow acceptance.

## File ownership

This map covers owners of package behavior and its verification, at file or
module-family granularity. Documentation, examples, release records, licenses
and dependency locks are supporting artifacts, not additional runtime owners.

| Files | Responsibility |
|---|---|
| plugin/paseo-plugin.json, plugin/index.server.ts | Plugin identity/host requirement and synchronous server contribution: register RPCs, construct the owned stores and lifecycle hooks, and return cleanup. No runtime installation at plugin load. |
| plugin/index.client.tsx | Register the Manager surface, workspace work panel, navigation entries and recipient-workspace supervision bell; return contribution cleanup. |
| plugin/shared/contracts.ts | Strict plugin-owned RPC envelopes, receipt, intent and persisted-view schemas plus erased module interfaces used by the server, client and verification adapters. Host-owned CatalogOutput descriptors (model, mode, thinking/select option and toggle/select feature) validate known fields and strip unknown keys; optional desktopTrigger is an opaque host-owned display string, preserving known and future values. Host descriptor additions therefore do not break the picker or widen configuration authority. |
| plugin/shared/supervision.ts | Supervision store migrations, role predicates, effective routes, bounded communication evidence/findings and RPC schemas. |
| plugin/shared/workflow-view.ts, plugin/server/workflow-view.ts | Read-only Human RPC with strict bounded pages. Bind the selected fresh SDK workspace to the verified served-home repository, report capability/state gaps, and reuse the desk projection without accepting client filesystem paths or adding mutation authority. |
| plugin/client/workflow-panel.tsx | Workspace work panel: current brief, decision/ownership/review/evidence and task pages, full-ledger queue counts, omission counts and fresh reads; target lifetime and request sequence reject stale host/workspace completions. |
| plugin/shared/archetypes.ts, plugin/shared/snapshot-catalog.ts | Package seat presets derived from the routing vocabulary, and UI catalog snapshot projections. |
| plugin/client/ManagerSurface.tsx, plugin/client/manager-state.ts | Displayed host/target, operation start/recovery/polling and bounded status; pure routing/pool form construction and comparisons stay in manager-state. |
| plugin/client/target-async.ts | Displayed-target async generation and load lifecycle, including effect replay and stale-result guards; cards retain their own reset, dirty-form and CAS policies. |
| plugin/client/catalog-demand.ts | Target-bound catalog/feature demand, deduplication, cache, retry and invalidation. Manager/card consumers request observations without owning cache lifecycle. |
| plugin/client/cards/ | Language, saved-role routing, Peer pool, Jev and supervision editors. Each card owns its RPC workflow, draft semantics, errors and save confirmations. |
| plugin/client/ui-kit.tsx, plugin/client/supervision-form.ts, plugin/client/supervision-controls.ts | Shared Manager presentation primitives, pure supervision form/projection logic and recipient-workspace bell actions through the single supervision writer. |
| plugin/server/manager.ts | Administrator mutation mutex, accepted intents, durable phase/recovery transitions, fresh binding verification and bounded status. No generic transaction executor or cached verification. |
| plugin/server/journal.ts | Private receipt read/CAS/durable replacement, strict receipt refinements and operation lookup; sidecar state stays outside immutable candidates. |
| plugin/server/config-view.ts, plugin/server/config-transaction.ts | Raw/live configuration observations, canonical hashes, owned-slot projections and pinned persisted-schema planning for activation, reconciliation and semantic restoration. |
| plugin/server/state-store.ts | Atomic private language/routing/Peer-pool state, CAS and legacy-pool import. Exports its own state locations; host configuration remains outside this writer. |
| plugin/server/provider-catalog.ts | Fresh host provider/model/mode/feature observations and bounded catalog projection, optional modelPrefix filtering with host order/thinking metadata preserved, and advisory family model constraints; provider presence or a matching model does not establish health or admission. |
| plugin/shared/runtime/model-constraints.ts | Pure family model restrictions shared by public discovery, the Peer pool wire schema and runtime binding/routing guards. The Devin swe-2 pattern has one source; no provider alias or host inventory determines eligibility. |
| plugin/server/materializer.ts | Immutable payload stage/verify/fsync/rename and retained-candidate receipt anchoring. Owns candidate integrity and publication decisions. |
| plugin/server/launchers.ts | Immutable launcher publication and verification, node/family binding, gate-vs-shim manifests and path ancestry. Owns launch-set integrity and collision decisions. |
| plugin/server/publication-files.ts | Shared asynchronous private-directory, exclusive-write, staging-path and durability mechanics for candidate/launcher publication; domain verification and recovery stay with their callers. |
| plugin/server/executables.ts | Verified ordinary Node and family executable resolution, daemon PATH aliases and forbidden-prefix/symlink rules. |
| plugin/server/role-injection.ts | Bind agent.create to the verified installed candidate's role bundle and runtime helpers, applying transport-specific instruction/environment overlays and minting desk membership through its assigned seam. Task-ticket creates require the exact validated claim and strip the carrier before native execution; ordinary hook behavior is preserved. |
| plugin/server/supervision/state.ts | Served-home supervision file location, schema migration view and the single CAS writer shared by the card and bell. |
| plugin/server/supervision/capture.ts, plugin/server/supervision/assessment.ts | Fixture-backed per-family brief/handback/send capture, provenance gates, strict Jev rubric/link parsing and independent communication findings. Neither reads an assignment pointer file. |
| plugin/server/supervision/observer.ts, plugin/server/supervision/delivery.ts | Lifecycle capture, serialized case/assessment queue and bounded metadata rings; route/recipient revalidation, durable mark-before-send attempts and no uncertain retry. |
| install.sh | One-command local install into the selected destination and Paseo home; reload configuration. |
| plugin/server/runtime/cli/paseo-install.ts | Merge owned provider/profile entries, preserve existing preferences, record rollback binding, initialize repository protocol and Supervisor notebook scaffold; materialize clones a source checkout's protocol, catalog and protocol references into a target checkout with frontmatter paths rebased (Supervisor notebook excluded). |
| plugin/server/runtime/cli/types.ts | Erased CLI contracts for binding, profiles, raw observations, snapshots and launch requests; validation stays with each runtime owner. |
| plugin/server/candidate-module.ts | Select exactly one declared runtime CLI TS, retained src TS or retained src MJS module from an already-authorized candidate; ambiguous layouts and non-regular modules are refused before import. |
| plugin/server/runtime/cli/host-config.ts | Sole reader/writer of the Paseo host configuration; one rule each for owned provider and owned profile verification and the two MCP flags. |
| plugin/server/runtime/cli/role-process.ts | Shared child-process lifecycle, signal/exit propagation, NDJSON framing and backpressure; adapters select protocol mode, instruction transforms and unchanged-frame serialization. |
| bin/codex-role.mjs, plugin/server/runtime/cli/role-transport.ts | Transparent Codex stdio adapter; append installed role instructions at start/resume and existing turn overrides. |
| bin/pi-role.mjs, plugin/server/runtime/cli/role-transport.ts | Pi native append-system-prompt adapter; preserve RPC bytes, host extensions and session/model/thinking arguments. |
| bin/devin-role.mjs, plugin/server/runtime/cli/role-transport.ts | Generic ACP adapter; prepend role core, recovery pointer and current managed communication-language state on every session prompt. First prompts and prompts re-armed by load/resume/fork also carry session-entry helpers and the full measured carrier; no compaction event is required. |
| bin/claude-role.mjs, plugin/server/runtime/cli/role-transport.ts | Claude Agent SDK stream-json adapter; append installed role instructions to the initialize control request's system-prompt append field; all other frames pass through. |
| bin/opencode-role.mjs, plugin/shared/runtime/opencode-version.mjs | Managed/standalone OpenCode V2 ACP adapter: preserve non-prompt frame bytes; prepend role core on every session prompt and entry helpers/carrier on first/re-armed prompts. Refuse native serve and unsupported versions. Managed opens additionally require a live session-open grant before child spawn. |
| src/common.md, src/roles/*.md | Authority, role behavior, conditional policy-text reuse and context-recovery rules; no repository tactics or model IDs. |
| src/delegation.md | Always-loaded Supervisor/Lead delegation core: required review-gate, parentage/placement and ambiguous-create invariants, with distinct managed-desk and ordinary/direct operating pointers. |
| src/references/delegation-execution.md | Ordinary/Lean formation, preparation, manual host verification and uncertain-create recovery; managed task dispatch uses its own guarded path. |
| src/references/orchestration.md | Lead's conditional topology, independent review/council, dependency and integration procedure. |
| src/references/monitoring.md | Supervisor/Lead event observation, heartbeat ownership and bounded-task resource settlement. |
| src/references/report-records.md | Handback submission versus offline schema/evidence validation, claim/observation limits and settlement mirror/export/sink operation. |
| src/references/governance.md | Supervisor scope, causal notebook, evidence-led failure investigation, authorized recovery, cross-project relay and policy evolution. |
| src/references/anti-patterns.md | Conditional twenty-pattern judgment catalogue with specific Inspect evidence, questions and bounded responses; governance owns causal records and authority. Hypotheses, not runtime detectors or a mandatory full audit. |
| src/references/provider-routing.md | Supervisor/Lead profile selection, Peer pool selection, validation and handoff; conditional pointer to Jev routing procedure. |
| src/references/jev-routing.md | Conditional Jev routing procedure: load only for `shadow`, `armed` or `error`; `error` blocks the dependent branch. |
| src/references/review-gates.md | Selected independent mandates for material questions and Human/protocol requirements, with explicit no-trigger and authorized waiver decisions; Lead-owned verification distinct from review seats, neutral briefs, visible disagreement, task-specific stop conditions and premise escalation. Briefs and reports carry falsifiable proof questions and Reviewer coverage statements (`roles/peer.md` also sets the Engineer delta self-check and Reviewer finding format); conditional tools are lens ordering, findings-then-addendum, candidate-bound receipt reuse (Lead keeps sufficiency, R1/R2 replay and acceptance), property-first repair rulings and effort-bound checkpoints. Explicit protocol obligations remain binding. |
| src/references/task-execution.md | Existing guarded desk tools: shared projections/briefs, scope review, task dispatch/result/ruling/integration/reconciliation; declares operation boundaries and unsupported capabilities without a mirrored state machine. |
| plugin/server/runtime/cli/report-records.ts | Report-block extraction, JSON schema, exact-fence semantic rendering and filesystem evidence adapter for the shared v1 validator. Referenced reads use the verifier's `--repo` when supplied, otherwise record-declared candidate roots. |
| plugin/server/runtime/cli/review-packet.ts | `review-packet <repo> --base <ref>` (`--since`, `--evidence`, `--out`): facts-only review packet — candidate head/snapshot sha256/file count from `snapshot()`, change set against the git base including untracked files with numstat, optional delta against an earlier candidate copy or saved snapshot JSON, optional evidence files as path/sha256/bytes. Read-only, offline, deterministic; no verdict, writer identity or finding; evidence is never interpreted (no repo-specific receipt parsing); `--out` must resolve outside the repository: the guard walks the lexically normalised path component by component with `lstat`/`readlink`, following every symlink including a dangling leaf or chain by its link target, and fails closed on a loop (limit 40); a symlink that resolves outside stays allowed. The check precedes the write, so a path changed in between (TOCTOU) is not covered. Blocking-safety property: no path either command reads or writes may block on a special file — `--evidence`, the `--since` file, the `record-build` request file and every `outputFile` must be regular files (checked by `stat` before opening); `--since` may also be a directory; `--out` must be a new path or an existing regular file (a fifo, device or directory is refused, never opened); the measured tree must hold no special file where git lists a tracked entry (checked by `lstat` before `snapshot()`; git never lists an untracked fifo). All fail closed with exit 1 and no output; unknown base, missing evidence or `--since` fail closed with exit 1 and no output. Two-way rule (plugin → repo): the invariant is that review facts a neutral brief carries are measured by one deterministic tool for every project using the plugin, not retyped; a repository protocol or harness serves only its own checkout and ceremony, and cannot supply this across projects. |
| plugin/server/runtime/cli/record-build.ts | `record-build <request.json>` (`--out`): builds one fenced v1 handback `slp-record` from seat, verdict, repository and checks (`cmd`, `exit`, `outputFile`). `sha` is the SHA-256 of the exact output-file bytes, the candidate is `snapshot()`; a request carrying `sha`/`output`/`outputRef` is rejected, so no placeholder enters. Files inside the repository become `outputRef`; files outside become inline `output` (valid UTF-8, 64 KiB cap). Missing/unreadable/oversized/non-UTF-8 output is an error with exit 1 and no output — never `sha: null`. The record is validated with the shared validator (`--repo` = repository) before printing; `--out` must be outside the repository, by the same guard as `review-packet` (symlink-following; new path or existing regular file only; request file and outputFile must be regular files) (shared `assertOutsideRepository`; TOCTOU between check and write is not covered). Two-way rule (plugin → repo): the invariant is that a handback's sha comes from bytes rather than from the writer's typing, for every project; the record schema and verifier are plugin-owned, so repository tactics cannot own the generator without copying them. |
| plugin/server/runtime/cli/candidate-verify.ts | Read-only handback-claim verifier (P1 `verifyHandback`): measures a report's `slp-record` claims against the caller-pinned `--repo` root — never the record-declared root — via bounded double-capture `snapshot()`/`git status` probes (`--no-optional-locks`, timeout/byte-cap), contract/artifact pin hashing, seat observation over `<paseoHome>/agents/` daemon files, and a runtime measurement comparing `identity(packageRoot).sha256` against the optional `--expect-runtime` candidate hash (`report-only` when absent). Emits the `slp-verify-handback` JSON view with closed comparison/reason enums and a completeness ledger; the one-time capability preflight is the only `CAPABILITY_GAP` source, everything after it is `IO_FAILURE`, and the view is evidence — never acceptance, quiescence or a command re-run. |
| plugin/server/runtime/cli/routing.ts | Resolve the repository catalog, falling back to the plugin-owned user-scope pool at `<paseoHome>/slp-runtime/state/peer-pool.json` when absent; bind a server- or Lead-selected option with fresh hash and availability checks. `optionExclusions` is the single eligibility predicate — closed-vocabulary tokens (`disabled`, `availability:<state>`, `role-not-listed`) shared by enforcement and Jev candidate generation. `validateCatalog` stays shape-only apart from normalizing the legacy `optionIds` quota-fallback list in place on read (≤1 → `optionId`, >1 fails closed — wave 6) and refusing the Jev decline sentinel as an option id — a shape-level collision; the semantic layer reports a reserved standard-seat id whose tokens diverge from the package set as a Token conflict on every read, and `catalogBinding` refuses to bind one. `catalogBinding` verifies a supplied Jev receipt offline — including the vocabulary version it was issued under — and requires one when the daemon arms `jev.capabilities.routing`. |
| plugin/shared/runtime/routing-vocabulary.ts | Single routing-criteria vocabulary for CLI, server and Manager: four axes, 16 exact-match tokens, 12 reserved standard-seat token sets, reading helpers and English Jev guidance, versioned together under `ROUTING_VOCABULARY_VERSION`. Callers import this source directly; no vocabulary mirror. |
| plugin/shared/runtime/families.ts | Dependency-free provider-family and role registry for CLI, server and Manager. Derives provider IDs, transport targets, classifications, labels and picker order. The shim retains bootstrap-local sets to reject unsupported Node before TypeScript loads and validate recorded launch manifests independently. |
| plugin/server/runtime/cli/jev.ts | Jev (TypeSafe System One) bounded-decision transport — never an ACP provider. Per-daemon config/key resolution (fail closed, all toggles default off) over two provider kinds: `openrouter` (Decisions API, pinned `typesafe/jev-1.13`, `provider.allow_fallbacks: false` on the wire) and `typesafe` (first-party `POST {baseUrl}/v1/systemone`, pinned `jev-1.13.0`, no provider field; baseUrl may be a custom https origin+path prefix) — each with its own model pin and baseUrl rule, calls with ~5s timeout and at most one bounded retry, typed-answer validation, credential-shaped-string redaction before send, and decision-receipt build/verify with the pin chosen by the receipt's provider kind. Receipts prove consistency, not authenticity; confidence is recorded, never a threshold. Provider endpoint/model rules and credential preflight/sanitization use the shared `runtime/jev-transport.ts`; CLI config parsing, typed answers and retry policy remain here. |
| plugin/server/runtime/cli/jev-routing.ts | First Jev consumer: `route-decide` computes the deterministic eligible set from `optionExclusions`, drops Token-conflicted seats from candidates (reporting every catalog conflict on the receipt), sends the Lead-authored brief as state plus the versioned English suitability guidance and the compact per-token glossary (never raw assignmentFile bytes; catalog `notes` withheld) and emits the option id plus receipt. The per-option surface is fixed-shape — `id`, `provider`, `model`, `thinkingOptionId` (explicit `null` when absent), `suitableFor`, `avoidFor`. Decline exits nonzero; `jev-no-candidates` when no usable seat remains. Runs on explicit CLI invocation or an admitted slp_seat_create executor — no loops, schedules or prepare-time calls. |
| plugin/server/runtime/cli/seat-selection.ts | Ordinary Peer choice discovery and selection. Off/unconfigured auto-pins only a sole eligible option; several options require independent selection. Shadow always requires independent Lead choice and retains the advisory pair; armed invokes routeDecide once and fails closed on decline/config/key/transport/schema errors. Full receipt plus source/catalog/config fingerprint is retained before native create; prepare remains offline. Choices and selection evidence each have a 32 KiB bound; at most 32 visible choices with omission counts. The plugin owns this invariant because a repo harness cannot serialize decisions with the desk's durable native-effect intent. |
| skills/paseo-slp-onboarding/SKILL.md | Evidence-based protocol adaptation and grant-aware writing before asking only missing decisions. The protocol holds the workspace's orchestration tactics adapted under its writing rules; invariants stay in role policy and operational facts in `.paseo-slp/references/`; conditional custom interview, exact authorized protocol diff and Peer pool setup with Supervisor/Lead profile verification. Supporting resources disclose setup details. Skill installation remains independent from repo initialization. |
| src/templates/workspace-protocol.md | Compact adaptable repository tactics, including a tiny procedure, outcome routes, local review triggers and completion decisions. Onboarding fills assignment, execution and delivery settings in one effective repo protocol, whose Repository references section points to operational facts (check commands, skill layout) kept in `.paseo-slp/references/`; filling configuration and references is not an Override; init still uses this default and preserves existing files. The `agent_mode` field records intended spawn mode for direct launches (empty falls back to the bundle's `modeId`, then asks). |
| plugin/server/runtime/cli/binding.ts | Every rule a Binding must satisfy: setting patterns, the route override deny-lists and the single provider-health check. Uses the shared family registry for provider transport targets. |
| plugin/server/runtime/cli/role-bundle.ts | Which policy bytes each role receives at session entry, and their order. Session-entry instructions also carry the carrier block (spawn kit plus role-scoped policy-byte locators, directory stated once, paths relative) so profile/provider launches receive the same payload prepare places in initialPrompt. Peer locators include `common.md` and `roles/peer.md`; Supervisor/Lead locator sets remain complete. Managed install/upgrade/uninstall helper lines are emitted only for orchestrating roles. Managed session entry injects the plugin-set communication language (slp-runtime/state/communication-language) when present. ACP delivery freezes the verified candidate core and carrier at adapter startup, reads language per prompt, and explicitly clears earlier runtime language instructions when unset; other transports retain entry-time language semantics. |
| plugin/server/runtime/cli/launch.ts, plugin/server/runtime/cli/profiles.ts | Select one Binding source (saved profiles, catalog routing or an explicit binding), then compose the create_agent argument record. launchPlan accepts a server-internal third context only after same-Git qualification: source routing/protocol and target execution are separate, never CLI JSON catalogFile overrides. launchPlan and handoffPlan share one builder; preparation state and validation operations also serve launchCheck, preserving each path's diagnostic order and fresh final revalidation; nothing edits the create record afterwards. Handoff adds explicit authority, old-owner evidence, resources and current work snapshot; no lifecycle mutations. request.inventoryFile fills providers/profiles the request did not inline; request.assignmentFileMode defaults to pointer, preserving the read-first prompt; snapshot mode reads and inlines a bounded, validated repository-contained copy during prepare. The same choice applies to prepare-handoff; the daemon never reads the file. The plan also surfaces the intended `modeId` (with a warning when the binding lacks one), a `spawnKit` of role-appropriate MCP tool signatures, and an `orientation` manifest of policy-byte locators (path/bytes/sha256, `missing` for receipt-declared files absent on disk; the set derives from the install receipt, so source-only documents are never declared) — locators only, never interpretation; the same payload is carried inside `create.initialPrompt`, the only field create_agent transmits, so the spawned seat actually receives it. The prompt-side carrier is omitted only when the binding targets the canonical `slp-<family>-<role>` wrapper and the request's live provider inventory observed it — the wrapper injects the carrier at session entry; unverified targets keep the prompt fallback. |
| plugin/server/runtime/cli/assignment-file.ts | How `request.assignmentFile` reaches the seat prompt: `assignmentFileMode` selection (pointer default, snapshot opt-in), the guarded snapshot reader (repository-contained, 16 KiB cap, UTF-8, no symlink, no nested marker, no credential-shaped content, changed-while-read refusal) and both prompt forms — the read-first pointer line and the marked inline snapshot. |
| plugin/server/runtime/cli/inventory.ts | Provider/profile inventory in the exact shapes prepare consumes: `paseo provider ls --json` only when the requested home's paseo.pid names a live process, else that home's own config.json `agents.providers` — never another daemon's providers, no directory materialization; provider `enabled` may be null for unrecognized states; profiles always from `daemon.agentProfiles`. Explicit `prepare --live` instead verifies the requested home via daemon status, pins provider listing to its reported endpoint, and rejects changed profile bytes or any configured-only fallback. Read-only; on multi-daemon hosts the live listing reflects whichever daemon the paseo CLI reaches. |
| plugin/server/runtime/cli/agent-state.ts | Shared read-only discovery of daemon persistence (`<paseoHome>/agents/*/<id>.json`) for agent listing and monitoring. A missing root yields no records; other root errors propagate; broken groups and records are skipped. Preserves filesystem read order and duplicate IDs, leaving projection and duplicate resolution to callers. |
| plugin/server/runtime/cli/agents.ts | Agent listing projected from `plugin/server/runtime/cli/agent-state.ts`, sorted by id with duplicate records retained, with shell-quoted devin-family `devin -r` attach hints; works around `paseo inspect`/`ls` not surfacing `persistence.nativeHandle`. Read-only, best-effort host detail. |
| plugin/server/runtime/cli/spawn-kit.ts | Package-owned approximation of the Paseo MCP tool surface per role (orchestrating vs peer), emitted in prepare plans so seats skip live schema re-derivation; marked approximate; unfamiliar parameters or an observed mismatch require a specific live schema lookup. |
| plugin/server/runtime/cli/monitor.ts | On-demand signal scan over daemon-owned agent state discovered by `plugin/server/runtime/cli/agent-state.ts` (last record per id wins) plus each declared worktree's git status; emits `{agentId, kind, evidence, observedAt}` candidates (attention, follow-up-round, idle-dirty, scope-drift, test-mirror, file-churn, tool-mix, correction-cadence) only for new fingerprints when a stateFile checkpoint is supplied — that checkpoint is the only write. Never a verdict, daemon or rendered-log parse; broken cwd becomes an evidence gap. An opt-in `devinSessionsDb` request field probes the devin CLI sessions.db read-only for devin-family agents (joined by `persistence.nativeHandle` = `sessions.id`; a missing or unmatched handle is a gap — never a cwd guess) to derive tool-mix and correction-cadence candidates; every failure is an evidence gap, not a crash. |
| plugin/server/runtime/cli/notebook.ts | Read-only locator for a repository's active governance notebook: resolves the repository's git common dir — the property linking a worktree back to its repository — then lists Supervisor agents (provider containing `supervisor`, or a Supervisor-titled state file) whose `cwd` shares it. Output is candidates only, sorted by lastActivityAt, each with notebook path and `notebookExists`; broken agent cwds become gaps. Never copies or mutates notebook content, and picks no authoritative candidate — governance stays per-checkout. |
| plugin/server/runtime/cli/package.ts | Package identity, exclusive staging, integrity checks and stable Git work snapshot; untracked nested Git work-tree roots are snapshotted recursively under `nested`, sub-repos can carry their own `nested`, and index gitlinks record `{path, kind:"gitlink", indexOid, headOid, state}` with non-clean states listed in top-level `incomplete`. |
| plugin/server/runtime/cli/runtime-state.ts | Read-only plugin-state probes (H13 workaround): `localTarget` mirrors the plugin's daemon-home detection; `runtimeStatus` recomputes the file-derivable parts of the daemon `status` view — receipt, owned providers/profiles, runtime and launcher integrity, config-drift presence — and reports daemon-only views (live conflicts, family availability) as gaps, never guesses. The Jev probe reports `hasKey`/`keyPermissionsOk` only — key material never enters output. Fails closed on corrupt plugin state. Mutation RPCs are Human-authority and are not exposed. Retire when the host ships `paseo plugin invoke` or MCP `invoke_plugin_rpc`. |
| bin/slp.mjs | Bootstrap-safe Node version guard; imports `plugin/server/runtime/cli/cli.ts` only after the version passes. |
| plugin/server/runtime/cli/cli.ts | Install/upgrade/preview, verify/uninstall, init, materialize, routes, prepare/handoff, inventory, agents, monitor, notebook, records (extract and validate `slp-record` blocks with optional evidence reads), review-packet and record-build (review facts and record drafting, see their rows), verify-handback (the read-only `verifyHandback` facade — `slp-verify-handback` JSON view on stdout, typed `<CODE>: <message>` errors on stderr), identity, snapshot, instructions (raw session-entry bundle bytes on stdout, provenance on stderr), route-decide (explicit CLI routing invocation, network, emits a receipt; the admitted slp_seat_create executor can also invoke Jev; prepare and prepare --check stay offline), status and local-target (read-only plugin-state probes), and desk-recover (the P2-e operator-only desk lock recovery — resolves the repository to its repoKey, runs the shared auto-mode algorithm, exits 0/1/2) entrypoints. |
| plugin/shared/enforcement.ts | Strict desk wire schemas, inferred tool input types, error vocabulary and bounded views. Owns the scope/rollout transition edge tables shared by command decisions and durable store refinements. |
| plugin/server/daemon-home.ts | Shared daemon-home detection, verified filesystem resolution and receipt/target matching. Detection alone is a UI suggestion; mutations require the verified home and task authority. |
| plugin/server/capabilities.ts | Curated capability evidence with source pins, closed statuses and explicit gaps. Static compatibility proves interfaces; live delivery requires live-probe evidence. Provider presence never establishes capability. Formation SDK ref/refresh/open/create ABI evidence is separate static metadata, with typed SDK assignability in the server entry; the published 39-row capacity and 64KiB view budget remain unchanged. |
| plugin/server/runtime-pin.ts | Read-only runtime binding verification against the served home's receipt, target and published payload integrity. Emits a canonical pin digest or a closed not-bound reason; faults remain typed faults. |
| plugin/server/enforcement.ts, plugin/server/limitations.ts | Read-only `readView` for installation state, capability evidence and membership projection. Reads bounded `repos/*/ledger.json` under the verified served home, emits `SeatBindingView` rows for memberships carrying an `agentId`, and accounts elisions in the completeness ledger. `limitations.ts` owns the shared limitation literals. The unused P0 `dispatch` placeholder is retired; desk mutations enter through `desk-bridge.ts` and the feature runners. |
| plugin/server/desk-store.ts, plugin/server/kept-files.ts | Durable desk store kernel (ledger v9): header-first absent/ok/corrupt/future/unsafe reads, in-memory v1→v2→v3→v4→v5→v6→v7→v8→v9 migrations and `schema-migrated` on the first successful post-bump commit. Per-repo `O_EXCL` locks plus an in-process mutex protect idempotent `transact` replay keyed by canonical `bodySha256` of `{repo, command}`. Decide outputs replace complete tables; the store checks schemas, cross-table identities, ownership at committed event time and full-chain refinements while features own command semantics. Immutable hash-chained event segments precede the `ledger.json` rename commit point; ledger bounds and task recovery headroom reject before either write. Live holders yield `CAPABILITY_GAP`, dead/unknown holders `RECOVERY_REQUIRED`; operator-only unlink belongs to recovery. Imports the canonical namespace layout from `runtime/desk-paths.ts`; `kept-files.ts` supplies policy-aware directory guards and re-exports the shared syscall primitives. |
| plugin/server/runtime/report-records.ts | Canonical typed v1 validator and frozen record vocabulary, with optional purpose-specific semantic reports; evidence and realpath are injected capabilities. No schema or host dependencies. CLI and desk facades use this implementation directly. |
| plugin/server/runtime/lock-holder.ts | One interpretation of desk/bridge/recover-lock holder bytes and process-probe outcomes, plus a Linux/WSL boot UUID + process-start-ticks identity probe (unavailable on other hosts). Callers retain waiting, re-entry, release, audit and recovery authority. |
| plugin/server/runtime/desk-recovery.ts | Canonical audited recovery state machine, sync operator CLI driver, async plugin driver and strict output projection. Two checkpoints preserve race barriers; thrown/rejected hooks re-enter the generator so recover-lock cleanup runs. |
| plugin/server/runtime/desk-paths.ts, plugin/server/runtime/filesystem.ts | Desk namespace derivation, path layout, bridge sentinel and low-level filesystem primitives shared by CLI recovery and plugin durable stores. No schema or host dependencies. |
| plugin/shared/runtime/jev-transport.ts | Dependency-free Jev provider defaults, model patterns, URL path rules and POST extras; one ordered credential detector/preflight and scrub-before-cap sanitizer. Adapters retain their error classes and config/HTTP lifecycle policies. |
| plugin/shared/runtime/session-delivery.ts | Published session-entry/launch/snapshot literals and carrier captions shared by producers and capture. Recognizer grammar stays explicit in its parser; historical wire bytes remain compatible. |
| plugin/server/jev.ts | Jev state/key RPCs and single-shot supervision requests. Strict plugin Zod config validation, CAS, auth-probe policy and stop cancellation stay here; disk/key observations and locations come from runtime/jev-state, provider/credential rules from the shared runtime. |
| plugin/server/runtime/jev-state.ts | Jev config/key namespace, uncached raw config/hash observations, stat-only key presence and private regular-file checks before secure key reads. CLI retains historical OFF/unknown-key tolerance; plugin persisted/RPC schemas remain strict. Each adapter owns its diagnostics and capability policy. |
| plugin/shared/runtime/desk-contract.ts, plugin/shared/runtime/node-version.mjs | Plain formation reason/recovery-result vocabulary, immutable-operation recovery text and diagnostic bounds; bootstrap-safe supported Node range/check shared by resolver, shim and CLI. Shared runtime has no Node imports or types. |
| plugin/server/runtime/cli/ | Standalone CLI runtime: command parsing, installer/identity, verifier/snapshot, policy rendering, routing, agent observations and role transport. Source is colocated with plugin-owned core, but remains an adapter tier; core cannot import CLI modules. `src/` contains only policy/template assets. `bin/` bootstraps and development-only runtime scripts call this runtime directly. |
| scripts/generate-plugin-payload.mjs, scripts/runtime-graph.mjs | `installUnitPaths()` owns the exact source-byte install unit, including only the two selected plugin runtime subtrees. Legacy identities allow absent runtime roots. The generator encodes bytes/modes and rejects missing, external and reverse-tier dependencies, including erased type imports; graph analysis is development-only. |
| scripts/generate-readme-diagrams.mjs, docs/images/slp-overview*.svg | Documentation-only SVG source and generated English/Vietnamese README overviews. One layout owns role placement, theme colors and localized labels; `--check` compares the generated assets without writing. Outside the runtime install unit. |
| plugin/server/desk-recovery.ts, plugin/server/runtime/cli/desk-recovery.ts | P2-e operator-only desk lock recovery: one closed 17-result algorithm exposed by the provenance-gated `enforcement-recover-lock` RPC and the operator-home `desk-recover` CLI. Orphan unlink requires holder parse, ESRCH, unchanged byte re-read, fsynced pre-unlink audit and directory fsync. `recover.lock` serializes recoverers and is never auto-removed; `internal-error` is the only exception sink. No `--force`, `expected`, membership-hook or transact recovery path; the bridge lifecycle alone may invoke the shared kernel for its reserved lock with actor `plugin:desk-bridge` and a process-identity probe. Operator CLI/RPC recovery remains ESRCH-only. Both adapters use `runtime/desk-recovery.ts`; the sync/async driver and surface regression corpus covers the closed results and race schedules. |
| plugin/server/desk-command.ts | Pure command invariants shared by handback, settlement, scope, check and rollout: deterministic tuple-derived ids, live registered membership, lead role and owned open assignment guards. Features retain their command schemas, state machines and rejection diagnostics. |
| plugin/server/desk-runner.ts | Shared store dependency, bound caller context, fresh ledger reads and strict repo envelope projection. Capture, export verification and check execution dependencies belong to the feature runners that use them. |
| plugin/server/desk-assignment.ts | Owner-only immutable brief/decision commands, revision CAS and assignment-local digest lineage. One pure, closed workflow projection supplies both the membership-guarded agent reader and the verified Human RPC. |
| plugin/server/desk-task.ts, plugin/server/desk-task-history.ts | Native task commands and internal effect admission over the additive v9 taskEntries stream. Shared current readiness/result qualification, immutable event-time authority, exact dependency evidence and recovery accounting; no SDK effects or second writer engine. |
| plugin/server/desk-task-capacity.ts | Pure post-state reserve for remaining task requests, records, memberships, assignment seats, scope transitions, events and serialized bytes. The store applies the same reserve to every commit; issued effects and finite cleanup cycles retain their unconsumed credits. |
| plugin/server/desk-task-execution.ts, plugin/server/desk-task-execution-host.ts, plugin/server/desk-task-execution-git.ts | Lead-invoked task dispatch, positive-identity observation/reconciliation and controlled integration through Core admission. Each new send appends a deterministic delivery trailer (Lead text sha256, assignment/task/attempt ids, verified parent agent id; a claim, not authority) and rejects `REQUEST_TOO_LARGE` before any effect if the composed prompt exceeds the wire limit; pre-trailer attempts replay without it. Bounded SDK/argv/Git/filesystem seams, exact base/result maps, three-way preservation, isolated stage/check and explicit retained proof/cleanup. No automatic retry, commit, push or deployment. |
| plugin/server/desk-task-services.ts, plugin/server/desk-task-access.ts, plugin/server/desk-task-host.ts, plugin/server/desk-task-runtime.ts | Production assembly: verified repository checkout roots and private per-repository IO, bounded connected SDK waits, installed-candidate measurement and fresh pool/Jev runtime resolution. Timeout preserves effect uncertainty; a supplied path cannot expand authority to a foreign repository. |
| plugin/shared/delegation.ts, plugin/server/desk-formation.ts | Strict ordinary formation input (optional Peer runtime or mutually exclusive independent selection; optional caller/existing/worktree-gap placement) and native SDK composition: derive caller parent and qualify the target workspace/cwd, resolve the active installed binding and launch plan per invocation using config-view saved profiles and connected providers, then pin that exact candidate through create/observe/send. A pre-invocation rebind is admitted only after fresh verification; mid-effect drift retains the created identity and withholds delivery. Automatic selection comes from the bound candidate, once inside an admitted executor; replans verify its source/catalog/config fingerprint offline. Omitted-placement full-runtime requests retain their five phases and never acquire a new Jev decision. No task enrollment, provider fallback or caller settings overlay. |
| plugin/server/desk-placement.ts | Formation-only workspace ref/refresh/open and cached qualified-handle create, bounded waits, canonical Git-common-dir equality, source/target HEAD and config pins. Formation uses a configured caller top, or the configured same-Git main checkout when a linked caller has neither config file, for routing/protocol and the SDK target for execution; inherited source pins survive Lead-to-Peer hops; absent trustworthy linked source fails closed; differing target-local configuration refuses. No workspace.create, Git worktree add, setup, dependency install or materialization. Timeout retains known IDs/cwd/correlation without retry. SDK open may register/revive a directory workspace and refresh Git/forge; active-only refresh cannot inventory archived history. Plugin owns this invariant because protocol/harness cannot qualify fresh SDK identity or record the effect winner. |
| plugin/server/desk-seat-observation.ts | Fresh native tuple/parent/runtime/label observation shared by formation and managed task execution through a read-only agent-ref/refresh interface; missing evidence stays uncertain. Shared private create-ticket error formatting redacts before truncation. No ledger, membership, placement or effect ownership. |
| plugin/server/desk-membership.ts | Shared exact live registered-member predicate for task binding and ordinary formation; formation also matches role, provider, cwd and workspace. Read-only; no task enrollment or synthetic hook repair. For new formation semantics, native identity without live registration after a bounded read-only wait is seat-pending, with ID/evidence and same-request operation_get action retained; legacy omitted full-pin Peer/Lead delivery bypasses this gate. |
| plugin/server/desk-operation.ts | Private immutable formation/delivery invocation receipts under state/operations. Read-only optional choice preflight follows retained-history inspection and rechecks concurrent admission before returning; it admits no intent/effects. Exclusive intent publication admits one executor, fsynced phase records precede effects, and retained lineage/results supply read-only replay. Partial/crashed/corrupt records never resume or overwrite an operation. Native operation identity remains stable across membership epochs; original caller epochs stay immutable. Separate from the installation journal and task ledger. |
| plugin/server/desk-delivery.ts | Semantic new-task composition over existing Core define/bootstrap/send and a targeted current-task/attempt view. Caller owns separate grants, scope/review/proof/runtime decisions; composition derives subrequest identities and fresh next-phase CAS. No task transitions, scheduler or result adjudication are added here. |
| plugin/server/desk-ownership.ts | Planned same-assignment offer/accept commands, exact live membership and revision checks, immutable receipt replay, participant reads and shared current reviewer exclusions. Current/historical owner resolution remains in the store kernel; acknowledgment transfers responsibility without cleanup, project acceptance or host lifecycle operations. |
| plugin/server/runtime/report-semantics.ts, plugin/server/runtime/handoff-recap.ts | Dependency-free optional semantic report validation/rendering and explicit-source handoff recap. Preserve v1 envelope and original fence bytes; distinguish supplied claims from fresh measurements and expose missing context without lifecycle operations. |
| scripts/review-copy.mjs | Development-only pinned candidate copy for independent writable probes, outside the checkout and install unit. Preserve ordinary snapshot identity, reject unsupported nested/gitlink candidates, and leave cleanup with the caller. |
| scripts/test-isolated.mjs | Entrypoint of `npm test`: runs `node --test` with a temporary `PASEO_HOME` and a minimal environment (PATH, HOME), forwards test files/flags and the exit code, and removes the temporary directory. |
| plugin/server/desk-seat.ts | The P2-c seat binding handshake (env-only): `DESK_FIELD_POLICY` is the §2.1 field × phase table as data (the single field policy; `ExactKeys` pins every branch two-way to its SDK source type, with compiler-API negative controls), `decideSeatCommand` applies the bounded TTL sweep and the `seat.mint`/`seat.bind`/`seat.register`/`seat.revoke` commands (guards against `BINDING_TRANSITIONS` with explicit P2-c targets, `INVALID_RECORD` + `MEMBERSHIPS_FULL_PREFIX`/`HANDLE_COLLISION_PREFIX` for a full table or handle collision, bounded sweep `ttlSweepPerCommit`, one event per row change, payloads never carry the handle), and `createDeskSeat` exposes the four fail-open seams (`deskMint`/`deskBind`/`deskRegister`/`deskRevoke`) with the §4.2 one-error-one-code repo resolution, the `hookDeskTransactMs` budget (unref'd timer, handlers attached before the race), and one bounded `console.warn` per failure. The task-create path supplies an ephemeral ticket/config context for one atomic versioned capacity claim; the role hook refuses native creation when that required claim fails. The raw ticket and handle never reach the ledger, events, or diagnostics. |
| plugin/server/desk-bridge.ts, bin/slp-desk-mcp.mjs | The P2-d desk MCP bridge transport: the packaged binary is a stdio↔UDS NDJSON relay (successful frames retain their raw bytes) (262144-byte raw-line cap in both directions, `REQUEST_TOO_LARGE`/`RESPONSE_TOO_LARGE` typed rejections, reconnects for the lifetime of open stdin with 100/200/400/800/1600ms capped backoff, Windows `CAPABILITY_GAP`, no TCP). The stable root is owned by one PID namespace; sharing it across PID namespaces (including another WSL distro or container) is unsupported because ESRCH is namespace-relative. The plugin-side adapter resolves the verified stable root through the launch set (`launchers.verify` — manifest `daemonHome`/candidate ancestry, independent of `PASEO_HOME`), takes one `O_EXCL` lifecycle lock under the reserved repo namespace (`deskBridgePaths` — live foreign holders get a bounded wait then `CAPABILITY_GAP: desk-busy`; provably dead holders are reclaimed through the serialized recovery seam with unchanged-byte recheck, fsynced pre-unlink audit (`actorKey: plugin:desk-bridge`) and directory fsync; ESRCH or a mismatch against the recorded Linux/WSL boot/start identity proves the old instance dead, while live old-format holders, unreadable records, EPERM and identity doubt remain untouched with `CAPABILITY_GAP`/`RECOVERY_REQUIRED`), binds `state/enforcement/desk.sock` at `0600`, and serves the pinned handshake (`slp-desk-bridge/1` hello = handle + self-reported `bridgeSha256` checked against the launch-set pin). Rejection ACKs may include bounded optional recovery text under the same protocol; the relay strips control characters and line separators, caps received recovery to 1024 code units in its single-line diagnostic, and accepts older ACKs without it. Each reconnect re-sends the same handle + binary pin; a still-valid durable membership may re-hello after restart, with no guard bypass. Initial stdin stays paused for up to 11500ms until the first positive hello ACK, with dialing and transient hello failures retried throughout that time budget using the capped backoff (the 1600ms delay repeats), including an absent or refusing socket. Each hello is bounded by 10000ms and the remaining startup budget; a permanently rejected hello (invalid record, pin mismatch or authority refusal) or spent initial budget releases requests as typed errors. After a socket drop, unsent requests stay paused for 700ms (100+200+400ms from the backoff schedule), measured from the drop and never renewed by retries. An ACK inside the window forwards held requests in order; expiry answers held and arriving requests with JSON-RPC `CAPABILITY_GAP` until connected, and remains binding across stdout backpressure and a late ACK. Accepted unanswered requests receive `EXECUTION_UNKNOWN` once on a drop and are never replayed. Holding uses the paused source buffer and carried splitter remainder under the existing flow-control bounds. Outstanding ID bookkeeping is capped at 4096 requests/1 MiB, stdout flush and backpressure persist through outages, and stderr diagnostics remain count-capped at 32. The catalog is one source: `tools/list` filters its visible entries by the hello-bound membership role (unknown or unavailable roles retain the full visible list); call-time guards remain unchanged and unlisted public tools still reach their existing handlers and typed refusals. Visible `slp_status` (caller-scoped membership + assignment/handback/settlement/scope projection), `slp_handback_submit` and the lead-only `slp_assignment_register`/`slp_assignment_attach`/`slp_assignment_close` (P3-a), current-owner `slp_assignment_amend`/`slp_decision_append`, planned `slp_assignment_offer`/`slp_assignment_accept`, and exact-participant `slp_workflow_get`, `slp_settlement_record`/`slp_settlement_export` (P3-b), and `slp_scope_declare`/`slp_scope_transition`/`slp_scope_review` (P4 — durable assignment-bound scope declarations, an explicit `declared→claimed→submitted-for-review→review-observed→approved/rejected→advanced/closed` machine with server-derived required-review gates from the pinned declaration (explicit legacy `spec`+`standards` compatibility, or a declared named-lens, no-trigger or authorized exemption decision), and self-review prohibited), `slp_check_declare`/`slp_check_run`/`slp_rollout_declare`/`slp_rollout_transition` (P5 — allowlisted check definitions, bounded repo-scoped runs, and the explicit rollout machine with server-derived check/cohort gates), plus a hidden mechanism entry that always rejects direct dispatch — `slp_recover_lock` and any live-deployment verb are deliberately absent. Schema-bound handlers preserve each parsed input type through execution; catalog names require an implementation at typecheck. Strict-input rejections expose at most three Zod path/message issues within the existing rejection cap and direct the seat to tools/list. Every dispatch re-runs the five guards (handle→membership sha, fresh row+epoch, live SDK identity, `desk-bridge.transport` capability row, strict input) and fails closed; a `recovery-required` or `degraded` desk rejects mutation while read-only status still answers — a ledger that no longer reads returns the handshake-bound row with `desk.state` `degraded` and explicit limitations, never fabricated data, and the status aggregate stays inside `WIRE_LIMITS` (counting markers for elided projection, `DeskBridgeToolEntry` caps enforced on every catalog row at construction). `agent.create` graft adds `mcpServers.slp_desk` (stdio, `command` = binding node, `args` = runtime bridge path, env = handle + socket) only when the earlier role-injection hook minted a handle; a foreign `slp_desk` entry or an integrity mismatch (pin/payload/actual diverge) preserves the request untouched. |
| plugin/server/desk-handback.ts, plugin/server/desk-records.ts | The P3-a structured handback surface behind the bridge catalog: a pure command layer (`assignment.register`/`attach`/`close` — lead-membership-only, `authorityRef` stored verbatim as a pointer, deterministic `asg-`/`hb-`/`cand-` ids derived inside decide so replay names the same row; `handback.submit` → `handback.observe` two-commit flow where the seat's `recordV1` is stored verbatim as `claimed`, observed.status `pending`, and the bound-runtime snapshot capture (60s/32MiB subprocess against the membership's `createCwd`, never a record-declared path) joins only `observed`/`gaps` — a failed capture commits with a `gaps` entry, never a rejection). `desk-records.ts` re-exports the shared `runtime/report-records.ts` validator (identical `{code, field, message}` issues, `readEvidence`/`realpath` behind injection seams — without them `outputRef` reports unreadable instead of dereferencing a claimed path). Caller-scoped `seatAssignmentsView` feeds `slp_status` with identifiers and shas only. Recorded gap: `human-register-rpc` — root/operator-side assignment registration (the §4.4 Human-RPC) is not surfaced yet; bindings are created only by a bound lead membership via `slp_assignment_register`. |
| plugin/server/desk-settlement.ts | Receiving-owner settlement attestations bound to durable assignment and seat identities. Recording verifies claimed timeline exports through the authorized artifact seam; read-only export re-derives and validates the committed v1 record for its two parties. Rows preserve gaps and provenance; acceptance and the official settlement sink remain outside the desk. |
| plugin/server/desk-scope.ts | Assignment-bound immutable scope declarations, reviewer observations and explicit state transitions. Pins review rounds to brief/declaration revision, mandate and candidate, derives required lenses server-side and prohibits owner/writer self-review. Optional ownership covers declared path/resource overlap and dependencies; authority pointers remain claims. Owns the standing approved-round projection used by rollout promotion; the store separately verifies historical approval evidence. Caller-scoped projection feeds desk status. |
| plugin/server/desk-check-runner.ts | Allowlisted check definitions and bounded executions against the rollout's pinned candidate. Bound snapshot capture checks full candidate freshness before execution and before result commit. Server derives environment, limits and eligibility; callers supply no argv or result. Pure decide rechecks current ownership and commits measured outcomes, including typed blocked execution-capability gaps; historical replay does not execute again. |
| plugin/server/desk-rollout.ts | Immutable rollout declarations and explicit transitions gated by pinned check results, standing scope review and canary cohort. Rollback pins a known-good observed candidate; transitions record decisions and perform no deployment. Owns the standing approved-round projection used by rollout promotion; the store separately verifies historical approval evidence. Caller-scoped projection feeds desk status. |
| plugin/server/injection-binding.ts | The O1 usable-for-injection predicate behind the hooks' `readActiveBinding`: canonicalizes the served daemon home (env or default source both count), journal-reads `<home>/slp-runtime`, requires `receipt.target.daemonHome` to equal it, then admits a binding only under `ACTIVE`/`ACTIVATING` (a pending operation never unbinds the intact recorded binding), returns `null` for absent receipt or binding-less `ACTIVE`/`ACTIVATING`/`INACTIVE`, and throws marker-carrying refusals for `target-mismatch`, `state-deactivating`, `state-recovery-required` and `state-inconsistent` — `role-injection.ts` still turns a throw into an aborted create. User-facing: while an install is `DEACTIVATING` or `RECOVERY_REQUIRED`, no new managed seat spawns; running sessions are unaffected. |
| skills/paseo-slp-e2e/SKILL.md | Single-session full-suite execution procedure; requires the source checkout and authorized Paseo actors. |
| e2e/evidence.mjs | One contract per evidence kind: what may enter the ledger and what discharges the kind's requirement at seal. |
| e2e/criteria.mjs | U1–U7 as code, each naming the evidence kinds that can support it; the mapping a reviewer previously held in their head. |
| e2e/collector.mjs | Frozen evidence ledger and review history; verify assessment byte identities and original-review links before summaries, addenda or review-dependent launch gates. |
| e2e/ledger.mjs, e2e/report.mjs | The ledger owns evidence storage, byte verification and per-kind discharge inspection, including the run context and capture provenance; reports consume that inspection to render attempt status, run summaries and the cross-run index without opening evidence records. |
| e2e/ | Development-only scenario manifest, fixture, external outcome check, evidence collector and repository E2E protocol. Collector commands do not create agents or judge behavioral evidence. |
| tests/helpers.mjs | Synthetic E2E fixture construction and evidence-kind dispatch; collectAll can omit kinds under test, while tests keep raw/invalid capture and provenance assertions explicit. |
| tests/*.test.mjs, tests/helpers/plugin-doubles.mjs, tests/helpers/desk-bridge-fixture.mjs | Local installer, rollback, transport, envelope, snapshot and plugin checks; the shared plugin doubles own temporary daemon/binary fixtures and their matching dependency wiring, including named recovery fault points that concentrate characterized UUID sequencing; the desk bridge fixture owns socket framing, handshake and membership wiring with explicit PIN/fault variants; tests own assertions, manager creation, filesystem blockers and durable-phase checks. |

## Installed bytes and storage

The install unit is package.json, install.sh, bin/, skills/, src/ and the
plugin/server/runtime/ and plugin/shared/runtime/ source subtrees. installed.json binds their
exact bytes. The standalone Paseo installer also binds paseo-binding.json, containing
only owned entries and prior MCP values, never credentials. The Option A plugin
keeps its receipt and operation intents in a private per-daemon-home sidecar
outside immutable candidates and plugin settings; its payload manifest
additionally verifies file modes. The shell installer and installed CLI share
the standalone installation code. The plugin uses the documented config.patch
transaction and stable executable shims.

## Provider catalog discovery

The public `catalog` RPC is read-only and advisory. Its optional `modelPrefix`
request field filters model ids by a case-sensitive literal prefix (1–256
characters), preserving host order and each retained model's thinking options
and declared default. Omission keeps the complete existing model list; an
unmatched prefix returns an empty list. Modes, features, errors and provider
resolution are unaffected, including when `model` selects a feature draft
outside the filtered list.

For Devin, the response also carries `modelConstraint: {pattern, description}`,
with JavaScript regex source `^swe-2($|-)`. This necessary package restriction
comes from the same pattern as the enabled Peer pool and runtime binding
guards, and is available even when host discovery reports an error. Other
families currently omit this hint. Host inventory remains visible by default,
including models outside the constraint; neither inclusion nor a pattern match
grants admission. Actual write-time validation, transport verification and
Human authority remain in force. Host descriptors validate known fields and
strip future additions; plugin request/response envelopes and the constraint
object remain strict. See [CLI discovery recipes](cli.md#provider-model-discovery-plugin-rpc).

## Installation and restoration

Managed family binaries use validated daemon PATH aliases when available, so
Codex, Pi, Devin, Claude and OpenCode updates can reach future launches. Existing
version-pinned bindings migrate on the next authorized activation; the SLP
picker refreshes the host catalog before presenting models.

Three roles remain Supervisor, Lead and Peer. Only two saved profiles are managed:
slp-supervisor and slp-lead. Up to fifteen providers use slp-codex-{role},
slp-pi-{role}, slp-devin-{role}, slp-claude-{role} and slp-opencode-{role}. Plugin activation with
saved role routing generates the chosen Supervisor/Lead providers and all
five Peer providers; absent routing keeps all fifteen. Peer chooses runtime from
the project pool, not a saved profile. Devin bindings accept swe-2 models only. OpenCode uses generic ACP (`extends: acp`) with the role wrapper for both
managed and standalone installation; native OpenCode is unsupported.
The plugin requires Paseo >=0.10.3. OpenCode detection and launch re-probes
accept V2 >=2.0.10, reject V1/unknown majors and preserve validated PATH aliases.
Measured compatibility is Paseo 0.10.3/OpenCode 2.0.24; the range is an API
compatibility boundary, not evidence that every later release was tested.
[OpenCode support](opencode.md) records the transport and proof limits.
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
its sole writer). External work trackers belong to workspace/harness configuration.
The plugin has no tracker settings, RPCs, executable probes or session overlays;
legacy tracker state and repository data are left untouched. Standalone host install/upgrade/uninstall and plugin
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

Persisted provider history admits exactly legacy4/legacy12 and current5/current15
vocabularies in the plugin journal/launch manifests. The standalone installer
also retains its separate exact Codex3 + three-profile historical format; it
never widens the plugin journal domain. Historical bindings, plans, snapshots and standalone receipts
retain their original fields and digests. Persisted observations can retain
native `extends: opencode` verbatim; current authored OpenCode entries and
bindings require ACP, and native launch is refused. Readers neither fill absent OpenCode
slots nor rewrite old evidence. New activation writes current plans/bindings,
retaining the original baseline. Recovery may reinstate an original pinned
legacy binding verbatim. Missing historical IDs carry no ownership: new rebind
checks collision/adoption explicitly, and legacy restore/removal uses only
recorded IDs. See [OpenCode compatibility](opencode.md).

## Configuration transactions

SLP management operations are administrator-only and require an exclusive
administrative edit window for the selected daemon. Do not edit daemon
configuration through the app, another plugin, a CLI, or a file while
activate, reconcile, or deactivate is in progress. The plugin serializes its
own operations and verifies persisted and live results. Paseo 0.8.0 provides
no compare-and-swap for these patches; this plugin cannot guarantee
preservation against concurrent external writers. A detected mismatch stops
automatic mutation and requires reconciliation.

## Runtime lifetime and policy delivery

Plugin disable/remove is not SLP deactivation. Existing sessions remain
operational; new managed OpenCode opens require the enabled hook grant.
Stable runtime bytes remain verified and roled, with ownership recoverable
by reinstalling the same plugin ID and reconciling its retained receipt.
Deactivate before removing the manager when detachment is intended. Neither
lifecycle cleanup nor deactivate deletes stable runtime or launcher
directories. These directories belong to the per-daemon SLP store and remain
available to existing sessions; deletion requires separate maintenance
authority after dependencies have ended. Provider commands and policy/helper
paths must never reference managed plugin checkouts.

Native hook policy is injected independently of the ordinary task prompt.
Managed OpenCode and standalone ACP transports carry role bytes as a prepended text block on every
`session/prompt`; first/re-armed prompts also include the measured carrier.
Managed OpenCode requires the live session-open grant before its ACP child
starts, including after plugin disable or during a reload gap. Standalone
OpenCode ACP works without that grant. Native OpenCode is unsupported: its
healthy V2 shared-runtime path can bypass the native sentinel when hooks are
disabled. No V2 `instructions` file/glob/URL configuration is used. Provider labels
and agent self-reports are not proof of loading: E2E evidence must correlate the
provider command, installed bytes, actual session instructions and host parentage.
Permissions and role boundaries remain distinct: policy is not tool isolation.

## Authority and role policy

The current Human assignment supplies outcome, scope, phase/grants, proof and
handback. Supervisor/Lead read the effective protocol on entry; Peer receives
relevant constraints unless explicitly assigned a full read. No global role is
written to AGENTS.md. Common policy owns authority, language, host boundaries,
one writer, required gates, inbound route,
Human stop and recovery; delegation owns the direct-Lead-write exception. Roles carry responsibilities and decision triggers;
conditional references own procedures. The recursive install unit and receipt-derived locators track the resulting
policy graph; core common/role/delegation loader paths remain stable. Formation
is consolidated into ordinary delegation and onboarding decision resources
into its skill. Governance's investigation method conditionally reaches the
preserved anti-pattern catalogue for specific evidence/questions. Retired paths are absent
from new receipts while historical wire fixtures retain their recorded bytes.

The carrier reaches seats through session-entry injection and prepare's
create.initialPrompt, the only field create_agent transmits. Plan-level
spawnKit/orientation alone would not reach them. Peer locators contain
`common.md` and `roles/peer.md`; Supervisor/Lead sets include their references.
The runtime directory appears once on a `Directory:` line; each locator line is
relative to it (directory + relative path = the absolute path) with bytes and
full sha256, or the missing marker. Retained absolute per-line renderings stay
recognizable. Captions distinguish entry measurement from prepare measurement. The kit is
approximate, with specific live schema lookup on unfamiliar parameters or mismatch;
locators are integrity evidence, not
policy content. This source contract stays outside installed bytes.

Lead owns framing, shared state, dependencies, integration and acceptance;
Peers keep bounded independent judgment. Bounded means finishable within one
Peer's context, including implementation, proof and anticipated review/correction
rounds. Lead records estimates of rounds/comments, flows/screens, files and the
provider context window; oversized work splits into dependency-ordered slices,
one Peer and explicit scope/acceptance per slice. Supervisor assignments state
outcome and authority, leaving execution topology to Lead. A Peer that consumes
about 1/3 context reading without recorded artifact/proof returns a scope question
with telemetry or a labelled estimate, remaining obligations and proposed slices.
This is a scope checkpoint, not timeout, quota or a monitor feature; writing just
to evade it is forbidden. Reviewer verdicts use the shared record vocabulary
APPROVE/FINDINGS; BLOCKED/REOPEN_REQUEST/DEPENDENCY_REQUEST name their respective
missing prerequisites/premises/dependencies. TestcaseAuthor supplies linked cases
and expected coverage; TestEngineer supplies granted test artifacts and pinned
execution evidence. Neither owns product acceptance. A required gate follows the rule the
effective workspace protocol declares. Material questions select minimum
sufficient independent mandates without fixed counts/axes/families; explicit
required shapes remain binding. Unavailable required proof blocks that gate.
Review, executed verification, Lead verdict, Delivery and settlement remain
separate. New Peer outcomes form fresh seats by default; healthy same-outcome
phases, corrections and re-review continue the verified owner. Desk task IDs
and dispatch.reuse do not determine this boundary or grant an exception;
grantRef remains a claim. Explicit Human exceptions stand. Human-requested
standby Lead formation binds orientation and the future task without relaxing
Peer continuity. Degraded context uses authorized handoff without a numeric
threshold; acceptance, Delivery, closed rework and resource reconciliation
precede authorized archive, which proves no quiescence.

Supervisor relays Human instructions verbatim, marking inferences separately and
never attributing added constraints to Human. On Human STOP it preserves already
available evidence/receipts and cancels the verified Lead immediately, without
waiting for a report or prompting that owner again. Parent cancellation does not
cancel Peer turns: list_agents is scanned for paseo.parent-agent-id matching the
Lead ID, and identified task children are cancelled directly under STOP authority.
IDs, control replies including failures, and timestamped activeTurn/permission
observations are retained; incomplete listings, unknown children or missing
receipts remain unknown settlement. No new cleanup agent or owner revival is
introduced; resource cleanup still needs its applicable grant/control. This is
behavioral policy, not an atomic tree-cancel or proof of process quiescence.

The existing guarded desk owns exact membership/revision checks, declared
scope overlap/review pins, effect reservations and observed task/resource
history. Policy teaches its public operations and uses current projections
instead of manual duplicate ledgers. Ordinary/Lean slp_seat_create needs a bound orchestrating caller but no task
queue enrollment; the compatibility CLI still emits arguments only, and
ordinary role injection can succeed with no desk membership. Manual host
verification remains on that compatibility path. Neither interface adds a
permission boundary or lifecycle principal.
Grant pointers, review sufficiency, semantic correctness, subjective outcomes,
actual writer pause and unsupported host quiescence remain agent/Human duties.
Measured server execution can be consumed as proof for its pinned class;
shell-reported checks still require independent verification. The allowlisted
check classes are not arbitrary feature tests. Neither desk qualification nor
source tests establish installation, live behavior or project acceptance.

Monitoring/council/recovery/parallel policy is not live E2E qualification.
monitor emits opt-in delta signals only; role tool-delivery exclusions provide
no shell/CLI isolation. Missing host controls remain explicit. The file map
owns load paths; [review checklist](review-checklist.md) bounds local proof.

## Runtime selection

Codex, Pi, Devin, Claude and OpenCode share role bytes through their respective adapters. Human configures
slp-supervisor/slp-lead with matching role providers and chosen models/settings.
Supervisor/Lead launches refresh these saved profiles and copy their complete
provider/model/mode/thinking/features bundles. A pinned binding/bundle modeId
wins; protocol agent_mode is the fallback when absent, otherwise the plan
warns and the Human must resolve it. Missing or
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
saved or routed until resolved. Bound slp_seat_create resolves Peer runtime
server-side, accepts an independent selection, or validates legacy full runtime
pins. Manual CLI formation remains compatible: the Lead reads/selects the pool
and validates its fresh hash with prepare. Provider pi/codex/devin/claude maps to the matching installed Peer wrapper; policy
and disposition stay separate from runtime choice. Neither the Lead's family nor
a saved slp-peer limits the pool. No catalog in either scope, or an
empty/no-eligible pool, blocks Peer creation until setup is completed — never a
saved profile, another repository's catalog or inherited Lead settings. An empty
repository catalog remains authoritative and disables the fallback.

## Jev routing

Jev-assisted routing is an opt-in per-daemon capability, configured under
<daemonHome>/slp-runtime/state/jev.json with the provider key beside it in
jev-<kind>.key (write-only, 0600; status surfaces hasKey only). Jev is a
bounded decision primitive over either the OpenRouter Decisions API (pinned
typesafe/jev-1.13) or the first-party TypeSafe System One API (pinned
jev-1.13.0, custom https baseUrl allowed), never
an ACP provider or agent seat, and runs through the explicit route-decide helper
or an admitted slp_seat_create executor — no loops, schedules or prepare-time calls; prepare and
prepare --check remain offline and merely verify the supplied receipt. Two
modes: shadow (enabled without capabilities.routing — either routing entry emits
a receipt, the Lead still chooses, the plan records both picks for agreement
measurement) and armed (capabilities.routing=true — the receipt is required
and binding, including optionId matching the recorded choice); when supplied
a receipt is always verified, current toggles apply to fresh formation/preparation
and never mutate running seats. Shadow evaluation precedes arming: the Human
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

## Communication supervision

Communication supervision is a second opt-in capability configured in
<daemonHome>/slp-runtime/state/supervision.json (schema 3, 0600, whole-file
sha256 CAS through one server-side writer shared by the supervision card and
the recipient-workspace bell).
Off by default; configuring Jev never enables it. The store holds a
daemon-wide confidenceThreshold (0.5–1, default 0.9), defaults for
discovered SLP Leads (an exact slp-<family>-lead seen in a lifecycle record
or verified by refresh; mode off unless the Human selects one) and explicit
per-Lead routes that always win, including an explicit off. An explicit
route observes only once host evidence (a lifecycle record or refresh) shows
an exact SLP Lead in the route's workspace; a save whose agents the plugin
cannot refresh still lands, reporting them unverified, while a returned
snapshot must match exactly. A schema-1 file
reads with every route off and its previous modes listed until the Human
re-saves — an upgrade never widens transmission or enables delivery. When a
Lead is observed (shadow or notify) and Jev holds capabilities.supervision,
the plugin's lifecycle hooks (agent.created/archived/turn_started/turn_ended)
synchronously capture normalized send_agent_prompt evidence for that Lead's
direct Peers, and a serialized plugin-owned queue assesses each Peer handback
as soon as it lands, and again when its packet changes (at most six paid
calls per case), through Jev's rubric-3 questions: turn-scoped brief
obligations (a disposition/closure-only notice owes no work-request elements
and is answered by a fitting acknowledgment; a bare acknowledgment never
discharges a brief that still asks for work, evidence or a decision — decided
by content, never by keywords), whether the handback answers its brief, and whether the Lead's
later communication disposes of the obligation the handback raised (handled,
no_action_required, pending, drift). A disposition or mishandling counts only
when Jev links it to one specific confirmed message the code offered — a
send's presence, acknowledgment, silence and elapsed time never decide.
Findings are independent per axis and immutable; a later message resolves a
finding only when linked as its specific correction. The detector judges
communication only: it never infers authority, certifies artifacts, accepts
work or mutates assignments, and every missing or unverifiable input keeps
its axis unknown. Local gates: whole-window provenance gaps (paused capture,
credential guard, oversize, unverified Peer family, failed Peer turn, no
communication) close the case before any Jev call; a brief line with optional
leading spaces/tabs, `Assignment file:`, optional spaces/tabs, and a non-whitespace
value is a pointer that makes brief and handback unobservable (the path is never
read); this gate applies to pointer mode. In `snapshot` mode, prepare has already
read and validated the file, so its `Assignment snapshot:` carrier and inline
content are ordinary brief text; the daemon still never reads a file. A missing
brief has the same effect. Lead send-lane and chronology
gaps (unmatched start, uncertain sends, failed or unobservable sends,
unverified Lead family, dropped events, withheld cross-Peer bodies) gate only
the handling axis. On this host, report-route-unverifiable is added to
completed Peer cases; incomplete Peer turns return before that flag (and
produce no case without an accepted send). When present it is disclosed to
Jev and the Supervisor, not a gate. External
data/cost: an assessment sends the brief (including an inline assignment
snapshot when selected), handback, the Lead's confirmed
post-handback messages to this Peer, to its other direct Peers and to the
Supervisor, and the Peer's confirmed sends to the configured Jev endpoint;
uncertain sends go as ids only. Mode notify additionally delivers a
code-generated alert with bounded untrusted excerpts to the route's
Supervisor (or the default recipient): brief/handback findings only after the
pending-delay checkpoint, linked mishandling immediately, at most once per
finding and recipient. Before every send the recipient is refreshed (exact
slp-<family>-supervisor, not archived, active status) and the route rechecked
after every await; a changed route cancels and never falls back. While a
notify route has an open case past its pending-delay checkpoint and no
deliverable finding, a throttled display-only probe refreshes the recipient
and surfaces an unusable one as a `notify-…` gate reason (never sends,
reserves, redirects or blocks); the reason belongs to that recipient, is shown only
for the route's current recipient (a pure read) and is dropped when the route changes recipient or stops notifying, and a displayed
reason is re-probed after the throttle window; an inconclusive
assessment keeps its `assessment-inconclusive` reason on the case — still
neither a finding nor acceptance. The attempt
is persisted before the SDK send; an unreadable, corrupt or schema-invalid
attempt history (or a failed write) refuses every reservation with a visible
reason and is never reset or overwritten; failure or timeout is recorded
uncertain and never retried; a running Supervisor is
not prompted, but a prompt landing as its turn starts interrupts it (the
SDK send options expose no active-turn behavior). Persisted output is two
bounded metadata rings (state/supervision-cases.json and
state/supervision-deliveries.json, ≤200 entries in memory and on disk, ≤30
days — fingerprints, ids, counts, flags, findings, assessment summaries,
delivery states; never message bodies or keys; attempt records of live cases
are pinned and each case holds at most three); open cases and the queue are process-local and are not
replayed after a restart. Provider coverage is per axis, never per family:
one capture module returns separate evidence for the brief, the handback and
each send's input and outcome, and opens only shapes backed by a real
normalized fixture — codex, claude and pi brief/handback/sends, devin
brief/handback (an SLP-wrapped Devin message must be exactly one wrapper for
the captured actor's role; a message with no transport trace is read
verbatim) with send outcomes unknown because the provider emits no result. OpenCode timeline/send shapes remain unverified; role delivery does not
authorize a fabricated supervision mapping. Lead-role live runs for
claude, codex and pi are not done (no such Lead provider on the test
daemon). An accepted
send needs the semantic success of that exact call; a related rejected or
unknown Lead send keeps handling unknown and never carries a body out;
handling also needs a usable brief. Opening a family's content is a
widening of transmission: config schema 3 reads schema-1/2 files with every
route and the defaults off until the Human re-saves. Live E2E validation and
model evaluation have not run; see docs/spec/supervision-integration.md.

## Launch planning and delegation

prepare accepts repository, workspaceId, assignment and role. Supervisor/Lead use
fresh profiles/providers; Peer uses providers and route.optionId/catalogSha256.
A profiles inventory can accompany Peer discovery but does not select its runtime;
an inventoryFile path fills providers/profiles the request did not inline (explicit
inline arrays win, including `[]`). `assignmentFileMode` defaults to `pointer`,
which appends the existing read-first pointer without inlining file bytes;
`snapshot` reads and validates a repository-contained file during prepare, then
inlines its bounded, normalized text with relative-path and SHA-256 provenance.
The credential guard checks both snapshot text and its repository-relative
provenance path, reporting only the matched pattern name on rejection.
Snapshot errors fail prepare with no pointer fallback. Both assignment fields
apply to prepare-handoff through the shared plan builder; supervision never
reads the file.
Catalog settings cannot be overlaid via route runtime/profile overrides. Explicit
binding without profiles remains a separate Human-authorized offline/handoff path,
not an ordinary missing-pool fallback. CLI helpers emit create arguments only; the native slp_seat_create operation
executes an installed launch plan through the connected workspace SDK with
explicit native parentage. Paseo owns lifecycle and actual settings. The three layers stay distinct: launch
planning pins repository/workspaceId/binding and renders the create record;
the caller owns invoking slp_seat_create (SDK execution with explicit parentage)
or the compatible agent-scoped create_agent path as the recorded parent;
the host owns the resulting parentage, placement and report
routing. A plan documents intended arguments — it is not proof the team
formed, so the caller verifies the returned child's actual parent, workspace
and report route against host evidence. request.workspaceId stays a required
plan input copied into create.workspaceId; a direct agent-scoped create_agent
may omit workspaceId to inherit the caller's workspace, but prepare keeps
emitting the resolved value. New seats are created through slp_seat_create's
workspace SDK or agent-scoped create_agent so the host records parentage, the report route and the sidebar
tree; prompting a standalone session observes work it already owns and cannot
carry a new delegation. Same-team seats share the assignment's pinned
workspace unless a declared worktree, repository or lane-isolation reason is
recorded with its paths — a second workspace on the same checkout is not
isolation. Source selection is shared by prepare-handoff.

## Agent-facing formation and bounded delivery

Native tuple evidence is owned by desk-seat-observation.ts, shared directly by
ordinary formation and managed task execution. Its host interface needs only
agents.ref().refresh(); it never creates, sends or reads task state. Missing
required fields remain uncertain, parent proof comes only from the native
parent label, and private create-ticket diagnostics redact before truncation.
Formation's private effect-placement qualification keeps the same ordered
target verify, actor guard, target verify sequence at create and delivery;
caller/source checks and retained-identity errors use that same local owner.
Decision-time and delayed-membership revalidation keep their distinct ordering.

Formation and task-runtime inventories preserve published provider transport
evidence. Current SDK provider snapshots omit extends: for a ready OpenCode
alias lacking it, the server reads the connected host's config.get around a
fresh snapshot and carries only that exact provider's stable extends value.
Availability still requires enabled/ready SDK evidence; config never supplies
it. Missing/failed/changing config or native transport blocks dependent OpenCode
binding, never infers ACP from the alias or falls back to another provider.
Config reads use the existing bounded read budget and add no operation phases;
raw provider config, commands, env and secrets never enter formation evidence.
Non-OpenCode observation needs no new config capability; replay performs no reads.

Four additive guarded bridge tools retire caller choreography when available.
slp_seat_create forms a Lead from the saved slp-lead bundle or an ordinary Peer
with runtime/selection omitted on its first ordinary request: the server selects
automatically, accepts an independent selection {optionId}, or validates legacy
full pool/Jev runtime pins. runtime and
selection are mutually exclusive. Parent derives from the bound caller;
workspace/cwd come from the qualified caller or existing placement. A fresh plan is pinned before create, native identity is observed before
work, and actor/runtime are revalidated before delivery. The exact selected
provider's fresh snapshot supplies mode evidence: an advertised `modes: []`
omits native `modeId` and verifies the created seat reports no mode; a missing
`modes` field is `CAPABILITY_GAP`, while a nonempty catalog requires the saved
profile's explicit mode to appear in it. Bundle and mode evidence stay pinned
through create and delivery. CLI preparation stays offline. New worktree placement uses Paseo create_workspace
under host-setup authority, followed by slp_seat_create placement existing;
agent-scoped create_agent remains a compatibility/recovery path, not the default
for isolation. Supplied grantRef remains a claim;
authority, one writer, sufficient independent review and semantic acceptance
remain with the caller/Human. Only host MCP create_agent/send_agent_prompt arm a
finish notification, so server-side SDK send ("delivery": "server") has none.
With positive native identity (and exact live membership for new formation semantics), default delivery "caller" returns
awaiting-caller-delivery with the exact prompt and sha256; the caller sends it
via send_agent_prompt notifyOnFinish=true. Either way the assignment requests
one explicit child-to-parent report; a finish notification signals the event
only and does not establish acceptance.

Without runtime, off/unconfigured pins a sole eligible option; several options
require selection or return pure selection-required choices without admission.
Shadow requires an independent Lead selection even with one eligible option;
the advisory Jev receipt never replaces that choice, and Jev errors block the
dependent formation. Armed invokes Jev once after durable admission and fails
closed on decline or configuration/key/transport/validation errors.
Preflight is discovery, not a mode lease: the executor re-reads current inputs
before choosing, so armed-to-off drift before selection follows off rules (sole
option or explicit selection; several options without selection refuse).
After route-selected, mode/config/catalog/source drift blocks later effects.
An oversized new automatic request is rejected in preflight before intent or Jev,
using the same three-copy allowance and 32KiB reserve as final evidence checks;
it consumes no requestId. Selection/plan evidence only known after decision is
also checked before child allocation. Legacy full-runtime requests keep their
original path. Missing armed Jev decision pins retain INVALID_RECORD with a
bounded cause and shared operation-recovery text; unclassified launch errors
stay redacted. The [seat policy](../src/references/delegation-execution.md#refused-or-uncertain-formation)
owns the recovery procedure. Issued/uncertain effects are never resumed by recovery.
Retained recorded/partial operations replay before preflight,
never re-decide or resume, and preserve their original bytes and phase count.
Successful omitted-placement automatic formation uses at most 7 of 16 phases; omitted-placement full-runtime keeps 5. Explicit placement adds up to 5 phases, for a worst case of 12/16.

Placement V1 is caller or existing; absent retains the historical caller path
without normalizing intent bytes. Explicit caller uses its exact bound workspace.
Existing accepts workspaceId and/or absolute cwd plus reason; when both are
supplied they must agree. The SDK descriptor, not the requested ID alone, pins
workspace/canonical cwd. Git-common-dir equality rejects foreign and nested Git
repositories before child creation; a same-Git linked worktree qualifies. No
multi-repository Lead authority is introduced. New explicit placement pins
source top/configuration/HEAD and target workspace/cwd/HEAD; pool/protocol use
source, provider snapshots and execution prompt use target. Source/target drift
blocks dependent effects; CLI JSON cannot supply the internal launch context or
route.catalogFile bypass. A checkout with either local routing or protocol configuration keeps its existing
source behavior. If a linked checkout has neither, formation discovers the main
checkout at dirname(git-common-dir), verifies the same common-dir and exact Git
top, and inherits its routing/protocol configuration with HEAD/file pins. This
also applies when a placed Lead forms its own child with omitted/caller placement.
A linked checkout without a trustworthy configured main source fails closed,
never silently switching to the user pool. A protocol-only configured source
retains its declared user-pool resolution; no catalog is synthesized. Inherited
source pins are rechecked before selection/create/delivery and recorded in the
existing prepared phase; no phase is added. Without inheritance, historical
omitted-placement calls qualify caller cwd/common-dir and active workspace
without adding HEAD/config leases or phase files, including an unborn repository.
The assignment directs the child to read the source protocol only when that
file has a non-null configuration pin.

kind=worktree is an admitted CAPABILITY_GAP result with zero formation phases
and no workspace/Git/setup/Jev effects. The host has no setup-suppression flag.
Lead needing a new worktree uses Paseo create_workspace under authority for the
host's setup, then slp_seat_create placement existing with a new requestId;
it does not revert to create_agent as the default. cwd-only existing first
qualifies the existing directory's Git identity, then records open-issued before
SDK open and retains the returned ID before refresh. Open may revive archived
workspace records and do Git/forge refresh; it does not run setup in the audited
branch. Timeout is not cancellation: placement-uncertain retains IDs/cwd/key,
and no replay re-opens, recreates or cleans up unknown resources. Prefer an
active existing workspace ID; SDK active-only listings cannot prove absence of
archived records or suppress revival.

New formation semantics (explicit placement, automatic Peer runtime or selection)
require exact live role/provider/cwd/workspace membership. Historical omitted
placement with a full Peer runtime pin, and omitted-placement Lead requests,
keep their original delivery behavior/bytes without reading or waiting on child
membership. New semantics allow at most 1500ms of read-only registration polling
(25/50/100/200ms capped backoff), with no additional phases or repair effects;
a positive delayed registration is followed by actor/plan/target revalidation.
Missing, unregistered, revoked or mismatched rows yield seat-pending with the
known child ID and assignmentEvidence (prompt/hash), not delivery. The response
names slp_operation_get {kind:"seat-create",requestId:<same ID>}: read the retained
receipt, keep the child ID, and never create a replacement. Operation_get and
exact replay do not refresh readiness or auto-resume. If registration is still
missing, report the gap; any separately authorized assignment delivery needs
fresh native tuple/membership/authority proof. Evidence alone grants no send.
Historical recorded/partial operations replay original bytes/results before
these checks. Membership observation adds one phase only for explicit placement;
legacy successful full-runtime requests retain five.

slp_task_deliver composes existing define/bootstrap/send for a new bounded task.
Callers supply task scope/review, proof, dependencies, separate create/send grants,
budgets, runtime, text and initial assignment CAS. The default placement is the
caller checkout/workspace. Core still owns every reservation, scope and effect
transition. Changed owner/brief/task pins, delayed registration and uncertainty
stop the sequence with retained identities; they never silently create again.
Explicit phased tools still own amendments, reconciliation and continuation.
slp_task_get reads one authorized current task and optional exact attempt,
returning CAS/identity/readiness and compact effect/resource markers without
paging unrelated history. Full proof/history stays in existing workflow views.

The invariant requiring runtime ownership is mark-before-effect and exact
non-resubmission under concurrent calls, lost acknowledgments and process loss;
protocol prose/harness cannot durably arbitrate a server-side native effect.
No setting, onboarding gate, scheduler, retries or provider fallback is added.
Immutable operation receipts bind the original caller/request and each phase
by digest outside the task ledger. Exclusive intent publication admits one
executor; native repo/agent/kind/request identity stays stable across membership
epochs while the original membership remains in immutable intent. A new live
epoch can read the same native caller's receipt (callerEpochMatches=false),
but mutation replay denies an epoch mismatch. Early epoch-addressed receipts
are located through their immutable native tuples without moving/resealing.
Ambiguous/corrupt legacy history, more than 4096 entries or 16 MiB of scanned
intent records blocks new admission rather than inferring absence; existing
stable-key reads need no legacy scan. No automatic cleanup is added.
Exact replay and slp_operation_get only read evidence. Failed or
partial publication keeps a gap; no recovered call resumes unfinished phases.
Caller reconciliation is explicit, receipts retain resource obligations and
neither receipt state nor local green tests establishes project acceptance.

## Repository initialization

init creates missing protocol and Supervisor notebook files
without overwriting existing files, and writes .paseo-slp/slp-routing.json only
when --routing-from names an explicitly chosen catalog — a repository without
its own catalog resolves the user-scope pool. Host upgrade archives retired Peer
profiles but neither creates
nor edits project catalogs, so setup never silently imports host choices.

## E2E evidence

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

## Durable work coordination

Ledger v7 adds exactly `briefRevisions` and `decisionEntries`. A complete
operative brief separates objective/acceptance, authority-backed constraints,
provisional design, assumptions, unknowns and proof from owned/excluded
surfaces, dependencies and notification intent. Its immutable assignment-local
revisions use expected-current-revision CAS and canonical body/entry digests.
Material decisions retain reasons, supporting and contrary evidence, unresolved
risk, affected revision/owners, notification references and outcome references.
Every new row is checked against its committed historical event on every read;
full-chain integrity is not replaced by a cached tip. Legacy assignments have
no invented brief; migrations preserve their existing evidence and obligations.

Ledger v8 separately adds `ownershipOffers` and `ownershipAccepts`. The
registration tuple remains immutable; current owner commands resolve the
latest contiguous accepted agent/membership tuple. A live current owner offers
an open assignment to one exact live registered Lead. Only that nominee accepts
with acknowledgment, resource account and ownership/ledger/brief revision CAS.
Acceptance works before or after the former owner retires and atomically denies
its fresh owner mutations. It does not expand the Human grant, retire a host
session, settle resources or establish project acceptance. Every lineage row
binds its committed event and authority at that event; history is never judged
using today's replacement owner. Legacy migration invents no acknowledgment.
New registration events also bind the immutable header content by digest;
retained events without that digest keep their original evidence shape.

Current owners, exact live prior owners, attached seats and usable current-offer
nominees can read; revoked, rebound and foreign callers cannot. Offering never
adds an execution/canary seat. A losing or stale offer grants no permanent read
access. Only the current owner amends the brief, records decisions or changes
ownership/review declarations. A declared direct Lead writer requires an
explicit bounded grant pointer. Pointers, paths/resources, findings and
notification/outcome references remain claims, not proof of authority,
communication or semantic truth. Missing prior offer leaves cold owner loss an
authority gap; no claimed-Human-pointer takeover is added.

Active declared path/resource overlaps and invalid dependency edges are
rejected. State/module ownership is separate from the moving write owner.
Review plans are pinned before the candidate round. New scopes must explicitly
declare `required` named lenses, `not-required` when no review trigger applies,
or an authorized `exempt` decision. All three retain authority, rule and reason;
`not-required` has zero lenses and null exemption class, while `exempt` names
the waived class. A no-trigger decision does not waive mandatory review, and
runtime validation does not authenticate a source pointer or risk assessment.
Explicit `reviewPlan: null` selects legacy Spec/Standards compatibility; stored
legacy declarations, migrations and rounds retain their original obligations.
Omission on a new scope is rejected. Omission on redeclaration inherits the
prior plan; exact retries retain their original effective decision and result.

Transitions cannot supply a smaller required set. The owner and writer cannot
discharge their own required independent review. Brief, scope or plan changes
invalidate standing dependent reviews while historical approval evidence remains
valid at its original event. Scope gates, rollout promotion and read views share
current qualification: a review authored by today's owner or declared writer
cannot carry their present gate, even when valid at its original event.
Unchanged independent third-party reviews remain reusable. Accepted ownership
invalidates an earlier canary pin even with an equal roster; migration alone at
ownership revision zero preserves its legacy digest recipe.
Empty discharge is valid only for the pinned
no-trigger or exempt decision and still requires measured candidate freshness
and valid approval/rollout history. The status projection exposes the decision
separately from waiver status. Findings and conflicting observations remain
visible for Lead adjudication; review and scope/check completion are not project
acceptance. Mandates cannot be dropped after adverse findings to evade an
obligation. Under the current Human grant, this repository uses selected mandates
and task-specific stop/effort bounds instead of a fixed pair or correction quota;
other repositories keep their effective protocol until an authorized amendment.

The closed workflow projection returns complete bounded rows, counted omissions
and ledger-bound continuations. The Human workspace RPC freshly binds the
selected SDK workspace to the verified served daemon home and Git common dir;
it accepts no client-selected filesystem root and adds no mutation authority.
Absent, unsupported and unreadable state stays explicit. The client invalidates
old host/workspace lifetimes and superseded requests. Source callers and agents
reuse the same projection under their respective binding/authorization checks.

Discovery uses the complete current brief objective (4096-character bound),
with explicit registration fallback only when no structured brief exists.
The ownership header separates original/current tuples, accepted acknowledgment
provenance and recorded membership state from host liveness. Typed handback and
settlement summaries preserve record digests, pending/failed observation, all
resource dispositions and claim-versus-measurement provenance; full handback
bodies remain ledger-held. Human RPC responses cap the complete UTF-8 object
at 65536 bytes, dropping only complete page items. A single overlarge header or
record returns `VIEW_TOO_LARGE`; no clipped proof is presented as complete.

The optional handback `report` uses `slp-report` v1 with execution, review or
adjudication semantics and meaningful purpose-specific fields. The existing
envelope, verdict, candidate and check validation stays intact. A renderer
preserves the original fenced evidence bytes; author-reported `read`/`ran`,
finding evidence and decisions remain claims. `handoff.recapInputs` is an
optional explicit context source alongside required legacy free text. Its pure
recap separates supplied report/candidate claims from fresh measurement,
discloses missing/mismatched/incomplete context and leaves settlement and
recipient acknowledgment unverified. No host lifecycle action is added.

Usage and detailed obligations are in [work coordination](work-coordination.md)
and its [spec](spec/work-coordination.md). The proof-copy harness belongs to
repository verification and stays outside installed bytes.

## Native task execution

Ledger v9 adds one strict append-only `taskEntries` union for task declarations,
attempts, results, adjudications, holds, actions, delivery, resources and control.
Legacy migration adds an empty stream without inventing work or receipts.
Commands bind exact live membership, current ownership, brief and entity pins;
effect phases also retain their request-bound admission lineage. Every read
reverifies the full event chain and task history. Caller pointers remain claims.

Tasks represent outcomes and prerequisite availability; existing scopes remain
the only moving write/review owner. Current shared resolvers supply both gates
and read views. Result usability needs explicit current owner adjudication,
applicable review/check/proof and consumed dependency revisions; a captured
handback or an approved scope alone is insufficient. Artifact bytes and code
availability are measured in the consumer's actual checkout or intended Git
base. A later reopened prerequisite invalidates dependent eligibility without
erasing the original attempt's consumed pins or resource obligations.

The task tools ride the existing guarded MCP bridge. Dispatch and
integration are explicit owner-invoked phases, not a scheduler. Reservation,
resource account and durable intent precede each external effect; SDK/Git
effects remain outside the ledger transaction. Bootstrap supplies no work
prompt. Exact registered worker identity, runtime/parent/workspace/placement
evidence and atomic assignment attachment plus scope declare/claim precede
writable delivery. Each uncertain effect retains its identity and obligations;
historical receipt replay never authorizes another create, send or apply.

Managed create carries one opaque ticket through the SDK's supported config/env
hook projection. The create intent stores its digest; the mint transaction
validates it against exactly one current issued action and records a versioned
capacity claim. Intended create metadata and observed hook configuration remain
separate evidence. The ticket is stripped before native execution; actual worker
identity and reserved labels must still match before bind/send. A lost ticket or
raw desk handle leaves a retained gap, without secret regeneration or a second
create. Ordinary seat creation retains its existing behavior.

Delayed registration leaves send pending without a write or host effect.
Explicit reconciliation verifies the already-observed create identity and exact
registered worker before atomic bind/claim; the owner reads fresh revisions
before sending. Task steering retains each live attempt's original pinned
reservation even when the current task declaration narrows its scope.

Integration pins source base/result and actual target, confines the delta to
granted paths, preserves unrelated dirty work using three-way comparison and
checks a separately staged combined candidate before apply. Owner-pinned named
bounded argv recipes are immutable proof-policy evidence; callers select IDs,
not late arbitrary commands. Drift, unsupported measurements or missing proof
blocks landing. Final target measurements remain distinct from project
acceptance. Referenced proof maps survive separately admitted stage/backup
cleanup. No automatic installation, commit, push or deployment is added.

The internal landing recovery plan is pinned once before backup/apply and is
immutable across later phases. It binds original/expected complete target maps,
backup manifest integrity and every admitted resource path. Lost receipts are
reconciled against exact target content and identity: only verified full apply
establishes a landed pin; partial or unknown recovery keeps obligations and the
target reservation. Cleanup cannot discharge an unverified or partially applied
land. Backup blobs have injective keys independent of source path/kind and
retain pinned content, byte size and original permissions for integrity checks.

Discharge first issues a verification-only account, then a separate removal
permit for each resource. Stage-only provenance is distinct from land recovery.
Complete before-inventories and account artifacts remain outside removable
directories. A locked readonly preflight verifies source/result evidence, target
identity, registration and all survivors before each resource issue; absence is
allowed only under an exact previously issued permit for that resource. Stage
failure stops the sequence before backup issuance. Partial cleanup reconciliation
records authorized destructive progress, not causal attribution, current backup
integrity or a new landed pin. All admitted resources must be positively
accounted for before the target fence releases.

For a worktree pointer lost under an earlier exact issued permit, the current
issued removal recipe may exclusively restore the original regular `.git`
leaf inside the owned stage. Fresh account/source/target/survivor and pinned
admin-registration checks precede it; derived bytes, length and mode must match
the verified inventory. Restoration refuses existing leaves, locks and foreign registration.
The adapter then uses the existing Git remove operation. No admin directory or
sibling worktree is repaired; a crash preserves the same finite-cycle account.

One fresh public discharge admits one verification or removal cycle. Each
account/resource has two total cycles; an owner, request or phase change cannot
reset them. Current public CAS/grant and immutable source controls remain
separate. The status-free internal trigger is persisted alongside Core-derived
observation; its original replay precedes artifact payload or observer access.
Transient account bytes never enter the command hash, ledger or read projection.

Stop denies new effect issuance but proves no host turn cancellation. Archive,
revocation, idle, turn end and a single absence observation alone cannot release
a writer/process reservation. Explicit revision-bound owner rulings and matching
server disposition evidence govern release; missing quiescence remains retained.
Internal task cancellation can close the exact old attempt-bound scope under
the current owner and brief only after supported effect/delivery/resource
settlement. Its distinct event records cancellation and grants no approval.
Ordinary scope closure retains its existing gates. Task result qualification
may reuse the exact ordinary terminal approved round while all current proof
and independence pins still hold; canceled or formerly approved rounds do not
qualify by history alone.
Planned succession carries outstanding task/action/delivery/resource records,
without reparenting or changing host report routes. No-offer cold takeover and
an authenticated Human RPC principal remain unsupported.

The sixth workflow section carries full-ledger task counts and per-entity
current markers alongside full shared readiness/result qualification and
current ruling. Historical rows remain readable. Recap is an authorized tasks
page with the same revision, ownership and continuation pins, counted omissions
and global counts; a partial history page does not manufacture complete context.
The existing 50-row page, bounded history and 65536-byte Human/recap budgets
drop only complete records; a single oversized record returns `VIEW_TOO_LARGE`.
Admission preserves bounded recovery headroom across requests, task records,
membership/assignment seats, scopes/transitions, events and serialized bytes.
The pure reserve is computed on every commit's post-state, including legacy
commands and recorded rejections, and consumes credits only as the corresponding
edges commit. It does not prune history or increase the queue's limits.
Details and operating limits are in [native task execution](task-execution.md).

## Handoff and snapshots

Provider switching creates a new session: prepare-handoff carries old-owner settlement
evidence and state/resource handoff inputs without inventing parentage or acceptance.
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

## Quota fallback

Peer quota fallback is configured by catalog quotaFallback.enabled and optionId —
one designated option, not an ordered list. Missing/disabled means stop; the
target must be an existing eligible pool bundle.
prepare validates route.quotaFallbackFrom against this authorization and fresh hash.
Raw Paseo create/update calls remain host capabilities: the package supplies policy
and validation, not a host security boundary. Evidence must verify actual settings
on start/resume/update; availability flags alone do not prove quota recovery.

## ACP context recovery

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

## Tiny procedure and policy-text reuse

The adaptable template retains a bounded inline brief/formation, one writer's
inner loop, in-session stable proof, local risk-triggered review and Lead
inspection/verdict; other outcome routes carry their needed grant/proof/
completion. These tactics are template defaults, not a universal recipe
catalog or new requirement for custom protocols. Tiny classification alone
gives no write/review exception. Direct Lead writing follows common policy's
explicit grant; missing/stale protocols grant no exception. Growing scope/risk
requires reassessment before dependent work.

Onboarding preserves Human decisions and historical template provenance,
records a newly measured source basis separately, and checks exact bytes/base
drift within the current grant. Native skill installation, host configuration,
pool changes and live launch remain separate authority. Optional integrations
create no default setup gates.
Full unchanged policy text in context may be reused; a summary cannot replace
it. Changed/lost/uncertain policy needs re-reading and the first full protocol
read remains required. Catalog, eligibility, provider and Jev evidence still
need fresh checks. Lead's applicable independent-review decision reads remain
explicit in its role entry.
