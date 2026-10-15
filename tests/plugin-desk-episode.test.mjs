import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEpisodeTracker, assignmentEpisode } from '../plugin/server/desk-episode.ts';
import { createDeskStore, verifiedDeskEvents, repoKeyFor } from '../plugin/server/desk-store.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';
import { episodeId, episodeLabels } from '../plugin/server/runtime/episode.ts';
import { runAssignmentClose, runAssignmentRegister } from '../plugin/server/desk-handback.ts';
import { gitRepo, memberRow, repoOf, seedMemberships } from './helpers/desk-bridge-fixture.mjs';
import { placementFixture } from './helpers/formation-placement-fixture.mjs';
import { realDesk, taskSpec, bootstrapInput } from './helpers/task-execution-fixtures.mjs';
import { latestTask } from '../plugin/server/desk-task.ts';
import { runTaskDispatch } from '../plugin/server/desk-task-execution.ts';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'slp-episode-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = { hostId: 'local', gitCommonDir: join(root, '.git') };
  mkdirSync(repo.gitCommonDir);
  const store = createDeskStore({ stableRoot: root }), repoKey = repoKeyFor(repo);
  assert.equal((await store.transact(repoKey, { repo, actorKey: 'fixture', assignmentId: 'seed', requestId: 'seed', command: {} }, () => ({ok:true, events:[]}))).ok, true);
  const ledger = store.read(repoKey).ledger;
  return { root, ledger, store, repo, repoKey, tracker: createEpisodeTracker(root), creator: { agentId: 'human-root', labels: {}, ledger },
    state: () => join(root, 'state/episodes', `${canonicalSha256('human-root')}.jsonl`) };
}

test('an unlabelled root shares one episode across calls and restart without rewriting it', async t => {
  const f = await fixture(t);
  const first = f.tracker.forSeat({ ...f.creator, key: 'formation-A' });
  assert.equal(first.episode.rootAgentId, 'human-root');
  assert.equal(first.basis, 'creator-unlabelled-unformed');
  assert.deepEqual(first.warnings, []);
  const initial = readFileSync(f.state(), 'utf8'), info = lstatSync(f.state());
  const second = createEpisodeTracker(f.root).forSeat({ ...f.creator, key: 'formation-B' });
  assert.deepEqual(second.episode, first.episode);
  assert.equal(readFileSync(f.state(), 'utf8'), initial);
  assert.equal(lstatSync(f.state()).mtimeMs, info.mtimeMs);
  const records = initial.trimEnd().split('\n').map(line => JSON.parse(line));
  const record = { body: { events: records.map(row => row.body.event) } };
  assert.equal(record.body.events.length, 1);
  assert.equal(record.body.events[0].kind, 'episode-opened');
  assert.deepEqual(Object.keys(record.body.events[0].payload).sort(), ['at', 'episodeId', 'rootAgentId']);
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
  assert.deepEqual(f.creator.labels, {}, 'the Human-created root stays unlabelled');
});

test('parallel root selections converge, while explicit new is stable on replay', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.resolve().then(() =>
    createEpisodeTracker(f.root).forSeat({ ...f.creator, key: `parallel-${i}` }))));
  assert.equal(new Set(results.map(row => row.episode.episodeId)).size, 1);
  const next = f.tracker.forSeat({ ...f.creator, mode: 'new', key: 'new-assignment' });
  assert.notEqual(next.episode.episodeId, results[0].episode.episodeId);
  const replay = createEpisodeTracker(f.root).forSeat({ ...f.creator, mode: 'new', key: 'new-assignment' });
  assert.deepEqual(replay.episode, next.episode);
  assert.equal(readFileSync(f.state(), 'utf8').trimEnd().split('\n').length, 2);
});

