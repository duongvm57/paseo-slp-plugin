// tests/work-tracker.test.mjs — the beads work-tracker package side:
// plugin/server/runtime/cli/work-tracker.ts reader semantics, findBd PATH scan, the read-only
// probe against a fake `bd` on a temp PATH (T5 — no real bd exists on this
// machine and none is ever installed), the session-
// entry block and the `slp tracker` CLI. The adapter-path check (T7)
// lives at the bottom — both roots must resolve the same setting file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORK_TRACKER_FILE,
  findBd,
  probeWorkTracker,
  readWorkTrackerSetting,
  workTrackerBlock,
} from '../plugin/server/runtime/cli/work-tracker.ts';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { roleBundle, roleDelivery } from '../plugin/server/runtime/cli/role-bundle.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function tmp(t, prefix = 'wt-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A daemon-home-shaped fixture: the state file lives under
// <home>/slp-runtime/state/, matching the plugin's <stableRoot>/state.
function tmpHome(t) {
  const home = tmp(t, 'wt-home-');
  mkdirSync(join(home, 'slp-runtime', 'state'), { recursive: true });
  return home;
}

const settingPath = home => join(home, WORK_TRACKER_FILE);
const writeSetting = (home, value) => writeFileSync(settingPath(home), typeof value === 'string' ? value : JSON.stringify(value));

// A fake `bd` executable on a temp PATH — a shell script, never a real
// install. whereJson=null makes `bd where` fail like an uninitialized repo.
function fakeBd(t, { version = 'bd version 0.21.0 (build abc123)', versionExit = 0, whereJson = null, whereExit = 1, captureEnv = null } = {}) {
  const dir = tmp(t, 'wt-bd-');
  const path = join(dir, 'bd');
  const q = s => `'${String(s).replaceAll("'", "'\\''")}'`;
  writeFileSync(path, `#!/bin/sh
${captureEnv ? `printf 'BD_DISABLE_METRICS=%s\\nPATH=%s\\n' "$BD_DISABLE_METRICS" "$PATH" > ${q(captureEnv)}\n` : ''}if [ "$1" = "version" ]; then
  printf '%s\\n' ${q(version)}
  exit ${versionExit}
fi
if [ "$1" = "where" ]; then
  ${whereJson === null ? `echo 'no beads workspace here' >&2` : `printf '%s\\n' ${q(whereJson)}`}
  exit ${whereExit}
fi
exit 0
`);
  chmodSync(path, 0o755);
  return { dir, path };
}

// ---------------------------------------------------------------------------
// readWorkTrackerSetting — the §4 contract
// ---------------------------------------------------------------------------

test('setting reader: absent file is disabled without error; valid files read through', t => {
  const home = tmpHome(t);
  assert.deepEqual(readWorkTrackerSetting(home), { enabled: false, error: null });
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: true });
  assert.deepEqual(readWorkTrackerSetting(home), { enabled: true, error: null });
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: false });
  assert.deepEqual(readWorkTrackerSetting(home), { enabled: false, error: null });
});

test('setting reader: corrupt or foreign shapes are disabled plus a surfaced error', t => {
  const home = tmpHome(t);
  writeSetting(home, '{corrupt');
  const broken = readWorkTrackerSetting(home);
  assert.equal(broken.enabled, false);
  assert.match(broken.error, /not valid JSON/);
  for (const [name, value, pattern] of [
    ['array', [1], /expected an object/],
    ['wrong schemaVersion', { schemaVersion: 2, tracker: 'beads', enabled: true }, /expected schemaVersion 1/],
    ['foreign tracker', { schemaVersion: 1, tracker: 'linear', enabled: true }, /expected tracker "beads"/],
    ['non-boolean enabled', { schemaVersion: 1, tracker: 'beads', enabled: 'yes' }, /enabled to be a boolean/],
    ['extra key', { schemaVersion: 1, tracker: 'beads', enabled: true, extra: 1 }, /unexpected keys: extra/],
  ]) {
    writeSetting(home, JSON.stringify(value));
    const result = readWorkTrackerSetting(home);
    assert.equal(result.enabled, false, name);
    assert.match(result.error, pattern, name);
  }
});

test('setting reader: non-ENOENT filesystem errors propagate', t => {
  const home = tmpHome(t);
  // A directory at the file path → EISDIR, which is not a "missing setting".
  mkdirSync(settingPath(home));
  assert.throws(() => readWorkTrackerSetting(home), error => error.code === 'EISDIR');
});

