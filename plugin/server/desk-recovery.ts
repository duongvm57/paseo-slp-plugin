// Operator-only RPC adapter: provenance, schemas and output bounds belong here.
// The shared recovery engine never runs on an unverified or foreign home.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  RecoverLockInput, RecoverLockOutput, WIRE_LIMITS,
  type DeskRecoveryResultValue, type RecoverLockOutputValue,
} from "../shared/enforcement.ts";
import { MAX_RPC_BYTES, OperationConflict } from "../shared/contracts.ts";
import { detectDaemonHome } from "./daemon-home.ts";
import { DESK_BRIDGE_REPO, repoKeyFor } from "./runtime/desk-paths.ts";
import {
  recoverDeskLockAsync, recoveryOutput,
  type DeskRecoveryDeps, type DeskRecoveryOutcome,
} from "./runtime/desk-recovery.ts";
export { recoveryOutput } from "./runtime/desk-recovery.ts";
export type { DeskRecoveryReceipt, DeskRecoveryOutcome, DeskRecoveryIo, DeskRecoveryHooks, DeskRecoveryDeps } from "./runtime/desk-recovery.ts";

function summarize(error: unknown, max = 200): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Preserve the RPC's diagnostic caps; the CLI retains full diagnostics. */
export async function recoverDeskLock(deps: DeskRecoveryDeps, input: { actorKey: string }): Promise<DeskRecoveryOutcome> {
  const outcome = await recoverDeskLockAsync(deps, input);
  if (outcome.ok) return outcome;
  return {
    ...outcome,
    message: outcome.message.slice(0, WIRE_LIMITS.rejectionMessage),
    recovery: outcome.recovery === null ? null : outcome.recovery.slice(0, WIRE_LIMITS.rejectionRecovery),
  };
}

// ---------------------------------------------------------------------------
// RPC surface — provenance gate (A1/A2) + output shaping. The algorithm above
// never runs on an unverified or foreign home.
// ---------------------------------------------------------------------------

/** The final emit guard for the recovery output — same contract as
 *  boundStatusView: schema-invalid or over-bound output is producer-invalid
 *  and fails closed with IO_FAILURE, never a truncated envelope. */
export function boundRecoveryOutput(output: unknown): RecoverLockOutputValue {
  const parsed = RecoverLockOutput.safeParse(output);
  if (!parsed.success) {
    throw new OperationConflict(
      "IO_FAILURE",
      "enforcement-recover-lock produced a schema-invalid output — withheld",
    );
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > MAX_RPC_BYTES) {
    throw new OperationConflict(
      "IO_FAILURE",
      "enforcement-recover-lock output exceeds the 64 KiB bound — withheld",
    );
  }
  return parsed.data;
}

export interface RecoverLockRpcDeps extends Omit<DeskRecoveryDeps, "stableRoot" | "repoKey"> {
  /** Served-home detection seam — defaults to the real env/default probe. */
  detectDaemonHome?: () => { daemonHome: string; source: "env" | "default" };
  realpath?: (path: string) => string;
}

/** The `enforcement-recover-lock` RPC entrypoint: input schema + 64 KiB
 *  request bound, then the §3.4 provenance gate (A1 home-unverified /
 *  A2 target-mismatch), then the shared algorithm with the fixed
 *  `operator:rpc` actor. Every branch returns the strict output through the
 *  bound guard; off-table exceptions degrade to `internal-error`. */