test('labelled descendants inherit globally across desks and a later new root assignment overrides first-episode labels', async t => {
  const f = await fixture(t), first = f.tracker.forSeat({ ...f.creator, key: 'initial' });
  const child = { agentId: 'lead-in-another-repo', labels: episodeLabels(first.episode), ledger: f.ledger };
  const inherit = f.tracker.forSeat({ ...child, key: 'descendant' });
  assert.deepEqual(inherit.episode, first.episode);
  const next = f.tracker.forSeat({ ...child, mode: 'new', key: 'later-human-assignment' });
  assert.equal(next.episode.rootAgentId, child.agentId);
  assert.notEqual(next.episode.episodeId, first.episode.episodeId);
  assert.deepEqual(createEpisodeTracker(f.root).forSeat({ ...child, key: 'later-child' }).episode, next.episode);
});

test('legacy children, unreadable labels and unavailable history stay explicit gaps', async t => {
  const f = await fixture(t);
  for (const labels of [null, { 'slp.formation': 'old-formation' }, { 'paseo.parent-agent-id': 'parent' }]) {
    const result = f.tracker.forSeat({ ...f.creator, labels, mode: 'new', key: 'missing' });
    assert.equal(result.episode, null);
    assert.deepEqual(result.labels, {});
    assert.deepEqual(result.warnings, ['episode-context-missing']);
  }
  assert.equal(existsSync(join(f.root, 'state/episodes')), false);
  const ambiguous = f.tracker.forSeat({ ...f.creator, key: 'ambiguous', ledger: null });
  assert.equal(ambiguous.episode, null);
  assert.deepEqual(ambiguous.warnings, ['episode-history-unavailable']);
  assert.equal(existsSync(join(f.root, 'state/episodes')), false);
});

async function managedFixture(t) {
  const f = await fixture(t);
  const row = memberRow('root', { provider: 'slp-codex-lead', at: '2026-01-01T00:00:00.000Z' },
    { agentId: f.creator.agentId, role: 'lead', createCwd: f.root });
  await seedMemberships(f.store, f.repo, [row]);
  const ctx = { repoKey: f.repoKey, row };
  return { ...f, row, ctx, ledgerNow: () => f.store.read(f.repoKey).ledger,
    register: requestId => runAssignmentRegister(ctx, { requestId, authorityRef: 'human:grant', objective: 'bounded' },
      { store: f.store, episode: id => {
        const resolve = f.tracker.prepareAssignment({ ...f.creator, key: `assignment:${id}` });
        return ledger => {
          assert.notEqual(verifiedDeskEvents(ledger), null, 'the decide snapshot carries its verified history');
          return resolve(ledger);
        };
      } }),
    close: assignmentId => runAssignmentClose(ctx, { assignmentId, requestId: `close-${assignmentId}` }, { store: f.store }),
  };
}

test('causal desk anchors invalidate old Lean pointers after later managed assignments, across repeated cycles', async t => {
  const f = await managedFixture(t);
  const x = f.tracker.forSeat({ ...f.creator, key: 'lean-X', ledger: f.ledgerNow() }).episode;
  const a = await f.register('managed-A');
  await f.close(a.assignmentId);
  const z = f.tracker.forSeat({ ...f.creator, key: 'lean-Z', ledger: f.ledgerNow() }).episode;
  assert.notEqual(z.episodeId, x.episodeId);
  const b = await f.register('managed-B');
  await f.close(b.assignmentId);
  const after = f.tracker.forSeat({ ...f.creator, key: 'after-B', ledger: f.ledgerNow() }).episode;
  assert.notEqual(after.episodeId, z.episodeId);
});

test('closing an older managed assignment preserves a newer explicit Lean episode', async t => {
  const f = await managedFixture(t), a = await f.register('managed-A');
  const z = f.tracker.forSeat({ ...f.creator, key: 'newer-Lean', mode: 'new', ledger: f.ledgerNow() }).episode;
  assert.deepEqual(f.tracker.forSeat({ ...f.creator, key: 'before-close', ledger: f.ledgerNow() }).episode, z);
  await f.close(a.assignmentId);
  assert.deepEqual(createEpisodeTracker(f.root).forSeat({ ...f.creator, key: 'after-close', ledger: f.ledgerNow() }).episode, z);
});

