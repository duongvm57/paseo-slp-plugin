import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { identity, install, readJson, json, hash, verifyInstall } from '../plugin/server/runtime/cli/package.ts';
import { installPaseo, upgradePaseo, initWorkspace } from '../plugin/server/runtime/cli/paseo-install.ts';
import { resolveProfile } from '../plugin/server/runtime/cli/profiles.ts';
import { launchPlan, handoffPlan } from '../plugin/server/runtime/cli/launch.ts';
import { roleInstructions, roleBundle, roleDelivery } from '../plugin/server/runtime/cli/role-bundle.ts';

import { piRoleArgs, acpRolePrompt, claudeRolePrompt } from '../plugin/server/runtime/cli/role-transport.ts';
import { readCatalog, emptyCatalog, validateCatalog } from '../plugin/server/runtime/cli/routing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/routing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = join(dir, 'installed');
  return { dir, installed };
}
const profiles = [
  { id: 'slp-peer', provider: 'slp-codex-peer', model: 'gpt-5.6-luna' },
  { id: 'slp-lead', provider: 'slp-codex-lead', model: 'gpt-5.6-luna', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast_mode: true } },
];
// list_providers returns availability but need not return the extends field.
const providers = ['slp-codex-peer', 'slp-pi-peer', 'slp-devin-peer', 'slp-claude-peer', 'slp-codex-lead', 'slp-pi-lead', 'slp-devin-lead', 'slp-claude-lead', 'pi', 'devin', 'claude'].map(id => ({ id, enabled: true, status: 'available' }));
const request = { role: 'peer', repository: root, workspaceId: 'workspace', assignment: 'Inspect cancellation ownership; no code writes.', profiles, providers };
// Test pool fixture — independent of examples/, which is a documentation
// skeleton and must never contain launchable model names.
const testCatalog = () => ({ version: 1, policy: 'Test pool.', quotaFallback: { enabled: false, optionId: null }, options: [
  { id: 'luna-code', provider: 'codex', roles: ['peer'], model: 'gpt-5.6-luna', thinkingOptionId: 'medium', enabled: true, availability: 'unknown', suitableFor: ['coding'], avoidFor: [], notes: 'coding seat' },
  { id: 'luna-reason', provider: 'codex', roles: ['peer'], model: 'gpt-5.6-luna', thinkingOptionId: 'high', enabled: true, availability: 'unknown', suitableFor: ['reasoning'], avoidFor: [], notes: 'reasoning seat' },
  { id: 'glm-design', provider: 'pi', roles: ['peer'], model: 'opencode/glm-5.3-flash', thinkingOptionId: 'medium', enabled: true, availability: 'unknown', suitableFor: ['architect'], avoidFor: [], notes: 'pi seat' },
  { id: 'swe2-medium', provider: 'devin', roles: ['peer'], model: 'swe-2-medium', modeId: 'bypass', features: { auto_accept: true }, enabled: true, availability: 'unknown', suitableFor: ['coding'], avoidFor: [], notes: 'devin seat' },
  { id: 'swe2-high', provider: 'devin', roles: ['peer'], model: 'swe-2-high', modeId: 'bypass', features: { auto_accept: true }, enabled: true, availability: 'unknown', suitableFor: ['exploration'], avoidFor: [], notes: 'devin seat' },
  { id: 'swe2-max', provider: 'devin', roles: ['peer'], model: 'swe-2-max', modeId: 'bypass', features: { auto_accept: true }, enabled: true, availability: 'unknown', suitableFor: ['ambiguous'], avoidFor: [], notes: 'devin seat' },
  { id: 'claude-seat', provider: 'claude', roles: ['peer'], model: 'claude-synthetic-1', thinkingOptionId: 'medium', enabled: true, availability: 'unknown', suitableFor: ['coding'], avoidFor: [], notes: 'claude seat' },
] });
function catalogFixture(dir) {
  mkdirSync(join(dir, '.paseo-slp'), { recursive: true });
  const path = join(dir, '.paseo-slp/slp-routing.json');
  const catalog = testCatalog();
  catalog.options.forEach(option => { option.availability = 'ready'; });
  writeFileSync(path, json(catalog));
  const route = optionId => ({ optionId, catalogSha256: readCatalog(dir).sha256 });
  return { path, catalog, route };
}

test('Supervisor and Lead use saved profiles; Peer uses the project pool without profile fallback', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const saved = ['supervisor', 'lead'].map((role, i) => ({
    id: `slp-${role}`, provider: `slp-pi-${role}`, model: `upstream/model-${i}`,
    thinkingOptionId: i ? 'high' : 'medium', featureValues: { enabled: true },
  }));
  const inventory = [...saved.map(profile => ({ id: profile.provider, enabled: true, status: 'available' })), ...providers];
  const launch = fields => launchPlan(installed, { ...request, repository: dir, profiles: saved, providers: inventory, ...fields });
  for (const role of ['supervisor', 'lead']) {
    const selected = saved.find(p => p.id === `slp-${role}`);
    const plan = launch({ role });
    assert.equal(plan.profileId, selected.id);
    assert.equal(plan.create.provider, `${selected.provider}/${selected.model}`);
    assert.deepEqual(plan.create.settings, { thinkingOptionId: selected.thinkingOptionId, features: selected.featureValues });
    assert.throws(() => launch({ role, route: { model: 'other' } }), /Saved profile settings cannot be overridden/);
  }
  assert.throws(() => launch({}), /Peer requires a project routing option/);
  const { path, catalog, route } = catalogFixture(dir);
  const peer = launch({ route: route('glm-design') });
  assert.equal(peer.profileId, undefined);
  assert.equal(peer.create.provider, 'slp-pi-peer/opencode/glm-5.3-flash');
  const staleProfiles = [...saved, { id: 'slp-peer', provider: 'slp-codex-peer', model: 'wrong/model' }];
  assert.equal(launch({ profiles: staleProfiles, route: route('glm-design') }).create.provider, peer.create.provider);
  assert.throws(() => launch({ profiles: staleProfiles }), /Peer requires a project routing option/);
  assert.throws(() => launch({ route: { ...route('glm-design'), model: 'other' } }), /conflicting/);
  assert.throws(() => launch({ route: { ...route('glm-design'), profileId: 'slp-peer' } }), /conflicting/);
  catalog.options = [];
  writeFileSync(path, json(catalog));
  assert.throws(() => launch({ profiles: staleProfiles, route: route('glm-design') }), /Unknown routing option/);
  rmSync(path);
  assert.throws(() => launch({ route: { optionId: 'glm-design', catalogSha256: 'old' }, paseoHome: join(dir, 'no-home') }), /Missing Peer pool/);
});

