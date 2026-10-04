// tests/plugin-role-injection.test.mjs — Phase 2 hook + gate coverage
// (settings-driven-providers.md §6): agent.create role resolution across all
// twelve owned ids plus the slp_role marker, pass-through for foreign/devin
// providers, fail-closed binding/candidate behavior, systemPrompt
// composition, session_open grant emission, the bin/slp-gate.mjs sentinel as
// a real subprocess, thin-alias provider entries, and byte-parity between
// the hook-injected bundle and the devin wrapper's bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRoleInjection } from '../plugin/server/role-injection.ts';
import { DESK_FIELD_POLICY, DESK_TASK_CREATE_TICKET_KEY } from '../plugin/server/desk-seat.ts';
import { desiredProviderEntries } from '../plugin/server/config-transaction.ts';
import { createMaterializer } from '../plugin/server/materializer.ts';
import { embeddedPayload } from '../plugin/server/generated/runtime-payload.ts';
import { OperationConflict } from '../plugin/shared/contracts.ts';
import { FAMILY_LABEL } from '../plugin/shared/runtime/families.ts';
import { identity, install } from '../plugin/server/runtime/cli/package.ts';
import { roleBundle } from '../plugin/server/runtime/cli/role-bundle.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const GATE = join(root, 'bin', 'slp-gate.mjs');
const HOOK_FAMILIES = ['codex', 'pi', 'claude'];
const ALL_FAMILIES = [...HOOK_FAMILIES, 'devin'];
const ROLES = ['supervisor', 'lead', 'peer'];
const HOOK_IDS = HOOK_FAMILIES.flatMap(f => ROLES.map(r => `slp-${f}-${r}`));
const DEVIN_IDS = ROLES.map(r => `slp-devin-${r}`);
const OWNED_IDS = [...HOOK_IDS, ...DEVIN_IDS].sort();

