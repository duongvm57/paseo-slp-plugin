import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { install, json, hash } from '../plugin/server/runtime/cli/package.ts';
import { launchPlan, handoffPlan, launchCheck, requestSchema } from '../plugin/server/runtime/cli/launch.ts';
import { readAssignmentSnapshot } from '../plugin/server/runtime/cli/assignment-file.ts';
import { readCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { spawnKit } from '../plugin/server/runtime/cli/spawn-kit.ts';
import { buildHandoffRecap } from '../plugin/server/runtime/handoff-recap.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = join(dir, 'installed');
  install(root, installed);
  return { dir, installed };
}
const request = { repository: root, workspaceId: 'wks-launch', assignment: 'Bounded task; no external effects.' };
const piBinding = { provider: 'pi', model: 'opencode/glm-5.3-flash' };
const providers = [{ id: 'slp-devin-peer', enabled: true, status: 'available' }];
function catalogFixture(dir) {
  mkdirSync(join(dir, '.paseo-slp'), { recursive: true });
  writeFileSync(join(dir, '.paseo-slp/slp-routing.json'), json({
    version: 1, policy: 'Test pool.', quotaFallback: { enabled: false, optionId: null },
    options: [{ id: 'devin-peer', provider: 'devin', roles: ['peer'], model: 'swe-2-high',
      modeId: 'bypass', features: { auto_accept: true }, enabled: true, availability: 'ready',
      priority: 10, suitableFor: ['coding'], avoidFor: [], notes: 'test seat' }],
  }));
  return { optionId: 'devin-peer', catalogSha256: readCatalog(dir).sha256 };
}

const NO_MODE_WARNING = 'no modeId resolved (none in the binding and no agent_mode in .paseo-slp/workspace-protocol.md) — the spawn would inherit the caller default and cross-family inheritance fails at the host; pin modeId in the pool option or saved profile, or ask the Human';

test('plan surfaces the intended modeId with its provenance and warns when nothing resolves one', t => {
  const { dir, installed } = fixture(t);
  const base = { ...request, repository: dir, role: 'lead' };
  const withMode = launchPlan(installed, { ...base, binding: { ...piBinding, modeId: 'bypass' } });
  assert.equal(withMode.modeId, 'bypass');
  assert.equal(withMode.modeIdSource, 'binding');
  assert.equal(withMode.warnings, undefined);
  assert.deepEqual(withMode.create.settings, { modeId: 'bypass', features: {} });
  const noMode = launchPlan(installed, { ...base, binding: piBinding });
  assert.equal(noMode.modeId, null);
  assert.equal(noMode.modeIdSource, 'none');
  assert.deepEqual(noMode.warnings, [NO_MODE_WARNING]);
  assert.deepEqual(noMode.create.settings, { features: {} });
  // The create.* argument record is unchanged: only additive top-level fields.
  assert.deepEqual(Object.keys(noMode.create).sort(),
    ['initialPrompt', 'notifyOnFinish', 'provider', 'settings', 'title', 'workspaceId']);
});

test('agent_mode frontmatter is the declared mode fallback — emitted, sourced and warned', t => {
  const { dir, installed } = fixture(t);
  // A bundle-level pin always wins over the repository's declared default.
  mkdirSync(join(dir, '.paseo-slp'), { recursive: true });
  writeFileSync(join(dir, '.paseo-slp', 'workspace-protocol.md'),
    '---\nversion: \'1\'\nagent_mode: \'full-access\'\n---\n\n# Protocol\n');
  const pinned = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: { ...piBinding, modeId: 'bypass' } });
  assert.equal(pinned.modeId, 'bypass');
  assert.equal(pinned.modeIdSource, 'binding');
  assert.equal(pinned.warnings, undefined);
  // No pin → the protocol's agent_mode resolves into create.settings.modeId.
  const fallback = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: piBinding });
  assert.equal(fallback.modeId, 'full-access');
  assert.equal(fallback.modeIdSource, 'agent_mode');
  assert.deepEqual(fallback.create.settings, { modeId: 'full-access', features: {} });
  assert.equal(fallback.warnings.length, 1);
  assert.match(fallback.warnings[0], /agent_mode, not pinned in the binding/);
  // An empty agent_mode is the same as absent — nothing resolves to 'none'.
  writeFileSync(join(dir, '.paseo-slp', 'workspace-protocol.md'),
    '---\nversion: \'1\'\nagent_mode: \'\'\n---\n\n# Protocol\n');
  const none = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: piBinding });
  assert.equal(none.modeId, null);
  assert.equal(none.modeIdSource, 'none');
  assert.deepEqual(none.warnings, [NO_MODE_WARNING]);
});

test('prepare on a non-installed root names the root and the installed CLI, never raw ENOENT', t => {
  const { dir, installed } = fixture(t);
  // dir itself has no installed.json — the same failure a source checkout hits.
  let error;
  try { launchPlan(dir, request); } catch (e) { error = e; }
  assert.match(error.message, /No installed runtime at .*missing installed\.json receipt/);
  assert.match(error.message, /bin\/slp\.mjs/);
  assert.ok(!/ENOENT/.test(error.message), `raw ENOENT leaked: ${error.message}`);
  // The tail is caller-neutral: verify/uninstall hit the same path.
  assert.ok(!/prepare/.test(error.message), `prepare-flavored tail leaked: ${error.message}`);
  // A corrupt receipt is tampering evidence, not a missing install.
  writeFileSync(join(dir, 'installed.json'), 'not json');
  assert.throws(() => launchPlan(dir, request), /not valid JSON/);
  assert.throws(() => launchPlan(dir, request), /^(?!.*No installed runtime)/s);
  // A receipt-present install missing a package file is tampering — the
  // candidate mismatch surfaces, never the "not installed" hint.
  rmSync(join(installed, 'src/common.md'));
  assert.throws(() => launchPlan(installed, request), /Installed candidate changed/);
  assert.throws(() => launchPlan(installed, request), /^(?!.*No installed runtime)/s);
  // Payload-level ENOTDIR (a package path is a regular file) maps to the
  // same incomplete-install class instead of surfacing unadorned.
  rmSync(join(installed, 'src'), { recursive: true });
  writeFileSync(join(installed, 'src'), 'not a directory');
  assert.throws(() => launchPlan(installed, request), /Installed runtime at .* is incomplete — a package file is missing/s);
});