// ---------------------------------------------------------------------------
// findBd — PATH scan
// ---------------------------------------------------------------------------

test('findBd: first executable bd in absolute PATH order; relative entries skipped', t => {
  const one = fakeBd(t, {});
  const two = fakeBd(t, {});
  assert.equal(findBd({ PATH: `${one.dir}${delimiter}${two.dir}` }), one.path);
  assert.equal(findBd({ PATH: two.dir }), two.path);
  // A relative PATH entry is never consulted even when it resolves against cwd.
  const rel = tmp(t, 'wt-rel-');
  writeFileSync(join(rel, 'bd'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(findBd({ PATH: rel.slice(1) }), null, 'relative PATH entry skipped');
  assert.equal(findBd({ PATH: '' }), null);
  assert.equal(findBd({}), null);
});

test('findBd: a non-executable bd is skipped for the next PATH entry', t => {
  const dead = tmp(t, 'wt-dead-');
  writeFileSync(join(dead, 'bd'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const live = fakeBd(t, {});
  assert.equal(findBd({ PATH: `${dead}${delimiter}${live.dir}` }), live.path);
  assert.equal(findBd({ PATH: dead }), null);
});

// ---------------------------------------------------------------------------
// probeWorkTracker — read-only, gaps are data (T5)
// ---------------------------------------------------------------------------

test('probe: enabled field follows the setting file; absent home leaves it null', t => {
  const home = tmpHome(t);
  const repo = tmp(t, 'wt-repo-');
  const withoutHome = probeWorkTracker(repo, { env: { PATH: '/nonexistent' } });
  assert.equal(withoutHome.enabled, null);
  assert.equal(withoutHome.state, 'unavailable');
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: true });
  const withHome = probeWorkTracker(repo, { daemonHome: home, env: { PATH: '/nonexistent' } });
  assert.equal(withHome.enabled, true);
  writeSetting(home, '{corrupt');
  const corrupt = probeWorkTracker(repo, { daemonHome: home, env: { PATH: '/nonexistent' } });
  assert.equal(corrupt.enabled, false);
  assert.ok(corrupt.gaps.some(gap => /tracker setting unreadable/.test(gap)));
});

test('probe: missing bd reports a gap and never throws', t => {
  const repo = tmp(t, 'wt-repo-');
  const result = probeWorkTracker(repo, { env: { PATH: '/nonexistent-bd-dir' } });
  assert.equal(result.tracker, 'beads');
  assert.equal(result.repository, repo);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.bd, null);
  assert.equal(result.workspace, null);
  assert.ok(result.gaps.some(gap => /bd not found on PATH/.test(gap)));
});

test('probe: a repository that is not a directory is a gap, and bd is never consulted', t => {
  const bd = fakeBd(t, {});
  const missing = join(tmp(t, 'wt-repo-'), 'gone');
  const result = probeWorkTracker(missing, { env: { PATH: bd.dir } });
  assert.equal(result.state, 'unavailable');
  assert.equal(result.bd, null, 'no bd probe ran for a missing repository');
  assert.ok(result.gaps.some(gap => /not a directory/.test(gap)));
});

test('probe: bd version failures and garbage output degrade to gaps', t => {
  const repo = tmp(t, 'wt-repo-');
  const failing = fakeBd(t, { versionExit: 1 });
  const failed = probeWorkTracker(repo, { env: { PATH: failing.dir } });
  assert.equal(failed.state, 'unavailable');
  assert.deepEqual(failed.bd, { path: failing.path, version: null });
  assert.ok(failed.gaps.some(gap => /bd version failed/.test(gap)));

  // Garbage version output is a gap, but the workspace probe still runs.
  const garbage = fakeBd(t, { version: 'this is not a version line' });
  const odd = probeWorkTracker(repo, { env: { PATH: garbage.dir } });
  assert.equal(odd.state, 'uninitialized');
  assert.equal(odd.bd.version, null);
  assert.ok(odd.gaps.some(gap => /version output unrecognized/.test(gap)));
});

test('probe: failing bd where means uninitialized; JSON means ready', t => {
  const repo = tmp(t, 'wt-repo-');
  const absent = fakeBd(t, {});
  const uninit = probeWorkTracker(repo, { env: { PATH: absent.dir } });
  assert.equal(uninit.state, 'uninitialized');
  assert.equal(uninit.workspace, null);
  assert.equal(uninit.bd.version, '0.21.0');
  assert.ok(uninit.gaps.some(gap => /not a beads workspace/.test(gap)));

  const present = fakeBd(t, { whereJson: '{"Path":"/repo/.beads","Prefix":"slp","RedirectedFrom":""}', whereExit: 0 });
  const ready = probeWorkTracker(repo, { env: { PATH: present.dir } });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.workspace, { path: '/repo/.beads', prefix: 'slp', redirectedFrom: '' });
  assert.equal(ready.gaps.length, 0);

  const malformed = fakeBd(t, { whereJson: 'not json', whereExit: 0 });
  const odd = probeWorkTracker(repo, { env: { PATH: malformed.dir } });
  assert.equal(odd.state, 'uninitialized');
  assert.ok(odd.gaps.some(gap => /bd where failed/.test(gap)));
});

