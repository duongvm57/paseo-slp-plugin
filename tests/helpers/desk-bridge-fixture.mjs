// Real fs/store/UDS fixtures for desk bridge feature tests. Suites own pin
// choices, observed measurements, feature doubles and scenario assertions.
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeskBridge } from '../../plugin/server/desk-bridge.ts';
import { createDeskStore, deskBridgePaths, repoKeyFor } from '../../plugin/server/desk-store.ts';
import { sha256Hex } from '../../plugin/server/config-view.ts';
import { DESK_BRIDGE_PROTOCOL } from '../../plugin/shared/enforcement.ts';

export const BIN_SOURCE = fileURLToPath(new URL('../../bin/slp-desk-mcp.mjs', import.meta.url));

export function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

export function gitRepo(t, prefix) {
  const dir = tmp(t, prefix);
  execFileSync('git', ['init', '-q', dir]);
  return { dir, gitCommonDir: realpathSync(join(dir, '.git')) };
}

/** The candidate always ships the real packaged binary. The caller's pin may
 * deliberately be literal: scope/rollout exercise wire checks without grafting.
 * `over` keeps the bridge's existing dependency seams, including fault hooks. */
export function bridgeFixture(t, homePrefix, pin, over = {}) {
  const dir = tmp(t, homePrefix);
  const home = realpathSync(mkdirSync(join(dir, 'home'), { recursive: true }) ?? join(dir, 'home'));
  const stableRoot = join(home, 'slp-runtime');
  const launchSetSha = 'a'.repeat(64);
  const candidateSha = 'b'.repeat(64);
  const runtimePath = join(stableRoot, candidateSha);
  mkdirSync(join(stableRoot, 'launchers', launchSetSha), { recursive: true });
  mkdirSync(join(runtimePath, 'bin'), { recursive: true });
  writeFileSync(join(runtimePath, 'bin', 'slp-desk-mcp.mjs'), readFileSync(BIN_SOURCE));

  const warnings = [];
  const paseoRef = over.paseoRef ?? { current: null };
  const journal = over.journal ?? {
    read: () => ({
      binding: {
        launchSetSha256: launchSetSha,
        runtimePath,
        node: { path: process.execPath },
        candidateSha256: candidateSha,
      },
    }),
  };
  const launchers = over.launchers ?? {
    verify: async dir => ({
      directory: realpathSync(dir),
      files: [],
      launchSetSha256: launchSetSha,
      launchManifestSha256: launchSetSha,
      bridgeSha256: pin,
      bridgeProtocolVersion: DESK_BRIDGE_PROTOCOL,
    }),
  };
  const payload = over.payload ?? { files: [{ path: 'bin/slp-desk-mcp.mjs', sha256: pin }] };
  const bridge = createDeskBridge({
    journal,
    launchers,
    payload,
    paseoRef,
    detectDaemonHome: () => ({ daemonHome: home, source: 'env' }),
    realpath: realpathSync,
    createStore: over.createStore ?? (root => createDeskStore({ stableRoot: root })),
    capture: over.capture,
    verifyExport: over.verifyExport,
    checkExec: over.checkExec,
    checkProbe: over.checkProbe,
    checkEnvironment: over.checkEnvironment,
    kill: over.kill,
    platform: over.platform,
    now: over.now,
    uuid: over.uuid,
    warn: line => warnings.push(line),
  });
  return {
    home, stableRoot, launchSetSha, candidateSha, runtimePath,
    bridge, warnings, paseoRef, paths: deskBridgePaths(stableRoot),
  };
}

// Readiness is a result, not an assertion: lifecycle tests exercise refusals.
export async function startBridge(t, f) {
  void f.bridge.start();
  const outcome = await f.bridge.whenReady();
  t.after(() => f.bridge.stop());
  return { ...f, outcome };
}

export const repoOf = git => ({ hostId: 'local', gitCommonDir: git.gitCommonDir });

export const memberRow = (handle, { provider, at }, over = {}) => ({
  membershipId: randomUUID(),
  state: 'host-confirmed',
  bindingHandleSha256: sha256Hex(handle),
  provider,
  family: 'codex',
  role: 'peer',
  createCwd: '/repo',
  openGeneration: 1,
  agentId: 'agent-1',
  workspaceId: 'wks-1',
  createdAt: at,
  hostConfirmedAt: at,
  registeredAt: at,
  revokedAt: null,
  revokeReason: null,
  ...over,
});

export async function seedMemberships(store, repo, rows) {
  const repoKey = repoKeyFor(repo);
  const result = await store.transact(
    repoKey,
    {
      repo,
      actorKey: 'desk:hook',
      assignmentId: 'unassigned',
      requestId: randomUUID(),
      command: { kind: 'seed' },
    },
    () => ({ ok: true, events: [], memberships: rows }),
  );
  assert.ok(result.ok, `seed commit failed: ${JSON.stringify(result)}`);
  return repoKey;
}

export const seedStore = f => createDeskStore({ stableRoot: f.stableRoot });

/** Buffer raw bytes until a newline; split UTF-8 and multiple queued frames
 * remain intact. Exposed for malformed/oversize-frame tests at the same seam. */
export class LineReader {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    sock.on('data', chunk => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.pump();
    });
  }
  pump() {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i === -1) return;
      const line = this.buf.subarray(0, i);
      this.buf = this.buf.subarray(i + 1);
      const resolve = this.waiters.shift();
      if (resolve) resolve(line);
      else this.queue.push(line);
    }
  }
  next() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const waiter = line => {
        clearTimeout(timer);
        resolve(line);
      };
      const timer = setTimeout(() => reject(new Error('desk frame read timed out')), 5000);
      timer.unref?.();
      this.waiters.push(waiter);
    });
  }
}

export const connect = path => new Promise((resolve, reject) => {
  const sock = net.createConnection(path);
  sock.once('connect', () => resolve(sock));
  sock.once('error', reject);
});

// Strings are already-framed raw wire input; objects receive the NDJSON newline.
export const writeFrame = (conn, value) =>
  conn.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n');

export const hello = (pin, handle, over = {}) => ({
  schemaVersion: 1,
  protocol: DESK_BRIDGE_PROTOCOL,
  handle,
  bridgeSha256: pin,
  ...over,
});

export async function handshake(socketPath, helloFrame) {
  const conn = await connect(socketPath);
  const reader = new LineReader(conn);
  writeFrame(conn, helloFrame);
  const ack = JSON.parse((await reader.next()).toString('utf8'));
  return { conn, reader, ack };
}

/** Error frames and results both match the caller's unchanged request id. */
export async function rpc(reader, conn, frame) {
  writeFrame(conn, frame);
  for (;;) {
    const line = JSON.parse((await reader.next()).toString('utf8'));
    if ('id' in line && line.id === frame.id) return line;
  }
}
