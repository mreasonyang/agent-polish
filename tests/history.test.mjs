import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporary, plugin, run, json, mkfifo } from './hook_fixture.mjs';
import { readHistory, readPreviousReply } from '../plugins/codex-polish/hooks/history.mjs';
import { formatReply, originalReplyText } from '../plugins/codex-polish/skills/codex-polish/scripts/format_reply.mjs';

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

test('skips attachments and unattributed or host-generated messages based on provenance', t => {
  const { read, write } = fixture(t);
  const host = message('user', '<environment_context>system input</environment_context>', {internal_chat_message_metadata_passthrough: {
    content_item_kinds:['environments.environment_context'], content_item_metadata:[{provenance:{type:'harness'}}],
  }});
  for (const item of [host, message('user', 'unattributed'), event('user_message', { message: '', local_images: ['/my/path'] })]) {
    write(start('one'), item, final('answer'), finish('one', 'answer'), start('now'));
    assert.deepEqual(read(), []);
  }
});

test('text survives moderation metadata, extra provenance keys and mixed attachments without sending attachment data', t => {
  const { read, write, file } = fixture(t);
  const textWithAttachment = event('user_message', { message: 'caption', local_images: ['/private'], audio_references: ['private-audio'] });
  const typedMixed = message('user', '', {
    content: [{ type: 'input_image', image_url: 'private-image' }, { type: 'input_text', text: 'caption' }, { type: 'input_text', text: 'injected' }],
    internal_chat_message_metadata_passthrough: {
      turn_id: 'one', content_item_kinds: ['user.image', 'user.text', 'host.text'],
      content_item_metadata: [{ provenance: { type: 'user' } }, { provenance: { type: 'user', client: 'desktop' }, extra: true }, { provenance: { type: 'harness' } }],
    },
  });
  for (const input of [textWithAttachment, typedMixed]) {
    const annotated = event('agent_message', { phase: 'final_answer', message: 'visible', moderation: { flagged: false } });
    const mixedAnswer = message('assistant', '', { phase:'final_answer', content:[
      { type:'output_text', text:'visible' }, { type:'image', data:'attachment-only' },
    ]});
    for (const finals of [[annotated], [annotated, mixedAnswer], [mixedAnswer, annotated]]) {
      write(start('one'), input, ...finals, finish('one', 'visible'), start('now'));
      assert.deepEqual(read(), [{ user: 'caption', assistant: 'visible' }]);
      assert.deepEqual(readPreviousReply(file, 's', 'now'), { selection: 'visible' });
    }
  }
});

test('keeps an actual user’s text and the final answer regardless of what they quote', t => {
  const { read, write, file } = fixture(t);
  for (const literal of ['Subagent completed: worker', '<environment_context>an example</environment_context>',
    '# Context from my IDE setup:\nexample', 'password=fixture-secret', 'key\x1b[1m']) {
    for (const item of [user(literal), typed('one', literal)]) {
      write(start('one'), item, final(literal), finish('one', literal), start('now'));
      assert.deepEqual(read(), [{user:literal, assistant:literal}]);
      assert.deepEqual(readPreviousReply(file, 's', 'now'), { selection: literal });
    }
  }
});

