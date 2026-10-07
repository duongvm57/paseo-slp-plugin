// Coverage for the managed-runtime additions to role-bundle and inventory:
// launch-env path rendering (SLP_NODE_BIN / SLP_RUNTIME_ROOT / SLP_DAEMON_HOME
// with POSIX quoting), explicit-home helper commands, fail-closed env
// validation, and the managed inventory contract — config-only providers
// labeled `provenance:'configured'`, never a CLI listing against a foreign
// daemon, and a hard failure when no exact home is supplied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { install, json, hash } from '../plugin/server/runtime/cli/package.ts';
import { roleBundle, policyLocators } from '../plugin/server/runtime/cli/role-bundle.ts';
import { liveInventory } from '../plugin/server/runtime/cli/inventory.ts';
import { verifyProvider } from '../plugin/server/runtime/cli/binding.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

const fixture = t => {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/plugin-helpers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const paseoHomeFixture = dir => {
  const home = join(dir, 'paseo');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), json({
    version: 1,
    agents: { providers: {
      'slp-codex-lead': { extends: 'codex', label: 'SLP codex lead', command: ['node', '/x/bin/codex-role.mjs', 'lead'] },
      'slp-devin-peer': { extends: 'acp', label: 'SLP devin peer', command: ['node', '/x/bin/devin-role.mjs', 'peer'] },
    } },
    daemon: { agentProfiles: [{ id: 'slp-supervisor', provider: 'slp-codex-lead', model: 'gpt-5.6-luna' }] },
  }));
  return home;
};

const slp = (args, env) => execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), ...args], {
  env, encoding: 'utf8',
});

const managedEnv = (home, over = {}) => ({
  PATH: '',
  SLP_MANAGED_RUNTIME: '1',
  SLP_NODE_BIN: '/opt/node/bin/node',
  SLP_RUNTIME_ROOT: '/rt/candidate-1',
  SLP_DAEMON_HOME: home,
  ...over,
});

// --- role-bundle: managed rendering ----------------------------------------

test('unmanaged role bundle keeps the historical rendering and ordering', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const bundle = roleBundle(installed, 'lead', {});
  assert.deepEqual(bundle.parts, ['common.md', 'roles/lead.md', 'delegation.md']);
  assert.ok(bundle.instructions.includes(`Snapshot command: node '${join(installed, 'bin/slp.mjs')}' snapshot <repository>`));
  assert.ok(!bundle.instructions.includes('--paseo-home'));
  assert.ok(!bundle.instructions.includes('SLP_MANAGED_RUNTIME'));
  // Part order: common policy first, then the role file, then delegation.
  const common = bundle.instructions.indexOf(readFileSync(join(root, 'src/common.md'), 'utf8'));
  const role = bundle.instructions.indexOf(readFileSync(join(root, 'src/roles/lead.md'), 'utf8'));
  const delegation = bundle.instructions.indexOf(readFileSync(join(root, 'src/delegation.md'), 'utf8'));
  assert.ok(common !== -1 && role !== -1 && delegation !== -1);
  assert.ok(common < role && role < delegation);
});

test('managed bundle renders verified Node, the stable runtime CLI and explicit home', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const env = {
    SLP_MANAGED_RUNTIME: '1',
    // Quote-bearing and space-bearing paths exercise the POSIX escaping.
    SLP_NODE_BIN: "/opt/n'ode/bin/node",
    SLP_RUNTIME_ROOT: '/rt/cand one',
    SLP_DAEMON_HOME: '/home/daemon/.paseo',
  };
  const bundle = roleBundle(installed, 'peer', env);
  assert.deepEqual(bundle.parts, ['common.md', 'roles/peer.md']);
  const cli = `'/opt/n'\\''ode/bin/node' '/rt/cand one/bin/slp.mjs'`;
  const home = `'/home/daemon/.paseo'`;
  assert.ok(bundle.instructions.includes(`Snapshot command: ${cli} snapshot <repository>`));
  assert.ok(bundle.instructions.includes(`Installed policy directory: /rt/cand one/src`));
  // Commands that accept --paseo-home render it explicitly.
  for (const line of [
    'routes <repository>', 'inventory', 'agents', 'notebook <repository>',
    'install <dir>',
  ]) {
    assert.ok(bundle.instructions.includes(`${cli} ${line} --paseo-home ${home}`), line);
  }
  // monitor takes no flag — the home goes inside the request payload.
  assert.ok(bundle.instructions.includes(`${cli} monitor <request.json>`) &&
    bundle.instructions.includes(`"paseoHome": "/home/daemon/.paseo"`));
  // upgrade/uninstall resolve the home from the target's paseo-binding.json.
  assert.ok(bundle.instructions.includes(`paseo-binding.json must record ${home}`));
  // init/materialize are repo-scoped and never touch a daemon home.
  assert.ok(bundle.instructions.includes('init/materialize/snapshot/prepare/prepare-handoff/verify are repo-scoped'));
  // Policy text must not embed this checkout's path or RPC calls.
  assert.ok(!bundle.instructions.includes(installed));
  assert.ok(!/callPluginRpc|plugin\/rpc/.test(bundle.instructions));
});

