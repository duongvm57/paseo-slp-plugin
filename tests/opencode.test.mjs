import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, json } from '../plugin/server/runtime/cli/package.ts';
import { configurationPlan } from '../plugin/server/runtime/cli/paseo-install.ts';
import { createRoleInjection } from '../plugin/server/role-injection.ts';
import { launchPlan } from '../plugin/server/runtime/cli/launch.ts';
import { readCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { createExecutableResolver } from '../plugin/server/executables.ts';
import { createLauncherBuilder } from '../plugin/server/launchers.ts';
import { supportsOpenCodeVersion } from '../plugin/shared/runtime/opencode-version.mjs';
import { loadHostModule } from './helpers/plugin-doubles.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-opencode-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const candidate = join(dir, 'candidate');
  const { candidate: identity } = install(root, candidate);
  return { dir, candidate, sha: identity.sha256 };
}
const envFor = f => ({ HOME: f.dir, PATH: '/usr/bin:/bin', PASEO_HOME: join(f.dir, 'home') });
const bindingFor = f => ({ candidateSha256: f.sha, payloadSha256: 'a'.repeat(64), runtimePath: f.candidate, nodePath: process.execPath, daemonHome: join(f.dir, 'home') });

test('OpenCode version selection refuses V1, too-old V2, unknown majors and malformed output', () => {
  for (const version of ['opencode v2.0.24', '2.0.10', '2.1.0', 'opencode 2.0.24+build']) assert.equal(supportsOpenCodeVersion(version), true, version);
  for (const version of ['1.14.46', '2.0.9', '3.0.0', 'opencode development', '2.0', '2.0.24\nnoise', 'not-opencode 2.0.24']) assert.equal(supportsOpenCodeVersion(version), false, version);
});

test('installed Paseo cold selector limitation: failed version discovery can select legacy with first-manager settings', async t => {
  const mod = await loadHostModule('agent/providers/opencode/runtime-client.js');
  if (!mod?.OpenCodeRuntimeClient) { t.skip('installed V2 selector unavailable; cold-path source claim not verified'); return; }
  const logger = { child() { return this; }, warn() {}, info() {}, debug() {}, error() {}, trace() {} };
  const first = new mod.OpenCodeRuntimeClient(logger, { command: { mode: 'replace', argv: ['/bin/false'] } });
  const selectedSettings = { command: { mode: 'replace', argv: ['/bin/false'] }, env: { SLP_SELECTOR_FIXTURE: 'alias' } };
  const alias = new mod.OpenCodeRuntimeClient(logger, selectedSettings);
  const selected = await alias.client();
  assert.equal(selected.constructor.name, 'OpenCodeAgentClient');
  assert.equal(alias.legacySelected, true);
  assert.notEqual(selected.serverManager.runtimeSettingsKey, JSON.stringify(selectedSettings));
  assert.equal(selected.serverManager, first.legacy.serverManager);
  await alias.shutdown();
});

