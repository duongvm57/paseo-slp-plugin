# Open Peer presets (pool v2)

The Human-approved replacement for the v1 archetype UI is five editable
starter entries: Fast, Balanced, Advanced, Frontier and Cross-provider.
Every entry, including a custom one, carries its own display name,
description, runtime bundle and effort policy. Names, template origin and
list order are not routing enums. The first four starters describe relative
capability in the Human's pool; Cross-provider describes a selection purpose.

## Compatibility and ownership

The plugin owns this invariant: the selected entry/effort must be Human-allowed,
host-supported and pinned as the same complete bundle used at create. The
pool writer, formation executor and receipt verifier enforce it across
workspaces; a repository protocol cannot replace their schema/selection checks.
This adds no repository ceremony, authority, tracker or review gate.

Readers accept version 1 and version 2. Existing v1 catalogs retain their
reserved archetype/token semantics, fixed thinking settings and receipts.
Loading a Manager or upgrading the plugin never rewrites a pool. A missing
pool seeds five parked entries in the draft only. A saved empty pool stays
empty. Saving is explicit and CAS-guarded. Before writing v2, the server verifies the
active immutable candidate advertises peerPresets=2 and matches its binding;
a v1-only/unverifiable active runtime blocks conversion without changing the
existing pool. A pending or changed runtime operation blocks the write. No
active binding permits pre-install pool authoring. V1 writes keep their old path. Updating templates does not alter
saved entries or restore deleted defaults.

A v1 conversion is opt-in: preview all entries, review their descriptions,
copy the original v1 JSON if downgrade may be needed, then Save. Keep IDs,
settings, roles, availability, quota fallback, private notes and passthrough
fields. Existing effort becomes Fixed. Existing suitability fields are
retained for comparison; their strings seed the preview description without
inventing model capability. Enabled entries need a nonempty description.
No default entries are inserted into an existing pool. A v1 binary cannot
read v2; restoration uses the original v1 backup and a fresh CAS write.

## Entry fields

Alongside the existing id/provider/model/settings/eligibility fields, v2 has:

- `displayName`, `description`: Human text; enabled entries require both.
- `selectionHints`: optional advisory text sent to Lead/Jev.
- `notes`: private, optional text, never sent to routing.
- `templateOrigin`: optional provenance only; no reserved-ID behavior.
- `modelProvider`: optional Human-declared model vendor, used for cross-provider.
- `runtimeRule`: `none` or `different-model-provider`, explicit and editable.
- `effortPolicy`: `{kind:"fixed", thinkingOptionId:string|null}` or
  `{kind:"select", allowed?:string[]}`. Null is an explicit runtime default.
  Omitted allowed list permits all supported pure effort choices; an explicit
  empty/duplicate list is invalid. Select cannot carry a fixed thinking override.

The old suitableFor/avoidFor fields remain on the wire for comparison, but v2
routing uses description/hints. An option's ID remains unique, syntax-constrained
and distinct from the decline sentinel; all former archetype IDs are editable
v2 identities. Presets do not map to dispositions or grant permissions.

## Choice and pins

Fresh provider observations include model descriptors and per-model thinking
choices. Recognized pure effort IDs are minimal/low/medium/high/xhigh/max;
a host choice may also explicitly declare metadata.kind=effort. Unknown
orchestration choices are not selected automatically, but can be Human-fixed
when advertised. A model advertising no separate choices has a default-only
candidate. Missing model metadata and empty allowed intersections exclude the
entry, with no invented default.

The same choice set exposes descriptions, hints, explicit rules and entry/effort
pairs to Lead and Jev. The v2 Jev instructions interpret all eligible entries,
including arbitrary custom entries, against the raw brief. Criteria keys identify
pairs, not preset names. Private notes are excluded. Preflight exposes exclusions;
it never calls Jev or admits an operation. The set is bounded to 64 pairs / 24 KiB;
exceeding it reports an error and a narrowing action, never truncates silently.

Off chooses a sole pair or asks the Lead for `selection:{optionId,thinkingOptionId}`.
Shadow always requires the Lead's independent pair and retains the Jev pair.
Armed binds Jev's full pair; a supplied independent pair must agree. Receipt and
route bind catalog hash, v2 semantics and a hash of capabilities/context/choices.
Fresh create/delivery revalidation rejects drift. Replay retains its pinned
decision without another Jev call. Selection never overlays effort after routing,
changes a running seat, retries a decline or authorizes a cost escalation.

## Cross-provider and host gaps

The Cross-provider starter explicitly sets different-model-provider. Changing
its name or ID does not change the rule; custom entries can use the same rule.
Native formation accepts `routingRequirements:{referenceAgentId,crossProvider?}`.
It refreshes the named seat's provider/model and rechecks that runtime before
effects. It does not assume the Lead is the reference. An assignment-wide
crossProvider requirement filters every entry, regardless of its name.

Host snapshots currently identify runtime wrappers, not model vendors. The
pool's Human-declared modelProvider on entries matching the observed reference
runtime supplies that identity. Missing/conflicting declarations exclude the
cross-provider branch. Changing wrappers alone proves no different vendor.
If the reference model has no declared identity in the pool, configure that
identity before using this rule; no vendor is guessed from a model ID.
Different vendors do not establish independent authority, mandate or evidence.

CLI `route-choices <request.json|->` reads the same v2 pairs without Jev or
admission, including when routing is off. Copy the chosen optionId/thinkingOptionId,
catalogSha256/selectionSha256 and routingContext into prepare.route. The
`route-choices --schema` and `route-decide --schema` outputs describe the inputs.
CLI compatibility supplies fresh provider/model descriptors plus routingContext
(reference runtime observations), selectionSha256 and explicit thinkingOptionId;
prepare remains offline and validates these pins. Native formation/dispatch
additionally refreshes referenceAgentId. Legacy v1 discovery needs no new model
metadata. Repository catalogs still win over user pools, including empty catalogs.
Quota fallback keeps one designated option and must satisfy the same constraints.
