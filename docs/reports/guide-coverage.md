# Operating guide → package trace

Internal/local-only: a working trace and host-gaps register for package
maintainers, not end-user documentation.

Source: Agent Orchestration — Complete Operating Guide, a local artifact at
`.local-checks/reference/` (untracked, not shipped in the package).
Baseline: `26a272b47701a2bd14ed399017bedf95c7ce378c`. Revision: working-tree policy
alignment, 2026-09-08. This is a textual/load-path trace, not a workflow acceptance.

Guide invariants take precedence over illustrative prompts. DIRECT/SYNTHESIS/PRACTICE
labels describe the guide's source confidence; they do not make every example a
mandatory implementation. Rows group repeated requirements across sections; the
§9 table below accounts for every catalog entry individually.

Types: **I** invariant; **C** capability required when task/risk/authority calls for
it; **T** repository tactic; **H** heuristic/example; **X** context outside package
runtime. Before: covered, partial, missing or restricted by the bounded-job policy.
After **policy covered** means an actionable instruction has a load path; **conditional**
means a concrete task/host must supply the recorded prerequisites. Neither asserts
agent compliance or E2E success.

## Installed load paths

| Material | Entry and reader | When loaded |
|---|---|---|
| [Common](../../src/common.md) | [roleBundle](../../src/role-bundle.mjs) for all three roles | Session entry; adapter injects assembled instructions on supported start/resume/override messages. |
| [Supervisor](../../src/roles/supervisor.md), [Lead](../../src/roles/lead.md), [Peer](../../src/roles/peer.md) | roleBundle selects exactly one | Always for that role. |
| [Delegation](../../src/delegation.md) | roleBundle for orchestrating roles only (bundleParts) | Always for orchestrating roles; Peer excluded. Always-loaded core: carries the required review-gate invariant, the agent-scoped create_agent rule and the ambiguous-create/workspace invariants inline, with pointers to the two conditional procedure references below. |
| [Delegation formation](../../src/references/delegation-formation.md) | Delegation core pointer | Before choosing the operation — new team, continuation or observe-existing — and recording the formation record. |
| [Delegation execution](../../src/references/delegation-execution.md) | Delegation core pointer | Before preparing or issuing a delegation, verifying creation, recovering an ambiguous create or retrieving a child report. |
| [Orchestration](../../src/references/orchestration.md) | Lead pointer; delegation points to isolation branch | Before topology selection, independent review, design dispute or dependency splitting; when assignment/protocol requires review, Lead reads it with review-gates.md before reviewer selection, re-review reuse and acceptance, including after resume/compaction. |
| [Review gates](../../src/references/review-gates.md) | Orchestration pointer; Lead conditional re-read trigger | When assignment or protocol requires independent review: before choosing reviewer seats, re-review reuse and acceptance. An applicable gate with unavailable, stale or unclear rules is BLOCKED. |
| [Monitoring](../../src/references/monitoring.md) | Supervisor/Lead and delegation pointers | Before observation/wait and at each bounded task's settlement, after Delivery and closure of correction/re-review. A continuing lane does not keep a completed task open. |
| [Governance](../../src/references/governance.md) | Supervisor pointer; recovery and cross-project relay branches from orchestration | Supervision setup, Lead handoff or policy evolution; cross-project relay only under an explicit grant, verified route and authorized minimal payload. Missing authority keeps the branch BLOCKED. |
| [Anti-patterns](../../src/references/anti-patterns.md) | Supervisor/Lead pointers, monitoring/governance | Workflow audit, drift, repeated failure, unclear architecture or lost momentum. |
| [Routing](../../src/references/provider-routing.md) | Delegation and saved-profile pointer for Supervisor/Lead | Before every spawn: refresh the Human-configured role profile, validate capabilities and record the complete launch bundle; Jev details move to the conditional reference below. |
| [Jev routing](../../src/references/jev-routing.md) | Pointer from routing and delegation execution | Read only when `routes` reports `jevRouting.routing` as `shadow`, `armed` or `error`. `unconfigured`/`off` skip it; `error` blocks the dependent branch and never falls back silently. |
| [Work tracking](../../src/references/work-tracking.md) | Managed session-entry `Work tracker:` line rendered by `workTrackerBlock` (between the communication-language output and the assignment) | The reference self-gates on that line. Peer carrier includes its locator only when managed session entry enables beads; Supervisor/Lead keep their established locator set. |
| [Onboarding skill](../../skills/paseo-slp-onboarding/SKILL.md) | Installable skill at native project/global scope | Human requests repo setup/update: the host triggers the installed skill, which fills protocol and repo-local routing with preserved preferences and discovery evidence. Skill installation is separate from `init`. |
| [Protocol template](../../src/templates/workspace-protocol.md) | Explicit init creates repository .paseo-slp/workspace-protocol.md | Supervisor and Lead read the repository file when the assignment lands — before tactic-dependent replies or decisions, not only before delegation; Supervisor also reads it for an assigned protocol audit. Peer receives only relevant constraints. |

