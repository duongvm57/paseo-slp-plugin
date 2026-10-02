# Paseo SLP plugin implementation specification — Option A v1

Status: implementation design freeze, 2026-09-18. This specifies the manager/installer plugin accepted in the corrected working-tree [feasibility audit](paseo-plugin-feasibility.md). It is not a live acceptance report or authority to install, change a daemon, create agents, commit, or release.

## 1. Scope, sources, and invariants

**DECISION: A1 only.** Implement Git distribution, explicit management RPCs, immutable runtimes, and the existing four role transports using `config.patch`; do not implement A2 file writes, B0/B1 providers, or B2 hooks. Rationale: this is the accepted lowest-change architecture, with the executable-shim correction promoted into v1. Sources: [audit](paseo-plugin-feasibility.md):674–695,716–749; `plugin/server/runtime/cli/paseo-install.ts:30–46`; `plugin/server/runtime/cli/binding.ts:10–18`.

The following citation prefixes identify the installed **0.8.0** sources examined for this spec. They are evidence paths, never production import paths. Line numbers refer to the installed JavaScript/type declarations, not upstream TypeScript.

| Prefix | Absolute location |
|---|---|
| `N` | `/home/duongvm/.local/share/fnm/node-versions/v24.14.0/installation/lib/node_modules/@getpaseo/cli/node_modules` |
| `S` | `N/@getpaseo/server/dist/server/server` |
| `U` | `N/@getpaseo/server/dist/server/utils` |
| `SDK` | `N/@getpaseo/plugin/dist` |
| `API` | `N/@getpaseo/client/dist` |
| `P` | `N/@getpaseo/protocol/dist` |

Repository citations are relative to this repository. The source snapshot inspected for this spec is HEAD `c98db2aa9e21d121093dced554da338dbcc90781` plus the existing corrections in `docs/paseo-plugin-feasibility.md`. The audit's baseline runtime identity is `3ac1192b12099d98ce49e5aeab1ccbfa8b6dd03965120e3432a9448ba18a1e64`, containing 35 files. The implementation will change runtime bytes and therefore must generate a **new** identity and file count; 35 is not an acceptance constant.

**DECISION: preserve SLP's behavioral contract.** Maintain 12 providers (four families × Supervisor/Lead/Peer), exactly two saved profiles, independent policy injection, complete launch bindings, and authority boundaries. Rationale: packaging must not change role semantics or turn plugin RPCs into agent tools. Sources: `docs/contract.md:44–85`; `plugin/server/runtime/cli/profiles.ts`; `plugin/server/runtime/cli/binding.ts:10–18,31–49`; `plugin/server/runtime/cli/role-bundle.ts:10–29`; [audit](paseo-plugin-feasibility.md):636–638,726–735.

Mandatory invariants:

- Every SLP session reaches its existing role transport with verified candidate bytes. Missing or altered bytes stop the launch before forwarding instruction-bearing input.
- Provider/helper paths refer to retained stable files, never a managed plugin checkout.
- An update affects future launches; neither update nor deactivate terminates existing sessions or deletes their runtime/launcher directories.
- No provider is adopted based on labels, `config.get()` normalization, or a claimed SHA alone.
- `mcp.enabled === true` in the selected connection's effective config is required. The plugin does not attempt to patch that field.
- Live gates remain separate from unit, fixture, compiler, and source-inspection evidence.

## 2. Plugin skeleton and the actual SDK boundary

**DECISION: use a `plugin/` Git subdirectory with this manifest.** Rationale: 0.8.0 reads `paseo-plugin.json`, permits a Git `pluginPath`, and rejects extra manifest properties. Sources: `S/plugins/manifest.js:6–24`; `S/plugins/managed-source.js:36–60,207–222`; `P/messages.js:104–106`; `P/plugin-requirements.js:4–24`; [audit](paseo-plugin-feasibility.md):737–749.

`plugin/paseo-plugin.json`:

```json
{
  "id": "paseo-slp",
  "requirements": { "paseo": ">=0.8.0 <0.9.0" }
}
```

There is no `plugin.json`, manifest `version`, `main`, `server`, `permissions`, or declarative skill entry. The installed manifest validator is equivalent to:

```ts
z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  requirements: z.object({ paseo: z.string().optional() }).strict().optional(),
  build: z.array(z.array(z.string().refine(s => s.trim().length > 0)).min(1))
    .min(1).optional(),
}).strict();
```

`requirements.paseo` additionally undergoes npm-semver validation. The range follows the accepted audit; evidence here qualifies 0.8.0, not every future 0.8.x release. Install from the authorized repository Git URL/ref with `pluginPath: "plugin"`. Do not invent an npm installation flow.

**DECISION: commit generated payload source; omit installation-time build commands.** Rationale: server evaluation has no public checkout-directory handle, and the compiler accepts runtime code only in its designated directories. Sources: `S/plugins/compiler.js:51–68,310–352`; `S/plugins/plugin-process.js:193–213`; `plugin/server/runtime/cli/package.ts:17–28`; [audit](paseo-plugin-feasibility.md):556–595.

Planned source layout:

```text
plugin/
  paseo-plugin.json
  index.server.ts
  index.client.tsx
  shared/contracts.ts
  server/manager.ts
  server/config-view.ts
  server/config-transaction.ts
  server/journal.ts
  server/materializer.ts
  server/launchers.ts
  server/executables.ts
  server/generated/runtime-payload.ts
  client/SettingsScreen.tsx
scripts/generate-plugin-payload.mjs
bin/slp-shim.mjs
tests/plugin-*.test.mjs
```

The generator runs during development/release preparation against the install unit, not from the evaluated server. It writes only the generated module. CI must regenerate in memory and compare bytes so stale payloads fail. Do not import `../src/*.mjs` across the plugin boundary. Bundle production server dependencies or use SDK-provided externals; no absolute imports from this host's installation. Pin development SDK/protocol dependencies to 0.8.0 and validate against the installed Zod 4 API. Package version changes remain release-please's responsibility.

**DECISION: contributions are synchronous registration functions returning cleanup.** Rationale: the actual loader rejects a Promise or missing cleanup; the connected API arrives in handlers, not in `contribute`. Sources: `SDK/server/contracts.d.ts:7–15`; `SDK/contracts.d.ts` (`PluginCleanup`); `S/plugins/plugin-process.js:193–213,375–392`; `SDK/client/contracts.d.ts:60–87`.

Server entry, with the four contracts and manager supplied by later sections:

```ts
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { activate, reconcile, deactivate, status } from "./shared/contracts";
import { createManager } from "./server/manager";

const contribute: PluginServerContribution = server => {
  const manager = createManager();
  server.handle(activate, (input, { paseo }) => manager.activate(input, paseo));
  server.handle(reconcile, (input, { paseo }) => manager.reconcile(input, paseo));
  server.handle(deactivate, (input, { paseo }) => manager.deactivate(input, paseo));
  server.handle(status, (input, { paseo }) => manager.status(input, paseo));
  return () => manager.close();
};
export default contribute;
```

`manager.close()` stops accepting work and closes its own resources. It neither deactivates SLP nor removes files. Shutdown can interrupt an operation; recovery is journal-driven.

Available surfaces, with distinctions implementers must preserve:

| Surface | Actual contract / v1 use |
|---|---|
| Shared RPC | Public root export `defineRpc({ name, input, output })`. Public client `useRpc(contract)` calls the internal `callPluginRpc(contract, invoke, input)`, which parses both sides; do not import that helper as a public root export. The bridge's `invoke` is `(method: string, input: unknown) => Promise<unknown>`, scoped to the selected plugin/host. `SDK/index.d.ts:4`; `SDK/rpc.d.ts:1–15`; `SDK/rpc.js:1–11`; `SDK/client/rpc-context.js:8–16`. |
| Client | Register one `addSurface("manager", Component)` plus `addSidebarItem` and `addCommandCenterItem` entries that open it; return their cleanups. Components receive `host.id`/`host.label`, not a daemon filesystem path. Use `useRpc(contract)` from `@getpaseo/plugin/client`; plain `react-native` primitives are host externals for surfaces. `SDK/client/contracts.d.ts:8–18,60–130`; `SDK/client/rpc-context.d.ts:5–12`. |
| Server handler | `handle(contract, (parsedInput, { paseo }) => output)`; SDK validates output. No caller identity or cancellation signal is declared here. `SDK/server/contracts.d.ts:7–15`; `S/plugins/plugin-process.js:384–392`. |
| Connected config | `await paseo.config.get()` and `await paseo.config.patch(patch)` each return `{requestId, config}`. Read `.config`, not the envelope. `API/index.d.ts:340–360`. |
| Other connected APIs | `terminals`, `workspaces`, `projects`, `agents`, `providers`, `config`; no public daemon-home resolver, reload, or general plugin-invoke method on `PaseoApi`. `API/index.d.ts:362–369`. |
| Lifecycle hooks, available but unused in v1 | `server.on(name,(event,{paseo,signal})=>...)`; `server.before(name,({request},{paseo,signal})=>requestOrVoid)`, both return unsubscribe functions. `SDK/server/lifecycle.d.ts:4–7,23–31,78–90`. |
| Settings / providers, available but unused in v1 | `registerSettings(definition):void`, `registerProvider(registration):void`. Neither is a manager receipt store. `SDK/server/contracts.d.ts:10–13`. |

The underlying invoke wire request contains `type: "plugin.rpc.invoke.request"`, `requestId`, `pluginId`, `method`, and `input` (`P/messages.js:1258–1264`). That envelope is not the input schema of our four contracts.

## 3. Management RPCs and operation scheduling

**DECISION: expose exactly four versioned-schema RPCs named `activate`, `reconcile`, `deactivate`, and `status`.** Rationale: bounded start responses plus polling survive the non-canceling 30-second invoke timeout. Sources: `S/plugins/runtime.js:15,342–362`; `S/plugins/plugin-process.js:375–392`; [audit](paseo-plugin-feasibility.md):739–744.

The following Zod definitions are normative. The package exports all four contracts from `plugin/shared/contracts.ts`. They introduce SLP schemas; they do not claim to be pre-existing Paseo methods. All path fields are daemon-local. `AbsolutePath` accepts POSIX paths or Windows drive/UNC forms at the wire boundary; server validation then uses the daemon's platform and `realpath`, rejects NUL, and rejects a nonexistent home. Windows activation is separately gated in §6. `initialProfileFamily` applies only to a new binding; supplying it to change existing profile preferences is `INVALID_REQUEST` (edit profiles through `profiles` on `activate`, or the host profile workflow followed by reconcile).

