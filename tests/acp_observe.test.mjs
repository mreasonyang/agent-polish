import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prepareWorkspace } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_workspace.mjs';
import { originalReplyText } from '../plugins/codex-polish/skills/codex-polish/scripts/format_reply.mjs';
import { Fixture, SESSION } from './fixture_acp.mjs';

const script = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_observe.mjs', import.meta.url));
const model = 'gemini-4-hydrogen';
const session = 'session-1';
const line = data => JSON.stringify({jsonrpc:'2.0', ...data}) + '\n';
const init = line({id:1, result:{protocolVersion:1, agentCapabilities:{sessionCapabilities:{close:true}},
  authMethods:[{id:'agent-platform'}]}});
const config = new Fixture('ok').options();
const opened = line({id:3, result:{sessionId:session, configOptions:config}});
const selected = config.map(opt=>({...opt, currentValue:model}));
const selectedResponse = line({id:4, result:{configOptions:selected}});
const update = (id, type, fields) => line({method:'session/update', params:{sessionId:id, update:{sessionUpdate:type, ...fields}}});
const content = text => ({content:{type:'text', text}});
const end = line({id:6,result:{stopReason:'end_turn'}});

function context(t, catalogOnly = false, display = 'zh', scopeArgs = [], quoted = false) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(),'polish-observer-test-'));
  const agyPath = path.join(project,'agy');
  fs.writeFileSync(agyPath,'',{mode:0o700});
  const log = catalogOnly ? path.join(project,'catalog.jsonl') : undefined;
  const setup = prepareWorkspace(catalogOnly ? {agyPath,auth:'agent-platform',catalog:true,catalogLog:log} :
    {agyPath,cwd:project,trigger:'auto',model,auth:'existing-session',route:'acp',rewriteMode:'normal',display});
  t.after(()=>{ fs.rmSync(project,{recursive:true,force:true}); fs.rmSync(setup.workspace,{recursive:true,force:true}); });
  function observe(frames, displayLine = JSON.stringify({ draft: '  原稿\r\n' }) + '\n') {
    const args = catalogOnly ? ['--auth','agent-platform','--catalog','--catalog-log',log] :
      ['--auth','existing-session','--model',model,'--display',display,'--payload-args',JSON.stringify(['--cwd',project,...scopeArgs])];
    if (quoted) args.push('--quoted-source');
    let fd;
    try {
      if (!catalogOnly) {
        fd = fs.openSync(path.join(setup.workspace,'.acp-display'),fs.constants.O_RDWR);
        fs.writeFileSync(fd, displayLine);
      }
      const env = { ...process.env };
      delete env.CODEX_POLISH_SUPERVISOR_PID;
      const child = spawnSync(process.execPath,[script,...args,'--workspace-token',setup.write_token],{cwd:setup.workspace,env,input:frames,encoding:'utf8',timeout:5000});
      assert.ifError(child.error);
      assert.equal(child.status,0,child.stderr || child.signal);
      return child.stdout.trim().split('\n').map(line=>JSON.parse(line));
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return {observe, log, mark() {
    fs.linkSync(path.join(setup.workspace,'.acp-owner'),path.join(setup.workspace,'.acp-prompt'));
    fs.writeFileSync(path.join(setup.workspace,'.acp-prompt'),session);
  }};
}

test('observer handles batched model updates, refuses permission and delivers one exact answer', t=>{
  const ctx = context(t); ctx.mark();
  const permission = line({id:6,method:'session/request_permission',params:{sessionId:session}});
  const other = update(SESSION,'agent_message_chunk',content('foreign'));
  const own = update(session,'agent_message_chunk',content(' \n雪🚲 \r\n'));
  const configuration = update(session,'config_option_update',{configOptions:selected});
  const messages = ctx.observe(init+opened+selectedResponse+other+permission+configuration+own+end+permission);
  assert.deepEqual(messages.map(m=>m.event),['send','send','send','submit','send','delivery']);
  assert.match(messages[4].exec.cmd,/cancelled/);
  assert.deepEqual(messages[5], { event: 'delivery', markdown: '**Gemini 润色版**\n\n \n雪🚲 \r\n\n\n<details><summary>查看 GPT 原稿</summary>\n\n  原稿\r\n\n\n</details>' });
  assert.equal(originalReplyText(messages[5].markdown), '  原稿\r\n');
});

test('delivery respects body-only mode, quoted scope, and identical replies', t => {
  for (const [mode, args, quoted, draft, candidate, expected] of [
    ['body-only', [], false, 'source', '  copy\r\n\n', '  copy\r\n\n'],
    ['en', ['--selection-only'], false, ' \tsource\r\n', 'copy', '**Polished by Gemini**\n\ncopy\n\n<details><summary>View original text</summary>\n\n \tsource\r\n\n\n</details>'],
    ['zh', [], true, 'copy', 'copy', '**Gemini 返回了原文** <!-- codex-polish -->\n\ncopy'],
    ['en', [], false, 'copy', 'copy', '**Gemini returned the original draft** <!-- codex-polish -->\n\ncopy'],
    ['zh', [], false, 'copy', 'copy', '**Gemini 返回了原稿** <!-- codex-polish -->\n\ncopy'],
  ]) {
    const ctx = context(t, false, mode, args, quoted);
    ctx.mark();
    const wire = init + opened + selectedResponse + update(session, 'agent_message_chunk', content(candidate)) + end;
    const result = ctx.observe(wire, JSON.stringify({draft}) + '\n').at(-1);
    assert.deepEqual(result, { event:'delivery', markdown:expected });
    if (mode !== 'body-only') assert.equal(originalReplyText(result.markdown), draft);
  }
});

test('malformed local display material or a missing historical question never exposes the candidate', t => {
  const ctx = context(t, false, 'en', ['--turns-back','3']);
  ctx.mark();
  const wire = init + opened + selectedResponse + update(session, 'agent_message_chunk', content('private candidate')) + end;
  for (const invalid of ['{"draft":"source"}\n','{"draft":"source","question":"q","history":[]}\n','{}\n']) {
    const events = ctx.observe(wire, invalid);
    assert.deepEqual(events.at(-1), {event:'error', stage:'delivery', reason:'acp_display_failed'});
    assert.ok(!JSON.stringify(events).includes('private candidate'));
  }
  const complete = {draft:'source', question:'  Which old item?\r\n  请保留这行。\r\n'};
  const valid = ctx.observe(wire, JSON.stringify(complete) + '\n');
  assert.match(valid.find(message => message.event === 'submit').exec.cmd, /'--turns-back' '3'/);
  assert.doesNotMatch(valid.find(message => message.event === 'submit').exec.cmd, /--display|--quoted-source/);
  assert.equal(valid.at(-1).event, 'delivery');
  assert.equal(originalReplyText(valid.at(-1).markdown), complete.draft);
});

test('a premature EOF or changed model never releases a partial answer', t=>{
  const ctx = context(t); ctx.mark();
  const before = init+opened+selectedResponse+update(session,'agent_message_chunk',content('partial'));
  for (const [tail,reason] of [[end.trimEnd(),'acp_incomplete'],[update(session,'config_option_update',{configOptions:config})+end,'acp_model_unavailable']]) {
    const msgs=ctx.observe(before+tail);
    assert.equal(msgs.at(-1).reason,reason);
    assert.ok(!msgs.some(x=>Object.hasOwn(x,'text')));
  }
});

test('catalog authenticates, records only the successful raw model response and never requests a prompt', t=>{
  const ctx = context(t,true);
  const msgs=ctx.observe(init+line({id:2,result:{}})+opened);
  assert.equal(msgs[1].event,'send');
  assert.match(msgs[1].exec.cmd,/authenticate/);
  assert.deepEqual(msgs.map(m=>m.event),['send','send','send','catalog']);
  assert.ok(msgs.at(-1).models.some(m=>m.id===model));
  assert.equal(fs.readFileSync(ctx.log,'utf8'),opened);
});
