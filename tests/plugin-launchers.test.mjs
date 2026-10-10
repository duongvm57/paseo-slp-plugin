// Offline §13 "Executables / shims" coverage for the launch/runtime lane:
// resolver probes (ordinary Node vs Electron, poisoned env/PATH, explicit
// refusal, missing families), launch-set publish/verify integrity, shell
// quoting, argv0-only --version, runtime tampering, grant/PASEO_AGENT_ID
// non-selection, byte-exact role injection for all five families, and
// exit/signal/backpressure behavior through the real shim subprocess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, delimiter, join } from 'node:path';
import { createExecutableResolver, RUNTIME_CONTROL_ENV_KEYS } from '../plugin/server/executables.ts';
import { createLauncherBuilder } from '../plugin/server/launchers.ts';
import { identity, install } from '../plugin/server/runtime/cli/package.ts';
import { roleInstructions, roleDelivery } from '../plugin/server/runtime/cli/role-bundle.ts';
import { acpRolePrompt, claudeRolePrompt, injectRole, piRoleArgs } from '../plugin/server/runtime/cli/role-transport.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const FAMILIES = ['codex', 'pi', 'devin', 'claude', 'opencode'];
const ROLES = ['supervisor', 'lead', 'peer'];
const sq = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// The shim launches roles under the managed environment it freezes from the
// launch manifest; expected role text must be rendered with that same env.
const managedInstruction = (f, role) =>
  roleInstructions(f.candidate, role, {
    SLP_MANAGED_RUNTIME: '1',
    SLP_NODE_BIN: f.node.path,
    SLP_RUNTIME_ROOT: f.candidate,
    SLP_DAEMON_HOME: f.home,
  });

function tmp(t, prefix = 'launch-') {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/', prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const mkExe = path => {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
};

// A ProbeRunner double: handlers map an already-realpath'd executable path to a
// result or a function producing one. Every call is captured for env/argv
// assertions.
function fakeRun(handlers) {
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const handler = handlers[file];
    if (!handler) return Promise.resolve({ code: 1, stdout: '', stderr: '', error: 'ENOENT (fake)' });
    return Promise.resolve(typeof handler === 'function' ? handler(file, args, options) : handler);
  };
  return { run, calls };
}

const nodeReport = (execPath, overrides = {}) =>
  JSON.stringify({ node: '24.14.0', electron: null, execPath, ...overrides });
const nodeOk = { handle: (file, args) => ({ code: 0, stdout: nodeReport(file), stderr: '' }) };
const versionOut = version => ({ code: 0, stdout: `${version}\n`, stderr: '' });

function resolveDeps(t, overrides = {}) {
  const dir = tmp(t);
  const home = join(dir, 'home');
  const stableRoot = join(home, 'slp-runtime');
  mkdirSync(stableRoot, { recursive: true });
  return {
    request: { daemonHome: home, stableRoot, ...overrides },
    dir,
    home,
    stableRoot,
  };
}

// ---------------------------------------------------------------------------
// Executable resolver
// ---------------------------------------------------------------------------

test('resolver: explicit nodePath is probe-verified ordinary Node', async t => {
  const { request } = resolveDeps(t);
  const node = join(tmp(t), 'my-node');
  mkExe(node);
  const { run, calls } = fakeRun({ [node]: nodeOk.handle });
  const resolver = createExecutableResolver({ run, env: { PATH: '' } });
  const result = await resolver.resolve({ ...request, nodePath: node });
  assert.equal(result.node.path, node);
  assert.equal(result.node.version, '24.14.0');
  assert.equal(calls[0].file, node);
  assert.equal(calls[0].args[0], '-e');
  for (const family of FAMILIES) assert.equal(result.binaries[family].available, false);
});

test('resolver: Electron and old Node probes are rejected, not misread as Node', async t => {
  const { request } = resolveDeps(t);
  const electron = join(tmp(t), 'electronish');
  mkExe(electron);
  const { run } = fakeRun({
    [electron]: file => ({ code: 0, stdout: nodeReport(file, { electron: '37.0.0', node: '24.0.0' }), stderr: '' }),
  });
  const resolver = createExecutableResolver({ run, env: { PATH: '' } });
  await assert.rejects(resolver.resolve({ ...request, nodePath: electron }), error => {
    assert.equal(error.code, 'EXECUTABLE_UNAVAILABLE');
    assert.match(error.message, /Electron/);
    return true;
  });
  const old = join(tmp(t), 'old-node');
  mkExe(old);
  const stale = createExecutableResolver({
    run: fakeRun({ [old]: file => ({ code: 0, stdout: nodeReport(file, { node: '20.9.0' }), stderr: '' }) }).run,
    env: { PATH: '' },
  });
  await assert.rejects(stale.resolve({ ...request, nodePath: old }), /does not satisfy required range/);
});

