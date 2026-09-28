// plugin/server/enforcement.ts — the enforcement desk seam (P0).
//
// This module is the single use-case Interface the migration table assigns:
// callers reach the desk only through `readView` / `dispatch` — sequencing of
// locks, grants, pins and receipts is the desk's job, never the caller's.
// At P0 the desk is observational by construction:
//   - `readView` answers the capability audit, the install-receipt state and
//     a literal-empty binding list, all read-only — it never projects
//     configured provider values, effective policy or per-agent model rows;
//   - `dispatch` exists so every future mutation enters through one typed
//     rejection boundary — at P0 it refuses everything with CAPABILITY_GAP.
//
// Ownership lines it must never cross: role-injection.ts stays the hook
// owner, journal.ts stays the durable-write primitive, state-store.ts stays
// the preference owner, and no view here is an acceptance verdict.

import { z } from "zod";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { FetchAgentsResponseMessageSchema } from "@getpaseo/protocol/messages";
import {
  CompletenessCollection,
  CompletenessReason,
  DeskRejection,
  GetEnforcementStatusInput,
  GetEnforcementStatusOutput,
  WIRE_LIMITS,
  type CompletenessCollectionValue,
  type CompletenessEntryValue,
  type CompletenessReasonValue,
  type DeskRejectionValue,
  type GetEnforcementStatusOutputValue,
} from "../shared/enforcement.ts";
import { isRecord } from "./config-view.ts";
import { detectDaemonHome, receiptMatchesTarget } from "./daemon-home.ts";
import { MAX_RPC_BYTES, OperationConflict } from "../shared/contracts.ts";
import type { Journal } from "./journal.ts";
import { auditCapabilities } from "./capabilities.ts";

/** The pinned agents.list oracle: DaemonClient validates the wire envelope
 *  before a plugin ever sees it, so the host surface derives from the
 *  protocol schema itself rather than a second self-declared interface. */
type AgentsListResult = z.infer<typeof FetchAgentsResponseMessageSchema>["payload"];

/** The payload half of the same oracle — the value `agents.list` resolves
 *  to. One defensive safeParse is permitted at this seam: a host adapter or
 *  test double that bypasses DaemonClient validation degrades to
 *  inconclusive evidence, never to projected rows. */
const AgentsListPayload = FetchAgentsResponseMessageSchema.shape.payload;

/** Narrowed host surface (§2.1): only the read calls a status view may
 *  exercise — a structural subset of the connected SDK api, so the seam
 *  tracks the pinned protocol without importing its client types. */
export interface EnforcementHostApi {
  providers?: { snapshot?: () => Promise<unknown> };
  agents?: { list?: (input: { page: { limit: number } }) => Promise<AgentsListResult> };
}

export interface EnforcementDeps {
  journal: Journal;
  now?: () => Date;
}

/** The P0 static limitation strings every view carries — exported so the
 *  capacity fixture uses the producer's real content, not a second copy. */
export const P0_STATIC_LIMITATIONS = [
  "P0 is observational only — nothing in this view is enforced by a desk; dispatch rejects every command",
  "bindings[] is empty by construction: no desk binding ledger exists yet, and observed host agents are not desk-bound seats",
  "capability rows default to unknown; source-static-compat evidence proves interfaces, never live delivery",
  "a requested catalog model is not the effective model; per-agent model rows are outside the P0 contract",
  "configured provider values are not projected in P0; effective provider policy is not observable",
  "no reviewer axis or verdict exists in this view; a view is never acceptance",
] as const;

function summarize(error: unknown, max = 96): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Canonical ledger order — fixed enum ordinals, never locale (§2.1). */
const COLLECTION_ORDINAL = new Map(CompletenessCollection.options.map((c, i) => [c, i]));
const REASON_ORDINAL = new Map(CompletenessReason.options.map((r, i) => [r, i]));