```ts
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

export const Sha = z.string().regex(/^[0-9a-f]{64}$/);
export const Time = z.string().datetime({ offset: true });
export const Id = z.string().uuid();
export const Family = z.enum(["codex", "pi", "devin", "claude"]);
export const AbsolutePath = z.string().min(1).max(4096)
  .refine(s => !s.includes("\0") && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(s));
export const Target = z.object({
  hostId: z.string().min(1).max(256),
  daemonHome: AbsolutePath,
}).strict();
export const Authority = z.object({
  exclusiveAdministrativeWindow: z.literal(true),
  verifiedHostHomeMapping: z.literal(true),
}).strict();
export const State = z.enum([
  "INACTIVE", "ACTIVATING", "ACTIVE", "DEACTIVATING", "RECOVERY_REQUIRED",
]);
export const OperationKind = z.enum(["activate", "reconcile", "deactivate"]);
export const Phase = z.enum([
  "accepted", "materialized", "prepared", "patch-dispatched", "verified", "terminal",
]);
export const Conflict = z.object({
  code: z.enum([
    "BUSY", "IDEMPOTENCY_CONFLICT", "TARGET_MISMATCH", "HOME_UNVERIFIED",
    "UNSUPPORTED_PLATFORM", "EXECUTABLE_UNAVAILABLE", "MCP_DISABLED",
    "RAW_LIVE_DIVERGENCE", "COLLISION", "OWNERSHIP_DRIFT", "SCHEMA_LOSS",
    "DEPENDENT_REFERENCE", "RUNTIME_INTEGRITY", "RECOVERY_REQUIRED",
    "PATCH_OUTCOME_UNKNOWN", "IO_FAILURE", "INVALID_REQUEST", "NOT_FOUND",
  ]),
  path: z.string().max(4096).nullable(),
  message: z.string().min(1).max(2048),
  expectedSha256: Sha.nullable(),
  actualSha256: Sha.nullable(),
}).strict();
export const OperationView = z.object({
  operationId: Id,
  kind: OperationKind,
  phase: Phase,
  outcome: z.enum(["pending", "succeeded", "no-op", "failed", "recovery-required"]),
  startedAt: Time,
  updatedAt: Time,
  completedAt: Time.nullable(),
}).strict();
export const StartOutput = z.object({
  schemaVersion: z.literal(1),
  accepted: z.boolean(),
  state: State,
  operation: OperationView.nullable(),
  conflicts: z.array(Conflict).max(64),
  pollAfterMs: z.number().int().min(0).max(5000),
}).strict();
const Start = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  operationId: Id,
  authority: Authority,
}).strict();
export const ActivateInput = Start.extend({
  candidateSha256: Sha,
  adoptIdentical: z.boolean().default(false),
  nodePath: AbsolutePath.optional(),
  binaries: z.object({
    codex: AbsolutePath.optional(), pi: AbsolutePath.optional(),
    devin: AbsolutePath.optional(), claude: AbsolutePath.optional(),
  }).strict().default({}),
  initialProfileFamily: Family.optional(),
  // Human-supplied preferences merged into the owned profiles. The plugin
  // invents no model/mode/feature defaults. On first activation absent
  // fields are simply not written. On an existing binding `profiles` is an
  // explicit edit applied over the validated live entries — absent fields
  // preserve the live value, `null` clears it, and `family` repoints the
  // profile at that family's managed provider for the role — under the same
  // serialized operation and receipt as any other verify.
  profiles: z.object({
    supervisor: ProfilePrefs.optional(),
    lead: ProfilePrefs.optional(),
  }).strict().optional(),
}).strict();
export const ReconcileInput = Start.extend({
  action: z.enum(["inspect", "complete", "restore-before"]),
  interruptedOperationId: Id.optional(),
}).strict();
export const DeactivateInput = Start.extend({
  expectedBindingSha256: Sha,
}).strict();
export const StatusInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  operationId: Id.optional(),
}).strict();
export const BindingView = z.object({
  bindingSha256: Sha,
  candidateSha256: Sha,
  payloadSha256: Sha,
  launchSetSha256: Sha,
  runtimePath: AbsolutePath,
  nodePath: AbsolutePath,
  baseline: z.enum(["fresh", "adopted-observed"]),
}).strict();
export const FamilyView = z.object({
  family: Family,
  availability: z.enum(["available", "unavailable", "unresolved"]),
  binaryPath: AbsolutePath.nullable(),
  observedVersion: z.string().nullable(),
}).strict();
// Per-role editable fields. Absent = preserve (bound) or not written (fresh);
// null = clear; family repoints the profile's managed provider.
export const ProfilePrefs = z.object({
  family: Family.optional(),
  model: z.string().min(1).nullable().optional(),
  modeId: z.string().min(1).nullable().optional(),
  thinkingOptionId: z.string().min(1).nullable().optional(),
  featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();
// Live tunable fields of one managed profile, read from daemon config — lets
// the surface prefill the bound-state profile editor.
export const ManagedProfileView = z.object({
  id: z.string(), provider: z.string().nullable(),
  model: z.string().nullable(), modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  featureValues: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export const StatusOutput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  state: State,
  embeddedCandidateSha256: Sha,
  binding: BindingView.nullable(),
  managedProfiles: z.array(ManagedProfileView).max(2),
  families: z.array(FamilyView).length(4),
  operation: OperationView.nullable(),
  conflicts: z.array(Conflict).max(64),
  verifiedAt: Time.nullable(),
  retainedRuntimeCount: z.number().int().nonnegative(),
  liveAcceptance: z.literal("not-established-by-this-rpc"),
}).strict();
export const activate = defineRpc({ name: "activate", input: ActivateInput, output: StartOutput });
export const reconcile = defineRpc({ name: "reconcile", input: ReconcileInput, output: StartOutput });
export const deactivate = defineRpc({ name: "deactivate", input: DeactivateInput, output: StartOutput });
export const status = defineRpc({ name: "status", input: StatusInput, output: StatusOutput });
export const localTarget = defineRpc({ name: "local-target", input: LocalTargetInput, output: LocalTargetOutput });
// Read-only advisory catalog: models/modes/feature definitions of the
// family's provider entry — queried via PaseoApi.providers before any
// binding exists, which is exactly when the profile pickers need them. The
// transport family in `extends` (e.g. `acp`) is not a queryable provider
// id. Feature listing runs on a draft config: the host requires
// provider/model format, so `listFeatures` is only queried when `model` is
// supplied (`cwd` required; `modeId` refines the set) — without a model the
// catalog returns an empty feature list. Descriptors are the same
// toggle/select definitions the host profile editor renders.
export const catalog = defineRpc({ name: "catalog", input: CatalogInput, output: CatalogOutput });
```

**DECISION: enforce one mutation worker per plugin process; reject competing starts with `BUSY`.** Rationale: the host concurrently dispatches handlers and provides no transaction serialization. Source: `S/plugins/plugin-process.js:375–392`; [audit](paseo-plugin-feasibility.md):723,739–744.

Acquire the mutex before checking or recording an operation. `status` reads an immutable in-memory snapshot or the last complete journal image and does not wait for config I/O. Start handlers durably record acceptance, schedule the worker, and return promptly, targeting under one second; they do not await materialization or `config.patch`. The UI polls every 1000 ms while pending (`pollAfterMs:1000`); terminal/rejected responses use zero. No progress stream or cancel RPC is promised. Bound RPC input/output JSON to 64 KiB in the plugin, return hashes rather than raw configuration, and truncate conflict lists to 64 with the final message stating the omitted count. This is an application bound, not a measured host transport maximum.

Idempotency key is `(canonical daemon home, operationId)`. Store SHA-256 of canonical parsed request plus method name. Identical retries return the existing operation, including after restart; a changed payload with the same ID returns `IDEMPOTENCY_CONFLICT`. Do not include volatile timestamps in the request hash. A different ID for an already-active identical target runs verification and ends `no-op`; it does not re-materialize or patch. A different candidate or changed executable selection is an explicit rebind, not an install-time side effect. `candidateSha256` must equal the embedded candidate. `deactivate` on an inactive journal is `no-op` only if its expected binding matches the last deactivated binding, or the journal has never owned a binding and no SLP entries exist; otherwise report conflict. Status always returns each family exactly once; before resolution use `unresolved` and null path/version, and for a missing binary use `unavailable` and null path/version. Status with an unknown requested operation ID returns `operation:null` and `NOT_FOUND`; without an operation ID it returns the active or latest operation, if any.

Business failures use the declared conflict envelope. Schema validation and unavailable-plugin failures may still reject at the SDK transport layer. If start invocation times out, poll the original operation ID, then retry that exact request if it is absent. Never assume timeout canceled work. An operation already durably accepted returns `accepted:true` even if its terminal outcome later fails; rejection before durable acceptance uses `accepted:false`, `operation:null`, and at least one conflict. Map the receipt intent's `acceptedAt` to `OperationView.startedAt`. A pending accepted operation has a nonnull operation view; only it gets a nonzero poll delay. Reconcile `complete`/`restore-before` without `interruptedOperationId` is `INVALID_REQUEST` before acceptance.

## 4. Target selection, ownership, and durable storage

**DECISION: the administrator supplies the absolute daemon home and confirms its mapping to the selected connection.** Rationale: public `PaseoApi` and client host props do not expose that mapping; equality of config values or PID liveness cannot prove it. Sources: `API/index.d.ts:362–369`; `SDK/client/contracts.d.ts:8–18`; `plugin/server/runtime/cli/inventory.ts:49–77`; [audit](paseo-plugin-feasibility.md):611–634.

Canonicalize the supplied home on the daemon host. It must already exist and contain a readable regular `config.json`; do not create a home, infer `~/.paseo`, or use the client machine's environment. Reject symlinked `config.json` or sidecar/runtime descendants. Canonicalizing a home reached through a symlink is allowed, but all subsequent paths use its real path. The UI displays host ID, host label, canonical home, and candidate before the user starts an operation. The authority booleans acknowledge the administrative procedure; they are not authentication or cryptographic home proof. Store the host ID with the canonical home and refuse silent retargeting. Initial live qualification must verify this mapping on the isolated daemon (Q1).

**DECISION: use `<real-daemon-home>/slp-runtime` as the stable root.** Rationale: each daemon needs independent ownership, and plugin removal deletes plugin settings while managed updates delete old checkouts. Sources: `S/plugins/index.js:287–291,468–512`; [audit](paseo-plugin-feasibility.md):741–744; `plugin/server/runtime/cli/paseo-install.ts:51–52,125–169`.

```text
<daemon-home>/slp-runtime/
  <candidate-sha256>/             # immutable install unit + installed.json
  launchers/<launch-set-sha256>/  # immutable launch.json + 12 executable shims
  .staging/<operation-id>/        # unpublished candidate/launcher staging
  state/receipt.json              # authoritative receipt AND operation journal
```

