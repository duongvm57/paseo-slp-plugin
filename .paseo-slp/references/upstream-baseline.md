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

`requirements.paseo` in `plugin/paseo-plugin.json` is `>=0.11.0` for native
screen/sidebar support on daemon and app. Keep the field present. That current
API floor does not extend the assessed runtime evidence in the table above.
Updating SDK dependencies or documentation never proves live compatibility.

## Coverage and unresolved differences

The 2026-10-11 assessment was partial. Generated protocol validators and
unconsumed host internals remain unassessed; subsequent syncs start at 0.10.0
for those surfaces. No live 0.11.2 daemon/plugin cutover was performed.
Supervision fixtures were recorded on host 0.9.1 and have not been re-recorded.

`plugin/server/config-view.ts` parses config without stripping a UTF-8 BOM,
which daemon 0.9.2 accepts. Mirroring that behavior remains undecided; a docs
refresh does not authorize a production parser change.

## Evidence provenance

The 2026-10-11 tarball/diff assessment used the published
[Paseo v0.11.2 source](https://github.com/getpaseo/paseo/blob/v0.11.2/CHANGELOG.md).
Its raw artifacts were machine-local; the table records the tracked coverage,
not a new test receipt. Earlier host-parity checks used the extracted 0.10.0
server with `PASEO_CLI_MODULES`; their results qualify that earlier target only.
