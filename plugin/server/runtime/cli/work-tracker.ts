import type { Environment } from './types.ts';
import type { RuntimeError } from './types.ts';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { WORK_TRACKER_FILE as settingFile, findBd, parseBdVersion, readWorkTrackerSetting as readSetting, summarize } from "../work-tracker.ts";
export { findBd } from "../work-tracker.ts";

// Beads (`bd`) work-tracker detection and the session-entry pointer.
// Detect, never install (spec §2): nothing here downloads, installs,
// initializes, upgrades or configures beads — no `bd init`, `bd setup`,
// `bd hooks install`, `bd sync`/`bd dolt push`, and no edits to beads config.
// A missing or broken tracker is a gap carried in the result, never a thrown
// error and never a spawn blocker (spec §3.6).
//
// The CLI names the setting relative to a daemon home and keeps its historical
// { enabled, error } result. The plugin's stable-root reader also exposes configured.
export const WORK_TRACKER_FILE = `slp-runtime/${settingFile.replaceAll('\\', '/')}`;

export function readWorkTrackerSetting(daemonHome: string) {
  const { enabled, error } = readSetting(join(daemonHome, 'slp-runtime'));
  return { enabled, error };
}

// The probe runs only read-only bd commands: `bd version`, then `bd where
// --json` in the target repository — 5 s timeout, 64 KiB cap, telemetry off
// (forced: the probe env always carries BD_DISABLE_METRICS=1). `run` is the
// test seam; production uses execFileSync. Every bd-side failure lands in
// gaps and a non-ready state — the function only throws on non-ENOENT
// filesystem errors while reading the setting file (same rule as the
// communication-language reader).
export function probeWorkTracker(repository: string, { daemonHome = null, env = process.env, run = defaultRun }: { daemonHome?: string | null; env?: Environment; run?: (file: string, args: string[], options: { env: Environment; cwd: string }) => string } = {}) {
  const result: { tracker: string; repository: string; enabled: boolean | null; state: 'unavailable' | 'ready' | 'uninitialized'; bd: { path: string; version: string | null } | null; workspace: { path: string | null; prefix: string | null; redirectedFrom: string | null } | null; gaps: string[] } = {
    tracker: 'beads',
    repository,
    enabled: null,
    state: 'unavailable',
    bd: null,
    workspace: null,
    gaps: [],
  };
  if (daemonHome !== null) {
    const setting = readWorkTrackerSetting(daemonHome);
    result.enabled = setting.enabled;
    if (setting.error !== null) result.gaps.push(`tracker setting unreadable — ${setting.error}`);
  }
  let isRepoDir = false;
  try {
    isRepoDir = statSync(repository).isDirectory();
  } catch { /* reported below as a gap, not a crash */ }
  if (!isRepoDir) {
    result.gaps.push(`repository is not a directory: ${repository}`);
    return result;
  }
  const path = findBd(env);
  if (path === null) {
    result.gaps.push('bd not found on PATH — install is a Human action (brew install beads, npm i -g @beads/bd, or the upstream install.sh)');
    return result;
  }
  result.bd = { path, version: null };
  const runEnv = { ...env, BD_DISABLE_METRICS: '1' };
  try {
    const output = run(path, ['version'], { env: runEnv, cwd: repository });
    result.bd.version = parseBdVersion(output);
    if (result.bd.version === null) result.gaps.push(`bd version output unrecognized: ${summarize(output)}`);
  } catch (error) {
    result.gaps.push(`bd version failed: ${summarize((error as RuntimeError).message)}`);
    return result;
  }
  try {
    const parsed = JSON.parse(run(path, ['where', '--json'], { env: runEnv, cwd: repository }));
    // Verified on bd 1.3.0: `bd where --json` emits snake_case keys
    // (path/prefix/redirected_from, plus database_path and schema_version
    // the workspace record does not carry). PascalCase stays as a fallback
    // for builds emitting the spec's older casing; missing keys degrade to
    // null fields instead of a thrown probe.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    const field = (snake: string, pascal: string) =>
      typeof parsed[snake] === 'string' ? parsed[snake]
      : typeof parsed[pascal] === 'string' ? parsed[pascal]
      : null;
    result.workspace = {
      path: field('path', 'Path'),
      prefix: field('prefix', 'Prefix'),
      redirectedFrom: field('redirected_from', 'RedirectedFrom'),
    };
    result.state = 'ready';
  } catch (error) {
    result.state = 'uninitialized';
    result.gaps.push(`bd where failed — repository is not a beads workspace: ${summarize((error as RuntimeError).message)}`);
  }
  return result;
}

// execFileSync with the probe's fixed bounds — the only side effect is
// spawning the read-only command; a nonzero exit, timeout or oversized output
// throws and lands in gaps.
const defaultRun = (file: string, args: string[], { env, cwd }: { env: Environment; cwd: string }) => execFileSync(file, args, {
  env,
  cwd,
  encoding: 'utf8',
  timeout: 5000,
  maxBuffer: 64 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

// The session-entry pointer appended between communication-language and the
// assignment line in managed entry() renders. Disabled (absent or valid-off
// file) emits nothing at all — the disabled render is byte-identical to the
// pre-feature one. An unreadable/foreign setting emits one gap line; the seat
// records the gap and works on without the tracker. Enabled emits one line:
// the self-gated reference to read, and the probe command with the explicit
// daemon home (unavailable/uninitialized is a gap to record, never a block).
export function workTrackerBlock(daemonHome: string, { cli, policyDir, shq }: { cli: string; policyDir: string; shq: (value: string) => string }) {
  const setting = readWorkTrackerSetting(daemonHome);
  if (setting.error !== null) {
    return `Work tracker: setting unreadable — ${setting.error}; continuing without the tracker, record this gap.\n`;
  }
  if (!setting.enabled) return '';
  return `Work tracker: beads (enabled in SLP settings) — read ${join(policyDir, 'references', 'work-tracking.md')} before tracked work; ` +
    `run ${cli} tracker <repository> --paseo-home ${shq(daemonHome)} first and treat an unavailable or uninitialized state as a recorded gap to continue without the tracker.\n`;
}
