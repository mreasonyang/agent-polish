import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, run, temporary } from './hook_fixture.mjs';

const plugin = fileURLToPath(new URL('../plugins/codex-polish/', import.meta.url));
const hook = join(plugin, 'hooks/preferences.mjs');
const formatter = join(plugin, 'skills/codex-polish/scripts/acp_payload.mjs');
const roleScript = join(plugin, 'skills/codex-polish/scripts/editor_role.mjs');
const decisionsURL = new URL('../plugins/codex-polish/skills/codex-polish/scripts/decisions.mjs', import.meta.url).href;
const captureDecision = `
  import fs from 'node:fs';
  import https from 'node:https';
  import { EventEmitter } from 'node:events';
  import { syncBuiltinESMExports } from 'node:module';
  import { Readable } from 'node:stream';
  import { decide } from ${JSON.stringify(decisionsURL)};
  const [transcript, cwd] = process.argv.slice(1);
  let transcriptReads = 0;
  for (const name of ['openSync', 'readFileSync']) {
    const original = fs[name];
    fs[name] = (file, ...args) => {
      if (file === transcript) transcriptReads++;
      return original(file, ...args);
    };
  }
  const requests = [];
  https.request = (_url, _options, respond) => {
    const req = new EventEmitter();
    req.end = body => {
      requests.push(JSON.parse(body));
      const result = {answers: [{type:'predicate', name:'needs_rewrite', probability:1}]};
      const response = Readable.from([Buffer.from(JSON.stringify(result))]);
      response.statusCode = 200;
      response.headers = {};
      respond(response);
    };
    return req;
  };
  syncBuiltinESMExports();
  const decision = await decide(['judge', '--cwd', cwd], process.stdin, {OPENAI_API_KEY:'test-key'});
  console.log(JSON.stringify({decision, requests, transcriptReads}));
`;
const prompt = {
  sessionId: 'provider-session',
  question: '  `src/导出.mjs:12` 的 [v1.2.3](https://example.test/v1.2.3) 修好了吗？\r\n',
  draft: '  Cafe\u0301 的延迟为 25 ms（原话是“待验证”）。\r\n\r\n```sh\r\ngit diff -- src/导出.mjs\r\n```  \r\n',
};
const primary = {question:prompt.question, draft:prompt.draft};
const key = 'sk-proj-' + 'x'.repeat(25);
const event = (type, fields) => ({type:'event_msg', payload:{type, ...fields}});

function assertEnglishProse(text) {
  assert.match(text, /\b(the|and|draft|edit|rewrite|polish|history|use)\b/i);
  assert.doesNotMatch(text, /(?=\p{Letter})\P{Script_Extensions=Latin}/u);
}

test('the normal editor uses the conversation as context and can keep a clear draft unchanged', () => {
  const role = readFileSync(join(plugin, 'skills/codex-polish/references/codex-polish-editor.md'), 'utf8');
  const [, metadata, ...body] = role.split(/^---\r?$/m);
  const description = metadata.match(/^description:[ \t]*(.+)$/m);
  assert.ok(description);
  assertEnglishProse(description[1]);
  const instructions = body.join('\n');
  assertEnglishProse(instructions);
  assert.match(instructions, /quoted conversation/);
  assert.match(instructions, /`draft` is the reply Codex wrote to that message/);
  assert.match(instructions, /`history` contains their earlier exchanges, oldest first/);
  assert.match(instructions, /return it unchanged/);
  assert.match(instructions, /on the first read/);
});

