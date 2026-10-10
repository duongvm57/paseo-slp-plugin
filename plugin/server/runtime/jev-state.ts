// Jev disk mechanics shared by the CLI and plugin adapters. This module owns
// locations, raw config observations and key-file interpretation, not the two
// config dialects: CLI has historical OFF/unknown-key tolerance; plugin uses
// its strict persisted/RPC schema. No read caches or network calls live here.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const JEV_CONFIG_FILE = join("state", "jev.json");
export const jevKeyFile = (kind: string): string => join("state", `jev-${kind}.key`);
export const jevConfigPath = (stableRoot: string): string => join(stableRoot, JEV_CONFIG_FILE);
export const jevKeyPath = (stableRoot: string, kind: string): string => join(stableRoot, jevKeyFile(kind));

/** Preserve the raw UTF-8 byte interpretation used for plugin CAS, including
 * invalid JSON. Filesystem errors remain exceptions for adapters to classify;
 * neither an unreadable file nor broken JSON is silently an OFF config. */
export function readJevConfigFile(stableRoot: string) {
  const raw = readFileSync(jevConfigPath(stableRoot), "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  try {
    return { ok: true as const, value: JSON.parse(raw) as unknown, sha256 };
  } catch (error) {
    return { ok: false as const, error: error as Error, sha256 };
  }
}

type KeyInspection = { ok: true; mode: number } | {
  ok: false;
  reason: "missing" | "unreadable" | "not-regular" | "permissions";
  mode?: number;
  error?: NodeJS.ErrnoException;
};
function inspectKey(file: string): KeyInspection {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) {
    const cause = error as NodeJS.ErrnoException;
    return { ok: false, reason: cause.code === "ENOENT" ? "missing" : "unreadable", error: cause };
  }
  if (!stat.isFile()) return { ok: false, reason: "not-regular" };
  const mode = stat.mode & 0o777;
  if ((stat.mode & 0o077) !== 0) return { ok: false, reason: "permissions", mode };
  return { ok: true, mode };
}

/** Presence-only: lstat, never key bytes. A regular but insecure file remains
 * present; missing, symlink, non-regular or stat failure reports no key. */
export function observeJevKey(stableRoot: string, kind: string): { hasKey: boolean; keyPermissionsOk: boolean | null } {
  const observed = inspectKey(jevKeyPath(stableRoot, kind));
  if (observed.ok) return { hasKey: true, keyPermissionsOk: true };
  return observed.reason === "permissions"
    ? { hasKey: true, keyPermissionsOk: false }
    : { hasKey: false, keyPermissionsOk: null };
}

export type JevKeyRead = { ok: true; key: string; valid: boolean } | {
  ok: false;
  reason: "missing" | "unreadable" | "not-regular" | "permissions";
  stage: "stat" | "read";
  mode?: number;
  error?: NodeJS.ErrnoException;
};
/** Secure-use sequence: refuse symlinks/non-private files BEFORE reading.
 * Whitespace interpretation is shared; adapters decide whether an invalid
 * token is a typed refusal (CLI/supervision) or the legacy auth probe. */
export function readJevKeyFile(stableRoot: string, kind: string): JevKeyRead {
  const file = jevKeyPath(stableRoot, kind);
  const observed = inspectKey(file);
  if (!observed.ok) return { ...observed, stage: "stat" };
  let key: string;
  try { key = readFileSync(file, "utf8").trim(); }
  catch (error) { return { ok: false, reason: "unreadable", stage: "read", error: error as NodeJS.ErrnoException }; }
  return { ok: true, key, valid: key.length > 0 && !/\s/.test(key) };
}
