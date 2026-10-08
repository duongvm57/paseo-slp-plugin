// Offline §13 "Payload / materializer" suite: exercises the real generated
// embeddedPayload, the real createMaterializer seam and the production
// identity()/verifyInstall() contract on a temp stable root. No mirrors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, identity, json, verifyInstall } from '../plugin/server/runtime/cli/package.ts';
import { createMaterializer } from '../plugin/server/materializer.ts';
import { createLauncherBuilder } from '../plugin/server/launchers.ts';
import { embeddedPayload } from '../plugin/server/generated/runtime-payload.ts';
import { OperationConflict } from '../plugin/shared/contracts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = embeddedPayload.candidate.sha256;
const materializer = createMaterializer(embeddedPayload);
let sequence = 0;
const operation = () => `op-test-${process.pid}-${sequence++}`;

function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/plugin-materializer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'slp-runtime');
}
const mode = path => lstatSync(path).mode & 0o7777;
const conflict = async (promise, code) => {
  const error = await promise.then(() => null, error => error);
  assert.ok(error instanceof OperationConflict, `expected OperationConflict, got ${error}`);
  assert.equal(error.code, code, error.message);
  return error;
};

test('embedded payload recomputes the install-unit identity, bytes and modes', () => {
  const actual = identity(root);
  assert.equal(embeddedPayload.schemaVersion, 1);
  assert.equal(sha, actual.sha256);
  assert.equal(embeddedPayload.candidate.files.length, actual.files.length);
  assert.equal(embeddedPayload.files.length, actual.files.length);
  assert.match(embeddedPayload.payloadSha256, /^[0-9a-f]{64}$/);
  for (const file of embeddedPayload.files) {
    const bytes = readFileSync(join(root, file.path));
    assert.equal(file.sha256, hash(bytes), file.path);
    assert.deepEqual(Buffer.from(file.base64, 'base64'), bytes, file.path);
    assert.equal(file.mode, lstatSync(join(root, file.path)).mode & 0o777, file.path);
  }
});

test('generator --check byte-compares the committed payload module', () => {
  const out = execFileSync(process.execPath, ['scripts/generate-plugin-payload.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /runtime-payload\.ts is current/);
});

test('materialize publishes every byte/mode and passes production verifyInstall', async t => {
  const stable = fixture(t);
  const result = await materializer.materialize(stable, operation());
  assert.equal(result.reused, false);
  assert.equal(result.candidateSha256, sha);
  assert.equal(result.payloadSha256, embeddedPayload.payloadSha256);
  assert.equal(result.runtimePath, join(stable, sha));
  for (const file of embeddedPayload.files) {
    const target = join(result.runtimePath, file.path);
    assert.equal(hash(readFileSync(target)), file.sha256, file.path);
    assert.equal(mode(target), file.mode, file.path);
  }
  assert.equal(mode(join(result.runtimePath, 'installed.json')), 0o600);
  const receipt = JSON.parse(readFileSync(join(result.runtimePath, 'installed.json'), 'utf8'));
  assert.equal(receipt.source, `embedded:${sha}`);
  assert.equal(receipt.paseoBindingSha256, undefined);
  assert.equal(receipt.files.length, embeddedPayload.files.length);
  assert.ok(receipt.files.every(file => Number.isInteger(file.mode)));
  const verified = verifyInstall(result.runtimePath);
  assert.equal(verified.candidate.sha256, sha);
  assert.equal(existsSync(join(stable, '.staging')), true);
  assert.deepEqual(await materializer.materialize(stable, operation()), { ...result, reused: true });
});

test('executable modes survive a restrictive umask', async t => {
  const stable = fixture(t);
  const previous = process.umask(0o077);
  let result;
  try { result = await materializer.materialize(stable, operation()); }
  finally { process.umask(previous); }
  for (const file of embeddedPayload.files.filter(file => file.mode & 0o111)) {
    assert.equal(mode(join(result.runtimePath, file.path)), file.mode, file.path);
  }
  assert.ok(embeddedPayload.files.some(file => file.mode & 0o111), 'fixture needs an executable payload file');
});

test('an existing divergent destination is RUNTIME_INTEGRITY, never repaired or overwritten', async t => {
  for (const tamper of [
    async destination => writeFileSync(join(destination, 'plugin/server/runtime/cli/package.ts'), 'tampered'),
    async destination => rmSync(join(destination, 'install.sh')),
    async destination => writeFileSync(join(destination, 'extra.txt'), 'extra'),
    async destination => { rmSync(join(destination, 'package.json')); symlinkSync('/etc/hostname', join(destination, 'package.json')); },
    async destination => chmodSync(join(destination, 'install.sh'), 0o644),
    async destination => writeFileSync(join(destination, 'installed.json'), '{"source":"other","candidate":{}}\n'),
    async destination => mkdirSync(join(destination, 'stray-dir')),
  ]) {
    const stable = fixture(t);
    await materializer.materialize(stable, operation());
    const destination = join(stable, sha);
    await tamper(destination);
    const error = await conflict(materializer.materialize(stable, operation()), 'RUNTIME_INTEGRITY');
    assert.ok(error.message.length > 0);
    await conflict(materializer.verifyPublished(destination, sha, embeddedPayload.payloadSha256), 'RUNTIME_INTEGRITY');
  }
  // A sentinel in an intact destination survives every refusal path above.
  const stable = fixture(t);
  const destination = join(stable, sha);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'sentinel.log'), 'keep me');
  await conflict(materializer.materialize(stable, operation()), 'RUNTIME_INTEGRITY');
  assert.equal(readFileSync(join(destination, 'sentinel.log'), 'utf8'), 'keep me');
});

