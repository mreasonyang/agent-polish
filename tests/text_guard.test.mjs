import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MARKER, MAX_TEXT, run } from '../plugins/codex-polish/skills/codex-polish/scripts/text_guard.mjs';

const script = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/text_guard.mjs', import.meta.url));
function prep(draft, question = '请解释现状。') {
  const source = {question, draft};
  const output = run('prepare',source);
  assert.equal(output.bypass,false,JSON.stringify(output));
  return [source,output];
}
const restore = (source,candidate) => run('restore',{...source,candidate});
function cli(action,input,env = process.env) {
  const result = spawnSync(process.execPath,[script,action],{input,env,timeout:5000,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return result;
}

test('Chinese round trip with nested links, numbers, quotes and scoped markers', () => {
  const draft = '目前来看，已改3处，剩下两项，到了第三步。\n'
    + '请看 src/main.py:12、v1.2.3 和 [文档](https://example.org/a_(x))。\n反馈是“仍待验证”。来源为【记录】，可执行 git status 查看变化。';
  const [source,p] = prep(draft,'能解释 v1.2.3 的变化吗？');
  for (const literal of ['3处','两项','第三步','src/main.py','v1.2.3','文档','example.org','仍待验证','记录','git status'])
    assert.ok(!p.protected_draft.includes(literal));
  assert.ok(!p.protected_question.includes('v1.2.3'));
  const edit = value => value.replace('目前来看，','').replace('请看 ','详见 ');
  assert.deepEqual(restore(source,edit(p.protected_draft)),{ok:true,text:edit(draft)});
  assert.deepEqual(run('prepare',source),p);
});

test('Markdown blocks preserve exact bytes including CRLF', () => {
  const draft = '先看这个例子。\r\n\r\n1. 已完成。\r\n2. 待处理。\r\n'
    + '> quoted text\r\n| A | B |\r\n| --- | --- |\r\n| x | y |\r\n'
    + "~~~~sh\r\nprintf '%s' '~~~'\r\n~~~~\r\n运行 `git log`。";
  const [source,p] = prep(draft);
  for (const literal of ['quoted text','printf','git log']) assert.ok(!p.protected_draft.includes(literal));
  const edit = text => text.replace('先看这个例子。','下面是例子。');
  assert.deepEqual(restore(source,edit(p.protected_draft)),{ok:true,text:edit(draft)});
});

test('display restores masked content and labels both versions in the requested language', () => {
  const draft = '目前已经修复。详见 [记录](https://example.org/a_(b))。';
  const polished = draft.replace('目前已经', '已经');
  const [source, p] = prep(draft);
  assert.notEqual(p.protected_draft, draft);
  const candidate = p.protected_draft.replace('目前已经', '已经');
  for (const [language, heading, original] of [
    ['zh', '**Gemini 润色版**', '**GPT 原稿**'],
    ['en', '**Polished by Gemini**', '**Original GPT draft**'],
  ]) {
    assert.deepEqual(run('restore', { ...source, candidate, display_language: language }), {
      ok: true, text: polished, display_text: [heading, polished, original, draft].join('\n\n'),
    });
  }
});

test('display shows an identical restored draft once, keeping all source whitespace', () => {
  const draft = '  See `git log`.  \r\n\t\r\n';
  const [source, p] = prep(draft);
  assert.notEqual(p.protected_draft, draft);
  for (const [language, heading] of [
    ['zh', '**Gemini 已核对，和 GPT 原稿相同**'],
    ['en', '**Gemini reviewed the GPT draft and left it unchanged**'],
  ]) {
    assert.deepEqual(run('restore', { ...source, candidate: p.protected_draft, display_language: language }), {
      ok: true, text: draft, display_text: heading + '\n\n' + draft,
    });
  }
});

test('whitespace and Unicode normalization differences count as edits', () => {
  const draft = 'Café is ready.  \r\n';
  const [source] = prep(draft);
  for (const candidate of [draft.trimEnd(), draft.replace('\r\n', '\n'), draft.normalize('NFD')]) {
    assert.deepEqual(run('restore', { ...source, candidate, display_language: 'en' }), {
      ok: true, text: candidate,
      display_text: '**Polished by Gemini**\n\n' + candidate + '\n\n**Original GPT draft**\n\n' + draft,
    });
  }
});

test('display preserves long fenced Markdown, including tabs, CRLF and trailing lines, through the CLI', () => {
  const draft = '# Update\r\n\r\n- First draft.\r\n\r\n~~~~text\r\n\t' + 'x'.repeat(MAX_TEXT - 150)
    + '\r\n```\r\n~~~~\r\n\r\n';
  const [source, p] = prep(draft);
  const polished = draft.replace('First draft.', 'Revised copy.');
  const candidate = p.protected_draft.replace('First draft.', 'Revised copy.');
  const result = cli('restore', JSON.stringify({ ...source, candidate, display_language: 'en' }));
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, text: polished,
    display_text: '**Polished by Gemini**\n\n' + polished + '\n\n**Original GPT draft**\n\n' + draft,
  });
});

test('failed display requests return only the failure reason', () => {
  const [source, p] = prep('Use `git log` to inspect the update.');
  const request = { ...source, candidate: p.protected_draft, display_language: 'en' };
  assert.deepEqual(run('restore', { ...request, candidate: 'Here is the revised draft.' }),
    { ok: false, reason: 'marker_mismatch' });
  assert.deepEqual(run('restore', { ...request, candidate: p.protected_draft + '\n# Conclusion' }),
    { ok: false, reason: 'structure_changed' });
  for (const language of [null, false, '', 'auto', 'constructor', ['zh']]) {
    assert.deepEqual(run('restore', { ...request, display_language: language }), { ok: false, reason: 'invalid_input' });
  }
});

