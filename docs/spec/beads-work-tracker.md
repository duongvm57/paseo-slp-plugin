# Beads work tracker — implementation spec

Status: implemented per §12 on `feat/beads-work-tracker` — pending §11 Human
confirms and the §9 real-`bd` verification (`bd` not installed on the
implementation machine).
Written 2026-09-23 against `main` at `bfbc979`, Paseo 0.8.0 SDK declarations
and the primary-source report [beads-research.md](../reports/beads-research.md).
Supersedes the multi-adapter direction of
[beads-slp-integration.md](../reports/beads-slp-integration.md) §4; its §3
boundary rules still apply and are restated in §3 below.
Items marked **[confirm]** are proposed defaults the Human confirms before
merge; items marked **[verify]** need a real `bd` binary (§9).

## 1. Goal

Give SLP seats an optional, durable work graph — beads (`bd`) — so Supervisor,
Lead and Peer query task state (issues, assignees, dependencies, comments)
instead of rebuilding it from conversation, and survive resume/compaction by
reading it back.

Beads is the only tracker. There is no multi-tracker adapter layer: a future
external source (Backlog, GitHub Issues…) is an **intake** into beads, not a
second tracker (§10).

**Primary acceptance criterion:** with the tracker disabled in SLP settings,
every SLP path behaves exactly as it does today (§7).

## 2. Approach A — detect, never install