[Package identity/install](../../src/package.mjs) recursively includes `src/`, so all
ten references are in the install unit. Role-scoped locators keep Peer metadata
limited to common.md, peer.md and conditional work-tracking.md without reducing
install integrity coverage. Common resolves `references/` relative to the installed policy directory supplied by
the loader. The full guide and this matrix remain source documentation under docs/.
No deployed instance is updated merely by editing this checkout.

The carrier block (spawn-kit signatures plus role-scoped policy-byte locators) reaches a
seat through two channels: the session-entry bundle (the roleBundle column
above) for profile/provider launches, and `create.initialPrompt` for the
prepare path — the only field create_agent transmits, so plan-level
`spawnKit`/`orientation` fields are never forwarded by the host on their own.
prepare omits the prompt-side copy only for the canonical `slp-<family>-<role>`
wrapper observed in live provider inventory; unverified targets keep it, and a
seat may then receive the carrier twice — once at session entry, once in the
prompt. Peer carries locators for `common.md` and `roles/peer.md`, plus
`references/work-tracking.md` only when its managed session-entry line is enabled;
Supervisor/Lead sets stay unchanged. Captions mark the measurement point:
load-time for session entry, plan-time for prepare. Kit signatures are approximate and verified against live
`mcp_list_tools`; locators carry path/bytes/sha256 as integrity evidence, not
policy content. The locator set derives from the install receipt plus the
role's allowed policy files, so a receipt-declared file that vanished still
appears as `missing`; source-only documents like `docs/contract.md` are never
declared.

## Requirements by guide section

Targets refer to the linked materials above and their named sections.

