// Git/fs mechanics for the task-execution adapter: BASE→RESULT deltas,
// three-way conflict evaluation, isolated stage materialization, backup,
// verified apply and byte-restore. Pure functions over measured entry
// maps plus guarded fs effects — no ledger or Core imports; the
// orchestrator feeds pins and records outcomes.

import { createHash } from "node:crypto";
import { canonicalJson } from "./config-view.ts";
import { DeskTaskIntegrationCleanupInventoryEntry } from "../shared/enforcement.ts";
import type { DeskTaskIntegrationCleanupInventoryEntryValue } from "../shared/enforcement.ts";
import { join, normalize, sep } from "node:path";
import type {
  RepoEntry, RepositoryMeasure, TaskFsIo, TaskGitIo,
} from "./desk-task-execution-host.ts";

const sha256Hex = (bytes: string | NodeJS.ArrayBufferView) =>
  createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// Limits — every materialize/apply path is bounded; a violation is a typed
// rejection, never a partial clip.
// ---------------------------------------------------------------------------

export type TaskIoLimits = {
  maxDeltaPaths: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxStageEntries: number;
};

export const DEFAULT_IO_LIMITS: TaskIoLimits = {
  maxDeltaPaths: 512,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxStageEntries: 4096,
};

// ---------------------------------------------------------------------------
// Entry maps + delta — measured truth drives every comparison. A
// `deleted:true` entry means tracked-at-measure, absent-on-disk; it is
// normalised to "absent" for comparisons but retained for apply semantics.
// ---------------------------------------------------------------------------

type PresentEntry = Extract<RepoEntry, { kind: string }>;
type EntryMap = Map<string, RepoEntry>;

export const entryMap = (measure: RepositoryMeasure): EntryMap =>
  new Map(measure.entries.map(entry => [entry.path, entry]));

const entryKey = (entry: RepoEntry | undefined): string | null => {
  if (entry === undefined || "deleted" in entry) return null;
  if (entry.kind === "gitlink") return `gitlink:${entry.indexOid ?? "none"}:${entry.state}`;
  return `${entry.kind}:${entry.sha256}:${entry.mode}`;
};

export const entriesEqual = (a: RepoEntry | undefined, b: RepoEntry | undefined): boolean =>
  entryKey(a) === entryKey(b);

export type DeltaEntry = {
  path: string;
  op: "add" | "modify" | "delete";
  kind: "file" | "symlink";
  sha256: string | null;
  mode: number | null;
};

export type Delta = {
  entries: DeltaEntry[];
  digest: string;
  changedPaths: string[];
};

/** BASE → RESULT over the measured entry maps. Unsupported shapes surface
 *  separately via scanUnsupported — delta carries file/symlink only. */
export function computeDelta(base: RepositoryMeasure, result: RepositoryMeasure): Delta {
  const baseMap = entryMap(base);
  const resultMap = entryMap(result);
  const entries: DeltaEntry[] = [];
  const paths = new Set([...baseMap.keys(), ...resultMap.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseMap.get(path);
    const after = resultMap.get(path);
    const beforeKey = entryKey(before);
    const afterKey = entryKey(after);
    if (beforeKey === afterKey) continue;
    if (after !== undefined && !("deleted" in after) && after.kind === "gitlink") continue; // flagged by scanUnsupported
    if (beforeKey === null && afterKey !== null && after !== undefined && "kind" in after) {
      entries.push({
        path, op: "add", kind: after.kind === "symlink" ? "symlink" : "file",
        sha256: after.sha256, mode: after.mode,
      });
      continue;
    }
    if (afterKey === null) {
      entries.push({ path, op: "delete", kind: before !== undefined && "kind" in before && before.kind === "symlink" ? "symlink" : "file", sha256: null, mode: null });
      continue;
    }
    if (after !== undefined && "kind" in after) {
      entries.push({
        path, op: "modify", kind: after.kind === "symlink" ? "symlink" : "file",
        sha256: after.sha256, mode: after.mode,
      });
    }
  }
  const canonical = entries.map(e => `${e.op}:${e.kind}:${e.path}:${e.sha256 ?? "-"}:${e.mode ?? "-"}`).join("\n");
  return { entries, digest: sha256Hex(canonical), changedPaths: entries.map(e => e.path) };
}

// ---------------------------------------------------------------------------
// Grant confinement + unsupported shapes.
// ---------------------------------------------------------------------------

const normalizeRel = (path: string): string | null => {
  const normalized = normalize(path).replaceAll(sep, "/");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    return null;
  }
  return normalized;
};

