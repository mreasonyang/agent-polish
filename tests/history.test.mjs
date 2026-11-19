import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporary, plugin, run, json, mkfifo } from './hook_fixture.mjs';
import { readHistory, MAX_HISTORY_BYTES, MAX_SCAN_BYTES } from '../plugins/codex-polish/hooks/history.mjs';

const script = path.join(plugin, 'hooks/history.mjs');
const event = (name, fields = {}) => ({ type: 'event_msg', payload: { type: name, ...fields } });
function message(role, text, fields = {}) {
  return { type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...fields } };
}
const start = turn_id => event('task_started', { turn_id });
const finish = (turn_id, last_agent_message) => event('task_complete', { turn_id, last_agent_message });
const user = msg => event('user_message', { message: msg });
const final = msg => message('assistant', msg, { phase: 'final_answer' });
const exchange = (turn, q, a) => [start(turn), user(q), final(a), finish(turn, a)];
const typed = (turn, text) => message('user', text, { internal_chat_message_metadata_passthrough: {
  turn_id: turn, content_item_kinds: ['user.text'], content_item_metadata: [{ provenance: { type: 'user' } }],
} });

function fixture(t) {
  const file = path.join(temporary(t), 'rollout.jsonl');
  const meta = { type: 'session_meta', payload: { id: 's' } };
  const write = (...rows) => fs.writeFileSync(file, [meta, ...rows].map(row => JSON.stringify(row) + '\n').join(''));
  const read = turns => readHistory(file, 's', 'now', turns);
  return { file, meta, write, read };
}

test('requires user provenance, prefers UI events and keeps only the final answer', t => {
  const { write, read } = fixture(t);
  const q = '  保持原文\n访问 src/foo.py:3，延迟 25 ms。  ', a = '已保留 `command --flag`。\n';
  write(start('first'), message('developer', 'hidden'), message('user', 'injected'), typed('first', q),
    message('assistant', 'progress', { phase: 'commentary' }), { type: 'response_item', payload: { type: 'function_call_output', output: 'logs' } },
    user(q), event('agent_message', { message: 'interim' }), final(a), finish('first', a),
    start('second'), typed('second', q), final(a), finish('second', a), start('now'), user('current'), final('unfinished'));
  assert.deepEqual(read(), Array(2).fill({ user: q, assistant: a }));
});

test('skips host notices, attachments, credentials, controls and unattributed messages', t => {
  const { read, write } = fixture(t);
  for (const unsafe of [user('Subagent completed: worker'), user('hello\n<environment_context>private</environment_context>'),
    user('# Context from my IDE setup:\nprivate'), user('password=fixture-secret'), user('key\x1b[1m'),
    event('user_message', { message: 'image', local_images: ['/my/path'] }), message('user', 'unattributed')]) {
    write(start('one'), unsafe, final('answer'), finish('one', 'answer'), start('now'));
    assert.deepEqual(read(), []);
  }
});

test('takes recent completed turns in order without backfill', t => {
  const { read, write } = fixture(t);
  write(...exchange('a', 'qA', 'aA'), ...exchange('b', 'qB', 'aB'), ...exchange('c', 'qC', 'token=secret'),
    ...exchange('d', 'qD', 'aD'), start('aborted'), user('not answered'), event('turn_aborted', { turn_id: 'aborted' }), start('now'));
  assert.deepEqual(read(3), [{ user: 'qB', assistant: 'aB' }, { user: 'qD', assistant: 'aD' }]);
  assert.deepEqual(read(), [{ user: 'qD', assistant: 'aD' }]);
});

test('reader caps history, CLI rejects values above ten', t => {
  const { read, write, file } = fixture(t);
  const expected = Array.from({ length: 12 }, (_, i) => ({ user: 'q' + i, assistant: 'a' + i }));
  write(...expected.flatMap(({ user, assistant }, i) => exchange(String(i), user, assistant)), start('now'));
  assert.deepEqual(read(11), expected.slice(2));
  const args = ['--transcript', file, '--session-id', 's', '--turns'];
  assert.deepEqual(json(run(script, [...args, '10'])), expected.slice(2));
  const invalid = run(script, [...args, '11']);
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /10/);
});