test('managed bundle fails closed on a missing or relative launch env var', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const base = { SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: '/n/bin/node', SLP_RUNTIME_ROOT: '/rt/x', SLP_DAEMON_HOME: '/h' };
  for (const [over, pattern] of [
    [{ SLP_NODE_BIN: undefined }, /absolute SLP_NODE_BIN/],
    [{ SLP_RUNTIME_ROOT: undefined }, /absolute SLP_RUNTIME_ROOT/],
    [{ SLP_DAEMON_HOME: undefined }, /absolute SLP_DAEMON_HOME/],
    [{ SLP_NODE_BIN: 'node' }, /absolute SLP_NODE_BIN/],
    [{ SLP_RUNTIME_ROOT: 'relative/path' }, /absolute SLP_RUNTIME_ROOT/],
    [{ SLP_DAEMON_HOME: '~/.paseo' }, /absolute SLP_DAEMON_HOME/],
  ]) {
    assert.throws(() => roleBundle(installed, 'lead', { ...base, ...over }), pattern);
  }
  // Any value other than '1' leaves the bundle fully unmanaged.
  const off = roleBundle(installed, 'lead', { ...base, SLP_MANAGED_RUNTIME: '0' });
  assert.ok(!off.instructions.includes('--paseo-home'));
  assert.ok(off.instructions.includes(`node '${join(installed, 'bin/slp.mjs')}'`));
});

test('managed bundle injects the communication language only when the state file sets it', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const home = join(dir, 'daemon-home');
  const env = {
    SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: '/n/bin/node',
    SLP_RUNTIME_ROOT: installed, SLP_DAEMON_HOME: home,
  };
  // No file → no language bytes at all.
  const unset = roleBundle(installed, 'supervisor', env);
  assert.ok(!unset.instructions.includes('Communication language:'));
  // File set → the verbatim value is injected once.
  mkdirSync(join(home, 'slp-runtime/state'), { recursive: true });
  writeFileSync(join(home, 'slp-runtime/state/communication-language'), 'Vietnamese\n');
  const set = roleBundle(installed, 'supervisor', env);
  assert.equal(set.instructions.match(/Communication language: /g).length, 1);
  assert.ok(set.instructions.includes('Communication language: Vietnamese — all text you send to other seats uses it, including prompts and inline assignment fields in create_agent/send_agent_prompt requests, plus team artifacts (reports, assignments, briefs, handbacks, notebook entries)'));
  assert.ok(set.instructions.includes("direct replies to the Human mirror the Human's current language"), 'direct replies mirror the conversation, not the pinned artifact language');
  // Whitespace-only file behaves as unset.
  writeFileSync(join(home, 'slp-runtime/state/communication-language'), '  \n');
  const blank = roleBundle(installed, 'supervisor', env);
  assert.ok(!blank.instructions.includes('Communication language:'));
  // Unmanaged launches never inject, even if a file path would resolve.
  const unmanaged = roleBundle(installed, 'supervisor', { SLP_DAEMON_HOME: home });
  assert.ok(!unmanaged.instructions.includes('Communication language:'));
});

