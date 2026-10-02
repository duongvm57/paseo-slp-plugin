// tests/plugin-desk-store-migrations.test.mjs — merged store-level coverage
// for the desk-store schema migration chain (contract §7 + P3-a §X6/§4 + P3-b
// §B8 + R2 B1-B10 durable half + P5): the five former per-version files
// plugin-desk-store-schema-v2..v6.test.mjs, kept as one section per schema
// version below. Shared fixtures/helpers live once at the top; helpers whose
// text or binding differed between versions keep a V-suffix in their section
// (COMMAND_V2, envelopeV2, membershipRowV2, assertRefusedV3/V4, graphV3..V6,
// graphTablesV3..V6, seedTablesV6, scopeRowV5/V6, scopeReviewRowV5/V6,
// scopeTransitionRowV5/V6). A synthetic decide drives the state channels —
// command semantics live in the per-feature tests (plugin-desk-seat,
// plugin-desk-handback, plugin-desk-settlement, plugin-desk-scope,
// plugin-desk-rollout). Fixtures live under tmpdir(); the real daemon home,
// the repo tree and .local-checks are never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeskStore, LEDGER_LIMITS, MIGRATIONS, repoKeyFor } from '../plugin/server/desk-store.ts';
import { canonicalJson, canonicalSha256, sha256Hex } from '../plugin/server/config-view.ts';
import { WIRE_LIMITS } from '../plugin/shared/enforcement.ts';

// ---------------------------------------------------------------------------
// Shared fixtures — identical across the former per-version files.
// ---------------------------------------------------------------------------

const REPO = { hostId: 'host-test', gitCommonDir: '/repo/.git' };
const REPO_KEY = repoKeyFor(REPO);
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const COMMAND = { action: 'noop' };

const repoDir = root => join(root, 'state', 'enforcement', 'repos', REPO_KEY);
const ledgerPath = root => join(repoDir(root), 'ledger.json');
const eventsDir = root => join(repoDir(root), 'events');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-desk-migrations-'));
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

function membershipRow(over = {}) {
  return {
    membershipId: randomUUID(),
    state: 'host-confirmed',
    bindingHandleSha256: 'a'.repeat(64),
    provider: 'slp-codex-peer',
    family: 'codex',
    role: 'peer',
    createCwd: '/repo',
    openGeneration: 1,
    agentId: 'agent-1',
    workspaceId: 'wks-1',
    createdAt: FIXED_NOW,
    hostConfirmedAt: FIXED_NOW,
    registeredAt: FIXED_NOW,
    revokedAt: null,
    revokeReason: null,
    ...over,
  };
}

function assignmentRow(over = {}) {
  return {
    assignmentId: 'asg-1',
    requestId: 'req-asg-1',
    authorityRef: 'grant:x',
    objective: 'do the thing',
    ownerMembershipId: randomUUID(),
    ownerAgentId: 'agent-lead',
    workspaceId: 'wks-1',
    state: 'open',
    seats: [],
    ...over,
  };
}

function candidateRow(over = {}) {
  return {
    candidateId: 'cand-1',
    assignmentId: 'asg-1',
    kind: 'observed',
    seatAgentId: 'agent-1',
    seatMembershipId: randomUUID(),
    repository: '/repo',
    snapshotSha256: 'c'.repeat(64),
    head: 'a'.repeat(40),
    incomplete: [],
    measuredAt: FIXED_NOW,
    ...over,
  };
}

function handbackRow(over = {}) {
  // The store now fails closed when recordSha256 does not equal
  // canonicalSha256(record) — the fixture hashes the real row bytes, and a
  // negative test overrides recordSha256 explicitly.
  const record = over.record ?? { version: 1, kind: 'handback' };
  return {
    handbackId: 'hb-1',
    assignmentId: 'asg-1',
    agentId: 'agent-1',
    seatMembershipId: randomUUID(),
    requestId: 'req-hb-1',
    revision: 1,
    record,
    recordSha256: canonicalSha256(record),
    claimedCandidateId: null,
    observed: {
      status: 'pending',
      candidateId: null,
      repository: '/repo',
      measuredAt: null,
      error: null,
    },
    gaps: [],
    ...over,
  };
}

const seedTables = (store, tables) =>
  store.transact(REPO_KEY, envelope(), () => ({ ok: true, events: [], ...tables }));

// ===========================================================================
// Section: schema v2 — formerly tests/plugin-desk-store-schema-v2.test.mjs
// P2-c store-level coverage (contract §7, ADDENDUM item 2): the §2.2 decide → state channel, the positive v1→v3 migration chain (v1→v2→v3 through MIGRATIONS), persistedSchemaVersion, and the v4 future threshold. Section-local COMMAND_V2/envelopeV2/membershipRowV2 keep the original v2 bindings (grant command, unbound-open seat).
// ===========================================================================

const COMMAND_V2 = { action: 'grant', scope: 'read' };

function envelopeV2(over = {}) {
  return {
    repo: { ...REPO },
    actorKey: 'actor-1',
    assignmentId: 'assign-1',
    requestId: 'req-1',
    command: { ...COMMAND_V2 },
    ...over,
  };
}

const bodySha = () => canonicalSha256({ repo: REPO, command: COMMAND_V2 });

function membershipRowV2(over = {}) {
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

// A schema-valid v1 request record whose bodySha256 matches envelopeV2()'s
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
  const row = membershipRowV2();
  const seed = await store.transact(REPO_KEY, envelopeV2({ requestId: 'seed' }), () => ({
    ok: true,
    events: [],
    memberships: [row],
  }));
  assert.equal(seed.ok, true);
  const before = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  const result = await store.transact(REPO_KEY, envelopeV2({ requestId: 'r2' }), () => ({
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
  const row = membershipRowV2();
  const result = await store.transact(REPO_KEY, envelopeV2(), () => ({
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
  assert.equal(read.persistedSchemaVersion, 6);
});

test('§2.2: memberships with a bad schema → INVALID_RECORD, file bytes unchanged, no request record', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const bad = membershipRowV2({ state: 'attached' }); // outside the P2-c state set
  const result = await store.transact(REPO_KEY, envelopeV2(), () => ({
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
  const over = Array.from({ length: LEDGER_LIMITS.memberships + 1 }, () => membershipRowV2());
  let result = await store.transact(REPO_KEY, envelopeV2({ requestId: 'cap' }), () => ({
    ok: true, events: [], memberships: over,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');

  const live = membershipRowV2({ state: 'host-confirmed', agentId: 'agent-1', workspaceId: null, hostConfirmedAt: FIXED_NOW });
  const duplicate = membershipRowV2({ state: 'host-confirmed', agentId: 'agent-1', workspaceId: null, hostConfirmedAt: FIXED_NOW });
  result = await store.transact(REPO_KEY, envelopeV2({ requestId: 'refine' }), () => ({
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
  const row = membershipRowV2();
  await store.transact(REPO_KEY, envelopeV2({ requestId: 'seed' }), () => ({
    ok: true, events: [], memberships: [row],
  }));
  const before = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  const result = await store.transact(REPO_KEY, envelopeV2({ requestId: 'rej' }), () => ({
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
  const row = membershipRowV2();
  const first = await store.transact(REPO_KEY, envelopeV2(), () => ({
    ok: true, events: [], memberships: [row],
  }));
  assert.equal(first.ok, true);
  const replay = await store.transact(REPO_KEY, envelopeV2(), () => {
    throw new Error('decide must not run on a replay');
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.receipt.replayed, true);
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath(dir), 'utf8')).memberships, [row]);
});

test('§2.2: crash between the segment write and the ledger rename → the old table survives whole', async t => {
  const dir = fixture(t);
  const row = membershipRowV2();
  let armed = false;
  const store = createDeskStore({
    stableRoot: dir,
    faults: {
      segmentRenamed: () => {
        if (armed) throw new Error('boom between 6 and 7');
      },
    },
  });
  const seeded = await store.transact(REPO_KEY, envelopeV2({ requestId: 'seed' }), () => ({
    ok: true, events: [], memberships: [row],
  }));
  assert.equal(seeded.ok, true);
  const before = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  armed = true;
  await assert.rejects(
    store.transact(REPO_KEY, envelopeV2({ requestId: 'crash' }), () => ({
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

test('migration: the first transact after a v1 read writes v6 + schema-migrated and keeps requests', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  mkdirSync(repoDir(dir), { recursive: true });
  const v1 = v1Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v1));
  const result = await store.transact(REPO_KEY, envelopeV2({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.memberships, []);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.candidates, []);
  assert.deepEqual(onDisk.handbacks, []);
  assert.deepEqual(onDisk.requests.slice(0, -1), v1.requests, 'pre-bump requests verbatim');
  // The migration event is in the chain: read it back from the segments.
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 6);
  // Replay a pre-bump requestId — idempotency survives the bump.
  const replay = await store.transact(REPO_KEY, envelopeV2(), () => {
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

test('header v7 → future', t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  mkdirSync(repoDir(dir), { recursive: true });
  const body = JSON.stringify({ format: 'paseo-slp/enforcement', schemaVersion: 7, anything: 'goes' });
  writeFileSync(ledgerPath(dir), body);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'future');
  assert.equal(read.diagnostics.code, 'future-version');
  assert.equal(read.diagnostics.schemaVersion, 7);
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), body, 'a future ledger is never modified');
});

test('fresh commits write v6 directly with empty tables and no migration event', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelopeV2(), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.memberships, []);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.candidates, []);
  assert.deepEqual(onDisk.handbacks, []);
  const read = store.read(REPO_KEY);
  assert.equal(read.persistedSchemaVersion, 6);
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
  const rejected = await store.transact(REPO_KEY, envelopeV2({ requestId: 'rej-1' }), decideReject());
  assert.equal(rejected.ok, false);
  const afterRejection = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(afterRejection.schemaVersion, 1, 'a rejection never bumps the version');
  assert.equal(afterRejection.memberships, undefined, 'no memberships field on the v1 file');
  assert.equal(afterRejection.requests.length, 2, 'the rejection record is in the v1 ledger');
  assert.equal(existsSync(eventsDir(dir)), false, 'no segment was written');
  const ok = await store.transact(REPO_KEY, envelopeV2({ requestId: 'ok-1' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(ok.ok, true);
  const afterSuccess = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(afterSuccess.schemaVersion, 6, 'the first successful commit migrates');
  assert.deepEqual(afterSuccess.memberships, []);
  assert.deepEqual(afterSuccess.assignments, []);
  // The chain carries schema-migrated before the decide's own event.
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 6);
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
});

test('E-P2C-2 (ii) success-first: migrate immediately; a later rejection adds no event', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), JSON.stringify(v1Ledger()));
  const ok = await store.transact(REPO_KEY, envelopeV2({ requestId: 'ok-1' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(ok.ok, true);
  const afterSuccess = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(afterSuccess.schemaVersion, 6);
  const rejected = await store.transact(REPO_KEY, envelopeV2({ requestId: 'rej-1' }), decideReject());
  assert.equal(rejected.ok, false);
  const afterRejection = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(afterRejection.schemaVersion, 6, 'already migrated — the rejection changes nothing');
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
  const replay = await store.transact(REPO_KEY, envelopeV2(), () => {
    throw new Error('decide must not run on a replay');
  });
  assert.equal(replay.ok, false);
  assert.deepEqual(replay, {
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required for the command', recovery: 'change the command',
  }, 'the rejection replays verbatim across the bump');
});
// ===========================================================================
// Section: schema v3 — formerly tests/plugin-desk-store-schema-v3.test.mjs
// P3-a store-level coverage (contract P3-a §X6 + §4): the additive v2→v3 migration, the v1→v3 chain, byte-preservation of pre-existing tables, the decide → state channels (assignments/candidates/handbacks) and their refinements.
// ===========================================================================

// A v2 fixture: the P2-c shape — body fields + memberships, no P3-a tables.
function v2Ledger(over = {}) {
  return {
    format: 'paseo-slp/enforcement',
    schemaVersion: 2,
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
    requests: [
      {
        actorKey: 'actor-1',
        assignmentId: 'assign-1',
        requestId: 'req-1',
        bodySha256: canonicalSha256({ repo: REPO, command: COMMAND }),
        canonicalization: 'slp-canonical-json/1',
        receiptId: randomUUID(),
        revision: 1,
        outcome: 'committed',
        eventSeqs: null,
        rejection: null,
      },
    ],
    memberships: [membershipRow()],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Migration — additive v2→v3 and chained v1→v3; old tables byte-preserved.
// ---------------------------------------------------------------------------

test('migration: a valid v2 ledger reads ok with persistedSchemaVersion 2', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = v2Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 2);
  assert.deepEqual(read.ledger.assignments, []);
  assert.deepEqual(read.ledger.candidates, []);
  assert.deepEqual(read.ledger.handbacks, []);
  assert.deepEqual(read.ledger.memberships, v2.memberships, 'memberships migrate verbatim');
  assert.deepEqual(read.ledger.requests, v2.requests, 'requests migrate verbatim');
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), JSON.stringify(v2), 'read never rewrites the file');
});

test('migration: the first commit on a v2 ledger writes v3 + schema-migrated, tables byte-preserved', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = v2Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.candidates, []);
  assert.deepEqual(onDisk.handbacks, []);
  assert.deepEqual(onDisk.settlements, []);
  assert.deepEqual(onDisk.memberships, v2.memberships, 'memberships bytes preserved');
  assert.deepEqual(onDisk.requests.slice(0, -1), v2.requests, 'requests bytes preserved');
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 2, to: 6 });
});

test('migration: MIGRATIONS[2] is pure and total — input untouched, output adds three empty tables', t => {
  const v2 = v2Ledger();
  const snapshot = JSON.stringify(v2);
  const migrated = MIGRATIONS[2](v2);
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.assignments, []);
  assert.deepEqual(migrated.candidates, []);
  assert.deepEqual(migrated.handbacks, []);
  assert.deepEqual(migrated.memberships, v2.memberships);
  assert.deepEqual(migrated.requests, v2.requests);
  assert.equal(JSON.stringify(v2), snapshot, 'the input object is never mutated');
});

test('migration: a v1 ledger chains v1→v2→v3 on read and on commit', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v1 = { ...v2Ledger(), schemaVersion: 1 };
  delete v1.memberships;
  writeFileSync(ledgerPath(dir), JSON.stringify(v1));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 1);
  assert.deepEqual(read.ledger.memberships, []);
  assert.deepEqual(read.ledger.handbacks, []);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.settlements, []);
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.equal(migrated.kind, 'schema-migrated');
  assert.deepEqual(migrated.payload, { from: 1, to: 6 });
});

// ---------------------------------------------------------------------------
// The P3-a decide → state channels — same schema+refinement gate as
// memberships (§2.2). Synthetic decides only.
// ---------------------------------------------------------------------------

test('channels: valid assignments/candidates/handbacks tables commit; a later decide may leave them alone', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    seats: [{ agentId: member.agentId, membershipId: member.membershipId }],
  });
  const candidate = candidateRow({ seatMembershipId: member.membershipId });
  const handback = handbackRow({
    seatMembershipId: member.membershipId,
    claimedCandidateId: candidate.candidateId,
    observed: {
      status: 'ok',
      candidateId: candidate.candidateId,
      repository: '/repo',
      measuredAt: FIXED_NOW,
      error: null,
    },
  });
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true,
    events: [{ kind: 'test.seed', payload: {} }],
    memberships: [lead, member],
    assignments: [assignment],
    candidates: [candidate],
    handbacks: [handback],
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.deepEqual(read.ledger.assignments, [assignment]);
  assert.deepEqual(read.ledger.candidates, [candidate]);
  assert.deepEqual(read.ledger.handbacks, [handback]);
  // A decide without the new channels leaves them verbatim.
  const next = await store.transact(REPO_KEY, envelope({ requestId: 'r2' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(next.ok, true);
  const read2 = store.read(REPO_KEY);
  assert.deepEqual(read2.ledger.handbacks, [handback]);
});

test('channels: an invalid assignments table → INVALID_RECORD, nothing recorded', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const bad = assignmentRow({ state: 'reserving' }); // outside the v3 state set
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true, events: [], assignments: [bad],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /decide returned invalid assignments/);
  assert.equal(store.read(REPO_KEY).state, 'absent');
});

test('channels: an invalid handbacks table → INVALID_RECORD, nothing recorded', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const bad = handbackRow({ revision: 0 });
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true, events: [], handbacks: [bad],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /decide returned invalid handbacks/);
});

// ---------------------------------------------------------------------------
// Refinements — referential integrity and stream uniqueness.
// ---------------------------------------------------------------------------

test('refinement: a dangling ownerMembershipId in assignments fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, {
    assignments: [assignmentRow({ ownerMembershipId: randomUUID() })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
  assert.equal(store.read(REPO_KEY).state, 'absent');
});

test('refinement: a candidate against an unknown assignment is refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, {
    candidates: [candidateRow({ assignmentId: 'asg-missing' })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
});

test('refinement: a handback claiming a foreign candidateId is refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const result = await seedTables(store, {
    memberships: [lead, member],
    assignments: [assignmentRow({
      ownerMembershipId: lead.membershipId,
      seats: [{ agentId: member.agentId, membershipId: member.membershipId }],
    })],
    handbacks: [handbackRow({ seatMembershipId: member.membershipId, claimedCandidateId: 'cand-ghost' })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
});

test('refinement: duplicate (assignmentId, agentId, revision) handbacks are refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const result = await seedTables(store, {
    memberships: [lead, member],
    assignments: [assignmentRow({
      ownerMembershipId: lead.membershipId,
      seats: [{ agentId: member.agentId, membershipId: member.membershipId }],
    })],
    handbacks: [
      handbackRow({ handbackId: 'hb-1', seatMembershipId: member.membershipId }),
      handbackRow({ handbackId: 'hb-2', requestId: 'req-hb-2', seatMembershipId: member.membershipId }),
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
});

test('refinement: duplicate seat agentId inside one assignment is refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const result = await seedTables(store, {
    memberships: [lead, member, other],
    assignments: [assignmentRow({
      ownerMembershipId: lead.membershipId,
      seats: [
        { agentId: 'agent-1', membershipId: member.membershipId },
        { agentId: 'agent-1', membershipId: other.membershipId },
      ],
    })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
});

// ---------------------------------------------------------------------------
// A handback record cap — decide-side and row-level both bounded.
// ---------------------------------------------------------------------------

test('record bytes: an oversized handback record fails the schema refinement', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const fat = 'x'.repeat(LEDGER_LIMITS.handbackRecordBytes); // > cap once wrapped
  const result = await seedTables(store, {
    memberships: [lead, member],
    assignments: [assignmentRow({
      ownerMembershipId: lead.membershipId,
      seats: [{ agentId: member.agentId, membershipId: member.membershipId }],
    })],
    handbacks: [handbackRow({ seatMembershipId: member.membershipId, record: { big: fat } })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
});

// A rejected commit on a persisted v2 ledger keeps the v2 shape on disk.
test('migration: a rejection on a v2 ledger commits the v2 shape — bump waits for success', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = v2Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const store = freshStore(dir);
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), () => ({
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required', recovery: 'change the command',
  }));
  assert.equal(rejected.ok, false);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 2, 'a rejection never bumps the version');
  assert.equal(onDisk.assignments, undefined, 'no P3-a fields on the v2 file');
  assert.equal(onDisk.requests.length, 2);
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true, events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(ok.ok, true);
  const migrated = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.assignments, []);
  assert.deepEqual(migrated.settlements, []);
});