test('zero skips file access, steering shares a turn, tool-only runs do not count', t => {
  const { read, write } = fixture(t);
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('unexpected read'); });
  assert.deepEqual(read(0), []);
  assert.equal(open.mock.callCount(), 0);
  open.mock.restore();
  write(...exchange('old', 'old', 'old reply'), start('steered'), user('Original question.'), message('assistant', 'progress', { phase: 'commentary' }),
    user('One clarification.'), final('Answer to both.'), finish('steered', 'Answer to both.'), start('tool-only'), finish('tool-only', null), start('now'));
  assert.deepEqual(read(1), [{ user: 'Original question.\n\nOne clarification.', assistant: 'Answer to both.' }]);
});

test('rejects stale turn, session mismatch, incomplete, replaced or truncated answers', t => {
  const { read, write, file } = fixture(t);
  const seen = exchange('a', 'q', 'answer');
  write(...seen, start('now'));
  assert.deepEqual(readHistory(file, 'another', 'now'), []);
  assert.deepEqual(readHistory(file, 's', 'stale'), []);
  fs.appendFileSync(file, '{"unfinished":');
  assert.deepEqual(read(), []);
  for (const tail of [[...seen, start('now'), finish('now', 'unexpected')], [...seen.slice(0, -1), finish('a', 'replaced'), start('now')],
    [...seen, start('now'), start('newer')]]) {
    write(...tail);
    assert.deepEqual(read(), []);
  }
});

test('exec and resumed exec keep root user input and exclude agents or automations', t => {
  const { read, write } = fixture(t);
  const launch = (id, trigger, agent = null) => event('task_started', { turn_id: id, root_turn_id: id,
    turn_attribution: { turn_id: id, root_turn_id: id, turn_trigger: trigger, initiating_agent_path: agent, parent_turn_id: null } });
  const records = (id, trigger, agent) => [launch(id, trigger, agent), typed(id, 'typed ' + id), final('final ' + id), finish(id, 'final ' + id)];
  write(...records('first', 'exec'), ...records('agent', 'exec', '/root/child'), ...records('scheduled', 'cron'), launch('now', 'exec'));
  assert.deepEqual(read(1), [{ user: 'typed first', assistant: 'final first' }]);
});

test('returns newest whole exchanges within the UTF-8 byte budget', t => {
  const { read, write } = fixture(t);
  write(...exchange('a', 'secret past budget', 'x'.repeat(MAX_HISTORY_BYTES - 2)), ...exchange('b', 'q', '中'.repeat(Math.floor(MAX_HISTORY_BYTES / 3) - 1)),
    ...exchange('c', 'q', 'newest'), start('now'));
  assert.deepEqual(read(Number.MAX_SAFE_INTEGER), [{ user: 'q', assistant: 'newest' }]);
});

test('reads recent turns in large files, rejects malformed or special files', t => {
  const { read, write, file } = fixture(t);
  write(start('older'), user('too old'), { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'X'.repeat(MAX_SCAN_BYTES) } },
    ...exchange('a', 'q', 'answer'), start('now'));
  assert.deepEqual(read(), [{ user: 'q', assistant: 'answer' }]);
  const args = ['--session-id', 's', '--transcript', file, '--turn-id', 'now'];
  assert.deepEqual(json(run(script, args)), read());
  assert.deepEqual(json(run(script, [...args, '--turns', '0'])), []);
  fs.symlinkSync(file, file + '.link');
  assert.deepEqual(readHistory(file + '.link', 's', 'now'), []);
  fs.unlinkSync(file);
  mkfifo(file);
  assert.deepEqual(read(), []);
});

test('rollback and fork never cross thread history', t => {
  const { read, write, meta } = fixture(t), seen = exchange('a', 'q', 'answer');
  write(...seen, event('thread_rolled_back', { num_turns: 1 }), start('now'));
  assert.deepEqual(read(), []);
  write(...seen, { type: 'session_meta', payload: { id: 'other' } }, start('now'));
  assert.deepEqual(read(), []);
  meta.payload.forked_from_id = 'other';
  write(...seen, start('now'));
  assert.deepEqual(read(), []);
});