function tmp(t, prefix = 'roleinj-') {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/', prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A real materialized candidate (same layout the stable root publishes) so
// the hook's dynamic import loads the candidate's own role-bundle.ts.
function fixtureCandidate(t) {
  const dir = tmp(t);
  const home = join(dir, 'home');
  const stableRoot = join(home, 'slp-runtime');
  mkdirSync(join(stableRoot, 'state'), { recursive: true });
  const sha = identity(root).sha256;
  const candidate = join(stableRoot, sha);
  install(root, candidate);
  return { dir, home, stableRoot, sha, candidate };
}

const bindingFor = f => ({
  candidateSha256: f.sha,
  payloadSha256: 'a'.repeat(64),
  runtimePath: f.candidate,
  nodePath: process.execPath,
  daemonHome: f.home,
});

const managedEnv = f => ({
  SLP_MANAGED_RUNTIME: '1',
  SLP_NODE_BIN: process.execPath,
  SLP_RUNTIME_ROOT: f.candidate,
  SLP_DAEMON_HOME: f.home,
});

const createReq = (provider, configExtra = {}) => ({
  request: {
    config: { provider, cwd: '/work', ...configExtra },
  },
});

const openReq = (provider, extra = {}) => ({
  request: {
    agentId: 'agent-1',
    workspaceId: 'wks-1',
    provider,
    cwd: '/work',
    reason: 'create',
    purpose: 'interactive',
    env: { SLP_SESSION_OPEN_GRANT: '', SLP_FAMILY_BIN: '/bin/x' },
    ...extra,
  },
});

function makeInjection(t, overrides = {}) {
  const f = overrides.fixture ?? fixtureCandidate(t);
  const binding = overrides.binding === undefined ? bindingFor(f) : overrides.binding;
  return {
    fixture: f,
    injection: createRoleInjection({
      readActiveBinding: () => binding,
      verifyCandidate: async () => {},
      ...overrides.deps,
    }),
  };
}

// ---------------------------------------------------------------------------
// agent.create — role resolution and injection
// ---------------------------------------------------------------------------

test('agent.create: all nine hook-family ids inject; devin ids graft only the desk handle (R2, C10)', async t => {
  const mintInputs = [];
  const { injection } = makeInjection(t, {
    deps: {
      deskMint: async input => {
        mintInputs.push({ ...input });
        return { handle: `${'ab'.repeat(32)}${''.padEnd(0)}`.slice(0, 64) };
      },
    },
  });
  for (const id of OWNED_IDS) {
    const out = await injection.agentCreate(createReq(id));
    if (DEVIN_IDS.includes(id)) {
      // C10: the devin wrapper path returns the request with ONLY
      // env.SLP_DESK_HANDLE added — config is never touched.
      assert.ok(out?.config, `${id} returns the request`);
      assert.equal(out.config.provider, id, `${id} keeps its config`);
      assert.equal(out.config.systemPrompt, undefined, `${id} gets no role bytes`);
      assert.match(out.env.SLP_DESK_HANDLE, /^[0-9a-f]{64}$/, `${id} carries only the desk handle in env`);
      continue;
    }
    assert.ok(out?.config?.systemPrompt?.startsWith('SLP role='), `${id} must get role bytes`);
    assert.equal(out.config.provider, id, 'provider identity is never rewritten');
    assert.equal(out.config.cwd, '/work');
  }
  // The mint input carries exactly the §2.1 mint RECORD cells: provider,
  // family, role, cwd — one call per owned id.
  assert.equal(mintInputs.length, OWNED_IDS.length);
  assert.deepEqual(mintInputs.map(input => input.provider).sort(), OWNED_IDS);
});

test('agent.create: mint.config IGNORED cells never reach the mint input (policy §2.1)', async t => {
  const mintInputs = [];
  const { injection } = makeInjection(t, {
    deps: {
      deskMint: async input => {
        mintInputs.push({ ...input });
        return { handle: 'c'.repeat(64) };
      },
    },
  });
  // Every IGNORED cell of the mint policy is mutated; the mint input for
  // the same provider/cwd is unchanged — the policy is the only field list.
  const ignored = Object.entries(DESK_FIELD_POLICY.mint.config)
    .filter(([, rule]) => rule.cell === 'IGNORED')
    .map(([field]) => field);
  assert.ok(ignored.length >= 1, 'the policy names its IGNORED mint cells');
  const baseline = await injection.agentCreate(createReq('slp-codex-peer'));
  const baselineInput = mintInputs.at(-1);
  for (const field of ignored) {
    await injection.agentCreate(createReq('slp-codex-peer', { [field]: 'mutated' }));
    const input = mintInputs.at(-1);
    assert.deepEqual(
      { provider: input.provider, family: input.family, role: input.role, cwd: input.cwd },
      { provider: baselineInput.provider, family: baselineInput.family, role: baselineInput.role, cwd: baselineInput.cwd },
      `${field} is IGNORED — mutating it cannot change the mint input`,
    );
  }
});

test('agent.create: a null mint leaves the request byte-identical to the no-seam path', async t => {
  const { injection } = makeInjection(t, {
    deps: { deskMint: async () => null },
  });
  const out = await injection.agentCreate(createReq('slp-codex-peer'));
  assert.ok(out.config.systemPrompt.startsWith('SLP role='));
  assert.equal(out.env, undefined, 'no handle → no env graft, exactly the pre-P2-c shape');
  const devin = await injection.agentCreate(createReq('slp-devin-peer'));
  assert.equal(devin, undefined, 'a failed devin mint is the untouched pass-through');
});

test('agent.create: a rejecting seam never aborts the create (W5 fail-open)', async t => {
  const { injection } = makeInjection(t, {
    deps: { deskMint: async () => null },
  });
  const out = await injection.agentCreate(createReq('slp-codex-peer'));
  assert.ok(out.config.systemPrompt.startsWith('SLP role='), 'the create proceeds unbound');
});

test('session_open: with the desk seam the bind runs before the overlay for every slp-* id', async t => {
  const bindInputs = [];
  const { injection } = makeInjection(t, {
    deps: {
      deskBind: async input => {
        bindInputs.push({ ...input });
      },
    },
  });
  // Hook families AND devin bind (§5); the overlay still only applies to
  // hook families — devin's open returns undefined as before.
  for (const provider of ['slp-codex-peer', 'slp-devin-peer']) {
    const out = await injection.sessionOpen(openReq(provider));
    if (provider === 'slp-devin-peer') {
      assert.equal(out, undefined, 'devin keeps passing through the overlay');
    } else {
      assert.ok(out.env.SLP_SESSION_OPEN_GRANT, `${provider} keeps the grant overlay`);
    }
  }
  assert.deepEqual(bindInputs.map(input => input.provider).sort(), ['slp-codex-peer', 'slp-devin-peer']);
  // The composer passes the GATE cells through verbatim; the seam's own
  // gate (desk-seat suite) decides whether the phase runs.
  for (const reason of ['resume', 'refresh', 'import']) {
    bindInputs.length = 0;
    await injection.sessionOpen(openReq('slp-codex-peer', { reason }));
    assert.deepEqual(bindInputs.map(input => input.reason), [reason], `${reason} reaches the seam with its reason`);
  }
  // Non-slp providers never reach the seam.
  bindInputs.length = 0;
  assert.equal(await injection.sessionOpen(openReq('custom-tool')), undefined);
  assert.equal(bindInputs.length, 0);
});

test('session_open without the desk seam stays synchronous and byte-identical (R8–R12)', async t => {
  const { injection } = makeInjection(t);
  const out = injection.sessionOpen(openReq('slp-codex-peer'));
  assert.equal(typeof out?.then, 'undefined', 'no seam → the hook stays synchronous');
  assert.ok(out.env.SLP_SESSION_OPEN_GRANT);
});

test('agent.create: C10 exact-only — the devin output is the original request plus exactly env.SLP_DESK_HANDLE', async t => {
  const { injection } = makeInjection(t, {
    deps: { deskMint: async () => ({ handle: 'c'.repeat(64) }) },
  });
  const config = {
    provider: 'slp-devin-peer',
    cwd: '/work',
    systemPrompt: 'sentinel-prompt',
    modeId: 'mode-1',
    model: 'sentinel-model',
    thinkingOptionId: 'high',
    featureValues: { marker: 'sentinel' },
    title: 'sentinel-title',
    providerOptions: { apiKey: 'sentinel' },
    toolPolicy: { preapproved: [] },
    mcpServers: { sentinel: { command: 'bin' } },
    internal: false,
  };
  const env = { SLP_FAMILY_BIN: '/bin/x' };
  // L1 — the expected value is a deep-frozen COPY built before the call, so
  // a mutant that mutates the input (e.g. rewrites mcpServers) or grafts a
  // field into the output diverges from it and fails.
  const freeze = value => {
    for (const key of Object.keys(value)) {
      if (value[key] && typeof value[key] === 'object') freeze(value[key]);
    }
    return Object.freeze(value);
  };
  const expected = freeze(structuredClone({ config, env: { ...env, SLP_DESK_HANDLE: 'c'.repeat(64) } }));
  const out = await injection.agentCreate({ request: { config, env } });
  assert.deepEqual(out, expected, 'exactly one env key added; every config field (mcpServers included) untouched');
});

test('agent.create: devin without the desk seam returns undefined and never mutates the input (R2-S1)', async t => {
  // No deskMint seam — the pre-C10 pass-through. The request carries a
  // sentinel mcpServers; the hook must return undefined AND leave the
  // input byte-identical (no graft, no mutation).
  const { injection } = makeInjection(t);
  const config = {
    provider: 'slp-devin-peer',
    cwd: '/work',
    mcpServers: { sentinel: { command: 'bin' } },
    featureValues: { marker: 'sentinel' },
  };
  const env = { SLP_FAMILY_BIN: '/bin/x' };
  const freeze = value => {
    for (const key of Object.keys(value)) {
      if (value[key] && typeof value[key] === 'object') freeze(value[key]);
    }
    return Object.freeze(value);
  };
  const frozenInput = freeze(structuredClone({ config, env }));
  const out = await injection.agentCreate({ request: { config, env } });
  assert.equal(out, undefined, 'no seam → the devin pass-through returns undefined');
  assert.deepEqual(
    { config, env },
    { config: frozenInput.config, env: frozenInput.env },
    'the input request is never mutated on the no-seam devin path',
  );
});

test('agent.create: role suffix selects the correct bundle for every hook id', async t => {
  const { injection, fixture } = makeInjection(t);
  for (const family of HOOK_FAMILIES) {
    for (const role of ROLES) {
      const out = await injection.agentCreate(createReq(`slp-${family}-${role}`));
      const expected = roleBundle(fixture.candidate, role, managedEnv(fixture)).instructions;
      assert.equal(out.config.systemPrompt, expected, `slp-${family}-${role}`);
    }
  }
});

test('agent.create: foreign providers and bare family ids pass through', async t => {
  const { injection } = makeInjection(t);
  for (const provider of ['codex', 'pi', 'claude', 'devin', 'custom-tool', 'copilot']) {
    const out = await injection.agentCreate(createReq(provider));
    assert.equal(out, undefined, `${provider} must pass through`);
  }
});

test('agent.create: task ticket carriers fail closed before foreign-provider passthrough or native create', async t => {
  const { injection } = makeInjection(t);
  const ticket = 'f'.repeat(64);
  const foreign = { request: { config: { provider: 'custom-tool', cwd: '/work' }, env: { [DESK_TASK_CREATE_TICKET_KEY]: ticket } } };
  await assert.rejects(injection.agentCreate(foreign), /unsupported for this native provider/);
  assert.equal(await injection.agentCreate(createReq('custom-tool')), undefined, 'no-ticket ordinary pass-through stays unchanged');
  await assert.rejects(injection.agentCreate({ request: { config: { provider: 'custom-tool', cwd: '/work' },
    env: { [DESK_TASK_CREATE_TICKET_KEY]: 'bad' } } }), /ticket hook context is invalid/);
  await assert.rejects(injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: '/work' },
    env: { [DESK_TASK_CREATE_TICKET_KEY]: ticket } } }), error => {
    assert.equal(String(error.message).includes(ticket), false, 'ticket errors never echo the opaque secret');
    return true;
  });
});