| ID / guide | Type | Required behavior | Before | After / exact policy destination |
|---|---|---|---|---|
| G01 · Reading rules, §1 | I/H | Guide grants no authority; distinguish invariant, heuristic and illustrative configuration. | Partial | Policy covered: Common layer boundary; anti-pattern introduction; conditional cadence/counts in Monitoring/Orchestration. Historical messages remain source context. |
| G02 · §2 | C/T | Smallest useful topology; SLP ceremony not required for every tiny task. | Restricted: fixed chain/Engineer | Policy covered: Lead; Orchestration → Frame and select; Protocol → Choosing a workflow. |
| G03 · §2.1, §5.1 | I/C | Save Human attention; Human owns boundaries; concise decision/risk digest. | Partial | Policy covered: Supervisor; Governance → Establish supervision; direct Human–Lead path retained. |
| G04 · §2.2 | C | Foundation work needs enough domain framing to locate unknowns and owner decisions. | Missing | Policy covered: Orchestration → Frame and select; Protocol → Choosing a workflow. Human learning itself is contextual. |
| G05 · §3.0 | I/C | Preflight control plane, provider availability, workspace/agent inventory and user-owned changes. | Partial | Policy covered: Delegation step 1 plus the formation record (situation row, calling actor, expected parent, pinned workspace, recipient, operation, isolation reason) before the first delegation call; actual reachability remains per-launch evidence. |
| G06 · §3.0 | I/C | Durable notebook/protocol location and stable candidate identity. | Partial | Conditional: Governance → Causal notebook establishes authorized location/retrieval; Orchestration → Proof; Protocol identifies repo fields. |
| G07 · §3.1 | I | Paseo owns lifecycle/workspace/parentage/follow-up/timeline; no Peer orchestration. | Covered as policy | Policy covered: Common, Peer, Delegation. Native-subagent disabling/tool filtering is not implemented; see H06. |
| G08 · §3.2 | I/C | Independent sessions, neutral briefs and sealed boundaries when needed. | Partial | Policy covered: Delegation — new seats only via agent-scoped create_agent (parent link, report route, sidebar tree), same-team seats sharing the assignment's pinned workspace absent a declared isolation reason; Orchestration → Independent design and council; Peer read-only/sealed handback. |
| G09 · §3.3 | I/C | One writer per moving scope, real isolation, explicit transfer and frozen review. | Restricted to one writer total | Policy covered: Common; Orchestration → Ownership, isolation and integration. Host worktree creation is conditional. |
| G10 · §3.4, §6.3 | I/T | Discover providers/models; route by risk/budget; no stale model ID prescriptions. | Partial | Policy and implementation covered: `.paseo-slp/workspace-protocol.md` specifies repo criteria/budget; adjacent `slp-routing.json` describes options/quota for that repo. Lead selects each runtime bundle independently of disposition, with fresh hash/eligibility checks in prepare and live discovery in Delegation. No host/global fallback; two managed profiles and a project Peer pool. |
| G11 · §3.5 | I | Exact artifact, identity, real checks, independent review when required, correct acceptance owner. | Partial: no independent lane | Policy covered: Lead; Delegation → required-gate invariant; Orchestration → Proof and acceptance; Review gates; Peer review disposition. |
| G12 · §3.6, §5.1 | I/T | Explicit edit/commit/push/deploy, scope, important architecture, cost and acceptance boundaries. | Partial | Policy covered: Common, Supervisor, Protocol → Authority; assignment supplies actual grants. |
| G13 · §4 | I | Profile = invariant; protocol = repo tactic; prompt = bounded assignment. | Mixed: global bounded topology | Policy covered: Common; role restrictions removed; tactics located in Protocol; Delegation step 2 carries task fields. |
| G14 · §5.2 scope | I/C | Supervisor observes assigned sessions/workspaces across projects without project acceptance ownership. | Restricted to one new Lead | Policy covered: Supervisor; Governance → Establish supervision. Existing Leads and multiple projects supported in policy. |
| G15 · §5.2 attention | I/C | Observation → evidence → hypothesis → open question; address Lead within mandate. | Partial | Policy covered: Supervisor; Monitoring → On a signal; anti-pattern catalog. |
| G16 · §5.2 notebook | C | Durable causal notes, recurrence, precise owner relay, evidence-focused Human digest. | Partial: handback/timeline mention | Conditional: init scaffolds `.paseo-slp/notebook.md` as the default durable location and the protocol template records the concrete `Supervisor notebook:` field; Governance → Causal notebook still establishes authorized owner/retrieval, schema and fallback limitation, and `timeline:<agentId>` requires a retrieval reference left where the Human can find it. |
| G17 · §5.2 recovery | C | Propose replacement/handoff when Lead cannot recover; execute only within recovery mandate. | Restricted: blocker only | Policy covered: Governance → Recovery and handoff with old-owner settlement and new-owner acknowledgment. |
| G18 · §5.2 detection | I/C | Separate event, cheap detector, periodic wake and role judgment; respond to material mid-task changes. | Partial: lifecycle notifications | Conditional: Monitoring → Establish observation path, watch-list scan and sweep; where installed, `slp.mjs monitor` is an opt-in on-demand scan emitting signal candidates, not a background detector; semantic bridge remains a host gap H02. |
| G19 · §5.2, §6.5 | C/T/H | Event-first; low-frequency heartbeat safety net when needed, no universal 15-minute cadence. | Explicitly prohibited | Conditional: Monitoring → Heartbeat safety net and low-frequency sweep (protocol-chosen cadence); Protocol → Monitoring and heartbeat; H01/H03. |
| G20 · §5.2 model tier | T | Monitoring can use economical models; difficult recovery/judgment needs adequate reasoning. | Missing | Policy covered: Governance setup; Protocol → Routing and skills; preserve Human selections. |
| G21 · §5.3 ownership | I | Lead owns framing/topology/dependencies/integration/verdict; plans provisional; requests reconciled. | Partial | Policy covered: Lead; Orchestration → Frame and select, Reopen/dependencies, Proof. |
| G22 · §5.3 direct work | C/T | Lead may handle tiny coupled task if protocol allows; avoid difficult self-acceptance. | Restricted: Peer always writes | Policy covered: Lead assigns all implementation writes to a Peer Engineer; tiny work uses one Peer Engineer; Protocol → Tiny procedure; difficult work uses independent judgment. |
| G23 · §5.3 trajectory | C | Split large dependency/domain branches with contract/handback, retain main Lead trajectory. | Prohibited additional lanes | Policy covered: Lead; Orchestration → Reopen, dependencies and recovery boundaries. |
| G24 · §5.3 inputs/outputs | I | Root/protocol/assignment/inventory, owner map, routing, requests, candidate, proof, verdict and risks. | Partial | Policy covered: Lead, Delegation steps 1–3, Orchestration acceptance, Monitoring handback. |
| G25 · §5.4 disposition | I/C | One Peer profile with task-specific Engineer/Architect/Reviewer/Scout outputs and authority. | Engineer only | Policy covered: Peer; Delegation step 2; Orchestration Frame and select. |
| G26 · §5.4 independence | I | Challenge premise with evidence; alternatives outside Lead framing; no automatic contrarianism. | Partial | Policy covered: Peer reopen guard, Lead reconciliation, Orchestration council, anti-pattern introduction. |
| G27 · §5.4 multi-lens | C/H | Independent designs, distinct mandates, sealed reports where needed, bounded challenge then Lead decision. | Unsupported | Policy covered: Orchestration → Independent design and council. Counts/round limits are Protocol defaults. |
| G28 · §5.4 design reopen | I/C | Implementation-discovered precision/cadence/API/ownership changes may require design or owner decision. | Partial | Policy covered: Peer contract guard; Orchestration → Reopen with explicit behavioral consequences. |
| G29 · §6.1–6.2 | I | Generic Paseo primitives; SLP in independently installed roles/protocol, three role identities. | Covered | Preserved: installer/transport own package wiring; no Paseo core changes, detector or custom runner added. |
| G30 · §6.4 | I | Creation brief includes project/task/root/workspace/role/disposition/objective/scope/exclusions/authority/proof/handback. | Partial | Policy covered: Delegation step 2 adds identifiers, disposition, an explicit report-recipient agent ID and candidate/visibility conditions; step 3 verifies the returned child's actual parent, workspace and report route against host evidence. |
| G31 · §6.5 | I/C | Finish signals prompt evidence retrieval; sparse monitoring rather than repeated status polls. | Partial | Policy covered: Delegation step 4 and Monitoring — watch-list scan on each material event plus low-frequency sweep beside event waits; curated/full report distinction stays explicit. |
| G32 · §7.1–7.2 | I | Lead reads protocol; Supervisor reads for protocol mandate; Peer receives relevant constraints only. | Covered | Preserved and explicit in roles/Protocol/Delegation; Supervisor and Lead read it when the assignment lands, before tactic-dependent decisions — not only before delegation. No protocol broadcast through AGENTS.md. |
| G33 · §7.3–7.6 | T | Criticality, authority, task classes, isolation, routing, proof, escalation, anti-patterns, evolution, version/date. | Partial minimal template | Policy covered as template sections; per-repo values remain intentionally unresolved until assigned context supplies them. |
| G34 · §7.4 | I | No secrets, guessed models, global role dump, task-specific file list, universal ceremony or authority self-grant in protocol. | Partial | Policy covered by template scope, explicit unknowns and targeted repo tactics; no concrete task files/models/secrets added. |
| G35 · §8.1–8.3 | I/H | Independent coworkers, low authority gradient, provisional vertical planning. | Partial | Policy covered: Lead/Peer, Orchestration framing/council; anti-patterns §9.1/§9.2/§9.12. |
| G36 · §8.4–8.5 | I | Stable snapshot review; proof, falsification, technical acceptance and owner trade-offs are distinct. | Partial | Policy covered: Lead, Peer, Orchestration proof; integrated artifact is reverified. |
| G37 · §8.6 | I/C | Sparse intervention on material delta; wake alone never creates implementation or authority. | Partial | Policy covered: Common, Monitoring; loader now preserves authorized assignment across wake messages. |
| G38 · §8.7, §8.9 | I/C | Improve from real causal evidence; version repo policy; distinguish generic invariant from local tactic. | Partial | Policy covered: Governance → Policy evolution; Protocol → Repo anti-patterns, Overrides and evolution. |
| G39 · §8.8 | I/T | Role-appropriate skills, progressive disclosure and bounded attention. | Partial | Policy covered: role skill guidance, Protocol routing and conditional reference pointers. Runtime skill filtering remains H06. |
| G40 · §8.10 | H | Evidence/case and open questions precede diagnosis; preserve counterevidence. | Partial | Policy covered: Supervisor, Governance notebook, anti-pattern investigation method. |
| G41 · §9.1–9.20 | I/H | Operational guards plus signal/evidence/question/response for every catalog entry. | Partial scattered guards | Policy covered: full mapping in next table; generic catalog reached only by relevant roles/triggers. |
| G42 · §10 | C/T | Tiny, bounded, architecture slice, council, independent design, Supervisor loop, multiple projects. | Only bounded chain | Policy covered: Orchestration branches, Monitoring and Governance; Protocol chooses gates. |
| G43 · §11.1 | I | Prelaunch root/protocol/discovery/authority/ownership/isolation/neutral brief. | Partial | Policy covered: Lead plus Delegation preflight/creation and Orchestration ownership. |
| G44 · §11.2 | I/C | During work: reopen, evidence hypotheses, no silent expansion, meaningful wake, independent lens, contract-first tests. | Partial | Policy covered: Lead/Peer; Monitoring; Orchestration; catalog. |
| G45 · §11.3 | I/C | Before acceptance: unchanged artifact, actual checks/review, visible findings, correct authority, no abandoned task wake source. | Partial | Policy covered: Orchestration proof and Monitoring settlement; unobservable cleanup stays explicit, H03/H04. |
| G46 · §11.4–11.6 | I | Role self-checks on overreach/evidence/mandate, framing/ownership/judgment, scope/proof/reopen. | Partial | Policy covered in Supervisor/Governance, Lead/Orchestration and Peer; conditions integrated into procedures rather than duplicating checklists. |
| G47 · §12.1 | X/H | Human domain expertise and AI management learning. | Context only | Context retained in guide; domain framing and governance boundaries reflected in G03/G04. No training system added. |
| G48 · §12.2 | X/C | Subjective frontend quality needs informed visual acceptance. | Missing explicit gate | Policy covered where relevant: Orchestration proof and Protocol proof include Human visual/product evidence. Reference-bookmark/taste training stays contextual. |
| G49 · §12.3 | X/H | Game/networking/asset examples are illustrative, not universal role requirements. | Context only | Kept in guide; generic design-reopen behavior covered by G28. No game/asset implementation added. |
| G50 · §13–14 | I | Distilled roles, layer separation, evidence chain and attention protections. | Partial | Consolidated by G01–G46; no separate duplicated global manual. Runtime limitations remain explicit below. |