test('an unlinked ledger clone is a metadata gap and cannot revive an old pointer', async t => {
  const f = await managedFixture(t);
  f.tracker.forSeat({ ...f.creator, key: 'old-Lean', ledger: f.ledgerNow() });
  const result = f.tracker.forSeat({ ...f.creator, key: 'unlinked', ledger: structuredClone(f.ledgerNow()) });
  assert.equal(result.episode, null);
  assert.deepEqual(result.warnings, ['episode-history-unavailable']);
});

test('two registered root assignments are ambiguous, and a descendant close never closes the root episode', async t => {
  const f = await managedFixture(t), a = await f.register('managed-A'), b = await f.register('managed-B');
  const ambiguous = f.tracker.forSeat({ ...f.creator, key: 'ambiguous', ledger: f.ledgerNow() });
  assert.deepEqual(ambiguous.warnings, ['episode-context-ambiguous']);
  assert.equal(ambiguous.episode, null);
  await f.close(b.assignmentId);
  const episode = assignmentEpisode(f.ledgerNow(), a.assignmentId);
  const child = memberRow('child', { provider: 'slp-codex-lead', at: '2026-01-01T00:00:00.000Z' },
    { agentId: 'child-lead', role: 'lead', createCwd: f.root });
  await seedMemberships(f.store, f.repo, [f.row, child]);
  const ctx = { repoKey: f.repoKey, row: child };
  const registered = await runAssignmentRegister(ctx, { requestId: 'child-task', authorityRef: 'grant', objective: null }, {
    store: f.store, episode: id => f.tracker.prepareAssignment({ agentId: child.agentId,
      labels: episodeLabels(episode), key: id }),
  });
  const before = verifiedDeskEvents(f.ledgerNow()).filter(event => event.kind === 'episode-closed').length;
  await runAssignmentClose(ctx, { assignmentId: registered.assignmentId, requestId: 'child-close' }, { store: f.store });
  assert.equal(verifiedDeskEvents(f.ledgerNow()).filter(event => event.kind === 'episode-closed').length, before);
});

test('retention exhaustion warns, preserves history and still allows inheritance', async t => {
  const f = await fixture(t), first = f.tracker.forSeat({ ...f.creator, key: 'initial' });
  const initial = JSON.parse(readFileSync(f.state(), 'utf8').trim());
  let previousSha256 = null;
  const bytes = Array.from({ length: 2048 }, (_, i) => {
    const body = { ...initial.body, event: i === 0 ? initial.body.event
      : { kind: 'episode-opened', payload: { episodeId: episodeId(`retained-${i}`), rootAgentId: f.creator.agentId,
        at: '2026-01-01T00:00:00.000Z' } } };
    const sha256 = canonicalSha256({ body, previousSha256 });
    const line = JSON.stringify({ body, previousSha256, sha256 }) + '\n';
    previousSha256 = sha256;
    return line;
  }).join('');
  writeFileSync(f.state(), bytes);
  assert.deepEqual(createEpisodeTracker(f.root).forSeat({ ...f.creator, key: 'too-many', mode: 'new' }).warnings,
    ['episode-state-budget']);
  assert.equal(readFileSync(f.state(), 'utf8'), bytes);
  assert.equal(f.tracker.forSeat({ ...f.creator, key: 'still-inherit' }).episode.episodeId, episodeId('retained-2047'));
});

