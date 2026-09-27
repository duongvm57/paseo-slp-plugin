# Peer pool setup and validation

Read from onboarding step 4, after the Human has named where the Peer runtime
list lives. Peer runtime options come from the repository catalog
`.paseo-slp/slp-routing.json` when present, else the plugin-owned user-scope pool
`$PASEO_HOME/slp-runtime/state/peer-pool.json` (default ~/.paseo) authored in the
SLP Manager's Peer pool card. Read the installed
`src/references/provider-routing.md` — the runtime rule; this file is the setup
procedure. Within granted setup authority, populate the choices the Human made;
otherwise ask for the missing pool decision before delegation.

## Discover

Discover slp-pi-peer/slp-codex-peer/slp-devin-peer/slp-claude-peer and their exact
models, thinking/mode/features. Existing saved Peer settings may be shown as a migration suggestion but are not
automatically imported or a launch fallback. Never invent IDs, capability
claims or suitability guarantees.

## Populate the chosen source

- **inherit** (the default): the repository keeps no catalog and resolves the
  user-scope pool. Walk the seats in the Manager's Peer pool card: pick an
  archetype per kind of work, choose the discovered provider/model/mode in its
  pickers, and enable the seats the Human approves — the card's values come from
  the live provider catalog, so a mistyped mode id cannot reach the file. A
  legacy `$PASEO_HOME/slp-routing.json` can be imported once from the card; the
  plugin is the pool file's sole writer — never edit it by hand. If the Human
  leaves the pool empty, report that the inherited pool is currently empty. A
  populated user-scope pool is the fallback default, not this repository's
  configuration — its existence never substitutes for the Human's choice.
- **pinned**: build the same document as a file (the card's Copy pool JSON
  supplies the shape) and import it with
  `slp init <repo> --routing-from <file> --apply` in onboarding's Write step,
  after the confirmed effective protocol has been written and before Peer delegation.
  Interview the Human on which options to enable and the quota fallback rather
  than copying a catalog verbatim; --routing-from imports an explicitly selected
  source, only into a missing catalog, as a starting point for that decision.
- **empty**: the repository is deliberately without a pool, so pin an empty or
  all-disabled catalog — an absent catalog would still read every seat the
  shared pool holds, including seats authored for other repos. Record the
  resulting delegation limitation.

Any catalog file in the repository is authoritative and disables the fallback;
init creates none on its own. The user-scope pool is the only declared fallback
— never read another repository's catalog. No automatic import from retired
profile bindings occurs during host upgrade. Preserve existing pool entries and
Human preferences on updates; edit only the authorized scope.

Pool setup is complete when the Human has named where the list lives and, for a
list meant to work, picked discovered options seat by seat — or declared the
repository deliberately without a pool.

## Option schema

The catalog envelope is version: 1, a nonempty policy describing
selection/budget boundaries, and options: an array of bundles. Every option has:

- id: unique lowercase identifier; provider: pi, codex, devin or claude; exact
  discovered model. Devin options accept swe-2 models only. A disabled seat
  may park with a blank provider and model until the Human fills them.
- roles: ["peer"]; enabled: boolean; availability: ready, paused, quota-exhausted
  or unknown. Only enabled/ready options may launch.
- Optional thinkingOptionId, modeId and features, verified for that runtime.
- suitableFor and avoidFor: on the 12 reserved standard seats these are the
  package's closed `axis:value` tokens (read-only — docs/spec/routing-criteria.md);
  custom seats keep free-form lists Jev can read;
  notes: concrete guidance/tradeoffs for Lead, held back from Jev.

Default quotaFallback: { enabled: false, optionId: null } by default. Enable it
only under Human fallback authority; optionId must designate one existing pool
option — a single designated fallback, not an ordered list. Choose it by
suitability and budget, not provider model lists. Preserve the existing
designation on updates. Missing settings mean no fallback.

Lead chooses an option per assignment; do not hard-code Engineer/Architect/Reviewer
to one model. Multiple options may use the same provider with different
model/settings, or different providers. Every Peer wrapper loads the same policy.
Jev-assisted routing is per-daemon, set in the Manager's Jev card; onboarding
neither creates nor edits it.

## Validate

Validate with `node <slp-cli> routes <absolute-repo>`. It returns the catalog hash
and complete options. For each intended eligible option, use prepare with
role: "peer", repository, workspaceId, assignment, fresh providers, and
route: { optionId, catalogSha256 } to inspect launch arguments without creating
an agent — or `prepare <request.json> --check` to get every failing stage named
in one report (missing profile/provider/model, stale hash) with exit 1 on
failure. `prepare --schema` prints the request contract from a source checkout;
`prepare <request.json> --emit create` prints the audit artifact
`{ modeId, modeIdSource, create }` — `create` is the exact create_agent record.
Verify the wrapper/model/settings match the option. Include profiles only if
useful for discovery; they never select or override the Peer runtime.

Use `prepare --schema` for required fields. Launch assignments carry scope,
authority, recipient and verification/handback expectations; follow installed
provider-routing.md for topology and runtime validation. When `routes` reports
`jevRouting.routing` as `shadow`, `armed` or
`error`, read `references/jev-routing.md`; skip it for `unconfigured` or
`off`. `error` blocks the dependent routing branch.

For repeated prepares, capture discovery once: `node <slp-cli> inventory
--paseo-home <absolute-home>` prints {providers, profiles} to stdout in the
shape prepare consumes — pass the file's absolute path as request.inventoryFile
(inline arrays, including [], still win). Under a managed runtime its providers
are labeled provenance configured and are refused as launch evidence; pass live
list_providers output from the same daemon inline as providers instead.
Inventory output proves configuration completeness, not provider readiness —
never treat a listed entry as healthy.

An empty or ineligible pool blocks only Peer delegation. Report no eligible
option as unresolved setup, not success.