## Every anti-pattern in §9

All rows below resolve to the correspondingly numbered row in the installed
[anti-pattern reference](../../src/references/anti-patterns.md). Each has a signal and
mechanism, evidence to inspect, an open question and a bounded response. This table
also identifies the immediate guard or execution procedure when that pattern arises.

| Guide | Prior coverage | Operational destination in addition to catalog |
|---|---|---|
| §9.1 Authority gradient | Partial | Lead neutral framing; Peer challenge rights; Orchestration independent design. |
| §9.2 Perfect plan | Guard present | Lead provisional plans; Orchestration Frame and select. |
| §9.3 Symptom patching | Partial | Lead repeated-correction trigger; Orchestration reopen. |
| §9.4 Architecture lock-in | Risk named only | Protocol foundation gate; council alternatives and reversal conditions. |
| §9.5 Architecture fog | Missing | Architect output identifies ownership/lifecycle/failure; catalog deletion question. |
| §9.6 Moving scope | Single-writer guard | Orchestration worktree isolation, owner transfer, frozen/integrated review. |
| §9.7 Self-benchmark | Acceptance split only | Orchestration proof ties independent judgment to Human outcome. |
| §9.8 Test-shaped proof | Partial | Orchestration proof requires failure mechanism and appropriate outcome evidence. |
| §9.9 Overengineering | Missing | Council compares counterarguments/cost; catalog simpler fallback question. |
| §9.10 Polling debt | Poll ban only | Monitoring signal/prerequisite inspection and bounded heartbeat lifecycle; catalog row states the boundary — binds in-tree live-turn loops, while outside-tree periodic inspection is bounded by declared cadence, logging and settlement. |
| §9.11 Ceremony capture | Restricted topology instead | Orchestration smallest useful topology; Protocol bounded council defaults. |
| §9.12 Framing capture | Neutral brief only | Fresh reconstruction, hidden preference, sealed report boundary. |
| §9.13 Forked independence | Guard present | Delegation fresh sessions; Orchestration detects visibility leaks. |
| §9.14 Attention dilution | Relay only | Governance keeps a compact digest; cross-project relay requires an explicit assignment grant, a verified Lead route and minimum authorized data. Otherwise the dependent branch stays BLOCKED. |
| §9.15 Skill pollution | Peer no-orchestration guard | Role-specific skill selection and conditional reference loading. |
| §9.16 Status acceptance | Guard present | Lead artifact inspection; Monitoring evidence retrieval/settlement. |
| §9.17 Supervisor overreach | Guard present | Governance distinguishes observation from bounded recovery mandate. |
| §9.18 Tests mint API | Guard present | Peer established-contract guard; Orchestration design reopen before contract tests. |
| §9.19 Context branching | Additional lanes prohibited | Orchestration dependency Lead/lane and explicit integration handback. |
| §9.20 Verdict-first | Open questions only | Supervisor/Governance evidence, counterevidence and hypothesis workflow. |

