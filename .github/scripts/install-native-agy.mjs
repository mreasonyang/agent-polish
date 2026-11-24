import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { agyExecutable } from '../../scripts/installer_common.mjs';
import { installAgyBootstrap } from '../../scripts/agy_bootstrap.mjs';

await installAgyBootstrap(message => new Error(message));
const { command } = agyExecutable();
console.log(execFileSync(command, ['--version'], { encoding: 'utf8' }).trim());
const help = spawnSync(command, ['--help'], { encoding: 'utf8' });
if (help.error) throw help.error;
assert.equal(help.status, 0, help.stderr);
assert.match([help.stdout, help.stderr].join('\n'), /^\s*acp\s/m);
appendFileSync(process.env.GITHUB_PATH, dirname(command) + '\n');
