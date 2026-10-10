// tests/plugin-jev.test.mjs — the Jev per-daemon config/key lifecycle behind
// plugin/server/jev.ts: file layout + 0600 + atomic writes, strict input
// validation, hasKey-only views, and the injectable test-jev probe. No real
// network: the fetch seam is doubled throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createJev, resolveSupervision, jevConfigPath as pluginConfigPath, jevKeyPath as pluginKeyPath } from '../plugin/server/jev.ts';
import { readJevConfigFile, readJevKeyFile, observeJevKey } from '../plugin/server/runtime/jev-state.ts';
import { runtimeStatus } from '../plugin/server/runtime/cli/runtime-state.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { makeHome, seqNow, targetOf } from './helpers/plugin-doubles.mjs';
import { fakeOrKey, fakeTsKey } from './fake-secrets.mjs';
import { assertRedacted, readJevConfig, readJevKey, sanitizeRemoteText } from '../plugin/server/runtime/cli/jev.ts';
import { redactionFixtures } from './jev-redaction-matrix.mjs';

const jevPath = home => join(home, 'slp-runtime', 'state', 'jev.json');
const keyPath = home => join(home, 'slp-runtime', 'state', 'jev-openrouter.key');
const getJev = (jev, home) => jev.getJev({ schemaVersion: 1, target: targetOf(home) });
// set-jev carries a raw-file CAS token — the helper reads the current sha256
// first so every call writes against fresh state (call sites unchanged); the
// dedicated CAS test exercises the conflict path explicitly.
const setJev = async (jev, home, config) => {
  const current = await getJev(jev, home);
  return jev.setJev({ schemaVersion: 1, target: targetOf(home), jev: config, expectedSha256: current.jev.sha256 });
};
const setJevKey = (jev, home, key) => jev.setJevKey({ schemaVersion: 1, target: targetOf(home), key });
const testJev = (jev, home) => jev.testJev({ schemaVersion: 1, target: targetOf(home) });
const config = (over = {}) => ({
  schemaVersion: 1, enabled: true, capabilities: { routing: true },
  provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'typesafe/jev-1.13' },
  ...over,
});

test('jev config round-trips through get/set with 0600 atomic writes', async t => {
  const home = makeHome(t);
  const jev = createJev();
  // Unset → unconfigured view, no key.
  assert.equal(existsSync(jevPath(home)), false);
  assert.deepEqual((await getJev(jev, home)).jev, {
    configured: false, enabled: null, capabilities: null, provider: null,
    hasKey: false, keyPermissionsOk: null, sha256: null, error: null,
  });
  const stored = await setJev(jev, home, config());
  assert.equal(lstatSync(jevPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(jevPath(home), 'utf8')), config());
  assert.equal(stored.jev.configured, true);
  assert.equal(stored.jev.enabled, true);
  assert.deepEqual(stored.jev.capabilities, { routing: true });
  assert.equal(stored.jev.provider.model, 'typesafe/jev-1.13');
  // No tmp siblings survive the atomic write.
  assert.deepEqual(
    readdirSync(join(home, 'slp-runtime', 'state')).filter(name => name.endsWith('.tmp')),
    [],
  );
  // Toggling off preserves the whole document otherwise.
  await setJev(jev, home, config({ enabled: false }));
  const off = await getJev(jev, home);
  assert.equal(off.jev.enabled, false);
  assert.deepEqual(off.jev.capabilities, { routing: true });
});

test('set-jev rejects malformed input and drift-prone provider values', async t => {
  const home = makeHome(t);
  const jev = createJev();
  const cases = [
    ['unknown top key', { ...config(), extra: 1 }],
    ['wrong schemaVersion', { ...config(), schemaVersion: 2 }],
    ['non-bool capability', { ...config(), capabilities: { routing: 'yes' } }],
    ['alias model', { ...config(), provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'typesafe/jev-latest' } }],
    ['preview alias', { ...config(), provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'jev-preview' } }],
    ['first-party id shape', { ...config(), provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'jev-1.13.0' } }],
    ['http baseUrl', { ...config(), provider: { kind: 'openrouter', baseUrl: 'http://openrouter.ai', model: 'typesafe/jev-1.13' } }],
    ['undocumented baseUrl path', { ...config(), provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v2', model: 'typesafe/jev-1.13' } }],
    ['other kind', { ...config(), provider: { kind: 'openai', baseUrl: 'https://api.openai.com', model: 'typesafe/jev-1.13' } }],
    // Cross-kind confusion — each shape is pinned to its own kind.
    ['openrouter model on typesafe', { ...config(), provider: { kind: 'typesafe', baseUrl: 'https://api.typesafe.ai', model: 'typesafe/jev-1.13' } }],
    ['typesafe model on openrouter', { ...config(), provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'jev-1.13.0' } }],
    ['typesafe http baseUrl', { ...config(), provider: { kind: 'typesafe', baseUrl: 'http://api.typesafe.ai', model: 'jev-1.13.0' } }],
    ['typesafe baseUrl query', { ...config(), provider: { kind: 'typesafe', baseUrl: 'https://api.typesafe.ai/?x=1', model: 'jev-1.13.0' } }],
  ];
  for (const [name, jevConfig] of cases) {
    await assert.rejects(() => setJev(jev, home, jevConfig), /invalid set-jev input/, name);
  }
  await assert.rejects(() => jev.getJev({ schemaVersion: 1 }), /invalid get-jev input/);
  await assert.rejects(() => setJev(jev, home, { enabled: true }), /invalid set-jev input/);
  assert.equal(existsSync(jevPath(home)), false, 'a rejected write never creates the file');
});

