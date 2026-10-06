#!/usr/bin/env node
// Runs `node --test` against a throwaway PASEO_HOME with a clean environment,
// so an ambient managed runtime or enabled service never leaks into fixtures.
// Arguments are test files and `node --test` flags (default files:
// tests/*.test.mjs); the exit code is node's own.
//
// Wrapper flags (removed before forwarding):
//   --slp-record=<dir>       write <dir>/test.log, <dir>/events.jsonl and an
//                            atomic <dir>/receipt.json; stdout gets a short summary
//   --slp-baseline=<receipt> compare this run's failures with a previous receipt
// A receipt pins measurements only; deciding to reuse it belongs to the reader.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
// SLP_TEST_ISOLATED_ROOT points the wrapper at another repository; it exists so
// tests can exercise record mode on a throwaway repo without touching this one.
const root = process.env.SLP_TEST_ISOLATED_ROOT ? realpathSync(process.env.SLP_TEST_ISOLATED_ROOT) : resolve(dirname(self), '..');
const SUMMARY_FAIL_LINES = 15;

// Loaded by `node --test --test-reporter=<this file>`: forwards only the events
// the wrapper needs, as JSON lines to the destination file. The wrapper's own
// work runs only when this file is the process entry point, never from the
// environment, so importing it as a reporter cannot skip a run.
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type === 'test:fail' || event.type === 'test:summary') {
      const { name, nesting, file, line, details, counts, success } = event.data;
      const failure = details?.error?.failureType;
      yield `${JSON.stringify({ type: event.type, name, nesting, file, line, failure, counts, success })}\n`;
    }
  }
}

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const iso = () => new Date().toISOString();
const load = () => ({ loadavg: loadavg().map(n => Math.round(n * 100) / 100) });

function parseArgs(argv) {
  let record = null, baseline = null;
  const args = [];
  for (const arg of argv) {
    if (arg.startsWith('--slp-record=')) record = arg.slice('--slp-record='.length);
    else if (arg.startsWith('--slp-baseline=')) baseline = arg.slice('--slp-baseline='.length);
    else args.push(arg);
  }
  return { record, baseline, args };
}

const defaults = () => readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join('tests', name));
const isTestFile = arg => !arg.startsWith('-') && (/\.(?:mjs|js|cjs|mts|ts)$/.test(arg) || existsSync(resolve(root, arg)));

/** Fail-closed reading of the reporter events: anything unreadable is `invalid`. */
function readEvents(path) {
  let lines;
  try { lines = readFileSync(path, 'utf8').split('\n').filter(Boolean); } catch { return { error: 'events file is missing' }; }
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { return { error: 'events file has a malformed line' }; }
  }
  const final = events.filter(e => e.type === 'test:summary' && !e.file).at(-1);
  if (!final?.counts) return { error: 'no final test summary event' };
  const counts = final.counts;
  const keys = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];
  if (!keys.every(k => Number.isInteger(counts[k]) && counts[k] >= 0)) return { error: 'summary counts are not integers' };
  if (counts.tests === 0) return { error: 'summary reports zero tests' };
  if (counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo !== counts.tests) return { error: 'summary counts do not add up' };
  const failures = events.filter(e => e.type === 'test:fail' && e.failure !== 'subtestsFailed')
    .map(e => ({ name: e.name, file: e.file ? relative(root, e.file) : null, line: e.line ?? null }));
  return { counts: Object.fromEntries(keys.map(k => [k, counts[k]])), success: final.success === true, failures };
}

function verdict(code, signal, parsed, stable) {
  if (signal) return { status: 'invalid', reason: `child ended by signal ${signal}` };
  if (code === null) return { status: 'invalid', reason: 'child did not report an exit code' };
  if (parsed.error) return { status: 'invalid', reason: parsed.error };
  const { counts } = parsed;
  const bad = counts.failed + counts.cancelled;
  if (code === 0 && (bad > 0 || !parsed.success)) return { status: 'invalid', reason: 'exit code 0 contradicts failing counts' };
  if (code !== 0 && bad === 0 && parsed.success) return { status: 'invalid', reason: 'non-zero exit contradicts passing counts' };
  if (!stable) return { status: 'invalid', reason: 'candidate changed while the run was in progress' };
  return { status: code === 0 ? 'pass' : 'fail', reason: null };
}

const failKey = f => `${f.file ?? '?'}:${f.line ?? '?'} ${f.name}`;

