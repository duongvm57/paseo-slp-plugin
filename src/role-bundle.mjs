import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { roles, orchestrates } from './profiles.mjs';
import { files, hash, readJson } from './package.mjs';
import { spawnKit } from './spawn-kit.mjs';
import { readWorkTrackerSetting, workTrackerBlock } from './work-tracker.mjs';

// A Role bundle is the exact policy bytes a role receives at session entry.
// This module owns the load-path contract that docs/reports/guide-coverage.md documents:
// which policy files reach which role, and in what order. Both transport
// adapters and the create_agent planner read it from here.

// orchestrates lives in profiles.mjs so spawn-kit.mjs can read it without a
// role-bundle -> spawn-kit -> role-bundle cycle; re-exported to keep the API.
export { orchestrates };

export function bundleParts(role) {
  if (!roles.includes(role)) throw new Error('Unknown role');
  return ['common.md', `roles/${role}.md`, ...(orchestrates(role) ? ['delegation.md'] : [])];
}

// POSIX single-quote escaping for one shell argument.
const shq = value => "'" + value.replaceAll("'", "'\\''") + "'";

// Managed launch (spec §10): the plugin dispatcher freezes the verified Node,
// the stable candidate root and the canonical daemon home in the provider env.
// Helper text must render those absolute paths verbatim — a missing or
// relative value means the launch env is broken, so fail rather than render
// commands that would resolve the wrong runtime or home.
function managedRuntime(env) {
  if (env.SLP_MANAGED_RUNTIME !== '1') return null;
  const need = name => {
    const value = env[name];
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`Managed runtime requires absolute ${name}`);
    return value;
  };
  return { node: need('SLP_NODE_BIN'), runtimeRoot: need('SLP_RUNTIME_ROOT'), daemonHome: need('SLP_DAEMON_HOME') };
}

