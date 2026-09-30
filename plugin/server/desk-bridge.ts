// plugin/server/desk-bridge.ts — P2-d desk MCP bridge adapter.
//
// The plugin-side half of the seat↔desk transport: one Unix-domain socket
// under the verified stable root, one lifecycle lock in the reserved repo
// namespace, and the agent.create graft that hands managed seats their
// stdio MCP server (bin/slp-desk-mcp.mjs). UDS only — no TCP path exists;
// Windows is a typed CAPABILITY_GAP, not a fake adapter.
//
// Trust model (contract §4): the ONLY caller-supplied identity is the
// minted desk handle in the connection hello. The adapter resolves the
// membership row server-side (handle sha → ledger row → agentId); role and
// cwd claims from the bridge are never trusted. Every dispatch re-validates
// the full guard chain — envelope, catalog, fresh membership row, epoch,
// live SDK identity, capability row, strict input, desk state — and fails
// closed with the typed DeskErrorCode vocabulary.
//
// Lifecycle: contribute() calls start(); cleanup calls stop(). The lock is
// O_EXCL under repos/<reserved>/lock carrying {pid, instanceNonce,
// startedAt}; a live foreign holder is never stolen from — bounded wait,
// then a typed desk-busy gap. A dead/undetermined holder is
// RECOVERY_REQUIRED (operator recovery via the same seam as repo locks),
// never auto-unlinked. stop() closes connections, closes the server,
// unlinks the socket and releases the lock — in that order.

import { z } from "zod";
import { createServer, type Server, type Socket } from "node:net";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import {
  LEDGER_LIMITS,
  REPO_KEY_PATTERN,
  createDeskStore,
  deskBridgePaths,
  deskRepoPaths,
  deskReposDir,
  type DeskStore,
  type DeskStoreRead,
  type MembershipValue,
} from "./desk-store.ts";
import { assertRealComponents, ensurePrivateDirectory } from "./kept-files.ts";
import { detectDaemonHome } from "./daemon-home.ts";
import { sha256Hex } from "./config-view.ts";
import type { Journal } from "./journal.ts";
import type { LauncherBuilder } from "../shared/contracts.ts";
import {
  DESK_BRIDGE_PROTOCOL,
  DeskAssignmentAttachInput,
  DeskAssignmentCloseInput,
  DeskAssignmentRegisterInput,
  DeskBridgeAck,
  DeskBridgeFrameError,
  DeskBridgeHello,
  DeskBridgeToolCall,
  DeskBridgeToolEntry,
  DeskErrorCode as DeskErrorCodeSchema,
  DeskHandbackSubmitInput,
  DeskSeatStatus,
  WIRE_LIMITS,
  type DeskRejectionValue,
  type DeskSeatStatusValue,
} from "../shared/enforcement.ts";
import { auditCapabilities, CAPABILITY_IDS } from "./capabilities.ts";
import {
  captureSeatSnapshot,
  runAssignmentAttach,
  runAssignmentClose,
  runAssignmentRegister,
  runHandbackSubmit,
  seatAssignmentsView,
  type DeskRunnerDeps,
  type ObservedCaptureValue,
} from "./desk-handback.ts";

type AgentCreateRequest = PluginBeforeRequests["agent.create"];
type SessionOpenRequest = PluginBeforeRequests["agent.session_open"];

const REQUEST_CAP = WIRE_LIMITS.deskBridgeRequestBytes;
const RESPONSE_CAP = WIRE_LIMITS.deskBridgeResponseBytes;
const MAX_CONNECTIONS = 64;
const HANDSHAKE_BUDGET_MS = 10000;
const IDENTITY_BUDGET_MS = 8000;
const REPO_SCAN_LIMIT = 64;
const LOCK_POLL_MS = 50;
const BRIDGE_FILE = join("bin", "slp-desk-mcp.mjs");
const HIDDEN_TOOL = "slp_desk_internal";
const STATUS_TOOL = "slp_status";
const HANDBACK_SUBMIT_TOOL = "slp_handback_submit";
const ASSIGNMENT_REGISTER_TOOL = "slp_assignment_register";
const ASSIGNMENT_ATTACH_TOOL = "slp_assignment_attach";
const ASSIGNMENT_CLOSE_TOOL = "slp_assignment_close";

/** The bridge's own limitation literals — the seat-facing read view's
 *  bounded flag strings (kept in one table, same discipline as
 *  limitations.ts; that table is owned by P2-e and not extended here). */
const BRIDGE_LIMITATIONS = {
  deskRecoveryRequired:
    "desk lock orphaned or unreadable — operator recovery required before desk mutations",
  deskDegraded: "desk ledger is not readable — seat view is best-effort",
  assignmentsWithheld: "assignments view withheld — the desk ledger cannot be read",
} as const;

/** The desk tool catalog's wire contract — metadata lives at module level so
 *  the whole catalog (visible and hidden rows) is enumerable for cap checks.
 *  createDeskBridge binds each row's input schema and run implementation; a
 *  row that fails DeskBridgeToolEntry is a producer bug, never an emitted
 *  tool. */
export const DESK_TOOL_CATALOG = [
  {
    name: STATUS_TOOL,
    visible: true,
    mutation: false,
    description: "Seat-facing desk status: this seat's own membership view plus desk availability.",
  },
  {
    name: HANDBACK_SUBMIT_TOOL,
    visible: true,
    mutation: true,
    description:
      "Submit a structured handback record (v1, kind handback) against an assignment this seat is bound to. " +
      "Input: {requestId, assignmentId, recordV1, candidateId|null}. " +
      "Response: {ok, revision, receiptId, gaps, handbackId, observedCandidateId}.",
  },
  {
    name: ASSIGNMENT_REGISTER_TOOL,
    visible: true,
    mutation: true,
    description:
      "Lead-only: register a durable assignment binding on this desk. " +
      "Input: {requestId, authorityRef, objective|null}. authorityRef is stored verbatim as a pointer to the grant — never dereferenced. " +
      "Response: {ok, receiptId, assignmentId, state}.",
  },
  {
    name: ASSIGNMENT_ATTACH_TOOL,
    visible: true,
    mutation: true,
    description:
      "Lead owner only: bind a live seat to an open assignment. " +
      "Input: {requestId, assignmentId, agentId}. Idempotent on an already-bound seat. " +
      "Response: {ok, receiptId, assignmentId, seat}.",
  },
  {
    name: ASSIGNMENT_CLOSE_TOOL,
    visible: true,
    mutation: true,
    description:
      "Lead owner only: close an assignment; submissions against a closed assignment reject. " +
      "Input: {requestId, assignmentId}. Response: {ok, receiptId, assignmentId, state}.",
  },
  {
    name: HIDDEN_TOOL,
    visible: false,
    mutation: false,
    description: "Internal mechanism entry — exists to prove hidden-catalog dispatch rejection.",
  },
] as const;

/** The SDK surface the dispatch guards need — a structural subset of
 *  PaseoApi (same narrowing convention as supervision/state.ts): tests
 *  double it without the daemon and the plugin bundle keeps no runtime
 *  @getpaseo/client dependency. */
type PaseoLike = {
  agents: {
    ref(id: string): {
      refresh(): Promise<{
        agent: {
          provider?: unknown;
          workspaceId?: unknown;
          archivedAt?: unknown;
        } | null;
      } | null>;
    };
  };
};