test('validator parity with plugin/server/runtime/cli/jev.ts — prefixed baseUrl + defaults fill identically', async t => {
  const home = makeHome(t);
  const jev = createJev();
  // The documented prefixed form is accepted on the plugin side as well.
  await setJev(jev, home, config({ provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'typesafe/jev-1.13' } }));
  assert.equal((await getJev(jev, home)).jev.provider.baseUrl, 'https://openrouter.ai/api/v1');
  // A hand-written jev.json that omits baseUrl is valid for BOTH surfaces:
  // the CLI defaults it, and the plugin view must not call it broken.
  writeFileSync(jevPath(home), JSON.stringify({
    schemaVersion: 1, enabled: true, capabilities: {},
    provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' },
  }));
  const view = (await getJev(jev, home)).jev;
  assert.equal(view.configured, true);
  assert.equal(view.error, null);
  assert.equal(view.provider.baseUrl, 'https://openrouter.ai', 'absent baseUrl defaults like the CLI');
  assert.deepEqual(view.capabilities, { routing: false }, 'absent capability defaults off like the CLI');
});

test('a corrupt jev.json surfaces as an error view, never silently OFF', async t => {
  const home = makeHome(t);
  const jev = createJev();
  mkdirSync(dirname(jevPath(home)), { recursive: true });
  writeFileSync(jevPath(home), '{corrupt');
  const view = (await getJev(jev, home)).jev;
  assert.equal(view.configured, true, 'a broken file is configured-but-broken evidence');
  assert.match(view.error, /not valid JSON/);
  writeFileSync(jevPath(home), JSON.stringify({ schemaVersion: 1, enabled: 'yes' }));
  assert.match((await getJev(jev, home)).jev.error, /schema validation/);
});

test('key lifecycle: write 0600, hasKey-only view, toggle-off keeps the key, remove', async t => {
  const home = makeHome(t);
  const jev = createJev();
  await setJev(jev, home, config());
  const secret = fakeOrKey('plugin-test-key-000000');
  await setJevKey(jev, home, secret);
  assert.equal(lstatSync(keyPath(home)).mode & 0o777, 0o600);
  assert.equal(readFileSync(keyPath(home), 'utf8'), `${secret}\n`);
  const view = (await getJev(jev, home)).jev;
  assert.equal(view.hasKey, true);
  assert.equal(view.keyPermissionsOk, true);
  assert.ok(!JSON.stringify(view).includes(secret), 'the view never echoes key material');
  // Toggling every capability off must not delete the stored key.
  await setJev(jev, home, config({ enabled: false, capabilities: { routing: false } }));
  assert.equal(existsSync(keyPath(home)), true);
  assert.equal((await getJev(jev, home)).jev.hasKey, true);
  // Removal is explicit.
  await setJevKey(jev, home, null);
  assert.equal(existsSync(keyPath(home)), false);
  assert.equal((await getJev(jev, home)).jev.hasKey, false);
});

test('set-jev-key rejects whitespace keys and malformed input', async t => {
  const home = makeHome(t);
  const jev = createJev();
  await assert.rejects(() => setJevKey(jev, home, 'key with spaces'), /whitespace/);
  await assert.rejects(() => setJevKey(jev, home, ''), /invalid set-jev-key input/);
  await assert.rejects(() => jev.setJevKey({ schemaVersion: 1, target: targetOf(home) }), /invalid set-jev-key input/);
  assert.equal(existsSync(keyPath(home)), false);
});

test('test-jev probes the stored key — no key/config fail fast, network is doubled', async t => {
  const home = makeHome(t);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ data: { label: fakeOrKey('abc') + '…123', is_free_tier: false } }) };
  };
  const jev = createJev({ fetchImpl });
  // Unconfigured → fail result, never a throw, never a call.
  const unconfigured = await testJev(jev, home);
  assert.equal(unconfigured.ok, false);
  assert.match(unconfigured.detail, /not configured/);
  await setJev(jev, home, config());
  const noKey = await testJev(jev, home);
  assert.equal(noKey.ok, false);
  assert.match(noKey.detail, /no key stored/);
  assert.equal(calls.length, 0, 'no network before a stored key exists');
  await setJevKey(jev, home, fakeOrKey('probe-key'));
  const probed = await testJev(jev, home);
  assert.equal(probed.ok, true);
  assert.match(probed.detail, /key accepted/);
  assert.ok(probed.latencyMs >= 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/auth/key');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${fakeOrKey('probe-key')}`);
});

