// plugin/server/runtime-pin.ts — the RuntimePin producer (P2-b).
//
// `readRuntimePin` is the single closed predicate that decides whether the
// verified served home's install receipt currently binds a runtime — the
// only place an "active binding" verdict for verification is produced
// (`readActiveBinding` in role-injection stays untouched; that is the O1
// slice). The checks run in a fixed order and the first failing step
// decides the outcome: `bound` (pin + canonical digest), `not-bound` (one
// closed reason), or a thrown OperationConflict fault — a fault is never
// folded into not-bound.
//
// Everything is read-only: the journal's existing receipt parser is the
// only receipt read, daemon-home.ts supplies home detection/verification
// and the target predicate, materializer's verifyPublished is the runtime
// integrity oracle, and config-view's canonicalSha256 is the only
// canonicalizer — the pin digests, the component hashes and pinSha256 all
// come from it. Nothing here writes files, mutates the receipt or holds
// the manager mutation mutex.

import { realpathSync } from "node:fs";
import {
  GetRuntimePinInput,
  GetRuntimePinOutput,
  type GetRuntimePinOutputValue,
  type RuntimePinReasonValue,
  type RuntimePinValue,
} from "../shared/enforcement.ts";
import { MAX_RPC_BYTES, OperationConflict } from "../shared/contracts.ts";
import { canonicalSha256 } from "./config-view.ts";
import { detectDaemonHome, receiptMatchesTarget, resolveDaemonHome } from "./daemon-home.ts";
import { pendingOperation, type Journal } from "./journal.ts";

export interface RuntimePinDeps {
  /** The durable-read primitive — `journal.read` only. */
  journal: Pick<Journal, "read">;
  /** Published-candidate integrity oracle (materializer.verifyPublished). */
  verifyPublished: (runtimePath: string, candidateSha256: string, payloadSha256: string) => Promise<void>;
  /** Served-home detection seam — defaults to the real env/default probe. */
  detectDaemonHome?: () => { daemonHome: string; source: "env" | "default" };
  now?: () => Date;
}

export type RuntimePinVerdict =
  | { result: "bound"; pin: RuntimePinValue; pinSha256: string }
  | { result: "not-bound"; reason: RuntimePinReasonValue };

function summarize(error: unknown, max = 200): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The §3 closed predicate. Throws OperationConflict on fault —
 *  HOME_UNVERIFIED (home resolution), the journal's own codes (e.g.
 *  RECOVERY_REQUIRED) and the integrity oracle's codes pass through
 *  verbatim; any other exception becomes IO_FAILURE. */
export async function readRuntimePin(
  target: { hostId: string; daemonHome: string },
  deps: RuntimePinDeps,
): Promise<RuntimePinVerdict> {
  const detect = deps.detectDaemonHome ?? detectDaemonHome;
  try {
    // 1 — only an exported PASEO_HOME proves which home this process serves.
    const served = detect();
    if (served.source !== "env") return { result: "not-bound", reason: "unverified-home" };

    // 2a — canonical home verification; failure is a HOME_UNVERIFIED fault.
    const home = resolveDaemonHome(
      { hostId: "local", daemonHome: served.daemonHome },
      "served daemon home config.json is not a regular file",
    );

    // 2b — the caller's home must be this daemon's canonical home. A
    // resolved-but-different path is target-mismatch; a realpath that
    // throws is an exception, which the outer catch maps to IO_FAILURE —
    // errors are never swallowed into not-bound.
    if (realpathSync(target.daemonHome) !== home.canonicalHome) {
      return { result: "not-bound", reason: "target-mismatch" };
    }

    // 3 — the journal is the only receipt read; its typed conflicts pass.
    const receipt = deps.journal.read(home.stableRoot);
    if (receipt === null) return { result: "not-bound", reason: "no-receipt" };

    // 4 — a receipt naming another target is not this caller's evidence.
    if (!receiptMatchesTarget(receipt.target, { hostId: target.hostId, canonicalHome: home.canonicalHome })) {
      return { result: "not-bound", reason: "target-mismatch" };
    }

    // 5/6 — the binding must be settled: ACTIVE state, no active or pending op.
    if (receipt.state !== "ACTIVE") return { result: "not-bound", reason: "state-not-active" };
    if (receipt.activeOperationId !== null || pendingOperation(receipt) !== undefined) {
      return { result: "not-bound", reason: "operation-pending" };
    }

    // 7/8 — a binding must exist and the published runtime must verify.
    const binding = receipt.binding;
    if (binding === null) return { result: "not-bound", reason: "no-binding" };
    await deps.verifyPublished(binding.runtimePath, binding.candidateSha256, binding.payloadSha256);

    // 9 — emit the pin: binding fields verbatim, owned/binaries as digests,
    // bridge fields null until a later slice lands the bridge.
    const pin: RuntimePinValue = {
      schemaVersion: 1,
      state: "ACTIVE",
      candidateSha256: binding.candidateSha256,
      payloadSha256: binding.payloadSha256,
      launchSetSha256: binding.launchSetSha256,
      launchManifestSha256: binding.launchManifestSha256,
      bindingSha256: binding.bindingSha256,
      policyBundleSha256: canonicalSha256(binding.owned),
      binariesSha256: canonicalSha256(binding.binaries),
      node: { path: binding.node.path, version: binding.node.version },
      bridgeSha256: null,
      bridgeProtocolVersion: null,
      target: { hostId: target.hostId, daemonHome: home.canonicalHome },
      receiptRevision: receipt.revision,
      snapshotAlgorithmVersion: "slp-snapshot/package.mjs",
      recordContractVersion: 1,
    };
    return { result: "bound", pin, pinSha256: canonicalSha256(pin) };
  } catch (error) {
    if (error instanceof OperationConflict) throw error;
    throw new OperationConflict("IO_FAILURE", `runtime-pin predicate failed: ${summarize(error)}`);
  }
}