type DeskErrorCode = DeskRejectionValue["code"];

export interface DeskBridgeDeps {
  /** Durable receipt read — the binding/launch-set provenance chain. */
  journal: Pick<Journal, "read">;
  /** Launch-set verify — the launch-manifest → daemonHome provenance seam. */
  launchers: Pick<LauncherBuilder, "verify">;
  /** The embedded payload — its `bin/slp-desk-mcp.mjs` entry is the
   *  graft-time and handshake integrity oracle (same sha verifyPublished
   *  enforces). */
  payload: { files: { path: string; sha256: string }[] };
  /** Served-home detection — real env/default probe by default. */
  detectDaemonHome?: () => { daemonHome: string; source: "env" | "default" };
  realpath?: (path: string) => string;
  /** Store factory — tests substitute a store on a fixture root. */
  createStore?: (stableRoot: string) => DeskStore;
  audit?: typeof auditCapabilities;
  /** The connected-SDK slot — hook/RPC contexts fill it via notePaseo. */
  paseoRef: { current: PaseoLike | null };
  platform?: string;
  now?: () => Date;
  uuid?: () => string;
  kill?: (pid: number, signal?: number) => void;
  warn?: (line: string) => void;
  /** P3-a observed capture — tests substitute a deterministic double; the
   *  default spawns the bound runtime's snapshot under 60s/32MiB. */
  capture?: (deps: {
    nodePath: string;
    runtimePath: string;
    repository: string;
    now: () => Date;
  }) => Promise<ObservedCaptureValue>;
}

export type DeskBridgeState =
  | { kind: "starting" }
  | { kind: "listening"; socketPath: string }
  | { kind: "unavailable"; code: DeskErrorCode; reason: string };

type BoundSeat = {
  repoKey: string;
  handleSha256: string;
  membershipId: string;
  agentId: string;
  openGeneration: number;
  /** The handshake-resolved membership row — the only honest snapshot the
   *  status tool can still answer from when the ledger itself stops
   *  reading. Never written back; never a substitute for a live row on any
   *  other tool. */
  row: SeatRow;
};

type SeatRow = MembershipValue;

type Availability = "available" | "recovery-required" | "degraded";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The wire schema caps the limitations array itself — an aggregate that
 *  would exceed the cap sheds trailing entries into one counting marker so
 *  a saturated view stays schema-valid instead of failing the reply. */
const boundLimitations = (entries: string[], cap: number): string[] =>
  entries.length <= cap
    ? entries
    : [...entries.slice(0, cap - 1), `${entries.length - (cap - 1)} more limitation(s) elided`];

const rejection = (code: DeskErrorCode, message: string, recovery: string): DeskRejectionValue => ({
  ok: false,
  code,
  message,
  recovery,
});

/** MCP protocol version echoed when the caller declares none. */
const MCP_PROTOCOL_FALLBACK = "2024-11-05";

interface LockHolder {
  pid: number;
  instanceNonce: string;
  startedAt?: string;
}

