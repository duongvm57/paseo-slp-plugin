# Legacy standalone installer

> **Superseded by the Paseo plugin.** The plugin install path in
> [README.md](../../README.md#installation) is the supported model. This page
> documents the pre-plugin `install.sh`/`slp.mjs install` flow for
> installations that already use it. **Do not run both** — the standalone
> installer writes the same provider/profile IDs outside the plugin's
> journal, which blocks activation with `COLLISION`/`OWNERSHIP_DRIFT`.

## Installation

```bash
npm run install:slp          # preview only (dry run, writes nothing)
npm run install:slp:apply    # --apply --reload: writes and reloads
# or: ./install.sh           # always applies
```

Without a local clone, straight from GitHub:

```bash
npx --yes --package github:duongvm57/paseo-slp-plugin -- paseo-slp install --paseo-home --apply --reload
```

This installs the Markdown policies and CLI into the platform data
directory — `$XDG_DATA_HOME/paseo-slp` (`~/.local/share/paseo-slp`),
`~/Library/Application Support/paseo-slp` on macOS, `%LOCALAPPDATA%\paseo-slp`
on Windows — adds the twelve providers `slp-codex-{supervisor,lead,peer}`,
`slp-pi-{supervisor,lead,peer}`, `slp-devin-{supervisor,lead,peer}` and
`slp-claude-{supervisor,lead,peer}`, plus two saved profiles **SLP
Supervisor** and **SLP Lead** to `$PASEO_HOME/config.json` (default
`~/.paseo`), enables MCP injection and reloads.

- No agent is created during install. The three roles stay intact.
- **Peers need no saved profile** — the Lead picks each Peer's runtime from
  the project pool in `.paseo-slp/slp-routing.json`.
- Repos keep their tactics in `.paseo-slp/workspace-protocol.md`; onboarding
  guides you through both files.
- Override the install location with `SLP_HOME=/absolute/path` (or pass the
  path to `slp.mjs install`) and the host config with
  `PASEO_HOME=/absolute/home` (or a path after `--paseo-home`). Run the
  installer on the daemon's host.
- Running the same command again updates an intact installation in place:
  files are swapped atomically, tuned profile settings are kept, and a
  hand-modified install is preserved rather than overwritten.
- `install`/`upgrade --apply` also seeds the user-scope catalog
  `$PASEO_HOME/slp-routing.json` when absent; `uninstall` removes it only
  while still byte-identical to the scaffold (hash recorded in
  `paseo-binding.json`).

To preview the entries before writing:

```bash
node bin/slp.mjs install --paseo-home /absolute/paseo-home
# add --apply to write; add --reload to activate on the running daemon
```

## Upgrading

`install` already updates in place; `upgrade` is only for moving the
installation to a different directory. The command keeps profile settings
and leaves the old files for sessions still using them:

```bash
node bin/slp.mjs upgrade "$HOME/.local/share/paseo-slp.next" \
  --from "$HOME/.local/share/paseo-slp" --apply --reload
```

Drop `--apply --reload` for a dry run. Existing sessions keep their provider
process; the new profiles apply to later launches. Upgrade preserves the
current settings of `slp-peer` and any SLP-owned retired disposition profiles
by recording them in `paseo-binding.json` → `retiredProfiles` before removing
them from active profiles. The Supervisor/Lead profiles keep their chosen
settings; the project pool is neither modified nor auto-filled from old
profiles. An existing catalog and user-owned profiles outside this install
are preserved.

Keep the old directory around until dependent sessions have finished; do not
uninstall the old copy to remove entries that moved to the new one. Always
use the path the providers actually reference for `init` and `prepare`.

## Uninstall

Uninstall after the sessions using the install have finished:

```bash
node bin/slp.mjs uninstall "$HOME/.local/share/paseo-slp" --apply --reload
```

Uninstall removes the entries the install created and restores the two MCP
flags from before; it keeps other config and a Human-edited catalog. The
user-scope catalog scaffold is removed only while still unmodified (recorded
hash), so a catalog you populated survives. If an installed
profile/provider/file has been modified, the command stops and leaves
everything in place for you to decide how to keep the changes. The protocol
in the work repo is preserved. A reload failure does not roll back the file
writes: the output reports `reloadRequired`/`reloadError`; rerun
`PASEO_HOME=/absolute/home paseo reload --json` after fixing the cause. The
installer never restarts the daemon itself nor answers agent permission
prompts.

## Migrating to the plugin

1. Uninstall the standalone copy first (above) — its provider/profile IDs
   collide with the plugin's owned entries.
2. Install and activate the plugin per [README.md](../../README.md#installation).
3. Repo state under `.paseo-slp/` (protocol, catalog, notebook) is
   unaffected by either path.
