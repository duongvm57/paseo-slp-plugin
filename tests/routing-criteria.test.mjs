// tests/routing-criteria.test.mjs — the routing-criteria contract
// (docs/spec/routing-criteria.md): vocabulary integrity, §4 reading rules,
// §6.2 overlaps, §7.2 reserved-id/token-conflict semantics, the §7.4
// form/save/import flows and the Jev
// guidance/receipt binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { json, hash } from '../plugin/server/runtime/cli/package.ts';
import { readCatalog, catalogBinding, validateCatalog, ROUTE_DECISION_QUESTION, ROUTE_DECLINE_CANDIDATE } from '../plugin/server/runtime/cli/routing.ts';
import { routeDecide } from '../plugin/server/runtime/cli/jev-routing.ts';
import { canonicalJson } from '../plugin/server/runtime/cli/jev.ts';
import { fakeOrKey } from './fake-secrets.mjs';
import {
  HOW_TO_READ,
  JEV_SUITABILITY_GUIDANCE,
  JEV_TOKEN_DEFINITIONS,
  ROUTING_VOCABULARY_VERSION,
  STANDARD_SEAT_IDS,
  STANDARD_SEAT_TOKENS,
  SUITABILITY_AXES,
  SUITABILITY_TOKENS,
  avoidWarnings,
  catalogTokenConflicts,
  domainCoverage,
  isStandardSeatId,
  isStandardToken,
  seatTokenConflict,
  suitabilityMatch,
  tokenDefinition,
} from '../plugin/shared/runtime/routing-vocabulary.ts';
import { PEER_SEAT_ARCHETYPES } from '../plugin/shared/archetypes.ts';
import {
  buildPeerPool,
  convertSeatToCustom,
  customSeatCopy,
  customSeatFromArchetype,
  customSeatIdError,
  emptyPeerPoolForm,
  formSeatConflict,
  legacyImportAllowed,
  peerPoolForm,
  peerSeatFromArchetype,
  seatManagement,
  suggestCustomSeatId,
} from '../plugin/client/manager-state.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/routing-criteria-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, repo: join(dir, 'repo'), home: join(dir, 'home') };
}
const writeCatalog = (repo, catalog) => {
  mkdirSync(join(repo, '.paseo-slp'), { recursive: true });
  writeFileSync(join(repo, '.paseo-slp/slp-routing.json'), json(catalog));
};
const providers = ['slp-codex-peer', 'slp-codex-lead'].map(id => ({ id, enabled: true, status: 'available' }));
const seat = (id, over = {}) => ({
  id, provider: 'codex', roles: ['peer'], model: 'gpt-5.6-luna', enabled: true,
  availability: 'ready', suitableFor: [], avoidFor: [], notes: 'n', ...over,
});
const pool = options => ({ version: 1, policy: 'Test pool.', quotaFallback: { enabled: false, optionId: null }, options });
const jevHome = home => {
  mkdirSync(join(home, 'slp-runtime', 'state'), { recursive: true });
  writeFileSync(join(home, 'config.json'), json({ version: 1 }));
  writeFileSync(join(home, 'slp-runtime', 'state', 'jev.json'), json({
    schemaVersion: 1, enabled: true, capabilities: { routing: true },
    provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' },
  }), { mode: 0o600 });
  writeFileSync(join(home, 'slp-runtime', 'state', 'jev-openrouter.key'), fakeOrKey('synthetic-test-key-000') + '\n', { mode: 0o600 });
  return home;
};
const okFetch = choice => async () => ({
  ok: true,
  json: async () => ({
    id: 'gen-dec-mock', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe',
    answers: { [ROUTE_DECISION_QUESTION]: { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } } },
    usage: { cost: 0.0001, input_tokens: 10, output_tokens: 5 },
  }),
});

// ---------------------------------------------------------------------------
// §2/§3 — the closed vocabulary is exactly the 16 axis:value tokens
// ---------------------------------------------------------------------------

