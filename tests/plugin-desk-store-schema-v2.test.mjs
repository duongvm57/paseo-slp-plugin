// tests/plugin-desk-store-v2.test.mjs — P2-c store-level coverage (contract
// §7, ADDENDUM item 2): the §2.2 decide → state channel, the positive v1→v3
// migration chain (v1→v2→v3 through MIGRATIONS), `persistedSchemaVersion`,
// and the v4 future threshold. A synthetic decide drives the channel — no
// seat semantics here (those live in tests/plugin-desk-seat.test.mjs).
// Fixtures live under tmpdir(); the real daemon home, the repo tree and
// .local-checks are never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeskStore, LEDGER_LIMITS, MIGRATIONS, repoKeyFor } from '../plugin/server/desk-store.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';

const REPO = { hostId: 'host-test', gitCommonDir: '/repo/.git' };
const REPO_KEY = repoKeyFor(REPO);
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const COMMAND = { action: 'grant', scope: 'read' };

const repoDir = root => join(root, 'state', 'enforcement', 'repos', REPO_KEY);
const ledgerPath = root => join(repoDir(root), 'ledger.json');
const eventsDir = root => join(repoDir(root), 'events');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-desk-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const freshStore = root => createDeskStore({ stableRoot: root });

function envelope(over = {}) {
  return {
    repo: { ...REPO },
    actorKey: 'actor-1',
    assignmentId: 'assign-1',
    requestId: 'req-1',
    command: { ...COMMAND },
    ...over,
  };
}

const bodySha = () => canonicalSha256({ repo: REPO, command: COMMAND });

function membershipRow(over = {}) {
  return {
    membershipId: randomUUID(),
    state: 'unbound-open',
    bindingHandleSha256: 'a'.repeat(64),
    provider: 'slp-codex-peer',
    family: 'codex',
    role: 'peer',
    createCwd: '/repo',
    openGeneration: 1,
    agentId: null,
    workspaceId: null,
    createdAt: FIXED_NOW,
    hostConfirmedAt: null,
    registeredAt: null,
    revokedAt: null,
    revokeReason: null,
    ...over,
  };
}

// A schema-valid v1 request record whose bodySha256 matches envelope()'s
// command — the replay probe after the bump.
function v1RequestRecord(over = {}) {
  return {
    actorKey: 'actor-1',
    assignmentId: 'assign-1',
    requestId: 'req-1',
    bodySha256: bodySha(),
    canonicalization: 'slp-canonical-json/1',
    receiptId: randomUUID(),
    revision: 1,
    outcome: 'committed',
    eventSeqs: null,
    rejection: null,
    ...over,
  };
}

function v1Ledger(over = {}) {
  return {
    format: 'paseo-slp/enforcement',
    schemaVersion: 1,
    repo: {
      repoKey: REPO_KEY,
      repoKeyAlgorithm: 'sha256(hostId|gitCommonDir)@1',
      hostId: REPO.hostId,
      gitCommonDir: REPO.gitCommonDir,
    },
    revision: 1,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    lastEventSeq: 0,
    lastEventSha256: null,
    requests: [v1RequestRecord()],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// §2.2 — the decide → state channel, driven by a synthetic decide.
// ---------------------------------------------------------------------------

test('§2.2: decide without memberships → the table carries over verbatim (P2-a behavior)', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const row = membershipRow();
  const seed = await store.transact(REPO_KEY, envelope({ requestId: 'seed' }), () => ({
    ok: true,
    events: [],
    memberships: [row],
  }));
  assert.equal(seed.ok, true);
  const before = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'r2' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const after = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.deepEqual(after.memberships, [row], 'the table carries over verbatim');
  assert.deepEqual(after.memberships, before.memberships);
});

test('§2.2: decide with a valid memberships table → read returns it, same commit point', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const row = membershipRow();
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true,
    events: [{ kind: 'seat-minted', payload: { membershipId: row.membershipId } }],
    memberships: [row],
  }));
  assert.equal(result.ok, true);
  // Same commit point: the fresh file shows the new revision AND the new
  // table together — one rename, no second write.
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.revision, 1);
  assert.deepEqual(onDisk.memberships, [row]);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.deepEqual(read.ledger.memberships, [row]);
  assert.equal(read.persistedSchemaVersion, 3);
});

