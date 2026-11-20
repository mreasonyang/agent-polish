import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { json, makeProject, plugin, run } from './hook_fixture.mjs';

function fixture(t) {
  const f = makeProject(t), installed = path.join(f.home, 'installed'), bin = path.join(f.home, 'bin');
  fs.cpSync(plugin, installed, { recursive: true });
  fs.mkdirSync(bin);
  const agy = path.join(bin, 'agy'); fs.writeFileSync(agy, '#!/bin/sh\n: > "$FAULT_TEST_CALLS.agy"\n', { mode: 0o700 });
  const script = path.join(installed, 'hooks/preferences.mjs'), helper = path.join(installed, 'skills/codex-polish/scripts/decisions.mjs');
  fs.writeFileSync(helper, `import fs from 'node:fs';
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(3), ['--cwd', process.env.FAULT_TEST_CWD]);
fs.appendFileSync(process.env.FAULT_TEST_CALLS, process.argv[2] + '\\n');
assert.deepEqual(JSON.parse(fs.readFileSync(0, 'utf8')), { question: 'q', draft: 'private example' });
console.log(process.env.FAULT_TEST_RESPONSE);
process.exitCode = Number(process.env.FAULT_TEST_EXIT || 0);\n`);
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
  const finish = (route, trigger = 'auto', args = [], overrides = {}) => invoke(['finish', '--trigger', trigger, '--route', route, ...args], overrides);
  const check = overrides => invoke(['check'], overrides)[1];
  const note = reason => assert.equal(invoke(['note-failure', reason])[0], 0);
  const logged = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
  return { ...f, installed, bin, agy, env, calls, script, invoke, judge, finish, check, note, logged };
}

test('missing or invalid prerequisites never invoke a provider', t => {
  const { judge, agy, calls, env } = fixture(t);
  for (const [variable, value, expected] of [['OPENAI_API_KEY', 'x\ny', 'openai_key_invalid'], ['CODEX_POLISH_AGY_AUTH', 'oauth-personal', 'unsupported_google_auth']]) {
    assert.ok(judge('auto', [], { [variable]: value })[1].blockers.includes(expected));
  }
  fs.unlinkSync(agy);
  assert.ok(judge()[1].blockers.includes('agy_missing')); assert.ok(!fs.existsSync(calls) && !fs.existsSync(env.XDG_CACHE_HOME));
});

test('direct route skips the judge and enforces project policy', t => {
  const { judge, finish, check, mode, agy, calls } = fixture(t), keyless = { OPENAI_API_KEY: '' };
  for (const key of [undefined, '', ' \t\n']) {
    const env = { OPENAI_API_KEY: key }, status = check(env);
    assert.equal(status.decisions_enabled, false); assert.equal(status.decisions_mode, 'auto'); assert.deepEqual(status.blockers, []);
    assert.deepEqual(judge('auto', [], env), [0, { action: 'rewrite', reason: 'direct_acp', route: 'acp' }]);
    assert.deepEqual(finish('acp', 'auto', [], env), [0, { action: 'accept', reason: 'workflow_ready', route: 'acp' }]);
  }
  fs.writeFileSync(mode, 'manual'); assert.equal(judge('auto', [], keyless)[1].reason, 'project_mode');
  assert.equal(judge('explicit', [], keyless)[1].action, 'rewrite');
  fs.writeFileSync(mode, 'off'); assert.equal(finish('acp', 'explicit', [], keyless)[1].reason, 'project_mode');
  fs.writeFileSync(mode, 'auto'); fs.unlinkSync(agy);
  assert.deepEqual(judge('auto', [], keyless)[1].blockers, ['agy_missing']); assert.equal(fs.existsSync(calls), false);
});

test('finish requires the saved route, leaves stdin unread, and calls neither provider', t => {
  const { cwd, home, env, script, judge, calls, logged } = fixture(t);
  const { route } = judge()[1];
  const args = ['--trigger', 'auto', '--cwd', cwd];
  assert.equal(run(script, ['decision', 'verify', ...args], { env }).status, 2);
  assert.equal(run(script, ['finish', ...args], { env }).status, 2);

  const file = path.join(home, 'stdin');
  const input = '{"question":"q","draft":"private draft","candidate":"private candidate"}';
  fs.writeFileSync(file, input);
  const fd = fs.openSync(file, 'r');
  try {
    const output = json(run(script, ['finish', ...args, '--route', route], { env, stdio: [fd, 'pipe', 'pipe'] }));
    assert.deepEqual(output, { action: 'accept', reason: 'workflow_ready', route });
    assert.equal(fs.readFileSync(fd, 'utf8'), input);
  } finally {
    fs.closeSync(fd);
  }
  assert.deepEqual(logged(), ['judge']);
  assert.equal(fs.existsSync(calls + '.agy'), false);
});

