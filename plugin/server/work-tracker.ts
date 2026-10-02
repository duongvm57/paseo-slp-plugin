// Work-tracker RPCs and the hook-only seat env overlay. Shared runtime owns
// reading, PATH selection and version diagnostics; writes remain plugin-owned.
// The CLI adapter resolves a daemon home and omits the configured view field.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  GetWorkTrackerInput,
  OperationConflict,
  SetWorkTrackerInput,
  type GetWorkTrackerResult,
  type SetWorkTrackerResult,
  type WorkTrackerViewValue,
} from "../shared/contracts.ts";
import { resolveDaemonHome } from "./daemon-home.ts";
import { writePrivate } from "./state-store.ts";
import { WORK_TRACKER_FILE, findBd, parseBdVersion, readWorkTrackerSetting, summarize } from "./runtime/work-tracker.ts";
export { WORK_TRACKER_FILE, findBd, readWorkTrackerSetting, type WorkTrackerSetting } from "./runtime/work-tracker.ts";

export type BdRun = (file: string, args: string[], options: { env: Record<string, string | undefined> }) => string;

// execFileSync with the probe's fixed bounds — the only side effect is
// spawning the read-only command; a nonzero exit, timeout or oversized output
// throws and lands in bdError.
const defaultRun: BdRun = (file, args, { env }) => execFileSync(file, args, {
  env: env as NodeJS.ProcessEnv,
  encoding: "utf8",
  timeout: 5000,
  maxBuffer: 64 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});

export interface BdDetection {
  bd: { path: string; version: string | null } | null;
  bdError: string | null;
}

// `bd` on the plugin process PATH (= the daemon's PATH) — local exec, no
// network, 5 s timeout, telemetry forced off. Every failure is evidence in
// bdError; the RPC itself never fails on detection.
export function detectBd(
  env: Record<string, string | undefined> = process.env,
  run: BdRun = defaultRun,
): BdDetection {
  const path = findBd(env);
  if (path === null) {
    return { bd: null, bdError: "bd not found on PATH — install is a Human action (brew install beads, npm i -g @beads/bd, or the upstream install.sh)" };
  }
  const runEnv = { ...env, BD_DISABLE_METRICS: "1" };
  try {
    const output = run(path, ["version"], { env: runEnv });
    const version = parseBdVersion(output);
    if (version === null) {
      return { bd: { path, version: null }, bdError: `bd version output unrecognized: ${summarize(output)}` };
    }
    return { bd: { path, version }, bdError: null };
  } catch (error) {
    return { bd: { path, version: null }, bdError: `bd version failed: ${summarize((error as Error).message)}` };
  }
}

// Seat env overlay for hook-family providers (spec §6.3). BEADS_ACTOR is
// always SLP's per-seat identity — a daemon-wide or user-set actor would
// erase attribution in bd history. BD_AGENT_PROFILE and BD_DISABLE_METRICS
// are defaults only: an explicit Human-set env wins.
export function beadsSeatEnv(
  { role, agentId, env = {} }: { role: string; agentId: string; env?: Record<string, string | undefined> },
): Record<string, string> {
  const overlay: Record<string, string> = { BEADS_ACTOR: `slp-${role}-${agentId}` };
  if (env.BD_AGENT_PROFILE === undefined) overlay.BD_AGENT_PROFILE = "conservative";
  if (env.BD_DISABLE_METRICS === undefined) overlay.BD_DISABLE_METRICS = "1";
  return overlay;
}

// The session-open dep: true only when a valid setting file enables the
// tracker. Read errors propagate to the caller — sessionOpen converts any
// throw into "disabled" so an unreadable file never aborts an agent open.
export function readWorkTrackerEnabled(stableRoot: string): boolean {
  return readWorkTrackerSetting(stableRoot).enabled;
}

export interface WorkTrackerDeps {
  uuid?: () => string;
  env?: Record<string, string | undefined>;
  run?: BdRun;
}

export function createWorkTracker(deps: WorkTrackerDeps = {}) {
  const uuid = deps.uuid ?? randomUUID;
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const resolveHome = (target: { hostId: string; daemonHome: string }) =>
    resolveDaemonHome(target, "daemon home lacks a readable regular config.json");

  function view(stableRoot: string): WorkTrackerViewValue {
    const setting = readWorkTrackerSetting(stableRoot);
    const { bd, bdError } = detectBd(env, run);
    return {
      configured: setting.configured,
      enabled: setting.enabled,
      error: setting.error,
      bd,
      bdError,
    };
  }

  async function getWorkTracker(input: unknown): Promise<GetWorkTrackerResult> {
    const parsed = GetWorkTrackerInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `invalid get-work-tracker input: ${parsed.error.issues[0]?.message ?? "schema"}`,
      );
    }
    const ctx = resolveHome(parsed.data.target);
    return { schemaVersion: 1, workTracker: view(ctx.stableRoot) };
  }

  // Sole writer of work-tracker.json — atomic 0600 whole-file write, same
  // class as set-role-routing. The response re-reads the file and re-probes
  // `bd` so the returned view is post-write reality, not the request echo.
  async function setWorkTracker(input: unknown): Promise<SetWorkTrackerResult> {
    const parsed = SetWorkTrackerInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `invalid set-work-tracker input: ${parsed.error.issues[0]?.message ?? "schema"}`,
      );
    }
    const ctx = resolveHome(parsed.data.target);
    const bytes = `${JSON.stringify({ schemaVersion: 1, tracker: "beads", enabled: parsed.data.enabled }, null, 2)}\n`;
    writePrivate(ctx.stableRoot, WORK_TRACKER_FILE, bytes, uuid);
    return { schemaVersion: 1, workTracker: view(ctx.stableRoot) };
  }

  return { getWorkTracker, setWorkTracker };
}