test('Lead selects independent runtime bundles for one Peer role without a disposition mapping', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const { route } = catalogFixture(dir);
  const launch = fields => launchPlan(installed, { ...request, profiles: undefined, repository: dir, ...fields });
  const engineer = launch({ disposition: 'Engineer', route: route('luna-code') });
  const architect = launch({ disposition: 'architect', route: route('glm-design') });
  assert.equal(engineer.create.provider, 'slp-codex-peer/gpt-5.6-luna');
  assert.equal(architect.create.provider, 'slp-pi-peer/opencode/glm-5.3-flash');
  assert.deepEqual(engineer.create.settings, { thinkingOptionId: 'medium', features: {} });
  assert.deepEqual(architect.create.settings, { thinkingOptionId: 'medium', features: {} });
  for (const plan of [engineer, architect]) {
    assert.ok(!plan.create.initialPrompt.includes(readFileSync(join(installed, 'src/roles/peer.md'), 'utf8')), 'Installed Peer wrapper supplies policy, not the task prompt');
    assert.equal(roleBundle(installed, plan.role).parts.includes('delegation.md'), false);
  }
  assert.match(architect.create.initialPrompt, /Disposition: architect/);
  assert.equal(resolveProfile('peer', profiles, providers, { disposition: 'auditor' }).profileId, 'slp-peer');
  const secondEngineer = launch({ disposition: 'engineer', route: route('glm-design') });
  assert.equal(secondEngineer.create.provider, architect.create.provider);
  assert.equal(secondEngineer.routing.optionId, 'glm-design');
  assert.equal(launch({ disposition: 'proof-auditor', route: route('luna-reason') }).create.settings.thinkingOptionId, 'high');
  const staleProfiles = [...profiles, { id: 'slp-peer-architect', provider: 'slp-pi-peer', model: 'old' }];
  assert.equal(resolveProfile('peer', staleProfiles, providers, { disposition: 'architect' }).profileId, 'slp-peer');
});

test('prepared titles distinguish Peer dispositions and work scopes without changing bundles', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const { route } = catalogFixture(dir);
  const input = { ...request, repository: dir, route: route('luna-code'), taskLabel: 'checkout totals' };
  const engineer = launchPlan(installed, { ...input, disposition: 'engineer' });
  const reviewer = launchPlan(installed, { ...input, disposition: 'Reviewer' });
  assert.equal(engineer.create.title, 'Peer — Engineer — checkout totals');
  assert.equal(reviewer.create.title, 'Peer — Reviewer — checkout totals');
  assert.deepEqual(engineer.create.settings, reviewer.create.settings);
  assert.equal(engineer.create.provider, reviewer.create.provider);
  assert.equal(launchPlan(installed, { ...input, disposition: 'reviewer', taskLabel: 'checkout totals / API' }).create.title,
    'Peer — Reviewer — checkout totals / API');
  assert.match(launchPlan(installed, { ...input, taskLabel: undefined }).create.title, /^Peer — General — routing-/);
  const lead = launchPlan(installed, { ...input, role: 'lead', route: undefined });
  assert.equal(lead.create.title, 'Lead — checkout totals');
  for (const taskLabel of ['', '   ', 'line\nbreak', 42, 'x'.repeat(101)]) {
    assert.throws(() => launchPlan(installed, { ...input, taskLabel }), /taskLabel/);
  }
  for (const providers of [undefined, { providers: [] }]) {
    assert.throws(() => launchPlan(installed, { ...input, providers }), /list_providers inventory required/);
  }
});

test('explicit profile overrides disposition; missing profiles, unavailable and wrong-role providers fail', () => {
  const custom = [...profiles, { id: 'human-architecture', provider: 'slp-pi-peer', model: 'b-ai/glm-5.3-flash' }];
  assert.equal(resolveProfile('peer', custom, providers, { disposition: 'architect', profileId: 'human-architecture' }).model, 'b-ai/glm-5.3-flash');
  assert.throws(() => resolveProfile('peer', custom, providers, { profileId: 'missing' }), /Missing/);
  assert.throws(() => resolveProfile('peer', profiles, providers.map(p => ({ ...p, status: 'unavailable' }))), /Unverified/);
  assert.throws(() => resolveProfile('lead', custom, providers, { profileId: 'human-architecture' }), /matching SLP/);
});

test('provider fallback requires explicit target model and clears nonportable settings', t => {
  const { installed } = fixture(t); install(root, installed);
  assert.throws(() => resolveProfile('lead', profiles, providers, { provider: 'slp-pi-lead' }), /explicit target model/);
  const route = { provider: 'slp-pi-lead', model: 'opencode/glm-5.3-flash', thinkingOptionId: 'low' };
  const plan = launchPlan(installed, { ...request, profiles: undefined, role: 'lead', binding: resolveProfile('lead', profiles, providers, route) });
  assert.equal(plan.create.provider, 'slp-pi-lead/opencode/glm-5.3-flash');
  assert.deepEqual(plan.create.settings, { thinkingOptionId: 'low', features: {} });
  const clear = launchPlan(installed, { ...request, profiles: undefined, role: 'lead', binding: resolveProfile('lead', profiles, providers, { thinkingOptionId: null, modeId: null, features: {} }) });
  assert.deepEqual(clear.create.settings, { features: {} });
});

test('stock Pi offline preparation accepts catalog model IDs and no mode', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const path = join(dir, 'request.json');
  writeFileSync(path, json({ ...request, role: 'lead', profiles: undefined, providers: undefined, binding: { provider: 'pi', model: 'commandcode/z-ai/glm-5.3-flash', thinkingOptionId: 'medium' } }));
  const plan = JSON.parse(execFileSync(process.execPath, [join(installed, 'bin/slp.mjs'), 'prepare', path], { env: { PATH: '' }, encoding: 'utf8' }));
  assert.equal(plan.create.provider, 'pi/commandcode/z-ai/glm-5.3-flash');
  assert.equal(plan.create.settings.modeId, undefined);
});

test('every binding source rejects non-object features before create.settings', t => {
  const { installed } = fixture(t); install(root, installed);
  const base = { ...request, profiles: undefined, role: 'lead' };
  const handoff = { previousAgentId: 'old-lead', reason: 'quota', authority: 'Human requests replacement', state: 'paused on snapshot',
    previousOwner: { settled: true, evidence: 'cancel receipt' }, resources: [] };
  for (const features of [[], 'fast_mode', true, 42]) {
    const binding = { provider: 'pi', model: 'opencode/glm-5.3-flash', features };
    assert.throws(() => launchPlan(installed, { ...base, binding }), /Invalid features/);
    assert.throws(() => handoffPlan(installed, { ...base, binding, handoff }), /Invalid features/);
  }
  const plan = launchPlan(installed, { ...base, binding: { provider: 'pi', model: 'opencode/glm-5.3-flash', features: { fast_mode: true } } });
  assert.deepEqual(plan.create.settings.features, { fast_mode: true });
});

