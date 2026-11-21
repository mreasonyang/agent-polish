import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { editorRole } from '../plugins/codex-polish/skills/codex-polish/scripts/editor_role.mjs';
import { makeProject, useTestProfile, writeTestPrompt } from './hook_fixture.mjs';

const tool = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_workspace.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
function prepare(t, args) {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  const keys = ['cleanup_token', 'editor_role_file', 'workspace'];
  if (process.platform === 'win32') keys.push('output_file');
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
  t.after(() => fs.rmSync(value.workspace, { recursive: true, force: true, maxRetries: 5 }));
  return value;
}

test('stage an editor role without a provider executable or IPC endpoints, then dispose it', t => {
  const { cwd } = makeProject(t);
  const profile = useTestProfile(t);
  const custom = '保留所有行尾\r\n  literal $(false)\n';
  writeTestPrompt(profile, custom);
  for (const selectionOnly of [false, true]) {
    const args = ['--cwd', cwd, '--trigger', 'explicit'];
    if (selectionOnly) args.push('--selection-only');
    const { workspace, editor_role_file, cleanup_token } = prepare(t, args);
    const staged = fs.readFileSync(editor_role_file, 'utf8');
    assert.equal(staged, editorRole(cwd, 'explicit', { selectionOnly }));
    assert.equal(staged.includes(custom), !selectionOnly);
    for (const item of fs.readdirSync(workspace, { recursive: true, withFileTypes: true }))
      assert.ok(item.isFile() || item.isDirectory(), item.name);
    if (process.platform !== 'win32') assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
    assert.equal(run('--dispose', workspace, cleanup_token).status, 0);
    assert.equal(fs.existsSync(workspace), false);
  }
});

test('catalog setup is offline and disposal leaves unrelated files in place', t => {
  const { workspace, editor_role_file, cleanup_token } = prepare(t, ['--catalog']);
  const foreign = join(workspace, 'unrelated.txt');
  fs.writeFileSync(foreign, 'keep');
  assert.doesNotMatch(fs.readFileSync(editor_role_file, 'utf8'), /literal \$\(false\)/);
  run('--dispose', workspace, 'invalid');
  assert.ok(fs.existsSync(editor_role_file));
  run('--dispose', workspace, cleanup_token);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep');
});

test('workspace preparation rejects arguments intended to launch or communicate with a provider', () => {
  assert.notEqual(run('--catalog', '--agy-path', process.execPath).status, 0);
  assert.notEqual(run('--catalog', '--catalog-log', 'frames.jsonl').status, 0);
  assert.notEqual(run('--write', 'old', 'frame', '{}').status, 0);
});
