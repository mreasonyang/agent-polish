import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { homeEnv, temporary, windows } from './hook_fixture.mjs';

const helper = new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_windows_io.mjs', import.meta.url);
const probe = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { execFileSync } from 'node:child_process';
  import { secureDirectory, checkPrivatePaths, powershell } from ${JSON.stringify(helper.href)};
  let start = Date.now();
  function mark(label) {
    console.log(label + '=' + (Date.now() - start) + 'ms');
    start = Date.now();
  }
  const dir = process.argv[1];
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' });
  mark('PowerShell startup');
  secureDirectory(dir);
  mark('set directory ACL');
  const file = path.join(dir, 'settings');
  fs.writeFileSync(file, '');
  checkPrivatePaths([{path:dir,directory:true},{path:file,directory:false}]);
  mark('verify directory and file ACLs');
`;

test('Windows can secure and inspect a cache under the host and isolated profile environments', { skip: !windows }, t => {
  const root = temporary(t);
  for (const [name, env] of [['host', process.env], ['isolated', { ...homeEnv(root), PATH: process.env.PATH }]]) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, dir], {
      env, timeout: 60_000, encoding: 'utf8'
    });
    const timings = name + ': ' + result.stdout.trim().split(/\r?\n/).join(', ');
    t.diagnostic(timings);
    assert.equal(result.status, 0, [timings, result.error?.message, result.stderr].filter(Boolean).join('\n'));
  }
});