test('role instructions carry the spawn kit and policy locators at session entry', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  // Unmanaged render: locators resolve under the installation itself.
  const lead = roleBundle(installed, 'lead', {});
  assert.match(lead.instructions, /\nSpawn kit — role-scoped Paseo MCP signatures \(approximate; consult the specific live schema for unfamiliar parameters or a mismatch\):\n/);
  assert.ok(lead.instructions.includes('- create_agent(title: string'));
  // The locator set derives from the install receipt: docs/contract.md lives
  // outside the install unit and is never declared.
  assert.ok(!lead.instructions.includes('docs/contract.md'));
  // A receipt-declared policy file missing from disk keeps its missing marker
  // instead of vanishing from the list.
  rmSync(join(installed, 'src/references/review-gates.md'));
  const missing = roleBundle(installed, 'lead', {});
  assert.ok(missing.instructions.includes(`- ${join(installed, 'src/references/review-gates.md')} — declared but missing on disk`));
  const common = readFileSync(join(installed, 'src/common.md'));
  assert.ok(lead.instructions.includes(`- ${join(installed, 'src/common.md')} — ${common.length} bytes, sha256 ${hash(common)}`));
  // Session-entry caption: measured at load, never plan-time/prepare wording.
  assert.match(lead.instructions, /Policy locators — absolute paths; size\/sha256 were measured when these role instructions loaded/);
  assert.ok(!/plan-time|prepare checked/.test(lead.instructions));
  // Locators sort by absolute path — the list carries no bundle-order hint.
  const locatorPaths = lead.instructions.split('\n')
    .filter(line => line.startsWith(`- ${installed}/`))
    .map(line => line.slice(2).split(' — ')[0]);
  assert.deepEqual(locatorPaths, [...locatorPaths].sort());
  // Managed render derives locators from SLP_RUNTIME_ROOT, not the checkout.
  const managed = roleBundle(installed, 'peer', {
    SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: '/n/bin/node',
    SLP_RUNTIME_ROOT: installed, SLP_DAEMON_HOME: '/h',
  });
  // The Peer kit is exactly its two tools — never orchestrating signatures.
  assert.ok(managed.instructions.includes('- send_agent_prompt(agentId: string'));
  assert.ok(managed.instructions.includes('- get_agent_status(agentId: string)'));
  assert.ok(!managed.instructions.includes('- create_agent('));
  assert.ok(!managed.instructions.includes(`- ${join(installed, 'src/delegation.md')}`));
  assert.ok(managed.instructions.includes(`- ${join(installed, 'src/roles/peer.md')} — `));
  // Opt-out: prompt() appends the carrier itself, so the inline copy skips it.
  const bare = roleBundle(installed, 'lead', {}, { carrier: false });
  assert.ok(!bare.instructions.includes('Spawn kit —'));
  assert.ok(!bare.instructions.includes('Policy locators —'));
});

test('policyLocators validates role, tolerates absent optional paths and refuses corrupt or symlinked policy', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  // Role is validated at call time, not by a downstream path lookup.
  assert.throws(() => policyLocators(installed, 'engineer'), /Unknown role/);
  // A source checkout without a receipt scans the tree live.
  const source = policyLocators(root, 'peer', {});
  assert.ok(source.some(entry => entry.path === join(root, 'src/roles/peer.md') && entry.sha256));
  assert.deepEqual(source.map(entry => entry.path), [join(root, 'src/common.md'), join(root, 'src/roles/peer.md')].sort());
  // src/references being a plain file is an ENOTDIR absence, not a crash.
  const bare = join(dir, 'bare');
  mkdirSync(bare);
  mkdirSync(join(bare, 'src'));
  writeFileSync(join(bare, 'src/references'), 'not a directory');
  const locators = policyLocators(bare, 'lead');
  assert.equal(locators.length, 3);
  assert.ok(locators.every(entry => entry.missing === true));
  // A receipt that parses but has no candidate list is corrupt, not absent.
  writeFileSync(join(bare, 'installed.json'), '{}\n');
  assert.throws(() => policyLocators(bare, 'lead'), /lacks a candidate file list/);
  writeFileSync(join(bare, 'installed.json'), 'not json');
  assert.throws(() => policyLocators(bare, 'lead'), SyntaxError);
  // A symlinked policy path is an integrity failure, never absence.
  rmSync(join(installed, 'src/common.md'));
  symlinkSync(join(installed, 'src/roles/lead.md'), join(installed, 'src/common.md'));
  assert.throws(() => policyLocators(installed, 'lead'), /is a symlink/);
});