## Host capabilities and residual limits

Evidence for this revision: exposed Paseo MCP tool declarations inspected in the
editing session, plus the local Paseo reference. No runtime installation, agent
creation, schedule creation or heartbeat execution was performed. These are surface
observations, not proof that a future role session has identical tools or permissions.

| ID | Observed surface / gap | Policy treatment and remaining verification |
|---|---|---|
| H01 | create_heartbeat accepts prompt/cron/timezone/name/maxRuns/expiresIn and wakes caller; delete_heartbeat accepts id and deletes caller's heartbeat. | Monitoring binds owner/cadence/receipts/stop; actual delivery and deletion remain NOT_RUN. |
| H02 | Finish/error/permission notifications exist; no semantic detector/event subscription API is exposed in this session. | Explicitly record gap; material Lead reports when routing permits and heartbeat safety net if justified. No invented bridge or custom detector. |
| H03 | No heartbeat list/update API exposed; deletion is owner-scoped. | Persist receipts, bounded lifetime, owner cleanup; missing receipt/cross-owner access yields unknown settlement. Do not claim list_schedules inventories heartbeats. |
| H04 | get_agent_activity is curated; get_agent_status provides state/capabilities/permissions, not complete instruction/report evidence. | Discover actual full-timeline path when needed or report evidence BLOCKED. Baseline and resource receipts do not prove all processes settled. |
| H05 | create_workspace exposes worktree isolation; create_agent placement and parentage are host-owned. | Procedure verifies returned paths/base and separates writers; live concurrency and transfer remain NOT_RUN. |
| H06 | Package injects instructions; it does not disable native tools or enforce read-only/sealed/skill boundaries. | Behavior guard is present; tool/filesystem isolation and fresh-session instruction loading need host evidence. Literal example TOML is not installed over Human settings. |
| H07 | create_schedule creates new agents with a different argument surface from create_agent. | Separate recurring-work assignment and discovery required; schedule role/settings/parentage path unqualified, no automatic adapter added. |
| H08 | send_agent_prompt exposes async/background notifications; ancestor/report routing permissions not exercised. | Agree material-report recipient and verify available routing; use timeline/wake fallback within authority, otherwise report observation gap. |
| H09 | No package-owned durable notebook database; installed files are integrity-bound policy. | Authorized repo notebook or retrievable indexed timeline; missing durable access reported. Never write operational notes into installation. |
| H10 | Risk: fixed disposition routes, stale model/quota preferences, or fallback losing policy/parentage. | Supervisor/Lead saved profiles supply their launch settings; Peer uses project pool options by default with hash/eligibility checks and no profile fallback; role-matched Codex/Pi transports and handoff preserve policy/evidence. Actual model/effort/quota discovery and the interval between prepare and create_agent remain host/procedure responsibilities, not an atomic runtime gate. |
| H11 | `paseo inspect --json`/`paseo ls --json` do not surface `persistence.nativeHandle`, so a Devin ACP session cannot be linked back to `devin -r` from CLI output. | `slp.mjs agents` reads daemon persistence under `<paseoHome>/agents/` as a best-effort host detail, not a contract; a missing handle leaves `attach` null. |
| H12 | `create_heartbeat` rejected an ACP Lead session with "requires an agent-scoped session" (observed 2026-09-16). | Orchestration observability gap beside H02: caller-owned heartbeat may be unavailable to ACP sessions; fall back to the event/notification path within authority or report the gap. |
| H13 | No agent-facing plugin RPC invoke path: `paseo plugin` CLI is lifecycle-only and the paseo MCP has no invoke tool; the plugin's status/local-target views are reachable only via Manager UI or a hand-rolled WS `plugin.rpc.invoke.request`. | `slp.mjs status`/`local-target` recompute the file-derivable parts (receipt, owned providers/profiles, runtime+launcher integrity, config-drift presence) and report the rest as gaps — never guesses. Mutation RPCs stay Human-authority and are not exposed. Retire when the host ships `paseo plugin invoke` or MCP `invoke_plugin_rpc`. |
| H14 | Devin seats use the ACP wrapper transport and bypass `sessionOpen`, so the hook-family env overlay never reaches them: no `BEADS_ACTOR` on a Devin seat. The PATH seen by the plugin process can also differ from a seat's provider env when a provider entry overrides PATH. | Devin seats still receive the session-entry `Work tracker:` block through the ACP adapter; the reference's `--actor` fallback covers attribution and the seat-side probe is authoritative over the plugin's. Recorded gap, no workaround. |
| H15 | One observed `get_agent_status` response exposed `lastUsage.contextWindowUsedTokens=192809` and `lastUsage.contextWindowMaxTokens=1000000`. No verified compaction count, usage trend, degradation event or host threshold was exposed. | These fields are point-in-time usage only. Lead uses qualitative judgment when task decisions or evidence become unreliable to recover; trigger quality and actual handoff remain unverified by E2E evidence. |