test('spawnKit carries role-scoped approximate MCP tool signatures', t => {
  const { dir, installed } = fixture(t);
  const orchestrating = ['slp_seat_create', 'slp_seat_create', 'slp_task_deliver', 'slp_task_get', 'slp_operation_get', 'create_agent', 'send_agent_prompt', 'create_workspace', 'list_workspaces',
    'list_providers', 'list_profiles', 'list_agents', 'get_agent_status', 'get_agent_activity',
    'create_heartbeat', 'delete_heartbeat', 'cancel_agent'];
  for (const role of ['supervisor', 'lead']) {
    const plan = launchPlan(installed, { ...request, repository: dir, role, binding: piBinding });
    assert.match(plan.spawnKit.note, /approximate; consult the specific live schema for unfamiliar parameters or a mismatch/);
    assert.deepEqual(plan.spawnKit.tools.map(tool => tool.split('(')[0]), orchestrating);
    assert.match(plan.spawnKit.tools[5], /labels\?: object/);
    for (const tool of plan.spawnKit.tools) assert.match(tool, /^[a-z_]+\([^)]*\)$/);
    // The carrier: create_agent transmits only initialPrompt, so the kit must
    // reach the child there, not just at plan level.
    for (const tool of plan.spawnKit.tools) assert.ok(plan.create.initialPrompt.includes(`- ${tool}`));
    assert.match(plan.create.initialPrompt, /approximate; consult the specific live schema for unfamiliar parameters or a mismatch/);
  }
  const peer = launchPlan(installed, { ...request, repository: dir, role: 'peer', providers, route: catalogFixture(dir) });
  assert.deepEqual(peer.spawnKit.tools.map(tool => tool.split('(')[0]), ['slp_task_get', 'send_agent_prompt', 'get_agent_status']);
  // The Peer route resolves a verified slp-*-peer wrapper, which injects the
  // carrier at session entry — the prompt omits it, the plan fields stay.
  assert.ok(!peer.create.initialPrompt.includes('Policy locators —'));
  assert.equal(peer.spawnKit.tools.length, 3);
  assert.throws(() => spawnKit('human'), /Unknown role/);
});

test('the carrier appears exactly once in a stock-provider prompt', t => {
  const { dir, installed } = fixture(t);
  // Stock providers inline role instructions into the prompt AND plan()
  // appends the carrier block — the inline copy must not repeat it.
  const plan = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: piBinding });
  assert.equal(plan.create.initialPrompt.split('Spawn kit — role-scoped').length - 1, 1);
  assert.equal(plan.create.initialPrompt.split('Policy locators —').length - 1, 1);
  // The inline instructions keep their policy bytes; only the carrier opts out.
  assert.ok(plan.create.initialPrompt.includes(readFileSync(join(installed, 'src/roles/lead.md'), 'utf8')));
});

test('assignmentFile defaults and explicit pointer preserve the legacy prompt bytes', t => {
  const { dir, installed } = fixture(t);
  const assignmentFile = join(dir, 'brief.md');
  writeFileSync(assignmentFile, 'file content remains external');
  const base = { ...request, repository: dir, role: 'lead', binding: piBinding, assignmentFile };
  const implicit = launchPlan(installed, base).create.initialPrompt;
  const explicit = launchPlan(installed, { ...base, assignmentFileMode: 'pointer' }).create.initialPrompt;
  assert.equal(explicit, implicit);
  assert.ok(implicit.includes(`Assignment file: ${assignmentFile} — read it first; it is authoritative for scope details.`));
  assert.ok(!implicit.includes('file content remains external'));
});

test('snapshot mode validates and inlines normalized, hashed repository content', t => {
  const { dir, installed } = fixture(t);
  const assignmentFile = join(dir, 'brief.md');
  const normalized = 'alpha\nbeta\ngamma';
  writeFileSync(assignmentFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\r\nbeta\rgamma')]));
  const plan = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: piBinding,
    assignmentFile, assignmentFileMode: 'snapshot' });
  const prompt = plan.create.initialPrompt;
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  assert.ok(prompt.includes(`Assignment snapshot: brief.md — sha256 ${digest}, ${Buffer.byteLength(normalized)} bytes; the inline text below is authoritative, do not re-read the file.`));
  assert.ok(prompt.includes(`<<<SLP assignment snapshot>>>\n${normalized}\n<<<end SLP assignment snapshot>>>`));
  assert.ok(!prompt.includes('Assignment file:'));
  assert.ok(!prompt.includes(assignmentFile), 'snapshot provenance does not reveal the absolute file path');
  assert.ok(prompt.includes('Workspace ID: wks-launch'));
});

test('snapshot mode fails closed for missing/invalid mode and reports launchCheck at assignmentFile', t => {
  const { dir, installed } = fixture(t);
  const base = { ...request, repository: dir, role: 'lead', binding: piBinding };
  for (const requestWithMode of [
    { ...base, assignmentFileMode: 'pointer' },
    { ...base, assignmentFileMode: 'snapshot' },
    { ...base, assignmentFileMode: 'inline', assignmentFile: join(dir, 'brief.md') },
  ]) {
    assert.throws(() => launchPlan(installed, requestWithMode), error => error.message.startsWith('assignment-snapshot-invalid-mode:'));
    const checked = launchCheck(installed, requestWithMode);
    const assignmentCheck = checked.checks.find(check => check.name === 'assignmentFile');
    assert.equal(assignmentCheck.ok, false);
    assert.match(assignmentCheck.error, /^assignment-snapshot-invalid-mode:/);
  }
});

