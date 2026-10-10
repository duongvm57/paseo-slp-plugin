# CLI reference

The `slp.mjs` CLI ships in both the source checkout and the materialized
runtime. Use `node bin/slp.mjs <command>` in a checkout, or
`node "$SLP_RT/bin/slp.mjs" <command>` for the installed runtime. `SLP_RT`
is the active binding's `runtimePath` on the SLP screen (also recorded in
`<paseoHome>/slp-runtime/state/receipt.json`). An installed-runtime failure
reports that receipt's concrete CLI path when available; missing, malformed
or unusable guidance keeps the generic installation hint. This lookup is
read-only and does not verify or select a runtime for execution.

| Command / mode | Needs this CLI's installed runtime? | Works from a source checkout? |
|---|---|---|
| `prepare`, `prepare-handoff` (plan or `--emit create`, including `prepare --live`) | Yes | No; run the installed CLI |
| `prepare --check`, `prepare-handoff --check` | Install verification is a check | Yes, but the install check fails and exit is 1 |
| `prepare --schema`, `prepare-handoff --schema` | No | Yes |
| `monitor`, `record-build` (including `--schema`) | No | Yes |
| `identity`, `snapshot`, `review-packet`, `records`, `verify-handback` | No | Yes |
| `routes`, `route-decide` (including `--schema`), `inventory`, `agents`, `notebook`, `status`, `local-target` | No | Yes; relevant daemon files/configuration are still needed |
| `instructions` | No for a source preview | Yes; a managed render needs its binding environment |
| `init`, `materialize`, `install` | No | Yes |
| `upgrade`, `uninstall`, `verify` | No for the invoking CLI | Yes; the previous/target directory must be installed |
| `desk-recover` | No | Yes; targets the selected home's desk state |

`prepare`, `prepare-handoff`, `route-decide`, `monitor` and `record-build`
accept `-` instead of a request filename to parse JSON from stdin. `records`
also reads report text from `-`.
The parser accepts `-` as a positional target for every command; only these readers interpret it as stdin.
For example:

```bash
printf '%s\n' '{"agents":[{"id":"agent-id"}],"paseoHome":"/absolute/paseo-home"}' | node bin/slp.mjs monitor -
node bin/slp.mjs monitor --schema
node bin/slp.mjs record-build --schema
```

`--schema` takes no positional request; it prints required and optional keys,
types and value constraints without an installed receipt or daemon. CLI
exceptions with a code print `CODE: message` on stderr; ordinary exceptions
print their message. Most failures exit 1; `desk-recover` usage errors exit 2.

