import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { install, update, verifyInstall, json, readJson, hash } from '../plugin/server/runtime/cli/package.ts';
import { installPaseo, upgradePaseo, uninstallPaseo, initWorkspace, installHome } from '../plugin/server/runtime/cli/paseo-install.ts';
import { configFile, writeConfig } from '../plugin/server/runtime/cli/host-config.ts';
import { emptyCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { roleInstructions, roleBundle } from '../plugin/server/runtime/cli/role-bundle.ts';

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

test('standalone install requires an exclusive destination for directories, files and symlinks', t => {
  const { dir } = fixture(t);
  const existingDirectory = join(dir, 'existing-directory');
  mkdirSync(existingDirectory);
  writeFileSync(join(existingDirectory, 'sentinel.txt'), 'preserve directory\n');
  const existingFile = join(dir, 'existing-file');
  writeFileSync(existingFile, 'preserve file\n');
  const symlinkTarget = join(dir, 'symlink-target');
  mkdirSync(symlinkTarget);
  writeFileSync(join(symlinkTarget, 'sentinel.txt'), 'preserve symlink target\n');
  const existingSymlink = join(dir, 'existing-symlink');
  symlinkSync(symlinkTarget, existingSymlink, 'dir');

  for (const destination of [existingDirectory, existingFile, existingSymlink]) {
    assert.throws(() => install(root, destination), error => error.code === 'EEXIST', destination);
  }
  assert.equal(readFileSync(join(existingDirectory, 'sentinel.txt'), 'utf8'), 'preserve directory\n');
  assert.equal(readFileSync(existingFile, 'utf8'), 'preserve file\n');
  assert.equal(lstatSync(existingSymlink).isSymbolicLink(), true);
  assert.equal(readFileSync(join(symlinkTarget, 'sentinel.txt'), 'utf8'), 'preserve symlink target\n');
  assert.equal(existsSync(join(existingDirectory, 'installed.json')), false);
  assert.equal(existsSync(join(symlinkTarget, 'installed.json')), false);
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
  for (const role of ['supervisor', 'lead']) {
    assert.match(readFileSync(join(destination, `src/roles/${role}.md`), 'utf8'),
      /read .*workspace-protocol\.md[\s\S]*before (?:replying|a\s+reply|replies\/tactics)/i);
  }
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
    // The exact loaded bundle above preserves transport bytes. These pins
    // verify role-specific semantic responsibility and operating disclosure.
    assert.match(instruction, /Review selection never waives\s+a Human, assignment or protocol obligation/);
    assert.equal(/ordinary\/Lean creation or observation/.test(instruction), role !== 'peer');
    assert.equal(/references\/task-execution.md/.test(instruction), role !== 'peer');
    assert.equal(/When the assignment or protocol\s+requires independent review/.test(instruction), role === 'lead');
    assert.equal(/Reviewer\/Auditor stays independent of writer and accepting owner/.test(instruction), role === 'peer');
    assert.match(instruction, /parent\/report recipient must match your paseo\.parent-agent-id\s+label/);
    assert.match(instruction, /Unexposed labels are a visibility gap/);
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

test('update and upgrade preserve the original MCP baseline and accumulate exact retired profile rows', t => {
  for (const operation of ['update', 'upgrade']) {
    const { dir, home, destination } = fixture(t);
    const source = fakeSource(dir, 'old');
    const before = { version: 1, privateSetting: 'keep out of receipt', daemon: {
      mcp: { enabled: false, injectIntoAgents: false, humanFlag: 'keep' },
      agentProfiles: [{ id: 'personal', provider: 'codex', model: 'personal-model' }],
    } };
    config(home, before);
    installPaseo(source, destination, home, true);
    const bindingPath = join(destination, 'paseo-binding.json');
    const prior = readJson(bindingPath);
    assert.equal(Object.hasOwn(prior, 'retiredProfiles'), false, 'fresh receipts omit the archive');
    assert.deepEqual(prior.mcpBefore, { enabled: false, injectIntoAgents: false });
    const archived = { id: 'slp-peer-scout', provider: 'slp-codex-peer', notes: 'already archived' };
    const legacy = { id: 'slp-peer', provider: 'slp-pi-peer', model: 'old-peer-model', featureValues: { old: true } };
    prior.retiredProfiles = [archived];
    prior.profiles.push(legacy);
    writeFileSync(bindingPath, json(prior));
    const manifestPath = join(destination, 'installed.json');
    writeFileSync(manifestPath, json({ ...readJson(manifestPath), paseoBindingSha256: hash(json(prior)) }));
    const current = readJson(join(home, 'config.json'));
    const tuned = current.daemon.agentProfiles.find(p => p.id === 'slp-lead');
    Object.assign(tuned, { provider: 'slp-pi-lead', model: 'human-model', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { human: true } });
    current.daemon.agentProfiles.push(legacy);
    current.newHumanSetting = 'keep';
    config(home, current);
    const originalConfig = readFileSync(join(home, 'config.json'), 'utf8');
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const next = operation === 'upgrade' ? join(dir, 'next') : destination;
    const source2 = fakeSource(dir, 'new');
    const rebind = apply => operation === 'upgrade'
      ? upgradePaseo(source2, next, destination, apply)
      : installPaseo(source2, next, home, apply);
    const preview = rebind(false);
    assert.deepEqual(preview.retiredProfiles, ['slp-peer'], operation);
    assert.deepEqual(preview.profiles.find(p => p.id === 'slp-lead'), tuned);
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), originalConfig);
    assert.equal(readFileSync(manifestPath, 'utf8'), originalManifest);
    rebind(true);
    const receiptBytes = readFileSync(join(next, 'paseo-binding.json'), 'utf8');
    const receipt = JSON.parse(receiptBytes);
    assert.deepEqual(receipt.mcpBefore, { enabled: false, injectIntoAgents: false });
    assert.deepEqual(receipt.retiredProfiles, [archived, legacy]);
    assert.deepEqual(receipt.profiles.find(p => p.id === 'slp-lead'), tuned);
    assert.equal(receiptBytes.includes('keep out of receipt'), false);
    assert.equal(verifyInstall(next).paseoBindingSha256, hash(receiptBytes));
    const after = readJson(join(home, 'config.json'));
    assert.deepEqual(after.daemon.agentProfiles, [before.daemon.agentProfiles[0], ...receipt.profiles]);
    assert.equal(after.newHumanSetting, 'keep');
    assert.equal(after.daemon.mcp.humanFlag, 'keep');
    assert.equal(after.agents.providers['slp-codex-lead'].command[1], join(next, 'bin/codex-role.mjs'));
    if (operation === 'upgrade') assert.equal(readFileSync(manifestPath, 'utf8'), originalManifest, 'retained candidate untouched');
  }
});

test('host config commit failure rolls back fresh install, in-place swap and side-by-side upgrade independently', t => {
  for (const operation of ['install', 'update', 'upgrade']) {
    const { dir, home, destination } = fixture(t);
    const source = fakeSource(dir, 'old');
    config(home, { version: 1, privateSetting: 'keep', daemon: { mcp: { enabled: true, injectIntoAgents: true } } });
    if (operation !== 'install') installPaseo(source, destination, home, true);
    const configBytes = readFileSync(join(home, 'config.json'), 'utf8');
    const priorManifest = operation === 'install' ? null : readFileSync(join(destination, 'installed.json'), 'utf8');
    const priorBinding = operation === 'install' ? null : readFileSync(join(destination, 'paseo-binding.json'), 'utf8');
    const next = operation === 'upgrade' ? join(dir, 'next') : destination;
    // A real exclusive-write blocker at the host-config seam, before the operation.
    const blocker = join(home, `config.json.slp-${process.pid}.tmp`);
    writeFileSync(blocker, 'Human blocker');
    const source2 = fakeSource(dir, 'new');
    assert.throws(() => operation === 'upgrade'
      ? upgradePaseo(source2, next, destination, true)
      : installPaseo(source2, next, home, true), error => error.code === 'EEXIST', operation);
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), configBytes);
    assert.equal(readFileSync(blocker, 'utf8'), 'Human blocker');
    assert.equal(existsSync(`${next}.staging-${process.pid}`), false);
    assert.equal(existsSync(`${next}.replaced-${process.pid}`), false);
    if (operation === 'install') assert.equal(existsSync(destination), false);
    else {
      assert.equal(readFileSync(join(destination, 'installed.json'), 'utf8'), priorManifest);
      assert.equal(readFileSync(join(destination, 'paseo-binding.json'), 'utf8'), priorBinding);
      verifyInstall(destination);
      if (operation === 'upgrade') assert.equal(existsSync(next), false);
    }
  }
});