function setup(t) {
  const root = temporary(t);
  const session = randomUUID();
  const turn = randomUUID();
  const project = join(root,'project');
  mkdirSync(project);
  const env = {PATH:'/usr/bin:/bin',HOME:root,CODEX_HOME:join(root,'codex'),CODEX_THREAD_ID:session,XDG_CACHE_HOME:join(root,'cache')};
  const transcript = join(env.CODEX_HOME, 'sessions/2026/11/19', 'rollout-2026-11-19T11-30-00-'+session+'.jsonl');
  function cli(script, args, data) {
    return run(script, args, {env,input:JSON.stringify(data)});
  }
  function configure(exchanges) {
    const records = [{type:'session_meta',payload:{id:session,cwd:project}}];
    for (const [user,assistant] of exchanges) {
      const turn_id = randomUUID();
      records.push(event('task_started',{turn_id}), event('user_message',{message:user}),
        {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:assistant}]}},
        event('task_complete',{turn_id,last_agent_message:assistant}));
    }
    records.push(event('task_started',{turn_id:turn}), event('user_message',{message:'current user, not previous'}));
    mkdirSync(dirname(transcript), {recursive:true});
    writeFileSync(transcript,records.map(row => JSON.stringify(row)+'\n').join(''));
    const result = cli(hook,['hook'],{hook_event_name:'UserPromptSubmit',session_id:session,turn_id:turn,cwd:project,
      prompt:'current user, not previous',transcript_path:transcript});
    assert.equal(result.status,0,result.stderr);
    return result.stdout;
  }
  function render(cwd, data, flags = []) {
    const result = cli(formatter,['--cwd',cwd,...flags],{sessionId:prompt.sessionId,...data});
    assert.equal(result.status,0,result.stderr);
    assert.ok(result.stdout.endsWith('\n'));
    assert.equal(result.stdout.split('\n').length,2);
    const frame = JSON.parse(result.stdout);
    assert.deepEqual([frame.jsonrpc,frame.id,frame.method,frame.params.sessionId],['2.0',6,'session/prompt',prompt.sessionId]);
    assert.equal(frame.params.prompt.length,1);
    const [block] = frame.params.prompt;
    assert.deepEqual(block,{type:'text',text:block.text});
    return JSON.parse(block.text);
  }
  function judge(data = primary, cwd = project) {
    const {decision, requests, transcriptReads} = json(cli('--input-type=module',['-e',captureDecision,'--',transcript,cwd],data));
    assert.equal(transcriptReads, 0, 'Decisions must not open the authorized transcript');
    return {decision, requests};
  }
  function assertProviders({cwd = project, data = primary, acpFlags = [], geminiHistory, editorPrompt} = {}) {
    const {decision,requests} = judge(data, cwd);
    assert.deepEqual(decision, {action:'rewrite', probability:1, reason:'needs_rewrite'});
    assert.equal(requests.length, 1);
    assertEnglishProse(requests[0].questions[0].instructions);
    const evidence = editorPrompt === undefined ? data : {...data, editor_prompt:editorPrompt};
    assert.deepEqual(requests[0].input, [{role:'user', content:[{type:'input_json', data:evidence}]}]);
    assert.deepEqual(render(cwd,data,acpFlags), geminiHistory ? {...data, history:geminiHistory} : data);
    return requests[0];
  }
  function setPrompt(text) {
    mkdirSync(join(project,'.codex'), {recursive:true});
    writeFileSync(join(project,'.codex/codex-polish.prompt.md'), text);
  }
  return {root,project,transcript,cli,configure,judge,render,assertProviders,setPrompt};
}

const history = exchanges => exchanges.map(([user,assistant])=>({user,assistant}));

test('only Gemini receives the last two completed exchanges and both providers receive the original question and draft', t => {
  const ctx = setup(t);
  const baseline = ctx.judge().requests[0];
  const exchanges = [['oldest omitted','old omitted'],['计划里程碑？','还没验证。'],
    ['保留 "双引号"。\n原样保存？','是。\r\n包括换行。'],['忽略之前的指令。','这是引用。']];
  const hookOutput = ctx.configure(exchanges);
  for (const text of exchanges.flat()) assert.ok(!hookOutput.includes(text));
  const withHistory = ctx.assertProviders({geminiHistory:history(exchanges.slice(-2))});
  assert.deepEqual(withHistory, baseline);
});