test('devin bindings accept swe-2 models only and map catalog options to the acp wrapper', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const { path, catalog, route } = catalogFixture(dir);
  const lead = { ...request, profiles: undefined, repository: dir, role: 'lead' };
  for (const provider of ['devin', 'slp-devin-lead']) {
    assert.throws(() => launchPlan(installed, { ...lead, binding: { provider, model: 'gpt-5.6-luna' } }), /swe-2/);
    const plan = launchPlan(installed, { ...lead, binding: { provider, model: 'swe-2-high', modeId: 'bypass', features: { auto_accept: true } } });
    assert.equal(plan.create.provider, `${provider}/swe-2-high`);
    assert.deepEqual(plan.create.settings, { modeId: 'bypass', features: { auto_accept: true } });
  }
  // Stock devin carries the role policy in the prompt; the wrapper injects it.
  assert.ok(launchPlan(installed, { ...lead, binding: { provider: 'devin', model: 'swe-2-high' } })
    .create.initialPrompt.includes(readFileSync(join(installed, 'src/roles/lead.md'), 'utf8')));
  assert.ok(!launchPlan(installed, { ...lead, binding: { provider: 'slp-devin-lead', model: 'swe-2-high' } })
    .create.initialPrompt.includes(readFileSync(join(installed, 'src/roles/lead.md'), 'utf8')));
  // Saved-profile bindings pass through the same swe-2 gate.
  const devinProfiles = [
    { id: 'slp-lead', provider: 'slp-devin-lead', model: 'swe-2-high', modeId: 'bypass', featureValues: { auto_accept: true } },
  ];
  const profilePlan = launchPlan(installed, { ...lead, profiles: devinProfiles });
  assert.equal(profilePlan.create.provider, 'slp-devin-lead/swe-2-high');
  assert.deepEqual(profilePlan.create.settings, { modeId: 'bypass', features: { auto_accept: true } });
  assert.throws(() => launchPlan(installed, { ...lead, profiles: [{ ...devinProfiles[0], model: 'gpt-5.6-luna' }] }), /swe-2/);
  const peer = launchPlan(installed, { ...request, repository: dir, profiles: undefined, providers, route: route('swe2-medium') });
  assert.equal(peer.create.provider, 'slp-devin-peer/swe-2-medium');
  assert.deepEqual(peer.create.settings, { modeId: 'bypass', features: { auto_accept: true } });
  catalog.options.find(option => option.id === 'swe2-medium').model = 'claude-opus-5-max';
  writeFileSync(path, json(catalog));
  assert.throws(() => readCatalog(dir), /swe-2/);
});

test('claude bindings accept any discovered model and map catalog options to the claude wrapper', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const { route } = catalogFixture(dir);
  const lead = { ...request, profiles: undefined, repository: dir, role: 'lead' };
  for (const provider of ['claude', 'slp-claude-lead']) {
    const plan = launchPlan(installed, { ...lead, binding: { provider, model: 'claude-synthetic-1' } });
    assert.equal(plan.create.provider, `${provider}/claude-synthetic-1`);
  }
  // Stock claude carries the role policy in the prompt; the wrapper injects it.
  assert.ok(launchPlan(installed, { ...lead, binding: { provider: 'claude', model: 'claude-synthetic-1' } })
    .create.initialPrompt.includes(readFileSync(join(installed, 'src/roles/lead.md'), 'utf8')));
  assert.ok(!launchPlan(installed, { ...lead, binding: { provider: 'slp-claude-lead', model: 'claude-synthetic-1' } })
    .create.initialPrompt.includes(readFileSync(join(installed, 'src/roles/lead.md'), 'utf8')));
  const claudeProfiles = [
    { id: 'slp-lead', provider: 'slp-claude-lead', model: 'claude-synthetic-1', featureValues: { fast_mode: true } },
  ];
  const profilePlan = launchPlan(installed, { ...lead, profiles: claudeProfiles });
  assert.equal(profilePlan.create.provider, 'slp-claude-lead/claude-synthetic-1');
  assert.deepEqual(profilePlan.create.settings.features, { fast_mode: true });
  const peer = launchPlan(installed, { ...request, repository: dir, profiles: undefined, providers, route: route('claude-seat') });
  assert.equal(peer.create.provider, 'slp-claude-peer/claude-synthetic-1');
  assert.deepEqual(peer.create.settings, { thinkingOptionId: 'medium', features: {} });
});

test('installer registers both role transports and preserves user provider switches and model edits', t => {
  const { dir, installed } = fixture(t), home = join(dir, 'home'); mkdirSync(home);
  installPaseo(root, installed, home, true);
  const path = join(home, 'config.json');
  const config = readJson(path);
  assert.equal(Object.keys(config.agents.providers).length, 15);
  assert.equal(config.daemon.agentProfiles.length, 2);
  assert.equal(config.agents.providers['slp-pi-peer'].extends, 'pi');
  assert.equal(config.agents.providers['slp-pi-lead'].command[1], join(installed, 'bin/pi-role.mjs'));
  // Devin has no builtin client factory; its wrappers derive from the acp adapter.
  assert.equal(config.agents.providers['slp-devin-peer'].extends, 'acp');
  assert.equal(config.agents.providers['slp-devin-peer'].command[1], join(installed, 'bin/devin-role.mjs'));
  // Claude wrappers extend the builtin claude provider, launched through the Agent SDK.
  assert.equal(config.agents.providers['slp-claude-peer'].extends, 'claude');
  assert.equal(config.agents.providers['slp-claude-peer'].command[1], join(installed, 'bin/claude-role.mjs'));
  assert.equal(config.agents.providers['slp-claude-lead'].label, 'SLP claude lead');
  Object.assign(config.daemon.agentProfiles.find(p => p.id === 'slp-lead'), { provider: 'slp-pi-lead', model: 'b-ai/glm-5.3-flash', thinkingOptionId: 'medium' });
  writeFileSync(path, json(config));
  const bytes = readFileSync(path, 'utf8');
  assert.equal(installPaseo(root, installed, home, true).alreadyInstalled, true);
  assert.equal(readFileSync(path, 'utf8'), bytes);
  config.daemon.agentProfiles[0].provider = 'slp-pi-peer';
  writeFileSync(path, json(config));
  assert.throws(() => installPaseo(root, installed, home, true), /rebound profile/);
});

