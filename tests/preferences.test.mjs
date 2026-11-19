import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { makeProject, json, mkfifo, preferences, plugin, run } from './hook_fixture.mjs';
import { accessProjectSetting } from '../plugins/codex-polish/hooks/project_setting.mjs';

const exec = promisify(execFile);
function fixture(t) {
  const f = makeProject(t);
  const alias = path.join(f.project, "plug'in with spaces");
  fs.symlinkSync(plugin, alias);
  const config = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/hooks.json')));
  const command = config.hooks.UserPromptSubmit[0].hooks[0].command;
  const hook = (eventName = 'UserPromptSubmit', commandString = command) => {
    const result = spawnSync('/bin/sh', ['-c', commandString], { encoding: 'utf8', env: { ...f.env, PLUGIN_ROOT: alias },
      input: JSON.stringify({ hook_event_name: eventName, cwd: f.cwd, prompt: '私密样本' }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes('私密样本'));
    return result.stdout;
  };
  return { ...f, hook, getMode: () => f.call(['mode']).stdout.trim() };
}

test('only opted-in projects receive reminders', t => {
  const { mode, getMode, hook } = fixture(t);
  assert.equal(getMode(), 'manual'); assert.equal(hook(), '');
  fs.writeFileSync(mode, 'auto\n');
  assert.equal(getMode(), 'auto');
  const output = JSON.parse(hook()).hookSpecificOutput;
  assert.equal(output.hookEventName, 'UserPromptSubmit');
  assert.match(output.additionalContext, /codex-polish/);
  assert.equal(hook('SessionStart'), '');
  for (const value of ['off', 'typo', 'auto\n             trailing', '']) {
    fs.writeFileSync(mode, value);
    assert.equal(getMode(), 'off'); assert.equal(hook(), '');
  }
});

test('closer overrides and nested repository boundaries', t => {
  const { mode, cwd, getMode } = fixture(t);
  fs.writeFileSync(mode, 'auto'); fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.equal(getMode(), 'manual');
  fs.mkdirSync(path.join(cwd, '.codex')); fs.writeFileSync(path.join(cwd, '.codex/codex-polish.mode'), 'off');
  assert.equal(getMode(), 'off');
});

test('model selection is scoped and explicit reset restores Hydrogen', t => {
  const { project, cwd, check, call } = fixture(t);
  const def = 'gemini-4-hydrogen';
  assert.equal(check().gemini_model, def);
  assert.equal(fs.existsSync(path.join(cwd, '.codex')), false);
  const parent = json(call(['set-model', 'models/gemini-2.5-pro'], { where: project }));
  assert.equal(check().gemini_model, 'models/gemini-2.5-pro');
  assert.equal(fs.statSync(parent.file).mode & 0o777, 0o600);
  const child = json(call(['set-model', 'MODEL_PLACEHOLDER_M8']));
  assert.equal(check().gemini_model, 'MODEL_PLACEHOLDER_M8'); assert.equal(fs.readFileSync(child.file, 'utf8'), 'MODEL_PLACEHOLDER_M8\n');
  assert.equal(json(call(['set-model', '--reset'])).gemini_model, def); assert.equal(check().gemini_model, def);
  assert.equal(check({ where: project }).gemini_model, 'models/gemini-2.5-pro');
  fs.unlinkSync(child.file); fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.equal(check().gemini_model, def);
});

test('invalid ids preserve model; corrupt settings block rewrites; links are handled safely', t => {
  const { call, check, project } = fixture(t);
  const { file } = json(call(['set-model', 'gemini-example']));
  for (const args of [[], ['--reset', 'gemini-other'], ['gemini-a b'], ['gemini-1\nreset'], ['models/../secret'], ['a'.repeat(257)], ['gemini-私密']]) {
    assert.notEqual(call(['set-model', ...args]).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'gemini-example\n');
  }
  fs.writeFileSync(file, 'bad value\n');
  assert.equal(check().gemini_model, null); assert.ok(check().blockers.includes('gemini_model_invalid'));
  const decision = json(call(['decision', 'judge', '--trigger', 'explicit']));
  assert.equal(decision.action, 'keep'); assert.ok(decision.blockers.includes('gemini_model_invalid'));
  fs.unlinkSync(file);
  const parent = path.join(project, '.codex/codex-polish.model');
  fs.symlinkSync(parent, file);
  assert.notEqual(call(['set-model', '--reset']).status, 0); assert.ok(fs.lstatSync(file).isSymbolicLink());
  fs.unlinkSync(file); fs.rmdirSync(path.dirname(file)); fs.symlinkSync(path.dirname(parent), path.dirname(file));
  assert.equal(check().gemini_model, 'gemini-4-hydrogen');
  fs.writeFileSync(parent, 'linked-model'); assert.ok(check().blockers.includes('gemini_model_invalid'));
});

test('changing model clears only its own previous failure', t => {
  const { check, call } = fixture(t);
  const fail = reason => assert.equal(call(['note-failure', reason]).status, 0);
  fail('acp_model_unavailable');
  const before = check().cooldown;
  assert.equal(before.reason, 'acp_model_unavailable');
  json(call(['set-model', '--reset'])); assert.equal(check().cooldown.token, before.token);
  json(call(['set-model', 'gemini-example'])); assert.equal(check().cooldown, null);
  fail('acp_auth_failed');
  const token = check().cooldown.token;
  json(call(['set-model', '--reset'])); assert.equal(check().cooldown.token, token);
});

test('decision policy inherits, and invalid decisions disable only OpenAI', t => {
  const { check, call, env, mode, cwd, project } = fixture(t), options = { env: { ...env, OPENAI_API_KEY: 'example' } };
  const policy = () => { const s = check(options); return [s.mode, s.decisions_mode, s.decisions_enabled]; };
  fs.writeFileSync(mode, 'auto');
  assert.deepEqual(policy(), ['auto', 'auto', true]);
  const parent = json(call(['set-decisions', 'off'], { where: project }));
  assert.equal(parent.decisions_mode, 'off'); assert.deepEqual(policy(), ['auto', 'off', false]);
  const child = json(call(['set-decisions', 'auto']));
  assert.deepEqual(policy(), ['auto', 'auto', true]); assert.equal(fs.readFileSync(parent.file, 'utf8'), 'off\n');
  fs.writeFileSync(child.file, 'typo'); assert.deepEqual(policy(), ['auto', 'off', false]);
  fs.unlinkSync(child.file); fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.deepEqual(policy(), ['manual', 'auto', true]);
});

test('portable project hook does not require the plugin environment', t => {
  const { mode, cwd, env, project } = fixture(t);
  fs.writeFileSync(mode, 'auto');
  const hooks = json(run(preferences, ['project-hook']));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  const p = spawnSync('/bin/sh', ['-c', command], { cwd, env: { PATH: env.PATH }, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: project }), encoding: 'utf8' });
  assert.match(json(p).hookSpecificOutput.additionalContext, /codex-polish/);
});

