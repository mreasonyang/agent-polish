import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { catalog } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_models.mjs';
import { MAX_CONFIG_FRAME_BYTES } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_models.mjs';
import { promptFrame } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_payload.mjs';
import { Fixture, selectOption } from './fixture_acp.mjs';
import { useTestProfile } from './hook_fixture.mjs';

const script = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_models.mjs', import.meta.url));
function cli(args, frame) {
  return spawnSync(process.execPath, [script, ...args], {input: typeof frame === 'string' ? frame : JSON.stringify(frame), encoding:'utf8', timeout:5000});
}
function rejects(args, frame) {
  const result = cli(args, frame);
  assert.equal(result.status, 1);
  assert.equal(result.stdout + result.stderr, '');
}

const target = 'gemini-4-hydrogen';
const noThinking = { thinking_config_id: null, current_thinking_level: null, thinking_levels: [] };
const targetArgs = id => ['--response-id', String(id), '--target-model', target];
function next(response, level) {
  const args = targetArgs(response.id);
  if (level) args.push('--thinking-level', level);
  const output = cli(args, response);
  assert.equal(output.status, 0, output.stderr);
  return JSON.parse(output.stdout);
}

test('model change exposes the target thinking options, then the default Medium must be confirmed', async t => {
  useTestProfile(t);
  const events = [];
  const fixture = new Fixture('ok', line => events.push(JSON.parse(line)));
  const rpc = (id, method, params) => {
    fixture.handle({ jsonrpc:'2.0', id, method, params });
    return events.at(-1);
  };
  rpc(1, 'initialize', {protocolVersion:1});
  const opened = rpc(3, 'session/new', {cwd:'/offline', mcpServers:[]});
  const model = next(opened);
  assert.deepEqual(model, {next:'set_model', config_id:'model', value:target});
  const sessionId = opened.result.sessionId;
  const selected = rpc(4, 'session/set_config_option', {sessionId, configId:model.config_id, value:model.value});
  assert.equal(selected.result.configOptions.find(option => option.category === 'thought_level').currentValue, 'high');
  assert.deepEqual(next(selected), {next:'set_thinking_level', config_id:'thought_level', value:'medium'});
  const confirmed = rpc(5, 'session/set_config_option', {sessionId, configId:'thought_level', value:'medium'});
  assert.deepEqual(next(confirmed), {next:'submit_prompt'});

  const notice = { jsonrpc:'2.0', method:'session/update', params:{sessionId, update:{
    sessionUpdate:'config_option_update', configOptions:confirmed.result.configOptions,
  }}};
  const observed = cli(['--update-session', sessionId], notice);
  assert.equal(observed.status, 0);
  assert.deepEqual(JSON.parse(observed.stdout), catalog(confirmed.result.configOptions));
  const updateArgs = ['--update-session', sessionId, '--target-model'];
  const checked = cli([...updateArgs, target], notice);
  assert.equal(checked.status, 0);
  assert.deepEqual(JSON.parse(checked.stdout), catalog(confirmed.result.configOptions));
  rejects([...updateArgs, opened.result.configOptions.find(option => option.category === 'model').currentValue], notice);
  rejects([...updateArgs, 'missing-model'], notice);
  rejects(['--update-session', 'other-session', '--target-model', target], notice);
  rejects(targetArgs(4), notice);

  const prompt = await promptFrame({sessionId, question:'When?', draft:'Tomorrow.'});
  fixture.handle(prompt);
  assert.deepEqual(events.at(-1), {jsonrpc:'2.0', id:6, result:{stopReason:'end_turn'}});
  assert.equal(fixture.thinking, 'medium');
});

