#!/usr/bin/env node
// SLP managed-launch dispatcher (Option A v1, spec §6). Lives inside the
// immutable candidate payload at bin/slp-shim.mjs and is exec'd by the frozen
// POSIX launchers as:
//
//   slp-shim.mjs <launch-manifest-path> <manifest-sha256> <family> <role> -- <native-args...>
//
// The shim verifies the launch manifest digest and the candidate bytes before
// any action, then either answers the bare argv0 `--version` probe with the
// real family executable or enters the existing bin/{family}-role.mjs wrapper
// with the frozen manifest environment. Missing separator, invalid fixed
// fields, unavailable binaries and corrupt runtimes are hard failures — the
// shim never falls back to an unwrapped executable.
import { supportsNodeVersion, SUPPORTED_NODE_RANGE } from '../plugin/shared/runtime/node-version.mjs';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';

// Same list as the installed host's RUNTIME_CONTROL_ENV_KEYS
// (server/server/paseo-env.js): cleared before any family process runs.
const RUNTIME_CONTROL_ENV_KEYS = [
  'PASEO_NODE_ENV',
  'PASEO_DESKTOP_MANAGED',
  'PASEO_SUPERVISED',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ESBUILD_BINARY_PATH',
];
// NODE_OPTIONS is cleared as well: it would inject flags into the frozen
// helper Node commands rendered through SLP_NODE_BIN.
const STRIPPED_ENV_KEYS = [...RUNTIME_CONTROL_ENV_KEYS, 'NODE_OPTIONS'];
const FAMILIES = ['codex', 'pi', 'devin', 'claude', 'opencode'];
const ROLES = ['supervisor', 'lead', 'peer'];


const fail = message => {
  console.error(`slp-shim: ${message}`);
  process.exitCode = 1;
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function usage() {
  console.error(
    'usage: slp-shim.mjs <launch-manifest-path> <manifest-sha256> <family> <role> -- <native-args...>',
  );
  process.exitCode = 1;
}

function loadManifest(path, expectedSha256) {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('manifest-sha256 argument is not a sha256 digest');
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expectedSha256) throw new Error(`launch manifest digest mismatch: ${path}`);
  const manifest = JSON.parse(bytes.toString('utf8'));
  const bad = why => new Error(`launch manifest ${why}`);
  if (manifest?.schemaVersion !== 1) throw bad('schemaVersion is not 1');
  if (typeof manifest.daemonHome !== 'string' || !isAbsolute(manifest.daemonHome)) throw bad('daemonHome is not absolute');
  if (typeof manifest.candidate?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.candidate.sha256)) throw bad('candidate.sha256 is malformed');
  if (typeof manifest.candidate?.path !== 'string' || !isAbsolute(manifest.candidate.path)) throw bad('candidate.path is not absolute');
  if (typeof manifest.node?.path !== 'string' || !isAbsolute(manifest.node.path)) throw bad('node.path is not absolute');
  if (!Array.isArray(manifest.families) || manifest.families.length !== FAMILIES.length || !FAMILIES.every(f => manifest.families.includes(f))) throw bad('families is malformed');
  if (!Array.isArray(manifest.roles) || manifest.roles.length !== ROLES.length || !ROLES.every(r => manifest.roles.includes(r))) throw bad('roles is malformed');
  if (manifest.binaries === null || typeof manifest.binaries !== 'object') throw bad('binaries is missing');
  if (Object.keys(manifest.binaries).length !== FAMILIES.length || !FAMILIES.every(f => Object.hasOwn(manifest.binaries, f))) throw bad('binaries domain is malformed');
  return manifest;
}

// The candidate is verified twice: installed.json self-consistency through the
// existing verifier, then identity() against the digest frozen in the
// (already digest-verified) launch manifest.
async function verifyCandidate(manifest) {
  const root = manifest.candidate.path;
  const pkg = await import(pathToFileURL(join(root, 'plugin/server/runtime/cli/package.ts')).href);
  pkg.verifyInstall(root);
  const actual = pkg.identity(root).sha256;
  if (actual !== manifest.candidate.sha256) {
    throw new Error(`candidate integrity failure: expected ${manifest.candidate.sha256}, got ${actual}`);
  }
}

// Exactly `--version` (the argv0-only probe): run the real family executable
// with inherited stdio and forward its exit status. No role instructions, no
// banner, no Node version — and it must work with provider env entirely absent.
function runVersionProbe(binaryPath) {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  const child = spawn(binaryPath, ['--version'], { stdio: 'inherit', env });
  child.on('error', error => fail(`cannot exec ${binaryPath}: ${error.message}`));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
  });
}

// Provider protocol and admin invocations: freeze the manifest env, then load
// the existing family wrapper with process.argv = [node, wrapper, role, args].
// Its interception, passthrough, stdio, signal and exit-code behavior is
// unchanged. PASEO_AGENT_ID passes through as context only — it never selects
// a binding, and only OpenCode retains a session-open grant until its wrapper consumes
// and strips it; the other wrapper paths reset the sentinel.
async function enterWrapper(manifest, family, role, nativeArgs) {
  for (const key of STRIPPED_ENV_KEYS) delete process.env[key];
  if (family !== 'opencode') process.env.SLP_SESSION_OPEN_GRANT = '';
  if (family === 'opencode' && process.env.PASEO_AGENT_ID && !process.env.SLP_SESSION_OPEN_GRANT) {
    throw new Error('managed OpenCode session launched without live SLP hook grant');
  }
  process.env[`SLP_${family.toUpperCase()}_BIN`] = manifest.binaries[family].path;
  process.env.SLP_RUNTIME_ROOT = manifest.candidate.path;
  process.env.SLP_NODE_BIN = manifest.node.path;
  process.env.SLP_DAEMON_HOME = manifest.daemonHome;
  process.env.PASEO_HOME = manifest.daemonHome;
  process.env.SLP_MANAGED_RUNTIME = '1';
  const wrapperPath = join(manifest.candidate.path, 'bin', `${family}-role.mjs`);
  process.argv = [manifest.node.path, wrapperPath, role, ...nativeArgs];
  await import(pathToFileURL(wrapperPath).href);
}

async function main() {
  const argv = process.argv;
  if (argv.length < 7 || argv[6] !== '--') return usage();
  const [, , manifestPath, manifestSha256, family, role] = argv;
  const nativeArgs = argv.slice(7);
  if (!FAMILIES.includes(family)) return fail(`invalid family '${family}'`);
  if (!ROLES.includes(role)) return fail(`invalid role '${role}'`);
  // The shim itself must be running on ordinary supported Node, not Electron.
  if (process.versions.electron != null) return fail('requires ordinary Node.js, not an Electron runtime');
  if (!supportsNodeVersion(process.versions.node)) return fail(`requires Node.js ${SUPPORTED_NODE_RANGE}, running ${process.versions.node}`);

  const manifest = loadManifest(manifestPath, manifestSha256);
  const binary = manifest.binaries[family];
  if (binary?.available !== true || typeof binary.path !== 'string' || !isAbsolute(binary.path)) {
    return fail(`family '${family}' has no verified executable in this launch set (EXECUTABLE_UNAVAILABLE)`);
  }
  await verifyCandidate(manifest);

  if (nativeArgs.length === 1 && nativeArgs[0] === '--version') return runVersionProbe(binary.path);
  return enterWrapper(manifest, family, role, nativeArgs);
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
