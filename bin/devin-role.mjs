#!/usr/bin/env node
import { runRoleProcess } from '../plugin/server/runtime/cli/role-process.ts';
import { fileURLToPath } from 'node:url';
import { roleDelivery } from '../plugin/server/runtime/cli/role-bundle.ts';
import { verifyInstall } from '../plugin/server/runtime/cli/package.ts';
import { acpRolePrompt } from '../plugin/server/runtime/cli/role-transport.ts';

const [role, ...args] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  verifyInstall(root);
  const delivery = roleDelivery(root, role);
  const command = args.length ? args : ['acp'];
  const protocol = command[0] === 'acp';
  const seen = new Set();
  await runRoleProcess(process.env.SLP_DEVIN_BIN || 'devin', command, {
    protocol, transform: message => acpRolePrompt(message, delivery, seen),
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
