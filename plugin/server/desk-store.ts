// plugin/server/desk-store.ts — the durable desk store kernel (P2-a).
//
// One store per repoKey under <stableRoot>/state/enforcement/repos/<repoKey>/:
//   ledger.json        — the atomic document: header, repo binding, revision,
//                        bounded requests table (idempotency), last event tip
//   lock               — O_EXCL lockfile {pid, instanceNonce, startedAt};
//                        never stolen, never deleted for another instance
//   events/<f>-<l>.jsonl — immutable per-commit segments carrying the hash
//                        chain; the ledger.json rename is the commit point
//
// Invariants (contract §1):
//   - an acknowledged mutation is never lost: crash anywhere in the commit
//     protocol leaves either the old ledger or the committed one, plus at
//     most an orphan segment and an orphan lock (recovery is P2-e's);
//   - replay of (actorKey, assignmentId, requestId) with the same body
//     returns the recorded result verbatim; a different body is
//     IDEMPOTENCY_CONFLICT;
//   - the lockfile is never preempted: a live holder answers CAPABILITY_GAP,
//     a dead or unreadable holder answers RECOVERY_REQUIRED;
//   - a corrupt, schema-invalid, future-version, broken-chain or unsafe-path
//     ledger fails closed — only an ABSENT ledger is empty;
//   - decide is synchronous and pure; a thenable is a caller error, never a
//     commit.
//
// Only the journal's canonicalizer is used (canonicalSha256), receipt I/O is
// untouched, and the module writes nowhere outside <stableRoot>/state/
// enforcement/.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Family, OperationConflict, Sha, Time } from "../shared/contracts.ts";
import {
  DeskRejection,
  WIRE_LIMITS,
  type DeskRejectionValue,
} from "../shared/enforcement.ts";
import { ROLES } from "../shared/families.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./config-view.ts";
import {
  ensurePrivateDirectory,
  fsyncDirectory,
  lstatOrNull,
  PRIVATE_FILE_MODE,
} from "./kept-files.ts";

// ---------------------------------------------------------------------------
// Limits and identities — LEDGER_LIMITS is the sole owner of these caps.
// ---------------------------------------------------------------------------

export const LEDGER_LIMITS = {
  requests: 4096,
  eventsPerCommit: 64,
  eventKind: 64,
  eventPayloadBytes: 16384,
  idLen: 128,
  lockWaitMs: 2000,
  ledgerBytes: 16777216,
  memberships: 4096,
  pathLen: 4096,
  unboundTtlMs: 86400000,
  registrationWindowMs: 600000,
  ttlSweepPerCommit: 60,
  hookGitProbeMs: 2000,
  hookDeskTransactMs: 5000,
} as const;

const LEDGER_FORMAT = "paseo-slp/enforcement";
const LEDGER_SCHEMA_VERSION = 2;
/** The one repoKey algorithm label — schema literal and namespace refinement
 *  both read it from here; nothing else may restate it. */
export const REPO_KEY_ALGORITHM = "sha256(hostId|gitCommonDir)@1";
const CANONICALIZATION = "slp-canonical-json/1";
const REPO_KEY_PATTERN = /^[0-9a-f]{64}$/;
const SEGMENT_NAME = /^(\d+)-(\d+)\.jsonl$/;
const LOCK_RETRY_MS = 25;

/** The pure repoKey derivation — the only place the join rule lives. */
export function repoKeyFor(repo: { hostId: string; gitCommonDir: string }): string {
  return sha256Hex(`${repo.hostId}|${repo.gitCommonDir}`);
}

// ---------------------------------------------------------------------------
// Schemas — strict zod, header-first read, cross-field refinement layered on.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BoundedId = z.string().min(1).max(LEDGER_LIMITS.idLen);
const JsonObject = z
  .record(z.string(), z.unknown())
  .refine(value => isRecord(value), { message: "expected a JSON object" });

const EventSchema = z
  .object({
    seq: z.number().int().min(1),
    prevSha256: Sha.nullable(),
    sha256: Sha,
    at: Time,
    requestId: BoundedId,
    actorKey: BoundedId,
    assignmentId: BoundedId,
    kind: z.string().min(1).max(LEDGER_LIMITS.eventKind),
    payload: JsonObject,
  })
  .strict()
  .superRefine((event, ctx) => {
    try {
      const bytes = Buffer.byteLength(canonicalJson(event.payload), "utf8");
      if (bytes > LEDGER_LIMITS.eventPayloadBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload"],
          message: `payload exceeds ${LEDGER_LIMITS.eventPayloadBytes} canonical bytes`,
        });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "payload is not canonicalizable JSON" });
    }
  });

const RequestRecordSchema = z
  .object({
    actorKey: BoundedId,
    assignmentId: BoundedId,
    requestId: BoundedId,
    bodySha256: Sha,
    canonicalization: z.literal(CANONICALIZATION),
    receiptId: z.string().uuid(),
    revision: z.number().int().min(0),
    outcome: z.enum(["committed", "rejected"]),
    eventSeqs: z.tuple([z.number().int().min(1), z.number().int().min(1)]).nullable(),
    rejection: DeskRejection.nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.outcome === "committed" && record.rejection !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "committed record carries a rejection" });
    }
    if (record.outcome === "rejected" && (record.rejection === null || record.eventSeqs !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rejected record must carry its rejection and eventSeqs:null",
      });
    }
    if (record.eventSeqs !== null && record.eventSeqs[0] > record.eventSeqs[1]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "eventSeqs range is inverted" });
    }
  });