test('probe: bd where --json snake_case keys are canonical (bd 1.3.0)', t => {
  const repo = tmp(t, 'wt-repo-');
  // Real bd 1.3.0 output — snake_case keys plus database_path/schema_version
  // the workspace record intentionally does not carry.
  const bd = fakeBd(t, {
    whereJson: '{"database_path":"/repo/.beads/embeddeddolt","path":"/repo/.beads","prefix":"slp","schema_version":1}',
    whereExit: 0,
  });
  const ready = probeWorkTracker(repo, { env: { PATH: bd.dir } });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.workspace, { path: '/repo/.beads', prefix: 'slp', redirectedFrom: null });
  assert.equal(ready.gaps.length, 0);
});

test('probe: bd is spawned read-only with forced telemetry off and a cwd', t => {
  const repo = tmp(t, 'wt-repo-');
  const captureEnv = join(tmp(t, 'wt-env-'), 'env');
  const bd = fakeBd(t, { whereJson: '{"Path":"/repo/.beads","Prefix":"slp"}', whereExit: 0, captureEnv });
  // A Human-set BD_DISABLE_METRICS=0 is overridden for the probe — telemetry
  // stays off for SLP-run commands regardless of the ambient env.
  const result = probeWorkTracker(repo, { env: { PATH: bd.dir, BD_DISABLE_METRICS: '0' } });
  assert.equal(result.state, 'ready');
  assert.equal(readFileSync(captureEnv, 'utf8'), `BD_DISABLE_METRICS=1\nPATH=${bd.dir}\n`);
});

test('probe: the run seam receives file, args, env and cwd — no real spawn needed', t => {
  const repo = tmp(t, 'wt-repo-');
  const calls = [];
  const bd = fakeBd(t, {});
  const result = probeWorkTracker(repo, {
    env: { PATH: bd.dir },
    run: (file, args, options) => {
      calls.push({ file, args, env: options.env, cwd: options.cwd });
      return args[0] === 'version' ? 'bd version 1.2.3 (x)' : '{"Path":"/p","Prefix":"pre"}';
    },
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.bd.version, '1.2.3');
  assert.deepEqual(calls.map(call => call.args), [['version'], ['where', '--json']]);
  for (const call of calls) {
    assert.equal(call.file, bd.path);
    assert.equal(call.cwd, repo);
    assert.equal(call.env.BD_DISABLE_METRICS, '1');
    assert.equal(call.env.PATH, bd.dir);
  }
});

// ---------------------------------------------------------------------------
// workTrackerBlock — the session-entry pointer (spec §5.3)
// ---------------------------------------------------------------------------

const shq = value => "'" + value.replaceAll("'", "'\\''") + "'";

test('workTrackerBlock: disabled states emit nothing; enabled emits the pointer', t => {
  const home = tmpHome(t);
  const render = () => workTrackerBlock(home, { cli: 'slp', policyDir: '/policy/src', shq });
  assert.equal(render(), '', 'absent file — disabled by default');
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: false });
  assert.equal(render(), '', 'explicit off stays silent');
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: true });
  const block = render();
  assert.match(block, /^Work tracker: beads \(enabled in SLP settings\)/);
  assert.ok(block.includes('/policy/src/references/work-tracking.md'), 'names the policy reference');
  assert.ok(block.includes('slp tracker <repository>'), 'names the probe command');
  assert.ok(block.includes(`--paseo-home ${shq(home)}`), 'names the explicit home');
  assert.ok(block.endsWith('\n') && block.trim().split('\n').length === 1, 'one line');
});