test('verifyPublished passes on an intact published candidate', async t => {
  const stable = fixture(t);
  const { runtimePath } = await materializer.materialize(stable, operation());
  await materializer.verifyPublished(runtimePath, sha, embeddedPayload.payloadSha256);
  await conflict(materializer.verifyPublished(join(stable, 'a'.repeat(64)), sha, embeddedPayload.payloadSha256), 'RUNTIME_INTEGRITY');
  // A well-formed but wrong recorded payload identity fails the pair check;
  // malformed shas are caller errors.
  await conflict(materializer.verifyPublished(runtimePath, sha, 'b'.repeat(64)), 'RUNTIME_INTEGRITY');
  await conflict(materializer.verifyPublished(runtimePath, 'not-a-sha', embeddedPayload.payloadSha256), 'INVALID_REQUEST');
  await conflict(materializer.verifyPublished(runtimePath, sha, 'also-bad'), 'INVALID_REQUEST');
});

test('corrupt embedded payloads are refused before any filesystem write', async t => {
  const clone = () => JSON.parse(JSON.stringify(embeddedPayload));
  const bad = [
    payload => { payload.files[0].path = '../escape'; },
    payload => { payload.files[0].path = '/absolute'; },
    payload => { payload.files[0].path = 'bin//double'; },
    payload => { payload.files[0].path = 'C:\\drive'; },
    payload => { payload.files[0].path = 'src/./dot'; },
    payload => { payload.files[0].path = payload.files[1].path; },
    payload => { payload.files.push({ ...payload.files[0], path: payload.files[0].path.toUpperCase() }); },
    payload => { payload.files[0].sha256 = '0'.repeat(64); },
    payload => { payload.files[0].base64 = Buffer.from('corrupt').toString('base64'); },
    payload => { payload.files[0].mode = 0o4755; },
    payload => { payload.files[0].mode = -1; },
    payload => { payload.candidate.sha256 = '0'.repeat(64); },
    payload => { payload.payloadSha256 = '0'.repeat(64); },
    payload => { payload.files.reverse(); },
    payload => { payload.schemaVersion = 2; },
  ];
  for (const tamper of bad) {
    const payload = clone();
    tamper(payload);
    const stable = fixture(t);
    let error = null;
    try { createMaterializer(payload); } catch (thrown) { error = thrown; }
    assert.ok(error instanceof OperationConflict, `expected OperationConflict, got ${error}`);
    assert.equal(error.code, 'RUNTIME_INTEGRITY', error.message);
    assert.equal(existsSync(stable), false, `payload tamper touched disk: ${error.message}`);
  }
});

