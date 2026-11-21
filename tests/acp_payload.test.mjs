import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, run, temporary } from './hook_fixture.mjs';
import { prepareWorkspace } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_workspace.mjs';

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
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const agy = process.platform === 'win32' ? 'agy.exe' : 'agy';
  // The payload policy checks availability but never starts the provider.
  writeFileSync(join(bin, agy), '', { mode: 0o700 });
  const env = {PATH:[bin,dirname(process.execPath)].join(delimiter),HOME:root,USERPROFILE:root,
    CODEX_HOME:join(root,'codex'),CODEX_THREAD_ID:session,XDG_CACHE_HOME:join(root,'cache')};
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  const transcript = join(env.CODEX_HOME, 'sessions/2026/11/19', 'rollout-2026-11-19T11-30-00-'+session+'.jsonl');
  function cli(script, args, data) {
    return run(script, args, {env,input:JSON.stringify(data)});
  }
  function configure(exchanges, currentQuestion = 'current user, not previous', verifiedIndex) {
    const records = [{type:'session_meta',payload:{id:session,cwd:project}}];
    mkdirSync(dirname(transcript), {recursive:true});
    function submit(turn_id, prompt) {
      writeFileSync(transcript, records.map(row => JSON.stringify(row) + '\n').join(''));
      const result = cli(hook, ['hook'], {hook_event_name:'UserPromptSubmit', session_id:session, turn_id,
        cwd:project, prompt, transcript_path:transcript});
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    }
    for (const [index, [user,assistant]] of exchanges.entries()) {
      const turn_id = randomUUID();
      records.push(event('task_started',{turn_id}), event('user_message',{message:user}));
      if (index === verifiedIndex) {
        submit(turn_id, user);
        const script = join(plugin, 'skills/codex-polish/scripts/format_reply.mjs');
        assert.equal(json(cli(script, ['--cwd', project, '--skipped'], {draft:assistant, reason:'Kept the draft.'})).text, assistant);
      }
      records.push(
        {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:assistant}]}},
        event('task_complete',{turn_id,last_agent_message:assistant}));
    }
    records.push(event('task_started',{turn_id:turn}), event('user_message',{message:currentQuestion}));
    return submit(turn, currentQuestion);
  }
  function workflowFlags(cwd, flags = [], trigger = 'auto') {
    const scope = flags.includes('--selection-only') ? ['--selection-only'] : [];
    const status = json(cli(hook, ['check', '--cwd', cwd, '--trigger', trigger, ...scope]));
    const pinned = ['--trigger', trigger, '--route', status.decisions_enabled ? 'decisions' : 'acp', '--model', status.gemini_model];
    if (flags.includes('--editor-role-file')) return [...pinned, ...flags];
    const roleFile = join(root, scope.length ? 'render-role-selection-only.md' : 'render-role-' + trigger + '.md');
    const role = cli(roleScript, ['--cwd', cwd, '--trigger', trigger, ...scope]);
    assert.equal(role.status, 0);
    writeFileSync(roleFile, role.stdout);
    return [...pinned, '--editor-role-file', roleFile, '--rewrite-mode', status.rewrite_mode, ...flags];
  }
  function render(cwd, data, flags = []) {
    const result = cli(formatter,['--cwd',cwd,...workflowFlags(cwd, flags)],{sessionId:prompt.sessionId,...data});
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
  return {root,project,transcript,env,cli,configure,judge,render,workflowFlags,assertProviders,setPrompt};
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
  assert.ok(json(ctx.cli(hook,['check','--cwd',ctx.project])).blockers.includes('history_turns_invalid'));
  const flags = ['--cwd', ctx.project, ...ctx.workflowFlags(ctx.project)];
  assert.notEqual(ctx.cli(formatter,flags,prompt).status,0);
  assert.deepEqual(ctx.render(ctx.project,primary,['--no-history']),primary);
});