function compare(current, baselinePath) {
  let base;
  try { base = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch { return { error: `baseline receipt is unreadable: ${baselinePath}` }; }
  const warnings = [];
  if (base.status !== 'pass' && base.status !== 'fail') warnings.push(`baseline status is ${base.status}; its fail list is not a measurement`);
  if (!Array.isArray(base.failures)) return { error: 'baseline receipt has no fail list' };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (base.node !== current.node) warnings.push(`node differs (${base.node} vs ${current.node})`);
  if (!same(base.platform, current.platform)) warnings.push('platform/arch differs');
  if (!same(base.argv, current.argv)) warnings.push('argv differs');
  if (!same(base.files, current.files)) warnings.push('test file list differs');
  if (base.candidate?.after?.sha256 !== current.candidate.after?.sha256) warnings.push('candidate snapshot differs from the baseline');
  const before = new Set(base.failures.map(failKey)), now = new Set(current.failures.map(failKey));
  return { warnings, added: [...now].filter(k => !before.has(k)), fixed: [...before].filter(k => !now.has(k)), kept: [...now].filter(k => before.has(k)) };
}

function usage(message) {
  console.error(`test-isolated: ${message}`);
  process.exit(2);
}

function summaryLines(receipt, dir, comparison) {
  const c = receipt.counts;
  const out = [`test-isolated: ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ''}   selection: ${receipt.selection}`,
    `exit: ${receipt.exitCode}${receipt.signal ? ` signal: ${receipt.signal}` : ''}   duration: ${receipt.durationMs} ms`];
  if (c) out.push(`tests ${c.tests}  pass ${c.passed}  fail ${c.failed}  cancelled ${c.cancelled}  skipped ${c.skipped}  todo ${c.todo}`);
  const shown = receipt.failures.slice(0, SUMMARY_FAIL_LINES);
  if (receipt.failures.length) out.push(`failing tests (${receipt.failures.length}):`);
  for (const f of shown) out.push(`  ${failKey(f)}`);
  if (receipt.failures.length > shown.length) out.push(`  ... ${receipt.failures.length - shown.length} more not shown (truncated; full list in receipt)`);
  if (comparison) {
    if (comparison.error) out.push(`baseline: ${comparison.error}`);
    else {
      out.push(`baseline: ${comparison.added.length} new, ${comparison.fixed.length} fixed, ${comparison.kept.length} unchanged`);
      for (const [label, list] of [['new', comparison.added], ['fixed', comparison.fixed]]) {
        for (const k of list.slice(0, 5)) out.push(`  ${label}: ${k}`);
        if (list.length > 5) out.push(`  ... ${list.length - 5} more ${label} (truncated)`);
      }
      for (const w of comparison.warnings) out.push(`baseline WARNING: ${w}`);
    }
  }
  out.push(`receipt: ${join(dir, 'receipt.json')}`, `log sha256: ${receipt.log?.sha256 ?? 'n/a'}`);
  return out;
}

function writeReceipt(dir, receipt) {
  const target = join(dir, 'receipt.json');
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temp, target);
}

const { record, baseline, args } = parseArgs(process.argv.slice(2));
const isEntry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self);

/** Live descendants of a pid, from the process table. */
function descendants(pid) {
  let table;
  try { table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }); } catch { return []; }
  const kids = new Map();
  for (const line of table.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  const found = [];
  for (const queue = [pid]; queue.length;) for (const kid of kids.get(queue.shift()) ?? []) { found.push(kid); queue.push(kid); }
  return found;
}
const signalAll = (pids, sig) => { for (const pid of pids) { try { process.kill(pid, sig); } catch { /* already gone */ } } };