// ---------------------------------------------------------------------------
// Cross-table identity refinements — fail-closed on every link the decide
// relies on, not just existence. `graphV3()` builds a minimal VALID identity
// graph; each test then corrupts exactly one edge.
// ---------------------------------------------------------------------------

function graphV3() {
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const seat = membershipRow({ agentId: 'agent-1' });
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [{ agentId: seat.agentId, membershipId: seat.membershipId }],
  });
  const candidate = candidateRow({ seatMembershipId: seat.membershipId, seatAgentId: seat.agentId });
  const handback = handbackRow({
    seatMembershipId: seat.membershipId,
    agentId: seat.agentId,
    claimedCandidateId: candidate.candidateId,
    observed: {
      status: 'ok',
      candidateId: candidate.candidateId,
      repository: '/repo',
      measuredAt: FIXED_NOW,
      error: null,
    },
  });
  return { lead, seat, assignment, candidate, handback };
}

const graphTablesV3 = g => ({
  memberships: [g.lead, g.seat],
  assignments: [g.assignment],
  candidates: [g.candidate],
  handbacks: [g.handback],
});

const assertRefusedV3 = (result, store) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
  assert.equal(store.read(REPO_KEY).state, 'absent', 'a refused commit leaves nothing behind');
};

test('refinement: the valid identity graph commits (positive control)', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, graphTablesV3(graphV3()));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(store.read(REPO_KEY).state, 'ok');
});

test('refinement: an owner membership carrying a different agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  g.assignment.ownerAgentId = 'agent-2'; // ownerMembershipId still points at agent-lead
  assertRefusedV3(await seedTables(store, graphTablesV3(g)), store);
});

test('refinement: a non-lead owner membership fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  g.lead.role = 'peer'; // the ownerMembershipId now resolves to a non-lead
  assertRefusedV3(await seedTables(store, graphTablesV3(g)), store);
});

test('refinement: an assignment seat whose membership carries a different agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  g.assignment.seats = [{ agentId: 'agent-2', membershipId: g.seat.membershipId }];
  assertRefusedV3(await seedTables(store, graphTablesV3(g)), store);
});

test('refinement: a handback whose seatMembershipId carries a different agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  g.handback.seatMembershipId = other.membershipId; // resolves to agent-2, row claims agent-1
  const result = await seedTables(store, {
    ...graphTablesV3(g),
    memberships: [g.lead, g.seat, other],
  });
  assertRefusedV3(result, store);
});

test('refinement: a handback whose agentId is not attached to its assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  // asg-2 attaches agent-2 only; the handback claims the agent-1 seat on it.
  const otherAssignment = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    seats: [{ agentId: other.agentId, membershipId: other.membershipId }],
  });
  g.handback.assignmentId = otherAssignment.assignmentId;
  g.handback.claimedCandidateId = null;
  g.handback.observed = { status: 'pending', candidateId: null, repository: '/repo', measuredAt: null, error: null };
  const result = await seedTables(store, {
    ...graphTablesV3(g),
    memberships: [g.lead, g.seat, other],
    assignments: [g.assignment, otherAssignment],
  });
  assertRefusedV3(result, store);
});

test('refinement: a claimed candidateId on another assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const otherAssignment = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    seats: [{ agentId: other.agentId, membershipId: other.membershipId }],
  });
  const foreignCandidate = candidateRow({
    candidateId: 'cand-2',
    assignmentId: otherAssignment.assignmentId,
    seatMembershipId: other.membershipId,
    seatAgentId: other.agentId,
  });
  g.handback.claimedCandidateId = foreignCandidate.candidateId; // belongs to asg-2, not asg-1
  const result = await seedTables(store, {
    ...graphTablesV3(g),
    memberships: [g.lead, g.seat, other],
    assignments: [g.assignment, otherAssignment],
    candidates: [g.candidate, foreignCandidate],
  });
  assertRefusedV3(result, store);
});

test('refinement: an observed candidateId on another assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const otherAssignment = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    seats: [{ agentId: other.agentId, membershipId: other.membershipId }],
  });
  const foreignCandidate = candidateRow({
    candidateId: 'cand-2',
    assignmentId: otherAssignment.assignmentId,
    seatMembershipId: other.membershipId,
    seatAgentId: other.agentId,
  });
  g.handback.observed = {
    status: 'ok',
    candidateId: foreignCandidate.candidateId,
    repository: '/repo',
    measuredAt: FIXED_NOW,
    error: null,
  };
  const result = await seedTables(store, {
    ...graphTablesV3(g),
    memberships: [g.lead, g.seat, other],
    assignments: [g.assignment, otherAssignment],
    candidates: [g.candidate, foreignCandidate],
  });
  assertRefusedV3(result, store);
});

test('refinement: an observed candidate recorded for a different seatMembershipId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const otherCandidate = candidateRow({
    candidateId: 'cand-2',
    seatMembershipId: other.membershipId,
    seatAgentId: other.agentId,
  });
  // The candidate is on the same assignment but was observed for a seat the
  // handback never claimed — the handback→observed seat link must hold.
  g.assignment.seats.push({ agentId: other.agentId, membershipId: other.membershipId });
  g.handback.observed = {
    status: 'ok',
    candidateId: otherCandidate.candidateId,
    repository: '/repo',
    measuredAt: FIXED_NOW,
    error: null,
  };
  const result = await seedTables(store, {
    ...graphTablesV3(g),
    memberships: [g.lead, g.seat, other],
    candidates: [g.candidate, otherCandidate],
  });
  assertRefusedV3(result, store);
});

test('refinement: a candidate whose seatMembershipId carries a different agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  g.candidate.seatMembershipId = other.membershipId; // resolves to agent-2, row claims agent-1
  const result = await seedTables(store, {
    ...graphTablesV3(g),
    memberships: [g.lead, g.seat, other],
  });
  assertRefusedV3(result, store);
});

test('refinement: a candidate whose seatAgentId is not attached to its assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  g.assignment.seats = [{ agentId: other.agentId, membershipId: other.membershipId }]; // agent-1 detached
  // The handback would fail the same rule — candidates are checked first,
  // so this isolates the candidate-side attachment link.
  const result = await seedTables(store, {
    ...graphTablesV3(g),
    memberships: [g.lead, g.seat, other],
  });
  assertRefusedV3(result, store);
});

test('refinement: a closed assignment with a revoked seat stays valid history', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  g.assignment.state = 'closed';
  g.seat.state = 'revoked';
  g.seat.revokedAt = FIXED_NOW;
  g.seat.revokeReason = 'archived';
  const result = await seedTables(store, graphTablesV3(g));
  assert.equal(result.ok, true, `closed/revoked history must stay readable: ${JSON.stringify(result)}`);
  assert.equal(store.read(REPO_KEY).state, 'ok');
});