test('Pi wrapper appends role while preserving RPC bytes, resume, model, thinking and host extensions', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const fake = join(dir, 'fake-pi');
  const receipt = join(dir, 'args.json');
  writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(process.env.SLP_TEST_RECEIPT, JSON.stringify(process.argv.slice(2))); process.stdin.pipe(process.stdout);\n`);
  chmodSync(fake, 0o755);
  const args = ['--mode', 'rpc', '--model', 'opencode/glm-5.3-flash', '--thinking', 'medium', '--session', '/preserved/session.jsonl', '--extension', '/host/tools.ts', '--append-system-prompt', 'Host policy'];
  const input = '{"id":"unicode","type":"prompt","message":"a\u2028b"}\n{"id":"cancel","type":"abort"}\n';
  for (const role of ['supervisor', 'lead', 'peer']) {
    const output = execFileSync(process.execPath, [join(installed, 'bin/pi-role.mjs'), role, ...args], { env: { ...process.env, SLP_PI_BIN: fake, SLP_TEST_RECEIPT: receipt }, input, encoding: 'utf8', timeout: 5000 });
    assert.equal(output, input);
    assert.deepEqual(readJson(receipt), [...args, '--append-system-prompt', roleInstructions(installed, role)]);
  }
  assert.deepEqual(piRoleArgs(['--version'], 'policy'), ['--version']);
  assert.deepEqual(piRoleArgs(['--', '--version'], 'policy'), ['--append-system-prompt', 'policy', '--', '--version']);
});

test('Devin wrapper reasserts role core on follow-ups and restores the carrier after reload', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const fake = join(dir, 'fake-devin');
  writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(process.env.SLP_TEST_RECEIPT, JSON.stringify(process.argv.slice(2))); process.stdin.pipe(process.stdout);\n`);
  chmodSync(fake, 0o755);
  const prompt = (id, sessionId, text) => JSON.stringify({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } });
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'session/new', params: { cwd: '/repo' } }),
    prompt(1, 's1', 'first task'),
    prompt(2, 's1', 'follow up'),
    prompt(3, 's2', 'other session'),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'session/load', params: { sessionId: 's1' } }),
    prompt(5, 's1', 'after reload'),
  ].join('\n') + '\n';
  const output = execFileSync(process.execPath, [join(installed, 'bin/devin-role.mjs'), 'peer'], { env: { ...process.env, SLP_DEVIN_BIN: fake, SLP_TEST_RECEIPT: join(dir, 'argv.json') }, input, encoding: 'utf8', timeout: 5000 });
  assert.deepEqual(readJson(join(dir, 'argv.json')), ['acp']);
  const lines = output.trim().split('\n').map(line => JSON.parse(line));
  const instruction = roleInstructions(installed, 'peer');
  const blocks = id => lines.find(m => m.id === id).params.prompt;
  assert.equal(blocks(1)[0].type, 'text');
  assert.equal(blocks(1)[0].text, instruction);
  assert.equal(blocks(1)[1].text, 'first task');
  assert.equal(blocks(2).length, 2);
  assert.equal(blocks(2)[0].text, roleDelivery(installed, 'peer').anchor());
  assert.equal(blocks(2)[1].text, 'follow up');
  assert.ok(!blocks(2)[0].text.includes('Spawn kit —'));
  assert.ok(!blocks(2)[0].text.includes('Policy locators —'));
  assert.equal(blocks(3)[0].text, instruction);
  assert.equal(lines.find(m => m.id === 4).method, 'session/load');
  assert.equal(blocks(5)[0].text, instruction);
  // A malformed prompt must not pass silently: the agent would run without policy.
  assert.throws(() => acpRolePrompt({ method: 'session/prompt', params: { sessionId: 's', prompt: 'oops' } }, 'p', new Set()), /Malformed/);
  assert.throws(() => acpRolePrompt({ method: 'session/prompt', params: { prompt: [] } }, 'p', new Set()), /Malformed/);
  assert.equal(acpRolePrompt({ method: 'session/cancel' }, 'p', new Set()).method, 'session/cancel');
});

