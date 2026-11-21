import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { windowsSystemTool } from '../plugins/codex-polish/hooks/platform.mjs';
import { makeProject, run, preferences, plugin, json, windows } from './hook_fixture.mjs';

const SESSION = '877b05ee-93ac-4a48-abaa-493236a9a2d2', OTHER = '4c7e8db6-5efb-417b-9193-57e8bc405314';
const prefURL = new URL('../plugins/codex-polish/hooks/preferences.mjs', import.meta.url).href;
const cacheURL = new URL('../plugins/codex-polish/hooks/recovery.mjs', import.meta.url).href;
function fixture(t) {
  const project = makeProject(t);
  fs.mkdirSync(project.settings, { recursive: true });
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
  if (!windows) assert.equal(fs.statSync(db).mode & 0o077, 0);
  const data = fs.readFileSync(db);
  assert.ok(!data.includes('a private user message') && !data.includes('synthetic private conversation'));
});

test('source matches current thread, profile, and exact cwd', t => {
  const { hook, source, home, cwd } = fixture(t);
  hook();
  assert.equal(source({}, cwd), null);
  assert.equal(source({ CODEX_HOME: path.join(home, 'different profile') }), null);
  for (const id of [OTHER, '']) assert.equal(source({ CODEX_THREAD_ID: id, CODEX_SESSION_ID: SESSION }), null);
  assert.equal(hook({ turn_id: 'child', agent_id: OTHER }), '');
  assert.equal(hook({ turn_id: 'child', agent_type: 'worker' }), '');
  assert.equal(hook({ turn_id: 'child' }, { CODEX_THREAD_ID: OTHER }), '');
  assert.match(hook({ session_id: undefined }, { CODEX_THREAD_ID: OTHER }), /additionalContext/);
  assert.equal(source().turn_id, 'turn-1');
  const otherTranscript = path.join(home, 'other-transcript.jsonl');
  hook({ cwd, transcript_path: otherTranscript, turn_id: 'other-folder' });
  assert.deepEqual(source({}, cwd), { session_id: SESSION, turn_id: 'other-folder', transcript_path: otherTranscript });
  assert.equal(source().turn_id, 'turn-1');
});

test('invalid source and disabled profile revoke stored metadata', t => {
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
  const { project, env, hook, source, transcript, database, call } = fixture(t);
  json(call(['set-history-turns', '0']));
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
  assert.deepEqual(json(previous()), { selection: 'Second GPT answer.' });
  assert.deepEqual(json(previous('--turns-back', '2')), { selection: 'First GPT answer.' });
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
  if (windows) execFileSync(windowsSystemTool('icacls.exe'), [file, '/grant', '*S-1-1-0:(R)']);
  else fs.chmodSync(file, 0o644);
  assert.equal(source(), null);
  assert.match(hook(), /additionalContext/);
  if (windows) execFileSync(windowsSystemTool('icacls.exe'), [file, '/remove:g', '*S-1-1-0']);
  else fs.chmodSync(file, 0o600);
  sql('UPDATE history_source SET updated=0');
  assert.equal(source(), null);
  hook({ session_id: OTHER });
  assert.deepEqual(sql('SELECT session FROM history_source'), [{ session: OTHER }]);
});

