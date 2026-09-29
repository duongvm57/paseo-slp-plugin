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

/** An incremental raw-byte line splitter. Complete lines arrive as Buffer
 *  segments including no newline; the cap is enforced on the RAW bytes so
 *  an unterminated flood still surfaces as a rejection, not growth. An
 *  over-cap frame is swallowed whole up to its newline — the flood's tail
 *  never re-parses as a fresh request. */
function lineSplitter(onLine, onOverflow) {
  let pending = Buffer.alloc(0);
  let dropping = false;
  return chunk => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let start = 0;
    for (;;) {
      const nl = pending.indexOf(0x0a, start);
      if (nl === -1) {
        if (dropping) {
          pending = Buffer.alloc(0);
          return;
        }
        if (pending.length - start > LINE_CAP) {
          onOverflow(pending.subarray(start).length);
          dropping = true;
          pending = Buffer.alloc(0);
        } else {
          pending = pending.subarray(start);
        }
        return;
      }
      if (dropping) {
        start = nl + 1;
        dropping = false;
        continue;
      }
      const line = pending.subarray(start, nl);
      // A complete over-cap line is already terminated — reject it and
      // resume on the next frame; no swallow needed.
      if (line.length > LINE_CAP) onOverflow(line.length);
      else onLine(line);
      start = nl + 1;
    }
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

  /** Write with drain backpressure. Resolves false when the sink died. */
  const writeTo = (sink, bytes) =>
    new Promise(resolve => {
      const flush = sink.write(bytes, error => {
        if (error) resolve(false);
      });
      if (flush) resolve(true);
      else sink.once('drain', () => resolve(true));
    });

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
      return 1;
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
      return 1;
    }

    // ---- relay --------------------------------------------------------
    // stdin → socket: cap + well-formedness enforced; a bad frame never
    // leaves this process.
    const stdinOverflow = () => {
      diag('REQUEST_TOO_LARGE', `stdin frame over the ${LINE_CAP}-byte cap — dropped`);
      void writeTo(stdout, errorFrame(null, `REQUEST_TOO_LARGE: request frame exceeds ${LINE_CAP} bytes`, 'REQUEST_TOO_LARGE') + '\n');
    };
    const onStdinLine = line => {
      const text = decodeFrame(line);
      if (text === null) {
        diag('INVALID_RECORD', 'stdin frame is not valid UTF-8 — dropped');
        void writeTo(stdout, errorFrame(null, 'slp-desk: malformed NDJSON frame') + '\n');
        return;
      }
      try {
        JSON.parse(text);
      } catch {
        diag('INVALID_RECORD', 'stdin frame is not valid JSON — dropped');
        void writeTo(stdout, errorFrame(idOf(text), 'slp-desk: malformed NDJSON frame') + '\n');
        return;
      }
      if (line.length > 0) {
        void writeTo(socket, Buffer.concat([line, Buffer.from('\n')])).then(ok => {
          if (!ok) socket.destroy();
        });
      }
    };
    const splitStdin = lineSplitter(onStdinLine, stdinOverflow);
    const onStdinData = chunk => splitStdin(chunk);
    stdin.on('data', onStdinData);

    let stdinEnded = false;
    const onStdinEnd = () => {
      stdinEnded = true;
      socket.end();
    };
    stdin.once('end', onStdinEnd);

    // socket → stdout: cap enforced here too — the adapter is trusted to
    // stay under it, but a violation must not reach the MCP client raw.
    const socketOverflow = () => {
      diag('RESPONSE_TOO_LARGE', `socket frame over the ${LINE_CAP}-byte cap — replaced with a typed error`);
      void writeTo(stdout, errorFrame(null, `RESPONSE_TOO_LARGE: response frame exceeds ${LINE_CAP} bytes`, 'RESPONSE_TOO_LARGE') + '\n');
    };
    const onSocketLine = line => {
      const text = decodeFrame(line);
      if (text === null) {
        diag('INVALID_RECORD', 'socket frame is not valid UTF-8 — replaced with a typed error');
        void writeTo(stdout, errorFrame(null, 'slp-desk: malformed frame from desk adapter') + '\n');
        return;
      }
      try {
        JSON.parse(text);
      } catch {
        diag('INVALID_RECORD', 'socket frame is not valid JSON — replaced with a typed error');
        void writeTo(stdout, errorFrame(null, 'slp-desk: malformed frame from desk adapter') + '\n');
        return;
      }
      void writeTo(stdout, Buffer.concat([line, Buffer.from('\n')])).then(ok => {
        if (!ok) socket.destroy();
      });
    };
    const splitSocket = lineSplitter(onSocketLine, socketOverflow);
    const onSocketData = chunk => splitSocket(chunk);
    socket.on('data', onSocketData);
    // Bytes the ack parser already consumed past the ack line replay first.
    if (helloResult.rest && helloResult.rest.length > 0) onSocketData(helloResult.rest);

    const sessionEnd = await new Promise(resolve => {
      socket.once('close', () => resolve('close'));
      socket.once('error', () => resolve('error'));
    });
    stdin.removeListener('data', onStdinData);
    stdin.removeListener('end', onStdinEnd);
    socket.removeListener('data', onSocketData);
    socket.destroy();

    if (stdinEnded) return 0;
    // Mid-session drop: reconnect on the same bounded budget, then give
    // up typed rather than hanging forever.
    if (cycle >= 1) {
      diag('CAPABILITY_GAP', `desk socket lost (${sessionEnd}) and the reconnect budget is spent`);
      return 1;
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
