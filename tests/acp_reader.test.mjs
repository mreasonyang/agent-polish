import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAcpFrame, readACP } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_reader.mjs';
import { Fixture, REPLY, SESSION } from './fixture_acp.mjs';

const prompt = {pendingId:6, sessionId:SESSION};
const line = fields => JSON.stringify({jsonrpc:'2.0', ...fields}) + '\n';
const chunk = (text, sessionId = SESSION, sessionUpdate = 'agent_message_chunk') => line({
  method:'session/update', params:{sessionId, update:{sessionUpdate, content:{type:'text', text}}},
});
const stop = (id = 6, stopReason = 'end_turn') => line({id, result:{stopReason}});
const config = (sessionId = SESSION) => line({
  method:'session/update', params:{sessionId, update:{sessionUpdate:'config_option_update', configOptions:[]}},
});

test('one host read may bundle text, configuration, server requests with overlapping IDs, and the stop frame', () => {
  const notice = config();
  const request = line({id:6, method:'session/request_permission', params:{sessionId:SESSION}});
  const unsupported = line({id:'6', method:'fs/read_text_file', params:{sessionId:SESSION}});
  const end = stop();
  const fixture = new Fixture('interleaved');
  const lines = [];
  fixture.write = raw => lines.push(raw);
  fixture.prompt(6, {prompt:[{type:'text', text:'fixture'}]});
  const wire = lines[0] + notice + request + config('other-session') + unsupported + lines.slice(1).join('')
    + chunk('late') + config();
  const {state, events} = readACP(null, wire.replaceAll('\n', '\r\n'), prompt);
  assert.equal(state.reason, null);
  assert.equal(state.promptEnded, true);
  assert.equal(state.text, REPLY.join(''));
  assert.deepEqual(events, [
    {type:'config', sessionId:SESSION, raw:notice.trimEnd() + '\r'},
    {type:'request', id:6, method:'session/request_permission'},
    {type:'request', id:'6', method:'fs/read_text_file'},
    {type:'response', id:6, result:{stopReason:'end_turn'}, raw:end.trimEnd() + '\r'},
  ]);
});

test('partial frames and empty polls survive a serializable checkpoint, including across prompt submission', () => {
  const before = chunk('too early');
  const large = ('雪🐕🏽、e\u0301。\r\n\u2028' + JSON.stringify({q:'a"b\\c'})).repeat(15000);
  const text = ' \t\r\n' + large + ' \n';
  const wire = chunk(text) + chunk('  尾。') + stop();
  const split = wire.indexOf('🐕') + 1;
  const idle = {pendingId:null, sessionId:SESSION};
  let {state} = readACP(null, chunk('unsolicited') + before.slice(0, 43), idle);
  assert.equal(state.text, '');
  const resume = () => JSON.parse(JSON.stringify(state));
  ({state} = readACP(resume(), before.slice(43) + wire.slice(0, split), prompt));
  assert.equal(state.text, '');
  const empty = readACP(resume(), '', prompt);
  assert.deepEqual(empty, {state, events:[]});
  ({state} = readACP(resume(), wire.slice(split, -3), prompt));
  assert.equal(state.text, text + '  尾。');
  assert.equal(state.promptEnded, false);
  const end = readACP(resume(), wire.slice(-3), prompt);
  assert.deepEqual(end.events.map(row => [row.type,row.id]), [['response',6]]);
  assert.equal(end.state.text, state.text);
  const late = readACP(end.state, chunk('too late'), prompt);
  assert.deepEqual(late, {state:end.state, events:[]});
});

test('the new session and its following config update may arrive together before the next host write', () => {
  const opened = line({id:3, result:{sessionId:SESSION, configOptions:[]}});
  const ready = readACP(null, opened + config() + chunk('too soon'), {pendingId:3});
  assert.equal(ready.state.text, '');
  assert.deepEqual(ready.events.map(row => row.type), ['response','config']);
  assert.equal(ready.events[0].raw, opened.trimEnd());
  const idle = readACP(ready.state, config() + line({method:'_progress'}) + chunk('still too soon'), {pendingId:null});
  assert.deepEqual(idle.events.map(row => row.type), ['config']);
  assert.equal(idle.state.text, '');
  const complete = readACP(idle.state, chunk('real') + stop(), prompt);
  assert.equal(complete.state.text, 'real');
  assert.equal(complete.state.reason, null);
});

