// tests/jev.test.mjs — Jev transport (plugin/server/runtime/cli/jev.ts), routing consumer
// (plugin/server/runtime/cli/jev-routing.ts), the prepare receipt gate (plugin/server/runtime/cli/routing.ts) and the
// hasKey-only status surface. Every network interaction is mocked through the
// injected fetchImpl seam — no real OpenRouter/TypeSafe calls, ever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { install, json, hash } from '../plugin/server/runtime/cli/package.ts';
import { launchPlan, launchCheck } from '../plugin/server/runtime/cli/launch.ts';
import { readCatalog, catalogBinding, optionExclusions, ROUTE_DECLINE_CANDIDATE, ROUTE_DECISION_QUESTION } from '../plugin/server/runtime/cli/routing.ts';
import { routeDecide } from '../plugin/server/runtime/cli/jev-routing.ts';
import { readJevConfig, readJevKey, resolveJev, verifyReceipt, assertRedacted, askJev, askChoice, askScore, askNoul, JevError, canonicalJson } from '../plugin/server/runtime/cli/jev.ts';
import { fakeOrKey, fakeTsKey, fakeAwsKey, fakePem } from './fake-secrets.mjs';
import { runtimeStatus } from '../plugin/server/runtime/cli/runtime-state.ts';

const SYNTH_KEY = fakeOrKey('synthetic-test-key-000');

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/jev-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, installed: join(dir, 'installed'), repo: join(dir, 'repo'), home: join(dir, 'home') };
}

const testCatalog = () => ({ version: 1, policy: 'Test pool.', quotaFallback: { enabled: false, optionId: null }, options: [
  { id: 'luna-code', provider: 'codex', roles: ['peer'], model: 'gpt-5.6-luna', enabled: true, availability: 'ready', priority: 20, suitableFor: ['coding'], avoidFor: [], notes: 'coding seat' },
  { id: 'luna-reason', provider: 'codex', roles: ['peer'], model: 'gpt-5.6-luna', enabled: true, availability: 'ready', priority: 10, suitableFor: ['reasoning'], avoidFor: [], notes: 'reasoning seat', thinkingOptionId: 'xhigh' },
  { id: 'paused-seat', provider: 'codex', roles: ['peer'], model: 'gpt-5.6-luna', enabled: true, availability: 'paused', priority: 30, suitableFor: ['coding'], avoidFor: [], notes: 'paused seat' },
  { id: 'off-seat', provider: 'codex', roles: ['peer'], model: 'gpt-5.6-luna', enabled: false, availability: 'ready', priority: 40, suitableFor: ['coding'], avoidFor: [], notes: 'disabled seat' },
  { id: 'lead-only', provider: 'codex', roles: ['lead'], model: 'gpt-5.6-luna', enabled: true, availability: 'ready', priority: 50, suitableFor: ['review'], avoidFor: [], notes: 'lead seat' },
] });
function catalogFixture(repo) {
  mkdirSync(join(repo, '.paseo-slp'), { recursive: true });
  writeFileSync(join(repo, '.paseo-slp/slp-routing.json'), json(testCatalog()));
  return { sha256: readCatalog(repo).sha256 };
}

// Per-daemon Jev state under <home>/slp-runtime/state — mirrors the plugin's
// file layout. keyMode/key null skips the key file entirely.
function jevHome(home, { enabled = true, routing = true, key = SYNTH_KEY, keyMode = 0o600, config = null } = {}) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), json({ version: 1 }));
  const state = join(home, 'slp-runtime', 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'jev.json'), json(config ?? {
    schemaVersion: 1, enabled, capabilities: { routing },
    provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' },
  }), { mode: 0o600 });
  const keyPath = join(state, 'jev-openrouter.key');
  if (key !== null) writeFileSync(keyPath, `${key}\n`, { mode: keyMode });
  else if (existsSync(keyPath)) rmSync(keyPath);
  return home;
}