test('resolver: invalid explicit nodePath refuses without falling back to PATH', async t => {
  const { request } = resolveDeps(t);
  const dir = tmp(t);
  const good = join(dir, 'node');
  mkExe(good);
  const { run, calls } = fakeRun({ [good]: nodeOk.handle });
  const resolver = createExecutableResolver({ run, env: { PATH: dir } });
  await assert.rejects(
    resolver.resolve({ ...request, nodePath: join(dir, 'missing-node') }),
    error => {
      assert.equal(error.code, 'EXECUTABLE_UNAVAILABLE');
      assert.match(error.message, /nodePath/);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'PATH fallback must not run after an explicit failure');
});

test('resolver: native TypeScript floor covers both Node 22 and Node 23 boundaries', async t => {
  const { request } = resolveDeps(t);
  const node = join(tmp(t), 'node-floor');
  mkExe(node);
  for (const [version, supported] of [
    ['22.17.0', false], ['22.18.0', true], ['22.99.0', true],
    ['23.0.0', false], ['23.5.0', false], ['23.6.0', true], ['24.0.0', true],
    ['garbage', false], ['24.0.0-rc.1', false],
  ]) {
    const resolver = createExecutableResolver({
      run: fakeRun({ [node]: file => ({ code: 0, stdout: nodeReport(file, { node: version }), stderr: '' }) }).run,
      env: { PATH: '' },
    });
    if (supported) assert.equal((await resolver.resolve({ ...request, nodePath: node })).node.version, version);
    else await assert.rejects(resolver.resolve({ ...request, nodePath: node }), /does not satisfy required range/);
  }
});

test('resolver: PATH order, absolute-only entries, execPath consistency', async t => {
  const { request } = resolveDeps(t);
  const dir = tmp(t);
  const first = join(dir, 'd1');
  const second = join(dir, 'd2');
  mkdirSync(first);
  mkdirSync(second);
  const n1 = join(first, 'node');
  const n2 = join(second, 'node');
  mkExe(n1);
  mkExe(n2);
  const relativeCwd = 'relative-bin';
  const env = { PATH: ['', relativeCwd, first, second].join(delimiter) };
  const { run, calls } = fakeRun({ [n1]: nodeOk.handle, [n2]: nodeOk.handle });
  const resolver = createExecutableResolver({ run, env });
  const result = await resolver.resolve(request);
  assert.equal(result.node.path, n1, 'first absolute PATH dir wins');
  assert.deepEqual(calls.map(call => call.file), [n1]);

  // A probe whose reported execPath resolves elsewhere is a redirecting shim.
  const shadowed = createExecutableResolver({
    run: fakeRun({ [n1]: () => ({ code: 0, stdout: nodeReport(n2), stderr: '' }), [n2]: nodeOk.handle }).run,
    env: { PATH: first },
  });
  await assert.rejects(shadowed.resolve(request), /EXECUTABLE_UNAVAILABLE|does not match/);
});

test('resolver: prior receipt path preferred, stale prior falls back to PATH', async t => {
  const { request } = resolveDeps(t);
  const dir = tmp(t);
  const priorNode = join(dir, 'prior-node');
  const pathNode = join(dir, 'node');
  mkExe(priorNode);
  mkExe(pathNode);
  const { run } = fakeRun({ [priorNode]: nodeOk.handle, [pathNode]: nodeOk.handle });
  const resolver = createExecutableResolver({ run, env: { PATH: dir } });
  const withPrior = await resolver.resolve({ ...request, prior: { node: { path: priorNode } } });
  assert.equal(withPrior.node.path, priorNode);
  const stale = await resolver.resolve({ ...request, prior: { node: { path: join(dir, 'gone') } } });
  assert.equal(stale.node.path, pathNode);
});

test('resolver: probes strip Paseo/Electron runtime-control vars and NODE_OPTIONS', async t => {
  const { request } = resolveDeps(t);
  const dir = tmp(t);
  const node = join(dir, 'node');
  mkExe(node);
  const poisoned = {
    PATH: dir,
    NODE_OPTIONS: '--inspect-brk',
    PASEO_NODE_ENV: 'test',
    PASEO_DESKTOP_MANAGED: '1',
    PASEO_SUPERVISED: '1',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    ESBUILD_BINARY_PATH: '/evil/esbuild',
    KEEP_ME: 'yes',
  };
  const { run, calls } = fakeRun({ [node]: nodeOk.handle });
  const resolver = createExecutableResolver({ run, env: poisoned });
  await resolver.resolve(request);
  const probeEnv = calls[0].env;
  for (const key of [...RUNTIME_CONTROL_ENV_KEYS, 'NODE_OPTIONS']) {
    assert.equal(probeEnv[key], undefined, `${key} must not reach probes`);
  }
  assert.equal(probeEnv.KEEP_ME, 'yes', 'unrelated environment is preserved');
});

test('resolver: family binaries resolve explicit > PATH > prior; missing stays unavailable', async t => {
  const { request, stableRoot } = resolveDeps(t);
  const dir = tmp(t);
  const node = join(dir, 'node');
  mkExe(node);
  const explicitCodex = join(dir, 'my-codex');
  const priorPi = join(dir, 'prior-pi');
  mkExe(explicitCodex);
  mkExe(priorPi);
  const pathDir = join(dir, 'pathbin');
  mkdirSync(pathDir);
  const pathDevin = join(pathDir, 'devin');
  mkExe(pathDevin);
  const { run } = fakeRun({
    [node]: nodeOk.handle,
    [explicitCodex]: versionOut('codex 9.9.9'),
    [priorPi]: versionOut('pi 1.2.3'),
    [pathDevin]: versionOut('devin 4.5.6'),
  });
  const resolver = createExecutableResolver({ run, env: { PATH: pathDir } });
  const result = await resolver.resolve({
    ...request,
    nodePath: node,
    binaries: { codex: explicitCodex },
    prior: { binaries: { pi: { available: true, path: priorPi, version: 'pi 1.2.3' } } },
  });
  assert.deepEqual(result.binaries.codex, { available: true, path: explicitCodex, version: 'codex 9.9.9' });
  assert.deepEqual(result.binaries.pi, { available: true, path: priorPi, version: 'pi 1.2.3' });
  assert.deepEqual(result.binaries.devin, { available: true, path: pathDevin, version: 'devin 4.5.6' });
  assert.deepEqual(result.binaries.claude, { available: false, path: null, version: null });

  // A newly installed PATH binary replaces a still-working old receipt pin
  // on re-activation. If PATH has no candidate, the prior remains usable.
  const preferred = await resolver.resolve({
    ...request, nodePath: node,
    prior: { binaries: { devin: { available: true, path: priorPi, version: 'pi 1.2.3' } } },
  });
  assert.equal(preferred.binaries.devin.path, pathDevin);

  // Explicit binary that is actually the Node executable is an error.
  await assert.rejects(
    resolver.resolve({ ...request, nodePath: node, binaries: { codex: node } }),
    /Node\.js executable|usable codex/,
  );
  // A PATH binary resolving inside the SLP runtime root is skipped.
  const inside = join(stableRoot, 'launchers', 'fake-set');
  mkdirSync(inside, { recursive: true });
  const inner = join(inside, 'claude');
  mkExe(inner);
  const innerRun = createExecutableResolver({
    run: fakeRun({ [node]: nodeOk.handle, [inner]: versionOut('claude 0.0') }).run,
    env: { PATH: inside },
  });
  const res = await innerRun.resolve({ ...request, nodePath: node });
  assert.equal(res.binaries.claude.available, false);
});

test('resolver: _versions layout records the vendor current handle, healing stale prior pins', async t => {
  const { request } = resolveDeps(t);
  const dir = tmp(t);
  const node = join(dir, 'node');
  mkExe(node);
  // Devin-style self-updating layout: _versions/<ver>/bin/<bin>, `current` symlink.
  const versions = join(dir, 'cli', '_versions');
  mkdirSync(join(versions, '3000.10.31', 'bin'), { recursive: true });
  mkdirSync(join(versions, '3000.11.1', 'bin'), { recursive: true });
  const stale = join(versions, '3000.10.31', 'bin', 'devin');
  const fresh = join(versions, '3000.11.1', 'bin', 'devin');
  mkExe(stale);
  mkExe(fresh);
  symlinkSync('3000.11.1', join(versions, 'current'));
  const tracked = join(versions, 'current', 'bin', 'devin');
  const shimDir = join(dir, 'pathbin');
  mkdirSync(shimDir);
  symlinkSync(tracked, join(shimDir, 'devin'));
  const { run, calls } = fakeRun({
    [node]: nodeOk.handle,
    [join(shimDir, 'devin')]: versionOut('devin 3000.11.1'),
    [tracked]: versionOut('devin 3000.11.1'),
    [stale]: versionOut('devin 3000.10.31'),
    [fresh]: versionOut('devin 3000.11.1'),
  });
  const resolver = createExecutableResolver({ run, env: { PATH: shimDir } });

  // PATH resolution preserves the stable PATH alias.
  const result = await resolver.resolve({ ...request, nodePath: node });
  assert.deepEqual(result.binaries.devin, { available: true, path: join(shimDir, 'devin'), version: 'devin 3000.11.1' });
  assert.ok(calls.some(call => call.file === join(shimDir, 'devin')), 'probe runs through the stable alias');

  // A prior pin on a superseded release still heals to `current` on rebind —
  // the versioned file keeps probing fine, so without the handle the stale
  // version would win forever.
  const rebound = await resolver.resolve({
    ...request,
    nodePath: node,
    prior: { binaries: { devin: { available: true, path: stale, version: 'devin 3000.10.31' } } },
  });
  assert.equal(rebound.binaries.devin.path, join(shimDir, 'devin'));
  assert.equal(rebound.binaries.devin.version, 'devin 3000.11.1');

  // Without a PATH alias, the known vendor current handle heals the pin.
  const noPath = createExecutableResolver({ run, env: { PATH: '' } });
  const healed = await noPath.resolve({
    ...request, nodePath: node,
    prior: { binaries: { devin: { available: true, path: stale, version: 'devin 3000.10.31' } } },
  });
  assert.equal(healed.binaries.devin.path, tracked);

  // A `_versions` path with no `current` sibling keeps the realpath pin.
  const orphanDir = join(dir, 'orphan', '_versions', '9.9.9', 'bin');
  mkdirSync(orphanDir, { recursive: true });
  const orphan = join(orphanDir, 'codex');
  mkExe(orphan);
  const orphanRun = createExecutableResolver({
    run: fakeRun({ [node]: nodeOk.handle, [orphan]: versionOut('codex 9.9.9') }).run,
    env: { PATH: '' },
  });
  const orphanRes = await orphanRun.resolve({ ...request, nodePath: node, binaries: { codex: orphan } });
  assert.equal(orphanRes.binaries.codex.path, orphan);
});

test('resolver: Codex standalone releases follow the verified current handle on rebind', async t => {
  const { request } = resolveDeps(t);
  const dir = tmp(t);
  const node = join(dir, 'node');
  mkExe(node);
  const standalone = join(dir, 'standalone');
  const releases = join(standalone, 'releases');
  const oldDir = join(releases, '0.154.0', 'bin');
  const newDir = join(releases, '0.155.1', 'bin');
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  const oldCodex = join(oldDir, 'codex');
  const newCodex = join(newDir, 'codex');
  mkExe(oldCodex);
  mkExe(newCodex);
  symlinkSync(join(releases, '0.155.1'), join(standalone, 'current'));
  const currentCodex = join(standalone, 'current', 'bin', 'codex');
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  symlinkSync(currentCodex, join(binDir, 'codex'));
  const { run, calls } = fakeRun({
    [node]: nodeOk.handle,
    [join(binDir, 'codex')]: versionOut('codex-cli 0.155.1'),
    [oldCodex]: versionOut('codex-cli 0.154.0'),
    [newCodex]: versionOut('codex-cli 0.155.1'),
    [currentCodex]: versionOut('codex-cli 0.155.1'),
  });
  const resolver = createExecutableResolver({ run, env: { PATH: binDir } });
  const initial = await resolver.resolve({ ...request, nodePath: node });
  assert.deepEqual(initial.binaries.codex, {
    available: true, path: join(binDir, 'codex'), version: 'codex-cli 0.155.1',
  });
  const rebound = await resolver.resolve({
    ...request,
    nodePath: node,
    prior: { binaries: { codex: { available: true, path: oldCodex, version: 'codex-cli 0.154.0' } } },
  });
  assert.deepEqual(rebound.binaries.codex, initial.binaries.codex);
  assert.ok(calls.some(call => call.file === join(binDir, 'codex')));
  const noPath = createExecutableResolver({ run, env: { PATH: '' } });
  const healed = await noPath.resolve({
    ...request, nodePath: node,
    prior: { binaries: { codex: { available: true, path: oldCodex, version: 'codex-cli 0.154.0' } } },
  });
  assert.equal(healed.binaries.codex.path, currentCodex);
  const explicitPin = await resolver.resolve({
    ...request, nodePath: node, binaries: { codex: oldCodex },
  });
  assert.deepEqual(explicitPin.binaries.codex, {
    available: true, path: oldCodex, version: 'codex-cli 0.154.0',
  });
});

test('resolver: stable PATH aliases follow updates for all five families', async t => {
  const { request } = resolveDeps(t);
  const dir = tmp(t);
  const node = join(dir, 'node');
  mkExe(node);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const handlers = { [node]: nodeOk.handle };
  for (const family of FAMILIES) {
    const oldPath = join(dir, family, 'v1', family);
    const newPath = join(dir, family, 'v2', family);
    mkdirSync(join(dir, family, 'v1'), { recursive: true });
    mkdirSync(join(dir, family, 'v2'), { recursive: true });
    mkExe(oldPath);
    mkExe(newPath);
    const alias = join(bin, family);
    symlinkSync(oldPath, alias);
    handlers[alias] = () => versionOut(`${family} ${realpathSync(alias) === oldPath ? '2.0.24' : '2.0.25'}`);
  }
  const resolver = createExecutableResolver({ run: fakeRun(handlers).run, env: { PATH: bin } });
  const before = await resolver.resolve({ ...request, nodePath: node });
  for (const family of FAMILIES) {
    assert.deepEqual(before.binaries[family], {
      available: true, path: join(bin, family), version: `${family} 2.0.24`,
    });
    rmSync(join(bin, family));
    symlinkSync(join(dir, family, 'v2', family), join(bin, family));
  }
  const after = await resolver.resolve({ ...request, nodePath: node, prior: before });
  for (const family of FAMILIES) {
    assert.deepEqual(after.binaries[family], {
      available: true, path: join(bin, family), version: `${family} 2.0.25`,
    });
  }
});

test('resolver: explicit invalid family binary is a conflict, not silent unavailability', async t => {
  const { request } = resolveDeps(t);
  const node = join(tmp(t), 'node');
  mkExe(node);
  const { run } = fakeRun({ [node]: nodeOk.handle });
  const resolver = createExecutableResolver({ run, env: { PATH: '' } });
  await assert.rejects(
    resolver.resolve({ ...request, nodePath: node, binaries: { claude: '/nonexistent/claude' } }),
    error => {
      assert.equal(error.code, 'EXECUTABLE_UNAVAILABLE');
      assert.match(error.message, /binaries\.claude/);
      return true;
    },
  );
});

test('resolver: win32 is fail-closed UNSUPPORTED_PLATFORM', async t => {
  const { request } = resolveDeps(t);
  const resolver = createExecutableResolver({ platform: 'win32', env: { PATH: '' } });
  await assert.rejects(resolver.resolve(request), error => {
    assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
    return true;
  });
});

test('resolver: real probe of process.execPath parses and resolves it', async t => {
  // No fake run: this exercises defaultRun (timeout/maxBuffer/error mapping),
  // NODE_PROBE_SCRIPT and executableRealpath against the live Node binary.
  const { request } = resolveDeps(t);
  const resolver = createExecutableResolver({ env: { PATH: '' } });
  const result = await resolver.resolve({ ...request, nodePath: process.execPath });
  assert.equal(result.node.path, realpathSync(process.execPath));
  assert.equal(result.node.version, process.versions.node);
  for (const family of FAMILIES) assert.equal(result.binaries[family].available, false);
});

test('resolver: oversized version strings are bounded, never recorded', async t => {
  const { request } = resolveDeps(t);
  const dir = tmp(t);
  const node = join(dir, 'node');
  mkExe(node);
  const codex = join(dir, 'codex');
  mkExe(codex);
  const huge = `codex ${'9'.repeat(1000)}`;
  const { run } = fakeRun({ [node]: nodeOk.handle, [codex]: versionOut(huge) });
  const resolver = createExecutableResolver({ run, env: { PATH: dir } });
  // A PATH-resolved binary emitting a degenerate --version is skipped →
  // unavailable, so nothing oversized reaches the recorded resolution.
  const result = await resolver.resolve({ ...request, nodePath: node });
  assert.deepEqual(result.binaries.codex, { available: false, path: null, version: null });
  // An explicit binary with an oversized --version is a conflict, not silence.
  await assert.rejects(
    resolver.resolve({ ...request, nodePath: node, binaries: { codex } }),
    error => {
      assert.equal(error.code, 'EXECUTABLE_UNAVAILABLE');
      assert.match(error.message, /256/);
      return true;
    },
  );
  // The same bound covers the Node probe report's version field.
  const giant = createExecutableResolver({
    run: fakeRun({
      [node]: file => ({ code: 0, stdout: nodeReport(file, { node: `24.${'1'.repeat(300)}` }), stderr: '' }),
    }).run,
    env: { PATH: '' },
  });
  await assert.rejects(giant.resolve({ ...request, nodePath: node }), /256/);
});

// ---------------------------------------------------------------------------
// Launch-set builder
// ---------------------------------------------------------------------------

const UNAVAILABLE = { available: false, path: null, version: null };
const fakeBinary = (path, version = '9.9.9-fake') => ({ available: true, path, version });

async function fixtureRuntime(t, options = {}) {
  const dir = tmp(t, 'launch dir-');
  const home = join(dir, 'home');
  const stableRoot = join(home, 'slp-runtime');
  const sha = identity(root).sha256;
  const candidate = join(stableRoot, sha);
  install(root, candidate);
  const fakeDir = join(dir, 'provider-bin');
  mkdirSync(fakeDir, { recursive: true });
  const capture = { dir };
  const binaries = {};
  for (const family of FAMILIES) {
    if (options.missing === family) {
      binaries[family] = UNAVAILABLE;
      continue;
    }
    binaries[family] = fakeBinary(writeFakeBinary(fakeDir, family, dir));
  }
  const node = options.node ?? { path: process.execPath, version: process.versions.node };
  const launchers = createLauncherBuilder();
  const set = await launchers.publish({
    daemonHome: home,
    stableRoot,
    operationId: options.operationId ?? 'op-fixture-1',
    candidate: { sha256: sha, runtimePath: candidate },
    node,
    binaries,
  });
  const manifestPath = join(set.directory, 'launch.json');
  return { dir, home, stableRoot, sha, candidate, set, manifestPath, binaries, node, launchers, capture };
}

// A fake family executable: records argv and selected env, answers --version,
// sleeps on `hold`, exits 3 on `exit3`, otherwise echoes stdin (protocol mode).
function writeFakeBinary(dir, family, workdir) {
  const path = join(dir, family);
  const argvCapture = join(workdir, `${family}.argv`);
  const envCapture = join(workdir, `${family}.env`);
  const keys = [
    'SLP_SESSION_OPEN_GRANT', 'SLP_CODEX_BIN', 'SLP_PI_BIN', 'SLP_DEVIN_BIN', 'SLP_CLAUDE_BIN',
    'SLP_RUNTIME_ROOT', 'SLP_NODE_BIN', 'SLP_DAEMON_HOME', 'PASEO_HOME', 'SLP_MANAGED_RUNTIME',
    'PASEO_AGENT_ID', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS',
  ];
  writeFileSync(path, `#!/bin/sh
printf '%s\\0' "$@" > ${sq(argvCapture)}
{
for k in ${keys.join(' ')}; do
  if printenv "$k" >/dev/null 2>&1; then printf '%s=%s\\n' "$k" "$(printenv "$k")"; else printf '%s=<unset>\\n' "$k"; fi
done
} > ${sq(envCapture)}
for a in "$@"; do
  if [ "$a" = "hold" ]; then exec sleep 60; fi
  if [ "$a" = "exit3" ]; then exit 3; fi
done
if [ "$1" = "--version" ]; then printf '${family} ${family === 'opencode' ? '2.0.24' : '9.9.9-fake'}\\n'; exit 0; fi
cat
`);
  chmodSync(path, 0o755);
  return path;
}

const readArgv = path => {
  const parts = readFileSync(path).toString('utf8').split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
};
const readEnv = path =>
  Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }));