test('Claude wrapper appends role policy inside the SDK initialize control request', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const fake = join(dir, 'fake-claude');
  writeFileSync(fake, `#!${process.execPath}\nif(process.argv.includes('--version')) { console.log('probe-ok'); process.exit(0); } process.stdin.pipe(process.stdout);\n`);
  chmodSync(fake, 0o755);
  const sdkArgs = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--model', 'claude-synthetic-1'];
  const instruction = roleInstructions(installed, 'peer');
  const messages = [
    // r1/r2: defensive shapes — an emitter forwarding the preset object verbatim.
    // SDK 0.3.246 hoists options.systemPrompt.append to top-level instead (r3/r5).
    { type: 'control_request', request_id: 'r1', request: { subtype: 'initialize', sdkMcpServers: ['paseo'], systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Daemon prompt' } } },
    { type: 'control_request', request_id: 'r2', request: { subtype: 'initialize', systemPrompt: { type: 'preset', preset: 'claude_code' } } },
    // r3: the real SDK 0.3.246 wire shape (preset hoisted, systemPrompt dropped).
    { type: 'control_request', request_id: 'r3', request: { subtype: 'initialize', appendSystemPrompt: 'Daemon append' } },
    { type: 'control_request', request_id: 'r4', request: { subtype: 'initialize', systemPrompt: ['Fully custom prompt'] } },
    // r5: both fields present — the policy must join both, not silently pick one.
    { type: 'control_request', request_id: 'r5', request: { subtype: 'initialize', appendSystemPrompt: 'Daemon append', systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Preset append' } } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'bounded task' }] } },
    { type: 'control_response', response: { request_id: 'r1', subtype: 'success' } },
    { type: 'control_cancel_request', request_id: 'r9' },
  ];
  const env = { ...process.env, SLP_CLAUDE_BIN: fake };
  const run = argv => execFileSync(process.execPath, argv, { env, input: messages.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: 5000 });
  const lines = run([join(installed, 'bin/claude-role.mjs'), 'peer', ...sdkArgs]).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].request.systemPrompt.append, `Daemon prompt\n\n${instruction}`);
  assert.deepEqual(lines[0].request.sdkMcpServers, ['paseo']);
  assert.equal(lines[1].request.systemPrompt.append, instruction);
  assert.equal(lines[1].request.systemPrompt.preset, 'claude_code');
  assert.equal(lines[2].request.appendSystemPrompt, `Daemon append\n\n${instruction}`);
  assert.equal(lines[3].request.appendSystemPrompt, instruction);
  assert.deepEqual(lines[3].request.systemPrompt, ['Fully custom prompt']);
  assert.equal(lines[4].request.systemPrompt.append, `Preset append\n\n${instruction}`);
  assert.equal(lines[4].request.appendSystemPrompt, `Daemon append\n\n${instruction}`);
  assert.deepEqual(lines.slice(5), messages.slice(5));
  // Injection is idempotent when the policy already sits in the append field.
  const done = claudeRolePrompt(messages[0], instruction);
  assert.equal(claudeRolePrompt(done, instruction).request.systemPrompt.append, done.request.systemPrompt.append);
  assert.equal(claudeRolePrompt(messages[5], instruction), messages[5]);
  // Non-protocol invocations (--version, auth, interactive) stay a plain passthrough.
  assert.equal(execFileSync(process.execPath, [join(installed, 'bin/claude-role.mjs'), 'peer', '--version'], { env, encoding: 'utf8' }).trim(), 'probe-ok');
  // An unrecognized --input-format warns but preserves byte-for-byte passthrough.
  const rawInput = 'plain passthrough bytes\n';
  const fallback = spawnSync(process.execPath, [join(installed, 'bin/claude-role.mjs'), 'peer', '--input-format', 'json'], {
    env, input: rawInput, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.stdout, rawInput);
  assert.match(fallback.stderr, /--input-format.+stream-json.+passthrough/i);
  // The '--flag=value' arg style still selects protocol mode.
  const eqLines = run([join(installed, 'bin/claude-role.mjs'), 'peer', '--output-format=stream-json', '--input-format=stream-json']).trim().split('\n').map(JSON.parse);
  assert.equal(eqLines[2].request.appendSystemPrompt, `Daemon append\n\n${instruction}`);
});

test('quota handoff preserves evidence and old parentage, emits only new-session arguments', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const replacement = { ...request, profiles: undefined, role: 'lead', binding: { provider: 'slp-pi-lead', model: 'opencode/glm-5.3-flash', thinkingOptionId: 'medium' },
    handoff: { previousAgentId: 'old-lead', reason: 'quota', authority: 'Human requests Pi replacement; existing edit scope only.', state: 'Architect report ready; Engineer paused on snapshot.', previousOwner: { settled: true, evidence: 'cancel receipt and paused writer acknowledgment' }, resources: [{ agentId: 'peer-1', parentAgentId: 'old-lead', state: 'paused' }] } };
  const plan = handoffPlan(installed, replacement);
  assert.equal(plan.create.provider, 'slp-pi-lead/opencode/glm-5.3-flash');
  assert.equal(plan.handoff.resources[0].parentAgentId, 'old-lead');
  assert.match(plan.handoff.candidate.sha256, /^[a-f0-9]{64}$/);
  assert.match(plan.create.initialPrompt, /Parentage has not changed/);
  assert.match(plan.activation, /no agent started/);
  assert.throws(() => handoffPlan(installed, { ...replacement, handoff: { ...replacement.handoff, previousOwner: { settled: false } } }), /settlement evidence/);
  const path = join(dir, 'handoff.json'); writeFileSync(path, json(replacement));
  const actual = JSON.parse(execFileSync(process.execPath, [join(installed, 'bin/slp.mjs'), 'prepare-handoff', path], { encoding: 'utf8' }));
  assert.equal(actual.create.provider, plan.create.provider);
});

test('Peer handoff resolves the new project option without a saved Peer profile', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const repository = join(dir, 'repo'); mkdirSync(repository);
  execFileSync('git', ['init', '-q', repository]);
  const { route } = catalogFixture(repository);
  const current = { ...request, repository, profiles: profiles.filter(p => p.id !== 'slp-peer'),
    route: route('glm-design'), disposition: 'engineer',
    handoff: { previousAgentId: 'old-peer', reason: 'authorized runtime change',
      authority: 'Human requests a new Peer from the project pool.', state: 'Old writer paused; proof pending.',
      previousOwner: { settled: true, evidence: 'host cancellation receipt' }, resources: [] } };
  const plan = handoffPlan(installed, current);
  assert.equal(plan.profileId, undefined);
  assert.equal(plan.routing.optionId, 'glm-design');
  assert.equal(plan.create.provider, 'slp-pi-peer/opencode/glm-5.3-flash');
  assert.equal(plan.handoff.previousAgentId, 'old-peer');
  assert.equal(plan.create.title, 'Peer — Engineer — repo — Handoff');
  assert.throws(() => handoffPlan(installed, { ...current, route: undefined }), /Peer requires a project routing option/);
});

test('explicit upgrade preserves old three-profile preferences, config and live-session files', t => {
  const { dir, installed } = fixture(t), home = join(dir, 'home'); mkdirSync(home);
  installPaseo(root, installed, home, true);
  // Simulate the previous three-Codex-provider binding, not a modified user provider.
  const bindingPath = join(installed, 'paseo-binding.json');
  const old = readJson(bindingPath);
  old.providers = Object.fromEntries(Object.entries(old.providers).filter(([id]) => id.startsWith('slp-codex-')));
  old.profiles.push({ id: 'slp-peer', provider: 'slp-codex-peer', notes: 'Previous default Peer' });
  writeFileSync(bindingPath, json(old));
  const manifestPath = join(installed, 'installed.json');
  const manifest = readJson(manifestPath);
  writeFileSync(manifestPath, json({ ...manifest, paseoBindingSha256: hash(json(old)) }));
  // Older installations predate the top-level installable skill directory.
  rmSync(join(installed, 'skills'), { recursive: true });
  const legacyManifest = readJson(manifestPath);
  writeFileSync(manifestPath, json({ ...legacyManifest, candidate: identity(installed) }));
  const configPath = join(home, 'config.json');
  const config = readJson(configPath);
  config.agents.providers = old.providers;
  config.daemon.agentProfiles = structuredClone(old.profiles);
  Object.assign(config.daemon.agentProfiles.find(p => p.id === 'slp-peer'), { model: 'gpt-5.6-luna', thinkingOptionId: 'high' });
  config.humanPreference = 'preserve';
  writeFileSync(configPath, json(config));
  const before = readFileSync(configPath, 'utf8');
  const oldBytes = readFileSync(join(installed, 'src/common.md'), 'utf8');
  const next = join(dir, 'next');
  assert.equal(upgradePaseo(root, next, installed).applied, false);
  assert.equal(readFileSync(configPath, 'utf8'), before);
  const receipt = upgradePaseo(root, next, installed, true);
  assert.equal(receipt.retainedInstallation, installed);
  assert.equal(readFileSync(join(installed, 'src/common.md'), 'utf8'), oldBytes);
  verifyInstall(installed); verifyInstall(next);
  const after = readJson(configPath);
  assert.equal(after.humanPreference, 'preserve');
  assert.equal(after.daemon.agentProfiles.length, 2);
  assert.equal(after.daemon.agentProfiles.some(p => p.id === 'slp-peer'), false);
  assert.deepEqual(readJson(join(next, 'paseo-binding.json')).retiredProfiles, [config.daemon.agentProfiles.find(p => p.id === 'slp-peer')]);
  assert.equal(after.agents.providers['slp-pi-lead'].command[1], join(next, 'bin/pi-role.mjs'));
  assert.throws(() => upgradePaseo(root, next, installed, true), /new destination/);
});

