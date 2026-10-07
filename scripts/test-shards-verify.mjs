#!/usr/bin/env node
// Verifies that a set of test-isolated shard receipts covers the default test
// suite exactly once: every shard index present, each receipt an internally
// consistent passing shard run on one node and one stable candidate, each
// shard's argv exactly its file slice (only --test-concurrency may ride
// along), each file list equal to the deterministic partition of the freshly
// enumerated default suite, and the pinned log/events evidence actually
// readable beside the receipt with matching hashes. Any violation exits 1
// listing the reasons; a verified set prints an aggregate JSON summary.
// Receipts are measurements, not acceptance.
//
// usage: node scripts/test-shards-verify.mjs <receipts-dir>
//          --expect-node=<version|major> --expect-count=<n> [--repo=<dir>]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSuiteFiles, shardFiles } from './test-suite.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  console.error(`test-shards-verify: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const dir = args.find(arg => !arg.startsWith('--'));
const expectNode = args.find(arg => arg.startsWith('--expect-node='))?.slice('--expect-node='.length);
const expectCount = args.find(arg => arg.startsWith('--expect-count='))?.slice('--expect-count='.length);
const repoOverride = args.find(arg => arg.startsWith('--repo='))?.slice('--repo='.length);
if (!dir || dir.startsWith('--')) usage('a receipts directory is required');
if (expectNode === undefined || expectNode === '') usage('--expect-node=<version|major> is required');
if (!/^\d+$/.test(expectCount ?? '')) usage('--expect-count=<n> is required');
const root = repoOverride ? resolve(repoOverride) : repo;
const of = Number(expectCount);

const reasons = [];
// Collect receipt.json files one level deep (flat layout or one directory per
// shard); a present-but-unreadable receipt is a violation, an absent one just
// means the directory is not a shard.
const receipts = [];
try { receipts.push({ name: '.', path: dir, receipt: JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) }); }
catch (error) { if (error.code !== 'ENOENT') reasons.push(`.: receipt.json is unreadable or malformed`); }
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(dir, entry.name);
  try { receipts.push({ name: entry.name, path, receipt: JSON.parse(readFileSync(join(path, 'receipt.json'), 'utf8')) }); }
  catch (error) { if (error.code !== 'ENOENT') reasons.push(`${entry.name}: receipt.json is unreadable or malformed`); }
}