test('refinement: a doctored ledger file reads corrupt — write-side and read-side both fail closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, graphTablesV3(graphV3()));
  assert.equal(result.ok, true, JSON.stringify(result));
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  onDisk.handbacks[0].agentId = 'agent-2'; // tamper with the recorded identity link
  writeFileSync(ledgerPath(dir), JSON.stringify(onDisk));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'corrupt');
  assert.equal(read.diagnostics.code, 'refinement-failed');
});

// ---------------------------------------------------------------------------
// The serialized-ledger byte cap (LEDGER_LIMITS.ledgerBytes) — the commit
// path refuses a write that would produce an unreadable oversized file,
// before any durable write and without touching acknowledged state.
// ---------------------------------------------------------------------------

const fatHandbacks = (seatMembershipId, count, revisionFrom = 1) =>
  Array.from({ length: count }, (_, i) =>
    handbackRow({
      handbackId: `hb-fat-${revisionFrom + i}`,
      requestId: `req-fat-${revisionFrom + i}`,
      seatMembershipId,
      revision: revisionFrom + i,
      record: { version: 1, kind: 'handback', big: 'x'.repeat(240000) },
    }));

test('ledger bytes: an over-cap commit is refused INVALID_RECORD before any durable write', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true,
    events: [{ kind: 'test.seed', payload: {} }],
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
    // ~70 rows of ~250 KB each — the serialized candidate is ~17 MB.
    handbacks: fatHandbacks(g.seat.membershipId, 70),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /byte cap|over the \d+-byte cap/);
  // The refusal fired before the segment and the commit point alike — the
  // repo directory holds neither a ledger nor an orphan event segment.
  assert.equal(store.read(REPO_KEY).state, 'absent');
  assert.equal(existsSync(eventsDir(dir)), false);
});

test('ledger bytes: saturation refuses the over-cap commit, keeps acknowledged state readable and replayable', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const seed = await store.transact(REPO_KEY, envelope({ requestId: 'seed-1' }), () => ({
    ok: true,
    events: [],
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
  }));
  assert.equal(seed.ok, true, JSON.stringify(seed));
  // Each fill commit appends one ~250 KB handback row — the serialized
  // ledger approaches the cap and the first crossing commit is refused.
  const fill = i => ledger => ({
    ok: true,
    events: [{ kind: 'test.fill', payload: { i } }],
    handbacks: [...ledger.handbacks, ...fatHandbacks(g.seat.membershipId, 1, i)],
  });
  let saturated = null;
  let committed = 0;
  for (let i = 1; i <= 80; i += 1) {
    const result = await store.transact(REPO_KEY, envelope({ requestId: `fill-${i}` }), fill(i));
    if (!result.ok) {
      saturated = result;
      break;
    }
    committed = i;
  }
  assert.ok(saturated !== null, 'the byte cap must fire before 80 commits');
  assert.equal(saturated.code, 'INVALID_RECORD');
  assert.match(saturated.message, /over the \d+-byte cap/);
  // The acknowledged ledger never crossed the cap and still reads cleanly.
  assert.ok(statSync(ledgerPath(dir)).size <= LEDGER_LIMITS.ledgerBytes);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok', `saturated ledger must stay readable: ${JSON.stringify(read.diagnostics)}`);
  assert.equal(read.ledger.handbacks.length, committed);
  // An already-acknowledged request still replays its recorded receipt.
  const replay = await store.transact(
    REPO_KEY,
    envelope({ requestId: 'fill-1' }),
    () => ({ ok: false, code: 'X', message: 'unreachable', recovery: 'unreachable' }),
  );
  assert.equal(replay.ok, true, `replay must return the recorded receipt: ${JSON.stringify(replay)}`);
  assert.equal(replay.receipt.replayed, true);
  // The refused request was never recorded — retrying it re-derives the
  // same typed rejection instead of double-committing.
  const retry = await store.transact(REPO_KEY, envelope({ requestId: `fill-${committed + 1}` }), fill(committed + 1));
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'INVALID_RECORD');
});

// A decide rejection is also a commit — its recorded rejection row makes the
// serialized ledger grow, so the byte cap must refuse it identically. The
// ledger is built just under the cap so the outcome is deterministic.
test('ledger bytes: a decide rejection that would push the ledger over the cap is refused the same way', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  // Build a valid v3 ledger on disk sized just under the byte cap: fat
  // handback rows approach the bound, then one row's pad field lands the
  // file at exactly `target` bytes.
  const ledger = {
    format: 'paseo-slp/enforcement',
    schemaVersion: 3,
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
    requests: [],
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
    candidates: [],
    handbacks: [],
  };
  const target = LEDGER_LIMITS.ledgerBytes - 350;
  const measure = () => Buffer.byteLength(JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  while (measure() + 252000 < target) {
    ledger.handbacks.push(
      handbackRow({
        handbackId: `hb-fat-${ledger.handbacks.length + 1}`,
        requestId: `req-fat-${ledger.handbacks.length + 1}`,
        seatMembershipId: g.seat.membershipId,
        revision: ledger.handbacks.length + 1,
        record: { version: 1, kind: 'handback', big: 'x'.repeat(240000) },
      }),
    );
  }
  // The pad row stays under the per-record cap (its pad is < 252000 bytes).
  ledger.handbacks.push(
    handbackRow({
      handbackId: 'hb-pad',
      requestId: 'req-pad',
      seatMembershipId: g.seat.membershipId,
      revision: ledger.handbacks.length + 1,
      record: { version: 1, kind: 'handback', pad: '' },
    }),
  );
  ledger.handbacks.at(-1).record.pad = 'x'.repeat(target - measure());
  // The pad lands after handbackRow hashed the record — a sha256 field is
  // fixed-width, so recomputing it keeps the file at exactly `target`.
  ledger.handbacks.at(-1).recordSha256 = canonicalSha256(ledger.handbacks.at(-1).record);
  const bytes = JSON.stringify(ledger, null, 2) + '\n';
  assert.equal(Buffer.byteLength(bytes, 'utf8'), target);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), bytes);
  assert.equal(store.read(REPO_KEY).state, 'ok');
  // The rejection's own recorded row (~1.5 KB with these strings) overflows
  // the 350-byte headroom — refused before the commit point, never recorded.
  const rejected = await store.transact(
    REPO_KEY,
    envelope({ requestId: 'rej-cap' }),
    () => ({
      ok: false,
      code: 'AUTHORITY_REQUIRED',
      message: 'm'.repeat(500),
      recovery: 'r'.repeat(500),
    }),
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'INVALID_RECORD');
  assert.match(rejected.message, /over the \d+-byte cap/);
  // The acknowledged ledger is byte-identical — nothing was appended.
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), bytes);
  assert.equal(store.read(REPO_KEY).state, 'ok');
});

// ---------------------------------------------------------------------------
// r2 additions — join-key integrity, canonical hash, tuple encoding.
// ---------------------------------------------------------------------------

test('refinement: duplicate membershipIds fail closed on commit and on read', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const dup = randomUUID();
  const a = membershipRow({ membershipId: dup, agentId: 'agent-1' });
  const b = membershipRow({ membershipId: dup, agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const result = await seedTables(store, { memberships: [a, b] });
  assertRefusedV3(result, store);
  // A doctored on-disk ledger with the same duplication reads corrupt.
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = v2Ledger({ memberships: [a, b] });
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'corrupt');
  assert.equal(read.diagnostics.code, 'refinement-failed');
});

test('refinement: duplicate (ownerAgentId, requestId) assignment pairs fail closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  const second = assignmentRow({
    assignmentId: 'asg-2',
    requestId: g.assignment.requestId, // the response resolver keys here
    ownerMembershipId: g.lead.membershipId,
  });
  const result = await seedTables(store, {
    ...graphTablesV3(g),
    assignments: [g.assignment, second],
  });
  assertRefusedV3(result, store);
});

test('refinement: a stored recordSha256 that is not canonicalSha256(record) fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  g.handback.recordSha256 = 'f'.repeat(64); // plausible-looking but not the record's canonical hash
  const result = await seedTables(store, graphTablesV3(g));
  assertRefusedV3(result, store);
  // The same corruption planted on disk after a valid commit reads corrupt.
  const ok = await seedTables(store, graphTablesV3(graphV3()));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  onDisk.handbacks[0].recordSha256 = 'f'.repeat(64);
  writeFileSync(ledgerPath(dir), JSON.stringify(onDisk));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'corrupt');
  assert.equal(read.diagnostics.code, 'refinement-failed');
});

test('refinement: canonical key order — a record hashed canonically commits regardless of key order', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  // The stored record's keys are NOT in canonical order; its sha is the
  // canonical hash. A raw-byte hash implementation would refuse this row.
  g.handback.record = { zebra: 1, apple: { nested: true }, middle: [3, 2, 1] };
  g.handback.recordSha256 = canonicalSha256({ apple: { nested: true }, middle: [3, 2, 1], zebra: 1 });
  const result = await seedTables(store, graphTablesV3(g));
  assert.equal(result.ok, true, `canonical-ordered hash must verify: ${JSON.stringify(result)}`);
  assert.equal(store.read(REPO_KEY).state, 'ok');
});

test('refinement: delimiter-embedded handback tuples stay distinct', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV3();
  // Delimiter-injection control: an agentId carrying '|' must not alias
  // another (assignmentId, agentId) pair under ANY concat scheme. JSON
  // tuple encoding keeps ["asg-1","a|b",1] and ["asg-1|a","b",1] distinct;
  // a '|'-joined key would collide them.
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'b', bindingHandleSha256: 'e'.repeat(64) });
  const pipe = membershipRow({ membershipId: randomUUID(), agentId: 'a|b', bindingHandleSha256: '7'.repeat(64) });
  const second = assignmentRow({
    assignmentId: 'asg-1|a',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    seats: [{ agentId: 'b', membershipId: other.membershipId }],
  });
  // Keep the graph's original seat attached — g.candidate still resolves
  // through agent-1 — and add the 'a|b' seat alongside it.
  g.assignment.seats.push({ agentId: 'a|b', membershipId: pipe.membershipId });
  g.handback.agentId = 'a|b';
  g.handback.seatMembershipId = pipe.membershipId;
  g.handback.claimedCandidateId = null;
  g.handback.observed = { status: 'pending', candidateId: null, repository: '/repo', measuredAt: null, error: null };
  const otherHandback = handbackRow({
    handbackId: 'hb-2',
    requestId: 'req-hb-2',
    assignmentId: 'asg-1|a',
    agentId: 'b',
    seatMembershipId: other.membershipId,
    revision: 1,
  });
  const result = await seedTables(store, {
    memberships: [g.lead, g.seat, other, pipe],
    assignments: [g.assignment, second],
    candidates: [g.candidate],
    handbacks: [g.handback, otherHandback],
  });
  assert.equal(result.ok, true, `distinct tuples must not alias: ${JSON.stringify(result)}`);
  assert.equal(store.read(REPO_KEY).state, 'ok');
  assert.equal(store.read(REPO_KEY).ledger.handbacks.length, 2);
});

// ---------------------------------------------------------------------------
// r2-proof — the ORIGINAL bare-concat defect class. Every multi-part store
// key must distinguish tuples whose parts alias under `${a}${b}${c}` /
// join(""): split-boundary ("ab"+"c" == "a"+"bc") and digit ("a1"+23 ==
// "a"+123) shifts. Only tuple encoding (JSON.stringify) is safe — a mutant
// restoring bare concat on ANY single site turns this suite red.
// ---------------------------------------------------------------------------

