import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeProject, plugin, run } from './hook_fixture.mjs';

function fixture(t) {
  const f = makeProject(t), installed = path.join(f.home, 'installed'), bin = path.join(f.home, 'bin');
  fs.mkdirSync(installed); fs.cpSync(path.join(plugin, 'hooks'), path.join(installed, 'hooks'), { recursive: true });
  fs.mkdirSync(bin);
  const agy = path.join(bin, 'agy'); fs.writeFileSync(agy, '#!/bin/sh\n: > "$FAULT_TEST_CALLS.agy"\n', { mode: 0o700 });
  const script = path.join(installed, 'hooks/preferences.mjs'), helper = path.join(installed, 'skills/codex-polish/scripts/decisions.mjs');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, `import fs from 'node:fs';
fs.appendFileSync(process.env.FAULT_TEST_CALLS, process.argv[2] + '\\n');
JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(process.env.FAULT_TEST_RESPONSE);
process.exitCode = Number(process.env.FAULT_TEST_EXIT || 0);\n`);
  const calls = path.join(f.home, 'calls');
  const env = { ...f.env, PATH: bin, OPENAI_API_KEY: 'test-openai', FAULT_TEST_CALLS: calls,
    FAULT_TEST_RESPONSE: '{"action":"rewrite","reason":"needs_rewrite","probability":0.96}' };
  function invoke(args, overrides = {}) {
    const result = run(script, [...args, '--cwd', f.cwd], { env: { ...env, ...overrides }, input: '{"question":"q","draft":"private example"}' });
    assert.equal(result.stderr, ''); assert.ok(!result.stdout.includes('private example'));
    return [result.status, result.stdout ? JSON.parse(result.stdout) : null];
  }
  const decide = (stage = 'judge', trigger = 'auto', args = [], overrides = {}) => invoke(['decision', stage, '--trigger', trigger, ...args], overrides);
  const check = overrides => invoke(['check'], overrides)[1];
  const note = reason => assert.equal(invoke(['note-failure', reason])[0], 0);
  const logged = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
  return { ...f, installed, bin, agy, env, calls, invoke, decide, check, note, logged };
}

test('missing or invalid prerequisites never invoke a provider', t => {
  const { decide, agy, calls, env } = fixture(t);
  for (const [variable, value, expected] of [['OPENAI_API_KEY', 'x\ny', 'openai_key_invalid'], ['CODEX_POLISH_AGY_AUTH', 'oauth-personal', 'unsupported_google_auth']]) {
    assert.ok(decide('judge', 'auto', [], { [variable]: value })[1].blockers.includes(expected));
  }
  fs.unlinkSync(agy);
  assert.ok(decide()[1].blockers.includes('agy_missing')); assert.ok(!fs.existsSync(calls) && !fs.existsSync(env.XDG_CACHE_HOME));
});

test('direct route skips both decision calls and enforces project policy', t => {
  const { decide, check, mode, agy, calls } = fixture(t), keyless = { OPENAI_API_KEY: '' };
  for (const key of [undefined, '', ' \t\n']) {
    const env = { OPENAI_API_KEY: key }, status = check(env);
    assert.equal(status.decisions_enabled, false); assert.equal(status.decisions_mode, 'auto'); assert.deepEqual(status.blockers, []);
    assert.deepEqual(decide('judge', 'auto', [], env), [0, { action: 'rewrite', reason: 'direct_acp', route: 'acp' }]);
    assert.deepEqual(decide('verify', 'auto', ['--route', 'acp'], env), [0, { action: 'accept', reason: 'decisions_skipped', route: 'acp' }]);
  }
  fs.writeFileSync(mode, 'manual'); assert.equal(decide('judge', 'auto', [], keyless)[1].reason, 'project_mode');
  assert.equal(decide('judge', 'explicit', [], keyless)[1].action, 'rewrite');
  fs.writeFileSync(mode, 'off'); assert.equal(decide('verify', 'explicit', [], keyless)[1].reason, 'project_mode');
  fs.writeFileSync(mode, 'auto'); fs.unlinkSync(agy);
  assert.deepEqual(decide('judge', 'auto', [], keyless)[1].blockers, ['agy_missing']); assert.equal(fs.existsSync(calls), false);
});

