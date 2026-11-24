import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [source, host, version, channel, legacy] = process.argv.slice(2);
const read = (...path) => JSON.parse(readFileSync(join(source, ...path), 'utf8'));
const product = host + '-polish';
const root = read('package.json');
const pkg = legacy === 'true' ? root : read('packages', product, 'package.json');
if (legacy === 'true') {
  assert.equal(host, 'codex');
} else {
  assert.equal(root.private, true);
  assert.equal(pkg.repository.url, 'git+https://github.com/mreasonyang/agent-polish.git');
}
assert.notEqual(pkg.private, true);
assert.equal(pkg.name, '@kyun.si/' + product);
assert.equal(pkg.version, version);
assert.equal(pkg.publishConfig.tag, channel);
assert.equal(pkg.publishConfig.access, 'public');
assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/');

const codexManifest = 'plugins/codex-polish/.codex-plugin/plugin.json';
const agyManifest = 'plugins/agy-polish/plugin.json';
const manifest = read(host === 'codex' ? codexManifest : agyManifest);
assert.equal(manifest.name, product);
assert.equal(manifest.version, version);

// The final legacy package bundled both plugins. Older tags shipped only Codex.
if (legacy === 'true' && existsSync(join(source, agyManifest))) {
  assert.equal(read(agyManifest).version, version);
}
