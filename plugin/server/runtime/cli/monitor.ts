import type { PersistenceObservation } from './types.ts';
import type { DatabaseSync } from 'node:sqlite';
export interface MonitorRequest {
  paseoHome?: string;
  agents: {
    id: string;
    cwd?: string;
    scope?: string[];
  }[];
  thresholds?: Partial<{
    idleMinutes: number;
    churnScans: number;
    toolWindow: number;
    toolShare: number;
    cadenceEdits: number;
  }>;
  devinSessionsDb?: string;
  signals?: string[];
  stateFile?: string;
}
interface GitObservation {
  gap?: string;
  dirty?: string[];
  head?: string | null;
  committedAt?: string | null;
}
interface ToolCall {
  _meta?: Record<string, unknown>;
  kind?: unknown;
  title?: unknown;
  rawInput?: {
    file_path?: unknown;
    path?: unknown;
  };
  locations?: {
    path?: unknown;
  }[];
  content?: {
    type?: unknown;
    path?: unknown;
  }[];
}
interface DbObservation {
  db?: DatabaseSync;
  gap?: string;
}
interface DevinObservation {
  gap?: string;
  sessionId?: string;
  calls?: {
    tool: string;
    path: string | null;
  }[];
}
interface Checkpoint {
  lastUserMessageAt?: number | null;
  lastActivityAt?: number | null;
  lastStatus?: string | null;
  head?: string | null;
  followUpCount?: number;
  churn?: Record<string, {
    mtime: number | null;
    count: number;
  }>;
  devin?: {
    sessionId?: string;
  } | null;
  emitted?: string[];
}
interface MonitorSignal {
  agentId: string;
  kind: string;
  evidence: unknown;
  observedAt: string;
}
interface MonitorGap {
  agentId: string;
  gap: string;
  cwd?: string | null;
}
interface MonitorResult {
  signals: MonitorSignal[];
  scanned: number;
  stateFile: string | null;
  stateless?: boolean;
  gaps?: MonitorGap[];
}
import type { RuntimeError } from './types.ts';
import { lstatSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve, basename } from 'node:path';
import { resolveHome } from './managed-home.ts';
import { readAgentStates } from './agent-state.ts';
import { devinProviderPattern } from './binding.ts';
import { json, readJson } from './package.ts';

// On-demand signal scan for a Supervisor/Lead observer: one invocation is one
// scan — not a daemon, no held turn, no verdicts. Candidates come only from
// daemon-owned agent state files and each declared worktree's git status; the
// host exposes no cheap structured timeline read (`paseo logs` renders for
// humans and get_agent_activity is per-agent detail, not a tree timeline),
// so rendered output is never parsed. With a stateFile checkpoint only new fingerprints are emitted
// and the checkpoint is always rewritten — it is the only write. Without one
// the scan emits everything detectable and is flagged stateless.
//
// request.devinSessionsDb opts into a read-only probe of the devin CLI's
// sessions.db (sqlite): agents whose state provider is devin-family are
// linked by persistence.nativeHandle === sessions.id (the PK — cwd would
// misattribute sessions when two agents share a worktree) and their last
// tool calls are scanned for tool-mix and correction-cadence candidates.
// Every failure is an evidence gap, never a crash; absent the field nothing
// is probed.
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value ? value : null;
const millis = (value: unknown) => { const ms = typeof value === 'number' ? value : Date.parse(value as string); return Number.isFinite(ms) ? ms : null; };
const kinds = ['attention', 'follow-up-round', 'idle-dirty', 'scope-drift', 'test-mirror', 'file-churn', 'tool-mix', 'correction-cadence'];