function byLedgerOrdinal(a: CompletenessEntryValue, b: CompletenessEntryValue): number {
  return (COLLECTION_ORDINAL.get(a.collection) ?? 0) - (COLLECTION_ORDINAL.get(b.collection) ?? 0)
    || (REASON_ORDINAL.get(a.reason) ?? 0) - (REASON_ORDINAL.get(b.reason) ?? 0);
}

/** The §2.1 producer ledger: one entry per (collection, reason) pair,
 *  ordinal-sorted, `detail` always null on the wire. The ledger also tracks
 *  source-side `records_in`/`rows_emitted` so the conservation law
 *  (rows_emitted + Σcount == records_in) is checked before emit. */
class CompletenessLedger {
  private readonly counts = new Map<CompletenessCollectionValue, Map<CompletenessReasonValue, number>>();
  private readonly recordsIn = new Map<CompletenessCollectionValue, number>();
  private readonly rowsEmitted = new Map<CompletenessCollectionValue, number>();

  sourceIn(collection: CompletenessCollectionValue, count = 1): void {
    this.recordsIn.set(collection, (this.recordsIn.get(collection) ?? 0) + count);
  }

  emitted(collection: CompletenessCollectionValue, count = 1): void {
    this.rowsEmitted.set(collection, (this.rowsEmitted.get(collection) ?? 0) + count);
  }

  drop(collection: CompletenessCollectionValue, reason: CompletenessReasonValue, count = 1): void {
    const scope = this.counts.get(collection) ?? new Map<CompletenessReasonValue, number>();
    scope.set(reason, (scope.get(reason) ?? 0) + count);
    this.counts.set(collection, scope);
  }

  entries(): CompletenessEntryValue[] {
    const out: CompletenessEntryValue[] = [];
    for (const [collection, scope] of this.counts) {
      for (const [reason, count] of scope) {
        out.push({ collection, reason, count, detail: null });
      }
    }
    return out.sort(byLedgerOrdinal);
  }

  /** Conservation law — a violation is a producer bug: fail closed rather
   *  than ship a ledger that disagrees with itself. */
  assertConserved(): void {
    for (const collection of CompletenessCollection.options) {
      const dropped = [...(this.counts.get(collection)?.values() ?? [])].reduce((a, b) => a + b, 0);
      if ((this.rowsEmitted.get(collection) ?? 0) + dropped !== (this.recordsIn.get(collection) ?? 0)) {
        throw new OperationConflict(
          "IO_FAILURE",
          `enforcement ledger broke conservation on '${collection}' — view withheld`,
        );
      }
    }
  }
}

/** Capacity pins equal the audited inventory exactly — growth without a pin
 *  raise is producer-invalid and fails closed, never an omission the wire
 *  could pass as a complete view. */
function assertProducerBound(collection: string, count: number, cap: number): void {
  if (count > cap) {
    throw new OperationConflict(
      "IO_FAILURE",
      `${collection} produced ${count} records — over the pinned ${cap} capacity`,
    );
  }
}

/** The final emit guard (§2.1): the producer's view must already satisfy the
 *  output schema and the 64 KiB byte bound — the pinned capacity vector makes
 *  a byte shed unreachable, so this is a check, never a truncation pass.
 *  Producer-invalid or over-bound output throws IO_FAILURE; there is no
 *  floor-as-success. Exported so tests exercise the guard directly. */