const RepoSchema = z
  .object({
    repoKey: Sha,
    repoKeyAlgorithm: z.literal(REPO_KEY_ALGORITHM),
    hostId: z.string().min(1).max(WIRE_LIMITS.targetHostId),
    gitCommonDir: z.string().min(1).max(WIRE_LIMITS.targetDaemonHome),
  })
  .strict();

const isAbsolutePath = (value: string): boolean => value.startsWith("/");

/** P2-c membership states — the subset of SeatBindingState the handshake
 *  writes; `attached`/`active` belong to P2-e and no P2-c path creates
 *  them (guard is checked again in the seat decide). */
const MEMBERSHIP_STATES = ["unbound-open", "host-confirmed", "revoked"] as const;
const REVOKE_REASONS = [
  "archived",
  "expired-unbound",
  "registration-mismatch",
  "registration-timeout",
] as const;

/** v2 membership row (contract §2). Deliberately narrower than the P0 §5
 *  Membership: duty/epoch/seatRuntime/hostSessionId/nativeHandle/
 *  observedParentAgentId arrive in v3 (P2-e) by another additive
 *  migration — P2-c has no writer for them. The raw handle is never
 *  stored; only its SHA-256. */
const MembershipSchema = z
  .object({
    membershipId: z.string().uuid(),
    state: z.enum(MEMBERSHIP_STATES),
    bindingHandleSha256: Sha,
    provider: z.string().min(1).max(LEDGER_LIMITS.idLen),
    family: Family,
    role: z.enum(ROLES),
    createCwd: z.string().min(1).max(LEDGER_LIMITS.pathLen).refine(isAbsolutePath),
    openGeneration: z.literal(1),
    agentId: z.string().min(1).max(WIRE_LIMITS.agentId).nullable(),
    workspaceId: z.string().min(1).max(LEDGER_LIMITS.idLen).nullable(),
    createdAt: Time,
    hostConfirmedAt: Time.nullable(),
    registeredAt: Time.nullable(),
    revokedAt: Time.nullable(),
    revokeReason: z.enum(REVOKE_REASONS).nullable(),
  })
  .strict();

const LedgerBodyFields = {
  format: z.literal(LEDGER_FORMAT),
  repo: RepoSchema,
  revision: z.number().int().min(0),
  createdAt: Time,
  updatedAt: Time,
  lastEventSeq: z.number().int().min(0),
  lastEventSha256: Sha.nullable(),
  requests: z.array(RequestRecordSchema).max(LEDGER_LIMITS.requests),
} as const;

/** v1 — the P2-a shape, kept only so `read`/`transact` can migrate it
 *  in-memory (MIGRATIONS[1]). Never written again. */
const LedgerSchemaV1 = z
  .object({ ...LedgerBodyFields, schemaVersion: z.literal(1) })
  .strict();

/** v2 — adds `memberships` (C2). Every other field is untouched. */
const LedgerSchema = z
  .object({
    ...LedgerBodyFields,
    schemaVersion: z.literal(LEDGER_SCHEMA_VERSION),
    memberships: z.array(MembershipSchema).max(LEDGER_LIMITS.memberships),
  })
  .strict();

/** Additive ledger migrations keyed by the on-disk schemaVersion. Pure: the
 *  input is never mutated; the output reuses the frozen input's records
 *  verbatim. v1 → v2 adds the empty memberships table (C2); requests and
 *  events are untouched. */
export const MIGRATIONS = {
  1: (ledger: z.infer<typeof LedgerSchemaV1>): LedgerValue => ({
    ...ledger,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    memberships: [],
  }),
} as const;

const EnvelopeSchema = z
  .object({
    repo: z
      .object({
        hostId: z.string().min(1).max(WIRE_LIMITS.targetHostId),
        gitCommonDir: z.string().min(1).max(WIRE_LIMITS.targetDaemonHome),
      })
      .strict(),
    actorKey: BoundedId,
    assignmentId: BoundedId,
    requestId: BoundedId,
    command: JsonObject,
  })
  .strict();

const DecideEventSchema = z.object({ kind: z.string().min(1).max(LEDGER_LIMITS.eventKind), payload: JsonObject }).strict();

export type LedgerValue = z.infer<typeof LedgerSchema>;
export type MembershipValue = z.infer<typeof MembershipSchema>;
export type RequestRecordValue = z.infer<typeof RequestRecordSchema>;
export type EventValue = z.infer<typeof EventSchema>;
export type DeskStoreEnvelope = z.infer<typeof EnvelopeSchema>;

/** Read outcomes — `diagnostics.code` is a closed vocabulary, never a free
 *  string: corrupt (invalid-json | header-invalid | schema-invalid |
 *  refinement-failed | hash-chain-broken | oversized), future
 *  (future-version), unsafe (unsafe-path | not-regular-file |
 *  repo-key-invalid | repo-mismatch). */