Read commands do not grant acceptance or launch authority. `--out` writes a
response file, `monitor` writes a checkpoint when `stateFile` is supplied, and
`desk-recover` performs operator recovery immediately. Installation and
workspace setup commands are dry-run until `--apply`. Setup context is in
[operations.md](operations.md#repository-setup).

## Provider model discovery (plugin RPC)

The Manager plugin exposes `catalog`; the offline `slp.mjs` CLI has no
`call catalog` command. Consumers invoking that RPC can send:

```json
{"schemaVersion":1,"family":"devin","role":"peer","modelPrefix":"swe-2"}
```

`modelPrefix` is an optional, case-sensitive literal model-id prefix of 1–256
characters. It reduces the response's `models` list in host order, retaining
labels, `thinkingOptions` (including option metadata/default markers) and
`defaultThinkingOptionId`. Omit it for the full inventory. No match returns
`models: []`; modes, features and errors stay intact. The separate `model`
field still selects the feature draft, regardless of the prefix.

Devin responses include advisory `modelConstraint.pattern` (`^swe-2($|-)`)
and `modelConstraint.description`, so a consumer can check the package's
necessary model restriction before writing a profile or enabling a pool
option. Other families currently omit it. A model matching this pattern is
not proof of availability, transport eligibility or write acceptance. For
example, the literal prefix `swe-2` also matches `swe-20`; check the constraint
as well. Write guards remain authoritative.

For compact presentation of an RPC response already saved as `catalog.json`,
this recipe keeps the discovery hint and thinking metadata:

```bash
jq '{modelConstraint, error, models: [.models[] | {id, label, thinkingOptions, defaultThinkingOptionId}]}' catalog.json
```

This is response-file processing, not a new CLI flag. The
[catalog contract](contract.md#provider-catalog-discovery) defines the wire
behavior for both snapshot and legacy hosts.

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

`prepare <request.json|-> --live [--paseo-home <absolute-home>]` is an
explicit saved-profile preparation for `supervisor` or `lead`. The request
must omit `binding`, `providers`, `profiles`, `inventoryFile` and `route`.
The command reads saved profiles from the selected home's `config.json`,
checks `paseo daemon status --home <home> --json` for that home's running,
reachable daemon, then lists providers through the reported `--host` endpoint.
It refuses configured fallback and a changed profile file during observation.
`--live` can accompany `--check` or `--emit create`; it cannot accompany
`--schema` and is not accepted by `prepare-handoff`. It prepares arguments
only and creates no agent. Home resolution follows `--paseo-home`, then the
managed binding when managed, otherwise `PASEO_HOME` or `~/.paseo`.

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

## Bound seat formation

`slp_seat_create` is a desk MCP tool, not a CLI command. Peer runtime may be
omitted; server-side selection is described in [operations](operations.md#ordinary-peer-formation-through-the-desk).
Use `selection: {optionId}` for an independent pick or an existing full runtime
pin, never both. The spawn kit exposes both optional arguments. A choice response
is unadmitted, not a successful create. After admission exact replay never calls
Jev or resumes effects. `prepare`/`--check`/handoff preparation remain offline
and still require explicit Peer pool pins; the new selector is not run by them.

Placement is a desk argument, not a CLI repository/catalog override. Both
roles accept caller or existing (workspaceId and/or absolute cwd, reason).
Existing worktrees share the bound Git-common-dir; foreign/nested repos refuse.
Source routing/protocol and target execution cwd are pinned separately inside
the server; CLI prepare still uses its own repository and cannot supply that
trusted context or route.catalogFile. New worktree: use Paseo create_workspace
under its host-setup grant, then slp_seat_create placement existing; the desk's
kind=worktree branch returns a gap before effects. Pending keeps the child ID
and evidence without runnable delivery; replay never repairs or recreates it.

## `route-decide`

`route-decide <request.json> [--schema] [--out <path>] [--paseo-home <absolute-home>]`
is the CLI path
that calls routing Jev (the admitted slp_seat_create executor also invokes it) — see [Jev-assisted routing](operations.md#jev-assisted-routing-optional)
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
node bin/slp.mjs monitor --schema
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

## `record-build`

`record-build <request.json|-> [--out <path-outside-repo>]` measures inputs
and prints one fenced v1 handback record. `record-build --schema` prints the
strict request contract directly from the source checkout. Example request:

```json
{
  "repository": "/absolute/repository",
  "seat": {"role": "peer", "disposition": "engineer", "agentId": "agent-id"},
  "verdict": null,
  "checks": [{"cmd": "npm test", "exit": 0, "outputFile": "/absolute/check-output.txt"}]
}
```

`repository`, `seat`, `verdict` and a nonempty `checks` array are required.
`seat.agentId` is optional (nonblank string or null); role and disposition
are nonblank strings. `verdict` is null or one of the handback verdicts
printed by `--schema`. Each check requires a nonblank `cmd`, integer `exit`
and absolute `outputFile`; unknown request, seat and check keys are refused.
The command does not execute `cmd` or independently observe its exit code.
It hashes the exact output bytes and snapshots the repository. Evidence
inside the real repository becomes a repository-relative `outputRef`;
external evidence is inline `output` (valid UTF-8, at most 64 KiB). Missing,
unreadable or non-regular evidence fails rather than producing a null sha.
Supplying `sha`, `output` or `outputRef` is refused: they are derived.

The generated record passes the shared validator before output. A filename
request must be a regular file; `-` explicitly selects stdin. `--out` must be
outside the repository after following symlinks and be a new path or an
existing regular file; it writes the emitted fence. Failed validation emits
no record. `slp_handback_submit.recordV1` takes the **bare JSON object inside
the fence**, not the Markdown fence, a JSON string, or the request object.
Offline generation does not submit a handback or accept its claims.

## `review-packet`

`review-packet <absolute-repo> --base <git-ref>
[--since <earlier-candidate-dir|snapshot.json>]
[--evidence <absolute-file>]... [--out <path-outside-repo>]` emits a
facts-only `slp-review-packet` JSON object. It contains the current HEAD,
snapshot hash and file count, the resolved base commit, tracked changes and
untracked non-ignored files against that base, and insertion/deletion totals.
`--since` adds an added/removed/modified path comparison against an earlier
candidate directory or saved `snapshot` JSON. Repeatable `--evidence` adds
path, SHA-256 and byte count for each file; its contents are never interpreted.
The packet contains no verdict, writer attribution or review finding.

Unknown bases and missing inputs fail with exit 1 and no packet. Evidence
must be regular files; `--since` must be a directory or regular snapshot file.
Tracked special files in the measured tree are refused before snapshotting.
`--out` must resolve outside the repository, including dangling/chained
symlink targets, and be a new path or existing regular file. Path checks
precede writes and do not cover a path changed between check and write.
Without `--out`, this command is read-only.

## `verify-handback`

```bash
node bin/slp.mjs verify-handback /absolute/report.md \
  --repo /absolute/repository \
  --expect-contract .paseo-slp/workspace-protocol.md=<sha256> \
  [--expect-file <repo-relative-path>=<sha256>]... \
  [--expect-runtime <candidate-sha256>] \
  [--paseo-home <absolute-home>] \
  [--expect-parent <agent-id>] [--expect-workspace <workspace-id>]
```

The report path, `--repo` and `--expect-contract` are required. Pin hashes
are lowercase 64-character SHA-256 values; pin paths are repository-relative.
The command measures against the caller's `--repo`, never a record-declared
root. It extracts/validates the handback, captures bounded before/after
snapshot and Git status observations, hashes the contract and optional file
pins, and observes the claimed seat in the selected home's daemon files.
`--expect-runtime` compares this package's measured candidate hash; without
it runtime comparison is `report-only`. A bare `--paseo-home` resolves the
normal managed/default home, just as omission does.

Output is a `slp-verify-handback` JSON view with comparisons, gaps,
limitations and a completeness ledger. A successfully produced view exits 0
even when claims mismatch or are incomplete: inspect the view. Invalid
inputs or operational failures exit 1 with `INVALID_REQUEST`, `IO_FAILURE`
or `CAPABILITY_GAP`. This read-only command never re-runs checks, proves
writer quiescence or grants acceptance.

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

Fences must start at column 1: the opening line is exactly
three backticks immediately followed by `slp-record`,
and the closing line is three backticks; either may have trailing whitespace.
Indented fences, tildes and extra text after the language tag are not
recognized. The parser splits on LF and removes a trailing CR from each
line, so CRLF is tolerated; it preserves the original fence bytes for
rendering. Inside the fence is one JSON object. The **last record of each
kind in a document is authoritative**: selection uses the last parsed record
of each recognized kind, even if schema validation fails; earlier
blocks remain inspectable, and multiple blocks of a kind produce a warning.
Validation errors from earlier blocks still make the command fail.

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

## `instructions`

`instructions <supervisor|lead|peer>` prints the raw role-bundle instruction
bytes to stdout; role, root and managed/source-preview provenance go to
stderr. A source render is a preview of this tree. A managed render needs
its `SLP_*` binding environment and reads current communication-language
state, as the role wrapper does. The command neither installs a role nor
proves what a live shim delivered.

## `init`

`init <absolute-repo> [--routing-from <absolute-json>] [--apply]` stages
`.paseo-slp/workspace-protocol.md` from the package template and a Supervisor
notebook scaffold. Only an explicit, validated `--routing-from` import adds
`.paseo-slp/slp-routing.json`; otherwise the user-scope Peer pool remains the
fallback. Existing target files are preserved. The default response reports
paths, preservation and proposed byte hashes; `--apply` writes missing files.
It does not configure the daemon, install skills or launch seats.

## `install` / `upgrade` / `uninstall` / `verify`

```bash
node bin/slp.mjs install [absolute-dir] [--paseo-home <absolute-home>] [--apply] [--reload]
node bin/slp.mjs upgrade <absolute-new-dir> --from <previous-installation> [--apply] [--reload]
node bin/slp.mjs uninstall <absolute-dir> [--apply] [--reload]
node bin/slp.mjs verify <dir>
```

`install` defaults to `SLP_HOME`, otherwise the platform data directory
(`$XDG_DATA_HOME/paseo-slp` or `~/.local/share/paseo-slp` on Linux).
Without `--paseo-home` it materializes package bytes and `installed.json`;
an intact standalone installation can be updated in place. With
`--paseo-home` it also binds role providers, saved profiles and the two MCP
flags in that home's configuration, recording `paseo-binding.json` for
verification/restoration. It preserves existing preferences and refuses
conflicting owned entries. This is the CLI installation path; plugin
activation is a separate workflow.

`upgrade` requires a Paseo-integrated previous installation and a new
absolute destination outside it. It rebinds the previous home's configuration
to the new runtime and retains the previous directory for running sessions.
`uninstall` detects a Paseo binding, verifies owned configuration before
restoring it and removing the runtime, and refuses extra runtime files or
modified owned entries. These three commands are dry-run until `--apply`.
`--reload` requires `--apply` and a Paseo-integrated installation; it calls
Paseo at the selected home's recorded endpoint. Applied files may still
require restart or a manual reload, reflected in the result and exit 1.

`verify` is read-only: it compares installed package bytes against
`installed.json` and checks the optional binding-file hash. It prints the
manifest on success and exits 1 for a missing receipt, incomplete payload or
drift. It does not establish provider health or E2E acceptance.

## `desk-recover`

`desk-recover <repository> [--paseo-home <absolute-home>] [--json]` resolves
the repository's canonical Git common directory to the desk namespace.
`desk-recover --bridge [--paseo-home <absolute-home>] [--json]` targets the
bridge sentinel lock instead; a repository and `--bridge` are mutually
exclusive. This is an operator recovery command: it may remove a lock only
when the shared recovery algorithm proves its holder dead, appending audit
evidence before removal. A live holder, uncertain identity or invalid lock
is preserved; there is no force flag and no process is killed. Unlike setup
commands it has no `--apply` mode and may mutate desk recovery files on
invocation. Use it under the current recovery authority.

Text output includes result, PID, nonce, actor/repository keys and recovery
details. `--json` emits the strict recovery output object on one line. Exit
0 means `recovered` or `no-lock`, exit 1 means a rejected/failed outcome, and
exit 2 means a usage error (including a non-repository target).


For ordinary SDK formation, a linked Lead with no local routing/protocol uses
its configured same-Git main checkout as a pinned source, including its own
Peer delegations. The execution cwd remains the qualified target. A missing
trustworthy source refuses formation; the CLI itself does not discover host
placement or accept trusted-context/catalogFile overrides. New-semantic
seat-pending results name slp_operation_get with the same requestId; receipt
reads do not resume or create a replacement. Legacy omitted full-pin Peer/Lead
requests retain their old delivery path.