Follow-up clarification (2026-09-09): the earlier 44/48 ≈ 92% figure counted textual
groups equally and overstated routing readiness. G10 now distinguishes implemented
provider paths from conditional host/E2E evidence.
Do not treat this matrix as a single operational-completeness percentage; separate
policy coverage, implemented provider paths and observed live behavior. Host discovery
confirmed Codex/Pi availability and model options, not successful SLP launches on Pi.

## Textual scenario walkthrough

| Scenario | Trace result |
|---|---|
| Direct Lead, tiny task | Lead reads protocol; a tiny class follows the protocol's tiny procedure — one Peer Engineer, focused proof and Lead verdict. Owner questions go directly to Human without inventing a Supervisor. |
| Bounded Engineer | Delegation assigns one scope; notifications wake Lead; paused candidate, diff and proof precede verdict. No heartbeat unless observation needs it. |
| Architecture-sensitive work | Protocol gate → Orchestration → read-only Architect → Lead decision → Engineer → fresh Reviewer on stable result → Lead verdict. |
| Sealed council | Distinct neutral briefs → reports before cross-view → material propositions → bounded challenge → binding decision/counterargument/reversal conditions. |
| New dependency during implementation | Peer stops incompatible patch and requests decision → Lead scopes separate lane/Lead within grant → stable handback → one integration writer → new candidate proof. |
| Long observation with incomplete events | Record event gap → choose authorized observer/cadence/bounds → caller-owned heartbeat receipt → inspect delta only → delete on task settlement. |
| Repeated correction | Lead/Supervisor pointer reaches catalog → gather evidence/counterevidence → open question → revised premise or blocker → causal note. |
| Recovery under existing mandate | Evidence → old-owner settlement → fresh Lead with explicit contract/state/resources → acknowledgment; unknown control/cleanup remains visible. |
| Long-lived lane after bounded task | Task A reaches Delivery and has no open correction/re-review → settle A and reconcile its resources while the lane continues; if rework is open, keep the same Engineer and independent reviewers for that task. |
| Stop with late wake | Common stop and loader assignment boundary prevent reactivation → authorized owned cancellation/cleanup → receipts or unknown settlement, no new cleanup agents. |