test('refinement: bare-concat aliases stay distinct across every multi-part store key', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  // Two owner leads whose (ownerAgentId, requestId) pairs alias under bare
  // concat: ("lead-ab","c") and ("lead-a","bc") both flatten to "lead-abc".
  const leadAb = membershipRow({ membershipId: randomUUID(), agentId: 'lead-ab', role: 'lead', bindingHandleSha256: '1'.repeat(64) });
  const leadA = membershipRow({ membershipId: randomUUID(), agentId: 'lead-a', role: 'lead', bindingHandleSha256: '2'.repeat(64) });
  const seatA1 = membershipRow({ membershipId: randomUUID(), agentId: 'a1', bindingHandleSha256: '3'.repeat(64) });
  const seatA = membershipRow({ membershipId: randomUUID(), agentId: 'a', bindingHandleSha256: '4'.repeat(64) });
  const seatAb = membershipRow({ membershipId: randomUUID(), agentId: 'ab', bindingHandleSha256: '5'.repeat(64) });
  const seatB = membershipRow({ membershipId: randomUUID(), agentId: 'b', bindingHandleSha256: '6'.repeat(64) });
  const asgMain = assignmentRow({
    assignmentId: 'asg-1',
    requestId: 'req-asg-1',
    ownerMembershipId: leadAb.membershipId,
    ownerAgentId: 'lead-ab',
    seats: [
      { agentId: 'a1', membershipId: seatA1.membershipId },
      { agentId: 'a', membershipId: seatA.membershipId },
      { agentId: 'ab', membershipId: seatAb.membershipId },
    ],
  });
  const asgAlt = assignmentRow({
    assignmentId: 'asg-1a',
    requestId: 'req-asg-2',
    ownerMembershipId: leadAb.membershipId,
    ownerAgentId: 'lead-ab',
    seats: [{ agentId: 'b', membershipId: seatB.membershipId }],
  });
  // The (ownerAgentId, requestId) bare-concat alias pair.
  const asgOwn1 = assignmentRow({
    assignmentId: 'asg-own-1',
    requestId: 'c',
    ownerMembershipId: leadAb.membershipId,
    ownerAgentId: 'lead-ab',
    seats: [],
  });
  const asgOwn2 = assignmentRow({
    assignmentId: 'asg-own-2',
    requestId: 'bc',
    ownerMembershipId: leadA.membershipId,
    ownerAgentId: 'lead-a',
    seats: [],
  });
  const hb = (over) => handbackRow({ claimedCandidateId: null, observed: { status: 'pending', candidateId: null, repository: '/repo', measuredAt: null, error: null }, ...over });
  const result = await seedTables(store, {
    memberships: [leadAb, leadA, seatA1, seatA, seatAb, seatB],
    assignments: [asgMain, asgAlt, asgOwn1, asgOwn2],
    handbacks: [
      // Digit-boundary stream alias: ("asg-1","a1",23) ~ ("asg-1","a",123)
      // → "asg-1a123" under bare concat; distinct revisions under JSON.
      hb({ handbackId: 'hb-d1', requestId: 'r-digit-1', assignmentId: 'asg-1', agentId: 'a1', seatMembershipId: seatA1.membershipId, revision: 23 }),
      hb({ handbackId: 'hb-d2', requestId: 'r-digit-2', assignmentId: 'asg-1', agentId: 'a', seatMembershipId: seatA.membershipId, revision: 123 }),
      // Split-boundary stream alias: ("asg-1","ab",1) ~ ("asg-1a","b",1)
      // → "asg-1ab1".
      hb({ handbackId: 'hb-s1', requestId: 'r-alpha-1', assignmentId: 'asg-1', agentId: 'ab', seatMembershipId: seatAb.membershipId, revision: 1 }),
      hb({ handbackId: 'hb-s2', requestId: 'r-alpha-2', assignmentId: 'asg-1a', agentId: 'b', seatMembershipId: seatB.membershipId, revision: 1 }),
      // Split-boundary submit-key alias: ("asg-1","a","bc1") ~
      // ("asg-1a","b","c1") → "asg-1abc1".
      hb({ handbackId: 'hb-k1', requestId: 'bc1', assignmentId: 'asg-1', agentId: 'a', seatMembershipId: seatA.membershipId, revision: 124 }),
      hb({ handbackId: 'hb-k2', requestId: 'c1', assignmentId: 'asg-1a', agentId: 'b', seatMembershipId: seatB.membershipId, revision: 2 }),
    ],
  });
  assert.equal(result.ok, true, `distinct tuples must not alias under any key: ${JSON.stringify(result)}`);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.handbacks.length, 6);
  assert.equal(read.ledger.assignments.length, 4);
});

test('refinement: bare-concat request-tuple aliases commit as distinct requests', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  // (actorKey, assignmentId, requestId) pairs that alias under bare
  // concat: ("a","bc","d") and ("ab","c","d") both flatten to "abcd".
  const first = await store.transact(REPO_KEY, envelope({ actorKey: 'a', assignmentId: 'bc', requestId: 'd' }), () => ({
    ok: true, events: [{ kind: 'test.seed', payload: { n: 1 } }],
  }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await store.transact(REPO_KEY, envelope({ actorKey: 'ab', assignmentId: 'c', requestId: 'd' }), () => ({
    ok: true, events: [{ kind: 'test.seed', payload: { n: 2 } }],
  }));
  assert.equal(second.ok, true, `a concat-aliased second request must commit: ${JSON.stringify(second)}`);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.requests.length, 2);
});
// ===========================================================================
// Section: schema v4 — formerly tests/plugin-desk-store-schema-v4.test.mjs
// P3-b store-level coverage (contract P3-b §B8): the additive v3→v4→v5 migration, the chained v1/v2 bumps, byte-preservation of pre-existing tables, and the decide → settlements channel with its refinements.
// ===========================================================================

function settlementRow(over = {}) {
  return {
    settlementId: 'stl-1',
    assignmentId: 'asg-1',
    requestId: 'req-stl-1',
    revision: 1,
    ownerMembershipId: randomUUID(),
    ownerAgentId: 'agent-lead',
    seatAgentId: 'agent-1',
    seatMembershipId: randomUUID(),
    seatProvider: 'slp-codex-peer',
    seatTitle: 'bounded task',
    at: FIXED_NOW,
    deliveryRef: 'note:delivered',
    reworkClosureRef: 'note:rework-closed',
    sinkRef: 'issue:root',
    decisionRef: null,
    handbackRefs: [],
    candidateRefs: [],
    resources: [{ ref: 'agent:peer-1', disposition: 'released' }],
    timeline: {
      nativeHandle: 'rollout-uuid-1',
      sessionId: null,
      via: 'host-transcript',
      export: null,
      gap: 'no authorized transcript export on this host',
    },
    exportVerification: null,
    status: 'completed',
    gaps: ['transcript-export-unavailable', 'decision-reference-missing'],
    ...over,
  };
}

// A v3 fixture: the P3-a shape — body fields + memberships + the P3-a
// tables, no settlements.
function v3Ledger(over = {}) {
  return {
    format: 'paseo-slp/enforcement',
    schemaVersion: 3,
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
    requests: [
      {
        actorKey: 'actor-1',
        assignmentId: 'assign-1',
        requestId: 'req-1',
        bodySha256: canonicalSha256({ repo: REPO, command: COMMAND }),
        canonicalization: 'slp-canonical-json/1',
        receiptId: randomUUID(),
        revision: 1,
        outcome: 'committed',
        eventSeqs: null,
        rejection: null,
      },
    ],
    memberships: [membershipRow()],
    assignments: [],
    candidates: [],
    handbacks: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Migration — additive v3→v4 and chained v1/v2; old tables byte-preserved.
// ---------------------------------------------------------------------------

test('migration: a valid v3 ledger reads ok with persistedSchemaVersion 3', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  // A populated v3 fixture: every P3-a table carries a wired row, so the
  // read asserts verbatim migration of real rows, not empty arrays.
  const g = graphV4();
  const v3 = v3Ledger({
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
    candidates: [g.candidate],
    handbacks: [g.handback],
  });
  writeFileSync(ledgerPath(dir), JSON.stringify(v3));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 3);
  assert.deepEqual(read.ledger.settlements, []);
  assert.deepEqual(read.ledger.scopes, []);
  assert.deepEqual(read.ledger.scopeReviews, []);
  assert.deepEqual(read.ledger.scopeTransitions, []);
  assert.deepEqual(read.ledger.handbacks, v3.handbacks, 'handbacks migrate verbatim');
  assert.deepEqual(read.ledger.assignments, v3.assignments, 'assignments migrate verbatim');
  assert.deepEqual(read.ledger.candidates, v3.candidates, 'candidates migrate verbatim');
  assert.deepEqual(read.ledger.memberships, v3.memberships, 'memberships migrate verbatim');
  assert.deepEqual(read.ledger.requests, v3.requests, 'requests migrate verbatim');
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), JSON.stringify(v3), 'read never rewrites the file');
});

test('migration: the first commit on a v3 ledger writes v5 + schema-migrated, tables byte-preserved', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v3 = v3Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v3));
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.settlements, []);
  assert.deepEqual(onDisk.scopes, []);
  assert.deepEqual(onDisk.scopeReviews, []);
  assert.deepEqual(onDisk.scopeTransitions, []);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.memberships, v3.memberships, 'memberships bytes preserved');
  assert.deepEqual(onDisk.requests.slice(0, -1), v3.requests, 'requests bytes preserved');
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 3, to: 6 });
});

test('migration: MIGRATIONS[3] is pure and total — input untouched, output adds the empty table', t => {
  const v3 = v3Ledger();
  const snapshot = JSON.stringify(v3);
  const migrated = MIGRATIONS[3](v3);
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.settlements, []);
  assert.deepEqual(migrated.memberships, v3.memberships);
  assert.deepEqual(migrated.requests, v3.requests);
  assert.equal(JSON.stringify(v3), snapshot, 'the input object is never mutated');
});

test('migration: MIGRATIONS[4] is pure and total — the v4 shape gains the three P4 tables', t => {
  const v4 = { ...v3Ledger(), schemaVersion: 4, settlements: [] };
  const snapshot = JSON.stringify(v4);
  const migrated = MIGRATIONS[4](v4);
  assert.equal(migrated.schemaVersion, 5);
  assert.deepEqual(migrated.scopes, []);
  assert.deepEqual(migrated.scopeReviews, []);
  assert.deepEqual(migrated.scopeTransitions, []);
  assert.deepEqual(migrated.settlements, []);
  assert.equal(JSON.stringify(v4), snapshot, 'the input object is never mutated');
});

test('migration: a v2 ledger chains v2→v3→v4→v5 on read and on commit', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = { ...v3Ledger(), schemaVersion: 2 };
  delete v2.assignments;
  delete v2.candidates;
  delete v2.handbacks;
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 2);
  assert.deepEqual(read.ledger.settlements, []);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.settlements, []);
  assert.deepEqual(onDisk.scopes, []);
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.equal(migrated.kind, 'schema-migrated');
  assert.deepEqual(migrated.payload, { from: 2, to: 6 });
});

test('migration: a v1 ledger chains v1→v2→v3→v4→v5 on read and on commit', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v1 = { ...v3Ledger(), schemaVersion: 1 };
  delete v1.memberships;
  delete v1.assignments;
  delete v1.candidates;
  delete v1.handbacks;
  writeFileSync(ledgerPath(dir), JSON.stringify(v1));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 1);
  assert.deepEqual(read.ledger.settlements, []);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 1, to: 6 });
});

test('migration: a future-version ledger still fails closed', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), JSON.stringify({ ...v3Ledger(), schemaVersion: 7 }));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'future');
  assert.equal(read.diagnostics.code, 'future-version');
});

// A rejected commit on a persisted v3 ledger keeps the v3 shape on disk.
test('migration: a rejection on a v3 ledger commits the v3 shape — bump waits for success', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v3 = v3Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v3));
  const store = freshStore(dir);
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), () => ({
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required', recovery: 'change the command',
  }));
  assert.equal(rejected.ok, false);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 3, 'a rejection never bumps the version');
  assert.equal(onDisk.settlements, undefined, 'no P3-b field on the v3 file');
  assert.deepEqual(onDisk.assignments, [], 'the v3 tables stay');
  assert.equal(onDisk.requests.length, 2);
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true, events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(ok.ok, true);
  const migrated = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.settlements, []);
  assert.deepEqual(migrated.scopes, []);
});

// ---------------------------------------------------------------------------
// The P3-b decide → state channel — same schema+refinement gate as the
// P3-a tables (§2.2). Synthetic decides only.
// ---------------------------------------------------------------------------

/** A minimal VALID settlement graph: lead owner + attached seat + the
 *  seat's handback/observed candidate + one settlement row. */
function graphV4() {
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const seat = membershipRow({ agentId: 'agent-1' });
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [{ agentId: seat.agentId, membershipId: seat.membershipId }],
  });
  const candidate = candidateRow({ seatMembershipId: seat.membershipId, seatAgentId: seat.agentId });
  const handback = handbackRow({
    seatMembershipId: seat.membershipId,
    agentId: seat.agentId,
    observed: {
      status: 'ok',
      candidateId: candidate.candidateId,
      repository: '/repo',
      measuredAt: FIXED_NOW,
      error: null,
    },
  });
  const settlement = settlementRow({
    ownerMembershipId: lead.membershipId,
    seatMembershipId: seat.membershipId,
    seatProvider: seat.provider,
    handbackRefs: [handback.handbackId],
    candidateRefs: [candidate.candidateId],
  });
  return { lead, seat, assignment, candidate, handback, settlement };
}

const graphTablesV4 = g => ({
  memberships: [g.lead, g.seat],
  assignments: [g.assignment],
  candidates: [g.candidate],
  handbacks: [g.handback],
  settlements: [g.settlement],
});

const assertRefusedV4 = (result, store) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement|invalid settlements/);
  assert.equal(store.read(REPO_KEY).state, 'absent', 'a refused commit leaves nothing behind');
};

