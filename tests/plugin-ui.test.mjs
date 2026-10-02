// Coverage for the pure view-state helpers in plugin/client/manager-state.ts
// (imported directly — no react), plus an esbuild check that the client entry
// bundles cleanly against host externals with no server-only or node code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { buildSync } from 'esbuild';
import {
  DISABLE_REMOVE_NOTICE,
  EXCLUSIVE_WINDOW_NOTICE,
  RESTORATION_NOTICE,
  RETAINED_RUNTIME_NOTICE,
  STATUS_POLL_MS,
  activationKind,
  activationLabel,
  applyFamilyChange,
  applySettingChange,
  applyPatch,
  buildPeerPool,
  buildPeerSeat,
  buildRoleChoice,
  conflictLine,
  conflictLines,
  createTargetViews,
  emptyTargetView,
  errorMessage,
  familyHint,
  isDaemonHome,
  isOperationId,
  liveAcceptanceLabel,
  newOperationId,
  operationPending,
  operationRows,
  peerPoolDiffers,
  peerPoolEquals,
  peerPoolForm,
  peerSeatFromArchetype,
  customSeatCopy,
  samePeerPoolForm,
  pollDelayAfterStart,
  pollDelayAfterStatus,
  reconcileProblem,
  recoverPendingStart,
  familyFromProviderId,
  thinkingOptionsFor,
  roleChoiceEquals,
  routingChoiceDiffers,
  routingDiverges,
  startPatch,
  shortenSha,
  visibleConflicts,
  stateHint,
  statusRows,
  targetKey,
} from '../plugin/client/manager-state.ts';
import { PEER_SEAT_ARCHETYPES } from '../plugin/shared/archetypes.ts';
import { CatalogInput, PeerPoolOption } from '../plugin/shared/contracts.ts';
import {
  pickSnapshotEntry,
  snapshotEntryCatalog,
} from '../plugin/shared/snapshot-catalog.ts';
import { validateCatalog } from '../plugin/server/runtime/cli/routing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const OP_ID = '11111111-1111-4111-8111-111111111111';

const operation = (over = {}) => ({
  operationId: OP_ID,
  kind: 'activate',
  phase: 'verifying-runtime',
  outcome: 'pending',
  startedAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:05Z',
  completedAt: null,
  ...over,
});

const family = (name, over = {}) => ({
  family: name,
  availability: 'available',
  binaryPath: `/usr/bin/${name}`,
  observedVersion: '1.0.0',
  ...over,
});

const statusView = (over = {}) => ({
  schemaVersion: 1,
  target: { hostId: 'h1', daemonHome: '/h' },
  state: 'ACTIVE',
  embeddedCandidateSha256: SHA,
  binding: {
    bindingSha256: SHA_B,
    candidateSha256: SHA,
    payloadSha256: SHA,
    launchSetSha256: SHA,
    runtimePath: '/rt/x',
    nodePath: '/usr/bin/node',
    baseline: 'fresh',
  },
  families: ['codex', 'pi', 'devin', 'claude'].map(name => family(name)),
  operation: null,
  conflicts: [],
  verifiedAt: '2026-09-18T00:00:10Z',
  retainedRuntimeCount: 2,
  communicationLanguage: 'Vietnamese',
  liveAcceptance: 'not-established-by-this-rpc',
  ...over,
});

const startResult = (over = {}) => ({
  schemaVersion: 1,
  accepted: true,
  operation: operation(),
  conflicts: [],
  pollAfterMs: 1000,
  ...over,
});

// --- inputs -----------------------------------------------------------------

test('isDaemonHome enforces the AbsolutePath contract', () => {
  assert.equal(isDaemonHome('/home/u/.paseo'), true);
  assert.equal(isDaemonHome('C:\\daemons\\paseo'), true);
  assert.equal(isDaemonHome('\\\\srv\\share'), true);
  assert.equal(isDaemonHome('relative/path'), false);
  assert.equal(isDaemonHome(''), false);
  assert.equal(isDaemonHome('/bad\0path'), false);
  assert.equal(isOperationId(OP_ID), true);
  assert.equal(isOperationId('not-a-uuid'), false);
  assert.equal(isOperationId(newOperationId()), true);
});

// --- per-target isolation ---------------------------------------------------

test('view state is isolated per (hostId, daemonHome) pair', () => {
  const store = createTargetViews();
  const a = { hostId: 'h1', daemonHome: '/a' };
  const b = { hostId: 'h1', daemonHome: '/b' };
  const c = { hostId: 'h2', daemonHome: '/a' };
  assert.notEqual(targetKey(a), targetKey(b));
  assert.notEqual(targetKey(a), targetKey(c));
  const viewA = { ...emptyTargetView(), notice: 'a-only' };
  store.set(a, viewA);
  assert.equal(store.get(a).notice, 'a-only');
  assert.equal(store.get(b), undefined);
  assert.equal(store.get(c), undefined);
});

test('applyPatch stores under the request target and repaints only when displayed', () => {
  const store = createTargetViews();
  const a = { hostId: 'h1', daemonHome: '/a' };
  const b = { hostId: 'h1', daemonHome: '/b' };
  // Patch for A while A is displayed: stored and repainted.
  const shown = applyPatch(store, a, { notice: 'for-a' }, targetKey(a));
  assert.equal(shown.repaint, true);
  assert.equal(shown.view.notice, 'for-a');
  assert.equal(store.get(a).notice, 'for-a');
  // A stale RPC for A landing after the administrator moved to B: the store
  // still updates under A, but nothing repaints and the merge never touches
  // B's view or mixes B's fields into A's entry.
  const stale = applyPatch(store, a, { lastError: 'late' }, targetKey(b));
  assert.equal(stale.repaint, false);
  assert.equal(stale.view.notice, 'for-a'); // merged onto A's stored view, not the screen's
  assert.equal(stale.view.lastError, 'late');
  assert.equal(store.get(a).lastError, 'late');
  assert.equal(store.get(b), undefined);
  // And when no target is displayed at all, store still records the result.
  const none = applyPatch(store, b, { busy: true }, null);
  assert.equal(none.repaint, false);
  assert.equal(store.get(b).busy, true);
});

// --- polling ----------------------------------------------------------------

test('start response drives the first poll; terminal outcomes stop it', () => {
  assert.equal(pollDelayAfterStart(startResult()), 1000);
  assert.equal(pollDelayAfterStart(startResult({ pollAfterMs: 250 })), 250);
  for (const outcome of ['succeeded', 'failed', 'conflict']) {
    assert.equal(pollDelayAfterStart(startResult({ operation: operation({ outcome }) })), 0);
  }
  assert.equal(pollDelayAfterStart(startResult({ accepted: false, operation: null })), 0);
  assert.equal(operationPending(operation()), true);
  assert.equal(operationPending(operation({ outcome: 'succeeded' })), false);
  assert.equal(operationPending(null), false);
});

test('status responses poll every STATUS_POLL_MS and stop at terminal', () => {
  assert.equal(STATUS_POLL_MS, 1000);
  assert.equal(pollDelayAfterStatus(statusView({ operation: operation() })), 1000);
  for (const outcome of ['succeeded', 'failed', 'conflict']) {
    assert.equal(pollDelayAfterStatus(statusView({ operation: operation({ outcome }) })), 0);
  }
  assert.equal(pollDelayAfterStatus(statusView({ operation: null })), 0);
});

test('a dropped start response polls, retries only when absent, never hijacks', () => {
  // Operation absent -> the identical request may be retried.
  assert.deepEqual(recoverPendingStart(OP_ID, statusView({ operation: null })), { kind: 'retry' });
  // Same operation pending -> keep polling; the request already landed.
  assert.deepEqual(recoverPendingStart(OP_ID, statusView({ operation: operation() })), { kind: 'poll' });
  // Same operation terminal -> settled, no retry needed.
  const settled = recoverPendingStart(OP_ID, statusView({ operation: operation({ outcome: 'succeeded', completedAt: '2026-09-18T00:00:09Z' }) }));
  assert.equal(settled.kind, 'settled');
  assert.equal(settled.operation.outcome, 'succeeded');
  // A different pending operation -> unresolved; never adopt a foreign op.
  const foreign = recoverPendingStart(OP_ID, statusView({ operation: operation({ operationId: '22222222-2222-4222-8222-222222222222' }) }));
  assert.equal(foreign.kind, 'unresolved');
});

test('startPatch surfaces conflicts whether accepted or not, and they persist across refresh', () => {
  const conflict = { code: 'OWNERSHIP_MISMATCH', message: 'drifted entry', path: '/providers/x', expectedSha256: null, actualSha256: null };
  // accepted + conflicts → reportedConflicts populated, no lastError.
  const accepted = startPatch(startResult({ accepted: true, conflicts: [conflict] }));
  assert.deepEqual(accepted.reportedConflicts, [conflict]);
  assert.equal(accepted.lastError, undefined);
  assert.equal(accepted.busy, false);
  assert.deepEqual(accepted.pending, { operationId: OP_ID, nextPollMs: 1000 });
  // not-accepted + conflicts → visible AND flagged as an error.
  const rejected = startPatch(startResult({ accepted: false, operation: null, conflicts: [conflict] }));
  assert.deepEqual(rejected.reportedConflicts, [conflict]);
  assert.match(rejected.lastError, /OWNERSHIP_MISMATCH/);
  assert.equal(rejected.pending, null);
  // accepted + no conflicts → clean.
  const clean = startPatch(startResult());
  assert.equal(clean.reportedConflicts, null);
  // terminal operation → no pending poll.
  assert.equal(startPatch(startResult({ operation: operation({ outcome: 'succeeded' }) })).pending, null);
  // A follow-up status refresh must not clear a conflict report the operator
  // has not seen — reportedConflicts survives unrelated patches.
  const store = createTargetViews();
  const target = { hostId: 'h1', daemonHome: '/h' };
  applyPatch(store, target, { reportedConflicts: [conflict] }, targetKey(target));
  const after = applyPatch(store, target, { status: statusView(), lastError: null }, targetKey(target));
  assert.deepEqual(after.view.reportedConflicts, [conflict]);
});

test('visibleConflicts merges start, operation-status, and status conflicts — deduped', () => {
  const c1 = { code: 'OWNERSHIP_DRIFT', message: 'drifted entry', path: '/p/1', expectedSha256: null, actualSha256: null };
  const c2 = { code: 'RUNTIME_INTEGRITY', message: 'hash mismatch', path: '/p/2', expectedSha256: null, actualSha256: null };
  const c3 = { code: 'RAW_LIVE_DIVERGENCE', message: 'live differs', path: null, expectedSha256: null, actualSha256: null };
  // (a) status(opId) carrying op-level conflicts → rendered.
  const withOp = { ...emptyTargetView(), status: statusView({ operation: operation({ conflicts: [c1] }) }) };
  assert.deepEqual(visibleConflicts(withOp), [c1]);
  // (b) a succeeded op carrying conflicts stays visible — not swallowed.
  const succeeded = { ...emptyTargetView(), status: statusView({ operation: operation({ outcome: 'succeeded', completedAt: '2026-09-18T00:00:09Z', conflicts: [c1] }) }) };
  assert.deepEqual(visibleConflicts(succeeded), [c1]);
  // (c) no conflicts anywhere → clean.
  const cleanView = { ...emptyTargetView(), status: statusView({ operation: operation() }) };
  assert.deepEqual(visibleConflicts(cleanView), []);
  // (d) the same conflict arriving via start AND status dedupes; distinct merge.
  const both = {
    ...emptyTargetView(),
    reportedConflicts: [c1],
    status: statusView({ operation: operation({ conflicts: [c1, c2] }), conflicts: [c2, c3] }),
  };
  assert.deepEqual(visibleConflicts(both), [c1, c2, c3]);
  // (e) conflicts live on the target's own view — another target's shows none.
  const other = { ...emptyTargetView(), status: statusView() };
  assert.deepEqual(visibleConflicts(other), []);
});

// --- bounded formatting -----------------------------------------------------

test('conflict rendering truncates messages and bounds the visible list', () => {
  const conflicts = Array.from({ length: 70 }, (_, i) => ({
    code: 'OWNERSHIP_MISMATCH',
    message: `conflict ${i} ${'x'.repeat(400)}`,
    path: `/providers/${i}`,
    expectedSha256: SHA,
    actualSha256: SHA_B,
  }));
  const wide = conflictLines(conflicts);
  assert.equal(wide.length, 9); // 8 shown + overflow marker
  assert.match(wide[8], /…and 62 more conflicts$/);
  const compact = conflictLines(conflicts, 4);
  assert.equal(compact.length, 5);
  assert.match(compact[4], /…and 66 more conflicts$/);
  // code + truncated message + path/expected/actual detail stays bounded.
  assert.ok(wide.every(line => line.length < 360));
  const line = conflictLine(conflicts[0]);
  assert.match(line, /^OWNERSHIP_MISMATCH: /);
  assert.match(line, /expected a{12}…/);
});