/** Delta paths must sit inside the granted path set (exact match or
 *  directory prefix). Violations name the offending paths — bounded. */
export function constrainDelta(
  delta: Delta, grantedPaths: string[], limits: Pick<TaskIoLimits, "maxDeltaPaths"> = DEFAULT_IO_LIMITS,
): { ok: true; delta: Delta } | { ok: false; code: "DELTA_CAP" | "OUT_OF_GRANT"; paths: string[] } {
  if (delta.entries.length > limits.maxDeltaPaths) {
    return { ok: false, code: "DELTA_CAP", paths: delta.changedPaths.slice(0, limits.maxDeltaPaths) };
  }
  const grants = grantedPaths.map(normalizeRel).filter((g): g is string => g !== null);
  const violations: string[] = [];
  for (const entry of delta.entries) {
    const rel = normalizeRel(entry.path);
    const granted = rel !== null && grants.some(g => rel === g || rel.startsWith(`${g}/`));
    if (!granted) violations.push(entry.path);
    if (violations.length > 32) break;
  }
  return violations.length === 0
    ? { ok: true, delta }
    : { ok: false, code: "OUT_OF_GRANT", paths: violations };
}

/** File modes, deletions and symlinks are preserved; anything else —
 *  gitlinks, submodules, device nodes — is a typed rejection. */
export function scanUnsupported(
  measures: { label: string; measure: RepositoryMeasure }[],
): { path: string; label: string; shape: string }[] {
  const unsupported: { path: string; label: string; shape: string }[] = [];
  for (const { label, measure } of measures) {
    for (const entry of measure.entries) {
      if ("deleted" in entry) continue;
      if (entry.kind === "gitlink") {
        unsupported.push({ path: entry.path, label, shape: `gitlink:${entry.state}` });
      }
    }
  }
  return unsupported;
}

// ---------------------------------------------------------------------------
// Three-way evaluation — per path: baseEntry vs resultEntry vs freshTarget.
// ---------------------------------------------------------------------------

export type ThreeWayPlan = {
  apply: DeltaEntry[];
  noop: string[];
  conflicts: { path: string; reason: "target-modified" | "delete-vs-modify" | "add-vs-add" }[];
};