test('the vocabulary is exactly the 16 tokens across the four axes', () => {
  assert.equal(SUITABILITY_TOKENS.length, 16);
  const byAxis = new Map(SUITABILITY_AXES.map(axis => [axis.id, new Set(axis.values)]));
  for (const token of SUITABILITY_TOKENS) {
    const [axis, value] = token.id.split(':');
    assert.ok(byAxis.has(axis), `${token.id} names a declared axis`);
    assert.ok(byAxis.get(axis).has(value), `${token.id} uses a value of its axis`);
    assert.equal(token.axis, axis);
    for (const field of ['sign', 'example', 'counterExample', 'boundary']) {
      assert.ok(token[field].trim().length > 0, `${token.id} carries a packaged ${field}`);
    }
    assert.equal(tokenDefinition(token.id), token);
  }
  assert.equal(isStandardToken('work:change'), true);
  assert.equal(isStandardToken('work:Change'), false, 'exact match, no case folding');
  assert.equal(isStandardToken('domain:code'), false, 'no synonyms');
  assert.equal(isStandardToken('anything'), false);
});

// ---------------------------------------------------------------------------
// §6 — the package token sets on all 12 standard seats
// ---------------------------------------------------------------------------

test('STANDARD_SEAT_TOKENS pins the §6 table for all 12 archetypes', () => {
  assert.deepEqual(STANDARD_SEAT_IDS, [
    'lightweight-recon', 'standard-coding', 'deep-reasoning', 'independent-second-opinion',
    'autonomous-long-running', 'test-authoring', 'spec-docs-writing', 'security-review',
    'debugging-root-cause', 'mechanical-refactor', 'research-spike', 'data-migration',
  ]);
  assert.deepEqual(STANDARD_SEAT_TOKENS['lightweight-recon'], {
    suitableFor: ['work:enumerate', 'depth:mechanical', 'depth:bounded'],
    avoidFor: ['work:change', 'work:design', 'work:verify', 'depth:open'],
  });
  assert.deepEqual(STANDARD_SEAT_TOKENS['standard-coding'], {
    suitableFor: ['work:change', 'depth:mechanical', 'depth:bounded', 'domain:software', 'domain:tests'],
    avoidFor: ['work:design', 'depth:open'],
  });
  assert.deepEqual(STANDARD_SEAT_TOKENS['deep-reasoning'], {
    suitableFor: ['work:investigate', 'work:design', 'work:verify', 'depth:bounded', 'depth:open'],
    avoidFor: ['depth:mechanical'],
  });
  assert.deepEqual(STANDARD_SEAT_TOKENS['independent-second-opinion'], { suitableFor: ['work:verify'], avoidFor: [] });
  assert.deepEqual(STANDARD_SEAT_TOKENS['autonomous-long-running'], { suitableFor: ['flow:staged'], avoidFor: ['flow:direct'] });
  assert.deepEqual(STANDARD_SEAT_TOKENS['test-authoring'], {
    suitableFor: ['work:change', 'work:verify', 'domain:tests'],
    avoidFor: ['work:design', 'domain:software'],
  });
  assert.deepEqual(STANDARD_SEAT_TOKENS['spec-docs-writing'], {
    suitableFor: ['work:change', 'domain:prose'],
    avoidFor: ['domain:software'],
  });
  assert.deepEqual(STANDARD_SEAT_TOKENS['security-review'], {
    suitableFor: ['work:design', 'work:verify', 'domain:security'],
    avoidFor: ['work:change'],
  });
  assert.deepEqual(STANDARD_SEAT_TOKENS['debugging-root-cause'], {
    suitableFor: ['work:investigate', 'depth:open', 'domain:software'],
    avoidFor: ['work:change', 'domain:prose'],
  });
  assert.deepEqual(STANDARD_SEAT_TOKENS['mechanical-refactor'], {
    suitableFor: ['work:change', 'depth:mechanical', 'domain:software'],
    avoidFor: ['depth:bounded', 'depth:open'],
  });
  assert.deepEqual(STANDARD_SEAT_TOKENS['research-spike'], {
    suitableFor: ['work:investigate', 'depth:open', 'domain:software'],
    avoidFor: ['work:change'],
  });
  assert.deepEqual(STANDARD_SEAT_TOKENS['data-migration'], {
    suitableFor: ['work:change', 'domain:data', 'flow:direct', 'flow:staged'],
    avoidFor: [],
  });
});

