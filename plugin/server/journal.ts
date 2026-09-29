// plugin/server/journal.ts — sole owner of receipt I/O (spec §4, §7).
//
// The receipt lives at <stable-root>/state/receipt.json and is the single
// authoritative journal: state, binding, retained runtimes and every operation
// intent share one atomic document. Writes are temp-sibling + flush + rename +
// directory fsync (POSIX), mode 0600, and each write increments `revision` by
// exactly one against the bytes currently on disk — a tampered or concurrently
// rewritten receipt therefore fails instead of being silently replaced.
//
// A corrupt or unsupported journal is evidence: readers get a
// RECOVERY_REQUIRED conflict and the file is never overwritten.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  Receipt,
  OperationConflict,
  type BindingValue,
  type IntentValue,
  type ProjectionValue,
  type ReceiptValue,
  type SnapshotValue,
} from "../shared/contracts.ts";
import {
  OWNED_PROFILE_IDS,
  OWNED_PROVIDER_IDS,
  canonicalSha256,
  providerExtendsForId,
} from "./config-view.ts";
import {
  assertRealDirectory,
  ensurePrivateDirectory,
  fsyncDirectory,
  lstatOrNull,
  PRIVATE_FILE_MODE,
} from "./kept-files.ts";

export const RECEIPT_FILE = join("state", "receipt.json");
const RECEIPT_MODE = PRIVATE_FILE_MODE;

export interface JournalDeps {
  /** Temp-file name entropy; injected for deterministic fault tests. */
  uuid?: () => string;
  platform?: string;
}

