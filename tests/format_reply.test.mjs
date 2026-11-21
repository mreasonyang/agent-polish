import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatReply, originalReplyText } from '../plugins/codex-polish/skills/codex-polish/scripts/format_reply.mjs';

const formatScript = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/format_reply.mjs', import.meta.url));

function cli(args, input, env = process.env) {
  const result = spawnSync(process.execPath, args, { input, env, timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('render prints exactly the final Markdown, including list spacing and trailing newlines', () => {
  const draft = 'draft\n';
  const candidate = '1. one\n   - nested\r\n\r\n  last  \n';
  const input = { draft, candidate, display_language: 'en' };
  assert.equal(cli([formatScript, '--render'], JSON.stringify(input)).stdout, formatReply(input).display_text);
  assert.equal(cli([formatScript, '--render'], JSON.stringify({ draft, candidate })).stdout, candidate);
});

test('host input passes a large Unicode reply without shell interpolation', () => {
  const candidate = ('汉字 🐕 \r\n `$value`  ').repeat(3000);
  const input = JSON.stringify({ draft: 'old', candidate }) + '\n';
  assert.equal(cli([formatScript, '--host-input', '--render'], input).stdout, 'input_ready\n' + candidate);
});

test('a complete rewrite can be formatted without the original question', () => {
  const draft = '关于本次改动，有一个变动要同步。中位数从 80 ms 降到 45 ms。\n请用 `npm test` 检查 src/export.mjs，详见 [记录](https://example.org/a_(b))。';
  const candidate = '中位数现在是 45 ms，之前是 80 ms。\n请用 `npm test` 检查 src/export.mjs，详见 [记录](https://example.org/a_(b))。';
  assert.deepEqual(formatReply({ draft, candidate }), { text: candidate });
});

test('the changed reply comes first and the closed disclosure credits Gemini and identifies the source', () => {
  const draft = '目前已经修复。详见 [记录](https://example.org/a_(b))。';
  const candidate = draft.replace('目前已经', '已经');
  for (const [display_language, source_label, summary] of [
    ['zh', 'gpt', 'Gemini 改写 · 查看 GPT 原稿'],
    ['en', 'gpt', 'Rewritten by Gemini · View original GPT draft'],
    ['zh', 'quoted', 'Gemini 改写 · 查看原文'],
    ['en', 'quoted', 'Rewritten by Gemini · View original text'],
  ]) {
    for (const trigger of ['auto', 'explicit']) {
      assert.deepEqual(formatReply({ draft, candidate, display_language, source_label }, { trigger }), {
        text: candidate,
        display_text: [candidate, `<details><summary>${summary}</summary>`, draft, '</details>'].join('\n\n'),
      });
    }
  }
});

test('a draft discussing disclosure syntax stays verbatim inside a single fenced excerpt', () => {
  const draft = 'Original explanation.\n\n<details><summary>Example</summary>\r\n    :::\n\n</details>\n\n````html\n</details>\n````';
  const candidate = draft.replace('Original explanation.', 'Revised explanation.');
  const result = formatReply({ draft, candidate, display_language: 'en' });
  assert.equal(result.text, candidate);
  assert.equal(result.display_text, candidate
    + '\n\n:::github-details{summary="Rewritten by Gemini · View original GPT draft"}\n\n> `````text\n'
    + '> Original explanation.\n> \n> <details><summary>Example</summary>\r\n>     :::\n> \n> </details>\n> \n> ````html\n> </details>\n> ````\n> `````\n\n:::');
});

test('identical drafts are silent by default and explicit requests acknowledge the correct source once', () => {
  const draft = '  Café is ready.  \r\nDoors open tomorrow.\r\n';
  assert.deepEqual(formatReply({ draft, candidate: draft }, { trigger: 'explicit' }), { text: draft });
  for (const [display_language, source_label, notice] of [
    ['zh', 'gpt', 'Gemini 返回了原稿。'],
    ['en', 'gpt', 'Gemini returned the original draft.'],
    ['zh', 'quoted', 'Gemini 返回了原文。'],
    ['en', 'quoted', 'Gemini returned the original text.'],
  ]) {
    const input = { draft, candidate: draft, display_language, source_label };
    assert.deepEqual(formatReply(input), { text: draft, display_text: draft });
    const explicit = formatReply(input, { trigger: 'explicit' });
    assert.equal(explicit.display_text, notice + '\n\n' + draft);
    assert.equal(explicit.text, draft);
    assert.equal(cli([formatScript, '--render', '--trigger', 'auto'], JSON.stringify(input)).stdout, draft);
    assert.equal(cli([formatScript, '--render', '--trigger', 'explicit'], JSON.stringify(input)).stdout, explicit.display_text);
  }
});

test('Decisions keeping a draft renders only the exact draft', () => {
  const draft = '  Already clear.  \r\n\r\n';
  for (const display_language of ['zh', 'en', undefined]) {
    assert.equal(cli([formatScript, '--render', '--trigger', 'auto', '--kept'], JSON.stringify({ draft, display_language })).stdout, draft);
  }
});

test('failed rewrites display one localized sentence followed by the exact draft', () => {
  const draft = '  Original <!-- a comment in the draft -->\r\n\r\n';
  for (const [display_language, reason] of [
    ['zh', 'Gemini 请求超时，已保留原稿。'],
    ['en', 'The Gemini request timed out, so the original draft is shown below.'],
  ]) {
    const input = JSON.stringify({ draft, reason, display_language });
    for (const trigger of ['auto', 'explicit']) {
      assert.equal(cli([formatScript, '--render', '--skipped', '--trigger', trigger], input).stdout, reason + '\n\n' + draft);
    }
  }
  assert.equal(cli([formatScript, '--render', '--skipped'], JSON.stringify({ draft, reason: 'Gemini timed out.' })).stdout, draft);
});

test('edits to indentation, outer whitespace, line endings or Unicode retain the exact original', () => {
  const draft = '    Café opens today.\r\nDoors open at noon.  \r\n';
  for (const candidate of [draft.trimStart(), draft.trimEnd(), draft.replaceAll('\r\n', '\n'),
    draft.replace('\r\n', '\n\n'), draft.replace(' at', '  at'), draft.normalize('NFD')]) {
    assert.deepEqual(formatReply({ draft, candidate }), { text: candidate });
    const result = formatReply({ draft, candidate, display_language: 'en' });
    assert.equal(result.text, candidate);
    assert.ok(result.display_text.includes('<summary>Rewritten by Gemini · View original GPT draft</summary>'));
    assert.equal(originalReplyText(result.display_text), draft);
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
    display_text: candidate + '\n\n<details><summary>Rewritten by Gemini · View original GPT draft</summary>\n\n' + draft + '\n\n</details>',
  });
});

const chartData = '{"path":"/tmp/visuals/waves.html","mode":"wide","title":"Waves"}';
const chartRef = '\uE200visualize\uE202' + chartData + '\uE201';
const literalChart = 'visualize' + chartData;

test('all display modes preserve the provider’s chart markers, wording and whitespace verbatim', () => {
  const draft = 'First wave.\n\n' + chartRef;
  const candidates = [
    literalChart, chartRef.slice(1), chartRef.slice(0, -1), chartRef,
    chartRef.replace('waves.html', 'heights.html'), chartRef.replace('wide', 'other'),
    chartRef + '\n\n' + chartRef, '~~~text\n' + literalChart + '\n~~~',
    'A reply with no reference.',
  ];
  for (const reference of candidates) {
    const candidate = '  Revised opening.\r\n\r\n' + reference + '\r\n\r\nLast line.  ';
    assert.deepEqual(formatReply({ draft, candidate }), { text: candidate });
    for (const display_language of ['en', 'zh']) {
      const output = formatReply({ draft, candidate, display_language });
      assert.equal(output.text, candidate);
      assert.ok(output.display_text.startsWith(candidate + '\n\n<details>'));
    }
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
