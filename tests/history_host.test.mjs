import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isCurrentTurn, readHistory, readPreviousReply } from '../plugins/codex-polish/hooks/history.mjs';
import { temporary } from './hook_fixture.mjs';

function rollout(t) {
  const file = path.join(temporary(t), 'rollout.jsonl');
  return { file, write: (...rows) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join('')) };
}

const meta = (id, parent, extra = {}) => ({ type: 'session_meta', payload: { id, forked_from_id: parent, ...extra } });
const event = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields } });
const start = (turn_id, trigger = 'composer') => event('task_started', { turn_id, turn_attribution: { turn_trigger: trigger } });
const user = message => event('user_message', { message });
const answer = message => event('agent_message', { phase: 'final_answer', message });
const complete = (turn_id, last_agent_message) => event('task_complete', { turn_id, last_agent_message });
const abort = turn_id => event('turn_aborted', { turn_id, reason: 'interrupted' });
const rollback = num_turns => event('thread_rolled_back', { num_turns });
const exchange = id => [start(id), user('question ' + id), answer(id), complete(id, id)];
const pair = id => ({ user: 'question ' + id, assistant: id });

test('a copied fork selects the outermost thread and preserves its inherited visible turns', t => {
  const { file, write } = rollout(t);
  for (const ancestors of [[meta('parent')], [meta('parent', 'root'), meta('root')]]) {
    // thread/fork prepends the child header to the entire copied rollout.
    write(meta('child', 'parent'), ...ancestors, ...exchange('inherited'), ...exchange('discarded'), rollback(1),
      ...exchange('local'), start('now'));
    assert.deepEqual(readHistory(file, 'child', 'now'), [pair('inherited'), pair('local')]);
    assert.deepEqual(readPreviousReply(file, 'child', 'now', 0, 2), { selection: 'inherited' });
    assert.equal(isCurrentTurn(file, 'child', 'now'), true);
    for (const { payload: { id } } of ancestors) {
      assert.equal(isCurrentTurn(file, id, 'now'), false);
      assert.equal(readPreviousReply(file, id, 'now'), null);
      assert.deepEqual(readHistory(file, id, 'now'), []);
    }
  }
});

test('only accepts contiguous matching user fork headers, including across rollback replay', t => {
  const { file, write } = rollout(t);
  for (const prefix of [
    [meta('child'), meta('other')],
    [meta('child', 'parent'), meta('other')],
    [meta('child', 'parent'), meta('parent', 'child')],
    [meta('child', 'parent'), meta('parent', 'root'), meta('parent')],
    [meta('child', 'parent'), meta('parent', undefined, { source: { subagent: 'review' } })],
    [meta('child', 'parent'), meta('parent', undefined, { thread_source: 'automation' })],
    [meta('child', 'parent'), ...exchange('early'), meta('parent')],
    [meta('child', 'parent'), ...exchange('early'), rollback(1), ...exchange('late'), meta('parent'), rollback(1)],
  ]) {
    write(...prefix, ...exchange('local'), start('now'));
    assert.equal(isCurrentTurn(file, 'child', 'now'), false);
    assert.deepEqual(readHistory(file, 'child', 'now'), []);
  }
});

test('rollback counts every explicitly opened host turn, including empty and interrupted turns', t => {
  const { file, write } = rollout(t);
  const prefix = [meta('thread'), ...exchange('first'), ...exchange('second')];
  for (const last of [
    [start('empty'), complete('empty', null)],
    [start('empty'), abort('empty')],
    [start('scheduled', 'cron'), answer('scheduled'), complete('scheduled', 'scheduled')],
    [start('tool'), { type: 'response_item', payload: { type: 'function_call_output', output: 'tool output' } }],
  ]) {
    for (const [count, survivors] of [[1, ['first', 'second']], [2, ['first']], [3, []]]) {
      write(...prefix, ...last, rollback(count), start('now'));
      assert.deepEqual(readHistory(file, 'thread', 'now'), survivors.map(pair));
      assert.equal(readPreviousReply(file, 'thread', 'now')?.selection, survivors.at(-1));
    }
  }
});

test('resumes combine surviving input for a reply but each host start counts independently for rollback', t => {
  const { file, write } = rollout(t);
  const initial = [meta('thread'), ...exchange('older'), start('input'), user('Original question.'), abort('input')];
  const resumed = [start('resume', 'resume_interrupted_task'), user('More detail.'), answer('Reply.'), complete('resume', 'Reply.')];
  write(...initial, ...resumed, start('empty'), complete('empty', null), rollback(1), start('now'));
  assert.deepEqual(readHistory(file, 'thread', 'now'), [pair('older'), { user: 'Original question.\n\nMore detail.', assistant: 'Reply.' }]);
  write(...initial, ...resumed, rollback(2), start('now'));
  assert.deepEqual(readHistory(file, 'thread', 'now'), [pair('older')]);
  write(...initial, ...resumed, rollback(1), start('another', 'resume_interrupted_task'), answer('New reply.'),
    complete('another', 'New reply.'), start('now'));
  assert.deepEqual(readHistory(file, 'thread', 'now'), [pair('older'), { user: 'Original question.', assistant: 'New reply.' }]);
});