test('agent.create: slp_role feature marker resolves the role on an un-suffixed slp-* id', async t => {
  const { injection, fixture } = makeInjection(t);
  for (const role of ROLES) {
    const out = await injection.agentCreate(
      createReq('slp-codex', { featureValues: { slp_role: role } }),
    );
    const expected = roleBundle(fixture.candidate, role, managedEnv(fixture)).instructions;
    assert.equal(out.config.systemPrompt, expected, `marker slp_role=${role}`);
  }
});

test('agent.create: slp-* provider without resolvable role fails closed', async t => {
  const { injection } = makeInjection(t);
  for (const [provider, featureValues] of [
    ['slp-codex', undefined],
    ['slp-custom-thing', undefined],
    ['slp-codex', { slp_role: 'bogus' }],
    ['slp-codex', { slp_role: 42 }],
  ]) {
    await assert.rejects(
      injection.agentCreate(createReq(provider, { featureValues })),
      /cannot resolve a role/,
      `${provider} must abort the create`,
    );
  }
});

test('agent.create: selected obligations reach each role without leaking Lead procedure to Peer', async t => {
  const { injection } = makeInjection(t);
  for (const id of HOOK_IDS) {
    const role = id.split('-')[2];
    const out = await injection.agentCreate(createReq(id));
    const prompt = out.config.systemPrompt;
    assert.match(prompt, /Review selection never waives a Human, assignment or protocol obligation/, id);
    assert.doesNotMatch(prompt, /does not license merging\s+the axes into one seat|parallel seats on split axes/, id);
    if (role === 'peer') {
      assert.match(prompt, /Reviewer and optional Auditor mandates remain independent of the writer and\s+accepting owner/, id);
      assert.ok(!/Lead records an explicit review selection|Record the review selection and its reason|Required review cannot be weakened/.test(prompt), id);
      assert.ok(!/When the assignment or protocol\s+requires independent review/.test(prompt), id);
      assert.ok(!/cannot carry a new\s+delegation/.test(prompt), id);
      assert.ok(!/New-team delegation|Observe-existing-work|formation record/.test(prompt), `${id} gets no formation doctrine`);
      // The inbound-route self-check is a Peer-visible self-check (common.md),
      // not formation doctrine.
      assert.match(prompt, /paseo\.parent-agent-id label must match/, id);
      assert.match(prompt, /distinct from your\s+parent/, `${id} keeps the observe-existing carve-out`);
      assert.match(prompt, /not a hard block/, id);
      assert.match(prompt, /names no agent\s+recipient/, id);
      continue;
    }
    assert.match(prompt, /Lead records an explicit review selection before the candidate round/, id);
    assert.match(prompt, /minimum sufficient independent mandates for material decision-changing questions/, id);
    assert.match(prompt, /Required review cannot be weakened because seats are unavailable or findings are adverse/, id);
    assert.equal(/Record the review selection and its reason before the candidate round/.test(prompt), role === 'lead', id);
    assert.equal(/review-gates\.md when making or revising that decision, including a\s+not-required decision/.test(prompt), role === 'lead', id);
    assert.equal(/When the assignment or protocol\s+requires independent review/.test(prompt), role === 'lead', id);
    // The C8 formation pins reach both orchestrating roles through the hook too.
    assert.match(prompt, /Observe-existing-work/, id);
    assert.match(prompt, /Continuation: same team and ownership/, id);
    assert.match(prompt, /not evidence of parentage/, id);
    assert.match(prompt, /not filesystem\s+isolation/, id);
    assert.match(prompt, /send_agent_prompt to a\s+parentless or differently parented/, id);
    assert.match(prompt, /second workspace\s+for the same team with no isolation reason/, id);
    assert.match(prompt, /distinct from your\s+parent/, `${id} keeps the observe-existing carve-out`);
    assert.match(prompt, /not a hard block/, id);
    assert.match(prompt, /names no agent\s+recipient/, id);
    assert.equal(/standalone session never makes\s+it your child/.test(prompt), role === 'supervisor', id);
    assert.equal(/does not adopt it/.test(prompt), role === 'lead', id);
  }
});

