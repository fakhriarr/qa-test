import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { publicFiles } from './public-files.mjs';
const files = publicFiles().filter(path => /\.tsx?$/.test(path) && !path.endsWith('.d.ts'));
let errors = 0;
for (const fileName of files) {
  const result = ts.transpileModule(readFileSync(fileName,'utf8'), { fileName, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true } });
  for (const diagnostic of result.diagnostics ?? []) if (diagnostic.category === ts.DiagnosticCategory.Error) {
    errors++; console.error(`${fileName}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
}
console.log(JSON.stringify({ check: 'TypeScript syntax/transpile only (in memory)', files: files.length, errors, limitation: 'Not typecheck, module resolution, framework build, or runtime verification.' }));
process.exitCode = errors ? 1 : 0;