test('every archetype ships the package token set and a package note', () => {
  assert.equal(PEER_SEAT_ARCHETYPES.length, 12);
  for (const archetype of PEER_SEAT_ARCHETYPES) {
    const standard = STANDARD_SEAT_TOKENS[archetype.id];
    assert.ok(standard, `${archetype.id} is a reserved standard id`);
    assert.deepEqual([...archetype.suitableFor].sort(), [...standard.suitableFor].sort());
    assert.deepEqual([...archetype.avoidFor].sort(), [...standard.avoidFor].sort());
    assert.ok(archetype.notes.length > 0, `${archetype.id} carries a package note`);
    assert.equal(archetype.enabled, false, 'archetypes ship parked');
    assert.equal(archetype.provider, '');
    assert.equal(archetype.model, '');
    // Package integrity: no seat may assert the same token in both fields
    // (§4 — a contradictory assertion is a package content error).
    const overlap = standard.suitableFor.filter(token => standard.avoidFor.includes(token));
    assert.deepEqual(overlap, [], `${archetype.id} has no contradictory assertion`);
  }
});

// ---------------------------------------------------------------------------
// §6.2 — deliberate overlaps are pinned, not deduplicated away
// ---------------------------------------------------------------------------

test('§6.2 overlaps are part of the contract', () => {
  const suit = id => new Set(STANDARD_SEAT_TOKENS[id].suitableFor);
  // debugging-root-cause and research-spike keep the same entire suitable.
  assert.deepEqual(suit('debugging-root-cause'), suit('research-spike'));
  // standard-coding and mechanical-refactor both accept change/mechanical/software.
  for (const token of ['work:change', 'depth:mechanical', 'domain:software']) {
    assert.ok(suit('standard-coding').has(token) && suit('mechanical-refactor').has(token), token);
  }
  // standard-coding and test-authoring both accept change/bounded/tests —
  // test-authoring declares no depth axis, so a bounded task creates no
  // contradiction; the work axis keeps the verification distinction.
  assert.ok(suit('standard-coding').has('depth:bounded') && suit('standard-coding').has('domain:tests'));
  assert.ok(suit('test-authoring').has('work:change') && suit('test-authoring').has('domain:tests'));
  assert.equal(
    suitabilityMatch(STANDARD_SEAT_TOKENS['test-authoring'].suitableFor, { work: 'change', depth: 'bounded', domains: ['tests'] }),
    true,
    'test-authoring accepts a bounded test task — depth is undeclared, not contradicted',
  );
  assert.ok(suit('test-authoring').has('work:verify') && !suit('standard-coding').has('work:verify'));
  // Three seats match verify but differ on domain: only security-review
  // declares a domain, so it alone is in the full-coverage group for
  // verify/security while the other two are fallback (§4 step 3).
  for (const id of ['deep-reasoning', 'independent-second-opinion', 'security-review']) {
    assert.ok(suit(id).has('work:verify'), id);
  }
  assert.equal(domainCoverage(STANDARD_SEAT_TOKENS['security-review'].suitableFor, ['security']), 'full');
  assert.equal(domainCoverage(STANDARD_SEAT_TOKENS['deep-reasoning'].suitableFor, ['security']), 'fallback');
  assert.equal(domainCoverage(STANDARD_SEAT_TOKENS['independent-second-opinion'].suitableFor, ['security']), 'fallback');
});

// ---------------------------------------------------------------------------
// §4 — how the flat lists read
// ---------------------------------------------------------------------------

test('suitableFor is OR within an axis and AND across declared axes', () => {
  const tokens = STANDARD_SEAT_TOKENS['standard-coding'].suitableFor;
  assert.equal(suitabilityMatch(tokens, { work: 'change', depth: 'mechanical' }), true);
  assert.equal(suitabilityMatch(tokens, { work: 'change', depth: 'bounded' }), true, 'OR among depth values');
  assert.equal(suitabilityMatch(tokens, { work: 'change', depth: 'open' }), false, 'AND across axes');
  assert.equal(suitabilityMatch(tokens, { work: 'verify' }), false);
  // An axis the task does not classify creates no contradiction; an axis the
  // seat does not declare creates no wildcard — both directions of §4.
  assert.equal(suitabilityMatch(tokens, { work: 'change' }), true);
  assert.equal(suitabilityMatch(STANDARD_SEAT_TOKENS['independent-second-opinion'].suitableFor, { work: 'verify', depth: 'open', flow: 'staged' }), true,
    'undeclared axes on the seat side assert nothing');
  assert.equal(suitabilityMatch(STANDARD_SEAT_TOKENS['independent-second-opinion'].suitableFor, { work: 'change' }), false);
  // Free strings on a custom seat never satisfy an axis.
  assert.equal(suitabilityMatch(['bounded coding tasks'], { work: 'change', depth: 'bounded' }), true,
    'non-token strings are not axis declarations');
});

