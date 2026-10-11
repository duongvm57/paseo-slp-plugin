# Paseo upstream baseline

Operational facts for the `paseo-slp-upstream-sync` skill
(`.agents/skills/paseo-slp-upstream-sync/SKILL.md`). Each sync reads this file
to start from the last assessed release and updates it at handback, including
a "no plugin change" outcome.

- **Pinned**: the version this checkout builds against (lockfile, or the host
  runtime for unpinned packages). Compatibility is judged against it.
- **Assessed**: the newest release whose delta from Pinned was classified.
  The next sync diffs and reads release notes from Assessed to its target.

| Package | Pinned | Assessed | Coverage | Date | Outcome |
|---|---|---|---|---|---|
| `@getpaseo/plugin` | 0.11.2 | 0.11.2 | Public SDK declarations and consumed touchpoints; no live probe | 2026-10-11 | Additive SDK APIs; existing aliases retained, no optional API adoption |
| `@getpaseo/client` | 0.11.2 | 0.11.2 | Public declarations and changed runtime methods; no live probe | 2026-10-11 | Contracts retained; send queue and usage additions inspected |
| `@getpaseo/protocol` | 0.11.2 | 0.11.2 | Imported schema/type touchpoints; generated validators not exhaustively assessed | 2026-10-11 | Optional desktopTrigger/options; ProviderOptions relaxed |
| `@getpaseo/server` | unpinned host; not changed | 0.11.2 | Partial plugin/config/provider touchpoints, not whole host | 2026-10-11 | Inspection only; no host installation or live compatibility claim |
| `@getpaseo/cli` | unpinned host; not changed | 0.11.2 | Partial plugin/schedule/command delta, not full CLI | 2026-10-11 | Inspection only; no CLI installation |

`requirements.paseo` in `plugin/paseo-plugin.json`: `>=0.10.3`, unchanged
by this SDK update. The earlier record of `>=0.8.0` described the September
assessment, not the current manifest. Field must stay present: an absent
`requirements.paseo` is treated by the daemon as a pre-0.8 legacy plugin.
Updating build dependencies does not update historical capability evidence,
raise the supported host floor or prove runtime compatibility.

## 2026-10-11 bounded SDK update

Human requested the latest local SDK while preparing the spawn-guidance fix
for a PR. All five npm stable tags resolved to 0.11.2; only the three direct
SDK dependencies and the plugin's protocol dependency were updated. Package
tarballs, SHA256 pins, changed-file inventories, diffs and the pre-update
impact report are retained under
`~/slp-traces/spawn-guidance-fix-20261010/sdk-0.11.2/`.
Release source: [Paseo v0.11.2 changelog](https://github.com/getpaseo/paseo/blob/v0.11.2/CHANGELOG.md).

Coverage is deliberately partial: no optional upstream feature was adopted,
no live daemon/plugin cutover was performed, and generated protocol
validators plus unconsumed host internals remain unassessed. Subsequent
syncs must start at 0.10.0 for those unreviewed surfaces. Source checks and
independent-review outcomes are reported in the PR; this record alone is
not test or acceptance evidence.

## Open items from the last assessment

- `plugin/server/config-view.ts` parses config without stripping a UTF-8 BOM,
  which daemon ≥0.9.2 accepts: consider mirroring the strip. Still undecided.
- Docs pinned to 0.8.0 need re-baselining with a bump:
  `docs/spec/paseo-plugin-implementation.md`,
  `docs/spec/paseo-plugin-feasibility.md`, `docs/contract.md`.
- No live daemon exercise on 0.11.2 in this SDK update; `tests/fixtures/supervision/*.json` were
  recorded on host 0.9.1 and not re-recorded.

## Evidence

2026-09-28 assessment, Devin session 9ab88406b1f14e58948532f68a932d30:
`.local-checks/skill-upstream-sync/v0.10.0/report.md` with tarball diffs and
check receipts beside it (`receipts/`). That directory is gitignored and
exists only on the machine that ran it; the rows above are the tracked
record. Notable this run: parity tests ran against a real 0.10.0 server
backend (`PASEO_CLI_MODULES` → extracted tarball + `which`/`semver`
shims), so manifest validation, `compilePlugin`, `DaemonConfigStore` merge
and `loadPersistedConfig` schema parity are verified on the target, not
skipped.