function conversation(t) {
  const { project, env, transcript, hook, database, sql, call } = fixture(t);
  const scripts = path.join(plugin, 'skills/codex-polish/scripts');
  const options = { env: { ...env, CODEX_THREAD_ID: SESSION } };
  fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: SESSION } }) + '\n');
  let turn;
  const append = (type, fields) => fs.appendFileSync(transcript, JSON.stringify({ type: 'event_msg', payload: { type, ...fields } }) + '\n');
  function begin(id, question) {
    turn = id;
    append('task_started', { turn_id: id });
    append('user_message', { message: question });
    return hook({ turn_id: id, prompt: question });
  }
  function end(text) {
    append('agent_message', { phase: 'final_answer', message: text });
    append('task_complete', { turn_id: turn, last_agent_message: text });
  }
  function display(input, ...flags) {
    const result = json(run(path.join(scripts, 'format_reply.mjs'), ['--cwd', project, ...flags], { ...options, input: JSON.stringify(input) }));
    return result.display_text ?? result.text;
  }
  const previous = (back = 1, ...flags) => run(path.join(scripts, 'previous_reply.mjs'), ['--cwd', project, '--turns-back', String(back), ...flags], options);
  function gemini(target, back) {
    const url = new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_payload.mjs', import.meta.url);
    const code = `import {promptFrame} from ${JSON.stringify(url.href)};
      const input = JSON.parse(process.argv[2]);
      let scope = {};
      if (Object.hasOwn(input, 'selection')) scope = { selection: true };
      else if (process.argv[3] !== '') scope = { turnsBack: Number(process.argv[3]) };
      const frame = await promptFrame(input, process.argv[1], { trigger: 'explicit', ...scope });
      console.log(frame.params.prompt[0].text);`;
    return json(run('--input-type=module', ['-e', code, project, JSON.stringify({ sessionId: 'fixture', ...target }), String(back ?? '')], options));
  }
  const zeroHistory = () => json(call(['set-history-turns', '0']));
  return { begin, end, display, gemini, previous, database, sql, zeroHistory, options };
}

test('successive rewrites of an earlier comparison use its original question, source label and preceding history', t => {
  const { begin, end, display, previous, database, gemini, zeroHistory, options } = conversation(t);
  const draft = 'The browser can reuse the old image.';
  const target = { question: 'Why is my avatar stale?', draft };
  const before = { user: 'A separate question with the same answer.', assistant: draft };
  begin('before', before.user);
  end(before.assistant);
  begin('original', target.question);
  end(display({ draft, candidate: 'Your old avatar is cached.', display_language: 'en' }));
  begin('intervening', 'An unrelated question also has the same answer.');
  end(draft);
  begin('rewrite', 'Reword the avatar reply.');
  assert.deepEqual(json(previous(2)), { ...target, source_label: 'gpt' });
  const output = display({ ...target, candidate: 'Your browser kept the earlier image.', display_language: 'zh' }, '--turns-back', '2');
  assert.match(output, /查看 GPT 原稿/);
  end(output);
  const reminder = JSON.parse(begin('twice', '重写')).hookSpecificOutput.additionalContext;
  assert.match(reminder, /--trigger explicit\b/);
  assert.doesNotMatch(reminder, /--trigger auto\b/);
  assert.deepEqual(json(previous()), { ...target, source_label: 'gpt' });
  assert.deepEqual(gemini(target, 1), { ...target, history: [before] });

  zeroHistory();
  assert.deepEqual(gemini(target, 1), target);
  const skipped = display({ ...target, reason: 'Service unavailable.', display_language: 'en' }, '--turns-back', '1', '--skipped');
  end(skipped);
  begin('three', 'Rewrite again.');
  assert.deepEqual(json(previous()), { ...target, source_label: 'gpt' });
  assert.deepEqual(gemini(target, 1), target);
  const bytes = fs.readFileSync(database());
  for (const content of [draft, target.question, 'Your old avatar is cached.', 'Service unavailable.']) assert.ok(!bytes.includes(content));
  assert.equal(json(run('--input-type=module', ['-e', `import {removeProfileCache} from ${JSON.stringify(cacheURL)}; console.log(JSON.stringify(removeProfileCache()));`], options)), null);
});