test('avoidFor is OR over the whole list — one intersection warns', () => {
  const warn = STANDARD_SEAT_TOKENS['lightweight-recon'].avoidFor;
  assert.deepEqual(avoidWarnings(warn, { work: 'design', domains: [] }), ['work:design']);
  assert.deepEqual(avoidWarnings(warn, { work: 'enumerate', depth: 'open', domains: [] }), ['depth:open'],
    'one intersecting token already warns — no AND required');
  assert.deepEqual(avoidWarnings(warn, { work: 'enumerate', depth: 'mechanical', domains: [] }), []);
  // A shared domain warns even when work matches.
  assert.deepEqual(avoidWarnings(STANDARD_SEAT_TOKENS['spec-docs-writing'].avoidFor, { work: 'change', domains: ['software'] }), ['domain:software']);
});

test('domain coverage is the §4 priority group, not a score', () => {
  const required = ['software', 'tests'];
  assert.equal(domainCoverage(STANDARD_SEAT_TOKENS['standard-coding'].suitableFor, required), 'full');
  // Declaring part is fallback, same as omitting the axis — two of three
  // does not outrank one of three by score.
  assert.equal(domainCoverage(['domain:tests', 'domain:security'], ['software', 'tests', 'security']), 'fallback');
  assert.equal(domainCoverage(['domain:tests'], required), 'fallback');
  assert.equal(domainCoverage([], required), 'fallback', 'silence on domain is not universal support');
  // Extra unrelated domains create no advantage — full is full.
  assert.equal(domainCoverage(['domain:software', 'domain:tests', 'domain:prose'], required), 'full');
});

// ---------------------------------------------------------------------------
// §7.2 — reserved ids and token conflicts (unordered set compare)
// ---------------------------------------------------------------------------

test('reserved ids are exact-match; conflicts compare unordered sets', () => {
  assert.equal(isStandardSeatId('security-review'), true);
  assert.equal(isStandardSeatId('security-review-2'), false, 'a suffix makes it a custom name');
  assert.equal(isStandardSeatId('my-security-review'), false);
  const standard = STANDARD_SEAT_TOKENS['security-review'];
  // Same set, different order → in sync.
  assert.equal(seatTokenConflict({
    id: 'security-review',
    suitableFor: [...standard.suitableFor].reverse(),
    avoidFor: [...standard.avoidFor],
  }), null);
  // Divergent → conflict naming missing and extra tokens.
  const conflict = seatTokenConflict({ id: 'security-review', suitableFor: ['work:verify'], avoidFor: ['work:change', 'legacy-tag'] });
  assert.deepEqual(conflict.suitableFor.missing, ['work:design', 'domain:security']);
  assert.deepEqual(conflict.suitableFor.extra, []);
  assert.deepEqual(conflict.avoidFor.extra, ['legacy-tag']);
  // Notes are a local-only user annotation — never part of the divergence diff.
  assert.equal(seatTokenConflict({
    id: 'security-review',
    suitableFor: standard.suitableFor,
    avoidFor: standard.avoidFor,
    notes: 'user-overwritten local note',
  }), null, 'stored notes are not compared as divergence');
  // A custom id keeps free strings even when they match standard tokens.
  assert.equal(seatTokenConflict({ id: 'my-security-review', suitableFor: ['work:verify'], avoidFor: [] }), null);
  assert.equal(seatTokenConflict({ id: 'my-security-review', suitableFor: standard.suitableFor, avoidFor: standard.avoidFor }), null,
    'identical contents do not make a custom seat package-managed');
});