export function threeWay(base: RepositoryMeasure, result: RepositoryMeasure, target: RepositoryMeasure, delta: Delta): ThreeWayPlan {
  const baseMap = entryMap(base);
  const resultMap = entryMap(result);
  const targetMap = entryMap(target);
  const plan: ThreeWayPlan = { apply: [], noop: [], conflicts: [] };
  for (const entry of delta.entries) {
    const baseEntry = baseMap.get(entry.path);
    const resultEntry = resultMap.get(entry.path);
    const targetEntry = targetMap.get(entry.path);
    const targetPresent = entryKey(targetEntry) !== null;
    if (entry.op === "delete") {
      if (!targetPresent) { plan.noop.push(entry.path); continue; }
      if (entriesEqual(targetEntry, baseEntry)) { plan.apply.push(entry); continue; }
      if (entriesEqual(targetEntry, resultEntry)) { plan.apply.push(entry); continue; }
      plan.conflicts.push({ path: entry.path, reason: "delete-vs-modify" });
      continue;
    }
    if (entry.op === "add") {
      if (!targetPresent) { plan.apply.push(entry); continue; }
      if (entriesEqual(targetEntry, resultEntry)) { plan.noop.push(entry.path); continue; }
      plan.conflicts.push({ path: entry.path, reason: "add-vs-add" });
      continue;
    }
    // modify
    if (entriesEqual(targetEntry, baseEntry)) { plan.apply.push(entry); continue; }
    if (entriesEqual(targetEntry, resultEntry)) { plan.noop.push(entry.path); continue; }
    plan.conflicts.push({ path: entry.path, reason: "target-modified" });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Stage materialization — copy targetBase content then delta ops, all
// inside owned scratch. Never writes the real target.
// ---------------------------------------------------------------------------

const writeEntry = (fs: TaskFsIo, dstRoot: string, entry: DeltaEntry, srcRoot: string): void => {
  const dst = join(dstRoot, entry.path);
  if (entry.op === "delete") {
    try { fs.unlink(dst); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  const src = join(srcRoot, entry.path);
  if (entry.kind === "symlink") {
    const target = fs.readlink(src);
    try { fs.unlink(dst); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fs.symlink(target, dst);
    return;
  }
  fs.copyFile(src, dst, entry.mode ?? 0o644);
};

const copyMeasured = (fs: TaskFsIo, srcRoot: string, dstRoot: string, entry: RepoEntry, limits: TaskIoLimits, spent: { bytes: number }): void => {
  const dst = join(dstRoot, entry.path);
  if ("deleted" in entry || entry.kind === "gitlink") return;
  if (entry.kind === "symlink") {
    const target = fs.readlink(join(srcRoot, entry.path));
    try { fs.unlink(dst); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fs.symlink(target, dst);
    return;
  }
  const st = fs.lstat(join(srcRoot, entry.path));
  void st;
  const bytes = fs.readFile(join(srcRoot, entry.path));
  spent.bytes += bytes.byteLength;
  if (bytes.byteLength > limits.maxFileBytes) throw new Error(`IO_CAP: ${entry.path} exceeds ${limits.maxFileBytes} bytes`);
  if (spent.bytes > limits.maxTotalBytes) throw new Error(`IO_CAP: materialization exceeds ${limits.maxTotalBytes} bytes`);
  fs.writeFile(dst, bytes, entry.mode);
};

/** Materialize a staged candidate: every targetBase entry (prior dirty
 *  work included) plus the delta ops from the source checkout. For a
 *  git-worktree stage the worktree's checked-out index paths not present
 *  in targetBase are removed first (target truth wins). */
export function materializeStage(deps: {
  fs: TaskFsIo;
  stageRoot: string;
  stageKind: "git-worktree" | "content-dir";
  worktreePaths?: string[];
  targetRoot: string;
  targetBase: RepositoryMeasure;
  sourceRoot: string;
  delta: Delta;
  limits?: TaskIoLimits;
}): { materialized: number; deleted: number } {
  const limits = deps.limits ?? DEFAULT_IO_LIMITS;
  const spent = { bytes: 0 };
  const baseMap = entryMap(deps.targetBase);
  let materialized = 0;
  let deleted = 0;
  if (deps.stageKind === "git-worktree" && deps.worktreePaths !== undefined) {
    for (const path of deps.worktreePaths) {
      const normalized = path.replace(/\/+$/, "");
      if (!baseMap.has(normalized)) {
        const abs = join(deps.stageRoot, normalized);
        try { deps.fs.rmrf(abs); deleted += 1; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  } else {
    deps.fs.ensureEmptyDir(deps.stageRoot);
  }
  for (const entry of deps.targetBase.entries) {
    if ("deleted" in entry) {
      // Target truth: absent at measure ⇒ absent in stage (worktree only).
      if (deps.stageKind === "git-worktree") {
        try { deps.fs.rmrf(join(deps.stageRoot, entry.path)); deleted += 1; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      continue;
    }
    if (materialized >= limits.maxStageEntries) throw new Error(`IO_CAP: stage exceeds ${limits.maxStageEntries} entries`);
    copyMeasured(deps.fs, deps.targetRoot, deps.stageRoot, entry, limits, spent);
    materialized += 1;
  }
  for (const entry of deps.delta.entries) {
    writeEntry(deps.fs, deps.stageRoot, entry, deps.sourceRoot);
  }
  return { materialized, deleted };
}

/** Expected stage content map — the oracle the staged measure is compared
 *  against: targetBase entries minus delta-deleted, delta ops applied. */
export function expectedStageMap(targetBase: RepositoryMeasure, delta: Delta): Map<string, string> {
  const expected = new Map<string, string>();
  for (const entry of targetBase.entries) {
    const key = entryKey(entry);
    if (key !== null) expected.set(entry.path, key);
  }
  for (const entry of delta.entries) {
    if (entry.op === "delete") expected.delete(entry.path);
    else expected.set(entry.path, `${entry.kind}:${entry.sha256}:${entry.mode}`);
  }
  return expected;
}

/** Compare a fresh stage measure to the expected map. Content-map measures
 *  never carry `deleted` tombstones; git-snapshot measures may — a tracked
 *  path deleted in stage legitimately reads absent, so absent ≡ deleted. */
export function stageMatches(stage: RepositoryMeasure, expected: Map<string, string>): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const seen = new Set<string>();
  for (const entry of stage.entries) {
    const key = entryKey(entry);
    if (key === null) continue;
    seen.add(entry.path);
    const want = expected.get(entry.path);
    if (want === undefined) { mismatches.push(`unexpected:${entry.path}`); continue; }
    if (want !== key) mismatches.push(`mismatch:${entry.path}`);
  }
  for (const path of expected.keys()) {
    if (!seen.has(path)) mismatches.push(`missing:${path}`);
  }
  return { ok: mismatches.length === 0, mismatches: mismatches.slice(0, 32) };
}

/** Read a complete bounded resource inventory, including ignored content
 * and Git pointer files. This IO helper returns canonical bytes; Core's
 * authoritative inferred inventory schema parses the bytes at the observer.
 * No links are followed, and file sizes are refused before byte reads. */
export function collectCleanupInventoryBytes(
  fs: TaskFsIo, root: string, limits: TaskIoLimits = DEFAULT_IO_LIMITS,
): Buffer {
  const entries = new Map<string, DeskTaskIntegrationCleanupInventoryEntryValue>();
  let contentBytes = 0;
  const visit = (path: string): void => {
    if (entries.size >= limits.maxStageEntries) throw new Error("INVENTORY_CAP: entry count");
    const full = path === "." ? root : join(root, path);
    const st = fs.lstat(full);
    if (st.isSymlink || st.isFile) {
      if (path === ".") throw new Error("INVENTORY_UNSUPPORTED: resource root must be a directory");
      if (st.bytes > limits.maxFileBytes) throw new Error("INVENTORY_CAP: file bytes");
      const bytes = st.isSymlink ? Buffer.from(fs.readlink(full)) : fs.readFile(full);
      if (bytes.byteLength > limits.maxFileBytes || bytes.byteLength !== st.bytes) throw new Error("INVENTORY_DRIFT: changed byte size");
      contentBytes += bytes.byteLength;
      if (contentBytes > limits.maxTotalBytes) throw new Error("INVENTORY_CAP: total content bytes");
      const after = fs.lstat(full);
      if (after.isFile !== st.isFile || after.isSymlink !== st.isSymlink || after.mode !== st.mode || after.bytes !== st.bytes) throw new Error("INVENTORY_DRIFT: changed entry identity");
      entries.set(path, DeskTaskIntegrationCleanupInventoryEntry.parse({path, kind: st.isSymlink ? "symlink" : "file", bytes: bytes.byteLength, sha256: sha256Hex(bytes), mode: st.mode}));
      return;
    }
    if (!st.isDirectory) throw new Error("INVENTORY_UNSUPPORTED: unsupported entry shape");
    entries.set(path, DeskTaskIntegrationCleanupInventoryEntry.parse({path, kind: "directory", bytes: 0, sha256: null, mode: st.mode}));
    const children = fs.listDirectory(full);
    const unique = new Set(children);
    if (children.length !== unique.size || children.some(name => name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0"))) throw new Error("INVENTORY_UNSUPPORTED: unsafe directory listing");
    for (const name of children.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) visit(path === "." ? name : `${path}/${name}`);
    const after = fs.lstat(full);
    const afterChildren = fs.listDirectory(full).sort();
    if (!after.isDirectory || after.isSymlink || after.mode !== st.mode || JSON.stringify(afterChildren) !== JSON.stringify([...children].sort())) throw new Error("INVENTORY_DRIFT: changed directory");
  };
  visit(".");
  const ordered = [...entries].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const bytes = Buffer.from(canonicalJson(ordered.map(([, entry]) => entry)));
  if (bytes.byteLength > limits.maxTotalBytes) throw new Error("INVENTORY_CAP: artifact bytes");
  return bytes;
}

/** Retained content proof distinguishes actual filesystem permission bits
 * from Git reference executable classes. Expected maps are expectations,
 * never measurements of a future checkout. */
export const recoveryMapSha256 = (map: Map<string, string>): string => sha256Hex(
  [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([p, v]) => `${p}=${v}`).join("\n"));

export function recoveryMapBytes(measure: RepositoryMeasure, map = expectedStageMap(measure, {entries: [], changedPaths: [], digest: ""})): Buffer {
  if (measure.kind === "git-reference" || measure.incomplete.length > 0 || scanUnsupported([{label: "map", measure}]).length > 0) throw new Error("RECOVERY_MAP_UNSUPPORTED");
  return Buffer.from(JSON.stringify({version: 1, modeSemantics: "actual-filesystem-bits", root: measure.root, head: measure.head,
    entries: [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)}));
}

export function parseRecoveryMap(bytes: Buffer): {root: string; head: string | null; map: Map<string, string>} {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("RECOVERY_MAP_INVALID");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "entries,head,modeSemantics,root,version" || v.version !== 1 || v.modeSemantics !== "actual-filesystem-bits"
    || typeof v.root !== "string" || !(v.head === null || typeof v.head === "string") || !Array.isArray(v.entries) || v.entries.length > DEFAULT_IO_LIMITS.maxStageEntries) throw new Error("RECOVERY_MAP_INVALID");
  const map = new Map<string, string>();
  for (const item of v.entries) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || normalizeRel(item[0]) !== item[0] || item[0] === "." || map.has(item[0])
      || typeof item[1] !== "string" || !/^(file|symlink):[a-f0-9]{64}:[0-9]+$/.test(item[1]) || Number(item[1].split(":")[2]) > 0o777) throw new Error("RECOVERY_MAP_INVALID");
    map.set(item[0], item[1]);
  }
  return {root: v.root, head: v.head, map};
}

// ---------------------------------------------------------------------------
// Backup + apply + restore — the only path that writes the real target.
// ---------------------------------------------------------------------------

export type BackupEntry = {
  path: string;
  existed: boolean;
  kind: "file" | "symlink" | null;
  blobKey: string | null;
  sha256: string | null;
  bytes: number | null;
  /** Original target permissions; blobs separately always use private 0600. */
  mode: number | null;
  blobMode: 384 | null;
};

/** Read-only plan: canonical ordinal keys are injective independently of
 * source path and kind. Its exact bytes can be admitted before backup IO. */
export function planBackupDeltaPaths(deps: {
  fs: TaskFsIo; targetRoot: string; delta: Delta; limits?: TaskIoLimits;
}): BackupEntry[] {
  const limits = deps.limits ?? DEFAULT_IO_LIMITS;
  if (deps.delta.entries.length > limits.maxDeltaPaths) throw new Error("IO_CAP: backup paths");
  const manifest: BackupEntry[] = [];
  let spent = 0;
  const seen = new Set<string>();
  for (const entry of [...deps.delta.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (normalizeRel(entry.path) !== entry.path || entry.path === "." || seen.has(entry.path)) throw new Error("BACKUP_INVALID_PATH");
    seen.add(entry.path);
    const src = join(deps.targetRoot, entry.path);
    if (!deps.fs.exists(src)) {
      manifest.push({path: entry.path, existed: false, kind: null, blobKey: null, sha256: null, bytes: null, mode: null, blobMode: null});
      continue;
    }
    const st = deps.fs.lstat(src);
    if (!st.isSymlink && !st.isFile) throw new Error(`BACKUP_UNSUPPORTED: ${entry.path}`);
    const bytes = st.isSymlink ? Buffer.from(deps.fs.readlink(src)) : deps.fs.readFile(src);
    spent += bytes.byteLength;
    if (bytes.byteLength > limits.maxFileBytes || spent > limits.maxTotalBytes) throw new Error("IO_CAP: backup bytes");
    manifest.push({path: entry.path, existed: true, kind: st.isSymlink ? "symlink" : "file",
      blobKey: `blobs/${manifest.length.toString().padStart(8, "0")}`, sha256: sha256Hex(bytes), bytes: bytes.byteLength, mode: st.mode, blobMode: 384});
  }
  return manifest;
}

export function backupManifestBytes(entries: BackupEntry[]): Buffer {
  return Buffer.from(JSON.stringify({version: 1, modeSemantics: "actual-filesystem-bits", entries}));
}

/** Validate the entire manifest and ALL blobs before any apply/restore. */
export function verifyBackupIntegrity(deps: {
  fs: TaskFsIo; backupDir: string; manifest: BackupEntry[]; limits?: TaskIoLimits;
}): Map<string, Buffer> {
  const limits = deps.limits ?? DEFAULT_IO_LIMITS;
  if (deps.manifest.length > limits.maxDeltaPaths) throw new Error("BACKUP_INTEGRITY: paths cap");
  const buffers = new Map<string, Buffer>();
  const seen = new Set<string>();
  let spent = 0;
  for (const [index, entry] of deps.manifest.entries()) {
    if (entry === null || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "blobKey,blobMode,bytes,existed,kind,mode,path,sha256" || typeof entry.path !== "string" || typeof entry.existed !== "boolean") throw new Error("BACKUP_INTEGRITY: manifest shape");
    if (normalizeRel(entry.path) !== entry.path || entry.path === "." || seen.has(entry.path)) throw new Error("BACKUP_INTEGRITY: invalid path");
    seen.add(entry.path);
    if (!entry.existed) {
      if ([entry.kind, entry.blobKey, entry.sha256, entry.bytes, entry.mode, entry.blobMode].some(v => v !== null)) throw new Error("BACKUP_INTEGRITY: invalid absent entry");
      continue;
    }
    if (!["file", "symlink"].includes(entry.kind ?? "") || entry.blobKey !== `blobs/${index.toString().padStart(8, "0")}`
      || !Number.isInteger(entry.mode) || entry.mode! < 0 || entry.mode! > 0o777 || entry.blobMode !== 0o600) throw new Error("BACKUP_INTEGRITY: invalid manifest");
    const path = join(deps.backupDir, entry.blobKey);
    const st = deps.fs.lstat(path);
    if (!st.isFile || st.isSymlink || st.mode !== entry.blobMode) throw new Error("BACKUP_INTEGRITY: blob kind/mode");
    const bytes = deps.fs.readFile(path);
    spent += bytes.byteLength;
    if (bytes.byteLength > limits.maxFileBytes || spent > limits.maxTotalBytes || bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256) throw new Error("BACKUP_INTEGRITY: blob bytes/hash");
    buffers.set(entry.path, bytes);
  }
  return buffers;
}

export function backupDeltaPaths(deps: {
  fs: TaskFsIo; targetRoot: string; backupDir: string; delta: Delta;
  limits?: TaskIoLimits; planned?: BackupEntry[];
}): BackupEntry[] {
  const manifest = planBackupDeltaPaths(deps);
  if (deps.planned !== undefined && !backupManifestBytes(manifest).equals(backupManifestBytes(deps.planned))) throw new Error("BACKUP_INTEGRITY: target changed after admission");
  for (const entry of manifest) {
    if (!entry.existed || entry.blobKey === null) continue;
    const src = join(deps.targetRoot, entry.path);
    const bytes = entry.kind === "symlink" ? Buffer.from(deps.fs.readlink(src)) : deps.fs.readFile(src);
    if (sha256Hex(bytes) !== entry.sha256 || bytes.byteLength !== entry.bytes) throw new Error("BACKUP_INTEGRITY: source changed");
    deps.fs.writeFile(join(deps.backupDir, entry.blobKey), bytes, 0o600);
  }
  verifyBackupIntegrity({...deps, manifest});
  return manifest;
}

/** Apply verified delta ops onto the real target — called only after the
 *  durable landing intent and the fresh three-way re-verify. */
export function applyDeltaToTarget(deps: {
  fs: TaskFsIo;
  targetRoot: string;
  sourceRoot: string;
  apply: DeltaEntry[];
}): { applied: string[] } {
  const applied: string[] = [];
  for (const entry of deps.apply) {
    writeEntry(deps.fs, deps.targetRoot, entry, deps.sourceRoot);
    applied.push(entry.path);
  }
  return { applied };
}

/** Explicit helper only: the orchestrator never auto-restores. Validate
 * every blob before the first target mutation, preserving original modes. */
export function restoreFromBackup(deps: {
  fs: TaskFsIo;
  targetRoot: string;
  backupDir: string;
  manifest: BackupEntry[];
}): { restored: string[] } {
  const buffers = verifyBackupIntegrity(deps);
  const restored: string[] = [];
  for (const entry of deps.manifest) {
    const dst = join(deps.targetRoot, entry.path);
    if (!entry.existed) {
      try { deps.fs.rmrf(dst); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      restored.push(entry.path);
      continue;
    }
    if (entry.kind === "symlink") {
      const target = buffers.get(entry.path)!.toString();
      try { deps.fs.rmrf(dst); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      deps.fs.symlink(target, dst);
      restored.push(entry.path);
      continue;
    }
    const bytes = buffers.get(entry.path)!;
    deps.fs.writeFile(dst, bytes, entry.mode!);
    restored.push(entry.path);
  }
  return { restored };
}

// ---------------------------------------------------------------------------
// Placement materialization — isolated seats get a desk-owned worktree of
// the repo; the worktree shares gitCommonDir ⇒ same desk binding.
// ---------------------------------------------------------------------------

export async function materializeIsolatedPlacement(deps: {
  fs: TaskFsIo;
  git: TaskGitIo;
  repoRoot: string;
  scratchDir: string;
  baseRef: string;
}): Promise<{ cwd: string; commonDir: string; head: string | null }> {
  const repoTop = await deps.git.top(deps.repoRoot);
  const commonDir = await deps.git.commonDir(deps.repoRoot);
  const head = await deps.git.revParse(repoTop, deps.baseRef);
  if (head === null) throw new Error(`PLACEMENT_BASE_UNRESOLVED: ${deps.baseRef}`);
  const scratch = deps.fs.ensureEmptyDir(deps.scratchDir);
  await deps.git.worktreeAdd(repoTop, scratch, head);
  const scratchCommon = await deps.git.commonDir(scratch);
  if (scratchCommon !== commonDir) {
    throw new Error(`PLACEMENT_DESK_MISMATCH: worktree resolved ${scratchCommon}, desk is ${commonDir}`);
  }
  return { cwd: scratch, commonDir, head };
}

export async function removeIsolatedPlacement(deps: {
  git: TaskGitIo;
  repoRoot: string;
  scratchDir: string;
}): Promise<void> {
  await deps.git.worktreeRemove(deps.repoRoot, deps.scratchDir, { force: true });
}

/** Desk-root layout for adapter-owned scratch — placements, staged
 *  candidates and backups live under the verified stable root. */
export const adapterPaths = (stableRoot: string, repoKey: string) => ({
  placements: (attemptId: string) => join(stableRoot, "task-exec", repoKey, "placements", attemptId),
  integration: (actionId: string) => join(stableRoot, "task-exec", repoKey, "integrations", actionId),
  stage: (actionId: string) => join(stableRoot, "task-exec", repoKey, "integrations", actionId, "stage"),
  backup: (actionId: string) => join(stableRoot, "task-exec", repoKey, "integrations", actionId, "backup"),
});
