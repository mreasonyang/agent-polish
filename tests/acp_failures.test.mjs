import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, SESSION, PERMISSION_ID, REPLY } from './fixture_acp.mjs';

const request = (id, method, params) => ({jsonrpc:'2.0', id, method, params});
const initialize = request(1, 'initialize', {protocolVersion:1, clientCapabilities:{}});
const auth = request(2, 'authenticate', {methodId:'gemini-api-key'});
const newSession = request(3, 'session/new', {cwd:'/offline', mcpServers:[]});
const model = request(4, 'session/set_config_option', {sessionId:SESSION, configId:'model', value:'gemini-4-hydrogen'});
const prompt = request(6, 'session/prompt', {sessionId:SESSION, prompt:[{type:'text', text:'模拟原稿'}]});

function trace(fixture, ...messages) {
  const lines = [];
  fixture.write = text => lines.push(text);
  for (const message of messages) {
    fixture.handle(message);
    if (fixture.ended) break;
  }
  return lines;
}

function turn(scenario) {
  const fixture = new Fixture(scenario);
  trace(fixture, initialize, newSession, model);
  return [fixture, trace(fixture, prompt)];
}

test('existing credentials can open a session without authenticate', () => {
  const [ready, opened] = trace(new Fixture('ok'), initialize, newSession).map(JSON.parse);
  assert.equal(ready.result.authMethods.some(method => method.id === 'existing-session'), false);
  assert.deepEqual([opened.id, opened.result.sessionId], [3, SESSION]);
});

test('signed out session requires authentication before prompt', () => {
  const fixture = new Fixture('signed-out');
  const [,denied] = trace(fixture, initialize, newSession).map(JSON.parse);
  assert.deepEqual([denied.id, denied.error.code], [3, -32000]);
  assert.equal(fixture.hasSession, false);
  assert.equal(fixture.pending, null);
});

test('both explicit auth methods can open a session', () => {
  for (const methodId of ['gemini-api-key','agent-platform']) {
    const [ready, accepted, opened] = trace(new Fixture('signed-out'), initialize,
      request(2, 'authenticate', {methodId}), newSession).map(JSON.parse);
    assert.ok(ready.result.authMethods.some(method => method.id === methodId));
    assert.deepEqual(accepted.result, {});
    assert.equal(opened.result.sessionId, SESSION);
  }
});

test('denied auth and missing hydrogen surface before the prompt', () => {
  const [,denied] = trace(new Fixture('auth-denied'), initialize, auth).map(JSON.parse);
  assert.deepEqual([denied.id, denied.error.code], [2,-32000]);
  const [,opened,unavailable] = trace(new Fixture('no-hydrogen'), initialize, newSession, model).map(JSON.parse);
  assert.deepEqual(opened.result.configOptions[0].options.map(item => item.value), ['gemini-3.8-flash']);
  assert.ok(unavailable.error);
});

test('flash completes without a thinking selector', () => {
  const fixture = new Fixture('no-hydrogen');
  const [,opened] = trace(fixture, initialize, newSession).map(JSON.parse);
  assert.equal(opened.result.configOptions.length, 1);
  assert.equal(opened.result.configOptions[0].currentValue, 'gemini-3.8-flash');
  assert.equal(JSON.parse(trace(fixture, prompt).at(-1)).result.stopReason, 'end_turn');
});

test('only its own session can cancel a stalled turn', () => {
  const [fixture, lines] = turn('stalled');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).params.update.content.text, REPLY[0]);
  const cancel = sessionId => ({method:'session/cancel', params:{sessionId}});
  assert.deepEqual(trace(fixture, cancel('other-session')), []);
  const [stopped] = trace(fixture, cancel(SESSION)).map(JSON.parse);
  assert.deepEqual([stopped.id,stopped.result.stopReason], [6,'cancelled']);
  assert.deepEqual(trace(fixture, cancel(SESSION)), []);
});

test('permission reply uses the server request ID', () => {
  const [fixture, lines] = turn('permission');
  assert.equal(JSON.parse(lines[0]).id, PERMISSION_ID);
  const [stopped] = trace(fixture, {id:PERMISSION_ID, result:{outcome:{outcome:'cancelled'}}}).map(JSON.parse);
  assert.deepEqual([stopped.id,stopped.result.stopReason], [6,'cancelled']);
});

test('stops and transport errors may follow partial text', () => {
  for (const [scenario, reason] of [['refused','refusal'],['cancelled','cancelled']]) {
    const [chunk, end] = turn(scenario)[1].map(JSON.parse);
    assert.equal(chunk.params.update.content.text, REPLY[0]);
    assert.deepEqual([end.id,end.result.stopReason], [6,reason]);
  }
  assert.ok(JSON.parse(turn('provider-error')[1].at(-1)).error);
  const [,truncated] = turn('truncated');
  assert.equal(JSON.parse(truncated[0]).method, 'session/update');
  assert.throws(() => JSON.parse(truncated.at(-1)), SyntaxError);
});

test('apparent end_turn can have the wrong ID, model or content', () => {
  const end = JSON.parse(turn('wrong-end-id')[1].at(-1));
  assert.deepEqual([end.id,end.result.stopReason], ['another-request','end_turn']);
  const [before,change,after,complete] = turn('model-drift')[1].map(JSON.parse);
  assert.equal(change.params.update.configOptions[0].currentValue, 'gemini-3.8-flash');
  assert.equal(before.params.sessionId, after.params.sessionId);
  assert.equal(complete.result.stopReason, 'end_turn');
  assert.deepEqual(turn('nontext')[1].slice(0,-1).map(line => JSON.parse(line).params.update.content.type), ['text','image','text']);
});

test('interleaved notifications retain the session and content kind', () => {
  const updates = turn('interleaved')[1].slice(0,-1).map(line => JSON.parse(line).params);
  assert.deepEqual(updates.map(item => [item.sessionId,item.update.sessionUpdate]), [
    [SESSION,'agent_message_chunk'], ['other-session','agent_message_chunk'],
    [SESSION,'agent_thought_chunk'], [SESSION,'agent_message_chunk']]);
  assert.equal(updates[0].update.content.text + updates.at(-1).update.content.text, REPLY.join(''));
});