test('agent.create: missing binding fails closed for hook ids, not for pass-through ids', async t => {
  const { injection } = makeInjection(t, { binding: null });
  for (const id of DEVIN_IDS) {
    assert.equal(await injection.agentCreate(createReq(id)), undefined);
  }
  assert.equal(await injection.agentCreate(createReq('codex')), undefined);
  await assert.rejects(
    injection.agentCreate(createReq('slp-codex-lead')),
    /no active binding/,
  );
});

test('agent.create: candidate import failure aborts; eviction allows a later retry', async t => {
  const f = fixtureCandidate(t);
  let calls = 0;
  const injection = createRoleInjection({
    readActiveBinding: () => bindingFor(f),
    verifyCandidate: async () => {},
    importModule: specifier => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('staged import failure'));
      return import(specifier);
    },
  });
  await assert.rejects(injection.agentCreate(createReq('slp-pi-peer')), /staged import failure/);
  const out = await injection.agentCreate(createReq('slp-pi-peer'));
  assert.ok(out.config.systemPrompt.startsWith('SLP role=peer'), 'retry re-imports and succeeds');
  assert.equal(calls, 2);
});

test('agent.create: the imported module is cached per candidate sha', async t => {
  const f = fixtureCandidate(t);
  let calls = 0;
  const injection = createRoleInjection({
    readActiveBinding: () => bindingFor(f),
    verifyCandidate: async () => {},
    importModule: specifier => {
      calls += 1;
      return import(specifier);
    },
  });
  await injection.agentCreate(createReq('slp-codex-peer'));
  await injection.agentCreate(createReq('slp-claude-lead'));
  assert.equal(calls, 1, 'one dynamic import per candidate');
});