test('readCatalog reports tokenConflicts; catalogBinding refuses a conflicted seat', t => {
  const { repo } = fixture(t);
  const standard = STANDARD_SEAT_TOKENS['security-review'];
  const catalog = pool([
    seat('security-review', { suitableFor: ['work:verify', 'old-tag'], avoidFor: [] }),
    seat('helper-seat', { suitableFor: ['free text'] }),
    seat('luna-code', { suitableFor: standard.suitableFor, avoidFor: standard.avoidFor }),
  ]);
  writeCatalog(repo, catalog);
  const read = readCatalog(repo);
  assert.deepEqual(read.tokenConflicts.map(c => c.id), ['security-review']);
  const sha256 = read.sha256;
  assert.throws(
    () => catalogBinding(repo, 'peer', providers, { optionId: 'security-review', catalogSha256: sha256 }),
    /Token conflict/,
  );
  // Unrelated seats are untouched — a clean seat on the same file still binds.
  const bound = catalogBinding(repo, 'peer', providers, { optionId: 'luna-code', catalogSha256: sha256 });
  assert.equal(bound.routing.optionId, 'luna-code');
  // A custom seat with free strings is unaffected by the semantic layer.
  assert.equal(catalogBinding(repo, 'peer', providers, { optionId: 'helper-seat', catalogSha256: sha256 }).routing.optionId, 'helper-seat');
});

// ---------------------------------------------------------------------------
// route-decide / prepare — conflicted seats are not Jev candidates, and a
// receipt binds the vocabulary version it was issued under
// ---------------------------------------------------------------------------

test('route-decide excludes conflicted seats and records them on the receipt', async t => {
  const { repo, home } = fixture(t);
  const standard = STANDARD_SEAT_TOKENS['security-review'];
  writeCatalog(repo, pool([
    seat('security-review', { suitableFor: ['legacy-tag'], avoidFor: [] }),
    seat('luna-code', { suitableFor: standard.suitableFor, avoidFor: standard.avoidFor }),
    // A disabled seat is out of eligibility but its conflict still belongs on
    // the read path's report (§7.2).
    seat('deep-reasoning', { enabled: false, suitableFor: ['old-token'], avoidFor: [] }),
  ]));
  jevHome(home);
  let body;
  const result = await routeDecide({ repository: repo, brief: 'x' }, {
    home,
    fetchImpl: async (url, init) => { body = JSON.parse(init.body); return okFetch('luna-code')(url, init); },
  });
  assert.deepEqual(result.decision.context.candidates, ['luna-code']);
  assert.deepEqual(result.tokenConflicts, ['security-review', 'deep-reasoning'],
    'the receipt reports every catalog conflict, not only eligible ones');
  assert.equal(result.decision.context.vocabularyVersion, ROUTING_VOCABULARY_VERSION);
  assert.deepEqual(result.decision.context.tokenConflicts, ['security-review', 'deep-reasoning']);
  // §1/§9 — the state carries the compact token glossary under the bound
  // vocabulary version so bare axis:value strings are never unexplained.
  assert.equal(body.state.vocabulary.version, ROUTING_VOCABULARY_VERSION);
  assert.equal(body.state.vocabulary.tokens.length, 16);
  assert.deepEqual(Object.keys(body.state.vocabulary.tokens[0]).sort(), ['axis', 'boundary', 'id', 'sign']);
  assert.deepEqual(Object.keys(body.questions[ROUTE_DECISION_QUESTION].criteria), ['luna-code', ROUTE_DECLINE_CANDIDATE]);
  // The receipt binds the pool to 'luna-code' — and a receipt re-signed
  // under a different vocabulary version is refused at prepare.
  const reSign = decision => { const { sha256: _s, ...unsigned } = decision; return { ...unsigned, sha256: hash(canonicalJson(unsigned)) }; };
  const stale = reSign({ ...result.decision, context: { ...result.decision.context, vocabularyVersion: 'routing-criteria-v0' } });
  assert.throws(
    () => catalogBinding(repo, 'peer', providers, { optionId: 'luna-code', catalogSha256: result.catalogSha256, decision: stale }, home),
    /vocabulary routing-criteria-v0.*now speaks routing-criteria-v1/s,
  );
  const bound = catalogBinding(repo, 'peer', providers, { optionId: 'luna-code', catalogSha256: result.catalogSha256, decision: result.decision }, home);
  assert.equal(bound.routing.jev.decision, 'verified');
});

