import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cleanupProjectSettings } from '../plugins/codex-polish/hooks/owned_settings.mjs';
import { makeProject, json, supportsFileSymlink } from './hook_fixture.mjs';

test('uninstall removes settings last configured by this profile, including existing and edited files', t => {
  const { home, project, env, call } = makeProject(t);
  const settings = path.join(project, '.codex');
  const second = path.join(home, 'second project');
  fs.mkdirSync(second);
  const otherProfile = { ...env, CODEX_HOME: path.join(home, 'other profile') };
  const write = (args, options) => json(call(args, options)).file;

  const mode = write(['set-mode', 'manual']);
  write(['set-mode', 'off']);
  const language = write(['set-language', 'zh']);
  fs.writeFileSync(language, 'en\n');
  const model = path.join(settings, 'codex-polish.model');
  fs.writeFileSync(model, 'gemini-existing\n');
  write(['set-model', 'gemini-updated']);
  const shared = write(['set-history-turns', '4']);
  write(['set-history-turns', '2'], { env: otherProfile });
  const other = write(['set-decisions', 'off'], { env: otherProfile });
  const secondMode = write(['set-rewrite-mode', 'turbo'], { where: second });
  const unknown = path.join(settings, 'codex-polish.personal');
  fs.writeFileSync(unknown, 'keep');

  assert.equal(cleanupProjectSettings(env), 4);
  for (const deleted of [mode, secondMode, language, model, path.join(env.CODEX_HOME, 'codex-polish', 'owned-settings.sqlite')])
    assert.equal(fs.existsSync(deleted), false, deleted);
  assert.equal(cleanupProjectSettings(env), 0);
  assert.equal(fs.readFileSync(shared, 'utf8'), '2\n');
  assert.equal(cleanupProjectSettings(otherProfile), 2);
  assert.equal(fs.existsSync(other), false);
  assert.equal(fs.existsSync(shared), false);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'keep');
});

test('an explicitly configured tracked setting is removed and neighboring files survive', t => {
  const { project, env, call } = makeProject(t);
  execFileSync('git', ['init', '-q', project], { env });
  const configured = json(call(['set-model', 'gemini-project'])).file;
  const untouched = path.join(project, '.codex', 'codex-polish.language');
  fs.writeFileSync(untouched, 'zh\n');
  execFileSync('git', ['-C', project, 'add', '--', '.codex'], { env });
  assert.equal(cleanupProjectSettings(env), 1);
  assert.equal(fs.existsSync(configured), false);
  assert.equal(fs.readFileSync(untouched, 'utf8'), 'zh\n');
});

test('reset and replacement release ownership, including replaced settings directories', t => {
  const { home, project, env, call } = makeProject(t);
  const removed = json(call(['set-model', 'gemini-test'])).file;
  json(call(['set-model', '--reset']));
  fs.writeFileSync(removed, 'user-setting');
  const file = json(call(['set-mode', 'manual'])).file;
  if (supportsFileSymlink()) {
    const external = path.join(home, 'externally managed');
    fs.writeFileSync(external, 'external');
    fs.unlinkSync(file);
    fs.symlinkSync(external, file);
    assert.equal(cleanupProjectSettings(env), 0);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(external, 'utf8'), 'external');
  }

  const turns = json(call(['set-history-turns', '6'])).file;
  const original = path.join(project, '.codex');
  const moved = path.join(home, 'elsewhere');
  fs.renameSync(original, moved);
  fs.symlinkSync(moved, original, 'junction');
  assert.equal(cleanupProjectSettings(env), 0);
  assert.equal(fs.readFileSync(turns, 'utf8'), '6\n');
  assert.equal(fs.readFileSync(removed, 'utf8'), 'user-setting');
});

test('cleanup reports inaccessible settings and retains receipts for a later retry', t => {
  const { env, call } = makeProject(t);
  const file = json(call(['set-mode', 'manual'])).file;
  const unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', name => {
    if (path.resolve(name) === file) throw Object.assign(new Error('busy'), { code: 'EACCES' });
    unlink(name);
  });
  assert.throws(() => cleanupProjectSettings(env), { code: 'EACCES', path: file });
  mock.mock.restore();
  assert.equal(cleanupProjectSettings(env), 1);
  assert.equal(fs.existsSync(file), false);
});

test('a setter waiting during cleanup registers its new file in the live profile database', async t => {
  const { home, env, call } = makeProject(t);
  const initial = json(call(['set-mode', 'manual'])).file;
  const directory = path.dirname(initial);
  const waiting = path.join(home, 'writer-opened-registry');
  const registry = new URL('../plugins/codex-polish/hooks/owned_settings.mjs', import.meta.url).href;
  const writer = `
    import fs from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { changeProjectSetting } from ${JSON.stringify(registry)};
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql.includes('BEGIN IMMEDIATE')) fs.writeFileSync(process.env.WAITING, '');
      return exec.call(this, sql);
    };
    changeProjectSetting(process.env.SETTINGS, 'write', 'codex-polish.language', 'en');`;
  const unlink = fs.unlinkSync;
  let child, closed;
  t.after(() => { if (child?.exitCode === null) child.kill(); });
  t.mock.method(fs, 'unlinkSync', name => {
    if (path.resolve(name) === initial) {
      child = spawn(process.execPath, ['--input-type=module', '-e', writer], {
        env: { ...env, WAITING: waiting, SETTINGS: directory }, stdio: 'ignore'
      });
      closed = once(child, 'close');
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(waiting) && Date.now() < deadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      assert.ok(fs.existsSync(waiting), 'competing writer opened the original database');
    }
    return unlink(name);
  });
  assert.equal(cleanupProjectSettings(env), 1);
  assert.deepEqual(await closed, [0, null]);
  const file = path.join(directory, 'codex-polish.language');
  assert.equal(fs.readFileSync(file, 'utf8'), 'en\n');
  assert.equal(cleanupProjectSettings(env), 1);
  assert.equal(fs.existsSync(file), false);
});