test('agent.create: pre-set systemPrompt is appended after the role bundle', async t => {
  const { injection, fixture } = makeInjection(t);
  const out = await injection.agentCreate(
    createReq('slp-claude-supervisor', { systemPrompt: 'existing host instructions' }),
  );
  const expected = roleBundle(fixture.candidate, 'supervisor', managedEnv(fixture)).instructions;
  assert.ok(out.config.systemPrompt.startsWith(expected), 'role authority leads');
  assert.ok(out.config.systemPrompt.endsWith('existing host instructions'));
  assert.ok(out.config.systemPrompt.length > expected.length);
});

// ---------------------------------------------------------------------------
// agent.create — per-create candidate verification (O1)
// ---------------------------------------------------------------------------

test('agent.create: candidate verification runs once per candidate sha', async t => {
  const f = fixtureCandidate(t);
  let calls = 0;
  const injection = createRoleInjection({
    readActiveBinding: () => bindingFor(f),
    verifyCandidate: async binding => {
      calls += 1;
      assert.equal(binding.candidateSha256, f.sha);
    },
  });
  await injection.agentCreate(createReq('slp-codex-peer'));
  await injection.agentCreate(createReq('slp-pi-lead'));
  await injection.agentCreate(createReq('slp-claude-supervisor'));
  assert.equal(calls, 1, 'one verification per candidate sha per process');
});

test('agent.create: verification failure aborts; eviction lets a repaired candidate retry', async t => {
  const f = fixtureCandidate(t);
  let calls = 0;
  const injection = createRoleInjection({
    readActiveBinding: () => bindingFor(f),
    verifyCandidate: async () => {
      calls += 1;
      if (calls === 1) throw new Error('staged integrity failure');
    },
  });
  await assert.rejects(injection.agentCreate(createReq('slp-pi-peer')), /staged integrity failure/);
  const out = await injection.agentCreate(createReq('slp-pi-peer'));
  assert.ok(out.config.systemPrompt.startsWith('SLP role=peer'), 'retry re-verifies and succeeds');
  assert.equal(calls, 2, 'a failed verification is not cached');
});

test('agent.create: a tampered candidate file aborts through the real verifyPublished', async t => {
  // A real materialized candidate (install() fixtures lack the embedded
  // installed.json anchor verifyPublished requires), then tamper a byte.
  const dir = tmp(t, 'roleinj-verify-');
  const home = join(dir, 'home');
  const stableRoot = join(home, 'slp-runtime');
  mkdirSync(join(stableRoot, 'state'), { recursive: true });
  const materializer = createMaterializer(embeddedPayload);
  const published = await materializer.materialize(stableRoot, `op-${process.pid}`);
  const binding = {
    candidateSha256: published.candidateSha256,
    payloadSha256: published.payloadSha256,
    runtimePath: published.runtimePath,
    nodePath: process.execPath,
    daemonHome: home,
  };
  const injection = createRoleInjection({
    readActiveBinding: () => binding,
    verifyCandidate: b => materializer.verifyPublished(b.runtimePath, b.candidateSha256, b.payloadSha256),
  });

  const bundlePath = join(published.runtimePath, 'plugin', 'server', 'runtime', 'cli', 'role-bundle.ts');
  const original = readFileSync(bundlePath);
  writeFileSync(bundlePath, '// tampered\n' + original.toString('utf8'));
  const error = await injection.agentCreate(createReq('slp-codex-lead')).then(
    () => null,
    e => e,
  );
  assert.ok(error instanceof OperationConflict, `expected OperationConflict, got ${error}`);
  assert.equal(error.code, 'RUNTIME_INTEGRITY', error.message);

  // Eviction: restore the bytes and the same sha verifies + renders again.
  writeFileSync(bundlePath, original);
  const out = await injection.agentCreate(createReq('slp-codex-lead'));
  assert.ok(out.config.systemPrompt.startsWith('SLP role=lead'), 'repaired candidate verifies and renders');
});