test('only supported choices can be confirmed, including fixed models with no selector', () => {
  const model = selectOption('model','model','Model',target,[[target,'Gemini 4 Hydrogen']]);
  const response = (id, ...options) => ({jsonrpc:'2.0', id, result:{configOptions:[model, ...options]}});
  assert.deepEqual(next(response(3), 'fixed'), {next:'submit_prompt'});
  rejects(targetArgs(3), response(3));
  const choices = [['low','Low'],['medium','Medium'],['high','High'],['xhigh','Extra']];
  for (const [value] of choices) {
    const level = selectOption('thinking','thought_level','Thinking','high',choices);
    const step = next(response(3, level), value);
    if (value === 'high') assert.deepEqual(step, {next:'submit_prompt'});
    else {
      assert.deepEqual(step, {next:'set_thinking_level', config_id:'thinking', value});
      rejects([...targetArgs(5), '--thinking-level', value], response(5, level));
    }
    assert.deepEqual(next(response(5, {...level, currentValue:value}), value), {next:'submit_prompt'});
    rejects([...targetArgs(3), '--thinking-level', 'fixed'], response(3, level));
  }
  const limited = selectOption('thinking','thought_level','Thinking','high',[['low','Low'],['high','High']]);
  rejects(targetArgs(4), response(4, limited));
});

test('a failed model change or an unexpected response cannot trigger a prompt or retry', () => {
  const model = selectOption('model','model','Model','gemini-4-neon',[[target,'Gemini 4 Hydrogen'],['gemini-4-neon','Gemini 4 Neon']]);
  const response = (id, options) => ({jsonrpc:'2.0', id, result:{configOptions:options}});
  rejects(targetArgs(4), response(4,[model]));
  rejects(targetArgs(3), response(3, new Fixture('no-hydrogen').options()));
  const chosen = {...model, currentValue:target};
  for (const id of [5,6]) rejects(targetArgs(id), response(id,[chosen]));
  rejects(targetArgs(4), {jsonrpc:'2.0', id:4, error:{code:-32602}});
});

test('catalog preserves provider order and uses the provider IDs to identify Gemini entries', () => {
  const choices = [
    ['gemini-4-neon','Gemini 4 Neon'], ['gemini-4-argon','Gemini 4 Argon'], ['gemini-4-hydrogen','Gemini 4 Hydrogen'],
    ['gemini-pro-orchestrator-neon','Orchestrator (Neon)'], ['gemini-pro-orchestrator-g1-pro','Orchestrator (Argon)'],
    ['gemini-3.8-flash','Gemini 3.8 Flash'], ['claude-opus-5-5','Claude Opus 5.5'], ['gpt-oss-120b-medium','GPT-OSS 120B (Medium)']];
  const selector = selectOption('model','model','Model',choices[0][0],choices);
  const out = cli(['--response-id','3'], {jsonrpc:'2.0', id:3, result:{
    configOptions:[selector], sessionId:'must-omit', _meta:{hidden:true}}});
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {...noThinking,config_id:'model', current_model:'gemini-4-neon',
    models:choices.filter(([id]) => id.startsWith('gemini-')).map(([id,name]) => ({id,name}))});
});

test('grouped model values from the current ACP schema', () => {
  const options = new Fixture('ok').options();
  const [selector] = options;
  selector.options = selector.options.map((entry, i) => ({group:String(i),name:'ignore group label',options:[entry]}));
  const out = catalog(options);
  assert.equal(out.config_id, 'model');
  assert.equal(out.current_model, 'gemini-3.8-flash');
  assert.ok(out.models.some(item => item.id === 'gemini-4-hydrogen' && item.name === 'Gemini 4 Hydrogen'));
});

test('model labels can be localized or duplicated without changing the selected provider ID', () => {
  const selector = selectOption('model','model','Model','claude-opus', [
    ['gemini-4-neon','Gemini Pro'], ['gemini-4-argon','Gemini Pro'], ['claude-opus','Claude Opus'],
    ['opaque-id','Gemini 4 Hydrogen'], ['google/gemini-2.5-flash','Flash'], ['gemini-4-hydrogen','Hydrogen']]);
  assert.deepEqual(catalog([selector]), {...noThinking,config_id:'model', current_model:null, models:[
    {id:'gemini-4-neon', name:'Gemini Pro'}, {id:'gemini-4-argon', name:'Gemini Pro'},
    {id:'google/gemini-2.5-flash', name:'Flash'}, {id:'gemini-4-hydrogen', name:'Hydrogen'}]});
});

