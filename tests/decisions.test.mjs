import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, MAX_DECISION_DATA_BYTES, MAX_RESPONSE_BYTES } from '../plugins/codex-polish/skills/codex-polish/scripts/decisions.mjs';
import { homeEnv, makeProject, temporary, useTestProfile, writeTestPrompt } from './hook_fixture.mjs';
import { saveOpenAIKey, clearOpenAIKey } from '../plugins/codex-polish/hooks/openai_credentials.mjs';
import { writeProfileSetting } from '../plugins/codex-polish/hooks/profile_setting.mjs';

test.beforeEach(t => {
  useTestProfile(t);
  writeProfileSetting('codex-polish.mode', 'auto');
  saveOpenAIKey('test-key');
});

const script = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/decisions.mjs', import.meta.url));
const draft = {
  question: '  `src/导出.mjs:12` 的 [v1.2.3](https://example.test/v1.2.3) 修好了吗？\r\n',
  draft: '  Cafe\u0301 的延迟为 25 ms（原话是“待验证”）。\r\n\r\n```sh\r\ngit diff -- src/导出.mjs\r\n```  \r\n',
};
const reply = (name, probability) => ({answers:[{type:'predicate',name,probability}]});
const failure = reason => ({action:'keep',reason});
const dataStream = data => Readable.from([Buffer.from(JSON.stringify(data))]);

function cli(args, data, request) {
  return decide(args,dataStream(data),{OPENAI_API_KEY:'ambient-test-key'},request);
}

// Mock the native HTTPS entry point, so status, truncation, byte limits and redirects
// exercise the same response handling that a real network request uses.
function mockResponse(t) {
  let next;
  const requests = [];
  const mocked = t.mock.method(https,'request',(url,options,respond) => {
    const req = new EventEmitter();
    req.end = body => {
      requests.push({url,options,body});
      if (next instanceof Error) {
        req.emit('error',next);
        return;
      }
      const stream = Readable.from([next.body]);
      stream.statusCode = next.status;
      stream.headers = next.headers;
      respond(stream);
    };
    return req;
  });
  return {
    set(body, status = 200, headers = {}) {
      next = body instanceof Error ? body : {body:Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),status,headers};
    },
    requests, calls:() => mocked.mock.callCount(),
  };
}

test('judge sends the exact original fields in one HTTPS request', async t => {
  const mock = mockResponse(t);
  const { cwd } = makeProject(t);
  mock.set(reply('needs_rewrite', 0.80));
  assert.deepEqual(await cli(['judge', '--cwd', cwd], draft),
    {action:'rewrite', probability:0.80, reason:'needs_rewrite'});
  assert.equal(mock.calls(), 1);
  const {url, options, body} = mock.requests[0];
  assert.equal(url, 'https://api.openai.com/v1/decisions');
  assert.equal(options.method, 'POST');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  assert.equal(options.headers['Content-Length'], Buffer.byteLength(body));
  const payload = JSON.parse(body);
  assert.equal(payload.model, 'gpt-6-luna');
  assert.deepEqual(payload.input, [{role:'user', content:[{type:'input_json', data:draft}]}]);
  assert.equal(payload.questions.length, 1);
  assert.equal(payload.questions[0].name, 'needs_rewrite');
  assert.equal(payload.questions[0].type, 'predicate');
  assert.match(payload.questions[0].instructions, /Would rewriting `draft` without changing its meaning noticeably improve/);
  assert.doesNotMatch(payload.questions[0].instructions, /\bhistory\b/i);
});

test('a direct judge invocation checks the rewrite policy before using credentials or sending a request', async t => {
  const { cwd } = makeProject(t);
  const mock = mockResponse(t);
  const settings = path.join(process.env.CODEX_HOME, 'codex-polish', 'settings');
  const setting = path.join(settings, 'codex-polish.rewrite-mode');
  for (const [value, reason] of [['turbo', 'decision_route_changed'], ['typo', 'rewrite_mode_invalid']]) {
    fs.writeFileSync(setting, value);
    assert.deepEqual(await cli(['judge', '--cwd', cwd], draft), failure(reason));
  }
  assert.equal(mock.calls(), 0);
  fs.writeFileSync(setting, 'normal');
  mock.set(reply('needs_rewrite', 0.9));
  assert.equal((await cli(['judge', '--cwd', cwd], draft)).action, 'rewrite');
  assert.equal(mock.calls(), 1);
});

test('standalone judge respects the profile trigger mode and OpenAI-specific opt-out', async t => {
  const { cwd } = makeProject(t);
  const mock = mockResponse(t);
  const settings = path.join(process.env.CODEX_HOME, 'codex-polish', 'settings');
  const modeFile = path.join(settings, 'codex-polish.mode');
  fs.unlinkSync(modeFile);
  assert.deepEqual(await cli(['judge', '--cwd', cwd], draft), failure('trigger_mode'));
  for (const mode of ['off', 'manual']) {
    fs.writeFileSync(modeFile, mode);
    assert.deepEqual(await cli(['judge', '--cwd', cwd], draft), failure('trigger_mode'));
  }
  fs.writeFileSync(modeFile, 'auto');
  fs.writeFileSync(path.join(settings, 'codex-polish.decisions'), 'off');
  assert.deepEqual(await cli(['judge', '--cwd', cwd], draft), failure('decision_route_changed'));
  assert.equal(mock.calls(), 0);
});

