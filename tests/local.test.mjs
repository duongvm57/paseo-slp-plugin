import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { identity, install, verifyInstall, uninstall, snapshot, json } from '../src/package.mjs';
import { prompt, launchPlan } from '../src/launch.mjs';
import { roleBundle } from '../src/role-bundle.mjs';
import { resolveProfile } from '../src/profiles.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const binding = { provider: 'codex', model: 'gpt-5.6-luna', modeId: 'auto', thinkingOptionId: 'medium' };
test('profile resolution preserves user preferences and rejects missing or wrong family', () => {
  const profiles = ['supervisor', 'lead'].map(role => ({ id: `slp-${role}`,
    ...binding, provider: `slp-codex-${role}`, modeId: 'full-access',
    featureValues: { fast_mode: true }, command: 'legacy-wrapper' }));
  const providers = profiles.map(p => ({ id: p.provider, enabled: true, status: 'available', extends: 'codex' }));
  const resolved = resolveProfile('supervisor', profiles, providers);
  assert.equal(resolved.modeId, 'full-access');
  assert.deepEqual(resolved.features, { fast_mode: true });
  assert.ok(!JSON.stringify(resolved).includes('legacy-wrapper'));
  assert.throws(() => resolveProfile('peer', profiles, providers), /Missing/);
  assert.throws(() => resolveProfile('lead', profiles, []), /Unverified/);
});

test('initialPrompt role envelope is provider-neutral and supports Pi bindings', t => {
  const installed = join(fixture(t), 'release');
  install(root, installed);
  const rendered = prompt(installed, 'supervisor', 'Run the bounded check', { provider: 'pi', model: 'pi-model', modeId: 'default' });
  assert.match(rendered, /^SLP role=supervisor/);
  assert.ok(rendered.includes('Run the bounded check'));
});
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('install preserves exact candidate bytes; rollback preserves unrelated siblings', t => {
  const dir = fixture(t), target = join(dir, 'release');
  writeFileSync(join(dir, 'human.txt'), 'preserve');
  install(root, target);
  assert.deepEqual(verifyInstall(target).candidate, identity(root));
  assert.equal(existsSync(join(target, 'skills/paseo-slp-onboarding/SKILL.md')), true);
  assert.throws(() => install(root, target), /EEXIST/);
  uninstall(target);
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(join(dir, 'human.txt'), 'utf8'), 'preserve');
});

test('changed install and user-added files block destructive rollback', t => {
  const target = join(fixture(t), 'release');
  install(root, target);
  writeFileSync(join(target, 'notes.txt'), 'human work');
  assert.throws(() => uninstall(target), /Extra files/);
  assert.equal(existsSync(join(target, 'notes.txt')), true);
  writeFileSync(join(target, 'src/common.md'), 'changed');
  assert.throws(() => verifyInstall(target), /changed/);
});