test('channel: a valid settlements table commits; a later decide may leave it alone', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  const result = await seedTables(store, graphTablesV4(g));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.deepEqual(read.ledger.settlements, [g.settlement]);
  const next = await store.transact(REPO_KEY, envelope({ requestId: 'r2' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(next.ok, true);
  assert.deepEqual(store.read(REPO_KEY).ledger.settlements, [g.settlement]);
});

test('channel: an invalid settlements table → INVALID_RECORD, nothing recorded', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const bad = settlementRow({ revision: 0 });
  const result = await seedTables(store, { settlements: [bad] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /invalid settlements/);
});

// ---------------------------------------------------------------------------
// Settlement refinements — every identity link the decide relies on.
// ---------------------------------------------------------------------------

test('refinement: the valid settlement graph commits (positive control)', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, graphTablesV4(graphV4()));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('refinement: a settlement owned by a non-owner agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.ownerAgentId = 'agent-2'; // ownerMembershipId still points at agent-lead
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: a settlement owner membership that is not a lead fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.lead.role = 'peer';
  g.assignment.ownerMembershipId = g.seat.membershipId;
  g.assignment.ownerAgentId = 'agent-1';
  g.settlement.ownerMembershipId = g.seat.membershipId;
  g.settlement.ownerAgentId = 'agent-1';
  // The seat row is not a lead → owner role check fires.
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: a settlement for a seat not attached to the assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.seatAgentId = 'agent-2'; // not in assignment.seats
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: a settlement whose seatMembershipId belongs to another agent fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.seatMembershipId = g.lead.membershipId; // resolves to agent-lead, not agent-1
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: a settlement referencing another seat\'s handback fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  // agent-2 is a real seat of the same assignment with a valid handback —
  // ONLY the settlement's ref link is broken, so the seat pin inside the
  // settlement refinement is the check under test.
  const seat2 = membershipRow({ agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  g.assignment.seats.push({ agentId: 'agent-2', membershipId: seat2.membershipId });
  g.handback.agentId = 'agent-2';
  g.handback.seatMembershipId = seat2.membershipId;
  // The foreign handback carries no candidate links — those would trip the
  // handback's own observed-candidate refinement before the settlement's
  // ref link is even reached.
  g.handback.claimedCandidateId = null;
  g.handback.observed = { status: 'pending', candidateId: null, repository: '/repo', measuredAt: null, error: null };
  g.settlement.handbackRefs = [g.handback.handbackId];
  g.settlement.candidateRefs = [];
  const tables = graphTablesV4(g);
  tables.memberships.push(seat2);
  assertRefusedV4(await seedTables(store, tables), store);
});

test('refinement: a settlement referencing a foreign-assignment handback fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  // A second, fully valid assignment for the same seat — the handback is
  // legal THERE; only the settlement's assignment pin is under test.
  const asg2 = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [{ agentId: g.seat.agentId, membershipId: g.seat.membershipId }],
  });
  const hb2 = handbackRow({
    handbackId: 'hb-2',
    assignmentId: 'asg-2',
    agentId: g.seat.agentId,
    seatMembershipId: g.seat.membershipId,
    requestId: 'req-hb-2',
  });
  g.settlement.handbackRefs = [hb2.handbackId];
  const tables = graphTablesV4(g);
  tables.assignments.push(asg2);
  tables.handbacks.push(hb2);
  assertRefusedV4(await seedTables(store, tables), store);
});

test('refinement: a settlement referencing a foreign-assignment candidate fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  const asg2 = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [{ agentId: g.seat.agentId, membershipId: g.seat.membershipId }],
  });
  const cand2 = candidateRow({
    candidateId: 'cand-2',
    assignmentId: 'asg-2',
    seatAgentId: g.seat.agentId,
    seatMembershipId: g.seat.membershipId,
  });
  g.settlement.candidateRefs = [cand2.candidateId];
  const tables = graphTablesV4(g);
  tables.assignments.push(asg2);
  tables.candidates.push(cand2);
  assertRefusedV4(await seedTables(store, tables), store);
});

test('refinement: a settlement denormalized seatProvider must match the membership', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.seatProvider = 'slp-pi-peer';
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: duplicate (assignmentId, seatAgentId, revision) settlements are refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  const dup = settlementRow({
    ...g.settlement,
    settlementId: 'stl-2',
    requestId: 'req-stl-2',
  });
  const result = await seedTables(store, { ...graphTablesV4(g), settlements: [g.settlement, dup] });
  assertRefusedV4(result, store);
});

test('refinement: duplicate (assignmentId, ownerAgentId, requestId) settlement requests are refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  const dup = settlementRow({
    ...g.settlement,
    settlementId: 'stl-2',
    revision: 2,
  });
  const result = await seedTables(store, { ...graphTablesV4(g), settlements: [g.settlement, dup] });
  assertRefusedV4(result, store);
});

test('refinement: a settlement on an unknown assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.assignmentId = 'asg-ghost';
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: a settlement via outside the closed SETTLEMENT_VIA enum fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.timeline = { ...g.settlement.timeline, via: 'invented-source' };
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('schema: settlement pointer/field caps share the wire bounds', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.deliveryRef = 'x'.repeat(WIRE_LIMITS.deskSettlementPointer + 1);
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
  const g2 = graphV4();
  g2.settlement.gaps = ['y'.repeat(WIRE_LIMITS.gapLen + 1)];
  const second = await seedTables(store, { ...graphTablesV4(g2), settlements: [g2.settlement] });
  assertRefusedV4(second, store);
});

// ---------------------------------------------------------------------------
// Export-verification coupling (P3-b R1) — the durable seam verdict must be
// consistent with the claim and the computed status: an unproven export can
// never sit on a completed row.
// ---------------------------------------------------------------------------

const CLAIMED_EXPORT = { path: '.local-checks/t.txt', sha256: 'f'.repeat(64), bytes: 12 };

test('refinement: a claimed export without the seam verdict fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = null;
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: an export-less row carrying a verdict fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.exportVerification = { status: 'verified', detail: null };
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: an unverified export can never sit on a completed row', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'unavailable', detail: 'host-verifier-missing' };
  g.settlement.status = 'completed';
  g.settlement.gaps = ['transcript-export-unverified'];
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: an unverified export without the durable gap marker fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'unavailable', detail: null };
  g.settlement.status = 'partial';
  g.settlement.gaps = ['decision-reference-missing'];
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: a verified row carrying the unverified gap marker fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'verified', detail: null };
  g.settlement.status = 'completed';
  g.settlement.gaps = ['transcript-export-unverified', 'decision-reference-missing'];
  assertRefusedV4(await seedTables(store, graphTablesV4(g)), store);
});

test('refinement: a claimed-only unavailable export commits as partial with the durable gap (positive control)', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'unavailable', detail: 'host-verifier-missing' };
  g.settlement.status = 'partial';
  g.settlement.gaps = ['transcript-export-unverified', 'decision-reference-missing'];
  const result = await seedTables(store, graphTablesV4(g));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('refinement: a verified export commits as completed (positive control)', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV4();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'verified', detail: null };
  g.settlement.status = 'completed';
  g.settlement.gaps = ['decision-reference-missing'];
  const result = await seedTables(store, graphTablesV4(g));
  assert.equal(result.ok, true, JSON.stringify(result));
});
// ===========================================================================
// Section: schema v5 — formerly tests/plugin-desk-store-schema-v5.test.mjs
// P4 store-level coverage (contract R2 B1-B10 durable half): the additive v4→v5 migration, chained bumps from older versions, byte-preservation, and the decide → scopes/scopeReviews/scopeTransitions channels with fail-closed refinements.
// ===========================================================================

function scopeRowV5(over = {}) {
  return {
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-scp-1',
    revision: 1,
    priorRevision: null,
    ownerMembershipId: 'LEAD_MID',
    ownerAgentId: 'agent-lead',
    assignmentRevision: 2,
    seatAgentId: 'agent-1',
    label: 'bounded slice',
    declarationSha256: 'e'.repeat(64),
    refs: ['note:plan'],
    ...over,
  };
}

function scopeReviewRowV5(over = {}) {
  return {
    reviewId: 'srv-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-rev-1',
    revision: 1,
    scopeRevision: 1,
    candidateSnapshot: 'c'.repeat(64),
    axis: 'spec',
    verdict: 'approve',
    reviewerAgentId: 'agent-2',
    reviewerSeatId: 'SEAT2_MID',
    findingsRef: null,
    ...over,
  };
}

function scopeTransitionRowV5(over = {}) {
  return {
    transitionId: 'stn-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-trn-1',
    revision: 1,
    command: 'declare',
    from: null,
    to: 'declared',
    scopeRevision: 1,
    candidateSnapshot: null,
    candidateHead: null,
    discharged: [],
    actorAgentId: 'agent-lead',
    ...over,
  };
}

// A v4 fixture: the P3-b shape — every pre-P4 field, no scope tables.
function v4Ledger(over = {}) {
  return {
    format: 'paseo-slp/enforcement',
    schemaVersion: 4,
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
    requests: [
      {
        actorKey: 'actor-1',
        assignmentId: 'assign-1',
        requestId: 'req-1',
        bodySha256: canonicalSha256({ repo: REPO, command: COMMAND }),
        canonicalization: 'slp-canonical-json/1',
        receiptId: randomUUID(),
        revision: 1,
        outcome: 'committed',
        eventSeqs: null,
        rejection: null,
      },
    ],
    memberships: [membershipRow()],
    assignments: [],
    candidates: [],
    handbacks: [],
    settlements: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Migration — additive v4→v5; old tables byte-preserved.
// ---------------------------------------------------------------------------

test('migration: a valid v4 ledger reads ok with persistedSchemaVersion 4 and empty P4+P5 tables', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const g = graphV5();
  const v4 = v4Ledger({
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
  });
  writeFileSync(ledgerPath(dir), JSON.stringify(v4));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 4);
  assert.deepEqual(read.ledger.scopes, []);
  assert.deepEqual(read.ledger.scopeReviews, []);
  assert.deepEqual(read.ledger.scopeTransitions, []);
  // v6 — the P5 check-runner/rollout tables materialize empty.
  assert.deepEqual(read.ledger.checkDefinitions, []);
  assert.deepEqual(read.ledger.checkRuns, []);
  assert.deepEqual(read.ledger.rollouts, []);
  assert.deepEqual(read.ledger.rolloutTransitions, []);
  assert.deepEqual(read.ledger.candidates, v4.candidates, 'candidates migrate verbatim');
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), JSON.stringify(v4), 'read never rewrites the file');
});

test('migration: the first commit on a v4 ledger writes v6 + schema-migrated, tables byte-preserved', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v4 = v4Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v4));
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.scopes, []);
  assert.deepEqual(onDisk.scopeReviews, []);
  assert.deepEqual(onDisk.scopeTransitions, []);
  assert.deepEqual(onDisk.checkDefinitions, []);
  assert.deepEqual(onDisk.checkRuns, []);
  assert.deepEqual(onDisk.rollouts, []);
  assert.deepEqual(onDisk.rolloutTransitions, []);
  assert.deepEqual(onDisk.memberships, v4.memberships, 'memberships bytes preserved');
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 4, to: 6 });
});

test('migration: a rejection on a v4 ledger commits the v4 shape — the bump waits for success', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), JSON.stringify(v4Ledger()));
  const store = freshStore(dir);
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), () => ({
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required', recovery: 'change the command',
  }));
  assert.equal(rejected.ok, false);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 4, 'a rejection never bumps the version');
  assert.equal(onDisk.scopes, undefined, 'no P4 fields on the v4 file');
  assert.equal(onDisk.checkDefinitions, undefined, 'no P5 fields on the v4 file');
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true, events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(ok.ok, true);
  const migrated = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.scopes, []);
  assert.deepEqual(migrated.rollouts, []);
});

// ---------------------------------------------------------------------------
// The decide → state channels — same schema+refinement gate as P3.
// ---------------------------------------------------------------------------

/** A minimal VALID P4 graph: lead owner + two attached seats + the bound
 *  seat's observed candidate + declaration rev 1 + the opening transition
 *  + a submitted round + both review axes + the discharging gate row. */
function graphV5() {
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const seat = membershipRow({ agentId: 'agent-1' });
  const reviewer = membershipRow({ agentId: 'agent-2', bindingHandleSha256: 'b'.repeat(64) });
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [
      { agentId: seat.agentId, membershipId: seat.membershipId },
      { agentId: reviewer.agentId, membershipId: reviewer.membershipId },
    ],
  });
  const candidate = candidateRow({ seatMembershipId: seat.membershipId, seatAgentId: seat.agentId });
  const scope = scopeRowV5({ ownerMembershipId: lead.membershipId, assignmentRevision: 3 });
  const transitions = [
    scopeTransitionRowV5({ transitionId: 'stn-1', revision: 1 }),
    scopeTransitionRowV5({
      transitionId: 'stn-2', revision: 2, requestId: 'req-trn-2',
      command: 'claim', from: 'declared', to: 'claimed',
    }),
    scopeTransitionRowV5({
      transitionId: 'stn-3', revision: 3, requestId: 'req-trn-3',
      command: 'submit-for-review', from: 'claimed', to: 'submitted-for-review',
      candidateSnapshot: 'c'.repeat(64), candidateHead: 'a'.repeat(40),
    }),
  ];
  const reviews = [
    scopeReviewRowV5({ reviewerSeatId: reviewer.membershipId }),
    scopeReviewRowV5({ reviewId: 'srv-2', requestId: 'req-rev-2', axis: 'standards', reviewerSeatId: reviewer.membershipId }),
  ];
  const gate = scopeTransitionRowV5({
    transitionId: 'stn-4', revision: 4, requestId: 'req-trn-4',
    command: 'review-observed', from: 'submitted-for-review', to: 'review-observed',
    discharged: [
      { axis: 'spec', reviewId: 'srv-1' },
      { axis: 'standards', reviewId: 'srv-2' },
    ],
  });
  return { lead, seat, reviewer, assignment, candidate, scope, transitions, reviews, gate };
}

