import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import ts from 'typescript';

const cli = new URL('../bin/slp.mjs', import.meta.url).pathname;
const run = (args, input, home = process.env.PASEO_HOME) => spawnSync(process.execPath, [cli, ...args], {
  input, encoding: 'utf8', timeout: 20000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, PASEO_HOME: home },
});
const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'slp-cli-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const schema = command => {
  const result = run([command, '--schema']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

// Scan the whole command, binding tracked names to lexical symbols so a
// shadowed churn-loop entry is not mistaken for an agent. Unknown read forms
// fail closed: the author must teach this scanner before adding that form.
function assertCoverage(module, interfaceName, schemas, variables, sourceText) {
  const source = ts.createSourceFile(module, sourceText ?? readFileSync(new URL(`../plugin/server/runtime/cli/${module}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const options = { noResolve: true, noLib: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => name === module ? source : undefined;
  const checker = ts.createProgram([module], options, host).getTypeChecker();
  const symbol = node => node && checker.getSymbolAtLocation(node);
  const roots = new Map();
  const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
  const unwrap = node => ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const unsupported = node => assert.fail(`Cannot attribute ${node.getText(source)}; extend the scanner`);
  const field = (contract, key) => {
    assert.ok(Object.hasOwn(contract.properties, key), `validated field ${key} missing from schema`);
    return contract.properties[key];
  };
  const structured = contract => contract?.properties || contract?.items?.properties;
  const read = (raw, nested = false) => {
    const node = unwrap(raw);
    if (ts.isIdentifier(node)) return roots.get(symbol(node));
    if (ts.isBinaryExpression(node) && (structured(read(node.left)) || structured(read(node.right)))) unsupported(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && (nested || node.expression.name.text === 'at') && structured(read(node.expression.expression))) unsupported(node);
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
    const base = read(node.expression, true);
    if (!base) return undefined;
    if (ts.isPropertyAccessExpression(node)) return base.properties ? field(base, node.name.text) : undefined;
    if (base.properties && ts.isStringLiteral(node.argumentExpression)) return field(base, node.argumentExpression.text);
    // The one supported dynamic read enumerates the same threshold table
    // that builds the schema; bind key to that exact loop, not its spelling.
    const key = symbol(node.argumentExpression)?.declarations?.[0];
    const loop = key?.parent?.parent;
    if (base === schemas.thresholds && loop && ts.isForOfStatement(loop)) {
      const enumeration = unwrap(loop.expression);
      if (ts.isCallExpression(enumeration) && enumeration.expression.getText(source) === 'Object.keys'
        && enumeration.arguments[0]?.getText(source) === 'thresholdRules') return undefined;
    }
    return unsupported(node);
  };
  for (const node of source.statements) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) field(schemas.request, member.name.text);
    }
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== (module === 'monitor.ts' ? 'monitor' : 'recordBuild')) continue;
    if ((!node.parameters[0] || !ts.isIdentifier(node.parameters[0].name)) || !variables[node.parameters[0].name.text]) unsupported(node.parameters[0] ?? node);
    walk(node, declaration => {
      if ((ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) && ts.isIdentifier(declaration.name)
        && variables[declaration.name.text]) roots.set(symbol(declaration.name), schemas[variables[declaration.name.text]]);
    });
    walk(node, expression => {
      if (ts.isSpreadAssignment(expression) && structured(read(expression.expression))) {
        let declaration = expression.parent.parent;
        while (ts.isAsExpression(declaration) || ts.isParenthesizedExpression(declaration)) declaration = declaration.parent;
        if (!ts.isVariableDeclaration(declaration) || roots.get(symbol(declaration.name)) !== read(expression.expression)) unsupported(expression);
      }
      if (ts.isForOfStatement(expression)) {
        const items = read(expression.expression)?.items;
        const binding = expression.initializer.declarations?.[0]?.name;
        if (items?.properties && roots.get(symbol(binding)) !== items) unsupported(expression);
      }
      if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
        const items = read(expression.expression.expression)?.items;
        const callback = expression.arguments[0];
        const binding = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback.parameters[0]?.name : undefined;
        if (items?.properties && roots.get(symbol(binding)) !== items) unsupported(expression);
      }
      if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && structured(read(expression.right))) unsupported(expression);
      if (ts.isVariableDeclaration(expression) && expression.initializer) {
        const base = read(expression.initializer);
        if (base && ts.isObjectBindingPattern(expression.name)) {
          for (const binding of expression.name.elements) {
            if (binding.dotDotDotToken || !ts.isIdentifier(binding.name)) unsupported(binding);
            const key = (binding.propertyName ?? binding.name).getText(source);
            const contract = field(base, key);
            if (contract.properties || contract.items) {
              if (binding.name.text !== key) unsupported(binding);
              roots.set(symbol(binding.name), contract);
            }
          }
        } else if (base?.properties || base?.items) unsupported(expression);
      }
      if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) read(expression);
    });
  }
}

test('monitor schema covers the validator and advertises types, defaults and signal values', () => {
  const contract = schema('monitor');
  assert.deepEqual(contract.required, ['agents']);
  assert.equal(contract.properties.agents.items.properties.id.type, 'string');
  assert.equal(contract.properties.thresholds.properties.toolShare.maximum, 1);
  assert.equal(contract.properties.thresholds.properties.idleMinutes.default, 20);
  assert.ok(contract.properties.signals.items.enum.includes('scope-drift'));
  assertCoverage('monitor.ts', 'MonitorRequest', {
    request: contract, entry: contract.properties.agents.items, thresholds: contract.properties.thresholds,
  }, { request: 'request', entry: 'entry', thresholds: 'thresholds' });
  assert.equal(run(['monitor', '-', '--schema'], '{}').status, 1);
});

test('record-build schema covers strict validator keys and verdict values', () => {
  const contract = schema('record-build');
  assert.deepEqual(contract.required, ['repository', 'seat', 'verdict', 'checks']);
  assert.equal(contract.additionalProperties, false);
  assert.equal(contract.properties.checks.items.properties.exit.type, 'integer');
  assert.ok(contract.properties.verdict.enum.includes('APPROVE'));
  assert.ok(contract.properties.verdict.enum.includes(null));
  assertCoverage('record-build.ts', 'RecordBuildRequest', {
    request: contract, seat: contract.properties.seat, entry: contract.properties.checks.items,
  }, { request: 'request', seat: 'seat', entry: 'entry' });
  assert.equal(run(['record-build', '-', '--schema'], '{}').status, 1);
});

test('request commands parse stdin, including a positional dash after flags', t => {
  const dir = fixture(t);
  for (const command of ['prepare', 'prepare-handoff', 'route-decide', 'monitor', 'record-build']) {
    const file = join(dir, `${command}.json`);
    writeFileSync(file, '{}');
    const fromFile = run([command, file]);
    const fromStdin = run([command, '-'], '{}');
    assert.equal(fromStdin.status, fromFile.status, command);
    assert.equal(fromStdin.stderr, fromFile.stderr, command);
    assert.equal(fromStdin.stdout, fromFile.stdout, command);
    assert.match(run([command, '-'], '{bad').stderr, /JSON|Unexpected|property name/, command);
  }
  const request = JSON.stringify({ agents: [{ id: 'absent' }], paseoHome: dir });
  const monitored = run(['monitor', '-'], request);
  assert.equal(monitored.status, 0, monitored.stderr);
  assert.equal(JSON.parse(monitored.stdout).scanned, 1);
  const checked = run(['prepare', '--check', '-'], '{}');
  assert.equal(checked.status, 1);
  assert.ok(JSON.parse(checked.stdout).checks.length > 0);
  execFileSync('git', ['init', '-q', dir]);
  const output = join(dir, 'output.txt');
  writeFileSync(output, 'passed\n');
  const built = run(['record-build', '-', '--out', join(tmpdir(), `slp-cli-record-${process.pid}.md`)], JSON.stringify({
    repository: dir, seat: { role: 'peer', disposition: 'engineer' }, verdict: null,
    checks: [{ cmd: 'check', exit: 0, outputFile: output }],
  }));
  t.after(() => rmSync(join(tmpdir(), `slp-cli-record-${process.pid}.md`), { force: true }));
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /^```slp-record\n/);
});

test('missing-runtime diagnostics resolve the explicit or default daemon receipt without writes', t => {
  const dir = fixture(t), home = join(dir, 'home'), runtime = join(dir, 'active runtime');
  mkdirSync(join(home, 'slp-runtime/state'), { recursive: true });
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin/slp.mjs'), '// fixture');
  const receipt = join(home, 'slp-runtime/state/receipt.json');
  const bytes = JSON.stringify({ state: 'ACTIVE', binding: { runtimePath: runtime } });
  writeFileSync(receipt, bytes);
  for (const flags of [[], ['--paseo-home', home], ['--check', '--paseo-home', home]]) {
    const result = run(['prepare', '-', ...flags], '{}', home);
    assert.equal(result.status, 1);
    assert.ok((result.stderr + result.stdout).includes(join(runtime, 'bin/slp.mjs')), result.stderr + result.stdout);
    assert.equal(readFileSync(receipt, 'utf8'), bytes);
  }
  const other = join(dir, 'other');
  mkdirSync(other);
  assert.doesNotMatch(run(['prepare', '-', '--paseo-home', other], '{}', home).stderr, /active runtime/);
  for (const contents of ['{bad', '{}', JSON.stringify({ state: 'INACTIVE', binding: { runtimePath: runtime } }), JSON.stringify({ binding: { runtimePath: 'relative' } }), JSON.stringify({ binding: { runtimePath: join(dir, 'missing') } })]) {
    writeFileSync(receipt, contents);
    const result = run(['prepare', '-'], '{}', home);
    assert.match(result.stderr, /node <installed-root>\/bin\/slp.mjs/);
    assert.equal(readFileSync(receipt, 'utf8'), contents);
  }
});

test('CLI exceptions with codes retain the code prefix and exit behavior', t => {
  const dir = fixture(t);
  const missing = run(['monitor', join(dir, 'missing.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^ENOENT: /);
  assert.doesNotMatch(missing.stderr, /ENOENT: ENOENT:/);
  const invalid = run(['route-decide', '-'], '{}');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^jev-request-invalid: /);
  const uncoded = run(['monitor', '-'], '{}');
  assert.match(uncoded.stderr, /^request.agents required\n$/);
});


test('monitor threshold contract preserves numeric bounds and nullable optional fields', t => {
  const home = fixture(t);
  const request = { agents: [{ id: 'absent', cwd: null, scope: null }], paseoHome: home,
    signals: null, devinSessionsDb: null, stateFile: null, thresholds: null, extra: true };
  assert.equal(run(['monitor', '-'], JSON.stringify(request)).status, 0);
  const contract = schema('monitor');
  for (const [key, rule] of Object.entries(contract.properties.thresholds.properties)) {
    const valid = run(['monitor', '-'], JSON.stringify({ ...request, thresholds: { [key]: rule.default } }));
    assert.equal(valid.status, 0, valid.stderr);
    for (const value of [0, -1, '1', null, ...(rule.type === 'integer' ? [1.5] : []), ...(rule.maximum === undefined ? [] : [rule.maximum + 0.1])]) {
      const invalid = run(['monitor', '-'], JSON.stringify({ ...request, thresholds: { [key]: value } }));
      assert.equal(invalid.status, 1, `${key}: ${value}`);
      assert.ok(invalid.stderr.includes(`thresholds.${key}`), invalid.stderr);
    }
  }
});


const runtimeFixture = t => {
  const home = fixture(t), runtime = join(home, 'runtime');
  mkdirSync(join(home, 'slp-runtime/state'), { recursive: true });
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin/slp.mjs'), '// fixture');
  const receipt = join(home, 'slp-runtime/state/receipt.json');
  return { home, runtime, receipt };
};

test('F1: monitor preserves threshold error precedence', t => {
  const request = { agents: [{ id: 'absent' }], paseoHome: fixture(t), thresholds: { toolShare: 2, cadenceEdits: 0 } };
  const result = run(['monitor', '-'], JSON.stringify(request));
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'thresholds.cadenceEdits must be a positive integer\n');
});

test('F3: prepare --check resolves both install and plan runtime errors', t => {
  const { home, runtime, receipt } = runtimeFixture(t);
  writeFileSync(receipt, JSON.stringify({ state: 'ACTIVE', binding: { runtimePath: runtime } }));
  const result = run(['prepare', '-', '--check', '--paseo-home', home], '{}');
  assert.equal(result.status, 1);
  const checks = JSON.parse(result.stdout).checks;
  for (const name of ['install', 'plan']) {
    const check = checks.find(check => check.name === name);
    assert.equal(check.ok, false);
    assert.ok(check.error.includes(join(runtime, 'bin/slp.mjs')), `${name}: ${check.error}`);
    assert.doesNotMatch(check.error, /<installed-root>/);
  }
});

test('F5: runtime hints require ACTIVE or ACTIVATING receipt state', t => {
  const { home, runtime, receipt } = runtimeFixture(t);
  for (const state of [undefined, null, 'INACTIVE', 'DEACTIVATING', 'RECOVERY_REQUIRED', 'ACTIVE', 'ACTIVATING']) {
    const bytes = JSON.stringify({ state, binding: { runtimePath: runtime } });
    writeFileSync(receipt, bytes);
    const result = run(['prepare', '-'], '{}', home);
    assert.equal(result.status, 1);
    const active = state === 'ACTIVE' || state === 'ACTIVATING';
    assert.equal(result.stderr.includes(join(runtime, 'bin/slp.mjs')), active, String(state));
    assert.equal(result.stderr.includes('<installed-root>'), !active, String(state));
    assert.equal(readFileSync(receipt, 'utf8'), bytes);
  }
});

test('F4: coverage scanner fails closed on aliases and indices and scans beyond prior', () => {
  const contract = schema('monitor');
  const schemas = { request: contract, entry: contract.properties.agents.items, thresholds: contract.properties.thresholds };
  const variables = { request: 'request', entry: 'entry', thresholds: 'thresholds' };
  for (const body of [
    'const alias = request; alias.extra;',
    'let alias; alias = request; alias.extra;',
    'const alias = request ?? {}; alias.extra;',
    'const alias = { ...request }; alias.extra;',
    'const limits = { ...request.thresholds }; limits.extra;',
    'request.agents.at(0).extra;',
    'const thresholds = { ...request.thresholds }; const alias = thresholds; alias.extra;',
    'for (const entry of request.agents) { const alias = entry; alias.extra; }',
    'for (const alias of request.agents) { alias.extra; }',
    'request.agents.map(alias => alias.extra);',
    'request.agents[0].extra;',
    'request[key];',
  ]) {
    assert.throws(() => assertCoverage('monitor.ts', 'MonitorRequest', schemas, variables,
      `function monitor(request) { ${body} }`), /extend.*scanner/, body);
  }
  assert.throws(() => assertCoverage('monitor.ts', 'MonitorRequest', schemas, variables,
    'function monitor(request) { let prior = {}; request.extra; }'), /missing from schema/);
  assert.throws(() => assertCoverage('monitor.ts', 'MonitorRequest', schemas, variables,
    'function monitor(input) { input.extra; }'), /extend.*scanner/);
  const record = schema('record-build');
  assert.throws(() => assertCoverage('record-build.ts', 'RecordBuildRequest',
    { request: record, seat: record.properties.seat, entry: record.properties.checks.items },
    { request: 'request', seat: 'seat', entry: 'entry' },
    'function recordBuild(request) { const { seat } = request; const alias = seat; alias.extra; }'), /extend.*scanner/);
});