test('rebind guards preserve operation-specific MCP and provider failure precedence', t => {
  const { dir, home, destination } = fixture(t);
  const source = fakeSource(dir, 'old');
  installPaseo(source, destination, home, true);
  const current = readJson(join(home, 'config.json'));
  current.daemon.mcp.enabled = false;
  config(home, current);
  const bytes = readFileSync(join(home, 'config.json'), 'utf8');
  const missingSource = join(dir, 'missing-source');
  assert.throws(() => installPaseo(missingSource, destination, home, true), /requires Paseo MCP enabled/, 'update gates MCP before probing source identity');
  const next = join(dir, 'next');
  assert.equal(upgradePaseo(source, next, destination).applied, false, 'upgrade preview does not gate MCP');
  assert.throws(() => upgradePaseo(missingSource, next, destination, true), error => error.code === 'ENOENT', 'upgrade installs before gating MCP');
  assert.throws(() => upgradePaseo(source, next, destination, true), /requires Paseo MCP enabled/);
  assert.equal(existsSync(next), false);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), bytes);
  current.agents.providers['slp-codex-lead'].command = ['human-wrapper'];
  config(home, current);
  assert.throws(() => installPaseo(missingSource, destination, home, true), /Modified provider slp-codex-lead; preserve installation/);
  assert.throws(() => upgradePaseo(missingSource, next, destination, true), /Modified provider slp-codex-lead; preserve previous installation/);
  verifyInstall(destination);
});

test('an intact installation updates in place, preserving tuned settings', t => {
  const { dir, home, destination } = fixture(t);
  installPaseo(root, destination, home, true);
  const current = readJson(join(home, 'config.json'));
  current.daemon.agentProfiles[0].modeId = 'full-access'; config(home, current);
  const source2 = fakeSource(dir, 'v2');
  const preview = installPaseo(source2, destination, home);
  assert.equal(preview.updated, true);
  assert.equal(preview.applied, false);
  assert.equal(readFileSync(join(destination, 'plugin/server/runtime/cli/monitor.ts'), 'utf8').length > 0, true);
  const applied = installPaseo(source2, destination, home, true);
  assert.equal(applied.updated, true);
  verifyInstall(destination);
  assert.equal(readFileSync(join(destination, 'src/roles.md'), 'utf8'), 'v2');
  assert.equal(existsSync(join(destination, 'plugin/server/runtime/cli/monitor.ts')), false);
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
  writeFileSync(join(destination, 'plugin/server/runtime/cli/monitor.ts'), 'human tweak');
  assert.throws(() => installPaseo(source2, destination, home, true), /candidate changed/);
  assert.equal(readFileSync(join(destination, 'plugin/server/runtime/cli/monitor.ts'), 'utf8'), 'human tweak');
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