test('onboarding Markdown resource links resolve from an installed package', t => {
  const installed = join(fixture(t), 'release');
  install(root, installed);
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : path.endsWith('.md') ? [path] : [];
  });
  for (const file of walk(join(installed, 'skills/paseo-slp-onboarding'))) {
    const markdown = readFileSync(file, 'utf8');
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${file}: missing installed resource ${target}`);
    }
  }
});

test('installed common protocol supports combined configuration without losing gates', t => {
  const installed = join(fixture(t), 'release');
  install(root, installed);
  const base = readFileSync(join(installed, 'src/templates/workspace-protocol.md'), 'utf8');
  assert.match(base, /^template_sha256:/m);
  assert.equal(base.match(/^## Repository configuration$/gm).length, 1);
  for (const field of ['Assignment source', 'Execution scope', 'Delivery and completion point', 'Shared-state controls', 'Lead topology']) {
    assert.ok(base.includes(`| ${field} |`), field);
  }
  assert.match(base, /All four recipes remain available by default/);
  assert.match(base, /tracker does not\nrequire a separate Task Lead/);
  assert.match(base, /requires an independent review gate/);
  assert.match(base, /parallel Spec and Standards seats/);
  const transition = base.split('## Recipe C')[1].split('## Recipe D')[0];
  assert.ok(transition.indexOf('| Gate |') < transition.indexOf('| Execute |'));
  assert.match(transition, /outcome verdict/);
  const skill = readFileSync(join(installed, 'skills/paseo-slp-onboarding/SKILL.md'), 'utf8');
  assert.ok(!skill.includes('templates/profiles/'));
  assert.match(skill, /combine every applicable setting/);
  const examples = readFileSync(join(installed, 'skills/paseo-slp-onboarding/references/repository-configuration.md'), 'utf8');
  assert.match(skill, /Do not\nadd tracker setup questions or activation gates/);
  assert.ok(!base.includes('| Connector and cadence |'));
  assert.match(examples, /new pricing feature with a database backfill/);
  assert.match(examples, /Opening a PR does not grant production\nexecution/);
  // Operational facts live in .paseo-slp/references/; moving them there is
  // configuration, never a deviation the Overrides table must register.
  assert.equal(base.match(/^## Repository references$/gm).length, 1);
  assert.match(base, /`\.paseo-slp\/references\/<topic>\.md`/);
  assert.match(base, /never adds, relaxes or overrides a rule/);
  assert.match(base, /never as a grant/);
  assert.match(base, /live in its checks reference under Repository\nreferences/);
  assert.match(base, /referenced files is configuration, not an override/);
  assert.match(skill, /`\.paseo-slp\/references\/<topic>\.md`/);
  assert.match(skill, /split is configuration, not an Override/);
  assert.match(examples, /^## Protocol and references$/m);
});

test('launcher loads installed role bytes, excludes private review material, preserves configured custom provider/full-access', t => {
  const installed = join(fixture(t), 'release');
  install(root, installed);
  const request = { workspaceId: 'host-workspace', repository: root,
    assignment: 'Change the greeting; edits only. No commit/push/external effects.',
    binding, outcomeCheck: 'PRIVATE_CHECK', checklist: 'PRIVATE_CHECKLIST' };
  const result = launchPlan(installed, request);
  assert.ok(result.create.initialPrompt.includes(readFileSync(join(installed, 'src/roles/supervisor.md'), 'utf8')));
  assert.ok(!result.create.initialPrompt.includes('PRIVATE_'));
  assert.equal(result.argv, undefined);
  assert.equal(result.create.provider, 'codex/gpt-5.6-luna');
  assert.throws(() => launchPlan(installed, { ...request, binding: { ...binding, provider: 'slp-codex-peer' } }), /matching SLP/);
  assert.equal(launchPlan(installed, { ...request, binding: { ...binding, provider: 'slp-codex-supervisor' } }).create.provider, 'slp-codex-supervisor/gpt-5.6-luna');
  assert.equal(launchPlan(installed, { ...request, binding: { ...binding, modeId: 'full-access' } }).create.settings.modeId, 'full-access');
  const peer = prompt(installed, 'peer', 'bounded outcome', binding);
  assert.deepEqual(roleBundle(installed, 'peer').parts, ['common.md', 'roles/peer.md']);
  assert.ok(peer.includes(readFileSync(join(installed, 'src/roles/peer.md'), 'utf8')));
  for (const role of ['supervisor', 'lead']) {
    const child = launchPlan(installed, { ...request, role });
    assert.ok(child.create.initialPrompt.includes(readFileSync(join(installed, `src/roles/${role}.md`), 'utf8')));
    assert.equal(child.create.notifyOnFinish, true);
    for (const family of ['pi', 'codex', 'devin', 'claude']) {
      const model = family === 'devin' ? 'swe-2-medium' : family === 'claude' ? 'claude-synthetic-1' : binding.model;
      const wrapped = launchPlan(installed, { ...request, role, binding: { ...binding, model, provider: `slp-${family}-${role}` } });
      assert.ok(wrapped.create.initialPrompt.includes(request.assignment));
      assert.ok(!wrapped.create.initialPrompt.includes(readFileSync(join(installed, `src/roles/${role}.md`), 'utf8')), 'Wrapper policy must not be broadcast again as task input');
      assert.ok(!wrapped.create.initialPrompt.includes(readFileSync(join(installed, 'src/common.md'), 'utf8')));
    }
  }
  const routed = launchPlan(installed, { ...request, binding: undefined, profiles: [{ id: 'slp-supervisor',
    ...binding, provider: 'slp-codex-supervisor', modeId: 'full-access', featureValues: { fast_mode: false } }],
    providers: [{ id: 'slp-codex-supervisor', enabled: true, status: 'available' }] });
  assert.equal(routed.create.provider, 'slp-codex-supervisor/gpt-5.6-luna');
  assert.equal(routed.profileId, 'slp-supervisor');
  assert.equal(routed.create.settings.modeId, 'full-access');
  assert.deepEqual(routed.create.settings.features, { fast_mode: false });
});

test('offline CLI prepares from a staged install with no Paseo executable or daemon', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const request = join(dir, 'request.json');
  writeFileSync(request, json({ installed, workspaceId: 'local-check-only', repository: root, assignment: 'Local rendering check only', binding }));
  const result = JSON.parse(execFileSync(process.execPath, [join(installed, 'bin/slp.mjs'), 'prepare', request], { env: { PATH: '' }, encoding: 'utf8' }));
  assert.equal(result.create.provider, 'codex/gpt-5.6-luna');
  assert.equal(result.create.notifyOnFinish, true);
  const planned = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'install', join(dir, 'not-created')], { env: { PATH: '' }, encoding: 'utf8' }));
  assert.equal(planned.applied, false);
  assert.equal(existsSync(join(dir, 'not-created')), false);
});

test('prepare --emit create prints the create record verbatim and --check gates on failures', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const request = join(dir, 'request.json');
  writeFileSync(request, json({ workspaceId: 'wks-x', repository: root, assignment: 'emit check', binding }));
  const env = { PATH: '' };
  const cli = join(installed, 'bin/slp.mjs');
  // --emit create emits an audit artifact: `create` stays byte-identical to
  // the plan's create member — no trimming or recomposing — and the resolved
  // mode plus its provenance travel alongside so the file records the mode
  // actually used.
  const emitted = JSON.parse(execFileSync(process.execPath, [cli, 'prepare', request, '--emit', 'create'], { env, encoding: 'utf8' }));
  const full = JSON.parse(execFileSync(process.execPath, [cli, 'prepare', request], { env, encoding: 'utf8' }));
  assert.deepEqual(emitted.create, full.create);
  assert.equal(emitted.modeId, full.modeId);
  assert.equal(emitted.modeIdSource, full.modeIdSource);
  assert.equal(emitted.create.provider, 'codex/gpt-5.6-luna');
  assert.ok(emitted.create.initialPrompt.includes('SLP role=supervisor'));
  // --check on a valid request exits 0 with per-stage results.
  const ok = JSON.parse(execFileSync(process.execPath, [cli, 'prepare', request, '--check'], { env, encoding: 'utf8' }));
  assert.equal(ok.ok, true);
  assert.ok(ok.checks.every(check => check.ok));
  // Missing model: exit 1 and the failing stage is named, before any create.
  writeFileSync(request, json({ workspaceId: 'wks-x', repository: root, assignment: 'x', binding: { provider: 'codex' } }));
  const bad = spawnSync(process.execPath, [cli, 'prepare', request, '--check'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  const report = JSON.parse(bad.stdout);
  assert.equal(report.ok, false);
  assert.match(report.checks.find(check => check.name === 'settings').error, /model/);
  // prepare-handoff shares both modes; --check exits 1 on failing stages.
  const handoffRun = spawnSync(process.execPath, [cli, 'prepare-handoff', request, '--check'], { env, encoding: 'utf8' });
  assert.equal(handoffRun.status, 1);
  const handoffReport = JSON.parse(handoffRun.stdout);
  assert.equal(handoffReport.ok, false);
  assert.equal(handoffReport.checks.find(check => check.name === 'handoff').ok, false);
  // Modes are mutually exclusive.
  const clash = spawnSync(process.execPath, [cli, 'prepare', request, '--check', '--emit', 'create'], { env, encoding: 'utf8' });
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /separate modes/);
  // Flag-first ordering works too: prepare --check <file> parses the same.
  const flagFirst = spawnSync(process.execPath, [cli, 'prepare', '--check', request], { env, encoding: 'utf8' });
  assert.equal(flagFirst.status, 1);
  assert.deepEqual(JSON.parse(flagFirst.stdout).checks.map(c => c.name), report.checks.map(c => c.name));
});

test('prepare --schema prints the request contract without a request file, receipt or daemon', () => {
  const env = { PATH: '' };
  // Runs straight from the source checkout — no installed.json needed.
  const schema = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'prepare', '--schema'], { env, encoding: 'utf8' }));
  for (const role of ['supervisor', 'lead', 'peer']) assert.ok(schema.examples[role]);
  assert.ok(schema.bindingSources['catalog routing — required for peer']);
  const handoff = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'prepare-handoff', '--schema'], { env, encoding: 'utf8' }));
  assert.ok(handoff.handoff.resources);
  assert.equal(handoff.base.repository, schema.base.repository);
  // --schema takes no request file.
  const bad = spawnSync(process.execPath, [join(root, 'bin/slp.mjs'), 'prepare', 'x.json', '--schema'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /takes no request file/);
});

test('route-decide --schema prints the request contract and --out persists the result', t => {
  const dir = fixture(t);
  const env = { PATH: '' };
  const cli = join(root, 'bin/slp.mjs');
  // --schema runs without a request file, a daemon home or jev.json.
  const schema = JSON.parse(execFileSync(process.execPath, [cli, 'route-decide', '--schema'], { env, encoding: 'utf8' }));
  assert.match(schema.request.brief, /nonempty STRING of raw task/);
  assert.match(schema.request.brief, /Structured forms.*refused/);
  const clash = spawnSync(process.execPath, [cli, 'route-decide', 'x.json', '--schema'], { env, encoding: 'utf8' });
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /takes no request file/);
  // --out writes the RESULT bytes — the response, never the request file —
  // creating parent directories as needed.
  const out = join(dir, 'nested', 'schema.json');
  execFileSync(process.execPath, [cli, 'route-decide', '--schema', '--out', out], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), schema);
  // The same flag persists a plan result (not just schema modes).
  const installed = join(dir, 'release'); install(root, installed);
  const request = join(dir, 'request.json');
  writeFileSync(request, json({ installed, workspaceId: 'wks-x', repository: root, assignment: 'out flag check', binding }));
  const planOut = join(dir, 'plan.json');
  const plan = JSON.parse(execFileSync(process.execPath, [join(installed, 'bin/slp.mjs'), 'prepare', request, '--out', planOut], { env, encoding: 'utf8' }));
  assert.deepEqual(JSON.parse(readFileSync(planOut, 'utf8')), plan);
  assert.equal(plan.modeId, 'auto');
  assert.equal(plan.modeIdSource, 'binding');
  // --out requires a path and is not valid everywhere.
  const missing = spawnSync(process.execPath, [cli, 'route-decide', '--schema', '--out'], { env, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--out requires a path/);
  const invalid = spawnSync(process.execPath, [cli, 'monitor', 'x.json', '--out', out], { env, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--out is not valid for monitor/);
});

test('--out refuses to overwrite the request file', t => {
  const dir = fixture(t);
  const env = { PATH: '' };
  const installed = join(dir, 'release'); install(root, installed);
  const cli = join(installed, 'bin/slp.mjs');
  const request = join(dir, 'request.json');
  writeFileSync(request, json({ installed, workspaceId: 'wks-x', repository: root, assignment: 'out overwrite check', binding }));
  const bytes = readFileSync(request);
  for (const command of ['prepare', 'prepare-handoff', 'route-decide']) {
    const run = spawnSync(process.execPath, [cli, command, request, '--out', request], { env, encoding: 'utf8' });
    assert.equal(run.status, 1, command);
    assert.match(run.stderr, /--out must not resolve to the request file/);
    assert.deepEqual(readFileSync(request), bytes, `${command} must leave the request file untouched`);
  }
  // A distinct --out path still persists the result.
  const out = join(dir, 'plan.json');
  execFileSync(process.execPath, [cli, 'prepare', request, '--out', out], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).create.provider, 'codex/gpt-5.6-luna');
});

test('CLI reports a missing target instead of a raw path error', () => {
  const cli = join(root, 'bin/slp.mjs');
  for (const command of ['prepare', 'prepare-handoff', 'snapshot', 'verify', 'routes', 'init']) {
    const result = spawnSync(process.execPath, [cli, command], { encoding: 'utf8' });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, new RegExp(`${command} requires`), command);
  }
});

test('prepare rejects an unknown role before binding resolution', t => {
  const installed = join(fixture(t), 'release');
  install(root, installed);
  assert.throws(() => launchPlan(installed, { role: 'bogus', workspaceId: 'w', repository: root, assignment: 'x', binding }), /Unknown role/);
});

test('work snapshot detects untracked edits, deletion and executable mode without a commit', t => {
  const dir = fixture(t);
  execFileSync('git', ['init', '--quiet', dir]);
  writeFileSync(join(dir, 'owned.txt'), 'first');
  const first = snapshot(dir);
  assert.equal(first.head, null);
  assert.equal(snapshot(dir).sha256, first.sha256);
  writeFileSync(join(dir, 'owned.txt'), 'second');
  const second = snapshot(dir).sha256;
  assert.notEqual(second, first.sha256);
  chmodSync(join(dir, 'owned.txt'), 0o755);
  assert.notEqual(snapshot(dir).sha256, second);
  execFileSync('git', ['-C', dir, 'add', 'owned.txt']);
  rmSync(join(dir, 'owned.txt'));
  assert.deepEqual(snapshot(dir).files, [{ path: 'owned.txt', deleted: true }]);
  assert.ok(!('incomplete' in snapshot(dir)), 'a tree without gitlinks stays complete');
});

const gitRun = (dir, args) => execFileSync('git', ['-C', dir, ...args]);
const gitCommit = (dir, message = 'c') => gitRun(dir, ['-c', 'user.email=t@slp', '-c', 'user.name=t', 'commit', '--quiet', '-m', message]);
// A real superproject + submodule: upstream is a standalone repo the main repo
// links at `subPath`. Returns the superproject root, the submodule checkout and
// the upstream repo for making new commits.
function submoduleFixture(t, subPath = 'sub') {
  const base = fixture(t);
  const upstream = join(base, 'upstream');
  mkdirSync(upstream);
  gitRun(upstream, ['init', '--quiet']);
  writeFileSync(join(upstream, 'u.txt'), 'u1');
  gitRun(upstream, ['add', 'u.txt']);
  gitCommit(upstream);
  const dir = join(base, 'main');
  mkdirSync(dir);
  gitRun(dir, ['init', '--quiet']);
  writeFileSync(join(dir, 'owned.txt'), 'o');
  gitRun(dir, ['add', 'owned.txt']);
  gitCommit(dir);
  gitRun(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, subPath]);
  gitCommit(dir);
  return { dir, sub: join(dir, subPath), upstream };
}
const gitlinkOf = (snap, path = 'sub') => snap.files.find(entry => entry.path === path);

test('snapshot records a clean initialized gitlink as pointer plus observed HEAD', t => {
  const { dir, sub } = submoduleFixture(t);
  const headOid = gitRun(sub, ['rev-parse', 'HEAD']).toString().trim();
  const snap = snapshot(dir);
  assert.deepEqual(gitlinkOf(snap), { path: 'sub', kind: 'gitlink', indexOid: headOid, headOid, state: 'clean' });
  assert.ok(!('incomplete' in snap));
  assert.equal(snapshot(dir).sha256, snap.sha256, 'snapshot stays deterministic');
});

test('snapshot digest follows a moved submodule checkout while the staged pointer stays put', t => {
  const { dir, sub, upstream } = submoduleFixture(t);
  const first = snapshot(dir);
  writeFileSync(join(upstream, 'u.txt'), 'u2');
  gitRun(upstream, ['add', 'u.txt']);
  gitCommit(upstream);
  const moved = gitRun(upstream, ['rev-parse', 'HEAD']).toString().trim();
  gitRun(sub, ['fetch', '--quiet', 'origin']);
  gitRun(sub, ['checkout', '--quiet', moved]);
  const after = snapshot(dir);
  const entry = gitlinkOf(after);
  assert.equal(entry.headOid, moved);
  assert.equal(entry.indexOid, first.files.find(e => e.path === 'sub').indexOid, 'index pointer unchanged until staged');
  assert.equal(entry.state, 'clean');
  assert.ok(!('incomplete' in after));
  assert.notEqual(after.sha256, first.sha256, 'headOid is part of the digest');
});

test('snapshot distinguishes a staged pointer from the checkout it no longer matches', t => {
  const { dir, sub, upstream } = submoduleFixture(t);
  const staged = gitRun(sub, ['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(upstream, 'u.txt'), 'u2');
  gitRun(upstream, ['add', 'u.txt']);
  gitCommit(upstream);
  const moved = gitRun(upstream, ['rev-parse', 'HEAD']).toString().trim();
  gitRun(sub, ['fetch', '--quiet', 'origin']);
  gitRun(sub, ['checkout', '--quiet', moved]);
  gitRun(dir, ['add', 'sub']);
  gitRun(sub, ['checkout', '--quiet', staged]);
  const entry = gitlinkOf(snapshot(dir));
  assert.equal(entry.indexOid, moved, 'staging intent is the gitlink identity object');
  assert.equal(entry.headOid, staged);
  assert.equal(entry.state, 'clean');
});

test('snapshot marks dirty or untracked submodule content as unproven scope', t => {
  const { dir, sub } = submoduleFixture(t);
  writeFileSync(join(sub, 'u.txt'), 'edited');
  let snap = snapshot(dir);
  assert.equal(gitlinkOf(snap).state, 'dirty');
  assert.deepEqual(snap.incomplete, ['sub']);
  // A second dirty tree with different content keeps the same digest — the
  // scope is unproven, so the snapshot must not claim completeness for it.
  writeFileSync(join(sub, 'u.txt'), 'edited again');
  const snap2 = snapshot(dir);
  assert.equal(snap2.sha256, snap.sha256);
  assert.deepEqual(snap2.incomplete, ['sub']);
  // Untracked-only content is dirty too.
  execFileSync('git', ['-C', sub, 'checkout', '--quiet', '--', 'u.txt']);
  writeFileSync(join(sub, 'untracked.txt'), 'x');
  snap = snapshot(dir);
  assert.equal(gitlinkOf(snap).state, 'dirty');
  assert.deepEqual(snap.incomplete, ['sub']);
});

test('snapshot reports uninitialized, deleted and replaced gitlink paths without failing', t => {
  const { dir, sub } = submoduleFixture(t);
  gitRun(dir, ['submodule', 'deinit', '--force', 'sub']);
  let snap = snapshot(dir);
  assert.equal(gitlinkOf(snap).state, 'uninitialized');
  assert.equal(gitlinkOf(snap).headOid, null);
  assert.deepEqual(snap.incomplete, ['sub']);
  gitRun(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--quiet', '--init', 'sub']);
  assert.equal(gitlinkOf(snapshot(dir)).state, 'clean');
  rmSync(sub, { recursive: true, force: true });
  snap = snapshot(dir);
  assert.equal(gitlinkOf(snap).state, 'missing');
  assert.deepEqual(snap.incomplete, ['sub']);
  // A regular file where the submodule dir was is also missing, not a crash.
  writeFileSync(sub, 'not a directory');
  assert.equal(gitlinkOf(snapshot(dir)).state, 'missing');
});

test('snapshot records a conflicted gitlink index without picking a stage', t => {
  const { dir, sub } = submoduleFixture(t);
  const headOid = gitRun(sub, ['rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', dir, 'update-index', '--index-info'], {
    input: `0 ${'0'.repeat(40)}\tsub\n160000 ${'1'.repeat(40)} 1\tsub\n160000 ${'2'.repeat(40)} 2\tsub\n160000 ${'3'.repeat(40)} 3\tsub\n` });
  const entry = gitlinkOf(snapshot(dir));
  assert.equal(entry.indexOid, null, 'conflict must not pick stage 0');
  assert.equal(entry.state, 'conflicted');
  assert.equal(entry.headOid, headOid);
  assert.deepEqual(snapshot(dir).incomplete, ['sub']);
});

test('snapshot handles a gitlink path containing spaces', t => {
  const { dir, sub } = submoduleFixture(t, 'my lib');
  const headOid = gitRun(sub, ['rev-parse', 'HEAD']).toString().trim();
  const snap = snapshot(dir);
  assert.deepEqual(gitlinkOf(snap, 'my lib'), { path: 'my lib', kind: 'gitlink', indexOid: headOid, headOid, state: 'clean' });
});

test('role bundle load paths are the contract: Peer never receives delegation policy', t => {
  const installed = join(fixture(t), 'release');
  install(root, installed);
  const expected = {
    supervisor: ['common.md', 'roles/supervisor.md', 'delegation.md'],
    lead: ['common.md', 'roles/lead.md', 'delegation.md'],
    peer: ['common.md', 'roles/peer.md'],
  };
  for (const [role, parts] of Object.entries(expected)) {
    const bundle = roleBundle(installed, role);
    assert.deepEqual(bundle.parts, parts);
    assert.equal(bundle.orchestrates, role !== 'peer');
    for (const part of parts) {
      assert.ok(bundle.instructions.includes(readFileSync(join(installed, 'src', part), 'utf8')), `${role} must load ${part}`);
    }
    const withheld = ['common.md', 'roles/supervisor.md', 'roles/lead.md', 'roles/peer.md', 'delegation.md'].filter(p => !parts.includes(p));
    for (const part of withheld) {
      assert.ok(!bundle.instructions.includes(readFileSync(join(installed, 'src', part), 'utf8')), `${role} must not load ${part}`);
    }
  }
  assert.throws(() => roleBundle(installed, 'engineer'), /Unknown role/);
});

test('decision-doctrine lines reach the standalone bundles that need them and never reach Peer', t => {
  const installed = join(fixture(t), 'release');
  install(root, installed);
  // The review-gate invariant and the create_agent parentage rule ride
  // delegation.md (Supervisor + Lead); the re-read trigger and the
  // protocol-read timing live in the role files. Peer must receive none.
  const [supervisor, lead] = ['supervisor', 'lead'].map(role => roleBundle(installed, role, {}).instructions);
  for (const instructions of [supervisor, lead]) {
    assert.match(instructions, /does not license merging\s+the axes into one seat/, 'review-gate invariant');
    assert.match(instructions, /cannot carry a new\s+delegation/, 'agent-scoped create_agent rule');
    // C8 formation pins ride delegation.md into both orchestrating bundles:
    // the three-way decision table, the formation record, the placement pin
    // and the post-create parentage verification.
    assert.match(instructions, /New-team delegation/, 'decision table: new-team row');
    assert.match(instructions, /Continuation: same team and ownership/, 'decision table: continuation row');
    assert.match(instructions, /Observe-existing-work/, 'decision table: observe-existing row');
    assert.match(instructions, /formation record/, 'preflight formation record');
    assert.match(instructions, /not evidence of parentage/, 'post-create verification');
    assert.match(instructions, /paseo\.parent-agent-id label must match/, 'inbound-route self-check rides common.md');
    assert.match(instructions, /distinct from your\s+parent/, 'observe-existing carve-out: recipient need not equal parent');
    assert.match(instructions, /not a hard block/, 'unexposed label is a recorded gap, not a block');
    assert.match(instructions, /names no agent\s+recipient/, 'no-named-recipient case is classified, not a block');
    assert.match(instructions, /not filesystem\s+isolation/, 'workspace placement pin');
    assert.match(instructions, /send_agent_prompt to a\s+parentless or differently parented/, 'B21 formation-defect trigger');
    assert.match(instructions, /second workspace\s+for the same team with no isolation reason/, 'B22 placement-defect trigger');
  }
  assert.match(lead, /re-read\s+the review-gate rules/);
  assert.match(lead, /after resume or compaction/);
  assert.ok(!/re-read\s+the review-gate rules/.test(supervisor), 'the re-read trigger is Lead-scoped');
  assert.match(supervisor, /before replying to the Human/, 'B12 protocol-read timing');
  assert.match(lead, /before your first reply/, 'B12 protocol-read timing');
  // Role-scoped C8 cues: the observe-vs-establish distinction is Supervisor's;
  // the conditional parent-label fallback and no-adoption rule are Lead's.
  assert.match(supervisor, /standalone session never makes\s+it your child/, 'Supervisor new-team vs observe cue');
  assert.ok(!/standalone session never makes\s+it your child/.test(lead), 'Supervisor cue stays role-scoped');
  assert.match(lead, /does not adopt it/, 'Lead continuity boundary');
  assert.match(lead, /does not repair a wrong parent/, 'Lead conditional parent-label fallback');
  assert.ok(!/does not adopt it/.test(supervisor), 'Lead cue stays role-scoped');
  const peer = roleBundle(installed, 'peer', {}).instructions;
  assert.ok(!/does not license merging/.test(peer));
  assert.ok(!/re-read\s+the review-gate rules/.test(peer));
  assert.ok(!/cannot carry a new\s+delegation/.test(peer));
  assert.ok(!/New-team delegation|Observe-existing-work|formation record/.test(peer), 'Peer gets no formation doctrine');
  assert.ok(!/not evidence of parentage|not filesystem\s+isolation/.test(peer));
  // The inbound-route self-check is a Peer-visible self-check on the seat's own
  // assignment envelope (common.md), not formation doctrine — it must reach Peer.
  assert.match(peer, /paseo\.parent-agent-id label must match/, 'inbound-route self-check is Peer-visible');
  assert.match(peer, /distinct from your\s+parent/, 'Peer self-check keeps the observe-existing carve-out');
  assert.match(peer, /not a hard block/, 'Peer self-check tolerates an unexposed label');
  assert.match(peer, /names no agent\s+recipient/, 'Peer self-check classifies the no-recipient case');
  for (const ref of ['orchestration.md', 'review-gates.md']) {
    assert.ok(!peer.includes(readFileSync(join(installed, 'src/references', ref), 'utf8')), `Peer must not load ${ref} bytes`);
  }
  // The shipped protocol template carries the same doctrine: read-on-landing,
  // split-axis gate wording, idle retention, create_agent-only seats and the
  // shared-workspace placement default with the owner-map/receipt record.
  const template = readFileSync(join(installed, 'src/templates/workspace-protocol.md'), 'utf8');
  assert.match(template, /when the assignment lands/);
  assert.match(template, /split-axis seats, never one merged seat/);
  assert.match(template, /keep accepted Peers idle/);
  assert.match(template, /assignment that formed the team/, 'idle-retention referent is the team assignment');
  assert.match(template, /agent-scoped create_agent/);
  assert.match(template, /share the\s+assignment'?s workspace by default/, 'team-workspace default');
  assert.match(template, /owner map and\s+creation receipts/, 'formation receipts tactic');
  // B25: split-seat naming convention — slash suffix, never an "axis" suffix.
  assert.match(template, /Reviewer — <task> \/ Spec/, 'Spec seat naming convention');
  assert.match(template, /Reviewer — <task> \/ Standard`/, 'Standard seat naming convention, unabbreviated');
  assert.match(template, /never\s+an "axis" suffix/);
  // B24: monitoring doctrine enumerates seats by identity, not cwd, and never
  // infers nonexistence from an empty listing (references ship as locators —
  // pin the installed bytes directly).
  const monitoring = readFileSync(join(installed, 'src/references/monitoring.md'), 'utf8');
  assert.match(monitoring, /never by cwd/, 'seat enumeration is not cwd-scoped');
  assert.match(monitoring, /empty list_agents result does not prove/, 'empty list is not nonexistence');
  assert.match(monitoring, /refs\/heads\/<lane>/, 'lane branches carry lane commits');
  // M2: the single-seat exception is class-listed and Lead-recorded; a
  // required gate never collapses into one seat.
  const gates = readFileSync(join(installed, 'src/references/review-gates.md'), 'utf8');
  assert.match(gates, /change classes the protocol lists\s+explicitly/, 'single-seat exception is class-listed');
  assert.match(gates, /never single-seat/, 'required gate never collapses to one seat');
  assert.match(gates, /Lead decides it and\s+records/, 'exception authority and record are pinned');
});
