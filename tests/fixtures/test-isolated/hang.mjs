import test from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('fixture hangs with a grandchild', async () => {
  const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' });
  writeFileSync('pids.json', JSON.stringify({ runner: process.ppid, self: process.pid, grandchild: grandchild.pid, home: process.env.PASEO_HOME }));
  await new Promise(() => {});
});
