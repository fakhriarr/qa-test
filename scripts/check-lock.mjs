import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const manifest = JSON.parse(readFileSync('package.json','utf8'));
const lock = JSON.parse(readFileSync('package-lock.json','utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.name, manifest.name);
assert.equal(lock.version, manifest.version);
for (const kind of ['dependencies','devDependencies']) {
  assert.deepEqual(lock.packages[''][kind], manifest[kind]);
  for (const [name, version] of Object.entries(manifest[kind])) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
}
console.log('PASS static manifest/lock: exact root versions and lock entries agree; npm ci remains a cloud gate.');
