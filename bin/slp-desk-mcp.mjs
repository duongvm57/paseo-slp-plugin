#!/usr/bin/env node
// bin/slp-desk-mcp.mjs — P2-d desk MCP bridge transport (seat side).
//
// Relays raw NDJSON frames between this process's stdin/stdout (the MCP
// client's stdio channel) and the desk adapter's Unix-domain socket. UDS
// only — there is no TCP path and never will be. The first frame written
// to the socket is the bridge hello carrying the minted desk handle; the
// adapter answers one ack line, then every subsequent line is an MCP
// JSON-RPC frame relayed verbatim in both directions.
//
// Contract pins:
//  - every raw UTF-8 line is capped in BOTH directions — mirrors
//    WIRE_LIMITS.deskBridgeRequestBytes (stdin→socket) and
//    WIRE_LIMITS.deskBridgeResponseBytes (socket→stdout), both 262144 —
//    an oversized or malformed inbound frame is rejected with a typed
//    diagnostic and a JSON-RPC error frame on stdout; the connection and
//    the process stay alive;
//  - both directions are flow-controlled: the producer (stdin or socket)
//    is paused whenever its sink (socket or stdout) is full and resumes on
//    drain — queued bytes stay bounded by the sink's highWaterMark plus at
//    most one in-flight frame, ordering is preserved, and every exit path
//    flushes pending stdout bytes before returning (process.exit after
//    run() cannot cut pending frames);
//  - Windows has no usable transport — startup emits a typed
//    CAPABILITY_GAP diagnostic and exits non-zero (no fake named-pipe
//    adapter);
//  - connect failures and mid-session drops retry on a bounded backoff
//    budget; exhaustion exits non-zero with a typed diagnostic;
//  - stderr diagnostics are single-line JSON records, count-capped so a
//    broken peer can never flood the host log.
//
// Environment: SLP_DESK_SOCK (socket path, required), SLP_DESK_HANDLE
// (desk membership handle minted at agent.create, required).
//
// The module also exports its seams so tests can drive the lifecycle
// without a real process; `main` runs only when the file is invoked
// directly.

import net from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PROTOCOL = 'slp-desk-bridge/1';
const LINE_CAP = 262144;
const HANDLE_CAP = 512;
const SOCK_CAP = 4096;
const MAX_DIAGNOSTICS = 32;
const CONNECT_ATTEMPTS = 5;
const CONNECT_BACKOFF_MS = [100, 200, 400, 800, 1600];
const HELLO_ACK_TIMEOUT_MS = 10000;

/** One bounded, typed stderr record. Diagnostics never carry frame bytes,
 *  handle material or filesystem secrets — code + message only. */
export function diagnosticLine(code, message) {
  return JSON.stringify({ slpDeskBridge: true, code, message });
}

/** JSON-RPC error frame written to stdout when an inbound frame is
 *  rejected. `id` is recovered from the payload when it parses. */
function errorFrame(id, message, slpCode = 'INVALID_RECORD') {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code: -32600, message, data: { slpCode } },
  });
}

/** Strict UTF-8 frame decode: malformed byte sequences become null instead
 *  of silently decoding to U+FFFD — a substituted frame must never be
 *  parsed and relayed as if it were the sender's bytes (E-P2D-1). */
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeFrame(line) {
  try {
    return utf8.decode(line);
  } catch {
    return null;
  }
}

function idOf(line) {
  try {
    const value = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'id' in value) {
      const id = value.id;
      if (id === null || typeof id === 'string' || typeof id === 'number') return id;
    }
  } catch { /* malformed — no id recoverable */ }
  return null;
}

/** An incremental raw-byte line splitter with cooperative pause. `feed`
 *  returns false when the consumer asked to wait (its sink is full): the
 *  unconsumed tail stays buffered under the raw cap and `resume()` continues
 *  the loop, so a chunk carrying many frames never floods a full sink. The
 *  cap is enforced on the RAW bytes so an unterminated flood still surfaces
 *  as a rejection, not growth; an over-cap frame is swallowed whole up to
 *  its newline — the flood's tail never re-parses as a fresh request. */