test('§2.2: memberships with a bad schema → INVALID_RECORD, file bytes unchanged, no request record', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const bad = membershipRow({ state: 'attached' }); // outside the P2-c state set
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true,
    events: [],
    memberships: [bad],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /decide returned invalid memberships/);
  assert.equal(store.read(REPO_KEY).state, 'absent', 'nothing was committed');
});

test('§2.2: memberships over the cap or violating a refinement → INVALID_RECORD, nothing recorded', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const over = Array.from({ length: LEDGER_LIMITS.memberships + 1 }, () => membershipRow());
  let result = await store.transact(REPO_KEY, envelope({ requestId: 'cap' }), () => ({
    ok: true, events: [], memberships: over,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');

  const live = membershipRow({ state: 'host-confirmed', agentId: 'agent-1', workspaceId: null, hostConfirmedAt: FIXED_NOW });
  const duplicate = membershipRow({ state: 'host-confirmed', agentId: 'agent-1', workspaceId: null, hostConfirmedAt: FIXED_NOW });
  result = await store.transact(REPO_KEY, envelope({ requestId: 'refine' }), () => ({
    ok: true, events: [], memberships: [live, duplicate],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'absent', 'no RequestRecord, no ledger');
});

test('§2.2: a DeskRejection commits as in P2-a and the table is untouched', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const row = membershipRow();
  await store.transact(REPO_KEY, envelope({ requestId: 'seed' }), () => ({
    ok: true, events: [], memberships: [row],
  }));
  const before = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'rej' }), () => ({
    ok: false,
    code: 'AUTHORITY_REQUIRED',
    message: 'authority required for the command',
    recovery: 'change the command',
  }));
  assert.equal(result.ok, false);
  const after = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.deepEqual(after.memberships, before.memberships, 'a rejection keeps the snapshot table');
  assert.equal(after.requests.at(-1).outcome, 'rejected');
});

test('§2.2: replay after a memberships commit → replayed:true, table unchanged', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const row = membershipRow();
  const first = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true, events: [], memberships: [row],
  }));
  assert.equal(first.ok, true);
  const replay = await store.transact(REPO_KEY, envelope(), () => {
    throw new Error('decide must not run on a replay');
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.receipt.replayed, true);
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath(dir), 'utf8')).memberships, [row]);
});

test('§2.2: crash between the segment write and the ledger rename → the old table survives whole', async t => {
  const dir = fixture(t);
  const row = membershipRow();
  let armed = false;
  const store = createDeskStore({
    stableRoot: dir,
    faults: {
      segmentRenamed: () => {
        if (armed) throw new Error('boom between 6 and 7');
      },
    },
  });
  const seeded = await store.transact(REPO_KEY, envelope({ requestId: 'seed' }), () => ({
    ok: true, events: [], memberships: [row],
  }));
  assert.equal(seeded.ok, true);
  const before = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  armed = true;
  await assert.rejects(
    store.transact(REPO_KEY, envelope({ requestId: 'crash' }), () => ({
      ok: true,
      events: [{ kind: 'test.event', payload: { v: 2 } }],
      memberships: [],
    })),
    /event segment write failed/,
  );
  const after = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.deepEqual(after.memberships, before.memberships, 'no half-written state');
  assert.equal(after.revision, before.revision);
});

// ---------------------------------------------------------------------------
// Migration v1 → v2 (contract §7) and persistedSchemaVersion.
// ---------------------------------------------------------------------------

test('migration: a valid v1 ledger reads ok with persistedSchemaVersion 1', t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  mkdirSync(repoDir(dir), { recursive: true });
  const v1 = v1Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v1));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 1);
  assert.deepEqual(read.ledger.memberships, []);
  assert.deepEqual(read.ledger.requests, v1.requests, 'requests intact in the view');
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), JSON.stringify(v1), 'read never rewrites the file');
});

test('migration: the first transact after a v1 read writes v3 + schema-migrated and keeps requests', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  mkdirSync(repoDir(dir), { recursive: true });
  const v1 = v1Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v1));
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 3);
  assert.deepEqual(onDisk.memberships, []);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.candidates, []);
  assert.deepEqual(onDisk.handbacks, []);
  assert.deepEqual(onDisk.requests.slice(0, -1), v1.requests, 'pre-bump requests verbatim');
  // The migration event is in the chain: read it back from the segments.
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 3);
  // Replay a pre-bump requestId — idempotency survives the bump.
  const replay = await store.transact(REPO_KEY, envelope(), () => {
    throw new Error('decide must not run on a replay');
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.receipt.replayed, true);
});