test('managed role injection preserves the complete OpenCode bundle, options, MCP and env', async t => {
  const f = fixture(t);
  const injection = createRoleInjection({ readActiveBinding: () => bindingFor(f), verifyCandidate: async () => {}, deskMint: async () => ({ handle: 'a'.repeat(64) }) });
  for (const role of ['supervisor', 'lead', 'peer']) {
    const config = { provider: `slp-opencode-${role}`, cwd: f.dir, model: 'provider/nested/model', modeId: 'plan', thinkingOptionId: 'high', featureValues: { auto_accept: false, custom: 'keep' }, providerOptions: { permission: { bash: 'ask' } }, mcpServers: { existing: { type: 'stdio', command: '/bin/true', env: { KEEP: 'yes' } } }, systemPrompt: 'Human instructions' };
    const out = await injection.agentCreate({ request: { config, env: { KEEP: 'yes' } } });
    assert.deepEqual({ ...out.config, systemPrompt: config.systemPrompt }, config);
    assert.deepEqual(out.config, config, 'ACP keeps config intact instead of relying on systemPrompt');
    assert.deepEqual(out.env, { KEEP: 'yes', SLP_DESK_HANDLE: 'a'.repeat(64) });
    for (const reason of ['create', 'resume', 'refresh', 'import']) {
      const open = injection.sessionOpen({ request: { provider: config.provider, cwd: f.dir, agentId: 'agent', workspaceId: 'workspace', reason, purpose: 'interactive', env: { KEEP: 'yes', SLP_SESSION_OPEN_GRANT: '' } } });
      assert.equal(open.env.KEEP, 'yes');
      assert.ok(open.env.SLP_SESSION_OPEN_GRANT.length > 0);
    }
  }
  const unbound = createRoleInjection({ readActiveBinding: () => { throw new Error('wrapper verifies its own candidate'); }, verifyCandidate: async () => {} });
  assert.equal(await unbound.agentCreate({ request: { config: { provider: 'slp-opencode-peer', cwd: f.dir } } }), undefined);
});

test('pool and saved profiles preserve nested OpenCode model IDs and all launch settings on the ACP adapter', t => {
  const f = fixture(t);
  const model = 'provider/nested/model';
  mkdirSync(join(f.dir, '.paseo-slp'));
  writeFileSync(join(f.dir, '.paseo-slp/slp-routing.json'), json({ version: 1, policy: 'fixture', quotaFallback: { enabled: false, optionId: null }, options: [{ id: 'open', provider: 'opencode', model, roles: ['peer'], enabled: true, availability: 'ready', modeId: 'plan', thinkingOptionId: 'high', features: { auto_accept: false }, suitableFor: [], avoidFor: [], notes: 'Bounded OpenCode fixture' }] }));
  for (const transport of ['acp']) {
    const providers = ['peer', 'lead', 'supervisor'].map(role => ({ id: `slp-opencode-${role}`, enabled: true, status: 'available', extends: transport }));
    const base = { repository: f.dir, workspaceId: 'workspace', assignment: 'Inspect only.', providers };
    const peer = launchPlan(f.candidate, { ...base, role: 'peer', route: { optionId: 'open', catalogSha256: readCatalog(f.dir).sha256 } });
    assert.equal(peer.create.provider, `slp-opencode-peer/${model}`);
    assert.deepEqual(peer.create.settings, { modeId: 'plan', thinkingOptionId: 'high', features: { auto_accept: false } });
    for (const role of ['lead', 'supervisor']) {
      const saved = { id: `slp-${role}`, provider: `slp-opencode-${role}`, model, modeId: 'plan', thinkingOptionId: 'high', featureValues: { auto_accept: false } };
      const out = launchPlan(f.candidate, { ...base, role, profiles: [saved] });
      assert.equal(out.create.provider, `${saved.provider}/${model}`);
      assert.deepEqual(out.create.settings, peer.create.settings);
    }
    for (const extendsValue of ['opencode', undefined]) {
      const wrong = providers.map(({ extends: ignored, ...p }) => extendsValue === undefined ? p : { ...p, extends: extendsValue });
      assert.throws(() => launchPlan(f.candidate, { ...base, providers: wrong, role: 'peer', route: { optionId: 'open', catalogSha256: readCatalog(f.dir).sha256 } }), /Unverified provider family/);
    }
  }
  const config = configurationPlan(f.candidate, { version: 1 });
  for (const role of ['peer', 'lead', 'supervisor']) {
    assert.equal(config.providers[`slp-opencode-${role}`].extends, 'acp');
    assert.deepEqual(config.providers[`slp-opencode-${role}`].command, [process.execPath, join(f.candidate, 'bin/opencode-role.mjs'), role]);
  }
});

