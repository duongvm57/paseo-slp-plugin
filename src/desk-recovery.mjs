// src/desk-recovery.mjs — CLI mirror of plugin/server/desk-recovery.ts (P2-e).
//
// One algorithm, two implementations (contract §3.1): the installed runtime
// ships only bin/ + src/, so this file carries its own copy of the pins —
// WIRE_LIMITS in plugin/shared/enforcement.ts is the owner; the values here
// are mirrored verbatim, never restated differently:
//   recoverActorKey = 128   (actor key refused, never truncated, past the cap)
//   recoverNonce    = 64    (opaque bounded nonce — length only, no format pin;
//                          the writer emits randomUUID, the reader just bounds)
//
// Unlink happens only when the lock reads, its pid is a positive integer,
// kill(pid, 0) throws ESRCH, the bytes are unchanged on re-read, and the
// pre-unlink audit line is durable. No force mode — there is no `expected`
// input and no `--force` flag (a `--force` flag is a usage error upstream).
// The CLI never applies the RPC's A1/A2 provenance gate: the operator's
// explicit/resolved home IS the authority here (§3.4).
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';

const RECOVER_ACTOR_KEY = 128;
const RECOVER_NONCE = 64;
const PRIVATE_FILE_MODE = 0o600;
const REPO_KEY_PATTERN = /^[0-9a-f]{64}$/;

export class DeskRecoverUsage extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeskRecoverUsage';
  }
}

const summarize = (error, max = 200) => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// Mirror of repoKeyFor (plugin/server/desk-store.ts): the same join rule,
// hostId "local", sha256 hex.
export function repoKeyFor({ hostId, gitCommonDir }) {
  return createHash('sha256').update(`${hostId}|${gitCommonDir}`).digest('hex');
}

// Mirror of DESK_BRIDGE_REPO (plugin/server/desk-store.ts): the reserved
// repo descriptor the desk-bridge lifecycle lock lives under — a sentinel,
// never a real repository. Reached only via the explicit --bridge flag.
export const DESK_BRIDGE_REPO = { hostId: 'desk-bridge', gitCommonDir: 'desk-bus' };

// Mirror of deskRepoPaths (plugin/server/desk-store.ts) — the single owner of
// every path join under the stable root; kept verbatim, nothing restated.
const deskRepoPaths = (stableRoot, repoKey) => {
  const stateDir = join(stableRoot, 'state');
  const enforcementDir = join(stateDir, 'enforcement');
  const baseDir = join(enforcementDir, 'repos');
  const repoDir = join(baseDir, repoKey);
  return {
    stateDir,
    enforcementDir,
    baseDir,
    repoDir,
    eventsDir: join(repoDir, 'events'),
    lockPath: join(repoDir, 'lock'),
    recoverLockPath: join(repoDir, 'recover.lock'),
    auditPath: join(repoDir, 'recovery-log.jsonl'),
  };
};

const lstatOrNull = path => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const fsyncDirectory = (path, platform) => {
  if (platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const parseHolder = bytes => {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 &&
          typeof parsed.instanceNonce === 'string' && parsed.instanceNonce !== '' &&
          parsed.instanceNonce.length <= RECOVER_NONCE) {
        return { pid: parsed.pid, instanceNonce: parsed.instanceNonce };
      }
    }
  } catch { /* unparseable */ }
  return null;
};

const classifyKill = (pid, kill) => {
  try { kill(pid); return 'alive'; }
  catch (error) {
    if (error.code === 'ESRCH') return 'esrch';
    if (error.code === 'EPERM') return 'eperm';
    return 'undetermined';
  }
};

/** §3.1 — the one recovery algorithm. `deps.io` is the fault-injection seam
 *  the parity tests share with the plugin surface; production passes none.
 *  Synchronous by design — the CLI is a single-shot process. */