test('bare, body-only and detached quoted sources keep neutral attribution', t => {
  const { begin, end, display, previous } = conversation(t);
  const draft = 'An ordinary-looking answer.';
  const question = 'What happened?';
  begin('first', question);
  end(display({ draft, candidate: draft }));
  begin('shorten', 'Shorten the previous reply.');
  assert.deepEqual(json(previous()), { question, draft, source_label: 'quoted' });
  const candidate = '**Polishing skipped** · A heading inside Gemini’s text.\n\nKeep this line.';
  end(display({ question, draft, candidate }, '--turns-back', '1'));
  begin('again', 'Rephrase that.');
  assert.deepEqual(json(previous()), { question, draft: candidate, source_label: 'quoted' });
  const neutral = display({ question, draft: candidate, candidate: 'A new rewrite.', source_label: 'gpt', display_language: 'en' }, '--turns-back', '1');
  assert.ok(neutral.includes('View original text') && !neutral.includes('GPT'));
  end(neutral);
  begin('quote', 'Use just the selected sentence.');
  assert.deepEqual(json(previous()), { question, draft: candidate, source_label: 'quoted' });
  const quotation = display({ draft, candidate: draft, source_label: 'gpt', display_language: 'zh' }, '--trigger', 'explicit', '--selection');
  assert.equal(quotation, 'Gemini 返回了原文。\n\n' + draft);
  end(quotation);
  begin('next', 'Again.');
  assert.deepEqual(json(previous()), { selection: draft });
  assert.equal(previous(1,'--require-gpt').status, 1);
});

for (const [status, notice] of [
  ['skipped', 'Service unavailable.'],
  ['unchanged', 'Gemini returned the original draft.'],
]) {
  test(`history strips a plain ${status} notice only with a matching formatted delivery`, t => {
    const { begin, end, display, previous, gemini } = conversation(t);
    const question = 'What happened to my request?';
    const draft = 'Your request was saved.\n';
    begin('generated', question);
    const formatted = status === 'skipped'
      ? display({ draft, reason: 'Service unavailable.', display_language: 'en' }, '--skipped')
      : display({ draft, candidate: draft, display_language: 'en' }, '--trigger', 'explicit');
    assert.equal(formatted, notice + '\n\n' + draft);
    end(formatted);

    const literalQuestion = 'Quote the entire example.';
    begin('literal', literalQuestion);
    assert.deepEqual(json(previous(1, '--require-gpt')), { question, draft, source_label: 'gpt', turns_back: 1 });
    end(display({ draft: formatted, candidate: formatted }, '--selection'));

    const ordinaryQuestion = 'Type the same example.';
    begin('ordinary', ordinaryQuestion);
    assert.deepEqual(json(previous()), { selection: formatted });
    assert.equal(previous(1, '--require-gpt').status, 1);
    assert.deepEqual(gemini({ question: ordinaryQuestion, draft: formatted }).history, [
      { user: question, assistant: draft }, { user: literalQuestion, assistant: formatted },
    ]);
    end(formatted);

    const next = { question: 'Review the example.', draft: 'The example is complete.' };
    begin('review', next.question);
    assert.deepEqual(json(previous()), { selection: formatted });
    assert.equal(previous(1, '--require-gpt').status, 1);
    assert.deepEqual(gemini(next).history, [
      { user: literalQuestion, assistant: formatted }, { user: ordinaryQuestion, assistant: formatted },
    ]);
  });
}

test('automatic keep, identical rewrite and failure retain a GPT draft that itself looks like a comparison', t => {
  const { begin, end, display, previous, gemini } = conversation(t);
  const draft = 'Example foreground.\n\n<details><summary>Rewritten by Gemini · View original text</summary>\n\nExample fold.\n\n</details>';
  for (const [status, fields, flags] of [
    ['keep', {}, ['--kept']],
    ['identical', { candidate: draft }, []],
    ['failure', { reason: 'Gemini was unavailable.' }, ['--skipped']],
  ]) {
    const question = 'Show the comparison syntax for ' + status + '.';
    begin(status, question);
    const output = display({ draft, display_language: 'en', ...fields }, '--trigger', 'auto', ...flags);
    assert.equal(output, status === 'failure' ? fields.reason + '\n\n' + draft : draft);
    end(output);
    const followup = { question: 'What did I receive?', draft: 'You received the original example.' };
    begin(status + '-next', followup.question);
    assert.deepEqual(json(previous(1, '--require-gpt')), { question, draft, source_label: 'gpt', turns_back: 1 });
    assert.deepEqual(gemini(followup).history.at(-1), { user: question, assistant: draft });
    end(followup.draft);
  }
});

