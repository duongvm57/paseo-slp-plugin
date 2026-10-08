#!/usr/bin/env node
// Managed and standalone OpenCode use ACP stdio, with role bytes on every prompt.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRoleProcess } from '../plugin/server/runtime/cli/role-process.ts';
import { roleDelivery } from '../plugin/server/runtime/cli/role-bundle.ts';
import { verifyInstall } from '../plugin/server/runtime/cli/package.ts';
import { acpRolePrompt } from '../plugin/server/runtime/cli/role-transport.ts';
import { supportsOpenCodeVersion, OPENCODE_VERSION_REQUIREMENT } from '../plugin/shared/runtime/opencode-version.mjs';

const [role, ...args] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  verifyInstall(root);
  const delivery = roleDelivery(root, role);
  const binary = process.env.SLP_OPENCODE_BIN || 'opencode';
  const command = args.length ? args : ['acp'];
  const versionProbe = command.length === 1 && command[0] === '--version';
  if (!versionProbe && command[0] !== 'acp') {
    throw new Error('SLP OpenCode supports only ACP stdio; native serve sessions are unsupported');
  }
  if (!versionProbe && process.env.SLP_MANAGED_RUNTIME === '1' && process.env.PASEO_AGENT_ID && !process.env.SLP_SESSION_OPEN_GRANT) {
    throw new Error('managed OpenCode session launched without live SLP hook grant');
  }
  // A grant belongs to this open only. Neither the version check nor the ACP
  // child may inherit it and reuse it in a nested session.
  if (!versionProbe) delete process.env.SLP_SESSION_OPEN_GRANT;
  if (!versionProbe) {
    const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    if (probe.status !== 0 || !supportsOpenCodeVersion(probe.stdout ?? '')) {
      throw new Error(`SLP OpenCode requires ${OPENCODE_VERSION_REQUIREMENT}; executable version was not verified`);
    }
  }
  const seen = new Set();
  await runRoleProcess(binary, command, {
    protocol: !versionProbe,
    preserveUnchanged: true,
    transform: message => acpRolePrompt(message, delivery, seen),
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