test('formatter rejects caller-supplied instructions, history, and invalid primary fields', t => {
  const ctx = setup(t);
  const flags = ['--cwd', ctx.project, ...ctx.workflowFlags(ctx.project)];
  for (const invalid of [{...prompt,instructions:'Change the draft language.'},
    {...prompt,history:[{user:'invented',assistant:'text'}]}, {...prompt,question:null}, {...prompt,draft:''},
    {...prompt,draft:'bad\ud800'}, {...prompt,sessionId:''}]) {
    const result = ctx.cli(formatter,flags,invalid);
    assert.equal(result.status,1);
    assert.equal(result.stdout + result.stderr,'');
  }
});

test('Normal passes raw text to Decisions and Gemini, including literal credentials, controls and machine output', t => {
  const ctx = setup(t);
  const exchanges = [['password=示例值', key]];
  ctx.configure(exchanges);
  const editorPrompt = 'Preserve the sample token=example-value.\u2066';
  ctx.setPrompt(editorPrompt);
  for (const draft of ['{"status":"ok"}', 'git status', '~~~md\nunfinished', '\u001b[31m' + key]) {
    ctx.assertProviders({data:{question:'把示例里的 password=示例值 换成环境变量。', draft}, geminiHistory:history(exchanges), editorPrompt});
  }
});

test('Gemini receives all configured exchanges even when their combined text exceeds 16 KiB', t => {
  const ctx = setup(t);
  const exchanges = [['更早的问题','答复'], ['第二个问题','长'.repeat(1000)], ['最近的问题','近'.repeat(5000)]];
  ctx.configure(exchanges);
  const set = ctx.cli(hook,['set-history-turns','10','--cwd',ctx.project]);
  assert.equal(set.status,0,set.stderr);
  ctx.assertProviders({geminiHistory:history(exchanges)});
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

test('the Decisions input limit does not trim the ACP frame or staged editor role', t => {
  const ctx = setup(t);
  const exchanges = [['先前的 "答案"？','第一行\\第二行。\r\n'], ['最后一问？','甲与乙。']];
  const editorPrompt = '按 "顺序" 换行。\r\n'.repeat(2500);
  ctx.configure(exchanges);
  ctx.setPrompt(editorPrompt);
  const material = {question:'问"\\\n'.repeat(18000), draft:'汉'.repeat(50_000)};
  assert.ok(Buffer.byteLength(editorPrompt) > 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(material)) > 256 * 1024);
  assert.deepEqual(ctx.judge(material), {decision:{action:'keep',reason:'decision_input_too_large'}, requests:[]});
  assert.deepEqual(ctx.render(ctx.project, material), {...material, history:history(exchanges)});
  const role = ctx.cli(roleScript, ['--cwd', ctx.project]);
  assert.equal(role.status, 0, role.stderr);
  assert.ok(role.stdout.endsWith(editorPrompt));
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
  const result = ctx.cli(formatter,['--cwd',ctx.project,...ctx.workflowFlags(ctx.project, roleFlags)],prompt);
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
    const stale = ctx.cli(formatter, ['--cwd', ctx.project, ...ctx.workflowFlags(ctx.project, flags)], prompt);
    assert.notEqual(stale.status, 0);
    assert.equal(stale.stdout, '');
  }
  writeFileSync(mode, 'turbo');
  const unpinned = ctx.cli(formatter, ['--cwd', ctx.project, '--editor-role-file', roleFile], prompt);
  assert.notEqual(unpinned.status, 0);
  assert.equal(unpinned.stdout, '');
});

test('no ACP frame is written when the approved route, trigger or selected model changes', t => {
  const ctx = setup(t);
  const base = ['--cwd', ctx.project, ...ctx.workflowFlags(ctx.project)];
  const render = flags => ctx.cli(formatter, flags, prompt);
  const block = flags => {
    const result = render(flags);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  };
  assert.equal(render(base).status, 0);
  block(['--cwd', ctx.project]);
  for (const flag of ['--editor-role-file','--trigger','--route','--model','--rewrite-mode']) {
    const incomplete = [...base];
    incomplete.splice(incomplete.indexOf(flag), 2);
    block(incomplete);
  }
  const set = (cmd, arg) => assert.equal(ctx.cli(hook, [cmd, arg, '--cwd', ctx.project]).status, 0);
  set('set-mode', 'manual'); block(base);
  block(base.map(x => x === 'auto' ? 'explicit' : x));
  const explicit = ['--cwd', ctx.project, ...ctx.workflowFlags(ctx.project, [], 'explicit')];
  assert.equal(render(explicit).status, 0);
  block(explicit.map(x => x === 'explicit' ? 'turbo' : x));
  set('set-mode', 'off'); block(explicit);
  set('set-mode', 'auto');
  ctx.env.OPENAI_API_KEY = 'example';
  block(base);
  const withDecision = base.map(x => x === 'acp' ? 'decisions' : x);
  assert.equal(render(withDecision).status, 0);
  set('set-decisions', 'off'); block(withDecision);
  set('set-model', 'gemini-other'); block(base);
});

