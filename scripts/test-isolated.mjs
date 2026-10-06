#!/usr/bin/env node
// Runs `node --test` against a throwaway PASEO_HOME with a clean environment,
// so an ambient managed runtime or enabled service never leaks into fixtures.
// Arguments are test files and `node --test` flags (default files:
// tests/*.test.mjs); the exit code is node's own.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const defaults = () => readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join('tests', name));
const isTestFile = arg => !arg.startsWith('-') && (/\.(?:mjs|js|cjs|mts|ts)$/.test(arg) || existsSync(resolve(root, arg)));
const files = args.some(isTestFile) ? args : [...args, ...defaults()];

const home = mkdtempSync(join(tmpdir(), 'slp-test-home-'));
const clean = { PASEO_HOME: home, PATH: process.env.PATH ?? '' };
if (process.env.HOME) clean.HOME = process.env.HOME;
let status = 1;
try {
  const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, env: clean, stdio: 'inherit' });
  status = run.status ?? 1;
  if (run.error) console.error(`test-isolated: ${run.error.message}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exitCode = status;
