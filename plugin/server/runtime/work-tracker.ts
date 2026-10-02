// Read-only work-tracker primitives shared by CLI probes and plugin RPCs.
// Adapters choose daemon-home/stable-root resolution, output shape and writes.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const WORK_TRACKER_FILE = join("state", "work-tracker.json");

// Keep the ordered schema checks and reason strings identical for both
// adapter views.
const schemaFail = (reason: string): string => `work-tracker.json failed schema validation: ${reason}`;

export interface WorkTrackerSetting {
  enabled: boolean;
  error: string | null;
  /** True only when a valid setting file exists on disk. */
  configured: boolean;
}

export function readWorkTrackerSetting(stableRoot: string): WorkTrackerSetting {
  let raw: string;
  try {
    raw = readFileSync(join(stableRoot, WORK_TRACKER_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { enabled: false, error: null, configured: false };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { enabled: false, error: `work-tracker.json is not valid JSON: ${(error as Error).message}`, configured: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { enabled: false, error: schemaFail("expected an object"), configured: false };
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return { enabled: false, error: schemaFail("expected schemaVersion 1"), configured: false };
  }
  if (record.tracker !== "beads") {
    return { enabled: false, error: schemaFail('expected tracker "beads"'), configured: false };
  }
  if (typeof record.enabled !== "boolean") {
    return { enabled: false, error: schemaFail("expected enabled to be a boolean"), configured: false };
  }
  const extra = Object.keys(record).filter(key => !["schemaVersion", "tracker", "enabled"].includes(key)).sort();
  if (extra.length > 0) {
    return { enabled: false, error: schemaFail(`unexpected keys: ${extra.join(", ")}`), configured: false };
  }
  return { enabled: record.enabled as boolean, error: null, configured: true };
}

// First executable `bd` on the given PATH, in order. Only absolute PATH
// entries are eligible — a relative entry would resolve against whatever cwd
// the probe happens to run in. On Windows the binary lands as bd.exe; plain
// `bd` is checked last there so an extensionless shim cannot shadow it.
export function findBd(env: Record<string, string | undefined> | null = process.env): string | null {
  const pathEnv = typeof env?.PATH === "string" ? env.PATH : "";
  const names = process.platform === "win32" ? ["bd.exe", "bd.cmd", "bd.bat", "bd"] : ["bd"];
  for (const entry of pathEnv.split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    for (const name of names) {
      const candidate = join(entry, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { /* not here — keep scanning */ }
    }
  }
  return null;
}

// `bd version` prints `bd version <semver> (…)` [verify]. Accept the exact
// documented shape first, then fall back to any semver-looking token so an
// upstream format tweak still yields a version instead of a gap.
const VERSION_LINE = /bd\s+version\s+(\S+)/;
const SEMVER_TOKEN = /(\d+\.\d+\.\d+[^\s]*)/;
export const parseBdVersion = (output: string): string | null =>
  VERSION_LINE.exec(output)?.[1] ?? SEMVER_TOKEN.exec(output)?.[1] ?? null;

export const summarize = (value: unknown, max = 160): string => {
  const text = String(value).replaceAll("\n", " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