test('large UTF-8 question or draft reaches both providers intact', t => {
  const ctx = setup(t);
  const large = '汉'.repeat(60_000);
  for (const field of ['question','draft']) ctx.assertProviders({data:{...primary,[field]:large}});
});

test('explicit selections send the exact passage and only the separately permitted editing directions', t => {
  const ctx = setup(t);
  const selection = '  password=示例值\u202e\r\n\r\n`draft` 和 `question` 是原文。  \r\n';
  const directions = 'Keep the sample token=example-value.';
  const custom = 'PROJECT-PROMPT-CANARY';
  const excluded = ['PRIOR-QUESTION-CANARY', 'PRIOR-REPLY-CANARY', 'SURROUNDING-TEXT-CANARY', 'LOCAL-NOTE-CANARY'];
  ctx.configure([[excluded[0], excluded[1]]], [excluded[2], selection, directions, excluded[3]].join('\n'));
  ctx.setPrompt(custom);

  function render(scope, data, extra = []) {
    const flags = ctx.workflowFlags(ctx.project, [scope], 'explicit');
    const role = readFileSync(flags[flags.indexOf('--editor-role-file') + 1], 'utf8');
    assert.equal(role.includes(custom), scope === '--selection');
    const result = ctx.cli(formatter, ['--cwd', ctx.project, ...flags, ...extra], {sessionId:prompt.sessionId, ...data});
    const frame = json(result);
    const expected = {draft:selection};
    if (Object.hasOwn(data, 'rewrite_request')) expected.rewrite_request = directions;
    for (const text of excluded) assert.ok(!result.stdout.includes(text));
    assert.deepEqual(frame, {
      jsonrpc:'2.0', id:6, method:'session/prompt',
      params:{sessionId:prompt.sessionId, prompt:[{type:'text', text:JSON.stringify(expected)}]},
    });
  }

  render('--selection', {selection, rewrite_request:directions});
  render('--selection', {selection});
  render('--selection-only', {selection});
  render('--selection-only', {selection}, ['--no-history']);
  ctx.setPrompt(key);
  render('--selection-only', {selection});
});

test('the selection CLI rejects mixed inputs, history targeting, automatic triggers, and a mismatched role', t => {
  const ctx = setup(t);
  ctx.setPrompt('Private project style.');
  const explicit = ctx.workflowFlags(ctx.project, [], 'explicit');
  const strict = ctx.workflowFlags(ctx.project, ['--selection-only'], 'explicit');
  const automatic = ctx.workflowFlags(ctx.project);
  const selected = {selection:'The selected paragraph.'};
  function blocked(data, flags) {
    const result = ctx.cli(formatter, ['--cwd', ctx.project, ...flags], {sessionId:prompt.sessionId, ...data});
    assert.equal(result.status, 1);
    assert.equal(result.stdout + result.stderr, '');
  }

  blocked(selected, explicit);
  blocked(selected, [...explicit, '--selection-only']); // Staged role contains the project prompt.
  blocked({...selected, rewrite_request:'These directions must stay local.'}, strict);
  blocked({...selected, rewrite_request:null}, strict);
  blocked(selected, [...strict, '--selection']);
  for (const flag of ['--selection', '--selection-only']) blocked(selected, [...automatic, flag]);
  for (const flags of [[...explicit, '--selection'], strict]) {
    blocked(selected, [...flags, '--turns-back', '1']);
    for (const data of [primary, {}, {selection:' '}, {selection:['one', 'two']},
      {...selected, question:'Mixed user request'}, {...selected, draft:'Entire reply'},
      {...selected, history:[]}, {...selected, notes:'Private notes'}]) blocked(data, flags);
  }
});

