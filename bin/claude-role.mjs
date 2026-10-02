#!/usr/bin/env node
import { runRoleProcess } from '../plugin/server/runtime/cli/role-process.ts';
import { fileURLToPath } from 'node:url';
import { roleInstructions } from '../plugin/server/runtime/cli/role-bundle.ts';
import { verifyInstall } from '../plugin/server/runtime/cli/package.ts';
import { claudeRolePrompt } from '../plugin/server/runtime/cli/role-transport.ts';

const [role, ...args] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  verifyInstall(root);
  const instruction = roleInstructions(root, role);
  // The Agent SDK speaks NDJSON only in stream-json mode; every other
  // invocation (--version, auth, interactive) is a plain passthrough.
  // SDK 0.3.246 emits '--flag value' pairs; the '--flag=value' form is matched
  // too. If --input-format is present but the stream-json pair is not recognized,
  // preserve passthrough and warn that role injection is unavailable.
  const flag = (name, value) => args.some((arg, index) =>
    arg === `${name}=${value}` || (arg === name && args[index + 1] === value));
  const hasInputFormat = args.some(arg => arg === '--input-format' || arg.startsWith('--input-format='));
  const protocol = flag('--input-format', 'stream-json') && flag('--output-format', 'stream-json');
  if (hasInputFormat && !protocol) {
    process.stderr.write('claude-role: --input-format was present without the stream-json input/output pair; using passthrough without role injection.\n');
  }
  await runRoleProcess(process.env.SLP_CLAUDE_BIN || 'claude', args, {
    protocol, transform: message => claudeRolePrompt(message, instruction), preserveUnchanged: true,
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
