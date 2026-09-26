import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scenarios } from '../e2e/scenarios.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');

test('Lead implementation ownership stays with Peer Engineers across doctrine and dogfood docs', () => {
  const lead = read('src/roles/lead.md');
  const template = read('src/templates/workspace-protocol.md');
  const surfaces = [
    ['src/roles/lead.md', lead],
    ['src/templates/workspace-protocol.md', template],
    ['.paseo-slp/workspace-protocol.md', read('.paseo-slp/workspace-protocol.md')],
    ['docs/review-checklist.md', read('docs/review-checklist.md')],
    ['e2e/workspace-protocol.md', read('e2e/workspace-protocol.md')],
  ];
  const staleAllowances = [
    /Lead may implement\b/i,
    /Lead can implement\b/i,
    /Lead directly if protocol permits/i,
    /or Lead for permitted tiny work/i,
    /not a global prohibition on Lead direct work/i,
  ];

  assert.match(lead, /Lead frames, inspects\s+and verifies, but does not implement\./i);
  assert.match(template, /every implementation write\s+belongs to a Peer/i);
  for (const [name, contents] of surfaces) {
    for (const allowance of staleAllowances) {
      assert.doesNotMatch(contents, allowance, `${name} retains ${allowance}`);
    }
  }
});

test('premise-reopen scenario repeats the seeded false premise across every Peer family', () => {
  const variants = scenarios.filter(item => item.id.startsWith('premise-reopen-'));
  assert.deepEqual(variants.map(item => item.providerFamily).sort(), ['claude', 'codex', 'devin', 'pi']);
  for (const scenario of variants) {
    assert.equal(scenario.repetitions, 2);
    assert.equal(scenario.runtimeSource, 'profiles-and-peer-pool');
    assert.match(scenario.trigger, /false premise/i);
    assert.match(scenario.trigger, /TASK\.md/);
    assert.match(scenario.trigger, /REOPEN_REQUEST/);
    assert.match(scenario.assertions[0], /Before writing, Peer returns REOPEN_REQUEST/);
    assert.match(scenario.assertions[1], /Lead checks the same evidence.*corrected premise/s);
  }
});

test('direct-Lead dogfood assigns implementation to a Peer', () => {
  const scenario = scenarios.find(item => item.id === 'direct-codex');
  assert.ok(scenario, 'scenario manifest contains direct-codex');
  assert.match(scenario.trigger, /Peer Engineer as implementation owner/);
  assert.match(scenario.assertions.join(' '), /Peer supplies proof/);
});