test('an explicit rewrite sends the selected earlier question and draft, its preceding context, and optional directions', t => {
  const ctx = setup(t);
  ctx.env.OPENAI_API_KEY = 'test-only';
  const older = ['How does caching work?', 'The browser can reuse the old image.'];
  const target = {question:'Why do I still see the old avatar?', draft:'Your browser still has the old image.'};
  ctx.configure([older, [target.question, target.draft], ['What time is the meeting?', 'Nine.']],
    'Rewrite your earlier reply about the old avatar. Make it two sentences.', 1);
  const roleFile = join(ctx.root, 'once.md');
  const stage = trigger => {
    const role = ctx.cli(roleScript, ['--cwd', ctx.project, '--trigger', trigger]);
    assert.equal(role.status, 0, role.stderr);
    writeFileSync(roleFile, role.stdout);
    return role.stdout;
  };
  const flags = ['--cwd',ctx.project,'--trigger','explicit','--rewrite-mode','turbo',
    '--route','acp','--model','gemini-4-hydrogen','--editor-role-file',roleFile];
  function frame(material, extra = []) {
    const raw = ctx.cli(formatter, [...flags,...extra], {sessionId:prompt.sessionId,...material});
    if (raw.status !== 0) {
      assert.equal(raw.stdout, '');
      return null;
    }
    return JSON.parse(JSON.parse(raw.stdout).params.prompt[0].text);
  }

  stage('auto');
  assert.equal(frame(target), null, 'the previously staged Normal role must not be used');
  assert.match(stage('explicit'), /Always rewrite/);
  const edit = {...target, rewrite_request:'Make it two sentences.'};
  const pinned = ['--turns-back','2'];
  assert.deepEqual(frame(target,pinned), {...target,history:history([older])});
  assert.deepEqual(frame(edit,pinned), {...edit,history:history([older])});
  assert.deepEqual(frame(edit,[...pinned,'--no-history']), edit);
  assert.deepEqual(frame({...primary,rewrite_request:'Shorter.'},['--no-history']), {...primary,rewrite_request:'Shorter.'});
  assert.equal(frame(edit,['--turns-back','1']), null, 'a stale or incorrect target cannot be sent');
  assert.equal(frame(edit,['--turns-back','4']), null);
  assert.deepEqual(frame({...edit,rewrite_request:key},pinned), {...target, rewrite_request:key, history:history([older])});
  assert.equal(frame({...edit,rewrite_request:[]},pinned), null);
  ctx.cli(hook,['set-history-turns','0','--cwd',ctx.project]);
  assert.deepEqual(frame(edit,pinned), edit, 'zero history still permits a requested old reply');
  ctx.setPrompt('Keep regional spelling.');
  assert.ok(stage('explicit').endsWith('Keep regional spelling.'));
  assert.deepEqual(frame(edit,pinned), edit, 'the full custom role remains compatible with turn-specific directions');

  assert.equal(json(ctx.cli(hook,['check','--cwd',ctx.project])).rewrite_mode,'normal');
  for (const mode of ['normal', 'turbo']) {
    json(ctx.cli(hook, ['set-rewrite-mode', mode, '--cwd', ctx.project]));
    const automatic = ['--cwd', ctx.project, ...ctx.workflowFlags(ctx.project)];
    for (const [data, flags] of [[target, pinned], [edit, []]]) {
      const result = ctx.cli(formatter, [...automatic, ...flags], { sessionId:prompt.sessionId, ...data });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
    }
  }
});