test('mode changes affect only the exact target', t => {
  const { mode, cwd, call, getMode, hook } = fixture(t);
  fs.writeFileSync(mode, 'off\n');
  for (const value of ['auto', 'manual', 'off', 'off']) {
    assert.equal(json(call(['set-mode', value])).mode, value);
    assert.equal(getMode(), value); assert.equal(fs.readFileSync(mode, 'utf8'), 'off\n'); assert.equal(Boolean(hook()), value === 'auto');
  }
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.codex')), ['codex-polish.mode']);
});

test('mode writes reject symlinked directories, symlinked settings and FIFOs', t => {
  const { mode, cwd, call } = fixture(t);
  fs.writeFileSync(mode, 'off\n');
  const dir = path.join(cwd, '.codex'), marker = path.join(dir, path.basename(mode));
  fs.symlinkSync(path.dirname(mode), dir);
  assert.notEqual(call(['set-mode', 'auto']).status, 0);
  fs.unlinkSync(dir); fs.mkdirSync(dir); fs.symlinkSync(mode, marker);
  assert.notEqual(call(['set-mode', 'auto']).status, 0); assert.ok(fs.lstatSync(marker).isSymbolicLink());
  fs.unlinkSync(marker); mkfifo(marker);
  assert.notEqual(call(['set-mode', 'auto']).status, 0); assert.ok(fs.lstatSync(marker).isFIFO()); assert.equal(fs.readFileSync(mode, 'utf8'), 'off\n');
});

test('history count has independent default, inheritance and override', t => {
  const { check, call, cwd, project, getMode } = fixture(t);
  const count = options => check(options).history_turns;
  const setting = path.join(project, '.codex/codex-polish.history-turns');
  assert.equal(count(), 2); assert.equal(fs.existsSync(path.join(cwd, '.codex')), false); assert.equal(fs.existsSync(setting), false);
  const saved = json(call(['set-history-turns', '10'], { where: project }));
  assert.equal(saved.history_turns, 10); assert.equal(saved.file, setting);
  assert.equal(fs.readFileSync(setting, 'utf8'), '10\n'); assert.equal(fs.statSync(setting).mode & 0o777, 0o600);
  json(call(['set-mode', 'auto'])); assert.equal(count(), 10);
  json(call(['set-history-turns', '0'])); assert.equal(count(), 0);
  assert.equal(getMode(), 'auto'); assert.equal(count({ where: project }), 10);
  const child = path.join(cwd, 'child'); fs.mkdirSync(child); fs.writeFileSync(path.join(child, '.git'), 'gitdir: ../.git');
  assert.equal(count({ where: child }), 2);
});

