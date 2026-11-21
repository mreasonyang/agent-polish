import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { json, makeProject, plugin, run, windows, runHookCommand, agyName, useTestProfile } from './hook_fixture.mjs';
import { saveOpenAIKey, clearOpenAIKey } from '../plugins/codex-polish/hooks/openai_credentials.mjs';

function fixture(t, { savedKey = true } = {}) {
  const f = makeProject(t), installed = path.join(f.home, 'installed'), bin = path.join(f.home, 'bin');
  useTestProfile(t, f.env.CODEX_HOME);
  if (savedKey) saveOpenAIKey('plugin-test-key');
  fs.cpSync(plugin, installed, { recursive: true });
  fs.mkdirSync(bin);
  const agy = path.join(bin, agyName); fs.writeFileSync(agy, '#!/bin/sh\n: > "$FAULT_TEST_CALLS.agy"\n', { mode: 0o700 });
  const script = path.join(installed, 'hooks/preferences.mjs'), helper = path.join(installed, 'skills/codex-polish/scripts/decisions.mjs');
  fs.writeFileSync(helper, `import fs from 'node:fs';
import assert from 'node:assert/strict';
export async function decide(args, stream) {
  assert.deepEqual(args, ['judge', '--cwd', process.env.FAULT_TEST_CWD]);
  fs.appendFileSync(process.env.FAULT_TEST_CALLS, 'judge\\n');
  const pieces = [];
  for await (const part of stream) pieces.push(part);
  assert.deepEqual(JSON.parse(Buffer.concat(pieces)), { question: 'q', draft: 'private example' });
  return JSON.parse(process.env.FAULT_TEST_RESPONSE);
}
`);
  const calls = path.join(f.home, 'calls');
  const env = { ...f.env, PATH: bin, OPENAI_API_KEY: 'test-openai', FAULT_TEST_CALLS: calls, FAULT_TEST_CWD: f.cwd,
    FAULT_TEST_RESPONSE: JSON.stringify({ action: 'rewrite', reason: 'needs_rewrite', probability: 0.96 }) };
  function invoke(args, overrides = {}) {
    const input = args[0] === 'decision' ? '{"question":"q","draft":"private example"}' : undefined;
    const result = run(script, [...args, '--cwd', f.cwd], { env: { ...env, ...overrides }, input });
    assert.equal(result.stderr, ''); assert.ok(!result.stdout.includes('private example'));
    return [result.status, result.stdout ? JSON.parse(result.stdout) : null];
  }
  const judge = (trigger = 'auto', args = [], overrides = {}) => invoke(['decision', 'judge', '--trigger', trigger, ...args], overrides);
  const check = overrides => invoke(['check'], overrides)[1];
  const logged = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
  return { ...f, installed, bin, agy, env, calls, script, invoke, judge, check, helper, logged };
}

test('the interactive style check consumes one host record and keeps its contents private in stdout', t => {
  const f = fixture(t);
  const args = ['decision', 'judge', '--trigger', 'auto', '--route', 'decisions', '--host-input', '--cwd', f.cwd];
  const { stdout, stderr, status } = run(path.join(f.installed, 'hooks/preferences.mjs'), args, {
    env: f.env, input: JSON.stringify({ question: 'q', draft: 'private example' }) + '\n',
  });
  assert.equal(status, 0, stderr);
  const [ready, result] = stdout.trimEnd().split('\n');
  assert.equal(ready, 'input_ready');
  assert.deepEqual(JSON.parse(result), { action: 'rewrite', reason: 'needs_rewrite', probability: 0.96, route: 'decisions' });
  assert.deepEqual(f.logged(), ['judge']);
});

test('the workflow maps ordinary requests for a polish and earlier-answer rewrites to the correct trigger and draft', () => {
  const workflow = fs.readFileSync(path.join(plugin, 'skills/codex-polish/WORKFLOW.md'), 'utf8');
  const lines = workflow.split('\n');
  const explicit = lines.find(line => line.includes('返回结果 polish'));
  assert.ok(explicit?.includes('--trigger explicit'));
  assert.match(explicit, /Turbo/);
  assert.match(explicit, /跳过 Decisions/);
  const automatic = lines.find(line => line.includes('--trigger auto'));
  assert.ok(automatic?.includes('UserPromptSubmit'));
  assert.match(automatic, /普通提问/);
  const earlier = lines.find(line => line.includes('上一条我没看懂，换个说法'));
  assert.ok(earlier?.includes('--turns-back'));
  const judgeCommands = lines.filter(line => line.includes('preferences.mjs decision judge'));
  assert.equal(judgeCommands.length, 1);
  assert.match(judgeCommands[0], /--trigger auto --route decisions --rewrite-mode normal/);
  assert.ok(lines.some(line => line.includes('route=acp') && line.includes('不调用 `decision judge`')));
  assert.doesNotMatch(workflow, /--trigger turbo\b/);
});