test('upgrade refuses changed managed provider before writing a new installation', t => {
  const { dir, installed } = fixture(t), home = join(dir, 'home'); mkdirSync(home);
  installPaseo(root, installed, home, true);
  const path = join(home, 'config.json'), config = readJson(path);
  config.agents.providers['slp-codex-lead'].command = ['human-wrapper'];
  writeFileSync(path, json(config));
  const bytes = readFileSync(path, 'utf8');
  assert.throws(() => upgradePaseo(root, join(dir, 'next'), installed, true), /Modified provider/);
  assert.equal(readFileSync(path, 'utf8'), bytes);
});

test('quota edits invalidate prepared selections and fresh selection can use another provider', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const { path, catalog, route } = catalogFixture(dir);
  const launch = fields => launchPlan(installed, { ...request, profiles: undefined, repository: dir, ...fields });
  const stale = route('luna-code');
  catalog.options[0].availability = 'quota-exhausted';
  writeFileSync(path, json(catalog));
  assert.throws(() => launch({ route: stale }), /catalog changed/);
  assert.throws(() => launch({ route: route('luna-code') }), /availability:quota-exhausted/);
  assert.equal(launch({ route: route('glm-design') }).create.provider, 'slp-pi-peer/opencode/glm-5.3-flash');
  catalog.options[2].enabled = false;
  writeFileSync(path, json(catalog));
  assert.throws(() => launch({ route: route('glm-design') }), /excluded for peer: disabled/);
  assert.throws(() => launch({ route: route('missing') }), /Unknown routing option/);
  assert.throws(() => launch({ role: 'supervisor', route: route('luna-reason') }), /excluded/);
  assert.throws(() => launch({ route: { ...route('luna-reason'), thinkingOptionId: 'low' } }), /conflicting/);
  assert.throws(() => launch({ providers: [], route: route('luna-reason') }), /Unverified/);
  assert.throws(() => launch({ route: { optionId: 'luna-reason' } }), /hash missing/);
});