test('resolver refuses unsupported explicit OpenCode and follows the verified V2 PATH alias', async t => {
  const f = fixture(t);
  const binary = join(f.dir, 'native');
  const alias = join(f.dir, 'opencode');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); symlinkSync(binary, alias);
  let version = 'opencode v2.0.24';
  const resolver = createExecutableResolver({ env: { PATH: f.dir }, run: async (file, args) => ({ code: 0, stderr: '', stdout: args[0] === '-e' ? JSON.stringify({ node: process.versions.node, electron: null, execPath: process.execPath }) : version }) });
  const request = { daemonHome: join(f.dir, 'home'), stableRoot: join(f.dir, 'stable'), nodePath: process.execPath };
  assert.equal((await resolver.resolve(request)).binaries.opencode.path, alias);
  for (version of ['1.14.46', '2.0.9', '3.0.0', 'garbage']) {
    assert.equal((await resolver.resolve(request)).binaries.opencode.available, false);
    await assert.rejects(resolver.resolve({ ...request, binaries: { opencode: alias } }), /requires OpenCode V2/);
  }
});

test('standalone ACP injects entry and repeated core, rearms after resume, and preserves non-prompt frames', t => {
  const f = fixture(t);
  const fake = join(f.dir, 'opencode');
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode v2.0.24"; exit 0; fi\ncat\n', { mode: 0o755 });
  const initialize = '{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1 } }';
  const prompt = { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'task' }], untouched: 'keep' } };
  const settings = { jsonrpc: '2.0', id: 3, method: 'session/set_config_option', params: { sessionId: 's', configId: 'model', value: 'provider/nested/model' } };
  const resume = { jsonrpc: '2.0', id: 4, method: 'session/resume', params: { sessionId: 's', cwd: f.dir, mcpServers: [] } };
  const input = [initialize, JSON.stringify(prompt), JSON.stringify(settings), JSON.stringify(prompt), JSON.stringify(resume), JSON.stringify(prompt)].join('\n');
  const out = spawnSync(process.execPath, [join(f.candidate, 'bin/opencode-role.mjs'), 'peer'], { input, encoding: 'utf8', timeout: 10000, env: { ...envFor(f), SLP_OPENCODE_BIN: fake } });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.equal(lines[0], initialize, 'initialize passes through byte-for-byte');
  const frames = lines.map(line => JSON.parse(line));
  assert.deepEqual(frames[2], settings); assert.deepEqual(frames[4], resume);
  for (const i of [1, 3, 5]) {
    assert.deepEqual(frames[i].params.prompt[1], prompt.params.prompt[0]);
    assert.equal(frames[i].params.untouched, 'keep');
    assert.ok(frames[i].params.prompt[0].text.includes('Human authority is the ceiling'));
  }
  assert.ok(frames[1].params.prompt[0].text.includes('Policy locators — relative to Directory;'));
  assert.ok(!frames[3].params.prompt[0].text.includes('Policy locators — relative to Directory;'));
  assert.ok(frames[5].params.prompt[0].text.includes('Policy locators — relative to Directory;'));
});