test('typesafe kind: config round-trip, jev-typesafe.key lifecycle, /v1/models probe', async t => {
  const home = makeHome(t);
  const calls = [];
  const jev = createJev({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ data: [{ id: 'jev-1.13.0' }] }) }; } });
  const tsConfig = over => config({ provider: { kind: 'typesafe', model: 'jev-1.13.0', ...over } });
  // Absent baseUrl defaults to the first-party origin — same parity rule as
  // the openrouter default.
  const stored = await setJev(jev, home, tsConfig());
  assert.equal(stored.jev.provider.baseUrl, 'https://api.typesafe.ai');
  assert.equal(stored.jev.provider.model, 'jev-1.13.0');
  // A custom endpoint mounts under an origin+path prefix (Human-requested).
  await setJev(jev, home, tsConfig({ baseUrl: 'https://jev.internal.example.com/proxy' }));
  assert.equal((await getJev(jev, home)).jev.provider.baseUrl, 'https://jev.internal.example.com/proxy');
  // The key lives in the kind-named file, not jev-openrouter.key.
  await setJevKey(jev, home, fakeTsKey('probe-key'));
  assert.equal(existsSync(join(home, 'slp-runtime', 'state', 'jev-typesafe.key')), true);
  assert.equal(existsSync(keyPath(home)), false, 'openrouter key file untouched');
  // The probe follows the configured baseUrl mount — a proxy serves its API
  // under the prefix, so {baseUrl}/v1/models is the documented check.
  const result = await testJev(jev, home);
  assert.equal(result.ok, true);
  assert.equal(calls.at(-1).url, 'https://jev.internal.example.com/proxy/v1/models');
  assert.equal(calls.at(-1).init.headers.authorization, 'Bearer ts-probe-key');
  // Bad key → the documented 401 surfaces as a failed probe, never a throw.
  const bad = createJev({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const denied = await testJev(bad, home);
  assert.equal(denied.ok, false);
  assert.match(denied.detail, /HTTP 401/);
});

test('test-jev reports HTTP and network failures without throwing or leaking', async t => {
  const home = makeHome(t);
  const secret = fakeOrKey('d0n0tleakme-plugin');
  const http = status => async () => ({ ok: false, status, json: async () => ({}) });
  for (const status of [401, 402, 500]) {
    const jev = createJev({ fetchImpl: http(status) });
    await setJev(jev, home, config());
    await setJevKey(jev, home, secret);
    const result = await testJev(jev, home);
    assert.equal(result.ok, false);
    assert.match(result.detail, new RegExp(`HTTP ${status}`));
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  const jev = createJev({ fetchImpl: async () => { throw new TypeError('socket hangup'); } });
  const result = await testJev(jev, home);
  assert.equal(result.ok, false);
  assert.match(result.detail, /socket hangup/);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('a label carrying credential-shaped text is scrubbed from the detail', async t => {
  const home = makeHome(t);
  const reflected = fakeOrKey('reflectedsecret0000');
  const jev = createJev({
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { label: `acct ${reflected} label` } }) }),
    now: seqNow(),
  });
  await setJev(jev, home, config());
  await setJevKey(jev, home, fakeOrKey('probe-key'));
  const result = await testJev(jev, home);
  assert.equal(result.ok, true);
  assert.ok(!result.detail.includes(reflected), 'remote label text is sanitized');
  assert.match(result.detail, /<redacted>/);
  assert.equal(result.latencyMs, 1000, 'deps.now wires into the latency measurement');
  // Flag-preserving rebuild: a lowercase `bearer <token>` in remote text must
  // still scrub — a plain 'g' rebuild would drop the pattern's /i.
  const bearerJev = createJev({
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { label: 'bearer abcdefghijklmnopqrstuvwxyz012345' } }) }),
  });
  const bearerResult = await testJev(bearerJev, home);
  assert.ok(!bearerResult.detail.includes('abcdefghijklmnopqrstuvwxyz012345'), 'lowercase bearer token is scrubbed');
  assert.match(bearerResult.detail, /<redacted>/);
  // Bare `ts-…` keys — the typesafe kind's credential shape; a custom
  // endpoint could reflect it in the key-info label or error text.
  const tsKey = fakeTsKey('reflectedtypesafekey000');
  const tsJev = createJev({
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { label: `acct ${tsKey}` } }) }),
  });
  const tsResult = await testJev(tsJev, home);
  assert.ok(!tsResult.detail.includes(tsKey), 'bare ts- key is scrubbed');
  assert.match(tsResult.detail, /<redacted>/);
});