const graphTablesV5 = g => ({
  memberships: [g.lead, g.seat, g.reviewer],
  assignments: [g.assignment],
  candidates: [g.candidate],
  scopes: [g.scope],
  scopeTransitions: [...g.transitions, g.gate],
  scopeReviews: g.reviews,
});

test('channel: a valid P4 graph commits and reads back', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  const result = await seedTables(store, graphTablesV5(g));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.scopes.length, 1);
  assert.equal(read.ledger.scopeReviews.length, 2);
  assert.equal(read.ledger.scopeTransitions.length, 4);
});

test('channel: schema-invalid scope tables reject INVALID_RECORD', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  const bad = { ...g.scope, refs: 'not-an-array' };
  const result = await seedTables(store, { ...graphTablesV5(g), scopes: [bad] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /invalid scopes/);
  const badReview = { ...g.reviews[0], axis: 'vibes' };
  const result2 = await seedTables(store, { ...graphTablesV5(g), scopeReviews: [badReview] });
  assert.equal(result2.ok, false);
  assert.match(result2.message, /invalid scopeReviews/);
  const badTr = { ...g.transitions[0], to: 'nowhere' };
  const result3 = await seedTables(store, { ...graphTablesV5(g), scopeTransitions: [badTr] });
  assert.equal(result3.ok, false);
  assert.match(result3.message, /invalid scopeTransitions/);
});

// ---------------------------------------------------------------------------
// Refinements — fail closed on every link.
// ---------------------------------------------------------------------------

test('refinement: a scope on a foreign assignment or non-owner owner fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  const foreign = { ...g.scope, assignmentId: 'asg-ghost' };
  const result = await seedTables(store, { ...graphTablesV5(g), scopes: [foreign] });
  assert.equal(result.ok, false);
  assert.match(result.message, /refinement/);
  const wrongOwner = { ...g.scope, ownerAgentId: 'agent-9' };
  const result2 = await seedTables(store, { ...graphTablesV5(g), scopes: [wrongOwner] });
  assert.equal(result2.ok, false);
});

test('refinement: declaration lineage must be contiguous — a skipped or forked revision fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  const gap = { ...g.scope, requestId: 'req-scp-9', revision: 3, priorRevision: 2 };
  const result = await seedTables(store, { ...graphTablesV5(g), scopes: [g.scope, gap] });
  assert.equal(result.ok, false, 'revision 3 without revision 2 is corruption');
  const fork = { ...g.scope, requestId: 'req-scp-9', label: 'forked' };
  const result2 = await seedTables(store, { ...graphTablesV5(g), scopes: [g.scope, fork] });
  assert.equal(result2.ok, false, 'two rows claim revision 1');
  const orphan = { ...g.scope, requestId: 'req-scp-9', revision: 2, priorRevision: null };
  const result3 = await seedTables(store, { ...graphTablesV5(g), scopes: [g.scope, orphan] });
  assert.equal(result3.ok, false, 'rev 2 must name priorRevision 1');
});

test('refinement: assignmentRevision beyond the assignment\'s structural revision fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  const future = { ...g.scope, assignmentRevision: 99 };
  const result = await seedTables(store, { ...graphTablesV5(g), scopes: [future] });
  assert.equal(result.ok, false);
});

test('refinement: a review by the owner or the bound seat is self-review — corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  // Each sub-case keeps the surrounding tables self-consistent — only the
  // self-review refinement can reject.
  const base = {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
    scopeTransitions: g.transitions,
  };
  // Owner as reviewer — its agentId is never a seat, so reviewerSeatId
  // claims the reviewer's membership and the owner check must still fail.
  const ownerReview = { ...g.reviews[0], reviewerAgentId: 'agent-lead' };
  const result = await seedTables(store, { ...base, scopeReviews: [ownerReview] });
  assert.equal(result.ok, false, 'the owner may never review');
  // The bound seat reviewing its own scope — its seat binding is real.
  const selfReview = { ...g.reviews[0], reviewerAgentId: 'agent-1', reviewerSeatId: g.seat.membershipId };
  const result2 = await seedTables(store, { ...base, scopeReviews: [selfReview] });
  assert.equal(result2.ok, false, 'the bound seat may never review its own scope');
});

test('refinement: a review pinned to a nonexistent scopeRevision or foreign candidate fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  const ghostRev = { ...g.reviews[0], scopeRevision: 7 };
  const result = await seedTables(store, { ...graphTablesV5(g), scopeReviews: [ghostRev] });
  assert.equal(result.ok, false);
  const foreignCand = { ...g.reviews[0], candidateSnapshot: '9'.repeat(64) };
  const result2 = await seedTables(store, { ...graphTablesV5(g), scopeReviews: [foreignCand] });
  assert.equal(result2.ok, false);
});

test('refinement: the transition walk must follow the shared edges — an illegal hop is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  // declared → advance is not an edge.
  const illegal = scopeTransitionRowV5({
    transitionId: 'stn-9', revision: 5, requestId: 'req-trn-9',
    command: 'advance', from: 'review-observed', to: 'advanced',
    discharged: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-2' }],
  });
  const result = await seedTables(store, { ...graphTablesV5(g), scopeTransitions: [...g.transitions, g.gate, illegal] });
  assert.equal(result.ok, false, 'an edge outside SCOPE_TRANSITIONS never commits');
  // A gap in the revision stream.
  const stream = [...g.transitions];
  const gap = scopeTransitionRowV5({ transitionId: 'stn-9', revision: 5, requestId: 'req-trn-9', command: 'claim', from: 'declared', to: 'claimed' });
  const result2 = await seedTables(store, { memberships: [g.lead, g.seat, g.reviewer], assignments: [g.assignment], candidates: [g.candidate], scopes: [g.scope], scopeTransitions: [g.transitions[0], gap] });
  assert.equal(result2.ok, false, 'transition revisions must be contiguous');
});

test('refinement: a transition whose `to` drifts from the edge\'s target is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  // claim is a legal edge from declared — but its `to` must be `claimed`,
  // never something else. A drifted `to` desyncs the derived machine state.
  const drifted = scopeTransitionRowV5({
    transitionId: 'stn-2', revision: 2, requestId: 'req-trn-2',
    command: 'claim', from: 'declared', to: 'closed',
  });
  const result = await seedTables(store, {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
    scopeTransitions: [g.transitions[0], drifted],
  });
  assert.equal(result.ok, false, 'the edge table owns the target state, not the row');
});

test('refinement: a gate transition\'s discharge must bind the round pin exactly', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  // Discharge naming a foreign reviewId.
  const badGate = { ...g.gate, discharged: [{ axis: 'spec', reviewId: 'srv-ghost' }, { axis: 'standards', reviewId: 'srv-2' }] };
  const result = await seedTables(store, { ...graphTablesV5(g), scopeTransitions: [...g.transitions, badGate] });
  assert.equal(result.ok, false, 'a discharge must name a real review row');
  // Only one axis discharged.
  const halfGate = { ...g.gate, discharged: [{ axis: 'spec', reviewId: 'srv-1' }] };
  const result2 = await seedTables(store, { ...graphTablesV5(g), scopeTransitions: [...g.transitions, halfGate] });
  assert.equal(result2.ok, false, 'every required axis must be discharged');
  // A discharge entry pointing at a review pinned to a different round.
  const wrongPin = { ...g.reviews[0], scopeRevision: 2 };
  const extraScope = { ...g.scope, requestId: 'req-scp-2', revision: 2, priorRevision: 1, label: 'amended' };
  const wrongGate = { ...g.gate, discharged: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-2' }] };
  const result3 = await seedTables(store, {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope, extraScope],
    scopeReviews: [{ ...wrongPin }, g.reviews[1]],
    scopeTransitions: [...g.transitions, wrongGate],
  });
  assert.equal(result3.ok, false, 'a review pinned off the round never discharges it');
});

test('refinement: an ungated transition carrying discharged entries is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  const tainted = scopeTransitionRowV5({
    transitionId: 'stn-2', revision: 2, requestId: 'req-trn-2',
    command: 'claim', from: 'declared', to: 'claimed',
    discharged: [{ axis: 'spec', reviewId: 'srv-1' }],
  });
  const result = await seedTables(store, {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
    scopeReviews: g.reviews,
    scopeTransitions: [g.transitions[0], tainted],
  });
  assert.equal(result.ok, false, 'only gated transitions carry discharge evidence');
});

test('refinement: a non-owner actor on a transition row fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  const wrong = { ...g.transitions[1], actorAgentId: 'agent-1' };
  const result = await seedTables(store, { ...graphTablesV5(g), scopeTransitions: [g.transitions[0], wrong] });
  assert.equal(result.ok, false);
});

test('refinement: duplicate request keys per actor fail closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV5();
  // A legal third transition (claimed → submitted-for-review) that reuses
  // the claim row's requestId — same (assignmentId, actorAgentId, requestId).
  const dup = scopeTransitionRowV5({
    transitionId: 'stn-3', revision: 3, requestId: 'req-trn-2',
    command: 'submit-for-review', from: 'claimed', to: 'submitted-for-review',
    candidateSnapshot: 'c'.repeat(64), candidateHead: 'a'.repeat(40),
  });
  const result = await seedTables(store, {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
    scopeTransitions: [g.transitions[0], g.transitions[1], dup],
  });
  assert.equal(result.ok, false, 'two transitions share (assignmentId, actorAgentId, requestId)');
});
// ===========================================================================
// Section: schema v6 — formerly tests/plugin-desk-store-schema-v6.test.mjs
// P5 store-level coverage: the additive v5→v6 migration, chained bumps from older versions, byte-preservation, and the decide → checkDefinitions/checkRuns/rollouts/rolloutTransitions channels with their refinements.
// ===========================================================================

function scopeRowV6(over = {}) {
  return {
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-scp-1',
    revision: 1,
    priorRevision: null,
    ownerMembershipId: 'LEAD_MID',
    ownerAgentId: 'agent-lead',
    assignmentRevision: 2,
    seatAgentId: 'agent-1',
    label: 'bounded slice',
    declarationSha256: 'e'.repeat(64),
    refs: [],
    ...over,
  };
}

function checkDefRow(over = {}) {
  return {
    checkId: 'check-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-chk-1',
    revision: 1,
    priorRevision: null,
    ownerMembershipId: 'LEAD_MID',
    ownerAgentId: 'agent-lead',
    assignmentRevision: 2,
    checkClass: 'repo-git-head',
    label: 'head pin check',
    definitionSha256: 'b'.repeat(64),
    limits: { timeoutMs: 5000, maxOutputBytes: 65536, maxRetries: 1 },
    requiredEvidence: [],
    refs: [],
    ...over,
  };
}

function checkRunRow(over = {}) {
  return {
    runId: 'run-1',
    assignmentId: 'asg-1',
    rolloutId: 'rollout-1',
    checkId: 'check-1',
    requestId: 'req-run-1',
    rolloutRevision: 1,
    definitionRevision: 1,
    definitionSha256: 'b'.repeat(64),
    candidateSnapshot: 'c'.repeat(64),
    candidateHead: 'a'.repeat(40),
    environment: { node: 'v99.0.0-test', platform: 'test-os' },
    status: 'passed',
    attempt: 1,
    retryOf: null,
    actorAgentId: 'agent-lead',
    actorSeatId: 'LEAD_MID',
    exitCode: 0,
    timedOut: false,
    durationMs: 12,
    outputSha256: 'f'.repeat(64),
    outputTail: 'ok',
    outputTruncated: false,
    outputPointer: null,
    evidenceRef: null,
    gap: null,
    ...over,
  };
}

function rolloutRow(over = {}) {
  return {
    rolloutId: 'rollout-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-rol-1',
    revision: 1,
    priorRevision: null,
    ownerMembershipId: 'LEAD_MID',
    ownerAgentId: 'agent-lead',
    assignmentRevision: 2,
    label: 'p5 rollout',
    declarationSha256: 'e'.repeat(64),
    candidateSnapshot: 'c'.repeat(64),
    candidateHead: 'a'.repeat(40),
    requiredChecks: [{ checkId: 'check-1', definitionDigest: 'b'.repeat(64) }],
    refs: [],
    ...over,
  };
}

const COHORT = (assignment, over = {}) => {
  const members = [assignment.ownerAgentId, ...assignment.seats.map(s => s.agentId)].sort();
  return {
    members,
    digest: sha256Hex(canonicalJson({ members, assignmentRevision: 2 })),
    assignmentRevision: 2,
    ...over,
  };
};

function rolloutTransitionRow(over = {}) {
  return {
    transitionId: 'rtn-1',
    assignmentId: 'asg-1',
    rolloutId: 'rollout-1',
    requestId: 'req-rtn-1',
    revision: 1,
    command: 'declare',
    from: null,
    to: 'declared',
    rolloutRevision: 1,
    actorAgentId: 'agent-lead',
    cohort: null,
    targetSnapshot: null,
    targetHead: null,
    evidenceRefs: [],
    dischargedChecks: [],
    dischargedReviews: [],
    cohortDigestAtGate: null,
    ...over,
  };
}

function scopeTransitionRowV6(over = {}) {
  return {
    transitionId: 'stn-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-stn-1',
    revision: 1,
    command: 'declare',
    from: null,
    to: 'declared',
    scopeRevision: 1,
    candidateSnapshot: null,
    candidateHead: null,
    discharged: [],
    actorAgentId: 'agent-lead',
    ...over,
  };
}