test('snapshot mode enforces root containment, including file and component symlink escapes', t => {
  const { dir, installed } = fixture(t);
  const outsideDir = mkdtempSync(join(dirname(dir), `${basename(dir)}-outside-`));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  const outside = join(outsideDir, 'brief.md');
  writeFileSync(outside, 'outside');
  const base = { ...request, repository: dir, role: 'lead', binding: piBinding, assignmentFileMode: 'snapshot' };
  assert.throws(() => launchPlan(installed, { ...base, assignmentFile: outside }), error => error.message.startsWith('assignment-snapshot-outside-root:'));

  const fileLink = join(dir, 'file-escape.md');
  symlinkSync(outside, fileLink);
  assert.throws(() => launchPlan(installed, { ...base, assignmentFile: fileLink }), error => error.message.startsWith('assignment-snapshot-outside-root:'));

  const dirLink = join(dir, 'directory-escape');
  symlinkSync(outsideDir, dirLink, 'dir');
  assert.throws(() => launchPlan(installed, { ...base, assignmentFile: join(dirLink, 'brief.md') }), error => error.message.startsWith('assignment-snapshot-outside-root:'));

  const internal = join(dir, 'internal.md');
  const internalLink = join(dir, 'internal-link.md');
  writeFileSync(internal, 'inside');
  symlinkSync(internal, internalLink);
  const allowed = launchPlan(installed, { ...base, assignmentFile: internalLink });
  assert.ok(allowed.create.initialPrompt.includes('Assignment snapshot: internal.md'));

  const repositoryLink = join(dirname(dir), `${basename(dir)}-repository-link`);
  symlinkSync(dir, repositoryLink, 'dir');
  t.after(() => rmSync(repositoryLink, { force: true }));
  const throughRepositoryLink = launchPlan(installed, { ...base, repository: repositoryLink, assignmentFile: join(repositoryLink, 'internal.md') });
  assert.ok(throughRepositoryLink.create.initialPrompt.includes('Assignment snapshot: internal.md'));
});

test('snapshot mode rejects non-regular, oversize, invalid UTF-8, controls and nested markers', t => {
  const { dir, installed } = fixture(t);
  const assignmentFile = join(dir, 'brief.md');
  const base = { ...request, repository: dir, role: 'lead', binding: piBinding, assignmentFile, assignmentFileMode: 'snapshot' };
  const code = (expected, contents) => {
    writeFileSync(assignmentFile, contents);
    assert.throws(() => launchPlan(installed, base), error => error.message.startsWith(`assignment-snapshot-${expected}:`));
  };

  const directory = join(dir, 'assignment-directory');
  mkdirSync(directory);
  assert.throws(() => launchPlan(installed, { ...base, assignmentFile: directory }), error => error.message.startsWith('assignment-snapshot-not-regular:'));
  if (process.platform !== 'win32') {
    const fifo = join(dir, 'assignment-fifo');
    try {
      execFileSync('mkfifo', [fifo]);
      assert.throws(() => launchPlan(installed, { ...base, assignmentFile: fifo }), error => error.message.startsWith('assignment-snapshot-not-regular:'));
    } catch (error) {
      if (error?.code === 'ENOENT') t.diagnostic('mkfifo unavailable; FIFO branch not exercised');
      else throw error;
    }
  }

  writeFileSync(assignmentFile, Buffer.alloc(16_384, 0x61));
  assert.ok(launchPlan(installed, base).create.initialPrompt.includes('16384 bytes;'));
  code('oversize', Buffer.alloc(16_385, 0x61));
  code('not-text', Buffer.from([0xc3, 0x28]));
  code('not-text', 'nul\0byte');
  code('not-text', 'control\u0001byte');
  code('not-text', 'control\u0085byte');
  for (const contents of [
    'Assignment file: nested.md',
    ' \tAssignment file: nested.md',
    'Assignment file: nested.md\r\n',
    '<<<SLP assignment snapshot>>>',
    '<<<end SLP assignment snapshot>>>',
  ]) code('nested-marker', contents);
});

test('snapshot credential errors disclose only the pattern class', t => {
  const { dir, installed } = fixture(t);
  const assignmentFile = join(dir, 'brief.md');
  const secret = `sk-${'a'.repeat(24)}`;
  writeFileSync(assignmentFile, `token=${secret}`);
  let failure;
  try {
    launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: piBinding,
      assignmentFile, assignmentFileMode: 'snapshot' });
  } catch (error) { failure = error; }
  assert.match(failure.message, /^assignment-snapshot-credential:.*openai-style-key/);
  assert.ok(!failure.message.includes(secret));
});

test('snapshot credential-shaped provenance paths fail without disclosing the path', t => {
  const { dir, installed } = fixture(t);
  const secret = `sk-${'a'.repeat(24)}`;
  const assignmentFile = join(dir, `${secret}.md`);
  writeFileSync(assignmentFile, 'Ordinary brief.');
  assert.throws(() => launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: piBinding,
    assignmentFile, assignmentFileMode: 'snapshot' }), error => {
    assert.equal(error.code, 'assignment-snapshot-credential');
    assert.match(error.message, /openai-style-key/);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes(assignmentFile));
    return true;
  });
});

test('snapshot mode maps unreadable files and detects replacement through the read seam', t => {
  const { dir, installed } = fixture(t);
  const assignmentFile = join(dir, 'brief.md');
  writeFileSync(assignmentFile, 'readable');

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    chmodSync(assignmentFile, 0);
    assert.throws(() => launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: piBinding,
      assignmentFile, assignmentFileMode: 'snapshot' }), error => error.message.startsWith('assignment-snapshot-unresolvable:'));
    chmodSync(assignmentFile, 0o644);
  }

  const real = fs.realpathSync(assignmentFile);
  const io = {
    ...fs,
    statSync(path, ...args) {
      const value = fs.statSync(path, ...args);
      if (path === real) return { dev: value.dev, ino: value.ino + 1, isFile: () => value.isFile() };
      return value;
    },
  };
  assert.throws(() => readAssignmentSnapshot(dir, assignmentFile, io), error => error.message.startsWith('assignment-snapshot-changed:'));
});

test('the prompt carrier is dropped only when the target wrapper provably injects it', t => {
  const { dir, installed } = fixture(t);
  const leadProviders = [{ id: 'slp-codex-lead', enabled: true, status: 'available' }];
  const wrapped = { ...piBinding, provider: 'slp-codex-lead' };
  // Canonical wrapper observed live → the session-entry injection carries it.
  const live = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: wrapped, providers: leadProviders });
  assert.ok(!live.create.initialPrompt.includes('Policy locators —'));
  assert.ok(!live.create.initialPrompt.includes('Spawn kit —'));
  assert.equal(live.spawnKit.tools.length, 17);
  assert.ok(live.orientation.policyBytes.length > 0);
  // The same wrapper without a live inventory observation keeps the fallback.
  const blind = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: wrapped });
  assert.equal(blind.create.initialPrompt.split('Policy locators —').length - 1, 1);
  // Configured-provenance inventory is not live evidence — carrier stays.
  const configured = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: wrapped,
    providers: [{ id: 'slp-codex-lead', enabled: true, provenance: 'configured' }] });
  assert.equal(configured.create.initialPrompt.split('Policy locators —').length - 1, 1);
  // An unavailable observation is equally unproven.
  const down = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: wrapped,
    providers: [{ id: 'slp-codex-lead', enabled: true, status: 'unavailable' }] });
  assert.equal(down.create.initialPrompt.split('Policy locators —').length - 1, 1);
  // A mismatched extends cannot be this package's wrapper.
  const alien = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: wrapped,
    providers: [{ id: 'slp-codex-lead', enabled: true, extends: 'pi' }] });
  assert.equal(alien.create.initialPrompt.split('Policy locators —').length - 1, 1);
});

