import { readFileSync } from 'node:fs';
import { publicFiles } from './public-files.mjs';
const files = publicFiles();
const forbidden = ['node' + ':sqlite', 'Database' + 'Sync', 'local' + '-user', 'recover' + 'Sending', 'qa-proof' + '.sqlite', 'http' + 'Transport', 'qaProof' + 'Runtime'];
let bad = false;
for (const path of files) {
  const source = readFileSync(path, 'utf8');
  if (path.startsWith('src/') || path.startsWith('tests/') || path.endsWith('.ts') || path.endsWith('.mjs')) {
    for (const token of forbidden) if (source.includes(token)) { console.error(`${path}: forbidden legacy persistence/runtime token`); bad = true; }
  }
  if (/(?:sb_secret_)[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{16,}/.test(source)) {
    console.error(`${path}: possible secret; review without printing value`); bad = true;
  }
}
if (readFileSync('.env.example','utf8').split('\n').some(line => line && !line.startsWith('#') && !/^[A-Z_]+=$/.test(line))) {
  console.error('Environment template must have empty values'); bad = true;
}
if (files.some(p => /(?:^|\/)(?:node_modules|artifacts|\.local|\.next|AGENTS\.md|CLAUDE\.md)(?:\/|$)/.test(p))) {
  console.error('Public allowlist includes internal/generated files'); bad = true;
}
console.log(JSON.stringify({ check: 'static public source allowlist', files: files.length, pass: !bad, limitation: 'Pattern scan is not a complete secret/security audit; review allowlist before push.' }));
process.exitCode = bad ? 1 : 0;