test('opt-out and routing changes cannot silently call OpenAI', t => {
  const { invoke, check, decide, calls, logged } = fixture(t);
  assert.equal(invoke(['set-decisions', 'off'])[1].decisions_mode, 'off');
  const status = check({ OPENAI_API_KEY: 'bad key' });
  assert.deepEqual([status.decisions_mode, status.decisions_enabled, status.blockers], ['off', false, []]);
  assert.equal(decide()[1].route, 'acp');
  for (const stage of ['judge', 'verify']) assert.equal(decide(stage, 'explicit', ['--route', 'decisions'])[1].reason, 'decision_route_changed');
  invoke(['set-decisions', 'auto']);
  for (const stage of ['judge', 'verify']) assert.equal(decide(stage, 'explicit', ['--route', 'acp'])[1].reason, 'decision_route_changed');
  assert.equal(fs.existsSync(calls), false);
  assert.equal(decide('judge', 'explicit', ['--route', 'decisions'])[1].route, 'decisions'); assert.deepEqual(logged(), ['judge']);
});

test('direct route ignores only OpenAI cooldowns and recovers ACP', t => {
  const { note, check, decide, calls } = fixture(t), env = { OPENAI_API_KEY: '' };
  for (const reason of ['api_quota_exhausted', 'invalid_api_response']) {
    note(reason); const recent = check().cooldown;
    assert.equal(recent.reason, reason); assert.equal(check(env).cooldown, null);
    assert.equal(decide('judge', 'auto', [], env)[1].action, 'rewrite');
    decide('verify', 'explicit', ['--recovery-token', recent.token], env);
    assert.equal(check().cooldown.token, recent.token);
  }
  note('acp_auth_failed'); assert.equal(decide('judge', 'auto', [], env)[1].reason, 'cooldown');
  const first = decide('judge', 'explicit', [], env)[1].recovery_token;
  note('acp_timeout'); decide('verify', 'explicit', ['--route', 'acp', '--recovery-token', first], env);
  const second = decide('judge', 'explicit', [], env)[1].recovery_token;
  assert.notEqual(first, second); decide('verify', 'explicit', ['--route', 'acp', '--recovery-token', second], env);
  assert.equal(check(env).cooldown, null); assert.equal(fs.existsSync(calls), false);
});

test('default delegates Google authentication to agy', t => {
  const { check, decide, calls } = fixture(t);
  for (const env of [{}, { CODEX_POLISH_AGY_AUTH: 'existing-session' }, { GEMINI_API_KEY: 'test-gemini' }, { GEMINI_API_KEY: 'invalid unused key' }]) {
    const status = check(env); assert.equal(status.google_auth_method, 'existing-session'); assert.equal(status.gemini_key_configured, null);
    assert.deepEqual(status.blockers, []); assert.equal(decide('judge', 'auto', [], env)[1].action, 'rewrite');
  }
  assert.equal(fs.existsSync(calls + '.agy'), false);
});

test('explicit key mode validates only the configured Gemini key', t => {
  const { decide, calls } = fixture(t);
  const withKey = key => decide('judge', 'auto', [], { CODEX_POLISH_AGY_AUTH: 'gemini-api-key', GEMINI_API_KEY: key })[1];
  for (const [key, reason] of [[undefined, 'gemini_key_missing'], [' \t', 'gemini_key_missing'], ['x y', 'gemini_key_invalid']]) assert.deepEqual(withKey(key).blockers, [reason]);
  assert.equal(fs.existsSync(calls), false); assert.equal(withKey('test-gemini').action, 'rewrite');
  assert.equal(fs.existsSync(calls + '.agy'), false);
});

