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
| `@getpaseo/plugin` | 0.14.0 | 0.14.0 | Changed public declarations/export maps, consumed lifecycle/provider/client APIs; no live probe | 2026-11-02 | SDK updated; empty turn-ended history adapted; new session-open fields explicitly classified outside seat identity |
| `@getpaseo/client` | 0.14.0 | 0.14.0 | Public declarations, relied-on timeline API and changed host methods | 2026-11-02 | SDK updated; optional host routing/reload APIs not adopted |
| `@getpaseo/protocol` | 0.14.0 | 0.14.0 | Consumed config/message schemas; generated outbound validators not exhaustive | 2026-11-02 | Root and plugin runtime pins aligned; new speech/idle-cleanup/registry config preserved |
| `@getpaseo/server` | unpinned host; not changed | 0.14.0 | Partial lifecycle, persisted config, provider registry/runtime and ACP runtime paths | 2026-11-02 | Empty timeline hook adaptation; no host installation or live acceptance |
| `@getpaseo/cli` | unpinned host; not changed | 0.14.0 | Release notes and relied-on agent send/archive paths; not full CLI | 2026-11-02 | Queued-delivery receipt and archive pagination are host-side fixes; no CLI adaptation or installation |

`requirements.paseo` in `plugin/paseo-plugin.json` is `>=0.11.0` for native
screen/sidebar support on daemon and app. Keep the field present. That current
API floor does not extend the assessed runtime evidence in the table above.
Updating SDK dependencies or documentation never proves live compatibility.

## Coverage and unresolved differences

The assessments remain partial. The 2026-11-02 sync covers changed consumed surfaces through stable 0.14.0; historical unreviewed internals and generated validators remain open. The 2026-10-22 sync covered 0.11.3, 0.11.4,
0.12.0-beta.1 through beta.3 and stable, including stable tarball rechecks. Generated protocol validators and
unconsumed host internals remain unassessed; subsequent syncs start at 0.10.0
for those surfaces. No live 0.11.2, 0.12.0 or 0.14.0 daemon/plugin cutover was performed.
Supervision fixtures were recorded on host 0.9.1 and have not been re-recorded.

`plugin/server/config-view.ts` parses config without stripping a UTF-8 BOM,
which daemon 0.9.2 accepts. Mirroring that behavior remains undecided; a docs
refresh does not authorize a production parser change.

## Evidence provenance

The 2026-11-02 stable 0.14.0 sync report and package diffs are machine-local at
`.local-checks/skill-upstream-sync/0.14.0/impact.md`. Human approved SDK pins,
empty-hook history adaptation and config compatibility while retaining the
manifest floor. The report records exact candidate/check/review evidence and
remaining limits; these table rows record source/package assessment, not live
qualification. Published dates, intermediate 0.13/0.14 release notes and all
five package tarballs were inspected. Optional tools/MCP/translation/host APIs
were not adopted. Empty hooks use one bounded 500-entry history read; missing
turn IDs, incomplete boundaries or failed reads remain unverified.


The 2026-10-22 impact report is console-only in the Human conversation; no
scratch report was granted. Sources: [stable release](https://github.com/getpaseo/paseo/releases/tag/v0.12.0),
intermediate beta release notes, and published npm tarballs for all five
packages. The implementation adds source-derived projection controls and a
fake native-stream adapter test, with source/license details in
[Antigravity support](../../docs/antigravity.md). These are local proof, not a
live compatibility result. `ws-outbound*` generated validators and unrelated
host internals remain unreviewed. The Human subsequently granted isolated Antigravity CLI probes under
`.local-checks/skill-upstream-sync/0.12.0/`. SLP adds per-open stdio/HTTP MCP
relays and role reassertion on every prompt; fake-service probes do not prove
live desk/fleet acceptance or model compliance. Supervision shapes remain
unverified. Native agy 1.4.4 is the qualified minimum for this new family.

The 2026-10-11 tarball/diff assessment used the published
[Paseo v0.11.2 source](https://github.com/getpaseo/paseo/blob/v0.11.2/CHANGELOG.md).
Its raw artifacts were machine-local; the table records the tracked coverage,
not a new test receipt. Earlier host-parity checks used the extracted 0.10.0
server with `PASEO_CLI_MODULES`; their results qualify that earlier target only.

The source-first follow-up preserves episode labels and handles Desk delivery
IDs across legacy inputs and semantic agent-message projections. Public client
0.11.0/0.11.2 drop the additive source/background fields; client 0.12.0 enforces
host capabilities before requests. Mixed clients/hosts may refuse safely; no
plain-send fallback or retry is added. The external analyzer still needs its
implementation migrated to the updated episode input contract.