test('route-decide fails closed when every eligible seat is in conflict', async t => {
  const { repo, home } = fixture(t);
  writeCatalog(repo, pool([seat('security-review', { suitableFor: ['legacy-tag'], avoidFor: [] })]));
  jevHome(home);
  let fetched = false;
  await assert.rejects(
    routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: async () => { fetched = true; return okFetch('security-review')(); } }),
    error => error.code === 'jev-no-candidates' && /Token conflict/.test(error.message) && /security-review/.test(error.message),
  );
  assert.equal(fetched, false, 'conflict exclusion runs before any model call');
});

// ---------------------------------------------------------------------------
// §7.4 — the form/save flows on the client helpers
// ---------------------------------------------------------------------------

const seatForm = over => ({
  id: 'helper-seat', family: 'codex', model: 'gpt-5.6-luna', modeId: '', thinkingOptionId: '',
  enabled: true, features: '', feature: {}, suitableFor: 'free text', avoidFor: '', notes: 'n', custom: true,
  ...over,
});
const noDefs = () => [];

test('picker actions: standard lands on the canonical id, custom copy is suggested', () => {
  const archetype = PEER_SEAT_ARCHETYPES.find(a => a.id === 'security-review');
  const standard = peerSeatFromArchetype(archetype);
  assert.equal(standard.id, 'security-review', 'standard add uses the exact canonical id — never a suffix');
  assert.equal(standard.custom, false);
  assert.equal(standard.enabled, false, 'parked until the Human binds a runtime');
  // "Create a custom seat from template": template content on a suggested non-reserved id.
  const fromTemplate = customSeatFromArchetype(archetype, ['security-review']);
  assert.equal(fromTemplate.id, 'security-review-2');
  assert.equal(fromTemplate.custom, true);
  assert.equal(fromTemplate.enabled, false);
  assert.equal(fromTemplate.family, '');
  assert.deepEqual(fromTemplate.suitableFor.split('\n'), STANDARD_SEAT_TOKENS['security-review'].suitableFor);
  const again = customSeatFromArchetype(archetype, ['security-review', 'security-review-2']);
  assert.equal(again.id, 'security-review-3', 'incrementing suffix');
  assert.equal(customSeatIdError(again.id, []), null);
});

test('customSeatCopy duplicates the viewed row under a custom id, disabled', () => {
  const original = seatForm({ id: 'security-review', custom: false, enabled: true, modeId: 'bypass', features: '{"auto_accept":true}' });
  const copy = customSeatCopy(original, ['security-review']);
  assert.equal(copy.id, 'security-review-2');
  assert.equal(copy.custom, true);
  assert.equal(copy.enabled, false, 'the copy is not auto-enabled');
  assert.equal(copy.modeId, 'bypass', 'binding content is kept');
  assert.equal(copy.features, '{"auto_accept":true}');
});

test('customSeatIdError refuses reserved names, duplicates and bad syntax', () => {
  assert.match(customSeatIdError('security-review', []), /reserved standard-seat id.*security-review-2/s);
  assert.match(customSeatIdError('helper-seat', ['helper-seat']), /already used/);
  assert.match(customSeatIdError('Bad Id', []), /must match/);
  assert.equal(customSeatIdError('security-review-2', ['security-review']), null);
});

test('convertSeatToCustom renames and retargets quotaFallback in one draft edit', () => {
  const form = {
    ...emptyPeerPoolForm(),
    seats: [seatForm({ id: 'security-review', custom: false }), seatForm({ id: 'helper-seat' })],
    quotaFallbackId: 'security-review',
  };
  const next = convertSeatToCustom(form, 0, 'sec-custom');
  assert.equal(next.seats[0].id, 'sec-custom');
  assert.equal(next.seats[0].custom, true);
  assert.equal(next.quotaFallbackId, 'sec-custom', 'designation retargeted to the new id');
  assert.equal(next.seats[1].id, 'helper-seat', 'unrelated seats untouched');
  // A designation on another seat is not moved by the conversion.
  const other = convertSeatToCustom({ ...form, quotaFallbackId: 'helper-seat' }, 0, 'sec-custom');
  assert.equal(other.quotaFallbackId, 'helper-seat');
});

