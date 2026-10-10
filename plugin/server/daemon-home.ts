// Daemon-home verification (§8.1) — one implementation shared by the
// manager and the jev module: canonical realpath, a real directory, a
// readable regular config.json, and a real slp-runtime directory (a
// symlinked stableRoot would redirect credential writes outside the
// canonical home). Every failure is a HOME_UNVERIFIED OperationConflict.
//
// The two callers keep their distinct message for a non-regular
// config.json — the manager names the link case, jev keeps its generic
// wording — passed as `notRegularConfigMessage`. The returned `configPath`
// is carried by the manager's HomeContext; the jev module ignores it.
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OperationConflict } from "../shared/contracts.ts";

export interface HomeContext {
  canonicalHome: string;
  configPath: string;
  stableRoot: string;
}

export function resolveDaemonHome(
  target: { hostId: string; daemonHome: string },
  notRegularConfigMessage: string,
): HomeContext {
  let canonicalHome: string;
  try {
    canonicalHome = realpathSync(target.daemonHome);
  } catch {
    throw new OperationConflict(
      "HOME_UNVERIFIED",
      `daemon home does not resolve: ${target.daemonHome}`,
      { path: target.daemonHome },
    );
  }
  const homeStat = lstatSync(canonicalHome);
  if (!homeStat.isDirectory()) {
    throw new OperationConflict("HOME_UNVERIFIED", "daemon home is not a directory", {
      path: canonicalHome,
    });
  }
  const configPath = join(canonicalHome, "config.json");
  let configStat;
  try {
    configStat = lstatSync(configPath);
  } catch {
    throw new OperationConflict(
      "HOME_UNVERIFIED",
      "daemon home lacks a readable regular config.json",
      { path: configPath },
    );
  }
  if (!configStat.isFile() || configStat.isSymbolicLink()) {
    throw new OperationConflict("HOME_UNVERIFIED", notRegularConfigMessage, {
      path: configPath,
    });
  }
  const stableRoot = join(canonicalHome, "slp-runtime");
  try {
    const rootStat = lstatSync(stableRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new OperationConflict(
        "HOME_UNVERIFIED",
        "slp-runtime exists but is not a real directory",
        { path: stableRoot },
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { canonicalHome, configPath, stableRoot };
}

// The plugin child inherits the daemon's environment: PASEO_HOME when the
// daemon exported it, else the platform default ~/.paseo — the same detection
// the session-usage plugin uses. The `source` distinguishes them: only an
// exported env value is proof the plugin serves that home ("default" is a
// guess). This is a prefill suggestion only for the Manager UI; the §4
// verifiedHostHomeMapping acknowledgment remains a human decision.
export function detectDaemonHome(): { daemonHome: string; source: "env" | "default" } {
  const raw = (process.env.PASEO_HOME ?? "").trim();
  if (!raw) return { daemonHome: join(homedir(), ".paseo"), source: "default" };
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return { daemonHome: resolve(expanded), source: "env" };
}

/** The single receipt↔target predicate shared by the manager's
 *  `resolveReceipt` and the enforcement read view: a receipt is the caller's
 *  evidence only when it names the same hostId and the same canonical
 *  (realpath) home it was written against. Both callers pass an
 *  already-canonicalized home — receipts store `ctx.canonicalHome` verbatim,
 *  so the match is strict. */
export function receiptMatchesTarget(
  receipt: { hostId: string; daemonHome: string },
  caller: { hostId: string; canonicalHome: string },
): boolean {
  return receipt.hostId === caller.hostId && receipt.daemonHome === caller.canonicalHome;
}