test('staging collision and staging-root faults refuse before writing', async t => {
  const stable = fixture(t);
  mkdirSync(stable, { recursive: true });
  const op = operation();
  mkdirSync(join(stable, '.staging', op), { recursive: true });
  writeFileSync(join(stable, '.staging', op, 'marker'), 'other writer');
  await conflict(materializer.materialize(stable, op), 'COLLISION');
  assert.equal(readFileSync(join(stable, '.staging', op, 'marker'), 'utf8'), 'other writer');
  assert.equal(existsSync(join(stable, sha)), false);

  const blocked = fixture(t);
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(blocked, '.staging'), 'not a directory');
  await conflict(materializer.materialize(blocked, operation()), 'RUNTIME_INTEGRITY');
  assert.equal(existsSync(join(blocked, sha)), false);
});

test('concurrent publishers race to one verified destination', async t => {
  const stable = fixture(t);
  const [a, b] = await Promise.all([
    materializer.materialize(stable, operation()),
    materializer.materialize(stable, operation()),
  ]);
  assert.equal(a.runtimePath, b.runtimePath);
  assert.ok(a.reused || b.reused, 'at most one staged publish');
  verifyInstall(a.runtimePath);
  assert.deepEqual(readdirSync(join(stable, '.staging')), []);
});

test('discardStaging removes only this operation staging', async t => {
  const stable = fixture(t);
  mkdirSync(join(stable, '.staging', 'op-a'), { recursive: true });
  mkdirSync(join(stable, '.staging', 'op-b'), { recursive: true });
  writeFileSync(join(stable, '.staging', 'op-a', 'partial'), 'x');
  writeFileSync(join(stable, '.staging', 'op-b', 'partial'), 'y');
  const { runtimePath } = await materializer.materialize(stable, operation());
  await materializer.discardStaging(stable, 'op-a');
  assert.equal(existsSync(join(stable, '.staging', 'op-a')), false);
  assert.equal(existsSync(join(stable, '.staging', 'op-b', 'partial')), true);
  await materializer.discardStaging(stable, 'op-gone');
  assert.equal(verifyInstall(runtimePath).candidate.sha256, sha);
  await conflict(materializer.discardStaging(stable, '../escape'), 'INVALID_REQUEST');
  assert.equal(existsSync(join(stable, sha)), true);
});

test('discardStaging deletes nothing through a symlinked ancestor chain (X1)', async t => {
  // .staging is a symlink out of the store: a rejected materialize reports
  // RUNTIME_INTEGRITY and cleanup deletes nothing — the external tree and
  // the symlink itself survive.
  const stable = fixture(t);
  const external = fixture(t);
  mkdirSync(join(external, 'op-x'), { recursive: true });
  writeFileSync(join(external, 'op-x', 'victim.txt'), 'must survive');
  mkdirSync(stable, { recursive: true });
  symlinkSync(external, join(stable, '.staging'));
  await conflict(materializer.materialize(stable, operation()), 'RUNTIME_INTEGRITY');
  await conflict(materializer.discardStaging(stable, 'op-x'), 'RUNTIME_INTEGRITY');
  assert.equal(readFileSync(join(external, 'op-x', 'victim.txt'), 'utf8'), 'must survive');
  assert.equal(lstatSync(join(stable, '.staging')).isSymbolicLink(), true);

  // A symlinked <operationId> leaf inside a real .staging is refused the same
  // way: nothing deleted, evidence untouched.
  const stable2 = fixture(t);
  const external2 = fixture(t);
  mkdirSync(external2, { recursive: true });
  writeFileSync(join(external2, 'victim.txt'), 'must survive');
  mkdirSync(join(stable2, '.staging'), { recursive: true });
  symlinkSync(external2, join(stable2, '.staging', 'op-leaf'));
  await conflict(materializer.discardStaging(stable2, 'op-leaf'), 'RUNTIME_INTEGRITY');
  assert.equal(readFileSync(join(external2, 'victim.txt'), 'utf8'), 'must survive');
  assert.equal(lstatSync(join(stable2, '.staging', 'op-leaf')).isSymbolicLink(), true);
});

