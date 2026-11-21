import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const plugin = fileURLToPath(new URL('../plugins/codex-polish/', import.meta.url));
export const windows = process.platform === 'win32';
export const agyName = windows ? 'agy.exe' : 'agy';
export function homeEnv(home) {
  if (!windows) return { HOME: home };
  const runtime = {};
  for (const key of ['ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PROCESSOR_ARCHITECTURE',
    'SystemDrive', 'windir', 'PSModulePath', 'ALLUSERSPROFILE', 'CommonProgramFiles', 'CommonProgramFiles(x86)']) {
    if (process.env[key]) runtime[key] = process.env[key];
  }
  return { ...runtime, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    TEMP: os.tmpdir(), TMP: os.tmpdir(), PATHEXT: process.env.PATHEXT };
}
export function runHookCommand(handler, options) {
  if (windows) return spawnSync(process.env.ComSpec, ['/d', '/s', '/c', '"' + handler.commandWindows + '"'],
    { windowsVerbatimArguments: true, ...options });
  return spawnSync('/bin/sh', ['-c', handler.command], options);
}
let fileSymlink;
export function supportsFileSymlink() {
  if (!windows) return true;
  if (fileSymlink === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-link-'));
    try { fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file'); fileSymlink = true; }
    catch (e) { if (e.code !== 'EPERM') throw e; fileSymlink = false; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return fileSymlink;
}
export const preferences = path.join(plugin, 'hooks/preferences.mjs');

export function temporary(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-polish-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function useTestProfile(t, directory = path.join(temporary(t), 'profile')) {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  return directory;
}

export function writeTestPrompt(profile, content) {
  const settings = path.join(profile, 'codex-polish', 'settings');
  fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(path.join(settings, 'codex-polish.prompt.md'), content);
}

export function makeProject(t) {
  const home = temporary(t);
  const project = path.join(home, '有 空格');
  const cwd = path.join(project, 'src');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  const env = { ...homeEnv(home), XDG_CACHE_HOME: path.join(home, 'cache'), CODEX_HOME: path.join(home, 'profile'),
    PATH: process.env.PATH, LC_ALL: 'en_US.UTF-8' };
  const settings = path.join(env.CODEX_HOME, 'codex-polish', 'settings');
  const mode = path.join(settings, 'codex-polish.mode');
  const call = (args, { where = cwd, ...options } = {}) => {
    const runtime = args[0] === 'check' || args[0] === 'decision';
    return run(preferences, runtime ? [...args, '--cwd', where] : args, { cwd: where, env, ...options });
  };
  const check = opts => json(call(['check'], opts));
  return { home, project, cwd, settings, mode, env, call, check };
}

export function run(script, args = [], options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: windows ? 60_000 : 5000, ...options });
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