test('a comparison receipt preserves an old marked status quoted at the beginning of Gemini’s rewrite', t => {
  const { begin, end, display, previous, gemini, sql } = conversation(t);
  const question = 'Show the historical status text.';
  const draft = 'The old layout had a status heading.';
  const heading = '**Polishing skipped** · Example only. <!-- codex-polish -->';
  const candidate = heading + '\n\nThis is how the heading looked.';
  begin('sample', question);
  const shown = display({ draft, candidate, display_language: 'en' });
  end(shown);
  const followup = { question: 'Which part was rewritten?', draft: 'The explanation was rewritten.' };
  begin('next', followup.question);
  assert.deepEqual(json(previous(1, '--require-gpt')), { question, draft, source_label: 'gpt', turns_back: 1 });
  assert.deepEqual(gemini(followup).history, [{ user: question, assistant: candidate }]);

  // Older installations used 0 for all formatted deliveries. The same visible
  // bytes then represent a status followed by a literal comparison example.
  sql('UPDATE reply_origin SET literal=0');
  const literalExample = shown.slice(heading.length + 2);
  assert.deepEqual(json(previous(1, '--require-gpt')), { question, draft: literalExample, source_label: 'gpt', turns_back: 1 });
  assert.deepEqual(gemini(followup).history, [{ user: question, assistant: literalExample }]);
});

test('changed delivery, a stale formatter target or an expired reference cannot attach another question', t => {
  const { begin, end, display, previous, sql } = conversation(t);
  const draft = 'Shared answer.';
  begin('one', 'First question.');
  display({ draft, candidate: 'Expected answer.', display_language: 'en' });
  end('Replacement the user actually saw.');
  begin('two', 'Second question.');
  assert.deepEqual(json(previous()), { selection: 'Replacement the user actually saw.' });
  end(draft);
  begin('three', 'Reword it.');
  const ambiguous = display({ question: 'A different question.', draft, candidate: 'Complete result.', display_language: 'en' }, '--turns-back', '1');
  assert.match(ambiguous, /Complete result\./);
  assert.match(ambiguous, /View original text/);
  end(ambiguous);
  begin('four', 'Again.');
  assert.deepEqual(json(previous()), { selection: 'Complete result.' });
  const visible = display({ draft, candidate: 'Expected answer.', display_language: 'en' });
  end(visible);
  begin('five', 'Again.');
  assert.equal(json(previous()).source_label, 'gpt');
  sql('UPDATE reply_origin SET updated=0');
  assert.deepEqual(json(previous()), { selection: 'Expected answer.' });
  assert.equal(previous(1, '--require-gpt').status, 1);
});

test('rewriting a displayed selection or expired comparison submits only its visible candidate', t => {
  const { begin, end, display, previous, gemini, sql } = conversation(t);
  const draft = 'Folded draft that should stay out of this request.';
  const candidate = '**Polished by Gemini**\n\nThe heading is part of the actual paragraph.';
  begin('one', 'Only edit this passage.');
  end(display({ draft, candidate, display_language: 'en' }, '--selection'));
  begin('two', 'Rewrite the last reply.');
  for (const expire of [false,true]) {
    if (expire) sql('UPDATE reply_origin SET updated=0');
    const selected = json(previous());
    assert.deepEqual(selected, {selection:candidate});
    assert.deepEqual(gemini(selected), {draft:candidate});
    assert.notEqual(previous(1, '--require-gpt').status, 0);
  }
  const current = {question:'Rewrite the last reply.', draft:'A separate answer.'};
  end(display({ ...current, candidate:'A revision.', display_language:'en' }));
  begin('three', 'Repeat.');
  assert.deepEqual(gemini(current, 1).history, [{user:'Only edit this passage.',assistant:candidate}]);
});