test('verbatim provider shape is enforced — added, removed or forged fields refuse verification', t => {
  const { dir, installed } = fixture(t);
  const route = catalogFixture(dir);
  const base = { ...request, repository: dir, role: 'peer', route };
  const observed = {
    id: 'slp-devin-peer', enabled: true, status: 'available',
    paseoTools: { disabledTools: ['create_agent'] }, disallowedTools: ['Task'],
  };
  const plan = launchPlan(installed, { ...base, providers: [observed] });
  assert.match(plan.create.provider, /^slp-devin-peer\//);
  // Added field — a forged marker is outside the live record vocabulary.
  assert.throws(() => launchPlan(installed, { ...base, providers: [{ ...observed, forged: true }] }),
    /unexpected field\(s\) 'forged'.*verbatim/);
  // Removed required field — a stripped `enabled` fails the fail-closed gate
  // (undefined is not true).
  const { enabled: _enabled, ...noEnabled } = observed;
  assert.throws(() => launchPlan(installed, { ...base, providers: [noEnabled] }),
    /enabled===true.*observed enabled: undefined/);
  // A forged provenance key cannot dress a static read as live evidence.
  assert.throws(() => launchPlan(installed, { ...base, providers: [{ ...observed, provenance: 'live' }] }),
    /unexpected field\(s\) 'provenance'/);
  // Edited extends still refuses on the family check.
  assert.throws(() => launchPlan(installed, { ...base, providers: [{ ...observed, extends: 'pi' }] }),
    /'extends' \(pi\) does not match the 'devin' transport/);
  // Advisory path: an explicit binding keeps the prompt carrier when the
  // observed entry fails the shape check.
  const wrapped = { ...piBinding, provider: 'slp-codex-lead' };
  const forged = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: wrapped,
    providers: [{ id: 'slp-codex-lead', enabled: true, status: 'available', forged: true }] });
  assert.equal(forged.create.initialPrompt.split('Policy locators —').length - 1, 1);
});

test('verifyProvider fails closed on enabled — null (unknown) refuses like false', t => {
  const { dir, installed } = fixture(t);
  const route = catalogFixture(dir);
  const base = { ...request, repository: dir, role: 'peer', route };
  // Tri-state null from inventory normalization means "unknown", never
  // enabled — it must not pass as live-verified.
  assert.throws(() => launchPlan(installed, { ...base,
    providers: [{ id: 'slp-devin-peer', enabled: null, status: 'available' }] }),
    /enabled===true.*observed enabled: null/);
  assert.throws(() => launchPlan(installed, { ...base,
    providers: [{ id: 'slp-devin-peer', enabled: false, status: 'available' }] }),
    /observed enabled: false/);
  // Advisory path: enabled:null keeps the prompt carrier — the provider is
  // unproven, so the fallback block stays.
  const wrapped = { ...piBinding, provider: 'slp-codex-lead' };
  const unknown = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: wrapped,
    providers: [{ id: 'slp-codex-lead', enabled: null, status: 'available' }] });
  assert.equal(unknown.create.initialPrompt.split('Policy locators —').length - 1, 1);
});

test('orientation carries mechanical locators only', t => {
  const { dir, installed } = fixture(t);
  const lead = launchPlan(installed, { ...request, repository: dir, role: 'lead', binding: piBinding });
  assert.equal(lead.orientation.installedRoot, installed);
  assert.equal(lead.orientation.catalogSha256, null);
  const byPath = Object.fromEntries(lead.orientation.policyBytes.map(entry => [entry.path, entry]));
  const paths = lead.orientation.policyBytes.map(entry => entry.path);
  assert.deepEqual(paths, [...paths].sort(), 'policyBytes sorts by path; no bundle-order hint');
  for (const entry of lead.orientation.policyBytes) {
    assert.ok(entry.path.startsWith(`${installed}/`), 'policyBytes paths are absolute under installedRoot');
  }
  // docs/contract.md is a source-checkout document outside the install unit;
  // the locator set derives from the install receipt and never declares it.
  assert.equal(byPath[join(installed, 'docs/contract.md')], undefined);
  const receipt = JSON.parse(readFileSync(join(installed, 'installed.json'), 'utf8'));
  const expectedPolicy = ['src/common.md', 'src/roles/lead.md', 'src/delegation.md',
    ...receipt.candidate.files.map(entry => entry.path).filter(path => path.startsWith('src/references/'))];
  for (const rel of expectedPolicy) {
    const entry = byPath[join(installed, rel)];
    const bytes = readFileSync(join(installed, rel));
    assert.deepEqual(entry, { path: join(installed, rel), bytes: bytes.length, sha256: hash(bytes) });
  }
  assert.equal(lead.orientation.policyBytes.length, expectedPolicy.length);
  // Carrier: locators must survive into initialPrompt on the fallback path
  // (stock piBinding is not an injecting wrapper, so the carrier stays).
  assert.ok(lead.create.initialPrompt.includes(`- ${join(installed, 'src/common.md')} — `));
  assert.ok(lead.create.initialPrompt.includes(`${join(installed, 'src/common.md')} — ${readFileSync(join(installed, 'src/common.md')).length} bytes, sha256 ${hash(readFileSync(join(installed, 'src/common.md')))}`));
  assert.ok(!lead.create.initialPrompt.includes('docs/contract.md'));
  // A Peer bundle omits delegation.md and passes the routed catalog hash through.
  const route = catalogFixture(dir);
  const peer = launchPlan(installed, { ...request, repository: dir, role: 'peer', providers, route });
  assert.equal(peer.orientation.catalogSha256, route.catalogSha256);
  const peerPaths = peer.orientation.policyBytes.map(entry => entry.path);
  assert.ok(peerPaths.includes(join(installed, 'src/common.md')));
  assert.ok(peerPaths.includes(join(installed, 'src/roles/peer.md')));
  assert.ok(!peerPaths.includes(join(installed, 'src/delegation.md')));
  assert.deepEqual(peerPaths, [join(installed, 'src/common.md'), join(installed, 'src/roles/peer.md')].sort());
  assert.equal(peer.orientation.policyBytes.length, 2);
});