function scopeReviewRowV6(over = {}) {
  return {
    reviewId: 'srv-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-srv-1',
    revision: 1,
    scopeRevision: 1,
    candidateSnapshot: 'c'.repeat(64),
    axis: 'spec',
    verdict: 'approve',
    reviewerAgentId: 'agent-2',
    reviewerSeatId: randomUUID(),
    findingsRef: null,
    ...over,
  };
}

// A v5 fixture: the P4 shape — every pre-P5 field, no check/rollout tables.
function v5Ledger(over = {}) {
  return {
    format: 'paseo-slp/enforcement',
    schemaVersion: 5,
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
    requests: [
      {
        actorKey: 'actor-1',
        assignmentId: 'assign-1',
        requestId: 'req-1',
        bodySha256: canonicalSha256({ repo: REPO, command: COMMAND }),
        canonicalization: 'slp-canonical-json/1',
        receiptId: randomUUID(),
        revision: 1,
        outcome: 'committed',
        eventSeqs: null,
        rejection: null,
      },
    ],
    memberships: [membershipRow()],
    assignments: [],
    candidates: [],
    handbacks: [],
    settlements: [],
    scopes: [],
    scopeReviews: [],
    scopeTransitions: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Migration — additive v5→v6; old tables byte-preserved.
// ---------------------------------------------------------------------------

test('migration: a valid v5 ledger reads ok with persistedSchemaVersion 5 and empty P5 tables', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const g = graphV6();
  const v5 = v5Ledger({
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
  });
  writeFileSync(ledgerPath(dir), JSON.stringify(v5));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 5);
  assert.deepEqual(read.ledger.checkDefinitions, []);
  assert.deepEqual(read.ledger.checkRuns, []);
  assert.deepEqual(read.ledger.rollouts, []);
  assert.deepEqual(read.ledger.rolloutTransitions, []);
  assert.deepEqual(read.ledger.scopes, v5.scopes, 'P4 tables migrate verbatim');
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), JSON.stringify(v5), 'read never rewrites the file');
});

test('migration: the first commit on a v5 ledger writes v6 + schema-migrated, tables byte-preserved', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v5 = v5Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v5));
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.checkDefinitions, []);
  assert.deepEqual(onDisk.checkRuns, []);
  assert.deepEqual(onDisk.rollouts, []);
  assert.deepEqual(onDisk.rolloutTransitions, []);
  assert.deepEqual(onDisk.memberships, v5.memberships, 'memberships bytes preserved');
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 5, to: 6 });
});

test('migration: a rejection on a v5 ledger commits the v5 shape — the bump waits for success', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), JSON.stringify(v5Ledger()));
  const store = freshStore(dir);
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), () => ({
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required', recovery: 'change the command',
  }));
  assert.equal(rejected.ok, false);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 5, 'a rejection never bumps the version');
  assert.equal(onDisk.checkDefinitions, undefined, 'no P5 fields on the v5 file');
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true, events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(ok.ok, true);
  const migrated = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.checkRuns, []);
});

test('migration: MIGRATIONS[5] is pure and total — input untouched, output adds the four tables', () => {
  const v5 = v5Ledger();
  const snapshot = JSON.stringify(v5);
  const migrated = MIGRATIONS[5](v5);
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.checkDefinitions, []);
  assert.deepEqual(migrated.checkRuns, []);
  assert.deepEqual(migrated.rollouts, []);
  assert.deepEqual(migrated.rolloutTransitions, []);
  assert.equal(JSON.stringify(v5), snapshot, 'the input object is never mutated');
});

// ---------------------------------------------------------------------------
// The decide → state channels — same schema+refinement gate as P4.
// ---------------------------------------------------------------------------

// Each seed gets its own requestId — a shared envelope would replay the
// first committed request row and never reach decide.
const seedTablesV6 = (store, tables) =>
  store.transact(REPO_KEY, envelope({ requestId: `seed-${randomUUID()}` }), () => ({ ok: true, events: [], ...tables }));

/** A minimal VALID P5 graph: lead owner + one attached seat + the bound
 *  seat's observed candidate + scope + check definition + rollout +
 *  opening edge + start-checks + a passed run + the discharging gate row. */
function graphV6() {
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const seat = membershipRow({ agentId: 'agent-1' });
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [{ agentId: seat.agentId, membershipId: seat.membershipId }],
  });
  const candidate = candidateRow({ seatMembershipId: seat.membershipId, seatAgentId: seat.agentId });
  const scope = scopeRowV6({ ownerMembershipId: lead.membershipId });
  const def = checkDefRow({ ownerMembershipId: lead.membershipId });
  const rollout = rolloutRow({ ownerMembershipId: lead.membershipId });
  const transitions = [
    rolloutTransitionRow({ transitionId: 'rtn-1', revision: 1 }),
    rolloutTransitionRow({
      transitionId: 'rtn-2', revision: 2, requestId: 'req-rtn-2',
      command: 'start-checks', from: 'declared', to: 'checks-running',
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-3', revision: 3, requestId: 'req-rtn-3',
      command: 'checks-passed', from: 'checks-running', to: 'checks-passed',
      dischargedChecks: [{ checkId: 'check-1', runId: 'run-1' }],
    }),
  ];
  const run = checkRunRow({ actorSeatId: lead.membershipId });
  return { lead, seat, assignment, candidate, scope, def, rollout, transitions, run };
}

const graphTablesV6 = g => ({
  memberships: [g.lead, g.seat],
  assignments: [g.assignment],
  candidates: [g.candidate],
  scopes: [g.scope],
  checkDefinitions: [g.def],
  rollouts: [g.rollout],
  checkRuns: [g.run],
  rolloutTransitions: g.transitions,
});

test('channel: a valid P5 graph commits and reads back', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  const result = await seedTablesV6(store, graphTablesV6(g));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.checkDefinitions.length, 1);
  assert.equal(read.ledger.checkRuns.length, 1);
  assert.equal(read.ledger.rollouts.length, 1);
  assert.equal(read.ledger.rolloutTransitions.length, 3);
});

test('channel: schema-invalid P5 tables reject INVALID_RECORD', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  const badDef = { ...g.def, checkClass: 'arbitrary-shell' };
  const result = await seedTablesV6(store, { ...graphTablesV6(g), checkDefinitions: [badDef] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /invalid checkDefinitions/);
  const badRun = { ...g.run, status: 'mystery' };
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [badRun] });
  assert.equal(result2.ok, false);
  assert.match(result2.message, /invalid checkRuns/);
  const badRollout = { ...g.rollout, requiredChecks: 'not-an-array' };
  const result3 = await seedTablesV6(store, { ...graphTablesV6(g), rollouts: [badRollout] });
  assert.equal(result3.ok, false);
  assert.match(result3.message, /invalid rollouts/);
  const badTr = { ...g.transitions[0], to: 'deployed' };
  const result4 = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [badTr] });
  assert.equal(result4.ok, false);
  assert.match(result4.message, /invalid rolloutTransitions/);
});

// ---------------------------------------------------------------------------
// Refinements — fail closed on every link.
// ---------------------------------------------------------------------------

test('refinement: a definition on a foreign assignment/scope or non-owner owner fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  const foreign = { ...g.def, assignmentId: 'asg-ghost' };
  const result = await seedTablesV6(store, { ...graphTablesV6(g), checkDefinitions: [foreign] });
  assert.equal(result.ok, false);
  const wrongOwner = { ...g.def, ownerAgentId: 'agent-9' };
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), checkDefinitions: [wrongOwner] });
  assert.equal(result2.ok, false);
  const ghostScope = { ...g.def, scopeId: 'scope-ghost' };
  const result3 = await seedTablesV6(store, { ...graphTablesV6(g), checkDefinitions: [ghostScope] });
  assert.equal(result3.ok, false);
});

test('refinement: definition and rollout lineages must be contiguous 1..N', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  const gap = { ...g.def, requestId: 'req-chk-9', revision: 3, priorRevision: 2 };
  const result = await seedTablesV6(store, { ...graphTablesV6(g), checkDefinitions: [g.def, gap] });
  assert.equal(result.ok, false, 'definition revision 3 without revision 2 is corruption');
  const rolGap = { ...g.rollout, requestId: 'req-rol-9', revision: 2, priorRevision: null };
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), rollouts: [g.rollout, rolGap] });
  assert.equal(result2.ok, false, 'rollout revision 2 must name priorRevision 1');
  // Contiguous revisions but a forged priorRevision link — only the
  // immediate-parent check catches this; the size check alone passes.
  const forged = { ...g.def, requestId: 'req-chk-9', revision: 2, priorRevision: null };
  const result3 = await seedTablesV6(store, { ...graphTablesV6(g), checkDefinitions: [g.def, forged] });
  assert.equal(result3.ok, false, 'revision 2 must chain priorRevision 1 — contiguity is not lineage');
});

test('refinement: a rollout pinned to a phantom candidate or phantom check digest fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  const ghostCand = { ...g.rollout, candidateSnapshot: '9'.repeat(64) };
  const result = await seedTablesV6(store, { ...graphTablesV6(g), rollouts: [ghostCand] });
  assert.equal(result.ok, false);
  const badDigest = { ...g.rollout, requiredChecks: [{ checkId: 'check-1', definitionDigest: '7'.repeat(64) }] };
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), rollouts: [badDigest] });
  assert.equal(result2.ok, false, 'a required pin must resolve to a definition row at that digest');
  // A required check living on a different scope never resolves — even
  // with a correct digest.
  const scope2 = { ...g.scope, scopeId: 'scope-2', requestId: 'req-scp-2' };
  const defOtherScope = { ...g.def, checkId: 'check-9', scopeId: 'scope-2', requestId: 'req-chk-9' };
  const wrongScope = { ...g.rollout, requiredChecks: [{ checkId: 'check-9', definitionDigest: 'b'.repeat(64) }] };
  const result3 = await seedTablesV6(store, {
    ...graphTablesV6(g),
    scopes: [g.scope, scope2],
    checkDefinitions: [g.def, defOtherScope],
    rollouts: [wrongScope],
  });
  assert.equal(result3.ok, false, 'a required check on another scope never resolves');
});

test('refinement: a run bound to a mismatched definition digest or rollout pin is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  const badDigest = { ...g.run, definitionSha256: '7'.repeat(64) };
  const result = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [badDigest] });
  assert.equal(result.ok, false, 'run digest must match the pinned definition row');
  const badCandidate = { ...g.run, candidateSnapshot: '8'.repeat(64) };
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [badCandidate] });
  assert.equal(result2.ok, false, 'run candidate must equal the pinned declaration revision');
  const foreignActor = { ...g.run, actorAgentId: 'agent-1' };
  const result3 = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [foreignActor] });
  assert.equal(result3.ok, false, 'runs are owner-authored only');
});

test('refinement: a blocked run must carry its gap record; a passed run may not', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  const unblocked = { ...g.run, gap: { capability: 'repo-checkout', detail: 'missing' } };
  const result = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [unblocked] });
  assert.equal(result.ok, false, 'only a blocked run carries a gap');
  const bareBlocked = {
    ...g.run,
    status: 'blocked',
    exitCode: null,
    durationMs: null,
    outputSha256: null,
    outputTail: null,
    gap: null,
  };
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [bareBlocked] });
  assert.equal(result2.ok, false, 'blocked without a gap record is corrupt');
  const executedBlocked = { ...bareBlocked, gap: { capability: 'x', detail: 'y' }, exitCode: 1 };
  const result3 = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [executedBlocked] });
  assert.equal(result3.ok, false, 'a blocked run never executed — no exit fields');
});

test('refinement: retry streams are contiguous, chained and capped by the definition', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  // A third attempt exceeds maxRetries 1.
  const third = checkRunRow({
    runId: 'run-3', requestId: 'req-run-3', attempt: 3, retryOf: 'run-2', status: 'failed',
  });
  const second = checkRunRow({
    runId: 'run-2', requestId: 'req-run-2', attempt: 2, retryOf: 'run-1', status: 'failed',
  });
  const result = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [g.run, second, third] });
  assert.equal(result.ok, false, 'maxRetries 1 allows two attempts, never three');
  // A retry naming a phantom predecessor.
  const orphan = checkRunRow({ runId: 'run-2', requestId: 'req-run-2', attempt: 2, retryOf: 'run-ghost', status: 'failed' });
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [g.run, orphan] });
  assert.equal(result2.ok, false, 'attempt 2 must chain attempt 1 by runId');
  // A stream mixing pinned definitions is corrupt.
  const mixed = checkRunRow({ runId: 'run-2', requestId: 'req-run-2', attempt: 2, retryOf: 'run-1', status: 'failed', definitionRevision: 9, definitionSha256: 'b'.repeat(64) });
  const result3 = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [g.run, mixed] });
  assert.equal(result3.ok, false, 'a stream runs one definition revision');
});

