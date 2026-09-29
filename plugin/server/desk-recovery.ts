// plugin/server/desk-recovery.ts — P2-e desk lock recovery (operator-only).
// Unlinks an orphan desk repo lock when and only when the lock reads, its
// pid is a positive integer, kill(pid, 0) throws ESRCH, the bytes are
// unchanged on re-read, and the pre-unlink audit line is durable (P2-e §3.1).
// No force mode, no `expected` field, no --force flag. The provenance gate
// (exported PASEO_HOME + realpath match, A1/A2) is the RPC layer's job; the
// actor-key cap (A3) and the namespace check (A4) run here, before any file
// operation.
//
// Authority (Supervisor S2): recovery is operator-only — never in a hook,
// never inside a transact. The spawn path (P2-c) keeps Q3 fail-open and never
// imports this module.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  RecoverLockInput,
  RecoverLockOutput,
  WIRE_LIMITS,
  type DeskRecoveryResultValue,
  type RecoverLockOutputValue,
} from "../shared/enforcement.ts";
import { MAX_RPC_BYTES, OperationConflict } from "../shared/contracts.ts";
import { detectDaemonHome } from "./daemon-home.ts";
import { DESK_BRIDGE_REPO, deskRepoPaths, repoKeyFor } from "./desk-store.ts";
import { fsyncDirectory, lstatOrNull, PRIVATE_FILE_MODE } from "./kept-files.ts";

export interface DeskRecoveryReceipt {
  schemaVersion: 1;
  repoKey: string;
  actorKey: string;
  at: string;
  result: DeskRecoveryResultValue;
  pid: number | null;
  instanceNonce: string | null;
  auditAppended: boolean;
  recoverLockReleased: boolean | null;
}

type RecoveryCode = "CAPABILITY_GAP" | "ACTOR_MISMATCH" | "INVALID_RECORD" | "STATE_UNREADABLE" | "RECOVERY_REQUIRED";

/** The internal outcome envelope. The wire shape (§3.4) projects this as
 *  `{ ok: true, receipt }` or `{ ok: false, code, message, recovery,
 *  receipt }` — the discriminated union keeps code/message non-null on
 *  rejection so the wire projection needs no casts. */
export type DeskRecoveryOutcome =
  | { ok: true; code: null; message: null; recovery: null; receipt: DeskRecoveryReceipt }
  | { ok: false; code: RecoveryCode; message: string; recovery: string | null; receipt: DeskRecoveryReceipt };

/** Injectable IO seam — deterministic fault injection for the §7 oracles
 *  (no sleeps, no probabilistic loops). Every member is one syscall. */
export interface DeskRecoveryIo {
  readFileSync(path: string): Buffer;
  openSync(path: string, flags: "wx" | "a", mode?: number): number;
  writeSync(fd: number, data: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  unlinkSync(path: string): void;
  fsyncDirectory(path: string): void;
  lstatOrNull(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean } | null;
}

/** Barrier hooks for the deterministic race schedules (§7 L1/L2/L2b/L3) —
 *  each fires synchronously at its protocol point and may return a promise,
 *  so a child-process recoverer can park on an IPC barrier exactly like the
 *  P2-a `faults` seam. Production never passes `hooks`. */
export interface DeskRecoveryHooks {
  /** Fires after recover.lock is created, before the lock read. */
  recoverLockHeld?: () => void | Promise<void>;
  /** Fires after the holder classified ESRCH, before the byte re-read. */
  beforeLockRecheck?: () => void | Promise<void>;
}

export interface DeskRecoveryDeps {
  stableRoot: string;
  repoKey: string;
  platform?: string;
  uuid?: () => string;
  now?: () => Date;
  pid?: number;
  kill?: (pid: number) => void;
  io?: Partial<DeskRecoveryIo>;
  hooks?: DeskRecoveryHooks;
}

function summarize(error: unknown, max = 200): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface LockHolder { pid: number; instanceNonce: string; }

/** Strict holder record: positive-integer pid + bounded nonce. Anything else
 *  (unparseable, pid ≤ 0, oversized nonce) is not a holder — the caller maps
 *  it to `unreadable`/`recover-lock-orphan` per §3.2. */
function parseHolder(bytes: Buffer): LockHolder | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.pid === "number" && Number.isInteger(rec.pid) && rec.pid > 0 &&
          typeof rec.instanceNonce === "string" && rec.instanceNonce !== "" &&
          rec.instanceNonce.length <= WIRE_LIMITS.recoverNonce) {
        return { pid: rec.pid, instanceNonce: rec.instanceNonce };
      }
    }
  } catch { /* unparseable */ }
  return null;
}