test('launchers: legacy4 manifest bytes verify unchanged; mixed, partial and unknown domains fail closed', async t => {
  const f = await fixtureRuntime(t);
  const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
  manifest.families = ['codex', 'pi', 'devin', 'claude'];
  manifest.launcherFamilies = [...manifest.families];
  manifest.gateFamilies = ['codex', 'pi', 'claude'];
  delete manifest.binaries.opencode;
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  const digest = createHash('sha256').update(bytes).digest('hex');
  const directory = join(f.stableRoot, 'launchers', digest); mkdirSync(directory);
  writeFileSync(join(directory, 'launch.json'), bytes, { mode: 0o644 });
  for (const family of manifest.families) for (const role of ROLES) {
    const name = `slp-${family}-${role}`;
    const original = readFileSync(join(f.set.directory, name), 'utf8');
    const legacyBytes = original.replaceAll(f.set.directory, directory).replaceAll(f.set.launchManifestSha256, digest);
    writeFileSync(join(directory, name), legacyBytes, { mode: 0o755 });
  }
  const before = readFileSync(join(directory, 'launch.json'));
  const verified = await f.launchers.verify(directory);
  assert.equal(verified.launchSetSha256, digest); assert.equal(verified.files.length, 12);
  assert.deepEqual(readFileSync(join(directory, 'launch.json')), before);
  for (const mutate of [
    m => { m.binaries.opencode = { available: false, path: null, version: null }; },
    m => { m.families.pop(); },
    m => { m.families[0] = 'unknown'; },
    m => { m.launcherFamilies.push('opencode'); },
    m => { m.gateFamilies.push('opencode'); },
    m => { m.binaries.codex.available = 'yes'; },
  ]) {
    const bad = structuredClone(manifest); mutate(bad);
    const encoded = JSON.stringify(bad, null, 2) + '\n'; const sha = createHash('sha256').update(encoded).digest('hex');
    const path = join(f.stableRoot, 'launchers', sha); mkdirSync(path); writeFileSync(join(path, 'launch.json'), encoded, { mode: 0o600 });
    await assert.rejects(f.launchers.verify(path), error => error.code === 'RUNTIME_INTEGRITY');
    assert.equal(readFileSync(join(path, 'launch.json'), 'utf8'), encoded);
  }
  const binaries = structuredClone(f.binaries); delete binaries.opencode;
  await assert.rejects(f.launchers.publish({ daemonHome: f.home, stableRoot: f.stableRoot, operationId: 'bad-legacy-publish', candidate: { sha256: f.sha, runtimePath: f.candidate }, node: f.node, binaries }), /missing a binaries.opencode resolution/);
});