export function createDeskBridge(deps: DeskBridgeDeps) {
  const platform = deps.platform ?? process.platform;
  const uuid = deps.uuid ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 0));
  const detectHome = deps.detectDaemonHome ?? detectDaemonHome;
  const realpath = deps.realpath ?? realpathSync;
  const createStore = deps.createStore ?? (stableRoot => createDeskStore({ stableRoot }));
  const audit = deps.audit ?? auditCapabilities;
  const capture = deps.capture ?? captureSeatSnapshot;
  const instanceNonce = uuid();
  /** The connected-SDK slot — every hook/handler context that reaches the
   *  plugin stashes it here so dispatch guards can verify live identity
   *  even on resumed sessions where no create ran this process lifetime.
   *  E-P2D-4: a stash is hook evidence only — it never proves an RPC
   *  dispatch reached this plugin. */
  const stashPaseo = (paseo: PaseoLike | null | undefined): void => {
    if (paseo !== null && paseo !== undefined) deps.paseoRef.current = paseo;
  };
  /** E-P2D-4 — plugin-RPC dispatch evidence: set ONLY by `noteDispatch`,
   *  which a real daemon→plugin RPC handler invokes. Hook contexts (stash
   *  above) never flip this — `plugin-rpc.dispatch` stays `unknown` until a
   *  genuine dispatch lands. */
  let rpcDispatched = false;
  const noteDispatch = (paseo: PaseoLike | null | undefined): void => {
    rpcDispatched = true;
    stashPaseo(paseo);
  };
  // One bounded warn per key — diagnostics never repeat.
  const warned = new Set<string>();
  const warn = (key: string, line: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    (deps.warn ?? console.warn)(line.slice(0, 400));
  };

  let state: DeskBridgeState = { kind: "starting" };
  let stableRoot: string | null = null;
  let paths: ReturnType<typeof deskBridgePaths> | null = null;
  let binding: {
    runtimePath: string;
    nodePath: string;
    candidateSha256: string;
    /** The launch-set manifest's bridge pin — the P2-b amend seam records
     *  it; undefined means the bound candidate predates the bridge and no
     *  graft/hello may proceed (fail closed). */
    bridgeSha256: string | undefined;
  } | null = null;
  let store: DeskStore | null = null;
  let server: Server | null = null;
  let lockHeld = false;
  let stopped = false;
  const connections = new Set<Socket>();

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  /** Strict UTF-8 frame decode: malformed byte sequences become null instead
   *  of silently decoding to U+FFFD — a substituted frame must never be
   *  parsed and relayed as if it were the sender's bytes (E-P2D-1). */
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const decodeFrame = (line: Buffer): string | null => {
    try {
      return utf8.decode(line);
    } catch {
      return null;
    }
  };

  const pidAlive = (pid: number): boolean => {
    try {
      kill(pid);
      return true;
    } catch {
      return false;
    }
  };

  function parseHolder(bytes: Buffer): LockHolder | null {
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isRecord(value)) return null;
      const { pid, instanceNonce, startedAt } = value;
      if (
        typeof pid === "number" && Number.isInteger(pid) && pid > 0 &&
        typeof instanceNonce === "string" &&
        instanceNonce.length > 0 && instanceNonce.length <= WIRE_LIMITS.recoverNonce
      ) {
        return {
          pid,
          instanceNonce,
          ...(typeof startedAt === "string" ? { startedAt } : {}),
        };
      }
    } catch { /* unparseable */ }
    return null;
  }

  // ---------------------------------------------------------------------
  // stable-root provenance (D7) — receipt → verified launch set → the
  // manifest's own ancestry. Never a blind default: an unreadable or
  // binding-less receipt leaves the bridge inert.
  // ---------------------------------------------------------------------

  async function resolveStableRoot(): Promise<{
    stableRoot: string;
    binding: NonNullable<typeof binding>;
  }> {
    const home = realpath(detectHome().daemonHome);
    const provisional = join(home, "slp-runtime");
    const receipt = deps.journal.read(provisional);
    if (receipt === null || receipt.binding === null) {
      throw rejection(
        "CAPABILITY_GAP",
        "no active SLP binding under the detected daemon home — desk bridge stays inert",
        "activate the manager for this home; a binding-less home has no desk to serve",
      );
    }
    // The verified launch set proves <daemonHome>/slp-runtime/launchers/<sha>
    // ancestry — its manifest.daemonHome must equal the real directory
    // ancestry, so the stable root we serve is the one activation pinned
    // (contract §5: this proof path is independent of PASEO_HOME).
    const launchSet = await deps.launchers.verify(
      join(provisional, "launchers", receipt.binding.launchSetSha256),
    );
    const stableRoot = dirname(dirname(launchSet.directory));
    // Receipt vs verified manifest: the binding's recorded runtimePath must
    // be the candidate directory the launch set itself verified — a
    // divergence is integrity drift, never a path to follow.
    const bound = receipt.binding;
    if (bound.runtimePath !== join(stableRoot, bound.candidateSha256)) {
      throw rejection(
        "CANDIDATE_DRIFT",
        "the binding's runtimePath diverges from the verified launch set's candidate root",
        "inspect the install receipt and launch set; the bridge never follows an unverified path",
      );
    }
    return {
      stableRoot,
      binding: {
        runtimePath: bound.runtimePath,
        nodePath: bound.node.path,
        candidateSha256: bound.candidateSha256,
        bridgeSha256: launchSet.bridgeSha256,
      },
    };
  }

  // ---------------------------------------------------------------------
  // lifecycle lock — O_EXCL under the reserved repo namespace
  // ---------------------------------------------------------------------

  async function acquireLock(lockPath: string): Promise<
    | { ok: true }
    | { ok: false; code: DeskErrorCode; reason: string }
  > {
    const deadline = Date.now() + LEDGER_LIMITS.lockWaitMs;
    for (;;) {
      let fd: number | null = null;
      try {
        fd = openSync(lockPath, "wx", 0o600);
        writeSync(
          fd,
          JSON.stringify({ pid: process.pid, instanceNonce, startedAt: now().toISOString() }) + "\n",
        );
        fsyncSync(fd);
        lockHeld = true;
        return { ok: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return {
            ok: false,
            code: "CAPABILITY_GAP",
            reason: `bridge lock cannot be created: ${(error as Error).message}`,
          };
        }
      } finally {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* already closed */ }
        }
      }
      let holder: LockHolder | null = null;
      try {
        holder = parseHolder(readFileSync(lockPath));
      } catch {
        return { ok: false, code: "RECOVERY_REQUIRED", reason: "bridge lock is unreadable" };
      }
      if (holder !== null && holder.pid === process.pid && holder.instanceNonce === instanceNonce) {
        // Re-entry by THIS instance — adopt rather than steal. A live pid
        // with a different nonce is a stacked holder: bounded wait below.
        lockHeld = true;
        return { ok: true };
      }
      if (holder === null) {
        return {
          ok: false,
          code: "RECOVERY_REQUIRED",
          reason: "bridge lock holder record is malformed — operator recovery required",
        };
      }
      if (!pidAlive(holder.pid)) {
        return {
          ok: false,
          code: "RECOVERY_REQUIRED",
          reason:
            `bridge lock held by dead pid ${holder.pid} — operator recovery ` +
            "required via the desk recovery seam; the bridge never steals a lock",
        };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          code: "CAPABILITY_GAP",
          reason: `desk-busy: bridge lock held by live pid ${holder.pid} (nonce ${holder.instanceNonce})`,
        };
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  /** Release deletes a lock only while THIS instance still owns it —
   *  identical pid AND nonce, the same rule desk-store's releaseLock
   *  enforces. A missing, unreadable or foreign-held lock is left in place
   *  and logged; the file is never unlinked blind. */
  function releaseLock(): void {
    if (paths === null || !lockHeld) return;
    lockHeld = false;
    const path = paths.lockPath;
    let holder: LockHolder | null = null;
    try {
      holder = parseHolder(readFileSync(path));
    } catch {
      warn("release-unreadable", `slp: desk bridge lock at ${path} is unreadable — left in place`);
      return;
    }
    if (holder === null || holder.pid !== process.pid || holder.instanceNonce !== instanceNonce) {
      warn(
        "release-foreign",
        `slp: desk bridge lock at ${path} is not owned by this instance ` +
          `(pid ${String(holder?.pid)}, nonce ${String(holder?.instanceNonce)}) — left in place`,
      );
      return;
    }
    try { unlinkSync(path); } catch { /* already gone */ }
  }

  // ---------------------------------------------------------------------
  // seat resolution — handle sha → {repoKey, row}; server-side identity
  // ---------------------------------------------------------------------

  function resolveSeat(handleSha: string):
    | { row: SeatRow; repoKey: string }
    | { error: DeskRejectionValue } {
    if (store === null || stableRoot === null) {
      return {
        error: rejection(
          "CAPABILITY_GAP",
          "desk store is not open",
          "the bridge must be listening before seats resolve",
        ),
      };
    }
    let repos: string[];
    try {
      repos = readdirSync(deskReposDir(stableRoot)).filter(name => REPO_KEY_PATTERN.test(name));
    } catch {
      return {
        error: rejection(
          "STATE_UNREADABLE",
          "the repos directory cannot be read",
          "the desk has no seat state to resolve against",
        ),
      };
    }
    if (repos.length > REPO_SCAN_LIMIT) {
      return {
        error: rejection(
          "CAPABILITY_GAP",
          `repo scan over the ${REPO_SCAN_LIMIT} bound — resolution refused`,
          "the seat scan is bounded; prune stale repos before dispatch",
        ),
      };
    }
    for (const repoKey of repos) {
      let read: DeskStoreRead;
      try {
        read = store.read(repoKey);
      } catch {
        // A repo that throws cannot prove the handle absent — refuse the
        // handshake typed rather than skip it and fabricate ACTOR_MISMATCH.
        return {
          error: rejection(
            "STATE_UNREADABLE",
            "a desk ledger cannot be read while resolving the seat",
            "inspect the desk state on disk; the hello stays unbound",
          ),
        };
      }
      if (read.state !== "ok") continue;
      const row = read.ledger.memberships.find(m => m.bindingHandleSha256 === handleSha);
      if (row !== undefined) return { row, repoKey };
    }
    return {
      error: rejection(
        "ACTOR_MISMATCH",
        "no membership row matches the supplied handle",
        "the handle comes from the minted seat env — an unmatched handle is not a seat",
      ),
    };
  }

  // ---------------------------------------------------------------------
  // dispatch guards (D5) — every call, fail closed
  // ---------------------------------------------------------------------

  /** The fresh membership read behind every dispatch. The carried `read` is
   *  the single ledger observation the status tool also derives
   *  availability and its projection from — identity, availability and
   *  projection can never disagree inside one call. A THROWN read is still
   *  a bounded outcome: it maps to STATE_UNREADABLE like a non-ok state. */
  function freshRow(bound: BoundSeat):
    | { row: SeatRow; read: DeskStoreRead }
    | { error: DeskRejectionValue; read: DeskStoreRead | null } {
    if (store === null) {
      return { error: rejection("STATE_UNREADABLE", "desk store closed", "restart the plugin session"), read: null };
    }
    let read: DeskStoreRead;
    try {
      read = store.read(bound.repoKey);
    } catch (error) {
      return {
        error: rejection(
          "STATE_UNREADABLE",
          `the bound repo ledger read threw: ${(error as Error).message.slice(0, 120)}`,
          "inspect the ledger on disk; dispatch refuses a desk it cannot read",
        ),
        read: null,
      };
    }
    if (read.state === "absent") {
      return {
        error: rejection(
          "STALE_EPOCH",
          "the bound repo ledger is gone",
          "the desk state no longer records this seat — rebind the session",
        ),
        read,
      };
    }
    if (read.state !== "ok") {
      return {
        error: rejection(
          "STATE_UNREADABLE",
          `the bound repo ledger reads ${read.state}`,
          "inspect the ledger on disk; dispatch refuses a desk it cannot read",
        ),
        read,
      };
    }
    const row = read.ledger.memberships.find(m => m.membershipId === bound.membershipId);
    if (
      row === undefined ||
      row.bindingHandleSha256 !== bound.handleSha256 ||
      row.openGeneration !== bound.openGeneration ||
      row.state === "revoked"
    ) {
      return {
        error: rejection(
          "STALE_EPOCH",
          "the membership row vanished, re-bound or ended its epoch",
          "the seat epoch ended — reconnect with a fresh handle",
        ),
        read,
      };
    }
    if (row.agentId === null) {
      return {
        error: rejection(
          "ACTOR_MISMATCH",
          "the membership is not host-bound to an agent",
          "the seat handshake completes at session_open — a bridge cannot bind a seat",
        ),
        read,
      };
    }
    if (row.registeredAt === null) {
      return {
        error: rejection(
          "STALE_EPOCH",
          "the seat registration is not host-confirmed yet",
          "registration confirms on agent.created — retry once the seat is live",
        ),
        read,
      };
    }
    return { row, read };
  }

  /** Guard item — live SDK identity (contract §4 guard). `agents.ref`
   *  refresh is the "current identity" oracle only; contract §2 forbids it
   *  for REBIND, which this path never performs — a mismatch here rejects
   *  the call, it does not rebind anything. */
  async function sdkIdentity(row: SeatRow): Promise<DeskRejectionValue | null> {
    const paseo = deps.paseoRef.current;
    if (paseo === null) {
      return rejection(
        "CAPABILITY_GAP",
        "no host SDK context has reached the plugin this run",
        "identity cannot be verified without a connected paseo context — dispatch stays closed",
      );
    }
    let result: { agent: { provider?: unknown; workspaceId?: unknown; archivedAt?: unknown } | null } | null;
    try {
      result = await Promise.race([
        paseo.agents.ref(row.agentId as string).refresh(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("identity refresh budget exceeded")), IDENTITY_BUDGET_MS),
        ),
      ]);
    } catch (error) {
      return rejection(
        "CAPABILITY_GAP",
        `SDK identity refresh failed: ${(error as Error).message.slice(0, 200)}`,
        "the seat identity cannot be verified — dispatch stays closed",
      );
    }
    const agent = result?.agent ?? null;
    if (agent === null) {
      return rejection(
        "ACTOR_MISMATCH",
        "the bound agent is gone from the host",
        "the seat epoch ended when its agent disappeared",
      );
    }
    if (agent.archivedAt !== null && agent.archivedAt !== undefined) {
      return rejection(
        "ACTOR_MISMATCH",
        "the bound agent is archived",
        "an archived seat cannot dispatch — rebind a live session",
      );
    }
    // workspaceId is optional on the live snapshot and nullable on the row —
    // compare on the same null normalization or undefined !== null rejects
    // a healthy seat.
    const liveWorkspace = typeof agent.workspaceId === "string" ? agent.workspaceId : null;
    if (agent.provider !== row.provider || liveWorkspace !== row.workspaceId) {
      return rejection(
        "ACTOR_MISMATCH",
        "the bound agent's provider/workspace diverged from the membership record",
        "the recorded binding no longer describes a live seat — rebind the session",
      );
    }
    return null;
  }

  function capabilityGate(): DeskRejectionValue | null {
    // E-P2D-4: `rpcDispatched` is set only when a real daemon→plugin RPC
    // handler invoked `noteDispatch` — hook-context stashes never count, so
    // the capability row stays `unknown` until a genuine dispatch lands.
    const { records } = audit({
      now: now().toISOString(),
      observed: {
        rpcDispatched,
        providersSnapshot: null,
        agentsList: null,
      },
    });
    const row = records.find(r => r.capabilityId === CAPABILITY_IDS.pluginRpcDispatch);
    if (row?.status !== "supported") {
      return rejection(
        "CAPABILITY_GAP",
        "the plugin-rpc.dispatch capability row is not supported in this audit",
        "dispatch stays closed until the capability audit reports the surface",
      );
    }
    return null;
  }

  /** The lock-holder probe — deliberately ledger-free so the status tool
   *  can combine it with the single freshRow observation instead of paying
   *  a second ledger read that could diverge mid-call. */
  function probeLock(repoKey: string): "clear" | "recovery-required" {
    if (stableRoot === null) return "recovery-required";
    const { lockPath } = deskRepoPaths(stableRoot, repoKey);
    if (existsSync(lockPath)) {
      let holder: LockHolder | null = null;
      try {
        holder = parseHolder(readFileSync(lockPath));
      } catch {
        return "recovery-required";
      }
      if (holder === null || !pidAlive(holder.pid)) return "recovery-required";
    }
    return "clear";
  }

  function probeAvailability(repoKey: string): Availability {
    if (stableRoot === null || store === null) return "degraded";
    if (probeLock(repoKey) === "recovery-required") return "recovery-required";
    let read: DeskStoreRead;
    try {
      read = store.read(repoKey);
    } catch {
      // A thrown read still answers: degraded — mutations reject via the
      // availability gate, status reports the desk it cannot read.
      return "degraded";
    }
    if (read.state !== "ok" && read.state !== "absent") return "degraded";
    return "available";
  }

  // ---------------------------------------------------------------------
  // tool catalog — server-side source of truth (D3)
  // ---------------------------------------------------------------------

  interface ToolDef {
    name: string;
    visible: boolean;
    mutation: boolean;
    description: string;
    input: z.ZodType;
    run(ctx: {
      row: SeatRow;
      bound: BoundSeat;
      availability: Availability;
      /** The one ledger observation behind this dispatch — the status
       *  runner projects it directly; mutations re-read under the lock. */
      seatRead: DeskStoreRead | null;
      input: unknown;
    }): Promise<unknown>;
  }

  /** Runner deps shared by the mutation tools — the store and bound-runtime
   *  capture wiring live in the bridge scope. */
  const runnerDeps = (): DeskRunnerDeps => ({
    store: store as DeskRunnerDeps["store"],
    capture,
    uuid,
    now,
    binding: binding === null ? null : { runtimePath: binding.runtimePath, nodePath: binding.nodePath },
  });

  const TOOL_IMPLS: Record<string, { input: z.ZodType; run: ToolDef["run"] }> = {
    [STATUS_TOOL]: {
      input: z.object({}).strict(),
      async run({ row, bound, availability, seatRead }) {
        const limitations: string[] = [];
        if (availability === "recovery-required") {
          limitations.push(BRIDGE_LIMITATIONS.deskRecoveryRequired);
        } else if (availability === "degraded") {
          limitations.push(BRIDGE_LIMITATIONS.deskDegraded);
        }
        let assignments: DeskSeatStatusValue["assignments"] = [];
        if (availability === "available" && seatRead !== null && seatRead.state === "ok") {
          // The projection reads the SAME ledger observation that resolved
          // this seat's identity — availability and assignments can never
          // come from different ledger versions inside one status call.
          const projection = seatAssignmentsView(seatRead.ledger, row, {
            assignments: WIRE_LIMITS.deskStatusAssignments,
            seats: WIRE_LIMITS.deskStatusSeats,
            handbacks: WIRE_LIMITS.deskStatusHandbacks,
          });
          assignments = projection.assignments;
          limitations.push(...projection.limitations);
        } else if (availability !== "available") {
          // The projection is withheld, not faked — a desk that cannot be
          // read cannot serve a trustworthy seat view; the limitation
          // records the elision instead of silently returning [].
          limitations.push(BRIDGE_LIMITATIONS.assignmentsWithheld);
        } else {
          limitations.push("assignments view unavailable — ledger did not read cleanly");
        }
        const view: DeskSeatStatusValue = {
          schemaVersion: 1,
          generatedAt: now().toISOString(),
          seat: {
            membershipId: row.membershipId,
            agentId: row.agentId as string,
            state: row.state,
            family: row.family,
            role: row.role,
            provider: row.provider,
            workspaceId: row.workspaceId,
            createCwd: row.createCwd,
            openGeneration: row.openGeneration,
            createdAt: row.createdAt,
            hostConfirmedAt: row.hostConfirmedAt,
            registeredAt: row.registeredAt,
          },
          desk: { repoKey: bound.repoKey, state: availability, protocol: DESK_BRIDGE_PROTOCOL },
          assignments,
          limitations: boundLimitations(limitations, WIRE_LIMITS.deskBridgeLimitations),
          acceptance: "not-established-by-this-view",
        };
        return DeskSeatStatus.parse(view);
      },
    },
    [HANDBACK_SUBMIT_TOOL]: {
      input: DeskHandbackSubmitInput,
      async run({ row, bound, input }) {
        return runHandbackSubmit(
          { repoKey: bound.repoKey, row },
          input as {
            requestId: string;
            assignmentId: string;
            recordV1: Record<string, unknown>;
            candidateId: string | null;
          },
          runnerDeps(),
        );
      },
    },
    [ASSIGNMENT_REGISTER_TOOL]: {
      input: DeskAssignmentRegisterInput,
      async run({ row, bound, input }) {
        return runAssignmentRegister(
          { repoKey: bound.repoKey, row },
          input as { requestId: string; authorityRef: string; objective: string | null },
          runnerDeps(),
        );
      },
    },
    [ASSIGNMENT_ATTACH_TOOL]: {
      input: DeskAssignmentAttachInput,
      async run({ row, bound, input }) {
        return runAssignmentAttach(
          { repoKey: bound.repoKey, row },
          input as { requestId: string; assignmentId: string; agentId: string },
          runnerDeps(),
        );
      },
    },
    [ASSIGNMENT_CLOSE_TOOL]: {
      input: DeskAssignmentCloseInput,
      async run({ row, bound, input }) {
        return runAssignmentClose(
          { repoKey: bound.repoKey, row },
          input as { requestId: string; assignmentId: string },
          runnerDeps(),
        );
      },
    },
    [HIDDEN_TOOL]: {
      input: z.object({}).strict(),
      async run() {
        throw new Error("hidden tool must never run");
      },
    },
  };
  // Producer contract: every catalog row — visible or hidden — must satisfy
  // the centralized DeskBridgeToolEntry caps and bind an implementation
  // before one can be served.
  const TOOLS: ToolDef[] = DESK_TOOL_CATALOG.map(meta => {
    DeskBridgeToolEntry.parse(meta);
    const impl = TOOL_IMPLS[meta.name];
    if (impl === undefined) throw new Error(`desk tool ${meta.name} has no run implementation`);
    return { ...meta, ...impl };
  });

  function mcpToolsList() {
    return TOOLS.filter(t => t.visible).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input),
    }));
  }

  type McpToolResult = { content: { type: "text"; text: string }[]; isError?: true };

  async function callTool(params: unknown, bound: BoundSeat): Promise<McpToolResult> {
    const text = (value: unknown) => JSON.stringify(value);
    const fail = (value: DeskRejectionValue): McpToolResult => ({
      content: [{ type: "text", text: text(value) }],
      isError: true,
    });
    const call = DeskBridgeToolCall.safeParse(params);
    if (!call.success) {
      return fail(rejection(
        "INVALID_RECORD",
        "tools/call params fail the bridge envelope schema",
        "the params must be {name, arguments?} within the wire bounds",
      ));
    }
    const tool = TOOLS.find(t => t.name === call.data.name);
    if (tool === undefined) {
      return fail(rejection(
        "INVALID_RECORD",
        `unknown desk tool ${JSON.stringify(call.data.name.slice(0, WIRE_LIMITS.deskBridgeToolName))}`,
        "tools/list enumerates every callable tool",
      ));
    }
    if (!tool.visible) {
      return fail(rejection(
        "AUTHORITY_REQUIRED",
        `${tool.name} is a hidden mechanism entry, not a seat tool`,
        "no caller may dispatch hidden catalog entries — the rejection is the mechanism",
      ));
    }
    const rowOrError = freshRow(bound);
    let row: SeatRow;
    let seatRead: DeskStoreRead | null;
    if ("error" in rowOrError) {
      // slp_status is the seat's own health reporter — a ledger that cannot
      // be read at all is exactly what it must describe: the
      // handshake-bound row still answers, desk.state degrades and the
      // assignments projection is withheld. Every other tool — and every
      // other error class — fails closed unchanged.
      if (tool.name !== STATUS_TOOL || rowOrError.error.code !== "STATE_UNREADABLE") {
        return fail(rowOrError.error);
      }
      row = bound.row;
      seatRead = rowOrError.read;
    } else {
      row = rowOrError.row;
      seatRead = rowOrError.read;
    }
    const identityError = await sdkIdentity(row);
    if (identityError !== null) return fail(identityError);
    const capError = capabilityGate();
    if (capError !== null) return fail(capError);
    const input = tool.input.safeParse(call.data.arguments ?? {});
    if (!input.success) {
      return fail(rejection(
        "INVALID_RECORD",
        `tool arguments fail the strict input schema for ${tool.name}`,
        "dispatch carries only the fields the tool's schema declares",
      ));
    }
    let availability: Availability;
    if (tool.mutation) {
      availability = probeAvailability(bound.repoKey);
      if (availability !== "available") {
        return fail(rejection(
          "RECOVERY_REQUIRED",
          "desk-unavailable: the bound desk is recovery-required",
          "run the operator desk recovery before mutating desk state",
        ));
      }
    } else {
      // Status answers from the ONE read that resolved the seat row: the
      // lock probe is a filesystem check, while availability and the
      // assignments projection share freshRow's ledger observation — a
      // mid-call read transition can never split the view.
      availability =
        probeLock(bound.repoKey) === "recovery-required"
          ? "recovery-required"
          : seatRead !== null && seatRead.state === "ok"
            ? "available"
            : "degraded";
    }
    try {
      const result = await tool.run({ row, bound, availability, seatRead, input: input.data });
      return { content: [{ type: "text", text: text(result) }] };
    } catch (error) {
      return fail(rejection(
        "EXECUTION_UNKNOWN",
        `tool ${tool.name} failed: ${(error as Error).message.slice(0, 200)}`,
        "the dispatch result is unknown — do not assume it landed",
      ));
    }
  }

  // ---------------------------------------------------------------------
  // connection handling — hello → bound seat → serialized JSON-RPC
  // ---------------------------------------------------------------------

  function ackLine(ok: boolean, error?: { code: DeskErrorCode; message: string }): string {
    const ack = ok
      ? { schemaVersion: 1 as const, protocol: DESK_BRIDGE_PROTOCOL, ok: true as const }
      : {
          schemaVersion: 1 as const,
          protocol: DESK_BRIDGE_PROTOCOL,
          ok: false as const,
          error: error ?? { code: "CAPABILITY_GAP" as const, message: "unknown" },
        };
    return JSON.stringify(DeskBridgeAck.parse(ack)) + "\n";
  }

  function rejectConn(conn: Socket, code: DeskErrorCode, message: string): void {
    try {
      conn.write(ackLine(false, { code, message }), () => conn.destroy());
    } catch {
      conn.destroy();
    }
  }

  function dispatchMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
    const hasId = "id" in msg && msg.id !== undefined;
    if (!hasId) return null; // notifications never answer
    const id = msg.id;
    const answer = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (msg.method) {
      case "initialize": {
        const params = isRecord(msg.params) ? msg.params : {};
        const protocolVersion =
          typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_FALLBACK;
        return answer({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "slp-desk", version: DESK_BRIDGE_PROTOCOL },
        });
      }
      case "ping":
        return answer({});
      case "tools/list":
        return answer({ tools: mcpToolsList() });
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `slp-desk: unknown method ${JSON.stringify(String(msg.method).slice(0, 64))}`,
          },
        };
    }
  }

  function handleConnection(conn: Socket): void {
    if (connections.size >= MAX_CONNECTIONS) {
      rejectConn(conn, "CAPABILITY_GAP", "desk bridge connection limit reached");
      return;
    }
    connections.add(conn);
    let bound: BoundSeat | null = null;
    let pending: Promise<void> = Promise.resolve();
    const handshakeTimer = setTimeout(() => {
      if (bound === null) {
        rejectConn(conn, "INVALID_RECORD", "hello not received within the handshake budget");
      }
    }, HANDSHAKE_BUDGET_MS);
    handshakeTimer.unref();

    let carry = Buffer.alloc(0);
    const write = (line: string) => {
      try {
        conn.write(line + "\n");
      } catch { /* closing */ }
    };
    /** Every adapter-emitted error frame carries the typed SLP desk code in
     *  `error.data.slpCode` (schema-validated against DeskBridgeFrameError)
     *  alongside the numeric JSON-RPC code — the vocabulary is
     *  machine-readable, never just message text (D3/errata T5). */
    const writeError = (id: unknown, code: number, message: string, slpCode: DeskErrorCode) => {
      const error = DeskBridgeFrameError.safeParse({ code, message, data: { slpCode } });
      write(JSON.stringify(error.success
        ? { jsonrpc: "2.0", id, error: error.data }
        : { jsonrpc: "2.0", id, error: { code: -32603, message: "slp-desk: error frame failed schema", data: { slpCode: "INVALID_RECORD" } } }));
    };
    /** Outbound frames obey the response byte cap (D3): an oversized result
     *  is replaced by a bounded typed error, never truncated. */
    const writeResult = (id: unknown, result: unknown) => {
      const line = JSON.stringify({ jsonrpc: "2.0", id, result });
      if (Buffer.byteLength(line, "utf8") <= RESPONSE_CAP) {
        write(line);
        return;
      }
      writeError(
        id,
        -32603,
        `RESPONSE_TOO_LARGE: desk reply exceeds the ${RESPONSE_CAP}-byte frame cap`,
        "RESPONSE_TOO_LARGE",
      );
    };

    const onLine = async (line: Buffer): Promise<void> => {
      if (bound === null) {
        clearTimeout(handshakeTimer);
        let hello: unknown;
        const helloText = decodeFrame(line);
        if (helloText === null) {
          rejectConn(conn, "INVALID_RECORD", "hello is not valid UTF-8");
          return;
        }
        try {
          hello = JSON.parse(helloText);
        } catch {
          rejectConn(conn, "INVALID_RECORD", "hello is not valid JSON");
          return;
        }
        const parsed = DeskBridgeHello.safeParse(hello);
        if (!parsed.success) {
          rejectConn(conn, "INVALID_RECORD", "hello fails the bridge handshake schema");
          return;
        }
        // The hello's self-reported binary sha must equal the launch-set
        // pin — absence of a pin is also a refusal: a candidate that never
        // recorded one has no bridge contract to serve.
        const pin = binding?.bridgeSha256;
        if (pin === undefined || parsed.data.bridgeSha256 !== pin) {
          rejectConn(conn, "CANDIDATE_DRIFT", "the running bridge binary does not match the bound candidate's recorded pin");
          return;
        }
        const seat = resolveSeat(sha256Hex(parsed.data.handle));
        if ("error" in seat) {
          rejectConn(conn, seat.error.code, seat.error.message);
          return;
        }
        if (seat.row.agentId === null) {
          rejectConn(conn, "ACTOR_MISMATCH", "the membership is not host-bound to an agent yet");
          return;
        }
        if (seat.row.state === "revoked") {
          rejectConn(conn, "STALE_EPOCH", "the membership is revoked");
          return;
        }
        bound = {
          repoKey: seat.repoKey,
          handleSha256: sha256Hex(parsed.data.handle),
          membershipId: seat.row.membershipId,
          agentId: seat.row.agentId,
          openGeneration: seat.row.openGeneration,
          row: seat.row,
        };
        // ackLine already terminates its own frame — write it raw so no
        // empty line follows the handshake answer.
        try {
          conn.write(ackLine(true));
        } catch { /* closing */ }
        return;
      }
      let msg: unknown;
      const msgText = decodeFrame(line);
      if (msgText === null) {
        writeError(null, -32700, "slp-desk: malformed NDJSON frame (invalid UTF-8)", "INVALID_RECORD");
        return;
      }
      try {
        msg = JSON.parse(msgText);
      } catch {
        writeError(null, -32700, "slp-desk: malformed NDJSON frame", "INVALID_RECORD");
        return;
      }
      if (!isRecord(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
        writeError(null, -32600, "slp-desk: malformed JSON-RPC frame", "INVALID_RECORD");
        return;
      }
      if (msg.method === "tools/call" && "id" in msg && msg.id !== undefined) {
        try {
          const result = await callTool(msg.params, bound);
          writeResult(msg.id, result);
        } catch (error) {
          // No frame may go unacknowledged — a guard or runner fault still
          // answers with a bounded typed error, never a silent timeout.
          writeError(
            msg.id,
            -32603,
            `slp-desk: dispatch fault — ${(error as Error).message.slice(0, 200)}`,
            "EXECUTION_UNKNOWN",
          );
        }
        return;
      }
      const reply = dispatchMessage(msg);
      if (reply !== null) {
        if ("error" in reply) {
          const error = reply.error as { code: number; message: string };
          writeError(reply.id, error.code, error.message, "CAPABILITY_GAP");
        } else {
          writeResult(reply.id, reply.result);
        }
      }
    };

    // An unterminated over-cap frame is swallowed whole: once the cap
    // trips mid-frame, every byte up to the next newline is discarded so
    // the flood's tail can never re-parse as a fresh request. A complete
    // over-cap line is already bounded by its newline — reject it and
    // resume on the next frame.
    let dropping = false;
    const overCap = (swallow: boolean) => {
      if (bound === null) {
        clearTimeout(handshakeTimer);
        rejectConn(
          conn,
          "REQUEST_TOO_LARGE",
          `hello frame exceeds the ${REQUEST_CAP}-byte cap`,
        );
        return;
      }
      dropping = swallow;
      writeError(null, -32600, `REQUEST_TOO_LARGE: slp-desk frame exceeds ${REQUEST_CAP} bytes`, "REQUEST_TOO_LARGE");
    };
    conn.on("data", chunk => {
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let start = 0;
      for (;;) {
        const nl = carry.indexOf(0x0a, start);
        if (nl === -1) {
          if (dropping) {
            carry = Buffer.alloc(0);
            return;
          }
          const rest = carry.subarray(start);
          if (rest.length > REQUEST_CAP) {
            overCap(true);
            carry = Buffer.alloc(0);
          } else {
            carry = rest;
          }
          return;
        }
        if (dropping) {
          start = nl + 1;
          dropping = false;
          continue;
        }
        const line = carry.subarray(start, nl);
        start = nl + 1;
        if (line.length > REQUEST_CAP) {
          overCap(false);
          continue;
        }
        // Serialize per-connection dispatch — a frame never starts until
        // the previous one fully answered.
        pending = pending.then(() => onLine(line)).catch(error => {
          warn("dispatch-fault", `slp: desk bridge dispatch fault: ${(error as Error).message}`);
          // Warn-only is not a response: a fault outside the guarded
          // callTool path still owes the client one bounded frame.
          try {
            if (bound === null) {
              rejectConn(conn, "EXECUTION_UNKNOWN", "slp-desk: dispatch fault during the handshake");
            } else {
              writeError(null, -32603, `slp-desk: dispatch fault — ${(error as Error).message.slice(0, 200)}`, "EXECUTION_UNKNOWN");
            }
          } catch { /* the connection is already closing */ }
        });
      }
    });
    conn.on("error", () => { /* close owns cleanup */ });
    conn.on("close", () => {
      clearTimeout(handshakeTimer);
      connections.delete(conn);
    });
  }

  // ---------------------------------------------------------------------
  // start / stop / graft / stash
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // stable bridge binary (F1) — self-install under enforcementDir
  // ---------------------------------------------------------------------

  /** Self-install the verified bridge binary at the stable, non-SHA path
   *  `paths.bridgePath` and return that path — or null with one bounded
   *  diagnostic when integrity fails. Verified chain: the candidate bytes
   *  at `binding.runtimePath/bin/slp-desk-mcp.mjs` must hash to BOTH the
   *  launch-manifest pin and the embedded payload declaration before any
   *  byte is installed; the installed file is then re-hashed so a graft
   *  never points at bytes that diverge from the pin. The lifecycle lock
   *  makes this instance the only writer, so an atomic tmp+rename
   *  replacement is safe — a GC'd or drifted stable file is re-installed,
   *  never served as-is. */
  function stableBridgePath(): string | null {
    if (paths === null || binding === null) return null;
    const pin = binding.bridgeSha256;
    const declared = deps.payload.files.find(f => f.path === BRIDGE_FILE)?.sha256;
    const shorten = (v: string | undefined) => (v === undefined ? "absent" : `${v.slice(0, 12)}…`);
    if (pin === undefined || declared === undefined || pin !== declared) {
      warn(
        "graft-drift",
        `slp: desk bridge pin divergence (manifest ${shorten(pin)}, payload ${shorten(declared)}) — no stable binary installed`,
      );
      return null;
    }
    const target = paths.bridgePath;
    // Already installed and intact — a regular file hashing to the pin.
    // Checked BEFORE the candidate read so a GC'd candidate directory
    // cannot strand a verified install (the whole point of F1).
    try {
      const stat = lstatSync(target);
      if (stat.isFile() && !stat.isSymbolicLink() &&
          sha256Hex(readFileSync(target)) === pin) {
        return target;
      }
    } catch { /* absent or unreadable — install below */ }
    const source = join(binding.runtimePath, BRIDGE_FILE);
    let bytes: Buffer;
    try {
      bytes = readFileSync(source);
    } catch (error) {
      warn("graft-read", `slp: desk bridge binary unreadable at ${source}: ${(error as Error).message}`);
      return null;
    }
    if (sha256Hex(bytes) !== pin) {
      warn("graft-drift", `slp: desk bridge candidate bytes fail the manifest pin (${sha256Hex(bytes).slice(0, 12)}…) — no stable binary installed`);
      return null;
    }
    const tmp = join(paths.enforcementDir, `.slp-desk-mcp.${process.pid}.${instanceNonce}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "w", 0o600);
      writeSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, target);
      if (sha256Hex(readFileSync(target)) !== pin) {
        warn("graft-drift", `slp: desk bridge stable file at ${target} failed post-install verification — graft refused`);
        return null;
      }
      return target;
    } catch (error) {
      warn("graft-install", `slp: desk bridge stable install failed: ${(error as Error).message}`);
      return null;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* closed */ }
      }
      try { unlinkSync(tmp); } catch { /* renamed or never created */ }
    }
  }

  let readyResolve!: (s: "listening" | "unavailable") => void;
  const ready = new Promise<"listening" | "unavailable">(resolve => {
    readyResolve = resolve;
  });

  async function start(): Promise<void> {
    if (stopped) return;
    if (platform === "win32") {
      state = { kind: "unavailable", code: "CAPABILITY_GAP", reason: "no Windows transport — unix-socket only" };
      readyResolve("unavailable");
      return;
    }
    /** F8: stop() may run while an await below is still pending — after each
     *  resumption re-check the flag and undo whatever this attempt already
     *  acquired so nothing outlives plugin cleanup. */
    const abortIfStopped = async (): Promise<boolean> => {
      if (!stopped) return false;
      if (server !== null) {
        await new Promise<void>(resolve => server!.close(() => resolve()));
        server = null;
      }
      if (paths !== null) {
        try { unlinkSync(paths.socketPath); } catch { /* never created */ }
      }
      releaseLock();
      state = { kind: "unavailable", code: "CAPABILITY_GAP", reason: "desk bridge stopped" };
      readyResolve("unavailable");
      return true;
    };
    try {
      const resolved = await resolveStableRoot();
      if (await abortIfStopped()) return;
      stableRoot = resolved.stableRoot;
      binding = resolved.binding;
      paths = deskBridgePaths(stableRoot);
      // F7: lstat every path component under the verified root — a symlinked
      // or non-directory intermediate would silently place the socket, lock
      // and installed binary outside it (launchers assertRealSetPath rule).
      assertRealComponents(stableRoot, paths.enforcementDir, "desk bridge");
      assertRealComponents(stableRoot, deskReposDir(stableRoot), "desk bridge");
      assertRealComponents(stableRoot, paths.repoDir, "desk bridge");
      assertRealComponents(stableRoot, dirname(paths.socketPath), "desk bridge");
      assertRealComponents(stableRoot, dirname(paths.lockPath), "desk bridge");
      assertRealComponents(stableRoot, dirname(paths.bridgePath), "desk bridge");
      ensurePrivateDirectory(paths.enforcementDir, platform);
      ensurePrivateDirectory(deskReposDir(stableRoot), platform);
      ensurePrivateDirectory(paths.repoDir, platform);
      const lock = await acquireLock(paths.lockPath);
      if (await abortIfStopped()) {
        return;
      }
      if (!lock.ok) {
        state = { kind: "unavailable", code: lock.code, reason: lock.reason };
        warn(`bridge-${lock.code}`, `slp: desk bridge ${lock.code}: ${lock.reason}`);
        readyResolve("unavailable");
        return;
      }
      // The socket file without a live lock holder is leftover, never a
      // peer — only we hold the lock here, so replacing it is safe.
      try { unlinkSync(paths.socketPath); } catch { /* absent */ }
      // F1: install the verified stable binary eagerly while the lifecycle
      // lock still makes this instance the sole writer — a drifted or
      // missing install only warns; the graft re-verifies per call and
      // fails closed on its own.
      stableBridgePath();
      server = createServer(handleConnection);
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(paths!.socketPath, () => {
          server!.removeListener("error", reject);
          resolve();
        });
      });
      if (await abortIfStopped()) return;
      try {
        chmodSync(paths.socketPath, 0o600);
      } catch (error) {
        await new Promise<void>(resolve => server!.close(() => resolve()));
        server = null;
        releaseLock();
        state = {
          kind: "unavailable",
          code: "CAPABILITY_GAP",
          reason: `socket mode could not be pinned: ${(error as Error).message}`,
        };
        readyResolve("unavailable");
        return;
      }
      store = createStore(stableRoot);
      state = { kind: "listening", socketPath: paths.socketPath };
      readyResolve("listening");
    } catch (error) {
      releaseLock();
      const reason = (error as Error).message ?? String(error);
      const parsed = isRecord(error) ? DeskErrorCodeSchema.safeParse(error.code) : null;
      const code: DeskErrorCode = parsed?.success === true ? parsed.data : "CAPABILITY_GAP";
      state = { kind: "unavailable", code, reason: `stable-root resolution failed: ${reason.slice(0, 300)}` };
      readyResolve("unavailable");
    }
  }

  function stop(): void {
    stopped = true;
    // Cleanup order (contract §3.3): connections → server → socket → lock.
    for (const conn of connections) {
      try { conn.destroy(); } catch { /* already gone */ }
    }
    connections.clear();
    const srv = server;
    server = null;
    const finish = () => {
      if (paths !== null) {
        try { unlinkSync(paths.socketPath); } catch { /* already gone */ }
      }
      releaseLock();
      if (state.kind === "listening" || state.kind === "starting") {
        state = { kind: "unavailable", code: "CAPABILITY_GAP", reason: "desk bridge stopped" };
        readyResolve("unavailable");
      }
    };
    if (srv !== null) {
      srv.close(finish);
      return;
    }
    finish();
  }

  /** The agent.create graft (contract §4 amend P2-c): when the P2-c mint
   *  already placed a handle in request.env and the bridge is listening,
   *  graft the stdio server into config.mcpServers.slp_desk with env
   *  carrying the same handle plus the socket path. Registered AFTER
   *  role-injection's hook, so a missing handle means the mint fail-opened
   *  and the graft follows suit. Unrelated entries pass through verbatim;
   *  a foreign slp_desk entry or a failed integrity check leaves the
   *  request untouched (fail-open, one bounded diagnostic each). */
  async function agentCreateGraft(
    input: { request: AgentCreateRequest },
    ctx?: PluginHookContext,
  ): Promise<AgentCreateRequest | undefined> {
    stashPaseo(ctx?.paseo);
    const request = input.request;
    const config = request.config;
    const provider = config?.provider;
    if (typeof provider !== "string" || !provider.startsWith("slp-") || config === undefined) {
      return undefined;
    }
    const handle = request.env?.SLP_DESK_HANDLE;
    if (typeof handle !== "string" || handle.length === 0) return undefined;
    // A create can race contribute(): wait the bounded budget for start()
    // to settle, then fail open — a bridge that never started never blocks
    // the mint, it just adds no transport.
    await Promise.race([ready, sleep(LEDGER_LIMITS.lockWaitMs)]);
    if (state.kind !== "listening") {
      warn("graft-unavailable", "slp: desk bridge is not listening — seat mints keep env handle only");
      return undefined;
    }
    if (binding === null || paths === null) {
      warn("graft-no-binding", "slp: desk bridge has no active binding — graft skipped");
      return undefined;
    }
    const mcpServers = config.mcpServers ?? {};
    if ("slp_desk" in mcpServers) {
      warn("graft-collision", "slp: config.mcpServers.slp_desk already exists — graft skipped, entry preserved");
      return undefined;
    }
    // Integrity (F1): the graft points at the STABLE binary under the
    // enforcement dir — never the GC-able candidate sha-dir. The install
    // helper verifies candidate bytes == manifest pin == payload
    // declaration before serving the path, and re-installs a drifted or
    // GC'd copy from the verified source.
    const bridgePath = stableBridgePath();
    if (bridgePath === null) {
      warn("graft-refused", "slp: desk bridge stable binary fails integrity — graft refused");
      return undefined;
    }
    return {
      ...request,
      config: {
        ...config,
        mcpServers: {
          ...mcpServers,
          slp_desk: {
            type: "stdio",
            command: binding.nodePath,
            args: [bridgePath],
            env: {
              SLP_DESK_HANDLE: handle,
              SLP_DESK_SOCK: paths.socketPath,
            },
          },
        },
      },
    };
  }

  /** A stash-only session_open before-hook — supplies the connected SDK
   *  context to dispatch guards on resume/refresh opens where no create
   *  ever ran this process lifetime. Returns undefined (no request change). */
  function sessionOpenStash(
    _input: { request: SessionOpenRequest },
    ctx?: PluginHookContext,
  ): undefined {
    stashPaseo(ctx?.paseo);
    return undefined;
  }

  return {
    /** Kick the lifecycle — resolves the verified stable root, takes the
     *  lock, binds the socket. Safe to fire-and-forget; state/ready carry
     *  the outcome. */
    start,
    /** Resolves "listening" or "unavailable" exactly once. */
    whenReady: () => ready,
    state: () => state,
    socketPath: () => (state.kind === "listening" ? state.socketPath : null),
    /** Hook-only SDK stash — never counts as RPC-dispatch evidence. */
    notePaseo: stashPaseo,
    /** Called from a real daemon→plugin RPC handler: records dispatch
     *  evidence AND stashes the SDK context. */
    noteDispatch,
    agentCreateGraft,
    sessionOpenStash,
    stop,
  };
}

export type DeskBridge = ReturnType<typeof createDeskBridge>;