test('refinement: the rollout walk follows ROLLOUT_TRANSITIONS — illegal hops and drifted `to` are corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  const illegal = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-9',
    command: 'promote', from: 'checks-passed', to: 'promoted',
  });
  const result = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [...g.transitions, illegal] });
  assert.equal(result.ok, false, 'checks-passed → promote is not an edge');
  const drifted = rolloutTransitionRow({
    transitionId: 'rtn-2', revision: 2, requestId: 'req-rtn-2',
    command: 'start-checks', from: 'declared', to: 'promoted',
  });
  const result2 = await seedTablesV6(store, {
    ...graphTablesV6(g),
    rolloutTransitions: [g.transitions[0], drifted],
  });
  assert.equal(result2.ok, false, 'the edge table owns the target state');
  const dupRequest = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-2',
    command: 'checks-failed', from: 'checks-running', to: 'checks-failed',
  });
  const result3 = await seedTablesV6(store, {
    ...graphTablesV6(g),
    rolloutTransitions: [g.transitions[0], g.transitions[1], dupRequest],
  });
  assert.equal(result3.ok, false, 'two transitions share (assignmentId, actorAgentId, requestId)');
});

test('refinement: cohort and target fields ride exactly their commands', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  // cohort on a non-start-canary row.
  const stray = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-9',
    command: 'canary-ready', from: 'checks-passed', to: 'canary-ready',
    cohort: COHORT(g.assignment),
  });
  const result = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [...g.transitions, stray] });
  assert.equal(result.ok, false, 'a stray cohort payload is corruption');
  // start-canary without a cohort.
  const bare = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-9',
    command: 'start-canary', from: 'canary-ready', to: 'canary-running',
    cohort: null,
  });
  const withReady = [...g.transitions, rolloutTransitionRow({
    transitionId: 'rtn-4', revision: 4, requestId: 'req-rtn-4',
    command: 'canary-ready', from: 'checks-passed', to: 'canary-ready',
  })];
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [...withReady, { ...bare, revision: 5 }] });
  assert.equal(result2.ok, false, 'start-canary must pin the cohort');
  // A forged roster digest.
  const forged = rolloutTransitionRow({
    transitionId: 'rtn-5', revision: 5, requestId: 'req-rtn-5',
    command: 'start-canary', from: 'canary-ready', to: 'canary-running',
    cohort: { members: ['agent-1'], digest: '0'.repeat(64), assignmentRevision: 2 },
  });
  const result3 = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [...withReady, forged] });
  assert.equal(result3.ok, false, 'the cohort digest recomputes — a forged roster is corrupt');
  // A cohort member outside the assignment roster.
  const outsideCohort = COHORT(g.assignment, { members: ['agent-1', 'agent-lead', 'agent-9'].sort() });
  outsideCohort.digest = sha256Hex(canonicalJson({ members: outsideCohort.members, assignmentRevision: 2 }));
  const outsider = rolloutTransitionRow({
    transitionId: 'rtn-5', revision: 5, requestId: 'req-rtn-5',
    command: 'start-canary', from: 'canary-ready', to: 'canary-running',
    cohort: outsideCohort,
  });
  const result4 = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [...withReady, outsider] });
  assert.equal(result4.ok, false, 'cohort members must be the assignment roster');
  // rollback target must resolve.
  const ghostTarget = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-9',
    command: 'rollback', from: 'checks-passed', to: 'rolled-back',
    targetSnapshot: '9'.repeat(64), targetHead: null,
  });
  const result5 = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [...g.transitions, ghostTarget] });
  assert.equal(result5.ok, false, 'rollback pins an observed candidate, never a claimed hash');
});

test('refinement: a check-gated transition must discharge real passed runs bound to the pins', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  // Phantom runId.
  const badGate = { ...g.transitions[2], dischargedChecks: [{ checkId: 'check-1', runId: 'run-ghost' }] };
  const result = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [g.transitions[0], g.transitions[1], badGate] });
  assert.equal(result.ok, false, 'a discharge must name a real run');
  // Empty discharge on a gated command.
  const bareGate = { ...g.transitions[2], dischargedChecks: [] };
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [g.transitions[0], g.transitions[1], bareGate] });
  assert.equal(result2.ok, false, 'every required check must be discharged');
  // A failed run never discharges.
  const failedRun = { ...g.run, status: 'failed' };
  const result3 = await seedTablesV6(store, { ...graphTablesV6(g), checkRuns: [failedRun] });
  assert.equal(result3.ok, false, 'a failed run cannot discharge the gate');
  // An ungated command carrying discharge evidence.
  const stray = { ...g.transitions[1], dischargedChecks: [{ checkId: 'check-1', runId: 'run-1' }] };
  const result4 = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [g.transitions[0], stray] });
  assert.equal(result4.ok, false, 'only check-gated transitions carry discharge evidence');
});

test('refinement: a cohort-gated transition records the pinned digest at gate time', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graphV6();
  const ready = rolloutTransitionRow({
    transitionId: 'rtn-4', revision: 4, requestId: 'req-rtn-4',
    command: 'canary-ready', from: 'checks-passed', to: 'canary-ready',
  });
  const cohort = COHORT(g.assignment);
  const canary = rolloutTransitionRow({
    transitionId: 'rtn-5', revision: 5, requestId: 'req-rtn-5',
    command: 'start-canary', from: 'canary-ready', to: 'canary-running',
    cohort,
  });
  const passed = rolloutTransitionRow({
    transitionId: 'rtn-6', revision: 6, requestId: 'req-rtn-6',
    command: 'canary-passed', from: 'canary-running', to: 'canary-passed',
    cohortDigestAtGate: cohort.digest,
  });
  const valid = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [...g.transitions, ready, canary, passed] });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  // A gate digest that disagrees with the pinned cohort is corruption —
  // the decide would have rejected, and a forged commit cannot replay.
  const drifted = { ...passed, cohortDigestAtGate: '0'.repeat(64) };
  const result = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [...g.transitions, ready, canary, drifted] });
  assert.equal(result.ok, false, 'the gate digest must equal the pinned cohort digest');
  // A cohort-gated row without the recorded digest.
  const bare = { ...passed, cohortDigestAtGate: null };
  const result2 = await seedTablesV6(store, { ...graphTablesV6(g), rolloutTransitions: [...g.transitions, ready, canary, bare] });
  assert.equal(result2.ok, false, 'a cohort-gated commit must record what it observed');
});

/** A promote-ready graph: a reviewer seat joins the roster, the scope's
 *  review round stands approved on the rollout's exact candidate pin, and
 *  the transition stream walks to `promote` carrying every discharge the
 *  decide would have recorded. */
function promoteGraph() {
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const seat = membershipRow({ agentId: 'agent-1' });
  const reviewer = membershipRow({ agentId: 'agent-2', bindingHandleSha256: 'b'.repeat(64) });
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [
      { agentId: seat.agentId, membershipId: seat.membershipId },
      { agentId: reviewer.agentId, membershipId: reviewer.membershipId },
    ],
  });
  const candidate = candidateRow({ seatMembershipId: seat.membershipId, seatAgentId: seat.agentId });
  const scope = scopeRowV6({ ownerMembershipId: lead.membershipId });
  const def = checkDefRow({ ownerMembershipId: lead.membershipId });
  const rollout = rolloutRow({ ownerMembershipId: lead.membershipId });
  const reviews = [
    scopeReviewRowV6({ reviewerSeatId: reviewer.membershipId }),
    scopeReviewRowV6({ reviewId: 'srv-2', requestId: 'req-srv-2', axis: 'standards', reviewerSeatId: reviewer.membershipId }),
  ];
  const scopeTransitions = [
    scopeTransitionRowV6({ transitionId: 'stn-1', revision: 1 }),
    scopeTransitionRowV6({
      transitionId: 'stn-2', revision: 2, requestId: 'req-stn-2',
      command: 'claim', from: 'declared', to: 'claimed',
    }),
    scopeTransitionRowV6({
      transitionId: 'stn-3', revision: 3, requestId: 'req-stn-3',
      command: 'submit-for-review', from: 'claimed', to: 'submitted-for-review',
      candidateSnapshot: 'c'.repeat(64), candidateHead: 'a'.repeat(40),
    }),
    scopeTransitionRowV6({
      transitionId: 'stn-4', revision: 4, requestId: 'req-stn-4',
      command: 'review-observed', from: 'submitted-for-review', to: 'review-observed',
      discharged: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-2' }],
    }),
    scopeTransitionRowV6({
      transitionId: 'stn-5', revision: 5, requestId: 'req-stn-5',
      command: 'approve', from: 'review-observed', to: 'approved',
    }),
  ];
  const cohort = COHORT(assignment);
  const transitions = [
    rolloutTransitionRow({ transitionId: 'rtn-1', revision: 1 }),
    rolloutTransitionRow({
      transitionId: 'rtn-2', revision: 2, requestId: 'req-rtn-2',
      command: 'start-checks', from: 'declared', to: 'checks-running',
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-3', revision: 3, requestId: 'req-rtn-3',
      command: 'checks-passed', from: 'checks-running', to: 'checks-passed',
      dischargedChecks: [{ checkId: 'check-1', runId: 'run-1' }],
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-4', revision: 4, requestId: 'req-rtn-4',
      command: 'canary-ready', from: 'checks-passed', to: 'canary-ready',
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-5', revision: 5, requestId: 'req-rtn-5',
      command: 'start-canary', from: 'canary-ready', to: 'canary-running', cohort,
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-6', revision: 6, requestId: 'req-rtn-6',
      command: 'canary-passed', from: 'canary-running', to: 'canary-passed',
      cohortDigestAtGate: cohort.digest,
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-7', revision: 7, requestId: 'req-rtn-7',
      command: 'promote', from: 'canary-passed', to: 'promoted',
      dischargedChecks: [{ checkId: 'check-1', runId: 'run-1' }],
      dischargedReviews: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-2' }],
      cohortDigestAtGate: cohort.digest,
    }),
  ];
  const run = checkRunRow({ actorSeatId: lead.membershipId });
  return { lead, seat, reviewer, assignment, candidate, scope, def, rollout, transitions, reviews, scopeTransitions, run };
}

const promoteTables = g => ({
  memberships: [g.lead, g.seat, g.reviewer],
  assignments: [g.assignment],
  candidates: [g.candidate],
  scopes: [g.scope],
  scopeTransitions: g.scopeTransitions,
  scopeReviews: g.reviews,
  checkDefinitions: [g.def],
  rollouts: [g.rollout],
  checkRuns: [g.run],
  rolloutTransitions: g.transitions,
});

test('channel: a fully-gated promote graph commits and reads back', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = promoteGraph();
  const result = await seedTablesV6(store, promoteTables(g));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.rolloutTransitions.length, 7);
});

test('refinement: a promote row carries exactly the approved round\'s discharge — forged, missing, extra or mismatched evidence is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = promoteGraph();
  const promote = g.transitions[6];
  // A forged reviewId resolves to nothing.
  const forged = { ...promote, dischargedReviews: [{ axis: 'spec', reviewId: 'srv-ghost' }, { axis: 'standards', reviewId: 'srv-2' }] };
  const result = await seedTablesV6(store, { ...promoteTables(g), rolloutTransitions: [...g.transitions.slice(0, 6), forged] });
  assert.equal(result.ok, false, 'a discharge must name a durable review row');
  // A missing axis leaves the round under-discharged.
  const missing = { ...promote, dischargedReviews: [{ axis: 'spec', reviewId: 'srv-1' }] };
  const result2 = await seedTablesV6(store, { ...promoteTables(g), rolloutTransitions: [...g.transitions.slice(0, 6), missing] });
  assert.equal(result2.ok, false, 'every required axis must be discharged once');
  // An extra discharge row — a duplicated axis — never shrinks or pads the set.
  const extra = { ...promote, dischargedReviews: [...promote.dischargedReviews, { axis: 'spec', reviewId: 'srv-2' }] };
  const result3 = await seedTablesV6(store, { ...promoteTables(g), rolloutTransitions: [...g.transitions.slice(0, 6), extra] });
  assert.equal(result3.ok, false, 'an axis discharges at most once');
  // A real review row bound to a different candidate than the rollout pin.
  const foreign = scopeReviewRowV6({ reviewId: 'srv-9', requestId: 'req-srv-9', axis: 'standards', candidateSnapshot: '9'.repeat(64), reviewerSeatId: g.reviewer.membershipId });
  const wrongPin = { ...promote, dischargedReviews: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-9' }] };
  const result4 = await seedTablesV6(store, {
    ...promoteTables(g),
    scopeReviews: [...g.reviews, foreign],
    rolloutTransitions: [...g.transitions.slice(0, 6), wrongPin],
  });
  assert.equal(result4.ok, false, 'the review must bind the promoted candidate');
  // No approved round at all — the discharge evidence is unanchored.
  const unanchored = promoteTables(g);
  unanchored.scopeTransitions = g.scopeTransitions.slice(0, 4);
  const result5 = await seedTablesV6(store, unanchored);
  assert.equal(result5.ok, false, 'no approve edge consumed this discharge set');
  // Review evidence on a non-gated transition.
  const stray = { ...g.transitions[1], dischargedReviews: [{ axis: 'spec', reviewId: 'srv-1' }] };
  const result6 = await seedTablesV6(store, { ...promoteTables(g), rolloutTransitions: [g.transitions[0], stray, ...g.transitions.slice(2)] });
  assert.equal(result6.ok, false, 'only review-gated transitions carry review evidence');
});
