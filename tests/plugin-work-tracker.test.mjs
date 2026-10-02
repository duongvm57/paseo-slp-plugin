// tests/plugin-work-tracker.test.mjs — the beads work-tracker plugin side:
// plugin/server/work-tracker.ts RPC handlers (get/set, atomic 0600 writes,
// HOME_UNVERIFIED on foreign homes, strict input) and live `bd` detection on
// the plugin process PATH — a fake `bd` script on a temp PATH, never a real
// install (no real bd exists on this machine). The reader-adapter check (T7)
// lives in tests/work-tracker.test.mjs next to the package reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORK_TRACKER_FILE,
  beadsSeatEnv,
  createWorkTracker,
  detectBd,
  readWorkTrackerEnabled,
  readWorkTrackerSetting,
} from '../plugin/server/work-tracker.ts';
import { makeHome, targetOf } from './helpers/plugin-doubles.mjs';

const filePath = home => join(home, 'slp-runtime', 'state', 'work-tracker.json');
const stableRoot = home => join(home, 'slp-runtime');
const get = (tracker, home) => tracker.getWorkTracker({ schemaVersion: 1, target: targetOf(home) });
const set = (tracker, home, enabled) => tracker.setWorkTracker({ schemaVersion: 1, target: targetOf(home), enabled });
const writeSetting = (home, value) => {
  mkdirSync(join(home, 'slp-runtime', 'state'), { recursive: true });
  writeFileSync(filePath(home), typeof value === 'string' ? value : JSON.stringify(value));
};

const NO_BD = { PATH: '/definitely-no-bd-here' };

// A fake `bd` executable on a temp PATH — a shell script, never a real
// install. Used only to exercise the PATH-scan + `bd version` detection.
function fakeBd(t, { version = 'bd version 0.21.0 (build abc123)', exit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-bd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bd');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${exit}\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

test('get-work-tracker: absent file is unconfigured+disabled; bd detection degrades to bdError', async t => {
  const home = makeHome(t);
  const tracker = createWorkTracker({ env: { ...NO_BD } });
  const view = (await get(tracker, home)).workTracker;
  assert.equal(existsSync(filePath(home)), false);
  assert.deepEqual(view, {
    configured: false,
    enabled: false,
    error: null,
    bd: null,
    bdError: 'bd not found on PATH — install is a Human action (brew install beads, npm i -g @beads/bd, or the upstream install.sh)',
  });
});

test('set-work-tracker: writes the strict file atomically at 0600 and re-reads the view', async t => {
  const home = makeHome(t);
  const bd = fakeBd(t);
  const tracker = createWorkTracker({ env: { PATH: bd.dir } });
  const on = (await set(tracker, home, true)).workTracker;
  assert.equal(lstatSync(filePath(home)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(filePath(home), 'utf8')), { schemaVersion: 1, tracker: 'beads', enabled: true });
  assert.equal(on.configured, true);
  assert.equal(on.enabled, true);
  assert.equal(on.error, null);
  assert.deepEqual(on.bd, { path: bd.path, version: '0.21.0' });
  assert.equal(on.bdError, null);
  // No tmp siblings survive the atomic write.
  assert.deepEqual(
    readdirSync(join(home, 'slp-runtime', 'state')).filter(name => name.endsWith('.tmp')),
    [],
  );
  const off = (await set(tracker, home, false)).workTracker;
  assert.equal(off.configured, true);
  assert.equal(off.enabled, false);
});

test('get/set reject malformed input and an unverifiable home', async t => {
  const home = makeHome(t);
  const tracker = createWorkTracker({ env: { ...NO_BD } });
  await assert.rejects(() => tracker.getWorkTracker({ schemaVersion: 1 }), /invalid get-work-tracker input/);
  await assert.rejects(() => tracker.setWorkTracker({ schemaVersion: 1, target: targetOf(home), enabled: 'yes' }), /invalid set-work-tracker input/);
  await assert.rejects(() => tracker.setWorkTracker({ schemaVersion: 1, target: targetOf(home), enabled: true, extra: 1 }), /invalid set-work-tracker input/);
  await assert.rejects(() => get(tracker, join(home, 'nonexistent')), /daemon home does not resolve/);
  assert.equal(existsSync(filePath(home)), false, 'a rejected write never creates the file');
});

test('readWorkTrackerSetting: absent/corrupt/foreign shapes match the package contract', t => {
  const home = makeHome(t);
  assert.deepEqual(readWorkTrackerSetting(stableRoot(home)), { enabled: false, error: null, configured: false });
  writeSetting(home, '{corrupt');
  const broken = readWorkTrackerSetting(stableRoot(home));
  assert.equal(broken.enabled, false);
  assert.equal(broken.configured, false);
  assert.match(broken.error, /not valid JSON/);
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: true, extra: 1 });
  const foreign = readWorkTrackerSetting(stableRoot(home));
  assert.equal(foreign.enabled, false);
  assert.match(foreign.error, /unexpected keys: extra/);
  writeSetting(home, { schemaVersion: 1, tracker: 'beads', enabled: true });
  assert.deepEqual(readWorkTrackerSetting(stableRoot(home)), { enabled: true, error: null, configured: true });
  assert.equal(readWorkTrackerEnabled(stableRoot(home)), true);
  // A directory at the file path → EISDIR propagates, like the src reader.
  rmSync(filePath(home));
  mkdirSync(filePath(home));
  assert.throws(() => readWorkTrackerSetting(stableRoot(home)), error => error.code === 'EISDIR');
});