export async function recoverLockView(
  input: unknown,
  deps: RecoverLockRpcDeps = {},
): Promise<RecoverLockOutputValue> {
  const parsed = RecoverLockInput.safeParse(input);
  if (!parsed.success) {
    throw new OperationConflict(
      "INVALID_REQUEST",
      `invalid enforcement-recover-lock input: ${parsed.error.issues[0]?.message ?? "schema"}`,
    );
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_RPC_BYTES) {
    throw new OperationConflict("INVALID_REQUEST", "input exceeds the 64 KiB bound");
  }
  const { target, repo } = parsed.data;
  const actorKey = "operator:rpc";
  // E-P2D-3 — the explicit sentinel descriptor reaches the P2-d desk-bridge
  // lifecycle lock; every other input keeps real-repo derivation verbatim.
  const repoKey = "sentinel" in repo
    ? repoKeyFor(DESK_BRIDGE_REPO)
    : repoKeyFor({ hostId: "local", gitCommonDir: repo.gitCommonDir });
  // The clock seam reads inside the try — a throwing clock degrades to
  // internal-error like every other off-table exception (§3.2); the catch
  // falls back to the real clock for the receipt's `at`.
  let at: string | null = null;

  try {
    at = (deps.now ?? (() => new Date()))().toISOString();
    const baseReceipt = {
      schemaVersion: 1 as const,
      repoKey,
      actorKey,
      at,
      pid: null,
      instanceNonce: null,
      auditAppended: false,
      recoverLockReleased: null,
    };
    const gateReject = (
      result: DeskRecoveryResultValue,
      code: "CAPABILITY_GAP" | "ACTOR_MISMATCH",
      message: string,
      recovery: string,
    ): RecoverLockOutputValue => boundRecoveryOutput({
      ok: false,
      code,
      message,
      recovery,
      receipt: { ...baseReceipt, result },
    });


    // A1 — only an exported PASEO_HOME proves which home this process serves;
    // a default guess never receives a mutation.
    const detect = deps.detectDaemonHome ?? detectDaemonHome;
    const served = detect();
    if (served.source !== "env") {
      return gateReject(
        "home-unverified",
        "CAPABILITY_GAP",
        "served-home-unverified: PASEO_HOME is not exported, so this daemon's home is a default guess and recovery will not mutate it",
        "run `node <installed-runtime>/bin/slp.mjs desk-recover <repository> --paseo-home <exact-home>` with this daemon's real home, or export PASEO_HOME for the daemon and retry the RPC",
      );
    }
    // A2 — the caller's home must realpath to this daemon's canonical home;
    // an unresolvable target is a mismatch, never a silent pass.
    const realpath = deps.realpath ?? realpathSync;
    let canonicalServed: string;
    try {
      canonicalServed = realpath(served.daemonHome);
      if (realpath(target.daemonHome) !== canonicalServed) {
        return gateReject(
          "target-mismatch",
          "ACTOR_MISMATCH",
          "target-mismatch: target.daemonHome does not realpath to this daemon's served home",
          "point target.daemonHome at the home this daemon serves, or use the desk-recover CLI with --paseo-home",
        );
      }
    } catch {
      return gateReject(
        "target-mismatch",
        "ACTOR_MISMATCH",
        "target-mismatch: target or served home path does not resolve",
        "point target.daemonHome at the home this daemon serves, or use the desk-recover CLI with --paseo-home",
      );
    }

    const outcome = await recoverDeskLock(
      { ...deps, stableRoot: join(canonicalServed, "slp-runtime"), repoKey },
      { actorKey },
    );
    return boundRecoveryOutput(recoveryOutput(outcome));
  } catch (error) {
    if (error instanceof OperationConflict) throw error;
    // Belt-and-suspenders boundary: no raw exception ever leaves the RPC.
    return boundRecoveryOutput(recoveryOutput({
      ok: false,
      code: "RECOVERY_REQUIRED",
      message: `internal-error: ${summarize(error)}`,
      recovery: `slp-runtime/state/enforcement/repos/${repoKey}/lock`,
      receipt: {
        schemaVersion: 1,
        repoKey,
        actorKey,
        at: at ?? new Date().toISOString(),
        pid: null,
        instanceNonce: null,
        auditAppended: false,
        recoverLockReleased: null,
        result: "internal-error" as const,
      },
    }));
  }
}