function submission(t, ctx, scope, flags) {
  const settings = { agyPath: join(ctx.root, 'bin/agy'), cwd: ctx.project, auth: 'existing-session', trigger: 'explicit',
    model: 'gemini-4-hydrogen', route: 'acp', rewriteMode: 'turbo', display: 'zh', ...scope };
  const prepared = prepareWorkspace(settings);
  const { workspace, write_token, editor_role_file } = prepared;
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const command = (args, input) => spawnSync(process.execPath, [join(plugin, 'skills/codex-polish/scripts/acp_workspace.mjs'), ...args], {
    cwd: workspace, env: ctx.env, encoding: 'utf8', input, timeout: 5000,
  });
  assert.equal(command(['--activate', write_token]).status, 0);
  const open = name => {
    const fd = openSync(join(workspace, name), constants.O_RDWR | constants.O_NONBLOCK);
    t.after(() => closeSync(fd));
    return fd;
  };
  const display = open('.acp-display');
  const provider = open('.acp-in');
  const record = fd => {
    const data = Buffer.alloc(8192);
    const size = readSync(fd, data);
    return JSON.parse(data.subarray(0, size).toString('utf8'));
  };
  return { workspace, readLocal: () => record(display), readProvider: () => record(provider),
    send: data => command(['--write', write_token, 'prompt', '--submit', '--session-id', 'fixture-session',
      '--cwd', ctx.project, '--editor-role-file', editor_role_file, '--route', settings.route, '--rewrite-mode', settings.rewriteMode,
      '--trigger', settings.trigger, '--model', settings.model, ...flags], JSON.stringify(data) + '\n') };
}

const fifoTest = process.platform === 'win32' ? test.skip : test;

fifoTest('local display receives the exact earlier question and draft while only ACP gets history and directions', t => {
  const ctx = setup(t);
  const earlier = ['Earlier context', 'Earlier response'];
  const targeted = ['  Which version?\r\n', '  Version two.\n'];
  ctx.configure([earlier, targeted, ['Later?', 'Later.']], 'Rewrite the second most recent reply.', 1);
  const pipe = submission(t, ctx, { turnsBack: 2, display: 'en' }, ['--turns-back', '2']);
  const data = { question: targeted[0], draft: targeted[1], rewrite_request: 'Be concise.' };
  assert.equal(pipe.send(data).status, 0);
  assert.deepEqual(pipe.readLocal(), { question: targeted[0], draft: targeted[1] });
  const expected = { question: targeted[0], draft: targeted[1], history: history([earlier]), rewrite_request: data.rewrite_request };
  const frame = pipe.readProvider();
  assert.deepEqual(frame, { jsonrpc: '2.0', id: 6, method: 'session/prompt',
    params: { sessionId: 'fixture-session', prompt: [{ type: 'text', text: JSON.stringify(expected) }] } });
  assert.equal(pipe.send(data).status, 1);
  assert.throws(pipe.readLocal, { code: 'EAGAIN' });
  assert.throws(pipe.readProvider, { code: 'EAGAIN' });
});

fifoTest('selected and quoted originals keep all display fields out of the ACP frame', t => {
  const ctx = setup(t);
  const pipe = submission(t, ctx, { selection: true, quotedSource: true, display: 'body-only' }, ['--selection']);
  const data = { selection: 'Only this paragraph.\r\n', rewrite_request: 'Keep the quotation.' };
  assert.equal(pipe.send(data).status, 0);
  assert.deepEqual(pipe.readLocal(), { draft: data.selection });
  const frame = pipe.readProvider();
  assert.deepEqual(frame.params, { sessionId: 'fixture-session', prompt: [
    { type: 'text', text: JSON.stringify({ draft: data.selection, rewrite_request: data.rewrite_request }) },
  ] });
});

fifoTest('a substituted display pipe prevents submission without writing to the replacement', t => {
  const ctx = setup(t);
  const pipe = submission(t, ctx, {}, []);
  const local = join(pipe.workspace, '.acp-display');
  unlinkSync(local);
  writeFileSync(local, 'foreign');
  assert.equal(pipe.send(primary).status, 1);
  assert.equal(readFileSync(local, 'utf8'), 'foreign');
  assert.throws(pipe.readLocal, { code: 'EAGAIN' });
  assert.throws(pipe.readProvider, { code: 'EAGAIN' });
});
