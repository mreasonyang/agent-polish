import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const plugin = fileURLToPath(new URL('../plugins/codex-polish/', import.meta.url));
export const preferences = path.join(plugin, 'hooks/preferences.mjs');

export function temporary(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-polish-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function makeProject(t) {
  const home = temporary(t);
  const project = path.join(home, '有 空格');
  const cwd = path.join(project, 'src');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(project, '.codex'));
  const env = { HOME: home, XDG_CACHE_HOME: path.join(home, 'cache'), CODEX_HOME: path.join(home, 'profile'),
    PATH: process.env.PATH, LC_ALL: 'en_US.UTF-8' };
  const mode = path.join(project, '.codex/codex-polish.mode');
  const call = (args, options = {}) => run(preferences, [...args, '--cwd', options.where || cwd], { env, ...options });
  const check = opts => json(call(['check'], opts));
  return { home, project, cwd, mode, env, call, check };
}

export function run(script, args = [], options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000, ...options });
  assert.ifError(result.error);
  return result;
}

export function json(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

export function mkfifo(file) {
  assert.equal(spawnSync('mkfifo', [file]).status, 0);
}
