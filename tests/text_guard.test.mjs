import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_TEXT, run } from '../plugins/codex-polish/skills/codex-polish/scripts/text_guard.mjs';

const script = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/text_guard.mjs', import.meta.url));
function prep(draft, question = '请解释现状。') {
  const source = {question, draft};
  const output = run('prepare',source);
  assert.deepEqual(output, {bypass: false});
  return source;
}
const review = (source,candidate) => run('review',{...source,candidate});
function cli(action,input,env = process.env) {
  const result = spawnSync(process.execPath,[script,action],{input,env,timeout:5000,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return result;
}

test('original question, draft and candidate use ordinary text throughout', () => {
  const draft = '关于本次改动，有一个变动要同步。中位数从 80 ms 降到 45 ms。\n请用 `npm test` 检查 src/export.mjs，详见 [记录](https://example.org/a_(b))。';
  const question = 'src/export.mjs 的新耗时是多少？';
  const source = prep(draft, question);
  const candidate = '中位数现在是 45 ms，之前是 80 ms。\n请用 `npm test` 检查 src/export.mjs，详见 [记录](https://example.org/a_(b))。';
  assert.deepEqual(review(source, candidate), {ok: true, text: candidate});
});

test('display shows the rewrite and puts the original in a closed disclosure in the requested language', () => {
  const draft = '目前已经修复。详见 [记录](https://example.org/a_(b))。';
  const polished = draft.replace('目前已经', '已经');
  const source = prep(draft);
  const candidate = source.draft.replace('目前已经', '已经');
  for (const [language, heading, original] of [
    ['zh', '**Gemini 润色版**', '查看 GPT 原稿'],
    ['en', '**Polished by Gemini**', 'View original GPT draft'],
  ]) {
    assert.deepEqual(run('review', { ...source, candidate, display_language: language }), {
      ok: true, text: polished,
      display_text: [heading, polished, `<details><summary>${original}</summary>`, draft, '</details>'].join('\n\n'),
    });
  }
});

test('a draft discussing disclosure syntax is kept verbatim inside a single fenced excerpt', () => {
  const draft = 'Original explanation.\n\n<details><summary>Example</summary>\r\n    :::\n\n</details>\n\n````html\n</details>\n````';
  const source = prep(draft);
  const candidate = source.draft.replace('Original explanation.', 'Revised explanation.');
  const result = run('review', { ...source, candidate, display_language: 'en' });
  assert.equal(result.ok, true);
  assert.equal(result.display_text, '**Polished by Gemini**\n\n' + result.text
    + '\n\n:::github-details{summary="View original GPT draft"}\n\n> `````text\n'
    + '> Original explanation.\n> \n> <details><summary>Example</summary>\r\n>     :::\n> \n> </details>\n> \n> ````html\n> </details>\n> ````\n> `````\n\n:::');
});

test('display shows an identical draft once, keeping all source whitespace', () => {
  const draft = '  See `git log`.  \r\n\t\r\n';
  const source = prep(draft);
  for (const [language, heading] of [
    ['zh', '**Gemini 已核对，和 GPT 原稿相同**'],
    ['en', '**Gemini reviewed the GPT draft and left it unchanged**'],
  ]) {
    assert.deepEqual(run('review', { ...source, candidate: source.draft, display_language: language }), {
      ok: true, text: draft, display_text: heading + '\n\n' + draft,
    });
  }
});

test('whitespace and Unicode normalization differences count as edits', () => {
  const draft = 'Café is ready.  \r\n';
  const source = prep(draft);
  for (const candidate of [draft.trimEnd(), draft.replace('\r\n', '\n'), draft.normalize('NFD')]) {
    assert.deepEqual(run('review', { ...source, candidate, display_language: 'en' }), {
      ok: true, text: candidate,
      display_text: '**Polished by Gemini**\n\n' + candidate + '\n\n<details><summary>View original GPT draft</summary>\n\n' + draft + '\n\n</details>',
    });
  }
});

test('turbo only accepts a changed draft through the review CLI', () => {
  const source = prep('Café opens on Friday.\r\nDoors open at noon.');
  function turbo(candidate, display_language) {
    const result = spawnSync(process.execPath, [script, 'review', '--rewrite-mode', 'turbo'], {
      input: JSON.stringify({...source, candidate, display_language}), encoding:'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  for (const candidate of [source.draft, '  ' + source.draft + '\n', source.draft.normalize('NFD').replace('\r\n','\n\n')]) {
    for (const lang of [undefined, 'en'])
      assert.deepEqual(turbo(candidate, lang), {ok:false, reason:'unchanged_candidate'});
  }
  const revised = 'The café opens its doors at noon on Friday.';
  assert.deepEqual(turbo(revised), {ok:true, text:revised});
  assert.ok(turbo(revised, 'zh').display_text.includes(source.draft));
  assert.deepEqual(run('review', {...source, candidate:revised}, 'other'), {ok:false, reason:'invalid_input'});
});

test('display preserves long fenced Markdown, including tabs, CRLF and trailing lines, through the CLI', () => {
  const draft = '# Update\r\n\r\n- First draft.\r\n\r\n~~~~text\r\n\t' + 'x'.repeat(MAX_TEXT - 150)
    + '\r\n```\r\n~~~~\r\n\r\n';
  const source = prep(draft);
  const polished = draft.replace('First draft.', 'Revised copy.');
  const candidate = source.draft.replace('First draft.', 'Revised copy.');
  const result = cli('review', JSON.stringify({ ...source, candidate, display_language: 'en' }));
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, text: polished,
    display_text: '**Polished by Gemini**\n\n' + polished + '\n\n<details><summary>View original GPT draft</summary>\n\n' + draft + '\n\n</details>',
  });
});

test('failed display requests return only the failure reason', () => {
  const source = prep('Use `git log` to inspect the update.');
  const request = { ...source, candidate: source.draft, display_language: 'en' };
  assert.deepEqual(run('review', { ...request, candidate: source.draft + '\n# Conclusion' }),
    { ok: false, reason: 'structure_changed' });
  for (const language of [null, false, '', 'auto', 'constructor', ['zh']]) {
    assert.deepEqual(run('review', { ...request, display_language: language }), { ok: false, reason: 'invalid_input' });
  }
});

test('display controls bypass or reject without echoing', () => {
  const source = prep('文件已经检查完了。');
  for (const control of ['\x08','\x1b','\u202e','\u2066']) {
    for (const field of ['question','draft','candidate']) {
      const action = field === 'candidate' ? 'review' : 'prepare';
      const expected = action === 'review' ? {ok:false} : {bypass:true};
      assert.deepEqual(run(action,{...source,[field]:'编辑材料'+control+'内容。'}),{...expected,reason:'display_control'});
    }
  }
  prep('مكتمل\t状态正常。\r\n文字正常。');
});

test('a candidate must fit the original text budget', () => {
  const source = prep('检查完成。');
  assert.deepEqual(review(source, 'x'.repeat(MAX_TEXT + 1)), {ok:false,reason:'size_limit'});
});

test('CLI keeps ordinary UTF-8 text intact in an ASCII locale', () => {
  const draft = '测a'.repeat(30_000);
  const result = cli('review',JSON.stringify({question:'继续。', draft, candidate:draft}),{...process.env,LANG:'C',LC_ALL:'C'});
  assert.deepEqual(JSON.parse(result.stdout),{ok:true,text:draft});
});

test('Markdown structure changes are still rejected', () => {
  const source = prep('处理完成了，结果正常。');
  for (const extra of ['\n> 注释','\n# 结论','\n- 附件','\n\n~~~sh\npwd\n~~~'])
    assert.equal(review(source,source.draft+extra).reason,'structure_changed',extra);
});

test('a prose reply can include fenced source code as supplied', () => {
  const draft = '看下面的例子。\n\n```js\nconst value = 45;\n```';
  const source = prep(draft);
  assert.equal(review(source, draft).text, draft);
});

test('explicit format requests, commands and machine output bypass rewriting', () => {
  for (const question of ['只给我一条命令','这次只要命令','严格按以下格式返回','请原样输出','return only JSON'])
    assert.deepEqual(run('prepare',{question,draft:'原稿是中文。'}),{bypass:true,reason:'fixed_format'});
  for (const draft of ['{"key": "value"}','[true, false]','true',' false\n','null','git status','pwd',
    '`npm test`','```sh\ngit log\n```','diff --git a/file b/file','def main():\n    pass'])
    assert.equal(run('prepare',{question:'帮我看下。',draft}).bypass,true);
});

test('an English request for only the polished text allows a rewrite while exact output still bypasses it', () => {
  const draft = 'The work is currently complete.';
  for (const question of ['Only show the polished text.', 'Please return only the polished text.',
    'Edit for clarity and give me only the polished answer.']) {
    const source = prep(draft, question);
    const candidate = source.draft.replace('currently ', '');
    assert.deepEqual(review(source, candidate), { ok: true, text: 'The work is complete.' });
  }
  for (const question of ['Output only JSON.', 'Output only JSON. Return only the polished text.',
    'Return only the polished text as JSON.', 'Keep the quote verbatim and return only the polished text.',
    'Return exactly the polished text.']) {
    assert.deepEqual(run('prepare', { question, draft }), { bypass: true, reason: 'fixed_format' });
  }
});

test('credentials never appear in CLI failure payloads', () => {
  const secret = 'sk-proj-'+'x'.repeat(25);
  for (const [field,action] of [['question','prepare'],['draft','prepare'],['candidate','review']]) {
    const data = {question:'继续说明。',draft:'已经完成了。',candidate:'已经完成。'};
    data[field] += secret;
    const result = cli(action,JSON.stringify(data));
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.equal(JSON.parse(result.stdout).reason,'possible_credential');
  }
  for (const credential of ['Authorization: Bearer abcdefghij','Authorization: Basic abcdefghij','Authorization: Token abcdefghijklmnop',
    '"Authorization": "Token example"','Cookie: sid=secretvalue','"Cookie": "session=private"','api_key="abcdef"',
    'postgres://user:pwd@example.org','密码：abcdef','-----BEGIN PRIVATE KEY-----'])
    assert.equal(run('prepare',{question:'继续。',draft:credential}).reason,'possible_credential');
});

test('malformed inputs and unclosed fenced blocks fail closed', () => {
  for (const data of [[],{draft:'一些文字。'},...['\udc80','内容\n~~~sh\nls',
    'a'.repeat(MAX_TEXT+1)].map(draft => ({question:'继续。',draft}))])
    assert.equal(run('prepare',data).bypass,true);
  for (const [action,expected] of [['prepare',{bypass:true}],['review',{ok:false}]])
    assert.deepEqual(JSON.parse(cli(action,'{invalid').stdout),{...expected,reason:'invalid_input'});
});