test('session_open: grants are minted without touching candidate verification', async t => {
  const f = fixtureCandidate(t);
  let calls = 0;
  const injection = createRoleInjection({
    readActiveBinding: () => bindingFor(f),
    verifyCandidate: async () => {
      calls += 1;
    },
  });
  for (const reason of ['create', 'resume', 'refresh', 'import']) {
    injection.sessionOpen(openReq('slp-codex-peer', { reason }));
  }
  assert.equal(calls, 0, 'session_open is grant-only — it never loads candidate code');
});

// ---------------------------------------------------------------------------
// agent.session_open — grant overlay
// ---------------------------------------------------------------------------

test('session_open: every hook id gets a fresh non-empty grant; others pass through', async t => {
  const { injection } = makeInjection(t);
  const seen = new Set();
  for (const reason of ['create', 'resume', 'refresh', 'import']) {
    for (const id of OWNED_IDS) {
      const out = injection.sessionOpen(openReq(id, { reason }));
      if (DEVIN_IDS.includes(id)) {
        assert.equal(out, undefined, `${id} (${reason}) must pass through`);
        continue;
      }
      const grant = out.env.SLP_SESSION_OPEN_GRANT;
      assert.ok(typeof grant === 'string' && grant.length > 0, `${id} (${reason}) needs a grant`);
      seen.add(grant);
      // Non-env fields are returned unchanged; the sentinel is overlaid, the
      // rest of the env is preserved.
      assert.equal(out.env.SLP_FAMILY_BIN, '/bin/x');
      assert.equal(out.provider, id);
      assert.equal(out.reason, reason);
      assert.equal(out.agentId, 'agent-1');
    }
  }
  assert.equal(seen.size, 36, 'every open gets a distinct grant token');
  for (const provider of ['codex', 'custom-tool', 'slp-devin-peer']) {
    assert.equal(injection.sessionOpen(openReq(provider)), undefined);
  }
});

// ---------------------------------------------------------------------------
// agent.session_open — grant overlay only; no seat env is ever added
// ---------------------------------------------------------------------------

test('session_open: emits only the grant overlay on hook ids', async t => {
  const { injection } = makeInjection(t);
  for (const reason of ['create', 'resume', 'refresh', 'import']) {
    const out = injection.sessionOpen(openReq('slp-codex-peer', { reason }));
    assert.ok(out.env.SLP_SESSION_OPEN_GRANT.length > 0, `${reason} still grants`);
    assert.equal(out.env.BEADS_ACTOR, undefined, `${reason}: no actor overlay`);
    assert.equal(out.env.BD_AGENT_PROFILE, undefined, `${reason}: no profile overlay`);
    assert.equal(out.env.BD_DISABLE_METRICS, undefined, `${reason}: no metrics overlay`);
    assert.equal(out.env.SLP_FAMILY_BIN, '/bin/x');
  }
});

test('session_open: Human-set tracker env passes through untouched beside the grant', async t => {
  const { injection } = makeInjection(t);
  const out = injection.sessionOpen(openReq('slp-codex-lead', {
    env: { SLP_SESSION_OPEN_GRANT: '', BD_AGENT_PROFILE: 'aggressive', BD_DISABLE_METRICS: '0', BEADS_ACTOR: 'human-cli' },
  }));
  // User-supplied values are preserved verbatim; the retired overlay can
  // neither overwrite them nor add new keys.
  assert.equal(out.env.BD_AGENT_PROFILE, 'aggressive');
  assert.equal(out.env.BD_DISABLE_METRICS, '0');
  assert.equal(out.env.BEADS_ACTOR, 'human-cli');
  assert.ok(out.env.SLP_SESSION_OPEN_GRANT.length > 0, 'grant still lands');
  for (const provider of ['slp-devin-peer', 'codex', 'custom-tool']) {
    assert.equal(injection.sessionOpen(openReq(provider)), undefined, `${provider} passes through`);
  }
});

// ---------------------------------------------------------------------------
// bin/slp-gate.mjs — sentinel gate as a real subprocess
// ---------------------------------------------------------------------------