// F1/N1: a binding/retained candidate from an older plugin generation must
// stay verifiable — anchored on its own installed.json record, never the
// current embedded payload. A deliberately records install.sh at 0644 while
// the embedded payload B records 0755 for the same path.
const foreignPayload = () => {
  const files = ['bin/slp.mjs', 'install.sh', 'package.json', 'src/old-only.mjs'].map(path => {
    const bytes = Buffer.from(`foreign candidate ${path}\n`);
    const mode = path === 'bin/slp.mjs' ? 0o755 : 0o644;
    return { path, sha256: hash(bytes), mode, base64: bytes.toString('base64') };
  });
  const candidateFiles = files.map(({ path, sha256 }) => ({ path, sha256 }));
  return {
    schemaVersion: 1,
    candidate: { sha256: hash(json(candidateFiles)), files: candidateFiles },
    payloadSha256: hash(json(files.map(({ path, sha256, mode }) => ({ path, sha256, mode })))),
    files,
  };
};

test('foreign candidates verify by their own record, never the embedded payload', async t => {
  const payload = foreignPayload();
  const foreignSha = payload.candidate.sha256;
  const foreignPayloadSha = payload.payloadSha256;
  assert.notEqual(foreignSha, sha);
  const publish = async stable =>
    (await createMaterializer(payload).materialize(stable, operation())).runtimePath;

  // Pristine foreign A verifies clean under its recorded pair — including the
  // shared path whose recorded mode (0644) differs from the embedded
  // payload's (0755). Embedded-sha verification of the same dir refuses.
  const intact = await publish(fixture(t));
  assert.equal(mode(join(intact, 'install.sh')), 0o644);
  await materializer.verifyPublished(intact, foreignSha, foreignPayloadSha);
  await conflict(materializer.verifyPublished(intact, sha, embeddedPayload.payloadSha256), 'RUNTIME_INTEGRITY');
  // A well-formed but wrong recorded payloadSha256 breaks the anchor.
  await conflict(materializer.verifyPublished(intact, foreignSha, 'c'.repeat(64)), 'RUNTIME_INTEGRITY');

  // Every deviation from A's own record refuses: bytes, A's recorded modes on
  // shared and A-only paths, special bits, extra and missing entries.
  for (const tamper of [
    destination => chmodSync(join(destination, 'install.sh'), 0o755),
    destination => chmodSync(join(destination, 'src/old-only.mjs'), 0o755),
    destination => chmodSync(join(destination, 'src/old-only.mjs'), 0o2644),
    destination => writeFileSync(join(destination, 'src/old-only.mjs'), 'tampered'),
    destination => writeFileSync(join(destination, 'extra.txt'), 'x'),
    destination => rmSync(join(destination, 'package.json')),
  ]) {
    const destination = await publish(fixture(t));
    tamper(destination);
    await conflict(materializer.verifyPublished(destination, foreignSha, foreignPayloadSha), 'RUNTIME_INTEGRITY');
  }

  // Forged installed.json: wrong source, wrong recorded sha, candidate.files
  // no longer anchoring the sha, a mode record diverging from it, or a
  // deleted/malformed mode record — all fail closed against the recorded
  // payloadSha256 anchor.
  const receipt = destination => JSON.parse(readFileSync(join(destination, 'installed.json'), 'utf8'));
  const rewrite = (destination, edit) => {
    const r = receipt(destination);
    edit(r);
    writeFileSync(join(destination, 'installed.json'), json(r));
  };
  for (const forge of [
    destination => rewrite(destination, r => { r.source = `embedded:${'0'.repeat(64)}`; }),
    destination => rewrite(destination, r => { r.candidate.sha256 = '1'.repeat(64); }),
    destination => rewrite(destination, r => { r.candidate.files = r.candidate.files.slice(1); }),
    destination => rewrite(destination, r => { r.candidate.files[0].sha256 = '2'.repeat(64); }),
    destination => rewrite(destination, r => { r.files.find(f => f.path === 'install.sh').mode = 0o777; }),
    destination => rewrite(destination, r => { r.files = r.files.slice(1); }),
    destination => rewrite(destination, r => { delete r.files; }),
    destination => rewrite(destination, r => { r.files = 'not-an-array'; }),
    // Astra's R5 repro: chmod a file AND forge its recorded mode to match —
    // the recomputed record digest diverges from the recorded payloadSha256.
    destination => {
      chmodSync(join(destination, 'install.sh'), 0o755);
      rewrite(destination, r => { r.files.find(f => f.path === 'install.sh').mode = 0o755; });
    },
  ]) {
    const destination = await publish(fixture(t));
    forge(destination);
    await conflict(materializer.verifyPublished(destination, foreignSha, foreignPayloadSha), 'RUNTIME_INTEGRITY');
  }

  // Missing installed.json — a directory whose only evidence is its name.
  const bare = await publish(fixture(t));
  rmSync(join(bare, 'installed.json'));
  await conflict(materializer.verifyPublished(bare, foreignSha, foreignPayloadSha), 'RUNTIME_INTEGRITY');
  const empty = join(fixture(t), 'slp-runtime', 'f'.repeat(64));
  mkdirSync(empty, { recursive: true });
  await conflict(materializer.verifyPublished(empty, 'f'.repeat(64), 'f'.repeat(64)), 'RUNTIME_INTEGRITY');
});

