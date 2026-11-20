import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporary } from './hook_fixture.mjs';
import * as recovery from '../plugins/codex-polish/hooks/recovery.mjs';

const execute = promisify(execFile);
const moduleURL = new URL('../plugins/codex-polish/hooks/recovery.mjs', import.meta.url).href;
const { activeFailure, clearFailure, noteFailure, databasePath, removeProfileCache, withCache } = recovery;

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

test('absent records and nonservice errors create nothing', t => {
  const { project, cache } = fixture(t);
  assert.equal(activeFailure(project), null);
  assert.equal(clearFailure(project, 'a'.repeat(32)), false);
  for (const scope of [null, 'relative']) assert.equal(noteFailure(scope, 'api_timeout'), false);
  for (const reason of ['', 'api_refusal', 'already_clear', 'missing_api_key', 'acp_permission_requested', null]) assert.equal(noteFailure(project, reason), false);
  assert.equal(fs.existsSync(cache), false);
});

test('workflow can run without an available SQLite builtin', async t => {
  const { project, cache } = fixture(t);
  const getBuiltinModule = process.getBuiltinModule;
  t.mock.method(process, 'getBuiltinModule', name => name === 'node:sqlite' ? undefined : getBuiltinModule(name));
  const fresh = await import(moduleURL + '?nosqlite');
  assert.equal(fresh.noteFailure(project, 'acp_timeout'), false);
  assert.equal(fresh.activeFailure(project), null);
  assert.equal(fresh.clearFailure(project, 'a'.repeat(32)), false);
  assert.equal(fs.existsSync(cache), false);
});

test('long and short deadlines respect monotonic and wall clock changes', t => {
  const { project } = fixture(t);
  const unit = 1000, wall = 1000 * unit, mono = 200 * unit;
  for (const [reason, ttl] of [['api_timeout', 60], ['acp_auth_failed', 300]]) {
    const duration = ttl * unit;
    assert.equal(noteFailure(project, reason, () => [wall, mono]), true);
    const active = activeFailure(project, () => [wall, mono]);
    assert.deepEqual([active.reason, active.remaining_seconds], [reason, ttl]);
    assert.equal(activeFailure(project, () => [wall + unit, mono + duration - 1]).remaining_seconds, 1);
    for (const [w, m] of [[wall + unit, mono + duration], [wall - unit, mono + unit], [wall + unit, mono - unit], [wall + duration + unit, mono + unit]]) {
      assert.equal(activeFailure(project, () => [w, m]), null);
    }
  }
});

test('scopes are private and independent per project and profile', t => {
  const { project, root, cache, profile } = fixture(t);
  assert.equal(noteFailure(project, 'api_quota_exhausted'), true);
  assert.equal(activeFailure(path.join(root, 'other-project')), null);
  process.env.CODEX_HOME = path.join(root, 'other-profile');
  assert.equal(activeFailure(project), null);
  assert.equal(noteFailure(project, 'acp_timeout'), true);
  process.env.CODEX_HOME = profile;
  assert.equal(activeFailure(project).reason, 'api_quota_exhausted');
  const dir = path.join(cache, 'codex-polish');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2);
  const data = Buffer.concat(files.map(file => fs.readFileSync(path.join(dir, file))));
  for (const value of ['private-project', 'private-profile', 'other-profile']) assert.equal(data.includes(value), false);
});

test('compare and delete keeps a concurrent newer failure', async t => {
  const { project } = fixture(t);
  assert.equal(noteFailure(project, 'api_timeout'), true);
  const first = activeFailure(project).token;
  const call = (func, value) => execute(process.execPath, ['--input-type=module', '-e',
    `import { ${func} } from ${JSON.stringify(moduleURL)}; console.log(${func}(...process.argv.slice(1)));`, project, value]);
  const [, written] = await Promise.all([call('clearFailure', first), call('noteFailure', 'acp_provider_error')]);
  assert.equal(written.stdout.trim(), 'true');
  const last = activeFailure(project);
  assert.equal(last.reason, 'acp_provider_error');
  assert.notEqual(last.token, first);
  assert.equal(clearFailure(project, first), false);
  assert.equal(clearFailure(project, last.token), true);
  assert.equal(activeFailure(project), null);
});

test('broken or unwritable cache fails open without replacing unrelated files', t => {
  const { root, cache, project } = fixture(t);
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const damaged of ['unrelated private content', 'SQLite format 3\0' + 'x'.repeat(300)]) {
    fs.writeFileSync(file, damaged, { mode: 0o600 });
    assert.equal(activeFailure(project), null);
    assert.equal(noteFailure(project, 'acp_timeout'), false);
    assert.equal(clearFailure(project, 'a'.repeat(32)), false);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  }
  fs.unlinkSync(file);
  const occupied = path.join(root, 'ordinary-file');
  fs.writeFileSync(occupied, 'notes');
  process.env.XDG_CACHE_HOME = occupied;
  assert.equal(noteFailure(project, 'api_server_error'), false);
  assert.equal(activeFailure(project), null);
  process.env.XDG_CACHE_HOME = cache;
  fs.symlinkSync(occupied, file);
  assert.equal(noteFailure(project, 'api_server_error'), false);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'notes');
});

test('cleanup retains unrecognized files, reports busy database, and removes owned cache', t => {
  const { project } = fixture(t);
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'unrelated user content', { mode: 0o600 });
  assert.equal(removeProfileCache(), file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unrelated user content');
  fs.unlinkSync(file);
  assert.equal(noteFailure(project, 'acp_timeout'), true);
  withCache('write', db => {
    db.exec('BEGIN EXCLUSIVE');
    assert.throws(removeProfileCache, { path: file, code: 'EIO' });
  });
  assert.equal(removeProfileCache(), null);
  assert.equal(fs.existsSync(file), false);
  assert.equal(removeProfileCache(), null);
});

test('a damaged row cannot expose free text', t => {
  const { project } = fixture(t);
  assert.equal(noteFailure(project, 'api_rate_limited'), true);
  withCache('write', db => db.exec("UPDATE cooldown SET reason='private diagnostic', token='private text'"));
  assert.equal(activeFailure(project), null);
});
