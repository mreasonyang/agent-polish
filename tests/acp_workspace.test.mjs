import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readOutput } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_workspace.mjs';
import { editorRole } from '../plugins/codex-polish/skills/codex-polish/scripts/editor_role.mjs';
import { makeProject, useTestProfile, writeTestPrompt } from './hook_fixture.mjs';

const tool = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_workspace.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
function prepare(t, args) {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ['cleanup_token', 'editor_role_file', 'output_file', 'workspace']);
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
    const { workspace, editor_role_file, output_file, cleanup_token } = prepare(t, args);
    const staged = fs.readFileSync(editor_role_file, 'utf8');
    assert.equal(staged, editorRole('explicit', { selectionOnly }));
    assert.equal(staged.includes(custom), !selectionOnly);
    for (const item of fs.readdirSync(workspace, { recursive: true, withFileTypes: true }))
      assert.ok(item.isFile() || item.isDirectory(), item.name);
    assert.deepEqual(readOutput(workspace, cleanup_token, 0), { text: '', next_offset: 0 });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
      assert.equal(fs.statSync(output_file).mode & 0o777, 0o600);
    }
    assert.equal(run('--dispose', workspace, cleanup_token).status, 0);
    assert.equal(fs.existsSync(workspace), false);
  }
});

test('a clipped read can be replayed in smaller pages through interleaved configuration and command records', t => {
  const { workspace, output_file, cleanup_token } = prepare(t, ['--catalog']);
  const notification = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {
    sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'large-list', description: '天地🌍'.repeat(1400) }]
  } } };
  const response = { jsonrpc: '2.0', id: 4, result: { configOptions: [{ id: 'model', currentValue: 'target' }] } };
  const records = [notification, response, notification];
  const stream = records.map(frame => JSON.stringify(frame) + '\n').join('');
  fs.writeFileSync(output_file, stream);

  const first = readOutput(workspace, cleanup_token, 0);
  assert.ok(first.next_offset > 8188 && first.next_offset <= 8192);
  const smaller = run('--read-output', workspace, cleanup_token, '0', '191');
  assert.equal(smaller.status, 0, smaller.stderr);
  let { text, next_offset: offset } = JSON.parse(smaller.stdout);
  assert.ok(offset > 0 && offset <= 191 && first.text.startsWith(text));
  while (offset < Buffer.byteLength(stream)) {
    const page = readOutput(workspace, cleanup_token, offset, 191);
    assert.ok(page.next_offset > offset && page.next_offset <= offset + 191);
    text += page.text;
    offset = page.next_offset;
  }
  assert.deepEqual(text.trimEnd().split('\n').map(line => JSON.parse(line)), records);
  assert.equal(text, stream);
  assert.deepEqual(readOutput(workspace, cleanup_token, offset), { text: '', next_offset: offset });
});

test('a partial UTF-8 character waits for the remaining bytes at the same offset', t => {
  const { workspace, output_file, cleanup_token } = prepare(t, ['--catalog']);
  const bytes = Buffer.from('a🌍');
  fs.appendFileSync(output_file, bytes.subarray(0, 3));
  assert.deepEqual(readOutput(workspace, cleanup_token, 0, 4), { text: 'a', next_offset: 1 });
  assert.deepEqual(readOutput(workspace, cleanup_token, 1, 4), { text: '', next_offset: 1 });
  fs.appendFileSync(output_file, bytes.subarray(3));
  assert.deepEqual(readOutput(workspace, cleanup_token, 1, 4), { text: '🌍', next_offset: 5 });
  assert.throws(() => readOutput(workspace, cleanup_token, 6));
  for (const size of ['0', '3', '8193', '4.5', 'invalid'])
    assert.notEqual(run('--read-output', workspace, cleanup_token, '0', size).status, 0);
});

test('a replaced output file cannot be read or deleted as part of the session', t => {
  const { workspace, output_file, cleanup_token } = prepare(t, ['--catalog']);
  fs.renameSync(output_file, join(workspace, 'original-output'));
  fs.writeFileSync(output_file, 'unrelated file');
  assert.throws(() => readOutput(workspace, cleanup_token, 0), /output_changed/);
  assert.equal(run('--dispose', workspace, cleanup_token).status, 0);
  assert.equal(fs.readFileSync(output_file, 'utf8'), 'unrelated file');
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