These walkthroughs compare instruction branches, authority and references. They do
not simulate agents or claim E2E behavior. No npm suite is used as evidence of guide
coverage. Independent live acceptance remains outside this textual trace.

## Checks performed on this revision

- Read the source guide and compared installed policy/procedure branches with the
  50 grouped requirement rows and all 20 §9 entries above.
- Rendered roleInstructions in memory and followed conditional reference paths:
  the policy references (four at that revision, ten now) resolve and occur
  in the recursive package identity. Peer
  has no delegation procedure or orchestration reference pointer in its envelope.
- Exercised the textual branches for context handoff, bounded-task settlement,
  Jev off/armed/error and Peer tracker-off/on locator loading. These source checks
  do not simulate an agent or establish live workflow behavior.
- At the initial alignment, checked 20 local Markdown links in README, contract, review checklist and this
  matrix; all resolve. Catalog numbering is exactly §9.1 through §9.20.
- Walked the ten scenarios above, including the distinction between Architect
  reports/material updates and implementation/project acceptance handbacks.
- Ran `npm test` (782 passing), `npm run typecheck`,
  `npm run check:plugin-payload`, `npm run check` and `git diff --check`.
  These local checks are not E2E acceptance evidence.
- No live agents, E2E runs, runtime installation or host changes were used for this
  textual trace.