test('corrupt metadata, unsafe paths and a retained lock never overwrite evidence or throw', async t => {
  const f = await fixture(t);
  f.tracker.forSeat({ ...f.creator, key: 'initial' });
  writeFileSync(f.state(), 'broken');
  assert.deepEqual(f.tracker.forSeat({ ...f.creator, key: 'next' }).warnings, ['episode-state-corrupt']);
  assert.equal(readFileSync(f.state(), 'utf8'), 'broken');
  const g = await fixture(t), foreign = join(g.root, 'foreign');
  mkdirSync(foreign);
  symlinkSync(foreign, join(g.root, 'state/episodes'));
  assert.deepEqual(g.tracker.forSeat({ ...g.creator, key: 'symlink' }).warnings, ['episode-state-unavailable']);
  assert.deepEqual(readdirSync(foreign), []);
  const h = await fixture(t);
  h.tracker.forSeat({ ...h.creator, key: 'initial' });
  writeFileSync(`${h.state()}.lock`, 'retained');
  assert.equal(h.tracker.forSeat({ ...h.creator, key: 'inherit' }).episode.rootAgentId, h.creator.agentId);
  assert.deepEqual(h.tracker.forSeat({ ...h.creator, mode: 'new', key: 'new' }).warnings, ['episode-lock-retained']);
  assert.equal(readFileSync(`${h.state()}.lock`, 'utf8'), 'retained');
});

test('metadata persistence failure does not stop native formation', async t => {
  const f = placementFixture(t);
  // Operations also own state/, so inject an isolated unavailable metadata
  // root rather than corrupting their mandatory receipt namespace.
  const bad = await fixture(t); writeFileSync(join(bad.root, 'state/episodes'), 'occupied');
  f.deps.selectEpisode = key => bad.tracker.forSeat({ ...bad.creator, key });
  const out = await f.run();
  assert.equal(out.result.state, 'awaiting-caller-delivery');
  assert.ok(out.phases.find(row => row.name === 'create-issued').value.warnings.includes('episode-state-unavailable'));
});

test('managed assignment events supply root context and close exactly once in existing transactions', async t => {
  const f = await fixture(t), git = gitRepo(t, 'slp-episode-desk-'), repo = repoOf(git);
  const store = createDeskStore({ stableRoot: f.root });
  const row = memberRow('root-handle', { provider: 'slp-codex-lead', at: '2026-01-01T00:00:00.000Z' }, { agentId: f.creator.agentId, role: 'lead' });
  const repoKey = await seedMemberships(store, repo, [row]);
  const ctx = { repoKey, row }, input = { requestId: 'register', authorityRef: 'human:grant', objective: 'bounded' };
  const deps = { store, episode: id => f.tracker.prepareAssignment({ ...f.creator, key: `assignment:${id}` }) };
  const registered = await runAssignmentRegister(ctx, input, deps);
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const ledger = store.read(repoKey).ledger, episode = assignmentEpisode(ledger, registered.assignmentId);
  assert.ok(episode);
  assert.equal(verifiedDeskEvents(ledger).filter(event => event.kind === 'episode-opened').length, 1);
  const child = f.tracker.forSeat({ ...f.creator, key: 'child', ledger });
  assert.deepEqual(child.episode, episode);
  assert.equal(existsSync(join(f.root, 'state/episodes')), false, 'managed inheritance adds no metadata write');
  const closeInput = { requestId: 'close', assignmentId: registered.assignmentId };
  assert.equal((await runAssignmentClose(ctx, closeInput, { store })).ok, true);
  assert.equal((await runAssignmentClose(ctx, { ...closeInput, requestId: 'close-again' }, { store })).ok, true);
  const closed = store.read(repoKey).ledger;
  const closes = verifiedDeskEvents(closed).filter(event => event.kind === 'episode-closed');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].payload.episodeId, episode.episodeId);
  assert.equal(closes[0].payload.outcome, 'unknown');
  const after = f.tracker.forSeat({ ...f.creator, key: 'next-episode', ledger: closed });
  assert.notEqual(after.episode.episodeId, episode.episodeId);
  assert.deepEqual(f.tracker.forSeat({ ...f.creator, key: 'next-peer', ledger: closed }).episode, after.episode);
  assert.equal((await runAssignmentRegister(ctx, input, deps)).assignmentId, registered.assignmentId);
  assert.equal(verifiedDeskEvents(store.read(repoKey).ledger).filter(event => event.kind === 'episode-opened').length, 1);
});


