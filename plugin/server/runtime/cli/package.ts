import type { CandidateIdentity, InstalledManifest, NestedSnapshot, Snapshot, SnapshotEntry } from './types.ts';
import type { RuntimeError } from './types.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync, mkdirSync, writeFileSync, copyFileSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

export const hash = (bytes: string | NodeJS.ArrayBufferView) => createHash('sha256').update(bytes).digest('hex');
export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
export function files(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Package symlink unsupported: ${path}`);
    if (stat.isDirectory()) return files(root, path);
    if (!stat.isFile()) throw new Error(`Package entry is not a regular file: ${path}`);
    return [path];
  });
}

// One install-unit selector owns both installed identity and embedded payload.
// Runtime subtrees are optional when verifying legacy receipts; the source
// dependency-graph gate separately requires every current imported module.
export function installUnitPaths(root: string) {
  const directory = (path: string, optional = false) => {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      let stat;
      try { stat = lstatSync(join(root, ancestor)); }
      catch (error) {
        if (optional && (error as RuntimeError).code === 'ENOENT') return [];
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        const error = new Error(`Package directory is a symlink or non-directory: ${ancestor}`);
        // Preserve verifyInstall's existing incomplete-directory diagnostic.
        if (!stat.isSymbolicLink()) (error as RuntimeError).code = 'ENOTDIR';
        throw error;
      }
    }
    return files(root, path);
  };
  const regular = (path: string) => {
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Package entry is a symlink or non-regular file: ${path}`);
    return path;
  };
  return [regular('package.json'), regular('install.sh'), ...directory('bin'),
    ...directory('skills', true), ...directory('src'),
    ...directory('plugin/server/runtime', true), ...directory('plugin/shared/runtime', true)].sort();
}

