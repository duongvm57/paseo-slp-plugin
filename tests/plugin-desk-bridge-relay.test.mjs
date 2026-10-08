import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { run } from '../bin/slp-desk-mcp.mjs';
import { auditCapabilities, CAPABILITY_IDS } from '../plugin/server/capabilities.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import {
  BIN_SOURCE, bridgeFixture, startBridge, gitRepo, repoOf, seedStore,
  seedMemberships, memberRow, connect, LineReader, writeFrame,
} from './helpers/desk-bridge-fixture.mjs';

const PIN = sha256Hex(readFileSync(BIN_SOURCE));
const HANDLE = 'persistent-handle';
const PROVIDER = 'slp-codex-peer';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function advanceClock(t, milliseconds) {
  // Let promise continuations and real stream events settle between ticks.
  while (milliseconds > 0) {
    const step = Math.min(milliseconds, 100);
    t.mock.timers.tick(step);
    await new Promise(resolve => setImmediate(resolve));
    milliseconds -= step;
  }
}
async function until(check) {
  for (let n = 0; n < 500; n++) { if (check()) return; await pause(10); }
  assert.fail('relay did not reach the expected state');
}
function relay(t, socketPath, dial = connect, onDiagnostic = () => {}) {
  const stdin = new Readable({ read() {} });
  const stdout = new PassThrough();
  const reader = new LineReader(stdout);
  const diagnostics = [];
  let exited = false;
  const pending = run({
    env: { SLP_DESK_SOCK: socketPath, SLP_DESK_HANDLE: HANDLE },
    platform: 'linux', stdin, stdout,
    stderr: { write: line => {
      const diagnostic = JSON.parse(line);
      diagnostics.push(diagnostic);
      onDiagnostic(diagnostic);
    } },
    connect: dial, selfSha256: PIN,
  }).then(code => { exited = true; return code; });
  t.after(() => stdin.push(null));
  return { stdin, stdout, reader, pending, diagnostics, exited: () => exited };
}
const request = (id, name = 'slp_status', args = {}) => ({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
});
const reply = async r => JSON.parse((await r.reader.next()).toString());

