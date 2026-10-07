interface CommandSpec {
  usage: string;
  flags?: string[];
  target?: string;
  optionalTarget?: boolean;
}
interface CliOptions {
  [key: string]: string | string[] | boolean | undefined;
  '--include'?: string[];
  '--evidence'?: string[];
  '--base'?: string;
  '--since'?: string;
  '--expect-file'?: string[];
  '--paseo-home'?: string;
  '--from'?: string;
  '--routing-from'?: string;
  '--out'?: string;
  '--repo'?: string;
  '--kind'?: string;
  '--require'?: string;
  '--render'?: string;
  '--emit'?: string;
  '--expect-contract'?: string;
  '--expect-parent'?: string;
  '--expect-workspace'?: string;
  '--expect-runtime'?: string;
}
interface AppliedResult {
  configPath?: string;
  reload?: {
    restartRequiredPaths?: unknown[];
    overrideControlledPaths?: unknown[];
  };
  reloadRequired?: boolean;
  reloadError?: string;
}
import type { RuntimeError } from './types.ts';
import { fileURLToPath } from 'node:url';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { identity, install, uninstall, update, verifyInstall, snapshot, readJson, json } from './package.ts';
import { launchPlan, handoffPlan, launchCheck, requestSchema } from './launch.ts';
import { roleBundle } from './role-bundle.ts';
import { readCatalog } from './routing.ts';
import { routeDecide, routeDecideSchema } from './jev-routing.ts';
import { jevRoutingState } from './jev.ts';
import { resolveHome } from './managed-home.ts';
import { installPaseo, uninstallPaseo, upgradePaseo, initWorkspace, materializeWorkspace, installHome } from './paseo-install.ts';
import { inventory, liveInventory } from './inventory.ts';
import { agents } from './agents.ts';
import { monitor } from './monitor.ts';
import { notebook } from './notebook.ts';
import { localTarget, runtimeStatus } from './runtime-state.ts';
import { extractRecords, recordSchema, requireRecordKind, RECORD_KINDS } from './report-records.ts';
import { renderSlpReport } from '../report-semantics.ts';
import { verifyHandback, VerifyError } from './candidate-verify.ts';
import { deskRecover, DeskRecoverUsage } from './desk-recovery.ts';
import { reviewPacket, assertOutsideRepository, assertRegularFile } from './review-packet.ts';
import { recordBuild } from './record-build.ts';

// One entry per command: the flags it accepts, the required positional target
// (--schema stands in for it where offered), whether it takes an optional
// destination checked by the command itself, and its usage fragment. Order is
// the usage order.
const commands: Record<string, CommandSpec> = {
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
  prepare: { flags: ['--check', '--emit', '--schema', '--out', '--live', '--paseo-home'], target: 'request.json', usage: 'prepare <request.json> [--check | --emit create | --schema] [--live --paseo-home <absolute-home>] [--out <path>]' },
  'prepare-handoff': { flags: ['--check', '--emit', '--schema', '--out'], target: 'request.json', usage: 'prepare-handoff <request.json> [--check | --emit create | --schema] [--out <path>]' },
  materialize: { flags: ['--from', '--apply', '--include', '--paseo-home'], target: 'repository', usage: 'materialize <repository> --from <source-repository> [--include <repo-path>]... [--paseo-home <absolute-home>] [--apply]' },
  monitor: { flags: [], target: 'request.json', usage: 'monitor <request.json>' },
  'route-decide': { flags: ['--paseo-home', '--schema', '--out'], target: 'request.json', usage: 'route-decide <request.json> [--schema] [--out <path>] [--paseo-home <absolute-home>]' },
  notebook: { flags: ['--paseo-home'], target: 'repository', usage: 'notebook <repository> [--paseo-home <absolute-home>]' },
  records: { flags: ['--kind', '--require', '--repo', '--schema', '--render'], target: 'path|-', usage: 'records <path|-> [--kind handback|settlement] [--require handback|settlement] [--repo <absolute-path>] [--schema] | records --render <file|-> [--repo <absolute-path>]' },
  'review-packet': { flags: ['--base', '--since', '--evidence', '--out'], target: 'repository', usage: 'review-packet <absolute-repo> --base <git-ref> [--since <earlier-candidate-dir|snapshot.json>] [--evidence <absolute-file>]... [--out <path-outside-repo>]' },
  'record-build': { flags: ['--out'], target: 'request.json', usage: 'record-build <request.json> [--out <path-outside-repo>]' },
  'verify-handback': { flags: ['--repo', '--paseo-home', '--expect-contract', '--expect-file', '--expect-parent', '--expect-workspace', '--expect-runtime'], target: 'report', usage: 'verify-handback <report-path> --repo <absolute-repo> --expect-contract <repo-path>=<sha256> [--expect-file <repo-path>=<sha256>]... [--expect-runtime <candidateSha256>] [--paseo-home [<absolute-home>]] [--expect-parent <agentId>] [--expect-workspace <workspaceId>]' },
  instructions: { target: 'role', usage: 'instructions <role>' },
  status: { flags: ['--paseo-home'], usage: 'status [--paseo-home <absolute-home>]' },
  'local-target': { flags: ['--paseo-home'], usage: 'local-target [--paseo-home <absolute-home>]' },
  'desk-recover': { flags: ['--paseo-home', '--json', '--bridge'], target: 'repository', usage: 'desk-recover <repository|--bridge> [--paseo-home <absolute-home>] [--json]' },
};
const usage = `Usage: slp.mjs ${Object.values(commands).map(entry => entry.usage).join(' | ')}`;