export interface Journal {
  /** Absolute receipt path for a stable root. */
  receiptPath(stableRoot: string): string;
  /**
   * Load the receipt; null when absent. Throws OperationConflict
   * (RECOVERY_REQUIRED) on corrupt bytes, schema violations, unexpected file
   * types or cross-field inconsistencies — callers must not overwrite it.
   */
  read(stableRoot: string): ReceiptValue | null;
  /**
   * Validate and atomically replace the receipt. `receipt.revision` must equal
   * the on-disk revision + 1 (0 when no receipt exists). Throws
   * OperationConflict(IO_FAILURE) on filesystem failure and a plain Error on
   * internal validation failure.
   */
  write(stableRoot: string, receipt: ReceiptValue): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Phases at or past plan commitment — the op has computed (and may already
 *  have dispatched) a mutation, so a durable plan must exist to interpret it.
 *  `terminal` is deliberately absent: pre-plan failures and early no-ops are
 *  stamped terminal with plan:null, which is legitimate. Instead, terminal
 *  ops whose outcome implies mutation (succeeded, recovery-required — the
 *  latter requires a dispatched patch attempt, which requires a plan) must
 *  still carry their plan — unless the op is a reconcile(inspect), which by
 *  definition never holds a plan. */
const PLAN_REQUIRED_PHASES = new Set(["prepared", "patch-dispatched", "verified"]);

/** The §7 cross-field refinements layered on top of Receipt.parse. */
function assertReceiptRefinements(receipt: ReceiptValue): void {
  const ids = new Set<string>();
  let pending = 0;
  for (const op of receipt.operations) {
    if (ids.has(op.operationId)) {
      throw new Error(`duplicate operation id ${op.operationId} in receipt`);
    }
    ids.add(op.operationId);
    if (op.outcome === "pending") pending += 1;
    if (PLAN_REQUIRED_PHASES.has(op.phase) && op.plan === null) {
      throw new Error(`operation ${op.operationId} in mutating phase ${op.phase} lacks a plan`);
    }
    const planlessInspect = op.kind === "reconcile" && op.recoveryAction === "inspect";
    if (
      op.phase === "terminal" &&
      op.plan === null &&
      !planlessInspect &&
      (op.outcome === "succeeded" || op.outcome === "recovery-required")
    ) {
      throw new Error(
        `operation ${op.operationId} terminated ${op.outcome} without a recorded plan`,
      );
    }
  }
  if (pending > 1) throw new Error("receipt holds more than one pending operation");
  if (receipt.activeOperationId !== null && !ids.has(receipt.activeOperationId)) {
    throw new Error(`activeOperationId ${receipt.activeOperationId} has no matching intent`);
  }
  const projections: (ProjectionValue | null | undefined)[] = [
    receipt.binding?.owned,
    receipt.binding?.beforeActivation.owned,
  ];
  for (const op of receipt.operations) {
    projections.push(op.plan?.before.owned, op.plan?.afterOwned);
  }
  for (const projection of projections) {
    if (!projection) continue;
    assertProjectionShape(projection);
  }
  // A live binding must own the complete projection — the exact twelve-id
  // provider key set (assertProjectionShape already proved it) plus both
  // profile slots. Settings-driven generation (Phase 1) legitimately records
  // non-chosen combos as present:false inside that key set; what remains
  // tampering is a missing profile slot or a malformed key set.
  if (receipt.binding !== null) {
    const owned = receipt.binding.owned;
    const slotIds = new Set(owned.profiles.map(slot => slot.value.id));
    for (const id of OWNED_PROFILE_IDS) {
      if (!slotIds.has(id)) {
        throw new Error(`bound receipt lacks owned profile ${id}`);
      }
    }
  }
  assertReceiptPaths(receipt);
  assertReceiptDerivedHashes(receipt);
}

/** §7 — digests recorded over other receipt fields must equal the
 *  recomputed hash of those fields. Format validity (the schema's Sha
 *  pattern) proves only the string LOOKS like a digest; a tampered or
 *  corrupt bindingSha256/ownedSha256 must not survive journal validation.
 *  Hashes of EXTERNAL state (rawConfigSha256, allProfilesSha256,
 *  unrelatedPersistedSha256, requestSha256, launcherFiles,
 *  lastDeactivatedBindingSha256) are not recomputable here — they bind data
 *  the receipt does not carry — and stay schema-checked only. */
function assertReceiptDerivedHashes(receipt: ReceiptValue): void {
  const checkSnapshot = (snapshot: SnapshotValue, label: string): void => {
    if (snapshot.ownedSha256 !== canonicalSha256(snapshot.owned)) {
      throw new Error(`${label} ownedSha256 does not match its owned projection`);
    }
  };
  const checkBinding = (binding: BindingValue, label: string): void => {
    const expected = canonicalSha256({
      candidateSha256: binding.candidateSha256,
      payloadSha256: binding.payloadSha256,
      launchSetSha256: binding.launchSetSha256,
      owned: binding.owned,
    });
    if (binding.bindingSha256 !== expected) {
      throw new Error(`${label} bindingSha256 does not match its recorded fields`);
    }
    if (binding.postPatchPersistedShapeSha256 !== canonicalSha256(binding.owned)) {
      throw new Error(`${label} postPatchPersistedShapeSha256 does not match its owned projection`);
    }
    checkSnapshot(binding.beforeActivation, `${label} beforeActivation`);
  };
  if (receipt.binding !== null) checkBinding(receipt.binding, "binding");
  for (const op of receipt.operations) {
    if (op.plan === null) continue;
    const label = `operation ${op.operationId} plan`;
    checkSnapshot(op.plan.before, `${label} before`);
    if (op.plan.afterOwnedSha256 !== canonicalSha256(op.plan.afterOwned)) {
      throw new Error(`${label} afterOwnedSha256 does not match its owned projection`);
    }
    if (op.plan.previousBinding !== null) {
      checkBinding(op.plan.previousBinding, `${label} previousBinding`);
    }
    if (op.plan.nextBinding !== null) {
      checkBinding(op.plan.nextBinding, `${label} nextBinding`);
    }
  }
}

/** §7 — every recorded path must sit exactly where the target's stable root
 *  puts it: stableRoot === <daemonHome>/slp-runtime; a binding's runtimePath is
 *  <stableRoot>/<candidateSha256>; launcher files live directly inside
 *  <stableRoot>/launchers/<launchSetSha256>; retained runtimePaths follow the
 *  binding rule. A foreign or relocated path is tampering, not drift. */
function assertReceiptPaths(receipt: ReceiptValue): void {
  const stableRoot = join(receipt.target.daemonHome, "slp-runtime");
  if (resolve(receipt.stableRoot) !== resolve(stableRoot)) {
    throw new Error(`stableRoot ${receipt.stableRoot} is not ${stableRoot}`);
  }
  const checkBinding = (binding: NonNullable<ReceiptValue["binding"]>, label: string) => {
    const expectedRuntime = join(stableRoot, binding.candidateSha256);
    if (resolve(binding.runtimePath) !== resolve(expectedRuntime)) {
      throw new Error(`${label} runtimePath ${binding.runtimePath} is not ${expectedRuntime}`);
    }
    const launchDir = join(stableRoot, "launchers", binding.launchSetSha256);
    for (const file of binding.launcherFiles) {
      if (resolve(dirname(file.path)) !== resolve(launchDir) || basename(file.path).length === 0) {
        throw new Error(`${label} launcher file ${file.path} is not inside ${launchDir}`);
      }
    }
  };
  if (receipt.binding !== null) checkBinding(receipt.binding, "binding");
  for (const op of receipt.operations) {
    if (op.plan?.previousBinding) {
      checkBinding(op.plan.previousBinding, `operation ${op.operationId} previousBinding`);
    }
    if (op.plan?.nextBinding) {
      checkBinding(op.plan.nextBinding, `operation ${op.operationId} nextBinding`);
    }
  }
  for (const retained of receipt.retained) {
    const expectedRuntime = join(stableRoot, retained.candidateSha256);
    if (resolve(retained.runtimePath) !== resolve(expectedRuntime)) {
      throw new Error(`retained runtimePath ${retained.runtimePath} is not ${expectedRuntime}`);
    }
  }
}

export function assertProjectionShape(projection: ProjectionValue): void {
  const keys = Object.keys(projection.providers).sort();
  if (keys.length !== OWNED_PROVIDER_IDS.length || keys.some((key, i) => key !== OWNED_PROVIDER_IDS[i])) {
    throw new Error("projection must carry exactly the twelve owned provider ids");
  }
  const seenProfileIds = new Set<string>();
  const seenIndexes = new Set<number>();
  for (const slot of projection.profiles) {
    if (!OWNED_PROFILE_IDS.includes(slot.value.id)) {
      throw new Error(`projection holds a non-owned profile id ${slot.value.id}`);
    }
    if (seenProfileIds.has(slot.value.id) || seenIndexes.has(slot.index)) {
      throw new Error("projection has duplicate profile ids or indexes");
    }
    seenProfileIds.add(slot.value.id);
    seenIndexes.add(slot.index);
  }
  for (const [id, presence] of Object.entries(projection.providers)) {
    if (!presence.present) continue;
    const expected = providerExtendsForId(id);
    if (expected === null || presence.value.extends !== expected) {
      throw new Error(`provider ${id} extends ${presence.value.extends}, expected ${expected}`);
    }
  }
}

function summarizeIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 8)
    .map(issue => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}

