// Plugin load-path verification, run inside the container against the
// manifest-built plugin copy:
//   1. import the real server entry (index.server.ts) and drive contribute()
//      with a minimal server stub — the same contract the host daemon uses;
//   2. drive the real materializer with the embedded payload: publish the
//      immutable runtime unit to <PASEO_HOME>/slp-runtime/<candidate-sha256>,
//      verifyPublished, and run the published runtime's own CLI checks.
// PASEO_HOME must point at the fake home (config.json present) so the
// supervision observer resolves exactly like production.
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let checks = 0;
const fail = message => { console.error(`PLUGIN_LOAD_FAIL ${message}`); process.exit(1); };
const ok = name => { checks += 1; console.log(`PLUGIN_LOAD_OK ${name}`); };
const eq = (actual, expected, name) =>
  JSON.stringify(actual) === JSON.stringify(expected) ? ok(name)
    : fail(`${name}: actual ${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`);

const pluginDir = process.argv[2] ?? fail('usage: plugin-load.mjs <plugin-dir>');
const home = process.env.PASEO_HOME ?? fail('PASEO_HOME not set');
const sourceRoot = process.env.SLP_SRC ?? fail('SLP_SRC not set');
const importPlugin = rel => import(pathToFileURL(join(pluginDir, rel)).href);

// --- (1) contribute() registration surface -------------------------------
const { default: contribute } = await importPlugin('index.server.ts');
eq(typeof contribute, 'function', 'index.server.ts default export is the contribution function');

const registrations = [], beforeHooks = [], onHooks = [], unregistered = [];
const server = {
  handle: (contract, handler) => registrations.push({ name: contract.name, handler }),
  before: (name, handler) => { beforeHooks.push(name); return () => unregistered.push(name); },
  on: (name, handler) => { onHooks.push(name); return () => unregistered.push(name); },
};
const cleanup = contribute(server);
eq(typeof cleanup, 'function', 'contribute() returns a cleanup function');
eq(registrations.map(r => r.name).sort(), [
  'activate', 'catalog', 'deactivate', 'disable-supervision-notifications',
  'enforcement-recover-lock', 'enforcement-runtime-pin', 'enforcement-status',
  'get-jev', 'get-peer-pool', 'get-role-routing', 'get-supervision',
  'get-supervision-status', 'get-workspace-workflow', 'local-target', 'reconcile',
  'set-jev', 'set-jev-key', 'set-language', 'set-peer-pool', 'set-role-routing',
  'set-supervision', 'status', 'test-jev',
], 'full RPC surface registered');
if (registrations.some(r => typeof r.handler !== 'function')) fail('a registered RPC handler is not a function');
ok('every RPC handler is callable');
eq(beforeHooks.sort(), ['agent.create', 'agent.create', 'agent.session_open', 'agent.session_open'],
  'role-injection + desk-bridge before-hook pairs registered in order');
// PASEO_HOME is exported and config.json exists → the shadow observer is
// verified → observer lifecycle hooks land on top of the desk handshake pair.
eq(onHooks.sort(), [
  'agent.archived', 'agent.archived', 'agent.created', 'agent.created',
  'agent.turn_ended', 'agent.turn_started',
], 'observer + desk handshake lifecycle hooks registered');
if (beforeHooks.length + onHooks.length === 0) fail('no hooks registered');
ok('hook surface non-empty');
cleanup();
eq(unregistered.sort(), [...beforeHooks, ...onHooks].sort(), 'cleanup unregisters every hook');
// A second cleanup may re-invoke unregister callbacks; the host-level fns are
// idempotent, so the only contract is that nothing outside the hook set unregisters.
cleanup();
const hookNames = new Set([...beforeHooks, ...onHooks]);
if (unregistered.some(name => !hookNames.has(name))) fail('cleanup unregistered an unknown hook');
ok('cleanup never unregisters foreign hooks');

// --- (2) embedded payload → materialize → verify → run ---------------------
const { createMaterializer } = await importPlugin('server/materializer.ts');
const { embeddedPayload } = await importPlugin('server/generated/runtime-payload.ts');
const materializer = createMaterializer(embeddedPayload); // validates payload in memory

const stableRoot = join(home, 'slp-runtime');
const published = await materializer.materialize(stableRoot, 'container-acceptance');
eq(published.reused, false, 'materialize published a fresh candidate');
eq(basename(published.runtimePath), published.candidateSha256, 'runtime path names the candidate sha');
await materializer.verifyPublished(published.runtimePath, published.candidateSha256, published.payloadSha256);
ok('verifyPublished accepts the published tree');

// The embedded payload must carry exactly the mounted checkout's install-unit
// identity — this pins the generated module to the source it was built from.
const sourceIdentity = JSON.parse(execFileSync(process.execPath, [join(sourceRoot, 'bin/slp.mjs'), 'identity'], { encoding: 'utf8' }));
eq(published.candidateSha256, sourceIdentity.sha256, 'embedded payload candidate == checkout identity');

// Run the PUBLISHED runtime (production storage layout) — its own CLI proves
// the artifact loads, not just that bytes exist.
const publishedIdentity = JSON.parse(execFileSync(process.execPath, [join(published.runtimePath, 'bin/slp.mjs'), 'identity'], { encoding: 'utf8' }));
eq(publishedIdentity.sha256, published.candidateSha256, 'published runtime recomputes its own identity');
const instructions = execFileSync(process.execPath, [join(published.runtimePath, 'bin/slp.mjs'), 'instructions', 'peer'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
if (!instructions.includes('SLP role=peer')) fail('published runtime produced no peer role instructions');
ok('published runtime renders role instructions');

console.log(`PLUGIN_LOAD_PASSED ${checks}`);
process.exit(0); // desk bridge/observer may hold handles; work is complete