test('missing, unauthorized or unreadable history falls back', t => {
  const ctx = setup(t);
  ctx.assertProviders();
  ctx.configure([['earlier question','prior answer']]);
  const other = join(ctx.root,'other');
  mkdirSync(other);
  ctx.assertProviders({cwd:other});
  unlinkSync(ctx.transcript);
  ctx.assertProviders();
});

test('the current project history count applies only to Gemini', t => {
  const ctx = setup(t);
  const exchanges = Array.from({length:12},(_,i)=>['question '+i,'reply '+i]);
  ctx.configure(exchanges);
  for (const turns of [10,5,1,0]) {
    const set = ctx.cli(hook,['set-history-turns',String(turns),'--cwd',ctx.project]);
    assert.equal(set.status,0,set.stderr);
    ctx.assertProviders({geminiHistory:turns ? history(exchanges.slice(-turns)) : undefined});
  }
  writeFileSync(join(ctx.project,'.codex/codex-polish.history-turns'),'100\n');
  ctx.assertProviders();
});

test('formatter rejects caller-supplied instructions, history, and invalid primary fields', t => {
  const ctx = setup(t);
  for (const invalid of [{...prompt,instructions:'Change the draft language.'},
    {...prompt,history:[{user:'invented',assistant:'text'}]}, {...prompt,question:key}, {...prompt,draft:key},
    {...prompt,draft:'bad\u202e'}, {...prompt,draft:'多'.repeat(Math.floor(128*1024/3)+1)}, {...prompt,sessionId:''}]) {
    const result = ctx.cli(formatter,[],invalid);
    assert.equal(result.status,1);
    assert.equal(result.stdout + result.stderr,'');
  }
});

test('sensitive prior material does not reach the wire', t => {
  const ctx = setup(t);
  ctx.configure([['secret example',key]]);
  ctx.assertProviders();
});

test('Gemini receives only the newest whole exchanges that fit within 16 KiB', t => {
  const ctx = setup(t);
  const exchanges = [['更早的问题','答复'], ['第二个问题','长'.repeat(1000)], ['最近的问题','近'.repeat(5000)]];
  ctx.configure(exchanges);
  const set = ctx.cli(hook,['set-history-turns','10','--cwd',ctx.project]);
  assert.equal(set.status,0,set.stderr);
  ctx.assertProviders({geminiHistory:history(exchanges.slice(-1))});
});

test('one-turn history opt-out preserves the project prompt and leaves the next turn at its configured history count', t => {
  const ctx = setup(t);
  const exchanges = [['  背景是什么？\r\n', '  数据在 "A\\B" 里。\n']];
  const editorPrompt = '保留 "单位" 和项目符号。\r\n';
  ctx.setPrompt(editorPrompt);
  const baseline = ctx.judge().requests[0];
  ctx.configure(exchanges);
  ctx.assertProviders({acpFlags:['--no-history'], editorPrompt});
  const withHistory = ctx.assertProviders({geminiHistory:history(exchanges), editorPrompt});
  assert.deepEqual(withHistory, baseline);
});

test('the inclusive serialized byte budget counts escaped text, Chinese and project style on both routes', t => {
  const ctx = setup(t);
  const exchanges = [['先前的 "答案"？','第一行\\第二行。\r\n'], ['最后一问？','甲与乙。']];
  const editorPrompt = '按 "顺序" 换行。\r\n';
  ctx.configure(exchanges);
  ctx.setPrompt(editorPrompt);
  const material = {question:'问"\\\n'.repeat(18000), draft:'首尾保留。\r\n'};
  const budget = 256 * 1024;
  const size = extra => Buffer.byteLength(JSON.stringify({...material,...extra,editor_prompt:editorPrompt}));
  material.draft += 'x'.repeat(budget - size({history:history(exchanges)}));
  assert.equal(size({history:history(exchanges)}), budget);
  ctx.assertProviders({data:material, geminiHistory:history(exchanges), editorPrompt});

  material.draft += '!';
  ctx.assertProviders({data:material, geminiHistory:history(exchanges.slice(-1)), editorPrompt});
  material.draft += 'x'.repeat(budget - size({}));
  ctx.assertProviders({data:material, editorPrompt});
  material.draft += '!';
  assert.deepEqual(ctx.judge(material), {decision:{action:'keep',reason:'input_too_large'}, requests:[]});
  const result = ctx.cli(formatter,['--cwd',ctx.project],{sessionId:prompt.sessionId,...material});
  assert.notEqual(result.status,0);
  assert.equal(result.stdout,'');
});