// One threshold table owns defaults, numeric validation and schema bounds.
const thresholdRules = {
  idleMinutes: { type: 'number', exclusiveMinimum: 0, default: 20, error: 'must be positive' },
  churnScans: { type: 'number', exclusiveMinimum: 0, default: 2, error: 'must be positive' },
  toolWindow: { type: 'integer', exclusiveMinimum: 0, default: 20, error: 'must be a positive integer' },
  cadenceEdits: { type: 'integer', exclusiveMinimum: 0, default: 3, error: 'must be a positive integer' },
  toolShare: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.8, error: 'must be in (0, 1]' },
} as const;
const thresholdProperties = Object.fromEntries(Object.entries(thresholdRules).map(([key, { error: _error, ...schema }]) => [key, schema]));
const absolutePath = { type: ['string', 'null'], description: 'Absolute filesystem path; null behaves like omission' };
export function monitorSchema() {
  return {
    type: 'object', required: ['agents'], additionalProperties: true,
    properties: {
      paseoHome: { ...absolutePath, description: 'Absolute daemon home; omitted/null uses the managed binding or PASEO_HOME, then ~/.paseo when unmanaged' },
      agents: {
        type: 'array', minItems: 1, description: 'Agent ids must be unique',
        items: {
          type: 'object', required: ['id'], additionalProperties: true,
          properties: {
            id: { type: 'string', minLength: 1 }, cwd: absolutePath,
            scope: { type: ['array', 'null'], items: { type: 'string', minLength: 1 } },
          },
        },
      },
      thresholds: { type: ['object', 'null'], additionalProperties: true, properties: thresholdProperties },
      devinSessionsDb: absolutePath,
      signals: { type: ['array', 'null'], items: { type: 'string', enum: kinds }, default: kinds },
      stateFile: { ...absolutePath, description: 'Absolute checkpoint path; the scan rewrites it when supplied' },
    },
  };
}

