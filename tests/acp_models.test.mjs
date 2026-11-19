import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { catalog } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_models.mjs';
import { MAX_REQUEST } from '../plugins/codex-polish/skills/codex-polish/scripts/text_guard.mjs';
import { Fixture, selectOption } from './fixture_acp.mjs';

const script = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_models.mjs', import.meta.url));
function cli(args, frame) {
  return spawnSync(process.execPath, [script, ...args], {input: typeof frame === 'string' ? frame : JSON.stringify(frame), encoding:'utf8', timeout:5000});
}
function rejects(args, frame) {
  const result = cli(args, frame);
  assert.equal(result.status, 1);
  assert.equal(result.stdout + result.stderr, '');
}

test('catalog preserves provider order and excludes routers and non-Gemini models', () => {
  const choices = [
    ['gemini-4-neon','Gemini 4 Neon'], ['gemini-4-argon','Gemini 4 Argon'], ['gemini-4-hydrogen','Gemini 4 Hydrogen'],
    ['gemini-pro-orchestrator-neon','Orchestrator (Neon)'], ['gemini-pro-orchestrator-g1-pro','Orchestrator (Argon)'],
    ['gemini-3.8-flash','Gemini 3.8 Flash'], ['claude-opus-5-5','Claude Opus 5.5'], ['gpt-oss-120b-medium','GPT-OSS 120B (Medium)']];
  const selector = selectOption('model','model','Model',choices[0][0],choices);
  const out = cli(['--response-id','3'], {jsonrpc:'2.0', id:3, result:{
    configOptions:[selector], sessionId:'must-omit', _meta:{hidden:true}}});
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {config_id:'model', current_model:'gemini-4-neon',
    models:choices.filter(([,name]) => name.startsWith('Gemini ')).map(([id,name]) => ({id,name}))});
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

test('labels cannot substitute for raw provider IDs and non-Gemini current is null', () => {
  const selector = selectOption('model','model','Model','claude-opus', [
    ['gemini-4-neon','Gemini Pro'], ['gemini-4-argon','Gemini Pro'], ['claude-opus','Claude Opus'],
    ['opaque-id','Gemini 4 Hydrogen'], ['google/gemini-2.5-flash','Flash'], ['gemini-4-hydrogen','Hydrogen']]);
  assert.deepEqual(catalog([selector]), {config_id:'model', current_model:null, models:[
    {id:'gemini-4-neon', name:'Gemini Pro'}, {id:'gemini-4-argon', name:'Gemini Pro'}]});
});

test('mislabeled values, metadata and unsafe display text stay private', () => {
  const selector = selectOption('model','model','Model','opaque', [
    ['claude-sonnet','Gemini 4 Hydrogen'], ['gemini-pro','Claude Sonnet'], ['gemini-auto','Gemini 4'], ['opaque','Not Gemini'],
    ['secret','Gemini\nexport key'], ['valid.id','Gemini 4\u202e'], ['bad id','Gemini 4'],
    ['sk-proj-'+'x'.repeat(24),'Gemini 4'], ['opaque2','Gemini sk-proj-'+'x'.repeat(24)]]);
  selector.options[0].description = 'must not be returned';
  assert.deepEqual(catalog([selector]), {config_id:'model',current_model:null,models:[]});
});

test('invalid, ambiguous and legacy unsettable selectors are rejected', () => {
  const model = selectOption('model','model','Model','gemini-pro',[['gemini-pro','Gemini Pro']]);
  for (const options of [[], [model, {...model,id:'other'}], [model,{id:'model',category:'thought_level'}],
    [{...model,type:'boolean'}],[{...model,currentValue:'missing'}],
    [{...model,category:undefined}],[{...model,name:undefined}],[{...model,options:[{value:'gemini-pro'}]}], [{...model,options:[...model.options,...model.options]}],
    [{...model,options:[...model.options,{group:'g',name:'g',options:[]}]}]]) assert.throws(() => catalog(options));
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
    [['--response-id','4'],'x'.repeat(MAX_REQUEST+1)]]) rejects(args, frame);
});