export function identity(root: string): CandidateIdentity {
  const entries = installUnitPaths(root).map(path => ({ path, sha256: hash(readFileSync(join(root, path))) }));
  return { sha256: hash(json(entries)), files: entries };
}
// A receipt lookup supplies diagnostic guidance only. It does not verify,
// activate, redirect to or write the recorded runtime. Missing/corrupt/stale
// guidance must not mask the original installed.json failure.
function missingRuntimeFallback(root: string) {
  return `No installed runtime at ${root} (missing installed.json receipt). `
    + `Run the CLI from the installed runtime instead: node <installed-root>/bin/slp.mjs <command> — `
    + `<installed-root> is the directory 'install <dir>' or plugin activation wrote (the managed role `
    + `instructions name it); verify it with 'verify <installed-root>'.`;
}
export function missingRuntimeMessage(root: string, home?: string) {
  const fallback = missingRuntimeFallback(root);
  try {
    if (home === undefined || !isAbsolute(home)) return fallback;
    const daemonHome = home;
    const receiptPath = join(daemonHome, 'slp-runtime/state/receipt.json');
    if (!lstatSync(receiptPath).isFile()) return fallback;
    const receipt = readJson(receiptPath) as { state?: unknown; binding?: { runtimePath?: unknown } } | null;
    if (receipt?.state !== 'ACTIVE' && receipt?.state !== 'ACTIVATING') return fallback;
    const runtimePath = receipt?.binding?.runtimePath;
    if (typeof runtimePath !== 'string' || !isAbsolute(runtimePath)) return fallback;
    const cliPath = join(runtimePath, 'bin/slp.mjs');
    if (!lstatSync(cliPath).isFile()) return fallback;
    // Quote the path as one literal shell argument, including spaces and '$'.
    const quotedCli = "'" + cliPath.replaceAll("'", "'\\''") + "'";
    return `No installed runtime at ${root} (missing installed.json receipt). `
      + `Recorded runtime CLI: node ${quotedCli} <command>. `
      + `Verify the recorded runtime with 'verify ${runtimePath}'.`;
  } catch { return fallback; }
}
export class MissingInstalledRuntimeError extends Error {
  root: string;
  constructor(root: string) { super(missingRuntimeFallback(root)); this.root = root; }
}
// Missing receipt, unreadable receipt and tampered package are three different
// failures: only the first means "not installed". Corrupt JSON or a vanished
// payload file must never collapse into the install hint.
export function verifyInstall(root: string): InstalledManifest {
  let expected;
  try { expected = (readJson(join(root, 'installed.json')) as InstalledManifest); }
  catch (error) {
    if ((error as RuntimeError).code === 'ENOENT' || (error as RuntimeError).code === 'ENOTDIR') throw new MissingInstalledRuntimeError(root);
    if (error instanceof SyntaxError) throw new Error(`installed.json at ${root} is not valid JSON: ${(error as RuntimeError).message}`);
    throw error;
  }
  let actual;
  try { actual = identity(root); }
  catch (error) {
    if ((error as RuntimeError).code === 'ENOENT' || (error as RuntimeError).code === 'ENOTDIR') throw new Error(`Installed runtime at ${root} is incomplete — a package file is missing: ${(error as RuntimeError).message}`);
    throw error;
  }
  if (json(actual) !== json(expected.candidate)) throw new Error('Installed candidate changed');
  if (expected.paseoBindingSha256) {
    if (!existsSync(join(root, 'paseo-binding.json'))) throw new Error(`Installed runtime at ${root} is incomplete — paseo-binding.json is missing`);
    if (hash(readFileSync(join(root, 'paseo-binding.json'))) !== expected.paseoBindingSha256) throw new Error('Installed Paseo binding changed');
  }
  return expected;
}
export function install(source: string, destination: string) {
  const candidate = identity(source);
  // Exclusive destination: parents may be created, but the destination itself
  // must not exist — no current binding, runtime configuration or session is touched.
  mkdirSync(resolve(destination, '..'), { recursive: true });
  mkdirSync(destination);
  try {
    for (const entry of candidate.files) {
      const target = join(destination, entry.path);
      mkdirSync(resolve(target, '..'), { recursive: true });
      copyFileSync(join(source, entry.path), target);
    }
    writeFileSync(join(destination, 'installed.json'), json({ source: realpathSync(source), candidate }), { flag: 'wx' });
    verifyInstall(destination);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { destination: realpathSync(destination), candidate };
}
// A staged sibling keeps a failed update from ever leaving a half-written
// installation; the caller writes its receipts (installed.json,
// paseo-binding.json) into staging before swapIn.
export function stageInstall(source: string, destination: string) {
  const staging = `${destination}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  const { candidate } = install(source, staging);
  return { staging, candidate };
}
export function swapIn(staging: string, destination: string) {
  const replaced = `${destination}.replaced-${process.pid}`;
  rmSync(replaced, { recursive: true, force: true });
  renameSync(destination, replaced);
  try { renameSync(staging, destination); }
  catch (error) { renameSync(replaced, destination); throw error; }
  return replaced;
}
// Same rule as uninstall: a swap would silently drop user-added files.
export function verifyReplaceable(destination: string, manifest: InstalledManifest) {
  const receipts = ['installed.json', ...(manifest.paseoBindingSha256 ? ['paseo-binding.json'] : [])];
  const expected = [...manifest.candidate.files.map(f => f.path), ...receipts].sort();
  if (json(files(destination).sort()) !== json(expected)) throw new Error('Extra files: preserve directory for manual review');
}
export function update(source: string, destination: string) {
  destination = resolve(destination);
  const manifest = verifyInstall(destination);
  if (manifest.paseoBindingSha256) throw new Error('Paseo-integrated installation; rerun install with --paseo-home');
  verifyReplaceable(destination, manifest);
  const { staging, candidate } = stageInstall(source, destination);
  try {
    const replaced = swapIn(staging, destination);
    rmSync(replaced, { recursive: true, force: true });
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  return { destination: realpathSync(destination), candidate, updated: true };
}
export function uninstall(destination: string) {
  const manifest = verifyInstall(destination);
  if (manifest.paseoBindingSha256) throw new Error('Use the CLI uninstall to detach Paseo configuration first');
  const expected = [...manifest.candidate.files.map(f => f.path), 'installed.json'].sort();
  if (json(files(destination).sort()) !== json(expected)) throw new Error('Extra files: preserve directory for manual review');
  rmSync(destination, { recursive: true });
}
// A gitlink (index mode 160000) snapshots as pointer + observed state, never
// by descending into the submodule's content. indexOid is the one place the
// snapshot reads staging intent: for a gitlink the index entry IS the identity
// object — there are no working-tree bytes that represent the pointer. Regular
// files still hash worktree bytes only. A conflicted index (stages 1–3)
// records indexOid:null rather than picking a stage. headOid is the
// submodule's own HEAD, resolved read-only; state is missing (no directory on
// disk), uninitialized (no resolvable HEAD), clean (HEAD resolves, empty
// porcelain), dirty (porcelain nonempty) or conflicted. Any non-clean state
// lists the path in top-level `incomplete` — that scope is not proven content.
function gitlinkEntry(root: string, path: string, link: { conflicted: boolean; indexOid: string | null }): Extract<SnapshotEntry, { kind: 'gitlink' }> {
  const entry: Omit<Extract<SnapshotEntry, { kind: 'gitlink' }>, 'state'> & { state: Extract<SnapshotEntry, { kind: 'gitlink' }>['state'] | null } = { path, kind: 'gitlink', indexOid: link.conflicted ? null : link.indexOid, headOid: null, state: null };
  const sub = join(root, path);
  let stat;
  try { stat = lstatSync(sub); }
  catch (error) { if ((error as RuntimeError).code !== 'ENOENT' && (error as RuntimeError).code !== 'ENOTDIR') throw error; }
  const gitSub = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', sub, ...args], { maxBuffer: 32 * 1024 * 1024 });
  // Only probe HEAD when the submodule has its own .git — without it git walks
  // up into the superproject and would resolve the wrong repository.
  if (stat?.isDirectory() && existsSync(join(sub, '.git'))) {
    try { entry.headOid = gitSub(['rev-parse', '--verify', '--quiet', 'HEAD']).toString().trim() || null; }
    catch { /* no resolvable HEAD — reported via state */ }
  }
  if (link.conflicted) entry.state = 'conflicted';
  else if (!stat?.isDirectory()) entry.state = 'missing';
  else if (!entry.headOid) entry.state = 'uninitialized';
  else entry.state = gitSub(['status', '--porcelain']).toString().trim() ? 'dirty' : 'clean';
  return entry as Extract<SnapshotEntry, { kind: 'gitlink' }>;
}

export function snapshot(root: string): Snapshot {
  root = realpathSync(root);
  const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
  if (git(['rev-parse', '--show-toplevel']).toString().trim() !== root) throw new Error('Snapshot requires repository root');
  const names = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean))].sort();
  // Index entries at mode 160000 are gitlinks; stage 0 carries the pointer OID,
  // stages 1–3 mean a conflicted merge state for that path.
  const gitlinks = new Map<string, { indexOid: string | null; conflicted: boolean }>();
  for (const line of git(['ls-files', '-z', '-s']).toString().split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [mode, oid, stage] = line.slice(0, tab).split(' ');
    if (mode !== '160000') continue;
    const link = gitlinks.get(line.slice(tab + 1)) ?? { indexOid: null, conflicted: false };
    if (stage === '0') link.indexOid = oid; else link.conflicted = true;
    gitlinks.set(line.slice(tab + 1), link);
  }
  const nested: NestedSnapshot[] = [];
  const entries = names.flatMap<SnapshotEntry>(name => {
    const link = gitlinks.get(name.replace(/\/+$/, ''));
    if (link) return [gitlinkEntry(root, name.replace(/\/+$/, ''), link)];
    try {
      const stat = lstatSync(join(root, name));
      if (stat.isDirectory()) {
        const path = name.replace(/\/+$/, '');
        if (existsSync(join(root, path, '.git'))) {
          const sub = snapshot(join(root, path));
          nested.push({ path, head: sub.head, sha256: sub.sha256, files: sub.files,
            ...(sub.nested ? { nested: sub.nested } : {}),
            ...(sub.incomplete ? { incomplete: sub.incomplete } : {}) });
          return [];
        }
        throw new Error(`Submodules/directories unsupported: ${name}`);
      }
      return [{ path: name, mode: stat.mode & 0o777, sha256: hash(stat.isSymbolicLink() ? readlinkSync(join(root, name)) : readFileSync(join(root, name))), kind: stat.isSymbolicLink() ? 'symlink' : 'file' }];
    } catch (error) {
      if ((error as RuntimeError).code === 'ENOENT') return [{ path: name, deleted: true }];
      throw error;
    }
  });
  let head = null;
  try { head = git(['rev-parse', '--verify', '--quiet', 'HEAD']).toString().trim(); }
  catch (error) { if ((error as RuntimeError).status !== 1) throw error; }
  const incomplete = entries.filter(entry => entry.kind === 'gitlink' && entry.state !== 'clean').map(entry => entry.path);
  const payload = { head, entries, ...(nested.length ? { nested } : {}), ...(incomplete.length ? { incomplete } : {}) };
  return { root, head, sha256: hash(json(payload)), files: entries,
    ...(nested.length ? { nested } : {}), ...(incomplete.length ? { incomplete } : {}) };
}