export type DeskStoreRead =
  | { state: "absent" }
  | { state: "ok"; ledger: LedgerValue; persistedSchemaVersion: 1 | 2 }
  | { state: "corrupt" | "future" | "unsafe"; diagnostics: { code: string; schemaVersion: number | null } };

export type TransactReceipt = {
  receiptId: string;
  revision: number;
  replayed: boolean;
  eventSeqs: [number, number] | null;
};
export type TransactResult = { ok: true; receipt: TransactReceipt } | DeskRejectionValue;

type DecideOutcome =
  | {
      ok: true;
      events: { kind: string; payload: Record<string, unknown> }[];
      /** §2.2 decide → state channel: when present, the FULL replacement
       *  memberships table. When absent, the snapshot's table carries over
       *  verbatim (P2-a behavior). Schema- and refinement-checked by the
       *  store; seat semantics stay in the decide. */
      memberships?: MembershipValue[];
    }
  | DeskRejectionValue;
export type DecideFunction = (ledger: Readonly<LedgerValue>, command: Record<string, unknown>) => DecideOutcome;

/** Internal test seam — production never passes `faults`. Each hook runs
 *  synchronously at its commit-protocol point; a hook may throw (maps to
 *  IO_FAILURE) or SIGKILL the process, and `lockHeld`/`lockWait` may return
 *  a promise so cross-process tests can barrier deterministically over IPC. */
export interface DeskStoreFaults {
  beforeLock?: () => void | Promise<void>;
  lockHeld?: () => void | Promise<void>;
  lockWait?: () => void | Promise<void>;
  segmentTempWritten?: () => void | Promise<void>;
  segmentRenamed?: () => void | Promise<void>;
  ledgerCommitted?: () => void | Promise<void>;
  afterComplete?: () => void | Promise<void>;
}

export interface DeskStoreDeps {
  stableRoot: string;
  platform?: string;
  uuid?: () => string;
  now?: () => Date;
  faults?: DeskStoreFaults;
}

