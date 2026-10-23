# Settings-driven providers and policy delivery

This spec owns provider generation, role injection and the profile editor's
technical contract. [Operations](../operations.md#agent-profiles) owns the
user procedure; [architecture](../architecture.md#two-lifecycles) explains the
lifecycle boundary. Historical probes qualify only their measured candidate,
not current live acceptance; see [development](../development.md).

## Family registry

`plugin/shared/runtime/families.ts` owns family IDs, labels, transport,
`binEnv`, executable name, `extends`, optional registration/session-grant flags
and picker rank. It has no imports
and ships in the CLI install unit and both host bundles. Derived lists,
schemas and provider IDs use that registry. Declaration order and picker
order are separate contracts.

| Family | Policy transport | Base provider | Managed session grant |
|---|---|---|---|
| Codex | Create hook + sentinel gate | `codex` | Required |
| Pi | Create hook + sentinel gate | `pi` | Required |
| Claude Code | Create hook + sentinel gate | `claude` | Required |
| Devin | Shim + ACP wrapper | `acp` | Wrapper verification |
| OpenCode | Shim + ACP wrapper | `acp` | Required before ACP child start |
| Antigravity | Create hook + sentinel gate | Registered `slp-antigravity-*` | Required |

Antigravity uses registered native providers and `agy` stream-json. Their
owned configuration omits `extends`; registrations reject their inert default
command before discovery or connection.
The adapter is maintained in the plugin, using public SDK interfaces.
See [Antigravity support](../antigravity.md) for MCP and evidence limits.

OpenCode's native transport is unsupported; version and proof limits belong
to [OpenCode support](../opencode.md). Adding a family requires a registry
entry, executable recognition, payload bootstrap handling and tests. The shim
also validates its bootstrap family/role domain before importing TypeScript;
keep that independent validation current. Persisted-domain expansion requires
historical hash, ownership and CAS compatibility review. Registry derivation
never authorizes rewriting retained records.

## Provider generation

Activation projects saved Supervisor/Lead routing into owned provider entries
and exactly two saved profiles. It includes each family's Peer provider. Without
saved routing it emits each family/role combination. Peers use the pool,
independently of the orchestrator's runtime. Generated labels use
`SLP <Family> <Role>` from registry labels.

Configuration planning, journal identity, recovery and semantic restoration
belong to `config-view.ts`, `config-transaction.ts`, `journal.ts` and
`manager.ts`. `profiles` and `initialProfileFamily` RPC inputs remain supported
for scripted use. Opening or reloading the UI never activates anything.

## Create hook and session-open grant

`role-injection.ts` resolves an owned hook-family role, verifies the active
binding's immutable published candidate, imports that candidate's
`role-bundle` module and prepends its output to `config.systemPrompt`.
A pre-existing prompt follows the role bundle; provider identity is unchanged.
Foreign providers pass through. An unresolved owned role, binding or candidate
fails closed. ACP families keep role delivery at the wrapper boundary.

Candidate verification and module imports are cached by candidate identity
within the plugin process. Failed verification is evicted so a repaired
candidate can be checked again. Imports use verified retained runtime paths,
never the managed plugin checkout. Retained module layouts are selected from
those candidates' receipts, with no fallback after an import failure.

`agent.session_open` supplies a nonempty `SLP_SESSION_OPEN_GRANT` for every
managed grant-bearing open reason, including resume, refresh and import.
Hook aliases keep an empty grant sentinel in provider env. Their generated
single-argv0 gate launcher freezes the verified Node and family binary paths.
The gate requires the live grant for a real session marked by
`PASEO_AGENT_ID`, strips the grant and forwards to the family binary.
Capability/model probes outside a session remain available, and bare
`--version` probes reach the real family binary in every grant state.

The single executable matters: host availability probes can discard both the
command tail and provider env. `[node, gate]` would probe Node's version;
an env-dependent launcher would not resolve its binary. Launchers clear
`NODE_OPTIONS` before Node starts, in addition to child runtime sanitization.

Launch sets publish eighteen files: twelve hook gates and six ACP shim
dispatchers. Manifests pin `launcherFamilies` and `gateFamilies` so verification
reconstructs the correct bytes. Retained manifests without these fields use
their historical all-shim plan and exact domain.

Hook and wrapper rendering share `roleBundle()` and byte-parity tests.
ACP delivery reasserts the verified role core on every `session/prompt`;
entry/re-arm also supplies helpers and policy locators. Managed language is
read on each prompt; non-ENOENT errors propagate. Role recovery does not
restore task context or ownership. Transport tests prove bytes, while real
compaction resilience needs live provider evidence.

## Catalog and profile editor

`provider-catalog.ts` prefers the managed role's snapshot entry, then the base
family. A snapshot-capable host with neither entry reports an error. Loading
entries use the resolved provider's listings to await warmup; ready snapshot
modes avoid a separate modes call. Features use the resolved provider/model.
Only a confirmed absent snapshot API latches legacy discovery for the plugin
process; other failures may retry. Models filter `isSelectable === false` and
retain host thinking/default metadata. Cache keys include family, role, model
and mode as applicable. Public prefix filtering and Devin constraints are
documented in [CLI discovery](../cli.md#provider-model-discovery-plugin-rpc).

One Role profiles card edits both complete choices with one Save operation.
The gate compares the same built choices Save sends; absent and an explicit
empty feature map remain distinct. Save needs a fresh bound target and a
different choice. Unbound fields remain editable drafts, while Save explains
the activation prerequisite. Scripted pre-binding writes remain supported.
One divergence warning compares saved choices with live profiles. The shell
chains activation only after a successful same-target save under the required
administrative acknowledgments; failure preserves saved choices for recovery.

Thinking controls use the selected model's declared options and default.
A resolved model with zero options has no thinking control and clears a stale
thinking choice. Unknown stored choices remain visible when options exist;
an unresolved model uses free text. Feature controls override the raw JSON
base, preserve undeclared keys and omit an explicitly emptied control.

An explicit family change revalidates model, mode and then thinking against
the new catalog, clears features and never auto-picks replacements. Re-selecting
the same family still clears features. An unavailable catalog clears dependent
choices without delayed prefill. Model/mode changes clear feature values.
Stored prefill does not trigger these user-edit rules or overwrite dirty drafts.
Antigravity has no independent thinking option: its model ID selects effort.
The role form omits that control even without a catalog. Rebinding to this
family clears an inherited `thinkingOptionId` when routing or an explicit
family preference does not supply one; other omitted profile fields retain
their existing preservation semantics. An explicitly supplied unsupported
thinking option remains an adapter validation error.

## Unresolved lifecycle questions

The following questions remain open; this cleanup supplies no new product
decision or acceptance evidence:

- A host spawn path that bypasses the create hook and sentinel could persist
  a seat without role bytes. Session-open grants alone cannot establish that
  its durable context contains those bytes. Detection/recovery needs an
  explicit decision and evidence before it can be claimed supported.
- Gate verification is transitive on the ordinary create-hook path. A launch
  outside that path does not establish the same verification. Independent
  per-launch verification was deferred because of spawn cost and host-tool
  availability; it remains unresolved.

Mixed alias/shim planning and recovery must retain exact manifest and receipt
semantics. The unresolved bypass questions do not authorize installing guards,
changing role behavior or claiming resume/refresh coverage from local tests.