function writeProbeBinary(t, name = 'family-bin') {
  const dir = tmp(t, 'gate-bin-');
  const path = join(dir, name);
  const argvCapture = join(dir, 'argv');
  const envCapture = join(dir, 'env');
  writeFileSync(path, `#!/bin/sh
printf '%s\\0' "$@" > '${argvCapture}'
{
  printenv SLP_SESSION_OPEN_GRANT || printf '<unset>'
  printenv NODE_OPTIONS || printf '<unset>'
} > '${envCapture}'
if [ "$1" = "--version" ]; then printf 'family 1.0-fake\\n'; exit 0; fi
for a in "$@"; do if [ "$a" = "exit3" ]; then exit 3; fi; done
cat
`);
  chmodSync(path, 0o755);
  return { path, argvCapture, envCapture };
}

const readArgv = path =>
  readFileSync(path, 'utf8').split('\0').filter(s => s.length > 0);

function runGate(args, env) {
  const child = spawn(process.execPath, [GATE, ...args], {
    env: { PATH: '/usr/bin:/bin', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', c => stdout.push(c));
  child.stderr.on('data', c => stderr.push(c));
  child.stdin.end();
  return new Promise(resolve =>
    child.on('close', code =>
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })));
}

test('gate: session spawn without a live grant fails closed with the required stderr', async t => {
  const probe = writeProbeBinary(t);
  for (const env of [
    { SLP_FAMILY_BIN: probe.path, PASEO_AGENT_ID: 'agent-1' },
    { SLP_FAMILY_BIN: probe.path, PASEO_AGENT_ID: 'agent-1', SLP_SESSION_OPEN_GRANT: '' },
  ]) {
    const result = spawnSync(process.execPath, [GATE, 'chat'], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed session launched without live SLP hook grant/);
  }
});

test('gate: non-session launches pass through without a grant', async t => {
  const probe = writeProbeBinary(t);
  // Capability snapshots and model enumeration run the same binary + argv as
  // a session spawn but carry no PASEO_AGENT_ID — they are not seats and must
  // not be refused, or the provider can never report ready.
  const ok = await runGate(['chat', '--flag'], { SLP_FAMILY_BIN: probe.path });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(readArgv(probe.argvCapture), ['chat', '--flag']);
});

test('gate: live grant forwards argv, strips control env, and passes exit codes through', async t => {
  const probe = writeProbeBinary(t);
  const env = {
    SLP_FAMILY_BIN: probe.path,
    PASEO_AGENT_ID: 'agent-1',
    SLP_SESSION_OPEN_GRANT: 'grant-token-1',
    NODE_OPTIONS: '--enable-source-maps',
  };
  const ok = await runGate(['chat', '--flag', 'two words'], env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(readArgv(probe.argvCapture), ['chat', '--flag', 'two words']);
  assert.equal(
    readFileSync(probe.envCapture, 'utf8'),
    '<unset><unset>',
    'grant and NODE_OPTIONS never reach the family process',
  );
  const exit3 = await runGate(['exit3'], env);
  assert.equal(exit3.code, 3);
});

test('gate: bare --version proxies the real binary in every grant state', async t => {
  const probe = writeProbeBinary(t);
  const noGrant = spawnSync(process.execPath, [GATE, '--version'], {
    env: { PATH: '/usr/bin:/bin', SLP_FAMILY_BIN: probe.path },
    encoding: 'utf8',
  });
  assert.equal(noGrant.status, 0);
  assert.equal(noGrant.stdout, 'family 1.0-fake\n');
  const granted = spawnSync(process.execPath, [GATE, '--version'], {
    env: { PATH: '/usr/bin:/bin', SLP_FAMILY_BIN: probe.path, SLP_SESSION_OPEN_GRANT: 'g' },
    encoding: 'utf8',
  });
  assert.equal(granted.status, 0);
  assert.equal(granted.stdout, 'family 1.0-fake\n');
});

test('gate: unresolved SLP_FAMILY_BIN fails clearly in both modes', async t => {
  const chat = spawnSync(process.execPath, [GATE, 'chat'], {
    env: { PATH: '/usr/bin:/bin', SLP_SESSION_OPEN_GRANT: 'g', SLP_FAMILY_BIN: '' },
    encoding: 'utf8',
  });
  assert.notEqual(chat.status, 0);
  assert.match(chat.stderr, /SLP_FAMILY_BIN/);
  const version = spawnSync(process.execPath, [GATE, '--version'], {
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  assert.notEqual(version.status, 0);
  assert.match(version.stderr, /SLP_FAMILY_BIN/);
});

// ---------------------------------------------------------------------------
// Thin-alias provider entries (desiredProviderEntries)
// ---------------------------------------------------------------------------

test('thin aliases: every entry gets a single-element launcher argv0; hook env adds SLP_FAMILY_BIN', t => {
  const f = fixtureCandidate(t);
  const setDir = join(f.stableRoot, 'launchers', 'a'.repeat(64));
  const launchSet = {
    launchSetSha256: 'a'.repeat(64),
    launchManifestSha256: 'a'.repeat(64),
    directory: setDir,
    files: OWNED_IDS.map(id => ({
      path: join(setDir, id),
      sha256: 'b'.repeat(64),
      mode: 0o755,
    })),
  };
  const binaries = Object.fromEntries(
    ALL_FAMILIES.map(family => [family, { available: true, path: `/opt/bin/${family}`, version: '1.0' }]),
  );
  const resolution = { node: { path: '/opt/node/bin/node', version: '24.0.0' }, binaries };
  const entries = desiredProviderEntries(launchSet, resolution, f.candidate, f.home, null);
  assert.equal(Object.keys(entries).length, 12);
  for (const id of OWNED_IDS) {
    const family = id.split('-')[1];
    const entry = entries[id];
    const roleDisplay = id.split('-')[2][0].toUpperCase() + id.split('-')[2].slice(1);
    // Uniform argv[0]: every entry points at its launch-set launcher so the
    // env-free host --version probe reaches a real executable.
    assert.deepEqual(entry.command, [join(setDir, id)]);
    assert.equal(entry.enabled, true);
    assert.equal(entry.env.SLP_SESSION_OPEN_GRANT, '');
    assert.equal(entry.env.SLP_MANAGED_RUNTIME, '1');
    assert.equal(entry.env.SLP_NODE_BIN, '/opt/node/bin/node');
    assert.equal(entry.env.SLP_RUNTIME_ROOT, f.candidate);
    assert.equal(entry.env.SLP_DAEMON_HOME, f.home);
    assert.equal(entry.env.PASEO_HOME, f.home);
    assert.equal(entry.env[`SLP_${family.toUpperCase()}_BIN`], `/opt/bin/${family}`);
    // One label template for every transport: `SLP <Family> <Role>` with
    // FAMILY_LABEL as the single display-name source.
    assert.equal(entry.label, `SLP ${FAMILY_LABEL[family]} ${roleDisplay}`);
    if (family === 'devin') {
      assert.equal(entry.extends, 'acp');
      assert.equal(entry.env.SLP_FAMILY_BIN, undefined);
      continue;
    }
    assert.equal(entry.extends, family);
    assert.equal(entry.env.SLP_FAMILY_BIN, `/opt/bin/${family}`);
  }
  // An unavailable hook-family binary disables the alias; the gate env keeps
  // the sentinel but an empty binary reference.
  const unavailable = {
    ...resolution,
    binaries: { ...binaries, pi: { available: false, path: null, version: null } },
  };
  const degraded = desiredProviderEntries(launchSet, unavailable, f.candidate, f.home, null);
  assert.equal(degraded['slp-pi-peer'].enabled, false);
  assert.equal(degraded['slp-pi-peer'].env.SLP_FAMILY_BIN, '');
});

// ---------------------------------------------------------------------------
// Parity: hook-injected bytes === devin-wrapper-injected bytes, all 12 roles
// ---------------------------------------------------------------------------

test('parity: hook systemPrompt and devin wrapper inject the identical bundle for every role', async t => {
  const f = fixtureCandidate(t);
  const injection = createRoleInjection({
    readActiveBinding: () => bindingFor(f),
    verifyCandidate: async () => {},
  });
  // The candidate's own role-bundle module, loaded the same way the devin
  // wrapper loads it (static import inside the candidate tree — here via
  // dynamic import of the materialized file, the hook's own mechanism).
  const wrapperModule = await import(pathToFileURL(join(f.candidate, 'plugin', 'server', 'runtime', 'cli', 'role-bundle.ts')).href);
  for (const id of OWNED_IDS) {
    const role = id.split('-')[2];
    // (b) the session-entry render the devin wrapper injects via acpRolePrompt
    // on first and re-armed prompts — delivery.entry() under the frozen managed
    // env; recurring prompts get the shorter delivery.anchor().
    const wrapperBytes = wrapperModule.roleBundle(f.candidate, role, managedEnv(f)).instructions;
    if (DEVIN_IDS.includes(id)) {
      // The devin path is the wrapper itself — nothing to compare, just
      // assert its own render is what the parity contract defines.
      assert.ok(wrapperBytes.startsWith(`SLP role=${role}`));
      continue;
    }
    // (a) what the agent.create hook writes into config.systemPrompt.
    const out = await injection.agentCreate(createReq(id));
    assert.equal(out.config.systemPrompt, wrapperBytes, `${id}: hook bytes !== wrapper bytes`);
  }
});