test('error payloads are bounded regardless of input size', () => {
  const huge = 'e'.repeat(5000);
  assert.ok(errorMessage(new Error(huge)).length <= 501);
  assert.ok(errorMessage(huge).length <= 501);
  assert.equal(errorMessage(new Error('short')), 'short');
});

// --- status rows: compact vs wide -------------------------------------------

test('wide status rows expose binding detail; compact omits it', () => {
  const view = statusView();
  const wide = statusRows(view);
  const compact = statusRows(view, { compact: true });
  const labels = rows => rows.map(row => row.label);
  assert.deepEqual(labels(wide), [
    'State', 'Daemon home (canonical)', 'Embedded candidate', 'Active candidate', 'Binding',
    'Runtime', 'Node', 'Launch set', 'Payload', 'Baseline',
    'Retained runtimes', 'Communication language', 'Last verified', 'Live acceptance',
  ]);
  assert.deepEqual(labels(compact), [
    'State', 'Daemon home (canonical)', 'Embedded candidate', 'Active candidate', 'Binding',
    'Retained runtimes', 'Communication language', 'Last verified', 'Live acceptance',
  ]);
  const wideRow = label => wide.find(row => row.label === label).value;
  const compactRow = label => compact.find(row => row.label === label).value;
  // §4: the server-canonicalized home is shown in both layouts — an admin who
  // typed a symlinked path sees the real target before mutating.
  assert.equal(wideRow('Daemon home (canonical)'), '/h');
  assert.equal(compactRow('Daemon home (canonical)'), '/h');
  assert.equal(wideRow('Runtime'), '/rt/x');
  assert.equal(wideRow('Embedded candidate'), `${SHA.slice(0, 12)}…`);
  assert.equal(compactRow('Embedded candidate'), `${SHA.slice(0, 8)}…`);
  assert.equal(wideRow('Retained runtimes'), '2');
  assert.equal(wideRow('Communication language'), 'Vietnamese');
  assert.equal(
    statusRows(statusView({ communicationLanguage: null })).find(r => r.label === 'Communication language').value,
    'unset (model default)',
  );
  assert.equal(wideRow('Last verified'), '2026-09-18T00:00:10Z');
  assert.equal(wideRow('Live acceptance'), 'not established by this RPC');
  // §10: render the literal contract value, never a stronger claim.
  assert.equal(liveAcceptanceLabel('not-established-by-this-rpc'), 'not established by this RPC');
  assert.equal(statusRows(statusView({ binding: null, verifiedAt: null })).find(r => r.label === 'Active candidate').value, 'none');
  assert.equal(statusRows(statusView({ verifiedAt: null })).find(r => r.label === 'Last verified').value, 'never');
});

test('state hints and operation rows reflect pending vs settled', () => {
  assert.match(stateHint('RECOVERY_REQUIRED'), /Reconcile/);
  assert.match(stateHint('ACTIVATING'), /in progress/);
  assert.equal(stateHint('ACTIVE'), '');
  const rows = operationRows(operation());
  assert.deepEqual(rows.map(r => r.label), ['Operation', 'Kind', 'Phase', 'Outcome', 'Started', 'Updated']);
  assert.ok(operationRows(operation({ outcome: 'succeeded', completedAt: '2026-09-18T00:00:09Z' })).some(r => r.label === 'Completed'));
});

test('family hints distinguish availability states', () => {
  assert.match(familyHint(family('codex')), /available — \/usr\/bin\/codex \(1\.0\.0\)/);
  assert.match(familyHint(family('codex'), { compact: true }), /available \(1\.0\.0\)/);
  assert.ok(!familyHint(family('codex'), { compact: true }).includes('/usr/bin'));
  assert.equal(familyHint(family('codex', { availability: 'unavailable' })), 'unavailable');
  assert.equal(familyHint(family('codex', { availability: 'unresolved' })), 'unresolved');
});

// --- action derivation --------------------------------------------------------

test('activate label distinguishes first bind, re-verify, and rebind', () => {
  assert.equal(activationKind(null), 'activate');
  assert.equal(activationLabel(null), 'Activate');
  const bound = statusView();
  assert.equal(activationKind(bound), 'reverify');
  assert.equal(activationLabel(bound), 'Re-verify binding');
  const diverged = statusView({ binding: { ...bound.binding, candidateSha256: SHA_B } });
  assert.equal(activationKind(diverged), 'rebind');
  assert.equal(activationLabel(diverged), 'Rebind');
});

test('reconcile complete/restore-before require the interrupted operation id', () => {
  assert.equal(reconcileProblem('inspect', ''), null);
  assert.match(reconcileProblem('complete', ''), /requires the interrupted operation ID/);
  assert.match(reconcileProblem('restore-before', 'not-a-uuid'), /requires the interrupted operation ID/);
  assert.equal(reconcileProblem('complete', OP_ID), null);
});

test('sha shortening and status helpers handle nulls', () => {
  assert.equal(shortenSha(null), 'none');
  assert.equal(shortenSha(SHA), `${SHA.slice(0, 12)}…`);
  assert.equal(shortenSha('short'), 'short');
});

test('routingDiverges compares the stored routing against the live binding', () => {
  const profiles = (supOver = {}, leadOver = {}) => [
    { id: 'slp-supervisor', provider: 'slp-pi-supervisor', model: 'pi-model', modeId: null, thinkingOptionId: null, featureValues: null, ...supOver },
    { id: 'slp-lead', provider: 'slp-devin-lead', model: null, modeId: 'bypass', thinkingOptionId: null, featureValues: { auto_accept: true }, ...leadOver },
  ];
  const routing = {
    schemaVersion: 1,
    supervisor: { family: 'pi', model: 'pi-model' },
    lead: { family: 'devin', modeId: 'bypass', featureValues: { auto_accept: true } },
  };

  // No routing → never diverged (legacy generation).
  assert.equal(routingDiverges(null, profiles()), false);
  // Matching provider + set fields → no divergence.
  assert.equal(routingDiverges(routing, profiles()), false);
  // Feature-value key order is not divergence.
  assert.equal(routingDiverges(routing, profiles({}, { featureValues: { auto_accept: true } })), false);
  // A different bound provider, model, or feature value diverges.
  assert.equal(routingDiverges(routing, profiles({ provider: 'slp-codex-supervisor' })), true);
  assert.equal(routingDiverges(routing, profiles({ model: 'other-model' })), true);
  assert.equal(routingDiverges(routing, profiles({}, { featureValues: { auto_accept: false } })), true);
  assert.equal(routingDiverges(routing, profiles({}, { modeId: 'plan' })), true);
  // Absent optional routing fields can never diverge — live values stay.
  const sparse = { schemaVersion: 1, supervisor: { family: 'pi' }, lead: { family: 'devin' } };
  assert.equal(routingDiverges(sparse, profiles({ model: 'anything' })), false);
  // No live profiles yet → nothing to compare.
  assert.equal(routingDiverges(routing, []), false);
});

test('the Save diff-gate enables only when the form-built choice differs from stored', () => {
  // buildRoleChoice is THE build path — the gate and saveRouting share it,
  // so the matrix below exercises exactly what a press would write.
  const form = (over = {}) => ({
    family: 'pi',
    model: 'pi-model',
    modeId: '',
    thinkingOptionId: '',
    features: '',
    feature: {},
    ...over,
  });
  const stored = { family: 'pi', model: 'pi-model' };
  const build = (f, s, defs = []) => buildRoleChoice('supervisor', f, s, defs);

  // Bound + form == stored → equal → Save disabled (a save would be a no-op).
  const equal = build(form(), stored);
  assert.equal(routingChoiceDiffers(equal, stored), false);
  assert.equal(roleChoiceEquals(equal.choice, stored), true);

  // Bound + stored=null + live-prefilled form → differs → enabled — the
  // reported bug: the shown config is not yet persisted.
  assert.equal(routingChoiceDiffers(build(form(), undefined), undefined), true);
  assert.equal(roleChoiceEquals(build(form(), undefined).choice, null), false);

  // An edit differs; editing back to the stored values compares equal again.
  assert.equal(routingChoiceDiffers(build(form({ model: 'other' }), stored), stored), true);
  assert.equal(routingChoiceDiffers(build(form({ model: ' pi-model ' }), stored), stored), false);

  // Post-save auto-disable: the server returns the parsed routing unchanged,
  // so storing the built choice makes the next comparison equal.
  const saved = build(form(), stored).choice;
  assert.equal(routingChoiceDiffers(build(form(), saved), saved), false);

  // Malformed feature JSON builds an error, which counts as differing — the
  // press reaches the save path, which surfaces the build error.
  const bad = build(form({ features: '{nope' }), stored);
  assert.ok('error' in bad);
  assert.match(bad.error, /not valid JSON/);
  assert.equal(routingChoiceDiffers(bad, stored), true);

  // featureValues canonicalization: key order never differs, but {} vs
  // absent does — an explicit clear is a real change.
  const withFeatures = { ...stored, featureValues: { a: 1, b: 2 } };
  assert.equal(
    routingChoiceDiffers(build(form({ features: '{"b":2,"a":1}' }), withFeatures), withFeatures),
    false,
  );
  assert.equal(routingChoiceDiffers(build(form({ features: '{}' }), stored), stored), true);

  // Declared controls merge over the raw JSON base: an undeclared key is
  // preserved and an empty control drops the declared key.
  const toggleDefs = [{ type: 'toggle', id: 'auto_accept', label: 'Auto', value: false }];
  const merged = build(
    form({ features: '{"auto_accept":true,"x":1}', feature: { auto_accept: 'false' } }),
    stored,
    toggleDefs,
  );
  assert.deepEqual(merged.choice.featureValues, { auto_accept: false, x: 1 });
});

test('thinkingOptionsFor resolves the picked model or falls back to free text', () => {
  const catalogResult = (models, over = {}) => ({
    schemaVersion: 1, models, modes: [], features: [], error: null, ...over,
  });
  const options = [
    { id: 'low', label: 'low' },
    { id: 'medium', label: 'medium', isDefault: true },
  ];
  // Declared options + declared default pass through.
  assert.deepEqual(
    thinkingOptionsFor(
      catalogResult([{ id: 'gpt-5.6', label: 'GPT', thinkingOptions: options, defaultThinkingOptionId: 'medium' }]),
      'gpt-5.6',
    ),
    { options, defaultId: 'medium' },
  );
  // The model id trims like featureKeyFor's catalog key.
  assert.deepEqual(
    thinkingOptionsFor(catalogResult([{ id: 'm1', label: 'M1' }]), '  m1  '),
    { options: [], defaultId: null },
  );
  // A model that declares no options (devin bakes thinking into model
  // ids) resolves to an honest empty set — not the free-text fallback.
  assert.deepEqual(
    thinkingOptionsFor(catalogResult([{ id: 'swe-2-max', label: 'SWE' }]), 'swe-2-max'),
    { options: [], defaultId: null },
  );
  // Unresolvable → null → free text: no catalog, an errored/empty
  // catalog, no picked model, or a model the catalog doesn't list.
  assert.equal(thinkingOptionsFor(null, 'm1'), null);
  assert.equal(thinkingOptionsFor(catalogResult([], { error: 'Catalog query failed' }), 'm1'), null);
  assert.equal(thinkingOptionsFor(catalogResult([{ id: 'm1', label: 'M1' }]), ''), null);
  assert.equal(thinkingOptionsFor(catalogResult([{ id: 'm1', label: 'M1' }]), 'other'), null);
});