test('custom profile editing goals reach the judge as evidence', async t => {
  const { cwd } = makeProject(t);
  const prompt = 'Lead with the result.\nUse short sentences.\n';
  const mock = mockResponse(t);
  mock.set(reply('needs_rewrite', 1));
  async function inspect(project = cwd) {
    const out = await cli(['judge', '--cwd', project], draft);
    assert.equal(out.action, 'rewrite');
    return JSON.parse(mock.requests.at(-1).body);
  }
  const defaultJudge = await inspect();
  writeTestPrompt(process.env.CODEX_HOME, prompt);
  const customJudge = await inspect();
  assert.deepEqual(await inspect(temporary(t)), customJudge);
  assert.deepEqual(customJudge.input, [{role:'user', content:[{type:'input_json', data:{...draft, editor_prompt:prompt}}]}]);
  assert.equal(customJudge.questions[0].name, 'needs_rewrite');
  assert.notEqual(customJudge.questions[0].instructions, defaultJudge.questions[0].instructions);
  assert.match(customJudge.questions[0].instructions, /Does `draft` need to change to satisfy `editor_prompt`\?/);
  assert.doesNotMatch(customJudge.questions[0].instructions, /\bhistory\b/i);
  assert.ok(!customJudge.questions[0].instructions.includes(prompt));
});

test('only validated evidence within the Decisions per-field limit reaches HTTPS', async t => {
  const { cwd } = makeProject(t);
  const mock = mockResponse(t);
  writeTestPrompt(process.env.CODEX_HOME, Buffer.from([0xff]));
  assert.deepEqual(await cli(['judge', '--cwd', cwd], draft), failure('editor_prompt_invalid'));
  assert.equal(mock.calls(), 0);
  const editor_prompt = 'Use short sentences.';
  writeTestPrompt(process.env.CODEX_HOME, editor_prompt);
  const input = { question:'q'.repeat(140 * 1024), draft:'' };
  input.draft = 'x'.repeat(MAX_DECISION_DATA_BYTES - Buffer.byteLength(JSON.stringify({...input, editor_prompt})));
  mock.set(reply('needs_rewrite', 0.7));
  assert.equal((await cli(['judge', '--cwd', cwd], input)).action, 'rewrite');
  assert.deepEqual(JSON.parse(mock.requests[0].body).input[0].content[0].data, {...input, editor_prompt});
  input.draft += 'x';
  assert.deepEqual(await cli(['judge', '--cwd', cwd], input), failure('decision_input_too_large'));
  assert.equal(mock.calls(), 1);
});

test('only a majority for rewriting sends a draft for editing', async () => {
  for (const [score, action] of [[0, 'keep'], [0.499, 'keep'], [0.5, 'keep'], [0.5001, 'rewrite'], [0.79, 'rewrite'], [1, 'rewrite']]) {
    const out = await cli(['judge'],draft,async () => reply('needs_rewrite',score));
    assert.equal(out.action,action);
    assert.equal(out.probability,score);
  }
});

test('bad inputs and configuration send nothing', async () => {
  let calls = 0;
  for (const [args,data,reason] of [
    [['judge','--threshold','nan'],draft,'invalid_options'], [['judge','--threshold','-1'],draft,'invalid_options'],
    [['judge','--timeout','inf'],draft,'invalid_options'], [['judge','--timeout','1e299'],draft,'invalid_options'],
    [['judge','--timeout','0'],draft,'invalid_options'], [['judge'],{...draft,transcript:'private'},'invalid_input'],
    [['judge'],{...draft,editor_prompt:'override'},'invalid_input'],
    [['verify'],{...draft,candidate:'edited'},'invalid_options'], [['judge'],{...draft,candidate:'edited'},'invalid_input'],
    [['judge'],{question:'q',draft:'汉'.repeat(90000)},'decision_input_too_large'],
    [['judge'],{question:'q',draft:'x'.repeat(600 * 1024)},'decision_input_too_large']])
    assert.deepEqual(await cli(args,data,()=>{calls++;}),failure(reason));
  assert.equal(calls,0);
});

test('the judge never falls back to an ambient key when the saved key is missing or malformed', async t => {
  const mock = mockResponse(t);
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'codex-polish', 'credentials', 'openai.key'), 'invalid key');
  assert.deepEqual(await cli(['judge'], draft), failure('invalid_api_key'));
  clearOpenAIKey();
  assert.deepEqual(await cli(['judge'], draft), failure('missing_api_key'));
  assert.equal(mock.calls(), 0);
});

test('judge rejects caller-supplied history before HTTPS', async t => {
  const mock = mockResponse(t);
  for (const history of [[], [{user:'Earlier question', assistant:'Earlier answer'}]]) {
    assert.deepEqual(await cli(['judge'], {...draft, history}), failure('invalid_input'));
  }
  assert.equal(mock.calls(), 0);
});