test('detectBd: PATH order, telemetry forced off, failures fill bdError', t => {
  const bd = fakeBd(t);
  const found = detectBd({ PATH: bd.dir });
  assert.deepEqual(found, { bd: { path: bd.path, version: '0.21.0' }, bdError: null });
  const failing = fakeBd(t, { exit: 3 });
  const failed = detectBd({ PATH: failing.dir });
  assert.equal(failed.bd.path, failing.path);
  assert.equal(failed.bd.version, null);
  assert.match(failed.bdError, /bd version failed/);
  const garbage = fakeBd(t, { version: 'not a version' });
  const odd = detectBd({ PATH: garbage.dir });
  assert.equal(odd.bd.version, null);
  assert.match(odd.bdError, /version output unrecognized/);
  assert.equal(detectBd({ PATH: '' }).bd, null);
  assert.match(detectBd({ PATH: '' }).bdError, /bd not found/);
  // The run seam proves telemetry is forced off regardless of ambient env.
  const calls = [];
  detectBd({ PATH: bd.dir, BD_DISABLE_METRICS: '0' }, (file, args, options) => {
    calls.push({ file, args, env: options.env });
    return 'bd version 1.2.3';
  });
  assert.deepEqual(calls.map(c => c.args), [['version']]);
  assert.equal(calls[0].env.BD_DISABLE_METRICS, '1');
});

test('beadsSeatEnv (hook overlay): SLP actor always wins; defaults yield to the env', () => {
  assert.deepEqual(beadsSeatEnv({ role: 'peer', agentId: 'abc', env: {} }), {
    BEADS_ACTOR: 'slp-peer-abc',
    BD_AGENT_PROFILE: 'conservative',
    BD_DISABLE_METRICS: '1',
  });
  const overridden = beadsSeatEnv({ role: 'lead', agentId: 'a1', env: { BEADS_ACTOR: 'human-cli' } });
  assert.equal(overridden.BEADS_ACTOR, 'slp-lead-a1');
  const preserved = beadsSeatEnv({
    role: 'supervisor', agentId: 's9',
    env: { BD_AGENT_PROFILE: 'aggressive', BD_DISABLE_METRICS: '0' },
  });
  assert.deepEqual(preserved, { BEADS_ACTOR: 'slp-supervisor-s9' });
});
