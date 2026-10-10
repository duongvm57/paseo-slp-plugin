import { isAbsolute } from 'node:path';
import { paseoHome } from './routing.ts';

// Managed runtime (SLP_MANAGED_RUNTIME=1, spec §10): the binding home arrives
// as SLP_DAEMON_HOME (the launcher/shim sets PASEO_HOME to the same canonical
// value). These guards must stand on their own — a managed session whose env
// was stripped must fail rather than infer ~/.paseo or another home.

export const isManagedRuntime = () => process.env.SLP_MANAGED_RUNTIME === '1';

// The managed binding home, or throw: absent or relative is a broken binding.
export function managedHome() {
  const home = process.env.SLP_DAEMON_HOME ?? process.env.PASEO_HOME;
  if (typeof home !== 'string' || !isAbsolute(home)) {
    throw new Error('Managed runtime requires an absolute SLP_DAEMON_HOME; refusing to infer a Paseo home');
  }
  return home;
}

// An explicit home always wins (each caller still validates it). Under managed
// mode an absent home resolves via managedHome() — fail closed, never the
// process default; unmanaged keeps the historical paseoHome() default.
export function resolveHome(explicit?: string | null) {
  if (explicit != null) return explicit;
  return isManagedRuntime() ? managedHome() : paseoHome();
}