export interface DeskStore {
  read(repoKey: string): DeskStoreRead;
  transact(repoKey: string, envelope: unknown, decide: DecideFunction): Promise<TransactResult>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function summarize(error: unknown, max = 200): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rejection(code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue {
  return {
    ok: false,
    code,
    message: message.slice(0, WIRE_LIMITS.rejectionMessage),
    recovery: recovery.slice(0, WIRE_LIMITS.rejectionRecovery),
  };
}

const invalidRecord = (message: string, recovery = "correct the record and resubmit") =>
  rejection("INVALID_RECORD", message, recovery);

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".")}: ${issue.message}` : "schema";
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createDeskStore(deps: DeskStoreDeps): DeskStore {
  const platform = deps.platform ?? process.platform;
  const uuid = deps.uuid ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());
  const faults = deps.faults ?? {};
  const instanceNonce = uuid();
  const mutex = new Map<string, Promise<void>>();

  const baseDir = join(deps.stableRoot, "state", "enforcement", "repos");
  const repoDir = (repoKey: string) => join(baseDir, repoKey);
  const eventsDir = (repoKey: string) => join(repoDir(repoKey), "events");
  const ledgerPath = (repoKey: string) => join(repoDir(repoKey), "ledger.json");
  const lockPath = (repoKey: string) => join(repoDir(repoKey), "lock");

  /** The ancestor chain must be real directories all the way down; a
   *  symlinked or non-directory component makes the namespace unsafe. */
  function unsafeAncestors(repoKey: string): boolean {
    for (const path of [
      deps.stableRoot,
      join(deps.stableRoot, "state"),
      join(deps.stableRoot, "state", "enforcement"),
      baseDir,
      repoDir(repoKey),
      eventsDir(repoKey),
    ]) {
      const stat = lstatOrNull(path);
      if (stat !== null && (!stat.isDirectory() || stat.isSymbolicLink())) return true;
    }
    return false;
  }

  /** §2 cross-field refinement — everything the body schema cannot express.
   *  Returns the read-state classification: repo/namespace violations are
   *  unsafe, the rest are corrupt. The algorithm label is pinned by the
   *  z.literal in RepoSchema — a divergent value never reaches this layer. */
  function checkRefinements(ledger: LedgerValue, repoKey: string): DeskStoreRead | null {
    if (ledger.repo.repoKey !== repoKeyFor(ledger.repo) || ledger.repo.repoKey !== repoKey) {
      return { state: "unsafe", diagnostics: { code: "repo-mismatch", schemaVersion: ledger.schemaVersion } };
    }
    const keys = new Set<string>();
    for (const record of ledger.requests) {
      const key = JSON.stringify([record.actorKey, record.assignmentId, record.requestId]);
      if (keys.has(key)) {
        return { state: "corrupt", diagnostics: { code: "refinement-failed", schemaVersion: ledger.schemaVersion } };
      }
      keys.add(key);
      if (record.eventSeqs !== null && record.eventSeqs[1] > ledger.lastEventSeq) {
        return { state: "corrupt", diagnostics: { code: "refinement-failed", schemaVersion: ledger.schemaVersion } };
      }
    }
    if ((ledger.lastEventSeq === 0) !== (ledger.lastEventSha256 === null)) {
      return { state: "corrupt", diagnostics: { code: "refinement-failed", schemaVersion: ledger.schemaVersion } };
    }
    // Membership refinements (contract §2): state ⇔ null invariants, a
    // unique handle hash, and at most one live row per agentId.
    const corrupt = (): DeskStoreRead => ({
      state: "corrupt",
      diagnostics: { code: "refinement-failed", schemaVersion: ledger.schemaVersion },
    });
    const handles = new Set<string>();
    const liveAgents = new Set<string>();
    for (const row of ledger.memberships) {
      const unboundNulls =
        row.agentId === null &&
        row.workspaceId === null &&
        row.hostConfirmedAt === null &&
        row.registeredAt === null &&
        row.revokedAt === null;
      if (row.state === "unbound-open" && !unboundNulls) return corrupt();
      if (
        row.state === "host-confirmed" &&
        !(row.agentId !== null && row.hostConfirmedAt !== null && row.revokedAt === null)
      ) {
        return corrupt();
      }
      if (row.state === "revoked" && !(row.revokedAt !== null && row.revokeReason !== null)) return corrupt();
      if (row.registeredAt !== null && row.hostConfirmedAt === null) return corrupt();
      if (handles.has(row.bindingHandleSha256)) return corrupt();
      handles.add(row.bindingHandleSha256);
      if (row.agentId !== null && row.state !== "revoked") {
        if (liveAgents.has(row.agentId)) return corrupt();
        liveAgents.add(row.agentId);
      }
    }
    return null;
  }

  /** Recompute the event hash chain from segments covering seq
   *  1..lastEventSeq. Segments entirely above lastEventSeq are orphans —
   *  renamed but uncommitted — and carry no authority (A3); a segment whose
   *  range straddles lastEventSeq is verified up to the tip and its tail is
   *  ignored. A missing events dir or any structural deviation breaks the
   *  chain. */
  function verifyChain(repoKey: string, ledger: LedgerValue): boolean {
    if (ledger.lastEventSeq === 0) return true;
    const dir = eventsDir(repoKey);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      // Absence is structural (a chain gap → corrupt); every other fs error
      // is an unexpected I/O fault → IO_FAILURE via read()'s outer catch.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
    const segments = names
      .map(name => SEGMENT_NAME.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => ({ name: match[0], first: Number(match[1]), last: Number(match[2]) }))
      .filter(segment => segment.first >= 1 && segment.first <= segment.last)
      .sort((a, b) => a.first - b.first);
    let expected = 1;
    let prevSha256: string | null = null;
    for (const segment of segments) {
      if (segment.first > ledger.lastEventSeq) continue; // orphan segment
      if (segment.first !== expected) return false; // gap or overlap
      let bytes: string;
      try {
        bytes = readFileSync(join(dir, segment.name), "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return false;
        throw error;
      }
      const lines = bytes.split("\n").filter(line => line.length > 0);
      if (lines.length !== segment.last - segment.first + 1) return false;
      for (const [index, line] of lines.entries()) {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          return false;
        }
        const parsed = EventSchema.safeParse(json);
        if (!parsed.success) return false;
        const event = parsed.data;
        if (event.seq !== segment.first + index) return false;
        const { sha256, ...rest } = event;
        if (sha256 !== canonicalSha256(rest)) return false;
        if (event.seq > ledger.lastEventSeq) break; // orphan tail
        if (event.prevSha256 !== prevSha256) return false;
        prevSha256 = sha256;
        expected += 1;
      }
    }
    return expected - 1 === ledger.lastEventSeq && prevSha256 === ledger.lastEventSha256;
  }

  function read(repoKey: string): DeskStoreRead {
    try {
      if (!REPO_KEY_PATTERN.test(repoKey)) {
        return { state: "unsafe", diagnostics: { code: "repo-key-invalid", schemaVersion: null } };
      }
      if (unsafeAncestors(repoKey)) {
        return { state: "unsafe", diagnostics: { code: "unsafe-path", schemaVersion: null } };
      }
      const path = ledgerPath(repoKey);
      const stat = lstatOrNull(path);
      if (stat === null) return { state: "absent" };
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { state: "unsafe", diagnostics: { code: "not-regular-file", schemaVersion: null } };
      }
      if (stat.size > LEDGER_LIMITS.ledgerBytes) {
        return { state: "corrupt", diagnostics: { code: "oversized", schemaVersion: null } };
      }
      let bytes: string;
      try {
        bytes = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
        throw error;
      }
      let json: unknown;
      try {
        json = JSON.parse(bytes);
      } catch {
        return { state: "corrupt", diagnostics: { code: "invalid-json", schemaVersion: null } };
      }
      if (!isRecord(json)) {
        return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion: null } };
      }
      // Header-first: format and schemaVersion are read before the body so a
      // future version can never be mistaken for corruption or for empty.
      const { format, schemaVersion } = json as { format?: unknown; schemaVersion?: unknown };
      if (format !== LEDGER_FORMAT || typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
        return { state: "corrupt", diagnostics: { code: "header-invalid", schemaVersion: null } };
      }
      if (schemaVersion > LEDGER_SCHEMA_VERSION) {
        return { state: "future", diagnostics: { code: "future-version", schemaVersion } };
      }
      // v1 ledgers migrate in-memory (MIGRATIONS[1]) and read as ok with
      // persistedSchemaVersion 1; the on-disk bytes are never touched by
      // read — the bump happens in the next transact's commit.
      let ledger: LedgerValue;
      let persistedSchemaVersion: 1 | 2;
      if (schemaVersion === 1) {
        const v1 = LedgerSchemaV1.safeParse(json);
        if (!v1.success) {
          return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion } };
        }
        ledger = MIGRATIONS[1](v1.data);
        persistedSchemaVersion = 1;
      } else {
        const parsed = LedgerSchema.safeParse(json);
        if (!parsed.success) {
          return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion } };
        }
        ledger = parsed.data;
        persistedSchemaVersion = 2;
      }
      const refinement = checkRefinements(ledger, repoKey);
      if (refinement !== null) return refinement;
      if (!verifyChain(repoKey, ledger)) {
        return { state: "corrupt", diagnostics: { code: "hash-chain-broken", schemaVersion } };
      }
      return { state: "ok", ledger, persistedSchemaVersion };
    } catch (error) {
      if (error instanceof OperationConflict) throw error;
      throw new OperationConflict("IO_FAILURE", `ledger read failed: ${summarize(error)}`);
    }
  }

  function ensureRepoDir(repoKey: string): void {
    ensurePrivateDirectory(join(deps.stableRoot, "state"), platform);
    ensurePrivateDirectory(join(deps.stableRoot, "state", "enforcement"), platform);
    ensurePrivateDirectory(baseDir, platform);
    ensurePrivateDirectory(repoDir(repoKey), platform);
  }

  /** wx-create the lockfile and retry until lockWaitMs expires; on expiry,
   *  classify the holder — a live pid answers desk-busy, anything else is
   *  RECOVERY_REQUIRED. The file is never deleted or overwritten. */
  async function acquireLock(repoKey: string): Promise<{ held: true } | { rejection: DeskRejectionValue }> {
    const path = lockPath(repoKey);
    const content = JSON.stringify({
      pid: process.pid,
      instanceNonce,
      startedAt: now().toISOString(),
    });
    const deadline = Date.now() + LEDGER_LIMITS.lockWaitMs;
    for (;;) {
      try {
        const fd = openSync(path, "wx", PRIVATE_FILE_MODE);
        try {
          writeSync(fd, content);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return { held: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new OperationConflict("IO_FAILURE", `cannot create desk lock: ${summarize(error)}`);
        }
        if (Date.now() < deadline) {
          await faults.lockWait?.();
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        // Expired: classify the holder. kill(pid, 0) success or EPERM means
        // the process is alive; ESRCH means dead; an unreadable lock means
        // unknown — the lock is never removed either way.
        let holder: { pid?: unknown; instanceNonce?: unknown } | null = null;
        try {
          const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
          if (isRecord(parsed)) holder = parsed;
        } catch {
          holder = null;
        }
        const pid = typeof holder?.pid === "number" ? holder.pid : null;
        if (pid !== null) {
          try {
            process.kill(pid, 0);
            return {
              rejection: rejection(
                "CAPABILITY_GAP",
                `desk lock held by live pid ${pid} (instance ${String(holder!.instanceNonce)})`,
                "desk-busy: another instance holds the repo lock",
              ),
            };
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === "EPERM") {
              return {
                rejection: rejection(
                  "CAPABILITY_GAP",
                  `desk lock held by live pid ${pid} (instance ${String(holder!.instanceNonce)})`,
                  "desk-busy: another instance holds the repo lock",
                ),
              };
            }
            // ESRCH or an undetermined kill → recovery-required.
            return {
              rejection: rejection(
                "RECOVERY_REQUIRED",
                `desk lock holder pid ${pid} is dead or undetermined (instance ${String(holder!.instanceNonce)}) — stale lock, recovery is P2-e`,
                "manual desk-lock recovery under maintenance authority",
              ),
            };
          }
        }
        return {
          rejection: rejection(
            "RECOVERY_REQUIRED",
            `desk lock is unreadable or unparseable (pid ${String(holder?.pid)}, instance ${String(holder?.instanceNonce)}) — stale lock, recovery is P2-e`,
            "manual desk-lock recovery under maintenance authority",
          ),
        };
      }
    }
  }

  /** Release only deletes a lock still owned by this instance — identical
   *  pid AND nonce. Anything else is IO_FAILURE; a foreign lock is never
   *  removed. */
  function releaseLock(repoKey: string): void {
    const path = lockPath(repoKey);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      throw new OperationConflict("IO_FAILURE", `cannot read desk lock for release: ${summarize(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
    const holder = isRecord(parsed) ? parsed : {};
    if (holder.pid !== process.pid || holder.instanceNonce !== instanceNonce) {
      throw new OperationConflict("IO_FAILURE", `desk lock at ${path} is not owned by this instance — left in place`);
    }
    try {
      unlinkSync(path);
      fsyncDirectory(repoDir(repoKey), platform);
    } catch (error) {
      throw new OperationConflict("IO_FAILURE", `cannot release desk lock: ${summarize(error)}`);
    }
  }

  /** Temp-sibling + fsync + rename + directory fsync — the same durable
   *  write idiom the journal uses. renameSync replaces an orphan segment of
   *  the same name; the temp is cleaned on any failure. */
  function atomicWrite(path: string, bytes: string, dir: string): void {
    const temp = `${path}.${uuid()}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(temp, "wx", PRIVATE_FILE_MODE);
      writeSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, path);
      fsyncDirectory(dir, platform);
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closing on the failure path
        }
      }
      rmSync(temp, { force: true });
      if (error instanceof OperationConflict) throw error;
      throw new OperationConflict("IO_FAILURE", `desk write failed for ${path}: ${summarize(error)}`);
    }
  }

  function freshLedger(repo: DeskStoreEnvelope["repo"], repoKey: string): LedgerValue {
    const stamp = now().toISOString();
    return {
      format: LEDGER_FORMAT,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      repo: { ...repo, repoKey, repoKeyAlgorithm: REPO_KEY_ALGORITHM },
      revision: 0,
      createdAt: stamp,
      updatedAt: stamp,
      lastEventSeq: 0,
      lastEventSha256: null,
      requests: [],
      memberships: [],
    };
  }

  /** Validate a committed decide result's event list against the caps —
   *  every violation is a caller error: INVALID_RECORD, nothing recorded. */
  function checkDecideEvents(events: unknown[]): { ok: true } | { rejection: DeskRejectionValue } {
    if (events.length > LEDGER_LIMITS.eventsPerCommit) {
      return { rejection: invalidRecord(`decide returned ${events.length} events — over the ${LEDGER_LIMITS.eventsPerCommit}-event bound`) };
    }
    for (const [index, event] of events.entries()) {
      const parsed = DecideEventSchema.safeParse(event);
      if (!parsed.success) {
        return { rejection: invalidRecord(`decide event ${index} is malformed: ${firstIssue(parsed.error)}`) };
      }
      try {
        const bytes = Buffer.byteLength(canonicalJson(parsed.data.payload), "utf8");
        if (bytes > LEDGER_LIMITS.eventPayloadBytes) {
          return { rejection: invalidRecord(`decide event ${index} payload exceeds ${LEDGER_LIMITS.eventPayloadBytes} canonical bytes`) };
        }
      } catch (error) {
        return { rejection: invalidRecord(`decide event ${index} payload is not canonicalizable JSON: ${summarize(error)}`) };
      }
    }
    return { ok: true };
  }

  async function commit(
    repoKey: string,
    envelope: DeskStoreEnvelope,
    decide: DecideFunction,
    bodySha256: string,
  ): Promise<TransactResult> {
    // c1 — before the lock attempt; a crash here leaves no lock, no dirs.
    await faults.beforeLock?.();
    ensureRepoDir(repoKey);
    const lock = await acquireLock(repoKey);
    if ("rejection" in lock) return lock.rejection;
    try {
      // The deterministic-concurrency barrier (C1–C3): the holder pauses
      // while owning the lockfile; other processes' acquire retries observe
      // it exactly like a slow writer.
      await faults.lockHeld?.();
      const state = read(repoKey);
      if (state.state !== "ok" && state.state !== "absent") {
        return rejection(
          "STATE_UNREADABLE",
          `desk ledger is ${state.state} (${state.diagnostics.code}${state.diagnostics.schemaVersion !== null ? `, schemaVersion ${state.diagnostics.schemaVersion}` : ""})`,
          "inspect the ledger under maintenance authority and restore or re-initialize it",
        );
      }
      const ledger = state.state === "absent" ? freshLedger(envelope.repo, repoKey) : state.ledger;
      // A v1 ledger read under this lock migrates in-memory; this commit is
      // the first write after the bump, so it records schemaVersion 2 plus
      // the schema-migrated event (contract §2).
      const migratedFrom = state.state === "ok" && state.persistedSchemaVersion === 1 ? 1 : null;
      if (state.state === "ok") {
        if (ledger.repo.hostId !== envelope.repo.hostId || ledger.repo.gitCommonDir !== envelope.repo.gitCommonDir) {
          return invalidRecord("envelope repo does not match the ledger's repo binding", "transact against the repo the ledger is bound to");
        }
      }
      // Idempotency precedes every other guard: the recorded outcome replays
      // verbatim — a committed receipt returns its record's fields, a
      // rejected request returns the rejection it committed.
      const prior = ledger.requests.find(
        record =>
          record.actorKey === envelope.actorKey &&
          record.assignmentId === envelope.assignmentId &&
          record.requestId === envelope.requestId,
      );
      if (prior !== undefined) {
        if (prior.bodySha256 !== bodySha256) {
          return rejection(
            "IDEMPOTENCY_CONFLICT",
            `requestId ${envelope.requestId} was recorded with a different body`,
            "resubmit under a new requestId or resend the identical body",
          );
        }
        if (prior.outcome === "rejected") return prior.rejection!;
        return {
          ok: true,
          receipt: {
            receiptId: prior.receiptId,
            revision: prior.revision,
            replayed: true,
            eventSeqs: prior.eventSeqs,
          },
        };
      }
      if (ledger.requests.length >= LEDGER_LIMITS.requests) {
        return invalidRecord(
          `requests table is full (${LEDGER_LIMITS.requests})`,
          "maintenance compaction required",
        );
      }
      // decide is synchronous and pure — a thenable or a throw is a caller
      // error, recorded nowhere.
      let outcome: unknown;
      try {
        outcome = decide(deepFreeze(structuredClone(ledger)), envelope.command);
      } catch (error) {
        return invalidRecord(`decide threw: ${summarize(error)}`, "fix the decide function and resubmit");
      }
      if (isThenable(outcome)) {
        return invalidRecord("decide must be synchronous — it returned a promise", "return the decision synchronously");
      }
      if (!isRecord(outcome) || (outcome.ok !== true && outcome.ok !== false)) {
        return invalidRecord("decide must return {ok:true, events} or a DeskRejection", "return a valid decision shape");
      }
      if (outcome.ok === false) {
        const parsed = DeskRejection.safeParse(outcome);
        if (!parsed.success) {
          return invalidRecord(`decide returned a malformed rejection: ${firstIssue(parsed.error)}`, "return a schema-valid DeskRejection");
        }
      }
      const decided = outcome as DecideOutcome;
      const decidedEvents = decided.ok === true ? decided.events : [];
      if (!Array.isArray(decidedEvents)) {
        return invalidRecord("decide must return an events array", "return {ok:true, events:[...]}");
      }
      // E-P2C-2 — the migration event rides the first SUCCESSFUL commit
      // after an in-memory bump. A rejection on a v1 ledger commits into
      // the v1 shape (no memberships, no event); the next successful
      // commit migrates.
      const events =
        migratedFrom === 1 && decided.ok === true
          ? [{ kind: "schema-migrated", payload: { from: 1, to: LEDGER_SCHEMA_VERSION } }, ...decidedEvents]
          : decidedEvents;
      const eventsCheck = checkDecideEvents(events);
      if ("rejection" in eventsCheck) return eventsCheck.rejection;

      // §2.2 — the decide → state channel, checked after decide and before
      // the segment write, schema-level only: the replacement table must
      // parse strict and the candidate ledger must pass the same
      // refinements read() applies. A violation is a consumer error —
      // INVALID_RECORD, nothing recorded (the decide-threw branch of P2-a
      // step 5).
      let nextMemberships = ledger.memberships;
      if (decided.ok === true && decided.memberships !== undefined) {
        const parsedMemberships = z.array(MembershipSchema).max(LEDGER_LIMITS.memberships).safeParse(decided.memberships);
        if (!parsedMemberships.success) {
          return invalidRecord(
            `decide returned invalid memberships: ${firstIssue(parsedMemberships.error)}`,
            "fix the decide function to return a schema-valid memberships table",
          );
        }
        const candidateInvalid = checkRefinements({ ...ledger, memberships: parsedMemberships.data }, repoKey);
        if (candidateInvalid !== null) {
          return invalidRecord(
            "decide returned invalid memberships (refinement failed)",
            "fix the decide function to return a table that satisfies the ledger refinements",
          );
        }
        nextMemberships = parsedMemberships.data;
      }

      const receiptId = uuid();
      const revision = ledger.revision + 1;
      const rejectionForRecord = decided.ok === false ? (decided as DeskRejectionValue) : null;
      const stamp = now().toISOString();
      let eventSeqs: [number, number] | null = null;
      let lastEventSeq = ledger.lastEventSeq;
      let lastEventSha256 = ledger.lastEventSha256;

      if (decided.ok === true && events.length > 0) {
        // Build the chain: seqs continue lastEventSeq, prevSha256 links to
        // the prior event's digest (or the recorded tip).
        const built: EventValue[] = [];
        let prev = ledger.lastEventSha256;
        for (const event of events) {
          const seq = lastEventSeq + 1;
          const withoutDigest = {
            seq,
            prevSha256: prev,
            at: stamp,
            requestId: envelope.requestId,
            actorKey: envelope.actorKey,
            assignmentId: envelope.assignmentId,
            kind: event.kind,
            payload: event.payload,
          };
          const sha256 = canonicalSha256(withoutDigest);
          built.push({ ...withoutDigest, sha256 });
          prev = sha256;
          lastEventSeq = seq;
        }
        lastEventSha256 = prev;
        eventSeqs = [built[0]!.seq, built[built.length - 1]!.seq];
        ensurePrivateDirectory(eventsDir(repoKey), platform);
        const segmentPath = join(eventsDir(repoKey), `${eventSeqs[0]}-${eventSeqs[1]}.jsonl`);
        const temp = `${segmentPath}.${uuid()}.tmp`;
        let fd: number | null = null;
        try {
          fd = openSync(temp, "wx", PRIVATE_FILE_MODE);
          writeSync(fd, built.map(event => JSON.stringify(event)).join("\n") + "\n");
          fsyncSync(fd);
          closeSync(fd);
          fd = null;
          // c2 — temp segment durable, not yet renamed.
          await faults.segmentTempWritten?.();
          renameSync(temp, segmentPath);
          fsyncDirectory(eventsDir(repoKey), platform);
          // c3 — segment renamed (durable), ledger not yet committed.
          await faults.segmentRenamed?.();
        } catch (error) {
          if (fd !== null) {
            try {
              closeSync(fd);
            } catch {
              // already closing on the failure path
            }
          }
          rmSync(temp, { force: true });
          if (error instanceof OperationConflict) throw error;
          throw new OperationConflict("IO_FAILURE", `event segment write failed: ${summarize(error)}`);
        }
      }

      const record: RequestRecordValue = {
        actorKey: envelope.actorKey,
        assignmentId: envelope.assignmentId,
        requestId: envelope.requestId,
        bodySha256,
        canonicalization: CANONICALIZATION,
        receiptId,
        revision,
        outcome: decided.ok === true ? "committed" : "rejected",
        eventSeqs,
        rejection: rejectionForRecord,
      };
      const candidate: LedgerValue = {
        ...ledger,
        revision,
        updatedAt: stamp,
        lastEventSeq,
        lastEventSha256,
        requests: [...ledger.requests, record],
        memberships: nextMemberships,
      };
      // The pre-commit refinement pass is the same one read() applies — a
      // ledger that would read as unsafe/corrupt is never written.
      const invalid = checkRefinements(candidate, repoKey);
      if (invalid !== null) {
        throw new OperationConflict("IO_FAILURE", "refusing to commit a ledger that would not read back cleanly");
      }
      // E-P2C-2 — a rejection on a v1 ledger keeps the on-disk v1 shape:
      // the empty migrated memberships table is dropped and the version
      // literal stays 1, so the bump (with its schema-migrated event)
      // happens on the first successful commit instead.
      let nextBytes: string;
      if (migratedFrom === 1 && decided.ok === false) {
        const { memberships: _dropped, ...v1Body } = candidate;
        const v1Next = { ...v1Body, schemaVersion: 1 };
        if (!LedgerSchemaV1.safeParse(v1Next).success) {
          throw new OperationConflict("IO_FAILURE", "refusing to commit a ledger that would not read back cleanly");
        }
        nextBytes = JSON.stringify(v1Next, null, 2) + "\n";
      } else {
        if (!LedgerSchema.safeParse(candidate).success) {
          throw new OperationConflict("IO_FAILURE", "refusing to commit a ledger that would not read back cleanly");
        }
        nextBytes = JSON.stringify(candidate, null, 2) + "\n";
      }
      atomicWrite(ledgerPath(repoKey), nextBytes, repoDir(repoKey));
      // c4 — the commit point passed; only release and the reply remain.
      await faults.ledgerCommitted?.();

      if (decided.ok === false) return decided;
      return {
        ok: true,
        receipt: { receiptId, revision, replayed: false, eventSeqs },
      };
    } finally {
      releaseLock(repoKey);
    }
  }

  async function transact(repoKey: string, envelope: unknown, decide: DecideFunction): Promise<TransactResult> {
    try {
      // Caller-error validation precedes the mutex and the lock: a
      // malformed envelope never touches the store.
      if (typeof repoKey !== "string" || !REPO_KEY_PATTERN.test(repoKey)) {
        return invalidRecord(`repoKey must match ${REPO_KEY_PATTERN.source}`);
      }
      const parsed = EnvelopeSchema.safeParse(envelope);
      if (!parsed.success) {
        return invalidRecord(`invalid envelope: ${firstIssue(parsed.error)}`);
      }
      const env = parsed.data;
      if (repoKeyFor(env.repo) !== repoKey) {
        return invalidRecord("repoKey does not equal repoKeyFor(envelope.repo)");
      }
      let bodySha256: string;
      try {
        bodySha256 = canonicalSha256({ repo: env.repo, command: env.command });
      } catch (error) {
        return invalidRecord(`envelope repo/command is not canonicalizable JSON: ${summarize(error)}`);
      }
      if (unsafeAncestors(repoKey)) {
        return rejection(
          "STATE_UNREADABLE",
          "desk ledger path is not safe (symlinked or non-directory ancestor)",
          "restore a real directory path under maintenance authority",
        );
      }

      // §4 step 1 — the in-process mutex serializes commits per repoKey.
      const prior = mutex.get(repoKey) ?? Promise.resolve();
      const run = prior.then(async () => {
        const result = await commit(repoKey, env, decide, bodySha256);
        // c5 — after the lock release that closed commit(); a crash here is
        // indistinguishable from one at c4: the commit is durable either way.
        await faults.afterComplete?.();
        return result;
      });
      const tracked = run.then(
        () => undefined,
        () => undefined,
      );
      mutex.set(repoKey, tracked);
      void tracked.finally(() => {
        if (mutex.get(repoKey) === tracked) mutex.delete(repoKey);
      });
      return await run;
    } catch (error) {
      if (error instanceof OperationConflict) throw error;
      throw new OperationConflict("IO_FAILURE", `desk transact failed: ${summarize(error)}`);
    }
  }

  return { read, transact };
}
