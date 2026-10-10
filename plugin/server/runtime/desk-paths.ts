// Desk namespace layout and identity shared by the store and recovery adapters.
import { join } from "node:path";
import { createHash } from "node:crypto";

/** The one repoKey algorithm label — schema literal and namespace refinement
 *  both read it from here; nothing else may restate it. */
export const REPO_KEY_ALGORITHM = "sha256(hostId|gitCommonDir)@1";

const deskStateDir = (stableRoot: string) => join(stableRoot, "state");
const deskEnforcementDir = (stableRoot: string) => join(deskStateDir(stableRoot), "enforcement");

/** The repos root every repo namespace lives under — the companion owner
 *  for callers (the P2-e projection) that scan the root itself rather than
 *  one repo's paths. The join rule lives here and nowhere else. */
export function deskReposDir(stableRoot: string): string {
  return join(deskEnforcementDir(stableRoot), "repos");
}

/** The repo-directory layout recovery shares with the store — the single
 *  owner of every path join under the stable root, so the store, the
 *  recovery module and the projection never restate a join rule.
 *  `acquireLock`/`releaseLock` are unchanged. */
export function deskRepoPaths(stableRoot: string, repoKey: string): {
  stateDir: string;
  enforcementDir: string;
  baseDir: string;
  repoDir: string;
  eventsDir: string;
  ledgerPath: string;
  lockPath: string;
  recoverLockPath: string;
  auditPath: string;
} {
  const baseDir = deskReposDir(stableRoot);
  const repoDir = join(baseDir, repoKey);
  return {
    stateDir: deskStateDir(stableRoot),
    enforcementDir: deskEnforcementDir(stableRoot),
    baseDir,
    repoDir,
    eventsDir: join(repoDir, "events"),
    ledgerPath: join(repoDir, "ledger.json"),
    lockPath: join(repoDir, "lock"),
    recoverLockPath: join(repoDir, "recover.lock"),
    auditPath: join(repoDir, "recovery-log.jsonl"),
  };
}
/** Exported for the P2-e bindings projection — repo directory names are
 *  filtered by this pattern before any ledger read (§4.1). */
export const REPO_KEY_PATTERN = /^[0-9a-f]{64}$/;
/** The pure repoKey derivation — the only place the join rule lives. */
export function repoKeyFor(repo: { hostId: string; gitCommonDir: string }): string {
  return createHash("sha256").update(`${repo.hostId}|${repo.gitCommonDir}`).digest("hex");
}

/** P2-d — the reserved repo descriptor the desk-bridge lifecycle lock lives
 *  under. The values are a sentinel, never a real repository: they keep the
 *  lock inside the single path-owner rule (`repos/<repoKey>/lock`) and let
 *  the operator recovery seam reach it like any other orphaned repo lock.
 *  `gitCommonDir` is a marker string, not a path. */
export const DESK_BRIDGE_REPO = {
  hostId: "desk-bridge",
  gitCommonDir: "desk-bus",
} as const;
