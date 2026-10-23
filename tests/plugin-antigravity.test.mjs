import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAntigravityProvider } from '../plugin/server/antigravity/provider.ts';
import { loadHostModule } from './helpers/plugin-doubles.mjs';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';
import { auditCapabilities, CAPABILITY_IDS } from '../plugin/server/capabilities.ts';

// Native-wire double: no installed agy, account, daemon or network is used.
function fakeAgy(t, version = "1.4.4") {
  const cwd = mkdtempSync(join(tmpdir(), 'slp-antigravity-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'agy.mjs'), capture = join(cwd, 'input.jsonl');
  writeFileSync(file, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
if (process.argv.includes('models')) { console.log('gemini-test\\tTest model'); process.exit(0); }
appendFileSync(process.env.TEST_CAPTURE + '.argv', JSON.stringify(process.argv.slice(2)) + '\\n');
appendFileSync(process.env.TEST_CAPTURE + '.environment', (process.env.SLP_ANTIGRAVITY_MCP_V1 || '{}') + '\\n');
if (process.env.TEST_FAIL_OPEN) { console.error('fake startup failed'); process.exit(1); }
const conversation = 'native-conversation';
console.log(JSON.stringify({ event: 'init', conversation_id: conversation, init: { model: 'gemini-test' } }));
let ordinal = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line); appendFileSync(process.env.TEST_CAPTURE, JSON.stringify(frame) + '\\n');
  console.log(JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: conversation, step_index: ordinal++, state: 'DONE', step_type: 'agent_response', text_delta: 'done',
    usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0 }
  }}));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS' } }));
}
`);
  return { cwd, capture, launch: { command: process.execPath, args: [file], env: { TEST_CAPTURE: capture } } };
}

function exchange(connection, input, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`no reply to ${input.type}`)); }, 5000);
    const off = connection.onEvent(event => {
      if (event.type === 'request.failed' || event.type === 'session.runtime_failed') {
        clearTimeout(timer); off(); reject(new Error(JSON.stringify(event))); return;
      }
      if (predicate(event)) { clearTimeout(timer); off(); resolve(event); }
    });
    Promise.resolve(connection.send(input)).catch(error => { clearTimeout(timer); off(); reject(error); });
  });
}

test('Antigravity registered role provider discovers and runs native turns with persisted role context', async t => {
  const f = fakeAgy(t);
  const registration = createAntigravityProvider('slp-antigravity-peer', 'SLP Antigravity Peer');
  assert.equal(registration.id, 'slp-antigravity-peer');
  assert.equal(registration.requiresConfiguration, true);
  const fallback = { command: registration.command[0], args: registration.command.slice(1), env: f.launch.env };
  assert.equal((await registration.status({ launch: fallback })).available, false);
  assert.equal(await registration.getCatalogCacheKey({ launch: fallback }), undefined);
  await assert.rejects(registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES, launch: fallback }), /supply the Antigravity launch/);
  assert.deepEqual(await registration.status({ launch: f.launch }), { available: true });
  const connection = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES, launch: f.launch });
  t.after(() => connection.close());
  const events = []; connection.onEvent(event => events.push(event));
  const catalog = await exchange(connection, { type: 'catalog', requestId: 'catalog', cwd: f.cwd }, e => e.type === 'catalog');
  assert.equal(catalog.catalog.models[0].id, 'gemini-test');
  await exchange(connection, { type: 'session.open', requestId: 'open', sessionId: 'seat', config: {
    cwd: f.cwd, env: {}, mcpServers: {}, model: 'gemini-test', mode: 'full-access', systemPrompt: 'ROLE POLICY', persist: true,
  } }, e => e.type === 'session.ready');
  for (const [id, text] of [['first', 'first brief'], ['second', 'follow-up']]) {
    await exchange(connection, { type: 'session.prompt', sessionId: 'seat', prompt: {
      clientMessageId: id, delivery: 'turn', input: { type: 'message', content: [{ type: 'text', text }] },
    } }, e => e.type === 'session.turn' && e.state === 'completed');
  }
  const sent = readFileSync(f.capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(sent[0].message.content, 'ROLE POLICY\n\nfirst brief');
  assert.equal(sent[1].message.content, 'ROLE POLICY\n\nfollow-up');
  assert.deepEqual(events.filter(e => e.type === 'timeline.item' && e.item.type === 'user_message').map(e => e.item.text), ['first brief', 'follow-up']);
  assert.ok(events.some(e => e.type === 'session.opened' && e.persistence.data.conversationId === 'native-conversation'));
  assert.equal(connection.capabilities.includes('prompt.steer'), false);
  await assert.rejects(connection.send({ type: 'session.prompt', sessionId: 'seat', prompt: {
    clientMessageId: 'steer', delivery: 'steer', input: { type: 'message', content: [{ type: 'text', text: 'never send' }] },
  } }), /prompt.steer/);
  const persistence = events.find(e => e.type === 'session.opened').persistence;
  await exchange(connection, { type: 'session.close', sessionId: 'seat', requestId: 'close' }, e => e.type === 'session.closed');
  await exchange(connection, { type: 'session.open', requestId: 'resume', sessionId: 'resumed', persistence, config: {
    cwd: f.cwd, env: {}, mcpServers: {}, model: 'gemini-test', mode: 'full-access', systemPrompt: 'ROLE POLICY', persist: true,
  } }, e => e.type === 'session.ready');
  await exchange(connection, { type: 'session.prompt', sessionId: 'resumed', prompt: {
    clientMessageId: 'third', delivery: 'turn', input: { type: 'message', content: [{ type: 'text', text: 'after resume' }] },
  } }, e => e.type === 'session.turn' && e.state === 'completed');
  const resumedSent = readFileSync(f.capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(resumedSent[2].message.content, 'ROLE POLICY\n\nafter resume', 'resume reasserts current role instructions');
  const launches = readFileSync(f.capture + '.argv', 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(!launches[0].includes('--conversation'));
  assert.equal(launches[1][launches[1].indexOf('--conversation') + 1], 'native-conversation');

});

test('Antigravity records configured MCP plumbing without claiming full live acceptance', () => {
  const { records } = auditCapabilities({ now: new Date(0).toISOString(), observed: { rpcDispatched: false, providersSnapshot: null, agentsList: null } });
  const row = records.find(r => r.family === 'antigravity' && r.capabilityId === CAPABILITY_IDS.mcpStdioLaunch);
  assert.equal(row.status, 'supported');
  assert.match(row.evidenceRef, /current session environment/);
  const live = records.find(r => r.family === 'antigravity' && r.capabilityId === CAPABILITY_IDS.probeCreateMcpEnv);
  assert.equal(live.status, 'unknown');
});

// Exercise host launch resolution with a native-wire double, never a live daemon.
test('host resolves the explicit launcher override and leaves the default unavailable', async t => {
  const host = await loadHostModule('agent/plugin-provider.js');
  if (!host?.PluginAgentClientRegistry) { t.skip('host provider module unavailable'); return; }
  const f = fakeAgy(t);
  const registry = new host.PluginAgentClientRegistry({ warn() {} });
  t.after(() => registry.shutdown());
  const registration = createAntigravityProvider('slp-antigravity-peer');
  registry.replace([registration]);
  assert.equal(await registry.clients()[registration.id].isAvailable(), false);
  const client = registry.definitions()[registration.id].createClient({ warn() {} }, {
    command: { mode: 'replace', argv: [f.launch.command, ...f.launch.args] }, env: f.launch.env,
  });
  assert.equal(await client.isAvailable(), true, JSON.stringify(await client.getDiagnostic()));
  const catalog = await client.fetchCatalog({ scope: 'workspace', cwd: f.cwd });
  assert.equal(catalog.models[0].id, 'gemini-test');
});

test('older native CLIs fail catalog admission before a session is opened', async t => {
  const f = fakeAgy(t, '1.4.3');
  const registration = createAntigravityProvider('slp-antigravity-peer');
  assert.equal((await registration.status({ launch: f.launch })).available, false);
  const connection = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES, launch: f.launch });
  t.after(() => connection.close());
  await assert.rejects(exchange(connection, { type: 'catalog', requestId: 'old', cwd: f.cwd }, e => e.type === 'catalog'), /1.4.4/);
});

test('MCP opens bind persistence, refresh endpoint data and refuse changed native declarations', async t => {
  const f = fakeAgy(t);
  const registration = createAntigravityProvider('slp-antigravity-peer');
  const connection = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES, launch: f.launch });
  t.after(() => connection.close());
  const cfg = token => ({ cwd: f.cwd, env: {}, mcpServers: { paseo: { type: 'http', url: 'http://127.0.0.1/' + token, headers: { Authorization: token } } }, model: 'gemini-test', mode: 'full-access', persist: true });
  const first = await exchange(connection, { type: 'session.open', requestId: 'one', sessionId: 'one', config: cfg('old') }, e => e.type === 'session.opened');
  assert.equal(first.persistence.version, 3);
  await exchange(connection, { type: 'session.close', requestId: 'close-one', sessionId: 'one' }, e => e.type === 'session.closed');
  const firstArgs = JSON.parse(readFileSync(f.capture + '.argv', 'utf8').trim());
  const roots = firstArgs.flatMap((arg, i) => arg === '--add-dir' ? [firstArgs[i + 1]] : []).filter(p => p !== f.cwd);
  assert.equal(roots.length, 1); assert.equal(existsSync(roots[0]), false);
  const resumed = await exchange(connection, { type: 'session.open', requestId: 'two', sessionId: 'two', config: cfg('new'), persistence: first.persistence }, e => e.type === 'session.opened');
  assert.equal(resumed.persistence.data.mcpNamespace, first.persistence.data.mcpNamespace);
  assert.equal(resumed.persistence.data.mcpBinding, first.persistence.data.mcpBinding);
  const maps = readFileSync(f.capture + '.environment', 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(maps[1].servers.paseo.headers.Authorization, 'new');
  const legacyV2 = { version: 2, data: { conversationId: first.persistence.data.conversationId, mcpBinding: first.persistence.data.mcpBinding } };
  await assert.rejects(exchange(connection, { type: 'session.open', requestId: 'old-mcp', sessionId: 'old-mcp', config: cfg('new'), persistence: legacyV2 }, e => e.type === 'session.opened'), /MCP_BINDING_CHANGED/);
  const legacyV1 = { version: 1, data: { conversationId: first.persistence.data.conversationId } };
  await assert.rejects(exchange(connection, { type: 'session.open', requestId: 'v1-mcp', sessionId: 'v1-mcp', config: cfg('new'), persistence: legacyV1 }, e => e.type === 'session.opened'), /MCP_BINDING_CHANGED/);
  const changedNamespace = { ...first.persistence, data: { ...first.persistence.data, mcpNamespace: 'b'.repeat(32) } };
  await assert.rejects(exchange(connection, { type: 'session.open', requestId: 'namespace', sessionId: 'namespace', config: cfg('new'), persistence: changedNamespace }, e => e.type === 'session.opened'), /MCP_BINDING_CHANGED/);
  const noMcp = { ...cfg('new'), mcpServers: {} };
  const { mcpBinding } = await import('../plugin/server/antigravity/internal/mcp.ts');
  for (const version of [1, 2]) {
    const old = { version, data: { conversationId: first.persistence.data.conversationId, ...(version === 2 ? { mcpBinding: mcpBinding(noMcp) } : {}) } };
    const migrated = await exchange(connection, { type: 'session.open', requestId: 'legacy-' + version, sessionId: 'legacy-' + version, config: noMcp, persistence: old }, e => e.type === 'session.opened');
    assert.equal(migrated.persistence.version, 3);
  }
  const different = cfg('new'); different.mcpServers = { another: different.mcpServers.paseo };
  await assert.rejects(exchange(connection, { type: 'session.open', requestId: 'different', sessionId: 'different', config: different, persistence: first.persistence }, e => e.type === 'session.opened'), /MCP_BINDING_CHANGED/);
});

test('failed native MCP opens remove their temporary carrier', async t => {
  const f = fakeAgy(t); f.launch.env.TEST_FAIL_OPEN = 'yes';
  const registration = createAntigravityProvider('slp-antigravity-peer');
  const connection = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES, launch: f.launch });
  t.after(() => connection.close());
  await assert.rejects(exchange(connection, { type: 'session.open', requestId: 'fail', sessionId: 'fail', config: {
    cwd: f.cwd, env: {}, mcpServers: { slp_desk: { type: 'stdio', command: '/bin/false' } }, model: 'gemini-test', mode: 'full-access', persist: true,
  } }, e => e.type === 'session.opened'), /fake startup failed/);
  const args = JSON.parse(readFileSync(f.capture + '.argv', 'utf8').trim());
  const root = args.flatMap((arg, i) => arg === '--add-dir' ? [args[i + 1]] : []).find(p => p !== f.cwd);
  assert.equal(typeof root, 'string'); assert.equal(existsSync(root), false);
});