function lineSplitter(onLine, onOverflow) {
  let pending = Buffer.alloc(0);
  let dropping = false;
  const step = () => {
    let start = 0;
    for (;;) {
      const nl = pending.indexOf(0x0a, start);
      if (nl === -1) {
        if (dropping) {
          pending = Buffer.alloc(0);
          return true;
        }
        if (pending.length - start > LINE_CAP) {
          const wait = onOverflow(pending.length - start) === 'wait';
          dropping = true;
          pending = Buffer.alloc(0);
          return !wait;
        }
        pending = pending.subarray(start);
        return true;
      }
      if (dropping) {
        start = nl + 1;
        dropping = false;
        continue;
      }
      const line = pending.subarray(start, nl);
      // A complete over-cap line is already terminated — reject it and
      // resume on the next frame; no swallow needed.
      if (line.length > LINE_CAP) {
        if (onOverflow(line.length) === 'wait') {
          pending = pending.subarray(nl + 1);
          return false;
        }
      } else if (onLine(line) === 'wait') {
        pending = pending.subarray(nl + 1);
        return false;
      }
      start = nl + 1;
    }
  };
  return {
    feed(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      return step();
    },
    resume: step,
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The full relay lifecycle. All surfaces are injectable: `io.connect`
 *  returns a connected net.Socket-like duplex; returns the exit code. */
export async function run({ env, platform, stdin, stdout, stderr, connect, selfSha256 }) {
  let diagnostics = 0;
  const diag = (code, message) => {
    if (diagnostics >= MAX_DIAGNOSTICS) return;
    diagnostics += 1;
    stderr.write(diagnosticLine(code, message) + '\n');
  };

  if (platform === 'win32') {
    diag('CAPABILITY_GAP', 'desk bridge has no Windows transport — unix-socket only');
    return 1;
  }
  const sockPath = env.SLP_DESK_SOCK;
  const handle = env.SLP_DESK_HANDLE;
  if (typeof sockPath !== 'string' || sockPath.length === 0 || sockPath.length > SOCK_CAP) {
    diag('INVALID_RECORD', 'SLP_DESK_SOCK is absent or over the path bound');
    return 1;
  }
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > HANDLE_CAP) {
    diag('INVALID_RECORD', 'SLP_DESK_HANDLE is absent or over the handle bound');
    return 1;
  }
  let bridgeSha256 = selfSha256;
  if (bridgeSha256 === undefined) {
    try {
      bridgeSha256 = createHash('sha256')
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest('hex');
    } catch {
      diag('STATE_UNREADABLE', 'bridge binary bytes are unreadable — no self-identity');
      return 1;
    }
  }

  const hello = JSON.stringify({
    schemaVersion: 1,
    protocol: PROTOCOL,
    handle,
    bridgeSha256,
    pid: process.pid,
  }) + '\n';

  /** Bounded write with real backpressure. Returns 'flushed' when the sink
   *  accepted the bytes without crossing its high-water mark, 'full' when
   *  the caller must pause its producer. `resume(reason)` fires at most
   *  once, and only on:
   *   - 'drain' — the sink's own drain event emptied the buffer;
   *   - 'error' — the write callback carried an error, or the sink emitted
   *     'error'/'close' first. A dead sink abandons an in-flight write
   *     without calling its callback, so the wait must be released by the
   *     sink's own lifecycle events, not just the write callback.
   *  A successful write callback NEVER resumes the producer: it fires when
   *  the kernel/driver accepted the bytes, which is exactly when queued
   *  bytes can still sit above the mark — resuming there would creep the
   *  buffer one frame per callback instead of holding it to the mark.
   *  write(true) means accepted, never flushed.
   *  `settledWrite(error)` observes the write callback itself (terminal
   *  flush accounting); listeners owed to a sink stay bounded to one
   *  drain + one error + one close and are removed on settle. */
  const boundedWrite = (sink, bytes, resume, settledWrite) => {
    let settled = false;
    const onDrain = () => once('drain');
    const onDead = () => once('error');
    const once = reason => {
      if (settled) return;
      settled = true;
      sink.removeListener('drain', onDrain);
      sink.removeListener('error', onDead);
      sink.removeListener('close', onDead);
      resume(reason);
    };
    const flush = sink.write(bytes, error => {
      settledWrite?.(error);
      if (error) once('error');
    });
    if (!flush) {
      sink.once('drain', onDrain);
      sink.once('error', onDead);
      sink.once('close', onDead);
    }
    return flush ? 'flushed' : 'full';
  };

  // Terminal-boundary preservation: process.exit after run() must not cut
  // pending stdout frames, so every exit path waits until every accepted
  // write callback has fired (or the sink died) before returning. Counting
  // write callbacks — not awaiting 'drain' — is what makes this safe while
  // writableLength > 0 with writableNeedDrain false: 'drain' may never emit
  // for bytes that never crossed the high-water mark.
  let stdoutPendingFlushes = 0;
  let stdoutIdleCallback = null;
  const writeStdout = (bytes, resume) => {
    stdoutPendingFlushes += 1;
    return boundedWrite(stdout, bytes, resume, () => {
      stdoutPendingFlushes = Math.max(0, stdoutPendingFlushes - 1);
      if (stdoutPendingFlushes === 0 && stdoutIdleCallback) {
        const done = stdoutIdleCallback;
        stdoutIdleCallback = null;
        done();
      }
    });
  };
  const flushStdout = () => new Promise(resolve => {
    // A destroyed sink abandons in-flight writes without calling their
    // callbacks — the count can never settle, so close/error releases it.
    if (stdoutPendingFlushes === 0 || stdout.destroyed || stdout.closed) return resolve();
    stdoutIdleCallback = () => resolve();
    stdout.once('error', () => resolve());
    stdout.once('close', () => resolve());
  });
  const finish = async code => {
    await flushStdout();
    return code;
  };

  for (let cycle = 0; ; cycle += 1) {
    // ---- connect + handshake -----------------------------------------
    let socket = null;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(CONNECT_BACKOFF_MS[Math.min(attempt - 1, CONNECT_BACKOFF_MS.length - 1)]);
      try {
        socket = await connect(sockPath);
        break;
      } catch (error) {
        diag('CAPABILITY_GAP', `desk socket connect failed (${attempt + 1}/${CONNECT_ATTEMPTS}): ${error.message}`);
      }
    }
    if (socket === null) {
      diag('CAPABILITY_GAP', 'desk socket unreachable after the bounded retry budget — desk-busy or adapter down');
      return 1;
    }

    const helloResult = await new Promise(resolve => {
      const pending = [];
      let done = false;
      const timer = setTimeout(() => finish({ ok: false, code: 'CAPABILITY_GAP', reason: 'hello ack timeout' }), HELLO_ACK_TIMEOUT_MS);
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        resolve(value);
      };
      const onData = chunk => {
        pending.push(chunk);
        const joined = Buffer.concat(pending);
        const nl = joined.indexOf(0x0a);
        if (nl === -1) {
          if (joined.length > LINE_CAP) finish({ ok: false, code: 'RESPONSE_TOO_LARGE', reason: 'hello ack over the line cap' });
          return;
        }
        const rest = joined.subarray(nl + 1);
        let ack;
        const ackText = decodeFrame(joined.subarray(0, nl));
        if (ackText === null) {
          return finish({ ok: false, code: 'INVALID_RECORD', reason: 'hello ack is not valid UTF-8' });
        }
        try {
          ack = JSON.parse(ackText);
        } catch {
          return finish({ ok: false, code: 'INVALID_RECORD', reason: 'hello ack is not valid JSON' });
        }
        finish({ ok: true, ack, rest });
      };
      const onError = error => finish({ ok: false, code: 'CAPABILITY_GAP', reason: `socket error during hello: ${error.message}` });
      const onClose = () => finish({ ok: false, code: 'CAPABILITY_GAP', reason: 'socket closed during hello' });
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.write(hello, error => {
        if (error) finish({ ok: false, code: 'CAPABILITY_GAP', reason: `hello write failed: ${error.message}` });
      });
    });

    if (!helloResult.ok) {
      diag(helloResult.code ?? 'CAPABILITY_GAP', `desk handshake failed: ${helloResult.reason}`);
      socket.destroy();
      return finish(1);
    }
    const ack = helloResult.ack;
    if (
      !ack || typeof ack !== 'object' ||
      ack.protocol !== PROTOCOL || ack.ok !== true
    ) {
      const code = ack && typeof ack === 'object' && ack.error && typeof ack.error === 'object'
        ? String(ack.error.code ?? 'ACTOR_MISMATCH')
        : 'ACTOR_MISMATCH';
      const message = ack && typeof ack === 'object' && ack.error && typeof ack.error === 'object'
        ? String(ack.error.message ?? 'desk rejected the handshake')
        : 'desk rejected the handshake';
      diag(code, message);
      socket.destroy();
      return finish(1);
    }

    // ---- relay --------------------------------------------------------
    // Both directions are flow-controlled: the producer (stdin or socket)
    // is paused whenever its sink (socket or stdout) is full and resumes as
    // accepted write callbacks fire — queued sink bytes stay bounded by the
    // sink's highWaterMark plus at most one in-flight frame, and ordering
    // is preserved. While paused mid-chunk, the splitter holds only that
    // chunk's unconsumed remainder (every complete line ≤ LINE_CAP, the
    // partial tail ≤ LINE_CAP — this is a chunk-size bound, not a LINE_CAP
    // bound on the whole remainder) and the paused source's own native
    // buffer stays within its high-water mark. A bad frame never leaves
    // this process; typed replies share the stdout sink's backpressure.
    let dead = false;
    let stdinEnded = false;
    let stdinPausedByUs = false;
    let socketPausedByUs = false;
    const pauseStdin = () => {
      if (!stdinPausedByUs && !stdinEnded) {
        stdinPausedByUs = true;
        stdin.pause();
      }
    };
    const pauseSocket = () => {
      if (!socketPausedByUs) {
        socketPausedByUs = true;
        if (!socket.destroyed) socket.pause();
      }
    };
    const toStdout = (bytes, resume) => writeStdout(bytes, reason => {
      if (reason === 'error') socket.destroy();
      else resume();
    });
    const stdinOverflow = () => {
      diag('REQUEST_TOO_LARGE', `stdin frame over the ${LINE_CAP}-byte cap — dropped`);
      if (toStdout(errorFrame(null, `REQUEST_TOO_LARGE: request frame exceeds ${LINE_CAP} bytes`, 'REQUEST_TOO_LARGE') + '\n', resumeStdin) === 'full') {
        pauseStdin();
        return 'wait';
      }
    };
    const onStdinLine = line => {
      if (dead) return;
      const text = decodeFrame(line);
      if (text === null) {
        diag('INVALID_RECORD', 'stdin frame is not valid UTF-8 — dropped');
        if (toStdout(errorFrame(null, 'slp-desk: malformed NDJSON frame') + '\n', resumeStdin) === 'full') {
          pauseStdin();
          return 'wait';
        }
        return;
      }
      try {
        JSON.parse(text);
      } catch {
        diag('INVALID_RECORD', 'stdin frame is not valid JSON — dropped');
        if (toStdout(errorFrame(idOf(text), 'slp-desk: malformed NDJSON frame') + '\n', resumeStdin) === 'full') {
          pauseStdin();
          return 'wait';
        }
        return;
      }
      if (line.length > 0) {
        const state = boundedWrite(socket, Buffer.concat([line, Buffer.from('\n')]), reason => {
          if (reason === 'error') socket.destroy();
          else resumeStdin();
        });
        if (state === 'full') {
          pauseStdin();
          return 'wait';
        }
      }
    };
    const splitStdin = lineSplitter(line => onStdinLine(line), stdinOverflow);
    const resumeStdin = () => {
      if (dead || !stdinPausedByUs) return;
      stdinPausedByUs = false;
      if (splitStdin.resume() === false) {
        stdinPausedByUs = true;
        return;
      }
      if (stdinEnded) {
        if (!socket.destroyed) socket.end();
      } else {
        stdin.resume();
      }
    };
    const onStdinData = chunk => {
      if (dead) return;
      if (splitStdin.feed(chunk) === false) pauseStdin();
    };
    stdin.on('data', onStdinData);

    // A paused producer can still emit 'end': every buffered chunk was
    // already handed to the splitter, so the raw stream reaches EOF while a
    // remainder waits on a full sink. Half-close only after that remainder
    // has drained — closing early would drop frames mid-session.
    const onStdinEnd = () => {
      stdinEnded = true;
      if (stdinPausedByUs) return;
      if (splitStdin.resume() === false) {
        stdinPausedByUs = true;
        return;
      }
      if (!socket.destroyed) socket.end();
    };
    stdin.once('end', onStdinEnd);
    // Adding a 'data' listener does NOT un-pause a stream — after the
    // teardown pause this stays paused forever and the buffered frames
    // (and a pending 'end') would never be delivered to the new cycle.
    // The 'end' listener attaches first so a synchronous 'end' on resume
    // is not missed.
    if (stdin.isPaused()) stdin.resume();

    // socket → stdout: cap enforced here too — the adapter is trusted to
    // stay under it, but a violation must not reach the MCP client raw.
    const socketOverflow = () => {
      diag('RESPONSE_TOO_LARGE', `socket frame over the ${LINE_CAP}-byte cap — replaced with a typed error`);
      if (toStdout(errorFrame(null, `RESPONSE_TOO_LARGE: response frame exceeds ${LINE_CAP} bytes`, 'RESPONSE_TOO_LARGE') + '\n', resumeSocket) === 'full') {
        pauseSocket();
        return 'wait';
      }
    };
    const onSocketLine = line => {
      if (dead) return;
      const text = decodeFrame(line);
      if (text === null) {
        diag('INVALID_RECORD', 'socket frame is not valid UTF-8 — replaced with a typed error');
        if (toStdout(errorFrame(null, 'slp-desk: malformed frame from desk adapter') + '\n', resumeSocket) === 'full') {
          pauseSocket();
          return 'wait';
        }
        return;
      }
      try {
        JSON.parse(text);
      } catch {
        diag('INVALID_RECORD', 'socket frame is not valid JSON — replaced with a typed error');
        if (toStdout(errorFrame(null, 'slp-desk: malformed frame from desk adapter') + '\n', resumeSocket) === 'full') {
          pauseSocket();
          return 'wait';
        }
        return;
      }
      if (toStdout(Buffer.concat([line, Buffer.from('\n')]), resumeSocket) === 'full') {
        pauseSocket();
        return 'wait';
      }
    };
    const splitSocket = lineSplitter(line => onSocketLine(line), socketOverflow);
    // Resolves the close-time drain of the socket splitter — bytes the
    // adapter already wrote must reach stdout before the session ends.
    let socketDrainWaiter = null;
    const resumeSocket = () => {
      if (dead) return;
      if (socketPausedByUs) {
        socketPausedByUs = false;
        if (splitSocket.resume() === false) {
          socketPausedByUs = true;
          return;
        }
        if (!socket.destroyed) socket.resume();
      }
      if (socketDrainWaiter && splitSocket.resume() !== false) {
        const done = socketDrainWaiter;
        socketDrainWaiter = null;
        done();
      }
    };
    const onSocketData = chunk => {
      if (dead) return;
      if (splitSocket.feed(chunk) === false) pauseSocket();
    };
    socket.on('data', onSocketData);
    // Bytes the ack parser already consumed past the ack line replay first.
    if (helloResult.rest && helloResult.rest.length > 0) onSocketData(helloResult.rest);

    const sessionEnd = await new Promise(resolve => {
      socket.once('close', () => resolve('close'));
      socket.once('error', () => resolve('error'));
    });
    // No more bytes arrive; the sink-side drain still honors stdout
    // backpressure, released by write callbacks or by the sink dying.
    // Pause stdin before detaching: removing the 'data' listener does NOT
    // stop a flowing stream — frames or 'end' arriving in the
    // detach→re-attach window would be emitted to nobody and dropped.
    // The stream stays paused across reconnect and is released either by
    // the next cycle's own 'data' listener or by the exit path.
    if (!stdinEnded && !stdinPausedByUs) {
      stdinPausedByUs = true;
      stdin.pause();
    }
    stdin.removeListener('data', onStdinData);
    stdin.removeListener('end', onStdinEnd);
    socket.removeListener('data', onSocketData);
    // `socketPausedByUs` is the drain signal: a 'wait' inside the splitter
    // always goes through pauseSocket(), so unpaused means fully consumed.
    // A sink that already died releases immediately — 'close' fired before
    // the once-listener could observe it.
    await new Promise(resolve => {
      const finish = () => {
        socketDrainWaiter = null;
        stdout.removeListener('error', finish);
        stdout.removeListener('close', finish);
        resolve();
      };
      socketDrainWaiter = finish;
      stdout.once('error', finish);
      stdout.once('close', finish);
      if (stdout.destroyed || stdout.closed) return finish();
      resumeSocket();
      if (!socketPausedByUs) finish();
    });
    dead = true;
    socket.destroy();

    if (stdinEnded) {
      stdinPausedByUs = false;
      return finish(0);
    }
    // Mid-session drop: reconnect on the same bounded budget, then give
    // up typed rather than hanging forever.
    if (cycle >= 1) {
      stdinPausedByUs = false;
      stdin.resume();
      diag('CAPABILITY_GAP', `desk socket lost (${sessionEnd}) and the reconnect budget is spent`);
      return finish(1);
    }
    diag('CAPABILITY_GAP', `desk socket lost (${sessionEnd}) — reconnecting once`);
  }
}

const invokedDirectly = (() => {
  try {
    return typeof process.argv[1] === 'string'
      && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const code = await run({
    env: process.env,
    platform: process.platform,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    connect: path => new Promise((res, rej) => {
      const socket = net.createConnection(path);
      socket.once('connect', () => res(socket));
      socket.once('error', rej);
    }),
  });
  process.exit(code);
}
