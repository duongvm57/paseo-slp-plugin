import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { install, update, verifyInstall, json, readJson } from '../src/package.mjs';
import { installPaseo, uninstallPaseo, initWorkspace, installHome } from '../src/paseo-install.mjs';
import { configFile, writeConfig } from '../src/host-config.mjs';
import { emptyCatalog } from '../src/routing.mjs';
import { roleInstructions, roleBundle } from '../src/role-bundle.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/installer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'paseo home'), destination = join(dir, 'installed role');
  mkdirSync(home);
  return { dir, home, destination };
}
// Tests cross the same host-config seam as production instead of forging config.json.
function config(home, value) { writeConfig(configFile(home), value); }

// Managed sessions export SLP_*/PASEO_* launch vars (SLP_MANAGED_RUNTIME,
// SLP_DAEMON_HOME, ...); a child inheriting them resolves the real daemon home
// instead of the test fixture. Strip them all, then apply the test's values.
const unmanagedEnv = extra => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SLP_') || key.startsWith('PASEO_')) delete env[key];
  }
  return { ...env, ...extra };
};

test('integrated install previews, preserves preferences and unrelated config, and rolls back only owned entries', t => {
  const { home, destination } = fixture(t);
  const before = { version: 1, privateSetting: 'not-in-receipt', agents: { providers: {
    legacy: { extends: 'codex', label: 'Legacy', command: ['old-runtime'] },
  } }, daemon: { mcp: { enabled: false, injectIntoAgents: false }, agentProfiles: [
    { id: 'personal-lead', name: 'My Lead', provider: 'legacy', model: 'human-model', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast_mode: true } },
  ] } };
  config(home, before);
  const originalBytes = readFileSync(join(home, 'config.json'), 'utf8');
  const preview = installPaseo(root, destination, home);
  assert.equal(preview.applied, false);
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), originalBytes);
  installPaseo(root, destination, home, true);
  verifyInstall(destination);
  const current = readJson(join(home, 'config.json'));
  assert.deepEqual(current.agents.providers.legacy, before.agents.providers.legacy);
  const lead = current.daemon.agentProfiles.find(p => p.id === 'slp-lead');
  assert.equal(lead.provider, 'slp-codex-lead');
  assert.deepEqual(current.daemon.agentProfiles[0], before.daemon.agentProfiles[0]);
  assert.ok(!readFileSync(join(destination, 'paseo-binding.json'), 'utf8').includes('not-in-receipt'));
  assert.equal(lstatSync(join(home, 'config.json')).mode & 0o777, 0o600);
  current.newHumanSetting = 'keep'; config(home, current);
  assert.equal(uninstallPaseo(destination).applied, false);
  assert.equal(existsSync(destination), true);
  uninstallPaseo(destination, true);
  assert.deepEqual(readJson(join(home, 'config.json')), { ...before, newHumanSetting: 'keep' });
  assert.equal(existsSync(destination), false);
});

test('collisions and modified profiles preserve both installation and host configuration', t => {
  const { home, destination, dir } = fixture(t);
  installPaseo(root, destination, home, true);
  const current = readJson(join(home, 'config.json'));
  current.daemon.agentProfiles[0].model = 'human-updated'; config(home, current);
  assert.throws(() => installPaseo(root, join(dir, 'another'), home, true), /already exists/);
  assert.throws(() => uninstallPaseo(destination, true), /Modified profile/);
  assert.deepEqual(readJson(join(home, 'config.json')), current);
  assert.equal(existsSync(destination), true);
});

test('extra files or changed binding block removal before detaching Paseo', t => {
  const { home, destination } = fixture(t);
  installPaseo(root, destination, home, true);
  const current = readFileSync(join(home, 'config.json'), 'utf8');
  writeFileSync(join(destination, 'human.md'), 'preserve');
  assert.throws(() => uninstallPaseo(destination, true), /Extra files/);
  rmSync(join(destination, 'human.md'));
  writeFileSync(join(destination, 'paseo-binding.json'), '{}');
  assert.throws(() => uninstallPaseo(destination, true), /binding changed/);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), current);
});