export function createJournal(deps: JournalDeps = {}): Journal {
  const uuid = deps.uuid ?? (() => randomUUID());
  const platform = deps.platform ?? process.platform;

  function receiptPath(stableRoot: string): string {
    return join(stableRoot, RECEIPT_FILE);
  }

  function read(stableRoot: string): ReceiptValue | null {
    const path = receiptPath(stableRoot);
    // §4's real-directory rule applies to the receipt's ancestors whether or
    // not the file exists: a symlinked state directory must not smuggle a
    // schema-valid receipt through a path the journal did not create.
    assertRealDirectory(join(stableRoot, "state"), "SLP state directory");
    assertRealDirectory(stableRoot, "SLP stable root");
    const stat = lstatOrNull(path);
    if (stat === null) {
      return null;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new OperationConflict("RECOVERY_REQUIRED", "receipt is not a regular file", { path });
    }
    let bytes: string;
    try {
      bytes = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new OperationConflict("IO_FAILURE", `cannot read receipt: ${(error as Error).message}`, {
        path,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(bytes);
    } catch {
      throw new OperationConflict("RECOVERY_REQUIRED", "receipt is not valid JSON; preserved for inspection", { path });
    }
    const parsed = Receipt.safeParse(json);
    if (!parsed.success) {
      throw new OperationConflict(
        "RECOVERY_REQUIRED",
        `receipt fails schema validation; preserved for inspection:\n${summarizeIssues(parsed.error)}`,
        { path },
      );
    }
    try {
      assertReceiptRefinements(parsed.data);
    } catch (error) {
      throw new OperationConflict(
        "RECOVERY_REQUIRED",
        `receipt violates cross-field invariants: ${(error as Error).message}`,
        { path },
      );
    }
    return parsed.data;
  }

  function write(stableRoot: string, receipt: ReceiptValue): void {
    const previous = read(stableRoot);
    const expectedRevision = previous === null ? 0 : previous.revision + 1;
    if (receipt.revision !== expectedRevision) {
      throw new Error(
        `receipt revision must advance by one: on-disk ${previous?.revision ?? "none"}, got ${receipt.revision}`,
      );
    }
    const parsed = Receipt.parse(receipt);
    assertReceiptRefinements(parsed);
    const stateDir = join(stableRoot, "state");
    ensurePrivateDirectory(stableRoot, platform);
    ensurePrivateDirectory(stateDir, platform);
    const path = receiptPath(stableRoot);
    const stat = lstatOrNull(path);
    if (stat !== null && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new OperationConflict("IO_FAILURE", "receipt path is not a regular file", { path });
    }
    const temp = join(stateDir, `receipt.json.${uuid()}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(temp, "wx", RECEIPT_MODE);
      writeSync(fd, JSON.stringify(parsed, null, 2) + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, path);
      fsyncDirectory(stateDir, platform);
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closing on failure path
        }
      }
      rmSync(temp, { force: true });
      if (error instanceof OperationConflict) throw error;
      throw new OperationConflict(
        "IO_FAILURE",
        `receipt write failed: ${(error as Error).message}`,
        { path },
      );
    }
  }

  return { receiptPath, read, write };
}

/** Build the first receipt for a target; revision 0, INACTIVE, empty history. */
export function emptyReceipt(input: {
  hostId: string;
  canonicalHome: string;
  stableRoot: string;
  now: string;
}): ReceiptValue {
  return {
    schemaVersion: 1,
    pluginId: "paseo-slp",
    target: { hostId: input.hostId, daemonHome: input.canonicalHome },
    stableRoot: input.stableRoot,
    revision: 0,
    state: "INACTIVE",
    createdAt: input.now,
    updatedAt: input.now,
    binding: null,
    lastDeactivatedBindingSha256: null,
    activeOperationId: null,
    retained: [],
    operations: [],
  };
}

export function findOperation(receipt: ReceiptValue, operationId: string): IntentValue | undefined {
  return receipt.operations.find(op => op.operationId === operationId);
}

export function pendingOperation(receipt: ReceiptValue): IntentValue | undefined {
  return receipt.operations.find(op => op.outcome === "pending");
}
