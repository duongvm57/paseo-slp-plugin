// Development-only graph gate. Installed modules need only Node; TypeScript
// is used here to inspect runtime and erased type imports with the same rules.
import ts from 'typescript';
import { isBuiltin } from 'node:module';
import { posix } from 'node:path';

const serverRoot = 'plugin/server/runtime/';
const sharedRoot = 'plugin/shared/runtime/';
// Source location does not grant core authority to the standalone CLI. It is
// an adapter even inside the server install subtree; core cannot import it.
const cliRoot = `${serverRoot}cli/`;
const tierOf = path => path.startsWith(cliRoot) ? 'adapter'
  : path.startsWith(sharedRoot) ? 'shared'
  : path.startsWith(serverRoot) ? 'server' : 'adapter';
// These existing imports use a digest-verified candidate and fixed family set.
// Keep their exact expressions explicit; new computed imports fail the gate.
const shimImports = new Set([
  "pathToFileURL(join(root, 'plugin/server/runtime/cli/package.ts')).href",
  'pathToFileURL(wrapperPath).href',
]);

export function assertRuntimeGraph(files) {
  const paths = new Set(files.map(file => file.path));
  const fail = (path, message) => { throw new Error(`runtime graph: ${path}: ${message}`); };
  for (const { path, source } of files) {
    const tier = tierOf(path);
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length) fail(path, 'module does not parse');
    if (ast.typeReferenceDirectives.length || ast.referencedFiles.length) fail(path, 'reference directives are outside the install graph');

    const edge = specifier => {
      if (isBuiltin(specifier)) {
        if (!specifier.startsWith('node:')) fail(path, `use explicit node: builtin imports: ${specifier}`);
        if (tier === 'shared') fail(path, `shared runtime cannot import Node: ${specifier}`);
        return;
      }
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) fail(path, `package or absolute import refused: ${specifier}`);
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!paths.has(target)) fail(path, `dependency is missing from install unit: ${specifier}`);
      const targetTier = tierOf(target);
      if (tier === 'shared' && targetTier !== 'shared') fail(path, `shared runtime import escapes its tier: ${specifier}`);
      if (tier === 'server' && targetTier === 'adapter') fail(path, `server runtime import escapes its tier: ${specifier}`);
    };
    const literalEdge = argument => {
      if (!argument || !ts.isStringLiteralLike(argument)) fail(path, 'computed module import refused');
      edge(argument.text);
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) literalEdge(node.moduleSpecifier);
      if (ts.isImportTypeNode(node)) {
        if (!ts.isLiteralTypeNode(node.argument)) fail(path, 'computed type import refused');
        literalEdge(node.argument.literal);
      }
      if (ts.isImportEqualsDeclaration(node)) fail(path, 'import-equals is not native ESM');
      if (tier !== 'adapter' && ts.isIdentifier(node) && ['require', 'createRequire', 'eval', 'Function'].includes(node.text)) fail(path, `runtime module loader refused: ${node.text}`);
      if (tier === 'shared' && ts.isIdentifier(node) && ['NodeJS', 'Buffer', 'process', 'global'].includes(node.text)) fail(path, `shared runtime cannot use Node globals/types: ${node.text}`);
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          if (path !== 'bin/slp-shim.mjs' || !argument || !shimImports.has(argument.getText(ast))) literalEdge(argument);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          literalEdge(node.arguments[0]);
        } else if (ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'createRequire') {
          literalEdge(node.arguments[0]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
}
