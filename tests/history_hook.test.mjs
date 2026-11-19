import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, run, preferences, json } from './hook_fixture.mjs';

const SESSION = '877b05ee-93ac-4a48-abaa-493236a9a2d2', OTHER = '4c7e8db6-5efb-417b-9193-57e8bc405314';
const prefURL = new URL('../plugins/codex-polish/hooks/preferences.mjs', import.meta.url).href;
const cacheURL = new URL('../plugins/codex-polish/hooks/recovery.mjs', import.meta.url).href;
function fixture(t) {
  const project = makeProject(t);
  const transcript = path.join(project.home, 'a transcript.jsonl');
  const event = { hook_event_name: 'UserPromptSubmit', cwd: project.project, session_id: SESSION, turn_id: 'turn-1',
    transcript_path: transcript, prompt: 'a private user message' };
  function hook(fields = {}, env = {}) {
    const p = run(preferences, ['hook'], { input: JSON.stringify({ ...event, ...fields }), env: { ...project.env, ...env } });
    assert.equal(p.status, 0, p.stderr);
    assert.equal(p.stderr, '');
    return p.stdout;
  }
  function source(env = {}, cwd = project.project) {
    return json(run('--input-type=module', ['-e', `import {historySource} from ${JSON.stringify(prefURL)}; console.log(JSON.stringify(historySource(process.argv[1])));`, cwd],
      { env: { ...project.env, CODEX_THREAD_ID: SESSION, ...env } }));
  }
  const sql = query => json(run('--input-type=module', ['-e', `import {withCache} from ${JSON.stringify(cacheURL)}; console.log(JSON.stringify(withCache('write', db => db.prepare(process.argv[1]).all())));`, query], { env: project.env }));
  const database = () => {
    const directory = path.join(project.env.XDG_CACHE_HOME, 'codex-polish');
    const entries = fs.readdirSync(directory);
    assert.equal(entries.length, 1);
    return path.join(directory, entries[0]);
  };
  return { ...project, transcript, hook, source, database, sql };
}

test('manual and auto store only metadata and the hook never prints it', t => {
  const { transcript, hook, source, mode, database } = fixture(t);
  fs.writeFileSync(transcript, 'synthetic private conversation');
  assert.equal(hook(), '');
  assert.deepEqual(source(), { session_id: SESSION, turn_id: 'turn-1', transcript_path: transcript });
  fs.writeFileSync(mode, 'auto');
  const reminder = hook({ turn_id: 'turn-2' });
  assert.match(reminder, /additionalContext/);
  assert.ok(!reminder.includes('transcript') && !reminder.includes(SESSION));
  assert.equal(source().turn_id, 'turn-2');
  const db = database();
  assert.equal(fs.statSync(db).mode & 0o077, 0);
  const data = fs.readFileSync(db);
  assert.ok(!data.includes('a private user message') && !data.includes('synthetic private conversation'));
});

test('source matches current thread, profile, and exact cwd', t => {
  const { hook, source, home, cwd } = fixture(t);
  hook();
  assert.equal(source({}, cwd), null);
  assert.equal(source({ CODEX_HOME: path.join(home, 'different profile') }), null);
  for (const id of [OTHER, '']) assert.equal(source({ CODEX_THREAD_ID: id, CODEX_SESSION_ID: SESSION }), null);
  hook({ turn_id: 'child', agent_id: OTHER });
  hook({ turn_id: 'child' }, { CODEX_THREAD_ID: OTHER });
  assert.equal(source().turn_id, 'turn-1');
});

test('invalid source and disabled project revoke stored metadata', t => {
  const { hook, source, mode } = fixture(t);
  for (const fields of [{ turn_id: null }, { transcript_path: null }, { transcript_path: 'relative.jsonl' }]) {
    hook();
    assert.equal(hook(fields), '');
    assert.equal(source(), null);
  }
  hook();
  fs.writeFileSync(mode, 'off');
  assert.equal(source(), null);
  assert.equal(hook(), '');
  fs.writeFileSync(mode, 'manual');
  assert.equal(source(), null);
});

test('uses private cache only and prunes stale pointers', t => {
  const { hook, source, database, sql } = fixture(t);
  hook();
  const file = database();
  fs.chmodSync(file, 0o644);
  assert.equal(source(), null);
  assert.equal(hook(), '');
  fs.chmodSync(file, 0o600);
  sql('UPDATE history_source SET updated=0');
  assert.equal(source(), null);
  hook({ session_id: OTHER });
  assert.deepEqual(sql('SELECT session FROM history_source'), [{ session: OTHER }]);
});