test('standalone version probe passes stdout/stderr/env/exit, while native serve and unsupported ACP versions fail before spawn', t => {
  const f = fixture(t);
  const fake = join(f.dir, 'opencode'); const marker = join(f.dir, 'spawned');
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode v2.0.24:$KEEP"; echo diagnostic >&2; exit 7; fi\ntouch '${marker}'\n`, { mode: 0o755 });
  const run = args => spawnSync(process.execPath, [join(f.candidate, 'bin/opencode-role.mjs'), 'peer', ...args], { encoding: 'utf8', timeout: 10000, env: { ...envFor(f), KEEP: 'env-kept', SLP_OPENCODE_BIN: fake } });
  const probe = run(['--version']); assert.equal(probe.status, 7); assert.equal(probe.stdout, 'opencode v2.0.24:env-kept\n'); assert.equal(probe.stderr, 'diagnostic\n');
  const serve = run(['serve']); assert.equal(serve.status, 1); assert.match(serve.stderr, /native serve sessions are unsupported/); assert.equal(existsSync(marker), false);
  for (const version of ['1.14.46', '2.0.9', '3.0.0', 'garbage']) {
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\ntouch '${marker}'\n`, { mode: 0o755 });
    const out = run(['acp']); assert.equal(out.status, 1); assert.match(out.stderr, /executable version was not verified/); assert.equal(existsSync(marker), false);
  }
});

test('managed OpenCode ACP shim refuses missing grants before child spawn; live grants are consumed and role bytes survive', async t => {
  const f = fixture(t); const fake = join(f.dir, 'opencode'); const marker = join(f.dir, 'spawned');
  const writeBinary = version => writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\necho "$@:$KEEP:$SLP_SESSION_OPEN_GRANT" > '${marker}'\ncat\n`, { mode: 0o755 });
  writeBinary('opencode v2.0.24');
  const home = join(f.dir, 'home'); const stableRoot = join(home, 'slp-runtime');
  const installed = join(stableRoot, f.sha); install(root, installed);
  const binaries = Object.fromEntries(['codex','pi','devin','claude','opencode'].map(id => [id, id === 'opencode' ? { available: true, path: fake, version: 'opencode v2.0.24' } : { available: false, path: null, version: null }]));
  const set = await createLauncherBuilder().publish({ daemonHome: home, stableRoot, operationId: 'grant-proof', candidate: { sha256: f.sha, runtimePath: installed }, node: { path: process.execPath, version: process.versions.node, execPath: process.execPath }, binaries });
  const launcher = join(set.directory, 'slp-opencode-peer');
  const message = { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'local echo fixture' }] } };
  const run = (extra = {}, args = []) => spawnSync(launcher, args, { input: JSON.stringify(message)+'\n', encoding: 'utf8', timeout: 10000, env: { ...envFor(f), PASEO_AGENT_ID: 'agent', KEEP: 'env-kept', ...extra } });
  for (const grant of [undefined, '']) {
    const out = run(grant === undefined ? {} : { SLP_SESSION_OPEN_GRANT: grant }); assert.equal(out.status, 1); assert.match(out.stderr, /without live SLP hook grant/); assert.equal(existsSync(marker), false);
  }
  const probe = run({}, ['--version']); assert.equal(probe.status, 0, probe.stderr); assert.equal(probe.stdout, 'opencode v2.0.24\n'); assert.equal(existsSync(marker), false);
  const allowed = run({ SLP_SESSION_OPEN_GRANT: 'live-grant' }); assert.equal(allowed.status, 0, allowed.stderr); assert.equal(readFileSync(marker, 'utf8'), 'acp:env-kept:\n');
  const transformed = JSON.parse(allowed.stdout); assert.ok(transformed.params.prompt[0].text.startsWith('SLP role=peer\n')); assert.deepEqual(transformed.params.prompt[1], message.params.prompt[0]); rmSync(marker);
  writeBinary('1.14.46'); const refused = run({ SLP_SESSION_OPEN_GRANT: 'live-grant' }); assert.equal(refused.status, 1); assert.match(refused.stderr, /executable version was not verified/); assert.equal(existsSync(marker), false);
});


test('retired native OpenCode gate refuses execution even with a live grant', t => {
  const f = fixture(t); const fake = join(f.dir, 'native'); const marker = join(f.dir, 'native-spawned');
  writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  for (const args of [['serve'], ['--version']]) {
    const out = spawnSync(process.execPath, [join(f.candidate, 'bin/slp-gate.mjs'), ...args], { encoding: 'utf8', timeout: 10000, env: { ...envFor(f), SLP_FAMILY_BIN: fake, SLP_OPENCODE_V2_ONLY: '1', SLP_SESSION_OPEN_GRANT: 'live-grant', PASEO_AGENT_ID: 'agent' } });
    assert.equal(out.status, 1); assert.match(out.stderr, /native OpenCode transport is unsupported/); assert.equal(existsSync(marker), false);
  }
});