Routing follow-up: the fifth reference is reached on every delegation. Local routing
checks cover independent choices for the same disposition, quota edits/stale hashes,
role/settings validation, mutable catalog preservation and migration to two profiles with retired Peer preferences archived.
These checks establish selector/installer behavior, not Lead judgment or E2E compliance.

Repo-scope follow-up: routes takes an explicit repo root and prepare uses request.repository.
Tests cover two repos with the same option ID but different settings, absent-repo-file
failure without global fallback, non-destructive two-file initialization, explicit
catalog import and host upgrades leaving former global catalogs untouched. The separately
installed onboarding skill supports setup/update within a repo mandate; structural validation is not a live
onboarding or workflow acceptance claim.

Lifecycle follow-up (2026-09-19): the required review gate (parallel seats on
split axes) is now inlined in the delegation procedure, and Lead re-reads
orchestration.md/review-gates.md at reviewer selection, re-review and
acceptance — a compaction-era "Engineer → Reviewer" summary does not license
one merged seat, and seats that cannot be supplied make the gate BLOCKED.
Artifact acceptance is not assignment close: each bounded task settles when
Delivery completes and no correction or re-review remains open, even while its
lane or team mandate continues. Accepted Peers stay idle for task-local rework;
settlement does not auto-archive, kill or reparent them. Human stop still takes
effect immediately. New seats join the team only through agent-scoped
create_agent (parent link, report route, sidebar tree); prompting a standalone
session observes existing work, never a new delegation.
Formation follow-up (2026-09-19): delegation now classifies new-team,
continuation and observe-existing before any tool call, with a short formation
record (situation, actor, expected parent, target, pinned workspace/cwd,
recipient, operation, isolation reason) as checklist evidence. Placement is
pinned the same way: same-team seats share the assignment's workspace unless a
declared worktree, repository or lane-isolation reason is recorded — a tidier
sidebar or generic "isolation" does not justify a second workspace, and a
second workspace on the same checkout is not filesystem isolation. Launch
planning, caller-owned create and host-owned parentage stay distinct: prepare
renders the intended create arguments (workspaceId remains a required plan
input), the caller executes the agent-scoped create as the recorded parent,
and the caller verifies the returned child's actual parent, workspace and
report route against host evidence — a title, sent prompt or label is not
proof of parentage.

Module follow-up (2026-09-22): delegation split into an always-loaded core
(delegation.md — required review gate, agent-scoped creation, ambiguous-create
and workspace invariants) plus two conditional references,
delegation-formation.md and delegation-execution.md, reached through the core's
pointers; the reference count is now eight. The ACP adapter re-anchors the role
core on every session prompt — first and re-armed (load/resume/fork) prompts
also carry session-entry helpers and the measured carrier — and the protocol
template owns a four-step tiny procedure (one Peer Engineer, inline
brief/formation, in-session proof, Lead verdict).

Work-tracker follow-up (2026-09-23): an optional beads (`bd`) work graph
reached the package as the ninth reference, `work-tracking.md`, plus
`src/work-tracker.mjs` probes, a `tracker` CLI, the plugin-owned
`slp-runtime/state/work-tracker.json` toggle with get/set RPCs and a
Manager card, and a hook-family `BEADS_ACTOR`/`BD_*` env overlay at
session open. Detection only — SLP never installs, initializes or
configures beads; a missing or broken `bd` is a recorded gap, never a
spawn block; with the toggle unset every managed path renders exactly as
before (the pointer line is simply absent, ACP `anchor()` unchanged),
while a corrupt or foreign setting file degrades to disabled plus one
surfaced gap line at session entry and an error on the Manager card.
Devin-family seats bypass `sessionOpen`, so they get no
`BEADS_ACTOR` env and rely on the reference's `--actor` fallback — H14.
