#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { identity, install, uninstall, update, verifyInstall, snapshot, readJson, json } from '../src/package.mjs';
import { launchPlan, handoffPlan, launchCheck, requestSchema } from '../src/launch.mjs';
import { roleBundle } from '../src/role-bundle.mjs';
import { readCatalog } from '../src/routing.mjs';
import { routeDecide, routeDecideSchema } from '../src/jev-routing.mjs';
import { jevRoutingState } from '../src/jev.mjs';
import { resolveHome } from '../src/managed-home.mjs';
import { installPaseo, uninstallPaseo, upgradePaseo, initWorkspace, materializeWorkspace, installHome } from '../src/paseo-install.mjs';
import { inventory } from '../src/inventory.mjs';
import { agents } from '../src/agents.mjs';
import { monitor } from '../src/monitor.mjs';
import { notebook } from '../src/notebook.mjs';
import { localTarget, runtimeStatus } from '../src/runtime-state.mjs';
import { probeWorkTracker } from '../src/work-tracker.mjs';
import { extractRecords, recordSchema, requireRecordKind, RECORD_KINDS } from '../src/report-records.mjs';

// One entry per command: the flags it accepts, the required positional target
// (--schema stands in for it where offered), whether it takes an optional
// destination checked by the command itself, and its usage fragment. Order is
// the usage order.
const commands = {
  identity: { usage: 'identity' },
  snapshot: { target: 'repository', usage: 'snapshot <repo>' },
  install: { flags: ['--paseo-home', '--apply', '--reload'], optionalTarget: true, usage: 'install [absolute-dir] [--paseo-home <absolute-home>] [--apply] [--reload]' },
  upgrade: { flags: ['--from', '--apply', '--reload'], optionalTarget: true, usage: 'upgrade <absolute-new-dir> --from <previous-installation> [--apply] [--reload]' },
  verify: { target: 'dir', usage: 'verify <dir>' },
  uninstall: { flags: ['--apply', '--reload'], optionalTarget: true, usage: 'uninstall <dir> [--apply] [--reload]' },
  init: { flags: ['--routing-from', '--apply'], target: 'repository', usage: 'init <absolute-repo> [--routing-from <absolute-json>] [--apply]' },
  routes: { flags: ['--paseo-home', '--out'], target: 'repository', usage: 'routes <absolute-repo> [--paseo-home <absolute-home>] [--out <path>]' },
  inventory: { flags: ['--paseo-home'], usage: 'inventory [--paseo-home <absolute-home>]' },
  agents: { flags: ['--paseo-home'], usage: 'agents [--paseo-home <absolute-home>]' },
  prepare: { flags: ['--check', '--emit', '--schema', '--out'], target: 'request.json', usage: 'prepare <request.json> [--check | --emit create | --schema] [--out <path>]' },
  'prepare-handoff': { flags: ['--check', '--emit', '--schema', '--out'], target: 'request.json', usage: 'prepare-handoff <request.json> [--check | --emit create | --schema] [--out <path>]' },
  materialize: { flags: ['--from', '--apply', '--include', '--paseo-home'], target: 'repository', usage: 'materialize <repository> --from <source-repository> [--include <repo-path>]... [--paseo-home <absolute-home>] [--apply]' },
  monitor: { flags: [], target: 'request.json', usage: 'monitor <request.json>' },
  'route-decide': { flags: ['--paseo-home', '--schema', '--out'], target: 'request.json', usage: 'route-decide <request.json> [--schema] [--out <path>] [--paseo-home <absolute-home>]' },
  notebook: { flags: ['--paseo-home'], target: 'repository', usage: 'notebook <repository> [--paseo-home <absolute-home>]' },
  records: { flags: ['--kind', '--require', '--repo', '--schema'], target: 'path|-', usage: 'records <path|-> [--kind handback|settlement] [--require handback|settlement] [--repo <absolute-path>] [--schema]' },
  instructions: { target: 'role', usage: 'instructions <role>' },
  status: { flags: ['--paseo-home'], usage: 'status [--paseo-home <absolute-home>]' },
  'local-target': { flags: ['--paseo-home'], usage: 'local-target [--paseo-home <absolute-home>]' },
  tracker: { flags: ['--paseo-home'], target: 'repository', usage: 'tracker <repository> [--paseo-home <absolute-home>]' },
};
const usage = `Usage: slp.mjs ${Object.values(commands).map(entry => entry.usage).join(' | ')}`;

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const [command, ...rest] = argv;
let [target, ...args] = rest[0]?.startsWith('--') ? [undefined, ...rest] : rest;
try {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--include') {
      // Repeatable: each use appends one repository-relative path to stage.
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) throw new Error('--include requires a repository-relative path');
      (options[key] ??= []).push(value);
      continue;
    }
    if (Object.hasOwn(options, key)) throw new Error(`Repeated option ${key}`);
    if (key === '--apply' || key === '--reload' || key === '--check' || key === '--schema') options[key] = true;
    else if (key === '--emit') {
      if (args[i + 1] !== 'create') throw new Error('--emit requires create');
      options[key] = args[++i];
    } else if (key === '--out') {
      const value = args[++i];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error('--out requires a path');
      options[key] = value;
    } else if (key === '--from' || key === '--routing-from') {
      if (!args[i + 1] || !isAbsolute(args[i + 1])) throw new Error(`Absolute path required for ${key}`);
      options[key] = args[++i];
    } else if (key === '--paseo-home') {
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        if (!isAbsolute(args[i + 1])) throw new Error(`Absolute path required for ${key}`);
        options[key] = args[++i];
      } else options[key] = resolveHome(); // bare flag: managed mode resolves SLP_DAEMON_HOME/PASEO_HOME or fails, never ~/.paseo
    } else if (key === '--kind' || key === '--require' || key === '--repo') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${key} requires a value`);
      if ((key === '--kind' || key === '--require') && !RECORD_KINDS.includes(value)) throw new Error(`${key} must be ${RECORD_KINDS.join(' or ')}`);
      if (key === '--repo' && !isAbsolute(value)) throw new Error('Absolute path required for --repo');
      options[key] = value;
    } else if (!key.startsWith('-')) {
      // Positional target may come after flags (e.g. prepare --check req.json).
      if (target !== undefined) throw new Error(`Unexpected argument ${key}`);
      target = key;
    } else throw new Error(`Unknown flag ${key}`);
  }
  const spec = Object.hasOwn(commands, command) ? commands[command] : undefined;
  for (const key of Object.keys(options)) if (!spec?.flags?.includes(key)) throw new Error(`${key} is not valid for ${command}`);
  const prepareModes = ['--check', '--emit', '--schema'].filter(key => options[key]);
  if (prepareModes.length > 1) throw new Error(`${prepareModes.join(' and ')} are separate modes — pick one`);
  if (command === 'upgrade' && !options['--from']) throw new Error('upgrade requires --from <previous-installation>');
  if (command === 'materialize' && !options['--from']) throw new Error('materialize requires --from <source-repository>');
  if (options['--reload'] && !options['--apply']) throw new Error('--reload requires --apply');
  if (spec?.target && !target && !options['--schema']) throw new Error(`${command} requires <${spec.target}>`);
  if (target && !spec?.target && !spec?.optionalTarget) throw new Error(`${command} takes no arguments`);
  // --out persists the response bytes — never the request file. Reject early
  // when it resolves to the request path so the input record is never
  // destroyed by its own result.
  if (options['--out'] && target && spec?.target === 'request.json' && resolve(options['--out']) === resolve(target)) throw new Error('--out must not resolve to the request file — it writes the response, never the request');
  let result;
  if (command === 'identity') result = identity(root);
  else if (command === 'snapshot') result = snapshot(target);
  else if (command === 'records') {
    if (options['--schema']) {
      if (target) throw new Error('records --schema takes no report path');
      result = recordSchema();
    } else {
      if (!target) throw new Error('records requires <path|->');
      const input = target === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(target), 'utf8');
      let parsed = extractRecords(input, options['--repo'] ? { repo: options['--repo'] } : {});
      if (options['--require']) parsed = requireRecordKind(parsed, options['--require']);
      const records = options['--kind'] ? parsed.records.filter(entry => entry.record?.kind === options['--kind']) : parsed.records;
      result = { records, errors: parsed.errors, warnings: parsed.warnings };
      if (parsed.errors.length) process.exitCode = 1;
    }
  }
  else if (command === 'verify') result = verifyInstall(resolve(target));
  else if (command === 'prepare' || command === 'prepare-handoff') {
    const handoff = command === 'prepare-handoff';
    if (options['--schema']) {
      if (target) throw new Error(`${command} --schema takes no request file`);
      result = requestSchema(handoff);
    } else if (options['--check']) {
      // Preflight only: named stage results, never a plan and never a spawn.
      // Exit 1 when any check fails so scripts can gate on it.
      result = launchCheck(root, readJson(target), { handoff });
      if (!result.ok) process.exitCode = 1;
    } else {
      const planned = handoff ? handoffPlan(root, readJson(target)) : launchPlan(root, readJson(target));
      // --emit create prints an audit artifact: `create` is the create_agent
      // argument record verbatim (initialPrompt, title, settings, workspaceId
      // untrimmed), and modeId/modeIdSource record the resolved mode plus its
      // provenance so a saved emit file is self-describing for audit.
      result = options['--emit'] ? { modeId: planned.modeId, modeIdSource: planned.modeIdSource, create: planned.create } : planned;
    }
  }
  else if (command === 'route-decide') {
    if (options['--schema']) {
      if (target) throw new Error('route-decide --schema takes no request file');
      result = routeDecideSchema();
    } else {
      // Explicit helper invocation only — Jev is never called from prepare, a
      // schedule or a background loop. A decline is a successful decision run
      // whose answer is "no suitable option": emit the receipt and exit 1.
      result = await routeDecide(readJson(target), { home: options['--paseo-home'] });
      if (result.declined) process.exitCode = 1;
    }
  }
  else if (command === 'routes') {
    const home = resolveHome(options['--paseo-home']);
    result = { ...readCatalog(target, home), jevRouting: jevRoutingState(home) };
  }
  else if (command === 'inventory') result = inventory(options['--paseo-home']);
  else if (command === 'agents') result = agents(options['--paseo-home']);
  else if (command === 'local-target') result = localTarget(options['--paseo-home']);
  else if (command === 'status') result = runtimeStatus(options['--paseo-home']);
  else if (command === 'init') result = initWorkspace(root, target, Boolean(options['--apply']), options['--routing-from']);
  else if (command === 'materialize') result = materializeWorkspace(options['--from'], target, Boolean(options['--apply']), { includePaths: options['--include'] ?? [], home: resolveHome(options['--paseo-home']) });
  else if (command === 'monitor') result = monitor(readJson(target));
  else if (command === 'tracker') {
    // Read-only beads probe: gaps are data, so exit 0 even when the state is
    // not ready. Without --paseo-home the setting is not read (enabled: null).
    result = probeWorkTracker(resolve(target), { daemonHome: options['--paseo-home'] ?? null });
  }
  else if (command === 'instructions') {
    // Raw preview: the exact bytes roleBundle would inject, unwrapped — stdout
    // stays diffable against a live bundle; provenance goes to stderr. A
    // managed render already reads SLP_* env (exact Node/runtime/home, and the
    // language state file at render time) and fails closed when they are
    // absent; a source-checkout render is a preview, never the bytes a live
    // shim emitted.
    const managed = process.env.SLP_MANAGED_RUNTIME === '1';
    const installed = existsSync(join(root, 'installed.json'));
    process.stderr.write(`instructions preview — role: ${target}, root: ${root}, managed: ${managed}\n`);
    if (!installed) process.stderr.write('note: source checkout — these bytes come from this tree, not from a live managed shim render\n');
    process.stdout.write(roleBundle(root, target, process.env).instructions);
  }
  else if (command === 'notebook') result = notebook(target, options['--paseo-home']);
  else if (command === 'install' || command === 'uninstall' || command === 'upgrade') {
    if (command === 'install' && !target) target = process.env.SLP_HOME || installHome();
    if (!target || !isAbsolute(target)) throw new Error('Absolute destination required');
    const integrated = command === 'upgrade' || (command === 'install' ? options['--paseo-home'] : existsSync(resolve(target, 'paseo-binding.json')));
    if (options['--reload'] && !integrated) throw new Error('--reload requires a Paseo-integrated installation');
    if (command === 'upgrade') result = upgradePaseo(root, target, options['--from'], Boolean(options['--apply']));
    else if (integrated) result = command === 'install'
      ? installPaseo(root, target, options['--paseo-home'], Boolean(options['--apply']))
      : uninstallPaseo(target, Boolean(options['--apply']));
    else if (!options['--apply']) result = { operation: command, destination: target, applied: false, candidate: command === 'install' ? identity(root) : verifyInstall(target).candidate };
    else result = command === 'install' ? (existsSync(target) ? update(root, target) : install(root, target)) : (uninstall(target), { removed: target });
    if (options['--reload']) {
      try {
        const env = { ...process.env, PASEO_HOME: resolve(result.configPath, '..') };
        delete env.PASEO_HOST;
        const daemon = readJson(resolve(env.PASEO_HOME, 'paseo.pid'));
        const endpoint = daemon.listen ?? daemon.sockPath;
        if (typeof endpoint !== 'string' || !endpoint) throw new Error('No local daemon endpoint recorded for this Paseo home');
        result.reload = JSON.parse(execFileSync('paseo', ['reload', '--host', endpoint, '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }));
        if (!Array.isArray(result.reload.restartRequiredPaths) || !Array.isArray(result.reload.overrideControlledPaths)) throw new Error('Unrecognized reload response');
        result.reloadRequired = result.reload.restartRequiredPaths.length > 0 || result.reload.overrideControlledPaths.length > 0;
        if (result.reloadRequired) process.exitCode = 1;
      } catch {
        result.reloadError = 'Files applied, but Paseo reload failed. Run paseo reload with PASEO_HOME set to the config directory.';
        process.exitCode = 1;
      }
    }
  } else throw new Error(usage);
  // --out persists the RESULT bytes — the response, never the request file —
  // so an audit artifact cannot silently hold the request instead.
  if (result !== undefined && options['--out']) {
    const out = resolve(options['--out']);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json(result));
  }
  if (result !== undefined) process.stdout.write(json(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
