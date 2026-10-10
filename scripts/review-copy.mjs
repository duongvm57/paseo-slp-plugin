// Development harness: a writable copy measured against the caller's frozen
// candidate. The copy owns its Git data; ignored/external evidence stays out.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshot } from '../plugin/server/runtime/cli/package.ts';

const git = (cwd, args, input) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args],
  { input, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });

/** No source mutation, dependency installation, probe execution or acceptance.
 * An unsupported candidate fails before allocation. Failed allocations are
 * removed; a returned directory belongs to the caller until it settles it. */
export function prepareReviewCopy(repository, expectedSnapshot, parent = tmpdir()) {
  if (!/^[0-9a-f]{64}$/.test(expectedSnapshot)) throw new Error('An exact snapshot SHA-256 is required');
  const source = realpathSync(repository);
  parent = realpathSync(parent);
  if (parent === source || parent.startsWith(`${source}/`)) throw new Error('Review copies must be outside the source checkout');
  const before = snapshot(source);
  if (before.sha256 !== expectedSnapshot) throw new Error('Source candidate differs from the requested snapshot');
  if (!before.head || before.nested?.length || before.files.some(file => file.kind === 'gitlink')) {
    throw new Error('Review copy requires a committed root without nested repositories or gitlinks; materialize those separately');
  }
  const links = new Set(before.files.filter(file => file.kind === 'symlink').map(file => file.path));
  for (const file of before.files) {
    const segments = file.path.split('/');
    for (let end = 1; end < segments.length; end++) {
      if (links.has(segments.slice(0, end).join('/'))) {
        throw new Error('Review copy cannot materialize files below a symlink; materialize that scope separately');
      }
    }
  }
  const tracked = new Set(git(source, ['ls-files', '-z', '--cached']).toString().split('\0').filter(Boolean));
  const directory = mkdtempSync(join(parent, 'slp-review-'));
  const candidate = join(directory, 'candidate');
  try {
    // Local copies have no hardlinks. Dissociate also prevents borrowed Git
    // alternates from making later probe writes share the source object store.
    git(parent, ['clone', '--quiet', '--no-checkout', '--no-hardlinks', '--dissociate', '--', source, candidate]);
    git(candidate, ['read-tree', '--empty']);
    for (const file of before.files) {
      const from = join(source, file.path), to = join(candidate, file.path);
      const deleted = 'deleted' in file;
      if (!deleted) {
        mkdirSync(dirname(to), { recursive: true });
        if (file.kind === 'symlink') symlinkSync(readlinkSync(from), to);
        else { copyFileSync(from, to); chmodSync(to, file.mode); }
      }
      // Reproduce the tracked name set, including a tracked missing file.
      // Regular-file staging intent is outside the snapshot contract.
      if (tracked.has(file.path)) {
        const bytes = deleted ? Buffer.alloc(0) : file.kind === 'symlink'
          ? Buffer.from(readlinkSync(from)) : readFileSync(to);
        const oid = git(candidate, ['hash-object', '-w', '--stdin'], bytes).toString().trim();
        const mode = !deleted && file.kind === 'symlink' ? '120000'
          : !deleted && file.mode & 0o111 ? '100755' : '100644';
        git(candidate, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${file.path}`]);
      }
    }
    const copied = snapshot(candidate), after = snapshot(source);
    if (after.sha256 !== expectedSnapshot) throw new Error('Source drifted during materialization');
    if (copied.sha256 !== expectedSnapshot) throw new Error('Copy identity differs from the frozen source');
    const receipt = {
      version: 1, source, candidate, snapshotSha256: expectedSnapshot, head: before.head,
      acceptance: 'not-established-by-this-copy',
      limitations: [
        'Ignored dependencies, outputs, processes and external evidence are not copied.',
        'Regular-file staging intent is not mirrored; compare worktree bytes to HEAD.',
        'A copy is writable and is not a filesystem or process sandbox.',
        'The caller owns probe resources and removal of this directory after settlement.',
      ],
    };
    writeFileSync(join(directory, 'copy.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { directory, ...receipt };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [repository, pin, parent] = process.argv.slice(2);
  if (!repository || !pin || process.argv.length > 5) {
    process.stderr.write('Usage: node scripts/review-copy.mjs <repository> <snapshot-sha256> [scratch-parent]\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(prepareReviewCopy(repository, pin, parent), null, 2)}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