test('rename/convert keeps passthrough fields via the load-time storedId', () => {
  // A stored foreign key the form does not model survives a rename and a
  // convert-to-custom because the stored lookup follows storedId, not the
  // edited id (§7.4.D).
  const stored = seat('keeper', { suitableFor: ['free text'], quotaNote: 'external metadata' });
  const form = peerPoolForm(pool([stored]));
  assert.equal(form.seats[0].storedId, 'keeper', 'load records the stored id');
  const storedOptions = new Map([[stored.id, stored]]);
  // Plain rename: id changes, passthrough survives.
  const renamed = { ...form, seats: [{ ...form.seats[0], id: 'keeper-renamed' }] };
  const renamedBuild = buildPeerPool(renamed, noDefs, storedOptions);
  assert.ok('pool' in renamedBuild, JSON.stringify(renamedBuild));
  assert.equal(renamedBuild.pool.options[0].quotaNote, 'external metadata');
  // Convert-to-custom: same preservation.
  const converted = convertSeatToCustom(form, 0, 'keeper-custom');
  const convertedBuild = buildPeerPool(converted, noDefs, storedOptions);
  assert.ok('pool' in convertedBuild, JSON.stringify(convertedBuild));
  assert.equal(convertedBuild.pool.options[0].quotaNote, 'external metadata');
});

test('the decline sentinel is refused as a seat id at every gate', () => {
  assert.match(customSeatIdError('no-suitable-option', []), /decline sentinel/);
  const built = buildPeerPool({ ...emptyPeerPoolForm(), seats: [seatForm({ id: 'no-suitable-option' })] }, noDefs);
  assert.ok('error' in built && /decline sentinel/.test(built.error));
  // The stored-data validator refuses it too — a pool file carrying the
  // sentinel must fail the same way the form does.
  assert.throws(() => validateCatalog(pool([seat('no-suitable-option')])), /decline sentinel/);
});

test('suggestCustomSeatId always returns a valid non-reserved id', () => {
  assert.equal(suggestCustomSeatId('', []), 'seat-2', 'empty base falls back to "seat"');
  assert.equal(suggestCustomSeatId('  ', ['seat-2']), 'seat-3');
  assert.equal(suggestCustomSeatId('1bad', []), 'seat-2', 'invalid base is replaced, not suffixed');
  assert.equal(suggestCustomSeatId('security-review', []), 'security-review-2');
});

test('seatManagement and formSeatConflict follow the draft row', () => {
  const standard = STANDARD_SEAT_TOKENS['security-review'];
  const inSync = seatForm({ id: 'security-review', custom: false, suitableFor: standard.suitableFor.join('\n'), avoidFor: standard.avoidFor.join('\n') });
  assert.equal(seatManagement(inSync), 'package-managed');
  assert.equal(formSeatConflict(inSync), null);
  const divergent = { ...inSync, suitableFor: 'old-tag\nwork:verify' };
  assert.equal(seatManagement(divergent), 'package-managed', 'a conflicted seat still carries the Package-managed label');
  assert.ok(formSeatConflict(divergent) !== null);
  // A Custom row typed onto a reserved name stays Custom — the reserved-name
  // error guards it, not an automatic flip to Package-managed.
  const renamed = { ...inSync, custom: true };
  assert.equal(seatManagement(renamed), 'custom');
  assert.equal(formSeatConflict(renamed), null);
  assert.match(customSeatIdError(renamed.id, []), /reserved/);
});

test('buildPeerPool refuses conflicts and reserved-name customs with seatIndex', () => {
  const standard = STANDARD_SEAT_TOKENS['security-review'];
  const okStandard = seatForm({ id: 'security-review', custom: false, suitableFor: standard.suitableFor.join('\n'), avoidFor: standard.avoidFor.join('\n') });
  const built = buildPeerPool({ ...emptyPeerPoolForm(), seats: [okStandard] }, noDefs);
  assert.ok('pool' in built, JSON.stringify(built));
  // Unresolved token conflict → build error pointing at the seat.
  const conflicted = { ...okStandard, suitableFor: 'work:verify\nlegacy-tag' };
  const refused = buildPeerPool({ ...emptyPeerPoolForm(), seats: [seatForm(), conflicted] }, noDefs);
  assert.ok('error' in refused);
  assert.equal(refused.seatIndex, 1);
  assert.match(refused.error, /Token conflict/);
  // A Custom row carrying a reserved name → reserved-name error.
  const stolen = buildPeerPool({ ...emptyPeerPoolForm(), seats: [seatForm({ id: 'security-review', custom: true })] }, noDefs);
  assert.ok('error' in stolen);
  assert.equal(stolen.seatIndex, 0);
  assert.match(stolen.error, /reserved standard-seat id/);
  // Custom seats keep free strings — same shape rule as validateCatalog.
  const free = buildPeerPool({ ...emptyPeerPoolForm(), seats: [seatForm({ suitableFor: 'anything\nfree form' })] }, noDefs);
  assert.ok('pool' in free, JSON.stringify(free));
  assert.deepEqual(free.pool.options[0].suitableFor, ['anything', 'free form']);
  // A stored conflict surfaces from a loaded pool — peerPoolForm marks it
  // package-managed, so the draft cannot be re-saved unresolved.
  const loaded = peerPoolForm(pool([seat('security-review', { suitableFor: ['legacy-tag'], avoidFor: [] })]));
  const loadedBuild = buildPeerPool(loaded, noDefs);
  assert.ok('error' in loadedBuild && /Token conflict/.test(loadedBuild.error));
});