test('routes reads only the selected repo on every call, independent of host and installation location', t => {
  const { dir, installed } = fixture(t), home = join(dir, 'home'); mkdirSync(home);
  installPaseo(root, installed, home, true);
  // Install scaffolds no catalog anywhere: neither the legacy user file nor the
  // plugin-owned pool exists until the Human authors one.
  assert.equal(existsSync(join(home, 'slp-routing.json')), false);
  assert.equal(existsSync(join(home, 'slp-runtime', 'state', 'peer-pool.json')), false);
  initWorkspace(installed, dir, true);
  const path = join(dir, '.paseo-slp/slp-routing.json');
  // Init no longer writes a repository catalog by default — the fixture opts in.
  assert.equal(existsSync(path), false);
  const { catalog } = catalogFixture(dir);
  // A leftover legacy catalog is inert — routes reads only the selected repo.
  writeFileSync(join(home, 'slp-routing.json'), 'invalid legacy host catalog');
  const read = () => JSON.parse(execFileSync(process.execPath, [join(installed, 'bin/slp.mjs'), 'routes', dir], { cwd: home, env: { PATH: '', PASEO_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const first = read();
  assert.equal(first.path, path);
  catalog.options[0].thinkingOptionId = 'high';
  writeFileSync(path, json(catalog));
  assert.notEqual(read().sha256, first.sha256);
  assert.equal(read().options[0].thinkingOptionId, 'high');
  verifyInstall(installed);
  installPaseo(root, installed, home, true);
  assert.deepEqual(readJson(path), catalog);
  writeFileSync(path, '{broken');
  assert.throws(read);
  assert.throws(() => validateCatalog({ ...catalog, options: [...catalog.options, catalog.options[0]] }), /duplicate/);
  assert.throws(() => validateCatalog({ ...catalog, options: [{ ...catalog.options[0], availability: 'typo' }] }), /availability/);
});

test('upgrade archives owned disposition settings in binding without reading or writing host routing', t => {
  const { dir, installed } = fixture(t), home = join(dir, 'home'); mkdirSync(home);
  installPaseo(root, installed, home, true);
  const configPath = join(home, 'config.json'), bindingPath = join(installed, 'paseo-binding.json');
  const binding = readJson(bindingPath), config = readJson(configPath);
  const specialized = [
    { id: 'slp-peer-engineer', provider: 'slp-codex-peer', model: 'gpt-5.6-luna', thinkingOptionId: 'high', featureValues: { fast_mode: true }, notes: 'Human edited' },
    { id: 'slp-peer-architect', provider: 'slp-pi-peer', model: 'opencode/glm-5.3-flash', thinkingOptionId: 'medium' },
    { id: 'slp-peer-reviewer', provider: 'slp-codex-peer' },
    { id: 'slp-peer-scout', provider: 'slp-codex-peer' },
  ];
  binding.profiles.push(...specialized);
  config.daemon.agentProfiles.push(...specialized, { id: 'human-custom-peer', provider: 'pi', model: 'human-model' });
  writeFileSync(bindingPath, json(binding));
  const manifestPath = join(installed, 'installed.json');
  writeFileSync(manifestPath, json({ ...readJson(manifestPath), paseoBindingSha256: hash(json(binding)) }));
  writeFileSync(configPath, json(config));
  const { catalog } = catalogFixture(dir);
  const path = join(home, 'slp-routing.json'); writeFileSync(path, json(catalog));
  const next = join(dir, 'next');
  const preview = upgradePaseo(root, next, installed);
  assert.equal(preview.retiredProfiles.length, 4);
  assert.deepEqual(readJson(path), catalog);
  upgradePaseo(root, next, installed, true);
  const after = readJson(configPath).daemon.agentProfiles;
  assert.equal(after.length, 3);
  assert.equal(after.filter(p => p.id.startsWith('slp-peer')).length, 0);
  assert.ok(after.some(p => p.id === 'human-custom-peer'));
  assert.deepEqual(readJson(path), catalog);
  assert.deepEqual(readJson(join(next, 'paseo-binding.json')).retiredProfiles, specialized);
  const final = join(dir, 'final');
  writeFileSync(path, 'invalid legacy host catalog');
  upgradePaseo(root, final, next, true);
  assert.equal(readFileSync(path, 'utf8'), 'invalid legacy host catalog');
  assert.deepEqual(readJson(join(final, 'paseo-binding.json')).retiredProfiles, specialized);
});

test('same option ID can resolve differently per repo; another repo catalog cannot redirect', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const repoA = join(dir, 'repo-a'), repoB = join(dir, 'repo-b'); mkdirSync(repoA); mkdirSync(repoB);
  const a = catalogFixture(repoA), b = catalogFixture(repoB);
  b.catalog.options[0].provider = 'pi'; b.catalog.options[0].model = 'opencode/glm-5.3-flash';
  b.catalog.options[0].thinkingOptionId = 'high'; writeFileSync(b.path, json(b.catalog));
  const launch = (repository, route, fields) => launchPlan(installed, { ...request, profiles: undefined, repository, route, paseoHome: join(dir, 'no-home'), ...fields });
  assert.equal(launch(repoA, a.route('luna-code')).create.provider, 'slp-codex-peer/gpt-5.6-luna');
  assert.equal(launch(repoB, b.route('luna-code')).create.provider, 'slp-pi-peer/opencode/glm-5.3-flash');
  assert.throws(() => launch(repoB, a.route('luna-code')), /catalog changed/);
  assert.throws(() => launch(repoB, { ...b.route('luna-code'), catalogFile: a.path }), /repository-scoped/);
  rmSync(b.path);
  assert.throws(() => launch(repoB, { optionId: 'luna-code', catalogSha256: a.route('luna-code').catalogSha256 }), /Missing Peer pool/);
  assert.throws(() => readCatalog(), /Absolute repository/);
});

test('repository catalog wins over the plugin-owned user-scope pool; fallback engages only when absent', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const home = join(dir, 'home'); mkdirSync(home);
  const stateDir = join(home, 'slp-runtime', 'state'); mkdirSync(stateDir, { recursive: true });
  const hostPath = join(stateDir, 'peer-pool.json');
  const hostCatalog = emptyCatalog();
  hostCatalog.options = [{ id: 'host-peer', provider: 'pi', roles: ['peer'], model: 'opencode/host-model', enabled: true, availability: 'ready', suitableFor: ['tests'], avoidFor: [], notes: 'User-scope pool' }];
  writeFileSync(hostPath, json(hostCatalog));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  // No repository catalog: routes resolves the user-scope pool.
  let resolved = readCatalog(repo, home);
  assert.equal(resolved.path, hostPath);
  assert.equal(resolved.scope, 'user');
  const hostRoute = { optionId: 'host-peer', catalogSha256: resolved.sha256 };
  const peer = launchPlan(installed, { ...request, profiles: undefined, repository: repo, route: hostRoute, paseoHome: home });
  assert.equal(peer.create.provider, 'slp-pi-peer/opencode/host-model');
  assert.equal(peer.routing.catalogScope, 'user');
  assert.equal(peer.routing.catalogFile, hostPath);
  // Repository catalog wins when present, even with different options.
  const { path, catalog } = catalogFixture(repo);
  resolved = readCatalog(repo, home);
  assert.equal(resolved.path, path);
  assert.equal(resolved.scope, 'repository');
  assert.throws(() => launchPlan(installed, { ...request, profiles: undefined, repository: repo, route: hostRoute, paseoHome: home }), /catalog changed|Unknown routing option/);
  // A malformed repository file is an authoring error, not a fallback trigger.
  writeFileSync(path, '{broken');
  assert.throws(() => readCatalog(repo, home), SyntaxError);
  // Both scopes absent: the error names both paths. The legacy
  // <home>/slp-routing.json is never read — even when it is the only file.
  rmSync(path); rmSync(hostPath);
  writeFileSync(join(home, 'slp-routing.json'), json(hostCatalog));
  assert.throws(() => readCatalog(repo, home), /Missing Peer pool.*no repository catalog.*no user-scope pool/s);
  // A regular file squatting on a path prefix (slp-runtime here) surfaces as
  // ENOTDIR — it resolves to the same missing-pool message, not a bare errno.
  rmSync(join(home, 'slp-routing.json'));
  rmSync(join(home, 'slp-runtime'), { recursive: true });
  writeFileSync(join(home, 'slp-runtime'), 'not a directory');
  assert.throws(() => readCatalog(repo, home), /Missing Peer pool.*no repository catalog.*no user-scope pool/s);
  rmSync(join(home, 'slp-runtime'));
  // routes CLI resolves the fallback home via --paseo-home.
  mkdirSync(join(home, 'slp-runtime', 'state'), { recursive: true });
  writeFileSync(hostPath, json(hostCatalog));
  const routes = () => JSON.parse(execFileSync(process.execPath, [join(installed, 'bin/slp.mjs'), 'routes', repo, '--paseo-home', home], { env: { PATH: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(routes().path, hostPath);
  assert.equal(routes().scope, 'user');
});

test('repository catalog vs live user-scope pool drift is reported, never reconciled', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const home = join(dir, 'home');
  const stateDir = join(home, 'slp-runtime', 'state'); mkdirSync(stateDir, { recursive: true });
  const poolPath = join(stateDir, 'peer-pool.json');
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const { path, catalog, route } = catalogFixture(repo);
  // The run-5 drift shape: the repo catalog pins swe-2-max while the live
  // pool carries swe-2-high for the same seat, plus a pool-only seat and a
  // repo-only seat.
  const pool = testCatalog();
  pool.options.forEach(option => { option.availability = 'ready'; });
  pool.options = pool.options.filter(option => option.id !== 'luna-code');
  pool.options.find(option => option.id === 'swe2-max').model = 'swe-2-high';
  pool.options.push({ id: 'pool-extra', provider: 'pi', roles: ['peer'], model: 'opencode/x', enabled: true, availability: 'ready', suitableFor: [], avoidFor: [], notes: 'pool only' });
  writeFileSync(poolPath, json(pool));

  const resolved = readCatalog(repo, home);
  assert.equal(resolved.scope, 'repository');
  const drift = resolved.poolDrift;
  assert.equal(drift.identical, false);
  assert.equal(drift.userPoolPath, poolPath);
  assert.deepEqual(drift.options.find(o => o.id === 'swe2-max').fields.model, { catalog: 'swe-2-max', pool: 'swe-2-high' });
  assert.deepEqual(drift.options.find(o => o.id === 'luna-code'), { id: 'luna-code', onlyIn: 'catalog' });
  assert.deepEqual(drift.options.find(o => o.id === 'pool-extra'), { id: 'pool-extra', onlyIn: 'pool' });
  // prepare still binds the repository catalog, but warns and records drift.
  const plan = launchPlan(installed, { ...request, profiles: undefined, repository: repo, route: route('swe2-max'), paseoHome: home });
  assert.equal(plan.create.provider, 'slp-devin-peer/swe-2-max');
  assert.equal(plan.routing.poolDrift.userPoolPath, poolPath);
  assert.match(plan.warnings.find(w => w.includes('differs from the live user-scope pool')), /"swe-2-max" \(catalog\) vs "swe-2-high" \(pool\)/);
  // A repo-only seat warns differently; a pool-only seat stays silent.
  const repoOnly = launchPlan(installed, { ...request, profiles: undefined, repository: repo, route: route('luna-code'), paseoHome: home });
  assert.match(repoOnly.warnings.find(w => w.includes('has no seat in the live user-scope pool')), /luna-code/);
  // Identical sources report identical:true and produce no drift warning.
  writeFileSync(poolPath, json(catalog));
  const clean = launchPlan(installed, { ...request, profiles: undefined, repository: repo, route: route('swe2-max'), paseoHome: home });
  assert.equal(clean.routing.poolDrift.identical, true);
  assert.equal((clean.warnings ?? []).some(w => w.includes('user-scope pool')), false);
  // An unreadable pool still reports its sha and the error — never read as
  // "no pool to compare".
  writeFileSync(poolPath, '{broken');
  const broken = readCatalog(repo, home);
  assert.equal(typeof broken.poolDrift.userPoolSha256, 'string');
  assert.match(broken.poolDrift.error, /JSON|valid/i);
  const planBroken = launchPlan(installed, { ...request, profiles: undefined, repository: repo, route: route('swe2-max'), paseoHome: home });
  assert.match(planBroken.warnings.find(w => w.includes('could not be compared')), /peer-pool/);
});

test('routes output carries the Jev routing mode for the daemon', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const home = join(dir, 'home');
  const stateDir = join(home, 'slp-runtime', 'state'); mkdirSync(stateDir, { recursive: true });
  const repo = join(dir, 'repo'); mkdirSync(repo);
  catalogFixture(repo);
  const jevPath = join(stateDir, 'jev.json');
  const routes = () => JSON.parse(execFileSync(process.execPath, [join(installed, 'bin/slp.mjs'), 'routes', repo, '--paseo-home', home], { env: { PATH: '' }, encoding: 'utf8' }));
  assert.deepEqual(routes().jevRouting, { routing: 'unconfigured' });
  writeFileSync(jevPath, json({ schemaVersion: 1, enabled: false }));
  assert.deepEqual(routes().jevRouting, { routing: 'off' });
  writeFileSync(jevPath, json({ schemaVersion: 1, enabled: true, capabilities: {}, provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' } }));
  assert.deepEqual(routes().jevRouting, { routing: 'shadow' });
  writeFileSync(jevPath, json({ schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' } }));
  assert.deepEqual(routes().jevRouting, { routing: 'armed' });
  // A corrupt config reports error, never reads as unconfigured.
  writeFileSync(jevPath, '{broken');
  assert.equal(routes().jevRouting.routing, 'error');
});

test('pool validation: provider may be blank only while disabled; priority is not required', () => {
  const parked = { id: 'parked', provider: '', roles: ['peer'], model: '', enabled: false, availability: 'ready', suitableFor: [], avoidFor: [], notes: 'Parked seat — Human fills provider and model later' };
  assert.doesNotThrow(() => validateCatalog({ ...emptyCatalog(), options: [parked] }));
  // A file still carrying the removed `priority` key keeps validating —
  // unknown extra keys are tolerated, not rejected.
  assert.doesNotThrow(() => validateCatalog({ ...emptyCatalog(), options: [{ ...parked, priority: 10 }] }));
  // Enabled requires a real family and a real model.
  assert.throws(() => validateCatalog({ ...emptyCatalog(), options: [{ ...parked, enabled: true }] }), /provider must be/);
  assert.throws(() => validateCatalog({ ...emptyCatalog(), options: [{ ...parked, provider: 'pi', enabled: true }] }), /invalid model/);
  // A parked devin seat with a blank model is inert config; enabling it still
  // requires a swe-2 model.
  const devin = { ...parked, id: 'devin-parked', provider: 'devin' };
  assert.doesNotThrow(() => validateCatalog({ ...emptyCatalog(), options: [devin] }));
  assert.throws(() => validateCatalog({ ...emptyCatalog(), options: [{ ...devin, enabled: true }] }), /invalid model/);
  assert.throws(() => validateCatalog({ ...emptyCatalog(), options: [{ ...devin, enabled: true, model: 'gpt-5' }] }), /swe-2/);
});

test('quota fallback stays within the authorized project pool and preserves complete bundles', t => {
  const { dir, installed } = fixture(t); install(root, installed);
  const {path, catalog, route} = catalogFixture(dir);
  const launch = overrides => launchPlan(installed, {...request, profiles: undefined, repository:dir, route:{...route('glm-design'), quotaFallbackFrom:'luna-code', ...overrides}});
  assert.throws(()=>launch(), /disabled or target/);
  delete catalog.quotaFallback; writeFileSync(path,json(catalog));
  assert.throws(()=>launch(), /disabled or target/);
  catalog.quotaFallback={enabled:true,optionId:'glm-design'};writeFileSync(path,json(catalog));
  const plan=launch();
  execFileSync('git',['init','-q',dir]);
  const handoff = {previousAgentId:'old-peer',reason:'quota',authority:'project quotaFallback',state:'read-only findings retained',previousOwner:{settled:true,evidence:'host idle and no writes'},resources:[]};
  const next = handoffPlan(installed,{...request,profiles:undefined,repository:dir,route:{...route('glm-design'),quotaFallbackFrom:'luna-code'},handoff});
  assert.equal(next.routing.quotaFallbackFrom,'luna-code');
  assert.equal(next.create.provider,plan.create.provider);
  assert.throws(()=>handoffPlan(installed,{...request,profiles:undefined,repository:dir,route:{...route('luna-reason'),quotaFallbackFrom:'luna-code'},handoff}),/not the designated option/);
  assert.equal(plan.create.provider,'slp-pi-peer/opencode/glm-5.3-flash');
  assert.equal(plan.routing.quotaFallbackFrom,'luna-code');
  assert.deepEqual(plan.create.settings,{thinkingOptionId:'medium',features:{}});
  assert.throws(()=>launch({optionId:'luna-reason'}),/disabled or target/);
  assert.throws(()=>launch({model:'gpt-5.6-sol'}),/conflicting/);
  assert.throws(()=>launchPlan(installed,{...request,repository:dir,profiles:undefined,binding:{provider:'slp-codex-peer',model:'gpt-5.6-sol'}}),/explicit bindings cannot bypass/);
  assert.throws(()=>launch({quotaFallbackFrom:'glm-design'}),/different source/);
  assert.throws(()=>launch({quotaFallbackFrom:'outside-pool'}),/different source/);
  const stale=route('glm-design').catalogSha256;
  catalog.options.find(o=>o.id==='glm-design').availability='quota-exhausted';writeFileSync(path,json(catalog));
  assert.throws(()=>launch({catalogSha256:stale}),/changed or hash missing/);
  assert.throws(()=>launch(),/availability:quota-exhausted/);
  for(const fallback of [{enabled:true,optionId:'outside-pool'},{enabled:true,optionId:null},{enabled:'true',optionId:'glm-design'},{enabled:true,optionId:'glm-design',model:'gpt-5.6-sol'},{enabled:true,optionIds:['outside-pool']},{enabled:true,optionIds:['glm-design','glm-design']},{enabled:true,optionId:'glm-design',optionIds:['glm-design']}]) {
    assert.throws(()=>validateCatalog({...catalog,quotaFallback:fallback}),/quotaFallback/);
  }
});
