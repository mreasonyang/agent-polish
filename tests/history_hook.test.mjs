import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, run, preferences, plugin, json } from './hook_fixture.mjs';

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
  fs.writeFileSync(mode, 'manual');
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
    assert.match(hook(fields), /additionalContext/);
    assert.equal(source(), null);
  }
  hook();
  fs.writeFileSync(mode, 'off');
  assert.equal(source(), null);
  assert.equal(hook(), '');
  fs.writeFileSync(mode, 'manual');
  assert.equal(source(), null);
});

test('a large user message still receives the automatic hook', t => {
  const { hook, source } = fixture(t);
  const output = hook({prompt: '中'.repeat(750_000)});
  assert.match(output, /additionalContext/);
  assert.equal(source().turn_id, 'turn-1');
});

test('zero history retains only the pointer needed for an explicit earlier-answer rewrite', t => {
  const { project, env, hook, source, transcript, database } = fixture(t);
  const setting = path.join(project, '.codex/codex-polish.history-turns');
  fs.writeFileSync(setting, '0');
  const event = (type, fields) => ({ type: 'event_msg', payload: { type, ...fields } });
  const exchange = (turn_id, message, answer) => [
    event('task_started', { turn_id }), event('user_message', { message }),
    event('agent_message', { phase: 'final_answer', message: answer }),
    event('task_complete', { turn_id, last_agent_message: answer }),
  ];
  fs.writeFileSync(transcript, [{ type: 'session_meta', payload: { id: SESSION } },
    ...exchange('first', 'Question one', 'First GPT answer.'), ...exchange('second', 'Question two', 'Second GPT answer.'),
    event('task_started', { turn_id: 'turn-1' }), event('user_message', { message: 'Rewrite the first answer.' }),
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  hook();
  assert.equal(source().turn_id, 'turn-1');
  assert.ok(!fs.readFileSync(database()).includes('First GPT answer.'));
  const script = path.join(plugin, 'skills/codex-polish/scripts/previous_reply.mjs');
  const previous = (...args) => run(script, ['--cwd', project, ...args], { env: { ...env, CODEX_THREAD_ID: SESSION } });
  assert.deepEqual(json(previous()), { question: 'Question two', draft: 'Second GPT answer.' });
  assert.deepEqual(json(previous('--turns-back', '2')), { question: 'Question one', draft: 'First GPT answer.' });
  for (const n of ['0', '-1', '1.5', '2e0', '9007199254740992', '3']) {
    const result = previous('--turns-back', n);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});

test('uses private cache only and prunes stale pointers', t => {
  const { hook, source, database, sql } = fixture(t);
  hook();
  const file = database();
  fs.chmodSync(file, 0o644);
  assert.equal(source(), null);
  assert.match(hook(), /additionalContext/);
  fs.chmodSync(file, 0o600);
  sql('UPDATE history_source SET updated=0');
  assert.equal(source(), null);
  hook({ session_id: OTHER });
  assert.deepEqual(sql('SELECT session FROM history_source'), [{ session: OTHER }]);
});