The root, staging, and state directories are private to the daemon account (POSIX mode 0700); the receipt is 0600. Candidate permissions preserve payload modes, including executable bits. No credentials, entire daemon config, or unrelated provider values go into the receipt or logs. Temporary receipt files are siblings of `receipt.json`, opened exclusively with 0600, flushed, then renamed over it; flush the containing directory on POSIX. One atomic replacement contains both state and operation progress. There is no second mutable “current” pointer to keep consistent. Record immutable candidate and launcher directories in the journal before publishing them; harmless retained/staged files are never proof of activation.

The manager owns these sidecars and runtimes independently of the plugin checkout. Disable/remove/reload does not deactivate or garbage-collect them. Deactivate detaches config but retains files. Automatic runtime deletion is outside v1; a separately authorized maintenance procedure may delete only after dependent sessions have finished and integrity/ownership are checked.

## 5. Embedded payload and atomic materialization

**DECISION: preserve the repository's byte identity and bind file modes separately.** Rationale: `identity()` hashes sorted path/content-hash entries but not modes; wrappers already call `verifyInstall()`. Sources: `plugin/server/runtime/cli/package.ts:6–46`; `bin/codex-role.mjs:10–16`; `bin/pi-role.mjs:8–13`; `bin/devin-role.mjs:10–17`; `bin/claude-role.mjs:10–23`; [audit](paseo-plugin-feasibility.md):556–595.

The generator uses `installUnitPaths()` from `plugin/server/runtime/cli/package.ts` to enumerate `package.json`, `install.sh`, all regular files recursively under `bin/`, optional `skills/`, `src/`, and the selected `plugin/server/runtime/` and `plugin/shared/runtime/` subtrees. Exclude docs, tests, E2E, other plugin source, and development dependencies. Runtime TS uses only erasable syntax and runs directly on supported Node; preserve source paths and bytes without compiling. The graph guard rejects package dependencies, missing imports, server-core imports outside the two runtime tiers, and Node imports/types in shared-core, including type-only edges. Optional runtime roots preserve verification of pre-refactor installation receipts; current source imports must all resolve inside the install unit. Reject symlinks and non-regular entries. Use POSIX `/` relative path keys, sorted lexicographically, no absolute paths, `..`, empty components, duplicates, case-colliding paths, or drive prefixes. Preserve exact bytes as base64.

The embedded module exports:

```ts
type EmbeddedPayload = {
  schemaVersion: 1;
  candidate: { sha256: string; files: { path: string; sha256: string }[] };
  payloadSha256: string;
  files: { path: string; sha256: string; mode: number; base64: string }[];
};
```

`candidate.sha256 = sha256(JSON.stringify(candidate.files, null, 2) + "\n")`, exactly the existing identity algorithm on POSIX. `payloadSha256` hashes that same pretty-JSON serialization of the sorted `{path,sha256,mode}` list. Modes are permission bits only (`stat.mode & 0o777`); reject setuid/setgid/sticky package files rather than silently converting them. The build compares every decoded file hash and the candidate identity before emitting. Windows qualification requires `identity()` to use the same portable path keys.

Materialization sequence:

1. Record operation acceptance and intended SHA/path in the journal before filesystem creation. Validate every embedded path, size, hash, and mode in memory. The payload is server-bundled; no runtime fetch or checkout read is permitted.
2. If `<stable-root>/<sha>` exists, verify the complete expected file set, bytes, modes, and `installed.json`; reuse only on exact match. A mismatch is `RUNTIME_INTEGRITY`, never an in-place repair.
3. Otherwise create an exclusive private staging directory on the same filesystem. Decode files using exclusive creates, apply their recorded modes explicitly after writing, and verify them from disk. Reject filesystem symlinks along the write path.
4. Write `installed.json` with mode 0600 as `{ "source": "embedded:<sha>", "candidate": <candidate> }`. Do not add `paseoBindingSha256` or a mutable `paseo-binding.json`; the plugin receipt is external. The legacy verifier ignores `source` semantics and checks `candidate`.
5. Flush files and directories, then rename the complete candidate directory to `<stable-root>/<sha>`. Never overlay an existing nonempty destination. If another publisher won, verify its entire destination and discard only this operation's unpublished staging. Reverify after publication.
6. Generate and publish the immutable launch set using the same staging/verify/rename sequence. Record `materialized` with both identities. Do not patch config until publication succeeds.

Crash cleanup may remove only verified unpublished staging associated with a journaled operation and no running worker. An interrupted candidate directory without the expected manifest is a conflict, not something to overwrite. Filesystem publication is atomic per directory; the overall materialize/config/journal operation is **not** one atomic transaction.

## 6. Executable shims and Node/binary resolution

> **Phase 2 amendment** ([settings-driven-providers.md](settings-driven-providers.md)
> §6): this section describes the v1 Option-A shape, which `slp-devin-*`
> still uses verbatim. For codex/pi/claude the provider entry is now a
> sentinel-gated thin alias — `extends` kept, env carrying the managed
> backstop plus `SLP_SESSION_OPEN_GRANT: ""` and `SLP_FAMILY_BIN` — whose
> `command` is a single-element argv0 launcher like every other entry.
> Launch sets therefore publish all twelve launchers again, but the nine
> hook-family launchers are trivial gate launchers (`#!/bin/sh`, export the
> frozen `SLP_FAMILY_BIN`, `exec` the verified Node on
> `<candidate>/bin/slp-gate.mjs "$@"`) instead of shim dispatchers; new
> manifests carry `launcherFamilies` (all twelve) plus `gateFamilies` (the
> nine) so verify replays the right plan per file, and manifests without
> the fields replay the legacy all-shim plan. An earlier cut of this phase
> put `[node, <candidate>/bin/slp-gate.mjs]` in `command` directly —
> rejected on review because the argv0 probe drops the tail (it would
> measure Node, and the env-free probe cannot see `SLP_NODE_BIN` either, so
> a shell wrapper reading env vars fails the same way). The argv0-probe
> rationale below is exactly why the launcher indirection is mandatory:
> the gate answers a bare `--version` through the real family binary
> without requiring the grant.

**DECISION: give each family/role its own real executable `argv[0]`.** Rationale: Paseo's Codex probe invokes only `command[0] --version`, dropping the command tail and provider runtime environment; today's Node-first command reports Node's version. Sources: `S/agent/providers/diagnostic-utils.js:108–120`; `S/agent/providers/codex-app-server-agent.js:5547–5578`; `plugin/server/runtime/cli/paseo-install.ts:39`; [audit](paseo-plugin-feasibility.md):694–695.

Each command is exactly one element:

```json
["<stable-root>/launchers/<launch-set-sha256>/slp-codex-supervisor"]
```

Generate corresponding executables for all 12 IDs. The role and family are baked into the launcher, not supplied by a dropped argument or session environment. The POSIX launcher begins `#!/bin/sh`, has mode 0755, and `exec`s the verified absolute Node executable, `<candidate>/bin/slp-shim.mjs`, the frozen manifest path/digest, family, role, a literal `--`, and `"$@"`. The dispatcher's exact positional interface is `<launch-manifest-path> <manifest-sha256> <family> <role> -- <native-args...>`; a missing separator or invalid fixed field fails. Quote every fixed shell argument using POSIX single-quote escaping; never evaluate user arguments. After verification, load the existing wrapper with `process.argv` set to `[nodePath, wrapperPath, role, ...nativeArgs]`. Its expected manifest digest is baked into each generated launcher.

`launch.json` contains schema version 1, canonical daemon home, candidate SHA/path, resolved Node path/version, all four resolved real-binary paths/versions or explicit unavailability, and the fixed family/role set. `launchSetSha256` hashes the canonical manifest before adding any self-reference; generated launcher bytes are deterministic from it and their file hashes/modes are recorded in the receipt. This avoids placing host-specific paths or mutable bindings inside the byte-identified install unit. A new Node location, real-binary selection, or candidate produces a new launch set; old sets are retained.

Dispatch rules:

| Invocation | Required behavior |
|---|---|
| Exactly `--version` | Verify the frozen launch metadata/candidate, then run the selected real family executable with exactly `--version`, inherited stdio, and forwarded exit status. Do not load role instructions, start a protocol session, print an SLP banner, or report Node's version. This works with provider env entirely absent. |
| Provider protocol invocation | Verify candidate and select the baked role, set the frozen environment below, and enter `bin/{family}-role.mjs`. Preserve Codex app-server interception, Pi role arguments, Devin ACP prompt injection, and Claude stream-json injection. |
| Existing non-session admin invocation | Preserve the wrapper's passthrough behavior, including Claude `auth status`. Do not add B2 discovery filtering or require a session grant. |
| Missing binary / corrupt runtime / invalid role | Diagnostic on stderr, nonzero exit, no provider launch. Never fall back to an unwrapped executable for a session. |

Keep stdio, backpressure, exit code, and SIGINT/SIGTERM/SIGHUP forwarding behavior from the existing transports. The shim must not create a second instruction layer; role bytes still come from `roleBundle()`. Live support remains limited to the invocation forms used by the pinned adapters; tests must reject any newly introduced session form that would bypass policy.

The following source-observed surfaces must work **without a session-open overlay**. “Without overlay” does not imply absence of static provider env. These are compatibility tests for A's ordinary wrapped transport, not B2 discovery allowlists:

| Family | Surface and source evidence |
|---|---|
| Codex | `argv[0] --version` omits provider runtime env; catalog starts an app-server for model discovery; native archive/unarchive also starts an app-server. `S/agent/providers/diagnostic-utils.js:108–120`; `S/agent/providers/codex-app-server-agent.js:5692–5748,5759–5785`. |
| Pi | Catalog starts a runtime session and calls `getAvailableModels`; `listFeatures` returns `[]`. `S/agent/providers/pi/agent.js:2115–2147`. Do not interpret Pi commands as JSON-RPC `method` messages in a shim test. |
| Devin / generic ACP | Catalog starts a probe and performs real `session/new`; feature probing can also create a session, and import listing starts a probe. `S/agent/providers/acp-agent.js:506–550,572–608`. Do not assume discovery never opens a session. |
| Claude | Version/auth probes carry static runtime env and command-tail args; catalog performs version/settings work; draft-command discovery reaches `listCommands()`/`ensureQuery()` and needs the existing stream-json transport. `S/agent/providers/claude/agent.js:1108–1123,1234–1249,2171–2173`; [audit](paseo-plugin-feasibility.md):706. |

Those probe sessions remain on the verified role wrapper. No grant is needed, and the manager never substitutes an unwrapped session just to make catalog discovery pass.

**DECISION: reserve the B2 grant variable but give it no authority in Option A.** Rationale: A's stable transport remains operational after raw plugin removal, and no-env discovery/probe paths exist. Sources: `S/agent/provider-launch-config.js:127–143`; `S/agent/providers/diagnostic-utils.js:108–120`; [audit](paseo-plugin-feasibility.md):681–695; `bin/*-role.mjs`.

