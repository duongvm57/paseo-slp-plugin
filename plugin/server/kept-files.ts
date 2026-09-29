// plugin/server/kept-files.ts — the shared filesystem primitives used by
// every durable store in this package (P2-a decision A5).
//
// journal.ts is the sole receipt-I/O owner; desk-store.ts is the sole
// enforcement-ledger owner. Both need the same four primitives — tolerant
// lstat, the real-directory guard, mode-0700 private directory creation and
// a directory fsync — so they live here exactly once. The helpers keep the
// semantics journal.ts has always had: assertRealDirectory throws
// RECOVERY_REQUIRED (callers that classify "unsafe path" as a read state
// instead build their own policy on lstatOrNull), and fsync/chmod policy is
// per-platform via the explicit `platform` argument.

import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { OperationConflict } from "../shared/contracts.ts";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function assertRealDirectory(path: string, what: string) {
  const stat = lstatOrNull(path);
  if (stat === null) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OperationConflict("RECOVERY_REQUIRED", `${what} is not a real directory: ${path}`, {
      path,
    });
  }
}

export function ensurePrivateDirectory(path: string, platform: string) {
  assertRealDirectory(path, "SLP state path");
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (platform !== "win32") {
    try {
      chmodSync(path, PRIVATE_DIR_MODE);
    } catch {
      // Permission bits are best-effort on unusual filesystems; the create
      // mode already requested privacy.
    }
  }
}

export function fsyncDirectory(path: string, platform: string) {
  if (platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