test('Peer carrier locators are allowlisted to the required bundle; a legacy tracker artifact adds nothing', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const home = join(dir, 'paseo');
  const state = join(home, 'slp-runtime/state');
  mkdirSync(state, { recursive: true });
  const env = managedEnv(home, { SLP_RUNTIME_ROOT: installed });
  const paths = instructions => instructions.split('\n')
    .filter(line => line.startsWith(`- ${installed}/`))
    .map(line => line.slice(2).split(' — ')[0]);
  const peerLocators = [join(installed, 'src/common.md'), join(installed, 'src/roles/peer.md')].sort();

  const off = roleBundle(installed, 'peer', env);
  assert.deepEqual(paths(off.instructions), peerLocators);
  assert.ok(!off.instructions.includes('Work tracker:'));
  for (const reference of ['governance.md', 'monitoring.md', 'orchestration.md', 'provider-routing.md', 'jev-routing.md']) {
    assert.ok(!paths(off.instructions).some(path => path.endsWith(`/references/${reference}`)), `${reference} is not a Peer locator`);
  }

  // A legacy tracker artifact is inert: enabled or corrupt, it can add no
  // prompt line and no locator — the render is byte-identical to absent.
  writeFileSync(join(state, 'work-tracker.json'), json({ schemaVersion: 1, tracker: 'beads', enabled: true }));
  const on = roleBundle(installed, 'peer', env);
  assert.equal(on.instructions, off.instructions);
  assert.deepEqual(paths(on.instructions), peerLocators);
  writeFileSync(join(state, 'work-tracker.json'), '{corrupt');
  assert.equal(roleBundle(installed, 'peer', env).instructions, off.instructions);

  const receipt = JSON.parse(readFileSync(join(installed, 'installed.json'), 'utf8'));
  const references = receipt.candidate.files.map(entry => entry.path)
    .filter(path => path.startsWith('src/references/'));
  for (const role of ['supervisor', 'lead']) {
    const entries = policyLocators(installed, role, env);
    const expected = ['src/common.md', `src/roles/${role}.md`, 'src/delegation.md', ...references]
      .map(path => join(installed, path)).sort();
    assert.deepEqual(entries.map(entry => entry.path).sort(), expected,
      `${role} retains its required bundle and every receipt-declared reference`);
    assert.ok(entries.some(entry => entry.path === join(installed, 'src/references/jev-routing.md')));
    assert.ok(entries.some(entry => entry.path === join(installed, 'src/references/task-execution.md')));
  }

  // A receipt-declared reference deleted from disk still reports missing.
  rmSync(join(installed, 'src/references/jev-routing.md'));
  const missing = policyLocators(installed, 'lead', env);
  assert.deepEqual(missing.find(entry => entry.path === join(installed, 'src/references/jev-routing.md')),
    { path: join(installed, 'src/references/jev-routing.md'), missing: true });
});

test('instructions <role> prints the exact bundle bytes on stdout and metadata on stderr', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const env = { PATH: process.env.PATH };
  const run = (bin, role, extraEnv = {}) => spawnSync(process.execPath, [bin, 'instructions', role], { encoding: 'utf8', env: { ...env, ...extraEnv } });
  // Installed unmanaged render: stdout is byte-identical to roleBundle.
  const lead = run(join(installed, 'bin/slp.mjs'), 'lead');
  assert.equal(lead.status, 0);
  assert.equal(lead.stdout, roleBundle(installed, 'lead', {}).instructions);
  assert.match(lead.stderr, /role: lead/);
  assert.match(lead.stderr, /managed: false/);
  // Managed render uses the exact env-provided runtime/node/home.
  const managedEnv = { SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: '/n/bin/node', SLP_RUNTIME_ROOT: installed, SLP_DAEMON_HOME: '/h' };
  const managed = run(join(installed, 'bin/slp.mjs'), 'peer', managedEnv);
  assert.equal(managed.status, 0);
  assert.equal(managed.stdout, roleBundle(installed, 'peer', managedEnv).instructions);
  assert.match(managed.stderr, /managed: true/);
  // A broken managed env fails closed instead of rendering.
  const broken = run(join(installed, 'bin/slp.mjs'), 'lead', { SLP_MANAGED_RUNTIME: '1' });
  assert.equal(broken.status, 1);
  // Source checkout: bytes render, stderr flags them as non-live preview.
  const source = run(join(root, 'bin/slp.mjs'), 'peer');
  assert.equal(source.status, 0);
  assert.equal(source.stdout, roleBundle(root, 'peer', {}).instructions);
  assert.match(source.stderr, /source checkout/);
  // Unknown role fails.
  const bad = run(join(installed, 'bin/slp.mjs'), 'bogus');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown role/);
});

test('managed bundles disclose guarded and ordinary paths while preserving role separation', t => {
  const installed = join(fixture(t), 'release');
  install(root, installed);
  const env = { SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: '/n/bin/node', SLP_RUNTIME_ROOT: installed, SLP_DAEMON_HOME: '/h' };
  for (const role of ['supervisor', 'lead', 'peer']) {
    const bundle = roleBundle(installed, role, env).instructions;
    assert.match(bundle, /Review selection never waives\s+a Human, assignment or protocol obligation/);
    assert.match(bundle, /parent\/report recipient must match your paseo\.parent-agent-id\s+label/);
    assert.match(bundle, /recipient distinct from your\s+parent/);
    if (role === 'peer') {
      assert.match(bundle, /Reviewer\/Auditor stays independent of writer and accepting owner/);
      assert.ok(!bundle.includes(readFileSync(join(installed, 'src/delegation.md'), 'utf8')));
      continue;
    }
    for (const ref of ['delegation-execution.md', 'task-execution.md']) {
      const body = readFileSync(join(installed, `src/references/${ref}`), 'utf8');
      assert.ok(bundle.includes(`references/${ref}`));
      assert.ok(!bundle.includes(body));
      assert.ok(policyLocators(installed, role).some(entry => entry.path.endsWith(`/references/${ref}`) && entry.sha256 === hash(Buffer.from(body))));
    }
    assert.match(bundle, /ordinary\/Lean creation or observation/);
    assert.match(bundle, /Runtime admission records and verifies reservations/);
  }
  assert.match(roleBundle(installed, 'lead', env).instructions, /When the assignment or protocol\s+requires independent review/);
  assert.ok(!/When the assignment or protocol\s+requires independent review/.test(roleBundle(installed, 'supervisor', env).instructions));
});

