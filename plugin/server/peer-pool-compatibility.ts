// Invariant: saving v2 must not strand an active v1-only consumer. The plugin
// owns both the pool writer and installed binding; repo prose cannot enforce
// their schema compatibility. No active binding permits pre-install authoring.
import { pathToFileURL } from 'node:url';
import { createJournal, pendingOperation } from './journal.ts';
import type { ReceiptValue } from '../shared/contracts.ts';
import { OperationConflict } from '../shared/contracts.ts';
import { candidateModulePath } from './candidate-module.ts';
import { verifyInstall } from './runtime/cli/package.ts';
import { canonicalJson } from './runtime/cli/jev.ts';

export async function guardPresetWrite(stableRoot: string, deps: {
  read?: (root: string) => ReceiptValue | null;
  observeRuntime?: (root: string) => Promise<{ candidateSha256: string; supported: boolean }>;
} = {}): Promise<() => void> {
  const read = deps.read ?? createJournal().read;
  const initial = read(stableRoot), binding = initial?.binding ?? null;
  if (initial && pendingOperation(initial)) throw new OperationConflict('BUSY', 'Finish the SLP runtime operation before saving a v2 pool');
  if (binding) {
    const observe = deps.observeRuntime ?? (async root => {
      const installed = verifyInstall(root);
      const launch = await import(pathToFileURL(candidateModulePath(root, 'launch')).href);
      return { candidateSha256: installed.candidate.sha256, supported: launch.FORMATION_CAPABILITIES?.peerPresets === 2 };
    });
    let observed;
    try { observed = await observe(binding.runtimePath); }
    catch { throw new OperationConflict('INVALID_REQUEST', 'Cannot verify active runtime preset support; update or reconcile SLP runtime before saving v2. The existing pool is unchanged.'); }
    if (!observed.supported || observed.candidateSha256 !== binding.candidateSha256) {
      throw new OperationConflict('INVALID_REQUEST', 'Active SLP runtime does not verify v2 preset support; use Update SLP runtime before conversion. The existing pool is unchanged.');
    }
  }
  // Re-read immediately before the synchronous CAS write: an awaited module
  // observation must not race an activation/update/deactivation.
  return () => {
    const current = read(stableRoot);
    if (current && pendingOperation(current) || canonicalJson(current?.binding ?? null) !== canonicalJson(binding)) {
      throw new OperationConflict('BUSY', 'SLP runtime changed during preset save; Reload and retry after the runtime operation finishes');
    }
  };
}
