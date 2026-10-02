import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { installUnitPaths } from '../plugin/server/runtime/cli/package.ts';
import { assertRuntimeGraph } from '../scripts/runtime-graph.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = 'plugin/server/runtime/engine.ts';
const shared = 'plugin/shared/runtime/contract.ts';
const cli = 'plugin/server/runtime/cli/adapter.ts';
const files = (path, source) => [
  { path: server, source: '' }, { path: shared, source: '' },
  { path: 'src/adapter.mjs', source: '' },
  { path: cli, source: '' },
].map(file => file.path === path ? { path, source } : file);

test('installed graph includes every adapter/core dependency without package dependencies', () => {
  assertRuntimeGraph(installUnitPaths(root).filter(path => /\.(?:mjs|ts)$/u.test(path))
    .map(path => ({ path, source: readFileSync(join(root, path), 'utf8') })));
});

test('runtime tiers allow adapter → server → shared and server Node imports', () => {
  assertRuntimeGraph([
    { path: 'bin/entry.mjs', source: "import '../plugin/server/runtime/cli/adapter.ts';" },
    { path: cli, source: "import '../engine.ts';" },
    { path: server, source: "import 'node:fs'; import type { Value } from '../../shared/runtime/contract.ts';" },
    { path: shared, source: 'export type Value = string;' },
  ]);
});

for (const [name, path, source, diagnostic] of [
  ['package dependency', server, "import { z } from 'zod';", /package or absolute/],
  ['erased package dependency', server, "import type { Agent } from '@getpaseo/plugin';", /package or absolute/],
  ['import type expression', server, "type Value = import('zod').ZodType;", /package or absolute/],
  ['core imports CLI', server, "import '../../../src/adapter.mjs';", /escapes its tier/],
  ['core imports relocated CLI', server, "import './cli/adapter.ts';", /escapes its tier/],
  ['core imports relocated CLI type', server, "import type { Value } from './cli/adapter.ts';", /escapes its tier/],
  ['shared imports relocated CLI', shared, "import '../../server/runtime/cli/adapter.ts';", /escapes its tier/],
  ['core imports feature', server, "import '../desk-store.ts';", /missing from install unit/],
  ['shared imports server', shared, "import '../../server/runtime/engine.ts';", /escapes its tier/],
  ['shared imports Node', shared, "import 'node:fs';", /cannot import Node/],
  ['shared uses Node types', shared, 'export type Value = NodeJS.Platform;', /Node globals\/types/],
  ['missing dependency', 'src/adapter.mjs', "import './missing.mjs';", /missing from install unit/],
  ['extensionless dependency', server, "import '../../shared/runtime/contract';", /missing from install unit/],
  ['computed import', server, 'const x = await import(name);', /computed module import/],
  ['CommonJS loader', server, "const x = require('node:fs');", /module loader refused/],
]) {
  test(`graph rejects ${name}`, () => assert.throws(() => assertRuntimeGraph(files(path, source)), diagnostic));
}