test('the CLI exposes auto and explicit as the only trigger choices', t => {
  const { call } = makeProject(t);
  for (const args of [['check'], ['decision', 'judge']]) {
    const help = call([...args, '--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--trigger \{auto,explicit\}/);
    const obsolete = call([...args, '--trigger', 'turbo']);
    assert.equal(obsolete.status, 2);
    assert.equal(obsolete.stdout, '');
  }
});

test('missing or invalid prerequisites never invoke a provider', t => {
  const { judge, agy, calls, env } = fixture(t);
  for (const [variable, value, expected] of [['CODEX_POLISH_AGY_AUTH', 'oauth-personal', 'unsupported_google_auth']]) {
    assert.ok(judge('auto', [], { [variable]: value })[1].blockers.includes(expected));
  }
  fs.unlinkSync(agy);
  assert.ok(judge()[1].blockers.includes('agy_missing')); assert.ok(!fs.existsSync(calls) && !fs.existsSync(env.XDG_CACHE_HOME));
});

test('an ambient key alone never enables the judge and the direct route enforces project policy', t => {
  const { judge, check, mode, agy, calls } = fixture(t, { savedKey: false }), keyless = { OPENAI_API_KEY: '' };
  for (const key of [undefined, '', ' \t\n', 'ambient-valid-key']) {
    const env = { OPENAI_API_KEY: key }, status = check(env);
    assert.equal(status.openai_key_configured, false); assert.equal(status.openai_key_malformed, false);
    assert.equal(status.decisions_enabled, false); assert.equal(status.decisions_mode, 'auto'); assert.deepEqual(status.blockers, []);
    assert.deepEqual(judge('auto', [], env), [0, { action: 'rewrite', reason: 'direct_acp', route: 'acp' }]);
  }
  fs.writeFileSync(mode, 'manual'); assert.equal(judge('auto', [], keyless)[1].reason, 'project_mode');
  assert.equal(judge('explicit', [], keyless)[1].action, 'rewrite');
  fs.writeFileSync(mode, 'off'); assert.equal(judge('explicit', [], keyless)[1].reason, 'project_mode');
  fs.writeFileSync(mode, 'auto'); fs.unlinkSync(agy);
  assert.deepEqual(judge('auto', [], keyless)[1].blockers, ['agy_missing']); assert.equal(fs.existsSync(calls), false);
});

test('opt-out and routing changes cannot silently call OpenAI', t => {
  const { invoke, check, judge, calls, logged } = fixture(t);
  assert.equal(invoke(['set-decisions', 'off'])[1].decisions_mode, 'off');
  const status = check({ OPENAI_API_KEY: 'bad key' });
  assert.deepEqual([status.decisions_mode, status.decisions_enabled, status.blockers], ['off', false, []]);
  assert.equal(judge()[1].route, 'acp');
  assert.equal(judge('auto', ['--route', 'decisions'])[1].reason, 'decision_route_changed');
  invoke(['set-decisions', 'auto']);
  assert.equal(judge('auto', ['--route', 'acp'])[1].reason, 'decision_route_changed');
  assert.equal(fs.existsSync(calls), false);
  assert.equal(judge('auto', ['--route', 'decisions'])[1].route, 'decisions'); assert.deepEqual(logged(), ['judge']);
});

test('turbo always bypasses Decisions and returning to normal uses the saved policy immediately', t => {
  const { invoke, judge, check, calls, logged, mode, agy } = fixture(t);
  invoke(['set-rewrite-mode', 'turbo']);
  for (const key of [undefined, 'valid-test-key', 'bad key']) {
    const env = { OPENAI_API_KEY: key };
    const status = check(env);
    assert.deepEqual([status.rewrite_mode, status.decisions_mode, status.decisions_enabled], ['turbo', 'auto', false]);
    assert.deepEqual(status.blockers, []);
    assert.deepEqual(judge('auto', ['--rewrite-mode', 'turbo'], env), [0, { action: 'rewrite', reason: 'direct_acp', route: 'acp' }]);
  }
  assert.equal(judge('auto', ['--route', 'decisions'])[1].reason, 'decision_route_changed');
  fs.writeFileSync(mode, 'manual');
  assert.equal(judge()[1].reason, 'project_mode');
  assert.equal(judge('explicit')[1].route, 'acp');
  fs.writeFileSync(mode, 'off');
  assert.equal(judge('explicit')[1].reason, 'project_mode');
  fs.writeFileSync(mode, 'auto');
  assert.equal(fs.existsSync(calls), false);
  invoke(['set-rewrite-mode', 'normal']);
  assert.equal(judge()[1].route, 'decisions');
  assert.deepEqual(logged(), ['judge']);
  fs.unlinkSync(agy);
  assert.deepEqual(judge()[1].blockers, ['agy_missing']);
});

test('decision detects strategy changes even when both modes use direct ACP', t => {
  const { invoke, judge, calls } = fixture(t);
  invoke(['set-decisions', 'off']);
  for (const [before, after] of [['normal', 'turbo'], ['turbo', 'normal']]) {
    const pinned = ['--rewrite-mode', before];
    assert.equal(judge('auto', pinned)[1].route, 'acp');
    invoke(['set-rewrite-mode', after]);
    assert.equal(judge('auto', pinned)[1].reason, 'rewrite_mode_changed');
    assert.equal(judge('auto', ['--rewrite-mode', after])[1].route, 'acp');
  }
  assert.equal(fs.existsSync(calls), false);
});

test('with a saved plugin key only ordinary Normal turns ask Decisions, even if it would keep the draft', t => {
  const { invoke, judge, logged, mode, helper } = fixture(t);
  fs.copyFileSync(path.join(plugin, 'skills/codex-polish/scripts/decisions.mjs'), helper);
  const mockHTTPS = `
    import fs from 'node:fs';
    import https from 'node:https';
    import { EventEmitter } from 'node:events';
    import { Readable } from 'node:stream';
    https.request = (url, options, respond) => {
      if (options.headers.Authorization !== 'Bearer plugin-test-key') throw Error('unexpected credential');
      fs.appendFileSync(process.env.FAULT_TEST_CALLS, options.method + ' ' + url + '\\n');
      const req = new EventEmitter();
      req.end = () => {
        const answer = { type: 'predicate', name: 'needs_rewrite', probability: 0.1 };
        const response = Readable.from([Buffer.from(JSON.stringify({ answers: [answer] }))]);
        response.statusCode = 200;
        response.headers = {};
        respond(response);
      };
      return req;
    };
  `;
  const setting = invoke(['set-rewrite-mode', 'normal'])[1].file;
  const env = { NODE_OPTIONS: '--import=data:text/javascript,' + encodeURIComponent(mockHTTPS) };
  const endpoint = 'POST https://api.openai.com/v1/decisions';
  function ordinaryTurn() {
    const status = invoke(['check', '--trigger', 'auto'], env)[1];
    assert.deepEqual([status.rewrite_mode, status.decisions_enabled], ['normal', true]);
    const args = ['--route', 'decisions', '--rewrite-mode', 'normal', '--model', status.gemini_model];
    assert.deepEqual(judge('auto', args, env), [0, { action: 'keep', reason: 'already_clear', probability: 0.1, route: 'decisions' }]);
  }

  ordinaryTurn();
  for (const projectMode of ['auto', 'manual']) {
    fs.writeFileSync(mode, projectMode);
    const status = invoke(['check', '--trigger', 'explicit'], env)[1];
    assert.deepEqual([status.rewrite_mode, status.decisions_enabled, status.mode], ['turbo', false, projectMode]);
    const args = ['--route', 'acp', '--rewrite-mode', 'turbo', '--model', status.gemini_model];
    assert.deepEqual(judge('explicit', args, env), [0, { action: 'rewrite', reason: 'direct_acp', route: 'acp' }]);
    assert.equal(judge('explicit', ['--route', 'decisions'], env)[1].reason, 'decision_route_changed');
    assert.equal(judge('explicit', ['--rewrite-mode', 'normal'], env)[1].reason, 'rewrite_mode_changed');
    assert.deepEqual(logged(), [endpoint]);
    assert.equal(fs.readFileSync(setting, 'utf8'), 'normal\n');
  }
  assert.equal(judge('auto')[1].reason, 'project_mode');
  fs.writeFileSync(mode, 'auto');
  ordinaryTurn();
  assert.deepEqual(logged(), [endpoint, endpoint]);
});

test('explicit requests honor the project switch and runtime checks independently of the automatic rewrite mode', t => {
  const { invoke, judge, calls, mode, agy } = fixture(t);
  const setting = invoke(['set-rewrite-mode', 'normal'])[1].file;
  assert.equal(judge('explicit', ['--model', 'unselected-model'])[1].reason, 'gemini_model_changed');
  assert.equal(judge('explicit', ['--thinking-level', 'high'])[1].reason, 'thinking_level_changed');
  assert.equal(judge('explicit', ['--thinking-level', 'medium'])[1].action, 'rewrite');
  assert.equal(fs.readFileSync(setting, 'utf8'), 'normal\n');
  for (const [value, reason] of [['off', 'project_mode'], ['broken', 'mode_invalid']]) {
    fs.writeFileSync(mode, value);
    assert.equal(judge('explicit')[1].reason, reason);
  }
  fs.unlinkSync(mode);
  fs.writeFileSync(setting, 'broken');
  assert.equal(judge('auto')[1].reason, 'rewrite_mode_invalid');
  assert.equal(judge('explicit')[1].route, 'acp');
  fs.unlinkSync(agy);
  assert.equal(judge('explicit')[1].reason, 'agy_missing');
  assert.equal(fs.existsSync(calls), false);
});

test('default delegates Google authentication to agy', t => {
  const { check, judge, calls } = fixture(t);
  for (const env of [{}, { CODEX_POLISH_AGY_AUTH: 'existing-session' }, { GEMINI_API_KEY: 'test-gemini' }, { GEMINI_API_KEY: 'invalid unused key' }]) {
    const status = check(env); assert.equal(status.google_auth_method, 'existing-session'); assert.equal(status.gemini_key_configured, null);
    assert.deepEqual(status.blockers, []); assert.equal(judge('auto', [], env)[1].action, 'rewrite');
  }
  assert.equal(fs.existsSync(calls + '.agy'), false);
});

test('explicit key mode validates only the configured Gemini key', t => {
  const { judge, calls } = fixture(t);
  const withKey = key => judge('auto', [], { CODEX_POLISH_AGY_AUTH: 'gemini-api-key', GEMINI_API_KEY: key })[1];
  for (const [key, reason] of [[undefined, 'gemini_key_missing'], [' \t', 'gemini_key_missing'], ['x y', 'gemini_key_invalid']]) assert.deepEqual(withKey(key).blockers, [reason]);
  assert.equal(fs.existsSync(calls), false); assert.equal(withKey('test-gemini').action, 'rewrite');
  assert.equal(fs.existsSync(calls + '.agy'), false);
});

test('enterprise runtime and policy changes', t => {
  const { judge, mode, logged, calls } = fixture(t);
  assert.equal(judge('auto', [], { CODEX_POLISH_AGY_AUTH: 'agent-platform', GEMINI_API_KEY: '' })[1].action, 'rewrite');
  fs.writeFileSync(mode, 'manual'); assert.equal(judge()[1].reason, 'project_mode');
  fs.writeFileSync(mode, 'off'); assert.equal(judge('explicit')[1].reason, 'project_mode');
  assert.deepEqual(logged(), ['judge']); assert.equal(fs.existsSync(calls + '.agy'), false);
});

test('each optional provider failure permits a rewrite without retrying the decision', t => {
  const { judge, logged } = fixture(t);
  const reasons = ['api_rate_limited', 'api_timeout', 'api_auth_error', 'api_quota_exhausted', 'api_refusal',
    'api_server_error', 'invalid_api_response', 'api_transport_error', 'api_http_error', 'decision_input_too_large', 'invalid_api_key'];
  for (const reason of reasons) {
    const failure = { FAULT_TEST_RESPONSE: JSON.stringify({ action: 'keep', reason }) };
    assert.deepEqual(judge('auto', [], failure), [0, { action: 'rewrite', reason: 'decision_unavailable', decision_error: reason, route: 'decisions' }]);
  }
  assert.equal(judge()[1].reason, 'needs_rewrite');
  assert.equal(logged().length, reasons.length + 1);
});

test('a malformed saved credential and provider-sized input use ACP without making an HTTPS request', t => {
  const { cwd, env, helper, script, check, judge } = fixture(t);
  fs.copyFileSync(path.join(plugin, 'skills/codex-polish/scripts/decisions.mjs'), helper);
  fs.writeFileSync(path.join(env.CODEX_HOME, 'codex-polish', 'credentials', 'openai.key'), 'malformed key');
  const status = check();
  assert.deepEqual([status.openai_key_malformed, status.decisions_enabled], [true, false]);
  assert.deepEqual(judge(), [0, { action:'rewrite', reason:'direct_acp', route:'acp' }]);
  assert.equal(judge('auto', ['--route', 'decisions'])[1].reason, 'decision_route_changed');
  saveOpenAIKey('valid-test-key');
  const input = JSON.stringify({ question: 'q', draft: 'x'.repeat(600 * 1024) });
  const output = json(run(script, ['decision', 'judge', '--cwd', cwd, '--route', 'decisions', '--trigger', 'auto'], {
    env: { ...env, HTTPS_PROXY: 'http://127.0.0.1:1' }, input,
  }));
  assert.deepEqual(output, { action:'rewrite', reason:'decision_unavailable', decision_error:'decision_input_too_large', route:'decisions' });
});

test('a project change or credential removal while stdin is being read prevents the OpenAI request', t => {
  const { cwd, mode, env, helper, script } = fixture(t);
  fs.copyFileSync(path.join(plugin, 'skills/codex-polish/scripts/decisions.mjs'), helper);
  const preload = `
    import fs from 'node:fs';
    import https from 'node:https';
    const original = process.stdin[Symbol.asyncIterator].bind(process.stdin);
    process.stdin[Symbol.asyncIterator] = async function* () {
      yield* original();
      if (process.env.TEST_REMOVE_KEY) fs.unlinkSync(process.env.TEST_SETTING_PATH);
      else fs.writeFileSync(process.env.TEST_SETTING_PATH, process.env.TEST_SETTING_VALUE);
    };
    https.request = () => { fs.writeFileSync(process.env.FAULT_TEST_CALLS, 'unexpected network'); throw new Error(); };
  `;
  const model = path.join(path.dirname(mode), 'codex-polish.model');
  const credential = path.join(env.CODEX_HOME, 'codex-polish', 'credentials', 'openai.key');
  for (const [file, value, reason] of [[mode, 'off', 'project_mode'], [model, 'gemini-other', 'gemini_model_changed'],
    [credential, null, 'decision_route_changed']]) {
    const result = run('--import', ['data:text/javascript,' + encodeURIComponent(preload), script, 'decision', 'judge',
      '--trigger', 'auto', '--route', 'decisions', '--rewrite-mode', 'normal', '--model', 'gemini-4-hydrogen', '--cwd', cwd],
    { env: { ...env, TEST_SETTING_PATH:file, ...(value === null ? {TEST_REMOVE_KEY:'1'} : {TEST_SETTING_VALUE:value}) },
      input: '{"question":"q","draft":"draft"}' });
    const decision = json(result);
    assert.equal(decision.action, 'keep');
    assert.equal(decision.reason, reason);
    assert.equal(fs.existsSync(env.FAULT_TEST_CALLS), false);
    if (value !== null) fs.unlinkSync(file);
  }
});

test('input and local-policy failures keep the draft without disabling later turns', t => {
  const { judge } = fixture(t);
  for (const reason of ['invalid_input', 'editor_prompt_invalid', 'decision_route_changed', 'rewrite_mode_invalid']) {
    const expected = { action: 'keep', reason };
    assert.deepEqual(judge('auto', [], { FAULT_TEST_RESPONSE: JSON.stringify(expected) }), [1, expected]);
  }
  assert.equal(judge()[1].action, 'rewrite');
});

test('unrecognized helper output cannot be delivered or recorded', t => {
  const { judge } = fixture(t);
  for (const response of ['{"action":"rewrite","reason":"needs_rewrite"}',
    '{"action":"rewrite","probability":true,"reason":"needs_rewrite"}', '{"action":"keep","reason":"private example"}']) {
    assert.deepEqual(judge('auto', [], { FAULT_TEST_RESPONSE: response }), [1, { action: 'keep', reason: 'decision_helper_unavailable' }]);
  }
});

test('an OpenAI outage leaves subsequent auto hooks available; missing Node reports a hook error', t => {
  const { installed, env, cwd, bin, judge, invoke } = fixture(t);
  const command = JSON.parse(fs.readFileSync(path.join(installed, 'hooks/hooks.json'))).hooks.UserPromptSubmit[0].hooks[0];
  const settings = { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PLUGIN_ROOT: installed };
  const runHook = () => runHookCommand(command, { env: settings, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd }) });
  const hook = () => {
    const p = runHook();
    assert.equal(p.status, 0); assert.equal(p.stderr, ''); return p.stdout;
  };
  const missing = runHook();
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /node/);
  if (windows) fs.copyFileSync(process.execPath, path.join(bin, 'node.exe'));
  else fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const workflow = JSON.stringify(path.join(installed, 'skills/codex-polish/WORKFLOW.md'));
  const ready = () => assert.ok(JSON.parse(hook()).hookSpecificOutput.additionalContext.includes(workflow));
  ready();
  judge('auto', [], { FAULT_TEST_RESPONSE: '{"action":"keep","reason":"api_server_error"}' });
  ready();
  clearOpenAIKey();
  ready();
  invoke(['set-rewrite-mode', 'turbo']);
  ready();
});