const providers = ['slp-codex-peer', 'slp-codex-lead'].map(id => ({ id, enabled: true, status: 'available' }));
const choiceAnswer = choice => ({ [ROUTE_DECISION_QUESTION]: { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } } });
const okFetch = (answers, extra = {}) => async () => ({ ok: true, json: async () => ({ id: 'gen-dec-mock', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', answers, usage: { cost: 0.0001, input_tokens: 10, output_tokens: 5 }, ...extra }) });
const httpFetch = status => async () => ({ ok: false, status, json: async () => ({ error: { code: status, message: `synthetic HTTP ${status}` } }) });
const netFail = async () => { throw new TypeError('fetch failed'); };
const timeoutFail = async () => { const error = new Error('The operation timed out'); error.name = 'TimeoutError'; throw error; };
const jevCode = async promise => { try { await promise; } catch (error) { assert.ok(error instanceof JevError, `expected JevError, got ${error}`); return error.code; } throw new Error('expected rejection'); };

// ---------------------------------------------------------------------------
// Config resolution + toggles
// ---------------------------------------------------------------------------

test('jev config resolves per daemon; absent config is OFF, not an error', t => {
  const { home } = fixture(t);
  mkdirSync(home, { recursive: true });
  assert.equal(readJevConfig(home), null);
  jevHome(home);
  const config = readJevConfig(home);
  assert.equal(config.enabled, true);
  assert.equal(config.capabilities.routing, true);
  const { provider, key } = resolveJev(home, 'routing');
  assert.equal(provider.endpoint, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(provider.model, 'typesafe/jev-1.13');
  assert.equal(key, SYNTH_KEY);
});

test('jev toggles fail closed: disabled config, missing key, absent home', async t => {
  const { home, repo } = fixture(t);
  catalogFixture(repo);
  // Every rejection below must land BEFORE any transport call — a fetchImpl
  // that records invocation proves the fail-closed boundary stays client-side.
  let fetched = false;
  const noFetch = async () => { fetched = true; throw new Error('network must not be reached'); };
  const decide = homeArg => routeDecide({ repository: repo, brief: 'x' }, { home: homeArg ?? home, fetchImpl: noFetch });
  jevHome(home, { enabled: false });
  assert.equal(await jevCode(decide()), 'jev-disabled');
  jevHome(home, { key: null });
  assert.equal(await jevCode(decide()), 'jev-key-missing');
  assert.equal(await jevCode(decide(join(home, 'absent'))), 'jev-unconfigured');
  assert.equal(fetched, false);
});

test('enabled without capabilities.routing runs SHADOW — receipt emitted, armed=false', async t => {
  const { home, repo } = fixture(t);
  catalogFixture(repo);
  jevHome(home, { routing: false });
  const result = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  assert.equal(result.optionId, 'luna-code');
  assert.equal(result.decision.context.armed, false);
  assert.equal(verifyReceipt(result.decision), true);
  // Strict consumers still get the capability gate — shadow is opt-in.
  assert.throws(() => resolveJev(home, 'routing'), error => error instanceof JevError && error.code === 'jev-capability-off');
  // And the armed flag flips true once the capability is armed.
  jevHome(home);
  const armed = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  assert.equal(armed.decision.context.armed, true);
});

test('jev config validation rejects aliases, non-https endpoints and corrupt files', t => {
  const { home } = fixture(t);
  for (const [name, config] of [
    ['alias model', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', model: 'typesafe/jev-latest' } }],
    ['preview alias', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', model: 'jev-preview' } }],
    ['http endpoint', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', baseUrl: 'http://openrouter.ai', model: 'typesafe/jev-1.13' } }],
    ['undocumented path', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/v1/x', model: 'typesafe/jev-1.13' } }],
    ['api v2 path', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v2', model: 'typesafe/jev-1.13' } }],
    ['query string', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/?x=1', model: 'typesafe/jev-1.13' } }],
    ['unknown kind', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openai', model: 'jev-1.13.0' } }],
    // Cross-kind confusion: each shape is pinned to its own kind.
    ['openrouter shape on typesafe', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'typesafe', model: 'typesafe/jev-1.13' } }],
    ['typesafe shape on openrouter', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', model: 'jev-1.13.0' } }],
    ['typesafe alias', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'typesafe', model: 'jev-latest' } }],
    ['typesafe http', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'typesafe', baseUrl: 'http://api.typesafe.ai', model: 'jev-1.13.0' } }],
    ['typesafe query', { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'typesafe', baseUrl: 'https://api.typesafe.ai/?x=1', model: 'jev-1.13.0' } }],
  ]) {
    jevHome(home, { config });
    assert.throws(() => readJevConfig(home), /jev-config-invalid|pinned Jev|https|provider\.kind|carry a path/, name);
  }
  jevHome(home);
  writeFileSync(join(home, 'slp-runtime', 'state', 'jev.json'), '{not json');
  assert.throws(() => readJevConfig(home), /not valid JSON/);
});

test('the documented prefixed baseUrl …/api/v1 is accepted and normalized', t => {
  const { home } = fixture(t);
  for (const baseUrl of ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/']) {
    jevHome(home, { config: { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', baseUrl, model: 'typesafe/jev-1.13' } } });
    const { provider } = resolveJev(home, 'routing');
    assert.equal(provider.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(provider.endpoint, 'https://openrouter.ai/api/v1/api/alpha/decisions');
  }
  // A missing baseUrl defaults to the bare origin on the CLI side too.
  jevHome(home, { config: { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' } } });
  assert.equal(readJevConfig(home).provider.baseUrl, 'https://openrouter.ai');
});

// First-party TypeSafe kind (docs.typesafe.ai contract): pinned bare
// jev-<semver> model, /v1/systemone endpoint, baseUrl may carry an
// origin+path prefix for a custom endpoint — and the request body must NOT
// carry OpenRouter's provider.allow_fallbacks.
test('the typesafe kind resolves /v1/systemone with its own model pin and sends no provider field', async t => {
  const { repo, home } = fixture(t);
  catalogFixture(repo);
  const keyPath = join(home, 'slp-runtime', 'state', 'jev-typesafe.key');
  for (const baseUrl of [undefined, 'https://api.typesafe.ai', 'https://jev.internal.example.com/proxy/v1']) {
    jevHome(home, { key: null, config: { schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'typesafe', ...(baseUrl ? { baseUrl } : {}), model: 'jev-1.13.0' } } });
    writeFileSync(keyPath, fakeTsKey('synthetic-test-key') + '\n', { mode: 0o600 });
    const { provider } = resolveJev(home, 'routing');
    const expectedBase = (baseUrl ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
    assert.equal(provider.baseUrl, expectedBase);
    assert.equal(provider.endpoint, `${expectedBase}/v1/systemone`);
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      // Native response shape: model + answers + usage — no id/provider.
      return { ok: true, json: async () => ({ model: 'jev-1.13.0', answers: choiceAnswer('luna-code'), usage: { input_tokens: 10, output_tokens: 5 } }) };
    };
    const result = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl });
    assert.equal(result.optionId, 'luna-code');
    assert.equal(calls.at(-1).url, `${expectedBase}/v1/systemone`);
    const body = JSON.parse(calls.at(-1).init.body);
    assert.equal(body.model, 'jev-1.13.0');
    assert.ok(!('provider' in body), 'native API must not receive provider.allow_fallbacks');
    assert.equal(result.decision.provider.kind, 'typesafe');
    assert.equal(verifyReceipt(result.decision), true, 'receipt verifies under the typesafe pin');
  }
  // A receipt pinning an openrouter-shaped model under kind typesafe (or vice
  // versa) must not verify.
  const { receipt } = await askChoice(
    { name: 'q', instructions: 'pick', criteria: { a: 'x', b: 'y' }, provider: { kind: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0' }, key: 'k', state: 's' },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ model: 'jev-1.13.0', answers: { q: { type: 'choice', choice: 'a' } } }) }) },
  );
  assert.throws(() => verifyReceipt({ ...receipt, model: 'typesafe/jev-1.13' }), /pinned Jev model/);
  assert.throws(() => verifyReceipt({ ...receipt, provider: { kind: 'openrouter', endpoint: receipt.provider.endpoint } }), /pinned Jev model/);
});

test('key file must be regular, 0600-class and non-empty', t => {
  const { home } = fixture(t);
  jevHome(home, { keyMode: 0o644 });
  assert.throws(() => readJevKey(home, 'openrouter'), /group\/other-accessible/);
  chmodSync(join(home, 'slp-runtime', 'state', 'jev-openrouter.key'), 0o600);
  assert.equal(readJevKey(home, 'openrouter'), SYNTH_KEY);
  jevHome(home, { key: '   ' });
  assert.throws(() => readJevKey(home, 'openrouter'), /empty or contains whitespace/);
});

// ---------------------------------------------------------------------------
// route-decide — the explicit helper path
// ---------------------------------------------------------------------------

test('route-decide asks Jev over the eligible set and returns a verifiable receipt', async t => {
  const { repo, home } = fixture(t);
  const { sha256 } = catalogFixture(repo);
  jevHome(home);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return okFetch(choiceAnswer('luna-code'))(url, init);
  };
  const result = await routeDecide({ repository: repo, brief: 'implement the jev transport' }, { home, fetchImpl });
  assert.equal(result.optionId, 'luna-code');
  assert.equal(result.declined, false);
  assert.equal(result.catalogSha256, sha256);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${SYNTH_KEY}`);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'typesafe/jev-1.13');
  assert.deepEqual(body.provider, { allow_fallbacks: false });
  // Candidate set = exactly the eligible options + the decline sentinel —
  // paused, disabled and lead-only seats are excluded deterministically.
  const criteria = body.questions[ROUTE_DECISION_QUESTION].criteria;
  assert.deepEqual(Object.keys(criteria), ['luna-code', 'luna-reason', ROUTE_DECLINE_CANDIDATE]);
  assert.deepEqual(result.decision.context.candidates, ['luna-code', 'luna-reason']);
  // notes (Vietnamese) and priority never enter the state; thinkingOptionId
  // ships on every option — explicit null when the catalog omits it.
  for (const option of body.state.options) {
    assert.deepEqual(Object.keys(option), ['id', 'provider', 'model', 'thinkingOptionId', 'suitableFor', 'avoidFor']);
  }
  assert.equal(body.state.options.find(o => o.id === 'luna-code').thinkingOptionId, null, 'absent → explicit null');
  assert.equal(body.state.options.find(o => o.id === 'luna-reason').thinkingOptionId, 'xhigh', 'catalog value ships verbatim');
  assert.match(criteria['luna-code'], /thinking: provider default/, 'criteria prose renders null as provider default');
  assert.match(criteria['luna-reason'], /thinking: xhigh/, 'criteria prose renders the catalog thinking id');
  assert.match(body.questions[ROUTE_DECISION_QUESTION].instructions, /thinking option/, 'instructions name the thinking field');
  assert.equal(body.state.task, 'implement the jev transport');
  assert.deepEqual(result.warnings, []);
  assert.equal(verifyReceipt(result.decision), true);
  assert.equal(result.decision.model, 'typesafe/jev-1.13');
  assert.equal(result.decision.resolvedModel, 'typesafe/jev-1.13-20260917');
  assert.equal(result.decision.context.catalogSha256, sha256);
  assert.equal(result.decision.context.capability, 'routing');
  assert.equal(result.decision.attempts, 1);
  assert.ok(typeof result.decision.issuedAt === 'string' && result.decision.latencyMs >= 0);
  assert.equal(result.decision.answers[ROUTE_DECISION_QUESTION].confidence, 0.9);
});

test('verbatim suitability tokens inside the brief are flagged, never stripped or classified by the caller', async t => {
  const { repo, home } = fixture(t);
  catalogFixture(repo);
  jevHome(home);
  let body;
  const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return okFetch(choiceAnswer('luna-code'))(); };
  // The brief ships verbatim — tokens stay in the text — but every standard
  // token hit is flagged for the caller and the instructions tell Jev to read
  // them as unverified mentions, so quoting the vocabulary cannot
  // pre-classify the task.
  const brief = 'change the guard in work:change style; domain:software and domain:security obligations, plus a nonstandard axis:custom label';
  const result = await routeDecide({ repository: repo, brief }, { home, fetchImpl });
  assert.equal(result.optionId, 'luna-code');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /3 verbatim suitability token\(s\) \(work:change, domain:software, domain:security\)/);
  assert.match(result.warnings[0], /unverified mentions/);
  assert.equal(body.state.task, brief, 'the brief text ships verbatim — nothing is rewritten or stripped');
  const instructions = body.questions[ROUTE_DECISION_QUESTION].instructions;
  assert.match(instructions, /unverified mentions, not the caller's classification/);
  // A nonstandard axis:value string is free text — flagged only when it is a
  // verbatim standard token.
  const clean = await routeDecide({ repository: repo, brief: 'migrate the queue consumer to the new topic naming' }, { home, fetchImpl });
  assert.deepEqual(clean.warnings, []);
  assert.equal(verifyReceipt(result.decision), true);
});

test('route-decide records the decline verdict instead of inventing a seat', async t => {
  const { repo, home } = fixture(t);
  catalogFixture(repo);
  jevHome(home);
  const result = await routeDecide({ repository: repo, brief: 'a task no pool seat covers' }, { home, fetchImpl: okFetch(choiceAnswer(ROUTE_DECLINE_CANDIDATE)) });
  assert.equal(result.declined, true);
  assert.equal(result.optionId, null);
  assert.equal(verifyReceipt(result.decision), true);
  assert.equal(result.decision.answers[ROUTE_DECISION_QUESTION].choice, ROUTE_DECLINE_CANDIDATE);
});

test('route-decide surfaces live-pool drift warnings alongside the receipt', async t => {
  const { repo, home } = fixture(t);
  catalogFixture(repo);
  jevHome(home);
  // The live pool disagrees on the chosen seat's model — the repository
  // catalog already won the binding; the decision run reports the drift.
  const pool = testCatalog();
  pool.options.find(option => option.id === 'luna-code').model = 'gpt-5.6-drift';
  writeFileSync(join(home, 'slp-runtime', 'state', 'peer-pool.json'), json(pool));
  const result = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  assert.equal(result.optionId, 'luna-code');
  assert.equal(result.poolDrift.identical, false);
  assert.equal(result.poolDrift.userPoolPath, join(home, 'slp-runtime', 'state', 'peer-pool.json'));
  assert.match(result.warnings.find(w => w.includes('differs from the live user-scope pool')), /"gpt-5.6-luna" \(catalog\) vs "gpt-5.6-drift" \(pool\)/);
  // Identical sources leave no drift warning.
  writeFileSync(join(home, 'slp-runtime', 'state', 'peer-pool.json'), json(testCatalog()));
  const clean = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  assert.deepEqual(clean.warnings, []);
});

test('route-decide fails closed when every option is excluded', async t => {
  const { repo, home, dir } = fixture(t);
  const catalog = testCatalog();
  catalog.options.forEach(option => { option.enabled = false; });
  mkdirSync(join(repo, '.paseo-slp'), { recursive: true });
  writeFileSync(join(repo, '.paseo-slp/slp-routing.json'), json(catalog));
  jevHome(home);
  let fetched = false;
  await assert.rejects(
    routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: async () => { fetched = true; return okFetch(choiceAnswer('luna-code'))(); } }),
    error => error instanceof JevError && error.code === 'jev-no-candidates' && /luna-code: disabled/.test(error.message),
  );
  assert.equal(fetched, false, 'eligibility is computed before any model call');
});

test('route-decide rejects invalid input and a decline-sentinel collision', async t => {
  const { repo, home, dir } = fixture(t);
  catalogFixture(repo);
  jevHome(home);
  await assert.rejects(routeDecide({ repository: repo }, { home }), /requires brief/);
  await assert.rejects(routeDecide({ repository: repo, brief: '   ' }, { home }), /requires brief/);
  // Structured briefs were removed (F10): object/array forms — including a
  // signals field that pre-classifies with Jev's own vocabulary — are
  // request-invalid, and the error says why.
  for (const brief of [
    { task: 'implement the jev transport', tags: ['implementation'] },
    { task: 'change the guard', signals: ['work:change', 'depth:bounded'] },
    ['work:change', 'depth:bounded'],
    { task: 'x' },
  ]) {
    await assert.rejects(routeDecide({ repository: repo, brief }, { home }),
      error => error instanceof JevError && error.code === 'jev-request-invalid' && /nonempty string of raw task/.test(error.message));
  }
  await assert.rejects(routeDecide({ repository: join(dir, 'missing'), brief: 'x' }, { home }), /absolute repository/);
  await assert.rejects(routeDecide({ repository: repo, brief: 'x', role: 'peer-architect' }, { home }), /role must be one of/);
  const catalog = testCatalog();
  catalog.options.push({ id: ROUTE_DECLINE_CANDIDATE, provider: 'codex', roles: ['peer'], model: 'gpt-5.6-luna', enabled: true, availability: 'ready', priority: 1, suitableFor: [], avoidFor: [], notes: 'collision' });
  writeFileSync(join(repo, '.paseo-slp/slp-routing.json'), json(catalog));
  // The sentinel id is refused at the catalog gate — the decision layer never
  // sees a pool whose seat collides with it.
  await assert.rejects(routeDecide({ repository: repo, brief: 'x' }, { home }), /decline sentinel/);
});

// ---------------------------------------------------------------------------
// Transport errors — all fail closed; at most one bounded retry
// ---------------------------------------------------------------------------

test('network, timeout and HTTP failures fail closed', async t => {
  const { repo, home } = fixture(t);
  catalogFixture(repo);
  jevHome(home);
  const decide = fetchImpl => routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl });
  assert.equal(await jevCode(decide(netFail)), 'jev-network');
  assert.equal(await jevCode(decide(timeoutFail)), 'jev-timeout');
  assert.equal(await jevCode(decide(httpFetch(401))), 'jev-http');
  assert.equal(await jevCode(decide(httpFetch(402))), 'jev-http');
  let calls = 0;
  const counting = status => async () => { calls += 1; return httpFetch(status)(); };
  await assert.rejects(decide(counting(400)), /HTTP 400/);
  assert.equal(calls, 1, 'client errors are not retried');
});

test('one bounded retry on transient failures — never a loop', async t => {
  const { repo, home } = fixture(t);
  catalogFixture(repo);
  jevHome(home);
  const decide = fetchImpl => routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl });
  let calls = 0;
  const flaky = async () => { calls += 1; return calls === 1 ? httpFetch(500)() : okFetch(choiceAnswer('luna-code'))(); };
  const result = await decide(flaky);
  assert.equal(result.optionId, 'luna-code');
  assert.equal(calls, 2);
  assert.equal(result.decision.attempts, 2);
  calls = 0;
  const alwaysDown = async () => { calls += 1; return httpFetch(503)(); };
  await assert.rejects(decide(alwaysDown), /HTTP 503/);
  assert.equal(calls, 2, 'at most one retry — the third call never happens');
});

test('transient retries resend the same payload with a fresh timeout and record the successful attempt', async () => {
  const request = {
    provider: { kind: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0' },
    key: 'synthetic-key', state: { task: 'pick' },
    name: 'q', instructions: 'pick one', criteria: { a: 'first' },
  };
  const abortFail = async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
  for (const fail of [netFail, timeoutFail, abortFail, httpFetch(429), httpFetch(529)]) {
    const calls = [];
    const result = await askChoice(request, {
      now: () => new Date('2026-09-22T00:00:00Z'),
      fetchImpl: async (url, init) => {
        calls.push({ url, ...init });
        if (calls.length === 1) return fail();
        return okFetch({ q: { type: 'choice', choice: 'a' } }, { model: 'jev-1.13.0' })();
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, request.provider.endpoint);
    assert.equal(calls[1].url, calls[0].url);
    assert.equal(calls[1].body, calls[0].body);
    assert.deepEqual(calls[1].headers, calls[0].headers);
    assert.notEqual(calls[1].signal, calls[0].signal);
    assert.equal(result.receipt.attempts, 2);
    assert.equal(result.receipt.issuedAt, '2026-09-22T00:00:00.000Z');
    assert.equal(verifyReceipt(result.receipt), true);
  }
  let calls = 0;
  await assert.rejects(askChoice(request, {
    retries: 0,
    fetchImpl: async () => { calls += 1; return netFail(); },
  }), error => error.code === 'jev-network');
  assert.equal(calls, 1, 'an explicit zero retry budget makes exactly one request');
});

test('malformed responses and out-of-set choices fail closed', async t => {
  const { repo, home } = fixture(t);
  catalogFixture(repo);
  jevHome(home);
  const decide = async fetchImpl => {
    let calls = 0;
    try {
      return await routeDecide({ repository: repo, brief: 'x' }, { home,
        fetchImpl: async (...args) => { calls += 1; return fetchImpl(...args); } });
    } finally {
      assert.equal(calls, 1, 'successful HTTP responses with invalid answers or JSON are never retried');
    }
  };
  assert.equal(await jevCode(decide(async () => ({ ok: true, json: async () => ({ not: 'a decision' }) }))), 'jev-response');
  assert.equal(await jevCode(decide(okFetch(choiceAnswer('no-such-option')))), 'jev-invalid-choice');
  assert.equal(await jevCode(decide(okFetch({ [ROUTE_DECISION_QUESTION]: { type: 'noul', noul: 0.5 } }))), 'jev-response');
  assert.equal(await jevCode(decide(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }))), 'jev-response');
});

test('the three typed primitives share the transport seam — future consumers never rewrite it', async t => {
  const { home } = fixture(t);
  jevHome(home);
  const { provider, key } = resolveJev(home, 'routing');
  const base = { provider, key, state: 'demo state' };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const answers = { q: { type: 'score', score: 0.7, confidence: 0.8 }, n: { type: 'noul', noul: 0.3 }, c: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } } };
    return { ok: true, json: async () => ({ model: 'typesafe/jev-1.13-20260917', answers }) };
  };
  const score = await askScore({ ...base, name: 'q', instructions: 'rate it', criteria: ['low', 'high'] }, { fetchImpl });
  assert.equal(score.answer.score, 0.7);
  assert.equal(score.answer.type, 'score');
  const noul = await askNoul({ ...base, name: 'n', instructions: 'likely?', criteria: { true: 'yes', false: 'no' } }, { fetchImpl });
  assert.equal(noul.answer.noul, 0.3);
  const choice = await askChoice({ ...base, name: 'c', instructions: 'pick', criteria: { a: 'first', b: 'second' } }, { fetchImpl });
  assert.equal(choice.answer.choice, 'a');
  assert.equal(verifyReceipt(choice.receipt), true);
  // Each primitive sent exactly one typed question under its name.
  assert.deepEqual(calls.map(body => Object.values(body.questions)[0].type), ['score', 'noul', 'choice']);
  // A type mismatch in the answer still fails closed through the same path.
  const mismatch = async () => ({ ok: true, json: async () => ({ model: 'typesafe/jev-1.13', answers: { q: { type: 'choice', choice: 'a' } } }) });
  await assert.rejects(
    askScore({ ...base, name: 'q', instructions: 'rate it', criteria: ['x'] }, { fetchImpl: mismatch }),
    error => error instanceof JevError && error.code === 'jev-response',
  );
});

// ---------------------------------------------------------------------------
// Redaction guard — credential-shaped strings never leave the machine
// ---------------------------------------------------------------------------

test('redaction guard fires before any network call and never echoes the secret', async t => {
  const { repo, home } = fixture(t);
  catalogFixture(repo);
  jevHome(home);
  let fetched = false;
  const fetchImpl = async () => { fetched = true; return okFetch(choiceAnswer('luna-code'))(); };
  const briefs = [
    'uses key ' + fakeOrKey('abcdef0123456789abcdef'),
    'see Bearer abcdefghijklmnopqrstuvwxyz012345',
    'log ' + fakePem('OPENSSH'),
    fakeAwsKey(),
  ];
  for (const brief of briefs) {
    try {
      await routeDecide({ repository: repo, brief }, { home, fetchImpl });
      assert.fail(`expected jev-redacted for ${JSON.stringify(brief).slice(0, 40)}`);
    } catch (error) {
      assert.equal(error.code, 'jev-redacted');
      assert.ok(!JSON.stringify(error).includes(fakeOrKey('abcdef')), 'the matched content is never echoed');
    }
  }
  // Credential at object KEY position is blocked too — and the key name itself
  // never reaches the error (position is reported at the parent path only).
  const keyPosition = fakeOrKey('keypositionsecret00');
  assert.throws(() => assertRedacted({ state: { [keyPosition]: 'x', task: 'x' } }), error => error.code === 'jev-redacted' && /object key/.test(error.message) && !error.message.includes(keyPosition));
  assert.throws(() => assertRedacted({ state: { [fakeAwsKey()]: 'v' } }), /object key.*at state/);
  assert.equal(fetched, false);
  assert.doesNotThrow(() => assertRedacted({ state: 'an ordinary brief', questions: { q: { instructions: 'pick', criteria: { a: 'x' } } } }));
});

// ---------------------------------------------------------------------------
// prepare gate — receipt required under Jev ON, verified offline
// ---------------------------------------------------------------------------

const peerRequest = (repo, home, route) => ({
  role: 'peer', repository: repo, workspaceId: 'workspace', assignment: 'bounded test',
  profiles: undefined, providers, paseoHome: home, route,
});

test('Jev OFF keeps the bare-optionId path; Jev ON requires a decision receipt', async t => {
  const { dir, installed, repo, home } = fixture(t);
  install(root, installed);
  const { sha256 } = catalogFixture(repo);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), json({ version: 1 }));
  // No jev.json at all — OFF: the existing Lead-judgment path is preserved.
  const off = launchPlan(installed, peerRequest(repo, home, { optionId: 'luna-code', catalogSha256: sha256 }));
  assert.equal(off.routing.optionId, 'luna-code');
  assert.deepEqual(off.routing.jev, { required: false, decision: 'none' });
  // Armed: a bare optionId now fails closed with a clear message.
  jevHome(home);
  assert.throws(() => launchPlan(installed, peerRequest(repo, home, { optionId: 'luna-code', catalogSha256: sha256 })), /route\.decision receipt.*route-decide/s);
  const result = await routeDecide({ repository: repo, brief: 'bounded implementation task' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  const on = launchPlan(installed, peerRequest(repo, home, { optionId: result.optionId, catalogSha256: sha256, decision: result.decision }));
  assert.equal(on.routing.optionId, 'luna-code');
  assert.deepEqual(on.routing.jev, { required: true, decision: 'verified', jevChoice: 'luna-code', declined: false });
});

test('a disabled jev.json without capabilities/provider never blocks Peer prepare', t => {
  const { dir, installed, repo, home } = fixture(t);
  install(root, installed);
  const { sha256 } = catalogFixture(repo);
  // "Disabled, not configured yet" is a coherent intent — the enabled-only
  // fields must not gate reading the config or resolving a route.
  jevHome(home, { config: { schemaVersion: 1, enabled: false } });
  const config = readJevConfig(home);
  assert.equal(config.enabled, false);
  assert.deepEqual(config.capabilities, {});
  assert.equal(config.provider, null);
  const plan = launchPlan(installed, peerRequest(repo, home, { optionId: 'luna-code', catalogSha256: sha256 }));
  assert.equal(plan.routing.optionId, 'luna-code');
  assert.deepEqual(plan.routing.jev, { required: false, decision: 'none' });
  // A capability call still fails closed at the enabled gate — the error is
  // jev-disabled, not a config parse failure.
  assert.throws(() => resolveJev(home, 'routing'), error => error instanceof JevError && error.code === 'jev-disabled');
  // Status reports the disabled view with no provider instead of erroring.
  const status = runtimeStatus(home);
  assert.equal(status.jev.configured, true);
  assert.equal(status.jev.enabled, false);
  assert.equal(status.jev.provider, null);
});

test('an enabled jev.json still fails loud on broken enabled-only fields', t => {
  const { home } = fixture(t);
  for (const [name, config] of [
    ['missing capabilities', { schemaVersion: 1, enabled: true, provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' } }],
    ['missing provider', { schemaVersion: 1, enabled: true, capabilities: { routing: true } }],
    ['capabilities non-boolean', { schemaVersion: 1, enabled: true, capabilities: { routing: 'yes' }, provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' } }],
  ]) {
    jevHome(home, { config });
    assert.throws(
      () => readJevConfig(home),
      error => error instanceof JevError && error.code === 'jev-config-invalid',
      name,
    );
  }
});

test('a supplied receipt is verified even when Jev mode is off', async t => {
  const { dir, installed, repo, home } = fixture(t);
  install(root, installed);
  const { sha256 } = catalogFixture(repo);
  jevHome(home);
  const result = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  // Flip the toggle off after deciding — the receipt is still checked.
  jevHome(home, { enabled: false });
  const verified = launchPlan(installed, peerRequest(repo, home, { optionId: 'luna-code', catalogSha256: sha256, decision: result.decision }));
  assert.deepEqual(verified.routing.jev, { required: false, decision: 'verified', jevChoice: 'luna-code', declined: false });
  const tampered = { ...result.decision, context: { ...result.decision.context, catalogSha256: 'f'.repeat(64) } };
  assert.throws(() => launchPlan(installed, peerRequest(repo, home, { optionId: 'luna-code', catalogSha256: sha256, decision: tampered })), /hash mismatch/);
});

test('receipt consistency: catalog hash, candidate membership, answer match, decline', async t => {
  const { dir, installed, repo, home } = fixture(t);
  install(root, installed);
  const { sha256 } = catalogFixture(repo);
  jevHome(home);
  const fetchImpl = okFetch(choiceAnswer('luna-code'));
  const result = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl });
  const decide = { optionId: 'luna-code', catalogSha256: sha256, decision: result.decision };
  // Answer/optionId mismatch.
  assert.throws(() => launchPlan(installed, peerRequest(repo, home, { ...decide, optionId: 'luna-reason' })), /does not match the Jev receipt choice/);
  // Catalog drifted after the decision — stale catalogSha256 in the receipt.
  const catalog = testCatalog();
  catalog.options[0].suitableFor = ['edited'];
  writeFileSync(join(repo, '.paseo-slp/slp-routing.json'), json(catalog));
  const sha2 = readCatalog(repo).sha256;
  assert.throws(() => launchPlan(installed, peerRequest(repo, home, { ...decide, catalogSha256: sha2 })), /issued against a different catalog/);
  // Candidate not in the receipt's set (receipt re-signed with shrunken list).
  writeFileSync(join(repo, '.paseo-slp/slp-routing.json'), json(testCatalog()));
  const shrunk = { ...result.decision, context: { ...result.decision.context, candidates: ['luna-reason'] } };
  const { sha256: _omit, ...unsigned } = shrunk;
  const resigned = { ...unsigned, sha256: hash(canonicalJson(unsigned)) };
  assert.throws(() => launchPlan(installed, peerRequest(repo, home, { ...decide, decision: resigned })), /not a Jev candidate/);
  // A decline receipt is never a binding source.
  const declined = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer(ROUTE_DECLINE_CANDIDATE)) });
  assert.throws(() => launchPlan(installed, peerRequest(repo, home, { ...decide, decision: declined.decision })), /declined to route/);
});

test('shadow mode verifies supplied receipts without binding the Lead pick', async t => {
  const { dir, installed, repo, home } = fixture(t);
  install(root, installed);
  const { sha256 } = catalogFixture(repo);
  // Enabled but unarmed: the receipt verifies, the Lead's optionId decides,
  // and the plan records both picks — the paired evaluation data.
  jevHome(home, { routing: false });
  const result = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  const shadow = launchPlan(installed, peerRequest(repo, home, { optionId: 'luna-reason', catalogSha256: sha256, decision: result.decision }));
  assert.equal(shadow.routing.optionId, 'luna-reason');
  assert.deepEqual(shadow.routing.jev, { required: false, decision: 'verified', jevChoice: 'luna-code', declined: false });
  // A decline receipt in shadow records rather than fails — the Lead still
  // routed, and declined:true lands on the plan.
  const declined = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer(ROUTE_DECLINE_CANDIDATE)) });
  const shadowDecline = launchPlan(installed, peerRequest(repo, home, { optionId: 'luna-code', catalogSha256: sha256, decision: declined.decision }));
  assert.deepEqual(shadowDecline.routing.jev, { required: false, decision: 'verified', jevChoice: ROUTE_DECLINE_CANDIDATE, declined: true });
  // But consistency still binds in shadow: a Lead pick outside the receipt's
  // candidate list fails, as does a tampered receipt.
  const reSign = decision => { const { sha256: _s, ...unsigned } = decision; return { ...unsigned, sha256: hash(canonicalJson(unsigned)) }; };
  const shrunk = reSign({ ...result.decision, context: { ...result.decision.context, candidates: ['luna-code'] } });
  assert.throws(() => launchPlan(installed, peerRequest(repo, home, { optionId: 'luna-reason', catalogSha256: sha256, decision: shrunk })), /not a Jev candidate/);
  // Arming the same daemon makes the same divergence a hard failure.
  jevHome(home);
  assert.throws(() => launchPlan(installed, peerRequest(repo, home, { optionId: 'luna-reason', catalogSha256: sha256, decision: result.decision })), /does not match the Jev receipt choice/);
});

test('receipt hardening: exactly route_option, bound role, bound model', async t => {
  const { repo, home } = fixture(t);
  const { sha256 } = catalogFixture(repo);
  jevHome(home);
  const result = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  const reSign = decision => { const { sha256: _s, ...unsigned } = decision; return { ...unsigned, sha256: hash(canonicalJson(unsigned)) }; };
  const bind = decision => catalogBinding(repo, 'peer', providers, { optionId: 'luna-code', catalogSha256: sha256, decision }, home);
  // (a) An extra question alongside route_option violates the one-question contract.
  const extra = reSign({
    ...result.decision,
    questions: { ...result.decision.questions, side: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] } },
    answers: { ...result.decision.answers, side: { type: 'score', score: 0.5 } },
  });
  assert.throws(() => bind(extra), /exactly the route_option question/);
  // (b) context.role binds to the request role.
  const wrongRole = reSign({ ...result.decision, context: { ...result.decision.context, role: 'lead' } });
  assert.throws(() => bind(wrongRole), /issued for a different role/);
  // (c) decision.model binds to the configured provider.model when the config reads.
  const wrongModel = reSign({ ...result.decision, model: 'acme/jev-9.9' });
  assert.throws(() => bind(wrongModel), /different model/);
  // With no config at all the model check is skipped — consistency still holds.
  const offHome = join(repo, '..', 'off-home');
  mkdirSync(offHome, { recursive: true });
  writeFileSync(join(offHome, 'config.json'), json({ version: 1 }));
  const offBind = catalogBinding(repo, 'peer', providers, { optionId: 'luna-code', catalogSha256: sha256, decision: result.decision }, offHome);
  assert.equal(offBind.routing.jev.decision, 'verified');
});

test('remote-controlled error text is scrubbed before it reaches thrown errors', async t => {
  const { repo, home } = fixture(t);
  catalogFixture(repo);
  const secret = fakeOrKey('remote-secret-000000');
  jevHome(home, { key: SYNTH_KEY });
  const echo = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 403, message: `invalid key ${secret}` } }) });
  try {
    await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: echo });
    assert.fail('expected jev-http');
  } catch (error) {
    assert.equal(error.code, 'jev-http');
    assert.ok(!error.message.includes(secret), 'reflected credential never reaches the thrown message');
    assert.match(error.message, /<redacted>/);
  }
  // The bearer pattern is /i — a lowercase `bearer <token>` must still scrub.
  // A flag-dropping rebuild (new RegExp(source,'g')) would let it through.
  const lower = 'bearer abcdefghijklmnopqrstuvwxyz012345';
  const echoLower = async () => ({ ok: false, status: 500, json: async () => ({ error: { code: 500, message: `auth failed: ${lower}` } }) });
  try {
    await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: echoLower });
    assert.fail('expected jev-http');
  } catch (error) {
    assert.equal(error.code, 'jev-http');
    assert.ok(!error.message.includes('abcdefghijklmnopqrstuvwxyz012345'), 'lowercase bearer token is scrubbed');
    assert.match(error.message, /<redacted>/);
  }
  // Bare `ts-…` keys — a custom typesafe endpoint can reflect the key in
  // error text; the Bearer form was already covered, the bare shape was not.
  const tsKey = fakeTsKey('bareechoedtypesafekey000');
  const echoTs = async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 401, message: `bad credential ${tsKey}` } }) });
  try {
    await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: echoTs });
    assert.fail('expected jev-http');
  } catch (error) {
    assert.equal(error.code, 'jev-http');
    assert.ok(!error.message.includes(tsKey), 'bare ts- key is scrubbed from remote error text');
    assert.match(error.message, /<redacted>/);
  }
  // Controls: `Bearer ts-…` still scrubs (bearer pattern), and remote text
  // carrying no credential shape passes through untouched.
  const bearerTs = `Bearer ${tsKey}`;
  const echoBearerTs = async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 401, message: `denied ${bearerTs}` } }) });
  await assert.rejects(routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: echoBearerTs }), error => error.code === 'jev-http' && !error.message.includes(tsKey));
  const clean = async () => ({ ok: false, status: 422, json: async () => ({ error: { code: 422, message: 'questions must be a record' } }) });
  await assert.rejects(routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: clean }), /questions must be a record/);
});

test('receipt for a different capability or missing answer fails verification', async t => {
  const { repo, home } = fixture(t);
  const { sha256 } = catalogFixture(repo);
  jevHome(home);
  const result = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  const reSign = decision => { const { sha256: _s, ...unsigned } = decision; return { ...unsigned, sha256: hash(canonicalJson(unsigned)) }; };
  const wrongCap = reSign({ ...result.decision, context: { ...result.decision.context, capability: 'triage' } });
  assert.throws(() => catalogBinding(repo, 'peer', providers, { optionId: 'luna-code', catalogSha256: sha256, decision: wrongCap }, home), /not a routing decision/);
  const noAnswer = reSign({ ...result.decision, answers: { other: result.decision.answers[ROUTE_DECISION_QUESTION] } });
  assert.throws(() => catalogBinding(repo, 'peer', providers, { optionId: 'luna-code', catalogSha256: sha256, decision: noAnswer }, home), /lacks a route_option choice answer|Answer route_option/);
});

test('prepare --check runs the same receipt stages offline — no network anywhere', async t => {
  const { dir, installed, repo, home } = fixture(t);
  install(root, installed);
  const { sha256 } = catalogFixture(repo);
  jevHome(home);
  const missing = launchCheck(installed, peerRequest(repo, home, { optionId: 'luna-code', catalogSha256: sha256 }));
  assert.equal(missing.ok, false);
  assert.match(missing.checks.find(check => check.name === 'binding').error, /route\.decision receipt/);
  const result = await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl: okFetch(choiceAnswer('luna-code')) });
  const checked = launchCheck(installed, peerRequest(repo, home, { optionId: 'luna-code', catalogSha256: sha256, decision: result.decision }));
  assert.equal(checked.ok, true, JSON.stringify(checked.checks));
  // Handoff shares the plan builder — the same receipt gate applies there.
  const handoff = { previousAgentId: 'old', reason: 'quota', authority: 'Human', state: 'paused', previousOwner: { settled: true, evidence: 'receipt' }, resources: [] };
  const handoffChecked = launchCheck(installed, { ...peerRequest(repo, home, { optionId: 'luna-code', catalogSha256: sha256 }), handoff }, { handoff: true });
  assert.equal(handoffChecked.ok, false);
  assert.match(handoffChecked.checks.find(check => check.name === 'binding').error, /route\.decision receipt/);
});

// ---------------------------------------------------------------------------
// Eligibility parity — one predicate, view and enforcement
// ---------------------------------------------------------------------------

test('optionExclusions names closed-vocabulary tokens; catalogBinding echoes them', t => {
  const { repo } = fixture(t);
  const catalog = testCatalog();
  const [code, , paused, off, lead] = catalog.options;
  assert.deepEqual(optionExclusions(code, 'peer'), []);
  assert.deepEqual(optionExclusions(paused, 'peer'), ['availability:paused']);
  assert.deepEqual(optionExclusions(off, 'peer'), ['disabled']);
  assert.deepEqual(optionExclusions(lead, 'peer'), ['role-not-listed']);
  assert.deepEqual(optionExclusions({ ...off, availability: 'quota-exhausted', roles: ['lead'] }, 'peer'), ['disabled', 'availability:quota-exhausted', 'role-not-listed']);
  catalogFixture(repo);
  const sha256 = readCatalog(repo).sha256;
  assert.throws(() => catalogBinding(repo, 'peer', providers, { optionId: 'off-seat', catalogSha256: sha256 }), /excluded for peer: disabled/);
  assert.throws(() => catalogBinding(repo, 'peer', providers, { optionId: 'paused-seat', catalogSha256: sha256 }), /excluded for peer: availability:paused/);
  assert.throws(() => catalogBinding(repo, 'peer', providers, { optionId: 'lead-only', catalogSha256: sha256 }), /excluded for peer: role-not-listed/);
});

// ---------------------------------------------------------------------------
// hasKey-only status — the key never crosses a status or log surface
// ---------------------------------------------------------------------------

test('runtimeStatus reports hasKey only — key material never leaks', t => {
  const { home } = fixture(t);
  const secret = fakeOrKey('d0n0tleakme000000000000');
  jevHome(home, { key: secret });
  const status = runtimeStatus(home);
  assert.equal(status.jev.configured, true);
  assert.equal(status.jev.enabled, true);
  assert.deepEqual(status.jev.capabilities, { routing: true });
  assert.equal(status.jev.hasKey, true);
  assert.equal(status.jev.keyPermissionsOk, true);
  assert.equal(status.jev.provider.model, 'typesafe/jev-1.13');
  assert.ok(!JSON.stringify(status).includes(secret), 'key material must not appear in status output');
  assert.ok(!JSON.stringify(status).includes('sk-or'), 'not even the key prefix leaks');
  chmodSync(join(home, 'slp-runtime', 'state', 'jev-openrouter.key'), 0o640);
  assert.equal(runtimeStatus(home).jev.keyPermissionsOk, false);
  const unconfigured = runtimeStatus(join(home, 'absent'));
  assert.equal(unconfigured.jev.configured, false);
  assert.equal(unconfigured.jev.hasKey, false);
});

test('transport errors carry no key material', async t => {
  const { repo, home } = fixture(t);
  const secret = fakeOrKey('d0n0tleakme111111111111');
  catalogFixture(repo);
  jevHome(home, { key: secret });
  for (const fetchImpl of [netFail, httpFetch(500), timeoutFail]) {
    try {
      await routeDecide({ repository: repo, brief: 'x' }, { home, fetchImpl });
      assert.fail('expected failure');
    } catch (error) {
      assert.ok(!JSON.stringify(error, Object.keys(error)).includes(secret), 'error payloads must not contain the key');
    }
  }
});

// ---------------------------------------------------------------------------
// CLI surface — route-decide exists, fails closed without a daemon config
// ---------------------------------------------------------------------------

test('slp route-decide fails closed with no daemon config — before any network', t => {
  const { dir, repo, home } = fixture(t);
  catalogFixture(repo);
  mkdirSync(home, { recursive: true });
  const request = join(dir, 'request.json');
  writeFileSync(request, json({ repository: repo, brief: 'x' }));
  const run = args => { try { return { code: 0, out: execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (error) { return { code: error.status, out: `${error.stdout}${error.stderr}` }; } };
  const missing = run(['route-decide', request, '--paseo-home', home]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /Jev is not configured/);
  // Flag validation parity with the other subcommands.
  assert.match(run(['route-decide']).out, /requires <request.json>/);
  assert.match(run(['route-decide', request, '--check']).out, /--check is not valid for route-decide/);
});
