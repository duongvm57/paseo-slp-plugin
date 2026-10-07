// tests/plugin-desk-relay-flow.test.mjs — P2-d relay flow-control regression
// (Greptile P2: unbounded relay buffering). Drives the exported run() with
// REAL streams: a Readable stdin, a real Writable stdout with a tiny
// high-water mark and a held flush, and a real Unix-domain adapter socket
// whose reader can be paused. No writeTo mocks, no fake drains — write()
// acceptance, writableLength and 'drain' come from the real stream
// implementation; only the consumer's release timing is controlled.
//
// SLP_DESK_RELAY_MODULE lets a pristine scratch copy of these same tests run
// against the pre-fix relay (git 7118d99) to capture the red baseline
// without mutating the checkout.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL = 'slp-desk-bridge/1';
const HANDLE = 'h'.repeat(64);
const relayUrl = () => pathToFileURL(process.env.SLP_DESK_RELAY_MODULE ?? join(REPO, 'bin', 'slp-desk-mcp.mjs'));

const frame = (id, body = 'x') => Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: { body } })}\n`);
const idOf = line => JSON.parse(line).id;

/** Real Writable with a tiny high-water mark and a held flush: write()
 *  returns false once the buffer passes the mark and stays false until
 *  release(). Tracks the peak queued length so the bound is measured on the
 *  real stream, not asserted from a mock. */
class HeldWritable extends Writable {
  constructor({ highWaterMark = 16 } = {}) {
    super({ highWaterMark });
    this.frames = [];
    this.maxQueued = 0;
    this.released = false;
    this._pending = [];
  }
  _write(chunk, _enc, cb) {
    this.frames.push(chunk);
    this.maxQueued = Math.max(this.maxQueued, this.writableLength);
    if (this.released) return cb();
    this._pending.push(cb);
  }
  release() {
    this.released = true;
    const pending = this._pending;
    this._pending = [];
    for (const cb of pending) cb();
  }
  get queued() { return this.writableLength; }
  get text() { return Buffer.concat(this.frames).toString('utf8'); }
  get ids() { return this.text.trim().split('\n').filter(Boolean).map(line => idOf(line)); }
}

class LineReader {
  constructor(socket, onLine) {
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      let at;
      while ((at = pending.indexOf(0x0a)) !== -1) {
        onLine(pending.subarray(0, at).toString('utf8'));
        pending = pending.subarray(at + 1);
      }
    });
  }
}

async function until(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** A real UDS adapter: answers the bridge hello with the ack, then hands
 *  every later line to `onFrame`; `onConnection` runs after the ack. */
function adapterServer(t, { onFrame, onConnection } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-relay-'));
  const path = join(dir, 'desk.sock');
  const server = net.createServer();
  const connections = [];
  server.on('connection', socket => {
    connections.push(socket);
    new LineReader(socket, line => {
      if ((JSON.parse(line).protocol ?? '') === PROTOCOL) {
        socket.write(`${JSON.stringify({ protocol: PROTOCOL, ok: true })}\n`);
        onConnection?.(socket);
        return;
      }
      onFrame?.(socket, line);
    });
  });
  t.after(() => {
    for (const socket of connections) socket.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new Promise(resolve => server.listen(path, () => resolve({ path, connections })));
}

/** Drives the exported run() against the real adapter with real streams. */
async function drive(t, { stdinChunks, stdin, stdout, onFrame, onConnection, onConnect } = {}) {
  const { run } = await import(relayUrl().href);
  const sink = stdout ?? (() => { const s = new HeldWritable({ highWaterMark: 65536 }); s.release(); return s; })();
  const adapter = await adapterServer(t, { onFrame, onConnection });
  const source = stdin ?? Readable.from(stdinChunks ?? []);
  const bridgeSockets = [];
  const stderrLines = [];
  const pending = run({
    env: { SLP_DESK_SOCK: adapter.path, SLP_DESK_HANDLE: HANDLE },
    platform: 'linux',
    stdin: source,
    stdout: sink,
    stderr: { write: line => stderrLines.push(line) },
    connect: socketPath => new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once('connect', () => {
        bridgeSockets.push(socket);
        onConnect?.(socket, bridgeSockets.length);
        resolve(socket);
      });
      socket.once('error', reject);
    }),
    selfSha256: 'f'.repeat(64),
  });
  return { pending, stdin: source, stdout: sink, adapter, bridgeSockets, stderrLines };
}

test('relay keeps stdout bounded and ordered under malformed pressure, one chunk over LINE_CAP', { timeout: 15000 }, async t => {
  // 3500 invalid-JSON lines of ~100 bytes each — ONE chunk over LINE_CAP
  // while every single line stays under it. Each line becomes a typed error
  // frame on the held stdout, so the sink fills and the relay must pause
  // mid-chunk instead of queueing the whole remainder.
  const count = 3500;
  const badLine = Buffer.from(`{${'x'.repeat(98)}\n`);
  const oneChunk = Buffer.concat(Array.from({ length: count }, () => badLine));
  assert.ok(oneChunk.length > 262144, 'the chunk itself exceeds LINE_CAP while every line stays valid');
  const stdout = new HeldWritable({ highWaterMark: 16 });
  const { pending, stdin } = await drive(t, { stdinChunks: [oneChunk], stdout, onFrame: () => {} });
  await until(() => stdin.isPaused(), 'the producer to pause behind the held stdout');
  assert.ok(stdout.maxQueued <= 16 + 512, `queued stdout bytes must stay bounded, saw ${stdout.maxQueued}`);
  stdout.release();
  assert.equal(await pending, 0);
  assert.equal(stdout.ids.length, count, 'every line is answered exactly once — no tail re-parse, no duplicate rejection');
  assert.ok(stdout.frames.every(chunk => JSON.parse(chunk.toString('utf8').trim()).error !== undefined), 'each answer is the typed error frame');
  assert.equal(stdout.queued, 0, 'the terminal boundary leaves no unflushed bytes');
});

test('relay pauses stdin and preserves order when the socket sink is slow', { timeout: 15000 }, async t => {
  // ~2MB — far above any unix-socket kernel buffer, so the bridge's own
  // write buffer is what fills and write() must return false.
  const count = 2000;
  const oneChunk = Buffer.concat(Array.from({ length: count }, (_, i) => frame(i, 'y'.repeat(1000))));
  const received = [];
  let adapterSocket;
  const { pending, stdin, bridgeSockets } = await drive(t, {
    stdinChunks: [oneChunk],
    onConnection: socket => { adapterSocket = socket; socket.pause(); },
    onFrame: (_socket, line) => received.push(idOf(line)),
  });
  // The adapter never reads: the bridge's socket write buffer fills, the
  // relay must pause stdin instead of queueing the whole chunk.
  await until(() => stdin.isPaused() && bridgeSockets[0]?.writableLength > 0, 'stdin to pause behind the full socket');
  assert.ok(
    bridgeSockets[0].writableLength <= bridgeSockets[0].writableHighWaterMark + 2048,
    `queued socket bytes must stay bounded, saw ${bridgeSockets[0].writableLength}`,
  );
  adapterSocket.resume();
  await pending;
  assert.deepEqual(received, Array.from({ length: count }, (_, i) => i), 'every frame reaches the adapter in order');
});

test('relay keeps socket→stdout bounded and ordered, ack-rest replay included', { timeout: 15000 }, async t => {
  const count = 300;
  const stdout = new HeldWritable({ highWaterMark: 16 });
  const manualStdin = new Readable({ read() {} });
  const { pending, bridgeSockets } = await drive(t, {
    stdin: manualStdin,
    stdout,
    onConnection: socket => {
      // ack + first frames share ONE chunk — the rest must replay exactly once.
      socket.write(Buffer.concat([frame(0), frame(1), frame(2)]));
      let next = 3;
      const pump = setInterval(() => {
        while (next < count && socket.write(frame(next))) next += 1;
        if (next >= count) clearInterval(pump);
      }, 5);
    },
    onFrame: (socket, line) => socket.write(`${line}\n`),
  });
  manualStdin.push(frame(-1));
  await until(() => bridgeSockets[0]?.isPaused(), 'the bridge to pause its socket behind the held stdout');
  assert.ok(stdout.maxQueued <= 16 + 512, `queued stdout bytes must stay bounded, saw ${stdout.maxQueued}`);
  stdout.release();
  await until(() => stdout.frames.length >= count + 1, 'every echoed frame to reach stdout');
  // Ending stdin half-closes the socket so the session ends cleanly.
  manualStdin.push(null);
  assert.equal(await pending, 0);
  assert.deepEqual(stdout.ids.slice(0, 3), [0, 1, 2], 'the ack-rest replay lands first, exactly once');
  assert.deepEqual(stdout.ids.filter(id => id !== -1), Array.from({ length: count }, (_, i) => i), 'every adapter frame arrives in order — none lost or duplicated');
  assert.equal(stdout.ids.filter(id => id === -1).length, 1, 'the echoed request arrives exactly once, wherever the adapter sent it');
});

test('malformed and over-cap pressure stays bounded, tails are swallowed, the session survives', { timeout: 15000 }, async t => {
  const stdout = new HeldWritable({ highWaterMark: 65536 });
  stdout.release();
  const overCap = Buffer.concat([Buffer.alloc(262145, 0x78), Buffer.from('\n')]);
  const unterminated = Buffer.alloc(262145, 0x79);
  const tail = Buffer.from('yy\n');
  const relayed = [];
  const { pending, stderrLines } = await drive(t, {
    stdinChunks: [frame(1), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('{nope\n'), overCap, unterminated, tail, frame(7)],
    stdout,
    onFrame: (_socket, line) => relayed.push(idOf(line)),
  });
  const code = await pending;
  assert.equal(code, 0);
  assert.deepEqual(relayed, [1, 7], 'only the valid frames are relayed, in order');
  const text = stdout.text;
  assert.match(text, /REQUEST_TOO_LARGE/, 'the over-cap frame is answered with a typed error');
  assert.match(text, /malformed NDJSON frame/, 'the malformed frames are answered with typed errors');
  assert.equal(stderrLines.filter(line => line.includes('REQUEST_TOO_LARGE')).length, 2, 'one rejection per over-cap frame, no tail re-parse');
  assert.ok(!stdout.ids.includes(undefined), 'no swallowed tail bytes re-parse as a frame');
});

test('a sink that dies before drain does not hang the relay', { timeout: 10000 }, async t => {
  const stdout = new HeldWritable({ highWaterMark: 16 });
  stdout.on('error', () => {}); // writes to a destroyed sink emit 'error' — the test owns that listener
  const manualStdin = new Readable({ read() {} });
  let generation = 0;
  const { pending } = await drive(t, {
    stdin: manualStdin,
    stdout,
    onConnection: () => {
      generation += 1;
      // Fresh frames on the reconnected socket keep echoes flowing into the
      // dead sink, so the second close spends the reconnect budget.
      if (generation === 2) for (let i = 50; i < 53; i += 1) manualStdin.push(frame(i));
    },
    onFrame: (socket, line) => socket.write(`${line}\n`),
  });
  for (let i = 0; i < 50; i += 1) manualStdin.push(frame(i));
  await until(() => stdout.frames.length > 0, 'frames to reach the held stdout');
  stdout.destroy();
  // stdin never ends and the adapter keeps echoing, so the relay must give
  // up the session typed instead of waiting on a drain that never comes —
  // the reconnect budget is spent by the second dead-sink close.
  assert.equal(await pending, 1, 'the relay exits typed instead of waiting for a drain that never comes');
});

test('mid-session drop reconnects once, keeps ordering, then ends cleanly', { timeout: 20000 }, async t => {
  const received = [];
  let generation = 0;
  const manualStdin = new Readable({ read() {} });
  const stdout = new HeldWritable({ highWaterMark: 65536 });
  stdout.release();
  const { pending } = await drive(t, {
    stdin: manualStdin,
    stdout,
    onConnection: socket => {
      generation += 1;
      if (generation === 2) {
        // Resume the stream on the fresh connection, then close stdin.
        manualStdin.push(frame(2));
        manualStdin.push(frame(3));
        manualStdin.push(frame(4));
        manualStdin.push(null);
      }
    },
    onFrame: (socket, line) => {
      received.push(idOf(line));
      if (generation === 1 && received.length === 2) socket.destroy();
    },
  });
  manualStdin.push(frame(0));
  manualStdin.push(frame(1));
  assert.equal(await pending, 0);
  assert.deepEqual(received, [0, 1, 2, 3, 4], 'frames relay across the reconnect in order');
  assert.equal(generation, 2, 'the relay reconnected exactly once after the mid-session drop');
});

for (const input of ['open', 'EOF', 'partial frame']) {
  test(`reconnect preserves the unsent chunk remainder with stdin ${input}`, { timeout: 15000 }, async t => {
    const count = 2000;
    const tail = frame(count);
    const cut = Math.floor(tail.length / 2);
    const chunk = Buffer.concat([
      ...Array.from({ length: count }, (_, i) => frame(i, 'y'.repeat(1000))),
      ...(input === 'partial frame' ? [tail.subarray(0, cut)] : []),
    ]);
    const source = input === 'EOF' ? Readable.from([chunk]) : new Readable({ read() {} });
    const written = [];
    const receivedAfterReconnect = [];
    let generation = 0;
    let ended = false;
    source.once('end', () => { ended = true; });
    const { pending, stdin, bridgeSockets, adapter } = await drive(t, {
      stdin: source,
      onConnect: (socket, cycle) => {
        // Observe every real write before input starts. Keep the original
        // net.Socket write and drain semantics, including failed writes.
        const write = socket.write;
        socket.write = function (bytes, ...args) {
          const value = JSON.parse(bytes.toString('utf8'));
          if ('id' in value) written.push({ id: value.id, cycle });
          return write.call(this, bytes, ...args);
        };
      },
      onConnection: socket => {
        generation += 1;
        if (generation === 1) socket.pause();
        else if (input !== 'EOF') {
          source.push(input === 'partial frame' ? tail.subarray(cut) : tail);
          source.push(null);
        }
      },
      onFrame: (socket, line) => {
        if (socket === adapter.connections[1]) receivedAfterReconnect.push(idOf(line));
      },
    });
    if (input !== 'EOF') source.push(chunk);
    await until(() => stdin.isPaused() && bridgeSockets[0]?.writableLength > 0, 'a full socket with a buffered stdin remainder');
    const sentBeforeDrop = written.length;
    assert.ok(sentBeforeDrop > 0 && sentBeforeDrop < count, 'complete requests remain unsent in the splitter');
    if (input === 'EOF') assert.equal(ended, true, 'EOF arrived while the splitter was paused');
    bridgeSockets[0].destroy();
    assert.equal(await pending, 0);
    assert.equal(generation, 2, 'the buffered remainder requires a reconnect even after EOF');
    const expected = Array.from({ length: count + (input === 'EOF' ? 0 : 1) }, (_, i) => i);
    assert.deepEqual(written.map(row => row.id), expected, 'every request is written exactly once; uncertain old writes are never replayed');
    assert.deepEqual(receivedAfterReconnect, expected.slice(sentBeforeDrop), 'every previously unsent request reaches the new adapter in order');
  });
}

test('unsent EOF requests fail when the reconnect budget is exhausted', { timeout: 15000 }, async t => {
  const count = 2000;
  const chunk = Buffer.concat(Array.from({ length: count }, (_, i) => frame(i, 'y'.repeat(1000))));
  const source = Readable.from([chunk]);
  let ended = false;
  let written = 0;
  source.once('end', () => { ended = true; });
  const { pending, stdin, bridgeSockets, stderrLines } = await drive(t, {
    stdin: source,
    onConnect: socket => {
      const write = socket.write;
      socket.write = function (bytes, ...args) {
        if ('id' in JSON.parse(bytes.toString('utf8'))) written += 1;
        return write.call(this, bytes, ...args);
      };
    },
    onConnection: socket => socket.pause(),
  });
  for (const cycle of [0, 1]) {
    await until(() => stdin.isPaused() && bridgeSockets[cycle]?.writableLength > 0, `socket ${cycle + 1} to fill with unsent EOF requests`);
    assert.equal(ended, true, 'EOF occurred before the socket drop');
    assert.ok(written > 0 && written < count, 'complete requests remain unwritten before the socket drop');
    bridgeSockets[cycle].destroy();
  }
  assert.equal(await pending, 1, 'unforwarded requests must never become a successful EOF exit');
  assert.equal(bridgeSockets.length, 2, 'only one reconnect is allowed');
  assert.ok(stderrLines.some(line => JSON.parse(line).code === 'CAPABILITY_GAP' && line.includes('reconnect budget is spent')));
});

test('reconnect preserves overflow swallowing across a paused stdin frame', { timeout: 10000 }, async t => {
  const source = new Readable({ read() {} });
  const stdout = new HeldWritable({ highWaterMark: 16 });
  const received = [];
  let generation = 0;
  const { pending, stdin, bridgeSockets } = await drive(t, {
    stdin: source,
    stdout,
    onConnection: () => {
      generation += 1;
      if (generation === 2) {
        // Valid-looking bytes are still the tail of the rejected frame up
        // to its newline. They must not become a fresh request on reconnect.
        source.push(Buffer.concat([frame(999), frame(1)]));
        source.push(null);
      }
    },
    onFrame: (_socket, line) => received.push(idOf(line)),
  });
  source.push(Buffer.alloc(262145, 0x78));
  await until(() => stdin.isPaused() && stdout.frames.length === 1, 'the overflow reply to fill stdout');
  bridgeSockets[0].destroy();
  await until(() => generation === 2, 'the new connection');
  stdout.release();
  assert.equal(await pending, 0);
  assert.deepEqual(received, [1], 'the rejected frame tail is swallowed on the new connection');
  assert.equal(stdout.ids.length, 1, 'overflow is rejected exactly once across reconnect');
});

test('the terminal boundary preserves pending stdout bytes before run() returns', { timeout: 10000 }, async t => {
  const stdout = new HeldWritable({ highWaterMark: 16 });
  const { pending } = await drive(t, {
    stdinChunks: [frame(1), frame(2), frame(3)],
    stdout,
    onFrame: (socket, line) => socket.write(`${line}\n`),
  });
  setTimeout(() => stdout.release(), 50);
  assert.equal(await pending, 0);
  assert.ok(stdout.released, 'run() waited for the held consumer before returning');
  assert.equal(stdout.queued, 0, 'no byte is left unflushed when run() resolves');
  assert.deepEqual(stdout.ids, [1, 2, 3]);
});

test('cleanup removes the relay listeners and restores the paused source', { timeout: 10000 }, async t => {
  const stdout = new HeldWritable({ highWaterMark: 65536 });
  stdout.release();
  const { pending, stdin, bridgeSockets } = await drive(t, {
    stdinChunks: [frame(1)],
    stdout,
    onFrame: () => {},
  });
  await pending;
  assert.equal(stdin.listenerCount('data'), 0, 'no stdin data listener survives the session');
  assert.equal(stdin.listenerCount('end'), 0, 'no stdin end listener survives the session');
  assert.equal(bridgeSockets[0].listenerCount('data'), 0, 'no socket data listener survives the session');
  assert.equal(stdout.listenerCount('drain'), 0, 'no drain listener survives the session');
  assert.equal(bridgeSockets[0].destroyed, true, 'the bridge socket is torn down');
});