| Variable | v1 contract |
|---|---|
| `SLP_SESSION_OPEN_GRANT` | Owned provider config sets `""`; the dispatcher resets it to `""` even if inherited or overlaid. Empty is the reserved no-grant sentinel. No v1 hook issues grants and no v1 launch requires one. A nonempty inherited value must not select another runtime or bypass verification. |
| `SLP_CODEX_BIN`, `SLP_PI_BIN`, `SLP_DEVIN_BIN`, `SLP_CLAUDE_BIN` | Absolute real executable selected during activation. This family's provider entry uses an empty string when unavailable; the dispatcher fails before entering the wrapper in that case. Otherwise it overwrites the relevant variable from its manifest, so version and session launches agree even without provider env. Never point to an SLP shim, Node, or plugin checkout. |
| `SLP_RUNTIME_ROOT` | Set from the immutable manifest to `<stable-root>/<candidate-sha>`; ignore an inherited alternative. This is a fixed A binding, not B2's hook-selected root. |
| `SLP_NODE_BIN` | Verified absolute ordinary Node path from the launch manifest, used for stable helper instructions. |
| `SLP_DAEMON_HOME` / `PASEO_HOME` | Set to the verified canonical daemon home; managed helper calls must use that home explicitly. |
| `SLP_MANAGED_RUNTIME` | Set to `"1"`; selects the managed helper restrictions in §10. |
| `PASEO_AGENT_ID` | Preserve as host context only. Never use it as a grant, session discriminator, or home proof. |

Include these fixed SLP values and `PASEO_HOME` in provider `env` for ordinary spawns; include only this family's `SLP_*_BIN`, with the explicit empty value when unavailable. The key set stays constant across v1 rebinds because patches deep-merge env maps and cannot delete subfields. Reconstruct the values from `launch.json` in the dispatcher because argv0-only probes do not carry that env. Preserve unrelated credentials and normal provider environment. Clear Paseo/Electron runtime-control variables using the same list as `S/paseo-env.js:3–24`; do not clear arbitrary credentials. The possible future B2 sentinel-plus-session-overlay protocol is deliberately not implemented.

**DECISION: resolve Node at activate/rebind time and persist the result.** Rationale: plugin `process.execPath` may be Electron, and child sanitization removes `ELECTRON_RUN_AS_NODE`; the package requires Node `>=22.18.0 <23.0.0 || >=23.6.0` for native TypeScript stripping. The bootstrap-safe shared version check runs in the CLI before importing TS and in the resolver/shim. Sources: `S/paseo-env.js:3–24,36–48`; `package.json` (`engines.node`); [audit](paseo-plugin-feasibility.md):634,695.

Try, in order: (1) explicit `nodePath` from the administrator; (2) the same home's previously verified receipt path; (3) executable `node` entries in the daemon subprocess's absolute `PATH` directories, in order. An invalid explicit path is an error, not permission to silently select another binary. Never use plugin `process.execPath` as a candidate, launch a login shell/version manager, install Node, search the client host, or depend on a future PATH lookup. Ignore relative/empty PATH entries. Resolve symlinks to an absolute existing executable; the result must lie outside managed plugin and SLP launcher directories.

Probe with `execFile`/`spawn` and `shell:false`, the runtime-control variables removed, `NODE_OPTIONS` removed for the probe, a five-second deadline, and bounded output. Execute a small Node script that returns JSON containing `process.versions.node`, `process.versions.electron ?? null`, and `process.execPath`, and imports required builtins (`fs`, `crypto`, `child_process`). Require no Electron version, the supported Node range above, successful imports, exit zero, and an executable canonical path consistent with the resolved result. A `--version` string alone is insufficient. Reverify before config mutation and on later activation/reconcile; the shim itself checks it is executing ordinary supported Node. Failure means `EXECUTABLE_UNAVAILABLE` with an actionable requirement to supply a Node path.

Resolve each family executable using explicit `binaries[family]`, then the corresponding executable in the daemon's absolute PATH directories (`codex`, `pi`, `devin`, `claude`), then its previous verified path when PATH has no usable candidate. PATH takes priority over a prior receipt so old realpath pins migrate to current CLI aliases on the next activation. Validate the alias and its resolved target outside managed directories, reject recursion into an SLP launcher or the Node executable, and run its bounded `--version` probe. Persist a validated alias path when present so vendor updates reached through that alias affect future launches without another SLP activation; known Devin `_versions/current` and Codex `standalone/current` handles also heal prior versioned paths. An explicit direct release path remains an operator pin for that activation; repeat the override when activating again to retain it. No downloads, authentication actions, or inferred command-tail stripping are allowed. Persist path and observed version, not credentials. These external binaries are not included in the SLP candidate hash; a vendor update behind an alias does not prove native-provider behavior, and the catalog is refreshed before SLP presents model choices.

Always create 12 provider definitions. A missing nonselected family gets `enabled:false` and a launcher that fails with `EXECUTABLE_UNAVAILABLE`; status reports it. A family used by either saved profile must resolve successfully. Initial profile family uses the explicit input, otherwise the first available explicitly enabled base family in `plugin/server/runtime/cli/profiles.ts` order, otherwise Codex if available; if none qualifies, activation fails. Rebind preserves existing valid profile choices. A later activation can enable a newly available family by publishing a new launch set.

**DECISION: ship POSIX first; Windows has a fail-closed platform gate.** Rationale: `.cmd` launchers require shell semantics in Paseo and cannot be validated by POSIX fixtures. Sources: `U/spawn.js:10–35,38–58`; [audit](paseo-plugin-feasibility.md):358,694–695.

The Windows implementation plan is a per-role `.cmd` argv0 executable invoking verified `node.exe` and the same dispatcher, using `@echo off`, `setlocal DisableDelayedExpansion`, properly quoted fixed paths, argument forwarding, and exit-code propagation. It must pass native tests for spaces, Unicode, `%`, `!`, `&`, `^`, parentheses, quotes, and empty arguments, as well as the argv0-only probe. Do not claim `shell:false` neutralizes `.cmd`: Paseo enables a shell for command scripts. Until Q4 and portable identity/mode handling pass, `activate` returns `UNSUPPORTED_PLATFORM` on Windows before accepting a mutation; no Node-first fallback is allowed.

## 7. Receipt and operation-intent schema

**DECISION: keep one authoritative schema-versioned JSON journal at `state/receipt.json`.** Rationale: prior presence, ownership, and an interrupted patch must survive plugin checkout/settings deletion without changing immutable policy bytes. Sources: `S/plugins/index.js:287–291,510–512`; `S/daemon-config-store.js:221–261,393–404`; [audit](paseo-plugin-feasibility.md):723–744.

The definitions below extend §3. `Profile` matches the persisted profile fields, retaining JSON-valued extensions; `OwnedProvider` deliberately has only the fields v1 writes. The complete receipt is `Receipt.parse(JSON.parse(bytes))` plus the listed cross-field refinements. Use JSON only: no `undefined`, BigInt, Dates, or executable values.

```ts
const Json = z.json();
const ProviderId = z.string().regex(/^slp-(codex|pi|devin|claude)-(supervisor|lead|peer)$/);
const Presence = <T extends z.ZodType>(value: T) => z.discriminatedUnion("present", [
  z.object({ present: z.literal(false) }).strict(),
  z.object({ present: z.literal(true), value }).strict(),
]);
const FlagBefore = z.object({ raw: Presence(z.boolean()), effective: z.boolean() }).strict();
const Profile = z.object({
  id: z.string(), name: z.string(), provider: z.string(),
  icon: z.string().optional(), color: z.string().optional(),
  model: z.string().optional(), modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), Json).optional(),
  notes: z.string().optional(),
}).catchall(Json);
const OwnedProvider = z.object({
  extends: z.enum(["codex", "pi", "acp", "claude"]),
  label: z.string(), command: z.tuple([AbsolutePath]),
  env: z.record(z.string(), z.string()), enabled: z.boolean(),
}).strict();
const OwnedProfileSlot = z.object({
  index: z.number().int().nonnegative(), value: Profile,
}).strict();
const Projection = z.object({
  providers: z.record(ProviderId, Presence(OwnedProvider)),
  profilesPresent: z.boolean(),
  profiles: z.array(OwnedProfileSlot).max(2),
  injectIntoAgents: Presence(z.boolean()),
}).strict();
const Snapshot = z.object({
  rawConfigSha256: Sha,
  owned: Projection,
  ownedSha256: Sha,
  allProfilesSha256: Sha,
  unrelatedPersistedSha256: Sha,
  effectiveEnabled: z.boolean(),
  effectiveInjection: z.boolean(),
}).strict();
const Binary = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), path: AbsolutePath, version: z.string().min(1) }).strict(),
  z.object({ available: z.literal(false), path: z.null(), version: z.null() }).strict(),
]);
const LauncherFile = z.object({
  path: AbsolutePath, sha256: Sha, mode: z.number().int().min(0).max(511),
}).strict();
const Binding = z.object({
  bindingSha256: Sha,
  candidateSha256: Sha,
  payloadSha256: Sha,
  runtimePath: AbsolutePath,
  launchSetSha256: Sha,
  launchManifestSha256: Sha,
  launcherFiles: z.array(LauncherFile).length(12),
  node: z.object({ path: AbsolutePath, version: z.string().min(1) }).strict(),
  binaries: z.object({ codex: Binary, pi: Binary, devin: Binary, claude: Binary }).strict(),
  baseline: z.enum(["fresh", "adopted-observed"]),
  beforeActivation: Snapshot,
  mcpBefore: z.object({ enabled: FlagBefore, injectIntoAgents: FlagBefore }).strict(),
  owned: Projection,
  postPatchPersistedShapeSha256: Sha,
  activatedAt: Time,
  verifiedAt: Time,
}).strict();
const Plan = z.object({
  before: Snapshot,
  afterOwned: Projection,
  afterOwnedSha256: Sha,
  afterAllProfilesSha256: Sha,
  previousBinding: Binding.nullable(),
  nextBinding: Binding.nullable(),
  restoreInjectionTo: z.boolean().nullable(),
}).strict();
const Intent = z.object({
  operationId: Id,
  requestSha256: Sha,
  kind: OperationKind,
  bootId: Id,
  phase: Phase,
  outcome: z.enum(["pending", "succeeded", "no-op", "failed", "recovery-required"]),
  candidateSha256: Sha.nullable(),
  recoveryOf: Id.nullable(),
  recoveryAction: z.enum(["inspect", "complete", "restore-before"]).nullable(),
  acceptedAt: Time,
  updatedAt: Time,
  completedAt: Time.nullable(),
  plan: Plan.nullable(),
  /** Receipt state to restore if this op fails without an ambiguous patch
   *  settlement — recorded at acceptance. Absent on intents journaled by
   *  older builds; readers fall back per op kind. */
  priorState: State.optional(),
  patchAttempts: z.array(z.object({
    requestId: Id,
    dispatchedAt: Time,
    settledAt: Time.nullable(),
    result: z.enum(["pending", "returned", "threw", "outcome-unknown"]),
  }).strict()),
  conflicts: z.array(Conflict).max(64),
}).strict();
const Receipt = z.object({
  schemaVersion: z.literal(1),
  pluginId: z.literal("paseo-slp"),
  target: Target,
  stableRoot: AbsolutePath,
  revision: z.number().int().nonnegative(),
  state: State,
  createdAt: Time,
  updatedAt: Time,
  binding: Binding.nullable(),
  lastDeactivatedBindingSha256: Sha.nullable(),
  activeOperationId: Id.nullable(),
  retained: z.array(z.object({
    candidateSha256: Sha, payloadSha256: Sha, runtimePath: AbsolutePath,
    launchSetSha256: Sha.nullable(), retainedAt: Time,
  }).strict()),
  operations: z.array(Intent),
}).strict();
```

