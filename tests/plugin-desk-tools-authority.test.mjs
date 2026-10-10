import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESK_TOOL_CATALOG } from '../plugin/server/desk-bridge.ts';

test('all 34 catalog tools × three roles run their real authority checks; accepted calls remain listed', async t => {
  assert.ok(process.env.PASEO_HOME, 'run through the isolated test wrapper');
  const dir = mkdtempSync(join(tmpdir(), 'slp-role-coverage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Reuse the feature fixtures' successful scenarios and pure decision
  // functions, rather than implement a second authority model in the test.
  const childEnv = { ...process.env, SLP_DESK_TOOL_COVERAGE: dir };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', './tests/helpers/desk-tools-authority-probe.mjs',
    '--test', '--test-concurrency=1',
    'tests/plugin-desk-handback.test.mjs', 'tests/plugin-desk-settlement.test.mjs',
    'tests/plugin-desk-scope.test.mjs', 'tests/plugin-desk-rollout.test.mjs',
    'tests/plugin-desk-workflow-continuity.test.mjs', 'tests/plugin-desk-task-bridge.test.mjs',
    'tests/plugin-desk-formation-bridge.test.mjs', 'tests/plugin-desk-tools-list.test.mjs',
    'tests/helpers/desk-tools-authority-scenarios.mjs'], {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(exit, 0, output);
  const summary = output.split('\n').filter(line => /^(?:#|ℹ) (?:tests|pass|fail|cancelled|skipped|todo) /.test(line));
  t.diagnostic(`Existing fixture subprocess: ${summary.join('; ')}`);
  const cells = {};
  for (const path of readdirSync(dir)) {
    const measured = JSON.parse(readFileSync(join(dir, path), 'utf8'));
    for (const [tool, roles] of Object.entries(measured)) for (const [role, cell] of Object.entries(roles)) {
      const target = (cells[tool] ??= {})[role] ??= { probes: 0, accepted: 0, rejected: [] };
      target.probes += cell.probes; target.accepted += cell.accepted; target.rejected.push(...cell.rejected);
    }
  }
  for (const entry of DESK_TOOL_CATALOG) for (const role of ['supervisor', 'lead', 'peer']) {
    const cell = cells[entry.name]?.[role];
    assert.ok(cell?.probes > 0, `${role}/${entry.name}: no real authority witness`);
    if (entry.roles.includes(role)) assert.ok(cell.accepted > 0, `${role}/${entry.name}: no accepted authority witness`);
    else assert.equal(cell.accepted, 0, `${role}/${entry.name}: callable tool hidden by its metadata`);
  }
  t.diagnostic('102/102 tool-role authority cells; each declared role has an accepted fixture witness');
});