test('an end response needs its NDJSON delimiter before delivery', () => {
  const {state, events} = readACP(null, chunk('完整文本') + stop().trimEnd(), prompt);
  assert.deepEqual(events, []);
  assert.equal(state.promptEnded, false);
  const end = readACP(state, '\n', prompt);
  assert.equal(end.events[0].id, 6);
  assert.equal(end.state.text, '完整文本');
});

test('invalid envelopes, ambiguous keys, and unmatched responses cannot complete a reply', () => {
  const invalid = [
    stop('6'), stop(16), stop(6,'unknown'), stop().replace('"id":6','"id":5,"\\u0069d":6'),
    stop().replace('"id":6','"id":6.0000000000000001'), stop().replace('"id":6','"id":6e0'),
    line({id:null, result:{}}), line({id:6, result:{stopReason:'end_turn'}, error:{code:0, message:'private'}}),
    line({id:6, method:'session/update', result:{}}), 'not protocol\n', 'null\n', '[]\n',
    line({jsonrpc:'1.0', id:6, result:{stopReason:'end_turn'}}), line({id:6}),
    line({method:'session/update', params:{sessionId:'', update:{}}}),
  ];
  for (const wire of invalid) {
    const {state, events} = readACP(null, chunk('partial') + wire + stop(), prompt);
    assert.equal(state.text, '');
    assert.deepEqual(events, [{type:'error', reason:'acp_protocol_error'}]);
    assert.deepEqual(readACP(state, chunk('later') + stop(), prompt), {state, events:[]});
  }
  assert.deepEqual(readACP(null, stop(), {sessionId:SESSION}).events, [{type:'error', reason:'acp_protocol_error'}]);
  const emptySession = readACP(null, line({id:3, result:{sessionId:' \t'}}), {pendingId:3});
  assert.deepEqual(emptySession.events, [{type:'error', reason:'acp_protocol_error'}]);
});

test('non-text updates, non-end stops, and provider failures never yield a partial candidate', () => {
  const image = line({method:'session/update', params:{sessionId:SESSION, update:{
    sessionUpdate:'agent_message_chunk', content:{type:'image', data:'secret'},
  }}});
  assert.equal(readACP(null, image + chunk(' \r\n') + stop(), prompt).state.reason, 'acp_incomplete');
  assert.equal(readACP(null, image + chunk(' ✓ ') + stop(), prompt).state.text, ' ✓ ');
  for (const reason of ['cancelled','refusal','max_tokens','max_turn_requests']) {
    const {state, events} = readACP(null, chunk('partial') + stop(6, reason), prompt);
    assert.deepEqual([state.text, state.promptEnded, events], ['', true, [{type:'error', reason:'acp_incomplete'}]]);
  }
  for (const [id, code, message, reason] of [
    [6,-32603,'private provider message','acp_provider_error'], [3,-32000,'private account','acp_auth_failed'],
    [2,-32602,'private identity','acp_auth_failed'], [6,-32603,'request timed out','acp_timeout'],
    [4,-32602,'Unknown config option','acp_model_unavailable'],
  ]) {
    const {state, events} = readACP(null, chunk('partial') + line({id, error:{code, message}}), {...prompt, pendingId:id});
    assert.deepEqual(events, [{type:'error', reason}]);
    assert.equal(state.text, '');
    assert.equal(state.promptEnded, id === 6);
  }
});

test('catalog inspection can compare exact large integer response IDs', () => {
  for (const token of ['9007199254740993', '-9223372036854775809']) {
    const wire = '{"id":' + token + '}';
    assert.equal(parseAcpFrame(wire, {bigintIds:true}).id, BigInt(token));
    assert.throws(() => parseAcpFrame(wire));
  }
  assert.equal(parseAcpFrame('{"id":4.0}', {bigintIds:true}).id, null);
  assert.throws(() => parseAcpFrame('{"id":4,"\\u0069d":4}', {bigintIds:true}));
});