**DECISION: hash raw presence separately from canonical persisted shape.** Rationale: effective reads hide defaults and unknown-field loss; identity must compare what the daemon actually persists. Sources: `P/provider-config.js:41–54`; `P/messages.js:77–93`; `S/daemon-config-store.js:182–203,221–223,452–469`; `S/persisted-config.js:379–401`.

Canonical JSON for receipt/request/projection hashes recursively sorts object keys, preserves array order and scalar values, emits compact JSON plus one newline, and rejects non-JSON values. This is **distinct from** the legacy candidate identity serializer in §5. `rawConfigSha256` hashes original file bytes, including formatting. “Byte-identical persisted entries” means identical bytes of this canonical, losslessly schema-validated entry serialization; key ordering/formatting in the surrounding config file is not an ownership difference, but absent vs explicit `false`/empty fields is.

Required refinements and derivations:

- Exactly 12 provider keys occur in every projection, each carrying present/absent explicitly. An active binding has all 12 present. Slots contain only the two owned profile IDs, no duplicate IDs or indexes; active bindings contain both. Role/provider family mappings must be valid, including `devin → acp`.
- `profilesPresent` records presence of raw `daemon.agentProfiles`; slot indexes are positions in that full array. `allProfilesSha256` hashes `{present:false}` or `{present:true,value:<whole-array>}`. The full unrelated array is reconstructed from a fresh verified raw read, never stored in the receipt.
- `unrelatedPersistedSha256` hashes raw JSON after removing the 12 owned providers, the two owned profiles, and `daemon.mcp.injectIntoAgents`. For this comparison only, normalize missing/empty `agents.providers` to an empty map and missing/empty `daemon.agentProfiles` to an empty array, and prune now-empty `agents`, `daemon.mcp`, and `daemon` containers. Keep every other value, including `mcp.enabled`, unchanged. This prevents intentional container creation from masquerading as unrelated drift.
- All path prefixes derive from `target.daemonHome`; runtime basename equals candidate SHA; no mutable current path, checkout path, or arbitrary client path is accepted. Validate Node and binary exceptions according to §6.
- `postPatchPersistedShapeSha256` is the hash of `Binding.owned`, freshly extracted from raw disk after patch/adoption. It is not the patch response's hash or the entire config hash.
- `bindingSha256` hashes candidate/payload/launch-set identities and `owned`; exclude timestamps, itself, and the historical baseline. `launchManifestSha256` hashes the actual `launch.json` bytes. Verify generated launcher files against their recorded bytes/modes.
- A rebind carries forward the original `mcpBefore` and `beforeActivation` baseline, while its operation plan independently records the immediate before-state for rollback. Never replace the original restoration baseline with “currently true”.
- `prepared` and later mutating phases require a complete plan. Set the plan's projected `nextBinding.verifiedAt` to preparation time initially; replace it with the real verification time at completion. An uncommitted plan is not an active receipt.
- At most one pending operation exists. Every progress update increments `revision` and atomically rewrites the journal. Keep operation IDs/request hashes and intent history in v1; no silent truncation or historical-ID reuse. If an administrative size limit is needed later, refuse a new start rather than dropping idempotency history.
- Corrupt/unsupported journal schemas produce `RECOVERY_REQUIRED` without overwriting the evidence. Logs and RPC conflicts contain paths/hashes and bounded explanations, never raw environment values or daemon config.

## 8. Configuration transaction protocol

**DECISION: raw-read for evidence, SDK-patch for mutation, with no fallback file writer or reload.** Rationale: `config.get()` returns live state, persistence reparses/strips data, arrays replace wholesale, and the API cannot delete arbitrary keys or patch `mcp.enabled`. Sources: `S/daemon-config-store.js:182–261,393–469`; `S/persisted-config.js:345–401`; `P/messages.js:158–177`; [audit](paseo-plugin-feasibility.md):663–684,723–749.

### 8.1 Shared preflight and pure plan

Read `<verified-home>/config.json` directly using read-only filesystem APIs, retaining original bytes and using `Object.hasOwn` at each relevant path. Do **not** call Paseo's `loadPersistedConfig` from the plugin: it can initialize a missing file and change permissions (`S/persisted-config.js:345–361`). Do not import internal server classes into production. The plugin's compatibility validator must reproduce the pinned persisted schema/migration loss checks from `S/persisted-config.js:188–289,379–388` and public `ProviderOverrideSchema` / `AgentProfileSchema`; offline tests compare it to the installed implementation. Validate without writing. Refuse invalid input or any parse/migration that would discard fields anywhere in the file (`SCHEMA_LOSS`), including unrelated providers. Never “fix” the file by stripping those fields.

Obtain `(await paseo.config.get()).config` through the same selected connection. Require effective `mcp.enabled === true` for activation/rebind. Require raw MCP defaults/effective values, owned provider commands/env, and the full profile array to agree with the live state for fields being written; otherwise report `RAW_LIVE_DIVERGENCE` and require an administrator to resolve overrides/reload outside this plugin transaction. Raw absent injection resolves to false; absent enabled resolves to true in the pinned host (`S/config.js:337–338`). An explicit conflicting enabled value or launch override is not repairable by this plugin. For deactivation, a changed enabled value is also drift from the binding precondition; do not claim to restore it.

Build expected provider entries exactly as:

```ts
{
  extends: family === "devin" ? "acp" : family,
  label: `SLP ${familyDisplay} ${roleDisplay}`,  // e.g. "SLP Claude Code Lead"
  command: [absoluteStableRoleLauncher],
  env: frozenEnvironmentForThisFamily,
  enabled: familyBinaryIsAvailable,
}
```

Create `slp-supervisor` and `slp-lead` with the names/notes from `plugin/server/runtime/cli/paseo-install.ts:41–44`, the selected family provider, and no invented model/mode defaults. No Peer saved profile is created. Existing legacy `slp-peer`/disposition profiles and old CLI installations are not silently migrated: report a migration conflict requiring a separately authorized legacy migration. An old Node-first provider definition is not identical to the new shim definition.

Collision rules:

1. Without a binding, absent owned IDs may be created. Present providers/profiles may be adopted only with `adoptIdentical:true` and exact canonical persisted equality to this operation's generated entries. Reject unknown or extra provider fields rather than stripping before comparison. Mixed absent/exact-present entries are allowed with explicit adoption, since an interrupted earlier install can leave such a set.
2. With a binding, require exact recorded provider equality. For activate/reconcile, valid human profile preferences may be refreshed into the receipt: keep IDs, require each provider to be `slp-<family>-<same-role>` with a verified available family, preserve every other schema-valid JSON preference and full-array position. A new/missing/duplicate owned profile or unrelated provider target is a conflict. Deactivate itself requires exact receipt profile equality; tell the administrator to reconcile legitimate edits first.
3. Rebind changes only existing v1 keys/values. If the desired provider shape needs deleting a subfield, reject it; never combine `removeProviders` and re-add for the same ID. That combination has different live and persisted ordering in 0.8.0 (`S/daemon-config-store.js:235–248,419–440`).
4. Before removal, reject references to owned providers from unrelated profiles or `agents.metadataGeneration.providers` (`DEPENDENT_REFERENCE`). Removal otherwise filters metadata-generation entries implicitly; do not silently destroy user configuration. Active sessions are handled by retention, not by this reference check.

No-receipt adoption records all actual pre-observed presence/values with `baseline:"adopted-observed"`. It does not reconstruct the first installation's history. Explicit adoption transfers management of the identical SLP entries, including authority to remove those entries on later deactivate; shared injection is restored to the value observed at adoption. UI must disclose that original pre-install shared values are unknown. Normal raw-remove recovery uses the surviving sidecar and retains its original baseline.

### 8.2 Activate / rebind

**DECISION: persist intent before each external mutation and commit ACTIVE only after disk and live verification.** Rationale: materialization, daemon persistence, and receipt publication are separate failure boundaries. Sources: `S/daemon-config-store.js:248–260,393–404`; [audit](paseo-plugin-feasibility.md):663–684,741–744.

Execute under the mutation mutex:

1. Validate target/authority, schema, supported platform, request idempotency, and requested embedded SHA. Reject a different in-flight operation. Read/validate the journal; pending work from an older boot enters recovery instead of starting a new activation. Atomically record `ACTIVATING`, operation `accepted`, original binding, intended candidate, and timestamps **before** materializing anything.
2. Resolve Node/binaries and materialize candidate/launchers (§5–6). Persist `materialized`. Runtime publication alone does not touch config.
3. Run shared preflight, raw/effective checks, schema-loss check, collisions, profile planning, and integrity verification. Capture `before`, original flag presence/effective values, previous binding, exact desired owned projection, full target profile-array hash, and candidate next binding. Compute the plan from raw persisted entries, never from a normalized `get()` snapshot alone.
4. Atomically persist the full plan with phase `prepared`. Immediately reread raw bytes and effective config: if the raw byte hash or relevant live values differ from the prepared before-state, stop without patching. This check detects some races; it is not CAS.
5. If raw and live state already equal the desired state, skip patch and proceed to adoption/verification. Otherwise append a `patchAttempts` record with a new request UUID and phase `patch-dispatched`, durably flush it, then make **one** call:

   ```ts
   await paseo.config.patch({
     providers: desiredTwelveProviderMap,
     agentProfiles: entireFreshArrayWithOwnedEntriesInsertedOrUpdated,
     mcp: { injectIntoAgents: true },
   }, patchRequestId);
   ```

   The profile array preserves unrelated entries, order, and fields. The patch never contains `mcp.enabled`, raw `daemon`/`agents` nesting, `removeProviders`, or secrets copied from unrelated providers. It is a mutable-config patch, not a raw-file patch.
6. When the call settles, persist its result and raw-read again. Verify all 12 persisted provider entries and both profile slots against the plan, injection presence/value against the target, the full profile-array hash, and preservation of the unrelated persisted projection. Fetch effective config and verify the same active bindings and both MCP flags. Verify published files once more. A patch response alone cannot satisfy this step.
7. Atomically publish the final binding, its `postPatchPersistedShapeSha256`, actual verification timestamp, retained previous runtime, `ACTIVE`, and terminal successful/no-op operation in one journal replacement. Only then may UI report active.

