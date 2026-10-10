import type { DeskRecoveryDeps, DeskRecoveryOutcome } from "../desk-recovery.ts";
type OperatorIo = NonNullable<DeskRecoveryDeps['io']> & {
  spawnGit?: (cwd: string) => string;
  realpath?: (path: string) => string;
};
type OperatorRequest = Omit<DeskRecoveryDeps, 'stableRoot' | 'repoKey' | 'io'> & {
  repository?: string;
  bridge?: boolean;
  home: string;
  io?: OperatorIo;
  userInfo?: () => {
    username: string;
  };
};
import type { RuntimeError } from './types.ts';
// Operator CLI adapter. Explicit/resolved home is the operator authority;
// the RPC provenance gate belongs to the plugin, not this single-shot command.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DESK_BRIDGE_REPO, repoKeyFor } from "../desk-paths.ts";
import { recoverDeskLockSync as recoverLock, recoveryOutput } from "../desk-recovery.ts";
export { DESK_BRIDGE_REPO, repoKeyFor } from "../desk-paths.ts";
export { recoverDeskLockSync as recoverLock, recoveryOutput } from "../desk-recovery.ts";

export class DeskRecoverUsage extends Error {
  constructor(message: string) { super(message); this.name = 'DeskRecoverUsage'; }
}
const summarize = (error: unknown, max = 200) => {
  const text = error instanceof Error ? (error as RuntimeError).message : String(error);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** `<repository>` → the canonical git common dir → repoKey (mirror of the
 *  P2-c resolution: rev-parse --git-common-dir then realpath). Failures are
 *  usage errors — the operator pointed at something that is not a repo. */
export function repoKeyOf(repository: string, io: OperatorIo = {}) {
  const spawnGit = io.spawnGit ?? (cwd => execFileSync('git',
    ['--no-optional-locks', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' }));
  const realpath = io.realpath ?? realpathSync;
  let commonDir;
  try {
    commonDir = spawnGit(repository).trim();
  } catch (error) {
    throw new DeskRecoverUsage(`cannot resolve ${repository} as a git repository: ${summarize(error)}`);
  }
  if (!isAbsolute(commonDir)) {
    throw new DeskRecoverUsage(`git reported a non-absolute common dir for ${repository}`);
  }
  return repoKeyFor({ hostId: 'local', gitCommonDir: realpath(commonDir) });
}

/** The CLI actor: `operator:cli:` + the local username. An empty username or
 *  a lookup exception is itself actor-invalid (A3) — the key is refused
 *  before any desk file operation, never truncated, never invented. */
export function cliActorKey(io: { userInfo?: () => { username: string } } = {}) {
  const info = io.userInfo ?? userInfo;
  const username = info().username;
  return `operator:cli:${username}`;
}

/** The desk-recover verb body: resolve the repo (input resolution — `git
 *  rev-parse` + realpath, not a desk file operation), resolve the home,
 *  resolve the actor, run the shared algorithm, return the strict output.
 *  Usage failures throw DeskRecoverUsage; every algorithmic outcome is a
 *  result, not an exception. A failed username lookup still produces the
 *  actor-invalid result — with a real repoKey in the receipt — and no desk
 *  file is ever touched on that path. */
export function deskRecover({ repository, bridge = false, home, io = {}, kill, now, uuid, pid, platform, userInfo: userInfoSeam }: OperatorRequest) {
  // The boundary rule is the same as the RPC surface: no raw exception ever
  // leaves — off-table faults (a throwing clock seam, an unresolvable home)
  // degrade to the internal-error outcome. DeskRecoverUsage stays a usage
  // error (exit 2 at the bin layer).
  let repoKey = null;
  try {
    const realpath = io.realpath ?? realpathSync;
    const nowFn = now ?? (() => new Date());
    // E-P2D-3 — the explicit --bridge flag resolves the sentinel repo key
    // for the desk-bridge lifecycle lock directly; no git invocation, no
    // realpath, and real-repo derivation is untouched.
    repoKey = bridge ? repoKeyFor(DESK_BRIDGE_REPO) : repoKeyOf(repository!, io);
    // A3 precedes any desk file operation — the actor resolves before the
    // home is even realpath'd; an invalid actor yields the result, nothing
    // under the stable root is touched.
    let actorKey = null;
    let actorError = null;
    try {
      actorKey = cliActorKey({ userInfo: userInfoSeam });
      if (actorKey === 'operator:cli:') throw new Error('empty username');
    } catch (error) {
      actorKey = null;
      actorError = error;
    }
    if (actorError !== null) {
      const outcome: DeskRecoveryOutcome = {
        ok: false,
        code: 'INVALID_RECORD',
        message: `actor-invalid: cannot resolve the local username: ${summarize(actorError)}`,
        recovery: 'run as an account with a resolvable POSIX username; the actor key is never invented or truncated',
        receipt: {
          schemaVersion: 1, repoKey, actorKey: 'operator:cli:', at: nowFn().toISOString(),
          result: 'actor-invalid', pid: null, instanceNonce: null,
          auditAppended: false, recoverLockReleased: null,
        },
      };
      return { outcome, output: recoveryOutput(outcome) };
    }
    const stableRoot = join(realpath(home), 'slp-runtime');
    const outcome = recoverLock(
      { stableRoot, repoKey, platform, uuid, now, pid, kill, io },
      { actorKey: actorKey! },
    );
    return { outcome, output: recoveryOutput(outcome) };
  } catch (error) {
    if (error instanceof DeskRecoverUsage) throw error;
    const outcome: DeskRecoveryOutcome = {
      ok: false,
      code: 'RECOVERY_REQUIRED',
      message: `internal-error: ${summarize(error)}`,
      recovery: `slp-runtime/state/enforcement/repos/${repoKey ?? 'unresolved'}/lock`,
      receipt: {
        schemaVersion: 1, repoKey: repoKey ?? 'f'.repeat(64), actorKey: 'operator:cli:',
        at: new Date().toISOString(),
        result: 'internal-error', pid: null, instanceNonce: null,
        auditAppended: false, recoverLockReleased: null,
      },
    };
    return { outcome, output: recoveryOutput(outcome) };
  }
}