test('launchCheck names every failing stage and separates profile completeness from live provider verification', t => {
  const { dir, installed } = fixture(t);
  const profiles = [{ id: 'slp-lead', provider: 'slp-codex-lead', model: 'gpt-5.6-luna', modeId: 'full-access' }];
  const goodProviders = [{ id: 'slp-codex-lead', enabled: true, status: 'available', extends: 'codex' }];
  const byName = report => Object.fromEntries(report.checks.map(check => [check.name, check]));
  // All-green: profile resolves and the provider is live-verified.
  const ok = launchCheck(installed, { ...request, repository: dir, role: 'lead', profiles, providers: goodProviders });
  assert.equal(ok.ok, true);
  assert.equal(byName(ok).provider.detail, 'live-verified: slp-codex-lead');
  assert.equal(byName(ok).plan.ok, true);
  // Missing profile: binding names it; provider stays undetermined-but-required.
  const missing = launchCheck(installed, { ...request, repository: dir, role: 'lead', profiles: [], providers: goodProviders });
  assert.equal(missing.ok, false);
  assert.match(byName(missing).binding.error, /Missing Paseo profile slp-lead/);
  assert.equal(byName(missing).provider.ok, false);
  // Stages that cannot run are marked skipped, not silently absent.
  assert.equal(byName(missing).settings.skipped, true);
  // Profile complete but provider only configured: the provider check, not the
  // binding check alone, is what fails on live-evidence grounds.
  const configured = launchCheck(installed, { ...request, repository: dir, role: 'lead', profiles,
    providers: [{ id: 'slp-codex-lead', enabled: true, provenance: 'configured' }] });
  assert.equal(configured.ok, false);
  assert.match(byName(configured).provider.error, /configured inventory is not live evidence/);
  // Profile without a model fails completeness while the provider still verifies.
  const noModel = launchCheck(installed, { ...request, repository: dir, role: 'lead',
    profiles: [{ id: 'slp-lead', provider: 'slp-codex-lead' }], providers: goodProviders });
  assert.match(byName(noModel).binding.error, /configure a model/);
  assert.equal(byName(noModel).provider.ok, true);
  // A missing mode is a warning, not a failure.
  const noMode = launchCheck(installed, { ...request, repository: dir, role: 'lead',
    profiles: [{ id: 'slp-lead', provider: 'slp-codex-lead', model: 'gpt-5.6-luna' }], providers: goodProviders });
  assert.equal(noMode.ok, true);
  assert.deepEqual(noMode.warnings, [NO_MODE_WARNING]);
  // Stale catalog hash is reported before create on the Peer path, while the
  // wrapper's live state is still reported separately.
  const peer = launchCheck(installed, { ...request, repository: dir, role: 'peer', providers,
    route: { ...catalogFixture(dir), catalogSha256: 'stale' } });
  assert.equal(peer.ok, false);
  assert.match(byName(peer).binding.error, /Routing catalog changed/);
  assert.equal(byName(peer).provider.detail, 'live-verified: slp-devin-peer');
  // Explicit binding without inventory: provider verification is advisory, not
  // a failure — the planner keeps the prompt carrier either way.
  const explicit = launchCheck(installed, { ...request, repository: dir, role: 'lead', binding: piBinding });
  assert.equal(explicit.ok, true);
  assert.match(byName(explicit).provider.detail, /not live-verified|no provider to verify/);
  // Handoff mode adds the settlement-evidence stage.
  const handoff = { previousAgentId: 'a', reason: 'r', authority: 'Human', state: 'settled',
    previousOwner: { settled: true, evidence: 'receipt' }, resources: [] };
  const hand = launchCheck(installed, { ...request, role: 'lead', binding: piBinding, handoff }, { handoff: true });
  assert.equal(byName(hand).handoff.ok, true);
  const unsettled = launchCheck(installed, { ...request, role: 'lead', binding: piBinding,
    handoff: { ...handoff, previousOwner: { settled: false, evidence: '' } } }, { handoff: true });
  assert.equal(unsettled.ok, false);
  assert.match(byName(unsettled).handoff.error, /settlement evidence/);
  // A non-object request reports one clean failure instead of a TypeError.
  assert.equal(launchCheck(installed, null).checks[0].error, 'Request must be a JSON object');
});

test('requestSchema describes the planner contract and its examples plan once placeholders are filled', t => {
  const { dir, installed } = fixture(t);
  const schema = requestSchema();
  for (const role of ['supervisor', 'lead', 'peer']) assert.ok(schema.examples[role], `example for ${role}`);
  assert.match(schema.description, /descriptive only/);
  for (const role of ['supervisor', 'lead']) {
    const example = structuredClone(schema.examples[role]);
    example.repository = dir;
    example.workspaceId = 'wks-test';
    example.assignment = 'x';
    example.profiles[0].model = 'gpt-5.6-luna';
    example.profiles[0].modeId = 'full-access';
    assert.equal(launchPlan(installed, example).role, role);
  }
  const peer = structuredClone(schema.examples.peer);
  peer.repository = dir;
  peer.workspaceId = 'wks-test';
  peer.assignment = 'x';
  peer.disposition = 'engineer';
  peer.providers = providers;
  peer.route = catalogFixture(dir);
  assert.equal(launchPlan(installed, peer).role, 'peer');
  // The handoff schema is the same base plus settlement requirements.
  const handoffSchema = requestSchema(true);
  assert.equal(handoffSchema.base.repository, schema.base.repository);
  assert.equal(handoffSchema.handoff.previousOwner.settled, 'required true');
});

test('prepare-handoff schema describes explicit recap inputs without requiring them', () => {
  const schema = requestSchema(true).handoff.recapInputs;
  assert.equal(schema.optional, true);
  assert.match(schema.description, /does not read arbitrary host state or source files/u);
  assert.match(schema.reportArtifacts, /candidate, checks and findings remain claims/u);
});