/** The fixed limitations every runtime-pin view carries, in order. */
export const RUNTIME_PIN_LIMITATIONS = [
  "a bound pin describes the installed runtime; it does not prove which runtime a seat actually executes",
  "the pin authority is this plugin view; CLI verification compares only a caller-supplied candidate hash",
] as const;

/** The final emit guard — same contract as boundStatusView: the view must
 *  satisfy the output schema, the bound pin's digest must equal
 *  canonicalSha256(pin) (the shared schema cannot hash, so the wire-level
 *  equality is enforced here), and the serialized view must fit the
 *  MAX_RPC_BYTES envelope. Producer-invalid or over-bound output throws
 *  IO_FAILURE before emit; there is no floor-as-success. Exported so tests
 *  exercise the guard directly. */
export function boundRuntimePinView(output: GetRuntimePinOutputValue): GetRuntimePinOutputValue {
  const parsed = GetRuntimePinOutput.safeParse(output);
  if (!parsed.success) {
    throw new OperationConflict(
      "IO_FAILURE",
      "enforcement-runtime-pin produced a schema-invalid view — withheld",
    );
  }
  if (parsed.data.result === "bound" && parsed.data.pinSha256 !== canonicalSha256(parsed.data.pin)) {
    throw new OperationConflict(
      "IO_FAILURE",
      "enforcement-runtime-pin emitted a pinSha256 that does not match its pin — withheld",
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
  if (bytes > MAX_RPC_BYTES) {
    throw new OperationConflict(
      "IO_FAILURE",
      `enforcement-runtime-pin view is ${bytes} bytes — over the ${MAX_RPC_BYTES}-byte bound`,
    );
  }
  return parsed.data;
}

/** The RPC entrypoint: validate the caller input (INVALID_REQUEST), apply
 *  the same 64 KiB envelope bound to the request, run the predicate and
 *  emit through the guard. No mutation path exists here. */
export async function readRuntimePinView(
  input: unknown,
  deps: RuntimePinDeps,
): Promise<GetRuntimePinOutputValue> {
  const parsed = GetRuntimePinInput.safeParse(input);
  if (!parsed.success) {
    throw new OperationConflict(
      "INVALID_REQUEST",
      `invalid enforcement-runtime-pin input: ${parsed.error.issues[0]?.message ?? "schema"}`,
    );
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_RPC_BYTES) {
    throw new OperationConflict("INVALID_REQUEST", "input exceeds the 64 KiB bound");
  }
  const now = deps.now ?? (() => new Date());
  // The predicate's own typed faults (steps 2a/3/8) keep their codes.
  const verdict = await readRuntimePin(parsed.data.target, deps);
  try {
    // Timestamping and emit live inside the RPC mapping layer: a throwing
    // clock seam or an invalid Date must surface as IO_FAILURE — never a
    // raw exception, and never another OperationConflict code (P2B-C1/S2).
    return boundRuntimePinView({
      schemaVersion: 1,
      target: parsed.data.target,
      generatedAt: now().toISOString(),
      result: verdict.result,
      reason: verdict.result === "bound" ? null : verdict.reason,
      pin: verdict.result === "bound" ? verdict.pin : null,
      pinSha256: verdict.result === "bound" ? verdict.pinSha256 : null,
      limitations: [...RUNTIME_PIN_LIMITATIONS],
      acceptance: "not-established-by-this-view",
    });
  } catch (error) {
    // Only the emit guard's own IO_FAILURE passes verbatim; every other
    // exception on this path — including an OperationConflict thrown by
    // the clock seam — is an emit-layer IO_FAILURE.
    if (error instanceof OperationConflict && error.code === "IO_FAILURE") throw error;
    throw new OperationConflict("IO_FAILURE", `runtime-pin emit failed: ${summarize(error)}`);
  }
}