test('applyFamilyChange resets dependents against the new family catalog', () => {
  // Mirrors the live probe: devin has modes but no thinking options, codex
  // has modes + thinking options, pi declares zero modes.
  const catalogResult = (over = {}) => ({
    schemaVersion: 1, models: [], modes: [], features: [], error: null, ...over,
  });
  const devinCatalog = catalogResult({
    models: [{ id: 'swe-2-max', label: 'SWE Max' }, { id: 'swe-2-medium', label: 'SWE Medium' }],
    modes: [{ id: 'bypass', label: 'Bypass' }, { id: 'plan', label: 'Plan' }],
  });
  const codexCatalog = catalogResult({
    models: [{
      id: 'gpt-5.6',
      label: 'GPT',
      thinkingOptions: [{ id: 'low', label: 'low' }, { id: 'medium', label: 'medium' }],
      defaultThinkingOptionId: 'medium',
    }],
    modes: [{ id: 'auto', label: 'Auto' }, { id: 'full-access', label: 'Full access' }],
  });
  const piCatalog = catalogResult({
    models: [{ id: 'pi-model', label: 'Pi' }],
    modes: [],
  });
  const form = (over = {}) => ({
    family: 'devin',
    model: 'swe-2-max',
    modeId: 'bypass',
    thinkingOptionId: '',
    features: '{"auto_accept":true}',
    feature: { auto_accept: 'true' },
    ...over,
  });

  // Foreign picks clear: swe-2-max is not a codex model and bypass is not a
  // codex mode; feature values always clear (per-provider ids — auto_accept
  // must not bleed into a codex profile, raw-JSON keys included).
  const switched = applyFamilyChange(form(), 'codex', codexCatalog);
  assert.deepEqual(switched, {
    family: 'codex', model: '', modeId: '', thinkingOptionId: '', features: '', feature: {},
  });

  // A model the new catalog lists keeps, and its declared thinking option
  // keeps with it — the defect case: an unlisted thinking id must NOT
  // survive to drop the row into free text.
  const kept = applyFamilyChange(
    form({ model: 'gpt-5.6', modeId: 'auto', thinkingOptionId: 'medium' }),
    'codex',
    codexCatalog,
  );
  assert.equal(kept.model, 'gpt-5.6');
  assert.equal(kept.modeId, 'auto');
  assert.equal(kept.thinkingOptionId, 'medium');
  assert.equal(kept.features, '');
  assert.deepEqual(kept.feature, {});
  const staleThinking = applyFamilyChange(
    form({ model: 'gpt-5.6', thinkingOptionId: 'ultra' }),
    'codex',
    codexCatalog,
  );
  assert.equal(staleThinking.model, 'gpt-5.6');
  assert.equal(staleThinking.thinkingOptionId, '');

  // pi edge: pi declares zero modes — switching to it always clears modeId.
  const toPi = applyFamilyChange(form({ model: 'pi-model' }), 'pi', piCatalog);
  assert.equal(toPi.model, 'pi-model');
  assert.equal(toPi.modeId, '');

  // Catalog not loaded (undefined) or errored (empty lists) → nothing keeps.
  const notLoaded = applyFamilyChange(form({ model: 'pi-model' }), 'pi', undefined);
  assert.equal(notLoaded.model, '');
  const errored = applyFamilyChange(
    form(),
    'codex',
    catalogResult({ error: 'Catalog query failed' }),
  );
  assert.equal(errored.model, '');
  assert.equal(errored.modeId, '');

  // Same-family re-pick keeps what the catalog declares — features still
  // clear (the rule is unconditional).
  const same = applyFamilyChange(form(), 'devin', devinCatalog);
  assert.equal(same.model, 'swe-2-max');
  assert.equal(same.modeId, 'bypass');
  assert.equal(same.features, '');
  assert.deepEqual(same.feature, {});
});

test('applySettingChange clears feature values on a model OR mode change', () => {
  // Feature defs are keyed family|model|modeId — either input changing
  // invalidates values authored under the previous key.
  const form = () => ({
    family: 'devin',
    model: 'swe-2-max',
    modeId: 'bypass',
    thinkingOptionId: '',
    features: '{"auto_accept":true}',
    feature: { auto_accept: 'true' },
  });

  const byModel = applySettingChange(form(), 'model', 'swe-2-medium');
  assert.equal(byModel.model, 'swe-2-medium');
  assert.equal(byModel.modeId, 'bypass');
  assert.equal(byModel.features, '');
  assert.deepEqual(byModel.feature, {});

  const byMode = applySettingChange(form(), 'modeId', 'plan');
  assert.equal(byMode.model, 'swe-2-max');
  assert.equal(byMode.modeId, 'plan');
  assert.equal(byMode.features, '');
  assert.deepEqual(byMode.feature, {});

  // A no-change pick returns the SAME form object — a redundant pick never
  // clears authored values.
  const unchanged = form();
  assert.equal(applySettingChange(unchanged, 'model', 'swe-2-max'), unchanged);
  assert.equal(applySettingChange(unchanged, 'modeId', 'bypass'), unchanged);
});

test('applySettingChange clears a stored thinkingOptionId only on a resolved 0-declare model', () => {
  // Host parity (wave 9): a model declaring ZERO thinking options renders
  // no control, so a stored ID could never be surfaced or corrected — the
  // model-switch path clears it before it can reach Save.
  const catalogResult = (models, over = {}) => ({
    schemaVersion: 1, models, modes: [], features: [], error: null, ...over,
  });
  const devinCatalog = catalogResult([
    { id: 'swe-2-max', label: 'SWE Max' },
    { id: 'swe-2-medium', label: 'SWE Medium' },
  ]);
  const codexCatalog = catalogResult([
    {
      id: 'gpt-5.6',
      label: 'GPT',
      thinkingOptions: [{ id: 'low', label: 'low' }, { id: 'medium', label: 'medium' }],
      defaultThinkingOptionId: 'medium',
    },
    {
      id: 'gpt-5.6-mini',
      label: 'GPT Mini',
      thinkingOptions: [{ id: 'low', label: 'low' }],
    },
  ]);
  const form = (over = {}) => ({
    family: 'codex',
    model: 'gpt-5.6',
    modeId: 'auto',
    thinkingOptionId: 'medium',
    features: '',
    feature: {},
    ...over,
  });

  // Switching to a resolved 0-declare model clears the stored ID.
  const toZero = applySettingChange(
    form({ family: 'devin', model: 'swe-2-max', thinkingOptionId: 'high' }),
    'model',
    'swe-2-medium',
    devinCatalog,
  );
  assert.equal(toZero.model, 'swe-2-medium');
  assert.equal(toZero.thinkingOptionId, '', 'stored ID must clear on a 0-declare model');

  // Switching to a model declaring a DIFFERENT option set keeps the ID —
  // the "(stored)" chip stays visible and clearable in the picker.
  const toDeclared = applySettingChange(
    form({ thinkingOptionId: 'ultra' }),
    'model',
    'gpt-5.6-mini',
    codexCatalog,
  );
  assert.equal(toDeclared.model, 'gpt-5.6-mini');
  assert.equal(toDeclared.thinkingOptionId, 'ultra', 'declaring model keeps the stored ID');

  // Unresolved targets keep the ID: catalog absent, errored, or the new
  // model unlisted — the free-text fallback owns those paths.
  for (const catalog of [undefined, catalogResult([], { error: 'Catalog query failed' })]) {
    const kept = applySettingChange(form(), 'model', 'unlisted-model', catalog);
    assert.equal(kept.thinkingOptionId, 'medium', 'unresolved model must keep the stored ID');
  }
  const unlisted = applySettingChange(form(), 'model', 'unlisted-model', codexCatalog);
  assert.equal(unlisted.thinkingOptionId, 'medium', 'unlisted model keeps the stored ID');

  // A mode switch never touches thinking.
  const byMode = applySettingChange(
    form({ family: 'devin', model: 'swe-2-max', thinkingOptionId: 'high' }),
    'modeId',
    'plan',
    devinCatalog,
  );
  assert.equal(byMode.thinkingOptionId, 'high', 'mode switch keeps thinking');
});

test('familyFromProviderId parses managed provider ids for form prefill', () => {
  assert.equal(familyFromProviderId('slp-pi-supervisor'), 'pi');
  assert.equal(familyFromProviderId('slp-claude-peer'), 'claude');
  assert.equal(familyFromProviderId('slp-devin-lead'), 'devin');
  assert.equal(familyFromProviderId('codex'), null);
  assert.equal(familyFromProviderId('slp-gpt-lead'), null);
  assert.equal(familyFromProviderId('slp-pi'), null);
  assert.equal(familyFromProviderId(null), null);
});

// --- disclosures --------------------------------------------------------------

test('disclosures carry the mandated meanings verbatim', () => {
  assert.match(EXCLUSIVE_WINDOW_NOTICE, /exclusive administrative edit window/);
  assert.match(EXCLUSIVE_WINDOW_NOTICE, /no compare-and-swap/);
  assert.match(RESTORATION_NOTICE, /semantics, not original JSON bytes/);
  assert.match(RESTORATION_NOTICE, /never patches mcp\.enabled/);
  assert.match(RETAINED_RUNTIME_NOTICE, /retains every runtime/);
  assert.match(DISABLE_REMOVE_NOTICE, /not SLP deactivation/);
  assert.match(DISABLE_REMOVE_NOTICE, /Deactivate before removing/);
});

// --- client bundle check -------------------------------------------------------

// Built once per test file — both the bundle-shape test and the routing-UI
// structural test consume the same output.
const clientBundle = (() => {
  let text;
  return () => {
    if (text === undefined) {
      const result = buildSync({
        entryPoints: [join(root, 'plugin/index.client.tsx')],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        logLevel: 'silent',
        // Mirrors the host compiler's client externals (compiler.js): the plugin
        // SDK specifiers plus the host-provided UI runtime.
        external: [
          '@getpaseo/plugin*',
          'zod',
          'react',
          'react/jsx-runtime',
          'react-native',
          '@tanstack/react-query',
        ],
      });
      text = result.outputFiles[0].text;
    }
    return text;
  };
})();

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