test('handoff plans carry modeId, spawnKit and orientation alongside the packet', t => {
  const { dir, installed } = fixture(t);
  const handoff = { previousAgentId: 'old-lead', reason: 'quota', authority: 'Human requests replacement',
    state: 'paused on snapshot', previousOwner: { settled: true, evidence: 'cancel receipt' }, resources: [] };
  const plan = handoffPlan(installed, { ...request, role: 'lead', binding: piBinding, handoff });
  assert.equal(plan.modeId, null);
  assert.equal(plan.modeIdSource, 'none');
  assert.deepEqual(plan.warnings, [NO_MODE_WARNING]);
  assert.equal(plan.spawnKit.tools.length, 17);
  assert.equal(plan.orientation.installedRoot, installed);
  assert.equal(plan.handoff.previousAgentId, 'old-lead');
  assert.equal(plan.handoff.state, 'paused on snapshot', 'legacy free text remains intact');
  assert.equal(plan.handoff.recap.transfer.settlement, 'unverified');
  assert.equal(plan.handoff.recap.transfer.recipientAcknowledgment, 'not-observed');
  assert.ok(plan.handoff.recap.gaps.includes('assignment-source-missing'));
  assert.match(plan.create.initialPrompt, /Structured handoff context is incomplete/u);
  // Handed-off seats receive the carrier inside the prompt too.
  assert.ok(plan.create.initialPrompt.includes('- create_agent(title: string'));
  assert.match(plan.create.initialPrompt, /Provider handoff evidence:/);

  const assignmentFile = join(dir, 'handoff-brief.md');
  writeFileSync(assignmentFile, 'handoff snapshot body');
  const snapshotPlan = handoffPlan(installed, { ...request, role: 'lead', binding: piBinding, handoff,
    assignmentFile, assignmentFileMode: 'snapshot' });
  assert.ok(snapshotPlan.create.initialPrompt.includes('Assignment snapshot: .local-checks/'));
  assert.ok(snapshotPlan.create.initialPrompt.includes('handoff snapshot body'));
  assert.ok(!snapshotPlan.create.initialPrompt.includes(`Assignment file: ${assignmentFile} — read it first`));

  const legacyRecap = handoffPlan(installed, { ...request, role: 'lead', binding: piBinding, handoff: {
    ...handoff,
    recapInputs: { reportArtifacts: [{ sourceRef: 'legacy.md#record-1', record: {
      version: 1, kind: 'handback', seat: { role: 'peer', disposition: 'engineer' }, verdict: null,
      candidate: { repository: request.repository, head: 'c'.repeat(40) },
      checks: [{ cmd: 'node --test old.test.mjs', exit: 0, sha: null }],
    } }] },
  } });
  assert.equal(legacyRecap.handoff.recap.candidate.claims[0].checks[0].cmd, 'node --test old.test.mjs');
  assert.ok(legacyRecap.handoff.recap.gaps.includes('report-artifact-report-missing:legacy.md#record-1'));
  assert.match(legacyRecap.create.initialPrompt, /Structured handoff context is incomplete/u);
});

test('recap treats a valid legacy handback without report as evidence claims plus an explicit gap', () => {
  const record = {
    version: 1, kind: 'handback', seat: { role: 'peer', disposition: 'engineer' }, verdict: null,
    candidate: { repository: '/repo', snapshotSha256: 'c'.repeat(64) },
    checks: [{ cmd: 'node --test legacy.test.mjs', exit: 0, sha: null }],
  };
  const recap = buildHandoffRecap({ reportArtifacts: [{ sourceRef: 'legacy.md#record-1', record }] }, {
    repository: '/repo', head: 'a'.repeat(40), sha256: 'b'.repeat(64), incomplete: [], nestedIncomplete: [],
  });

  assert.ok(recap.gaps.includes('report-artifact-report-missing:legacy.md#record-1'));
  assert.equal(recap.candidate.claims[0].candidate.snapshotSha256, 'c'.repeat(64));
  assert.equal(recap.candidate.claims[0].checks[0].cmd, 'node --test legacy.test.mjs');
  assert.deepEqual(recap.candidate.claims[0].findings, []);
  assert.equal(recap.candidate.claims[0].reportedOnly, true);
  assert.equal(recap.candidate.comparison, 'mismatch');
  assert.equal(recap.contextStatus, 'partial');
});

test('handoff recap keeps source artifacts, candidate measurements and report claims distinct', () => {
  const finding = {
    id: 'finding-1', state: 'hypothesis', obligation: 'The candidate requires a Lead ruling.',
    evidence: [{ summary: 'The pinned candidate differs.', source: 'review.md', basis: 'observed', ref: 'review.md#finding-1' }],
    remedy: 'Reconcile the pin before transfer.',
  };
  const record = {
    version: 1, kind: 'handback', seat: { role: 'peer', disposition: 'reviewer' }, verdict: 'FINDINGS',
    candidate: { repository: '/repo', head: 'c'.repeat(40) },
    checks: [{ cmd: 'node --test', exit: 0, sha: null }],
    report: {
      format: 'slp-report', version: 1, purpose: 'execution',
      assignment: {
        id: 'asg-1', revision: 'rev-2', scopeRevision: 'scope-1', sourceRef: 'assignment.json#current',
        objective: 'Prepare a bounded replacement handoff.', acceptance: ['Keep claims distinct from measurements.'],
        authority: [{ claim: 'Human authorized a new session.', sourceRef: 'assignment.json#authority' }],
        scope: { owned: ['handoff'], excluded: ['host lifecycle'] },
      },
      assumptions: ['Owner pins are read-only context.'], unknowns: [], selfReport: { read: [], ran: [] },
      execution: { result: 'Handoff context recorded.', completed: ['report'], unfinished: [] },
      review: null, adjudication: null, findings: [finding], owners: [], dependencies: [],
      nextAction: { state: 'ready', action: 'Lead verifies settlement.', ownerId: 'lead-1' }, resources: [],
    },
  };
  const recap = buildHandoffRecap({
    assignment: {
      id: 'asg-current', revision: 'rev-4', sourceRef: 'assignment.json#current', objective: 'Transfer bounded work.',
      authority: [{ claim: 'Human grant', sourceRef: 'assignment.json#authority' }],
    },
    decisions: [{ proposition: 'Keep old parentage.', ruling: 'Preserve.', reason: 'Host owns lifecycle.', sourceRef: 'decision.json#1' }],
    assumptions: [{ statement: 'No host mutation is planned.', sourceRef: 'assignment.json#assumptions' }],
    unresolved: [{ proposition: 'Confirm old-owner settlement.', reason: 'Needs host/task evidence.', ownerId: 'lead-1', sourceRef: 'status.json#old-owner' }],
    ownerPins: [{ surface: 'report runtime', ownerId: 'peer-2', state: 'active', basis: 'assignment', sourceRef: 'assignment.json#owners' }],
    dependencies: [{ need: 'Lead verifies old-owner settlement.', state: 'open', ownerId: 'lead-1', sourceRef: 'decision.json#dependency' }],
    nextAction: { state: 'blocked', action: 'Wait for settlement evidence.', ownerId: 'lead-1' },
    resources: [{ kind: 'workspace', id: 'wks-1', ownerId: 'lead-1', state: 'retained', sourceRef: 'status.json#workspace' }],
    reportArtifacts: [{ sourceRef: 'handback.md#record-1', record }],
  }, {
    repository: '/repo', head: 'a'.repeat(40), sha256: 'b'.repeat(64), incomplete: ['submodule'], nestedIncomplete: [],
  });

  assert.equal(recap.assignment.id, 'asg-current');
  assert.equal(recap.decisions[0].proposition, 'Keep old parentage.');
  assert.equal(recap.assumptions[0].statement, 'No host mutation is planned.');
  assert.equal(recap.owners[0].ownerId, 'peer-2');
  assert.equal(recap.dependencies[0].state, 'open');
  assert.equal(recap.candidate.measurement.head, 'a'.repeat(40));
  assert.equal(recap.candidate.claims[0].candidate.head, 'c'.repeat(40));
  assert.equal(recap.candidate.claims[0].checks[0].cmd, 'node --test');
  assert.equal(recap.candidate.comparison, 'mismatch');
  assert.deepEqual(recap.candidate.incomplete, ['submodule']);
  assert.equal(recap.findings[0].id, 'finding-1');
  assert.equal(recap.nextAction.state, 'blocked');
  assert.equal(recap.resources[0].ownerId, 'lead-1');
  assert.ok(recap.gaps.includes('candidate-claim-mismatch:handback.md#record-1'));
  assert.ok(recap.gaps.includes('report-assignment-stale:handback.md#record-1'));
  assert.ok(recap.gaps.includes('check-evidence-incomplete:handback.md#record-1'));
  assert.ok(recap.gaps.includes('candidate-measurement-incomplete'));
  assert.equal(recap.transfer.settlement, 'unverified');
  assert.equal(recap.transfer.recipientAcknowledgment, 'not-observed');
});