// A missing, non-repo or failing cwd is an evidence gap, never a crash. HEAD
// doubles as the commit marker for follow-up tracking; %ct records the last
// commit time as evidence.
function probeGit(cwd: string): GitObservation {
  let stat;
  try { stat = lstatSync(cwd); } catch { stat = null; }
  if (!stat?.isDirectory()) return { gap: 'cwd is not a directory' };
  const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  let dirty;
  try {
    // -uall keeps untracked paths per file so scope/test-mirror matching sees
    // them; core.quotePath=false keeps non-ASCII paths literal instead of
    // octal-escaped, which would never match a declared scope entry.
    dirty = git(['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean)
      .map(line => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''));
  } catch (error) { return { gap: text((error as RuntimeError & { stderr?: string }).stderr?.trim().split('\n')[0]) ?? 'git status failed' }; }
  try {
    const [head, committedAt] = git(['log', '-1', '--format=%H%x00%ct']).trim().split('\0');
    return { dirty, head, committedAt: new Date(Number(committedAt) * 1000).toISOString() };
  } catch { return { dirty, head: null, committedAt: null }; }
}

// Minimal scope matcher: an entry without `*` matches the path itself or
// anything beneath it as a directory prefix; `*` matches any run of
// characters, including '/'.
const inScope = (path: string, scope: string[]) => scope.some(entry => entry.includes('*')
  ? new RegExp(`^${entry.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(path)
  : path === entry || path.startsWith(entry.endsWith('/') ? entry : `${entry}/`));

const isTestPath = (path: string) => path.startsWith('tests/') || /\.test\.[^/]+$/.test(path);
// tests/foo.test.mjs and src/foo.ts share the stem 'foo'.
const stemOf = (path: string) => basename(path).replace(/\.test\.[^.]+$/, '').replace(/\.[^.]+$/, '');

// tool_call_state.tool_call_json is a serialised ACP ToolCall: the
// devin-specific inferenceToolName is the most precise name, ACP `kind` and
// the human `title` are fallbacks. The edited path comes from rawInput args
// first, then the declared locations/diff content — never guessed.
const toolNameOf = (call: ToolCall) => text(call._meta?.['cognition.ai/inferenceToolName']) ?? text(call.kind) ?? text(call.title);
const editPathOf = (call: ToolCall) => text(call.rawInput?.file_path) ?? text(call.rawInput?.path)
  ?? text(call.locations?.[0]?.path) ?? text(call.content?.find(item => item?.type === 'diff')?.path);

// Open the db lazily: an absent node:sqlite or unreadable file is a gap, not
// an import-time failure.
function openDevinDb(path: string): DbObservation {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; }
  catch { return { gap: 'node:sqlite unavailable' }; }
  try { return { db: new DatabaseSync(path, { readOnly: true }) }; }
  catch { return { gap: `devin sessions.db unreadable: ${path}` }; }
}

// Selective only — the real db is ~900MB. The nativeHandle is a direct PK
// lookup; rowid order approximates call recency inside the session.
function probeDevin(db: DatabaseSync, handle: string, window: number): DevinObservation {
  try {
    const session = db.prepare('SELECT id, last_activity_at FROM sessions WHERE id = ?').get(handle) as { id: string; last_activity_at?: unknown } | undefined;
    if (!session) return { gap: 'no devin session for handle' };
    const rows = db.prepare('SELECT tool_call_json FROM tool_call_state WHERE session_id = ? AND tool_call_json IS NOT NULL ORDER BY rowid DESC LIMIT ?').all(session.id, window) as { tool_call_json: string }[];
    const calls: NonNullable<DevinObservation['calls']> = [];
    for (const row of rows) {
      let call: ToolCall;
      try { call = JSON.parse(row.tool_call_json); } catch { continue; }
      if (!record(call)) continue;
      const tool = toolNameOf(call);
      if (!tool) continue;
      calls.push({ tool, path: ['edit', 'write'].includes(tool) ? editPathOf(call) : null });
    }
    return { sessionId: session.id, calls };
  } catch (error) { return { gap: `devin sessions.db query failed: ${(error as RuntimeError).message}` }; }
}

export function monitor(request: MonitorRequest) {
  if (!record(request)) throw new Error('Monitor request must be a JSON object');
  // Managed mode (SLP_MANAGED_RUNTIME=1) fails closed: an absent paseoHome
  // resolves via SLP_DAEMON_HOME/PASEO_HOME or throws, never ~/.paseo (§10).
  const home = resolveHome(request.paseoHome);
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('Absolute paseoHome required');
  if (!Array.isArray(request.agents) || !request.agents.length) throw new Error('request.agents required');
  const seen = new Set();
  for (const entry of request.agents) {
    if (!record(entry) || !text(entry.id)) throw new Error('agents[].id required');
    if (seen.has(entry.id)) throw new Error(`Duplicate agents[].id ${entry.id}`);
    seen.add(entry.id);
    if (entry.cwd != null && !isAbsolute(entry.cwd)) throw new Error(`agents[${entry.id}].cwd must be absolute`);
    if (entry.scope != null && (!Array.isArray(entry.scope) || entry.scope.some(value => !text(value)))) {
      throw new Error('agents[].scope must be a string list');
    }
  }
  if (request.thresholds != null && !record(request.thresholds)) throw new Error('request.thresholds must be a JSON object');
  const thresholds = {
    ...Object.fromEntries(Object.entries(thresholdRules).map(([key, rule]) => [key, rule.default])),
    ...request.thresholds,
  } as Required<NonNullable<MonitorRequest['thresholds']>>;
  for (const key of Object.keys(thresholdRules) as (keyof typeof thresholdRules)[]) {
    const rule = thresholdRules[key];
    const value = thresholds[key];
    if (!Number.isFinite(value) || value <= rule.exclusiveMinimum
      || (rule.type === 'integer' && !Number.isInteger(value))
      || ('maximum' in rule && value > rule.maximum)) throw new Error(`thresholds.${key} ${rule.error}`);
  }
  if (request.devinSessionsDb != null && !isAbsolute(request.devinSessionsDb)) throw new Error('Absolute devinSessionsDb required');
  const wanted = request.signals ?? kinds;
  if (!Array.isArray(wanted) || wanted.some(kind => !kinds.includes(kind))) throw new Error(`signals must be a subset of ${kinds.join(', ')}`);
  if (request.stateFile != null && !isAbsolute(request.stateFile)) throw new Error('Absolute stateFile required');
  let prior: Record<string, Checkpoint> = {};
  if (request.stateFile) {
    try { prior = readJson(request.stateFile) as Record<string, Checkpoint>; }
    catch (error) { if ((error as RuntimeError).code !== 'ENOENT') throw new Error(`stateFile unreadable: ${(error as RuntimeError).message}`); }
    if (!record(prior)) throw new Error('stateFile must be a JSON object');
  }
  const states = new Map(readAgentStates(home).map(state => [state.id, state]));
  const observedAt = new Date().toISOString();
  const now = Date.now();
  const signals: MonitorSignal[] = [], gaps: MonitorGap[] = [], next: Record<string, Checkpoint> = {};
  let devinDb: DbObservation | null = null;
  for (const entry of request.agents) {
    const id = entry.id;
    const prev: Checkpoint = record(prior[id]) ? prior[id] : {};
    const emitted = new Set(Array.isArray(prev.emitted) ? prev.emitted.filter(text) : []);
    const emit = (kind: string, evidence: unknown, key: string) => {
      const fingerprint = `${id}|${kind}|${key}`;
      if (!wanted.includes(kind) || emitted.has(fingerprint)) return;
      signals.push({ agentId: id, kind, evidence, observedAt });
      emitted.add(fingerprint);
    };
    const state = states.get(id);
    if (!state) gaps.push({ agentId: id, gap: 'no agent state under paseoHome' });
    const cwd = entry.cwd ?? text(state?.cwd);
    const git = cwd ? probeGit(cwd) : { gap: 'no cwd declared' };
    if (git.gap) gaps.push({ agentId: id, gap: git.gap, cwd: cwd ?? null });
    const status = text(state?.lastStatus) ?? text(state?.status);
    const lastActivityAt = state?.lastActivityAt as number | null ?? null;
    const lastUserMessageAt = state?.lastUserMessageAt as number | null ?? null;
    const head = git.head ?? null;
    // A user message without an intervening commit is a correction round; a
    // HEAD change breaks the streak.
    let followUpCount = Number.isInteger(prev.followUpCount) ? prev.followUpCount! : 0;
    const bumped = lastUserMessageAt != null && prev.lastUserMessageAt != null && lastUserMessageAt > prev.lastUserMessageAt;
    if (bumped) followUpCount = head === (prev.head ?? null) ? followUpCount + 1 : 1;
    else if (head !== (prev.head ?? null)) followUpCount = 0;
    // Churn counts repeated edits while dirty, not a path merely staying
    // dirty: the count rises only when the file's mtime changed between scans.
    const churn: NonNullable<Checkpoint['churn']> = {};
    for (const path of git.dirty ?? []) {
      let mtime = null;
      try { mtime = lstatSync(join(cwd!, path)).mtimeMs; } catch { /* deleted or staged-only path */ }
      const before = record(prev.churn?.[path]) ? prev.churn![path] : null;
      const prior = Number.isInteger(before?.count) ? before!.count as number : 0;
      churn[path] = { mtime, count: before == null ? 1 : mtime !== before.mtime ? prior + 1 : prior };
    }
    // A path that left the dirty set ended its churn episode; dropping its
    // fingerprint lets a later episode signal once again.
    for (const path of Object.keys(record(prev.churn) ? prev.churn : {})) {
      if (!Object.hasOwn(churn, path)) emitted.delete(`${id}|file-churn|${path}`);
    }
    const reason = text(state?.attentionReason);
    // requiresAttention alone decides; a stale reason left by the daemon is
    // evidence, not a trigger.
    if (state?.requiresAttention === true) {
      emit('attention', { status, requiresAttention: true, reason }, reason ?? 'flag');
    }
    if (followUpCount >= 2) emit('follow-up-round', { lastUserMessageAt, followUpCount, head }, `at:${lastUserMessageAt}`);
    const idleFor = millis(lastActivityAt) != null ? now - millis(lastActivityAt)! : null;
    if ((status === 'idle' || status === 'finished') && git.dirty?.length && idleFor! > thresholds.idleMinutes * 60000) {
      emit('idle-dirty', { status, lastActivityAt, dirty: git.dirty, idleMinutes: Math.floor(idleFor! / 60000) }, `at:${lastActivityAt}`);
    }
    if (entry.scope?.length && git.dirty) {
      const offending = git.dirty.filter(path => !inScope(path, entry.scope!));
      if (offending.length) emit('scope-drift', { scope: entry.scope, offending }, [...offending].sort().join(','));
    }
    if (git.dirty?.length) {
      const stems = new Map(git.dirty.filter(path => !isTestPath(path)).map(path => [stemOf(path), path]));
      const pairs = git.dirty.filter(isTestPath)
        .map(path => ({ test: path, implementation: stems.get(stemOf(path)) }))
        .filter(pair => pair.implementation);
      if (pairs.length) emit('test-mirror', { pairs }, pairs.map(pair => `${pair.test}>${pair.implementation}`).sort().join(','));
      for (const [path, entry] of Object.entries(churn)) {
        if (entry.count >= thresholds.churnScans) emit('file-churn', { path, scans: entry.count }, path);
      }
    }
    // Devin session probe: opt-in via devinSessionsDb, devin providers only.
    // The join key is persistence.nativeHandle (= sessions.id); a devin agent
    // without one is a gap — guessing by cwd would misattribute a session.
    const provider = text(state?.provider) ?? text((state?.persistence as PersistenceObservation | null | undefined)?.provider);
    let devin: DevinObservation | null = null;
    if (request.devinSessionsDb && devinProviderPattern.test(provider ?? '')) {
      const handle = text((state?.persistence as PersistenceObservation | null | undefined)?.nativeHandle);
      if (!handle) gaps.push({ agentId: id, gap: 'devin agent has no persistence.nativeHandle' });
      else {
        devinDb ??= openDevinDb(request.devinSessionsDb);
        devin = devinDb.db ? probeDevin(devinDb.db, handle, thresholds.toolWindow) : devinDb;
        if (devin.gap) gaps.push({ agentId: id, gap: devin.gap });
        else {
          // A new session for the same agent retires the previous fingerprints.
          if (record(prev.devin) && prev.devin.sessionId !== devin.sessionId) {
            for (const fp of [...emitted]) {
              if (fp.startsWith(`${id}|tool-mix|`) || fp.startsWith(`${id}|correction-cadence|`)) emitted.delete(fp);
            }
          }
          const window = devin.calls!.length;
          const counts: Record<string, number> = {};
          for (const call of devin.calls!) counts[call.tool] = (counts[call.tool] ?? 0) + 1;
          for (const [tool, count] of Object.entries(counts)) {
            if (count / window >= thresholds.toolShare) emit('tool-mix', { tool, share: count / window, window, sessionId: devin.sessionId }, tool);
          }
          const edits: Record<string, number> = {};
          for (const call of devin.calls!) {
            if (call.path) edits[call.path] = (edits[call.path] ?? 0) + 1;
          }
          for (const [path, count] of Object.entries(edits)) {
            if (count >= thresholds.cadenceEdits) emit('correction-cadence', { path, count, window, sessionId: devin.sessionId }, path);
          }
        }
      }
    }
    next[id] = { lastUserMessageAt, lastActivityAt, lastStatus: status, head, followUpCount, churn,
      devin: devin?.sessionId ? { sessionId: devin.sessionId } : (record(prev.devin) ? prev.devin : null),
      emitted: [...emitted].sort() };
  }
  try { devinDb?.db?.close(); } catch { /* best-effort close of a read-only db */ }
  const result: MonitorResult = { signals, scanned: request.agents.length, stateFile: request.stateFile ?? null };
  if (!request.stateFile) result.stateless = true;
  if (gaps.length) result.gaps = gaps;
  if (request.stateFile) {
    mkdirSync(resolve(request.stateFile, '..'), { recursive: true });
    const tmp = `${request.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, json(next));
    renameSync(tmp, request.stateFile);
  }
  return result;
}