test('launchers: publish writes manifest + 15 quoted launchers (12 gate + 3 shim), verify round-trips', async t => {
  const f = await fixtureRuntime(t);
  assert.equal(basename(f.set.directory), f.set.launchSetSha256);
  assert.equal(f.set.launchManifestSha256, f.set.launchSetSha256);
  const manifest = JSON.parse(readFileSync(f.manifestPath).toString('utf8'));
  assert.equal(manifest.schemaVersion, 1);
  // The manifest keeps the full five-family resolution record — the shipped
  // devin shim validates the complete sets — and records which families are
  // gate execs vs shim launchers.
  assert.deepEqual(manifest.families.sort(), [...FAMILIES].sort());
  assert.deepEqual(manifest.launcherFamilies.sort(), [...FAMILIES].sort());
  assert.deepEqual(manifest.gateFamilies.sort(), ['claude', 'codex', 'pi']);
  const names = readdirSync(f.set.directory).sort();
  assert.equal(names.length, 16);
  assert.deepEqual(
    f.set.files.map(file => basename(file.path)).sort(),
    FAMILIES.flatMap(family => ROLES.map(role => `slp-${family}-${role}`)).sort(),
  );
  for (const file of f.set.files) assert.equal(file.mode, 0o755);
  const verified = await f.launchers.verify(f.set.directory);
  assert.equal(verified.launchSetSha256, f.set.launchSetSha256);
  // Deterministic: a second publish of identical inputs reuses the same set.
  const again = await f.launchers.publish({
    daemonHome: f.home,
    stableRoot: f.stableRoot,
    operationId: 'op-fixture-2',
    candidate: { sha256: f.sha, runtimePath: f.candidate },
    node: f.node,
    binaries: f.binaries,
  });
  assert.equal(again.launchSetSha256, f.set.launchSetSha256);
  // Exact shim launcher bytes (devin): NODE_OPTIONS unset for the shim's own
  // node boot, fixed args single-quoted, -- separator, "$@" verbatim.
  const shimLauncher = readFileSync(join(f.set.directory, 'slp-devin-peer'), 'utf8');
  const shimExpected =
    '#!/bin/sh\n' +
    'unset NODE_OPTIONS\n' +
    `exec ${sq(f.node.path)} ${sq(join(f.candidate, 'bin', 'slp-shim.mjs'))} ` +
    `${sq(f.manifestPath)} ${sq(f.set.launchManifestSha256)} 'devin' 'peer' -- "$@"\n`;
  assert.equal(shimLauncher, shimExpected);
  // Exact gate launcher bytes (hook families): the frozen SLP_FAMILY_BIN is
  // exported so the env-free argv0 --version probe still reaches the real
  // binary, then the candidate's gate runs under the frozen Node.
  for (const family of ['codex', 'pi', 'claude']) {
    const gate = readFileSync(join(f.set.directory, `slp-${family}-lead`), 'utf8');
    const gateExpected =
      '#!/bin/sh\n' +
      'unset NODE_OPTIONS\n' +
      `export SLP_FAMILY_BIN=${sq(f.binaries[family].path)}\n` +
      `exec ${sq(f.node.path)} ${sq(join(f.candidate, 'bin', 'slp-gate.mjs'))} "$@"\n`;
    assert.equal(gate, gateExpected, `gate launcher for ${family}`);
  }
});

