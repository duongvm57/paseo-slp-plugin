# CLI reference

The offline `slp.mjs` CLI ships inside the materialized runtime:
`SLP_RT="$HOME/.paseo/slp-runtime/<candidate-sha256>"` — the active binding's
`runtimePath` on the SLP screen. Every command is read-only or dry-run unless
it takes `--apply`. Setup commands (`init`, repo-pinned catalogs) are in
[operations.md](operations.md#repository-setup).


## `prepare` / `prepare-handoff`

The optional offline path: `prepare` accepts role, repository, workspaceId
and assignment. Supervisor/Lead additionally take the `profiles`/`providers`
inventory; a Peer takes `providers` and `route: {optionId, catalogSha256}`
from `routes`. Profiles may accompany a Peer request for discovery, but they
never replace the pool. The [mixed-Peer request](../examples/mixed-peer.request.json)
is a template: replace its paths/hash and the entire illustrative `providers`
array with the current daemon's live `list_providers` array, preserving every
returned field. Example availability values are not launch evidence.
Three more optional fields, all also honored by
`prepare-handoff`:

- `inventoryFile`: absolute path to a JSON object carrying
  `providers`/`profiles`; these arrays only fill request fields that are not
  inline — an explicit inline array (even `[]`) always wins. Generate it with
  `inventory --paseo-home <absolute-home>` (below); under a managed runtime
  its providers are `provenance: "configured"` and are refused as launch
  evidence — pass live `list_providers` output from the same daemon inline as
  `providers` instead.
- `assignmentFile`: absolute path to the full assignment brief (must exist,
  be a regular file and be readable). By default, the prompt keeps
  `assignment` as a short brief and appends `Assignment file: <path> — read
  it first; it is authoritative for scope details.`; the file content is not
  inlined.
- `assignmentFileMode`: optional `pointer` (default, byte-for-byte current
  prompt behavior) or `snapshot`. Snapshot mode is opt-in per prepare request:
  supplying this field without `assignmentFile`, or using another value, fails
  with `assignment-snapshot-invalid-mode`.
  Prepare resolves symlinks in both the repository and file paths. The real
  file target must remain inside the real repository and be a regular file;
  symlinks escaping the repository are rejected. Prepare reads at most 16 KiB,
  strictly decodes UTF-8, removes a leading BOM,
  normalizes CRLF/CR to LF, and rejects control characters, nested markers and
  credential-shaped text or repository-relative provenance paths. It replaces
  the generated pointer with an
  `Assignment snapshot:` provenance line (repository-relative path, SHA-256
  and normalized byte count), sentinels and the normalized inline text. Any
  validation or read error fails prepare; it never falls back to pointer mode.
  `prepare-handoff` uses the same behavior. The daemon never reads this file;
  the snapshot is the brief text it already receives and may assess under the
  existing supervision route. Snapshotting puts that bounded text in the
  launch prompt and host timeline, so the Lead must choose an appropriate file;
  the pattern-based credential guard does not identify ordinary passwords.

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
[handoff example](../examples/provider-handoff.request.json).
Both commands only prepare arguments; Supervisor/Lead use Paseo to actually
create the agent.

An optional `handoff.recapInputs` supplies structured assignment/authority,
decisions, assumptions, unresolved items, owner/dependency pins, report artifacts
and resources. The packet retains the required free-text `handoff.state` and
adds a recap alongside the freshly measured candidate. Missing sources and
candidate mismatches remain visible; legacy free text is not mined for facts.
Reported checks and settlement stay claims. Preparation never transfers
ownership, acknowledges receipt or changes an agent's lifecycle.

Native `slp_assignment_offer` / `slp_assignment_accept` are separate desk
operations. A preparation recap does not substitute for their exact membership
and revision checks or durable acknowledgment. See [assignment continuity](work-continuity.md).

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
briefs use `assignmentFile` — a separate file per seat. Pointer mode keeps the
read-first reference; when supervision needs an observable brief, the Lead may
explicitly select `assignmentFileMode: "snapshot"` to inline its validated,
bounded content. Before any create_agent call, Lead records why the chosen
topology (which seats, which pool options) fits the assignment — under armed
Jev routing that reason trail is the decision receipt's distribution, not
prose.

## `route-decide`

`route-decide <request.json> [--schema] [--out <path>] [--paseo-home <absolute-home>]`
is the only path
that calls Jev — see [Jev-assisted routing](operations.md#jev-assisted-routing-optional)
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

## `routes`

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

## `inventory` / `agents`

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

## `snapshot`

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

## `materialize`

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

## `monitor`

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

## `notebook`

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

## `records`

`records <path|-> [--kind handback|settlement] [--require handback|settlement]
[--repo <absolute-path>]` extracts and validates `slp-record` blocks; `-` reads
stdin. `--schema` prints the v1 JSON Schema and takes no report path:

```bash
node "$SLP_RT/bin/slp.mjs" records /absolute/report.md --require handback
node "$SLP_RT/bin/slp.mjs" records --schema
node "$SLP_RT/bin/slp.mjs" records --render /absolute/report.md
```

`--kind` filters returned records only; errors and warnings still cover the full
report, and any error keeps the command's exit status non-zero. For `outputRef`,
`--repo` is the verifier's authoritative root and overrides record-declared
roots. Without it, the per-check candidate repository takes precedence, then
the record candidate. See
[handback and settlement records](../src/references/report-records.md) for the
record contract.

A handback may include an optional `slp-report` version 1 for execution,
review or Lead adjudication. Selecting it requires meaningful purpose-specific
content, including unfinished work or mandate/findings and unresolved decisions.
Legacy v1 records remain valid. `--render` emits the structured narrative plus
the original fenced evidence block without reserializing it. Reported `read`,
`ran`, candidate and checks remain claims; rendering establishes no execution
or acceptance. Use structured reports when the current runtime's
`records --schema` advertises `slp-report`, and rendering when its CLI usage
advertises `--render`. Older retained candidates may support only the legacy
v1 envelope; their lack of these optional modes does not invalidate it.

## `status` / `local-target`

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