Prepatch failure restores the prior steady state (ACTIVE for rebind, otherwise INACTIVE), records a terminal failure, and retains any materialized files. A thrown/expired/disconnected patch does **not** imply no write. Here and below, “settled” means the daemon operation is known to have finished, not merely that a client Promise rejected: a timeout/disconnection records `outcome-unknown`, with `settledAt:null`. Re-read if the daemon call is known to have settled; if the exact before-state survives, finish failed in the prior state; if exact after-state and live state agree, complete the receipt; every other result enters `RECOVERY_REQUIRED`. No blind compensating patch occurs. Rebind rollback is the explicit `reconcile restore-before` protocol below.

### 8.3 Deactivate

**DECISION: detach owned entries and restore shared flag semantics, retaining all runtime files.** Rationale: the API cannot express absence, active clients can still reference old files, and raw plugin removal is separate. Sources: `S/daemon-config-store.js:419–469`; `S/config.js:337–338`; `S/agent/provider-snapshot-manager.js:322–400`; [audit](paseo-plugin-feasibility.md):679–684,721–735.

1. Under the mutex, validate target, expected binding SHA, exact provider/profile ownership, flags, runtime integrity, raw/live consistency, and absence of dependent unrelated references. Legitimate profile preferences must first be acknowledged by reconcile. Do not require an external provider binary still to be installed merely to detach an otherwise verifiable binding.
2. Build the entire current profile array with only the two owned IDs removed; preserve unrelated objects/order. Desired providers are absent. Desired injection is the binding's original `mcpBefore.injectIntoAgents.effective`, including false when the original raw field was absent. Never patch `mcp.enabled`; it remains as observed and must still satisfy the receipt's unchanged precondition.
3. Atomically record `DEACTIVATING`, operation intent, before-snapshot, desired projection, and full profile-array hash. Re-read before dispatch exactly as for activate; journal the dispatch before calling:

   ```ts
   await paseo.config.patch({
     removeProviders: allTwelveOwnedProviderIds,
     agentProfiles: entireFreshArrayWithoutOwnedProfiles,
     mcp: { injectIntoAgents: originalEffectiveInjection },
   }, patchRequestId);
   ```

4. Verify raw absence of owned providers/profiles, explicit restored injection (or an already-equivalent no-op shape), unchanged unrelated fields, and corresponding live config. Record the resulting shape rather than claiming original file bytes. If the profile array was originally absent, an explicit `[]` can remain; empty parent objects can remain. Original `injectIntoAgents` absence becomes explicit false after an actual patch. No restoration claim covers whitespace/key order. `mcp.enabled` is neither added nor removed by this plugin.
5. Atomically set `INACTIVE`, `binding:null`, `lastDeactivatedBindingSha256`, retained runtime records, and terminal success. Preserve historical operation plans/baselines. An uncertain patch outcome enters recovery, with no automatic file deletion or session termination.

### 8.4 Reconcile and crash recovery

**DECISION: reconcile recognizes exact before/after states and reports conflicts; it never forces an ambiguous overwrite.** Rationale: adopt-if-identical is viable, but disk/live divergence and unknown patch completion are not transactions. Sources: `S/daemon-config-store.js:221–261,393–445`; [audit](paseo-plugin-feasibility.md):674–684,726–744.

`inspect` verifies target, journal, retained candidates/launchers, ownership, raw persisted state, and live state. It makes no daemon config patch. It may atomically refresh valid human profile preferences and their binding hash in a healthy ACTIVE receipt, or classify interrupted work and record conflicts. A profile update never changes an original flag baseline. On a missing receipt, inspection reports observed SLP entries but does not invent ownership; use `activate(adoptIdentical:true)` for explicit adoption.

For `complete` or `restore-before`, require `interruptedOperationId` naming a nonterminal/recovery operation with a durable plan. Create a new idempotent reconcile operation with `recoveryOf`, retaining the original plan; mark the old operation `recovery-required` before recording the new pending operation, so only one is pending. Finalization records both the original operation's resolved outcome and the recovery operation's outcome in the same journal replacement. Do not accept recovery against another home's journal. Reconstruct full profile patches from a fresh raw file only after validating its owned/unrelated/whole-array hashes against the selected plan endpoint.

An older-boot operation interrupted before any journaled patch dispatch needs no inverse patch. `inspect` verifies the retained current binding (if any), marks the interrupted operation failed, and restores ACTIVE or INACTIVE accordingly. A null plan is valid only before preparation; it cannot authorize forward recovery. To retry that prepatch failure, start a new activation ID after inspection. Preserve or clean only its unpublished staging under §5. A prepared plan with no dispatch may instead be completed through the normal before-state branch below.

| Observed disk and live state | `complete` | `restore-before` |
|---|---|---|
| Exact planned after-state, call settled | Finalize intended binding/state without another patch. | Apply inverse plan once, using the original owned before-values/profile positions and immediate before effective injection; verify and restore previous binding/state. |
| Exact planned before-state, call settled | Revalidate files/MCP/preconditions; dispatch the recorded forward plan once; verify and finalize. | Finalize previous state without another patch. |
| Disk after, live before (or inverse) | `RAW_LIVE_DIVERGENCE`; no patch. | Same. Administrator resolves daemon state outside the plugin, then retries. |
| Partial/modified owned entries, changed unrelated data relevant to recovery, or uncertain schema loss | Report paths/hashes as conflicts; no patch. | Same; no “force” switch. |
| Original call may still be running | `PATCH_OUTCOME_UNKNOWN`; inspection/poll only. | Same; never overlap an inverse patch with an unknown forward patch. |

The inverse for a fresh activation removes the owned IDs and writes the immediate before effective injection; adopted entries that existed before the interrupted operation are restored, not accidentally removed by rollback. The inverse for a rebind restores the previous provider values and saved-profile slots while keeping both runtimes. The inverse for deactivate reinstates the previous binding. Reject an inverse requiring provider subfield deletion or same-call remove/re-add; the frozen v1 schema avoids that change. Original absent flags/profiles still restore semantically, as in §8.3.

No source evidence establishes that an RPC timeout, a plugin-process death, or two equal reads proves a dispatched daemon operation has stopped. While the original worker exists, retain its promise and wait for settlement. Across a crash, if outcome remains ambiguous, keep recovery blocked until the administrator establishes a quiescent daemon (an explicitly authorized isolated-daemon restart is one available procedure). Restart/reload is not performed by this plugin. This is a bounded operational recovery requirement, not a request to add upstream CAS.

## 9. State machine and concurrency contract

**DECISION: persist state, binding, and operation progress together; never derive ACTIVE from files alone.** Rationale: the daemon and filesystem cannot commit atomically through the available SDK. Sources: `S/daemon-config-store.js:248–260`; `S/plugins/runtime.js:342–362`; [audit](paseo-plugin-feasibility.md):741–744.

| Transition | Trigger | Atomic local journal change / external work |
|---|---|---|
| INACTIVE → ACTIVATING | Accepted activate | Record request hash, operation, intended candidate; worker materializes then prepares/patches/verifies. |
| ACTIVE → ACTIVATING | Explicit rebind activate | Preserve previous binding and original baseline; publish new paths before changing config. |
| ACTIVATING → ACTIVE | Exact raw/live/file verification | Commit new/adopted binding and terminal outcome together. |
| ACTIVE → DEACTIVATING | Accepted deactivate | Keep binding while recording inverse target; patch only after prepared intent. |
| DEACTIVATING → INACTIVE | Verified detach/restoration | Clear current binding, retain histories/files, record terminal outcome. |
| Transitional → prior steady state | Proven prepatch failure or verified restore-before | Record failed/rolled-back outcome and keep the prior binding as appropriate. |
| Any → RECOVERY_REQUIRED | Interrupted dispatched work, corrupt evidence, ownership drift, or mismatch | Preserve last trustworthy binding/plan; expose conflict, prohibit normal mutation. |
| RECOVERY_REQUIRED → ACTIVE / INACTIVE | Successful explicit reconcile | Commit verified endpoint and terminal recovery outcome together. |

`status` is read-only: it reports `RECOVERY_REQUIRED` when a persisted pending operation belongs to another `bootId`, even before a worker has recorded that transition. The first authorized mutation/reconcile records the recovery classification atomically. With no receipt and no owned entries in a read-only raw check, report INACTIVE; with no receipt and existing owned entries, report RECOVERY_REQUIRED pending explicit adoption. Normal polling reports the last verified binding and `verifiedAt`, not a fresh full config/runtime validation; label that timestamp “last verified” in the UI. Use reconcile inspect for a fresh validation. Do not silently resume a config mutation during contribution, daemon startup, plugin enable, or status polling.

**DECISION: publish this exact concurrency limitation in setup, status help, and the contract.** Rationale: `config.patch` has no expected revision/CAS, and profile arrays replace wholesale. Sources: `P/messages.js:158–177`; `S/daemon-config-store.js:237–248,393–404,468–469`; [audit](paseo-plugin-feasibility.md):721–724.

> SLP management operations are administrator-only and require an exclusive administrative edit window for the selected daemon. Do not edit daemon configuration through the app, another plugin, a CLI, or a file while activate, reconcile, or deactivate is in progress. The plugin serializes its own operations and verifies persisted and live results. Paseo 0.8.0 provides no compare-and-swap for these patches; this plugin cannot guarantee preservation against concurrent external writers. A detected mismatch stops automatic mutation and requires reconciliation.

The mutex protects only this plugin process. Journal revision checks and immediate rereads detect some unexpected edits; they do not lock the daemon, its config store, another process, or the Human. `hostId`/authority acknowledgments do not create a new permission boundary; the plugin uses its host-granted connected API. Managed plugin update/remove must also wait for the worker to be idle. Do not describe the accepted limitation as atomicity, strict concurrency safety, or database isolation.

## 10. Helpers, routing, and user-visible management

**DECISION: retain stable CLI helpers and explicit onboarding; plugin setup does not install routing choices or global skills.** Rationale: helpers are part of the install unit, RPCs are not agent tools, and repository-first routing remains the contract. Sources: `plugin/server/runtime/cli/role-bundle.ts:18–29`; `bin/slp.mjs:35–48`; `plugin/server/runtime/cli/routing.ts:54–98`; [audit](paseo-plugin-feasibility.md):622–634.

Keep `identity`, `verify`, `routes`, `prepare`, `prepare-handoff`, `snapshot`, `init`, and `materialize` behavior. `roleBundle()` in a managed launch must render helper commands using the verified absolute `SLP_NODE_BIN` and stable `bin/slp.mjs`, with correct shell quoting, and include the explicit home for home-dependent commands. Preserve role-part ordering and all complete binding/assignment/settlement fields; do not insert a plugin checkout path or an RPC call in policy text. Legacy non-plugin paths keep their existing behavior.