test('client entry bundles against host externals with no server-only or node code', () => {
  const bundle = clientBundle();
  assert.ok(bundle.length > 0);
  // The surface and shared contracts were actually inlined.
  assert.ok(bundle.includes('Daemon home'));
  assert.ok(bundle.includes('exclusiveAdministrativeWindow'));
  // Host externals stay external.
  assert.match(bundle, /from\s*"react"/);
  assert.match(bundle, /from\s*"react-native"/);
  assert.match(bundle, /from\s*"zod"/);
  assert.match(bundle, /from\s*"@getpaseo\/plugin\/client"/);
  // No node builtins or server modules leaked into the client bundle.
  // ("node:" also appears as an object key in the binding schema — match imports.)
  assert.ok(!/from\s*["']node:/.test(bundle));
  assert.ok(!/import\s*["']node:/.test(bundle));
  assert.ok(!/require\(/.test(bundle));
  for (const banned of ['fs', 'path', 'os', 'child_process', 'net', 'crypto']) {
    assert.ok(
      !new RegExp(`from\\s*["'](?:node:)?${banned}["']`).test(bundle),
      `client bundle imports ${banned}`,
    );
  }
  assert.ok(!/index\.server|callPluginRpc/.test(bundle));
});

test('the routing UI is one card with one save and one divergence warning', () => {
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');
  // The card's state/handlers AND its JSX live in the routing card module
  // (wave 11 S3b/D ownership + S3c render extraction) — pins on card
  // internals read that file; shell pins keep reading ManagerSurface.
  const routingCard = readFileSync(join(root, 'plugin/client/cards/routing.tsx'), 'utf8');
  const poolCard = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  const bundle = clientBundle();

  // One consolidated "Role profiles" card edits the full profile each role
  // binds; the old per-role card titles and the separate peer card are gone.
  // The "routing" metaphor is retired from the card title only — the stored
  // artifact keeps its role-routing file/RPC names.
  // The nav strip's "Role profiles" anchor label is the only other use.
  assert.equal(occurrences(routingCard, 'title="Role profiles"'), 1, 'exactly one Role profiles card title');
  assert.ok(occurrences(source, '"Role profiles"') + occurrences(routingCard, '"Role profiles"') <= 2, 'card title + nav label');
  assert.equal(occurrences(source, '"Role providers"'), 0);
  assert.equal(occurrences(source, '"Role routing"'), 0);
  assert.equal(occurrences(source, '"Supervisor routing"'), 0);
  assert.equal(occurrences(source, '"Lead routing"'), 0);
  assert.equal(occurrences(source, '"Peer routing"'), 0);
  assert.ok(bundle.includes('Role profiles'));
  assert.ok(!bundle.includes('Role routing'));

  // The "Agent profiles" card and its immediate-apply path are gone —
  // routing is the sole role→provider configurator; the activate RPC's
  // profiles/initialProfileFamily inputs stay for scripted use.
  assert.equal(occurrences(source, '"Agent profiles"'), 0, 'Agent profiles card removed');
  assert.equal(occurrences(bundle, '"Agent profiles"'), 0, 'Agent profiles card removed from bundle');
  assert.equal(occurrences(source, 'Apply profile changes'), 0);
  assert.equal(occurrences(bundle, 'Apply profile changes'), 0);
  assert.equal(occurrences(source, 'runApplyProfiles'), 0);
  assert.equal(occurrences(source, 'buildProfiles'), 0);
  assert.equal(occurrences(source, 'pref('), 0, 'profile prefs machinery gone');

  // One Save action — a single button label and a single dispatch site for
  // the one set-role-routing call that carries both roles. The label is
  // "Save" — the card context already names what is saved (spec §9).
  assert.equal(occurrences(source, '"Save routing"') + occurrences(routingCard, '"Save routing"'), 0, 'label shortened to Save');
  assert.equal(occurrences(routingCard, '"Save"'), 1, 'exactly one Save button');
  assert.equal(occurrences(routingCard, 'callSetRoleRouting('), 1, 'one set-role-routing call site');
  assert.equal(occurrences(routingCard, 'routing.save()'), 1, 'one save dispatch');

  // ONE build path: buildRoleChoice runs only inside the card's builds
  // object (two roles), and save consumes the same builds the gate
  // compares — never a second construction that could drift.
  assert.equal(occurrences(routingCard, 'buildRoleChoice('), 2, 'one shared build site, two roles');
  assert.equal(occurrences(routingCard, 'builds.'), 4, 'gate + save consume the same builds');

  // The divergence warning renders once on the card, not once per role.
  assert.equal(
    occurrences(routingCard, 'Stored role profiles differ from the live binding'),
    1,
    'exactly one divergence warning',
  );

  // The routing card carries the full RoleChoice surface: feature controls
  // keyed on the routing form's picks plus a thinking-option field. The Peer
  // pool seat editor deliberately mirrors the same picker patterns, so the
  // per-card counts scope to the Role profiles card region.
  const roleCard = routingCard.slice(
    routingCard.indexOf('title="Role profiles"'),
    routingCard.indexOf('</Card>', routingCard.indexOf('title="Role profiles"')),
  );
  assert.ok(
    routingCard.includes('const family = routingForm[role].family'),
    'feature defs fetch keys on the routing form',
  );
  assert.equal(occurrences(routingCard, 'featureDefsFor(role)'), 1, 'feature defs resolved once per role');
  assert.equal(
    occurrences(routingCard, 'featureDefsFor("'),
    2,
    'the shared build merges the same defs for both roles',
  );
  assert.equal(occurrences(roleCard, '"Feature values (JSON)"'), 1, 'JSON fallback field present');
  assert.ok(roleCard.includes('featureDefs.error'), 'feature fetch error surfaced in the fallback');
  assert.ok(roleCard.includes('Retry feature controls'), 'retry affordance for failed feature fetch');
  assert.ok(source.includes('errorMessage(error)'), 'fetch rejection recorded, not swallowed');

  // Thinking options resolve per picked model from the catalog (§9
  // corrected finding): a ChipSelect ONLY when the model declares options
  // (a stored unknown value stays visible via the "(stored)" escape inside
  // that branch), NO control at all on a 0-declare model — host parity —
  // and the free-text Field kept only as the unresolvable fallback.
  assert.equal(occurrences(roleCard, 'thinkingOptionsFor('), 1, 'thinking resolves via the catalog helper');
  assert.equal(occurrences(roleCard, 'thinking === null'), 1, 'free text remains only the fallback path');
  assert.ok(
    roleCard.includes('Provider default (${thinking.defaultId})'),
    'auto entry names the declared default',
  );
  assert.ok(roleCard.includes('(stored)'), 'unknown stored option stays visible');
  // Host parity (wave 9): the control must not be resurrected by a stored
  // ID on a 0-declare model — the render condition is options.length only.
  assert.ok(!roleCard.includes('thinking.options.length > 0 ||'), 'stored ID must not resurrect the control');
  assert.equal(occurrences(roleCard, 'This model declares no thinking options'), 0, 'no 0-declare hint');
  assert.equal(occurrences(source, 'Not applicable — the model declares no thinking option'), 0, 'seat 0-declare hint removed');
  assert.equal(
    occurrences(source, 'The catalog does not list thinking options'),
    0,
    'stale free-text hint removed',
  );
  assert.ok(!bundle.includes('This model declares no thinking options'), '0-declare hint must not bundle');
  assert.equal(occurrences(roleCard, '"Thinking option"'), 1, 'thinking option field present');

  // The family picker goes through a dedicated handler — not the generic
  // single-field write — so dependent picks re-validate against the new
  // family's catalog (applyFamilyChange) instead of keeping stale foreign
  // values. "family" is out of setRoutingField's union entirely.
  assert.equal(occurrences(routingCard, 'setField(role, "family")'), 0, 'family write must reset dependents');
  assert.equal(occurrences(routingCard, 'onChange={routing.setFamily(role)}'), 1, 'family picker uses the dedicated handler');
  // The role card and the seat editor both route family switches through
  // applyFamilyChange — two application sites, same re-validation rule —
  // one in the routing card module, one on the seat editor in the shell.
  assert.equal(
    occurrences(source, 'applyFamilyChange(') + occurrences(routingCard, 'applyFamilyChange(')
      + occurrences(poolCard, 'applyFamilyChange('),
    2,
    'family-change sites: role + seat',
  );
  // Same for the feature-key fields: a model OR mode pick clears the feature
  // form via the shared helper — two application sites, one rule.
  assert.equal(
    occurrences(source, 'applySettingChange(') + occurrences(routingCard, 'applySettingChange(')
      + occurrences(poolCard, 'applySettingChange('),
    2,
    'feature-key sites: role + seat',
  );

  // The Activation card no longer exposes the pre-binding configurators;
  // the routing card is the sole role→provider configurator in the UI
  // (the RPC inputs stay for scripted use).
  assert.equal(occurrences(source, 'Preferred provider family'), 0);
  assert.equal(occurrences(source, 'Initial profiles'), 0);
  assert.equal(occurrences(bundle, 'Preferred provider family'), 0);
  assert.equal(occurrences(bundle, 'Initial profiles'), 0);
});

test('activation is a prerequisite: it renders above Role profiles and gates Save', () => {
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');

  // Human-mandated order (2026-09-19 round-2 polish): activation is the
  // prerequisite, so its card sits above the Role profiles card it feeds,
  // and Role profiles sits above Communication language — the apply action
  // is adjacent to the "re-activation required" warning that names it.
  const cardOrder = [
    'title="Daemon home"',
    'title="Status"',
    'title="Activation"',
    '<RoutingCard',
    '<PeerPoolCard',
    '<LanguageCard',
    'title="Advanced"',
    'title="Maintenance"',
  ];
  const positions = cardOrder.map(marker => source.indexOf(marker));
  positions.forEach((position, index) => {
    assert.notEqual(position, -1, `card title missing: ${cardOrder[index]}`);
  });
  assert.ok(
    positions.every((position, index) => index === 0 || position > positions[index - 1]),
    `cards out of order: ${positions.join(', ')}`,
  );

  // Save is disabled while unbound — an unbound save wrote the routing file
  // silently (no live profile to diverge from → dead-looking button) and the
  // unbound prefill falls back to the codex default, so a careless
  // save + activate could bind the wrong family. The hint names the
  // prerequisite; the block is UI-only (set-role-routing is unchanged).
  // While bound the gate is a diff-gate: enabled iff the form-built routing
  // differs from the stored one (routingDirty no longer participates —
  // prefill does not set it, which was the reported stuck-disabled bug).
  // The card JSX lives in the routing card module (wave 11 S3c).
  const routingModule = readFileSync(join(root, 'plugin/client/cards/routing.tsx'), 'utf8');
  const saveButton = routingModule.match(
    /label=\{routing\.busy \? "Saving…" : "Save"\}[\s\S]*?disabled=\{([^}]*)\}/,
  );
  assert.ok(saveButton, 'Save button not found');
  assert.match(saveButton[1], /!statusView\?\.binding/, 'Save is not gated on a live binding');
  assert.match(saveButton[1], /!routing\.differs/, 'Save is not diff-gated against the stored routing');
  assert.ok(!/routingDirty|routing\.dirty/.test(saveButton[1]), 'the dirty flag no longer gates Save');
  assert.ok(
    routingModule.includes('Activate first — role profiles are saved against a live binding.'),
    'activate-first hint missing',
  );

  // The bound case confirms the save until the next edit; the divergence
  // warning still owns the diverged state, so the line is suppressed there.
  assert.ok(
    routingModule.includes('Saved — matches the live binding.'),
    'bound-case save feedback missing',
  );

  // The Activation card's pre-bind note references the Role profiles card
  // by name — the previous "role profiles above" copy went spatially stale
  // when the cards reordered.
  assert.equal(occurrences(source, 'role profiles above'), 0, 'stale spatial copy');
  assert.ok(source.includes('the Role profiles card'), 'activation note must name the card');
});

// --- peer pool --------------------------------------------------------------

test('archetype seats parse as pool options and stay parked', () => {
  assert.ok(PEER_SEAT_ARCHETYPES.length >= 12, 'the seat set covers the agreed dispositions');
  const seen = new Set();
  for (const archetype of PEER_SEAT_ARCHETYPES) {
    assert.ok(PeerPoolOption.safeParse(archetype).success, `archetype ${archetype.id} fails the wire schema`);
    assert.equal(archetype.provider, '', `archetype ${archetype.id} ships a provider`);
    assert.equal(archetype.model, '', `archetype ${archetype.id} ships a model`);
    assert.equal(archetype.enabled, false, `archetype ${archetype.id} ships enabled`);
    assert.ok(!('priority' in archetype), `archetype ${archetype.id} still carries priority`);
    assert.ok(!seen.has(archetype.id), `duplicate archetype id ${archetype.id}`);
    seen.add(archetype.id);
    const seat = peerSeatFromArchetype(archetype);
    assert.equal(seat.family, '');
    assert.equal(seat.enabled, false);
    const built = buildPeerSeat(seat, undefined, []);
    assert.ok('option' in built, `archetype ${archetype.id} does not build: ${built.error}`);
    assert.deepEqual(built.option.roles, ['peer']);
    assert.equal(built.option.availability, 'ready');
  }
  // A pool assembled purely from archetypes is valid for the package
  // validator — blank provider/model is legal while disabled.
  const pool = buildPeerPool(
    {
      policy: 'test',
      seats: PEER_SEAT_ARCHETYPES.map(peerSeatFromArchetype),
      quotaFallbackEnabled: false,
      quotaFallbackId: "",
    },
    () => [],
  );
  assert.ok('pool' in pool, `archetype pool does not build: ${pool.error}`);
  validateCatalog(pool.pool);
});

test('peerPoolForm round-trips a stored pool and seeds defaults when absent', () => {
  const stored = {
    version: 1,
    policy: 'p',
    quotaFallback: { enabled: true, optionId: 'a' },
    options: [{
      id: 'a', provider: 'codex', roles: ['peer'], model: 'm', enabled: true,
      availability: 'ready', modeId: 'full', thinkingOptionId: 'high',
      features: { x: true }, suitableFor: ['one', 'two'], avoidFor: ['no'], notes: 'n',
    }],
  };
  const form = peerPoolForm(stored);
  assert.equal(form.policy, 'p');
  assert.equal(form.quotaFallbackEnabled, true);
  assert.equal(form.quotaFallbackId, 'a');
  assert.equal(form.seats.length, 1);
  const seat = form.seats[0];
  assert.equal(seat.family, 'codex');
  assert.equal(seat.suitableFor, 'one\ntwo');
  assert.equal(seat.feature.x, 'true');
  const rebuilt = buildPeerPool(form, () => [], new Map(stored.options.map(o => [o.id, o])));
  assert.ok('pool' in rebuilt, `stored pool does not rebuild: ${rebuilt.error}`);
  assert.ok(peerPoolEquals(rebuilt.pool, stored), 'form round-trip must equal the stored pool');
  assert.equal(peerPoolDiffers(rebuilt, stored), false, 'a rebuilt form must not look dirty');

  const empty = peerPoolForm(null);
  assert.equal(empty.seats.length, 0);
  const emptyBuild = buildPeerPool(empty, () => []);
  assert.ok('pool' in emptyBuild);
  validateCatalog(emptyBuild.pool);
});

test('buildPeerPool rejects the constraints validateCatalog enforces', () => {
  const seat = (id, over = {}) => ({
    id, family: 'codex', model: 'm', modeId: '', thinkingOptionId: '',
    enabled: true, features: '', feature: {},
    suitableFor: 'work', avoidFor: 'none', notes: 'n', ...over,
  });
  const base = { policy: 'p', seats: [seat('a')], quotaFallbackEnabled: false, quotaFallbackId: "" };
  assert.ok('error' in buildPeerPool({ ...base, seats: [seat('a'), seat('a')] }, () => []));
  assert.match(buildPeerPool({ ...base, quotaFallbackId: 'ghost' }, () => []).error, /not a pool seat/);
  assert.match(
    buildPeerPool({ ...base, quotaFallbackEnabled: true }, () => []).error,
    /designated seat/,
  );
  // A designation kept while disabled survives the build as optionId.
  const kept = buildPeerPool({ ...base, quotaFallbackId: 'a' }, () => []);
  assert.ok('pool' in kept, `disabled designation must build: ${kept.error}`);
  assert.deepEqual(kept.pool.quotaFallback, { enabled: false, optionId: 'a' });
  assert.match(buildPeerPool({ ...base, seats: [seat('Bad Id')] }, () => []).error, /must match/);
  assert.match(buildPeerPool({ ...base, seats: [seat('a', { enabled: true, family: '' })] }, () => []).error, /provider family/);
  assert.match(buildPeerPool({ ...base, seats: [seat('a', { enabled: true, model: '' })] }, () => []).error, /needs a model/);
  assert.match(buildPeerPool({ ...base, seats: [seat('a', { notes: ' ' })] }, () => []).error, /notes are required/);
  assert.match(
    buildPeerPool({ ...base, seats: [seat('a', { features: '{nope' })] }, () => []).error,
    /not valid JSON/,
  );
  assert.match(buildPeerPool({ ...base, policy: ' ' }, () => []).error, /policy is required/);
  // A parked seat (blank family/model, disabled) is legal.
  const parked = buildPeerPool({ ...base, seats: [seat('a', { family: '', model: '', enabled: false })] }, () => []);
  assert.ok('pool' in parked, `parked seat must build: ${parked.error}`);
  validateCatalog(parked.pool);
  // A stored `priority` is dropped on write — retired, not preserved.
  const withPriority = buildPeerSeat(seat('a'), { ...seat('a'), provider: 'codex', roles: ['peer'], availability: 'ready', suitableFor: ['w'], avoidFor: [], notes: 'n', priority: 9 }, []);
  assert.ok('option' in withPriority);
  assert.ok(!('priority' in withPriority.option), 'priority must not survive a save');
});

test('the Peer pool card authors the pool through catalog-backed pickers', () => {
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');
  const bundle = clientBundle();
  // The card JSX lives in the pool card module (wave 11 S3c).
  const poolView = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  const peerCard = poolView.slice(
    poolView.indexOf('title="Peer pool"'),
    poolView.indexOf('</Card>', poolView.indexOf('title="Peer pool"')),
  );
  assert.notEqual(poolView.indexOf('title="Peer pool"'), -1, 'Peer pool card missing');

  // One save path, CAS-guarded — the sha256 get-peer-pool returned is sent
  // back as expectedSha256; a conflict reloads instead of overwriting.
  const poolCardModule = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  assert.equal(occurrences(poolCardModule, 'callSetPeerPool('), 1, 'one set-peer-pool call site');
  assert.equal(occurrences(poolCardModule, 'callGetPeerPool('), 2, 'load + reload reads');
  assert.ok(poolCardModule.includes('expectedSha256'), 'CAS token is sent on save');
  assert.ok(poolCardModule.includes('peerPoolDiffers('), 'Save is diff-gated on the built pool');
  assert.equal(occurrences(peerCard, '"Save pool"'), 1, 'one pool save button');
  assert.ok(peerCard.includes('reloadPeerPool'), 'reload affordance for a CAS conflict');

  // Seats come from the shared archetype list; the family picker offers only
  // families the host reports available, and model/mode/thinking reuse the
  // catalog-backed pickers — hand-typed ids only when the provider lists none.
  assert.ok(peerCard.includes('PEER_SEAT_ARCHETYPES'), 'archetype list feeds Add seat');
  assert.ok(peerCard.includes('availableFamilies'), 'family picker filters on availability');
  assert.ok(peerCard.includes('${seat.modeId} (stored)'),
    'mode picker keeps the stored-value escape hatch');
  assert.ok(peerCard.includes('thinkingOptionsFor('), 'thinking resolves via the catalog helper');
  assert.ok(peerCard.includes('"Feature values (JSON)"'), 'raw-JSON features fallback present');

  // One toggle per seat; the editor writes availability:"ready" always —
  // no availability picker exists.
  assert.equal(occurrences(peerCard, 'setSeatEnabled('), 1, 'one inline seat toggle');
  assert.ok(!peerCard.includes('availability'), 'no availability picker in the seat editor');

  // Prose is grouped by audience — Jev-facing fields vs local-only notes.
  assert.ok(peerCard.includes('sent to Jev'), 'Jev-facing prose is labelled');
  assert.ok(peerCard.includes('Jev never sees this'), 'local-only prose is labelled');

  // Quota fallback: a toggle plus ONE designated-seat picker (wave 6 —
  // single optionId, no ordered list and no per-seat checkboxes).
  assert.ok(peerCard.includes('quotaFallbackEnabled'), 'fallback toggle present');
  assert.ok(peerCard.includes('setFallbackId'), 'single designated-seat picker');
  assert.ok(peerCard.includes('Designated fallback seat'), 'designated-seat label');
  assert.ok(!peerCard.includes('toggleFallbackId'), 'no ordered multi-select remains');

  // Jev banner when the routing capability is armed.
  assert.ok(
    peerCard.includes('jev.view?.enabled === true && jev.view.capabilities?.routing === true'),
    'armed-Jev banner missing',
  );
  assert.ok(peerCard.includes('candidate set Jev picks from'), 'banner names the consequence');

  // Copy JSON carries the repository-scope warning verbatim in spirit:
  // pasting into a repo makes it ignore this pool permanently, and the
  // sanctioned path is slp init --routing-from.
  assert.ok(peerCard.includes('Copy pool JSON'), 'copy button present');
  assert.ok(peerCard.includes('ignore this pool'), 'copy warning names the consequence');
  assert.ok(peerCard.includes('permanently'), 'copy warning names permanence');
  assert.ok(peerCard.includes('--routing-from'), 'copy warning names the supported route');

  // Legacy import is offered read-only; the stale-route note lands after Save.
  assert.ok(peerCard.includes('Import legacy catalog'), 'legacy import button present');
  assert.ok(peerCard.includes('never removed'), 'legacy file is documented read-only');
  assert.ok(peerCard.includes('now stale'), 'post-save stale-route note present');
  assert.ok(peerCard.includes('fails closed'), 'stale note names the fail-closed binding');
  assert.ok(bundle.includes('Peer pool'), 'card title bundled');
});

test('the Jev card offers both provider kinds with per-kind model/baseUrl/key surfaces', () => {
  // Kind defaults/labels and the card JSX live in the Jev card module
  // (wave 11 S3b/D ownership + S3c render extraction).
  const jevModule = readFileSync(join(root, 'plugin/client/cards/jev.tsx'), 'utf8');
  // Kind picker with both options — the Human asked for a TypeSafe
  // first-party path beside the OpenRouter relay.
  assert.ok(jevModule.includes('"TypeSafe (first-party)"'), 'typesafe kind option missing');
  assert.ok(jevModule.includes('{ label: "OpenRouter", value: "openrouter" }'), 'openrouter kind option missing');
  // Per-kind defaults and the per-kind key file label.
  assert.ok(jevModule.includes('jev-1.13.0'), 'typesafe pinned model default missing');
  assert.ok(jevModule.includes('jev-typesafe.key'), 'typesafe key file missing');
  // Custom base URL is the Human-requested surface — an editable field that
  // marks itself when the value diverges from the kind default.
  assert.ok(jevModule.includes('"Base URL (custom)"'), 'custom baseUrl marker missing');
});

// T4 pin (Spec F3): a corrupt/foreign work-tracker.json must surface on the
// card — the server view carries `error` and the card renders it as a
// visible `setting error:` line in the loaded branch, not just loadError.
test('the work-tracker card surfaces a setting error on the loaded view (T4)', () => {
  const card = readFileSync(join(root, 'plugin/client/cards/work-tracker.tsx'), 'utf8');
  // The error branch renders inside the loaded view, styled as danger.
  assert.ok(card.includes('view.error !== null'), 'card must branch on view.error');
  assert.ok(card.includes('setting error: {view.error}'), 'card must render the setting error text');
  const branch = card.indexOf('view.error !== null');
  const danger = card.indexOf('colors.statusDanger', branch);
  assert.ok(danger !== -1 && danger - branch < 300, 'setting error must render in the danger tone');
  // Server side: the view contract carries `error` and the RPC populates it.
  const contracts = readFileSync(join(root, 'plugin/shared/contracts.ts'), 'utf8');
  assert.ok(contracts.includes('error: z.string().nullable()'), 'WorkTrackerView must expose error');
});

test('featureDefsForSeat is declared before poolBuild calls it eagerly', () => {
  // Regression: poolBuild runs during render and invokes the lambda per seat
  // — a const declared below it is a TDZ crash on any non-empty seat list
  // (host report: picker renders, adding a seat crashes the surface).
  // Both live in the pool card module (wave 11 S3b/D).
  const source = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  const decl = source.indexOf('const featureDefsForSeat');
  const use = source.indexOf('const poolBuild = buildPeerPool(');
  assert.ok(decl !== -1 && use !== -1, 'featureDefsForSeat/poolBuild must exist');
  assert.ok(decl < use, 'featureDefsForSeat must be declared before poolBuild uses it');
});

test('the Manager UI renders in English — no Vietnamese strings in plugin/client', () => {
  // Human override (wave 5): §7.4's Vietnamese action names are source
  // identifiers only; every user-visible label renders in English.
  const source = [
    'plugin/client/ManagerSurface.tsx',
    'plugin/client/ui-kit.tsx',
    'plugin/client/cards/peer-pool.tsx',
  ].map(f => readFileSync(join(root, f), 'utf8')).join('\n');
  for (const label of [
    'Add a standard seat', 'Already present — open seat',
    'Create a custom seat from template', 'Create a custom copy',
    'Token definitions', 'Convert this seat to a custom seat',
    'How to read', 'Apply the standard set', 'Apply to draft',
    'Keep current edits', 'Discard changes and Reload',
  ]) {
    assert.ok(source.includes(label), `missing EN label: ${label}`);
  }
  // No Vietnamese letters remain in any client source — comments included.
  const viRe = /[\u00C0-\u1EF9]/u;
  const clientFiles = [
    ...readdirSync(join(root, 'plugin/client')).filter(f => /\.tsx?$/.test(f)).map(f => `plugin/client/${f}`),
    ...readdirSync(join(root, 'plugin/client/cards')).filter(f => /\.tsx?$/.test(f)).map(f => `plugin/client/cards/${f}`),
  ];
  for (const name of clientFiles) {
    const hit = readFileSync(join(root, name), 'utf8').split('\n').find(l => viRe.test(l));
    assert.equal(hit, undefined, `Vietnamese text remains in ${name}: ${hit}`);
  }
});

// --- wave 7: Draft-clarity design application --------------------------------

test('the Peer pool card reports draft state and seat counts', () => {
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');
  // The card JSX lives in the pool card module (wave 11 S3c).
  const poolView = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  const peerCard = poolView.slice(
    poolView.indexOf('title="Peer pool"'),
    poolView.indexOf('</Card>', poolView.indexOf('title="Peer pool"')),
  );
  // Header badge: amber draft, else the saved/absent state (mockup dirty badge).
  for (const label of ['Unsaved changes', 'Saved pool', 'No saved pool']) {
    assert.ok(peerCard.includes(`label="${label}"`), `missing badge label: ${label}`);
  }
  // Summary line: saved/absent + N seats in draft, with enabled/disabled and
  // the OVERLAPPING conflicted count.
  assert.ok(peerCard.includes(' in draft`'), 'summary missing the draft seat count');
  assert.ok(peerCard.includes('enabled'), 'summary missing the enabled count');
  assert.ok(peerCard.includes('disabled'), 'summary missing the disabled count');
  assert.ok(peerCard.includes('conflicted'), 'summary missing the conflicted count');
});

test('seat rows state the parked lifecycle explicitly', () => {
  const source = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  for (const state of ['Enabled in draft', 'Disabled · configured', 'Disabled · needs provider/model']) {
    assert.ok(source.includes(`"${state}"`), `missing seat state: ${state}`);
  }
  // Enabled is a deliberate switch — the flow hint names the path and no
  // binding infers enablement.
  assert.ok(source.includes('Choose provider/model → enable → Save pool'), 'parked flow hint missing');
});

test('the standard-seat picker filters and closes at the top', () => {
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');
  const kit = readFileSync(join(root, 'plugin/client/ui-kit.tsx'), 'utf8');
  // The card JSX lives in the pool card module (wave 11 S3c).
  const poolView = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  const peerCard = poolView.slice(
    poolView.indexOf('title="Peer pool"'),
    poolView.indexOf('</Card>', poolView.indexOf('title="Peer pool"')),
  );
  assert.ok(peerCard.includes('Filter by name or description'), 'picker filter missing');
  assert.ok(peerCard.includes('pickerQuery'), 'filter state missing');
  assert.ok(peerCard.includes('No templates match this filter'), 'empty-filter state missing');
  // SeatTemplateRow lives in ui-kit — its labels sit outside the card slice.
  assert.ok(kit.includes('Notes & custom option'), 'per-row notes expander missing');
  assert.ok(kit.includes('Already present — open seat'), 'duplicate-add affordance missing');
  // Close sits in the picker header — before the archetype list renders.
  const closeIdx = peerCard.indexOf('label="Close"', peerCard.indexOf('Standard seat picker'));
  const listIdx = peerCard.indexOf('SeatTemplateRow', peerCard.indexOf('Standard seat picker'));
  assert.ok(closeIdx !== -1 && listIdx !== -1 && closeIdx < listIdx, 'picker Close must precede the rows');
  // All twelve canonical archetypes still come from the package list.
  assert.ok(peerCard.includes('PEER_SEAT_ARCHETYPES'), 'archetype list feeds the picker');
});

test('CAS confirmation renders at the control that triggered it', () => {
  // The card JSX and its state live in the pool card module (wave 11 S3c).
  const poolModule = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  assert.ok(poolModule.includes('"notice" | "footer" | null'), 'origin-typed confirm state missing');
  assert.ok(poolModule.includes('requestReload("notice")'), 'notice-origin reload missing');
  assert.ok(poolModule.includes('requestReload("footer")'), 'footer-origin reload missing');
  assert.ok(poolModule.includes('poolReloadConfirm === "notice"'), 'notice-local confirm missing');
  assert.ok(poolModule.includes('poolReloadConfirm === "footer"'), 'footer-local confirm missing');
  // "Keep current edits" is focused by default via keepEditsRef.
  assert.ok(poolModule.includes('keepEditsRef'), 'keep-edits focus target missing');
  assert.ok(poolModule.includes('Keep current edits'), 'keep-edits action missing');
  assert.ok(poolModule.includes('Discard changes and Reload'), 'discard action missing');
  // "Open seat" on the conflict notice scrolls/focuses the editor.
  assert.ok(poolModule.includes('seatRowRefs'), 'seat-row scroll target missing');
});

test('saving and reloading are separate pending states with their own labels', () => {
  // The card JSX and its state live in the pool card module (wave 11 S3c).
  const poolModule = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  assert.ok(poolModule.includes('setPoolSaving(true)'), 'save busy flag missing');
  assert.ok(poolModule.includes('setPoolReloading(true)'), 'reload busy flag missing');
  assert.ok(poolModule.includes('poolSaving ? "Saving…"'), 'Saving… label missing');
  assert.ok(poolModule.includes('poolReloading ? "Reloading…"'), 'Reloading… label missing');
});

test('the Jev card splits saved settings from the draft and invalidates tests', () => {
  // Card state/handlers AND the card JSX live in the Jev card module
  // (wave 11 S3b/D ownership + S3c render extraction).
  const jevModule = readFileSync(join(root, 'plugin/client/cards/jev.tsx'), 'utf8');
  const jevCard = jevModule.slice(jevModule.indexOf('title="Jev"'), jevModule.indexOf('</Card>', jevModule.indexOf('title="Jev"')));
  // Saved-provider strip names the SAVED provider, not the draft pick.
  assert.ok(jevCard.includes('Saved provider'), 'saved-provider strip missing');
  assert.ok(jevCard.includes('jev.view.provider'), 'saved strip reads the stored provider');
  assert.ok(jevCard.includes('Unsaved settings'), 'unsaved-settings header missing');
  assert.ok(jevCard.includes('Apply before key actions'), 'dirty-draft key lock missing');
  // Key/test actions name the saved provider.
  for (const label of ['Save ${', 'Remove ${', 'Test ${']) {
    assert.ok(jevCard.includes(`\`${label}`), `named key action missing: ${label}`);
  }
  assert.ok(jevCard.includes('JEV_KIND_LABEL[jev.view.provider?.kind ?? jev.kind]'), 'key actions must name the saved provider');
  // Dirty settings lock the key/test actions.
  assert.ok(jevCard.includes('jev.keyBusy || jev.dirty'), 'save-key lock missing');
  assert.ok(jevCard.includes('jev.testBusy || jev.dirty'), 'test lock missing');
  // Any settings edit (kind/model/baseUrl/toggles) invalidates the prior
  // test result — five edit sites in the JSX route through the card's
  // setters, and every setter runs markEdited() — and a pending key input
  // does too.
  assert.equal(
    occurrences(jevCard, 'jev.setKind(') + occurrences(jevCard, 'jev.setModel(')
      + occurrences(jevCard, 'jev.setBaseUrl(') + occurrences(jevCard, 'jev.setEnabledOn(')
      + occurrences(jevCard, 'jev.setRoutingOn('),
    5,
    'every settings edit must route through an invalidating setter',
  );
  for (const setter of ['setKind', 'setModel', 'setBaseUrl', 'setEnabledOn', 'setRoutingOn']) {
    const fn = jevModule.slice(jevModule.indexOf(`const ${setter} =`), jevModule.indexOf('};', jevModule.indexOf(`const ${setter} =`)));
    assert.ok(fn.includes('markEdited()'), `${setter} must invalidate the test via markEdited`);
  }
  assert.ok(jevModule.includes('{ setJevKeyInput(text); setJevTest(null); }'), 'pending key must invalidate the test');
  assert.ok(jevCard.includes('Unsaved key — save it before testing'), 'pending-key marker missing');
  // Per-field errors land at their own fields.
  assert.ok(jevCard.includes('jev.modelError'), 'model field error missing');
  assert.ok(jevCard.includes('jev.urlError'), 'baseUrl field error missing');
  // Load states are distinct: loading, error+Retry, loaded.
  assert.ok(jevCard.includes('Loading Jev settings…'), 'loading branch missing');
  assert.ok(jevCard.includes('Could not load Jev settings'), 'error branch missing');
  assert.ok(jevCard.includes('jev.retryLoad()'), 'Retry path missing');
  // Endpoint preview follows provider-specific rules.
  assert.ok(jevCard.includes('/v1/systemone'), 'typesafe endpoint preview missing');
  assert.ok(jevCard.includes('/api/alpha/decisions'), 'openrouter endpoint preview missing');
});

test('token lookup offers underlined mono buttons that focus the definition', () => {
  // The seat JSX lives in the pool card module (wave 11 S3c).
  const source = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  const kit = readFileSync(join(root, 'plugin/client/ui-kit.tsx'), 'utf8');
  assert.ok(kit.includes('textDecorationLine: "underline"'), 'token underline style missing');
  assert.ok(source.includes('accessibilityLabel={`Define ${token}`}'), 'Define X labels missing');
  assert.ok(source.includes('"Show token definitions"'), 'Show label missing');
  assert.ok(source.includes('"Hide token definitions"'), 'Hide label missing');
  // Custom strings are lookupable — the definition states the package has none.
  assert.ok(
    source.includes('Custom content — the package does not define this token'),
    'custom-token definition text missing',
  );
  // Conflict marks cover BOTH lists plus the net summary.
  assert.ok(source.includes('Added:'), 'added-marks summary missing');
  assert.ok(source.includes('Removed:'), 'removed-marks summary missing');
  // Selecting a token scrolls/focuses the exact definition.
  assert.ok(source.includes('definitionRefs'), 'definition scroll target missing');
  // No token-definition drawer was introduced.
  assert.ok(!/drawer/i.test(source), 'a token drawer must not be introduced');
});

test('seat rows key on the stable draft uid, not the editable id', () => {
  const source = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  assert.ok(source.includes('key={seat.uid}'), 'seat rows must key on the draft uid');
  assert.ok(!source.includes('key={`${index}:${seat.id}`}'), 'index:id key would remount on rename');
});

test('managed seats pick mode like custom; only features stay a read-only summary', () => {
  // Wave 12 (§7.1/§7.4.B): the package owns the token set + seat id; the
  // user binds provider/model/mode/thinking on managed seats too. Mode uses
  // the same catalog picker + free-text fallback on both kinds — including
  // the "(stored)" escape — and routes through setSeatField so a mode pick
  // keeps the shared binding-reset rules. The managed branch keeps only the
  // read-only Feature values summary.
  const poolView = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  const summaryOpen = poolView.indexOf('{managed ? (', poolView.indexOf('setSeatField(index, "modeId")'));
  assert.ok(summaryOpen !== -1, 'managed summary block missing');
  const modeRegion = poolView.slice(
    poolView.indexOf('placeholder="Model ID'),
    summaryOpen,
  );
  assert.ok(modeRegion.includes('value={seat.modeId}'), 'mode control missing');
  assert.ok(
    modeRegion.includes('onChange={setSeatField(index, "modeId")}') &&
    modeRegion.includes('onChangeText={setSeatField(index, "modeId")}'),
    'mode must dispatch through setSeatField (shared reset rules)',
  );
  assert.ok(modeRegion.includes('${seat.modeId} (stored)'), 'mode picker needs the "(stored)" escape');
  assert.ok(!modeRegion.includes('managed'), 'the mode control must not be gated on managed');
  // The managed block renders Feature values alone — no Mode label inside.
  const summaryClose = poolView.indexOf('featureDefs.loading', summaryOpen);
  const summary = poolView.slice(summaryOpen, summaryClose);
  assert.ok(summary.includes('Feature values'), 'managed read-only feature summary missing');
  assert.ok(!summary.includes('>Mode<'), 'managed summary must not carry the mode field');
  assert.ok(!summary.includes('setSeatField(index, "modeId")'), 'managed summary must not edit mode');
});

test('managed-seat notes are an editable local annotation; id, features and tokens stay locked', () => {
  // Wave 13 (§7.4.B): Notes are user-editable on both seat kinds — local only,
  // Jev never sees them — with the package-provided explanation as the seeded
  // default. Id, token lists and feature values stay package-owned.
  const poolView = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  assert.ok(!poolView.includes('Package-provided'), 'managed notes read-only block remains');
  const notesRegion = poolView.slice(
    poolView.indexOf('Local only — Jev never sees this'),
    poolView.indexOf('label="Remove seat"'),
  );
  assert.ok(
    notesRegion.includes('value={seat.notes}') &&
    notesRegion.includes('onChangeText={setSeatField(index, "notes")}'),
    'notes must render the editable Field on both seat kinds',
  );
  assert.ok(!notesRegion.includes('{managed'), 'the notes field must not be gated on managed');
  // The seeding: a managed seat's notes default to the package explanation.
  const archetype = PEER_SEAT_ARCHETYPES.find(a => a.id === 'standard-coding');
  assert.equal(peerSeatFromArchetype(archetype).notes, archetype.notes,
    'peerSeatFromArchetype must keep seeding the package explanation');
  // The remaining managed locks: reserved id, feature controls, token lists.
  assert.ok(
    poolView.includes('Reserved standard-seat id — package-managed'),
    'managed seat id must stay display-only',
  );
  assert.ok(poolView.includes('{managed ? null : featureDefs.defs.length > 0 ? ('),
    'managed feature controls must stay locked');
  assert.ok(poolView.includes(') : managed ? ('), 'managed token lists must stay read-only');
});

test('draft uids are fresh per seat, ignored by form equality, and copied fresh', () => {
  const form = peerPoolForm({
    version: 1, policy: 'p', quotaFallback: { enabled: false, optionId: null },
    options: [{ id: 'a', provider: 'codex', roles: ['peer'], model: 'm', enabled: true, availability: 'ready', modeId: '', thinkingOptionId: '', features: {}, suitableFor: ['w'], avoidFor: [], notes: 'n' }],
  });
  assert.equal(form.seats.length, 1);
  assert.equal(typeof form.seats[0].uid, 'string');
  assert.ok(form.seats[0].uid.length > 0, 'uid must be non-empty');
  // A fresh form over the same pool differs only in uid — never dirty-looking.
  const again = peerPoolForm({
    version: 1, policy: 'p', quotaFallback: { enabled: false, optionId: null },
    options: [{ id: 'a', provider: 'codex', roles: ['peer'], model: 'm', enabled: true, availability: 'ready', modeId: '', thinkingOptionId: '', features: {}, suitableFor: ['w'], avoidFor: [], notes: 'n' }],
  });
  assert.notEqual(form.seats[0].uid, again.seats[0].uid, 'uids must be unique per draft row');
  assert.ok(samePeerPoolForm(form, again), 'uid difference must not mark the form changed');
  // A custom copy is a distinct draft row — not a second handle on one row.
  const copy = customSeatCopy(form.seats[0], []);
  assert.notEqual(copy.uid, form.seats[0].uid, 'custom copy needs a fresh uid');
});

test('custom controls carry RN accessibility props and stale mockup strings stay out', () => {
  // A11y props span the shell (seat rows, notices) and the ui-kit primitives.
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8')
    + readFileSync(join(root, 'plugin/client/ui-kit.tsx'), 'utf8')
    + readFileSync(join(root, 'plugin/client/cards/routing.tsx'), 'utf8')
    + readFileSync(join(root, 'plugin/client/cards/jev.tsx'), 'utf8')
    + readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  for (const prop of ['accessibilityRole=', 'accessibilityLabel=', 'accessibilityState=', 'accessibilityLiveRegion=']) {
    assert.ok(source.includes(prop), `missing a11y prop: ${prop}`);
  }
  assert.ok(source.includes('accessibilityRole="switch"'), 'seat enable switch role missing');
  assert.ok(source.includes('accessibilityRole="checkbox"'), 'check-row role missing');
  // Stale mockup vocabulary must not leak in (pre-wave-6 fallback + chrome).
  for (const stale of ['Allowed preference', 'Try B → A', 'optionIds', 'Design notes']) {
    assert.ok(!source.includes(stale), `stale mockup string present: ${stale}`);
  }
});

test('target-scoped Jev reads refuse to paint a stale response over the displayed view', () => {
  // Regression (gate F1/F-NEW): switching targets while a Jev RPC is in
  // flight must not let the old target's response seed the new target's
  // fields — the same issueKey discipline the pool ops use, on EVERY
  // Jev write-site: loadJev (load/Retry), saveJev (set-jev response),
  // saveJevKey (post-write refresh) and runJevTest (success AND error).
  // The Jev card module owns the handlers (wave 11 S3b/D); the stale-guard
  // mechanism is still the shell's — the card receives it as `sameTarget`,
  // which the shell wires to keyRef === targetKey.
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');
  const jevModule = readFileSync(join(root, 'plugin/client/cards/jev.tsx'), 'utf8');
  assert.ok(
    source.includes('keyRef.current === targetKey(forTarget)'),
    'the shell must wire sameTarget to the keyRef/targetKey guard',
  );
  const loadJev = jevModule.slice(jevModule.indexOf('const loadJev'), jevModule.indexOf('useEffect(() => {', jevModule.indexOf('const loadJev')));
  assert.equal(
    occurrences(loadJev, '!sameTarget(forTarget)'),
    2,
    'loadJev must gate the success AND error writes on the displayed key',
  );
  const saveJev = jevModule.slice(jevModule.indexOf('const save ='), jevModule.indexOf('const saveKey'));
  assert.ok(
    saveJev.includes('!sameTarget(target)'),
    'saveJev must gate its response writes on the displayed key',
  );
  const saveJevKey = jevModule.slice(jevModule.indexOf('const saveKey'), jevModule.indexOf('const runTest'));
  assert.ok(
    saveJevKey.includes('!sameTarget(target)'),
    'the key-save getJev refresh must be stale-guarded too',
  );
  // The key-input/test clears must sit AFTER the guard — a stale resolution
  // may not touch the new target's pending state.
  const guardIdx = saveJevKey.indexOf('!sameTarget(target)');
  assert.ok(
    guardIdx !== -1 && saveJevKey.indexOf('setJevKeyInput("")') > guardIdx,
    'saveJevKey clears must come after the stale-write guard',
  );
  const runJevTest = jevModule.slice(jevModule.indexOf('const runTest'), jevModule.indexOf('const setKind'));
  assert.equal(
    occurrences(runJevTest, '!sameTarget(target)'),
    2,
    'runJevTest must gate the success AND error result writes',
  );
  // Stale ops must not clear a newer op's busy flag — each finally only
  // releases it when the response still belongs to the displayed target.
  for (const flag of ['setJevBusy(false)', 'setJevKeyBusy(false)', 'setJevTestBusy(false)']) {
    const fn = flag === 'setJevBusy(false)' ? saveJev : flag === 'setJevKeyBusy(false)' ? saveJevKey : runJevTest;
    assert.ok(
      fn.includes(`sameTarget(target)) ${flag}`),
      `${flag} must be conditioned on the displayed key`,
    );
  }
  // And the target-switch reset drops the Jev draft + pending flags — a
  // skipped stale clear can never leak busy state onto the new target.
  const resetBlock = jevModule.slice(
    jevModule.indexOf('// Target switch drops the draft'),
    jevModule.indexOf('// Prefill the toggles'),
  );
  for (const reset of ['setJevDirty(false)', 'setJevBusy(false)', 'setJevKeyBusy(false)', 'setJevTestBusy(false)']) {
    assert.ok(resetBlock.includes(reset), `target-switch reset must drop ${reset}`);
  }
});

test('every card async completion, error and finally path is stale-guarded', () => {
  // Regression (wave 11 stale-write fix): a target switch mid-operation must
  // not let the old target's resolution write into the new target's card —
  // and a stale finally must not clear a newer in-flight op's busy flag.
  // Routing/language reuse the pool's isCurrentKey issue-key predicate; the
  // switch-side flag reset releases whatever the skipped finally abandoned.
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');
  const routingModule = readFileSync(join(root, 'plugin/client/cards/routing.tsx'), 'utf8');
  const languageModule = readFileSync(join(root, 'plugin/client/cards/language.ts'), 'utf8');
  const poolModule = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');

  // The shell wires the same keyRef guard to every card hook.
  assert.ok(
    source.includes('keyRef.current === issueKey'),
    'the shell must wire isCurrentKey to the keyRef guard',
  );
  for (const call of ['useLanguageCard({', 'useRoutingCard({', 'usePeerPoolCard({']) {
    const callSite = source.slice(source.indexOf(call), source.indexOf('});', source.indexOf(call)));
    assert.ok(callSite.includes('isCurrentKey'), `${call} must receive the stale-guard predicate`);
  }

  // Routing save: the completion writes (stored value, dirty clear, Saved
  // badge) sit AFTER the guard; the busy clear in finally is conditional.
  const routingSave = routingModule.slice(
    routingModule.indexOf('const save ='),
    routingModule.indexOf('return {', routingModule.indexOf('const save =')),
  );
  const rGuard = routingSave.indexOf('!isCurrentKey(issueKey)');
  assert.ok(rGuard !== -1, 'routing save must guard its completion writes');
  assert.ok(
    routingSave.indexOf('setRouting(result.routing)') > rGuard &&
    routingSave.indexOf('setRoutingDirty(false)') > rGuard &&
    routingSave.indexOf('setRoutingSaved(true)') > rGuard,
    'routing save writes must come after the stale guard',
  );
  assert.ok(
    routingSave.includes('if (isCurrentKey(issueKey)) setRoutingBusy(false)'),
    'routing save finally must not clear a newer op\'s busy flag',
  );

  // Language apply: the dirty clear sits AFTER the guard; the busy clear in
  // finally is conditional. refresh()/update() stay unguarded — both are
  // bound to the issuing target by applyPatch.
  const applyLanguage = languageModule.slice(
    languageModule.indexOf('const applyLanguage'),
    languageModule.indexOf('const onToggle'),
  );
  const lGuard = applyLanguage.indexOf('!isCurrentKey(issueKey)');
  assert.ok(lGuard !== -1, 'language apply must guard its completion writes');
  assert.ok(
    applyLanguage.indexOf('setLanguageDirty(false)') > lGuard,
    'language apply must not clear the displayed target\'s dirty flag on stale',
  );
  assert.ok(
    applyLanguage.includes('if (isCurrentKey(issueKey)) setLanguageBusy(false)'),
    'language apply finally must not clear a newer op\'s busy flag',
  );

  // Pool catch paths paint card-local poolError only when the key still
  // matches, and each finally busy-clear is conditional.
  const savePeerPool = poolModule.slice(
    poolModule.indexOf('const savePeerPool'),
    poolModule.indexOf('const reloadPeerPool'),
  );
  assert.ok(
    savePeerPool.includes('if (isCurrentKey(issueKey))') &&
    savePeerPool.indexOf('setPoolError({') > savePeerPool.lastIndexOf('if (isCurrentKey(issueKey)) {'),
    'pool save catch must gate setPoolError on the displayed key',
  );
  assert.ok(
    savePeerPool.includes('if (isCurrentKey(issueKey)) setPoolSaving(false)'),
    'pool save finally must not clear a newer op\'s busy flag',
  );
  const reloadPeerPool = poolModule.slice(
    poolModule.indexOf('const reloadPeerPool'),
    poolModule.indexOf('const requestReload'),
  );
  assert.ok(
    reloadPeerPool.includes('if (isCurrentKey(issueKey)) setPoolError({ message, cas: false })'),
    'pool reload catch must gate setPoolError on the displayed key',
  );
  assert.ok(
    reloadPeerPool.includes('if (isCurrentKey(issueKey)) setPoolReloading(false)'),
    'pool reload finally must not clear a newer op\'s busy flag',
  );
  const copyPoolJson = poolModule.slice(
    poolModule.indexOf('const copyPoolJson'),
    poolModule.indexOf('return {', poolModule.indexOf('const copyPoolJson')),
  );
  assert.ok(
    copyPoolJson.includes('isCurrentKey(issueKey)) setPoolCopied(true)'),
    'the copy confirmation must be stale-guarded',
  );

  // The guarded-finally discipline needs the switch to release abandoned
  // flags — routing and language each reset their transient flags on
  // targetKey change (the pool card already resets everything there).
  for (const [mod, flag] of [[routingModule, 'setRoutingBusy(false)'], [languageModule, 'setLanguageBusy(false)']]) {
    const fxEnds = [...mod.matchAll(/\[targetKey\]\);/g)].map(m => m.index);
    const hasReset = fxEnds.some(pos => mod.slice(Math.max(0, pos - 400), pos).includes(flag));
    assert.ok(hasReset, `target-switch reset must release ${flag}`);
  }
});

// ---------------------------------------------------------------------------
// Visual-system wave — the reviewed mockup's look (nav strip, routing
// headline, two-column profile panels, choice chips, select-box model row,
// hover/focus/pressed/disabled states) ported onto host theme slots.
// ---------------------------------------------------------------------------

test('the in-surface tab strip switches the five routing sections in order', () => {
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');
  // Five items in the fixed section order — Supervision is not a tab; its
  // card mounts inside the Jev section it depends on.
  const nav = source.slice(source.indexOf('MANAGER_SECTIONS = ['), source.indexOf('] as const'));
  for (const label of ['"Role profiles"', '"Peer pool"', '"Communication language"', '"Work tracker"', '"Jev"']) {
    assert.ok(nav.includes(`label: ${label}`), `nav item missing: ${label}`);
  }
  assert.ok(!nav.includes('id: "supervision"'), 'supervision must not be a nav tab');
  const order = ['profiles', 'pool', 'language', 'tracker', 'jev'].map(id => nav.indexOf(`id: "${id}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'nav order must be profiles → pool → language → tracker → jev');
  // Tab semantics: a press activates the section — no scrolling to it.
  assert.ok(source.includes('accessibilityLabel="Manager sections"'), 'tab strip a11y label missing');
  assert.ok(source.includes('role="tablist"'), 'tab strip must use a tablist container role');
  assert.ok(source.includes('accessibilityRole="tab"'), 'nav items must be tabs');
  assert.ok(source.includes('accessibilityState={{ selected: active }}'), 'tabs must expose selected state');
  assert.ok(source.includes('setActiveSection(section.id)'), 'tab press must switch the active section');
  // Inactive sections stay mounted under display:none — drafts and
  // card-local state survive a tab switch, but nothing lays out.
  for (const id of ['profiles', 'pool', 'language', 'tracker', 'jev']) {
    assert.ok(source.includes(`sectionShown("${id}")`), `section ${id} must gate layout on the active tab`);
  }
  assert.ok(!source.includes('sectionShown("supervision")'), 'supervision keeps no separate section gate');
  // The supervision card renders inside the jev-gated view.
  const jevView = source.slice(source.indexOf('sectionShown("jev")'), source.indexOf('sectionShown("jev")') + 1200);
  assert.ok(jevView.includes('<SupervisionCard'), 'SupervisionCard must mount inside the Jev section');
  // The scroll-anchor machinery is gone — scrolling never reveals sections.
  for (const gone of ['sectionTops', 'scrollToSection', 'onRootScroll', 'scrollTo({ y:', 'onScroll={']) {
    assert.ok(!source.includes(gone), `scroll-anchor machinery remains: ${gone}`);
  }
});

test('the routing region opens with the mockup headline and sub-copy', () => {
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');
  const kit = readFileSync(join(root, 'plugin/client/ui-kit.tsx'), 'utf8');
  assert.ok(source.includes('Routing configuration'), 'eyebrow missing');
  assert.ok(source.includes('Peer routing configuration'), 'headline missing');
  assert.ok(source.includes('Review the draft. Save when the whole pool is ready.'), 'sub-copy missing');
  // The eyebrow uppercases via the shared style (ui-kit), not a hardcoded string.
  const eyebrow = kit.slice(kit.indexOf('eyebrow:'), kit.indexOf('noticeBox:'));
  assert.ok(eyebrow.includes('textTransform: "uppercase"'), 'eyebrow must uppercase via style');
  // The host SLP header is untouched — no second page title.
  assert.equal(occurrences(kit + source, 'pageTitle'), 2, 'page title style + its single use only');
});

test('role profiles lay out in a container-measured two-column panel grid', () => {
  // The card JSX lives in the routing card module (wave 11 S3c).
  const source = readFileSync(join(root, 'plugin/client/cards/routing.tsx'), 'utf8');
  // The threshold is measured on the card body container — never the window.
  assert.ok(source.includes('profilePanelWide'), 'wide-panel flag missing');
  assert.ok(
    source.includes('onLayout={event => setProfilePanelWide(event.nativeEvent.layout.width >= 700)}'),
    'the grid must measure its own container at the ~700px breakpoint',
  );
  assert.ok(!source.includes('Dimensions.get'), 'window measurement is forbidden — use the container');
  assert.ok(
    source.includes('flexDirection: profilePanelWide ? "row" : "column"'),
    'two-column/one-column switch missing',
  );
  // Panels are bordered sub-cards on the subtler surface.
  const kit = readFileSync(join(root, 'plugin/client/ui-kit.tsx'), 'utf8');
  const panel = kit.slice(kit.indexOf('profilePanel:'), kit.indexOf('profileHeading:'));
  assert.ok(panel.includes('borderWidth: 1') && panel.includes('padding: 18'), 'profile-panel geometry missing');
  assert.ok(source.includes('backgroundColor: colors.surface0 }, profilePanelWide'), 'panel fill must use the surface slot');
});

test('provider family and mode render as mockup choice chips', () => {
  // The card JSX lives in the routing card module (wave 11 S3c).
  const source = readFileSync(join(root, 'plugin/client/cards/routing.tsx'), 'utf8');
  const kit = readFileSync(join(root, 'plugin/client/ui-kit.tsx'), 'utf8');
  const profiles = source.slice(source.indexOf('title="Role profiles"'), source.indexOf('</Card>', source.indexOf('title="Role profiles"')));
  // Both fields use the choice variant inside the profile panels.
  assert.ok(occurrences(profiles, 'variant="choice"') >= 2, 'family + mode must render as choice chips');
  // Choice-chip visuals: square-ish radius, muted until selected, then the
  // accent border/text over a tinted fill (surface2 — no accent-tint slot).
  const choice = kit.slice(kit.indexOf('choice:'), kit.indexOf('choiceLabel:'));
  assert.ok(choice.includes('borderRadius: 6'), 'choice chip radius missing');
  assert.ok(
    kit.includes('backgroundColor: active ? colors.surface2 : colors.surface0'),
    'selected choice must take the tinted fill',
  );
  assert.ok(
    kit.includes('color: active ? colors.accent : colors.foregroundMuted'),
    'selected choice must take the accent text',
  );
  // Other ChipSelect consumers keep the pill default.
  assert.ok(kit.includes('variant = "pill"'), 'pill must remain the default variant');
});

test('the model row is a non-destructive select-box with a manual disclosure', () => {
  const source = readFileSync(join(root, 'plugin/client/ui-kit.tsx'), 'utf8');
  const picker = source.slice(source.indexOf('function OptionPicker'), source.indexOf('function Collapse'));
  // The collapsed row shows the stored value (never blanked by opening).
  assert.ok(picker.includes('effective ?'), 'stored-value display missing');
  assert.ok(picker.includes('setOpen(current => !current)'), 'Change expander missing');
  assert.ok(!/onPress=\{[^}]*onChange\(""\)/.test(picker), 'opening the picker must not clear the model');
  assert.ok(picker.includes('Change ${label.toLowerCase()} ⌄'), 'Change-model link missing');
  assert.ok(picker.includes('Enter model ID manually'), 'manual disclosure missing');
  assert.ok(picker.includes('manualOpen'), 'manual disclosure state missing');
  // Provider default stays reachable as a list entry.
  assert.ok(picker.includes('Select Provider default'), 'provider-default entry missing');
  assert.ok(picker.includes('pick("")'), 'provider default must clear the value');
  // The searchable filter is kept.
  assert.ok(picker.includes('Filter ${label}'), 'search filter missing');
});

test('controls share hover/focus/pressed/disabled states via the theme', () => {
  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8')
    + readFileSync(join(root, 'plugin/client/ui-kit.tsx'), 'utf8')
    + readFileSync(join(root, 'plugin/client/cards/routing.tsx'), 'utf8')
    + readFileSync(join(root, 'plugin/client/cards/jev.tsx'), 'utf8')
    + readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  // RN-web runtime fields are widened once, locally — no untyped destructure.
  assert.ok(source.includes('type ControlState = { pressed: boolean; hovered?: boolean; focused?: boolean }'),
    'widened control-state type missing');
  assert.ok(occurrences(source, 'state.hovered') >= 8, 'hover state must cover the interactive controls');
  assert.ok(occurrences(source, 'state.focused') >= 8, 'focus state must cover the interactive controls');
  // The focus ring is the accent outline (no dedicated focus slot exists).
  assert.ok(source.includes('outlineColor: colors.accent'), 'accent focus ring missing');
  assert.ok(source.includes('outlineStyle: "solid"'), 'focus ring outline missing');
  assert.ok(occurrences(source, 'focusRing(colors)') >= 8, 'focus ring must apply across controls');
  // Disabled stays ~0.45 opacity.
  assert.ok(source.includes('{ opacity: 0.45 }'), 'disabled opacity missing');
});

test('no hardcoded hex colors live in the client', () => {
  const files = ['plugin/client/ManagerSurface.tsx', 'plugin/client/ui-kit.tsx'];
  const hits = files.flatMap(file =>
    (readFileSync(join(root, file), 'utf8').match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map(hit => `${file}:${hit}`),
  );
  assert.deepEqual(hits, [], `hex color literals found: ${hits.join(', ')}`);
});

// Wave 9b — the catalog rides providers.snapshot (host parity): the managed
// slp-<family>-<role> entry first, base family as fallback.
test('pickSnapshotEntry prefers the managed provider id, then the base family', () => {
  const entries = [
    { provider: 'slp-devin-peer' },
    { provider: 'devin' },
    { provider: 'slp-devin-lead' },
  ];
  assert.equal(pickSnapshotEntry(entries, 'slp-devin-lead', 'devin')?.provider, 'slp-devin-lead');
  // Managed id absent → base family entry.
  assert.equal(pickSnapshotEntry(entries, 'slp-codex-peer', 'devin')?.provider, 'devin');
  // Neither managed nor base → undefined (the caller reports, no legacy retry).
  assert.equal(pickSnapshotEntry(entries, 'slp-pi-peer', 'pi'), undefined);
  // Role-less request (preferredId === family) resolves the base entry.
  assert.equal(pickSnapshotEntry(entries, 'devin', 'devin')?.provider, 'devin');
});

test('snapshotEntryCatalog filters isSelectable === false only', () => {
  const mapped = snapshotEntryCatalog({
    provider: 'slp-devin-peer',
    status: 'ready',
    models: [
      { id: 'swe-2-max', label: 'SWE' },
      { id: 'hidden', isSelectable: false },
      { id: 'plain' },
    ],
  });
  assert.deepEqual(mapped.models.map(m => m.id), ['swe-2-max', 'plain']);
  // thinkingOptions pass through untouched.
  const withOptions = snapshotEntryCatalog({
    provider: 'slp-codex-lead',
    status: 'ready',
    models: [{ id: 'gpt-5.6', thinkingOptions: [{ id: 'medium', label: 'Medium' }], defaultThinkingOptionId: 'medium' }],
  });
  assert.equal(withOptions.models[0].thinkingOptions[0].id, 'medium');
  assert.equal(withOptions.models[0].defaultThinkingOptionId, 'medium');
});

test('snapshotEntryCatalog ships modes only for a ready entry', () => {
  const entry = {
    provider: 'slp-devin-peer',
    modes: [{ id: 'fast' }, { id: 'deep', label: 'Deep' }],
  };
  assert.equal(snapshotEntryCatalog({ ...entry, status: 'ready' }).modes.length, 2);
  assert.equal(snapshotEntryCatalog({ ...entry, status: 'error' }).modes.length, 0);
  // status absent → not provably ready → no modes.
  assert.equal(snapshotEntryCatalog(entry).modes.length, 0);
});

test('snapshotEntryCatalog surfaces entry errors instead of swallowing', () => {
  const mapped = snapshotEntryCatalog({
    provider: 'slp-pi-peer',
    status: 'error',
    error: 'credential missing',
    models: [],
  });
  assert.match(mapped.error, /credential missing/);
  assert.match(mapped.error, /slp-pi-peer is error/);
  const clean = snapshotEntryCatalog({ provider: 'devin', status: 'ready', models: [] });
  assert.equal(clean.error, null);
});

test('the catalog RPC rides providers.snapshot with legacy list calls kept', () => {
  const wiring = readFileSync(join(root, 'plugin/index.server.ts'), 'utf8');
  // The catalog implementation lives in plugin/server/provider-catalog.ts;
  // the entry only wires it.
  assert.ok(wiring.includes('import { loadCatalog } from "./server/provider-catalog.ts"'),
    'index.server.ts must wire loadCatalog from the catalog module');
  const source = readFileSync(join(root, 'plugin/server/provider-catalog.ts'), 'utf8');
  assert.ok(source.includes('providers.snapshot'), 'snapshot RPC missing');
  assert.ok(source.includes('paseo.providers.snapshot('), 'snapshot call missing');
  // Legacy endpoints stay verbatim for pre-snapshot daemons — the shared
  // per-provider listing helper is invoked on the family id.
  assert.ok(source.includes('paseo.providers.listModels(providerId'), 'listModels call missing');
  assert.ok(source.includes('paseo.providers.listModes(providerId'), 'listModes call missing');
  assert.ok(source.includes('return listCatalog(provider)'), 'legacy family listing path removed');
  // A snapshot entry caught mid-warmup resolves through those listings —
  // "loading" must never reach the client as a cached terminal error.
  assert.ok(source.includes('entry.status === "loading"'), 'loading fallback missing');
  // Probe-and-latch: no serverInfo accessor exists on PaseoApi, so the flag
  // must be the documented latch — and the comment must record why.
  assert.ok(source.includes('snapshotUnsupported'), 'capability latch missing');
  assert.match(source, /serverInfo/, 'the missing serverInfo capability must be recorded in a comment');
  // The latch fires only on identifiable capability absence — the daemon's
  // unknown_schema "Unknown request" reply or a missing method — never on a
  // transient transport failure, and never silently.
  assert.match(source, /unknown_schema\|unknown request/i, 'latch must key on the unknown-request marker');
  assert.ok(!/catch\s*\{\s*snapshotUnsupported\s*=\s*true/.test(source),
    'a blanket catch-all latch hides transient failures');
  assert.ok(source.includes('console.warn'), 'the downgrade must not be silent');
  // Features resolve against the SNAPSHOT-selected entry, not the base family.
  assert.ok(source.includes('`${entry.provider}/${input.model}`'), 'features must query the resolved provider id');
  // Snapshot path emits provenance; legacy path does not.
  assert.ok(source.includes('resolvedProvider: entry.provider'), 'resolvedProvider missing on the snapshot path');
});

test('catalog input accepts a role and the client caches by family|role', () => {
  const parsed = CatalogInput.parse({ schemaVersion: 1, family: 'devin', role: 'peer' });
  assert.equal(parsed.role, 'peer');
  // Role stays optional for wire back-compat.
  assert.equal(CatalogInput.parse({ schemaVersion: 1, family: 'devin' }).role, undefined);
  assert.throws(() => CatalogInput.parse({ schemaVersion: 1, family: 'devin', role: 'manager' }));

  const source = readFileSync(join(root, 'plugin/client/ManagerSurface.tsx'), 'utf8');
  // The scope/key formats are the shell-card seam contract — they live in
  // manager-state.ts (catalogScope/featureKey) since wave 11 S3b/D.
  const managerState = readFileSync(join(root, 'plugin/client/manager-state.ts'), 'utf8');
  assert.ok(managerState.includes('`${family}|${role}`'), 'catalog scope key missing');
  // Every catalog request carries its role scope.
  assert.ok(occurrences(source, 'schemaVersion: 1, family, role') >= 2, 'catalog requests must send role');
  // Feature cache keys are family|role|model|modeId.
  assert.ok(managerState.includes('`${family}|${role}|${model}|'), 'feature key missing the role segment');
  const poolCard = readFileSync(join(root, 'plugin/client/cards/peer-pool.tsx'), 'utf8');
  assert.ok(poolCard.includes('`${seat.family}|peer|'), 'seat feature key missing the peer segment');
  // No bare-family catalog lookups remain.
  assert.ok(!/catalogs\[form\.family\]/.test(source), 'bare-family role-card lookup remains');
  assert.ok(!/catalogs\[seat\.family\]/.test(source), 'bare-family seat lookup remains');
  // An Unset role has family "" — the scope list must drop it before keys
  // are built, or "|role" scopes would fire catalog RPCs zod rejects.
  assert.ok(/neededScopes[\s\S]*?\.filter\([\s\S]*?scope\.family !== ""\)/.test(source),
    'empty-family scopes must be filtered before scope keys are built');
});