test('launchers: the desk-bridge pin is recorded in the manifest and projected by verify', async t => {
  const f = await fixtureRuntime(t);
  const bridgeBytes = readFileSync(join(f.candidate, 'bin', 'slp-desk-mcp.mjs'));
  const expectedSha = createHash('sha256').update(bridgeBytes).digest('hex');
  const manifest = JSON.parse(readFileSync(f.manifestPath).toString('utf8'));
  assert.equal(manifest.bridgeSha256, expectedSha);
  assert.equal(manifest.bridgeProtocolVersion, 'slp-desk-bridge/1');
  const verified = await f.launchers.verify(f.set.directory);
  assert.equal(verified.bridgeSha256, expectedSha);
  assert.equal(verified.bridgeProtocolVersion, 'slp-desk-bridge/1');
});

test('launchers: verify refuses a malformed or wrong bridge pin', async t => {
  // The digest check binds the directory name to launch.json bytes, so a
  // schema-level pin violation is exercised through a self-digested set:
  // same launcher members, launch.json carrying the bad field, directory
  // named the tampered manifest's own digest.
  const f = await fixtureRuntime(t);
  const manifest = JSON.parse(readFileSync(f.manifestPath).toString('utf8'));
  const members = readdirSync(f.set.directory).filter(name => name !== 'launch.json');
  for (const [field, value] of [
    ['bridgeSha256', 'not-a-sha'],
    ['bridgeProtocolVersion', 'slp-desk-bridge/2'],
  ]) {
    const bytes = Buffer.from(JSON.stringify({ ...manifest, [field]: value }));
    const dir = join(f.stableRoot, 'launchers', createHash('sha256').update(bytes).digest('hex'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'launch.json'), bytes);
    for (const name of members) {
      writeFileSync(join(dir, name), readFileSync(join(f.set.directory, name)), { mode: 0o755 });
    }
    await assert.rejects(f.launchers.verify(dir), error => {
      assert.equal(error.code, 'RUNTIME_INTEGRITY');
      return true;
    });
  }
  // The untampered set still verifies.
  const verified = await f.launchers.verify(f.set.directory);
  assert.equal(verified.bridgeSha256, manifest.bridgeSha256);
});

test('launchers: a candidate without the bridge binary publishes no pin', async t => {
  const f = await fixtureRuntime(t);
  rmSync(join(f.candidate, 'bin', 'slp-desk-mcp.mjs'));
  // Re-hash the candidate identity after removal: the package identity
  // covers candidate bytes, so publish a fresh candidate without the file.
  const noSha = 'f'.repeat(64);
  const noCandidate = join(f.stableRoot, noSha);
  install(root, noCandidate);
  rmSync(join(noCandidate, 'bin', 'slp-desk-mcp.mjs'));
  const set = await f.launchers.publish({
    daemonHome: f.home,
    stableRoot: f.stableRoot,
    operationId: 'op-nobridge',
    candidate: { sha256: noSha, runtimePath: noCandidate },
    node: f.node,
    binaries: f.binaries,
  });
  const manifest = JSON.parse(readFileSync(join(set.directory, 'launch.json')).toString('utf8'));
  assert.equal(manifest.bridgeSha256, undefined);
  assert.equal(manifest.bridgeProtocolVersion, undefined);
  const verified = await f.launchers.verify(set.directory);
  assert.equal(verified.bridgeSha256, undefined);
});

