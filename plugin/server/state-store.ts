// Plugin-owned state files under <stableRoot>/state — readers, the file
// names, and the atomic 0600 write (a uuid-named temp sibling + rename, so
// a crash never leaves a half-written file for the next reader). Shared by
// the manager's role-routing/peer-pool writes and the jev module's
// config/key writes. Bounded: set-language keeps its deliberate direct
// write (the file is a one-line preference, not a routing artifact), and
// this module is not a general persistence layer.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GetPeerPoolInput,
  GetRoleRoutingInput,
  OperationConflict,
  PeerPool,
  RoleRouting,
  SetLanguageInput,
  SetPeerPoolInput,
  SetRoleRoutingInput,
  type GetPeerPoolResult,
  type GetRoleRoutingResult,
  type PeerPoolValue,
  type RoleRoutingValue,
  type SetLanguageResult,
  type SetPeerPoolResult,
  type SetRoleRoutingResult,
} from "../shared/contracts.ts";
import { catalogTokenConflicts } from "../shared/runtime/routing-vocabulary.ts";
import { sha256Hex } from "./config-view.ts";
import { resolveDaemonHome } from "./daemon-home.ts";

export function writePrivate(stableRoot: string, relative: string, bytes: string, uuid: () => string): void {
  const dir = join(stableRoot, "state");
  const file = join(stableRoot, relative);
  mkdirSync(dir, { recursive: true });
  const temp = `${file}.${uuid()}.tmp`;
  try {
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// Plugin-owned mutable state, outside the immutable candidate tree: the role
// bundle reads this file at session entry and injects the language only when
// set. <stableRoot>/state is created lazily — set-language must work before
// any activation has run.
export const LANGUAGE_FILE = join("state", "communication-language");
export function readLanguage(stableRoot: string): string | null {
  try {
    const value = readFileSync(join(stableRoot, LANGUAGE_FILE), "utf8").trim();
    return value || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Plugin-owned mutable state, same class as communication-language but read
// by the activation planner instead of the role bundle:
// <stableRoot>/state/role-routing.json picks the supervisor/lead provider
// families (+ optional model/mode/thinking/feature fields) that
// desiredProviderEntries/desiredProfiles generate from. Backward
// compatibility decision (settings-driven-providers.md §5 Phase 1): an
// absent file, unparseable bytes, or a schema/legacy-version mismatch all
// mean "no routing" — activation then keeps the v1 all-twelve provider
// generation exactly as before. The file is plugin-owned and rewritten
// atomically by set-role-routing, so foreign or truncated content degrades
// to the legacy path rather than blocking activation on a recoverable file.
export const ROUTING_FILE = join("state", "role-routing.json");
export function readRoleRouting(stableRoot: string): RoleRoutingValue | null {
  let raw: string;
  try {
    raw = readFileSync(join(stableRoot, ROUTING_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = RoleRouting.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Plugin-owned user-scope Peer pool: <stableRoot>/state/peer-pool.json is the
// catalog plugin/server/runtime/cli/routing.ts resolves for repositories without their own
// .paseo-slp/slp-routing.json. The plugin is its sole writer; set-peer-pool
// overwrites it atomically under sha256 CAS (same class of state write as
// set-role-routing). The retired pre-plugin catalog still sits directly under
// the daemon home — read here only so the Manager surface can offer a
// one-time import; the file is never written or deleted.
export const PEER_POOL_FILE = join("state", "peer-pool.json");
export const LEGACY_POOL_FILE = "slp-routing.json";
export interface PeerPoolFileView {
  pool: PeerPoolValue | null;
  sha256: string | null;
  error: string | null;
}
// Absent file = no pool (all null). A file that exists but fails JSON or
// schema parsing still reports its raw-bytes sha256 — the client can then
// overwrite it under CAS — and the parse error is surfaced as evidence
// rather than silently read as an empty pool. Other fs failures are the
// caller's choice: the pool file must fail loud (a Manager that cannot read
// the pool must not render it as empty), while the legacy probe is advisory
// and degrades to an error string instead of killing the whole RPC.
export function readPeerPoolFile(file: string, softErrors: boolean): PeerPoolFileView {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pool: null, sha256: null, error: null };
    if (softErrors) return { pool: null, sha256: null, error: `peer pool unreadable: ${(error as Error).message}` };
    throw new OperationConflict(
      "IO_FAILURE",
      `peer pool unreadable: ${(error as Error).message}`,
      { path: file },
    );
  }
  const sha256 = sha256Hex(raw);
  try {
    const parsed = PeerPool.safeParse(JSON.parse(raw));
    return parsed.success
      ? { pool: parsed.data, sha256, error: null }
      : { pool: null, sha256, error: `peer pool failed schema validation: ${parsed.error.issues[0]?.message ?? "schema"}` };
  } catch (error) {
    return { pool: null, sha256, error: `peer pool is not valid JSON: ${(error as Error).message}` };
  }
}


// ---------------------------------------------------------------------------
// The five state-file RPCs (wave 11 S5) — the same class of operation as
// jev.ts: plugin-owned files, no journal, no mutex, no authority gate.
// `uuid` arrives as a dep; home verification shares the §8.1 check in
// server/daemon-home.ts with this store's "not a link" message for a
// non-regular config.json (the message these RPCs carried in manager.ts).
// ---------------------------------------------------------------------------

export interface StateStoreDeps {
  uuid?: () => string;
}

export function createStateStore(deps: StateStoreDeps = {}) {
  const uuid = deps.uuid ?? randomUUID;
  const resolveHome = (target: { hostId: string; daemonHome: string }) =>
    resolveDaemonHome(target, "config.json must be a regular file, not a link");

  // One atomic file write under plugin-owned state — no journal, no mutex:
  // the role bundle reads it at the next session entry, and nothing else in
  // the operation pipeline touches it.
  async function setLanguage(input: unknown): Promise<SetLanguageResult> {
    const parsed = SetLanguageInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `invalid set-language input: ${parsed.error.issues[0]?.message ?? "schema"}`,
      );
    }
    const ctx = resolveHome(parsed.data.target);
    const file = join(ctx.stableRoot, LANGUAGE_FILE);
    if (parsed.data.value === null) {
      rmSync(file, { force: true });
      return { schemaVersion: 1, value: null };
    }
    mkdirSync(join(ctx.stableRoot, "state"), { recursive: true });
    writeFileSync(file, `${parsed.data.value}\n`, "utf8");
    return { schemaVersion: 1, value: parsed.data.value };
  }

  // Plugin-owned role routing — same class of operation as set-language:
  // one file under slp-runtime/state, no journal, no mutex. Read returns
  // null on absent/legacy content; write validates the strict schema then
  // lands atomically (temp sibling + rename) so a crash never leaves a
  // half-written routing for the next activation to read.
  async function getRoleRouting(input: unknown): Promise<GetRoleRoutingResult> {
    const parsed = GetRoleRoutingInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `invalid get-role-routing input: ${parsed.error.issues[0]?.message ?? "schema"}`,
      );
    }
    const ctx = resolveHome(parsed.data.target);
    return { schemaVersion: 1, routing: readRoleRouting(ctx.stableRoot) };
  }

  async function setRoleRouting(input: unknown): Promise<SetRoleRoutingResult> {
    const parsed = SetRoleRoutingInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `invalid set-role-routing input: ${parsed.error.issues[0]?.message ?? "schema"}`,
      );
    }
    const ctx = resolveHome(parsed.data.target);
    writePrivate(ctx.stableRoot, ROUTING_FILE, `${JSON.stringify(parsed.data.routing, null, 2)}\n`, uuid);
    return { schemaVersion: 1, routing: parsed.data.routing };
  }

  // The user-scope Peer pool — same class of plugin-owned state as
  // role-routing (one file under slp-runtime/state, no journal, no mutex, no
  // authority gate). The package's readCatalog resolves this file for every
  // repository without its own .paseo-slp/slp-routing.json, and the plugin is
  // its sole writer. Writes are whole-file overwrites under sha256 CAS so a
  // stale editor never clobbers a newer pool silently — a mismatch forces a
  // reload before saving.
  async function getPeerPool(input: unknown): Promise<GetPeerPoolResult> {
    const parsed = GetPeerPoolInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `invalid get-peer-pool input: ${parsed.error.issues[0]?.message ?? "schema"}`,
      );
    }
    const ctx = resolveHome(parsed.data.target);
    const { pool, sha256, error } = readPeerPoolFile(join(ctx.stableRoot, PEER_POOL_FILE), false);
    // The retired user catalog is offered as a one-time import source —
    // advisory only: a read failure degrades to legacyError and never kills
    // get-peer-pool. The plugin never modifies or deletes the legacy file.
    const legacy = readPeerPoolFile(join(ctx.canonicalHome, LEGACY_POOL_FILE), true);
    return { schemaVersion: 1, pool, sha256, error, legacy: legacy.pool, legacyError: legacy.error };
  }

  async function setPeerPool(input: unknown): Promise<SetPeerPoolResult> {
    const parsed = SetPeerPoolInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `invalid set-peer-pool input: ${parsed.error.issues[0]?.message ?? "schema"}`,
      );
    }
    const ctx = resolveHome(parsed.data.target);
    const file = join(ctx.stableRoot, PEER_POOL_FILE);
    // Semantic gate (§7.2), shared with the form build and the routing-read
    // path: a seat on a reserved standard id whose tokens diverge from the
    // package set is a Token conflict — never stored as a valid standard
    // seat. The conflict survives in the file only when it arrived by import
    // or package upgrade; every write must resolve it first.
    const conflicts = catalogTokenConflicts(parsed.data.pool);
    if (conflicts.length > 0) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `peer pool has unresolved Token conflicts on standard seats: ${conflicts.map(c => c.id).join(", ")} — resolve each seat in the Manager surface (use the standard set or convert to a custom id)`,
      );
    }
    // CAS gate next, after the semantic gate above: the on-disk bytes must
    // hash to the token the writer read. An unreadable pool fails loud
    // rather than comparing against null.
    const actualSha256 = readPeerPoolFile(file, false).sha256;
    if (actualSha256 !== parsed.data.expectedSha256) {
      throw new OperationConflict(
        "IDEMPOTENCY_CONFLICT",
        "peer pool changed since it was read — reload before saving",
        { path: file, expectedSha256: parsed.data.expectedSha256, actualSha256 },
      );
    }
    const bytes = `${JSON.stringify(parsed.data.pool, null, 2)}\n`;
    writePrivate(ctx.stableRoot, PEER_POOL_FILE, bytes, uuid);
    return { schemaVersion: 1, pool: parsed.data.pool, sha256: sha256Hex(bytes) };
  }

  return { setLanguage, getRoleRouting, setRoleRouting, getPeerPool, setPeerPool };
}