type KillOutcome = "alive" | "esrch" | "eperm" | "undetermined";

function classifyKill(pid: number, kill: (pid: number) => void): KillOutcome {
  try { kill(pid); return "alive"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "esrch";
    if (code === "EPERM") return "eperm";
    return "undetermined";
  }
}

/** §3.1 — the one recovery algorithm, shared verbatim by the RPC handler and
 *  the CLI mirror. Never throws to the caller: any exception outside the
 *  precedence table becomes `internal-error` here and again at the surface
 *  boundary (belt and suspenders — the contract forbids raw exceptions). */
export async function recoverDeskLock(
  deps: DeskRecoveryDeps,
  input: { actorKey: string },
): Promise<DeskRecoveryOutcome> {
  const platform = deps.platform ?? process.platform;
  const io: DeskRecoveryIo = {
    readFileSync: path => readFileSync(path),
    openSync: (p, flags, mode) => openSync(p, flags, mode),
    writeSync: (fd, data) => writeSync(fd, data),
    fsyncSync: fd => fsyncSync(fd),
    closeSync: fd => closeSync(fd),
    unlinkSync: p => unlinkSync(p),
    fsyncDirectory: p => fsyncDirectory(p, platform),
    lstatOrNull: p => lstatOrNull(p),
    ...deps.io,
  };
  const uuid = deps.uuid ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 0));
  const pidOfSelf = deps.pid ?? process.pid;
  const paths = deskRepoPaths(deps.stableRoot, deps.repoKey);
  const lockPtr = `slp-runtime/state/enforcement/repos/${deps.repoKey}/lock`;
  const rlPtr = `slp-runtime/state/enforcement/repos/${deps.repoKey}/recover.lock`;
  const manualRl = `inspect ${rlPtr}; remove it manually only after confirming no recoverer is running`;

  // Group E runs after every C/D outcome: rlReleased stays null while the
  // recoverer never held RL, becomes true/false from the finally cleanup.
  const ctx = { rlReleased: null as boolean | null, auditAppended: false };
  // The clock seam is read inside the try — a throwing clock degrades to
  // internal-error like every other off-table exception (§3.2); the catch
  // falls back to the real clock for the receipt's `at`.
  let at: string | null = null;

  try {
    at = now().toISOString();
    const base = { schemaVersion: 1 as const, repoKey: deps.repoKey, actorKey: input.actorKey, at };

    const reject = (
      result: DeskRecoveryResultValue,
      code: RecoveryCode,
      message: string,
      recovery: string | null,
      pid: number | null,
      nonce: string | null,
      auditAppended: boolean,
    ): DeskRecoveryOutcome => ({
      ok: false,
      code,
      message: message.slice(0, WIRE_LIMITS.rejectionMessage),
      recovery: recovery === null ? null : recovery.slice(0, WIRE_LIMITS.rejectionRecovery),
      receipt: { ...base, result, pid, instanceNonce: nonce, auditAppended, recoverLockReleased: null },
    });
    const pass = (
      result: DeskRecoveryResultValue,
      pid: number | null,
      nonce: string | null,
      auditAppended: boolean,
    ): DeskRecoveryOutcome => ({
      ok: true, code: null, message: null, recovery: null,
      receipt: { ...base, result, pid, instanceNonce: nonce, auditAppended, recoverLockReleased: null },
    });

    // A3 — actorKey cap, before any file operation. The rejected key goes
    // into the receipt verbatim: never truncated, never invented.
    if (input.actorKey.length === 0 || input.actorKey.length > WIRE_LIMITS.recoverActorKey) {
      return reject("actor-invalid", "INVALID_RECORD",
        input.actorKey.length === 0
          ? "actor-invalid: actorKey is empty"
          : `actor-invalid: actorKey length ${input.actorKey.length} exceeds ${WIRE_LIMITS.recoverActorKey}`,
        "use a shorter actor identity; the actor key is never truncated", null, null, false);
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
        return reject("unsafe", "STATE_UNREADABLE",
          "unsafe: the desk namespace contains a symlink or non-directory",
          "restore a real directory path under maintenance authority", null, null, false);
      }
    }

    // Step 2 — create recover.lock (O_EXCL, no wait, no retry). EEXIST →
    // group B; any other error → A5.
    const instanceNonce = uuid();
    const rlContent = JSON.stringify({ pid: pidOfSelf, instanceNonce, startedAt: at });
    let rlFd: number | null = null;
    try {
      rlFd = io.openSync(paths.recoverLockPath, "wx", PRIVATE_FILE_MODE);
      try { io.writeSync(rlFd, rlContent); io.fsyncSync(rlFd); } finally { io.closeSync(rlFd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // A5 — best-effort unlink of the recover.lock this call just created
        // (O_EXCL won, so only we could own it); "bytes unchanged" holds.
        if (rlFd !== null) {
          try { io.unlinkSync(paths.recoverLockPath); } catch { /* best-effort */ }
        }
        return reject("recover-lock-io", "STATE_UNREADABLE",
          `recover-lock-io: cannot create recover.lock: ${summarize(error)}`,
          "inspect the repo directory under maintenance authority", null, null, false);
      }
      // Group B — RL exists; classify its holder.
      let rlHolder: LockHolder | null;
      try {
        rlHolder = parseHolder(io.readFileSync(paths.recoverLockPath));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
          return reject("busy", "CAPABILITY_GAP",
            "busy: another recoverer just released recover.lock", null, null, null, false);
        }
        return reject("recover-lock-orphan", "RECOVERY_REQUIRED",
          `recover-lock-orphan: cannot read recover.lock: ${summarize(readError)}`,
          manualRl, null, null, false);
      }
      if (rlHolder !== null) {
        const alive = classifyKill(rlHolder.pid, kill);
        if (alive === "alive" || alive === "eperm") {
          return reject("busy", "CAPABILITY_GAP",
            `busy: recover.lock held by live pid ${rlHolder.pid} (instance ${rlHolder.instanceNonce})`,
            null, rlHolder.pid, rlHolder.instanceNonce, false);
        }
      }
      // B3 — holder not proven alive (unreadable, unparseable, pid ≤ 0,
      // ESRCH, or another kill error). RL is never removed automatically.
      return reject("recover-lock-orphan", "RECOVERY_REQUIRED",
        `recover-lock-orphan: recover.lock holder is not proven alive (pid ${rlHolder?.pid ?? "unreadable"}, instance ${rlHolder?.instanceNonce ?? "unreadable"})`,
        manualRl, rlHolder?.pid ?? null, rlHolder?.instanceNonce ?? null, false);
    }
    // RL is held from here on; the inner closure returns the C/D outcome and
    // its finally performs the group-E cleanup before we patch the receipt.
    // The recoverLockHeld hook fires INSIDE inner so a throwing hook still
    // passes through the finally — every exit after RL creation runs cleanup.
    const inner = async (): Promise<DeskRecoveryOutcome> => {
      try {
        await deps.hooks?.recoverLockHeld?.();

        // Step 3 — read the lock bytes (one readFileSync).
        let lockBytes: Buffer;
        try {
          lockBytes = io.readFileSync(paths.lockPath);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
            return pass("no-lock", null, null, false);
          }
          return reject("unreadable", "RECOVERY_REQUIRED",
            `unreadable: cannot read lock: ${summarize(readError)}`, lockPtr, null, null, false);
        }
        const holder = parseHolder(lockBytes);
        if (holder === null) {
          return reject("unreadable", "RECOVERY_REQUIRED",
            "unreadable: lock content is not a valid holder record", lockPtr, null, null, false);
        }

        // Step 4 — classify the holder.
        const alive = classifyKill(holder.pid, kill);
        if (alive === "alive" || alive === "eperm") {
          return reject("held", "CAPABILITY_GAP",
            `held: lock holder pid ${holder.pid} is alive (instance ${holder.instanceNonce})`,
            null, holder.pid, holder.instanceNonce, false);
        }
        if (alive === "undetermined") {
          return reject("undetermined", "RECOVERY_REQUIRED",
            `undetermined: kill(pid ${holder.pid}) threw an unexpected error`,
            lockPtr, holder.pid, holder.instanceNonce, false);
        }
        await deps.hooks?.beforeLockRecheck?.();

        // Step 5 — ESRCH only: re-read and compare bytes byte-for-byte.
        let recheck: Buffer;
        try {
          recheck = io.readFileSync(paths.lockPath);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
            return reject("changed", "CAPABILITY_GAP",
              "changed: the lock vanished between reads", null, holder.pid, holder.instanceNonce, false);
          }
          return reject("unreadable", "RECOVERY_REQUIRED",
            `unreadable: re-read failed: ${summarize(readError)}`, lockPtr, holder.pid, holder.instanceNonce, false);
        }
        if (!recheck.equals(lockBytes)) {
          return reject("changed", "CAPABILITY_GAP",
            "changed: the lock bytes changed between reads", null, holder.pid, holder.instanceNonce, false);
        }

        // Step 6 — append the audit line (one write, line + \n), fsync the
        // file, and fsync the directory when this call created it. Any
        // failure → D3, no unlink.
        const lockSha256 = createHash("sha256").update(lockBytes).digest("hex");
        const auditLine = JSON.stringify({
          schemaVersion: 1, phase: "pre-unlink", at, actorKey: input.actorKey,
          repoKey: deps.repoKey, pid: holder.pid, instanceNonce: holder.instanceNonce, lockSha256,
        }) + "\n";
        try {
          const auditCreated = io.lstatOrNull(paths.auditPath) === null;
          const auditFd = io.openSync(paths.auditPath, "a", PRIVATE_FILE_MODE);
          try { io.writeSync(auditFd, auditLine); io.fsyncSync(auditFd); } finally { io.closeSync(auditFd); }
          if (auditCreated) io.fsyncDirectory(paths.repoDir);
        } catch (auditError) {
          return reject("audit-failed", "RECOVERY_REQUIRED",
            `audit-failed: cannot append the pre-unlink audit line: ${summarize(auditError)}`,
            lockPtr, holder.pid, holder.instanceNonce, false);
        }
        ctx.auditAppended = true;

        // Step 7 — unlink the lock, then fsync the repo directory.
        try {
          io.unlinkSync(paths.lockPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code === "ENOENT") {
            return reject("changed", "CAPABILITY_GAP",
              "changed: the lock was removed by another party after the audit",
              null, holder.pid, holder.instanceNonce, true);
          }
          return reject("unlink-failed", "RECOVERY_REQUIRED",
            `unlink-failed: cannot unlink the lock: ${summarize(unlinkError)}`,
            lockPtr, holder.pid, holder.instanceNonce, true);
        }
        try {
          io.fsyncDirectory(paths.repoDir);
        } catch (fsyncError) {
          return reject("unlink-unsynced", "RECOVERY_REQUIRED",
            `unlink-unsynced: the lock was unlinked but the directory fsync failed: ${summarize(fsyncError)}`,
            lockPtr, holder.pid, holder.instanceNonce, true);
        }
        return pass("recovered", holder.pid, holder.instanceNonce, true);
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

    const outcome = await inner();
    outcome.receipt.recoverLockReleased = ctx.rlReleased;
    if (ctx.rlReleased === false) {
      // E2 — keep the C/D result in the receipt; the envelope becomes a
      // rejection pointing at the recover.lock we could not release.
      outcome.ok = false;
      outcome.code = "RECOVERY_REQUIRED";
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
      code: "RECOVERY_REQUIRED",
      message: `internal-error: ${summarize(error)}`.slice(0, WIRE_LIMITS.rejectionMessage),
      recovery: lockPtr,
      receipt: {
        schemaVersion: 1, repoKey: deps.repoKey, actorKey: input.actorKey,
        at: at ?? new Date().toISOString(),
        result: "internal-error", pid: null, instanceNonce: null,
        auditAppended: ctx.auditAppended, recoverLockReleased: ctx.rlReleased,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// RPC surface — provenance gate (A1/A2) + output shaping. The algorithm above
// never runs on an unverified or foreign home.
// ---------------------------------------------------------------------------

/** The strict §3.4 wire output — key order is load-bearing (the CLI --json
 *  mirror prints this same object): `{ ok: true, receipt }` on success,
 *  `{ ok: false, code, message, recovery, receipt }` on rejection. */
export function recoveryOutput(outcome: DeskRecoveryOutcome): RecoverLockOutputValue {
  if (outcome.ok) {
    return { ok: true, receipt: outcome.receipt };
  }
  return {
    ok: false,
    code: outcome.code,
    message: outcome.message,
    recovery: outcome.recovery,
    receipt: outcome.receipt,
  };
}

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