test('HTTP failure discards provider details with no redirect or retry', async t => {
  const mock = mockResponse(t);
  const statuses = [[401,'api_auth_error'],[403,'api_auth_error'],[408,'api_timeout'],[429,'api_rate_limited'],
    [503,'api_server_error'],[307,'api_http_error']];
  for (const [status,reason] of statuses) {
    mock.set(Buffer.from('private draft'),status,{location:'https://other.invalid/private'});
    const before = mock.calls();
    assert.deepEqual(await cli(['judge'],draft),failure(reason));
    assert.equal(mock.calls(),before+1);
  }
  for (const [error,reason] of [
    [Object.assign(new Error('private'),{code:'ETIMEDOUT'}),'api_timeout'],
    [Object.assign(new Error('private'),{code:'ECONNRESET'}),'api_transport_error'],
    [new Error('private'),'api_transport_error'], [new TypeError('private proxy setting'),'api_transport_error']]) {
    mock.set(error);
    const before = mock.calls();
    assert.deepEqual(await cli(['judge'],draft),failure(reason));
    assert.equal(mock.calls(),before+1);
  }
});

test('HTTPS proxy receives CONNECT with no evidence or provider authorization', async t => {
  const proxy = http.createServer();
  let received;
  proxy.once('connect',(req,socket,head) => {
    received = {path:req.url,headers:req.headers,head};
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  proxy.listen(0,'127.0.0.1');
  await once(proxy,'listening');
  t.after(() => proxy.close());
  const env = {HTTPS_PROXY:'http://u:p@127.0.0.1:'+proxy.address().port};
  assert.deepEqual(await decide(['judge'],dataStream(draft),env),failure('api_transport_error'));
  assert.equal(received.path,'api.openai.com:443');
  assert.equal(received.headers.authorization,undefined);
  assert.equal(received.headers['proxy-authorization'],'Basic dTpw');
  assert.equal(received.head.length,0);
  const mock = mockResponse(t);
  mock.set(reply('needs_rewrite',0.9));
  assert.equal((await decide(['judge'],dataStream(draft),{...env,NO_PROXY:'.openai.com'})).action,'rewrite');
});

test('quota classification uses structured codes only', async t => {
  const mock = mockResponse(t);
  for (const [body,reason] of [
    [{error:{code:'insufficient_quota',message:'private draft'}},'api_quota_exhausted'],
    [{error:{type:'insufficient_quota'}},'api_quota_exhausted'],
    [{error:{code:'rate_limit_exceeded',message:'insufficient_quota'}},'api_rate_limited'],
    [{error:'insufficient_quota'},'api_rate_limited']]) {
    mock.set(body,429);
    const before = mock.calls();
    assert.deepEqual(await cli(['judge'],draft),failure(reason));
    assert.equal(mock.calls(),before+1);
  }
});

test('CLI exits at the wall-clock deadline even with a trickling reply', () => {
  const preload = `
    import https from 'node:https';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    https.request = (url, options, respond) => {
      const req = new EventEmitter();
      req.end = () => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        setInterval(() => response.write(' '),20);
        respond(response);
      };
      return req;
    };
  `;
  const result = spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),
    script,'judge','--timeout','0.10'],{input:JSON.stringify(draft),env:{...homeEnv(process.env.CODEX_HOME), CODEX_HOME:process.env.CODEX_HOME},
    encoding:'utf8',timeout:process.platform === 'win32' ? 30_000 : 3000});
  assert.equal(result.status,1);
  assert.deepEqual(JSON.parse(result.stdout),failure('api_timeout'));
  assert.equal(result.stderr,'');
});

test('judge reports a refusal only for the expected predicate', async t => {
  const mock = mockResponse(t);
  for (const [name,reason] of [['needs_rewrite','api_refusal'],['other','invalid_api_response']]) {
    mock.set({answers:[{type:'refusal',name}]});
    assert.deepEqual(await cli(['judge'],draft),failure(reason));
  }
  assert.equal(mock.calls(),2);
});

test('malformed predicate responses fail closed', async t => {
  const mock = mockResponse(t);
  const answer = reply('needs_rewrite',0.99).answers[0];
  for (const body of [Buffer.from('{'),Buffer.from([0xff]),[],{answers:[]},{answers:[answer,answer]},reply('other',0.9),
    reply('needs_rewrite',true),Buffer.from('{"answers":[{"name":"needs_rewrite","type":"predicate","probability":NaN}]}'),
    reply('needs_rewrite',-0.1),Buffer.alloc(MAX_RESPONSE_BYTES+1,120)]) {
    mock.set(body);
    assert.deepEqual(await cli(['judge'],draft),failure('invalid_api_response'));
  }
});

test('partial success and short bodies are never accepted', async t => {
  const mock = mockResponse(t);
  const body = Buffer.from(JSON.stringify(reply('needs_rewrite',0.95)));
  for (const [status,size] of [[206,body.length],[200,body.length+1]]) {
    mock.set(body,status,{'content-length':String(size)});
    assert.deepEqual(await cli(['judge'],draft),failure('invalid_api_response'));
  }
});
