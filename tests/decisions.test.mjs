import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, MAX_INPUT_BYTES, MAX_RESPONSE_BYTES } from '../plugins/codex-polish/skills/codex-polish/scripts/decisions.mjs';

const script = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/decisions.mjs', import.meta.url));
const draft = {question:'改好了没？', draft:'修复已完成，回归验证仍待进行。'};
const verify = {...draft, candidate:'修好了，还没跑回归测试。'};
const reply = (name, probability) => ({answers:[{type:'predicate',name,probability}]});
const failure = reason => ({action:'keep',reason});
const dataStream = data => Readable.from([Buffer.from(JSON.stringify(data))]);

function cli(args, data, key = 'test-key', request) {
  return decide(args,dataStream(data),{OPENAI_API_KEY:key},request);
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

test('judge sends one predicate with structured data over HTTPS', async t => {
  const mock = mockResponse(t);
  mock.set(reply('needs_rewrite',0.80));
  assert.deepEqual(await cli(['judge'],draft),{action:'rewrite',probability:0.80,reason:'needs_rewrite'});
  assert.equal(mock.calls(),1);
  const [{url,options,body}] = mock.requests;
  assert.equal(url,'https://api.openai.com/v1/decisions');
  assert.equal(options.method,'POST');
  assert.equal(options.rejectUnauthorized,true);
  assert.equal(options.headers.Authorization,'Bearer test-key');
  const payload = JSON.parse(body);
  assert.equal(payload.model,'gpt-6-luna');
  assert.deepEqual(payload.input,[{role:'user',content:[{type:'input_json',data:draft}]}]);
  assert.equal(payload.questions.length,1);
  assert.equal(payload.questions[0].name,'needs_rewrite');
  assert.equal(payload.questions[0].type,'predicate');
});

test('thresholds and reported score preserve inclusive decimal cutoffs', async () => {
  for (const [args,providerScore,score,action,name] of [
    [['judge'],0.79,0.79,'keep','needs_rewrite'], [['judge','--threshold','0.7'],0.79,0.79,'rewrite','needs_rewrite'],
    [['verify'],0.95,0.05,'accept','meaning_preserved'], [['verify'],0.949,0.051,'keep','meaning_preserved'],
    [['verify','--threshold','0.2'],0.8,0.2,'accept','meaning_preserved'], [['verify'],0,1,'keep','meaning_preserved'],
    [['verify'],0.9499999999999998,0.0500000000000002,'keep','meaning_preserved']]) {
    const out = await cli(args,args[0] === 'judge' ? draft : verify,'test-key',async (url,options,body) => {
      assert.equal(JSON.parse(body).questions[0].name,name);
      return reply(name,providerScore);
    });
    assert.equal(out.action,action);
    assert.equal(out.probability,score);
  }
});

test('bad inputs and configuration send nothing', async () => {
  let calls = 0;
  for (const [args,data,key,reason] of [
    [['judge','--threshold','nan'],draft,'key','invalid_options'], [['verify','--threshold','-1'],verify,'key','invalid_options'],
    [['judge','--timeout','inf'],draft,'key','invalid_options'], [['judge','--timeout','1e299'],draft,'key','invalid_options'],
    [['judge','--timeout','0'],draft,'key','invalid_options'], [['judge'],{...draft,transcript:'private'},'key','invalid_input'],
    [['verify'],draft,'key','invalid_input'], [['verify'],{...verify,candidate:' '},'key','invalid_input'],
    [['judge'],draft,'','missing_api_key'], [['judge'],draft,'x\r\ny','invalid_api_key'],
    [['judge'],{question:'q',draft:'汉'.repeat(90000)},'key','input_too_large'],
    [['judge'],{question:'q',draft:'x'.repeat(MAX_INPUT_BYTES)},'key','input_too_large']])
    assert.deepEqual(await cli(args,data,key,()=>{calls++;}),failure(reason));
  assert.equal(calls,0);
});

test('live fidelity preserves status and rejects reversals', {skip: process.env.CODEX_POLISH_TEST_LIVE_DECISIONS !== '1'}, async () => {
  assert.ok(process.env.OPENAI_API_KEY,'Set OPENAI_API_KEY to run the live Decisions check.');
  for (const [question,draft,faithful,changed] of [
    ['导出按钮修好了吗？','导出按钮已修复。本地测试已经通过，线上尚未验证。',
      '导出按钮修好了，本地测过，线上还没验证。','导出按钮修好了，本地和线上都验证通过了。'],
    ['Can we deploy?','Only staging has been tested. Production still needs a check.',
      'We’ve tested staging. We still need to check production.','Both staging and production passed testing.']]) {
    for (const [candidate,action] of [[faithful,'accept'],[changed,'keep']]) {
      const out = await decide(['verify'],dataStream({question,draft,candidate}));
      assert.equal(out.action,action,JSON.stringify(out));
      assert.ok('probability' in out,JSON.stringify(out));
    }
  }
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
    assert.deepEqual(await cli(['verify'],verify),failure(reason));
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
  const env = {OPENAI_API_KEY:'private-key', HTTPS_PROXY:'http://u:p@127.0.0.1:'+proxy.address().port};
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
    assert.deepEqual(await cli(['verify'],verify),failure(reason));
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
    script,'verify','--timeout','0.10'],{input:JSON.stringify(verify),env:{OPENAI_API_KEY:'test-key'},
    encoding:'utf8',timeout:3000});
  assert.equal(result.status,1);
  assert.deepEqual(JSON.parse(result.stdout),failure('api_timeout'));
  assert.equal(result.stderr,'');
});

test('refusal is distinct from transport and semantic rejection', async t => {
  const mock = mockResponse(t);
  for (const [name,reason] of [['meaning_preserved','api_refusal'],['other','invalid_api_response']]) {
    mock.set({answers:[{type:'refusal',name}]});
    assert.deepEqual(await cli(['verify'],verify),failure(reason));
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