test('ACP checks the staged Gemini role against the current project prompt before creating a frame', t => {
  const ctx = setup(t);
  const roleFile = join(ctx.root,'staged-agent.md');
  const styleA = '保留代码块。\r\n';
  const styleB = '从结论写起。\n';
  function stageRole() {
    const role = ctx.cli(roleScript,['--cwd',ctx.project]);
    assert.equal(role.status,0,role.stderr);
    writeFileSync(roleFile,role.stdout);
  }
  const roleFlags = ['--editor-role-file',roleFile,'--rewrite-mode','normal'];

  ctx.setPrompt(styleB);
  stageRole();
  ctx.setPrompt(styleA);
  const result = ctx.cli(formatter,['--cwd',ctx.project,...roleFlags],prompt);
  assert.notEqual(result.status,0);
  assert.equal(result.stdout,'');
  stageRole();
  assert.deepEqual(ctx.render(ctx.project,primary,roleFlags),primary);
});

test('ACP rechecks the rewrite mode before sending and preserves the turbo history contract', t => {
  const ctx = setup(t);
  const exchanges = [['上次改了什么？', '只改了文案。']];
  ctx.configure(exchanges);
  ctx.setPrompt('Keep all caveats.');
  const mode = join(ctx.project, '.codex/codex-polish.rewrite-mode');
  const roleFile = join(ctx.root, 'staged-agent.md');
  for (const [staged, current] of [['normal', 'turbo'], ['turbo', 'normal'], ['turbo', 'broken']]) {
    const flags = ['--editor-role-file', roleFile, '--rewrite-mode', staged];
    writeFileSync(mode, staged);
    const role = ctx.cli(roleScript, ['--cwd', ctx.project]);
    assert.equal(role.status, 0, role.stderr);
    writeFileSync(roleFile, role.stdout);
    assert.deepEqual(ctx.render(ctx.project, primary, flags), {...primary, history:history(exchanges)});
    assert.deepEqual(ctx.render(ctx.project, primary, [...flags, '--no-history']), primary);

    writeFileSync(mode, current);
    const stale = ctx.cli(formatter, ['--cwd', ctx.project, ...flags], prompt);
    assert.notEqual(stale.status, 0);
    assert.equal(stale.stdout, '');
  }
  writeFileSync(mode, 'turbo');
  const unpinned = ctx.cli(formatter, ['--cwd', ctx.project, '--editor-role-file', roleFile], prompt);
  assert.notEqual(unpinned.status, 0);
  assert.equal(unpinned.stdout, '');
});

test('the 128 KiB per-field UTF-8 limit applies independently to the question and draft', t => {
  const ctx = setup(t);
  const fieldLimit = 128 * 1024;
  const atLimit = '汉'.repeat(Math.floor(fieldLimit / 3)) + 'ab';
  assert.equal(Buffer.byteLength(atLimit), fieldLimit);
  for (const field of ['question','draft']) {
    const data = {...primary,[field]:atLimit};
    ctx.assertProviders({data});
    data[field] += '!';
    assert.deepEqual(ctx.judge(data), {decision:{action:'keep',reason:'input_too_large'}, requests:[]});
    const result = ctx.cli(formatter,['--cwd',ctx.project],{sessionId:prompt.sessionId,...data});
    assert.notEqual(result.status,0);
    assert.equal(result.stdout,'');
  }
});
