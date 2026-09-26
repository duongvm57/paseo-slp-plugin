import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { json, readJson, hash } from '../src/package.mjs';
import { materializeWorkspace } from '../src/paseo-install.mjs';
import { readCatalog } from '../src/routing.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/materialize-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function slpCheckout(dir) {
  mkdirSync(join(dir, '.paseo-slp'), { recursive: true });
  writeFileSync(join(dir, '.paseo-slp/workspace-protocol.md'),
    `---\nversion: '1'\nowner: 'tester'\napplies_to: 'repo (${realpathSync(dir)})'\nsupervisor_notebook: '.paseo-slp/notebook.md (owner: Supervisor)'\n---\n\n# Workspace Protocol\n`);
  writeFileSync(join(dir, '.paseo-slp/slp-routing.json'), json({ version: 1, policy: 'test pool', options: [] }));
  writeFileSync(join(dir, '.paseo-slp/notebook.md'), '# Supervisor notebook\n');
  return dir;
}

test('materialize dry-runs, applies and rebases frontmatter paths without copying notebook.md', t => {
  const dir = fixture(t), source = slpCheckout(join(dir, 'source')), target = join(dir, 'target');
  mkdirSync(target);
  const plan = materializeWorkspace(source, target, false);
  assert.equal(plan.applied, false);
  assert.equal(existsSync(join(target, '.paseo-slp')), false);
  const applied = materializeWorkspace(source, target, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.files.length, 2);
  assert.ok(applied.files.every(file => file.applied && file.sha256));
  const protocolFile = applied.files.find(file => file.path.endsWith('workspace-protocol.md'));
  assert.equal(protocolFile.rebased, true);
  const protocol = readFileSync(join(target, '.paseo-slp/workspace-protocol.md'), 'utf8');
  assert.ok(protocol.includes(`applies_to: 'repo (${realpathSync(target)})'`));
  assert.ok(!protocol.includes(realpathSync(source)));
  assert.deepEqual(readJson(join(target, '.paseo-slp/slp-routing.json')), { version: 1, policy: 'test pool', options: [] });
  assert.equal(existsSync(join(target, '.paseo-slp/notebook.md')), false);
  const again = materializeWorkspace(source, target, true);
  assert.equal(again.preserved, true);
  assert.equal(again.applied, false);
  assert.ok(again.files.every(file => file.preserved && !file.sha256));
});

test('materialize works when the source never created a catalog', t => {
  const dir = fixture(t), source = slpCheckout(join(dir, 'source')), target = join(dir, 'target');
  mkdirSync(target);
  // init no longer writes a catalog: a fresh source checkout has protocol +
  // notebook only. Materialize must carry the protocol and leave the target
  // to resolve the user-scope pool, exactly like the source does.
  rmSync(join(source, '.paseo-slp/slp-routing.json'));
  const applied = materializeWorkspace(source, target, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.files.length, 1);
  assert.equal(applied.files[0].path.endsWith('workspace-protocol.md'), true);
  assert.equal(existsSync(join(target, '.paseo-slp/slp-routing.json')), false);
  assert.equal(existsSync(join(target, '.paseo-slp/workspace-protocol.md')), true);
});

test('materialize carries protocol references so worktree pointers resolve', t => {
  const dir = fixture(t), source = slpCheckout(join(dir, 'source')), target = join(dir, 'target');
  mkdirSync(target);
  // The protocol keeps rules and one-line pointers; the operational facts it
  // points to live under .paseo-slp/references/ and must travel with it.
  mkdirSync(join(source, '.paseo-slp/references/components'), { recursive: true });
  writeFileSync(join(source, '.paseo-slp/references/check-commands.md'), '# Checks\n');
  writeFileSync(join(source, '.paseo-slp/references/components/web.md'), '# Web\n');
  const applied = materializeWorkspace(source, target, true);
  assert.equal(applied.files.length, 4, 'protocol + catalog + 2 references');
  assert.equal(readFileSync(join(target, '.paseo-slp/references/check-commands.md'), 'utf8'), '# Checks\n');
  assert.equal(readFileSync(join(target, '.paseo-slp/references/components/web.md'), 'utf8'), '# Web\n');
  // A target-owned reference is preserved, like every other target file.
  writeFileSync(join(target, '.paseo-slp/references/check-commands.md'), '# Target checks\n');
  const again = materializeWorkspace(source, target, true);
  assert.equal(again.preserved, true);
  assert.equal(readFileSync(join(target, '.paseo-slp/references/check-commands.md'), 'utf8'), '# Target checks\n');
  // References stage through the protocol contract, not --include.
  assert.throws(() => materializeWorkspace(source, target, false, { includePaths: ['.paseo-slp/references'] }), /managed by materialize/);
  // A symlinked reference is refused before any target write.
  const fresh = join(dir, 'fresh');
  mkdirSync(fresh);
  symlinkSync('check-commands.md', join(source, '.paseo-slp/references/alias.md'));
  assert.throws(() => materializeWorkspace(source, fresh, true), /Protocol reference is a symlink/);
  assert.equal(existsSync(join(fresh, '.paseo-slp')), false);
});