test('launchers: publish refuses symlink or non-directory staging paths', async t => {
  const f = await fixtureRuntime(t);
  const launchers = createLauncherBuilder();
  // A different node version changes the manifest digest, so publish cannot
  // take the verified-set early return and must reach the staging path.
  const request = {
    daemonHome: f.home,
    stableRoot: f.stableRoot,
    operationId: 'op-symlink',
    candidate: { sha256: f.sha, runtimePath: f.candidate },
    node: { path: f.node.path, version: '0.0.0-staging' },
    binaries: f.binaries,
  };
  // A symlink at .staging/<opId> is never traversed or removed.
  const outside = join(f.dir, 'outside');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(f.stableRoot, '.staging'), { recursive: true });
  symlinkSync(outside, join(f.stableRoot, '.staging', 'op-symlink'));
  await assert.rejects(launchers.publish(request), error => {
    assert.equal(error.code, 'RUNTIME_INTEGRITY');
    return true;
  });
  assert.ok(existsSync(outside), 'symlink target untouched');
  // Same rule for a pre-placed symlink at the launch-set leaf.
  const opDir = join(f.stableRoot, '.staging', 'op-leaf');
  mkdirSync(opDir, { recursive: true });
  symlinkSync(outside, join(opDir, 'launch-set'));
  await assert.rejects(
    launchers.publish({ ...request, operationId: 'op-leaf' }),
    error => {
      assert.equal(error.code, 'RUNTIME_INTEGRITY');
      return true;
    },
  );
});

test('launchers: verify rejects tampering, extras and mode drift', async t => {
  const f = await fixtureRuntime(t);
  const one = join(f.set.directory, 'slp-devin-lead');
  appendFileSync(one, '# tampered\n');
  await assert.rejects(f.launchers.verify(f.set.directory), error => {
    assert.equal(error.code, 'RUNTIME_INTEGRITY');
    return true;
  });
  const f2 = await fixtureRuntime(t);
  writeFileSync(join(f2.set.directory, 'extra'), 'x');
  await assert.rejects(f2.launchers.verify(f2.set.directory), /unexpected launch-set member/);
  const f3 = await fixtureRuntime(t);
  appendFileSync(f3.manifestPath, '\n');
  await assert.rejects(f3.launchers.verify(f3.set.directory), /does not match its manifest digest/);
  const f4 = await fixtureRuntime(t);
  chmodSync(join(f4.set.directory, 'slp-devin-peer'), 0o644);
  await assert.rejects(f4.launchers.verify(f4.set.directory), /mode 644/);
});

test('launchers: verify rejects symlink members and special mode bits', async t => {
  // A member replaced by a symlink — even to byte-identical content outside
  // the immutable directory — is not a regular file and must be rejected.
  const f = await fixtureRuntime(t);
  const member = join(f.set.directory, 'slp-devin-peer');
  const bytes = readFileSync(member);
  const outside = join(f.dir, 'launcher-copy');
  writeFileSync(outside, bytes, { mode: 0o755 });
  rmSync(member);
  symlinkSync(outside, member);
  await assert.rejects(f.launchers.verify(f.set.directory), error => {
    assert.equal(error.code, 'RUNTIME_INTEGRITY');
    return true;
  });
  // Special bits (setuid here) must not be masked away: 04755 != 0755.
  const f2 = await fixtureRuntime(t);
  chmodSync(join(f2.set.directory, 'slp-devin-supervisor'), 0o4755);
  await assert.rejects(f2.launchers.verify(f2.set.directory), error => {
    assert.equal(error.code, 'RUNTIME_INTEGRITY');
    return true;
  });
});

test('launchers: verify rejects symlinked set dir, symlinked ancestors, wrong-identity real dir', async t => {
  const f = await fixtureRuntime(t);
  // A second real set in the same stable root (different manifest → new digest).
  const other = await f.launchers.publish({
    daemonHome: f.home,
    stableRoot: f.stableRoot,
    operationId: 'op-other',
    candidate: { sha256: f.sha, runtimePath: f.candidate },
    node: { path: f.node.path, version: '2.0.0-other' },
    binaries: f.binaries,
  });
  assert.notEqual(other.directory, f.set.directory);

  // (a) The set directory itself replaced by a symlink to the other set:
  // verify must reject, never silently verify the wrong identity.
  rmSync(other.directory, { recursive: true });
  symlinkSync(f.set.directory, other.directory);
  await assert.rejects(f.launchers.verify(other.directory), error => {
    assert.equal(error.code, 'RUNTIME_INTEGRITY');
    return true;
  });
  rmSync(other.directory); // removes the link itself; the target is untouched
  assert.ok(existsSync(f.manifestPath));

  // (b) A symlinked ancestor is rejected just the same — launchers/ here.
  const sr2 = join(f.dir, 'second-root');
  const outsideLaunchers = join(f.dir, 'outside-launchers');
  mkdirSync(join(outsideLaunchers, 'a'.repeat(64)), { recursive: true });
  mkdirSync(sr2);
  symlinkSync(outsideLaunchers, join(sr2, 'launchers'));
  await assert.rejects(
    f.launchers.verify(join(sr2, 'launchers', 'a'.repeat(64))),
    error => {
      assert.equal(error.code, 'RUNTIME_INTEGRITY');
      return true;
    },
  );
  // And a symlinked stable root one level above that.
  const home2 = join(f.dir, 'home2');
  const outsideRoot = join(f.dir, 'outside-root');
  mkdirSync(join(outsideRoot, 'launchers', 'b'.repeat(64)), { recursive: true });
  mkdirSync(home2);
  symlinkSync(outsideRoot, join(home2, 'slp-runtime'));
  await assert.rejects(
    f.launchers.verify(join(home2, 'slp-runtime', 'launchers', 'b'.repeat(64))),
    error => {
      assert.equal(error.code, 'RUNTIME_INTEGRITY');
      return true;
    },
  );

  // (c) A REAL directory holding a valid set under the wrong name is also
  // rejected: the returned identity is bound to the directory basename.
  const f2 = await fixtureRuntime(t);
  const wrong = join(f2.stableRoot, 'launchers', 'f'.repeat(64));
  renameSync(f2.set.directory, wrong);
  await assert.rejects(f2.launchers.verify(wrong), error => {
    assert.equal(error.code, 'RUNTIME_INTEGRITY');
    return true;
  });
});

test('launchers: publish is fail-closed on win32', async t => {
  const f = await fixtureRuntime(t);
  const win = createLauncherBuilder({ platform: 'win32' });
  await assert.rejects(
    win.publish({
      daemonHome: f.home,
      stableRoot: f.stableRoot,
      operationId: 'op-win',
      candidate: { sha256: f.sha, runtimePath: f.candidate },
      node: f.node,
      binaries: f.binaries,
    }),
    error => {
      assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
      return true;
    },
  );
  await assert.rejects(win.verify(f.set.directory), error => {
    assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
    return true;
  });
});

