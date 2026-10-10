import type { Snapshot, SnapshotEntry } from './types.ts';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hash, snapshot } from './package.ts';

// Facts-only review packet: candidate identity, the change set against a git
// base, an optional delta against an earlier candidate, and optional evidence
// file pins. Read-only, offline and deterministic — no verdict, no writer
// identity, no finding. The Lead decides what the brief says; this only
// measures what a Reviewer would otherwise rediscover by hand.
const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@^~{}-]*$/u;

export const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// Where a write to `path` would really land: walk the path component by
// component with lstat, following every symlink (a dangling one included, by
// its readlink target) and treating `..` after the walk, so no component can
// hide a route into the repository. Components that do not exist yet are
// appended as written. Fails closed on a symlink loop. A check is still only a
// check: the path can change between this call and the write (TOCTOU).
export function realTarget(path: string): string {
  const pending = resolve(path).split(sep).filter(Boolean).reverse();
  let current: string = sep;
  let links = 0;
  while (pending.length) {
    const part = pending.pop()!;
    if (part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const next = join(current, part);
    let stat;
    try { stat = lstatSync(next); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      current = next;
      continue;
    }
    if (!stat.isSymbolicLink()) { current = next; continue; }
    if (++links > 40) throw new Error(`Too many symbolic links while resolving ${path}`);
    const target = readlinkSync(next);
    if (isAbsolute(target)) current = sep;
    pending.push(...target.split(sep).filter(Boolean).reverse());
  }
  return current;
}

// Every path a command reads or writes must be unable to block: inputs are
// regular files (or the directories that are explicitly allowed), and --out is
// either absent or an existing regular file. Anything else fails closed before
// it is opened.
export function assertRegularFile(path: string, what: string) {
  let stat;
  try { stat = statSync(path); } catch { throw new Error(`${what} missing or unreadable: ${path}`); }
  if (!stat.isFile()) throw new Error(`${what} must be a regular file: ${path}`);
}

export function assertOutsideRepository(repository: string, out: string, flag: string) {
  const target = realTarget(out);
  if (isInside(realpathSync(repository), target)) throw new Error(`${flag} must be outside the repository — a file written inside it would change the candidate`);
  let stat;
  try { stat = lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`${flag} must be a new path or an existing regular file: ${out}`);
}

// snapshot() reads every listed file, which would block on a fifo or device
// inside the measured tree; refuse such a tree before measuring it.
export function assertMeasurable(root: string) {
  const names = execFileSync('git', ['--no-optional-locks', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
  for (const name of names) {
    let stat;
    try { stat = lstatSync(join(root, name)); } catch { continue; }
    if (!stat.isFile() && !stat.isSymbolicLink() && !stat.isDirectory()) throw new Error(`candidate contains a special file that cannot be read safely: ${name}`);
  }
}

const gitOut = (root: string, args: string[]) =>
  execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', '-C', root, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

type ChangeStatus = 'added' | 'modified' | 'deleted' | 'untracked';
interface Change { path: string; status: ChangeStatus; insertions: number | null; deletions: number | null }

const STATUS: Record<string, ChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' };

function changes(root: string, base: string): Change[] {
  const byPath = new Map<string, Change>();
  const tokens = (buffer: Buffer) => buffer.toString().split('\0').filter(Boolean);
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none'];
  const names = tokens(gitOut(root, [...diffArgs, '--name-status', '-z', base, '--']));
  for (let i = 0; i + 1 < names.length; i += 2) {
    const status = STATUS[names[i]![0]!];
    if (!status) throw new Error(`Unsupported git change status ${names[i]} for ${names[i + 1]}`);
    byPath.set(names[i + 1]!, { path: names[i + 1]!, status, insertions: null, deletions: null });
  }
  // --numstat -z (no rename): "<ins>\t<del>\t<path>\0"; binary counts are "-".
  for (const record of tokens(gitOut(root, [...diffArgs, '--numstat', '-z', base, '--']))) {
    const [ins, del, ...pathParts] = record.split('\t');
    const entry = byPath.get(pathParts.join('\t'));
    if (!entry) continue;
    entry.insertions = ins === '-' ? null : Number(ins);
    entry.deletions = del === '-' ? null : Number(del);
  }
  for (const path of tokens(gitOut(root, ['ls-files', '-z', '--others', '--exclude-standard']))) {
    if (byPath.has(path)) continue;
    let insertions: number | null = null;
    try {
      const bytes = readFileSync(join(root, path));
      if (!bytes.includes(0)) insertions = bytes.length === 0 ? 0 : bytes.toString().split('\n').length - (bytes.at(-1) === 10 ? 1 : 0);
    } catch { /* directories (nested repos) and unreadable files keep null counts */ }
    byPath.set(path, { path, status: 'untracked', insertions, deletions: insertions === null ? null : 0 });
  }
  return [...byPath.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

const fingerprint = (entry: SnapshotEntry) => 'deleted' in entry ? 'deleted' : entry.kind === 'gitlink' ? `gitlink:${entry.indexOid}:${entry.headOid}:${entry.state}` : `${entry.kind}:${entry.mode}:${entry.sha256}`;

function delta(current: Snapshot, previous: { sha256: string; files: SnapshotEntry[] }) {
  const before = new Map(previous.files.map(entry => [entry.path, fingerprint(entry)]));
  const after = new Map(current.files.map(entry => [entry.path, fingerprint(entry)]));
  const added = [...after.keys()].filter(path => !before.has(path)).sort();
  const removed = [...before.keys()].filter(path => !after.has(path)).sort();
  const modified = [...after.keys()].filter(path => before.has(path) && before.get(path) !== after.get(path)).sort();
  return { identical: current.sha256 === previous.sha256, added, removed, modified };
}

// `--since` is either an earlier candidate copy (a git work tree, measured with
// snapshot()) or a saved `slp.mjs snapshot` JSON file. Nested sub-repository
// snapshots are not compared: they are reported by head/sha256 pair only.
function previousSnapshot(since: string): { sha256: string; files: SnapshotEntry[]; source: string } {
  const path = resolve(since);
  let stat;
  try { stat = statSync(path); } catch { throw new Error(`--since not found: ${since}`); }
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`--since must be a directory or a regular file: ${since}`);
  if (stat.isDirectory()) {
    assertMeasurable(realpathSync(path));
    const copy = snapshot(path);
    return { sha256: copy.sha256, files: copy.files, source: 'repository' };
  }
  let parsed: { sha256?: unknown; files?: unknown };
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`--since is not a snapshot JSON file: ${since}`); }
  if (typeof parsed.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(parsed.sha256) || !Array.isArray(parsed.files)) throw new Error(`--since is not a snapshot JSON file: ${since}`);
  return { sha256: parsed.sha256, files: parsed.files as SnapshotEntry[], source: 'snapshot-file' };
}

function evidenceFacts(paths: string[]) {
  return paths.map(entry => {
    if (!isAbsolute(entry)) throw new Error(`--evidence requires an absolute path: ${entry}`);
    assertRegularFile(entry, 'evidence file');
    let bytes: Buffer;
    try { bytes = readFileSync(entry); } catch { throw new Error(`evidence file missing or unreadable: ${entry}`); }
    return { path: resolve(entry), sha256: hash(bytes), bytes: bytes.length };
  });
}

export interface ReviewPacketOptions { base: string; since?: string; evidence?: string[]; out?: string }

export function reviewPacket(repository: string, options: ReviewPacketOptions) {
  if (typeof repository !== 'string' || !isAbsolute(repository)) throw new Error('Absolute repository path required');
  if (!options.base) throw new Error('review-packet requires --base <git-ref>');
  if (!GIT_REF_PATTERN.test(options.base)) throw new Error(`--base is not a plain git ref: ${options.base}`);
  if (options.out) assertOutsideRepository(repository, options.out, '--out');
  // Evidence and --since fail before the (slower) candidate measurement.
  const evidence = options.evidence?.length ? evidenceFacts(options.evidence) : undefined;
  const previous = options.since ? previousSnapshot(options.since) : undefined;
  const root = realpathSync(repository);
  assertMeasurable(root);
  const current = snapshot(root);
  let resolved: string;
  try { resolved = gitOut(root, ['rev-parse', '--verify', '--quiet', `${options.base}^{commit}`]).toString().trim(); }
  catch { throw new Error(`--base is not a git commit in this repository: ${options.base}`); }
  const changed = changes(root, resolved);
  const sum = (key: 'insertions' | 'deletions') => changed.reduce((total, change) => total + (change[key] ?? 0), 0);
  return {
    kind: 'slp-review-packet',
    version: 1,
    repository: root,
    candidate: { head: current.head, snapshotSha256: current.sha256, files: current.files.length, ...(current.incomplete ? { incomplete: current.incomplete } : {}) },
    base: { ref: options.base, commit: resolved },
    changed,
    diffStat: { files: changed.length, insertions: sum('insertions'), deletions: sum('deletions') },
    ...(previous ? { since: { source: previous.source, snapshotSha256: previous.sha256, ...delta(current, previous) } } : {}),
    ...(evidence ? { evidence } : {}),
  };
}
