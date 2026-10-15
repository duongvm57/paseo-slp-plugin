// Coverage for the pure view-state helpers in plugin/client/manager-state.ts
// (imported directly — no react), plus an esbuild check that the client entry
// bundles cleanly against host externals with no server-only or node code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
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
  families: ['codex', 'pi', 'devin', 'claude', 'opencode'].map(name => family(name)),
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
  assert.deepEqual(recoverPendingStart(OP_ID, statusView({ operation: null, conflicts: [{ code: 'NOT_FOUND', message: 'no operation in journal' }] })), { kind: 'retry' });
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
  assert.equal(activationLabel(null), 'Activate SLP runtime');
  const bound = statusView();
  assert.equal(activationKind(bound), 'reverify');
  assert.equal(activationLabel(bound), 'Apply saved profiles');
  const diverged = statusView({ binding: { ...bound.binding, candidateSha256: SHA_B } });
  assert.equal(activationKind(diverged), 'rebind');
  assert.equal(activationLabel(diverged), 'Update SLP runtime');
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
    assert.equal(seat.notes, archetype.notes, `archetype ${archetype.id} must retain its package explanation`);
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

test('catalog input retains the optional role wire contract', () => {
  const parsed = CatalogInput.parse({ schemaVersion: 1, family: 'devin', role: 'peer' });
  assert.equal(parsed.role, 'peer');
  // Role stays optional for wire back-compat.
  assert.equal(CatalogInput.parse({ schemaVersion: 1, family: 'devin' }).role, undefined);
  assert.throws(() => CatalogInput.parse({ schemaVersion: 1, family: 'devin', role: 'manager' }));

  // Cache role scoping and demand/retry behavior are covered by the real
  // cache hook in tests/client-catalog-demand.test.mjs.

});