test('opt-out and routing changes cannot silently call OpenAI', t => {
  const { invoke, check, judge, finish, calls, logged } = fixture(t);
  assert.equal(invoke(['set-decisions', 'off'])[1].decisions_mode, 'off');
  const status = check({ OPENAI_API_KEY: 'bad key' });
  assert.deepEqual([status.decisions_mode, status.decisions_enabled, status.blockers], ['off', false, []]);
  assert.equal(judge()[1].route, 'acp');
  assert.equal(judge('explicit', ['--route', 'decisions'])[1].reason, 'decision_route_changed');
  assert.equal(finish('decisions', 'explicit')[1].reason, 'decision_route_changed');
  invoke(['set-decisions', 'auto']);
  assert.equal(judge('explicit', ['--route', 'acp'])[1].reason, 'decision_route_changed');
  assert.equal(finish('acp', 'explicit')[1].reason, 'decision_route_changed');
  assert.equal(fs.existsSync(calls), false);
  assert.equal(judge('explicit', ['--route', 'decisions'])[1].route, 'decisions'); assert.deepEqual(logged(), ['judge']);
});

test('direct route ignores only OpenAI cooldowns and recovers ACP', t => {
  const { note, check, judge, finish, calls } = fixture(t), env = { OPENAI_API_KEY: '' };
  for (const reason of ['api_quota_exhausted', 'invalid_api_response']) {
    note(reason); const recent = check().cooldown;
    assert.equal(recent.reason, reason); assert.equal(check(env).cooldown, null);
    assert.equal(judge('auto', [], env)[1].action, 'rewrite');
    finish('acp', 'explicit', ['--recovery-token', recent.token], env);
    assert.equal(check().cooldown.token, recent.token);
  }
  note('acp_auth_failed'); assert.equal(judge('auto', [], env)[1].reason, 'cooldown');
  assert.equal(finish('acp', 'auto', [], env)[1].reason, 'cooldown');
  const first = judge('explicit', [], env)[1].recovery_token;
  note('acp_timeout'); finish('acp', 'explicit', ['--recovery-token', first], env);
  const second = judge('explicit', [], env)[1].recovery_token;
  assert.notEqual(first, second); finish('acp', 'explicit', ['--recovery-token', second], env);
  assert.equal(check(env).cooldown, null); assert.equal(fs.existsSync(calls), false);
});

test('turbo skips Decisions with any OpenAI key and preserves the saved normal-mode policy', t => {
  const { invoke, judge, finish, check, calls, note, logged } = fixture(t);
  note('api_quota_exhausted');
  const previous = check().cooldown;
  invoke(['set-rewrite-mode', 'turbo']);
  for (const key of [undefined, 'valid-test-key', 'bad key']) {
    const env = { OPENAI_API_KEY: key };
    const status = check(env);
    assert.deepEqual([status.rewrite_mode, status.decisions_mode, status.decisions_enabled], ['turbo', 'auto', false]);
    assert.deepEqual(status.blockers, []); assert.equal(status.cooldown, null);
    assert.deepEqual(judge('auto', ['--rewrite-mode', 'turbo'], env), [0, { action: 'rewrite', reason: 'direct_acp', route: 'acp' }]);
    assert.equal(finish('acp', 'explicit', ['--rewrite-mode', 'turbo', '--recovery-token', previous.token], env)[1].action, 'accept');
  }
  assert.equal(finish('decisions')[1].reason, 'decision_route_changed');
  assert.equal(fs.existsSync(calls), false);
  invoke(['set-rewrite-mode', 'normal']);
  assert.equal(check().cooldown.token, previous.token);
  assert.equal(judge()[1].reason, 'cooldown');
  assert.equal(judge('explicit')[1].route, 'decisions');
  assert.deepEqual(logged(), ['judge']);
});

test('turbo honors ACP recovery, trigger policy and local requirements', t => {
  const { invoke, mode, agy, note, check, judge, finish, calls } = fixture(t);
  invoke(['set-rewrite-mode', 'turbo']);
  note('acp_auth_failed');
  assert.equal(judge()[1].reason, 'cooldown');
  assert.equal(finish('acp')[1].reason, 'cooldown');
  const token = judge('explicit')[1].recovery_token;
  assert.equal(token, check().cooldown.token);
  assert.equal(finish('acp', 'explicit', ['--recovery-token', token])[1].action, 'accept');
  assert.equal(check().cooldown, null);
  fs.writeFileSync(mode, 'manual');
  assert.equal(judge()[1].reason, 'project_mode');
  assert.equal(judge('explicit')[1].route, 'acp');
  fs.writeFileSync(mode, 'off');
  assert.equal(judge('explicit')[1].reason, 'project_mode');
  fs.writeFileSync(mode, 'auto');
  fs.unlinkSync(agy);
  assert.deepEqual(judge()[1].blockers, ['agy_missing']);
  assert.equal(fs.existsSync(calls), false);
});