test('handoff recap makes omitted groups and whitespace-only source claims visible', () => {
  const recap = buildHandoffRecap({
    assignment: { id: 'asg-1', revision: 'rev-1', sourceRef: 'assignment.json', authority: [{ claim: 'Human grant', sourceRef: 'assignment.json#authority' }] },
    decisions: [{ proposition: ' ', ruling: 'Keep.', reason: 'Reviewed.', sourceRef: 'decision.json#1' }],
    assumptions: [], unresolved: [], ownerPins: [], dependencies: [],
    nextAction: { state: 'none', action: null, ownerId: null }, resources: [], reportArtifacts: [],
  }, { repository: '/repo', head: 'a'.repeat(40), sha256: 'b'.repeat(64), incomplete: [], nestedIncomplete: [] });

  assert.equal(recap.contextStatus, 'partial');
  assert.ok(recap.gaps.includes('decisions-row-invalid:0:proposition'));
  assert.deepEqual(recap.gaps.filter(gap => gap.endsWith('-source-missing')), []);
});

test('prepare paths ignore a legacy tracker artifact: no prompt line and byte-identical plans', t => {
  const { dir, installed } = fixture(t);
  // The prepare CLI must run from an installed root — source checkouts refuse.
  const slp = join(installed, 'bin/slp.mjs');
  const home = join(dir, 'home');
  mkdirSync(join(home, 'slp-runtime/state'), { recursive: true });
  const setting = join(home, 'slp-runtime/state/work-tracker.json');
  const baseEnv = { PATH: process.env.PATH };
  const managed = {
    ...baseEnv,
    SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: process.execPath,
    SLP_RUNTIME_ROOT: installed, SLP_DAEMON_HOME: home,
  };
  // A stock provider inlines the full role instructions into the prompt —
  // the only prepare path where session-entry helpers can appear. slp-*
  // wrappers render the short role tag instead and inject the bundle through
  // the hook, which is a different entry surface.
  const request = { repository: dir, workspaceId: 'wks-t3', assignment: 'x', role: 'lead',
    binding: { provider: 'pi', model: 'm' } };
  const reqFile = join(dir, 'req.json');
  writeFileSync(reqFile, json(request));
  const handoff = { previousAgentId: 'a', reason: 'r', authority: 'Human', state: 'settled',
    previousOwner: { settled: true, evidence: 'e' }, resources: [] };
  const handoffFile = join(dir, 'handoff.json');
  // handoffPacket snapshots the repository — point it at a real git root.
  writeFileSync(handoffFile, json({ ...request, repository: root, handoff }));
  const run = (args, env) => spawnSync(process.execPath, [slp, ...args], { env, encoding: 'utf8' });

  for (const [command, file] of [['prepare', reqFile], ['prepare-handoff', handoffFile]]) {
    // A legacy artifact the retired adapter once read — enabled or corrupt —
    // must not add a tracker line or change any plan byte, managed or not.
    rmSync(setting, { force: true });
    const absent = run([command, file], managed);
    const absentUnmanaged = run([command, file], baseEnv);
    assert.equal(absent.status, 0, absent.stderr);
    assert.ok(!JSON.parse(absent.stdout).create.initialPrompt.includes('Work tracker:'));
    for (const artifact of [json({ schemaVersion: 1, tracker: 'beads', enabled: true }), '{corrupt']) {
      writeFileSync(setting, artifact);
      const withArtifact = run([command, file], managed);
      assert.equal(withArtifact.status, 0, withArtifact.stderr);
      assert.equal(withArtifact.stdout, absent.stdout, `${command}: legacy artifact leaves every plan byte identical`);
      const unmanaged = run([command, file], baseEnv);
      assert.equal(unmanaged.stdout, absentUnmanaged.stdout, `${command}: unmanaged output ignores the artifact`);
      assert.ok(!unmanaged.stdout.includes('Work tracker:'));
    }
  }
  // prepare --check emits the stage report — never role instructions — so the
  // artifact is equally inert there.
  rmSync(setting, { force: true });
  const checkOff = run(['prepare', '--check', reqFile], managed);
  writeFileSync(setting, json({ schemaVersion: 1, tracker: 'beads', enabled: true }));
  const checkOn = run(['prepare', '--check', reqFile], managed);
  assert.equal(checkOn.stdout, checkOff.stdout, 'prepare --check output is identical with or without the artifact');
  assert.equal(checkOn.status, checkOff.status);
  // The probe entrypoint is retired with the adapter: `slp tracker` is no
  // longer a command and fails like any other unknown invocation.
  const retired = run(['tracker', dir, '--paseo-home', home], managed);
  assert.notEqual(retired.status, 0);
});

