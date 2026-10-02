import type { DaemonAgent } from './types.ts';
import type { RuntimeError } from './types.ts';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

// Read-only discovery of daemon-owned <home>/agents/<group>/<id>.json.
// A missing root is empty; other root errors propagate. Broken groups/files
// are skipped, group symlinks are not traversed, and file links retain the
// host reader's existing behavior. Preserve read order and duplicate IDs:
// callers own projection, sorting and which duplicate wins.
export function readAgentStates(home: string): DaemonAgent[] {
  const dir = join(home, 'agents');
  let groups;
  try { groups = readdirSync(dir); } catch (error) {
    if ((error as RuntimeError).code === 'ENOENT') return [];
    throw error;
  }
  const states: DaemonAgent[] = [];
  for (const group of groups) {
    const groupDir = join(dir, group);
    let names;
    try {
      if (!lstatSync(groupDir).isDirectory()) continue;
      names = readdirSync(groupDir);
    } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let state;
      try { state = JSON.parse(readFileSync(join(groupDir, name), 'utf8')); } catch { continue; }
      if (state === null || typeof state !== 'object' || typeof state.id !== 'string') continue;
      states.push(state);
    }
  }
  return states;
}