test('migration: MIGRATIONS[1] is pure and total — input untouched, output adds an empty table', async t => {
  const v1 = v1Ledger();
  const snapshot = JSON.stringify(v1);
  const migrated = MIGRATIONS[1](v1);
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.memberships, []);
  assert.deepEqual(migrated.requests, v1.requests);
  assert.equal(JSON.stringify(v1), snapshot, 'the input object is never mutated');
});

test('header v4 → future', t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  mkdirSync(repoDir(dir), { recursive: true });
  const body = JSON.stringify({ format: 'paseo-slp/enforcement', schemaVersion: 4, anything: 'goes' });
  writeFileSync(ledgerPath(dir), body);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'future');
  assert.equal(read.diagnostics.code, 'future-version');
  assert.equal(read.diagnostics.schemaVersion, 4);
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), body, 'a future ledger is never modified');
});

test('fresh commits write v3 directly with empty tables and no migration event', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 3);
  assert.deepEqual(onDisk.memberships, []);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.candidates, []);
  assert.deepEqual(onDisk.handbacks, []);
  const read = store.read(REPO_KEY);
  assert.equal(read.persistedSchemaVersion, 3);
  // No schema-migrated event on a fresh ledger: the first segment covers
  // exactly the decide's own event.
  assert.deepEqual(result.receipt.eventSeqs, [1, 1]);
});

// ---------------------------------------------------------------------------
// E-P2C-2 — migration is lazy: a rejection on a v1 ledger keeps v1; the
// first successful commit migrates with the schema-migrated event.
// ---------------------------------------------------------------------------

const decideReject = () => () => ({
  ok: false,
  code: 'AUTHORITY_REQUIRED',
  message: 'authority required for the command',
  recovery: 'change the command',
});

test('E-P2C-2 (i) reject-then-success: the rejection keeps v1 with no segment; the success migrates', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  mkdirSync(repoDir(dir), { recursive: true });
  const v1 = v1Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v1));
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), decideReject());
  assert.equal(rejected.ok, false);
  const afterRejection = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(afterRejection.schemaVersion, 1, 'a rejection never bumps the version');
  assert.equal(afterRejection.memberships, undefined, 'no memberships field on the v1 file');
  assert.equal(afterRejection.requests.length, 2, 'the rejection record is in the v1 ledger');
  assert.equal(existsSync(eventsDir(dir)), false, 'no segment was written');
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(ok.ok, true);
  const afterSuccess = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(afterSuccess.schemaVersion, 3, 'the first successful commit migrates');
  assert.deepEqual(afterSuccess.memberships, []);
  assert.deepEqual(afterSuccess.assignments, []);
  // The chain carries schema-migrated before the decide's own event.
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 3);
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
});

test('E-P2C-2 (ii) success-first: migrate immediately; a later rejection adds no event', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), JSON.stringify(v1Ledger()));
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(ok.ok, true);
  const afterSuccess = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(afterSuccess.schemaVersion, 3);
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), decideReject());
  assert.equal(rejected.ok, false);
  const afterRejection = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(afterRejection.schemaVersion, 3, 'already migrated — the rejection changes nothing');
  assert.equal(afterRejection.requests.length, 3);
  const read = store.read(REPO_KEY);
  const last = read.ledger.requests.at(-1);
  assert.equal(last.outcome, 'rejected');
  assert.equal(last.eventSeqs, null, 'a rejection commit has no events');
});

test('E-P2C-2: replay of a pre-bump rejected request returns the recorded rejection verbatim', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  mkdirSync(repoDir(dir), { recursive: true });
  const v1 = v1Ledger({
    requests: [v1RequestRecord({ outcome: 'rejected', rejection: {
      ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required for the command', recovery: 'change the command',
    } })],
  });
  writeFileSync(ledgerPath(dir), JSON.stringify(v1));
  const replay = await store.transact(REPO_KEY, envelope(), () => {
    throw new Error('decide must not run on a replay');
  });
  assert.equal(replay.ok, false);
  assert.deepEqual(replay, {
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required for the command', recovery: 'change the command',
  }, 'the rejection replays verbatim across the bump');
});