test('handoff packet surfaces unproven submodule scope as an evidence gap, not a refusal', t => {
  const { dir, installed } = fixture(t);
  // Build a real repository with a dirty gitlink so the snapshot is incomplete.
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args]);
  const upstream = join(dir, 'upstream');
  mkdirSync(upstream);
  git(upstream, ['init', '--quiet']);
  writeFileSync(join(upstream, 'u.txt'), 'u');
  git(upstream, ['add', 'u.txt']);
  git(upstream, ['-c', 'user.email=t@slp', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'u']);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '--quiet']);
  writeFileSync(join(repo, 'owned.txt'), 'o');
  git(repo, ['add', 'owned.txt']);
  git(repo, ['-c', 'user.email=t@slp', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'o']);
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, 'sub']);
  git(repo, ['-c', 'user.email=t@slp', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'sub']);
  writeFileSync(join(repo, 'sub/u.txt'), 'unproven edit');
  const handoff = { previousAgentId: 'old-lead', reason: 'quota', authority: 'Human requests replacement',
    state: 'paused on snapshot', previousOwner: { settled: true, evidence: 'cancel receipt' }, resources: [] };
  const plan = handoffPlan(installed, { ...request, repository: repo, role: 'lead', binding: piBinding, handoff });
  assert.deepEqual(plan.handoff.candidate.incomplete, ['sub']);
  assert.match(plan.create.initialPrompt, /Snapshot evidence gap: sub is unproven submodule scope/);
});

test('handoff packet flattens nested-repo submodule gaps into parent-root paths', t => {
  const { dir, installed } = fixture(t);
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args]);
  const commit = (cwd, message = 'c') => git(cwd, ['-c', 'user.email=t@slp', '-c', 'user.name=t', 'commit', '--quiet', '-m', message]);
  const upstream = join(dir, 'upstream');
  mkdirSync(upstream);
  git(upstream, ['init', '--quiet']);
  writeFileSync(join(upstream, 'u.txt'), 'u');
  git(upstream, ['add', 'u.txt']);
  commit(upstream);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '--quiet']);
  writeFileSync(join(repo, 'owned.txt'), 'o');
  git(repo, ['add', 'owned.txt']);
  commit(repo);
  // `inner` is an untracked nested repo whose own submodule is dirty.
  const inner = join(repo, 'inner');
  mkdirSync(inner);
  git(inner, ['init', '--quiet']);
  writeFileSync(join(inner, 'i.txt'), 'i');
  git(inner, ['add', 'i.txt']);
  commit(inner);
  git(inner, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, 'sub']);
  commit(inner);
  writeFileSync(join(inner, 'sub/u.txt'), 'unproven edit');
  const handoff = { previousAgentId: 'old-lead', reason: 'quota', authority: 'Human requests replacement',
    state: 'paused on snapshot', previousOwner: { settled: true, evidence: 'cancel receipt' }, resources: [] };
  const plan = handoffPlan(installed, { ...request, repository: repo, role: 'lead', binding: piBinding, handoff });
  assert.equal(plan.handoff.candidate.incomplete, undefined, 'top-level tree itself is clean');
  assert.deepEqual(plan.handoff.candidate.nestedIncomplete, ['inner/sub']);
  assert.match(plan.create.initialPrompt, /Snapshot evidence gap: inner\/sub is unproven submodule scope/);
});

test('handoff packet keeps the full ancestor prefix for depth-3 submodule gaps', t => {
  const { dir, installed } = fixture(t);
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args]);
  const commit = (cwd, message = 'c') => git(cwd, ['-c', 'user.email=t@slp', '-c', 'user.name=t', 'commit', '--quiet', '-m', message]);
  const upstream = join(dir, 'upstream');
  mkdirSync(upstream);
  git(upstream, ['init', '--quiet']);
  writeFileSync(join(upstream, 'u.txt'), 'u');
  git(upstream, ['add', 'u.txt']);
  commit(upstream);
  const initRepo = path => {
    mkdirSync(path, { recursive: true });
    git(path, ['init', '--quiet']);
    writeFileSync(join(path, 'f.txt'), 'f');
    git(path, ['add', 'f.txt']);
    commit(path);
  };
  const repo = join(dir, 'repo');
  initRepo(repo);
  // `inner` is an untracked nested repo containing another untracked repo
  // `deep`, whose submodule `sub` is dirty — three levels below the top root.
  const inner = join(repo, 'inner');
  initRepo(inner);
  const deep = join(inner, 'deep');
  initRepo(deep);
  git(deep, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, 'sub']);
  commit(deep);
  writeFileSync(join(deep, 'sub/u.txt'), 'unproven edit');
  const handoff = { previousAgentId: 'old-lead', reason: 'quota', authority: 'Human requests replacement',
    state: 'paused on snapshot', previousOwner: { settled: true, evidence: 'cancel receipt' }, resources: [] };
  const plan = handoffPlan(installed, { ...request, repository: repo, role: 'lead', binding: piBinding, handoff });
  assert.deepEqual(plan.handoff.candidate.nestedIncomplete, ['inner/deep/sub']);
  assert.match(plan.create.initialPrompt, /Snapshot evidence gap: inner\/deep\/sub is unproven submodule scope/);
});

test('preparation preserves fail-fast request precedence and diagnostic stage ordering', t => {
  const { dir, installed } = fixture(t);
  const bad = { ...request, repository: dir, role: 'unknown', inventoryFile: 'relative', assignmentFile: 'also-relative' };
  assert.throws(() => launchPlan(installed, bad), /Unknown role/);
  const result = launchCheck(installed, bad);
  assert.deepEqual(result.checks.map(check => check.name), ['install', 'inventoryFile', 'assignmentFile', 'request', 'binding', 'provider', 'settings', 'plan']);
  const errors = Object.fromEntries(result.checks.map(check => [check.name, check.error]));
  assert.equal(errors.inventoryFile, 'Absolute inventoryFile required');
  assert.equal(errors.assignmentFile, 'Absolute assignmentFile required');
  assert.equal(errors.request, 'Unknown role');
  assert.equal(errors.plan, 'Unknown role');
});
