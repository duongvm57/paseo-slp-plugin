// plugin/server/injection-binding.ts — the O1 "usable-for-injection"
// predicate. readInjectionBinding resolves the live ActiveBinding for the
// agent.create/session_open hooks; role-injection.ts is unchanged — a throw
// here aborts the create, null becomes its "no active binding" error.
//
// Deliberate differences from readRuntimePin (P2-b), per Supervisor Q1/Q2:
//  - the served daemon home is accepted however it resolved — an exported
//    env value AND the platform default both count (no unverified-home
//    gate, and the default-home guess is unchanged pre-O1 behavior);
//  - a pending operation is usable, and ACTIVATING carrying a binding is
//    usable: the manager commits the replacement binding atomically with
//    ACTIVE, so any binding recorded under ACTIVATING is the intact old
//    binding;
//  - DEACTIVATING and RECOVERY_REQUIRED fail closed — no new managed seat
//    spawns while the install drains or waits on recovery. Running
//    sessions never read this predicate, so they are unaffected.
//
// Limitation: the injection path has no caller hostId, so only the daemon
// home side of the target is checked (contract §5).
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { detectDaemonHome } from "./daemon-home.ts";
import type { Journal } from "./journal.ts";
import type { ActiveBinding } from "./role-injection.ts";

export interface InjectionBindingDeps {
  /** The durable-read primitive — `journal.read` only. */
  journal: Pick<Journal, "read">;
  /** Served-home detection seam — defaults to the real env/default probe. */
  detectDaemonHome?: () => { daemonHome: string; source: "env" | "default" };
  /** Home canonicalization seam — defaults to realpathSync. */
  realpath?: (path: string) => string;
}

// Bounded, marker-carrying refusal — names the state or home in play and
// carries no secret material.
function refused(marker: string, detail: string): Error {
  return new Error(`SLP role injection refused (${marker}): ${detail}`.slice(0, 400));
}

// Contract §2, in order: canonicalize the served home (a realpath failure
// propagates), journal-read the receipt under <home>/slp-runtime (journal
// conflicts propagate), absent receipt → null, the receipt's target home
// must equal this canonical home, then the state × binding table.
export function readInjectionBinding(deps: InjectionBindingDeps): ActiveBinding | null {
  const detect = deps.detectDaemonHome ?? detectDaemonHome;
  const realpath = deps.realpath ?? realpathSync;
  const home = realpath(detect().daemonHome);
  const receipt = deps.journal.read(join(home, "slp-runtime"));
  if (receipt === null) return null;
  if (receipt.target.daemonHome !== home) {
    throw refused(
      "target-mismatch",
      `receipt targets daemon home ${receipt.target.daemonHome} but this daemon resolved ${home}`,
    );
  }
  const { state, binding } = receipt;
  if (state === "DEACTIVATING") {
    throw refused("state-deactivating", `receipt at ${home} is DEACTIVATING`);
  }
  if (state === "RECOVERY_REQUIRED") {
    throw refused(
      "state-recovery-required",
      `receipt at ${home} is RECOVERY_REQUIRED; recover the install before spawning managed seats`,
    );
  }
  if (state === "INACTIVE") {
    if (binding !== null) {
      throw refused(
        "state-inconsistent",
        `receipt at ${home} is INACTIVE yet still carries a binding`,
      );
    }
    return null;
  }
  if (binding === null) return null; // ACTIVE/ACTIVATING without a committed binding
  return {
    candidateSha256: binding.candidateSha256,
    payloadSha256: binding.payloadSha256,
    runtimePath: binding.runtimePath,
    nodePath: binding.node.path,
    daemonHome: receipt.target.daemonHome,
  };
}