test('workTrackerBlock: a corrupt setting emits one gap line, not a throw', t => {
  const home = tmpHome(t);
  writeSetting(home, '{corrupt');
  const block = workTrackerBlock(home, { cli: 'slp', policyDir: '/policy/src', shq });
  assert.match(block, /^Work tracker: setting unreadable — work-tracker\.json is not valid JSON/);
  assert.match(block, /record this gap/);
  assert.ok(block.endsWith('\n') && block.trim().split('\n').length === 1, 'one gap line');
});

// ---------------------------------------------------------------------------
// `slp tracker` CLI (spec §5.2)
// ---------------------------------------------------------------------------

const SLP = join(root, 'bin', 'slp.mjs');
const runCli = (args, env = {}) => spawnSync(process.execPath, [SLP, ...args], {
  env: { PATH: process.env.PATH, ...env },
  encoding: 'utf8',
});

test('tracker CLI: prints the probe JSON and exits 0 even when not ready', t => {
  const repo = tmp(t, 'wt-repo-');
  const home = tmpHome(t);
  const missing = runCli(['tracker', repo], { PATH: '/nonexistent-bd' });
  assert.equal(missing.status, 0, missing.stderr);
  const parsed = JSON.parse(missing.stdout);
  assert.equal(parsed.tracker, 'beads');
  assert.equal(parsed.state, 'unavailable');
  assert.equal(parsed.enabled, null, 'no --paseo-home means the setting is not read');
  assert.ok(parsed.gaps.length > 0);

  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: true });
  const bd = fakeBd(t, { whereJson: '{"Path":"/repo/.beads","Prefix":"slp"}', whereExit: 0 });
  const ready = runCli(['tracker', repo, '--paseo-home', home], { PATH: bd.dir });
  assert.equal(ready.status, 0, ready.stderr);
  const out = JSON.parse(ready.stdout);
  assert.equal(out.enabled, true);
  assert.equal(out.state, 'ready');
  assert.equal(out.bd.version, '0.21.0');
});

test('tracker CLI: argument validation matches the other commands', () => {
  assert.notEqual(runCli(['tracker']).status, 0);
  assert.match(runCli(['tracker']).stderr, /requires <repository>/);
  const bad = runCli(['tracker', '/tmp', '--bogus']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unknown flag --bogus/);
  const relative = runCli(['tracker', '/tmp', '--paseo-home', 'relative']);
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /Absolute path required/);
});

// ---------------------------------------------------------------------------
// role-bundle session entry — the §5.3 pointer and §7 disabled parity
// ---------------------------------------------------------------------------

const managedEnv = (home, runtimeRoot = '/rt/candidate') => ({
  PATH: '',
  SLP_MANAGED_RUNTIME: '1',
  SLP_NODE_BIN: '/opt/node/bin/node',
  SLP_RUNTIME_ROOT: runtimeRoot,
  SLP_DAEMON_HOME: home,
});

test('session entry: disabled tracker renders byte-identically — absent file and explicit off (T1)', t => {
  const home = tmpHome(t);
  const dir = tmp(t, 'wt-inst-');
  const installed = join(dir, 'release');
  install(root, installed);
  const env = managedEnv(home);
  const absent = roleBundle(installed, 'peer', env).instructions;
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: false });
  const off = roleBundle(installed, 'peer', env).instructions;
  assert.equal(off, absent, 'explicit-off render must equal absent render');
  assert.ok(!absent.includes('Work tracker:'), 'disabled render carries no tracker line');
  // Unmanaged sessions never read the setting at all.
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: true });
  const unmanaged = roleBundle(installed, 'peer', {}).instructions;
  assert.ok(!unmanaged.includes('Work tracker:'), 'unmanaged render ignores the setting');
});

