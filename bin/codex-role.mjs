#!/usr/bin/env node
import { runRoleProcess } from '../plugin/server/runtime/cli/role-process.ts';
import { fileURLToPath } from 'node:url';
import { roleInstructions } from '../plugin/server/runtime/cli/role-bundle.ts';
import { verifyInstall } from '../plugin/server/runtime/cli/package.ts';
import { injectRole } from '../plugin/server/runtime/cli/role-transport.ts';

const [role, ...args] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  verifyInstall(root);
  const instruction = roleInstructions(root, role);
  const protocol = args.includes('app-server') && !args.includes('--help') && !args.includes('--version');
  await runRoleProcess(process.env.SLP_CODEX_BIN || 'codex', args, {
    protocol, transform: message => injectRole(message, instruction),
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