test('publication: materializer claims the operation directory; launchers re-enter and replace only launch-set', async t => {
  const stable = fixture(t);
  const payload = foreignPayload();
  const publisher = createMaterializer(payload);
  const op = 'Op-shared_09.1';
  const staging = join(stable, '.staging', op);
  const other = join(stable, '.staging', 'op-other');
  mkdirSync(join(staging, 'launch-set'), { recursive: true });
  mkdirSync(other);
  writeFileSync(join(staging, 'marker'), 'operation evidence');
  writeFileSync(join(staging, 'launch-set', 'leftover'), 'unpublished launch set');
  writeFileSync(join(other, 'marker'), 'other operation');

  const collision = await conflict(publisher.materialize(stable, op), 'COLLISION');
  assert.equal(collision.path, staging);
  assert.equal(collision.message, 'staging directory already exists for this operation');
  assert.equal(readFileSync(join(staging, 'marker'), 'utf8'), 'operation evidence');
  assert.equal(readFileSync(join(staging, 'launch-set', 'leftover'), 'utf8'), 'unpublished launch set');
  assert.equal(existsSync(join(stable, payload.candidate.sha256)), false);

  // Materializer cleanup owns the complete operation subtree, and publication
  // consumes that same staging path by rename. Other operation evidence stays.
  await publisher.discardStaging(stable, op);
  assert.equal(existsSync(staging), false);
  const candidate = await publisher.materialize(stable, op);
  assert.equal(existsSync(staging), false);
  mkdirSync(join(staging, 'launch-set'), { recursive: true });
  writeFileSync(join(staging, 'marker'), 'operation evidence');
  writeFileSync(join(staging, 'launch-set', 'leftover'), 'unpublished launch set');

  const builder = createLauncherBuilder();
  const previous = process.umask(0o077);
  let set;
  try {
    set = await builder.publish({
      daemonHome: join(stable, '..'),
      stableRoot: stable,
      operationId: op,
      candidate: { sha256: candidate.candidateSha256, runtimePath: candidate.runtimePath },
      node: { path: process.execPath, version: process.versions.node },
      binaries: Object.fromEntries(['codex', 'pi', 'devin', 'claude', 'opencode'].map(family => [
        family, { available: false, path: null, version: null },
      ])),
    });
  } finally {
    process.umask(previous);
  }
  assert.equal(readFileSync(join(staging, 'marker'), 'utf8'), 'operation evidence');
  assert.equal(readFileSync(join(other, 'marker'), 'utf8'), 'other operation');
  assert.equal(existsSync(join(staging, 'launch-set')), false);
  assert.equal(existsSync(join(set.directory, 'leftover')), false);
  assert.equal(mode(join(set.directory, 'launch.json')), 0o644);
  assert.equal(set.files.length, 15);
  for (const file of set.files) assert.equal(mode(file.path), 0o755);
  assert.equal((await builder.verify(set.directory)).launchSetSha256, set.launchSetSha256);
  await publisher.verifyPublished(candidate.runtimePath, candidate.candidateSha256, candidate.payloadSha256);
});