// --- inventory: managed vs unmanaged ---------------------------------------

test('managed inventory reads the exact home, never the CLI, and labels providers configured', t => {
  const dir = fixture(t), home = paseoHomeFixture(dir);
  // A live-looking pid file must not matter under managed mode.
  writeFileSync(join(home, 'paseo.pid'), json({ pid: process.pid, listen: '127.0.0.1:1' }));
  // A fake `paseo` CLI on PATH that would return a marker provider if invoked.
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'paseo'), '#!/bin/sh\nprintf \'%s\n\' \'[{"provider":"LIVE-MARKER","enabled":"Enabled","status":"available"}]\'\n');
  chmodSync(join(fakeBin, 'paseo'), 0o755);
  const env = managedEnv(home, { PATH: fakeBin });

  const out = JSON.parse(slp(['inventory', '--paseo-home', home], env));
  assert.equal(out.source.providers, join(home, 'config.json'));
  assert.equal(out.providersProvenance, 'configured, not live');
  assert.ok(out.providers.length >= 2);
  assert.ok(out.providers.every(p => p.provenance === 'configured'));
  // The fake CLI listing was never invoked.
  assert.ok(!out.providers.some(p => p.id === 'LIVE-MARKER'));
  // Static config entries are rejected as launch evidence (plugin/server/runtime/cli/binding.ts).
  assert.throws(
    () => verifyProvider(out.providers, 'slp-codex-lead', () => 'codex'),
    /configured inventory is not live evidence/,
  );
  // Profiles still come from the same exact-home config.
  assert.ok(out.profiles.some(p => p.id === 'slp-supervisor'));
  // With no flag, the managed env home is used — not the process default.
  const implicit = JSON.parse(slp(['inventory'], env));
  assert.equal(implicit.source.providers, join(home, 'config.json'));
  assert.equal(implicit.providersProvenance, 'configured, not live');
});

test('managed inventory fails rather than infer a home when none is bound', () => {
  const result = spawnSync(process.execPath, [join(root, 'bin/slp.mjs'), 'inventory'], {
    env: { PATH: '', SLP_MANAGED_RUNTIME: '1', HOME: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SLP_DAEMON_HOME|refusing to infer/);
});

test('a relative --paseo-home is rejected before any read', () => {
  const result = spawnSync(process.execPath, [join(root, 'bin/slp.mjs'), 'inventory', '--paseo-home', 'rel/path'], {
    env: { PATH: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Absolute path required/);
});

// --- managed fail-closed home guards (spec §10 — the guard must stand even
// when the session env is stripped of PASEO_HOME) -----------------------------

const managedFail = (args, extraEnv = {}) =>
  spawnSync(process.execPath, [join(root, 'bin/slp.mjs'), ...args], {
    env: { PATH: '', SLP_MANAGED_RUNTIME: '1', HOME: '/nonexistent', ...extraEnv },
    encoding: 'utf8',
  });

const agentHomeFixture = dir => {
  const home = paseoHomeFixture(dir);
  mkdirSync(join(home, 'agents', 'grp'), { recursive: true });
  writeFileSync(join(home, 'agents', 'grp', 'one.json'),
    json({ id: 'agent-1', title: 'managed agent', provider: 'slp-devin-peer', cwd: dir }));
  return home;
};

test('managed agents/notebook/monitor fail when no home is bound', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'req.json'), json({ agents: [{ id: 'x' }] }));
  for (const [args, pattern] of [
    [['agents'], /SLP_DAEMON_HOME|refusing to infer/],
    [['notebook', root], /SLP_DAEMON_HOME|refusing to infer/],
    [['monitor', join(dir, 'req.json')], /SLP_DAEMON_HOME|refusing to infer/],
    // A bare --paseo-home must resolve the managed home or fail at parse time —
    // never the process default ~/.paseo.
    [['inventory', '--paseo-home'], /SLP_DAEMON_HOME|refusing to infer/],
    [['agents', '--paseo-home'], /SLP_DAEMON_HOME|refusing to infer/],
  ]) {
    const result = managedFail(args);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, pattern);
  }
  const rel = managedFail(['agents'], { SLP_DAEMON_HOME: 'rel/path' });
  assert.equal(rel.status, 1);
  assert.match(rel.stderr, /SLP_DAEMON_HOME|refusing to infer/);
});