async function main() {
  if (baseline !== null && record === null) usage('--slp-baseline requires --slp-record');
  const explicit = args.some(isTestFile);
  const files = explicit ? args.filter(isTestFile) : defaults();
  const forwarded = explicit ? args : [...args, ...files];
  // Allowlist of nothing: any argument for node may narrow the run, so only an argument-free run is the default suite.
  const selection = args.length === 0 ? 'default-suite' : 'partial';

  let dir = null, snapshot = null;
  if (record !== null) {
    dir = resolve(record);
    let real;
    try {
      let link = null;
      try { link = lstatSync(dir); } catch { /* not there yet */ }
      real = link ? realpathSync(dir) : resolve(realpathSync(dirname(dir)), dir.split('/').at(-1));
    } catch {
      usage(`--slp-record parent directory does not exist or is a dangling link: ${record}`);
    }
    if (real === root || real.startsWith(`${root}/`)) usage('--slp-record must be outside the repository (record files would change the candidate)');
    mkdirSync(dir, { recursive: true });
    for (const stale of ['receipt.json', 'test.log', 'events.jsonl']) rmSync(join(dir, stale), { force: true });
    ({ snapshot } = await import('../plugin/server/runtime/cli/package.ts'));
  }
  const measure = () => { try { return snapshot(root); } catch (error) { return { error: String(error.message ?? error) }; } };
  const pinOf = s => (s.error ? { error: s.error } : { head: s.head, sha256: s.sha256 });

  const home = mkdtempSync(join(tmpdir(), 'slp-test-home-'));
  const clean = { PASEO_HOME: home, PATH: process.env.PATH ?? '' };
  if (process.env.HOME) clean.HOME = process.env.HOME;
  const startedAt = new Date();
  const before = record !== null ? measure() : null;
  const startLoad = load();
  const childArgs = ['--test'];
  let logFd = null;
  if (record !== null) {
    childArgs.push('--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${self}`, `--test-reporter-destination=${join(dir, 'events.jsonl')}`);
    logFd = openSync(join(dir, 'test.log'), 'w');
  }
  childArgs.push(...forwarded);

  let interrupted = null, tree = [];
  let child;
  const result = await new Promise(done => {
    child = spawn(process.execPath, childArgs, { cwd: root, env: clean,
      stdio: record !== null ? ['ignore', logFd, logFd] : 'inherit' });
    child.on('error', error => done({ code: null, signal: null, error }));
    child.on('close', (code, signal) => done({ code, signal }));
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => {
        if (interrupted) return;
        interrupted = sig;
        // The child shares our process group (so a group SIGKILL reaches it); a
        // caught signal walks the descendant tree instead of signalling the group,
        // which would also hit the caller's shell or npm.
        tree = [child.pid, ...descendants(child.pid)];
        signalAll(tree, 'SIGTERM');
        setTimeout(() => signalAll([...tree, ...descendants(child.pid)], 'SIGKILL'), 3000).unref();
      });
    }
  });
  signalAll(tree, 'SIGKILL'); // anything in the tree that ignored SIGTERM
  rmSync(home, { recursive: true, force: true });
  if (logFd !== null) closeSync(logFd);
  if (result.error) console.error(`test-isolated: ${result.error.message}`);

  const endedAt = new Date();
  let exit = result.code ?? 1;
  if (interrupted) exit = 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[interrupted];

  if (record === null) { process.exitCode = exit; return; }

  const after = measure();
  const stable = !before.error && !after.error && before.sha256 === after.sha256;
  const parsed = readEvents(join(dir, 'events.jsonl'));
  const outcome = interrupted ? { status: 'interrupted', reason: `received ${interrupted}` }
    : verdict(result.error ? null : result.code, result.signal, parsed, stable);
  const lockPath = join(root, 'node_modules', '.package-lock.json');
  const receipt = {
    schema: 'test-isolated-receipt/1',
    selection,
    status: outcome.status,
    reason: outcome.reason,
    candidate: { before: pinOf(before), after: pinOf(after), stable },
    argv: forwarded,
    files,
    node: process.version,
    platform: { platform: process.platform, arch: process.arch, cpus: cpus().length },
    load: { start: startLoad.loadavg, end: load().loadavg },
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt - startedAt,
    exitCode: exit,
    signal: interrupted ?? result.signal ?? null,
    counts: parsed.counts ?? null,
    failures: parsed.failures ?? [],
    events: existsSync(join(dir, 'events.jsonl')) ? { path: join(dir, 'events.jsonl'), sha256: sha256(join(dir, 'events.jsonl')) } : null,
    log: { path: join(dir, 'test.log'), sha256: sha256(join(dir, 'test.log')) },
    nodeModulesLockSha256: existsSync(lockPath) ? sha256(lockPath) : null,
  };
  const comparison = baseline !== null ? compare(receipt, resolve(baseline)) : null;
  if (comparison?.error) receipt.baseline = { path: resolve(baseline), error: comparison.error };
  if (comparison && !comparison.error) receipt.baseline = { path: resolve(baseline), added: comparison.added, fixed: comparison.fixed, kept: comparison.kept, warnings: comparison.warnings };
  writeReceipt(dir, receipt);
  console.log(summaryLines(receipt, dir, comparison).join('\n'));
  // A run that cannot be called a pass must not exit 0, even when node did.
  process.exitCode = outcome.status === 'pass' || exit !== 0 ? exit : 1;
}

if (isEntry) await main();