test('materialize copies catalog bytes verbatim so a pinned route hash stays valid', t => {
  const dir = fixture(t), source = slpCheckout(join(dir, 'source')), target = join(dir, 'target');
  mkdirSync(target);
  // A valid catalog with unusual formatting: odd indentation, a CRLF-free
  // compact style and non-canonical key order — reserialization would change
  // every byte and the sha256.
  const raw = '{\n  "options": [],\n\t"policy": "test pool",\n  "version": 1,\n  "quotaFallback": {"enabled":false,"optionId":null}\n}\n\n\n';
  const sourceCatalog = join(source, '.paseo-slp/slp-routing.json');
  writeFileSync(sourceCatalog, raw);
  const applied = materializeWorkspace(source, target, true);
  const catalogEntry = applied.files.find(file => file.path.endsWith('slp-routing.json'));
  assert.equal(catalogEntry.sha256, hash(raw));
  // Byte identity source → target, not just semantic equality.
  assert.equal(readFileSync(join(target, '.paseo-slp/slp-routing.json'), 'utf8'), raw);
  // The route hash a seat pinned against the source resolves identically on
  // the materialized target.
  assert.equal(readCatalog(target).sha256, readCatalog(source).sha256);
  // The source bytes themselves are untouched.
  assert.equal(readFileSync(sourceCatalog, 'utf8'), raw);
});

test('materialize warns instead of silently keeping stale paths, and respects path boundaries', t => {
  const dir = fixture(t), source = slpCheckout(join(dir, 'source')), target = join(dir, 'target');
  mkdirSync(target);
  const root = realpathSync(source);
  // Frontmatter with no source-root path at all: copied file warns.
  writeFileSync(join(source, '.paseo-slp/workspace-protocol.md'),
    `---\nversion: '1'\napplies_to: 'somewhere else'\n---\n\n# Workspace Protocol\n`);
  const out = materializeWorkspace(source, target, true);
  const stale = out.files.find(file => file.path.endsWith('workspace-protocol.md'));
  assert.equal(stale.rebased, false);
  assert.match(stale.warning, /no source-root path/);
  // A longer sibling path (`<source>-old`) is not a boundary match and stays.
  writeFileSync(join(source, '.paseo-slp/workspace-protocol.md'),
    `---\nversion: '1'\napplies_to: 'repo (${root})'\nprevious: '${root}-old'\n---\n\n# Workspace Protocol\n`);
  rmSync(join(target, '.paseo-slp/workspace-protocol.md'));
  const rebound = materializeWorkspace(source, target, true);
  const fixed = rebound.files.find(file => file.path.endsWith('workspace-protocol.md'));
  assert.equal(fixed.rebased, true);
  assert.equal(fixed.warning, undefined);
  const protocol = readFileSync(join(target, '.paseo-slp/workspace-protocol.md'), 'utf8');
  assert.ok(protocol.includes(`applies_to: 'repo (${realpathSync(target)})'`));
  assert.ok(protocol.includes(`previous: '${root}-old'`));
});

test('materialize validates the catalog and refuses missing source files before writing', t => {
  const dir = fixture(t), source = slpCheckout(join(dir, 'source')), target = join(dir, 'target');
  mkdirSync(target);
  writeFileSync(join(source, '.paseo-slp/slp-routing.json'), json({ version: 1, policy: 'x', options: [{ id: 'BAD ID' }] }));
  assert.throws(() => materializeWorkspace(source, target, true), /routing option id/i);
  assert.equal(existsSync(join(target, '.paseo-slp')), false);
  // Unparseable bytes fail at validation too — still before any target write.
  writeFileSync(join(source, '.paseo-slp/slp-routing.json'), '{ not json');
  assert.throws(() => materializeWorkspace(source, target, true), SyntaxError);
  assert.equal(existsSync(join(target, '.paseo-slp')), false);
  writeFileSync(join(source, '.paseo-slp/slp-routing.json'), json({ version: 1, policy: 'test pool', options: [] }));
  rmSync(join(source, '.paseo-slp/workspace-protocol.md'));
  assert.throws(() => materializeWorkspace(source, target, true), /lacks \.paseo-slp\/workspace-protocol\.md/);
  assert.throws(() => materializeWorkspace(join(dir, 'gone'), target, true), /ENOENT/);
  assert.throws(() => materializeWorkspace(source, 'relative-target', true), /Absolute repository directory required/);
});

test('materialize preserves existing target files and the CLI reports per-file results', t => {
  const dir = fixture(t), source = slpCheckout(join(dir, 'source')), target = join(dir, 'target');
  mkdirSync(join(target, '.paseo-slp'), { recursive: true });
  writeFileSync(join(target, '.paseo-slp/slp-routing.json'), json({ version: 1, policy: 'target-owned', options: [] }));
  const cli = join(root, 'bin/slp.mjs');
  const out = JSON.parse(execFileSync(process.execPath, [cli, 'materialize', target, '--from', source, '--apply'], { encoding: 'utf8' }));
  assert.equal(out.source, realpathSync(source));
  const catalog = out.files.find(file => file.path.endsWith('slp-routing.json'));
  assert.equal(catalog.preserved, true);
  assert.equal(readJson(join(target, '.paseo-slp/slp-routing.json')).policy, 'target-owned');
  const protocol = out.files.find(file => file.path.endsWith('workspace-protocol.md'));
  assert.equal(protocol.applied, true);
  for (const [argv, pattern] of [
    [[cli, 'materialize', target], /materialize requires --from/],
    [[cli, 'materialize', target, '--from', source, '--check'], /--check is not valid for materialize/],
  ]) {
    const fail = spawnSync(process.execPath, argv, { encoding: 'utf8' });
    assert.equal(fail.status, 1, argv.join(' '));
    assert.match(fail.stderr, pattern);
  }
});