const nodeMatches = (version, spec) => {
  const wanted = spec.startsWith('v') ? spec.slice(1) : spec;
  return wanted.includes('.') ? version === `v${wanted}` : version.startsWith(`v${wanted}.`);
};
const COUNT_KEYS = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];
const STATUS_KEYS = ['passed', 'failed', 'cancelled', 'skipped', 'todo'];
// Runner paths inside events are absolute on the machine that ran the shard;
// after artifact relocation only the tail under the repository's tests/
// directory is meaningful. Matching requires the full `tests/<file>` tail —
// basename-only matches would confuse foreign files.
const eventFile = path => {
  const match = /\/(tests\/[^/]+\.test\.mjs)$/.exec(path ?? '');
  return match ? match[1] : null;
};
const nodeVersions = new Set(receipts.map(({ receipt }) => receipt?.node));
if (receipts.length !== of) reasons.push(`expected ${of} shard receipts, found ${receipts.length}`);
for (const { name, path, receipt } of receipts) {
  if (!receipt || typeof receipt !== 'object') { reasons.push(`${name}: receipt is not an object`); continue; }
  if (receipt.schema !== 'test-isolated-receipt/1') reasons.push(`${name}: unexpected receipt schema ${JSON.stringify(receipt.schema)}`);
  if (receipt.selection !== 'shard') reasons.push(`${name}: selection is ${JSON.stringify(receipt.selection)}, not "shard"`);
  if (receipt.shard?.of !== of) reasons.push(`${name}: shard.of is ${JSON.stringify(receipt.shard?.of)}, expected ${of}`);
  if (receipt.status !== 'pass') reasons.push(`${name}: status is ${JSON.stringify(receipt.status)}`);
  if (receipt.exitCode !== 0) reasons.push(`${name}: exitCode is ${JSON.stringify(receipt.exitCode)}`);
  if (!(receipt.durationMs > 0)) reasons.push(`${name}: durationMs is ${JSON.stringify(receipt.durationMs)}`);
  if (!nodeMatches(receipt.node ?? '', expectNode)) reasons.push(`${name}: node ${JSON.stringify(receipt.node)} does not match --expect-node=${expectNode}`);
  const counts = receipt.counts;
  if (!counts || typeof counts !== 'object') { reasons.push(`${name}: counts missing`); continue; }
  if (!COUNT_KEYS.every(key => Number.isInteger(counts[key]) && counts[key] >= 0)) reasons.push(`${name}: counts are not all nonnegative integers (${JSON.stringify(counts)})`);
  else {
    if (counts.tests < 1) reasons.push(`${name}: counts.tests is ${counts.tests}`);
    if (counts.passed !== counts.tests) reasons.push(`${name}: passed ${counts.passed} != tests ${counts.tests} — hidden omissions are not coverage`);
    if (counts.failed !== 0 || counts.cancelled !== 0 || counts.skipped !== 0 || counts.todo !== 0) {
      reasons.push(`${name}: passing coverage forbids failed/cancelled/skipped/todo (${JSON.stringify(counts)})`);
    }
    if (STATUS_KEYS.reduce((total, key) => total + counts[key], 0) !== counts.tests) reasons.push(`${name}: counts do not add up (${JSON.stringify(counts)})`);
  }
  const { before, after, stable } = receipt.candidate ?? {};
  if (before?.sha256 !== after?.sha256 || stable !== true) reasons.push(`${name}: candidate pins are not one stable pin`);
  const forwarded = (receipt.argv ?? []).filter(arg => !/^--test-concurrency=\d+$/.test(arg));
  if (JSON.stringify(forwarded) !== JSON.stringify(receipt.files)) reasons.push(`${name}: argv is not exactly the shard slice (a filter may be hiding)`);
  for (const [key, fileName] of [['log', 'test.log'], ['events', 'events.jsonl']]) {
    const pinned = receipt[key]?.sha256;
    if (!pinned) { reasons.push(`${name}: no ${key} sha pin`); continue; }
    let actual = null;
    try { actual = createHash('sha256').update(readFileSync(join(path, fileName))).digest('hex'); } catch { /* missing */ }
    if (actual !== pinned) reasons.push(`${name}: ${fileName} is missing or its hash differs from the pinned ${pinned}`);
  }
  // Semantic events check on the retained sibling bytes: exactly one global
  // success summary matching the receipt counts, and per-file summaries that
  // are exhaustive, disjoint and sum to the global counts.
  let eventLines;
  try { eventLines = readFileSync(join(path, 'events.jsonl'), 'utf8').split('\n').filter(Boolean); }
  catch { reasons.push(`${name}: events.jsonl is not readable for the semantic check`); continue; }
  const events = [];
  let malformed = false;
  for (const [lineIndex, line] of eventLines.entries()) {
    try { events.push(JSON.parse(line)); }
    catch { reasons.push(`${name}: events.jsonl line ${lineIndex + 1} is malformed`); malformed = true; break; }
  }
  if (malformed) continue;
  const globalSummaries = events.filter(event => event.type === 'test:summary' && !event.file);
  if (globalSummaries.length !== 1) { reasons.push(`${name}: events carry ${globalSummaries.length} global summaries, expected exactly 1`); continue; }
  const global = globalSummaries[0];
  if (global.success !== true) reasons.push(`${name}: events global summary is not a success`);
  if (!COUNT_KEYS.every(key => global.counts?.[key] === counts[key])) reasons.push(`${name}: receipt counts differ from the events global summary`);
  const perFile = events.filter(event => event.type === 'test:summary' && event.file);
  const byFile = new Map();
  for (const event of perFile) {
    const relative = eventFile(event.file);
    if (!relative) { reasons.push(`${name}: events carry a summary for a file outside the repository's tests/ directory: ${JSON.stringify(event.file)}`); continue; }
    byFile.set(relative, (byFile.get(relative) ?? 0) + 1);
  }
  for (const file of receipt.files ?? []) if ((byFile.get(file) ?? 0) !== 1) reasons.push(`${name}: events carry ${byFile.get(file) ?? 0} summaries for ${file}, expected exactly 1`);
  for (const relative of byFile.keys()) if (!(receipt.files ?? []).includes(relative)) reasons.push(`${name}: events carry a summary for a file not in the shard slice: ${relative}`);
  const totals = perFile.reduce((sum, event) => {
    for (const key of COUNT_KEYS) sum[key] = (sum[key] ?? 0) + (event.counts?.[key] ?? 0);
    return sum;
  }, {});
  if (!COUNT_KEYS.every(key => totals[key] === counts[key])) reasons.push(`${name}: per-file event counts sum ${JSON.stringify(totals)} != global ${JSON.stringify(counts)}`);
}
if (nodeVersions.size > 1) reasons.push(`shards ran on different node versions: ${[...nodeVersions].join(', ')}`);
const locks = new Set(receipts.map(({ receipt }) => receipt?.nodeModulesLockSha256 ?? 'none'));
if (locks.size > 1) reasons.push(`shards ran on different node_modules lock identities: ${[...locks].join(', ')}`);