export function recoverLock(deps, input) {
  const platform = deps.platform ?? process.platform;
  const io = {
    readFileSync: path => readFileSync(path),
    openSync: (p, flags, mode) => openSync(p, flags, mode),
    writeSync: (fd, data) => writeSync(fd, data),
    fsyncSync: fd => fsyncSync(fd),
    closeSync: fd => closeSync(fd),
    unlinkSync: p => unlinkSync(p),
    fsyncDirectory: p => fsyncDirectory(p, platform),
    lstatOrNull,
    ...deps.io,
  };
  const uuid = deps.uuid ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());
  const kill = deps.kill ?? (pid => process.kill(pid, 0));
  const pidOfSelf = deps.pid ?? process.pid;
  const paths = deskRepoPaths(deps.stableRoot, deps.repoKey);
  const lockPtr = `slp-runtime/state/enforcement/repos/${deps.repoKey}/lock`;
  const rlPtr = `slp-runtime/state/enforcement/repos/${deps.repoKey}/recover.lock`;
  const manualRl = `inspect ${rlPtr}; remove it manually only after confirming no recoverer is running`;

  const ctx = { rlReleased: null, auditAppended: false };
  // The clock seam is read inside the try — a throwing clock degrades to
  // internal-error like every other off-table exception (§3.2); the catch
  // falls back to the real clock for the receipt's `at`.
  let at = null;

  try {
    at = now().toISOString();
    const base = { schemaVersion: 1, repoKey: deps.repoKey, actorKey: input.actorKey, at };

    const reject = (result, code, message, recovery, pid, nonce, auditAppended) => ({
      ok: false,
      code,
      message,
      recovery,
      receipt: { ...base, result, pid, instanceNonce: nonce, auditAppended, recoverLockReleased: null },
    });
    const pass = (result, pid, nonce, auditAppended) => ({
      ok: true, code: null, message: null, recovery: null,
      receipt: { ...base, result, pid, instanceNonce: nonce, auditAppended, recoverLockReleased: null },
    });

    // A3 — actorKey cap, before any file operation. The rejected key goes
    // into the receipt verbatim: never truncated, never invented.
    if (input.actorKey.length === 0 || input.actorKey.length > RECOVER_ACTOR_KEY) {
      return reject('actor-invalid', 'INVALID_RECORD',
        input.actorKey.length === 0
          ? 'actor-invalid: actorKey is empty'
          : `actor-invalid: actorKey length ${input.actorKey.length} exceeds ${RECOVER_ACTOR_KEY}`,
        'use a shorter actor identity; the actor key is never truncated', null, null, false);
    }

    // Step 1 — namespace safety, the same ancestor chain transact checks.
    for (const p of [
      deps.stableRoot,
      paths.stateDir,
      paths.enforcementDir,
      paths.baseDir,
      paths.repoDir,
      paths.eventsDir,
    ]) {
      const stat = io.lstatOrNull(p);
      if (stat !== null && (!stat.isDirectory() || stat.isSymbolicLink())) {
        return reject('unsafe', 'STATE_UNREADABLE',
          'unsafe: the desk namespace contains a symlink or non-directory',
          'restore a real directory path under maintenance authority', null, null, false);
      }
    }

    // Step 2 — create recover.lock (O_EXCL, no wait, no retry). EEXIST →
    // group B; any other error → A5.
    const instanceNonce = uuid();
    const rlContent = JSON.stringify({ pid: pidOfSelf, instanceNonce, startedAt: at });
    let rlFd = null;
    try {
      rlFd = io.openSync(paths.recoverLockPath, 'wx', PRIVATE_FILE_MODE);
      try { io.writeSync(rlFd, rlContent); io.fsyncSync(rlFd); } finally { io.closeSync(rlFd); }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        // A5 — best-effort unlink of the recover.lock this call just created;
        // no other recoverer could own it (O_EXCL won or it did not exist).
        if (rlFd !== null) {
          try { io.unlinkSync(paths.recoverLockPath); } catch { /* best-effort */ }
        }
        return reject('recover-lock-io', 'STATE_UNREADABLE',
          `recover-lock-io: cannot create recover.lock: ${summarize(error)}`,
          'inspect the repo directory under maintenance authority', null, null, false);
      }
      // Group B — RL exists; classify its holder.
      let rlHolder = null;
      try {
        rlHolder = parseHolder(io.readFileSync(paths.recoverLockPath));
      } catch (readError) {
        if (readError.code === 'ENOENT') {
          return reject('busy', 'CAPABILITY_GAP',
            'busy: another recoverer just released recover.lock', null, null, null, false);
        }
        return reject('recover-lock-orphan', 'RECOVERY_REQUIRED',
          `recover-lock-orphan: cannot read recover.lock: ${summarize(readError)}`,
          manualRl, null, null, false);
      }
      if (rlHolder !== null) {
        const alive = classifyKill(rlHolder.pid, kill);
        if (alive === 'alive' || alive === 'eperm') {
          return reject('busy', 'CAPABILITY_GAP',
            `busy: recover.lock held by live pid ${rlHolder.pid} (instance ${rlHolder.instanceNonce})`,
            null, rlHolder.pid, rlHolder.instanceNonce, false);
        }
      }
      // B3 — holder not proven alive; RL is never removed automatically.
      return reject('recover-lock-orphan', 'RECOVERY_REQUIRED',
        `recover-lock-orphan: recover.lock holder is not proven alive (pid ${rlHolder?.pid ?? 'unreadable'}, instance ${rlHolder?.instanceNonce ?? 'unreadable'})`,
        manualRl, rlHolder?.pid ?? null, rlHolder?.instanceNonce ?? null, false);
    }

    const inner = () => {
      try {
        // Step 3 — read the lock bytes (one readFileSync).
        let lockBytes;
        try {
          lockBytes = io.readFileSync(paths.lockPath);
        } catch (readError) {
          if (readError.code === 'ENOENT') return pass('no-lock', null, null, false);
          return reject('unreadable', 'RECOVERY_REQUIRED',
            `unreadable: cannot read lock: ${summarize(readError)}`, lockPtr, null, null, false);
        }
        const holder = parseHolder(lockBytes);
        if (holder === null) {
          return reject('unreadable', 'RECOVERY_REQUIRED',
            'unreadable: lock content is not a valid holder record', lockPtr, null, null, false);
        }

        // Step 4 — classify the holder.
        const alive = classifyKill(holder.pid, kill);
        if (alive === 'alive' || alive === 'eperm') {
          return reject('held', 'CAPABILITY_GAP',
            `held: lock holder pid ${holder.pid} is alive (instance ${holder.instanceNonce})`,
            null, holder.pid, holder.instanceNonce, false);
        }
        if (alive === 'undetermined') {
          return reject('undetermined', 'RECOVERY_REQUIRED',
            `undetermined: kill(pid ${holder.pid}) threw an unexpected error`,
            lockPtr, holder.pid, holder.instanceNonce, false);
        }

        // Step 5 — ESRCH only: re-read and compare bytes byte-for-byte.
        let recheck;
        try {
          recheck = io.readFileSync(paths.lockPath);
        } catch (readError) {
          if (readError.code === 'ENOENT') {
            return reject('changed', 'CAPABILITY_GAP',
              'changed: the lock vanished between reads', null, holder.pid, holder.instanceNonce, false);
          }
          return reject('unreadable', 'RECOVERY_REQUIRED',
            `unreadable: re-read failed: ${summarize(readError)}`, lockPtr, holder.pid, holder.instanceNonce, false);
        }
        if (!recheck.equals(lockBytes)) {
          return reject('changed', 'CAPABILITY_GAP',
            'changed: the lock bytes changed between reads', null, holder.pid, holder.instanceNonce, false);
        }

        // Step 6 — append the audit line (one write, line + \n), fsync the
        // file, and fsync the directory when this call created it. Any
        // failure → D3, no unlink.
        const lockSha256 = createHash('sha256').update(lockBytes).digest('hex');
        const auditLine = JSON.stringify({
          schemaVersion: 1, phase: 'pre-unlink', at, actorKey: input.actorKey,
          repoKey: deps.repoKey, pid: holder.pid, instanceNonce: holder.instanceNonce, lockSha256,
        }) + '\n';
        try {
          const auditCreated = io.lstatOrNull(paths.auditPath) === null;
          const auditFd = io.openSync(paths.auditPath, 'a', PRIVATE_FILE_MODE);
          try { io.writeSync(auditFd, auditLine); io.fsyncSync(auditFd); } finally { io.closeSync(auditFd); }
          if (auditCreated) io.fsyncDirectory(paths.repoDir);
        } catch (auditError) {
          return reject('audit-failed', 'RECOVERY_REQUIRED',
            `audit-failed: cannot append the pre-unlink audit line: ${summarize(auditError)}`,
            lockPtr, holder.pid, holder.instanceNonce, false);
        }
        ctx.auditAppended = true;

        // Step 7 — unlink the lock, then fsync the repo directory.
        try {
          io.unlinkSync(paths.lockPath);
        } catch (unlinkError) {
          if (unlinkError.code === 'ENOENT') {
            return reject('changed', 'CAPABILITY_GAP',
              'changed: the lock was removed by another party after the audit',
              null, holder.pid, holder.instanceNonce, true);
          }
          return reject('unlink-failed', 'RECOVERY_REQUIRED',
            `unlink-failed: cannot unlink the lock: ${summarize(unlinkError)}`,
            lockPtr, holder.pid, holder.instanceNonce, true);
        }
        try {
          io.fsyncDirectory(paths.repoDir);
        } catch (fsyncError) {
          return reject('unlink-unsynced', 'RECOVERY_REQUIRED',
            `unlink-unsynced: the lock was unlinked but the directory fsync failed: ${summarize(fsyncError)}`,
            lockPtr, holder.pid, holder.instanceNonce, true);
        }
        return pass('recovered', holder.pid, holder.instanceNonce, true);
      } finally {
        // Group E — always try to release our own recover.lock: re-read it,
        // unlink only when pid + nonce still match ours.
        try {
          const rlNow = parseHolder(io.readFileSync(paths.recoverLockPath));
          if (rlNow !== null && rlNow.pid === pidOfSelf && rlNow.instanceNonce === instanceNonce) {
            io.unlinkSync(paths.recoverLockPath);
            ctx.rlReleased = true;
          } else {
            ctx.rlReleased = false;
          }
        } catch {
          ctx.rlReleased = false;
        }
      }
    };

    const outcome = inner();
    outcome.receipt.recoverLockReleased = ctx.rlReleased;
    if (ctx.rlReleased === false) {
      // E2 — keep the C/D result in the receipt; the envelope becomes a
      // rejection pointing at the recover.lock we could not release.
      outcome.ok = false;
      outcome.code = 'RECOVERY_REQUIRED';
      outcome.message = `recover-lock-release-failed: ${outcome.receipt.result}`;
      outcome.recovery = manualRl;
    }
    return outcome;
  } catch (error) {
    // Off-table exception → internal-error; recoverLockReleased follows E.
    // `at` may be unset when the clock seam itself threw — the receipt falls
    // back to the real clock so it still satisfies the wire schema.
    return {
      ok: false,
      code: 'RECOVERY_REQUIRED',
      message: `internal-error: ${summarize(error)}`,
      recovery: lockPtr,
      receipt: {
        schemaVersion: 1, repoKey: deps.repoKey, actorKey: input.actorKey,
        at: at ?? new Date().toISOString(),
        result: 'internal-error', pid: null, instanceNonce: null,
        auditAppended: ctx.auditAppended, recoverLockReleased: ctx.rlReleased,
      },
    };
  }
}

/** The strict §3.4 wire shape — the same object the RPC returns and the
 *  --json flag prints, key order preserved. */
export function recoveryOutput(outcome) {
  if (outcome.ok) return { ok: true, receipt: outcome.receipt };
  return {
    ok: false,
    code: outcome.code,
    message: outcome.message,
    recovery: outcome.recovery,
    receipt: outcome.receipt,
  };
}

/** `<repository>` → the canonical git common dir → repoKey (mirror of the
 *  P2-c resolution: rev-parse --git-common-dir then realpath). Failures are
 *  usage errors — the operator pointed at something that is not a repo. */
export function repoKeyOf(repository, io = {}) {
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
export function cliActorKey(io = {}) {
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
export function deskRecover({ repository, bridge = false, home, io = {}, kill, now, uuid, pid, platform, userInfo: userInfoSeam }) {
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
    repoKey = bridge ? repoKeyFor(DESK_BRIDGE_REPO) : repoKeyOf(repository, io);
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
      const outcome = {
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
      { actorKey },
    );
    return { outcome, output: recoveryOutput(outcome) };
  } catch (error) {
    if (error instanceof DeskRecoverUsage) throw error;
    const outcome = {
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
