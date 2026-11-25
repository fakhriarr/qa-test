import { lstatSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export const publicRoots = ['src', 'supabase', 'scripts', 'tests', '.github/workflows', 'public'];
export const publicRootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'next-env.d.ts', '.gitignore', '.env.example', 'README.md'];
export function publicFiles() {
  const files = [];
  const walk = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Symlink must not be published: ${path}`);
    if (stat.isDirectory()) { for (const entry of readdirSync(path).sort()) walk(join(path, entry)); }
    else if (stat.isFile()) files.push(path);
  };
  for (const path of [...publicRootFiles, ...publicRoots]) if (existsSync(path)) walk(path);
  return files.sort();
}