test('managed agents/notebook/monitor resolve SLP_DAEMON_HOME or PASEO_HOME', t => {
  const dir = fixture(t), home = agentHomeFixture(dir);
  writeFileSync(join(dir, 'req.json'), json({ agents: [{ id: 'agent-1' }] }));
  // SLP_DAEMON_HOME binds the home for every helper.
  const env = { PATH: '', SLP_MANAGED_RUNTIME: '1', SLP_DAEMON_HOME: home, HOME: '/nonexistent' };
  const agentsOut = JSON.parse(slp(['agents'], env));
  assert.deepEqual(agentsOut.map(a => a.id), ['agent-1']);
  // A bare --paseo-home under managed resolves the bound home, not ~/.paseo.
  const bareOut = JSON.parse(slp(['agents', '--paseo-home'], env));
  assert.deepEqual(bareOut.map(a => a.id), ['agent-1']);
  // notebook probes git — give it a real PATH (the managed home stays bound).
  const gitEnv = { ...env, PATH: process.env.PATH };
  const notebookOut = JSON.parse(slp(['notebook', root], gitEnv));
  assert.equal(notebookOut.gitCommonDir.length > 0, true);
  const monitorOut = JSON.parse(slp(['monitor', join(dir, 'req.json')], env));
  assert.equal(monitorOut.scanned, 1);
  // PASEO_HOME alone carries the same value when SLP_DAEMON_HOME is absent.
  const paseoEnv = { PATH: '', SLP_MANAGED_RUNTIME: '1', PASEO_HOME: home, HOME: '/nonexistent' };
  assert.deepEqual(JSON.parse(slp(['agents'], paseoEnv)).map(a => a.id), ['agent-1']);
  // An explicit absolute home still wins under managed mode.
  const other = paseoHomeFixture(join(dir, 'other'));
  mkdirSync(join(other, 'agents', 'grp'), { recursive: true });
  writeFileSync(join(other, 'agents', 'grp', 'two.json'), json({ id: 'agent-2', title: 'explicit', provider: 'pi' }));
  const explicit = JSON.parse(slp(['agents', '--paseo-home', other], env));
  assert.deepEqual(explicit.map(a => a.id), ['agent-2']);
  // monitor honors an explicit request.paseoHome the same way.
  writeFileSync(join(dir, 'req2.json'), json({ paseoHome: other, agents: [{ id: 'agent-2' }] }));
  const monitorExplicit = JSON.parse(slp(['monitor', join(dir, 'req2.json')], env));
  assert.equal(monitorExplicit.scanned, 1);
});

test('unmanaged home resolution is unchanged — default and bare flag still work', t => {
  const dir = fixture(t), home = agentHomeFixture(dir);
  const env = { PATH: '', PASEO_HOME: home, HOME: '/nonexistent' };
  assert.deepEqual(JSON.parse(slp(['agents'], env)).map(a => a.id), ['agent-1']);
  assert.deepEqual(JSON.parse(slp(['agents', '--paseo-home'], env)).map(a => a.id), ['agent-1']);
  // Unmanaged with a nonexistent home returns empty state, not a throw.
  assert.deepEqual(JSON.parse(slp(['agents'], { PATH: '', HOME: dir })), []);
});

// --- S1: install --paseo-home on a never-installed dir ----------------------