// T1 byte-level pin: disabled session entry keeps the historical instruction
// body after removing the declared common communication-policy and Peer
// slp-record emit-rule deltas. Keep the fixture historical; any other body
// drift remains visible. The locator contract exposes only common.md and the
// Peer role file.
test('session entry: disabled Peer render keeps historical body after declared policy deltas (T1)', t => {
  const before = JSON.parse(readFileSync(join(root, 'tests/fixtures/pre-tracker-session.json'), 'utf8'));
  const home = tmpHome(t);
  const installed = join(tmp(t, 'wt-inst-'), 'release');
  const env = managedEnv(home, installed);
  install(root, installed);
  const after = roleBundle(installed, 'peer', env).instructions
    .replaceAll(installed, '<RUNTIME_ROOT>')
    .replaceAll(home, '<DAEMON_HOME>');
  // Locator hashes change with policy edits. Pin the role allowlist and body,
  // not historical locator bytes.
  const locatorRe = /^- (.*\S) — \d+ bytes, sha256 [0-9a-f]{64}$/;
  const splitRender = text => {
    const locators = new Set(), body = [];
    for (const line of text.split('\n')) {
      const m = line.match(locatorRe);
      if (m) locators.add(m[1]); else body.push(line);
    }
    return { locators, body: body.join('\n') };
  };
  const a = splitRender(after), b = { body: before.body };
  const communicationPolicy = readFileSync(join(root, 'src/common.md'), 'utf8')
    .split(/\r?\n[ \t]*\r?\n/u)
    .find(paragraph => paragraph.includes('Seat-facing text'));
  assert.ok(communicationPolicy, 'common.md contains the seat-facing text paragraph');
  const peerEmitRule = readFileSync(join(root, 'src/roles/peer.md'), 'utf8')
    .split(/\r?\n[ \t]*\r?\n/u)
    .find(paragraph => paragraph.includes('slp-record'));
  assert.ok(peerEmitRule, 'peer.md contains the slp-record emit-rule paragraph');
  const withoutPeerEmitRule = a.body.replace(`\n\n${peerEmitRule}\n`, '\n\n');
  assert.notEqual(withoutPeerEmitRule, a.body, 'the declared Peer emit-rule delta is present');
  const historicalBody = withoutPeerEmitRule.replace(`\n\n${communicationPolicy}\n\n`, '\n\n');
  assert.notEqual(historicalBody, withoutPeerEmitRule, 'the declared common-policy delta is present');
  assert.deepEqual([...a.locators].sort(), [
    '<RUNTIME_ROOT>/src/common.md',
    '<RUNTIME_ROOT>/src/roles/peer.md',
  ].sort(), 'tracker-off Peer carrier contains only its role allowlist');
  assert.equal(historicalBody, b.body, 'the remaining disabled render body equals the historical baseline byte-for-byte');
});

test('session entry: enabled setting adds one pointer line between language and assignment (T3)', t => {
  const home = tmpHome(t);
  const dir = tmp(t, 'wt-inst-');
  const installed = join(dir, 'release');
  install(root, installed);
  writeFileSync(join(home, 'slp-runtime/state/communication-language'), 'Vietnamese\n');
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: true });
  // SLP_RUNTIME_ROOT points at the real install so the carrier locators
  // resolve actual files — matching a managed seat's frozen runtime root.
  const instructions = roleBundle(installed, 'peer', managedEnv(home, installed)).instructions;
  const language = instructions.indexOf('Communication language: Vietnamese');
  const tracker = instructions.indexOf('Work tracker: beads (enabled in SLP settings)');
  const assignment = instructions.indexOf('Use the current authorized Human or delegated assignment');
  assert.ok(language !== -1 && tracker !== -1 && assignment !== -1, 'all three lines present');
  assert.ok(language < tracker && tracker < assignment, 'pointer sits between language and assignment');
  assert.equal(instructions.split('Work tracker:').length - 1, 1, 'exactly one tracker line');
  const line = instructions.split('\n').find(l => l.startsWith('Work tracker:'));
  assert.ok(line.includes(`${installed}/src/references/work-tracking.md`), 'names the installed policy reference');
  assert.ok(line.includes(`tracker <repository> --paseo-home '${home}'`), 'names the probe with the explicit home');
  // The integrity locator list always carries the reference — enabled or not.
  const locatorLine = instructions.split('\n').find(l => l.includes(`${installed}/src/references/work-tracking.md`) && l.startsWith('- '));
  assert.ok(locatorLine && locatorLine.includes('sha256'), 'locator lists the doctrine with size and hash');
});

test('session entry: a corrupt setting emits one gap line and never crashes the render (T4)', t => {
  const home = tmpHome(t);
  const dir = tmp(t, 'wt-inst-');
  const installed = join(dir, 'release');
  install(root, installed);
  writeSetting(home, '{corrupt');
  const instructions = roleBundle(installed, 'peer', managedEnv(home)).instructions;
  assert.match(instructions, /Work tracker: setting unreadable — work-tracker\.json is not valid JSON/);
  assert.match(instructions, /record this gap/);
  assert.equal(instructions.split('Work tracker:').length - 1, 1, 'one gap line');
  // The rest of the entry is intact — assignment still renders.
  assert.ok(instructions.includes('Use the current authorized Human or delegated assignment'));
});