test('a torn append preserves evidence and omits context instead of reviving the previous episode', async t => {
  const f = await fixture(t);
  f.tracker.forSeat({ ...f.creator, key: 'old' });
  const before = readFileSync(f.state(), 'utf8');
  const broken = before + '{"body":{"new-episode":';
  writeFileSync(f.state(), broken);
  for (const mode of ['inherit', 'new']) {
    const result = createEpisodeTracker(f.root).forSeat({ ...f.creator, key: 'after-crash', mode });
    assert.equal(result.episode, null);
    assert.deepEqual(result.warnings, ['episode-state-corrupt']);
    assert.equal(readFileSync(f.state(), 'utf8'), broken);
  }
});

test('assignment preparation captures metadata outside the pure snapshot resolver', async t => {
  const f = await fixture(t);
  const labels = episodeLabels({ episodeId: episodeId('original'), rootAgentId: 'supervisor' });
  const creator = { ...f.creator, labels };
  const current = f.tracker.forSeat({ ...creator, mode: 'new', key: 'later-human-work' }).episode;
  const resolve = f.tracker.prepareAssignment({ ...creator, key: 'register-child' });
  writeFileSync(f.state(), 'unavailable-after-prepare');
  const result = resolve(f.ledger);
  assert.deepEqual(result.episode, current, 'the resolver uses captured metadata and the supplied verified ledger');
  assert.deepEqual(result.warnings, []);
});

test('managed bootstrap pins the registered episode and metadata remains advisory during native verification', async t => {
  const d = await realDesk(t, { transformSnapshot: result => ({ ...result, agent: { ...result.agent,
    labels: Object.fromEntries(Object.entries(result.agent.labels).filter(([key]) => !['slp.role', 'slp.episode-id'].includes(key))) } }) });
  const tracker = createEpisodeTracker(d.deps.scratch.stableRoot);
  const registered = await runAssignmentRegister(d.ctx,
    { requestId: 'episode-assignment', authorityRef: 'human:grant', objective: null },
    { store: d.store, episode: key => tracker.prepareAssignment({ agentId: d.ctx.row.agentId, labels: {}, key }) });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const assignmentId = registered.assignmentId, taskId = 'episode-task';
  const defined = await d.taskCommand({ operation: 'define', requestId: 'define-episode-task', assignmentId, taskId,
    expectedLedgerRevision: d.ledger().revision, expectedBriefRevision: 0, expectedOwnershipRevision: 0,
    expectedTaskRevision: 0, task: taskSpec() });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  d.deps.runtimeSha = 'a'.repeat(64);
  const input = bootstrapInput({ requestId: 'bootstrap-episode-task', assignmentId, taskId,
    expectedLedgerRevision: d.ledger().revision, expectedTaskRevision: latestTask(d.ledger(), assignmentId, taskId).revision,
    placement: { kind: 'shared-checkout', cwd: d.w.repo, baseRef: d.w.head } });
  const out = await runTaskDispatch(d.ctx, input, d.deps);
  assert.equal(out.state, 'bound', JSON.stringify(out));
  const labels = d.host.calls.create[0].labels;
  assert.deepEqual({ episodeId: labels['slp.episode-id'], rootAgentId: labels['slp.episode-root'] },
    assignmentEpisode(d.ledger(), assignmentId));
  assert.equal(labels['slp.role'], 'peer');
  assert.equal(labels['slp.runtime-sha'], 'a'.repeat(64));
  const intent = d.ledger().taskEntries.find(row => row.kind === 'action' && row.actionKind === 'create');
  assert.deepEqual({ ...intent.body.labels, 'slp.create-action': intent.actionId }, labels);
  const replay = await runTaskDispatch(d.ctx, input, d.deps);
  assert.equal(replay.perform, false);
  assert.equal(d.host.calls.create.length, 1);
});
