import type { RuntimeError } from './types.ts';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

// Own the child lifecycle and NDJSON flow; adapters own protocol detection
// and instruction transforms. Some protocols require untouched frame bytes.
export async function runRoleProcess(command: string, args: string[], { protocol, transform, preserveUnchanged = false }: { protocol: boolean; transform: (message: unknown) => unknown; preserveUnchanged?: boolean }) {
  const child = spawn(command, args, {
    stdio: protocol ? ['pipe', 'pipe', 'inherit'] : 'inherit',
  });
  const fail = (error: unknown) => { console.error(`SLP: ${(error as RuntimeError).message}`); process.exitCode = 1; child.kill(); process.stdin.destroy(); };
  child.on('error', fail);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
    process.stdin.destroy();
  });
  if (protocol) {
    child.stdout!.pipe(process.stdout);
    child.stdin!.on('error', fail);
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const next = transform(message);
        const output = (preserveUnchanged && next === message ? line : JSON.stringify(next)) + '\n';
        if (!child.stdin!.write(output)) await once(child.stdin!, 'drain');
      }
      child.stdin!.end();
    } catch (error) { fail(error); }
  }
}