test('relay answers arriving requests during an outage, survives the old retry budget, and exits on stdin EOF', { timeout: 15000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const r = relay(t, '/tmp/slp-no-such-socket', async () => { throw new Error('offline'); });
  r.stdin.push(JSON.stringify(request('offline')) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  await advanceClock(t, 11500);
  const error = await reply(r);
  assert.equal(error.id, 'offline');
  assert.equal(error.error.data.slpCode, 'CAPABILITY_GAP');
  await advanceClock(t, 2000);
  assert.equal(r.exited(), false);
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
  assert.ok(r.diagnostics.length <= 32);
});

test('relay survives repeated plugin restarts, re-hellos the persisted handle and preserves dispatch guards', { timeout: 20000 }, async t => {
  const agent = { provider: PROVIDER, workspaceId: 'wks-1', archivedAt: null };
  const paseoRef = { current: { agents: { ref: () => ({ refresh: async () => ({ agent }) }) } } };
  let transportSupported = true;
  const f = await startBridge(t, bridgeFixture(t, 'slp-rehello-', PIN, { paseoRef, audit: input => {
    const result = auditCapabilities(input);
    if (!transportSupported) result.records = result.records.filter(r => r.capabilityId !== CAPABILITY_IDS.deskBridgeTransport);
    return result;
  } }));
  const repo = repoOf(gitRepo(t, 'slp-rehello-repo-'));
  const row = memberRow(HANDLE, { provider: PROVIDER, at: '2026-01-01T00:00:00.000Z' });
  await seedMemberships(seedStore(f), repo, [row]);
  let bridge = f.bridge;
  let hellos = 0;
  const seenHellos = [];
  const r = relay(t, f.paths.socketPath, async path => {
    const socket = await connect(path);
    const write = socket.write;
    socket.write = function(bytes, ...args) {
      const frame = JSON.parse(bytes.toString());
      if (frame.protocol) { hellos++; seenHellos.push(frame); }
      return write.call(this, bytes, ...args);
    };
    return socket;
  });
  t.after(() => bridge.stop());
  r.stdin.push(JSON.stringify(request(0)) + '\n');
  const initial = await reply(r);
  assert.ok(initial.result, JSON.stringify(initial));
  assert.equal(initial.result.isError, undefined);
  for (let i = 1; i <= 3; i++) {
    const drops = r.diagnostics.filter(d => d.message.includes('socket lost')).length;
    bridge.stop();
    await until(() => r.diagnostics.filter(d => d.message.includes('socket lost')).length > drops);
    bridge = f.makeBridge();
    void bridge.start();
    // Like the MCP client, send while the new listener/hello is still pending.
    r.stdin.push(JSON.stringify(request(i)) + '\n');
    const status = await reply(r);
    assert.ok(status.result, JSON.stringify(status));
    assert.equal(status.result.isError, undefined);
    assert.equal(await bridge.whenReady(), 'listening');
  }
  assert.equal(hellos, 4);
  assert.ok(seenHellos.every(h => h.handle === HANDLE && h.bridgeSha256 === PIN));
  agent.archivedAt = '2026-10-08T00:00:00.000Z';
  r.stdin.push(JSON.stringify(request('guard')) + '\n');
  const guarded = await reply(r);
  assert.equal(guarded.result.isError, true);
  assert.equal(JSON.parse(guarded.result.content[0].text).code, 'ACTOR_MISMATCH');
  agent.archivedAt = null;
  const rejected = async (id, expected, args = {}) => {
    r.stdin.push(JSON.stringify(request(id, 'slp_status', args)) + '\n');
    const answer = await reply(r);
    assert.equal(answer.result.isError, true);
    assert.equal(JSON.parse(answer.result.content[0].text).code, expected);
  };
  await rejected('strict', 'INVALID_RECORD', { agentId: 'forged' });
  transportSupported = false;
  await rejected('capability', 'CAPABILITY_GAP');
  transportSupported = true;
  await seedMemberships(seedStore(f), repo, [{ ...row, bindingHandleSha256: sha256Hex('other') }]);
  await rejected('handle-binding', 'STALE_EPOCH');
  await seedMemberships(seedStore(f), repo, [{ ...row, state: 'revoked', revokedAt: '2026-10-08T00:00:00.000Z', revokeReason: 'archived' }]);
  await rejected('fresh-epoch', 'STALE_EPOCH');
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

test('a dropped in-flight request gets EXECUTION_UNKNOWN once and is never replayed', { timeout: 10000 }, async t => {
  const net = await import('node:net');
  const f = bridgeFixture(t, 'slp-inflight-', PIN);
  const path = `${f.home}/test.sock`;
  let socket;
  let requests = 0;
  const server = net.createServer(conn => {
    socket = conn;
    let carry = '';
    let bound = false;
    conn.on('data', chunk => {
      carry += chunk.toString();
      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const frame = JSON.parse(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
        if (!bound) { bound = true; writeFrame(conn, { protocol: frame.protocol, ok: true }); }
        else { requests++; conn.destroy(); }
      }
    });
  });
  t.after(() => { socket?.destroy(); server.close(); });
  await new Promise(resolve => server.listen(path, resolve));
  const r = relay(t, path);
  await pause(30);
  r.stdin.push(JSON.stringify(request('uncertain')) + '\n');
  const error = await reply(r);
  assert.equal(error.id, 'uncertain');
  assert.equal(error.error.data.slpCode, 'EXECUTION_UNKNOWN');
  await pause(100);
  assert.equal(requests, 1);
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

test('initial hello rejection releases held requests with typed errors', { timeout: 10000 }, async t => {
  const net = await import('node:net');
  const f = bridgeFixture(t, 'slp-stalled-hello-', PIN);
  let peer;
  const server = net.createServer(conn => { peer = conn; conn.resume(); });
  t.after(() => { peer?.destroy(); server.close(); });
  const path = `${f.home}/hello.sock`;
  await new Promise(resolve => server.listen(path, resolve));
  const r = relay(t, path);
  await until(() => peer !== undefined);
  r.stdin.push(JSON.stringify(request('hello-wait')) + '\n');
  writeFrame(peer, { protocol: 'slp-desk-bridge/1', ok: false, error: { code: 'ACTOR_MISMATCH', message: 'rejected' } });
  assert.equal((await reply(r)).error.data.slpCode, 'CAPABILITY_GAP');
  assert.ok(r.diagnostics.some(d => d.code === 'ACTOR_MISMATCH'));
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

test('stdin close cancels a held initial dial and destroys its late socket', { timeout: 10000 }, async t => {
  let finishDial;
  const dial = new Promise(resolve => { finishDial = resolve; });
  const r = relay(t, '/tmp/slp-dial-pending.sock', () => dial);
  r.stdin.push(JSON.stringify(request('dial-wait')) + '\n');
  r.stdin.destroy();
  assert.equal(await r.pending, 0);
  let destroyed = false;
  finishDial({ destroy: () => { destroyed = true; } });
  await until(() => destroyed);
});

test('typed disconnected errors still obey the response cap for a maximal request id', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const r = relay(t, '/tmp/slp-offline-large-id.sock', async () => { throw new Error('offline'); });
  const frame = { jsonrpc: '2.0', id: 'x'.repeat(262090), method: 'ping' };
  const line = JSON.stringify(frame);
  assert.ok(Buffer.byteLength(line) <= 262144);
  r.stdin.push(line + '\n');
  await new Promise(resolve => setImmediate(resolve));
  await advanceClock(t, 11500);
  const response = await r.reader.next();
  assert.ok(response.length <= 262144);
  assert.equal(JSON.parse(response).error.data.slpCode, 'RESPONSE_TOO_LARGE');
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

// Real UDS peer with controlled ACK latency and distinct application replies.
// No relay readiness observation: clients write stdin as soon as run starts.
async function delayedAckPeer(t, delays, listenDelayMs = 0) {
  const net = await import('node:net');
  const f = bridgeFixture(t, 'slp-held-ack-', PIN);
  const path = `${f.home}/delayed.sock`;
  const sockets = new Set();
  const timers = new Set();
  const received = [];
  let generations = 0;
  const server = net.createServer(socket => {
    const generation = ++generations;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let carry = '';
    let helloSeen = false;
    let acknowledged = false;
    socket.on('data', chunk => {
      carry += chunk.toString();
      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const msg = JSON.parse(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
        if (!helloSeen) {
          helloSeen = true;
          assert.equal(msg.protocol, 'slp-desk-bridge/1');
          assert.equal(msg.handle, HANDLE);
          assert.equal(msg.bridgeSha256, PIN);
          if (delays[generation - 1] === null) { socket.destroy(); continue; }
          const timer = setTimeout(() => {
            timers.delete(timer);
            acknowledged = true;
            writeFrame(socket, { protocol: msg.protocol, ok: true });
            if (generation > 1) writeFrame(socket, {
              jsonrpc: '2.0', method: 'notifications/fixtureReady', params: { generation },
            });
          }, delays[generation - 1] ?? 0);
          timers.add(timer);
          continue;
        }
        assert.equal(acknowledged, true, 'held requests must follow the accepted hello');
        if (msg.id === 'uncertain' || msg.method === 'notifications/drop') {
          socket.destroy();
          continue;
        }
        received.push({ generation, id: msg.id ?? null, method: msg.method });
        if ('id' in msg) writeFrame(socket, {
          jsonrpc: '2.0', id: msg.id,
          result: msg.method === 'initialize'
            ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'delayed-fixture', version: '1' } }
            : { served: msg.method, generation, ordinal: received.length },
        });
      }
    });
    socket.on('error', () => {});
  });
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
  });
  if (listenDelayMs === 0) await new Promise(resolve => server.listen(path, resolve));
  else {
    const timer = setTimeout(() => { timers.delete(timer); server.listen(path); }, listenDelayMs);
    timers.add(timer);
  }
  return { path, received };
}
const initialize = id => ({ jsonrpc: '2.0', id, method: 'initialize', params: {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture-client', version: '1' },
} });

test('startup initialize survives an absent socket that starts listening 3 seconds after spawn', { timeout: 10000 }, async t => {
  const peer = await delayedAckPeer(t, [0], 3000);
  const child = spawn(process.execPath, [BIN_SOURCE], {
    env: { ...process.env, SLP_DESK_SOCK: peer.path, SLP_DESK_HANDLE: HANDLE },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { child.stdin.destroy(); if (child.exitCode === null) child.kill(); });
  const pending = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const reader = new LineReader(child.stdout);
  child.stderr.resume();
  child.stdin.write(JSON.stringify(initialize('late-listener-init')) + '\n');
  const answer = JSON.parse((await reader.next()).toString());
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  assert.equal(answer.id, 'late-listener-init');
  assert.equal(answer.result.serverInfo.name, 'delayed-fixture');
  assert.deepEqual(peer.received.map(f => f.id), ['late-listener-init']);
  child.stdin.end();
  assert.deepEqual(await pending, { code: 0, signal: null });
});

test('startup absent socket holds until 11500ms, then errors and keeps dialing until EOF', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let dials = 0;
  const r = relay(t, '/tmp/slp-budget-absent.sock', async () => {
    dials++;
    throw Object.assign(new Error('socket absent'), { code: 'ENOENT' });
  });
  t.after(async () => { r.stdin.destroy(); await r.pending; });
  const frames = [];
  r.stdout.on('data', chunk => frames.push({ at: Date.now(), value: JSON.parse(chunk.toString()) }));
  r.stdin.push(JSON.stringify(initialize('budget-init')) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  await advanceClock(t, 11499);
  assert.deepEqual(frames, [], 'fast ENOENT dials must not release startup input before the time budget');
  await advanceClock(t, 1);
  // Immediate dial, then 100/200/400/800 ms and repeating 1600 ms delays:
  // 11 dials fit in 11500 ms. Allow one dial of clock-stepping slack.
  assert.ok(dials >= 10 && dials <= 12, `startup capped backoff permits 10–12 dials in 11500ms; saw ${dials}`);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].at, 11500);
  assert.equal(frames[0].value.id, 'budget-init');
  assert.equal(frames[0].value.error.data.slpCode, 'CAPABILITY_GAP');
  const atExpiry = dials;
  await advanceClock(t, 3200);
  assert.ok(dials > atExpiry, 'budget expiry does not terminate reconnecting');
  assert.equal(r.exited(), false);
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

test('reconnect absent socket keeps capped backoff over an 11500ms outage', { timeout: 10000 }, async t => {
  const peer = await delayedAckPeer(t, [0]);
  let outage = false;
  let dials = 0;
  let markDropped;
  const dropped = new Promise(resolve => { markDropped = resolve; });
  const r = relay(t, peer.path, async path => {
    if (!outage) return connect(path);
    dials++;
    throw Object.assign(new Error('socket refused'), { code: 'ECONNREFUSED' });
  }, diagnostic => {
    if (diagnostic.message.includes('socket lost')) markDropped();
  });
  t.after(async () => { r.stdin.destroy(); await r.pending; });
  r.stdin.push(JSON.stringify(initialize('before-outage')) + '\n');
  assert.ok((await reply(r)).result);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  outage = true;
  r.stdin.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/drop' }) + '\n');
  await dropped;
  r.stdin.push(JSON.stringify(request('during-outage')) + '\n');
  await advanceClock(t, 11500);
  // Reconnect first waits 100 ms: the same schedule fits 10 dials here.
  assert.ok(dials >= 9 && dials <= 11, `reconnect capped backoff permits 9–11 dials in 11500ms; saw ${dials}`);
  const error = await reply(r);
  assert.equal(error.id, 'during-outage');
  assert.equal(error.error.data.slpCode, 'CAPABILITY_GAP');
  assert.equal(r.exited(), false);
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

test('a transient hello socket close preserves startup input for the next accepted hello', { timeout: 10000 }, async t => {
  const peer = await delayedAckPeer(t, [null, 200]);
  const r = relay(t, peer.path);
  r.stdin.push(JSON.stringify(initialize('transient-hello-init')) + '\n');
  assert.equal((await reply(r)).method, 'notifications/fixtureReady');
  const answer = await reply(r);
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  assert.equal(answer.id, 'transient-hello-init');
  assert.equal(answer.result.serverInfo.name, 'delayed-fixture');
  assert.deepEqual(peer.received.map(f => [f.generation, f.id]), [[2, 'transient-hello-init']]);
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

test('startup holds immediate initialize until a 200ms hello ACK and relays the real reply', { timeout: 10000 }, async t => {
  const peer = await delayedAckPeer(t, [200]);
  const r = relay(t, peer.path);
  r.stdin.push(JSON.stringify(initialize('initialize-now')) + '\n');
  const answer = await reply(r);
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  assert.equal(answer.id, 'initialize-now');
  assert.deepEqual(answer.result, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'delayed-fixture', version: '1' } });
  assert.deepEqual(peer.received.map(f => f.id), ['initialize-now']);
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

test('spawned stdio MCP serves initialize written immediately before the delayed hello ACK', { timeout: 10000 }, async t => {
  const peer = await delayedAckPeer(t, [200]);
  const child = spawn(process.execPath, [BIN_SOURCE], {
    env: { ...process.env, SLP_DESK_SOCK: peer.path, SLP_DESK_HANDLE: HANDLE },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { child.stdin.destroy(); if (child.exitCode === null) child.kill(); });
  const pending = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const reader = new LineReader(child.stdout);
  child.stderr.resume();
  child.stdin.write(JSON.stringify(initialize('spawn-init')) + '\n');
  const answer = JSON.parse((await reader.next()).toString());
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  assert.equal(answer.id, 'spawn-init');
  assert.equal(answer.result.serverInfo.name, 'delayed-fixture');
  assert.deepEqual(peer.received.map(f => f.id), ['spawn-init']);
  child.stdin.end();
  assert.deepEqual(await pending, { code: 0, signal: null });
});

test('reconnect expires its 700ms hold before a late ACK, rejects in order and never replays held requests', { timeout: 10000 }, async t => {
  const peer = await delayedAckPeer(t, [0, 1100]);
  const r = relay(t, peer.path);
  r.stdin.push(JSON.stringify(initialize('warmup')) + '\n');
  assert.ok((await reply(r)).result);
  const start = performance.now();
  r.stdin.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/drop' }) + '\n');
  await until(() => r.diagnostics.some(d => d.message.includes('socket lost')));
  r.stdin.push([request('held-1'), request('held-2')].map(JSON.stringify).join('\n') + '\n');
  for (const id of ['held-1', 'held-2']) {
    const error = await reply(r);
    assert.equal(error.id, id);
    assert.equal(error.error.data.slpCode, 'CAPABILITY_GAP');
  }
  assert.ok(performance.now() - start >= 600, 'requests are held rather than answered immediately');
  const ready = await reply(r); // application notification proves the late ACK was processed
  assert.equal(ready.method, 'notifications/fixtureReady');
  r.stdin.push(JSON.stringify(request('fresh')) + '\n');
  assert.equal((await reply(r)).result.generation, 2);
  assert.deepEqual(peer.received.filter(f => f.generation === 2).map(f => f.id), ['fresh']);
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

test('several reconnect-held requests cross the ACK in order; accepted old writes get uncertainty once', { timeout: 10000 }, async t => {
  const peer = await delayedAckPeer(t, [0, 200]);
  const r = relay(t, peer.path);
  r.stdin.push(JSON.stringify(initialize('warmup')) + '\n');
  assert.ok((await reply(r)).result);
  r.stdin.push(JSON.stringify(request('uncertain')) + '\n');
  const uncertain = await reply(r);
  assert.equal(uncertain.id, 'uncertain');
  assert.equal(uncertain.error.data.slpCode, 'EXECUTION_UNKNOWN');
  r.stdin.push([request('one'), request('two'), request('three')].map(JSON.stringify).join('\n') + '\n');
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push(await reply(r));
  assert.equal(answers[0].method, 'notifications/fixtureReady');
  assert.deepEqual(answers.slice(1).map(r => r.id), ['one', 'two', 'three']);
  assert.ok(answers.slice(1).every(r => r.result?.generation === 2), JSON.stringify(answers));
  assert.deepEqual(peer.received.filter(f => f.generation === 2).map(f => f.id), ['one', 'two', 'three']);
  r.stdin.push(null);
  assert.equal(await r.pending, 0);
});

test('startup holds several requests and EOF, then forwards them in order after ACK', { timeout: 10000 }, async t => {
  const peer = await delayedAckPeer(t, [200]);
  const r = relay(t, peer.path);
  r.stdin.push([initialize('init'), { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'list', method: 'tools/list' },
    { jsonrpc: '2.0', id: 'ping', method: 'ping' }].map(JSON.stringify).join('\n') + '\n');
  r.stdin.push(null);
  const answers = [await reply(r), await reply(r), await reply(r)];
  assert.deepEqual(answers.map(r => r.id), ['init', 'list', 'ping']);
  assert.ok(answers.every(r => r.result && !r.error), JSON.stringify(answers));
  assert.deepEqual(peer.received.map(r => r.method), ['initialize', 'notifications/initialized', 'tools/list', 'ping']);
  assert.equal(await r.pending, 0);
});

test('expired held requests remain typed errors when a late ACK arrives behind stdout backpressure', { timeout: 10000 }, async t => {
  const peer = await delayedAckPeer(t, [0, 1100]);
  const stdin = new Readable({ read() {} });
  const frames = [];
  const diagnostics = [];
  let blocking = false;
  const callbacks = [];
  const stdout = new Writable({ highWaterMark: 16, write(chunk, _enc, callback) {
    frames.push(JSON.parse(chunk.toString()));
    if (blocking) callbacks.push(callback); else callback();
  } });
  const release = () => { blocking = false; for (const callback of callbacks.splice(0)) callback(); };
  const pending = run({
    env: { SLP_DESK_SOCK: peer.path, SLP_DESK_HANDLE: HANDLE },
    platform: 'linux', stdin, stdout, connect, selfSha256: PIN,
    stderr: { write: line => diagnostics.push(JSON.parse(line)) },
  });
  t.after(async () => { release(); stdin.destroy(); await pending; });
  stdin.push(JSON.stringify(initialize('warmup')) + '\n');
  await until(() => frames.length === 1);
  assert.ok(frames[0].result);
  blocking = true;
  stdin.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/drop' }) + '\n');
  await until(() => diagnostics.some(d => d.message.includes('socket lost')));
  stdin.push([request('expired-1'), request('expired-2'), request('expired-3')].map(JSON.stringify).join('\n') + '\n');
  await until(() => frames.length === 2);
  assert.equal(frames[1].error.data.slpCode, 'CAPABILITY_GAP');
  // A second chunk stays in the paused native buffer, rather than the
  // splitter; both prefixes must keep their expiry disposition after ACK.
  stdin.push(JSON.stringify(request('expired-4')) + '\n');
  // The fixture notification accepted by stdout proves the late ACK was
  // processed while the first expiry error's write callback is still held.
  const expiryBytes = stdout.writableLength;
  await until(() => stdout.writableLength > expiryBytes);
  release();
  await until(() => frames.filter(f => String(f.id).startsWith('expired-')).length === 4);
  const expired = frames.filter(f => String(f.id).startsWith('expired-'));
  assert.deepEqual(expired.map(f => f.id), ['expired-1', 'expired-2', 'expired-3', 'expired-4']);
  assert.ok(expired.every(f => f.error?.data.slpCode === 'CAPABILITY_GAP'), JSON.stringify(expired));
  assert.deepEqual(peer.received.filter(f => f.generation === 2), []);
  stdin.push(null);
  assert.equal(await pending, 0);
});