test('launchers: POSIX single-quote escaping survives spaces and quotes end-to-end', async t => {
  const dir = tmp(t, "quote'd dir-");
  const home = join(dir, 'home');
  const stableRoot = join(home, 'slp-runtime');
  const sha = identity(root).sha256;
  const candidate = join(stableRoot, sha);
  install(root, candidate);
  const weirdDir = join(dir, "we'ird node");
  mkdirSync(weirdDir, { recursive: true });
  const fakeNode = join(weirdDir, 'node bin');
  const argvCapture = join(dir, 'captured.argv');
  const optionsFlag = join(dir, 'node-options.flag');
  writeFileSync(
    fakeNode,
    `#!/bin/sh\nprintf '%s\\0' "$@" > ${sq(argvCapture)}\n` +
      `if printenv NODE_OPTIONS >/dev/null 2>&1; then printf set > ${sq(optionsFlag)}; else printf unset > ${sq(optionsFlag)}; fi\n`,
  );
  chmodSync(fakeNode, 0o755);
  const launchers = createLauncherBuilder();
  const set = await launchers.publish({
    daemonHome: home,
    stableRoot,
    operationId: 'op-quote',
    candidate: { sha256: sha, runtimePath: candidate },
    node: { path: fakeNode, version: '99.0.0' },
    binaries: Object.fromEntries(FAMILIES.map(family => [family, UNAVAILABLE])),
  });
  const userArgs = ['two words', "it's", '--', ''];
  const result = spawnSync(join(set.directory, 'slp-devin-peer'), userArgs, {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require /nonexistent/evil.cjs' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(optionsFlag, 'utf8'), 'unset', 'launcher unsets NODE_OPTIONS before node boots');
  const expected = [
    join(candidate, 'bin', 'slp-shim.mjs'),
    join(set.directory, 'launch.json'),
    set.launchManifestSha256,
    'devin',
    'peer',
    '--',
    ...userArgs,
  ];
  assert.deepEqual(readArgv(argvCapture), expected);
});

test('gate launcher: env-free argv0 --version reaches the real family binary; grantless session spawn fails closed', async t => {
  // M1 regression coverage: the host probe invokes command[0] --version with
  // provider env entirely absent — the launcher's baked SLP_FAMILY_BIN is
  // what lets the gate answer through the real binary. A capability probe
  // launching the same argv without PASEO_AGENT_ID is a non-session launch
  // and passes through; only a daemon-stamped session spawn requires the
  // grant.
  const f = await fixtureRuntime(t);
  for (const family of ['codex', 'pi', 'claude']) {
    const probe = spawnSync(join(f.set.directory, `slp-${family}-peer`), ['--version'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' }, // no provider env at all
    });
    assert.equal(probe.status, 0, `${family} probe stderr: ${probe.stderr}`);
    assert.equal(probe.stdout, `${family} ${family === 'opencode' ? '2.0.24' : '9.9.9-fake'}\n`, `${family} probe reports the family binary`);
    const capability = spawnSync(join(f.set.directory, `slp-${family}-peer`), ['chat'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.equal(capability.status, 0, `${family} non-session launch passes through: ${capability.stderr}`);
    const spawn_ = spawnSync(join(f.set.directory, `slp-${family}-peer`), ['chat'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', PASEO_AGENT_ID: 'agent-1' },
    });
    assert.notEqual(spawn_.status, 0);
    assert.match(spawn_.stderr, /managed session launched without live SLP hook grant/);
  }
});

// ---------------------------------------------------------------------------
// Shim subprocess behavior (real Node + real candidate + fake family binaries)
// ---------------------------------------------------------------------------

const shimEnv = { PATH: '/usr/bin:/bin' };

function runShim(fixture, family, role, args, options = {}) {
  const shim = join(fixture.candidate, 'bin', 'slp-shim.mjs');
  return runNode([shim, fixture.manifestPath, fixture.set.launchManifestSha256, family, role, '--', ...args], options);
}

function runNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    env: options.env ?? shimEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  if (options.input !== undefined) {
    child.stdin.write(options.input);
    child.stdin.end();
  } else if (options.stdin !== false) {
    child.stdin.end();
  }
  const done = new Promise(resolvePromise =>
    child.on('close', (code, signal) =>
      resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })));
  return { child, done };
}

// Readiness handshake for the signal test: writes one protocol frame and
// resolves once its echo comes back through the shim's stdout. The fake
// binary's argv marker only proves the grandchild forked — the wrapper
// installs its signal-forwarding handlers in the synchronous turn after
// spawn(), so under parallel load the marker can appear while the shim still
// has the default SIGTERM disposition and dies instead of forwarding. A
// protocol echo can only come back after wrapper module evaluation finished,
// and the handlers are registered before the readline loop — so one
// round-trip proves the shim can actually receive a forwarded signal. Fails
// fast if the child exits first; kills the child on timeout.
async function waitForProtocolEcho(held, frame, timeoutMs = 15000) {
  let buf = '';
  let exited = false;
  const onData = chunk => { buf += chunk; };
  held.child.stdout.on('data', onData);
  held.child.stdin.on('error', () => {});
  held.child.once('exit', () => { exited = true; });
  try {
    held.child.stdin.write(frame);
    const deadline = Date.now() + timeoutMs;
    while (!buf.includes('\n')) {
      if (exited) {
        const result = await held.done;
        throw new Error(
          `shim exited before the protocol echo (code=${result.code} signal=${result.signal}): ${result.stderr.trim()}`);
      }
      if (Date.now() > deadline) throw new Error(`no protocol echo within ${timeoutMs}ms`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return buf;
  } catch (error) {
    held.child.kill('SIGKILL');
    // Reap the child, but an orphaned grandchild can hold the pipes open —
    // don't let the reap extend the failure past a bounded grace.
    await Promise.race([held.done, new Promise(resolve => setTimeout(resolve, 2000))]);
    throw error;
  } finally {
    held.child.stdout.off('data', onData);
  }
}

test('shim: missing args prints usage and exits nonzero', async () => {
  const { done } = runNode([join(root, 'bin', 'slp-shim.mjs')]);
  const result = await done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /usage: slp-shim\.mjs/);
});

test('shim: argv0 --version answers the real provider version with no provider env', async t => {
  const f = await fixtureRuntime(t);
  const { done } = runShim(f, 'codex', 'peer', ['--version'], { env: { PATH: '/usr/bin:/bin' } });
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'codex 9.9.9-fake\n');
  assert.ok(!result.stdout.includes(process.versions.node), 'no Node-version false positive');
  // The launcher executable alone reaches the same path (Paseo's argv0 probe).
  const viaLauncher = spawnSync(join(f.set.directory, 'slp-devin-peer'), ['--version'], {
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  assert.equal(viaLauncher.status, 0);
  assert.equal(viaLauncher.stdout, 'devin 9.9.9-fake\n');
});

test('shim: frozen env comes from the manifest; grant/PASEO_AGENT_ID cannot select a binding', async t => {
  const f = await fixtureRuntime(t);
  const env = {
    PATH: '/usr/bin:/bin',
    SLP_SESSION_OPEN_GRANT: 'forged-grant',
    SLP_RUNTIME_ROOT: '/evil/runtime',
    SLP_CODEX_BIN: '/evil/codex',
    PASEO_AGENT_ID: 'agent-context-1',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
  };
  const { done } = runShim(f, 'codex', 'peer', ['exit3'], { env });
  const result = await done;
  assert.equal(result.code, 3);
  const captured = readEnv(join(f.dir, 'codex.env'));
  assert.equal(captured.SLP_SESSION_OPEN_GRANT, '', 'grant resets to the empty sentinel');
  assert.equal(captured.SLP_RUNTIME_ROOT, f.candidate, 'runtime root is the manifest binding');
  assert.equal(captured.SLP_CODEX_BIN, f.binaries.codex.path);
  assert.equal(captured.SLP_NODE_BIN, f.node.path);
  assert.equal(captured.SLP_DAEMON_HOME, f.home);
  assert.equal(captured.PASEO_HOME, f.home);
  assert.equal(captured.SLP_MANAGED_RUNTIME, '1');
  assert.equal(captured.PASEO_AGENT_ID, 'agent-context-1', 'context preserved, never a selector');
  assert.equal(captured.ELECTRON_RUN_AS_NODE, '<unset>');
  assert.equal(captured.NODE_OPTIONS, '<unset>');
  assert.equal(captured.SLP_PI_BIN, '<unset>', 'only this family gets a bin variable');
});

test('shim: runtime tampering and manifest mismatch block the launch', async t => {
  const f = await fixtureRuntime(t);
  appendFileSync(join(f.candidate, 'src', 'common.md'), '\ntampered\n');
  const { done } = runShim(f, 'pi', 'peer', ['chat']);
  const result = await done;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /candidate|integrity|changed/i);

  const f2 = await fixtureRuntime(t);
  appendFileSync(f2.manifestPath, ' ');
  const second = await runShim(f2, 'codex', 'peer', ['exit3']).done;
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /digest mismatch/);
});

test('shim: invalid family/role, missing separator and unavailable binary all fail closed', async t => {
  const f = await fixtureRuntime(t, { missing: 'pi' });
  const badRole = await runShim(f, 'codex', 'bogus', []).done;
  assert.equal(badRole.code, 1);
  assert.match(badRole.stderr, /invalid role/);
  const badFamily = await runShim(f, 'emacs', 'peer', []).done;
  assert.equal(badFamily.code, 1);
  const shim = join(f.candidate, 'bin', 'slp-shim.mjs');
  const noSep = await runNode([shim, f.manifestPath, f.set.launchManifestSha256, 'codex', 'peer', '--version']).done;
  assert.equal(noSep.code, 1);
  assert.match(noSep.stderr, /usage/);
  const missing = await runShim(f, 'pi', 'peer', ['chat']).done;
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /EXECUTABLE_UNAVAILABLE|no verified executable/);
});

