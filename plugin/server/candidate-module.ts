// A retained immutable candidate may use either CLI layout. Callers establish
// candidate authority before selecting its declared module; an import failure
// never authorizes loading another file.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function candidateModulePath(runtimePath: string, name: "role-bundle" | "package" | "launch"): string {
  const receipt: unknown = JSON.parse(readFileSync(join(runtimePath, "installed.json"), "utf8"));
  const files = (receipt as { candidate?: { files?: { path?: unknown }[] } } | null)?.candidate?.files;
  if (!Array.isArray(files)) throw new Error("candidate receipt lacks its module file list");
  const layouts = [`plugin/server/runtime/cli/${name}.ts`, `src/${name}.ts`, `src/${name}.mjs`];
  const selected = files.filter(file => layouts.includes(file?.path as string));
  if (selected.length !== 1) throw new Error(`candidate must declare exactly one ${name} module`);
  const path = join(runtimePath, selected[0].path as string);
  if (!lstatSync(path).isFile()) throw new Error(`candidate module is not a regular file: ${path}`);
  return path;
}