// The plugin-managed communication language: a plain-text file at
// <daemon-home>/slp-runtime/state/communication-language written by the
// set-language RPC. Read at render time (every ACP prompt, otherwise entry).
// Ordinary entry omits an unset value; ACP explicitly clears stale history.
// Unmanaged launches never read a daemon language setting.
function communicationLanguage(env, explicitUnset = false) {
  if (env.SLP_MANAGED_RUNTIME !== '1') return '';
  const home = env.SLP_DAEMON_HOME;
  if (typeof home !== 'string' || !isAbsolute(home)) return '';
  let value;
  try {
    value = readFileSync(join(home, 'slp-runtime/state/communication-language'), 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    value = '';
  }
  if (!value) return explicitUnset
    ? "Communication language: not set — this replaces earlier runtime language settings; follow the current assignment, and direct replies to the Human mirror the Human's current language.\n"
    : '';
  return `Communication language: ${value} — all text you send to other seats uses it, including prompts and inline assignment fields in create_agent/send_agent_prompt requests, plus team artifacts (reports, assignments, briefs, handbacks, notebook entries); direct replies to the Human mirror the Human's current language; identifiers, paths and commands stay verbatim.\n`;
}

// The home-dependent helpers, each rendered with the explicit daemon home so
// no invocation silently resolves a default or foreign home. monitor takes the
// home inside its request JSON. install/upgrade/uninstall are standalone-
// install operations — never this managed runtime's lifecycle — but they are
// listed so an authorized use still names the home explicitly.
function managedHelpers(cli, home) {
  const q = shq(home);
  return `Managed runtime helpers (SLP_MANAGED_RUNTIME=1) — always this verified Node, stable runtime CLI and explicit daemon home:\n` +
    `  ${cli} routes <repository> --paseo-home ${q}\n` +
    `  ${cli} inventory --paseo-home ${q}\n` +
    `  ${cli} agents --paseo-home ${q}\n` +
    `  ${cli} notebook <repository> --paseo-home ${q}\n` +
    `  ${cli} monitor <request.json> — the request must carry "paseoHome": ${JSON.stringify(home)}\n` +
    `  ${cli} install <dir> --paseo-home ${q} — standalone installs only; the plugin owns this runtime's lifecycle\n` +
    `  upgrade/uninstall take no home flag — the target installation's paseo-binding.json must record ${q}; verify it before running them\n` +
    `  init/materialize/snapshot/prepare/prepare-handoff/verify are repo-scoped: they take explicit paths and never touch a daemon home.\n`;
}

// The declared locator set a role's carrier ships: required bundle parts plus
// that role's references. Supervisor/Lead keep the full reference set; Peer
// receives only work-tracking.md when managed session entry enables beads.
// On an installed root, references derive from candidate.files, so a selected
// receipt-declared file deleted from disk still reports missing. A source
// checkout falls back to a live scan. Nothing outside the install unit is
// declared. Entries sort by absolute path and carry no load-order hint.
// launch.mjs orientation() renders the same set. Only ENOENT/ENOTDIR on
// optional paths means absence; corrupt receipts, other read errors and
// symlinked policy paths remain integrity failures.
export function policyLocators(root, role, env = process.env) {
  const required = bundleParts(role).map(part => `src/${part}`);
  let receipt = null;
  try { receipt = readJson(join(root, 'installed.json')); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  let references;
  if (receipt !== null) {
    if (!Array.isArray(receipt.candidate?.files)) throw new Error(`installed.json at ${root} lacks a candidate file list`);
    references = receipt.candidate.files.map(entry => entry.path).filter(path => path.startsWith('src/references/'));
  } else {
    references = [];
    try { references = files(root, 'src/references'); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  if (role === 'peer') {
    const daemonHome = env?.SLP_MANAGED_RUNTIME === '1' ? env.SLP_DAEMON_HOME : null;
    const trackerEnabled = typeof daemonHome === 'string' && isAbsolute(daemonHome)
      ? readWorkTrackerSetting(daemonHome).enabled
      : false;
    references = trackerEnabled ? references.filter(path => path === 'src/references/work-tracking.md') : [];
  }
  return [...required, ...references].map(path => {
    const absolute = join(root, path);
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) return { path: absolute, missing: true };
    if (stat.isSymbolicLink()) throw new Error(`Policy locator path is a symlink: ${absolute}`);
    const bytes = readFileSync(absolute);
    return { path: absolute, bytes: bytes.length, sha256: hash(bytes) };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The carrier is the self-contained block that actually reaches the spawned
// seat. prepare appends it to create.initialPrompt (the only field
// create_agent transmits); role-bundle appends it to session-entry
// instructions so seats launched through a provider profile receive the same
// payload. Same text both ways — absolute policy locators (missing markers
// included) and the approximate kit signatures, no file contents inlined. The
// caption names when the locator values were measured: plan-time wording for
// the prepare path, load-time wording for session entry.
export function carrierBlock(kit, locators, caption) {
  const lines = locators.map(entry => entry.missing
    ? `- ${entry.path} — declared but missing on disk`
    : `- ${entry.path} — ${entry.bytes} bytes, sha256 ${entry.sha256}`);
  return `\nSpawn kit — role-scoped Paseo MCP signatures (${kit.note}):\n`
    + kit.tools.map(tool => `- ${tool}`).join('\n')
    + `\nPolicy locators — ${caption}:\n`
    + lines.join('\n') + '\n';
}

// Session-entry locators are measured when the bundle renders, not at plan
// time, so the caption must not borrow the prepare path's wording.
const sessionLocatorCaption = 'absolute paths; size/sha256 were measured when these role instructions loaded; verify the file found is the one measured';

// Freeze policy from the verified candidate; only managed language state is live.
// Entry and re-anchor share the same core, never independently summarized rules.
export function roleDelivery(root, role, env = process.env, options = {}) {
  env = { ...env };
  const parts = bundleParts(role);
  const read = path => readFileSync(join(root, 'src', path), 'utf8');
  const managed = managedRuntime(env);
  // Managed sessions render the verified absolute Node and the stable runtime
  // CLI; unmanaged sessions keep the historical `node <bin/slp.mjs>` form.
  const cli = managed
    ? `${shq(managed.node)} ${shq(join(managed.runtimeRoot, 'bin/slp.mjs'))}`
    : `node ${shq(join(root, 'bin/slp.mjs'))}`;
  // Policy text may name only the managed runtime root — never this checkout's
  // path — so the skill/policy locators derive from policyRoot, not root.
  const policyRoot = managed ? managed.runtimeRoot : root;
  const policyDir = join(policyRoot, 'src');
  const core = `SLP role=${role}\n` + parts.map(path => read(path) + '\n').join('');
  const recoveryCli = managed
    ? `env SLP_MANAGED_RUNTIME=1 SLP_NODE_BIN=${shq(managed.node)} SLP_RUNTIME_ROOT=${shq(managed.runtimeRoot)} SLP_DAEMON_HOME=${shq(managed.daemonHome)} ${cli}`
    : cli;
  const recovery = `Installed policy directory: ${policyDir}\nPolicy recovery command: ${recoveryCli} instructions ${role}\n`;
  const assignment = `Use the current authorized Human or delegated assignment and its Paseo workspace. Notifications and heartbeat prompts do not replace that assignment.\n`;
  const entryPrefix = core +
    (orchestrates(role) ? `For repo setup/update, use ${join(policyRoot, 'skills/paseo-slp-onboarding/SKILL.md')}.\n` : '') +
    recovery + `Snapshot command: ${cli} snapshot <repository>\n` +
    (managed ? managedHelpers(cli, managed.daemonHome) : '');
  // Compute the measured carrier once, alongside the immutable core. launch.mjs
  // opts out when it owns the carrier so the initial prompt never duplicates it.
  const carrier = options.carrier === false ? '' : carrierBlock(spawnKit(role), policyLocators(policyRoot, role, env), sessionLocatorCaption);
  return {
    role, parts, orchestrates: orchestrates(role),
    // The work-tracker pointer is an entry-time helper like managedHelpers:
    // managed sessions only, after the language line, before the assignment.
    // Disabled/absent settings emit nothing — the render stays byte-identical
    // to the pre-feature one. anchor() never carries it.
    entry: ({ explicitLanguageState = false } = {}) => entryPrefix + communicationLanguage(env, explicitLanguageState)
      + (managed ? workTrackerBlock(managed.daemonHome, { cli, policyDir, shq }) : '') + assignment + carrier,
    anchor: () => core + recovery + communicationLanguage(env, true) + assignment,
  };
}

export function roleBundle(root, role, env = process.env, options) {
  const delivery = roleDelivery(root, role, env, options);
  return { role: delivery.role, parts: delivery.parts, orchestrates: delivery.orchestrates, instructions: delivery.entry() };
}

export const roleInstructions = (root, role, env = process.env, options) => roleBundle(root, role, env, options).instructions;