test('workspace init creates only protocol and notebook once and preserves Human edits independently', t => {
  const { dir, destination } = fixture(t);
  install(root, destination);
  writeFileSync(join(dir, 'AGENTS.md'), 'Human instructions');
  assert.equal(initWorkspace(destination, dir).applied, false);
  assert.equal(existsSync(join(dir, '.paseo-slp')), false);
  const initialized = initWorkspace(destination, dir, true);
  assert.equal(initialized.files.length, 2);
  const protocol = join(dir, '.paseo-slp/workspace-protocol.md');
  const notebook = join(dir, '.paseo-slp/notebook.md');
  assert.equal(readFileSync(protocol, 'utf8'),
    readFileSync(join(destination, 'src/templates/workspace-protocol.md'), 'utf8'),
    'init stages the effective default template verbatim, without resolving repository settings');
  assert.match(readFileSync(protocol, 'utf8'), /Supervisor and Lead read this file when the assignment lands/);
  // A repository routing catalog is a deliberate opt-in — default init never
  // writes one, so the repo resolves the user-scope pool.
  assert.equal(existsSync(join(dir, '.paseo-slp/slp-routing.json')), false);
  assert.match(readFileSync(notebook, 'utf8'), /Supervisor notebook/);
  assert.equal(existsSync(join(dir, '.paseo-slp/skills')), false);
  writeFileSync(protocol, 'Human protocol');
  writeFileSync(notebook, 'Human notebook');
  assert.equal(initWorkspace(destination, dir, true).preserved, true);
  assert.equal(readFileSync(protocol, 'utf8'), 'Human protocol');
  assert.equal(readFileSync(notebook, 'utf8'), 'Human notebook');
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), 'Human instructions');
  rmSync(notebook);
  const repaired = initWorkspace(destination, dir, true);
  assert.equal(repaired.files.filter(file => file.applied).length, 1);
  assert.equal(readFileSync(protocol, 'utf8'), 'Human protocol');
});

test('repo init imports only an explicit catalog, preserves existing files and rejects invalid imports before writes', t => {
  const { dir, destination, home } = fixture(t); install(root, destination);
  const repository = join(dir, 'job'); mkdirSync(repository);
  const input = join(home, 'slp-routing.json');
  writeFileSync(input, 'invalid');
  assert.throws(() => initWorkspace(destination, repository, true, input));
  assert.equal(existsSync(join(repository, '.paseo-slp')), false);
  const catalog = { ...emptyCatalog(), options: [{ id: 'mine', provider: 'pi', roles: ['peer'], model: 'opencode/glm-5.3-flash', enabled: true, availability: 'ready', suitableFor: ['coding'], avoidFor: [], notes: 'imported seat' }] };
  writeFileSync(input, json(catalog));
  const cli = join(destination, 'bin/slp.mjs');
  const run = flags => JSON.parse(execFileSync(process.execPath, [cli, 'init', repository, '--routing-from', input, ...flags], { encoding: 'utf8' }));
  assert.equal(run([]).applied, false);
  assert.equal(existsSync(join(repository, '.paseo-slp/slp-routing.json')), false);
  assert.equal(run(['--apply']).applied, true);
  const routing = join(repository, '.paseo-slp/slp-routing.json');
  assert.deepEqual(readJson(routing), catalog);
  catalog.options[0].enabled = false; writeFileSync(routing, json(catalog));
  assert.equal(run(['--apply']).preserved, true);
  assert.equal(readJson(routing).options[0].enabled, false);
  const other = join(dir, 'another-job'); mkdirSync(other);
  symlinkSync(home, join(other, '.paseo-slp'));
  assert.throws(() => initWorkspace(destination, other, true), /Expected repo directory/);
  assert.equal(existsSync(join(other, '.paseo-slp/workspace-protocol.md')), false);
});

