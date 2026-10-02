# Paseo SLP plugin feasibility audit

Status: Paseo 0.8.0 audit with source checks, independently reproduced offline spikes, a completed Option A activation-transaction synthesis, a corrected B2 grant design, a current-HEAD delta audit, and an independent committee adjudication. No live plugin acceptance — gates S1–S8 remain. Verified against candidate `3ac1192b…` (35 files); HEAD moved to `0f7ccde` when this document was committed, candidate unchanged.

## Scope and evidence

This audit asks whether Paseo SLP can be distributed and operated as a Paseo plugin without discovering late that the plugin contract cannot preserve an existing SLP behavior. It covers both:

- **Option A — manager/installer plugin:** retain the current custom-provider transports and materialize the SLP runtime outside the plugin's managed checkout;
- **Option B — lifecycle-native redesign:** use plugin hooks and/or plugin providers to apply role behavior, including a robust hybrid that retains the current transports behind a hook-controlled bootstrap.

Status labels:

- **PROVEN:** guaranteed by the public contract, exact installed 0.8.0 source/types, or an isolated spike;
- **CONDITIONAL:** implementable with trusted server-side Node code, but only if the stated design condition is accepted;
- **UNSUPPORTED:** no public plugin primitive provides the behavior;
- **LIVE-SPIKE:** source supports the design, but it must pass a real daemon/provider scenario before commitment.

Primary public references:

- [Plugin quickstart](https://paseo.sh/docs/plugins.md)
- [Plugin v0.8 reference](https://paseo.sh/docs/plugins/v0.8/reference.md)
- [Provider plugins](https://paseo.sh/docs/plugins/providers.md)
- [Plugin publishing](https://paseo.sh/docs/plugins/publishing.md)
- [TypeScript SDK reference](https://paseo.sh/docs/sdk/reference.md)
- [Custom providers](https://paseo.sh/docs/custom-providers.md)

Exact local host used for source verification:

- `paseo --version`: `0.8.0`;
- `~/.paseo/config.json`: `pluginsEnabled: false`;
- `$CLI_ROOT` in local source citations: `/home/duongvm/.local/share/fnm/node-versions/v24.14.0/installation/lib/node_modules/@getpaseo/cli`;
- exact SDK: `@getpaseo/plugin` `0.8.0`.

At the audited baseline, `AGENTS.md` named `docs/reference/agent-orchestration-complete-operating-guide.md`, which remains absent from the repository. At HEAD `ee8c2a7` (the delta-audit commit; ancestor of this doc's commit) `AGENTS.md` references only [the candidate contract](../contract.md), and the guide exists solely as an untracked local artifact at `.local-checks/reference/agent-orchestration-complete-operating-guide.md`. This audit does not invent a replacement. Existing SLP behavior is taken from the contract and the implementation it maps.

## Executive verdict

### Packaging is feasible, but copying this repository into a plugin directory is not

A published plugin's managed checkout is not a stable runtime location. The daemon compiles the server entry into a string and evaluates it in a subprocess without exposing the plugin source directory. Git-managed updates move the candidate to a new path and delete the previous version. Therefore, provider commands and role instructions **must not point into the plugin checkout**.

The safe shared foundation for either viable option is:

1. generate a TypeScript file containing the exact SLP install-unit bytes and hashes;
2. bundle that generated data into the plugin server bundle;
3. atomically materialize an immutable, versioned SLP runtime under a stable user location;
4. point agent-visible helpers and provider transports only at that stable runtime, or use a path-independent bootstrap that receives its runtime location from a lifecycle hook.

### Option A is viable and lowest risk

A manager plugin can expose a settings/control screen and schema-validated RPCs. An explicit activation RPC can materialize the current SLP package, merge the twelve providers and two profiles through `paseo.config.patch`, and retain the current Codex/Pi/Devin/Claude transports. This preserves the present policy injection, routing, snapshot, inventory, upgrade, and E2E model with the least behavioral change.

It is not a perfectly lifecycle-native plugin: disable/remove has no pre-remove callback, so detaching SLP must remain an explicit operation. Raw plugin removal cannot be made transactionally equivalent to the current SLP uninstall contract.

### Pure Option B is not feature-equivalent

A pure `agent.create` + `systemPrompt` implementation is insufficient:

- the hook cannot see `profileId`, labels, parent, workspace, or initial prompt, so distinct role provider IDs are still required;
- Codex and Pi map the persisted system prompt into their native instruction mechanisms;
- generic ACP does not have a standard system-instruction channel, and on this 0.8.0 build the ACP adapter discards `systemPrompt` entirely — `session/new` sends only `{cwd, mcpServers}` (`acp-agent.js:1035–1038`), so not even vendor metadata is forwarded;
- `agent.session_open` may modify only environment variables;
- imported provider sessions do not pass through `agent.create`;
- plugin RPCs and client slash commands are not callable as agent tools;
- a plugin provider cannot publicly extend or delegate to a built-in Codex/Pi provider.

A complete direct `ProviderRegistration` for Codex and Pi is technically possible, but would reimplement Paseo's provider adapters: discovery, modes, prompts, streaming timeline, permissions, persistence, rewind, and child sessions. That is a provider rewrite, not a packaging change.

### A robust Option B hybrid is plausible, not yet accepted

A hook-controlled, path-independent bootstrap can preserve all twelve role provider IDs and the current transports:

- custom marker providers use a small executable shim at a stable runtime path rather than a checkout path (a `node -e` inline bootstrap is ruled out below — the Codex version probe executes `argv[0] --version` only, dropping args, so it would measure the Node runtime instead of the real binary);
- `agent.session_open` runs for create, resume, refresh, and import, materializes/verifies the bundled SLP candidate, and injects a dedicated session-open grant plus the runtime location through `env` (corrected discriminator design in the B2 follow-up below);
- the bootstrap imports the current stable `bin/{family}-role.mjs` and fails closed before any instruction-bearing request when the hook-provided runtime is absent;
- read-only provider/version/catalog discovery must still work without opening an unroled session.

Source contracts support this design, but catalog probing and fail-closed behavior differ by Codex, Pi, Claude, and ACP. It remains **LIVE-SPIKE** until all four providers pass the scenarios specified below.

## Facts established by isolated spikes

### `config.patch` capability

An isolated `DaemonConfigStore` test, using a temporary home rather than the live daemon, applied one patch containing:

- a custom provider with `extends`, `label`, and `command`;
- an `agentProfiles` array;
- `mcp.enabled: true` and `mcp.injectIntoAgents: true`.

Observed result:

- provider persisted: **yes**;
- profile persisted: **yes**;
- `mcp.injectIntoAgents`: changed to `true`;
- `mcp.enabled`: remained `false`.

This follows the exact patch schema and supported-field picker:

- `$CLI_ROOT/node_modules/@getpaseo/protocol/dist/messages.d.ts`, lines 154–213;
- `$CLI_ROOT/node_modules/@getpaseo/server/dist/server/server/daemon-config-store.js`, lines 153–180, 224–260, and 447–454.

A plugin must post-read configuration and require `mcp.enabled === true`; sending the field in a patch is not sufficient on 0.8.0.

### Plugin source-directory visibility

An isolated plugin compilation/evaluation test recorded inside the contributed server function:

```json
{"sourceUrl":null,"runtimeCwd":"/home/duongvm/projects/paseo-slp"}
```

`import.meta.url` did not identify the source, and `process.cwd()` was the daemon's working directory. This matches:

- `$CLI_ROOT/node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js`, lines 310–352;
- `$CLI_ROOT/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js`, lines 193–213;
- `$CLI_ROOT/node_modules/@getpaseo/server/dist/server/server/plugins/runtime.js`, lines 372–483.

The source path appearing in compiler metadata/comments is not a runtime API.

## Complete capability matrix

| Existing SLP behavior | Plugin primitive/evidence | Status | Consequence |
|---|---|---:|---|
| Install trusted code on daemon host | Git/directory plugin acquisition; server code and build commands are unsandboxed | PROVEN | A plugin may write files, spawn processes, and call the daemon SDK after user trust/enablement. |
| One distributable identity/version gate | `paseo-plugin.json` with `id` and `requirements.paseo` | PROVEN | Pin a tested 0.8 range; do not use an open-ended compatibility promise without tests. |
| Copy exact SLP install-unit bytes | Generate a file map and bundle it into server code; server writes a stable version directory | CONDITIONAL | Non-code Markdown/assets are not automatically available by source path. Generated bytes must be included and hash-verified. |
| Use plugin checkout as provider command path | Managed source paths rotate; server bundle lacks source path | UNSUPPORTED | Direct paths into Git/npm plugin storage are a no-go. Directory-only development does not prove publish/update safety. |
| Run preparation commands | Manifest `build` argv arrays, no shell | PROVEN for managed sources | Use for dependency install or generated source/assets only. Exact local 0.8.0 skips `build` for a direct directory install, so generated output must already exist for local development. Do not mutate live SLP state during staging. |
| Configure twelve custom providers | `paseo.config.get/patch`; provider patch accepts `extends`, `label`, `command`, `env`, models and policy fields | PROVEN | Preflight collisions and ownership, then patch exact provider records. |
| Configure two saved profiles | `paseo.config.patch({ agentProfiles })` | PROVEN | The entire array is patched; merge unrelated profiles and refuse SLP ID collisions. No declarative `addAgentProfile` contribution exists. |
| Preserve human profile choices on reinstall/upgrade | Read current profiles, retain model/mode/thinking/features, patch merged array | CONDITIONAL | Implement current ownership checks. There is no config compare-and-swap revision, so re-read/post-read and serialize plugin operations. |
| Enable MCP injection | Patch `mcp.injectIntoAgents` | PROVEN | Supported on exact 0.8.0. |
| Enable the daemon MCP service | `mcp.enabled` is visible via `config.get`, but ignored by `config.patch` | UNSUPPORTED by public patch on 0.8.0 | Require it as a precondition or add an upstream API. Directly editing an unknown daemon home is unsafe on multi-daemon hosts. |
| Enable plugins globally | User enables `pluginsEnabled`; plugin cannot run before that | PROVEN | Explicit trust approval is mandatory. Current test daemon has this off. |
| Record exact config ownership/rollback receipt | Stable `paseo-binding.json` or equivalent plugin-owned receipt | CONDITIONAL | Keep current exact-entry verification. Plugin settings alone are deleted on remove and are not enough for post-removal recovery. |
| Inject Codex role policy | `agent.create.config.systemPrompt`; Codex maps it to `developerInstructions` at start/load/turn | PROVEN for source path | Pure hook still needs live start/resume evidence and a role marker. Current wrapper remains the low-risk route. |
| Inject Pi role policy | `systemPrompt`; Pi creates a `before_agent_start` extension and persists prompt metadata | PROVEN for source path | Pure hook still needs live start/resume evidence. Current wrapper remains the low-risk route. |
| Inject Claude role policy | `systemPrompt`; Claude composes it into the Agent SDK `systemPrompt:{preset:"claude_code",append}`; under SDK 0.3.246 the wire request carries top-level `request.appendSystemPrompt` (the current wrapper already appends there; its `systemPrompt.append` branch is defensive compatibility, `plugin/server/runtime/cli/role-transport.ts:29–46`) | PROVEN for source path | Cleanest native mapping of the four families; imported native sessions and disabled-plugin launches still stay unroled. Current wrapper remains the low-risk route. |
| Inject Devin/generic ACP role policy | Current SLP ACP stdio transformer prepends first session prompt and rearms | PROVEN in current SLP | Generic plugin `systemPrompt` is not equivalent. Retain the adapter or implement/test a lower-level ACP stream wrapper. |
| Map `systemPrompt` through generic ACP | On this 0.8.0 build the ACP adapter drops `systemPrompt` outright — `session/new` sends only `{cwd, mcpServers}` (`acp-agent.js:1035–1038`); no `_paseo` metadata mechanism exists | UNSUPPORTED as generic instruction injection | Worse than earlier drafts assumed: not even metadata is forwarded. Retain the ACP transport. |
| Identify Supervisor/Lead/Peer in `agent.create` | Hook sees `config.provider` string | PROVEN | Keep distinct `slp-{family}-{role}` IDs or another provider-level marker. Profile ID is unavailable. |
| Identify selected profile | Not present in `PluginBeforeRequests["agent.create"]` | UNSUPPORTED | Do not design role selection around `profileId`. Profiles copy their values into config before the hook. |
| Read/change initial user assignment in hook | Hook request contains only `config` and optional `env` | UNSUPPORTED | A hook cannot prepend ACP policy to `initialPrompt`. |
| Change parent, labels, or workspace in agent hook | Those fields travel via `options`, outside the hook's `config` (`agent-manager.js:659–663`) | UNSUPPORTED | `cwd` is also blocked: `validateBeforeResult` throws `agent.create hooks cannot change the workspace directory` when returned `config.cwd` differs (`plugins/lifecycle/index.js:105–110`, invoked at `plugins/runtime.js:318`). Other config fields (`provider`, `model`, `systemPrompt`, …) are adopted wholesale — routing/parentage stays in the existing creation flow and evidence. |
| Apply config on create | `server.before("agent.create")` | PROVEN | Non-internal agents only; callback may fail creation and can append rather than replace existing prompt/config. |
| Apply launch env on create/resume/refresh/import | `server.before("agent.session_open")` with reason enum; only `env` may change | PROVEN | This is the stable seam for `SLP_RUNTIME_ROOT` and fail-closed bootstrap activation. |
| Modify prompt/provider config on resume/import | `agent.session_open` cannot change them | UNSUPPORTED | Persist role config during create or keep a transport that enforces it at protocol/session entry. |
| Preserve current role policy on active sessions | Host-managed custom provider process remains outside plugin subprocess | PROVEN by architecture | Option A/bootstrap hybrid can preserve it. Direct plugin providers cannot. |
| Register an ACP provider | `server.registerProvider(runAcpProvider(...))` | PROVEN | Useful for a new ACP provider, but not automatically equivalent to current role injection. |
| Register a direct provider | `ProviderRegistration` | PROVEN | Full protocol ownership is required. There is no built-in-provider delegation API. |
| Extend built-in Codex/Pi from a plugin provider | No `registerProvider` chaining/`extends` primitive | UNSUPPORTED | Continue using config custom providers or rewrite the provider. |
| Keep direct plugin-provider sessions across plugin reload/disable/update | Plugin cleanup closes every provider connection and subprocess | UNSUPPORTED | Reload/update can interrupt active turns; persistence may permit later recovery, not uninterrupted continuity. |
| Observe turn, permission, create/archive events | `server.on(...)` lifecycle events | PROVEN | Useful for monitoring/UI, not a replacement for current evidence acceptance. |
| Invoke `prepare`/`prepare-handoff` from plugin UI | Client action → schema RPC → existing pure planning code | PROVEN | Human/app flow is straightforward. |
| Invoke `prepare`/`prepare-handoff` from a role agent | Plugin RPC and client slash commands are not agent MCP tools | UNSUPPORTED directly | Retain stable `bin/slp.mjs` or implement and inject a separately hosted MCP server. |
| Run `routes`, `snapshot`, `identity`, `verify` from role policy | Stable materialized Node CLI | CONDITIONAL | Works if policy bytes name the stable runtime. The plugin checkout must not be named. |
| Initialize `.paseo-slp/` explicitly | Server RPC may write daemon-local workspace files; Command Center/panel supplies workspace context | PROVEN | Preserve explicit opt-in and no-overwrite behavior. Do not auto-write on workspace creation. |
| Read repo and user routing catalogs | Server Node filesystem | CONDITIONAL | Repo path is known. User-scope fallback needs the exact intended Paseo home or an explicit replacement location. |
| Discover daemon home | No field in `PluginServerContext`, hook context, `PaseoApi`, or runtime setup identifies it | UNSUPPORTED by public API | Do not infer `~/.paseo` for remote/non-default daemons. Ask/configure it only where a filesystem operation truly needs it. |
| Inventory providers/profiles | `paseo.providers.*` plus `paseo.config.get` | PROVEN | Prefer SDK data for the connected daemon over spawning a default CLI. |
| Read native persistence handles/attach hints | SDK `agents.list()` retains `entries[i].agent.persistence?.nativeHandle`; CLI inspect and the existing FS helper are different paths | PROVEN for returned SDK snapshots; CONDITIONAL for full inventory parity | See the helper follow-up: pagination, archived/unavailable-provider records, missing handles, and permissions must be accounted for before replacing the full FS helper. |
| Distribute onboarding behavior | Bundle/read the existing skill from stable runtime or expose explicit setup UI | CONDITIONAL | There is no declarative plugin skill contribution. Do not silently install files into provider-specific global skill directories. |
| Contribute agent-callable custom MCP tools | No such plugin contribution exists | UNSUPPORTED directly | A plugin may independently run an MCP server and inject it, but that is a new service with lifecycle, endpoint, auth, and resume requirements. |
| Add app-side setup/status UI | Settings screen, surface, workspace panel, Command Center, slash command | PROVEN | Client code must be React Native and work on compact/mobile layouts. Slash commands run in the client and are never sent to the agent. |
| Work when no app is connected | Server hooks and registered providers run in daemon subprocess | PROVEN | Setup that needs `paseo` still needs a hook/RPC context; `PluginServerContext` itself exposes only registration methods. |
| Perform configuration automatically during server contribution | Setup context has no `paseo` API | UNSUPPORTED directly | Use an explicit/automatic client RPC or defer safe reconciliation to a hook that receives `{ paseo }`. |
| Update plugin source safely | Candidate build/validation and old-version restore on activation failure | PROVEN | This protects plugin source, not separately mutated SLP config/runtime. Runtime reconciliation needs its own transaction. |
| Preserve old runtime for active sessions during SLP upgrade | Write immutable versioned directories and rebind future providers | CONDITIONAL | Keep current side-by-side cutover and explicit cleanup; plugin source updater otherwise deletes old managed checkout. |
| Intercept plugin disable/remove | Cleanup has no reason and no pre-remove hook | UNSUPPORTED | Never use generic cleanup as uninstall; it also runs on reload/update. |
| Exact current uninstall on raw `paseo plugin remove` | Remove stops plugin, deletes source/settings, and exposes no transactional callback | UNSUPPORTED | Require explicit **Deactivate SLP** first, or make leftover launchers fail closed. |
| Logs | `paseo plugin logs` and Settings → Plugins → Logs | PROVEN | Never log credentials or complete sensitive prompts. |
| npm distribution on this exact host | Deployed docs describe npm; exact local 0.8.0 CLI advertises and implements directory/Git only | UNSUPPORTED on tested host | Use Git for the first compatible release or raise the minimum Paseo version after testing npm acquisition. |
| Git distribution on this exact host | Managed Git source implementation is present | PROVEN | Build dependencies explicitly; avoid source-relative runtime commands. |

## Option A — manager/installer plugin

### Architecture

```text
Git/directory plugin
  client settings/control screen
    -> activate / reconcile / deactivate RPC
  server bundle
    -> embedded generated SLP file map + candidate hash
    -> current install/upgrade/uninstall logic
    -> SDK config get/patch

Stable runtime store
  <configured-user-data>/paseo-slp/<candidate-sha>/
    bin/
    src/
    skills/
    package.json
    installed.json
    paseo-binding.json

Paseo config
  twelve slp-* providers -> stable runtime bin/*-role.mjs
  two SLP profiles
  mcp.injectIntoAgents = true
```

The first activation supplies or confirms:

- stable runtime root;
- exact Paseo home only for current user-catalog/persistence-file features;
- whether `daemon.mcp.enabled` is already true;
- collision-free provider/profile ownership.

The RPC then:

1. reads current config through the exact daemon connection;
2. refuses collisions or modified formerly-owned entries;
3. writes a new immutable candidate to a staging directory;
4. verifies every byte and atomically publishes the version directory;
5. patches providers, merged profiles, and `mcp.injectIntoAgents`;
6. post-reads and verifies exact resulting entries;
7. writes the binding receipt only after the config operation succeeds;
8. leaves prior runtime versions in place for active sessions.

### Lifecycle semantics

| Plugin action | Option A behavior |
|---|---|
| Install | Installs manager only; SLP activation is an explicit second operation. |
| Reload | Manager restarts; existing SLP provider processes and sessions continue. |
| Update | New embedded candidate becomes available. Reconcile performs side-by-side SLP cutover; plugin checkout path is irrelevant. |
| Disable | Manager UI/hooks stop, but already installed SLP providers continue unless explicitly deactivated. This must be stated clearly. |
| Remove | Manager is deconfigured; managed source/settings disappear, while a local directory source remains. Stable SLP remains operable unless previously deactivated. Raw remove is not SLP uninstall. |
| Deactivate SLP | Exact owned-entry verification, provider/profile removal, restoration of owned shared settings, preservation of edited routing catalog, and safe runtime retention/removal. |

### Advantages

- preserves the current provider IDs, transport behavior, role bytes, CLI helpers, and E2E evidence model;
- does not interrupt active agents when the plugin itself reloads/updates;
- plugin source acquisition and SLP runtime cutover are independent transactions;
- smallest policy/behavior change.

### Costs and hard conditions

- plugin lifecycle controls the manager, not automatically the installed SLP runtime;
- explicit activation/deactivation is unavoidable without upstream pre-remove support;
- `mcp.enabled` is a checked prerequisite on 0.8.0;
- daemon-home-dependent features need an explicit exact home;
- stale runtime cleanup remains a human-authorized operation after dependent sessions settle.

**Option A decision:** **CONDITIONAL → shippable with documented operational constraints** (adjudicated below; supersedes the earlier "not yet GO" wording). It remains the lowest-change candidate; the config-store follow-up adds explicit concurrency, field-restoration and recovery constraints — accepted as documented limitations plus an exclusive administrative window — and the live gates S1/S2/S5–S8 remain mandatory before production commitment.

## Option B — lifecycle-native redesign

### B0: pure `agent.create` system-prompt hook

Possible creation flow:

```text
SLP marker provider selected
  -> agent.create hook reads config.provider
  -> append role bundle to config.systemPrompt
  -> launch stock provider
```

This is useful but not full parity.

#### What works

- The role can be selected from a distinct provider ID.
- Existing user/system instructions can be preserved by append semantics.
- Codex maps the value to native developer instructions.
- Pi maps the value to its native extension and persists it.
- The transformed config is normalized and stored for newly created agents.
- The hook can throw and fail creation.

#### What fails or changes

1. **No profile identity:** only provider-level role markers work.
2. **No initial-prompt transform:** generic ACP cannot be repaired at this hook.
3. **No import transform:** an imported provider session skips `agent.create`.
4. **Resume hook is env-only:** correctness depends on the created config retaining its prompt.
5. **Disable fail-open risk:** an ordinary alias that merely `extends` a stock provider remains launchable without the policy hook.
6. **Marker-to-base transform changes evidence:** changing `slp-codex-lead` to `codex` before launch loses the present runtime provider identity and requires contract/E2E changes.
7. **Hook composition:** later trusted plugins run in plugin-ID order and may replace fields. Plugin policy is not a security boundary.

A sentinel marker provider whose command fails unless the hook changes it to the base provider can prevent fail-open creation. That still changes stored provider identity and does not solve generic ACP.

**Pure B0 decision:** **NO-GO for full SLP parity.** It may be an optional future simplification for Codex/Pi/Claude only.

### B1: direct plugin providers

`server.registerProvider()` and `runAcpProvider()` are real provider extension points. They are appropriate when the plugin owns the native SDK/protocol.

They do not provide:

- a call into Paseo's built-in Codex provider;
- a call into Paseo's built-in Pi provider;
- a generic outbound ACP prompt transformer carrying per-session environment without additional connection design;
- uninterrupted sessions across plugin reload/update/disable.

A plugin can vendor/reimplement the Codex and Pi adapters, but doing so forks core behavior and expands the compatibility surface far beyond this package.

**Direct-provider B1 decision:** **NO-GO as a packaging strategy.** Use only if SLP intentionally becomes an independent provider implementation with its own test matrix.

### B2: hook-controlled bootstrap hybrid

This design preserves the current adapters while coupling future session opens to the plugin.

```text
Configured slp-{family}-{role} provider
  command: [<stable-runtime>/bin/slp-shim, role]
    (executable shim file, not node -e: the Codex version probe
     runs argv[0] --version with args dropped, so argv[0] must
     itself be the shim that can answer or proxy version probes)

Provider discovery
  bootstrap permits only required read-only/version/catalog protocol

Real create/resume/refresh/import
  agent.session_open hook:
    verify provider is an SLP marker
    materialize embedded candidate to immutable stable cache
    return env + SLP_RUNTIME_ROOT + candidate identity

Bootstrap:
  require valid hook-provided candidate for instruction-bearing/session work
  import <SLP_RUNTIME_ROOT>/bin/{family}-role.mjs
  otherwise fail before forwarding a prompt
```

Why use `agent.session_open` rather than only `agent.create`:

- it runs for all four entry reasons: create, resume, refresh, import;
- its environment reaches the provider process;
- it preserves the visible/stored SLP provider ID;
- absence of the plugin can be made fail-closed at the transport boundary;
- current protocol-specific policy semantics remain unchanged.

The bootstrap must not merely test an environment variable at process start, because providers may start processes during catalog/model discovery before a session-open hook exists. It needs a bounded family-specific rule:

- allow the exact discovery/version messages needed by Paseo;
- require a valid candidate and role policy before a thread/session/prompt becomes instruction-bearing;
- reject malformed or unsupported ordering;
- never launch an ordinary unroled interactive session.

### B2 lifecycle semantics

| Plugin action | Expected behavior; acceptance requirement |
|---|---|
| Install, not activated | No SLP entries, or marker entries whose bootstrap cannot perform interactive work. |
| Active | Every session-open selects a verified immutable candidate. |
| Reload/update | Existing provider subprocesses continue. New session opens during a hook gap fail visibly; after reload they use the new verified candidate. |
| Disable | Active sessions may continue; create/resume/refresh/import must fail before an unroled prompt. |
| Remove | Leftover marker providers/profiles may remain visible, but must fail closed. Explicit deactivate still removes them cleanly. |
| Catalog discovery while disabled | May report diagnostics/catalog, but must never progress to an instruction-bearing turn. |

### B2 remaining risks

- each family has different discovery/start protocol boundaries;
- the bootstrap must be a real executable shim file (POSIX shebang + `chmod`, `.cmd` on Windows) at a stable path — `node -e` is ruled out because the Codex version probe runs `argv[0] --version` only (`resolveBinaryVersion`, `diagnostic-utils.js:108–120`; callers `codex-app-server-agent.js:5547–5578`);
- Node executable resolution must be verified on Linux, macOS, and Windows; do not assume an Electron executable behaves as ordinary Node;
- source-proven hook order is not proof of actual Codex/Pi/Devin/Claude catalog behavior;
- exact failure must be observable in provider diagnostics and agent error state;
- plugin removal still cannot atomically remove config entries;
- this changes the package's installation and lifecycle contract and requires a new E2E evidence design.

**Option B2 decision:** **LIVE-SPIKE; no implementation commitment yet.** It is the only Option B variant that plausibly preserves all twelve role providers without reimplementing Paseo providers.

## Public plugin limitations that must remain explicit

1. **No source-directory capability.** Only provider icon resolution is explicitly relative to the plugin directory and is resolved by the host; general server code receives no directory handle.
2. **No server-start Paseo API.** `PluginServerContext` registers handlers/hooks/providers/settings. `{ paseo }` arrives in RPC and hook contexts.
3. **No pre-disable/pre-remove reason.** Cleanup runs for reload, update, disable, remove, process failure, and daemon shutdown; it cannot safely mean uninstall.
4. **No declarative agent profile contribution.** Profiles are mutable daemon config.
5. **No declarative agent skill or MCP-tool contribution.** Client slash commands are app actions, not agent commands.
6. **No hook access to initial prompt/profile/labels/parent.** Role signaling must use available config, normally provider ID.
7. **No non-env session-open mutation.** Resume/import policy must already be persisted or enforced by the provider transport.
8. **No built-in-provider delegation from `ProviderRegistration`.** Plugin providers own their protocol connection.
9. **No uninterrupted direct plugin-provider lifecycle.** Provider connections close when the plugin stops.
10. **No public 0.8.0 patch for `mcp.enabled`.** Post-read instead of assuming passthrough fields applied.
11. **No daemon-home locator in the SDK.** This matters on remote and multi-daemon hosts.
12. **No config revision/CAS in `config.patch`.** Serialize operations and verify after every administrative mutation.

Trusted, unsandboxed Node access can bypass several public limitations by editing files or running commands. That does not make such a bypass safe: without the exact target daemon home/endpoint and live-apply contract, it can mutate the wrong host or produce state the connected daemon has not applied. Missing host capability must be recorded before any fallback is considered.

## Version and documentation compatibility

The deployed documentation currently describes npm and Git acquisition and a settings handle returned by `server.registerSettings()`. Exact local 0.8.0 evidence differs in two relevant places:

- the installed CLI command/source service supports directory and Git sources, not npm identifiers;
- local `PluginServerContext.registerSettings(...)` is typed to return `void`, whereas current deployed reference examples use a returned server settings handle.

Therefore:

- initial distribution should use Git against this host;
- implementation must typecheck against the exact minimum SDK;
- any use of newer settings/acquisition contracts must raise `requirements.paseo` to the first verified release;
- use an upper bound such as `<0.9.0` until 0.9 compatibility is explicitly tested.

## Required live spikes before implementation commitment

These are tests, not optional post-implementation QA.

### S1 — plugin activation and config transaction

On an isolated Paseo home/daemon:

1. enable plugins with explicit trust approval;
2. install a minimal Git-managed plugin;
3. invoke setup RPC through its client contribution;
4. add one custom provider and one profile with `config.patch`;
5. prove immediate provider/profile discovery and persistence after daemon reload;
6. prove collision refusal and preservation of unrelated concurrent config;
7. prove `mcp.enabled` precondition fails closed and post-read catches it.

Pass criterion: no direct `config.json` edit or default-daemon inference is needed.

### S2 — stable materialization and managed update

1. install revision A from Git;
2. materialize candidate A and launch a real role session;
3. update the plugin to revision B;
4. prove plugin checkout path changes and A checkout is removed;
5. prove the active A session continues;
6. materialize B, rebind future launches, and prove a new B session loads B bytes;
7. prove rollback leaves A config/runtime valid when B activation fails.

Pass criterion: no provider/helper path contains a plugin managed-checkout directory.

### S3 — pure hook behavior for Codex and Pi

For each provider:

1. create through an SLP marker;
2. capture actual initial native instruction input;
3. resume and refresh, capturing instructions again;
4. disable the plugin and attempt a fresh marker launch;
5. attempt provider-session import under the marker;
6. verify no unroled turn can start.

Pass criterion: exact role bytes appear once, existing host instructions remain, and every unsupported path fails before a user prompt reaches the agent.

### S4 — Option B2 bootstrap for Codex, Pi, Devin ACP, and Claude

For every family and role transport:

1. provider availability and model/mode discovery with no session-open env;
2. real create with hook-provided candidate;
3. actual initial prompt/instruction capture;
4. resume, refresh, and supported import;
5. malformed/missing candidate identity;
6. plugin reload between discovery and session open;
7. plugin disable/remove followed by launch;
8. active turn during plugin reload/update;
9. Node bootstrap on each supported daemon OS;
10. stale-grant/stale-`PASEO_AGENT_ID` inheritance from a daemon launched inside an agent session: catalog/draft spawns must stay in discovery mode and a tampered grant must hard-fail.

Claude-specific additions: `--version`/`auth status` admin probes must pass through the bootstrap to the real binary — these probes DO receive provider `env` via `createProviderEnvSpec({runtimeSettings})` (`claude/agent.js:1234–1239,1248–1249`), so `SLP_CLAUDE_BIN` and the sentinel are present and only the session-open overlay is absent; catalog fetch spawns no session; draft-command listing spawns a real stream-json session without grant env and must complete its initialize round-trip without forwarding any `type:"user"` frame.

Pass criterion: discovery works as required, while every instruction-bearing path is either correctly roled or rejected before reaching the underlying agent.

### S5 — explicit deactivate and raw remove

1. modify unrelated config and human-owned profile settings;
2. run explicit deactivate and prove exact preservation/current ownership rules;
3. edit an SLP-owned entry and prove deactivate refuses;
4. edit the user routing catalog and prove it is preserved;
5. raw-remove the plugin without deactivate and verify the selected lifecycle contract: A retains a verified, correctly roled stable runtime; B2 rejects future session opens without the hook with an actionable diagnostic;
6. reinstall the same ID and prove recovery is deterministic.

### S6 — agent-facing helper accessibility

From actual Supervisor, Lead, and Peer sessions:

- run `routes`, `prepare`, `prepare-handoff`, `snapshot`, and required inventory/agent inspection through the selected stable mechanism;
- prove helpers use the intended daemon/repository and exact bundled candidate;
- prove plugin UI-only RPCs are not mistaken for agent tools.

### S7 — UI and host scope

- wide desktop and compact/mobile setup/status screen;
- dark/light themes;
- two connected daemons with different plugin/config states;
- remote daemon filesystem actions occur on the selected daemon only;
- an older app reports requirements incompatibility rather than evaluating unsupported client code.

### S8 — SLP behavioral acceptance

Run the SLP E2E manifest required by the changed transport/lifecycle contract, including all twelve `resume-{role}-{provider}` scenarios (48 scenarios total at HEAD `ee8c2a7`, unchanged through `0f7ccde`; onboarding now covers `{project,global}×{codex,pi,claude}`). Existing U2 evidence explicitly correlates provider command, installed bytes, actual initial/resume input, settings, parent create arguments, and triggered reference reads. Local typechecks and transport unit tests are not E2E acceptance.

## Go/no-go criteria

### Common GO requirements

- exact generated candidate bytes are reproducible and hash-bound;
- no runtime command or role instruction relies on plugin checkout location;
- custom provider/profile config is collision-safe, ownership-checked, and post-verified;
- `mcp.enabled` is true before activation;
- role helpers remain callable by agents, not only by app UI;
- no enabled path can start an unroled SLP-labeled agent;
- update preserves active-session ownership and old-candidate evidence;
- explicit deactivate is documented and tested before raw plugin removal;
- exact Paseo daemon and client version ranges are pinned;
- full affected SLP E2E acceptance passes.

### Option A GO

Proceed when S1, S2, S5, S6, S7, and S8 pass and the Human accepts that plugin disable/remove is distinct from SLP deactivate/uninstall.

### Option B GO

Proceed only when S3 and S4 additionally pass for Codex, Pi, Devin, and Claude, and the candidate changes to SLP's role-transport/evidence contract are reviewed and accepted.

### Immediate NO-GO conditions

Do not implement the chosen design if any requirement is:

- provider commands point into the managed plugin source;
- plugin cleanup is treated as uninstall;
- `config.patch({ mcp: { enabled: true } })` is assumed to work on 0.8.0;
- profile ID or initial prompt is assumed available in `agent.create` hooks;
- generic ACP is assumed to consume `systemPrompt` as role policy;
- a client slash command/plugin RPC is described as an agent tool;
- direct plugin providers are assumed to survive plugin reload/update;
- raw plugin removal must atomically restore the current SLP binding;
- pure Option B must support all four families without a retained ACP transport or provider rewrite;
- local checks are accepted as workflow E2E evidence.

## Implementation and user-experience differences

| Dimension | Option A — manager plugin | B0 — pure hook | B2 — hook + bootstrap |
|---|---|---|---|
| Existing code reuse | High | Low/medium; transport contract changes | High |
| Codex/Pi injection | Current wrappers | `systemPrompt` hook | Current wrappers behind bootstrap |
| Devin/ACP injection | Current wrapper | Not equivalent | Current ACP wrapper behind bootstrap |
| Claude injection | Current wrapper | `systemPrompt` → native SDK preset append | Current wrapper behind bootstrap |
| Runtime files | Stable versioned directory | Fewer files, missing helper parity | Stable versioned cache |
| Provider command | Points to stable runtime | Alias/marker provider | Executable shim at stable runtime path (`node -e` ruled out by the argv[0]-only version probe) |
| Lifecycle complexity | Medium | Lowest, but loses parity | Highest |
| E2E surface | Closest to existing | Major redesign | Discovery/lifecycle expansion |
| Plugin reload impact | Active role sessions continue | Active sessions continue, but new policy application stops | Active sessions may continue; new opens can fail visibly during a hook gap |
| Disable UX | Installed SLP still works unless deactivated | Ordinary aliases may launch unroled | SLP launch should fail closed |
| Remove UX | SLP remains installed unless deactivate ran | Aliases may remain and be ambiguous | Leftover providers should fail closed |
| Update UX | Explicit apply after plugin update; old sessions continue | New plugin behavior applies after update | New opens use newly verified candidate after plugin restart |
| Distribution UX | Install plugin, open manager, activate | Install plugin, select profiles | Install plugin, activate, then launches are hook-coupled |
| Failure UX | Setup errors in manager/RPC | Creation-time errors | Provider diagnostics plus launch-time errors |

## Recommendation

Build **Option A first**, sharing its generated candidate bundle, ownership checks, and stable materializer with an Option B2 experiment. Do not initially replace current role transports.

The independent architecture adjudication (memo in the committee agent's history, summarized below) refines this: **Option A is shippable with explicit operational constraints — it is not blocked by the missing upstream CAS**, provided the contract documents that concurrent-edit preservation is a limitation rather than a guarantee, activation/deactivation are serialized human operations inside an exclusive administrative window, verification compares persisted-shape state, and every interruption routes through an idempotent reconcile. Two pre-implementation decisions are promoted to v1 requirements: the executable-shim design (which also repairs the pre-existing Codex `argv[0] --version` mis-parse) and Node-executable resolution that does not trust the plugin subprocess `process.execPath` on Electron-packaged hosts.

The first implementation milestone should be only a throwaway S1/S2 probe on an isolated daemon. The second decision point is whether the product benefit of plugin-coupled fail-closed launches justifies B2's four-provider discovery/bootstrap matrix and a changed SLP E2E contract. B2 stays experimental: its fixture is a verdict classifier, not a real proxy, and its allowlists are source-estimated rather than wire-measured.

The current daemon cannot run that probe without a separate authorization because `pluginsEnabled` is presently `false`.

## Evidence follow-up: offline byte-materialization spike (2026-09-17)

A throwaway `node:test` spike exercised the shared Option A/B2 foundation through the full offline byte/compile/restore sequence on this host — not the plugin lifecycle or E2E. The test file is a local-only artifact at `.local-checks/plugin-candidate-roundtrip.test.mjs` (gitignored, not shipped; it does not exist in a fresh public clone). Results below were independently reproduced by the coordinator.

Environment and candidate:

- Host: WSL2 Linux (verified via `uname -sr`), Node v24.14.0, `paseo --version` 0.8.0; compiler loaded from `$CLI_ROOT/node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js` — bound to this host's install.
- Candidate (exact install unit per `plugin/server/runtime/cli/package.ts` `identity()`, lines 17–22): sha256 `3ac1192b12099d98ce49e5aeab1ccbfa8b6dd03965120e3432a9448ba18a1e64`, 35 files. An earlier run of this spike at baseline `a75c4db` measured sha256 `d1c54ddcefc7977daff03454ed53e399aa2afb40160bb53848fe9968bd87d11f`, 31 files; HEAD moved to `ee8c2a7` adding the Claude family and three `src/` helpers.
- Embedded payload: one JSON file map (path + sha256 + base64 bytes), 252,696 bytes; compiled `serverBundle` 254,290 bytes (205,489 / 207,063 bytes for the earlier 31-file candidate).
- Rerun command: `node --test .local-checks/plugin-candidate-roundtrip.test.mjs` → 11 pass / 0 fail / 0 skip, ~0.8 s; each run uses a fresh `mkdtempSync` directory and never touches prior fixtures (test lines 19–21, 92–96).
- Install-unit breakdown of the 35 hashed files: `package.json`, `install.sh`, 5 files under `bin/`, 2 skill files under `skills/`, 26 files under `src/` — matching the contract's install-unit definition exactly (the earlier candidate was 31 files: 4 under `bin/`, 23 under `src/`).
- The spike's `restore()` validates every declared path and byte hash before creating the destination, writes a production-shaped `installed.json` (`{source, candidate}`), then re-verifies with `verifyInstall()` (test lines 39–84).
- Production `install()` was exercised once against a test-owned fixture directory solely to measure permission bits; it wrote no host configuration and touched no daemon state.
- No host capability was used: the spike changed no global switch or host config, installed no plugin, started no daemon, and read or wrote no provider or profile entry.
- Three independent runs coexist under `.local-checks/plugin-candidate-roundtrip/` — `run-3tju9b` (author) and `run-AFe2wV` (coordinator) exercised the earlier 31-file `d1c54ddc` candidate; `run-2DnucI` (coordinator) exercised the current 35-file `3ac1192b` candidate. All passed 11/11; only `run-2DnucI` substantiates the current candidate.
- Every test regenerates the bundle from current working-tree bytes, including any uncommitted install-unit edits. HEAD `d30dacb6f35366b2821965992962d8f2d540cfb3` is contextual; the candidate SHA above identifies the bytes actually tested.

Now proven OFFLINE:

- The real installed `compilePlugin({ server })` (exported at compiler.js 347–352; `compileTarget` at 310–345; CJS wrapper `wrapCommonJsBundle` at 246–248) bundles a generated `server/payload.ts` module and the resulting bundle evaluates standalone via a narrowly mocked contribution context with no daemon; the payload string returns byte-for-byte and `process.cwd()` inside `contribute` is the caller's cwd, independent of the plugin source directory (test lines 227–268).
- No unexpected external `require` fired for THIS payload-only bundle — it proves embeddability of the data module, not that a full plugin with SDK imports is external-free.
- The generated plugin fixture used a root `index.server.ts` plus `server/payload.ts`, matching the compiler's `client/`/`server/`/`shared/` boundary rule (compiler.js `directoryTarget` 51–69, `moduleBoundaryError` 99–114): code files elsewhere under the plugin root are compile errors. Pure literal data is also permitted under `shared/`; `server/` is the recommended location so the payload cannot be accidentally pulled into a client bundle.
- Restored runtime passes production `identity()`/`verifyInstall()` (`plugin/server/runtime/cli/package.ts` lines 23–29) and all three `roleBundle()` loads (`plugin/server/runtime/cli/role-bundle.ts` lines 18–29), including under a Unicode/space-containing target path (test lines 98–134).

Validation behavior actually tested (test lines 136–210):

- Duplicate paths, tampered bytes, tampered declared hashes, and all invalid/traversal/absolute path cases are rejected BEFORE the destination directory is created.
- A missing entry is rejected AFTER restoration by the candidate-hash check — it is not a before-write guarantee.
- An existing destination is refused (`EEXIST`) and a sentinel file inside it is preserved; `restore()` never pre-deletes.
- Rejected-path coverage included `..`, `a/../../x`, empty and `.` segments, doubled separators, POSIX-absolute, and `C:\`/`sub\..\` Windows-style inputs — rejected lexically before any filesystem call on the target.
- The spike's restore is NOT atomic: a mid-write failure can leave a partial destination; the production materializer still needs staging-plus-rename semantics.
- These are functional checks only: no hostile concurrent writer, symlink, or cross-platform adversarial testing was done, so this is not a general path-security proof.

Measured file-mode correction: the earlier remark that `copyFileSync` loses the exec bit was FALSE on the tested Linux host. Measured `install.sh`: source 0o755, spike `writeFileSync` restore 0o644, production `install()` `copyFileSync` 0o755 (test lines 212–225). Consequence: byte identity does not cover permission bits, so a plugin materializer writing bytes must explicitly preserve required source modes. The current `identity()` contract is unchanged; no production change is proposed now.

Windows path-key concern is source-derived, not tested: `files()`/`identity()` build map keys with `path.join()` (`plugin/server/runtime/cli/package.ts` lines 9–22), so keys are separator-dependent across build platforms. Canonical path/hash design and actual Windows tests remain open.

Eleven tests total: unique run dir, byte-exact roundtrip under Unicode/space path, three role-bundle loads, existing-destination preservation, tampered bytes, tampered declared hash, missing entry, nine invalid/traversal/absolute path cases, duplicate path, measured file modes, and the real-compiler embed/eval roundtrip.

Limits: the fixture is a local ignored artifact; the mocked `contribute` is not SDK API validation; nothing exercised typecheck, full plugin initialization, live subprocess, config get/patch, hooks, providers, atomic staging, crash recovery, managed-source update, or live E2E. The compiler binary and `compiler.js` used are this host's installed 0.8.0 copy — results do not transfer automatically to other Paseo versions. This de-risks the shared A/B2 byte materialization path but does NOT pass scenarios S1–S8 and does NOT select B2.

## Helper integration follow-up: source-verified findings

These findings supersede the earlier uncertainty about SDK native handles. They do not establish full helper parity or constitute a live plugin test.

### SDK native handles are available, but inventory coverage needs work

The returned path is `response.entries[i].agent.persistence?.nativeHandle`:

- `$CLI_ROOT/node_modules/@getpaseo/server/dist/server/server/agent/agent-projections.js`, lines 53–85 and 275–301, retains `nativeHandle` while removing `metadata.mcpServers` from the wire projection.
- `$CLI_ROOT/node_modules/@getpaseo/protocol/dist/messages.js`, lines 659–708 and 3455–3485, preserves the field in response entries.
- `$CLI_ROOT/node_modules/@getpaseo/client/dist/index.js`, lines 77–83, delegates `agents.list()` to `fetchAgents`; `daemon-client.js`, lines 1075–1102, returns the response payload without stripping it.

This can replace persistence-file reads for attach hints on returned agents. It is not a drop-in replacement for `plugin/server/runtime/cli/agents.ts`, lines 18–55: handle absence, pagination, archived records, permissions, and unavailable-provider records need explicit treatment. In server `session.js`, lines 3591–3603, `includeUnavailablePersisted` is enabled for history requests, not ordinary `fetch_agents_request` used by the public `agents.list()` method. Do not remove the exact-home requirement for every legacy filesystem feature on this evidence alone.

### Stable CLI paths do not establish daemon identity

`plugin/server/runtime/cli/inventory.ts`, lines 50–77, checks PID liveness, removes only `PASEO_HOST`, and invokes `paseo provider ls --json`. The source exposes four risks, not yet reproduced against live daemons:

1. An inherited IPC `PASEO_LISTEN` can select another endpoint: CLI `dist/utils/client.js`, lines 99–110.
2. Default resolution appends a fallback host when no explicit host is supplied: the same file, lines 119–142.
3. Provider listing returns static manifest data on connection/snapshot failure: CLI `dist/commands/provider/ls.js`, lines 38–67. SLP can still label that result as coming from the live listing command.
4. A live PID does not establish that it belongs to the intended daemon; stale PID reuse remains possible.

The connected SDK avoids default-CLI target selection for plugin-side calls. Retaining the old CLI for agents retains its addressing/provenance risks. A complete design needs explicit target identity and live-versus-static provenance, not just environment-variable deletion. No credential clearing or host mutation is justified by this finding.

### Minimal integration seams

| Existing component | Preserve or change for plugin integration |
|---|---|
| `identity`, `verifyInstall`, `roleBundle` | Pass the stable runtime root; retain policy/reference/helper bytes. `plugin/server/runtime/cli/package.ts:17–28`, `plugin/server/runtime/cli/role-bundle.ts:18–29`. |
| `launchPlan`, `handoffPlan` | Preserve complete bindings, `inventoryFile`, `assignmentFile`, settlement and creation arguments. They do not create agents; handoff calls `snapshot`, which runs Git subprocesses, so it is not pure filesystem-only code. `plugin/server/runtime/cli/launch.ts:53–88,161–208`, `plugin/server/runtime/cli/package.ts:55–89`. |
| `routes`, `catalogBinding` | Preserve repository-first resolution and explicit legacy user-home fallback; never infer a remote daemon's home from the client machine. `plugin/server/runtime/cli/routing.ts:54–98`. |
| `inventory`, `agents`, `monitor`, `notebook` | Prefer selected-connection SDK data for plugin UI; adapt response shapes and coverage explicitly. Independently address the retained agent CLI path. `monitor` and `notebook` (added at HEAD `ee8c2a7`) are daemon-home-dependent like `agents`/`inventory`: both read `<home>/agents/*` state and need the explicit exact home; `monitor` also has an opt-in `devinSessionsDb` probe and a single caller-chosen `stateFile` write. `plugin/server/runtime/cli/monitor.ts`, `plugin/server/runtime/cli/notebook.ts`. |
| `materialize` | New at HEAD `ee8c2a7` (`plugin/server/runtime/cli/paseo-install.ts:234–258`): clones `.paseo-slp/` protocol and catalog across checkouts with frontmatter path rebasing. Repository-path driven; no daemon-home dependence. |
| `initWorkspace` | Preserve preview/apply, explicit `--routing-from`, daemon-local repository paths and no-overwrite behavior. `plugin/server/runtime/cli/paseo-install.ts:197–232` (`stageEntries` at `:175–194`). |
| Onboarding and host activation | Stable skill files remain accessible; no automatic global skill installation or workspace writes. Host install/upgrade DOES create `<home>/slp-routing.json` when absent via `scaffoldUserCatalog` (`plugin/server/runtime/cli/paseo-install.ts:22–25`, called at `:80,:156`; uninstall removes the unchanged scaffold at `:112–117`) — `docs/contract.md:67–68` claims the opposite, a contract-versus-implementation inconsistency to reconcile. |

Workspace context can supply the target repository; SDK calls can supply provider/profile inventory and handles for visible agents. A verified runtime location, actual Node executable, and exact home for legacy filesystem/fallback features still need configuration or a proven resolver. `process.execPath` is not automatically ordinary Node on an Electron-packaged host; retain the platform gate.

### Evidence must retain its existing meaning

SDK snapshots may establish inventory/attach-hint provenance in preflight or artifact records. They cannot replace the native coordinator transcript: `e2e/evidence.mjs`, lines 23–34 and 92–113, requires transcript content, native session marker, hash, and source-verified capture. Additional structured runtime-root/argv fields are proposed improvements, not existing enforcement: launch evidence currently uses `capturedBytes`. Preserve correlation of candidate bytes, provider argv, native instructions, selected daemon, parentage, and settlement. No E2E was run for this follow-up.

## Option A follow-up: recovered offline config-store evidence

The High agent hit a provider quota before delivering its final synthesis, but left `.local-checks/plugin-followup-a.test.mjs`. The coordinator reviewed and independently ran this local-only artifact against the exact installed `DaemonConfigStore`:

`node --test .local-checks/plugin-followup-a.test.mjs` → **12 pass, 0 fail, 0 skip** on Node v24.14.0 (about 0.52 s).

Each test uses a fresh temporary home, with no live daemon, network, plugin or native provider process. The fixture's `initialFor()` supplies a representative resolved config; its `reloadSource` is a test resolver. These tests do not exercise production bootstrap, SDK transport, actual provider registry owners, or crash termination. Test success confirms the asserted behavior, including undesirable behavior; it is not activation acceptance.

| Test | Observed result and design consequence |
|---|---|
| A1 | `get()` returns the supplied resolved/defaulted values, not raw-file presence. The fixture does not independently prove every production default. Exact absent-field restoration cannot be inferred from these values. |
| A2 | `mcp.enabled` patch is ignored; `injectIntoAgents` persists. Keep the enablement prerequisite. |
| A3–A4 | A stale whole-array profile patch overwrites an intervening file edit or another actor's patch. A successful post-read matches the writer's result but cannot reveal the lost edit. |
| A5 | An external provider addition can remain on disk while absent from the store's current state after an unrelated patch. Disk and memory are separate evidence surfaces. |
| A6–A7 | Unknown provider-entry fields can be stripped during persistence, including on an unrelated save; an unknown patched field can appear in `get()` without reaching disk. Arbitrary raw-field preservation is not guaranteed. |
| A8 | Provider updates merge existing fields. Removing and adding the same provider ID in one patch leaves it present on disk but absent in memory. Do not use that pattern as an atomic replacement. |
| A9 | `removeProviders` also removes matching entries from `metadataGeneration.providers`. Deactivation must account for these references rather than treating removal as an isolated provider-map edit. |
| A10 | An unknown top-level persisted field rejects a later patch under the strict schema. This is a schema-compatibility failure, not permission to rewrite the user's config. |
| A11 | Store reload with the test resolver reconciles file/memory differences and applies file-side `mcp.enabled`. It does not authorize or validate a live daemon reload. |
| A12 | An injected `onApply` exception restores the file. Actual process death between persistence and apply/receipt writing was not tested. |

Primary source: `$CLI_ROOT/node_modules/@getpaseo/server/dist/server/server/daemon-config-store.js`, lines 10–23, 153–203, 205–261, 310–360 and 393–470. The local test's cases are at lines 62–211.

### Stronger activation requirements

- **A plugin-local lock plus read/merge/patch/post-read is not sufficient for strict concurrent preservation.** Other clients and direct file writers do not participate in that lock. Require an explicitly accepted exclusive administrative-edit procedure, or an upstream atomic per-entry/CAS API; do not promise lossless concurrency on 0.8.0.
- Define whether deactivation restores effective behavior or exact original field presence. The existing strict receipt contract cannot silently be weakened because the mutable API returns resolved values.
- Inspect dependencies such as metadata-generation references before provider removal. Refuse conflicting unowned dependencies rather than silently changing them.
- Persist a recoverable operation intent before mutating config, and reconcile actual state after interruption or lost replies. This is a required design, not an implemented journal.
- Plugin RPC timeout is 30 seconds and does not cancel an ordinary RPC handler. `plugins/runtime.js:15,342–362` sends cancellation only for hooks; `plugins/plugin-process.js:375–392` continues the RPC promise. An error shown in the UI does not prove activation had no side effects; retries must be idempotent and state-aware.
- Keep raw plugin removal semantics option-specific. For A, leaving a verified, correctly roled stable runtime operational is the stated manager-only behavior; for B2, future session opens must fail closed without the hook. The earlier universal fail-closed wording in S5 step 5 must be interpreted according to the selected lifecycle contract, not imposed on A while promising continued operation.

These results strengthen the conditions on Option A; they do not pass S1/S2/S5 or finish the specialist's active-session/rebind analysis. Full preservation under arbitrary simultaneous external edits remains a blocker unless the host API or accepted requirements change.

## Option A synthesis: activation transaction findings

The recovered High-agent synthesis (`.local-checks/plugin-followup-a-findings.md`, 93 lines) completes the config-store analysis beyond the 12 test cases:

- **The SDK config path is strictly weaker than the current installer on concurrency.** The file-path installer rechecks the file's exact bytes immediately before an atomic rename (`plugin/server/runtime/cli/host-config.ts:26–28`) — optimistic stale-input detection, not a kernel-level compare-and-swap (an external write between compare and rename still loses); `config.patch` has no revision/expected-base field at all (`messages.d.ts:154–213`), so the plugin path loses the only staleness check the current package relies on.
- **Active-session continuity on config rebind is source-proven.** `config.patch` → `mutable-provider-config-owner.onApply` rebuilds clients/catalog and swaps registry maps, but `closeAgent` runs only for `retiredProviders`, which are produced solely by plugin-provider replacement (`agent-manager.js:319–342`; `provider-snapshot-manager.js:172–188,322–400`). Config-driven rebind/remove does not close running agents; stale clients stay owned until daemon shutdown, and catalog warm-up re-runs immediately on the new command. The remaining live-only question is end-to-end session behavior through a real cutover (S2), not process survival.
- **Collision refusal alone cannot recover partial activation.** A plugin/daemon crash between a successful patch and receipt write leaves SLP entries without a receipt; a naive re-activate then refuses on presence. Activation must adopt byte-identical owned entries (per persisted schema) instead of refusing, and write a per-daemon-home receipt sidecar — receipts cannot live inside the immutable `<store>/<sha>/` candidate (one shared runtime serves N homes) nor inside `plugin-settings/<id>` (deleted on remove).
- **Restore semantics are approximate, not byte-exact.** Patches cannot express "absent": `injectIntoAgents:false` is semantically equal to absent but persists an explicit `false`; `mcp.enabled` is unpatchable and may be unfixable without restart when CLI/env overrides control it (`daemon-config-store.js:276–291`). Provider sub-field removal needs either a verified maintenance flow (same-patch remove+add cleans the file but drops the live provider until a second patch/reload re-materializes it) or explicit rejection — it is not an atomic replace.
- **Under Option A, raw plugin removal is fail-operable, not fail-closed.** Leftover providers keep launching correctly roled agents because the transport is self-contained; the real defect is orphaned ownership (no manager for verified deactivate/restore). Reinstalling the same plugin ID must adopt identical entries to recover. This matches the corrected S5 wording and must be documented as accepted behavior.

This synthesis keeps Option A **CONDITIONAL**: the remaining blockers are accepted concurrency limits (exclusive administrative-edit window or upstream CAS), idempotent recovery design, and the S1/S2/S5/S6/S7/S8 live gates — not any single missing primitive.

## B2 follow-up: corrected grant discriminator (offline, 33/33)

The Max-agent continuation (`.local-checks/plugin-followup-b2-findings.md`, 119 lines; suite `.local-checks/plugin-followup-b2.test.mjs` → **33 pass / 0 fail / 0 skip**, independently rerun) corrects the discriminator used in the earlier sketch:

- **`PASEO_AGENT_ID` is not a trustworthy open/discovery discriminator.** `RUNTIME_CONTROL_ENV_KEYS` (`server/paseo-env.js:3–10`) does not strip it; every provider child inherits `process.env` (`utils/spawn.js:19–29`), so a daemon launched inside an agent session leaks a stale `PASEO_AGENT_ID` into catalog/draft spawns and would mis-classify them as opens. Executable tests on the installed 0.8.0 env builders prove it survives sanitization. It is demoted to an optional supplemental binding checked only when the grant carries an `agent` field.
- **Correct discriminator: a dedicated `SLP_SESSION_OPEN_GRANT`.** Provider runtime `env` sets `SLP_SESSION_OPEN_GRANT:""` for every spawn (schema `z.record(z.string(),z.string())` accepts empty); the `session_open` overlay writes the real grant and wins (`provider-launch-config.js:127–143`). Sentinel coverage is NOT universal: it reaches spawn paths built with `createProviderEnvSpec({runtimeSettings})`, but the Codex `argv[0] --version` probe calls `createProviderEnvSpec()` with no runtime settings (`diagnostic-utils.js:108–120`), so a stale inherited grant can still reach that probe — the shim must therefore handle `--version` safely in every grant state (self-probe the real binary), not rely on the sentinel. Bootstrap state machine: unset/empty → discovery allowlist; nonempty+valid → role; nonempty+malformed/tampered → hard fail. Instruction methods are denied in discovery mode, so a grantless open (disabled/crash/reload gap) fails closed at the first instruction frame without breaking discovery — no need to classify spawn purpose up front.
- **No-env spawn surfaces are now enumerated per family.** Codex has the widest set (catalog, importable list, both draft fallbacks, archive/restore sync where restore hard-fails if `thread/archive`/`unarchive` are denied, and the `argv[0] --version` probe which mis-parses Node as codex ≥0.128 → goals/auto-review gates must be handled by bootstrap self-probing the real binary). Pi: real `--mode rpc` catalog + draft-commands fallback (`listFeatures` returns `[]` client-side; importable list is filesystem-only). ACP: catalog probe performs `session/new`; `listFeatures` probes `session/new` only when `configFeatureOptions` is non-empty — the generic `slp-devin-*` registration supplies none, so it returns early without spawning (`acp-agent.js:572–576`); `session/load` must be allowed for import preview while `session/prompt` is denied.
- **Source-derived allowlists** for the three original families are recorded in `.local-checks/plugin-followup-b2/allowlists.json` — built by source regex extraction plus the fixture classifier, NOT measured on live wire traffic. Known defects already: the ACP list holds the JavaScript name `unstable_closeSession` whose wire method is `session/close` (`acp.js:546–547`), and the Pi fixture reads JSON-RPC `method` where Pi commands actually discriminate on `type`. The fixture proves the state-machine shape, not allowlist completeness — real method matrices still need live enumeration (S4).
- **`node -e` is ruled out as the bootstrap mechanism.** `resolveBinaryVersion` executes `argv[0] --version` with all args dropped (`diagnostic-utils.js:108–120`; Codex callers `codex-app-server-agent.js:5547–5578`), so an inline script can never answer the version probe — it measures the Node runtime instead. The bootstrap must be a real executable shim at a stable path (POSIX shebang + `chmod`; `.cmd` on Windows). Note this mis-parse is **pre-existing in the current package**: today's provider command is `[process.execPath, bin/{family}-role.mjs, role]`, so Codex version probes already measure Node on every install; the shim fixes that bug rather than working around it, and is promoted to a v1 requirement for Option A as well.
- **Executable resolution is a separate v1 blocker.** Provider commands written by the plugin subprocess must not embed its `process.execPath`: on an Electron-packaged daemon it resolves to the Electron binary while `ELECTRON_RUN_AS_NODE` is stripped from child environments (`paseo-env.js:3–24`). Resolve a stable Node path or use the shim.
- **All families remain CONDITIONAL/LIVE-SPIKE.** Residual gates: reload-gap block-at-prompt, daemon-in-agent-env regression, Codex version/goals handling, per-family draft coverage, ACP `session/load` boundary, grant tamper, disable/remove fail-closed, and the 30 s hook budget with abort-aware resolve.

## Current-HEAD delta audit (a75c4db → ee8c2a7)

A bounded delta audit (`.local-checks/plugin-current-head-delta-findings.md`, 333 lines) re-measured the package after HEAD moved: candidate `3ac1192b…` / **35 files** (was `d1c54ddc…` / 31), **twelve** providers `slp-{codex,pi,devin,claude}-{supervisor,lead,peer}` (was nine), new helpers `materialize`/`monitor`/`notebook`, renamed `workspace-protocol.md`, E2E manifest 41 → **48 scenarios** (`resume-{role}-{provider}` 9 → 12; onboarding now covers `{project,global}×{codex,pi,claude}`). Local suite `node --test tests/*.test.mjs` → 133/133 pass.

Claude wire behavior, source-verified on installed 0.8.0:

- `agent.create.config.systemPrompt` composes into the Agent SDK `systemPrompt:{preset:"claude_code",append}` (`claude/agent.js:2588–2637`); under SDK 0.3.246 the wire request carries it as top-level `request.appendSystemPrompt`, and `claudeRolePrompt` already appends to that field (`plugin/server/runtime/cli/role-transport.ts:29–46`; the `systemPrompt.append` branch is defensive compatibility). This is the cleanest native systemPrompt mapping of the four families for a future B0 simplification; import of native `~/.claude/projects` sessions stays unroled because metadata lacks `systemPrompt`.
- `session_open` env reaches the Claude process for all four open reasons (`query.js:39–48` overlays `launchEnv`; the `buildSelfNodeCommand` path still merges the provider env, `paseo-env.js:36–49`). `createProviderEnvSpec` force-deletes `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_AGENT_SDK_VERSION` (`provider-launch-config.js:121–135`) — grant keys must stay in the `SLP_*` namespace.
- Claude's catalog is the cleanest of the four: `fetchCatalog` runs a `--version` exec plus file/env reads and spawns no session (`agent.js:1108–1123`); `listImportableSessions` is filesystem-only; client `listFeatures` is local. The one no-env spawn surface is `listDraftCommands` → session-level `listCommands` (`agent.js:2171`) which spawns a real stream-json session without launch env. Admin probes (`--version`, `auth status`) carry `launch.args`, so they pass through the current wrapper to the real binary — Claude has no Codex-style version-mask problem.
- B2 instruction boundary for Claude is a single frame type: deny `type:"user"` frames in discovery mode; allow `control_request`/`control_response` initialize traffic. Admin probes (`--version`, `auth status`) DO carry provider `env` including `SLP_CLAUDE_BIN` (`claude/agent.js:1234–1239` passes `runtimeSettings`) — unlike the Codex version probe which receives none — so only the session-open overlay is absent there. Claude is the lowest-residual B2 family, but consistent with the conservative policy it remains CONDITIONAL until its live gates run — no family gets an unconditional GO without live evidence.

New fail-open surfaces recorded:

- `bin/claude-role.mjs` detection requires both `--input-format stream-json` and `--output-format stream-json` in either flag style; a third arg style would silently degrade to unroled passthrough under an `slp-claude-*` provider — an accepted risk pinned to SDK 0.3.246 arg emission, to be guarded or explicitly accepted.
- `SLP_CLAUDE_BIN` is a new trust-boundary input redirecting the wrapped binary; provider `env`/hook env can set it, so receipts/design must acknowledge it.

Option A impact: unchanged design, larger scope — `configurationPlan` emits 12 entries automatically; admin probes pass through the Claude wrapper without special-casing; `claude` binary on PATH (or `SLP_CLAUDE_BIN`) is a new host prerequisite; `monitor`/`notebook` raise the weight of the missing daemon-home locator because both read `<home>/agents/*`.

## Architecture adjudication (independent committee memo)

A SWE-2 Max committee agent reviewed all evidence on HEAD `ee8c2a7` and adjudicated the implementation question (full memo in agent history; its claims were spot-verified above). Decision: **Option A first — shippable with explicit operational constraints; not blocked by the missing upstream CAS.** B2 remains experimental/live-spike; B0/B1 stay NO-GO.

Requirements that may be weakened operationally (must be written into the contract):

- **Concurrent-edit preservation → documented limitation.** Serialize plugin operations, require an exclusive administrative window, post-read verify, and adopt-if-identical on retry. Do not claim strict preservation.
- **Byte-exact restoration → semantic restoration.** `injectIntoAgents:false` is semantically equal to absent (`config.js:338`); patches cannot express key deletion. Receipts must record pre-patch field presence, which `config.get()` cannot observe (resolved values hide absent-vs-default) — recording original presence needs a verified raw-config read; an API-only receipt records effective values and marks original presence unknown. Deactivate restores semantics.
- **Raw plugin remove → accept "orphaned-but-roled".** Leftover transports still inject policy (fail-closed on their own bytes); the defect is orphaned ownership, not unroled launches. Deactivate-before-remove is an operational convention.

Invariants that may not be weakened:

- no SLP launch may run unroled;
- exact policy bytes with hash-bound evidence (`installed.json` + receipt);
- active sessions are not broken by rebind (`provider-snapshot-manager.js:336–377` keeps runtime; runtime dirs are immutable side-by-side);
- collisions adopt only byte-identical entries under the **persisted** schema — `get()` returns resolved `this.current` and does NOT strip unknown keys (a patched loose field appears in `get()` yet is dropped on persist, `daemon-config-store.js:182–203,221–223`); normalized post-read equality does not prove persisted equality;
- `daemon.mcp.enabled` resolved `=== true` is a precondition (unpatchable — not a mutable field);
- provider commands never point into the managed plugin checkout (update deletes the old directory, `plugins/index.js:468–512`).

Minimal v1 architecture:

- Git-managed plugin (`npm` unsupported on this 0.8.0 CLI), `requirements.paseo = ">=0.8.0 <0.9.0"`.
- Server bundle embeds the path+sha256+bytes payload (spike mechanism proven on the 35-file candidate).
- RPCs `activate`/`reconcile`/`deactivate`/`status` — idempotent, in-plugin mutex, adopt-if-byte-identical, start+poll status (invoke RPCs are not enqueued and 30 s timeout does not cancel them).
- State machine: `INACTIVE → ACTIVATING (materialize → mcp.enabled preflight → collision check → patch → persisted-shape verify → receipt) → ACTIVE → DEACTIVATING → INACTIVE`; any interruption routes to `RECOVERY_REQUIRED` reconcile.
- Receipts are per-daemon-home sidecars outside the immutable `<store>/<sha>/` candidate and outside `plugin-settings/<id>` (deleted on remove).
- **Executable resolution is a v1 blocker to decide before implementation** (Electron `process.execPath`; `ELECTRON_RUN_AS_NODE` is stripped from child env).
- Two config-write strategies: **A1** `config.patch` (default, constraints above); **A2** file-write through `plugin/server/runtime/cli/host-config.ts` (optimistic byte-compare + atomic rename, `host-config.mjs:24–35`) + `paseo reload` — preserves today's exact-restoration contract but needs a verified daemon home and CLI reachability on the daemon host. `persistConfig` re-reads the file on every patch, which preserves some unrelated persisted changes, but live state derives from `this.current` (`daemon-config-store.js:237–248` vs `393–404`) — mixed file/API strategies are NOT automatically consistent and still require coordinated reload, serialization, and verification.

B2 stays experimental because: its fixture is a 54-line verdict classifier, not a real proxy (blocked requests would hang the client — no JSON-RPC error synthesis); allowlists are source-estimated, not wire-measured; the grant/sentinel design is source-verified but unproven on real provider spawns; and `node -e` is dead (argv[0]-only version probe) — an executable shim is required, which also repairs the pre-existing Codex version mis-parse in today's package.

Committee-debunked claims now corrected in this document:

| Earlier claim | Adjudication |
|---|---|
| `PASEO_AGENT_ID` as discriminator | Rejected — not sanitized (`paseo-env.js:3–10`) |
| `_paseo` systemPrompt metadata for ACP | Does not exist on this build — ACP drops `systemPrompt` entirely |
| B0 works only for Codex/Pi | Understated — Codex, Pi AND Claude all accept `systemPrompt` natively (Claude via SDK preset append); the sole hard blocker is generic ACP/Devin |
| Discovery-only bootstrap never creates a session | Infeasible — ACP catalog performs real `session/new` |
| `node -e` bootstrap | Dead — argv[0]-only version probe; Windows shell semantics |
| 31-file roundtrip evidence | Stale — rerun on the 35-file candidate (done: `run-2DnucI`, 11/11) |
| Codex version mis-parse is a B2 problem | Pre-existing package bug; the shim is a v1 requirement for Option A too |

Host-gap ledger for upstream asks: config patch revision/CAS field; plugin-reachable `daemon.config.reload`; daemon-home locator in SDK; pre-remove/cleanup reason; `mcp.enabled` patch support.

## Research status checkpoint (HEAD ee8c2a7→d30dacb→0f7ccde when this doc was committed; candidate `3ac1192b…` unchanged across all three)

- Candidate bundle/compiler: independently verified 11/11 offline tests on the current 35-file candidate (`3ac1192b…`); evidence recorded above.
- Helpers: source paths independently checked, including the delta helpers `materialize`/`monitor`/`notebook`; no live helper/E2E qualification.
- Option A: 12/12 config-store tests verified plus completed synthesis (`.local-checks/plugin-followup-a-findings.md`): adopt-if-identical activation, per-home receipt sidecars, source-proven active-session continuity on config rebind, approximate restore semantics, fail-operable raw remove. Verdict: **CONDITIONAL → shippable with documented operational constraints** (committee adjudication above); live gates S1/S2/S5–S8 still required.
- B2: corrected grant design verified (`.local-checks/plugin-followup-b2-findings.md`, 33/33 local tests, reproduced on this host): dedicated `SLP_SESSION_OPEN_GRANT` sentinel+overlay replaces the unsafe `PASEO_AGENT_ID` discriminator; per-family no-env surfaces enumerated; allowlists are source-derived with known defects (`session/close` wire name; Pi `type` discriminator) pending live enumeration; `node -e` ruled out → executable shim. Verdict: **CONDITIONAL/LIVE-SPIKE, experimental only** for all four families (Claude lowest residual).
- Current-HEAD delta: Claude added as fourth family; B0 native systemPrompt mapping cleanest for Claude; no new Option A blocker.
- Committee adjudication: Option A shippable with explicit constraints (not CAS-blocked); v1 blockers to decide before implementation: executable-shim design and Node-executable resolution; host-gap ledger recorded for upstream asks.
- Remaining work before any implementation: design freeze on executable shim + Node resolution + receipt sidecar + adopt-if-identical + persisted-shape verify; contract wording update (semantic restoration, CAS/concurrency limitation, raw-remove semantics, stable-runtime ownership — the twelve-provider count already landed at `docs/contract.md:49–52`, but its routing-catalog claim at `:67–68` contradicts `scaffoldUserCatalog` and must be reconciled); then run authorized live gates S1–S8 on an isolated daemon (`pluginsEnabled` is `false` on this host — separate authorization required); keep `docs/` (English) and `.local-checks/` (Vietnamese) synchronized.