The plugin and package **detect and verify** a Human-installed `bd`; they never
download, install, initialize, upgrade or configure it. This matches the
existing rules: `plugin/server/executables.ts` ("no login shells, version
managers or installs") and `plugin/server/materializer.ts` ("no runtime fetch").

| Concern | Owner |
|---|---|
| Install `bd` on the machine (`brew install beads`, `npm i -g @beads/bd`, upstream `install.sh`) | Human |
| Initialize a repository (`bd init --skip-agents --skip-hooks` **[verify]**) | Human or authorized onboarding |
| Enable/disable the tracker per daemon | Human, SLP manager card |
| Detect `bd` on PATH, report version/workspace, surface gaps | package + plugin |
| Seat identity env, session-entry pointer, policy reference | package + plugin |

Why not bundle or auto-install: plugin-managed downloads are a new network +
install capability (contract change), every upstream release would need a
plugin release, and the platform matrix grows. Version consistency is still
achieved: all seats on one machine run the same `bd` from the shared PATH.
Operational note for docs: upgrading `bd` migrates a repository's beads DB in
place on first use and older binaries then refuse it (research §1 "Schema
version guard") — upgrading `bd` is a migration decision.

Relevant upstream facts (research §1, §8): release binaries are CGO-built
(embedded mode) on linux/macOS amd64+arm64 and windows amd64; embedded mode
needs no daemon; beads telemetry is opt-out (`BD_DISABLE_METRICS=1`).

## 3. Boundaries (normative, all phases)

1. **Evidence, not control plane.** Paseo alone owns lifecycle, parentage,
   placement, notifications and report routes. Tracker state never creates,
   wakes or retires a seat.
2. **Authority is the assignment.** A claim/assignee grants no write scope,
   commit, push or external action; a claim without a matching assignment is
   drift evidence.
3. **Orchestrator-push.** Owners assign, assignees transition. A Peer never
   self-assigns with `bd ready --claim`.
4. **Review gates stay SLP gates.** Tracker status never discharges a required
   gate.
5. **Status is a recorded claim, not proof.** Acceptance still requires
   artifact, candidate identity and checks.
6. **Missing or broken tracker is a gap, never a crash or a block.**
7. **No installation side effects.** Nothing in SLP runs `bd init`,
   `bd setup`, `bd hooks install`, `bd dolt push`/`bd sync` or edits beads
   config without explicit authority.

## 4. Setting

- File: `<daemonHome>/slp-runtime/state/work-tracker.json`

  ```json
  { "schemaVersion": 1, "tracker": "beads", "enabled": true }
  ```

- Sole writer: the manager surface via `set-work-tracker` — atomic whole-file
  write, mode 0600, same class as `jev.json` / `communication-language`
  (plugin-owned state: no journal, no mutex, no authority gate).
- **Absent file = disabled. [confirm]** Upgrading SLP must not change the
  behavior of existing installations; enabling is one toggle.
- Unparseable or foreign-shape file = disabled **plus a surfaced gap** (card
  error; one gap line in session-entry instructions). Never blocks a spawn.
  Non-ENOENT filesystem errors propagate, as for the language file.
- Takes effect at the next session entry; no re-activation (same as language).

## 5. Package changes (`src/`, `bin/`)

### 5.1 `plugin/server/runtime/cli/work-tracker.ts` (CLI adapter)

| Export | Behavior |
|---|---|
| `WORK_TRACKER_FILE` | `'slp-runtime/state/work-tracker.json'` |
| `readWorkTrackerSetting(daemonHome)` | → `{ enabled, error }` per §4 |
| `findBd(env)` | first executable `bd` in **absolute** PATH entries, in order; relative entries skipped |
| `probeWorkTracker(repo, { daemonHome?, env?, run? })` | read-only: `bd version`, `bd where --json` with `cwd=repo`, env forced `BD_DISABLE_METRICS=1`, 5 s timeout, 64 KiB buffer. Returns `{ tracker:"beads", repository, enabled (null without home), state: "ready"\|"uninitialized"\|"unavailable", bd:{path,version}\|null, workspace:{path,prefix,redirectedFrom}\|null, gaps[] }`. Never throws for a missing/broken tracker. `run` is the test seam. |
| `workTrackerBlock(daemonHome, { cli, policyDir, shq })` | `''` when disabled; one gap line when unreadable; otherwise one line: tracker enabled, read `<policyDir>/references/work-tracking.md` before tracked work, run `<cli> tracker <repository> --paseo-home <home>` first, unavailable/uninitialized = gap and continue |

`bd where --json` field names (`Path`, `Prefix`, `RedirectedFrom`) and the
`bd version <semver> (…)` format are **[verify]**.

### 5.2 `bin/slp.mjs`

New command `tracker <repository> [--paseo-home <home>]` → prints
`probeWorkTracker` JSON; exit 0 even when the state is not `ready` (gaps are
data). Add to `commandFlags`, `targetArg` and the usage string.

### 5.3 `plugin/server/runtime/cli/role-bundle.ts`

In `roleDelivery().entry()`, for **managed** sessions only, append
`workTrackerBlock(...)` after the communication-language line and before the
assignment line. `anchor()` (ACP re-anchor) is unchanged — the block is an
entry-time helper like `managedHelpers`. Unmanaged renders never read daemon
state.

### 5.4 `src/references/work-tracking.md` (new, conditional)

Opens with: read only when session entry says `Work tracker: beads (enabled
in SLP settings)`; otherwise ignore. Content:

- Availability: run the probe first; `unavailable`/`uninitialized` = record
  gap once, continue without tracker; §3.7 prohibitions; always `--json` when
  output feeds a decision.
- Boundaries: §3.1–3.5.
- Writers (one writer per scope):

  | Scope | Writer |
  |---|---|
  | Root issue for a Human task or intake item | Supervisor, or Lead when no Supervisor is assigned |
  | Child issues, dependencies, assignment of children | Lead |
  | Status, comments, discovered work on the issue an assignment names | that assignment's seat |

- Identity: if `BEADS_ACTOR` is unset (e.g. Devin seats, §8), pass
  `--actor slp-<role>-<agent id>` on every write.
- Procedure **[verify command syntax]**:
  - Root owner: `bd create … --json`; intake items carry
    `--external-ref <source>:<key>` + label `intake`, looked up first with
    `bd search --external-contains <source>:<key> --json`; name the root ID in
    the assignment.
  - Lead: `bd create … --parent <root>`, `bd dep add <dependent>
    <prerequisite>` (dependent first), `bd assign <id> slp-peer-<id>`,
    `bd ready --json`, `bd dep tree <root>`, `bd list --assignee … --json`;
    `must_ask` → `bd gate create --type human --blocks <id>` (only the Human
    resolves it).
  - Assigned seat: `bd show <id> --json` → `bd update <id> --claim` (conflict
    = report, never force); `bd comments add <id> …`; out-of-scope work →
    `bd create … --deps discovered-from:<id>` + report; `bd close <id>
    --reason …` only when the assignment makes closing theirs.
- Recovery/handback: rebuild from `bd show <root>` + children after
  resume/compaction (does not replace Lead checkpoint or Supervisor notebook);
  a lapsed lease / `bd reclaim` is a signal — verify owner settlement through
  Paseo before reassigning; every report/handback names all open issue IDs;
  settlement = no claimed-but-abandoned issue, every gate resolved or handed
  off.

### 5.5 Not changed

`src/roles/*.md`, `src/common.md`, `src/delegation.md`, `plugin/server/runtime/cli/launch.ts`,
`prepare`/`prepare --check`/`prepare-handoff` output, routing, Jev, monitor.

## 6. Plugin changes (`plugin/`)

### 6.1 Contracts (`plugin/shared/contracts.ts`)

- `WorkTrackerConfig = { schemaVersion: 1, tracker: "beads", enabled: boolean }` (strict).
- `WorkTrackerView = { configured: boolean, enabled: boolean, error: string|null, bd: { path, version } | null, bdError: string|null }`.
- RPCs: `get-work-tracker` `{schemaVersion, target}` → `{schemaVersion, workTracker: WorkTrackerView}`;
  `set-work-tracker` `{schemaVersion, target, enabled}` → same output.

### 6.2 `plugin/server/work-tracker.ts` (new)

Jev/state-store pattern: `resolveDaemonHome` for the target, `writePrivate`
for the atomic 0600 write. `plugin/server/runtime/work-tracker.ts` owns the
setting reader, PATH selection, version parser and diagnostic formatter for
both adapters. The CLI takes a daemon home and returns `{ enabled, error }`;
the plugin takes the stable runtime root and also returns `configured`.
`get-work-tracker` also detects `bd` on the **plugin process PATH** (= daemon
PATH) with `bd version` — local exec, no network, 5 s timeout; failure fills
`bdError`, never fails the RPC. `beadsSeatEnv({ role, agentId, env })` lives
only in this plugin module for the hook overlay (§6.3): it always sets
`BEADS_ACTOR=slp-<role>-<agentId>` and supplies `BD_AGENT_PROFILE=conservative`
and `BD_DISABLE_METRICS=1` only when absent from the Human-set env.
Wire both handlers in `plugin/index.server.ts`.

### 6.3 Seat env (`plugin/server/role-injection.ts`)

New dep `readWorkTrackerEnabled(): boolean` (index.server.ts resolves the
daemon home like `readActiveBinding`). In `sessionOpen`, for hook-family ids
only:

```
env = { ...request.env, ...(enabled ? beadsSeatEnv(role, agentId, request.env) : {}), SLP_SESSION_OPEN_GRANT }
```

- Any read error → `enabled = false` (no overlay); never abort the open.
- Disabled → overlay is exactly today's (grant only).
- `session_open` env reaching the provider process is proven
  (settings-driven-providers.md Phase 0 "Sentinel" probe).
- Runs for every open reason (create/resume/refresh/import), so a resumed seat
  keeps its actor.

### 6.4 Manager card (`plugin/client/cards/work-tracker.tsx`)

"Work tracker" card: switch "Use beads work tracker"; a status line — `bd
<version> at <path>` or "bd not found on daemon PATH" with the three install
commands; setting error when present; Refresh. No install/init button.
Follow `cards/language.ts` (toggle applies immediately) and the `jev.tsx`
load/stale-target guards. Mount in `ManagerSurface.tsx` next to the language
card.

### 6.5 Payload

Regenerate `plugin/server/generated/runtime-payload.ts`
(`npm run generate:plugin-payload`; CI gate `check:plugin-payload`).

## 7. Disabled = unchanged: required tests

| # | Test | Where |
|---|---|---|
| T1 | Managed `entry()` bytes identical for: no file, `enabled:false`, and the pre-feature render — except the locator list (§11 b) | `tests/plugin-helpers.test.mjs` or new `tests/work-tracker.test.mjs` |
| T2 | `sessionOpen` with disabled/absent/corrupt setting returns only the grant overlay | `tests/plugin-role-injection.test.mjs` |
| T3 | `prepare`, `prepare --check`, `prepare-handoff` output unchanged with tracker on or off | `tests/launch.test.mjs` |
| T4 | Corrupt setting: spawn path succeeds, bundle carries the gap line, card shows the error | plugin + src tests |
| T5 | Enabled + `bd` missing / `bd where` failing / garbage version: probe returns gaps, never throws; state values correct | `tests/work-tracker.test.mjs` with a fake `bd` script on a temp PATH |
| T6 | Enabled: block present with absolute reference path and explicit home; env overlay has `BEADS_ACTOR=slp-<role>-<id>`; Human-set `BD_AGENT_PROFILE` preserved | src + plugin tests |
| T7 | CLI daemon-home and plugin stable-root adapters resolve the same fixture and preserve their result shapes | `tests/work-tracker.test.mjs` |
| T8 | Existing suite green | all |

Update the locator-count assertions (`tests/launch.test.mjs` currently
expects 11 Lead / 10 Peer locators; the new reference adds one each).

**Test-isolation note:** run the suite with an isolated home
(`env -u SLP_DAEMON_HOME PASEO_HOME=$(mktemp -d) npm test`). On a machine
whose real daemon has Jev routing armed, 13 existing tests fail without
isolation (baseline 2026-09-23: 545/545 isolated, 532/545 not). That leak is
pre-existing and out of scope here — file it separately.

## 8. Known host gaps

- **Devin seats** use the wrapper transport and bypass `sessionOpen`: no
  `BEADS_ACTOR` env. They still get the session-entry block through the ACP
  adapter; the reference's `--actor` rule covers attribution. Record in
  `docs/reports/guide-coverage.md`; no workaround.
- PATH seen by the plugin process may differ from a seat's provider env if a
  provider entry overrides PATH; the seat-side probe is authoritative.

## 9. Verify on a real `bd` before merge

Needs `bd` installed on the implementation machine (Human authority).

1. `bd version` output format; `bd where --json` field names and failure
   exit/JSON outside a workspace, including from a linked worktree.
2. `bd where` / `bd version` perform no schema migration or write.
3. `bd init --skip-agents --skip-hooks` creates no AGENTS.md/CLAUDE.md/
   `.claude`/`.codex`/git hooks.
4. Every command in §5.4 exists with that syntax (`assign`, `comments add`,
   `list --parent`, `search --external-contains`, `gate create --type human
   --blocks`, global `--actor`).
5. `BEADS_ACTOR` lands in `bd history <id> --events`.

Adjust §5.4 text to the verified syntax; record results in this file.

## 10. Future: external intake (out of scope, keep compatible)

Target use case: the Human tells Supervisor "every hour, pull new tasks from
Backlog and do them"; Supervisor heartbeat → pull → root bead → Lead → PR →
Backlog status "In Review". Not built now; this spec only preserves the seams:

- intake items: `--external-ref <source>:<key>` + label `intake`, lookup
  before create (idempotent);
- root issue owned by Supervisor, children by Lead (§5.4 writer table);
- the standing grant lives in the notebook, not in the heartbeat prompt
  (heartbeats grant no authority — `common.md`);
- source writes (Backlog status/comments) are external effects needing the
  grant; Backlog MCP only on the Supervisor seat; status IDs are per-project
  and the Backlog MCP has no status-list tool.

## 11. Decisions

| | Decision | Proposed |
|---|---|---|
| a | Default when no setting file | Disabled **[confirm]** |
| b | `work-tracking.md` appears in carrier policy locators even when disabled (integrity list, not instruction) | Accept; the reference self-gates **[confirm]** — alternative: filter it out when disabled for byte-identical carriers |
| c | Install `bd` on the implementation machine for §9 | Human authority **[confirm]** |
| d | Telemetry default `BD_DISABLE_METRICS=1` | Yes, Human env overrides |
| e | Writer model | Supervisor root / Lead children / seat own issue |

## 12. Delivery

Branch `feat/beads-work-tracker` from `main`. Suggested conventional commits:

1. `feat(tracker): add beads work-tracker probe and setting reader` — §5.1, §5.2, tests T5/T7
2. `feat(tracker): gate session-entry pointer and policy reference on the setting` — §5.3, §5.4, tests T1/T3/T4/T6
3. `feat(plugin): work-tracker setting RPCs and seat actor env` — §6.1–6.3, T2/T6
4. `feat(plugin): work-tracker manager card` — §6.4, §6.5
5. `docs: work tracker contract, coverage and onboarding` — contract.md file-map rows (`plugin/server/runtime/cli/work-tracker.ts`, `src/references/work-tracking.md`, state file + sole writer), guide-coverage load path + Devin gap, onboarding skill (install `bd`, per-repo init under authority, enable in the card)

Local checks are not E2E acceptance: a dogfood run (enabled, one Lead + one
Peer, issue created/claimed/closed with SLP actors in `bd history`) and a
disabled run (unchanged behavior) are separate evidence.