const files = defaultSuiteFiles(root);
const byIndex = new Map(receipts.map(({ name, receipt }) => [receipt?.shard?.index, { name, receipt }]));
for (let index = 1; index <= of; index++) {
  const { name, receipt } = byIndex.get(index) ?? {};
  if (!receipt) { reasons.push(`shard ${index}/${of} is missing`); continue; }
  const expected = shardFiles(root, files, index, of);
  if (JSON.stringify(receipt.files) !== JSON.stringify(expected)) {
    reasons.push(`${name}: ran ${JSON.stringify(receipt.files?.length ?? null)} files, expected the ${expected.length}-file partition slice for shard ${index}/${of}`);
  }
}
const union = receipts.flatMap(({ receipt }) => receipt?.files ?? []);
if (new Set(union).size !== union.length) reasons.push('shard file lists overlap');
if (new Set(union).size !== files.length) reasons.push(`shard union covers ${new Set(union).size} of ${files.length} default-suite files`);

const candidates = new Set(receipts.map(({ receipt }) => receipt?.candidate?.after?.sha256));
const heads = new Set(receipts.map(({ receipt }) => receipt?.candidate?.after?.head));
if (candidates.size > 1 || heads.size > 1) reasons.push('shards ran on different candidates');
let candidate = null;
if (candidates.size === 1 && heads.size === 1 && [...candidates][0] && [...heads][0]) {
  try {
    const { snapshot } = await import('../plugin/server/runtime/cli/package.ts');
    const measured = snapshot(root);
    candidate = { head: measured.head, sha256: measured.sha256 };
    if (measured.sha256 !== [...candidates][0]) reasons.push(`shard candidate ${[...candidates][0]} differs from the current checkout ${measured.sha256}`);
    if (measured.head !== [...heads][0]) reasons.push(`shard head ${[...heads][0]} differs from the current checkout ${measured.head}`);
  } catch (error) {
    reasons.push(`current checkout could not be snapshotted: ${error.message ?? error}`);
  }
} else if (receipts.length > 0) reasons.push('shard receipts carry no consistent candidate pin');

if (reasons.length) {
  for (const reason of reasons) console.error(`test-shards-verify: ${reason}`);
  process.exit(1);
}
const aggregate = {
  verified: true,
  repository: root,
  node: [...nodeVersions][0],
  count: of,
  files: files.length,
  candidate,
  shards: receipts.map(({ name, receipt }) => ({
    index: receipt.shard.index,
    source: name === '.' ? 'receipt.json' : name,
    tests: receipt.counts?.tests ?? null,
    passed: receipt.counts?.passed ?? null,
    failed: receipt.counts?.failed ?? null,
    durationMs: receipt.durationMs ?? null,
    exitCode: receipt.exitCode,
  })).sort((a, b) => a.index - b.index),
  sumDurationMs: receipts.reduce((sum, { receipt }) => sum + (receipt.durationMs ?? 0), 0),
  measuredAt: new Date().toISOString(),
};
console.log(JSON.stringify(aggregate, null, 2));