test('get/set-jev verify the daemon home like every other mutation', async t => {
  const home = makeHome(t);
  const jev = createJev();
  await assert.rejects(
    () => getJev(jev, join(home, 'missing')),
    error => error.code === 'HOME_UNVERIFIED',
  );
  // §8.1 parity with manager.ts: a symlinked slp-runtime redirects writes —
  // the real-directory check refuses it before any credential write.
  const outside = join(home, '..', `outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(home, 'slp-runtime'), 'dir');
  await assert.rejects(
    () => getJev(jev, home),
    error => error.code === 'HOME_UNVERIFIED' && /not a real directory/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// Credential adapter coverage — one fixture matrix through CLI and RPC paths
// (tests/jev-redaction-matrix.mjs). plugin/server/runtime/cli/jev.ts exposes assertRedacted (the
// outbound guard that refuses the send) and sanitizeRemoteText (exported);
// plugin/server/jev.ts keeps its sanitizeRemoteText private — the only
// reachable surfaces are testJev's accepted-label detail (cap 120) and its
// network-error detail (cap 200). Both go through the same scrubber, so the
// pins are byte-exact between the sides.
// ---------------------------------------------------------------------------

test('credential handling preserves CLI errors and RPC detail sanitization', async t => {
  const home = makeHome(t);
  const jev = createJev();
  await setJev(jev, home, config());
  await setJevKey(jev, home, fakeOrKey('probe-key'));

  const labelScrub = async text => {
    const probe = createJev({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: { label: text } }) }) });
    const result = await testJev(probe, home);
    assert.equal(result.ok, true);
    const prefix = 'key accepted (label ';
    assert.ok(result.detail.startsWith(prefix) && result.detail.endsWith(')'), `label detail shape: ${result.detail}`);
    return result.detail.slice(prefix.length, -1);
  };
  const errorScrub = async text => {
    const probe = createJev({ fetchImpl: async () => { throw new Error(`upstream ${text} tail`); } });
    const result = await testJev(probe, home);
    assert.equal(result.ok, false);
    return result.detail;
  };
  const redactError = (text, name) => {
    try {
      assertRedacted(text);
    } catch (error) {
      return error;
    }
    throw new Error(`expected jev-redacted for ${name}`);
  };

  for (const { name, text, detect } of redactionFixtures) {
    const pluginLabel = await labelScrub(text);
    const pluginError = await errorScrub(text);
    const srcScrubbed = sanitizeRemoteText(text, 120);
    if (detect === null) {
      // Pass-through is a no-op on both sides: the outbound guard stays
      // silent and every scrub surface returns the input byte-identical.
      assert.doesNotThrow(() => assertRedacted(text), name);
      assert.equal(sanitizeRemoteText(text), text, name);
      assert.equal(pluginLabel, text, `${name}: plugin label passes verbatim`);
      assert.equal(pluginError, `request failed: upstream ${text} tail`, `${name}: plugin error passes verbatim`);
      continue;
    }
    // The outbound guard refuses the send, names the pattern class and never
    // echoes the matched content.
    const thrown = redactError(text, name);
    assert.equal(thrown.code, 'jev-redacted', name);
    assert.ok(thrown.message.includes(`(${detect.pattern})`), `${name}: names ${detect.pattern}`);
    for (const secret of detect.secrets) {
      assert.ok(!thrown.message.includes(secret), `${name}: error never echoes the secret`);
      assert.ok(!srcScrubbed.includes(secret), `${name}: src scrub leaks no secret`);
      assert.ok(!pluginLabel.includes(secret), `${name}: plugin label leaks no secret`);
      assert.ok(!pluginError.includes(secret), `${name}: plugin error leaks no secret`);
    }
    assert.equal(pluginLabel, srcScrubbed, `${name}: identical sanitized bytes`);
    assert.ok(srcScrubbed.includes('<redacted>'), name);
  }
});

test('credential edge inputs — caps after scrub, non-strings, payload paths', async t => {
  const home = makeHome(t);
  const jev = createJev();
  await setJev(jev, home, config());
  await setJevKey(jev, home, fakeOrKey('probe-key'));

  // Non-string payload leaves are skipped by the outbound guard; on the
  // plugin side the label is scrubbed only when it is a string — metadata
  // types never reach the detail.
  assert.doesNotThrow(() => assertRedacted({ n: 42, flag: true, nil: null, list: [1, 'ok'] }));
  for (const label of [42, { secret: fakeOrKey('notread1234567') }, null]) {
    const probe = createJev({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: { label } }) }) });
    assert.equal((await testJev(probe, home)).detail, 'key accepted', `non-string label ${JSON.stringify(label)}`);
  }
  // An empty-string label is falsy — same 'key accepted' with nothing emitted.
  const emptyLabel = createJev({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: { label: '' } }) }) });
  assert.equal((await testJev(emptyLabel, home)).detail, 'key accepted');
  assert.equal(sanitizeRemoteText(''), '');
  // src's sanitizeRemoteText coerces through String(value) — pinned here so
  // the contract is explicit; the plugin call site guards with typeof.
  assert.equal(sanitizeRemoteText(12345), '12345');
  assert.equal(sanitizeRemoteText(null), 'null');

  // Caps apply AFTER redaction: a credential straddling the cut point loses
  // its match first, so no credential prefix can leak through the cap. (The
  // key needs a word boundary — the space before it is load-bearing.)
  const longKey = fakeOrKey('a'.repeat(30));
  const straddled = sanitizeRemoteText('z'.repeat(194) + ' ' + longKey);
  assert.equal(straddled.length, 200);
  assert.ok(straddled.endsWith('<reda'), 'redaction ran before the slice');
  assert.ok(!straddled.includes('sk-'), 'no credential prefix leaks past the cap');
  const labelProbe = createJev({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: { label: 'z'.repeat(114) + ' ' + longKey } }) }) });
  const straddleResult = await testJev(labelProbe, home);
  assert.equal(straddleResult.detail, `key accepted (label ${'z'.repeat(114)} <reda)`);
  assert.ok(!straddleResult.detail.includes(longKey));
  assert.equal(sanitizeRemoteText('x'.repeat(300)).length, 200, 'default cap');
  assert.equal(sanitizeRemoteText('x'.repeat(300), 64).length, 64, 'caller cap');
  const capProbe = createJev({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: { label: 'q'.repeat(150) } }) }) });
  assert.equal((await testJev(capProbe, home)).detail, `key accepted (label ${'q'.repeat(120)})`);
  const errProbe = createJev({ fetchImpl: async () => { throw new Error('e'.repeat(300)); } });
  assert.equal((await testJev(errProbe, home)).detail, `request failed: ${'e'.repeat(200)}`);

  // Outbound-guard path pinning: a nested value reports its JSON path, and a
  // credential at object-key position reports only the parent path — the key
  // text itself never reaches the error.
  const embedded = fakeOrKey('nestedkey00000000');
  try {
    assertRedacted({ state: { task: embedded } });
    assert.fail('expected jev-redacted');
  } catch (error) {
    assert.equal(error.code, 'jev-redacted');
    assert.match(error.message, /\(openrouter-key\) at state\.task/);
  }
  try {
    assertRedacted({ state: { [embedded]: 'v' } });
    assert.fail('expected jev-redacted');
  } catch (error) {
    assert.equal(error.code, 'jev-redacted');
    assert.match(error.message, /object key \(openrouter-key\) at state/);
    assert.ok(!error.message.includes(embedded), 'the key text never reaches the error');
  }
});

// ---------------------------------------------------------------------------
// Config/key parity — characterization style (S2). Shared semantics are
// pinned across both validators against the same on-disk file; intentional
// differences are settled adapter compatibility contracts: CLI lenient OFF/
// unknown-key reads and plugin strict persisted/RPC validation. Never silently
// normalize them into one dialect.
// ---------------------------------------------------------------------------

test('absent and corrupt config share one semantic on both sides — never silently misread', async t => {
  const home = makeHome(t);
  const jev = createJev();
  // Absent file = unconfigured OFF on both sides (no error).
  assert.equal(readJevConfig(home), null);
  assert.deepEqual((await getJev(jev, home)).jev, {
    configured: false, enabled: null, capabilities: null, provider: null,
    hasKey: false, keyPermissionsOk: null, sha256: null, error: null,
  });
  // Corrupt bytes are evidence, not absence: the runtime throws, the plugin
  // reports configured-but-broken — same "not OFF" verdict, different
  // surfacing mechanism (exception vs error field).
  mkdirSync(dirname(jevPath(home)), { recursive: true });
  writeFileSync(jevPath(home), '{not json');
  assert.throws(() => readJevConfig(home), /not valid JSON/);
  const corrupt = (await getJev(jev, home)).jev;
  assert.equal(corrupt.configured, true);
  assert.match(corrupt.error, /not valid JSON/);
  // Schema-mismatched content fails on both sides too.
  writeFileSync(jevPath(home), JSON.stringify({ schemaVersion: 2, enabled: false }));
  assert.throws(() => readJevConfig(home), /schemaVersion=1/);
  assert.match((await getJev(jev, home)).jev.error, /schema validation/);
  // enabled must be a boolean on both sides.
  writeFileSync(jevPath(home), JSON.stringify({ schemaVersion: 1, enabled: 'yes' }));
  assert.throws(() => readJevConfig(home), /enabled must be a boolean/);
  assert.match((await getJev(jev, home)).jev.error, /schema validation/);
});

test('minimal OFF config: runtime accepts the bare marker, plugin requires the full document', async t => {
  // Same bytes, two verdicts — settled compatibility. The runtime reads
  // {schemaVersion:1, enabled:false} as a coherent "disabled, not configured
  // yet" marker and never validates enabled-only fields on the OFF path
  // (tests/jev.test.mjs pins that a Peer prepare keeps working under it).
  // The plugin schema always requires the full document, so the same file
  // surfaces as configured-but-broken in the Manager view.
  const home = makeHome(t);
  mkdirSync(dirname(jevPath(home)), { recursive: true });
  writeFileSync(jevPath(home), JSON.stringify({ schemaVersion: 1, enabled: false }) + '\n', { mode: 0o600 });
  const runtime = readJevConfig(home);
  assert.equal(runtime.enabled, false);
  assert.deepEqual(runtime.capabilities, {});
  assert.equal(runtime.provider, null);
  const view = (await getJev(createJev(), home)).jev;
  assert.equal(view.configured, true, 'plugin strict read reports broken; CLI routing remains OFF');
  assert.equal(view.enabled, null);
  assert.match(view.error, /schema validation/);
});

test('strict-vs-lenient validation: unknown keys rejected on write/read by plugin, ignored by runtime', async t => {
  const home = makeHome(t);
  const jev = createJev();
  mkdirSync(dirname(jevPath(home)), { recursive: true });
  // settled compatibility: the runtime reader is field-oriented and ignores
  // unknown keys anywhere; the plugin schema is strict at every level, at
  // write time AND when viewing a hand-edited file.
  const extra = over => ({ schemaVersion: 1, enabled: true, capabilities: { routing: true }, provider: { kind: 'openrouter', model: 'typesafe/jev-1.13', ...over } });
  writeFileSync(jevPath(home), JSON.stringify({ ...extra({}), comment: 'human note' }));
  assert.equal(readJevConfig(home).enabled, true, 'runtime ignores an unknown top-level key');
  assert.match((await getJev(jev, home)).jev.error, /schema validation/);
  writeFileSync(jevPath(home), JSON.stringify(extra({ comment: 'field note' })));
  assert.equal(readJevConfig(home).provider.model, 'typesafe/jev-1.13', 'runtime ignores an unknown provider key');
  assert.match((await getJev(jev, home)).jev.error, /schema validation/);
  // And the write path refuses them up front — a Manager round-trip can
  // never produce a file the runtime would silently misread.
  await assert.rejects(() => setJev(jev, home, { ...config(), extra: 1 }), /invalid set-jev input/);
  await assert.rejects(() => setJev(jev, home, config({ provider: { kind: 'openrouter', model: 'typesafe/jev-1.13', comment: 'x' } })), /invalid set-jev input/);
  // Shared permissiveness, pinned identically: unknown CAPABILITY keys are
  // future-proof on both sides (boolean catchall vs record-of-booleans).
  const futureCap = { schemaVersion: 1, enabled: true, capabilities: { routing: true, futureCap: false }, provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' } };
  writeFileSync(jevPath(home), JSON.stringify(futureCap));
  assert.equal(readJevConfig(home).capabilities.futureCap, false);
  assert.equal((await getJev(jev, home)).jev.error, null);
  await setJev(jev, home, futureCap);
  assert.equal((await getJev(jev, home)).jev.capabilities.futureCap, false);
});

test('stored-but-disabled: the runtime reports a bare OFF view while the plugin shows the stored document', async t => {
  // settled compatibility: with enabled:false the runtime view drops the
  // stored capabilities/provider entirely (unvalidated fields are reported
  // absent — runtime-state.mjs applies the same rule to status output),
  // while the plugin view surfaces the stored document so the Manager can
  // render what re-enabling would restore.
  const home = makeHome(t);
  const jev = createJev();
  await setJev(jev, home, config({ enabled: false }));
  const runtime = readJevConfig(home);
  assert.equal(runtime.enabled, false);
  assert.deepEqual(runtime.capabilities, {});
  assert.equal(runtime.provider, null);
  const view = (await getJev(jev, home)).jev;
  assert.equal(view.enabled, false);
  assert.deepEqual(view.capabilities, { routing: true });
  assert.equal(view.provider.kind, 'openrouter');
});

test('key whitespace asymmetry: the write gate is strict, the runtime reader trims', async t => {
  const home = makeHome(t);
  const jev = createJev();
  // Write-side (plugin): any whitespace anywhere in the key input is refused.
  await assert.rejects(() => setJevKey(jev, home, ' padded '), /whitespace/);
  await assert.rejects(() => setJevKey(jev, home, 'has internal space'), /whitespace/);
  await assert.rejects(() => setJevKey(jev, home, ''), /invalid set-jev-key input/);
  assert.equal(existsSync(keyPath(home)), false, 'rejected writes never create the file');
  // Read-side (runtime): surrounding whitespace in the file is trimmed away —
  // settled compatibility leniency vs the write gate (a hand-edited key file
  // with a trailing newline/indent still resolves).
  mkdirSync(dirname(keyPath(home)), { recursive: true });
  writeFileSync(keyPath(home), '  padded-key  \n', { mode: 0o600 });
  assert.equal(readJevKey(home, 'openrouter'), 'padded-key');
  // Internal whitespace is rejected by BOTH sides — shared semantics: the
  // write gate refuses it and the reader fails on it.
  writeFileSync(keyPath(home), 'has internal space\n', { mode: 0o600 });
  assert.throws(() => readJevKey(home, 'openrouter'), /empty or contains whitespace/);
});

test('key file content is re-validated by the runtime but only presence-checked by the plugin', async t => {
  const home = makeHome(t);
  const jev = createJev();
  await setJev(jev, home, config());
  // Empty/whitespace-only content: the runtime reader fails jev-key-invalid
  // on every read; the plugin's keyProbe is lstat-only metadata — the file
  // exists and is private, so hasKey:true with no content inspection.
  // settled compatibility.
  mkdirSync(dirname(keyPath(home)), { recursive: true });
  for (const bytes of ['', '   \n']) {
    writeFileSync(keyPath(home), bytes, { mode: 0o600 });
    assert.throws(() => readJevKey(home, 'openrouter'), /empty or contains whitespace/);
    const view = (await getJev(jev, home)).jev;
    assert.equal(view.hasKey, true, `presence-only metadata for ${JSON.stringify(bytes)}`);
    assert.equal(view.keyPermissionsOk, true);
    assert.equal(view.error, null, 'an empty key file is not a view error');
  }
  // Non-regular file: both sides refuse it as a key — shared semantics,
  // different surfacing (throw vs hasKey:false metadata).
  rmSync(keyPath(home));
  mkdirSync(keyPath(home));
  assert.throws(() => readJevKey(home, 'openrouter'), /regular file/);
  const dirView = (await getJev(jev, home)).jev;
  assert.equal(dirView.hasKey, false);
  assert.equal(dirView.keyPermissionsOk, null);
});

test('keyProbe is metadata-only: key bytes never enter the view, only hasKey and permission bits', async t => {
  const home = makeHome(t);
  const jev = createJev();
  await setJev(jev, home, config());
  const marker = fakeOrKey('content-never-read-000');
  mkdirSync(dirname(keyPath(home)), { recursive: true });
  writeFileSync(keyPath(home), marker + '\n', { mode: 0o600 });
  const view = (await getJev(jev, home)).jev;
  assert.equal(view.hasKey, true);
  assert.equal(view.keyPermissionsOk, true);
  assert.ok(!JSON.stringify(view).includes(marker), 'key material never crosses the view');
  // A 0o077-accessible key file: shared "must be private" semantics with
  // different surfacing — the runtime throws jev-key-permissions while the
  // plugin reports the failure as view metadata (and testJev fails closed).
  chmodSync(keyPath(home), 0o640);
  const weak = (await getJev(jev, home)).jev;
  assert.equal(weak.hasKey, true);
  assert.equal(weak.keyPermissionsOk, false);
  assert.throws(() => readJevKey(home, 'openrouter'), /group\/other-accessible/);
  const probed = await testJev(jev, home);
  assert.equal(probed.ok, false);
  assert.match(probed.detail, /chmod 600/);
});

test('settled Jev disk dialect matrix: CLI OFF/unknown keys, plugin strict diagnostics and CAS', async t => {
  const home = makeHome(t);
  const stableRoot = join(home, 'slp-runtime');
  mkdirSync(dirname(jevPath(home)), { recursive: true });
  let networkCalls = 0;
  const jev = createJev({ fetchImpl: async () => { networkCalls++; throw new Error('network forbidden on read'); } });
  const cases = [
    { name: 'minimal OFF', value: { schemaVersion: 1, enabled: false }, cliOff: true, strictError: true },
    { name: 'OFF malformed enabled-only fields', value: { schemaVersion: 1, enabled: false, capabilities: 'unused', provider: null, future: 1 }, cliOff: true, strictError: true },
    { name: 'unknown top key ON', value: config({ note: 'local note' }), strictError: true },
    { name: 'unknown provider key ON', value: config({ provider: { ...config().provider, note: 'local note' } }), strictError: true },
    { name: 'stored OFF', value: config({ enabled: false }), cliOff: true, strictError: false },
    { name: 'future boolean capability', value: config({ capabilities: { supervision: true, future: false } }), strictError: false },
    { name: 'missing routing defaults differ', value: config({ capabilities: {} }), strictError: false },
    { name: 'null baseURL CLI default', value: config({ provider: { ...config().provider, baseUrl: null } }), strictError: true },
    { name: 'both reject invalid enabled', value: config({ enabled: 'no' }), cliError: /enabled must be a boolean/, strictError: true },
    { name: 'both reject invalid capabilities while ON', value: config({ capabilities: { supervision: 'yes' } }), cliError: /record of booleans/, strictError: true },
    { name: 'both reject invalid provider while ON', value: config({ provider: null }), cliError: /provider.kind/, strictError: true },
  ];
  for (const scenario of cases) {
    const raw = JSON.stringify(scenario.value, null, 1) + '\n';
    writeFileSync(jevPath(home), raw, { mode: 0o600 });
    const expectedHash = createHash('sha256').update(raw).digest('hex');
    const plugin = (await getJev(jev, home)).jev;
    assert.equal(plugin.sha256, expectedHash, `${scenario.name}: raw-file token is retained`);
    assert.equal(plugin.configured, true, scenario.name);
    if (scenario.strictError) assert.match(plugin.error, /^jev.json failed schema validation:/, scenario.name);
    else assert.equal(plugin.error, null, scenario.name);
    if (scenario.cliError) {
      assert.throws(() => readJevConfig(home), error => error.code === 'jev-config-invalid' && scenario.cliError.test(error.message), scenario.name);
    } else {
      const cli = readJevConfig(home);
      const status = runtimeStatus(home).jev;
      if (scenario.cliOff) {
        assert.deepEqual({ enabled: cli.enabled, capabilities: cli.capabilities, provider: cli.provider }, { enabled: false, capabilities: {}, provider: null }, scenario.name);
        assert.equal(status.enabled, false);
        assert.equal(status.provider, null);
      } else assert.equal(cli.enabled, true, scenario.name);
    }
  }
  writeFileSync(jevPath(home), '{broken json');
  const broken = (await getJev(jev, home)).jev;
  assert.match(broken.error, /^jev.json is not valid JSON:/);
  assert.equal(broken.sha256, createHash('sha256').update('{broken json').digest('hex'));
  assert.throws(() => readJevConfig(home), error => error.code === 'jev-config-invalid' && /not valid JSON/.test(error.message));
  await assert.rejects(() => jev.setJev({ schemaVersion: 1, target: targetOf(home), expectedSha256: null, jev: config() }), /changed since/);
  const fixed = await jev.setJev({ schemaVersion: 1, target: targetOf(home), expectedSha256: broken.sha256, jev: config() });
  assert.equal(fixed.jev.error, null, 'correct raw broken-file CAS token permits explicit repair');
  assert.equal(networkCalls, 0, 'get/set/status and both dialect parsers are offline');
  assert.equal(pluginConfigPath(stableRoot), join(home, 'slp-runtime', 'state', 'jev.json'));
  assert.equal(pluginKeyPath(stableRoot, 'typesafe'), join(home, 'slp-runtime', 'state', 'jev-typesafe.key'));
});

test('disk owner exposes raw corrupt-config hashes and interprets stat-only vs secure key reads', async t => {
  const home = makeHome(t), stableRoot = join(home, 'slp-runtime');
  mkdirSync(dirname(jevPath(home)), { recursive: true });
  writeFileSync(jevPath(home), '{broken');
  const observed = readJevConfigFile(stableRoot);
  assert.equal(observed.ok, false);
  assert.equal(observed.sha256, createHash('sha256').update('{broken').digest('hex'));
  const jev = createJev();
  await setJev(jev, home, config({ capabilities: { routing: false, supervision: true } }));
  await setJevKey(jev, home, fakeOrKey('disk-sequence-test'));
  const keyFile = keyPath(home);
  const read = fs.readFileSync;
  const reads = [];
  const mocked = t.mock.method(fs, 'readFileSync', (...args) => { reads.push(args[0]); return read(...args); });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(observeJevKey(stableRoot, 'openrouter'), { hasKey: true, keyPermissionsOk: true });
    assert.equal((await getJev(jev, home)).jev.hasKey, true);
    assert.equal(runtimeStatus(home).jev.hasKey, true);
    assert.equal(reads.filter(path => path === keyFile).length, 0, 'all observation surfaces avoid key bytes');
    const secure = readJevKeyFile(stableRoot, 'openrouter');
    assert.equal(secure.ok, true);
    assert.equal(secure.valid, true);
    assert.equal(reads.filter(path => path === keyFile).length, 1, 'secure read observes then reads once');
    reads.length = 0;
    chmodSync(keyFile, 0o644);
    assert.deepEqual(observeJevKey(stableRoot, 'openrouter'), { hasKey: true, keyPermissionsOk: false });
    assert.equal(readJevKeyFile(stableRoot, 'openrouter').reason, 'permissions');
    assert.throws(() => readJevKey(home, 'openrouter'), error => error.code === 'jev-key-permissions' && /mode 0644/.test(error.message));
    assert.equal(resolveSupervision(stableRoot).reason, 'jev-key-permissions');
    assert.equal((await testJev(jev, home)).ok, false);
    assert.equal(reads.filter(path => path === keyFile).length, 0, 'no insecure credential read occurs before refusal');
    chmodSync(keyFile, 0o600);
    rmSync(keyFile);
    symlinkSync(jevPath(home), keyFile);
    assert.deepEqual(observeJevKey(stableRoot, 'openrouter'), { hasKey: false, keyPermissionsOk: null });
    assert.equal(readJevKeyFile(stableRoot, 'openrouter').reason, 'not-regular');
    assert.throws(() => readJevKey(home, 'openrouter'), error => error.code === 'jev-key-invalid');
    assert.equal(resolveSupervision(stableRoot).reason, 'jev-key-missing');
    assert.equal(reads.filter(path => path === keyFile).length, 0, 'symlinks never reach the credential read');
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('private empty/whitespace keys keep observation, decision and auth-probe policies distinct', async t => {
  const home = makeHome(t), stableRoot = join(home, 'slp-runtime');
  let calls = 0;
  const jev = createJev({ fetchImpl: async () => { calls++; return { ok: false, status: 401 }; } });
  await setJev(jev, home, config({ capabilities: { supervision: true } }));
  for (const raw of [' \n\t', 'internal space\n']) {
    writeFileSync(keyPath(home), raw, { mode: 0o600 });
    assert.deepEqual(observeJevKey(stableRoot, 'openrouter'), { hasKey: true, keyPermissionsOk: true });
    assert.equal(readJevKeyFile(stableRoot, 'openrouter').valid, false);
    assert.throws(() => readJevKey(home, 'openrouter'), error => error.code === 'jev-key-invalid');
    assert.equal(resolveSupervision(stableRoot).reason, 'jev-key-invalid');
    const tested = await testJev(jev, home);
    assert.deepEqual({ ok: tested.ok, detail: tested.detail }, { ok: false, detail: 'OpenRouter answered HTTP 401' });
  }
  assert.equal(calls, 2, 'explicit auth probes retain legacy provider-side validity checking');
});

test('key filesystem errors retain stage-specific CLI, observation, supervision and probe dialects', async t => {
  const home = makeHome(t), stableRoot = join(home, 'slp-runtime');
  const jev = createJev({ fetchImpl: async () => { throw new Error('must not reach network'); } });
  await setJev(jev, home, config({ capabilities: { supervision: true } }));
  await setJevKey(jev, home, fakeOrKey('stage-error-test'));
  const keyFile = keyPath(home), stat = fs.lstatSync, read = fs.readFileSync;
  const denied = Object.assign(new Error('synthetic key read denied'), { code: 'EACCES' });
  let statMock = t.mock.method(fs, 'lstatSync', file => { if (file === keyFile) throw denied; return stat(file); });
  syncBuiltinESMExports();
  try {
    const observed = readJevKeyFile(stableRoot, 'openrouter');
    assert.equal(observed.reason, 'unreadable');
    assert.equal(observed.stage, 'stat');
    assert.deepEqual(observeJevKey(stableRoot, 'openrouter'), { hasKey: false, keyPermissionsOk: null });
    assert.throws(() => readJevKey(home, 'openrouter'), error => error === denied, 'CLI rethrows lstat failure unchanged');
    assert.equal(resolveSupervision(stableRoot).reason, 'jev-key-missing');
    assert.match((await testJev(jev, home)).detail, /^no key stored/);
  } finally { statMock.mock.restore(); syncBuiltinESMExports(); }
  const readMock = t.mock.method(fs, 'readFileSync', (...args) => { if (args[0] === keyFile) throw denied; return read(...args); });
  syncBuiltinESMExports();
  try {
    const observed = readJevKeyFile(stableRoot, 'openrouter');
    assert.equal(observed.reason, 'unreadable');
    assert.equal(observed.stage, 'read');
    assert.deepEqual(observeJevKey(stableRoot, 'openrouter'), { hasKey: true, keyPermissionsOk: true }, 'stat-only surface does not read');
    assert.throws(() => readJevKey(home, 'openrouter'), error => error === denied, 'CLI rethrows read failure unchanged');
    assert.equal(resolveSupervision(stableRoot).reason, 'jev-key-unreadable');
    assert.equal((await testJev(jev, home)).detail, 'key file unreadable: synthetic key read denied');
  } finally { readMock.mock.restore(); syncBuiltinESMExports(); }
});