test('takes recent completed turns in order without backfill', t => {
  const { read, write } = fixture(t);
  write(...exchange('a', 'qA', 'aA'), ...exchange('b', 'qB', 'aB'),
    start('c'), event('user_message', {message:'qC', images:['attachment']}), final('aC'), finish('c', 'aC'),
    ...exchange('d', 'qD', 'aD'), start('aborted'), user('not answered'), event('turn_aborted', { turn_id: 'aborted' }), start('now'));
  assert.deepEqual(read(3), ['B','C','D'].map(s => ({user:'q' + s, assistant:'a' + s})));
  assert.deepEqual(read(), ['C','D'].map(s => ({user:'q' + s, assistant:'a' + s})));
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

test('includes the requested complete exchanges even when their UTF-8 text exceeds 16 KiB', t => {
  const { read, write } = fixture(t);
  const first = { user: 'qA', assistant: 'x'.repeat(17000) };
  const second = { user: 'qB', assistant: '中'.repeat(17000) };
  write(...exchange('a', first.user, first.assistant), ...exchange('b', second.user, second.assistant), start('now'));
  assert.deepEqual(read(2), [first, second]);
});

test('desktop composer and interrupted resumes keep all typed questions once in one exchange', t => {
  const { write, read, file } = fixture(t);
  const launch = (id, trigger) => event('task_started', { turn_id: id, root_turn_id: id,
    turn_attribution: { turn_id: id, root_turn_id: id, turn_trigger: trigger, parent_turn_id: null, initiating_agent_path: null } });
  const abort = (turn_id, reason = 'interrupted') => event('turn_aborted', { turn_id, reason });
  const past = exchange('p', 'old', 'reply');
  const initial = [launch('a', 'composer'), typed('a', '第一句'), user('第一句'), user('补充 A'), abort('a')];
  const followup = [launch('b', 'resume_interrupted_task'), typed('b', '补充 B'), abort('b'), launch('c', 'resume_interrupted_task')];
  write(...past, ...initial, ...followup);
  // The submit hook can point to the original composer turn throughout a resume.
  assert.deepEqual(readHistory(file, 's', 'a', 1), [{ user: 'old', assistant: 'reply' }]);
  write(...past, ...initial, ...followup, final('完整答复'), finish('c', '完整答复'), launch('now', 'composer'));
  assert.deepEqual(read(1), [{ user: '第一句\n\n补充 A\n\n补充 B', assistant: '完整答复' }]);
  for (const [previous, current] of [
    [[launch('a', 'composer'), typed('a', 'discard'), abort('a', 'cancelled')], 'resume_interrupted_task'],
    [initial, 'composer'],
    [[...initial, launch('agent', 'cron'), abort('agent')], 'resume_interrupted_task'],
  ]) {
    write(...past, ...previous, launch('new', current), typed('new', 'fresh'), final('ok'), finish('new', 'ok'), launch('now', 'composer'));
    assert.deepEqual(read(1), [{ user: 'fresh', assistant: 'ok' }]);
  }
});

test('reads recent turns in large files, rejects malformed or special files', t => {
  const { read, write, file } = fixture(t);
  write(...exchange('old', 'older', 'answer before large tool result'), start('tool-only'), { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'X'.repeat(5 * 1024 * 1024) } },
    ...exchange('a', 'q', 'answer'), start('now'));
  assert.deepEqual(read(), [{ user: 'older', assistant: 'answer before large tool result' }, { user: 'q', assistant: 'answer' }]);
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
  assert.deepEqual(read(), [{user:'q', assistant:'answer'}]);
  meta.payload.source = { subagent: {} };
  write(...seen, start('now'));
  assert.deepEqual(read(), []);
});

test('successive rollbacks retain the surviving prefix, including text outside the former history window', t => {
  const { read, write, file } = fixture(t);
  const roll = num_turns => event('thread_rolled_back', { num_turns });
  const rows = n => exchange(String(n), 'q' + n, 'a' + n);
  write(...Array.from({length:15}, (_,i) => rows(i)).flat(), roll(10), ...rows(15), ...rows(16),
    start('incomplete'), user('withdrawn'), event('turn_aborted', {turn_id:'incomplete',reason:'cancelled'}), roll(2),
    ...rows(17), roll(3), ...rows(18), start('now'));
  assert.deepEqual(read(10).map(x => x.assistant), ['a0','a1','a2','a3','a18']);
  assert.deepEqual(readPreviousReply(file,'s','now',2,2), { selection: 'a3' });
});

test('a verified whole reply uses its question and draft and only the turns before it', t => {
  const { file, write } = fixture(t);
  const turns = Array.from({ length: 14 }, (_, i) => ({ user: 'question ' + i, assistant: 'answer ' + i }));
  const lookupOrigin = turnIds => ({ origin: [...turnIds][0], literal: true, label: 'quoted' });
  const previous = (count, turnsBack) => readPreviousReply(file, 's', 'now', count, turnsBack, { lookupOrigin });
  write(...turns.flatMap(({ user, assistant }, i) => exchange(String(i), user, assistant)), start('now'), user('Try again with Gemini.'));
  assert.deepEqual(previous(0), { question: 'question 13', draft: 'answer 13', source_label: 'quoted', origin_turn_id: '13', history: [] });
  assert.deepEqual(previous(10, 3), { question: 'question 11', draft: 'answer 11', source_label: 'quoted', origin_turn_id: '11', history: turns.slice(1, 11) });
  assert.deepEqual(previous(10, 14), { question: 'question 0', draft: 'answer 0', source_label: 'quoted', origin_turn_id: '0', history: [] });
  assert.equal(previous(10, 15), null);
  assert.equal(previous(10, Number.MAX_SAFE_INTEGER), null);
  assert.equal(previous(2, 0), null);
  assert.equal(readPreviousReply(file, 's', 'stale', 2), null);
  assert.equal(readPreviousReply(file, 'another', 'now', 2), null);
  write(start('now'), user('No earlier replies.'));
  assert.equal(previous(2), null);
});

test('previous rewrite extracts the displayed GPT original in either language, including quoted disclosures', t => {
  const { file, write } = fixture(t);
  for (const lang of ['zh', 'en']) {
    for (const draft of [
      'Plain original, with an intentional ending.\n',
      'The example contains markup.\r\n<details><summary>Demo</summary>\r\n\r\n\n> Example\n</details>\n\n```\n:::',
    ]) for (const candidate of ['Gemini supplied different text.', draft]) {
      const display = formatReply({ draft, candidate, display_language: lang }).display_text;
      write(...exchange('old', 'Earlier question.', 'Earlier answer.'), ...exchange('selected', 'Original question.', display),
        start('now'), user('Have Gemini rewrite the last reply.'));
      assert.deepEqual(readPreviousReply(file, 's', 'now', 1), { selection: candidate });
      assert.equal(readPreviousReply(file, 's', 'now', 1, 1, { requireGpt: true }), null);
      const receipt = () => ({ label: 'gpt', origin: 'selected', literal: false });
      assert.deepEqual(readPreviousReply(file, 's', 'now', 1, 1, { lookupOrigin: receipt }), {
        question: 'Original question.', draft, source_label: 'gpt', origin_turn_id: 'selected', history: [{ user: 'Earlier question.', assistant: 'Earlier answer.' }],
      });
    }
  }
});

test('the next rewrite uses the original body after a Normal decision or a service failure', () => {
  const draft = 'The browser reuses a cached copy.\n';
  for (const notice of ['**未润色** · OpenAI 判断原稿已经清楚。', '**Polishing skipped** · Gemini was unavailable.']) {
    assert.equal(originalReplyText(notice + ' <!-- codex-polish -->\n\n' + draft), draft);
  }
});

test('a title inside an ordinary answer and ambiguous chart text both remain available for rewriting', t => {
  const { file, write } = fixture(t);
  const sentence = '**Gemini 润色版** 是界面里的标题。';
  write(...exchange('one', 'What does the heading mean?', sentence), start('now'));
  assert.deepEqual(readPreviousReply(file, 's', 'now'), { selection: sentence });
  const full = '**Polished by Gemini**\n\nThis example has no disclosure.';
  write(...exchange('one', 'Show me the wording.', full), start('now'));
  assert.deepEqual(readPreviousReply(file, 's', 'now'), { selection: full });
  const original = 'Here is the chart.\n\n\uE200visualize\uE202{"path":"/tmp/example.html"}\uE201';
  const display = formatReply({ draft: original, candidate: 'See the chart below.', display_language: 'en' }).display_text;
  write(...exchange('one', 'Show the chart.', display), start('now'));
  const lookupOrigin = () => ({ origin: 'one', label: 'gpt', literal: false });
  assert.equal(readPreviousReply(file, 's', 'now', 1, 1, { lookupOrigin }).draft, original);
  assert.equal(readPreviousReply(file, 's', 'now', 1, 1, { lookupOrigin, requireGpt: true }).draft, original);
  assert.deepEqual(readPreviousReply(file, 's', 'now', 1), { selection: 'See the chart below.' });
  for (const originalText of [original + '\n&#xE200; &amp;#xE201; &#xE202;', original + '\n<details>\n&amp;amp;#xE200;']) {
    const formatted = formatReply({draft:originalText, candidate:'Visible.', display_language:'zh'}).display_text;
    assert.equal(originalReplyText(formatted), originalText);
  }
});

test('the formatter labels user-selected source neutrally and preserves it for later rewrites', () => {
  const script = path.join(plugin, 'skills/codex-polish/scripts/format_reply.mjs');
  for (const [lang, summary, unchanged] of [['zh', '查看原文', 'Gemini 返回了原文'], ['en', 'View original text', 'Gemini returned the original text']]) {
    for (const draft of ['A user-selected excerpt.', 'A quoted example.\n\n<details>\n:::']) {
      const input = { draft, candidate: 'Rewritten excerpt.', display_language: lang, source_label: 'quoted' };
      const { display_text } = json(run(script, [], { input: JSON.stringify(input) }));
      assert.ok(display_text.includes(summary));
      assert.ok(!display_text.includes('GPT'));
      assert.equal(originalReplyText(display_text), draft);
      const same = formatReply({ ...input, candidate: draft });
      assert.equal(same.display_text, `**${unchanged}** <!-- codex-polish -->\n\n${draft}`);
      assert.equal(originalReplyText(same.display_text), draft);
    }
  }
  const badLabel = run(script, [], { input: JSON.stringify({ draft: 'Source.', candidate: 'Result.', source_label: 'unknown' }) });
  assert.notEqual(badLabel.status, 0);
  assert.equal(badLabel.stdout, '');
});

test('unavailable targets never silently select an older answer', t => {
  const { file, write, meta } = fixture(t);
  const before = exchange('earlier', 'Earlier question.', 'Earlier answer.');
  const lookupOrigin = turnIds => ({ origin: [...turnIds][0], literal: true, label: 'quoted' });
  const previous = (turnsBack = 1) => readPreviousReply(file, 's', 'now', 2, turnsBack, { lookupOrigin });
  for (const target of [
    [start('x'), event('user_message', { message: '', images: ['attachment'] }), final('Reply.'), finish('x', 'Reply.')],
    [start('x'), message('user', 'Unattributed material.'), final('Reply.'), finish('x', 'Reply.')],
    [start('x'), user('Question.'), final('Reply.'), finish('x', 'Changed after completion.')],
    [start('x'), user('Question.'), final('Reply.'), finish('x', null)],
  ]) {
    write(...before, ...target, start('now'));
    assert.equal(previous(), null);
    write(...before, ...target, ...exchange('latest', 'Another question.', 'Another answer.'), start('now'));
    assert.equal(previous(2), null);
    assert.deepEqual(previous().history[0], { user: 'Earlier question.', assistant: 'Earlier answer.' });
  }
  write(...before, event('thread_rolled_back', { num_turns: 1 }), start('now'));
  assert.equal(previous(), null);
  meta.payload.forked_from_id = 'other';
  write(...before, start('now'));
  assert.equal(previous().draft, 'Earlier answer.');
});