test('display punctuation, provider aliases and namespace prefixes work from lookup through confirmation', () => {
  for (const [id, name] of [
    ['gemini-4-argon', 'Gemini 4 Argon / Preview'],
    ['models/gemini-4-argon', 'Gemini 4 Argon: High'],
    ['google:gemini-4-argon', 'Gemini 4 Argon (Auto)'],
    ['publishers/google/models/gemini-4-argon:preview', '氩 / 预览 🧪'],
  ]) {
    const option = selectOption('model','model','Model','other',[[id,name],['other','Gemini-looking label']]);
    option.options[0].description = 'not part of the menu';
    const result = n => ({jsonrpc:'2.0',id:n,result:{configOptions:[option]}});
    const choose = n => JSON.parse(cli(['--response-id',String(n),'--target-model',id,'--thinking-level','fixed'],result(n)).stdout);
    assert.deepEqual(catalog([option]), {...noThinking,config_id:'model',current_model:null,models:[{id,name}]});
    assert.deepEqual(choose(3),{next:'set_model', config_id:'model', value:id});
    option.currentValue = id;
    assert.deepEqual(choose(4),{next:'submit_prompt'});
  }
});

test('unrelated malformed entries and duplicate aliases cannot hide a usable model', () => {
  const model = selectOption('model','model','Model',target,[[target,'Hydrogen']]);
  model.options.unshift(null, 1, {value:'other'}, {options:'invalid'}, {name:'no ID'});
  model.options.push({group:'others',options:[{value:'gemini-4-argon'}, null, {value:target,name:'other label'}]});
  const configOptions=[null, {category:'other'}, model];
  assert.deepEqual(catalog(configOptions), {...noThinking,config_id:'model',current_model:target,models:[
    {id:target,name:'Hydrogen'}, {id:'gemini-4-argon',name:'gemini-4-argon'}]});
  assert.deepEqual(next({jsonrpc:'2.0',id:3,result:{configOptions}}, 'fixed'),{next:'submit_prompt'});
  model.currentValue = 'unlisted-current-model';
  assert.deepEqual(next({jsonrpc:'2.0',id:3,result:{configOptions}}), {next:'set_model',config_id:'model',value:target});
  rejects(targetArgs(4),{jsonrpc:'2.0',id:4,result:{configOptions}});
});

test('invalid, ambiguous and unsettable model selectors are rejected', () => {
  const model = selectOption('model','model','Model','gemini-pro',[['gemini-pro','Gemini Pro']]);
  for (const options of [[], [model, {...model,id:'other'}], [model,{id:'model',category:'thought_level'}],
    [{...model,type:'boolean'}],[{...model,currentValue:false}], [{...model,id:''}],
    [{...model,category:undefined}],[{...model,options:undefined}]]) assert.throws(() => catalog(options));
  rejects(['--response-id','3'], {jsonrpc:'2.0',id:3,result:{models:{availableModels:['unusable']}}});
});

test('responses and updates must match the open session and have unambiguous JSON', () => {
  const configOptions = new Fixture('ok').options();
  const response = {jsonrpc:'2.0',id:4,result:{configOptions}};
  const update = {sessionUpdate:'config_option_update',configOptions};
  const notice = {jsonrpc:'2.0', method:'session/update', params:{sessionId:'s',update}};
  assert.deepEqual(JSON.parse(cli(['--response-id','4'],response).stdout), catalog(configOptions));
  assert.deepEqual(JSON.parse(cli(['--update-session','s'],notice).stdout), catalog(configOptions));
  for (const [args, frame] of [
    [['--response-id','3'],response], [['--response-id','4'],{...response,error:{message:'private'}}],
    [['--response-id','1'],{...response,id:true}], [['--response-id','0'],notice],
    [['--update-session','other'],notice], [['--update-session','s'],response],
    [['--update-session','s'],{...notice,params:{sessionId:'s',update:{...update,sessionUpdate:'agent_message_chunk'}}}],
    [['--response-id','4'],JSON.stringify(response).replace('"id":4','"id":3,"id":4')],
    [['--response-id','4'],JSON.stringify(response).replace('"id":4','"id":4.0')],
    [['--response-id','4'],JSON.stringify(response).replace('"id":4','"id":3,"\\u0069d":4')],
    [['--response-id','4'],'x'.repeat(MAX_CONFIG_FRAME_BYTES+1)]]) rejects(args, frame);
});
