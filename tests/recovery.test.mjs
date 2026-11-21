import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporary } from './hook_fixture.mjs';
import * as recovery from '../plugins/codex-polish/hooks/recovery.mjs';

const moduleURL = new URL('../plugins/codex-polish/hooks/recovery.mjs', import.meta.url).href;
const { cacheScope, databasePath, removeProfileCache, withCache } = recovery;

function fixture(t) {
  const root = temporary(t);
  const cache = path.join(root, 'cache'), project = path.join(root, 'private-project'), profile = path.join(root, 'private-profile');
  for (const [key, value] of Object.entries({ CODEX_HOME: profile, XDG_CACHE_HOME: cache })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  return { root, cache, project, profile };
}

test('read-only lookups and missing SQLite never create the history cache', async t => {
  const { cache } = fixture(t);
  assert.throws(() => withCache('read', () => {}));
  const getBuiltinModule = process.getBuiltinModule;
  t.mock.method(process, 'getBuiltinModule', name => name === 'node:sqlite' ? undefined : getBuiltinModule(name));
  const fresh = await import(moduleURL + '?nosqlite');
  assert.throws(() => fresh.withCache('create', () => {}));
  assert.equal(fs.existsSync(cache), false);
});

test('cache scopes are private and independent per directory and profile', t => {
  const { project, root, profile } = fixture(t);
  const first = cacheScope(project);
  assert.doesNotMatch(first, /private/);
  assert.notEqual(cacheScope(path.join(root, 'other-project')), first);
  const firstFile = databasePath();
  process.env.CODEX_HOME = path.join(root, 'other-profile');
  assert.notEqual(cacheScope(project), first);
  assert.notEqual(databasePath(), firstFile);
  process.env.CODEX_HOME = profile;
  assert.equal(cacheScope(project), first);
});

test('broken or unwritable cache leaves unrelated files intact', t => {
  const { root, cache } = fixture(t);
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const damaged of ['unrelated private content', 'SQLite format 3\0' + 'x'.repeat(300)]) {
    fs.writeFileSync(file, damaged, { mode: 0o600 });
    assert.throws(() => withCache('create', () => {}));
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  }
  fs.unlinkSync(file);
  const occupied = path.join(root, 'ordinary-file');
  fs.writeFileSync(occupied, 'notes');
  process.env.XDG_CACHE_HOME = occupied;
  assert.throws(() => withCache('create', () => {}));
  process.env.XDG_CACHE_HOME = cache;
  fs.symlinkSync(occupied, file);
  assert.throws(() => withCache('create', () => {}));
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'notes');
});

test('cleanup retains unrecognized files, reports busy database, and removes owned cache', t => {
  fixture(t);
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'unrelated user content', { mode: 0o600 });
  assert.equal(removeProfileCache(), file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unrelated user content');
  fs.unlinkSync(file);
  withCache('create', db => db.exec('CREATE TABLE history_source(session TEXT)'));
  withCache('write', db => {
    db.exec('BEGIN EXCLUSIVE');
    assert.throws(removeProfileCache, { path: file, code: 'EIO' });
  });
  assert.equal(removeProfileCache(), null);
  assert.equal(fs.existsSync(file), false);
  assert.equal(removeProfileCache(), null);
});