test('legacyImportAllowed requires legacy data, an absent pool and a truly untouched draft', () => {
  const form = emptyPeerPoolForm();
  const legacy = pool([seat('old-seat')]);
  assert.equal(legacyImportAllowed({ legacy, pool: null }, form, false), true);
  assert.equal(legacyImportAllowed({ legacy: null, pool: null }, form, false), false, 'no legacy data');
  assert.equal(legacyImportAllowed({ legacy, pool: pool([]) }, form, false), false, 'a stored pool exists');
  assert.equal(legacyImportAllowed(null, form, false), false, 'read never succeeded');
  assert.equal(legacyImportAllowed({ legacy, pool: null }, { ...form, seats: [seatForm()] }, false), false, 'draft has seats');
  assert.equal(legacyImportAllowed({ legacy, pool: null }, form, true), false, 'policy/fallback edits count as dirty');
});

// ---------------------------------------------------------------------------
// §9 — Jev guidance content and versioning
// ---------------------------------------------------------------------------

test('the Jev guidance states the vocabulary rules, not just the word list', () => {
  assert.ok(JEV_SUITABILITY_GUIDANCE.includes(ROUTING_VOCABULARY_VERSION), 'guidance carries its version');
  for (const phrase of [
    'OR among values of the same axis',
    'AND across the axes',
    'full domain coverage is chosen before cost',
    'advisory warning, not a ban',
    'no-suitable-option',
  ]) {
    assert.ok(JEV_SUITABILITY_GUIDANCE.includes(phrase), `guidance states: ${phrase}`);
  }
  // §4 step 5 — the settled tie-break order, exactly: reliable cost metadata,
  // then lighter thinking on same provider/model, then ascending option.id.
  for (const phrase of [
    'lowest expected execution cost from trustworthy metadata',
    'lighter thinking option',
    'smallest option id',
    'never decline because of a tie',
  ]) {
    assert.ok(JEV_SUITABILITY_GUIDANCE.includes(phrase), `guidance states tie-break: ${phrase}`);
  }
  assert.ok(!JEV_SUITABILITY_GUIDANCE.includes('model size'), 'no unratified metadata in the tie-break');
  // Wave 2 — the thinking surface is real data now: the guidance must explain
  // what thinkingOptionId means, that all-null seats tie, and that an unclear
  // provider order falls back to id. §7.1 — null must stay neutral: it covers
  // both the provider-chosen default level and models with no thinking knob.
  for (const phrase of [
    'thinkingOptionId',
    'provider default',
    'provider\'s own default level',
    'no separate thinking knob',
    'all-null seats tie',
    'thinking order is unclear',
  ]) {
    assert.ok(JEV_SUITABILITY_GUIDANCE.includes(phrase), `guidance explains the thinking surface: ${phrase}`);
  }
  // No price field was added — "no reliable price exists" remains a
  // theoretical earlier tier only, not shipped metadata.
  assert.ok(!JEV_SUITABILITY_GUIDANCE.includes('option.price'), 'no price field promised');
  // §1/§9 — the glossary ships every standard token's packaged sign and
  // boundary so a bare axis:value never reaches Jev unexplained.
  assert.equal(JEV_TOKEN_DEFINITIONS.length, 16);
  for (const def of JEV_TOKEN_DEFINITIONS) {
    assert.ok(def.id.includes(':') && def.sign.length > 0 && def.boundary.length > 0, def.id);
  }
});