test('session entry: anchor() never carries the tracker block', t => {
  const home = tmpHome(t);
  const dir = tmp(t, 'wt-inst-');
  const installed = join(dir, 'release');
  install(root, installed);
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: true });
  const delivery = roleDelivery(installed, 'peer', managedEnv(home));
  assert.ok(delivery.entry().includes('Work tracker: beads'), 'entry() carries the pointer');
  assert.ok(!delivery.anchor().includes('Work tracker:'), 'anchor() omits it');
});

// ---------------------------------------------------------------------------
// The doctrine file — §5.4 self-gate and §3.7 prohibitions (T6, package side)
// ---------------------------------------------------------------------------

test('doctrine: work-tracking.md self-gates, keeps [verify] markers and the never-install rule (T6)', t => {
  const body = readFileSync(join(root, 'src/references/work-tracking.md'), 'utf8');
  // Self-gate: seats without the session-entry line ignore the file outright.
  assert.match(body, /Read this reference only when session entry says `Work tracker: beads/);
  // §3.7: never installs/initializes/configures beads.
  assert.match(body, /never installs, initializes, upgrades or configures beads/);
  assert.match(body, /do not run\s+`bd init`/i);
  // §3.6: unavailable/uninitialized is a gap, not a block.
  assert.match(body, /gaps?:\s+record the\s+state once/);
  assert.match(body, /never blocks work/);
  // Command syntax stays marked [verify] until a real bd confirms it.
  assert.match(body, /\[verify\]/);
  // Boundaries: evidence not control plane; assignment is authority; no
  // self-claim; tracker status is not proof.
  assert.match(body, /evidence, not a control plane|Evidence, not control plane/);
  assert.match(body, /Authority is the assignment/);
  assert.match(body, /never self-assigns with\s+`bd ready --claim`/);
  assert.match(body, /recorded claim, not proof|Status is a recorded claim/);
  // Writers table: one writer per scope.
  assert.match(body, /Root issue.*Supervisor/s);
  assert.match(body, /Child issues.*Lead/s);
  // Identity: BEADS_ACTOR with the --actor fallback for wrapper transports.
  assert.match(body, /BEADS_ACTOR=slp-<role>-<agent id>/);
  assert.match(body, /--actor slp-<role>-<agent id>/);
});

// ---------------------------------------------------------------------------
// T7 — CLI and plugin roots must resolve the same setting file. The CLI
// adapter exposes { enabled, error }; the plugin also exposes configured.
// ---------------------------------------------------------------------------

test('CLI and plugin adapters preserve root and result-shape contracts (T7)', async t => {
  const plugin = await import('../plugin/server/work-tracker.ts');
  const home = tmpHome(t);
  const stableRoot = join(home, 'slp-runtime');
  const cases = [
    ['absent file', undefined],
    ['enabled', { schemaVersion: 1, tracker: 'beads', enabled: true }, true],
    ['disabled', { schemaVersion: 1, tracker: 'beads', enabled: false }, true],
    ['corrupt JSON', '{corrupt'],
    ['array', [1]],
    ['wrong schemaVersion', { schemaVersion: 2, tracker: 'beads', enabled: true }],
    ['foreign tracker', { schemaVersion: 1, tracker: 'linear', enabled: true }],
    ['non-boolean enabled', { schemaVersion: 1, tracker: 'beads', enabled: 'yes' }],
    ['extra key', { schemaVersion: 1, tracker: 'beads', enabled: true, extra: 1 }],
  ];
  for (const [name, value, configured = false] of cases) {
    if (value === undefined) rmSync(settingPath(home), { force: true });
    else writeSetting(home, value);
    const src = readWorkTrackerSetting(home);
    const plg = plugin.readWorkTrackerSetting(stableRoot);
    assert.deepEqual(src, { enabled: plg.enabled, error: plg.error }, name);
    assert.equal(plg.configured, configured, `${name}: configured`);
  }
  // Both adapters use the same PATH selection on the same fixture.
  const bd = fakeBd(t, {});
  assert.equal(plugin.findBd({ PATH: bd.dir }), findBd({ PATH: bd.dir }));
  assert.equal(plugin.findBd({ PATH: 'relative' }), findBd({ PATH: 'relative' }));
});