test('install --paseo-home on a pre-existing never-installed dir fails with a business error', t => {
  const dir = fixture(t);
  const dest = join(dir, 'dest'), home = join(dir, 'home');
  mkdirSync(dest); // exists but was never installed — no installed.json
  const result = spawnSync(process.execPath,
    [join(root, 'bin/slp.mjs'), 'install', dest, '--paseo-home', home, '--apply'],
    { env: { PATH: '' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an installed SLP directory|missing installed\.json/i);
  assert.ok(!/ENOENT/.test(result.stderr), `raw ENOENT leaked: ${result.stderr}`);
  // A non-existent destination still takes the normal install path (no --apply
  // here: the proposal output proves the guard did not block it).
  const fresh = spawnSync(process.execPath,
    [join(root, 'bin/slp.mjs'), 'install', join(dir, 'fresh'), '--paseo-home', home],
    { env: { PATH: '' }, encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /"applied": false|"providers"/);
});

test('unmanaged inventory keeps its existing shape — no provenance markers', t => {
  const dir = fixture(t), home = paseoHomeFixture(dir);
  const out = JSON.parse(slp(['inventory', '--paseo-home', home], { PATH: '' }));
  assert.equal(out.providersProvenance, undefined);
  assert.ok(out.providers.every(p => !('provenance' in p)));
  // Unmanaged config fallback entries still pass launch-time verification.
  const { observed } = verifyProvider(out.providers, 'slp-codex-lead', () => 'codex');
  assert.equal(observed.id, 'slp-codex-lead');
  assert.equal(out.profiles[0].id, 'slp-supervisor');
});

test('ACP delivery keeps verified core while refreshing language and restoring carriers', async t => {
  const { roleDelivery } = await import('../plugin/server/runtime/cli/role-bundle.ts');
  const { acpRolePrompt } = await import('../plugin/server/runtime/cli/role-transport.ts');
  const dir = fixture(t), installed = join(dir, 'release'), home = join(dir, 'daemon');
  install(root, installed);
  const state = join(home, 'slp-runtime/state/communication-language');
  mkdirSync(join(home, 'slp-runtime/state'), { recursive: true });
  const env = { SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: process.execPath, SLP_RUNTIME_ROOT: installed, SLP_DAEMON_HOME: home };
  for (const role of ['peer', 'lead', 'supervisor']) {
    const delivery = roleDelivery(installed, role, env), seen = new Set();
    const prompt = sessionId => ({ method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'bounded task' }] } });
    const send = sessionId => acpRolePrompt(prompt(sessionId), delivery, seen).params.prompt;
    writeFileSync(state, 'Vietnamese\n');
    const first = send('a');
    assert.match(first[0].text, /Communication language: Vietnamese/);
    assert.match(first[0].text, /Spawn kit —/);
    assert.equal(first[0].text.split(`SLP role=${role}`).length, 2, 'one core per prompt');
    assert.equal(first[1].text, 'bounded task');
    writeFileSync(state, 'Japanese\n');
    const next = send('a')[0].text;
    assert.match(next, /Communication language: Japanese/);
    assert.ok(!next.includes('Communication language: Vietnamese'));
    assert.ok(!next.includes('Spawn kit —') && !next.includes('Policy locators —'));
    assert.match(next, /Policy recovery command: .* instructions /);
    assert.match(next, /Human stop/);
    assert.match(next, /Missing task evidence is a gap/);
    assert.match(next, /Review selection never waives\s+a Human, assignment or protocol obligation/);
    assert.equal(/Lead's explicit review selection precedes the candidate round/.test(next), role !== 'peer');
    assert.equal(/Unavailable\s+required reviewers or adverse findings never relax the gate/.test(next), role !== 'peer');
    assert.equal(/record selection\/reason before the candidate round/.test(next), role === 'lead');
    assert.equal(/Before each review\s+selection or revision, including not-required, read references\/review-gates\.md/.test(next), role === 'lead');
    assert.equal(/Reviewer\/Auditor stays independent of writer and accepting owner/.test(next), role === 'peer');
    assert.doesNotMatch(next, /does not license merging\s+the axes into one seat|parallel seats on split axes/);
    assert.match(send('b')[0].text, /Spawn kit —/, 'new session gets its own carrier');
    for (const method of ['session/load', 'session/resume', 'session/fork']) {
      const lifecycle = { method, params: { sessionId: 'a' } };
      assert.equal(acpRolePrompt(lifecycle, delivery, seen), lifecycle);
      assert.match(send('a')[0].text, /Spawn kit —/);
    }
    for (const value of ['', null]) {
      if (value === null) rmSync(state); else writeFileSync(state, value);
      assert.match(send('a')[0].text, /not set — this replaces earlier runtime language settings/);
    }
    mkdirSync(state);
    assert.throws(() => send('a'), /EISDIR/);
    rmSync(state, { recursive: true });
    const unrelated = { method: 'session/cancel', params: { sessionId: 'a' } };
    assert.equal(acpRolePrompt(unrelated, delivery, seen), unrelated);
    const bad = { method: 'session/prompt', params: { sessionId: 'broken', prompt: null } };
    assert.throws(() => acpRolePrompt(bad, delivery, seen), /Malformed/);
    assert.equal(seen.has('broken'), false);
  }
  const frozen = roleDelivery(installed, 'peer', env);
  const core = frozen.anchor();
  writeFileSync(join(installed, 'src/roles/peer.md'), 'changed after verification');
  assert.equal(frozen.anchor(), core, 'running delivery does not mix candidate policy versions');
  const unmanaged = roleDelivery(root, 'peer', { SLP_DAEMON_HOME: home });
  assert.ok(!unmanaged.anchor().includes('Communication language:'));
});

test('tiny policy keeps protocol-owned ceremony separate from required gates and runtime freshness', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const lead = roleBundle(installed, 'lead', {}).instructions.replace(/\s+/gu, ' ');
  const protocol = readFileSync(join(installed, 'src/templates/workspace-protocol.md'), 'utf8').replace(/\s+/gu, ' ');
  const orchestration = readFileSync(join(installed, 'src/references/orchestration.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.match(lead, /Peer writing is the managed-implementation default/);
  assert.match(lead, /direct Lead write requires an explicit Human assignment or current effective protocol grant for clear, reversible work, bounded scope, one writer and exact candidate proof/);
  assert.match(lead, /Lead writer never stands in for required independent review/);
  assert.match(lead, /Peer writing is the managed-implementation default\. A direct Lead write requires an explicit Human assignment/);
  assert.match(lead, /Tiny classification reduces repository ceremony, never authority, ownership, parentage or required review/);
  assert.match(lead, /Tiny labels and missing\/stale protocols grant no exception/);
  assert.match(lead, /Reuse full relevant policy\/protocol text in context only when its source is known unchanged/);
  assert.match(lead, /Runtime checks still need fresh catalog hash, eligibility, provider availability and Jev receipts/);
  assert.match(lead, /first required full workspace-protocol read remains mandatory/);
  assert.match(protocol, /Lean: short inline brief\/formation/);
  assert.match(protocol, /Peer is default; direct Lead writes need the grant below/);
  assert.match(protocol, /Independent review triggers across methods/);
  assert.match(protocol, /one authorized writer's edit\/check loop/);
  assert.match(protocol, /paused stable candidate, actual proof and in-session handback/);
  assert.match(protocol, /Lead inspection\/Gate\/verdict/);
  assert.match(protocol, /Direct Lead write grant.*None by default; Human may specify clear reversible scope, proof\/review bounds/);
  assert.match(orchestration, /One Peer Engineer; tiny ceremony comes from the effective protocol\. Direct Lead writes follow common policy's explicit grant/);
});

test('live preparation inventories only the verified home and preserves the saved bundle', () => {
  const home = '/fixture/paseo';
  const config = json({ daemon: { agentProfiles: [{ id: 'slp-lead', provider: 'slp-codex-lead', model: 'gpt-test', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast: false } }] } });
  const calls = [];
  const exec = args => {
    calls.push(args);
    return json(args[0] === 'daemon'
      ? { home, localDaemon: 'running', connectedDaemon: 'reachable', serverId: 'fixture-server', listen: '127.0.0.1:6767' }
      : [{ provider: 'slp-codex-lead', enabled: 'Enabled', status: 'available' }]);
  };
  const out = liveInventory(home, { exec, read: () => config });
  assert.deepEqual(calls, [
    ['daemon', 'status', '--home', home, '--json'],
    ['provider', 'ls', '--host', '127.0.0.1:6767', '--json'],
  ]);
  assert.deepEqual(out.profiles[0], JSON.parse(config).daemon.agentProfiles[0]);
  assert.deepEqual(out.providers, [{ id: 'slp-codex-lead', enabled: true, status: 'available' }]);
  verifyProvider(out.providers, 'slp-codex-lead', () => 'codex');
  assert.equal(out.hostId, 'fixture-server');
});

test('live preparation refuses foreign/unreachable hosts and changed profiles without fallback', () => {
  const home = '/fixture/paseo';
  const config = json({ daemon: { agentProfiles: [] } });
  for (const status of [
    { home: '/foreign', localDaemon: 'running', connectedDaemon: 'reachable', serverId: 's', listen: '127.0.0.1:1' },
    { home, localDaemon: 'running', connectedDaemon: 'unreachable', serverId: 's', listen: '127.0.0.1:1' },
  ]) {
    let calls = 0;
    assert.throws(() => liveInventory(home, { read: () => config, exec: () => { calls++; return json(status); } }), /mapping is unverified/);
    assert.equal(calls, 1);
  }
  let reads = 0;
  assert.throws(() => liveInventory(home, {
    read: () => reads++ === 0 ? config : config + ' ',
    exec: args => json(args[0] === 'daemon' ? { home, localDaemon: 'running', connectedDaemon: 'reachable', serverId: 's', listen: '127.0.0.1:1' } : []),
  }), /profiles changed/);
});