test('materialize --include stages extra repository files verbatim, deduped and preserved', t => {
  const dir = fixture(t), source = slpCheckout(join(dir, 'source')), target = join(dir, 'target');
  mkdirSync(target);
  // Untracked spec/evidence the seats must see — outside .paseo-slp/, nested
  // directories and a file also reachable through its parent dir.
  mkdirSync(join(source, 'docs/spec'), { recursive: true });
  writeFileSync(join(source, 'docs/spec/supervision.md'), '# Spec\n');
  writeFileSync(join(source, 'docs/spec/routing.md'), '# Routing\n');
  writeFileSync(join(source, 'notes.txt'), 'loose file\n');
  const plan = materializeWorkspace(source, target, false, { includePaths: ['docs/spec', 'docs/spec/routing.md', 'notes.txt'] });
  assert.equal(plan.applied, false);
  assert.equal(plan.files.length, 5, 'protocol + catalog + 3 unique include targets');
  const applied = materializeWorkspace(source, target, true, { includePaths: ['docs/spec', 'docs/spec/routing.md', 'notes.txt'] });
  assert.equal(applied.applied, true);
  assert.equal(readFileSync(join(target, 'docs/spec/supervision.md'), 'utf8'), '# Spec\n');
  assert.equal(readFileSync(join(target, 'docs/spec/routing.md'), 'utf8'), '# Routing\n');
  assert.equal(readFileSync(join(target, 'notes.txt'), 'utf8'), 'loose file\n');
  // Existing target files win — includes never overwrite.
  writeFileSync(join(target, 'notes.txt'), 'target-owned\n');
  const again = materializeWorkspace(source, target, true, { includePaths: ['notes.txt'] });
  assert.equal(again.files.find(file => file.path.endsWith('notes.txt')).preserved, true);
  assert.equal(readFileSync(join(target, 'notes.txt'), 'utf8'), 'target-owned\n');
  // Path discipline: traversal, absolute forms, backslashes, dot segments and
  // the managed .paseo-slp tree are all refused before any write.
  for (const bad of ['../escape', '/abs/path', 'a//b', './x', 'a/../b', '.paseo-slp/x.md', 'a\\b']) {
    assert.throws(() => materializeWorkspace(source, target, false, { includePaths: [bad] }), /Invalid include path|managed by materialize/, bad);
  }
  assert.throws(() => materializeWorkspace(source, target, false, { includePaths: ['missing.md'] }), /does not exist/);
  // The CLI wires repeatable --include flags into the same plan.
  const cli = join(root, 'bin/slp.mjs');
  const target2 = join(dir, 'target2'); mkdirSync(target2);
  const out = JSON.parse(execFileSync(process.execPath, [cli, 'materialize', target2, '--from', source, '--include', 'docs/spec', '--include', 'notes.txt', '--apply'], { encoding: 'utf8' }));
  assert.equal(out.files.length, 5);
  assert.equal(readFileSync(join(target2, 'docs/spec/routing.md'), 'utf8'), '# Routing\n');
});

test('materialize reports repository catalog vs live user-scope pool drift', t => {
  const dir = fixture(t), source = slpCheckout(join(dir, 'source')), target = join(dir, 'target');
  mkdirSync(target);
  const catalog = { version: 1, policy: 'test pool', options: [
    { id: 'seat-a', provider: 'devin', roles: ['peer'], model: 'swe-2-max', modeId: 'bypass', enabled: true, availability: 'ready', suitableFor: [], avoidFor: [], notes: 'devin seat' },
  ] };
  writeFileSync(join(source, '.paseo-slp/slp-routing.json'), json(catalog));
  // Live pool under a fake daemon home: same seat id, different model — the
  // run-5 drift shape. home=null skips the probe entirely.
  const home = join(dir, 'home');
  mkdirSync(join(home, 'slp-runtime/state'), { recursive: true });
  const pool = { ...catalog, options: [{ ...catalog.options[0], model: 'swe-2-high' }] };
  writeFileSync(join(home, 'slp-runtime/state/peer-pool.json'), json(pool));
  const drifted = materializeWorkspace(source, target, false, { home });
  assert.equal(drifted.poolDrift.identical, false);
  assert.deepEqual(drifted.poolDrift.options[0].fields.model, { catalog: 'swe-2-max', pool: 'swe-2-high' });
  const clean = materializeWorkspace(source, target, false);
  assert.equal(clean.poolDrift, undefined);
});