test('installed adapter injects every role over stdio while preserving host prompts, permissions and protocol replies', t => {
  const { dir, destination } = fixture(t);
  install(root, destination);
  const fake = join(dir, 'fake-codex');
  writeFileSync(fake, `#!${process.execPath}\nif(process.argv.includes('--version')) { console.log('probe-ok'); process.exit(0); } process.stdin.pipe(process.stdout);\n`);
  chmodSync(fake, 0o755);
  const messages = [
    { id: 1, method: 'thread/start', params: { developerInstructions: 'Paseo orchestration tools', model: 'selected', approvalPolicy: 'never', sandbox: 'danger-full-access', config: { features: { fast_mode: true } } } },
    { id: 2, method: 'thread/resume', params: { threadId: 'existing', developerInstructions: 'Resume context' } },
    { id: 3, method: 'turn/start', params: { threadId: 'existing', input: [{ type: 'text', text: 'ordinary assignment' }] } },
    { id: 4, method: 'turn/start', params: { developerInstructions: 'Host turn', collaborationMode: { mode: 'plan', settings: { model: 'selected', developer_instructions: 'Host mode' } } } },
    { id: 5, method: 'turn/interrupt', params: { threadId: 'existing', turnId: 'running' } },
    { id: 'permission', result: { decision: 'decline' } },
  ];
  for (const role of ['supervisor', 'lead', 'peer']) {
    const argv = [join(destination, 'bin/codex-role.mjs'), role, 'app-server'];
    const env = { ...process.env, SLP_CODEX_BIN: fake };
    const actual = execFileSync(process.execPath, argv, { env, input: messages.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(JSON.parse);
    const instruction = roleInstructions(destination, role);
    assert.equal(actual[0].params.developerInstructions, `Paseo orchestration tools\n\n${instruction}`);
    assert.equal(actual[1].params.developerInstructions, `Resume context\n\n${instruction}`);
    assert.equal(actual[0].params.approvalPolicy, 'never');
    assert.equal(actual[0].params.sandbox, 'danger-full-access');
    assert.deepEqual(actual[0].params.config, messages[0].params.config);
    assert.deepEqual(actual[2], messages[2]);
    assert.ok(actual[3].params.collaborationMode.settings.developer_instructions.endsWith(instruction));
    assert.deepEqual(actual.slice(4), messages.slice(4));
    assert.equal(roleBundle(destination, role).orchestrates, role !== 'peer');
    // The injected bytes carry the required review-gate invariant to the
    // orchestrating roles and the re-read trigger to Lead alone; both reach
    // the seat on thread/start and thread/resume (same instruction string).
    assert.equal(/does not license merging\s+the axes into one seat/.test(instruction), role !== 'peer');
    assert.equal(/When the assignment or protocol\s+requires independent review/.test(instruction), role === 'lead');
    // The C8 formation pins ride the same delegation block: the decision
    // table, formation record, placement pin and post-create verification
    // reach Supervisor and Lead, never Peer.
    assert.equal(/Observe-existing-work/.test(instruction), role !== 'peer');
    assert.equal(/Continuation: same team and ownership/.test(instruction), role !== 'peer');
    assert.equal(/formation record/.test(instruction), role !== 'peer');
    assert.equal(/not evidence of parentage/.test(instruction), role !== 'peer');
    assert.equal(/not filesystem\s+isolation/.test(instruction), role !== 'peer');
    assert.equal(/send_agent_prompt to a\s+parentless or differently parented/.test(instruction), role !== 'peer');
    assert.equal(/second workspace\s+for the same team with no isolation reason/.test(instruction), role !== 'peer');
    // The inbound-route self-check rides common.md — a self-check, not formation
    // doctrine — so it reaches every role including Peer.
    assert.match(instruction, /paseo\.parent-agent-id label must match/);
    assert.match(instruction, /distinct from your\s+parent/);
    assert.match(instruction, /not a hard block/);
    assert.match(instruction, /names no agent\s+recipient/);
    assert.equal(/standalone session never makes\s+it your child/.test(instruction), role === 'supervisor');
    assert.equal(/does not adopt it/.test(instruction), role === 'lead');
    assert.equal(execFileSync(process.execPath, [argv[0], role, '--version'], { env, encoding: 'utf8' }).trim(), 'probe-ok');
  }
});

test('one-command installer registers profiles and reloads the selected home, uninstall removes them', t => {
  const { dir, home, destination } = fixture(t);
  writeFileSync(join(home, 'paseo.pid'), json({ listen: '127.0.0.1:12345' }));
  const fakeBin = join(dir, 'bin'); mkdirSync(fakeBin);
  const paseo = join(fakeBin, 'paseo');
  writeFileSync(paseo, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(process.env.PASEO_HOME + '/reload-receipt', process.argv.slice(2).join(' ')); console.log(JSON.stringify({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }));\n`);
  chmodSync(paseo, 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, SLP_HOME: destination, PASEO_HOME: home };
  const result = JSON.parse(execFileSync('bash', [join(root, 'install.sh')], { env, encoding: 'utf8', timeout: 5000 }));
  assert.equal(result.applied, true);
  assert.equal(result.reloadRequired, false);
  assert.equal(readFileSync(join(home, 'reload-receipt'), 'utf8'), 'reload --host 127.0.0.1:12345 --json');
  assert.equal(readJson(join(home, 'config.json')).daemon.agentProfiles.length, 2);
  execFileSync(process.execPath, [join(destination, 'bin/slp.mjs'), 'uninstall', destination, '--apply', '--reload'], { env, timeout: 5000 });
  assert.equal(readJson(join(home, 'config.json')).daemon.agentProfiles.length, 0);
  assert.equal(existsSync(destination), false);
});

test('repeat install preserves user-selected settings without rewriting config', t => {
  const { home, destination } = fixture(t);
  installPaseo(root, destination, home, true);
  const current = readJson(join(home, 'config.json'));
  current.daemon.agentProfiles[0].modeId = 'full-access'; config(home, current);
  const before = readFileSync(join(home, 'config.json'), 'utf8');
  assert.equal(installPaseo(root, destination, home, true).alreadyInstalled, true);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
});

test('reload failure reports applied files and leaves a usable installation for retry', t => {
  const { dir, home, destination } = fixture(t);
  const fakeBin = join(dir, 'bin'); mkdirSync(fakeBin);
  const paseo = join(fakeBin, 'paseo');
  writeFileSync(paseo, '#!/bin/sh\nexit 23\n'); chmodSync(paseo, 0o755);
  writeFileSync(join(home, 'paseo.pid'), json({ listen: '127.0.0.1:12345' }));
  let failure;
  try {
    execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'install', destination, '--paseo-home', home, '--apply', '--reload'], {
      env: { ...process.env, PATH: fakeBin }, encoding: 'utf8', timeout: 5000,
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.status, 1);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.applied, true);
  assert.equal(report.reloadRequired, true);
  assert.match(report.reloadError, /Files applied/);
  verifyInstall(destination);
  assert.equal(readJson(join(home, 'config.json')).daemon.agentProfiles.length, 2);
});

test('install scaffolds no user-scope catalog; uninstall preserves legacy and pool files', t => {
  const { home, destination } = fixture(t);
  installPaseo(root, destination, home, true);
  // Neither the retired legacy path nor the plugin-owned pool is created by
  // install — the pool is authored through the plugin Manager surface.
  assert.equal(existsSync(join(home, 'slp-routing.json')), false);
  assert.equal(existsSync(join(home, 'slp-runtime', 'state', 'peer-pool.json')), false);
  // Pre-existing files in the home survive uninstall untouched: the legacy
  // catalog stays for the one-time import, and plugin state is never removed.
  writeFileSync(join(home, 'slp-routing.json'), 'Human catalog');
  mkdirSync(join(home, 'slp-runtime', 'state'), { recursive: true });
  writeFileSync(join(home, 'slp-runtime', 'state', 'peer-pool.json'), json(emptyCatalog()));
  uninstallPaseo(destination, true);
  assert.equal(readFileSync(join(home, 'slp-routing.json'), 'utf8'), 'Human catalog');
  assert.deepEqual(readJson(join(home, 'slp-runtime', 'state', 'peer-pool.json')), emptyCatalog());
  const { home: home2, destination: dest2 } = fixture(t);
  writeFileSync(join(home2, 'slp-routing.json'), 'Human catalog');
  installPaseo(root, dest2, home2, true);
  assert.equal(readFileSync(join(home2, 'slp-routing.json'), 'utf8'), 'Human catalog');
});

// A minimal alternate candidate: enough structure for identity()/install()
// without copying the whole repository.
function fakeSource(dir, marker) {
  const source = join(dir, `source-${marker}`);
  mkdirSync(join(source, 'bin'), { recursive: true });
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'package.json'), json({ name: 'paseo-slp', version: marker }));
  writeFileSync(join(source, 'install.sh'), '#!/bin/sh\n');
  for (const name of ['codex-role.mjs', 'pi-role.mjs', 'devin-role.mjs', 'claude-role.mjs', 'slp.mjs'])
    writeFileSync(join(source, 'bin', name), `// ${marker}\n`);
  writeFileSync(join(source, 'src', 'roles.md'), marker);
  return source;
}

test('an intact installation updates in place, preserving tuned settings', t => {
  const { dir, home, destination } = fixture(t);
  installPaseo(root, destination, home, true);
  const current = readJson(join(home, 'config.json'));
  current.daemon.agentProfiles[0].modeId = 'full-access'; config(home, current);
  const source2 = fakeSource(dir, 'v2');
  const preview = installPaseo(source2, destination, home);
  assert.equal(preview.updated, true);
  assert.equal(preview.applied, false);
  assert.equal(readFileSync(join(destination, 'src/monitor.mjs'), 'utf8').length > 0, true);
  const applied = installPaseo(source2, destination, home, true);
  assert.equal(applied.updated, true);
  verifyInstall(destination);
  assert.equal(readFileSync(join(destination, 'src/roles.md'), 'utf8'), 'v2');
  assert.equal(existsSync(join(destination, 'src/monitor.mjs')), false);
  const cfg = readJson(join(home, 'config.json'));
  assert.equal(Object.keys(cfg.agents.providers).filter(id => id.startsWith('slp-')).length, 12);
  assert.equal(cfg.daemon.agentProfiles[0].modeId, 'full-access');
  assert.equal(readJson(join(destination, 'paseo-binding.json')).configPath, join(home, 'config.json'));
  assert.equal(installPaseo(source2, destination, home, true).alreadyInstalled, true);
});

test('a modified installation refuses in-place update', t => {
  const { dir, home, destination } = fixture(t);
  installPaseo(root, destination, home, true);
  const source2 = fakeSource(dir, 'v2');
  writeFileSync(join(destination, 'src/monitor.mjs'), 'human tweak');
  assert.throws(() => installPaseo(source2, destination, home, true), /candidate changed/);
  assert.equal(readFileSync(join(destination, 'src/monitor.mjs'), 'utf8'), 'human tweak');
});

test('an extra top-level file refuses in-place update', t => {
  const { dir, home, destination } = fixture(t);
  installPaseo(root, destination, home, true);
  const source2 = fakeSource(dir, 'v2');
  writeFileSync(join(destination, 'notes.txt'), 'keep');
  assert.throws(() => installPaseo(source2, destination, home, true), /Extra files/);
  assert.equal(existsSync(join(destination, 'notes.txt')), true);
});

test('a standalone install updates in place and never drops extra files', t => {
  const { dir, destination } = fixture(t);
  install(root, destination);
  const source2 = fakeSource(dir, 'v2');
  const result = update(source2, destination);
  assert.equal(result.updated, true);
  verifyInstall(destination);
  assert.equal(readFileSync(join(destination, 'src/roles.md'), 'utf8'), 'v2');
  writeFileSync(join(destination, 'human.txt'), 'keep');
  assert.throws(() => update(source2, destination), /Extra files/);
  assert.equal(readFileSync(join(destination, 'human.txt'), 'utf8'), 'keep');
});

test('bare --paseo-home and SLP_HOME resolve the documented defaults', t => {
  const { home, destination } = fixture(t);
  const env = unmanagedEnv({ PASEO_HOME: home, SLP_HOME: destination });
  const result = JSON.parse(execFileSync(process.execPath,
    [join(root, 'bin/slp.mjs'), 'install', '--paseo-home', '--apply'], { env, encoding: 'utf8', timeout: 5000 }));
  assert.equal(result.destination, destination);
  assert.equal(readJson(join(home, 'config.json')).daemon.agentProfiles.length, 2);
});

test('the default install dir follows the platform data convention', () => {
  assert.equal(installHome('linux', {}, '/h'), '/h/.local/share/paseo-slp');
  assert.equal(installHome('linux', { XDG_DATA_HOME: '/xdg' }, '/h'), '/xdg/paseo-slp');
  assert.equal(installHome('darwin', {}, '/h'), '/h/Library/Application Support/paseo-slp');
  assert.equal(installHome('win32', { LOCALAPPDATA: 'C:/LA' }, 'C:/u'), 'C:/LA/paseo-slp');
  assert.equal(installHome('win32', {}, 'C:/u'), 'C:/u/AppData/Local/paseo-slp');
});

test('saved profiles default to the host\'s enabled provider family', t => {
  const { home, destination } = fixture(t);
  config(home, { version: 1, agents: { providers: { pi: { enabled: true } } }, daemon: {} });
  installPaseo(root, destination, home, true);
  const profiles = readJson(join(home, 'config.json')).daemon.agentProfiles;
  assert.equal(profiles.find(p => p.id === 'slp-lead').provider, 'slp-pi-lead');
  assert.equal(profiles.find(p => p.id === 'slp-supervisor').provider, 'slp-pi-supervisor');
  // Claude is a valid default and never outranks an earlier enabled family.
  const second = fixture(t);
  config(second.home, { version: 1, agents: { providers: { claude: { enabled: true } } }, daemon: {} });
  installPaseo(root, second.destination, second.home, true);
  assert.equal(readJson(join(second.home, 'config.json')).daemon.agentProfiles.find(p => p.id === 'slp-lead').provider, 'slp-claude-lead');
  const third = fixture(t);
  config(third.home, { version: 1, agents: { providers: { codex: { enabled: true }, claude: { enabled: true } } }, daemon: {} });
  installPaseo(root, third.destination, third.home, true);
  assert.equal(readJson(join(third.home, 'config.json')).daemon.agentProfiles.find(p => p.id === 'slp-lead').provider, 'slp-codex-lead');
});