test('invalid history input preserves saved value and malformed settings disable history', t => {
  const { call, check, project, cwd, mode, getMode } = fixture(t);
  const max = '9223372036854775807', parent = { where: project };
  json(call(['set-history-turns', '6'], parent));
  for (const value of ['11', max]) {
    const result = call(['set-history-turns', value], parent); assert.notEqual(result.status, 0); assert.match(result.stderr, /10/);
  }
  for (const value of ['-1', '1.5', 'three', '1_0', '9223372036854775808']) assert.notEqual(call(['set-history-turns', value], parent).status, 0);
  assert.equal(check(parent).history_turns, 6);
  fs.writeFileSync(mode, 'auto\n');
  const dir = path.join(cwd, '.codex'), file = path.join(dir, 'codex-polish.history-turns'); fs.mkdirSync(dir);
  for (const value of ['', '-3', '11', 'bad', '1\n0', Buffer.from([255]), '9'.repeat(100)]) {
    fs.writeFileSync(file, value); assert.equal(check().history_turns, 0);
  }
  assert.equal(getMode(), 'auto');
  fs.unlinkSync(file); mkfifo(file);
  const invalid = () => { assert.equal(check().history_turns, 0); assert.notEqual(call(['set-history-turns', '1']).status, 0); };
  invalid(); fs.unlinkSync(file); fs.symlinkSync(path.join(path.dirname(mode),path.basename(file)), file);
  invalid(); assert.equal(check(parent).history_turns, 6); fs.unlinkSync(file); fs.rmdirSync(dir); fs.symlinkSync(path.dirname(mode), dir);
  invalid();
});

test('concurrent changes never leave partial or unrelated files', async t => {
  const { cwd, check, env } = fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => exec(process.execPath, [preferences, 'set-history-turns', String(i), '--cwd', cwd], { env })));
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.codex')), ['codex-polish.history-turns']); assert.ok(check().history_turns < 8);
});

test('check never launches agy or returns credentials', t => {
  const { project, cwd, call, env } = fixture(t);
  fs.writeFileSync(path.join(project, 'agy'), '#!/bin/sh\n: > invocations\n', { mode: 0o700 });
  const result = call(['check'], { cwd, env: { ...env, PATH: project, OPENAI_API_KEY: 'private-openai', GEMINI_API_KEY: 'private-gemini', CODEX_POLISH_AGY_AUTH: 'private-unknown' } });
  const s = json(result);
  for (const secret of ['private-openai', 'private-gemini', 'private-unknown']) assert.ok(!(result.stdout + result.stderr).includes(secret));
  assert.equal(s.agy_available, true); assert.equal(s.codex_available, false); assert.equal(s.openai_key_configured, true);
  assert.equal(s.gemini_key_configured, true); assert.equal(s.google_auth_method, 'unsupported');
  assert.ok(!fs.existsSync(path.join(cwd, 'invocations')) && !fs.existsSync(path.join(cwd, '.codex')));
});

test('locates official agy install when GUI has an older PATH', t => {
  const { project, cwd, check, env } = fixture(t);
  const home = path.join(project, 'temporary home'), dir = path.join(project, 'custom bin'), bin = path.join(home, '.local/bin/agy');
  fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.mkdirSync(dir);
  fs.writeFileSync(bin, '#!/bin/sh\n: > unexpected-launch\n', { mode: 0o600 });
  const opts = { cwd, env: { ...env, HOME: home, PATH: dir } };
  assert.ok(check(opts).blockers.includes('agy_missing')); fs.chmodSync(bin, 0o700);
  const s = check(opts); assert.ok(s.agy_available && !s.blockers.includes('agy_missing')); assert.equal(s.agy_path, bin);
  const selected = path.join(dir, 'agy'); fs.copyFileSync(bin, selected); fs.chmodSync(selected, 0o700);
  assert.equal(check(opts).agy_path, selected); assert.ok(!fs.existsSync(path.join(cwd, 'unexpected-launch')));
});

test('settings I/O restores the working directory on success and on error', t => {
  const { project } = fixture(t);
  const settings = path.join(project, '.codex');
  const before = process.cwd();
  accessProjectSetting(settings, 'write', 'codex-polish.mode', 'auto');
  assert.equal(accessProjectSetting(settings, 'read', 'codex-polish.mode', 16), 'auto');
  assert.equal(process.cwd(), before);
  assert.throws(() => accessProjectSetting(settings, 'read', 'missing', 16), { code: 'ENOENT' });
  assert.equal(process.cwd(), before);
});