Managed `inventory` must not invoke the default-target `paseo provider ls` fallback in `plugin/server/runtime/cli/inventory.ts:64–74`. For managed launches, use exact-home config inventory explicitly labeled **configured, not live**, with `provenance:"configured"` on each provider entry. Extend `verifyProvider` in `plugin/server/runtime/cli/binding.ts:33–38` to reject that provenance for launch planning; its current enabled/status check alone would accept static entries. Require fresh selected-connection/MCP `list_providers` data before delegation. The plugin UI obtains live provider/config information from its handler's `paseo` API; agent planners continue accepting their existing `inventoryFile`/`providers` inputs. The existing profile inventory remains usable alongside explicitly supplied live providers. This freezes the minimal provenance correction without creating an agent-facing RPC/MCP server.

`agents`, `monitor`, and `notebook` retain explicitly selected-home filesystem behavior, with their existing read/write authority rules. They must fail rather than infer another home when `SLP_MANAGED_RUNTIME=1` and the binding home is unavailable. Do not silently claim SDK agent listings include every archived/unavailable record. `prepare-handoff`/snapshot still use Git subprocesses. S6 verifies the whole helper path from real role sessions, including native handles where needed. Sources: `plugin/server/runtime/cli/agents.ts:18–55`; `plugin/server/runtime/cli/inventory.ts:49–77`; `plugin/server/runtime/cli/package.ts:55–89`; [audit](paseo-plugin-feasibility.md):601–634.

The plugin activation/deactivation workflow does not scaffold, modify, or delete routing catalogs. Onboarding remains an explicit helper/skill action. The existing standalone installer still scaffolds an absent user catalog; §11 fixes its documentation. This distinction must appear in setup help so an empty or absent routing pool is not treated as ready for delegation.

One management surface (opened from the sidebar or command palette) shows selected host/home, embedded vs active candidate, state, operation progress, disabled/missing families, conflicts, and retained-runtime count. It offers explicit Activate/Rebind, Reconcile, and Deactivate actions, with recovery and override controls collapsed so the default view presents only the normal activation path. It explains semantic restoration, exclusive edits, and retained runtimes before mutation. Disable/remove is a separate host action: raw remove leaves correctly roled providers operational but without this manager; reinstall the same ID and use the surviving receipt to recover. Never auto-activate on install, reload, startup, or update.

## 11. Exact proposed contract reconciliation

**DECISION: land these contract edits with implementation, without changing the accepted global role policy.** Rationale: the current text describes the CLI binding location and falsely denies its routing scaffold; Option A has explicit restoration/ownership limits. Sources: `docs/contract.md:44–71`; `plugin/server/runtime/cli/paseo-install.ts:22–27,80–82,112–117,156`; [audit](paseo-plugin-feasibility.md):679–684,721–744.

This spec proposes the following replacements/additions; authoring this spec does not apply them.

Replace the paragraph at `docs/contract.md:44–47` with:

> The install unit is package.json, install.sh, bin/, skills/, src/, plugin/server/runtime/ and plugin/shared/runtime/. installed.json binds their exact bytes. The standalone Paseo installer also binds paseo-binding.json, containing only owned entries and prior MCP values, never credentials. The Option A plugin keeps its receipt and operation intents in a private per-daemon-home sidecar outside immutable candidates and plugin settings; its payload manifest additionally verifies file modes. The shell installer and installed CLI share the standalone installation code. The plugin uses the documented config.patch transaction and stable executable shims.

Replace `docs/contract.md:54–55` with:

> Standalone installation refuses collisions with owned provider and Supervisor/Lead profile IDs. Plugin activation may adopt existing entries only by explicit request and exact persisted-schema equality. A surviving receipt preserves the original restoration baseline; adoption without that receipt records the observed baseline and cannot recover earlier shared values. Unrelated configuration is preserved within the documented exclusive administrative edit window.

Replace `docs/contract.md:67–68` with:

> Standalone host install/upgrade creates an empty user routing-catalog scaffold at <paseo-home>/slp-routing.json only when absent. Uninstall removes that scaffold only while its bytes remain unchanged; existing or Human-edited catalogs are preserved. Plugin v1 activation/deactivation does not create, edit, or delete routing catalogs. Populating routing choices and migrating repository catalogs require explicit onboarding or migration authority.

Append after the lifecycle paragraph ending at current line 71:

> Option A plugin deactivation restores shared configuration semantics, not original JSON bytes or absent-key shape. It removes unchanged owned provider/profile entries and restores the recorded effective injectIntoAgents value; an originally absent value may become explicit false and an absent profile array may become empty. It never patches mcp.enabled, which must already be enabled. Human profile preferences are preserved during rebind and may be acknowledged by reconcile; conflicting managed entries stop deactivation.
>
> SLP management operations are administrator-only and require an exclusive administrative edit window for the selected daemon. Do not edit daemon configuration through the app, another plugin, a CLI, or a file while activate, reconcile, or deactivate is in progress. The plugin serializes its own operations and verifies persisted and live results. Paseo 0.8.0 provides no compare-and-swap for these patches; this plugin cannot guarantee preservation against concurrent external writers. A detected mismatch stops automatic mutation and requires reconciliation.
>
> Plugin disable/remove is not SLP deactivation. Raw removal leaves verified stable transports operational and correctly roled, with ownership recoverable by reinstalling the same plugin ID and reconciling its retained receipt. Deactivate before removing the manager when detachment is intended. Neither lifecycle cleanup nor deactivate deletes stable runtime or launcher directories. These directories belong to the per-daemon SLP store and remain available to existing sessions; deletion requires separate maintenance authority after dependencies have ended. Provider commands and policy/helper paths must never reference managed plugin checkouts.

The existing standalone uninstall warning remains applicable to standalone installs; the added paragraphs specifically define plugin behavior. No claims of exact restoration or automatic runtime removal should be copied from the CLI into plugin UI.

## 12. Implementation assignments and handbacks

**DECISION: use the repository's Supervisor → Lead → Peer protocol with one writer per scope.** Rationale: dogfooding must follow the same authority/evidence rules it packages. Sources: `AGENTS.md:3–22,24–31`; `.paseo-slp/workspace-protocol.md:35–66,76–98`; `docs/contract.md:78–90`.

These are future assignments, not permission to start agents in this documentation task. When authorized, delegate through Paseo `create_agent`, never native Codex subagents. Read current profiles, routing catalog, repository protocol, and assignment authority. Peer does not delegate. Parallel writers require distinct worktrees and explicit non-overlapping ownership; otherwise serialize. This freeze supplies the architecture: reviewers check conformance and unresolved gates, not a new Option A/B selection exercise.

| Seat | Exclusive write scope | Required handback |
|---|---|---|
| Supervisor | Authorized governance notebook/evidence references only; no implementation files | Confirm authority, scope, live-gate authorization boundary, stable-candidate review and behavioral acceptance. No implicit install/commit authority. |
| Lead / integration owner | `plugin/shared/contracts.ts`, `plugin/index.server.ts`, `plugin/index.client.tsx`, `plugin/paseo-plugin.json`, `plugin/server/runtime/cli/binding.ts` provenance check, development dependency/scripts configuration, and final `docs/contract.md`/implementation-spec reconciliation | Publish shared schema and function interfaces first; integrate only paused peer handbacks; regenerate final payload after every runtime change; record exact candidate and tests. Never hand-edit package version/CHANGELOG release sections or tags. |
| Peer — materializer | `plugin/server/materializer.ts`, `plugin/server/generated/runtime-payload.ts`, `scripts/generate-plugin-payload.mjs`, `tests/plugin-materializer.test.mjs` | Embedded manifest, candidate/mode verification, atomic publication and fault tests. Yield generated module ownership to Lead for final regeneration. |
| Peer — launch/runtime | `plugin/server/executables.ts`, `plugin/server/launchers.ts`, `bin/slp-shim.mjs`, `tests/plugin-launchers.test.mjs` | Node/Electron resolver, real argv0 probes, immutable launch manifests, no-env and signal/stdio tests, Windows blocked status. Existing family transport behavior must remain unchanged. |
| Peer — transaction | `plugin/server/manager.ts`, `plugin/server/config-view.ts`, `plugin/server/config-transaction.ts`, `plugin/server/journal.ts`, `tests/plugin-transaction.test.mjs`, `tests/plugin-recovery.test.mjs` | Pure persisted-shape plan, durable journal, idempotency/mutex, activation/deactivation/reconcile and crash matrix. |
| Peer — helpers/UI | `plugin/client/SettingsScreen.tsx`, `plugin/server/runtime/cli/role-bundle.ts`, `plugin/server/runtime/cli/inventory.ts`, `tests/plugin-helpers.test.mjs`, `tests/plugin-ui.test.mjs` | Stable explicit-node/home helper paths, static/live provenance separation, selected-host UI/start+poll, profile preference preservation display. |
| Independent Reviewer | Read-only stable integrated candidate | Findings linked to exact files/SHAs and this spec's requirements; distinguish offline evidence from live acceptance. Reuse the review session for corrections, with a new stable candidate identity. |

No peer may opportunistically edit another lane's files. If `plugin/server/runtime/cli/package.ts`, `bin/slp.mjs`, another helper, or an existing wrapper needs a small integration change, hand back the exact requested change to Lead, who owns that additional scope only after serializing it against other writers. Existing policy Markdown remains out of implementation scope unless a separately accepted requirement demands a change.

Module seams: materializer accepts embedded payload/verified store paths and returns immutable candidate identity/path; executable resolver accepts target/explicit choices/prior receipt and returns probe results; launcher builder consumes those results and returns a verified launch-set manifest; config-view returns lossless raw/effective snapshots; config-transaction produces pure before/after plans and patch objects; journal owns all receipt I/O; manager alone owns the mutation mutex, state transitions, and connected SDK calls. The client consumes shared contracts only. Freeze these interfaces before parallel work and typecheck the integrated server/client boundary against 0.8.0.

## 13. Offline verification before any live gate

**DECISION: require offline fault and protocol tests before authorized S1/S2, then run the relevant live gates separately.** Rationale: prior fixture passes did not load a live plugin or establish behavioral acceptance. Sources: [audit](paseo-plugin-feasibility.md):398–510,586–595,686–695; `AGENTS.md:11–22`; `docs/contract.md:73–75`.

Required offline suites and assertions:

| Suite | Required evidence |
|---|---|
| Manifest / SDK compilation | Exact manifest accepted, invented keys rejected, synchronous contribution cleanup accepted, all four inputs/outputs typechecked with actual SDK, real compiler resolves only permitted directories, client bundle imports no server-only code. No fixture-only `contribute` substitute counted as SDK validation. |
| Payload / materializer | Recompute install-unit SHA and file count; compare every byte/mode; missing/extra/symlink/path-traversal/corrupt file refusal; executable mode survives restrictive umask; staging faults before/after rename; existing identical candidate reuse; no overwrite; `verifyInstall` succeeds; checkout can disappear after bundle compilation. |
| Executables / shims | Mock ordinary Node vs Electron; poisoned runtime-control env/PATH; explicit-invalid path refusal; missing family handling; shell quoting; argv0-only `--version` returns real provider version with empty provider env; no Node-version false positive; runtime tampering blocks protocol launch; grant/PASEO_AGENT_ID inheritance cannot choose another binding; native wrapper argv and byte-exact role injection preserved for four families; backpressure, exits, signals. |
| Config compatibility | Run the installed config-store/persisted-schema logic only against temporary isolated fixtures. Verify schema-loss preflight, raw presence vs defaults, 12 provider and two-profile maps, whole-array preservation, disabled MCP precondition, supported patch fields, unknown field stripping detection, mixed exact/absent adoption, no-receipt adoption disclosure, unsupported legacy collision, metadata/unrelated-profile reference refusal. |
| Transaction / journal | Inject failures at every durable phase and before/after patch settlement; disk/live divergence; dropped start response and same-ID retry; changed same-ID payload; concurrent start BUSY; old-boot interruption; no mutation during status/contribution; no blind timeout rollback; explicit complete/restore-before; journal write failure after successful patch; no hidden second patch; retain old candidate on rebind/rollback/deactivate. |
| Preferences / restoration | Rebind preserves full valid profile preferences/order; reconcile acknowledges allowed edits; deactivate rejects unacknowledged drift; originally absent injection restores false semantically; true remains true; no enabled patch; original baseline survives multiple rebinds and raw plugin removal. |
| Helpers / UI | Absolute Node/runtime/home in helper text; unmanaged CLI behavior preserved; managed inventory cannot mark static data live; wrong-home/default-CLI paths fail; two-host state isolation; start+poll and timeout/retry; compact/wide status and bounded error payloads; disable/remove differs from deactivate. |
| Existing regression suite | Run current `node --test tests/*.test.mjs` and identity checks on the integrated candidate; report actual results including skips. Do not freeze a future pass count at the audit's 133. |

Existing `.local-checks/plugin-followup-*.test.mjs` and `.local-checks/plugin-candidate-roundtrip.test.mjs` are supporting evidence, not the production test suite. Keep the audit's 12/12, 33/33, and 11/11 in their original fixture/evidence scopes. Do not relabel them full E2E or three runs of the new candidate. The implementation's own tests must exercise the actual manager/dispatcher, not mirror a verdict classifier.

**DECISION: live execution requires `pluginsEnabled` and explicit task authority on an isolated daemon.** Rationale: these capabilities and trust changes have not been accepted as part of authoring or ordinary offline implementation. Sources: [audit](paseo-plugin-feasibility.md):398–510,769; `AGENTS.md:15–22`.

| Gate | Option A v1 execution and acceptance |
|---|---|
| S1 | Authorized Git install and selected-host RPC; raw/effective target verification; add/verify provider/profile persistence; MCP-disabled refusal; collision and recovery; demonstrate accepted exclusive-edit limitation and conflict detection without claiming concurrent-writer preservation. |
| S2 | Real revision A role session; update plugin to B and remove A checkout; old session continues; explicit B rebind gives new session B bytes; failed B/reconcile restore leaves A usable; no checkout paths in commands/helpers. |
| S3 | **Not applicable to Option A.** Pure-hook experiment stays unrun; do not count it as passed or silently add B0 implementation. |
| S4 | **B2 experiment not applicable.** Its generally applicable shim lessons are required here: all four families' no-env availability/version/catalog/admin/draft surfaces and native role transport must work. Do not add grant issuance or discovery allowlists. |
| S5 | Explicit deactivate and semantic restoration; unrelated/profile edits; changed ownership refusal; routing untouched by plugin; raw remove retains correctly roled stable launches; reinstall same ID recovers retained receipt. |
| S6 | Actual role agents run stable helpers against intended daemon/repository and candidate; provider inventory provenance, complete bindings, native-handle/inspection coverage, and authority remain correct. |
| S7 | Compact/mobile and desktop, dark/light, two connected daemons, remote filesystem selection, manifest compatibility, operation timeout/poll behavior, and filesystem permission/platform qualification. |
| S8 | Read and follow `skills/paseo-slp-e2e/SKILL.md` and `e2e/workspace-protocol.md`; execute the authorized manifest from that session. Baseline is 48 scenarios including 12 resume combinations. Report every scenario as pass/fail/blocked/unrun against the actual new candidate; local tests and process survival alone do not establish role behavior. |

The first live milestone remains the isolated S1/S2 probe, followed by S5–S8. S3 and B2-specific S4 stay explicitly out of v1 acceptance. A full SLP E2E assignment still requires the whole current manifest; the implementation must not reduce it to the cases convenient for the plugin.

## 14. Open questions and release gates

**DECISION: unresolved host observations are explicit gates, not alternative architectures or silent fallbacks.** Rationale: the accepted audit distinguishes source/fixture feasibility from live qualification. Sources: [audit](paseo-plugin-feasibility.md):398–510,595,634,684,769.

`BLOCKER` below means the affected host/platform cannot be declared usable until the stated check passes; it does not prohibit implementing the frozen offline design. `RUNTIME-VERIFY` means implement the specified behavior now and collect the named live evidence before release.

| ID / class | Remaining observation | Required evidence / fixed response to failure |
|---|---|---|
| Q1 — BLOCKER, target host | Can the administrator establish that the selected connection owns the supplied canonical home, and can the plugin read that exact raw config? The SDK provides no automatic home proof. | S1/S7 with isolated distinct homes and selected-host identity/config evidence. Refuse activation without the mapping/readability; no default-home inference or API-only presence claims. |
| Q2 — BLOCKER, target host | Can the real plugin subprocess write, chmod, flush, and rename in `<home>/slp-runtime`, outside `plugin-settings`? Ordinary Node filesystem code in a fixture is not proof of live host permissions. | S1/S2 write/read/mode/rename exercise in the authorized isolated home, including compiled payload size. Return explicit IO/platform conflict on failure; do not move receipts into removable settings or request a different architecture. |
| Q3 — BLOCKER, target host | Is a stable ordinary Node in `>=22.18.0 <23.0.0 || >=23.6.0` resolvable under the actual daemon/Electron environment, and are required family executables available? | S1/S2 sanitized probes and real argv0-only family probes. Require an explicit Node path or show unavailable families; never embed Electron or install a runtime automatically. |
| Q4 — BLOCKER, Windows only | `.cmd` quoting/exit/signal behavior, portable candidate paths, and permission representation have no native validation here. | Native offline tests plus isolated S2/S7 before enabling Windows. Until then return `UNSUPPORTED_PLATFORM`; POSIX qualification remains independent. |
| Q5 — RUNTIME-VERIFY | Exact effective RPC/IPC payload limits and latency under a real selected-host connection are not established by the SDK's `unknown` input type. | S1/S7 start/status near the 64-KiB application bound and a deliberately slow worker; confirm timeout/poll/idempotency. Payload bytes never travel in these RPCs. Reduce bounded summaries if needed without changing transaction semantics. |
| Q6 — RUNTIME-VERIFY | Four-family version/discovery/admin/draft and real session transport through the shim, including provider environment omissions. | S1/S2 plus A-applicable S4 observations and S8; capture actual native instruction input, not just process exit. Reject unqualified provider/platform paths. |
| Q7 — RUNTIME-VERIFY | Full active-session behavior through rebind/remove and helper reachability after old checkout deletion. Source establishes client retention, not full behavior. | S2/S5/S6/S8 with real old/new sessions and candidate-correlated evidence. Retain both runtime and launcher sets. |
| Q8 — RUNTIME-VERIFY | Interrupted live patches, post-write receipt failures, reload/remove timing, and operator-established quiescence. | S1/S5 crash drills on the isolated daemon. Ambiguous outcomes remain RECOVERY_REQUIRED until quiescent and verified; no new CAS research or force overwrite. |

Completion handback must identify the exact source revision, dirty-file status, embedded candidate/payload/launch identities, actual offline results, every applicable live gate's evidence or blocked/unrun reason, and remaining platform limits. The user-facing claim is “Option A manager implemented and qualified on the recorded host/platform” only after those checks; B2 remains experimental.

## 15. Errata — spec-author rulings (round-3 review, binding)

Corrections and approved deviations recorded by the spec author (Astra
`955229e6`) during the round-3 spec-author review of candidate `dc28fe78`.
These rulings are binding on the implementation; each entry names the clause
it amends and the exact approved scope.

### 15.1 §8.4 — foreign-boot `PATCH_OUTCOME_UNKNOWN` gate (approved narrow exception)

The implementation blocks `reconcile complete`/`restore-before` at admission
only when the interrupted operation shares the current `bootId` and still has
a `pending`/`outcome-unknown` patch attempt (`manager.ts` same-boot gate).
This is an approved **narrow** exception grounded in the host's closed
lifecycle (`S/session.js:1668` — `config.patch` executes synchronously inside
the daemon; `S/runtime.js:774` — plugin shutdown waits for the worker to
close): a same-boot pending attempt is the only case where "the original call
may still be running" is possible, and a foreign-boot pending attempt means
the caller is dead so the daemon-side outcome is already determined —
classification resolves it, and an unresolvable outcome lands
`RECOVERY_REQUIRED` (which is "recovery blocked" under §602).

This is recorded as an erratum, **not** as verbatim §8.4 compliance. No
general claim is made that a foreign boot is self-proving safe: the exception
holds only under the host-0.8.0 synchronous-patch/closed-lifecycle evidence
above, and recovery remains blocked whenever classification cannot resolve
the outcome.

### 15.2 §6 — managed launches do not inherit `NODE_OPTIONS` (approved deviation)

Generated launcher scripts emit `unset NODE_OPTIONS` before `exec`, so the
shim's own Node boot cannot be influenced by an inherited `NODE_OPTIONS`
(e.g. `--require <path>`). The shim's existing sanitization already covers
its children; this extends the same protection one level up to the process
that launches the shim. Recorded as a deliberate addition to §6's
runtime-control clearing contract.

### 15.3 §4 vs §5.6 — publication ordering (clarifying erratum)

§4's "record immutable candidate and launcher directories in the journal
before publishing them" is clarified to distinguish **intent-before-mutation**
from **result-after-mutation**: §5.6's order stands — the candidate and
launch set are generated and published first, then the `materialized` phase
records both identities in the journal. A published-but-unjournaled directory
is content-addressed, reusable, and never treated as proof of activation;
the journal's `materialized` record is the durable result write, not the
activation intent.
