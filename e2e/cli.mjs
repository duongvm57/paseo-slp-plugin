#!/usr/bin/env node
import { readJson, json } from '../plugin/server/runtime/cli/package.ts';
import { scenarios } from './scenarios.mjs';
import { initialize, begin, fixture, collect, collectCoordinator, collectResources, seal, review, reviewAddendum, defer, summary, attemptStatus, listRuns } from './collector.mjs';

const [command, ...args] = process.argv.slice(2);
const need = count => { if (args.length < count || args.slice(0, count).some(arg => !arg)) throw new Error(`${command} requires ${count} argument(s); use --help`); };
try {
  let result;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      result = { execution: 'SESSION_REQUIRED', skill: 'skills/paseo-slp-e2e/SKILL.md',
        instruction: 'Read the skill and execute the Human-selected scenarios (the entire manifest for a full-suite request) using Paseo from this session. Human must configure saved SLP profiles for basic-* scenarios before testing; verify them and complete fixture protocol before launch. Continue through collection, independent review and cleanup; this help output ran no live tests.',
        scenarios: scenarios.length, commands: ['plan [scenario-id]', 'init <new-run-directory> [run-config.json]', 'begin <run> <scenario-id> <config.json>', 'fixture <attempt>', 'collect <attempt> <kind> <source-file>', 'collect-coordinator <attempt> <native-session.jsonl> <native-session-id>', 'collect-resources <attempt> <settlement.json>', 'seal <attempt> [gaps.json]', 'status <attempt>', 'review <attempt> <review.json>', 'review-addendum <attempt> <review.json>', 'defer <run> <scenario-id> <reason.json>', 'summary <run>', 'runs <directory>'] };
      if (!command) process.exitCode = 2;
      break;
    case 'plan': result = args[0] ? scenarios.find(row => row.id === args[0]) : scenarios; if (!result) throw new Error('Unknown scenario'); break;
    case 'init': need(1); result = initialize(args[0], args[1] ? readJson(args[1]) : undefined); break;
    case 'begin': need(3); result = begin(args[0], args[1], readJson(args[2])); break;
    case 'fixture': need(1); result = { workspace: fixture(args[0]) }; break;
    case 'collect': need(3); result = collect(args[0], args[1], args[2]); break;
    case 'collect-coordinator': need(3); result = collectCoordinator(args[0], args[1], args[2]); break;
    case 'collect-resources': need(2); result = collectResources(args[0], args[1]); break;
    case 'seal': need(1); result = seal(args[0], args[1] ? readJson(args[1]) : undefined); break;
    case 'status': need(1); result = attemptStatus(args[0]); break;
    case 'review': need(2); result = review(args[0], readJson(args[1])); break;
    case 'review-addendum': need(2); result = reviewAddendum(args[0], readJson(args[1])); break;
    case 'defer': need(3); result = defer(args[0], args[1], readJson(args[2])); break;
    case 'summary': need(1); result = summary(args[0]); process.exitCode = result.status === 'FAIL' ? 1 : result.gateReady ? 0 : 2; break;
    case 'runs': need(1); result = listRuns(args[0]); break;
    default: throw new Error('Unknown E2E command; use --help');
  }
  process.stdout.write(json(result));
} catch (error) {
  process.stderr.write(json({ error: error.message }));
  process.exitCode = 1;
}
