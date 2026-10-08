// Derivation coverage for plugin/shared/runtime/families.ts — the family registry is
// the single source of truth for the slp-<family>-<role> id space; every
// downstream list, regex, label and env map must agree with it. These tests
// pin that agreement so a family added to the registry propagates to every
// consumer without a second literal list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  FAMILIES,
  FAMILY_BIN_ENV,
  FAMILY_IDS,
  FAMILY_LABEL,
  FAMILY_PICKER_ORDER,
  HOOK_FAMILY_IDS,
  HOOK_PROVIDER_ID_RE,
  MANAGED_FAMILY_PREFIX_RE,
  OWNED_PROVIDER_ID_RE,
  OWNED_PROVIDER_IDS,
  PROVIDER_EXTENDS,
  PROVIDER_EXTENDS_IDS,
  ROLES,
  WRAPPER_FAMILY_IDS,
  WRAPPER_PROVIDER_ID_RE,
  familyFromProviderId,
  ownedProviderId,
} from '../plugin/shared/runtime/families.ts';
import { Family, ProviderId } from '../plugin/shared/contracts.ts';
import { FAMILIES as LAUNCHER_FAMILIES, GATE_FAMILIES, ROLES as LAUNCHER_ROLES } from '../plugin/server/launchers.ts';
import { FAMILIES as RESOLVER_FAMILIES } from '../plugin/server/executables.ts';
import { FAMILIES as VIEW_FAMILIES, OWNED_PROVIDER_IDS as VIEW_OWNED, PROVIDER_EXTENDS as VIEW_EXTENDS } from '../plugin/server/config-view.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the registry declares the five current families on two transports', () => {
  assert.deepEqual(FAMILY_IDS, ['codex', 'pi', 'devin', 'claude', 'opencode']);
  assert.deepEqual(HOOK_FAMILY_IDS, ['codex', 'pi', 'claude']);
  assert.deepEqual(WRAPPER_FAMILY_IDS, ['devin', 'opencode']);
  // The registry is pure — no imports at all, so the client bundle can
  // never pull a server-only or node module through it.
  const source = readFileSync(join(root, 'plugin/shared/runtime/families.ts'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(source), 'families.ts must stay import-free');
});

test('every slp-<family>-<role> id classifies correctly by transport', () => {
  for (const family of FAMILY_IDS) {
    for (const role of ROLES) {
      const id = ownedProviderId(family, role);
      assert.equal(id, `slp-${family}-${role}`);
      assert.ok(OWNED_PROVIDER_ID_RE.test(id), `${id} must be owned`);
      const hook = HOOK_FAMILY_IDS.includes(family);
      assert.equal(HOOK_PROVIDER_ID_RE.test(id), hook, `${id} hook classification`);
      assert.equal(WRAPPER_PROVIDER_ID_RE.test(id), !hook, `${id} wrapper classification`);
      assert.equal(familyFromProviderId(id), family);
      assert.deepEqual(MANAGED_FAMILY_PREFIX_RE.exec(id)?.[1], family);
    }
  }
});

test('OWNED_PROVIDER_IDS is exactly the family × role cartesian product', () => {
  assert.equal(OWNED_PROVIDER_IDS.length, 15);
  assert.equal(OWNED_PROVIDER_IDS.length, FAMILY_IDS.length * ROLES.length);
  assert.equal(new Set(OWNED_PROVIDER_IDS).size, 15);
  assert.deepEqual(
    [...OWNED_PROVIDER_IDS].sort(),
    FAMILY_IDS.flatMap(family => ROLES.map(role => `slp-${family}-${role}`)).sort(),
  );
});

test('the regexes admit no orphan ids outside the registry', () => {
  const rejected = [
    'codex',
    'slp-codex',
    'slp-codex-supervisor-extra',
    'slp-gpt-lead',
    'slp--lead',
    'slp-codex-admin',
    'SLP-codex-lead',
    'xslp-codex-lead',
    'slp-codex-leadx',
    '',
  ];
  for (const id of rejected) {
    assert.equal(OWNED_PROVIDER_ID_RE.test(id), false, `owned must reject ${id}`);
    assert.equal(HOOK_PROVIDER_ID_RE.test(id), false, `hook must reject ${id}`);
    assert.equal(WRAPPER_PROVIDER_ID_RE.test(id), false, `wrapper must reject ${id}`);
    assert.equal(familyFromProviderId(id), null, `familyFromProviderId(${id})`);
  }
  // An slp-<unknown>- prefix must not parse as a managed family.
  assert.equal(MANAGED_FAMILY_PREFIX_RE.exec('slp-gpt-lead'), null);
  // Hook ∪ wrapper is the whole owned space and the two are disjoint.
  for (const id of OWNED_PROVIDER_IDS) {
    assert.equal(HOOK_PROVIDER_ID_RE.test(id) !== WRAPPER_PROVIDER_ID_RE.test(id), true, id);
  }
});

test('GATE_FAMILIES equals the registry entries on the hook transport', () => {
  assert.deepEqual(
    [...GATE_FAMILIES].sort(),
    FAMILIES.filter(f => f.transport === 'hook').map(f => f.id).sort(),
  );
  assert.deepEqual(GATE_FAMILIES, HOOK_FAMILY_IDS);
});

test('downstream FAMILIES/OWNED exports are the registry derivations', () => {
  for (const list of [LAUNCHER_FAMILIES, RESOLVER_FAMILIES, VIEW_FAMILIES]) {
    assert.deepEqual([...list], [...FAMILY_IDS]);
  }
  assert.deepEqual([...LAUNCHER_ROLES], [...ROLES]);
  assert.deepEqual(VIEW_OWNED, OWNED_PROVIDER_IDS);
  assert.deepEqual(VIEW_EXTENDS, PROVIDER_EXTENDS);
});

test('labels, env vars and extends are complete and consistent', () => {
  for (const family of FAMILY_IDS) {
    assert.equal(typeof FAMILY_LABEL[family], 'string');
    assert.ok(FAMILY_LABEL[family].length > 0);
    assert.equal(FAMILY_BIN_ENV[family], `SLP_${family.toUpperCase()}_BIN`);
    assert.equal(PROVIDER_EXTENDS[family], FAMILIES.find(f => f.id === family).extends);
  }
  assert.equal(new Set(Object.values(FAMILY_BIN_ENV)).size, FAMILY_IDS.length);
  assert.deepEqual(
    [...PROVIDER_EXTENDS_IDS].sort(),
    [...new Set(FAMILIES.map(f => f.extends))].sort(),
  );
  // Picker order is a permutation of the id set, not a second literal list.
  assert.deepEqual([...FAMILY_PICKER_ORDER].sort(), [...FAMILY_IDS].sort());
});

test('wire schemas derive their domains from the registry', () => {
  for (const family of FAMILY_IDS) {
    assert.equal(Family.safeParse(family).success, true);
  }
  assert.equal(Family.safeParse('gpt').success, false);
  for (const id of OWNED_PROVIDER_IDS) {
    assert.equal(ProviderId.safeParse(id).success, true, id);
  }
  assert.equal(ProviderId.safeParse('slp-gpt-lead').success, false);
  assert.equal(ProviderId.safeParse('slp-codex-admin').success, false);
});
