#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyInstall } from '../plugin/server/runtime/cli/package.ts';
import { roleInstructions } from '../plugin/server/runtime/cli/role-bundle.ts';
import { piRoleArgs } from '../plugin/server/runtime/cli/role-transport.ts';

const [role, ...args] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  verifyInstall(root);
  const instruction = roleInstructions(root, role);
  const child = spawn(process.env.SLP_PI_BIN || 'pi', piRoleArgs(args, instruction), {
    stdio: 'inherit',
  });
  child.on('error', error => { console.error(`SLP: ${error.message}`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
} catch (error) { console.error(error.message); process.exitCode = 1; }
