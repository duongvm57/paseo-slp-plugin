// plugin/server/limitations.ts — the single constant table for every
// limitation string P2-e adds or changes (contract §4.5, §4.7).
//
// Invariant (T1/T2/T3): every new/changed limitation literal lives HERE —
// producers (server/enforcement.ts, server/capabilities.ts) read the strings
// from this table or from the render helpers below; no limitation literal of
// this slice may exist outside this module. The enumeration test iterates
// the table, measures UTF-8 bytes and characters against WIRE_LIMITS[capKey],
// requires printable ASCII, and pins the literals verbatim against §4.5.
//
// Templates carry a `<…>` placeholder: the table's `text` holds the
// worst-case rendering (L-S1 with N = WIRE_LIMITS.bindingsRepos, R-RV with
// the longest REVOKE_REASONS member), generated from the owners — never a
// hand-copied number or reason. Producers render through the helpers.
import { WIRE_LIMITS } from "../shared/enforcement.ts";
import { REVOKE_REASONS } from "./desk-store.ts";

/** The longest revoke reason — derived from the enum owner (§4.7). */
const longestRevokeReason = REVOKE_REASONS.reduce(
  (a, b) => (b.length > a.length ? b : a),
);

const SKIPPED_TEMPLATE =
  "bindings: <N> repo ledger(s) skipped; inspect slp-runtime/state/enforcement/repos/*/ledger.json";
const REVOKED_TEMPLATE = "revoked: <revokeReason>";

/** §4.5 — the pinned literal table. `capKey` names the WIRE_LIMITS key the
 *  enumeration test measures `text` against (here always `limitationLen`). */
export const LIMITATION_TABLE = [
  {
    id: "L-B",
    capKey: "limitationLen",
    text: "bindings: desk handshake rows with an agentId; no attestation or authority; rows without agentId are only counted",
  },
  {
    id: "L-P",
    capKey: "limitationLen",
    text: "bindings withheld: PASEO_HOME not exported; memberships still recorded; export it or run desk-recover --paseo-home",
  },
  {
    id: "L-S1",
    capKey: "limitationLen",
    text: SKIPPED_TEMPLATE.replace("<N>", String(WIRE_LIMITS.bindingsRepos)),
  },
  {
    id: "L-S2",
    capKey: "limitationLen",
    text: "bindings: repos directory unreadable; check slp-runtime/state/enforcement/repos exists and is readable",
  },
  {
    id: "C-DL",
    capKey: "limitationLen",
    text: "desk ledger exists (P2-a store, P2-c memberships); bindings show handshakes, no attestation; no dispatch or authority",
  },
  {
    id: "R-RC",
    capKey: "limitationLen",
    text: "registration: confirmed",
  },
  {
    id: "R-RP",
    capKey: "limitationLen",
    text: "registration: pending",
  },
  {
    id: "R-AN",
    capKey: "limitationLen",
    text: "attestation: none",
  },
  {
    id: "R-RV",
    capKey: "limitationLen",
    text: REVOKED_TEMPLATE.replace("<revokeReason>", longestRevokeReason),
  },
] as const;

export type LimitationId = (typeof LIMITATION_TABLE)[number]["id"];

const byId = Object.fromEntries(LIMITATION_TABLE.map(entry => [entry.id, entry.text]));

/** Static entries — producers read the pinned string by id. */
export function limitation(id: LimitationId): string {
  return byId[id];
}

/** L-S1 with the real count — N counts only repos actually read and then
 *  excluded (errata E-P2E-1); repos beyond bindingsRepos never enter N. */
export function renderSkippedLedgers(skipped: number): string {
  return SKIPPED_TEMPLATE.replace("<N>", String(skipped));
}

/** R-RV with the row's own revokeReason. */
export function renderRevoked(revokeReason: string): string {
  return REVOKED_TEMPLATE.replace("<revokeReason>", revokeReason);
}