test('a body-only selection never acquires a question or history when its delivery record expires or disappears', t => {
  const { begin, end, display, previous, gemini, sql } = conversation(t);
  begin('context', 'Private earlier question.');
  end('Private earlier reply.');
  begin('selection', 'Edit only the excerpt. Private surrounding instructions.');
  const candidate = 'Rewritten excerpt.';
  end(display({ draft: 'Original excerpt.', candidate }, '--selection'));
  begin('again', 'Rewrite the last reply.');
  function check() {
    const selected = json(previous());
    assert.deepEqual(selected, { selection: candidate });
    assert.deepEqual(gemini(selected), { draft: candidate });
    assert.equal(previous(1, '--require-gpt').status, 1);
  }
  check();
  sql('UPDATE reply_origin SET updated=0');
  check();
  sql('DELETE FROM reply_origin');
  check();
});

for (const [layout, example] of [
  ['headed', '**Polished by Gemini**\n\nExample foreground.\n\n<details><summary>View original text</summary>\n\nExample fold.\n\n</details>'],
  ['headerless', 'Example foreground.\n\n<details><summary>Rewritten by Gemini · View original text</summary>\n\nExample fold.\n\n</details>'],
]) {
  test(`a body-only selection reproducing a ${layout} comparison stays literal in retrieval and ACP history`, t => {
    const { begin, end, display, previous, gemini } = conversation(t);
    const question = 'Give me the comparison syntax verbatim.';
    begin('example', question);
    const output = display({ draft: 'Show the syntax.', candidate: example }, '--selection', '--trigger', 'explicit');
    assert.equal(output, example);
    end(output);
    begin('second', 'Explain the layout.');
    const selected = json(previous());
    assert.deepEqual(selected, { selection: example });
    assert.deepEqual(gemini(selected), { draft: example });
    assert.equal(previous(1, '--require-gpt').status, 1);
    const target = { question: 'Explain the layout.', draft: 'The layout is vertical.' };
    const history = [{ user: question, assistant: example }];
    assert.deepEqual(gemini(target), { ...target, history });
    end(display({ ...target, candidate: 'The sections stack.', display_language: 'en' }));
    begin('third', 'Rewrite the explanation.');
    assert.deepEqual(gemini(target, 1), { ...target, history });
  });
}

test('locally recovered GPT text preserves the original code indentation and CRLF', t => {
  const { begin, end, display, previous } = conversation(t);
  const question = 'Show me the example.';
  const draft = '    example();\r\n    next();  \r\n';
  begin('example', question);
  end(display({ draft, candidate: draft.trim().replaceAll('\r\n', '\n'), display_language: 'en' }));
  begin('recover', 'Show me the original GPT draft.');
  assert.deepEqual(json(previous(1, '--require-gpt')), { question, draft, source_label: 'gpt', turns_back: 1 });
});

test('an explicit GPT request follows a body-only rewrite to a verified original by turn, even with duplicates', t => {
  const { begin, end, display, previous, gemini } = conversation(t);
  const draft = 'The original text.';
  const target = { question: 'Question about the first item.', draft };
  const bare = 'Only the Gemini body.';
  begin('other', 'Unrelated duplicate.');
  end(draft);
  begin('first', target.question);
  end(display({ draft, candidate: 'First edit.', display_language: 'zh' }));
  begin('second', 'A different question with the very same draft.');
  end(display({ draft, candidate: 'Second edit.', display_language: 'zh' }));
  begin('body', 'Edit the first item again and show only the polished text.');
  end(display({ ...target, candidate: bare }, '--turns-back', '2'));
  begin('user', 'Give me the GPT original from that edit.');
  assert.deepEqual(json(previous()), { question: target.question, draft: bare, source_label: 'quoted' });
  assert.deepEqual(json(previous(1, '--require-gpt')), { ...target, source_label: 'gpt', turns_back: 3 });
  assert.deepEqual(gemini(target, 3), { ...target, history: [{ user: 'Unrelated duplicate.', assistant: draft }] });

  // A body-only first delivery never displayed its GPT original.
  end(display({ draft, candidate: bare }));
  begin('hidden', 'Show the unseen GPT draft.');
  assert.equal(previous(1, '--require-gpt').status, 1);
  assert.equal(previous(5, '--require-gpt').status, 1, 'raw duplicate text cannot prove GPT authorship');
});