test('shim: codex app-server protocol gets byte-exact role injection', async t => {
  const f = await fixtureRuntime(t);
  const instruction = managedInstruction(f, 'peer');
  const message = { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { developerInstructions: 'host text' } };
  const { done } = runShim(f, 'codex', 'peer', ['app-server'], { input: JSON.stringify(message) + '\n' });
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  const expected = JSON.stringify(injectRole(message, instruction)) + '\n';
  assert.equal(result.stdout, expected, 'transformed frame is byte-exact');
  assert.deepEqual(readArgv(join(f.dir, 'codex.argv')), ['app-server']);
});

test('shim: pi role args are inserted before -- with byte-exact instruction', async t => {
  const f = await fixtureRuntime(t);
  const args = ['chat', '--', 'user words'];
  const { done } = runShim(f, 'pi', 'peer', args);
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  const instruction = managedInstruction(f, 'peer');
  assert.deepEqual(readArgv(join(f.dir, 'pi.argv')), piRoleArgs(args, instruction));
});

test('shim: devin acp session/prompt carries the role text block first', async t => {
  const f = await fixtureRuntime(t);
  const delivery = roleDelivery(f.candidate, 'lead', { SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: f.node.path, SLP_RUNTIME_ROOT: f.candidate, SLP_DAEMON_HOME: f.home });
  const instruction = delivery.entry({ explicitLanguageState: true });
  const message = { method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'do work' }] } };
  const { done } = runShim(f, 'devin', 'lead', [], { input: JSON.stringify(message) + '\n' });
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  const expected = acpRolePrompt(message, delivery, new Set());
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(expected.params.prompt[0].text, instruction);
  assert.deepEqual(readArgv(join(f.dir, 'devin.argv')), ['acp'], 'empty args default to acp');
});

test('shim: claude stream-json initialize appends role; auth status stays passthrough', async t => {
  const f = await fixtureRuntime(t);
  const instruction = managedInstruction(f, 'supervisor');
  const init = { type: 'control_request', request_id: 'r1', request: { subtype: 'initialize', appendSystemPrompt: 'base' } };
  const protocol = runShim(f, 'claude', 'supervisor',
    ['--input-format', 'stream-json', '--output-format', 'stream-json'],
    { input: JSON.stringify(init) + '\n' });
  const result = await protocol.done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), claudeRolePrompt(init, instruction));

  const admin = await runShim(f, 'claude', 'supervisor', ['auth', 'status']).done;
  assert.equal(admin.code, 0, admin.stderr);
  assert.deepEqual(readArgv(join(f.dir, 'claude.argv')), ['auth', 'status']);
});

test('shim: exit codes, signal forwarding and line backpressure hold', async t => {
  const f = await fixtureRuntime(t);
  const exited = await runShim(f, 'codex', 'peer', ['exit3']).done;
  assert.equal(exited.code, 3, 'native exit code forwards through wrapper and shim');

  // SIGTERM to the launcher forwards to the family process; the shim exits 143.
  // `cat` with stdin held open is the long-lived child; one protocol
  // round-trip is the readiness handshake — the argv marker only proves the
  // grandchild forked, not that the shim installed its signal handlers.
  const held = runShim(f, 'codex', 'peer', ['app-server'], { stdin: false });
  const probe = JSON.stringify({ method: 'readiness-probe' }) + '\n';
  const echoed = await waitForProtocolEcho(held, probe);
  assert.equal(echoed, probe, 'passthrough frame echoes back verbatim');
  held.child.kill('SIGTERM');
  const sig = await held.done;
  assert.equal(sig.code, 143);
  assert.equal(sig.signal, null);

  // A burst of frames exercises the write/drain loop; order and count survive.
  const lines = Array.from({ length: 1500 }, (_, i) => JSON.stringify({ method: 'noop', i }));
  const burst = runShim(f, 'codex', 'peer', ['app-server'], { input: lines.join('\n') + '\n' });
  const out = await burst.done;
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), lines);
});
