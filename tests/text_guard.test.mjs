import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepare } from '../plugins/codex-polish/skills/codex-polish/scripts/text_guard.mjs';
import { formatReply } from '../plugins/codex-polish/skills/codex-polish/scripts/format_reply.mjs';

const scripts = new URL('../plugins/codex-polish/skills/codex-polish/scripts/', import.meta.url);
const guardScript = fileURLToPath(new URL('text_guard.mjs', scripts));
const formatScript = fileURLToPath(new URL('format_reply.mjs', scripts));

function prep(draft, question = '请解释现状。') {
  assert.deepEqual(prepare({ question, draft }), { bypass: false });
}

function cli(args, input, env = process.env) {
  const result = spawnSync(process.execPath, args, { input, env, timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('a complete rewrite can be formatted without the original question', () => {
  const draft = '关于本次改动，有一个变动要同步。中位数从 80 ms 降到 45 ms。\n请用 `npm test` 检查 src/export.mjs，详见 [记录](https://example.org/a_(b))。';
  const candidate = '中位数现在是 45 ms，之前是 80 ms。\n请用 `npm test` 检查 src/export.mjs，详见 [记录](https://example.org/a_(b))。';
  prep(draft, 'src/export.mjs 的新耗时是多少？');
  assert.deepEqual(formatReply({ draft, candidate }), { text: candidate });
});

test('display shows a changed reply and a closed disclosure in the requested language', () => {
  const draft = '目前已经修复。详见 [记录](https://example.org/a_(b))。';
  const candidate = draft.replace('目前已经', '已经');
  for (const [language, heading, original] of [
    ['zh', '**Gemini 润色版**', '查看 GPT 原稿'],
    ['en', '**Polished by Gemini**', 'View original GPT draft'],
  ]) {
    assert.deepEqual(formatReply({ draft, candidate, display_language: language }), {
      text: candidate,
      display_text: [heading, candidate, `<details><summary>${original}</summary>`, draft, '</details>'].join('\n\n'),
    });
  }
});

test('a draft discussing disclosure syntax stays verbatim inside a single fenced excerpt', () => {
  const draft = 'Original explanation.\n\n<details><summary>Example</summary>\r\n    :::\n\n</details>\n\n````html\n</details>\n````';
  const candidate = draft.replace('Original explanation.', 'Revised explanation.');
  const result = formatReply({ draft, candidate, display_language: 'en' });
  assert.equal(result.text, candidate);
  assert.equal(result.display_text, '**Polished by Gemini**\n\n' + candidate
    + '\n\n:::github-details{summary="View original GPT draft"}\n\n> `````text\n'
    + '> Original explanation.\n> \n> <details><summary>Example</summary>\r\n>     :::\n> \n> </details>\n> \n> ````html\n> </details>\n> ````\n> `````\n\n:::');
});

test('equivalent replies display once and preserve Gemini’s original line endings and outer whitespace', () => {
  const draft = '  Café is ready.  \r\nDoors open tomorrow.\r\n';
  for (const candidate of [draft, draft.trim(), draft.replaceAll('\r\n', '\n'), '\t' + draft + '\n']) {
    assert.deepEqual(formatReply({ draft, candidate }), { text: candidate });
    for (const [language, heading] of [
      ['zh', '**Gemini 返回了原稿**'],
      ['en', '**Gemini returned the original draft**'],
    ]) {
      assert.deepEqual(formatReply({ draft, candidate, display_language: language }), {
        text: candidate,
        display_text: heading + '\n\n' + candidate,
      });
    }
  }
});

test('paragraph breaks, internal whitespace and Unicode edits display as revisions', () => {
  const draft = 'Café opens today.\r\nDoors open at noon.';
  for (const candidate of [draft.replace('\r\n', '\n\n'), draft.replace(' at', '  at'), draft.normalize('NFD')]) {
    const result = formatReply({ draft, candidate, display_language: 'en' });
    assert.equal(result.text, candidate);
    assert.ok(result.display_text.includes('<summary>View original GPT draft</summary>'));
  }
});

test('the formatter CLI accepts a complete identical reply in an ASCII locale', () => {
  const draft = '测a'.repeat(30_000);
  const result = cli([formatScript], JSON.stringify({ draft, candidate: draft }), { ...process.env, LANG: 'C', LC_ALL: 'C' });
  assert.deepEqual(JSON.parse(result.stdout), { text: draft });
});

test('the formatter CLI preserves long fenced Markdown, tabs, CRLF and trailing lines', () => {
  const draft = '# Update\r\n\r\n- First draft.\r\n\r\n~~~~text\r\n\t' + 'x'.repeat(160 * 1024)
    + '\r\n```\r\n~~~~\r\n\r\n';
  const candidate = draft.replace('First draft.', 'Revised copy.');
  const result = cli([formatScript], JSON.stringify({ draft, candidate, display_language: 'en' }));
  assert.deepEqual(JSON.parse(result.stdout), {
    text: candidate,
    display_text: '**Polished by Gemini**\n\n' + candidate + '\n\n<details><summary>View original GPT draft</summary>\n\n' + draft + '\n\n</details>',
  });
});

const chartData = '{"path":"/tmp/visuals/waves.html","mode":"wide","title":"Waves"}';
const chartRef = '\uE200visualize\uE202' + chartData + '\uE201';
const literalChart = 'visualize' + chartData;

test('the formatter restores any dropped separators around an unambiguous original chart', () => {
  const draft = '以上涨趋势为例：\r\n\r\n' + chartRef + '\r\n\r\n先看第一段。';
  for (const start of ['', '\uE200']) for (const sep of ['', '\uE202']) for (const end of ['', '\uE201']) {
    const candidate = draft.replace(chartRef, start + 'visualize' + sep + chartData + end);
    assert.deepEqual(formatReply({ draft, candidate, display_language: 'zh' }), {
      text: draft,
      display_text: '**Gemini 返回了原稿**\n\n' + draft,
    });
  }
});

test('a rewritten paragraph can move with its chart and keep fenced examples literal', () => {
  const example = '\n\n~~~text\n' + literalChart + '\n~~~';
  const draft = 'Original explanation.\n\n' + chartRef + example;
  const candidate = literalChart + '\n\n- See the first wave.' + example;
  assert.deepEqual(formatReply({ draft, candidate }), {
    text: chartRef + '\n\n- See the first wave.' + example,
  });
});

test('reordered charts keep their own attributes and the original disclosure renders them as source', () => {
  const otherData = '{"path":"/tmp/visuals/heights.html"}';
  const otherRef = '\uE200visualize\uE202' + otherData + '\uE201';
  const draft = 'Read the waves.\n\n' + chartRef + '\n\nNext come the heights.\n\n' + otherRef;
  const candidate = 'Start with the heights.\n\nvisualize' + otherData + '\n\nThen look at the waves.\n\n' + literalChart;
  const expected = 'Start with the heights.\n\n' + otherRef + '\n\nThen look at the waves.\n\n' + chartRef;
  for (const source of [draft, draft + '\n\n:::']) {
    const result = formatReply({ draft: source, candidate, display_language: 'en' });
    assert.equal(result.text, expected);
    assert.equal(result.display_text.split(chartRef).length, 2);
    assert.equal(result.display_text.split(otherRef).length, 2);
    const disclosure = result.display_text.split(expected)[1];
    assert.ok(disclosure.includes('View original GPT draft'));
    assert.ok(disclosure.includes(chartData));
    assert.ok(disclosure.includes(otherData));
  }
});

test('missing or ambiguous chart matches keep the surrounding rewrite and leave stripped references literal', () => {
  const draft = 'First wave.\n\n' + chartRef;
  const missing = 'The first wave rose sharply.';
  assert.deepEqual(formatReply({ draft, candidate: missing }), { text: missing });
  const duplicate = 'Wave one.\n\n' + literalChart + '\n\nWave two.\n\n' + literalChart;
  assert.deepEqual(formatReply({ draft, candidate: duplicate }), { text: duplicate });
  const literal = '\n\nExample:\n\n' + literalChart;
  const candidate = 'Look here:\n\n' + literalChart + literal;
  assert.deepEqual(formatReply({ draft: draft + literal, candidate }), { text: candidate });
});

test('a returned duplicate live chart keeps the complete revised explanation', () => {
  const draft = 'First wave.\n\n' + chartRef;
  const candidate = 'Read the first wave.\n\n' + chartRef + '\n\nCompare its end.\n\n' + chartRef;
  const result = formatReply({ draft, candidate, display_language: 'en' });
  for (const part of ['Read the first wave.', 'Compare its end.']) {
    assert.ok(result.text.includes(part));
    assert.ok(result.display_text.includes(part));
  }
});

test('new or changed live chart references keep the revised prose and display the unknown reference as text', () => {
  for (const [draft, returned] of [
    ['First wave.', chartRef],
    ['First wave.\n\n' + chartRef, chartRef.replace('waves.html', 'private.html')],
    ['First wave.\n\n' + chartRef, chartRef.replace('wide', 'other')],
  ]) {
    const candidate = 'See the revised chart.\n\n' + returned + '\n\nThe peak is in June.';
    const result = formatReply({ draft, candidate, display_language: 'en' });
    assert.ok(result.text.startsWith('See the revised chart.\n\n'));
    assert.ok(result.text.endsWith('\n\nThe peak is in June.'));
    assert.ok(result.display_text.includes('See the revised chart.'));
    assert.ok(result.display_text.includes(returned.slice(returned.indexOf('{'), returned.indexOf('}') + 1)));
    assert.ok(!result.display_text.includes(returned));
  }
});

test('a complete reply can contain code, mixed Markdown, display controls or credential-like strings', () => {
  const draft = '处理完成了，结果正常。';
  for (const candidate of [
    '> 注释', '## 结论\n结果正常。', '- 检查完成。\n- 结果正常。', '| 项目 | 结果 |\n|---|---|\n| 检查 | 完成 |',
    '~~~sh\npwd\n~~~', '看下面的例子。\n\n```js\nconst value = 45;\n```',
    'Direction: \u2066left to right\u2069', 'Example token: sk-proj-' + 'x'.repeat(25),
    '这是一段长文。'.repeat(32 * 1024),
  ]) {
    assert.deepEqual(formatReply({ draft, candidate }), { text: candidate });
  }
});

test('display controls in the question or draft bypass sending to Gemini', () => {
  const source = { question: '继续说明。', draft: '文件已经检查完了。' };
  for (const control of ['\x08', '\x1b', '\u202e', '\u2066']) {
    for (const field of ['question', 'draft']) {
      assert.deepEqual(prepare({ ...source, [field]: '编辑材料' + control + '内容。' }), {
        bypass: true, reason: 'display_control',
      });
    }
  }
  prep('مكتمل\t状态正常。\r\n文字正常。');
});

test('explicit format requests, commands and machine output bypass rewriting', () => {
  for (const question of ['只给我一条命令','这次只要命令','严格按以下格式返回','请原样输出','return only JSON'])
    assert.deepEqual(prepare({question,draft:'原稿是中文。'}),{bypass:true,reason:'fixed_format'});
  for (const draft of ['{"key": "value"}','[true, false]','true',' false\n','null','git status','pwd',
    '`npm test`','```sh\ngit log\n```','diff --git a/file b/file','diff --git a/file b/file\nindex 22..33\n@@ -1 +1 @@\n-old\n+new',
    'def main():\n    pass'])
    assert.equal(prepare({question:'帮我看下。',draft}).bypass,true);
});

test('an English request for only the polished text allows a rewrite while exact output still bypasses it', () => {
  const draft = 'The work is currently complete.';
  for (const question of ['Only show the polished text.', 'Please return only the polished text.',
    'Edit for clarity and give me only the polished answer.']) {
    prep(draft, question);
  }
  for (const question of ['Output only JSON.', 'Output only JSON. Return only the polished text.',
    'Return only the polished text as JSON.', 'Keep the quote verbatim and return only the polished text.',
    'Return exactly the polished text.']) {
    assert.deepEqual(prepare({ question, draft }), { bypass: true, reason: 'fixed_format' });
  }
});

test('ordinary references to verbatim output and log explanations can be rewritten', () => {
  for (const question of ['What does verbatim mean?', 'Give me only the main reason.', 'What does “return only JSON” mean?'])
    prep('From the logs, the upload timed out.', question);
  prep('From the logs, the upload timed out.\n\nfrom pathlib import Path');
});

test('documented credential placeholders can be shared, but a real value still blocks the turn', () => {
  for (const example of ['API_KEY=<你的密钥>。', 'password=<your-password>', 'token=${API_TOKEN}', 'Authorization: Bearer <token>',
    'api_key=`YOUR_API_KEY`'])
    prep('Example: ' + example);
  for (const example of ['API_KEY=<你的密钥> password=actual-value', 'api_key=<your-api-key>actual', 'token=<some-real-value>',
    'token=<sk-proj-' + 'x'.repeat(32) + '>'])
    assert.equal(prepare({question:'Explain.', draft:example}).reason, 'possible_credential');
});

test('credentials never appear in pre-send CLI bypass payloads', () => {
  const secret = 'sk-proj-'+'x'.repeat(25);
  for (const field of ['question', 'draft']) {
    const data = {question:'继续说明。', draft:'已经完成了。'};
    data[field] += secret;
    const result = cli([guardScript, 'prepare'], JSON.stringify(data));
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.equal(JSON.parse(result.stdout).reason,'possible_credential');
  }
  for (const credential of ['Authorization: Bearer abcdefghij','Authorization: Basic abcdefghij','Authorization: Token abcdefghijklmnop',
    '"Authorization": "Token example"','Cookie: sid=secretvalue','"Cookie": "session=private"','api_key="abcdef"',
    'postgres://user:pwd@example.org','密码：abcdef','密码：“private-password”','password=```private-value```','-----BEGIN PRIVATE KEY-----'])
    assert.equal(prepare({question:'继续。',draft:credential}).reason,'possible_credential');
});

test('malformed inputs and unclosed fenced blocks fail closed', () => {
  for (const data of [[],{draft:'一些文字。'},...['\udc80','内容\n~~~sh\nls'].map(draft => ({question:'继续。',draft}))])
    assert.equal(prepare(data).bypass,true);
  const result = cli([guardScript, 'prepare'], '{invalid');
  assert.deepEqual(JSON.parse(result.stdout), {bypass:true, reason:'invalid_input'});
});