test('opaque markers have request and role scope and order', () => {
  const [source,p] = prep('已处理3项，剩下2处。','为什么有10项？');
  const [one,two] = p.protected_draft.match(MARKER);
  const [foreign] = prep('已处理4项。')[1].protected_draft.match(MARKER);
  const [question] = p.protected_question.match(MARKER);
  for (const candidate of [one,two+one,one+two+two,one+two+question,one+two+foreign,one+two+'⟦CP:坏标记⟧'])
    assert.deepEqual(restore(source,candidate),{ok:false,reason:'marker_mismatch'});
});

test('duration unit is part of the protected value', () => {
  const [source,p] = prep('这步要 5 minutes，收尾要 12msec。');
  const [one,two] = p.protected_draft.match(MARKER);
  assert.equal(p.protected_draft,'这步要 '+one+'，收尾要 '+two+'。');
  assert.deepEqual(restore(source,p.protected_draft),{ok:true,text:source.draft});
  assert.equal(restore(source,p.protected_draft.replace('⟧','⟧s')).ok,false);
});

test('display controls bypass or reject without echoing', () => {
  const [source] = prep('文件已经检查完了。');
  for (const control of ['\x08','\x1b','\u202e','\u2066']) {
    for (const field of ['question','draft','candidate']) {
      const action = field === 'candidate' ? 'restore' : 'prepare';
      const expected = action === 'restore' ? {ok:false} : {bypass:true};
      assert.deepEqual(run(action,{...source,[field]:'编辑材料'+control+'内容。'}),{...expected,reason:'display_control'});
    }
  }
  prep('مكتمل\t状态正常。\r\n文字正常。');
});

test('restoring a hidden block cannot exceed the text budget', () => {
  const [source,p] = prep('检查完成。\n```txt\n'+'x'.repeat(MAX_TEXT-100)+'\n```');
  const candidate = '附带说明。'.repeat(30)+p.protected_draft;
  assert.ok(Buffer.byteLength(candidate) < MAX_TEXT);
  assert.deepEqual(restore(source,candidate),{ok:false,reason:'size_limit'});
});

test('long mixed-script prose finishes with original text', () => {
  const draft = '测a'.repeat(30_000);
  const result = cli('prepare',JSON.stringify({question:'继续。',draft}));
  assert.equal(JSON.parse(result.stdout).protected_draft,draft);
  const [source,p] = prep('请运行 deploy工具 --check 核对结果。');
  assert.ok(!p.protected_draft.includes('deploy工具'));
  assert.equal(restore(source,p.protected_draft).text,source.draft);
});

test('CLI writes UTF-8 JSON in an ASCII locale', () => {
  const result = cli('prepare',JSON.stringify({question:'继续。',draft:'已经改好。'}),{...process.env,LANG:'C',LC_ALL:'C'});
  assert.equal(JSON.parse(result.stdout).protected_draft,'已经改好。');
});

test('new deterministically detectable claims and structure are rejected', () => {
  const [source,p] = prep('处理完成了，结果正常。');
  for (const extra of ['已测9次。','已改９处。','剩下三项。',' "new quote"',' [新](https://example.org)',
    ' https://example.org',' example.org',' 见 test.py',' `unknown command`',' 用 git status 检查。',
    '\n> 注释','\n# 结论','\n- 附件','\n\n~~~sh\npwd\n~~~'])
    assert.equal(restore(source,p.protected_draft+extra).ok,false,extra);
});

test('explicit format requests, commands and machine output bypass rewriting', () => {
  for (const question of ['只给我一条命令','这次只要命令','严格按以下格式返回','请原样输出','return only JSON'])
    assert.deepEqual(run('prepare',{question,draft:'原稿是中文。'}),{bypass:true,reason:'fixed_format'});
  for (const draft of ['{"key": "value"}','[true, false]','true',' false\n','null','git status','pwd',
    '```sh\ngit log\n```','diff --git a/file b/file','def main():\n    pass'])
    assert.equal(run('prepare',{question:'帮我看下。',draft}).bypass,true);
});

test('an English request for only the polished text allows a rewrite while exact output still bypasses it', () => {
  const draft = 'The work is currently complete.';
  for (const question of ['Only show the polished text.', 'Please return only the polished text.',
    'Edit for clarity and give me only the polished answer.']) {
    const [source, p] = prep(draft, question);
    const candidate = p.protected_draft.replace('currently ', '');
    assert.deepEqual(restore(source, candidate), { ok: true, text: 'The work is complete.' });
  }
  for (const question of ['Output only JSON.', 'Output only JSON. Return only the polished text.',
    'Return only the polished text as JSON.', 'Keep the quote verbatim and return only the polished text.',
    'Return exactly the polished text.']) {
    assert.deepEqual(run('prepare', { question, draft }), { bypass: true, reason: 'fixed_format' });
  }
});

test('credentials never appear in CLI failure payloads', () => {
  const secret = 'sk-proj-'+'x'.repeat(25);
  for (const [field,action] of [['question','prepare'],['draft','prepare'],['candidate','restore']]) {
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

test('ambiguous and malformed inputs fail closed', () => {
  for (const data of [[],{draft:'一些文字。'},...['⟦CP:1⟧','\udc80','一些文字[未闭合','内容\n~~~sh\nls',
    'a'.repeat(MAX_TEXT+1),'prose '+String.fromCharCode(96).repeat(80000)].map(draft => ({question:'继续。',draft}))])
    assert.equal(run('prepare',data).bypass,true);
  for (const [action,expected] of [['prepare',{bypass:true}],['restore',{ok:false}]])
    assert.deepEqual(JSON.parse(cli(action,'{invalid').stdout),{...expected,reason:'invalid_input'});
});