test('enterprise runtime and policy changes', t => {
  const { decide, mode, logged, calls } = fixture(t);
  assert.equal(decide('judge', 'auto', [], { CODEX_POLISH_AGY_AUTH: 'agent-platform', GEMINI_API_KEY: '' })[1].action, 'rewrite');
  fs.writeFileSync(mode, 'manual'); assert.equal(decide('verify')[1].reason, 'project_mode');
  fs.writeFileSync(mode, 'off'); assert.equal(decide('verify', 'explicit')[1].reason, 'project_mode');
  assert.deepEqual(logged(), ['judge']); assert.equal(fs.existsSync(calls + '.agy'), false);
});

test('failed judge suppresses auto and explicit recovery is scoped', t => {
  const { decide, note, check, logged } = fixture(t);
  const error = { FAULT_TEST_EXIT: '1', FAULT_TEST_RESPONSE: '{"action":"keep","reason":"api_rate_limited"}' };
  assert.deepEqual(decide('judge', 'auto', [], error), [1, { action: 'keep', reason: 'api_rate_limited' }]);
  assert.equal(decide()[1].reason, 'cooldown');
  const first = decide('judge', 'explicit')[1].recovery_token;
  note('acp_auth_failed');
  const accept = { FAULT_TEST_RESPONSE: '{"action":"accept","probability":0.01,"reason":"meaning_preserved"}' };
  assert.equal(decide('verify', 'explicit', ['--recovery-token', first], accept)[1].action, 'accept');
  assert.equal(check().cooldown.reason, 'acp_auth_failed');
  const token = decide('judge', 'explicit')[1].recovery_token;
  decide('verify', 'explicit', ['--recovery-token', token], accept);
  assert.equal(check().cooldown, null); assert.deepEqual(logged(), ['judge', 'judge', 'verify', 'judge', 'verify']);
});

test('broken helper and content refusal retain original without backoff', t => {
  const { decide, note, check } = fixture(t);
  const env = { FAULT_TEST_RESPONSE: '{', FAULT_TEST_EXIT: '1' };
  assert.deepEqual(decide('judge', 'auto', [], env), [1, { action: 'keep', reason: 'decision_helper_unavailable' }]);
  env.FAULT_TEST_RESPONSE = '{"action":"keep","reason":"api_refusal"}';
  assert.deepEqual(decide('verify', 'auto', [], env), [1, { action: 'keep', reason: 'api_refusal' }]);
  note('acp_tool_requested'); assert.equal(check().cooldown, null);
});

test('unrecognized helper output cannot be delivered or recorded', t => {
  const { decide, check } = fixture(t);
  for (const [exit, response] of [['0', '{"action":"accept","reason":"meaning_preserved"}'],
    ['0', '{"action":"accept","probability":true,"reason":"meaning_preserved"}'], ['1', '{"action":"keep","reason":"private example"}']]) {
    assert.deepEqual(decide('verify', 'auto', [], { FAULT_TEST_EXIT: exit, FAULT_TEST_RESPONSE: response }), [1, { action: 'keep', reason: 'decision_helper_unavailable' }]);
    assert.equal(check().cooldown, null);
  }
});

test('auto hook shows a pause notice during backoff and stays silent without Node', t => {
  const { installed, env, cwd, bin, note } = fixture(t);
  const command = JSON.parse(fs.readFileSync(path.join(installed, 'hooks/hooks.json'))).hooks.UserPromptSubmit[0].hooks[0].command;
  const settings = { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PLUGIN_ROOT: installed };
  const hook = () => {
    const p = spawnSync('/bin/sh', ['-c', command], { env: settings, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd }) });
    assert.equal(p.status, 0); assert.equal(p.stderr, ''); return p.stdout;
  };
  assert.equal(hook(), ''); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const failure of ['invalid_api_response', 'acp_timeout']) {
    if (failure === 'acp_timeout') settings.OPENAI_API_KEY = '';
    assert.match(hook(), /codex-polish:codex-polish/);
    note(failure);
    const notice = JSON.parse(hook()).hookSpecificOutput.additionalContext;
    assert.match(notice, /temporarily paused/);
    assert.doesNotMatch(notice, /codex-polish:codex-polish/);
  }
});
