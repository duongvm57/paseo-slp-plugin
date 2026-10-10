import type { PersistenceObservation } from './types.ts';
import { isAbsolute } from 'node:path';
import { readAgentStates } from './agent-state.ts';
import { resolveHome } from './managed-home.ts';
import { devinProviderPattern } from './binding.ts';

// Agent state lives under <paseoHome>/agents/<group>/<agentId>.json; the daemon
// owns it. `paseo inspect --json` does not surface persistence.nativeHandle, so
// linking a Devin ACP session back to `devin -r` requires reading persistence
// here — a best-effort host detail, not a contract. Read-only: never writes.
const text = (value: unknown) => typeof value === 'string' && value ? value : null;
const shellQuote = (value: string) => /\s/.test(value) ? JSON.stringify(value) : value;

const attachHint = (provider: string | null, cwd: string | null, nativeHandle: string | null) =>
  devinProviderPattern.test(provider ?? '') && cwd && nativeHandle
    ? `cd ${shellQuote(cwd)} && devin -r ${shellQuote(nativeHandle)}`
    : null;

// resolveHome(): under SLP_MANAGED_RUNTIME=1 an absent home must come from
// SLP_DAEMON_HOME/PASEO_HOME or throw — never infer ~/.paseo (spec §10).
export function agents(home = resolveHome()) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('Absolute Paseo home required');
  const result = readAgentStates(home).map(state => {
    const provider = text(state.provider) ?? text((state.persistence as PersistenceObservation | null | undefined)?.provider);
    const cwd = text(state.cwd) ?? text((state.persistence as PersistenceObservation | null | undefined)?.metadata?.cwd);
    const nativeHandle = text((state.persistence as PersistenceObservation | null | undefined)?.nativeHandle);
    return {
      id: state.id,
      title: text(state.title),
      provider,
      cwd,
      workspaceId: text(state.workspaceId),
      status: text(state.lastStatus) ?? text(state.status),
      lastActivityAt: text(state.lastActivityAt),
      nativeHandle,
      attach: attachHint(provider, cwd, nativeHandle),
    };
  });
  return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
