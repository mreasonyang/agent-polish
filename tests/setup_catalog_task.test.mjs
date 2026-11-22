import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createCatalogTask } from '../scripts/setup_catalog_task.mjs';
import { windowsSystemTool } from '../plugins/codex-polish/hooks/platform.mjs';

const options = {
  agyPath: '/opt/bin/agy',
  authMethod: 'existing-session',
  workspace: { workspace: '/tmp/role', output_file: '/tmp/role/provider-output.jsonl' },
  choiceFile: '/tmp/menu/choice.json'
};

test('the Windows picker provides the tested native ConPTY command and a Win32 LF event', () => {
  const path = String.raw`C:\App 中文\%TEMP% & !\agy.exe`;
  const task = createCatalogTask({ ...options, agyPath: path, platform: 'win32' });
  const guide = readFileSync(new URL('../plugins/codex-polish/skills/codex-polish/references/acp-windows.md', import.meta.url), 'utf8');
  const command = guide.match(/^```powershell\r?\n([\s\S]+?)\r?\n```\r?$/m)[1];
  assert.ok(task.includes(command.replace('AGY_PATH_UTF8_BASE64', Buffer.from(path).toString('base64'))));
  assert.match(task, /U\+001B.*\[0;0;10;1;0;1_/);
  assert.doesNotMatch(task, /AGY_PATH_UTF8_BASE64|stty/);
});

test('POSIX launch preserves an absolute executable path with shell metacharacters', { skip: process.platform === 'win32' }, () => {
  const path = "/tmp/O'Brien & Co/$HOME/agy";
  const task = createCatalogTask({ ...options, agyPath: path, platform: 'linux' });
  const argument = task.match(/&& exec (.+) acp --agent codex-polish-editor --sandbox >> provider-output\.jsonl/)[1];
  // Parse only the generated path as a shell word. No provider is launched.
  const parsed = spawnSync('/bin/sh', ['-c', 'printf %s ' + argument], { encoding: 'utf8' });
  assert.equal(parsed.status, 0);
  assert.equal(parsed.stdout, path);
});

test('catalog authentication uses only the configured method, before opening the session', () => {
  for (const method of ['gemini-api-key', 'agent-platform']) {
    const task = createCatalogTask({ ...options, authMethod: method, platform: 'linux' });
    assert.ok(task.includes('id 2 authenticate with methodId "' + method + '"'));
    assert.ok(task.indexOf('id 2 authenticate') < task.indexOf('id 3 session/new'));
  }
  assert.doesNotMatch(createCatalogTask(options), /id 2 authenticate/);
  assert.throws(() => createCatalogTask({ ...options, authMethod: 'unsupported' }), /unsupported_google_auth/);
});

test('one local command waits for an installer choice and exits if the menu disappears', async t => {
  const root = mkdtempSync(join(tmpdir(), "catalog O'Brien "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'menu & 中文');
  mkdirSync(dir);
  const file = join(dir, 'choice.json');
  const task = createCatalogTask({ ...options, choiceFile: file });
  const command = task.split('This command only reads the menu choice:\n')[1].split('\nIf the choice is')[0];
  const run = () => {
    const native = process.platform === 'win32';
    const shell = native ? windowsSystemTool('WindowsPowerShell/v1.0/powershell.exe') : '/bin/sh';
    const args = native ? ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] : ['-c', command];
    return promisify(execFile)(shell, args, { timeout: 10000 });
  };
  const waiting = run();
  await delay(350);
  writeFileSync(file, '{"close":true}');
  assert.deepEqual(JSON.parse((await waiting).stdout), { close: true });
  rmSync(dir, { recursive: true });
  await assert.rejects(run(), error => error.code === 1);
});