test('publication: safe operation names share refusal rules while domain validation order and diagnostics stay distinct', async t => {
  const stable = fixture(t);
  const payload = foreignPayload();
  const publisher = createMaterializer(payload);
  const builder = createLauncherBuilder();
  const request = {
    daemonHome: join(stable, '..'),
    stableRoot: stable,
    candidate: { sha256: payload.candidate.sha256, runtimePath: join(stable, payload.candidate.sha256) },
    node: { path: process.execPath, version: process.versions.node },
    binaries: {},
  };
  for (const operationId of ['', '.', '..', '../escape', '/absolute', 'op/name', 'op\\name', 'a'.repeat(257)]) {
    const candidateError = await conflict(publisher.materialize(stable, operationId), 'INVALID_REQUEST');
    assert.equal(candidateError.message, `invalid operation id: ${JSON.stringify(operationId)}`);
    const launcherError = await conflict(builder.publish({ ...request, operationId }), 'INVALID_REQUEST');
    assert.equal(launcherError.message, 'operationId is not a safe staging name');
    assert.equal(existsSync(stable), false, 'invalid operation names must be refused before creating directories');
  }
  const earlier = await conflict(builder.publish({
    ...request,
    operationId: '../escape',
    candidate: { ...request.candidate, sha256: 'not-a-digest' },
  }), 'INVALID_REQUEST');
  assert.equal(earlier.message, 'candidate.sha256 is not a sha256 digest');
  assert.equal(existsSync(stable), false);
});

test('publication: private-directory creation failures retain domain wording and missing-chain behavior', async t => {
  const stable = fixture(t);
  writeFileSync(stable, 'blocking ancestor');
  const nested = join(stable, 'nested');
  const payload = foreignPayload();
  const publisher = createMaterializer(payload);
  const materializeError = await conflict(publisher.materialize(nested, 'op-mkdir'), 'IO_FAILURE');
  assert.equal(materializeError.path, nested);
  assert.match(materializeError.message, /^cannot create stable root: ENOTDIR:/);
  const launcherError = await conflict(createLauncherBuilder().publish({
    daemonHome: stable,
    stableRoot: nested,
    operationId: 'op-mkdir',
    candidate: { sha256: payload.candidate.sha256, runtimePath: join(nested, payload.candidate.sha256) },
    node: { path: process.execPath, version: process.versions.node },
    binaries: Object.fromEntries(['codex', 'pi', 'devin', 'claude', 'opencode'].map(family => [
      family, { available: false, path: null, version: null },
    ])),
  }), 'IO_FAILURE');
  assert.equal(launcherError.message, 'cannot create staging root');
  assert.equal(launcherError.path, join(nested, '.staging'));
  assert.equal(readFileSync(stable, 'utf8'), 'blocking ancestor');

  const absent = fixture(t);
  await publisher.discardStaging(absent, 'op-absent');
  assert.equal(existsSync(absent), false);
  const setPath = join(absent, 'launchers', 'a'.repeat(64));
  const missing = await conflict(createLauncherBuilder().verify(setPath), 'RUNTIME_INTEGRITY');
  assert.equal(missing.path, setPath);
  assert.equal(missing.message, `launch set path ${setPath} does not exist`);
  assert.equal(existsSync(absent), false);
});