export function boundStatusView(
  output: GetEnforcementStatusOutputValue,
): GetEnforcementStatusOutputValue {
  const parsed = GetEnforcementStatusOutput.safeParse(output);
  if (!parsed.success) {
    throw new OperationConflict(
      "IO_FAILURE",
      "enforcement-status produced a schema-invalid view — withheld",
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
  if (bytes > MAX_RPC_BYTES) {
    throw new OperationConflict(
      "IO_FAILURE",
      `enforcement-status view is ${bytes} bytes — over the ${MAX_RPC_BYTES}-byte bound`,
    );
  }
  return parsed.data;
}

export function createEnforcement(deps: EnforcementDeps) {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();

  /** Read-only desk status. Every host touch is a read; failures degrade to
   *  limitations in the view, never to a hidden empty truth. Receipt and
   *  host evidence attach only for a target verified as THIS daemon's served
   *  home — an exported PASEO_HOME plus a realpath match. Anything else gets
   *  a static-only view; the caller's home is never read. */
  async function readView(
    input: unknown,
    paseo: EnforcementHostApi | undefined,
  ): Promise<GetEnforcementStatusOutputValue> {
    const parsed = GetEnforcementStatusInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `invalid enforcement-status input: ${parsed.error.issues[0]?.message ?? "schema"}`,
      );
    }
    const target = parsed.data.target;
    // The 64 KiB bound applies to the input too — same contract as the
    // manager RPCs (the schema already caps fields, the check guards the
    // serialized envelope).
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_RPC_BYTES) {
      throw new OperationConflict("INVALID_REQUEST", "input exceeds the 64 KiB bound");
    }
    const generatedAt = now();
    const limitations: string[] = [];
    const ledger = new CompletenessLedger();

    // Provenance gate (spec §2.1 decision table): only an exported PASEO_HOME
    // proves which home this process serves — a default guess does not.
    let servedHome: string | null = null;
    const served = detectDaemonHome();
    if (served.source !== "env") {
      limitations.push(
        "PASEO_HOME is not exported — target unverified as the served home; receipt and host observations withheld",
      );
    } else {
      try {
        const canonicalServed = realpathSync(served.daemonHome);
        if (realpathSync(target.daemonHome) === canonicalServed) {
          servedHome = canonicalServed;
        } else {
          limitations.push(
            "target is not the served daemon home (realpath mismatch) — receipt and host observations withheld",
          );
        }
      } catch {
        limitations.push(
          "target or served home path does not resolve — receipt and host observations withheld",
        );
      }
    }

    // Install receipt — the journal stays the only durable-read primitive,
    // and only for the verified served home.
    let installation: GetEnforcementStatusOutputValue["installation"] = null;
    if (servedHome !== null) {
      try {
        const receipt = deps.journal.read(join(servedHome, "slp-runtime"));
        // A receipt naming another target is not this home's evidence —
        // TARGET_MISMATCH degrades the whole view to static-only (§2.1).
        // Same predicate as the manager's resolveReceipt, not a copy.
        if (receipt !== null
            && !receiptMatchesTarget(receipt.target, { hostId: target.hostId, canonicalHome: servedHome })) {
          servedHome = null;
          limitations.push(
            "install receipt targets a different home (TARGET_MISMATCH) — receipt and host observations withheld",
          );
        } else {
          installation = receipt === null
            ? { state: null, revision: null, bound: false, error: null }
            : {
                state: receipt.state,
                revision: receipt.revision,
                bound: receipt.binding !== null,
                error: null,
              };
        }
      } catch (error) {
        // A corrupt/future receipt is evidence: surface the bounded typed
        // code instead of failing the view or pretending the home is clean.
        const code = error instanceof OperationConflict ? error.code : "IO_FAILURE";
        installation = { state: null, revision: null, bound: false, error: `${code}: ${summarize(error, 200)}` };
        limitations.push(`install receipt unreadable — fail-closed state preserved: ${code}`);
      }
    }

    // Live host surfaces — read-only calls whose outcomes are evidence.
    let providersSnapshot: boolean | null = null;
    if (servedHome !== null && typeof paseo?.providers?.snapshot === "function") {
      try {
        await paseo.providers.snapshot();
        // An answered call proves the surface exists. Only an identifiable
        // unknown_schema/unknown-request rejection marks it unsupported;
        // any other transport failure stays inconclusive (null).
        providersSnapshot = true;
      } catch (error) {
        providersSnapshot = /unknown_schema|unknown request/i.test(summarize(error, 256)) ? false : null;
        limitations.push(`providers.snapshot failed: ${summarize(error)}`);
      }
    }

    // agents.list is exercised only to observe the endpoint. DaemonClient
    // already validates the wire envelope — one defensive safeParse guards
    // this seam against adapters that bypassed it. A payload the oracle
    // rejects is inconclusive evidence: agentsList stays null, never false.
    // agents.list keeps its own accounting namespace (§2.1): one request/
    // response envelope is exactly one source record — valid payload emits,
    // oracle reject or request failure omits once.
    let agentsList: boolean | null = null;
    if (servedHome !== null && typeof paseo?.agents?.list === "function") {
      ledger.sourceIn("agents.list");
      try {
        const result = await paseo.agents.list({ page: { limit: WIRE_LIMITS.agentsListPage } });
        if (AgentsListPayload.safeParse(result).success) {
          agentsList = true;
          ledger.emitted("agents.list");
        } else {
          agentsList = null;
          ledger.drop("agents.list", "malformed");
          limitations.push("agents.list answered but its payload failed the pinned protocol oracle — endpoint evidence stays inconclusive");
        }
      } catch (error) {
        agentsList = /unknown_schema|unknown request/i.test(summarize(error, 256)) ? false : null;
        ledger.drop("agents.list", "malformed");
        limitations.push(`agents.list failed: ${summarize(error)}`);
      }
    }

    const audit = auditCapabilities({
      now: generatedAt,
      observed: { rpcDispatched: true, providersSnapshot, agentsList },
    });
    // Producer caps (§2.1): the pins equal the audit inventory exactly, so
    // growth past a pin is a producer bug — fail closed rather than shed
    // rows behind an omission the view could hide behind.
    const records = audit.records;
    ledger.sourceIn("capabilities", records.length);
    assertProducerBound("capabilities", records.length, WIRE_LIMITS.capabilities);
    ledger.emitted("capabilities", records.length);
    const gaps = audit.gaps;
    ledger.sourceIn("gaps", gaps.length);
    assertProducerBound("gaps", gaps.length, WIRE_LIMITS.gaps);
    ledger.emitted("gaps", gaps.length);

    limitations.push(...P0_STATIC_LIMITATIONS);

    // Producer cap for the limitations collection itself — same fail-closed
    // rule: exceeding the pin is producer-invalid, not a row-limit shed.
    ledger.sourceIn("limitations", limitations.length);
    assertProducerBound("limitations", limitations.length, WIRE_LIMITS.limitations);
    ledger.emitted("limitations", limitations.length);

    // The completeness collection's own accounting: the ledger entries are
    // the records — what the producer computed is what the producer emits.
    const completeness = ledger.entries();
    ledger.sourceIn("completeness", completeness.length);
    ledger.emitted("completeness", completeness.length);
    // Conservation law (§2.1): rows_emitted + Σcount == records_in for
    // every collection — a broken invariant fails closed rather than
    // shipping a self-contradicting view.
    ledger.assertConserved();

    return boundStatusView({
      schemaVersion: 1,
      target,
      generatedAt,
      installation,
      capabilities: records,
      gaps,
      bindings: [],
      limitations,
      completeness,
      acceptance: "not-established-by-this-view",
    });
  }

  /** P0 keeps one typed rejection boundary for every mutation command; the
   *  command vocabulary lands with the ledger in P1/P2. Nothing here may
   *  write host state, assign authority or spawn work. */
  async function dispatch(command: unknown): Promise<DeskRejectionValue> {
    const named = isRecord(command) && typeof command.kind === "string"
      ? command.kind
      : "unknown";
    return DeskRejection.parse({
      ok: false,
      code: "CAPABILITY_GAP",
      message: `enforcement desk command '${named}' is not implemented at P0`,
      recovery: "P1+ assignment and a capability-audit pass are required before any desk mutation",
    });
  }

  return { readView, dispatch };
}
