// One source of truth for what the default test suite is and how CI shards
// divide it: the test wrapper enumerates from here and the shard verifier
// re-measures coverage against the same functions, so no copy can drift.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const defaultSuiteFiles = root =>
  readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join('tests', name));

// Measured solo wall durations (ms) per test file — Node v24.14.0, 16 CPUs,
// one sequential `node scripts/test-isolated.mjs <file>` pass per file
// (per-file logs under the run's own proof directory; the pass that filled
// this table is recorded in docs/development.md). Line count is the fallback
// for files not in the table, so a new file still gets a sane weight; refresh
// the table when the suite's shape changes materially.
const DURATION_WEIGHTS = {
// Provenance: solo wall durations per test file, Node v24.14.0, 16 CPUs.
// 79 entries from one sequential per-file sweep (80 runs, all exit 0;
// logs retained under the run's own proof directory) — that sweep spanned a
// changing tree, so each entry is a proxy whose applicability is bounded by
// the test file's bytes being unchanged since; the four
// plugin-desk-task-execution split parts are the run5 solo walls, pinned
// fdad7c7d9088706f246d8e94b091b26b90aaa5b1841cfc8fc526b7ce3c4753eb (167/167
// tests, stable — several correction attempts preceded it; this is not a
// one-attempt result). Line count stays the fallback for unknown files.
  'tests/candidate-verify.test.mjs': 75470,
  'tests/client-catalog-demand.test.mjs': 2445,
  'tests/client-target-async.test.mjs': 7038,
  'tests/client-workflow-view.test.mjs': 3376,
  'tests/desk-recovery-cli.test.mjs': 6854,
  'tests/harness-cli.test.mjs': 5338,
  'tests/harness-gate.test.mjs': 1227,
  'tests/harness-ledger.test.mjs': 1671,
  'tests/harness-review.test.mjs': 1861,
  'tests/install.test.mjs': 5867,
  'tests/inventory.test.mjs': 3294,
  'tests/jev.test.mjs': 2245,
  'tests/launch.test.mjs': 10233,
  'tests/local.test.mjs': 13421,
  'tests/materialize.test.mjs': 1664,
  'tests/monitor.test.mjs': 3236,
  'tests/notebook.test.mjs': 1268,
  'tests/plugin-desk-bridge.test.mjs': 17420,
  'tests/plugin-desk-check-freshness.test.mjs': 10697,
  'tests/plugin-desk-continuity.test.mjs': 3138,
  'tests/plugin-desk-formation-bridge.test.mjs': 12693,
  'tests/plugin-desk-formation.test.mjs': 1840,
  'tests/plugin-desk-handback.test.mjs': 13786,
  'tests/plugin-desk-operation.test.mjs': 827,
  'tests/plugin-desk-records-parity.test.mjs': 388,
  'tests/plugin-desk-recovery.test.mjs': 25525,
  'tests/plugin-desk-rollout.test.mjs': 25673,
  'tests/plugin-desk-scope.test.mjs': 24566,
  'tests/plugin-desk-seat.test.mjs': 27809,
  'tests/plugin-desk-settlement.test.mjs': 16495,
  'tests/plugin-desk-store-migrations.test.mjs': 55252,
  'tests/plugin-desk-store.test.mjs': 58620,
  'tests/plugin-desk-task-access.test.mjs': 955,
  'tests/plugin-desk-task-bridge.test.mjs': 18748,
  'tests/plugin-desk-task-capacity-boundaries.test.mjs': 213294,
  'tests/plugin-desk-task-capacity.test.mjs': 7773,
  'tests/plugin-desk-task-contract.test.mjs': 1229,
  'tests/plugin-desk-task-core.test.mjs': 20549,
  'tests/plugin-desk-task-execution-c2.test.mjs': 116244,
  'tests/plugin-desk-task-execution-ef.test.mjs': 103755,
  'tests/plugin-desk-task-execution-pointer.test.mjs': 107169,
  'tests/plugin-desk-task-execution.test.mjs': 107095,
  'tests/plugin-desk-task-host.test.mjs': 414,
  'tests/plugin-desk-task-runtime.test.mjs': 601,
  'tests/plugin-desk-workflow-continuity.test.mjs': 9237,
  'tests/plugin-desk-workflow-tasks.test.mjs': 2558,
  'tests/plugin-enforcement.test.mjs': 1386,
  'tests/plugin-entrypoints.test.mjs': 6854,
  'tests/plugin-families.test.mjs': 682,
  'tests/plugin-helpers.test.mjs': 9380,
  'tests/plugin-injection-binding.test.mjs': 1600,
  'tests/plugin-jev.test.mjs': 897,
  'tests/plugin-launchers.test.mjs': 9734,
  'tests/plugin-lock-holder.test.mjs': 31755,
  'tests/plugin-materializer.test.mjs': 9676,
  'tests/plugin-provider-catalog.test.mjs': 20396,
  'tests/plugin-recovery.test.mjs': 15354,
  'tests/plugin-role-injection.test.mjs': 3724,
  'tests/plugin-routing.test.mjs': 2550,
  'tests/plugin-runtime-pin.test.mjs': 2922,
  'tests/plugin-supervision-capture.test.mjs': 632,
  'tests/plugin-supervision-card.test.mjs': 494,
  'tests/plugin-supervision-delivery.test.mjs': 1236,
  'tests/plugin-supervision-observer.test.mjs': 16937,
  'tests/plugin-supervision.test.mjs': 845,
  'tests/plugin-task-recap.test.mjs': 671,
  'tests/plugin-transaction.test.mjs': 6744,
  'tests/plugin-ui.test.mjs': 750,
  'tests/plugin-workflow-view.test.mjs': 5603,
  'tests/policy-doctrine.test.mjs': 363,
  'tests/report-records.test.mjs': 4827,
  'tests/review-copy.test.mjs': 1406,
  'tests/review-tools.test.mjs': 19059,
  'tests/routing-criteria.test.mjs': 586,
  'tests/routing.test.mjs': 8334,
  'tests/runtime-core-install.test.mjs': 1365,
  'tests/runtime-graph.test.mjs': 1059,
  'tests/runtime-layout.test.mjs': 1209,
  'tests/runtime-state.test.mjs': 3707,
  'tests/stop-watcher.test.mjs': 982,
  'tests/test-isolated.test.mjs': 14477,
  'tests/test-shards.test.mjs': 16690,
  'tests/verify-handback-cli.test.mjs': 9124,
};

export function fileWeight(root, file) {
  const measured = DURATION_WEIGHTS[file];
  if (Number.isFinite(measured) && measured > 0) return measured;
  return readFileSync(join(root, file), 'utf8').split('\n').length;
}

// Deterministic weight-balanced partition: files are ordered by weight
// (measured duration when known, else line count) with the name as the
// tiebreak, then each file goes to the currently lightest shard (earliest
// index on ties). Every file lands exactly once, so the shards are disjoint
// and exhaustive by construction and stable for a given file set.
export function partitionSuite(root, files, of) {
  const order = files.map(file => ({ file, weight: fileWeight(root, file) }))
    .sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : 1));
  const shards = Array.from({ length: of }, () => ({ weight: 0, files: [] }));
  for (const { file, weight } of order) {
    const target = shards.reduce((min, shard, index) => (shard.weight < shards[min].weight ? index : min), 0);
    shards[target].weight += weight;
    shards[target].files.push(file);
  }
  return shards.map(shard => shard.files.sort());
}

export const shardFiles = (root, files, index, of) => partitionSuite(root, files, of)[index - 1];