const root = fileURLToPath(new URL('../../../../', import.meta.url) as import('node:url').URL);
const argv = process.argv.slice(2);
const [command, ...rest] = argv;
let [target, ...args] = rest[0]?.startsWith('--') ? [undefined, ...rest] : rest;
let parsed = false; // argument parse finished — desk-recover distinguishes usage errors from operational ones
let renderedOutput: string | undefined;
try {
  const options: CliOptions = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--include' || key === '--expect-file' || key === '--evidence') {
      // Repeatable: each use appends one repository-relative path to stage /
      // one artifact pin for verify-handback / one evidence file for review-packet.
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) throw new Error(key === '--include' ? '--include requires a repository-relative path' : key === '--evidence' ? '--evidence requires an absolute file path' : '--expect-file requires <repo-relative-path>=<sha256>');
      (options[key] ??= []).push(value);
      continue;
    }
    if (Object.hasOwn(options, key)) throw new Error(`Repeated option ${key}`);
    if (key === '--apply' || key === '--reload' || key === '--check' || key === '--schema' || key === '--json' || key === '--bridge' || key === '--live') options[key] = true;
    else if (key === '--emit') {
      if (args[i + 1]! !== 'create') throw new Error('--emit requires create');
      options[key] = args[++i];
    } else if (key === '--out') {
      const value = args[++i];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error('--out requires a path');
      options[key] = value;
    } else if (key === '--render') {
      const value = args[++i];
      if (typeof value !== 'string' || !value.trim() || (value.startsWith('-') && value !== '-')) throw new Error('--render requires <file|->');
      options[key] = value;
    } else if (key === '--from' || key === '--routing-from') {
      if (!args[i + 1]! || !isAbsolute(args[i + 1]!)) throw new Error(`Absolute path required for ${key}`);
      options[key] = args[++i];
    } else if (key === '--paseo-home') {
      if (args[i + 1]! && !args[i + 1]!.startsWith('--')) {
        if (!isAbsolute(args[i + 1]!)) throw new Error(`Absolute path required for ${key}`);
        options[key] = args[++i];
      } else options[key] = resolveHome(); // bare flag: managed mode resolves SLP_DAEMON_HOME/PASEO_HOME or fails, never ~/.paseo
    } else if (key === '--base' || key === '--since') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${key} requires a value`);
      options[key] = value;
    } else if (key === '--kind' || key === '--require' || key === '--repo') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${key} requires a value`);
      if ((key === '--kind' || key === '--require') && !RECORD_KINDS.includes(value as typeof RECORD_KINDS[number])) throw new Error(`${key} must be ${RECORD_KINDS.join(' or ')}`);
      if (key === '--repo' && !isAbsolute(value)) throw new Error('Absolute path required for --repo');
      options[key] = value;
    } else if (key === '--expect-contract' || key === '--expect-parent' || key === '--expect-workspace' || key === '--expect-runtime') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${key} requires a value`);
      options[key] = value;
    } else if (!key.startsWith('-')) {
      // Positional target may come after flags (e.g. prepare --check req.json).
      if (target !== undefined) throw new Error(`Unexpected argument ${key}`);
      target = key;
    } else throw new Error(`Unknown flag ${key}`);
  }
  const spec = Object.hasOwn(commands, command!) ? commands[command!] : undefined;
  for (const key of Object.keys(options)) if (!spec?.flags?.includes(key)) throw new Error(`${key} is not valid for ${command}`);
  const prepareModes = ['--check', '--emit', '--schema'].filter(key => options[key]);
  if (prepareModes.length > 1) throw new Error(`${prepareModes.join(' and ')} are separate modes — pick one`);
  if (command === 'review-packet' && !options['--base']) throw new Error('review-packet requires --base <git-ref>');
  if (command === 'upgrade' && !options['--from']) throw new Error('upgrade requires --from <previous-installation>');
  if (command === 'materialize' && !options['--from']) throw new Error('materialize requires --from <source-repository>');
  if (options['--reload'] && !options['--apply']) throw new Error('--reload requires --apply');
  // desk-recover --bridge targets the reserved desk-bridge sentinel lock —
  // it substitutes for <repository>, and the two are mutually exclusive.
  if (command === 'desk-recover' && options['--bridge'] && target) throw new Error('desk-recover takes either <repository> or --bridge, not both');
  if (spec?.target && !target && !options['--schema'] && !(command === 'records' && options['--render']) && !(command === 'desk-recover' && options['--bridge'])) throw new Error(`${command} requires <${spec.target}>`);
  if (target && !spec?.target && !spec?.optionalTarget) throw new Error(`${command} takes no arguments`);
  if (command === 'records' && options['--render']) {
    if (target !== undefined) throw new Error('records --render takes its report path as the --render value');
    if (options['--schema'] || options['--kind'] || options['--require']) throw new Error('records --render is a separate mode; use only --repo with it');
  }
  // --out persists the response bytes — never the request file. Reject early
  // when it resolves to the request path so the input record is never
  // destroyed by its own result.
  if (options['--out'] && target && spec?.target === 'request.json' && resolve(options['--out']) === resolve(target!)) throw new Error('--out must not resolve to the request file — it writes the response, never the request');
  let result: unknown;
  parsed = true;
  if (command === 'identity') result = identity(root);
  else if (command === 'snapshot') result = snapshot(target!);
  else if (command === 'records') {
    if (options['--schema']) {
      if (target) throw new Error('records --schema takes no report path');
      result = recordSchema();
    } else if (options['--render']) {
      const renderTarget = options['--render'];
      const input = renderTarget === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(renderTarget), 'utf8');
      const parsedRecords = extractRecords(input, options['--repo'] ? { repo: options['--repo'] } : {});
      const selected = parsedRecords.records.find(entry => entry.selected && (entry.record as { kind?: string } | null)?.kind === 'handback');
      const errors = [...parsedRecords.errors];
      if (!selected) errors.push({ code: 'structured-report-required', message: 'no selected handback slp-record block is available to render' });
      else if (selected.valid && !(selected.record as { report?: unknown }).report) {
        errors.push({ code: 'structured-report-required', blockIndex: selected.blockIndex, message: 'selected handback has no structured report' });
      }
      if (errors.length) {
        result = { errors, warnings: parsedRecords.warnings };
        process.exitCode = 1;
      } else if (selected) {
        renderedOutput = renderSlpReport(selected.record, selected.originalFence);
        if (parsedRecords.warnings.length) {
          renderedOutput = '## Record validation warnings\n'
            + parsedRecords.warnings.map(warning => '- ' + warning.message).join('\n')
            + '\n\n' + renderedOutput;
        }
      }
    } else {
      if (!target) throw new Error('records requires <path|->');
      const input = target === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(target!), 'utf8');
      let parsed = extractRecords(input, options['--repo'] ? { repo: options['--repo'] } : {});
      if (options['--require']) parsed = requireRecordKind(parsed, options['--require']);
      const records = options['--kind'] ? parsed.records.filter(entry => (entry.record as { kind?: string } | null)?.kind === options['--kind']) : parsed.records;
      result = { records, errors: parsed.errors, warnings: parsed.warnings };
      if (parsed.errors.length) process.exitCode = 1;
    }
  }
  else if (command === 'review-packet') {
    result = reviewPacket(resolve(target!), { base: options['--base']!, since: options['--since'], evidence: options['--evidence'], out: options['--out'] });
  }
  else if (command === 'record-build') {
    assertRegularFile(target!, 'request file');
    const request = readJson(target!) as Parameters<typeof recordBuild>[0];
    const repository = (request as { repository?: unknown } | null)?.repository;
    if (options['--out'] && typeof repository === 'string' && isAbsolute(repository)) assertOutsideRepository(repository, options['--out'], '--out');
    const built = recordBuild(request);
    renderedOutput = built.fence;
    for (const warning of built.warnings) process.stderr.write(`warning: ${(warning as { message: string }).message}\n`);
  }
  else if (command === 'verify-handback') {
    // Read-only claim verification (P1): the engine owns pin validation, so
    // the facade only splits <repo-relative-path>=<sha256>; a malformed pin
    // surfaces as INVALID_REQUEST, not a separate parser dialect.
    const pin = (value: string) => {
      const at = value.lastIndexOf('=');
      return { path: at === -1 ? value : value.slice(0, at), sha256: at === -1 ? '' : value.slice(at + 1) };
    };
    result = await verifyHandback({
      reportPath: resolve(target!),
      repo: options['--repo'],
      paseoHome: resolveHome(options['--paseo-home']),
      expectParent: options['--expect-parent'] ?? null,
      expectWorkspace: options['--expect-workspace'] ?? null,
      ...(options['--expect-runtime'] === undefined ? {} : { expectRuntime: options['--expect-runtime'] }),
      ...(options['--expect-contract'] === undefined ? {} : { expectContract: pin(options['--expect-contract']) }),
      expectFiles: (options['--expect-file'] ?? []).map(pin),
    });
  }
  else if (command === 'verify') result = verifyInstall(resolve(target!));
  else if (command === 'prepare' || command === 'prepare-handoff') {
    const handoff = command === 'prepare-handoff';
    let liveRequest: Parameters<typeof launchPlan>[1] | undefined;
    if (options['--live']) {
      if (handoff || options['--schema']) throw new Error('--live supports ordinary saved-profile preparation only');
      const request = readJson(target!) as Parameters<typeof launchPlan>[1];
      if (!['supervisor', 'lead'].includes(request.role ?? '') || request.binding || request.providers || request.profiles || request.inventoryFile || request.route) {
        throw new Error('--live requires a Supervisor/Lead request without binding, routing or caller inventory overrides');
      }
      const home = resolveHome(options['--paseo-home']);
      const observed = liveInventory(home);
      liveRequest = { ...request, paseoHome: home, providers: observed.providers, profiles: observed.profiles };
    }
    if (options['--schema']) {
      if (target) throw new Error(`${command} --schema takes no request file`);
      result = requestSchema(handoff);
    } else if (options['--check']) {
      // Preflight only: named stage results, never a plan and never a spawn.
      // Exit 1 when any check fails so scripts can gate on it.
      result = launchCheck(root, liveRequest ?? readJson(target!) as Parameters<typeof launchCheck>[1], { handoff });
      if (!(result as ReturnType<typeof launchCheck>).ok) process.exitCode = 1;
    } else {
      const planned = handoff ? handoffPlan(root, readJson(target!) as Parameters<typeof handoffPlan>[1]) : launchPlan(root, liveRequest ?? readJson(target!) as Parameters<typeof launchPlan>[1]);
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
      result = await routeDecide(readJson(target!) as Parameters<typeof routeDecide>[0], { home: options['--paseo-home'] });
      if ((result as Awaited<ReturnType<typeof routeDecide>>).declined) process.exitCode = 1;
    }
  }
  else if (command === 'routes') {
    const home = resolveHome(options['--paseo-home']);
    result = { ...readCatalog(target!, home), jevRouting: jevRoutingState(home) };
  }
  else if (command === 'inventory') result = inventory(options['--paseo-home']);
  else if (command === 'agents') result = agents(options['--paseo-home']);
  else if (command === 'local-target') result = localTarget(options['--paseo-home']);
  else if (command === 'status') result = runtimeStatus(options['--paseo-home']);
  else if (command === 'init') result = initWorkspace(root, target!, Boolean(options['--apply']), options['--routing-from']);
  else if (command === 'materialize') result = materializeWorkspace(options['--from']!, target!, Boolean(options['--apply']), { includePaths: options['--include'] ?? [], home: resolveHome(options['--paseo-home']) });
  else if (command === 'monitor') result = monitor(readJson(target!) as Parameters<typeof monitor>[0]);
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
    process.stdout.write(roleBundle(root, target!, process.env).instructions);
  }
  else if (command === 'notebook') result = notebook(target!, options['--paseo-home']);
  else if (command === 'desk-recover') {
    // P2-e operator recovery — the CLI owns input resolution (repo → realpath
    // → repoKey, explicit/resolved home → stable root) and prints the same
    // output object the RPC returns. Exit: 0 recovered/no-lock, 1 any
    // rejection, 2 usage (handled by the shared catch below).
    const { outcome, output } = deskRecover({
      repository: options['--bridge'] ? undefined : resolve(target!),
      bridge: Boolean(options['--bridge']),
      home: resolveHome(options['--paseo-home']),
    });
    if (options['--json']) process.stdout.write(JSON.stringify(output) + '\n');
    else {
      const r = outcome.receipt;
      const lines = [
        `result: ${r.result}`,
        `ok: ${outcome.ok}`,
        outcome.code === null ? null : `code: ${outcome.code}`,
        `pid: ${r.pid === null ? '-' : r.pid}`,
        `nonce: ${r.instanceNonce === null ? '-' : r.instanceNonce}`,
        `actorKey: ${r.actorKey}`,
        `repoKey: ${r.repoKey}`,
        `at: ${r.at}`,
        `auditAppended: ${r.auditAppended}`,
        `recoverLockReleased: ${r.recoverLockReleased === null ? '-' : r.recoverLockReleased}`,
        outcome.message === null ? null : `message: ${outcome.message}`,
        outcome.recovery === null ? null : `recovery: ${outcome.recovery}`,
      ].filter(line => line !== null);
      process.stdout.write(lines.join('\n') + '\n');
    }
    if (!outcome.ok) process.exitCode = 1;
  }
  else if (command === 'install' || command === 'uninstall' || command === 'upgrade') {
    if (command === 'install' && !target) target = process.env.SLP_HOME || installHome();
    if (!target || !isAbsolute(target)) throw new Error('Absolute destination required');
    const integrated = command === 'upgrade' || (command === 'install' ? options['--paseo-home'] : existsSync(resolve(target, 'paseo-binding.json')));
    if (options['--reload'] && !integrated) throw new Error('--reload requires a Paseo-integrated installation');
    if (command === 'upgrade') result = upgradePaseo(root, target, options['--from']!, Boolean(options['--apply']));
    else if (integrated) result = command === 'install'
      ? installPaseo(root, target, options['--paseo-home']!, Boolean(options['--apply']))
      : uninstallPaseo(target, Boolean(options['--apply']));
    else if (!options['--apply']) result = { operation: command, destination: target, applied: false, candidate: command === 'install' ? identity(root) : verifyInstall(target).candidate };
    else result = command === 'install' ? (existsSync(target) ? update(root, target) : install(root, target)) : (uninstall(target), { removed: target });
    if (options['--reload']) {
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, PASEO_HOME: resolve((result as AppliedResult).configPath!, '..') };
        delete env.PASEO_HOST;
        const daemon = (readJson(resolve(env.PASEO_HOME!, 'paseo.pid')) as { listen?: unknown; sockPath?: unknown });
        const endpoint = daemon.listen ?? daemon.sockPath;
        if (typeof endpoint !== 'string' || !endpoint) throw new Error('No local daemon endpoint recorded for this Paseo home');
        (result as AppliedResult).reload! = JSON.parse(execFileSync('paseo', ['reload', '--host', endpoint, '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }));
        if (!Array.isArray((result as AppliedResult).reload!.restartRequiredPaths) || !Array.isArray((result as AppliedResult).reload!.overrideControlledPaths)) throw new Error('Unrecognized reload response');
        (result as AppliedResult).reloadRequired = (result as AppliedResult).reload!.restartRequiredPaths!.length > 0 || (result as AppliedResult).reload!.overrideControlledPaths!.length > 0;
        if ((result as AppliedResult).reloadRequired) process.exitCode = 1;
      } catch {
        (result as AppliedResult).reloadError = 'Files applied, but Paseo reload failed. Run paseo reload with PASEO_HOME set to the config directory.';
        process.exitCode = 1;
      }
    }
  } else throw new Error(usage);
  // --out persists the RESULT bytes — the response, never the request file —
  // so an audit artifact cannot silently hold the request instead.
  const persisted = result !== undefined ? json(result) : command === 'record-build' ? renderedOutput : undefined;
  if (persisted !== undefined && options['--out']) {
    const out = resolve(options['--out']);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, persisted);
  }
  if (renderedOutput !== undefined) process.stdout.write(renderedOutput);
  else if (result !== undefined) process.stdout.write(json(result));
} catch (error) {
  console.error(error instanceof VerifyError ? `${(error as RuntimeError).code}: ${(error as RuntimeError).message}` : (error as RuntimeError).message);
  // desk-recover alone reserves exit 2 for usage errors — argument-parse
  // failures (before `parsed` is set) and DeskRecoverUsage thrown while
  // resolving its inputs. Every other command keeps exit 1.
  const usage = parsed === false || error instanceof DeskRecoverUsage;
  process.exitCode = command === 'desk-recover' && usage ? 2 : 1;
}