test('decision and finish detect strategy changes even when both use direct ACP', t => {
  const { invoke, judge, finish, calls } = fixture(t);
  invoke(['set-decisions', 'off']);
  for (const [before, after] of [['normal', 'turbo'], ['turbo', 'normal']]) {
    const pinned = ['--rewrite-mode', before];
    assert.equal(judge('auto', pinned)[1].route, 'acp');
    invoke(['set-rewrite-mode', after]);
    assert.equal(judge('auto', pinned)[1].reason, 'rewrite_mode_changed');
    assert.equal(finish('acp', 'auto', pinned)[1].reason, 'rewrite_mode_changed');
    assert.equal(finish('acp', 'auto', ['--rewrite-mode', after])[1].action, 'accept');
  }
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
  const { judge, finish, mode, logged, calls } = fixture(t);
  assert.equal(judge('auto', [], { CODEX_POLISH_AGY_AUTH: 'agent-platform', GEMINI_API_KEY: '' })[1].action, 'rewrite');
  fs.writeFileSync(mode, 'manual'); assert.equal(finish('decisions')[1].reason, 'project_mode');
  fs.writeFileSync(mode, 'off'); assert.equal(finish('decisions', 'explicit')[1].reason, 'project_mode');
  assert.deepEqual(logged(), ['judge']); assert.equal(fs.existsSync(calls + '.agy'), false);
});

test('failed judge suppresses auto and explicit recovery is scoped', t => {
  const { judge, finish, note, check, logged } = fixture(t);
  const error = { FAULT_TEST_EXIT: '1', FAULT_TEST_RESPONSE: '{"action":"keep","reason":"api_rate_limited"}' };
  assert.deepEqual(judge('auto', [], error), [1, { action: 'keep', reason: 'api_rate_limited' }]);
  assert.equal(judge()[1].reason, 'cooldown');
  const first = judge('explicit')[1].recovery_token;
  note('acp_auth_failed');
  assert.equal(finish('decisions', 'explicit', ['--recovery-token', first])[1].action, 'accept');
  assert.equal(check().cooldown.reason, 'acp_auth_failed');
  const token = judge('explicit')[1].recovery_token;
  finish('decisions', 'explicit', ['--recovery-token', token]);
  assert.equal(check().cooldown, null); assert.deepEqual(logged(), ['judge', 'judge', 'judge']);
});

test('broken helper, rejected input and content refusal retain original without backoff', t => {
  const { judge, note, check } = fixture(t);
  const env = { FAULT_TEST_RESPONSE: '{', FAULT_TEST_EXIT: '1' };
  assert.deepEqual(judge('auto', [], env), [1, { action: 'keep', reason: 'decision_helper_unavailable' }]);
  for (const reason of ['api_refusal', 'possible_credential', 'display_control', 'editor_prompt_invalid', 'decision_route_changed', 'rewrite_mode_invalid']) {
    const expected = { action: 'keep', reason };
    env.FAULT_TEST_RESPONSE = JSON.stringify(expected);
    assert.deepEqual(judge('auto', [], env), [1, expected]);
    assert.equal(check().cooldown, null);
  }
  note('acp_tool_requested'); assert.equal(check().cooldown, null);
});

test('unrecognized helper output cannot be delivered or recorded', t => {
  const { judge, check } = fixture(t);
  for (const [exit, response] of [['0', '{"action":"rewrite","reason":"needs_rewrite"}'],
    ['0', '{"action":"rewrite","probability":true,"reason":"needs_rewrite"}'], ['1', '{"action":"keep","reason":"private example"}']]) {
    assert.deepEqual(judge('auto', [], { FAULT_TEST_EXIT: exit, FAULT_TEST_RESPONSE: response }), [1, { action: 'keep', reason: 'decision_helper_unavailable' }]);
    assert.equal(check().cooldown, null);
  }
});

test('auto hook shows a pause notice during backoff and stays silent without Node', t => {
  const { installed, env, cwd, bin, note, invoke } = fixture(t);
  const command = JSON.parse(fs.readFileSync(path.join(installed, 'hooks/hooks.json'))).hooks.UserPromptSubmit[0].hooks[0].command;
  const settings = { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PLUGIN_ROOT: installed };
  const hook = () => {
    const p = spawnSync('/bin/sh', ['-c', command], { env: settings, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd }) });
    assert.equal(p.status, 0); assert.equal(p.stderr, ''); return p.stdout;
  };
  assert.equal(hook(), ''); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const ready = () => assert.match(hook(), /codex-polish:codex-polish/);
  const paused = () => {
    const notice = JSON.parse(hook()).hookSpecificOutput.additionalContext;
    assert.match(notice, /temporarily paused/);
    assert.doesNotMatch(notice, /codex-polish:codex-polish/);
  };
  ready(); note('invalid_api_response'); paused();
  settings.OPENAI_API_KEY = ''; ready();
  settings.OPENAI_API_KEY = env.OPENAI_API_KEY;
  invoke(['set-rewrite-mode', 'turbo']); ready();
  note('acp_timeout'); paused();
});
