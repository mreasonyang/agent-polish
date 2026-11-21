import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sqliteModule } from '../plugins/codex-polish/hooks/recovery.mjs';
import { cleanupProjectSettings } from '../plugins/codex-polish/hooks/owned_settings.mjs';
import { makeProject, supportsFileSymlink } from './hook_fixture.mjs';

// Uninstall can encounter a receipt created by a release that wrote project files.
function saveReceipt(env, files) {
  const parent = path.join(env.CODEX_HOME, 'codex-polish');
  fs.mkdirSync(parent, { recursive: true });
  const ledger = path.join(parent, 'owned-settings.sqlite');
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(ledger);
  const identity = file => {
    const st = fs.lstatSync(file, { bigint: true });
    return [st.dev, st.ino, st.birthtimeNs].join(':');
  };
  try {
    db.exec('PRAGMA application_id=0x43504f53; CREATE TABLE owned (directory TEXT, name TEXT, folder TEXT, file TEXT, PRIMARY KEY(directory,name))');
    const insert = db.prepare('INSERT INTO owned VALUES (?, ?, ?, ?)');
    for (const file of files) {
      const directory = path.dirname(file);
      insert.run(directory, path.basename(file), identity(directory), identity(file));
    }
  } finally {
    db.close();
  }
  return ledger;
}

function createSetting(project, name, value = 'saved') {
  const directory = path.join(project, '.codex');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'codex-polish.' + name);
  fs.writeFileSync(target, value);
  return target;
}

test('uninstall removes only the project files recorded by the profile being uninstalled', t => {
  const { home, project, env } = makeProject(t);
  const second = path.join(home, 'second project');
  const otherProfile = { ...env, CODEX_HOME: path.join(home, 'other profile') };
  const mode = createSetting(project, 'mode');
  const model = createSetting(second, 'model');
  const other = createSetting(project, 'language');
  const unknown = createSetting(project, 'personal', 'keep');
  const ledger = saveReceipt(env, [mode, model]);
  saveReceipt(otherProfile, [other]);
  fs.writeFileSync(model, 'edited');
  assert.equal(cleanupProjectSettings(env), 2);
  for (const file of [mode, model, ledger]) assert.equal(fs.existsSync(file), false, file);
  assert.equal(cleanupProjectSettings(env), 0);
  assert.ok(fs.existsSync(other));
  assert.equal(cleanupProjectSettings(otherProfile), 1);
  assert.equal(fs.existsSync(other), false);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'keep');
});

test('uninstall preserves replacements of previously recorded files and directories', t => {
  const { home, project, env } = makeProject(t);
  const file = createSetting(project, 'mode');
  const second = path.join(home, 'second project');
  const turns = createSetting(second, 'history-turns', '6');
  saveReceipt(env, [file, turns]);
  const original = path.join(home, 'original mode');
  fs.renameSync(file, original);
  if (supportsFileSymlink()) fs.symlinkSync(original, file);
  else fs.writeFileSync(file, 'saved');
  const moved = path.join(home, 'moved settings');
  fs.renameSync(path.dirname(turns), moved);
  fs.symlinkSync(moved, path.dirname(turns), 'junction');
  assert.equal(cleanupProjectSettings(env), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'saved');
  assert.equal(fs.readFileSync(turns, 'utf8'), '6');
});

test('cleanup reports inaccessible settings and retains receipts for a later retry', t => {
  const { project, env } = makeProject(t);
  const file = createSetting(project, 'mode');
  saveReceipt(env, [file]);
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
