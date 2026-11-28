import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { windowsSystemTool } from '../plugins/codex-polish/hooks/platform.mjs';
import { promisify } from 'node:util';
import { makeProject, json, mkfifo, agyName, windows, homeEnv, runHookCommand, supportsFileSymlink, preferences, plugin, run, useTestProfile } from './hook_fixture.mjs';
import { saveOpenAIKey } from '../plugins/codex-polish/hooks/openai_credentials.mjs';
import { accessSettingFile } from '../plugins/codex-polish/hooks/profile_setting.mjs';

const exec = promisify(execFile);
function fixture(t) {
  const f = makeProject(t);
  fs.mkdirSync(f.settings, { recursive: true });
  const alias = path.join(f.project, "plug'in with spaces");
  fs.symlinkSync(plugin, alias, 'junction');
  const config = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/hooks.json')));
  const command = config.hooks.UserPromptSubmit[0].hooks[0];
  const hook = (eventName = 'UserPromptSubmit', prompt = '私密样本') => {
    const result = runHookCommand(command, { encoding: 'utf8', env: { ...f.env, PLUGIN_ROOT: alias },
      input: JSON.stringify({ hook_event_name: eventName, cwd: f.cwd, prompt }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes('私密样本'));
    return result.stdout;
  };
  return { ...f, hook, getMode: () => f.call(['mode']).stdout.trim() };
}

test('a fresh profile defaults to Manual and recognizes a rewrite request without writing settings', t => {
  const { mode, cwd, getMode, check, hook } = fixture(t);
  fs.rmdirSync(path.dirname(mode));
  assert.equal(getMode(), 'manual');
  assert.equal(check().mode, 'manual');
  assert.equal(hook(), '');
  const response = JSON.parse(hook('UserPromptSubmit', 'Polish.'));
  assert.equal(Object.hasOwn(response, 'systemMessage'), false);
  const output = response.hookSpecificOutput;
  assert.equal(output.hookEventName, 'UserPromptSubmit');
  assert.match(output.additionalContext, /--trigger explicit\b/);
  assert.ok(output.additionalContext.includes(JSON.stringify(path.join(plugin, 'skills/codex-polish/WORKFLOW.md'))));
  assert.doesNotMatch(output.additionalContext, /codex-polish:codex-polish/);
  assert.equal(hook('SessionStart'), '');
  assert.equal(fs.existsSync(path.dirname(mode)), false);
  assert.equal(fs.existsSync(path.join(cwd, '.codex')), false);
});

test('standalone rewrite requests explicitly target the previous reply in auto and manual modes', t => {
  const { mode, call, hook } = fixture(t);
  const submit = prompt => hook('UserPromptSubmit', prompt);
  const shortcuts = [
    '说人话', '  说人话！\n', '重写。', '润色', 'SAY THAT IN PLAIN ENGLISH.', 'Say it in plain English!',
    'Speak plainly', ' rEwRiTe ', 'Polish.',
  ];
  const otherRequests = [
    '解释 DNS，说人话', '“说人话”是什么意思？', '别说人话', '“说人话”', '说人话？',
    '重写函数', '润色是什么？', 'Do not polish', 'Rewrite my function.', 'How do you say it in plain English?',
  ];
  for (const [triggerMode, language, previous] of [
    ['auto', 'en', /previous|preceding|last reply/i],
    ['manual', 'zh', /上一条|上一轮/],
  ]) {
    fs.writeFileSync(mode, triggerMode);
    json(call(['set-language', language]));
    for (const prompt of shortcuts) {
      const { hookEventName, additionalContext } = JSON.parse(submit(prompt)).hookSpecificOutput;
      assert.equal(hookEventName, 'UserPromptSubmit');
      assert.match(additionalContext, previous, prompt);
      assert.match(additionalContext, /--trigger explicit\b/, prompt);
      assert.doesNotMatch(additionalContext, /--trigger auto\b/, prompt);
      assert.ok(additionalContext.includes(JSON.stringify(path.join(plugin, 'skills/codex-polish/WORKFLOW.md'))));
    }
    for (const prompt of ['查看原稿', '查看原文。', 'Show the original draft.', 'show the original text']) {
      assert.equal(submit(prompt), '', prompt);
    }
    for (const prompt of otherRequests) {
      const output = submit(prompt);
      if (triggerMode === 'manual') assert.equal(output, '', prompt);
      else assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /--trigger auto\b/, prompt);
    }
  }
  fs.writeFileSync(mode, 'off');
  for (const prompt of ['说人话', '重写', '润色', 'polish']) assert.equal(submit(prompt), '', prompt);
});

test('saved profile modes are case insensitive and malformed modes are reported', t => {
  const { mode, getMode, hook, check, call } = fixture(t);
  for (const [value, expected] of [
    ['manual', 'manual'], ['AUTO\n', 'auto'], ['OFF', 'off'],
  ]) {
    fs.writeFileSync(mode, value);
    assert.equal(getMode(), expected);
    assert.equal(Boolean(hook()), expected === 'auto');
  }
  for (const bad of ['typo', 'auto\n             trailing', '']) {
    fs.writeFileSync(mode, bad);
    assert.equal(check().mode, null);
    assert.ok(check().blockers.includes('mode_invalid'));
    assert.match(call(['mode']).stderr, /codex-polish.mode/);
    assert.match(JSON.parse(hook()).systemMessage, /auto, manual or off/);
    assert.equal(json(call(['decision', 'judge', '--trigger', 'explicit'])).reason, 'mode_invalid');
  }
});

test('one profile supplies all settings across unrelated repositories, nested worktrees and ordinary folders', t => {
  const { project, home, cwd, call, check, settings, env } = makeProject(t);
  const second = path.join(home, 'second repository');
  const ordinary = path.join(home, 'ordinary folder');
  const clean = path.join(home, 'clean repository');
  for (const dir of [second, clean]) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(ordinary);
  fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');

  const legacy = {
    'codex-polish.mode': 'off', 'codex-polish.decisions': 'broken',
    'codex-polish.history-turns': '0', 'codex-polish.language': 'zh',
    'codex-polish.model': 'obsolete low', 'codex-polish.rewrite-mode': 'turbo',
    'codex-polish.prompt.md': 'Obsolete project instructions.',
  };
  for (const dir of [project, cwd, second]) {
    fs.mkdirSync(path.join(dir, '.codex'));
    for (const [file, value] of Object.entries(legacy)) fs.writeFileSync(path.join(dir, '.codex', file), value);
  }
  const selected = status => [status.mode, status.decisions_mode, status.history_turns, status.language_mode,
    status.gemini_model, status.gemini_thinking_level, status.rewrite_mode, status.prompt_source];
  const defaults = ['manual', 'auto', 2, 'auto', 'gemini-4-hydrogen', 'medium', 'normal', 'default'];
  const dirs = [project, cwd, second, clean, ordinary];
  const hook = where => call(['hook'], { where, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: where }) });
  for (const where of dirs) assert.deepEqual(selected(check({ where })), defaults);
  for (const where of [project, cwd, second]) assert.equal(hook(where).stdout, '');
  assert.equal(fs.existsSync(settings), false);

  const commands = [
    ['set-mode', 'manual'], ['set-decisions', 'off'], ['set-history-turns', '7'],
    ['set-language', 'en'], ['set-model', 'models/gemini-custom', '--thinking-level', 'high'],
    ['set-rewrite-mode', 'turbo'], ['set-prompt'],
  ];
  for (const args of commands) {
    const result = run(preferences, [...args, '--cwd', project], { env, cwd: ordinary, input: 'unused' });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  assert.equal(fs.existsSync(settings), false);
  for (const where of [clean, ordinary, second]) {
    for (const args of commands) {
      const { file } = json(call(args, { where, input: args[0] === 'set-prompt' ? 'Use short sentences.' : undefined }));
      assert.equal(path.dirname(file), settings);
      if (!windows) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  }
  const configured = ['manual', 'off', 7, 'en', 'models/gemini-custom', 'high', 'turbo', 'custom'];
  for (const where of dirs) {
    assert.deepEqual(selected(check({ where })), configured);
    const reminder = hook(where);
    assert.equal(reminder.status, 0, reminder.stderr);
    assert.equal(reminder.stdout, '');
    assert.deepEqual(json(call(['prompt'], { where })), { source: 'custom', text: 'Use short sentences.' });
  }
  assert.deepEqual(selected(json(run(preferences, ['check'], { env, cwd: ordinary }))), configured);
  assert.deepEqual(fs.readdirSync(settings).sort(), Object.keys(legacy).sort());
  assert.deepEqual(fs.readdirSync(path.join(env.CODEX_HOME, 'codex-polish')), ['settings']);
  for (const where of [ordinary, clean]) assert.equal(fs.existsSync(path.join(where, '.codex')), false);
  for (const dir of [project, cwd, second]) {
    assert.deepEqual(fs.readdirSync(path.join(dir, '.codex')).sort(), Object.keys(legacy).sort());
    for (const [file, value] of Object.entries(legacy)) assert.equal(fs.readFileSync(path.join(dir, '.codex', file), 'utf8'), value);
  }

  const other = { where: second, env: { ...env, CODEX_HOME: path.join(home, 'separate profile'), OPENAI_API_KEY: 'ambient-example' } };
  assert.deepEqual(selected(check(other)), defaults);
  assert.equal(check(other).openai_key_configured, false);
  json(call(['set-mode', 'off'], other));
  assert.equal(check(other).mode, 'off');
  assert.equal(check({ where: second }).mode, 'manual');
});

test('resetting the saved model and rewrite mode restores their built-in values across folders', t => {
  const { project, cwd, check, call } = makeProject(t);
  const parent = { where: project };
  const child = { where: cwd };
  assert.equal(check().gemini_model_configured, false);
  assert.equal(check().rewrite_mode_configured, false);
  const model = json(call(['set-model', 'models/gemini-2.5-pro', '--thinking-level', 'high'], parent));
  assert.equal(fs.readFileSync(model.file, 'utf8'), 'models/gemini-2.5-pro high\n');
  assert.equal(check(child).gemini_thinking_level, 'high');
  const rewrite = json(call(['set-rewrite-mode', 'turbo'], child));
  assert.equal(check(parent).rewrite_mode, 'turbo');
  assert.equal(call(['set-rewrite-mode', '--reset', 'turbo']).status, 2);
  const reset = json(call(['set-model', '--reset'], child));
  assert.equal(reset.file, model.file);
  assert.equal(json(call(['set-rewrite-mode', '--reset'], parent)).file, rewrite.file);
  for (const where of [project, cwd]) {
    const status = check({ where });
    assert.deepEqual([status.gemini_model, status.gemini_thinking_level, status.rewrite_mode], ['gemini-4-hydrogen', 'medium', 'normal']);
    assert.deepEqual([status.gemini_model_configured, status.rewrite_mode_configured], [true, true]);
  }
});

test('invalid ids preserve model; corrupt settings block rewrites; links are handled safely', t => {
  const { call, check, project, cwd } = fixture(t);
  fs.mkdirSync(path.join(cwd, '.git'));
  const { file } = json(call(['set-model', 'gemini-example']));
  for (const args of [[], ['--reset', 'gemini-other'], ['gemini-a b'], ['gemini-1\nreset'], ['models/../secret'], ['a'.repeat(257)], ['gemini-私密']]) {
    assert.notEqual(call(['set-model', ...args]).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'gemini-example medium\n');
  }
  for (const level of ['low', 'medium', 'high', 'xhigh', 'fixed']) {
    assert.equal(json(call(['set-model', 'gemini-example', '--thinking-level', level])).gemini_thinking_level, level);
    assert.equal(check().gemini_thinking_level, level);
  }
  for (const args of [['gemini-other', '--thinking-level', 'auto'], ['--reset', '--thinking-level', 'high']]) {
    assert.notEqual(call(['set-model', ...args]).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'gemini-example fixed\n');
  }
  fs.writeFileSync(file, 'bad value\n');
  assert.equal(check().gemini_model, null); assert.ok(check().blockers.includes('gemini_model_invalid'));
  const decision = json(call(['decision', 'judge', '--trigger', 'explicit']));
  assert.equal(decision.action, 'keep'); assert.ok(decision.blockers.includes('gemini_model_invalid'));
  fs.unlinkSync(file);
  const neighbor = path.join(project, 'other-model');
  fs.writeFileSync(neighbor, 'other-model');
  if (supportsFileSymlink()) {
    fs.symlinkSync(neighbor, file);
    assert.notEqual(call(['set-model', '--reset']).status, 0);
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    fs.unlinkSync(file);
  }
  fs.rmdirSync(path.dirname(file));
  fs.symlinkSync(project, path.dirname(file), 'junction');
  assert.ok(check().blockers.includes('gemini_model_invalid'));
  assert.notEqual(call(['set-model', 'new-model']).status, 0);
  assert.equal(fs.existsSync(path.join(project, path.basename(file))), false);
  assert.equal(fs.readFileSync(neighbor, 'utf8'), 'other-model');
});

test('Decisions settings recognize ON and OFF and report unknown values', t => {
  const { check, call, env, mode, cwd, project } = fixture(t), options = { env: { ...env, OPENAI_API_KEY: 'example' } };
  useTestProfile(t, env.CODEX_HOME);
  saveOpenAIKey('plugin-example');
  const policy = () => { const s = check(options); return [s.mode, s.decisions_mode, s.decisions_enabled]; };
  fs.writeFileSync(mode, 'auto');
  assert.deepEqual(policy(), ['auto', 'auto', true]);
  const parent = json(call(['set-decisions', 'off'], { where: project }));
  assert.equal(parent.decisions_mode, 'off'); assert.deepEqual(policy(), ['auto', 'off', false]);
  const child = json(call(['set-decisions', 'auto']));
  assert.deepEqual(policy(), ['auto', 'auto', true]); assert.equal(fs.readFileSync(parent.file, 'utf8'), 'auto\n');
  fs.writeFileSync(child.file, 'ON'); assert.deepEqual(policy(), ['auto', 'auto', true]);
  fs.writeFileSync(child.file, 'OFF'); assert.deepEqual(policy(), ['auto', 'off', false]);
  fs.writeFileSync(child.file, 'typo'); assert.deepEqual(policy(), ['auto', null, false]);
  assert.ok(check(options).blockers.includes('decisions_mode_invalid'));
  assert.ok(!json(call(['check','--trigger','explicit'], options)).blockers.includes('decisions_mode_invalid'));
  json(call(['set-rewrite-mode', 'turbo']));
  assert.ok(check(options).blockers.includes('decisions_mode_invalid'));
  assert.ok(!json(call(['check', '--trigger', 'auto'], options)).blockers.includes('decisions_mode_invalid'));
  fs.unlinkSync(child.file);
  fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.deepEqual(policy(), ['auto', 'auto', false]);
  json(call(['set-rewrite-mode', 'normal']));
  assert.deepEqual(policy(), ['auto', 'auto', true]);
});

test('automatic Normal bypasses an invalid Decisions setting when there is no OpenAI key', t => {
  const { project, env, call, mode, settings } = fixture(t);
  fs.writeFileSync(mode, 'auto');
  fs.writeFileSync(path.join(settings, 'codex-polish.decisions'), 'typo');
  fs.writeFileSync(path.join(project, agyName), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const options = { env: { ...env, PATH: project } };
  assert.ok(json(call(['check'], options)).blockers.includes('decisions_mode_invalid'));
  const status = json(call(['check', '--trigger', 'auto'], options));
  assert.deepEqual([status.rewrite_mode, status.decisions_enabled, status.blockers], ['normal', false, []]);
  assert.deepEqual(json(call(['decision', 'judge', '--trigger', 'auto', '--route', 'acp'], options)),
    { action: 'rewrite', reason: 'direct_acp', route: 'acp' });
  options.env.OPENAI_API_KEY = 'example';
  assert.deepEqual(json(call(['check', '--trigger', 'auto'], options)).blockers, []);
  useTestProfile(t, env.CODEX_HOME);
  saveOpenAIKey('plugin-example');
  assert.ok(json(call(['check', '--trigger', 'auto'], options)).blockers.includes('decisions_mode_invalid'));
});

test('the saved rewrite mode is independent of the trigger and Decisions settings', t => {
  const { cwd, project, call, check, settings } = fixture(t);
  const parent = { where: project };
  const setting = path.join(settings, 'codex-polish.rewrite-mode');
  function modeSelection(options) {
    const { rewrite_mode, rewrite_mode_configured } = check(options);
    return [rewrite_mode, rewrite_mode_configured];
  }
  assert.deepEqual(modeSelection(), ['normal', false]);
  assert.equal(fs.existsSync(setting), false);
  assert.deepEqual(json(call(['set-rewrite-mode', 'turbo'], parent)), { rewrite_mode: 'turbo', file: setting });
  if (!windows) assert.equal(fs.statSync(setting).mode & 0o777, 0o600);
  json(call(['set-mode', 'manual']));
  json(call(['set-decisions', 'off']));
  assert.deepEqual(modeSelection(), ['turbo', true]);
  const child = json(call(['set-rewrite-mode', 'Normal']));
  const status = check();
  assert.deepEqual([status.rewrite_mode, status.rewrite_mode_configured, status.mode, status.decisions_mode], ['normal', true, 'manual', 'off']);
  assert.equal(child.file, setting);
  assert.deepEqual(modeSelection(parent), ['normal', true]);
  assert.equal(call(['set-rewrite-mode', 'fast']).status, 2);
  assert.equal(fs.readFileSync(child.file, 'utf8'), 'normal\n');
  fs.unlinkSync(child.file);
  fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.deepEqual(modeSelection(), ['normal', false]);
});

test('invalid or linked automatic rewrite settings block automatic polishing and leave explicit Turbo available', t => {
  const { call, check, env, mode, project, cwd } = fixture(t);
  fs.writeFileSync(mode, 'auto');
  fs.mkdirSync(path.join(cwd, '.git'));
  const { file } = json(call(['set-rewrite-mode', 'turbo']));
  const inspect = () => {
    const options = { env: { ...env, OPENAI_API_KEY: 'example' } };
    const status = check(options);
    assert.equal(status.rewrite_mode, null);
    assert.equal(status.decisions_enabled, false);
    assert.equal(status.prompt_source, 'default');
    assert.ok(status.blockers.includes('rewrite_mode_invalid'));
    assert.equal(json(call(['decision', 'judge', '--trigger', 'auto'], options)).reason, 'rewrite_mode_invalid');
    const explicit = json(call(['check', '--trigger', 'explicit'], options));
    assert.equal(explicit.rewrite_mode, 'turbo');
    assert.equal(explicit.decisions_enabled, false);
    assert.ok(!explicit.blockers.includes('rewrite_mode_invalid'));
    assert.match(call(['prompt'], options).stderr, /set-rewrite-mode/);
  };
  fs.writeFileSync(file, 'Normal'); assert.equal(check().rewrite_mode,'normal');
  fs.writeFileSync(file, 'typo'); inspect();
  fs.unlinkSync(file);
  if (!supportsFileSymlink()) return;
  const neighbor = path.join(project, 'other-rewrite-mode');
  fs.writeFileSync(neighbor, 'normal\n');
  fs.symlinkSync(neighbor, file); inspect();
  assert.notEqual(call(['set-rewrite-mode', 'turbo']).status, 0);
  assert.equal(fs.readFileSync(neighbor, 'utf8'), 'normal\n');
});

test('the profile prompt shows the default for the saved mode and keeps a custom prompt across modes', t => {
  const { env } = fixture(t);
  const profile = (args, input) => json(run(preferences, args, { env, input }));
  const prompt = () => profile(['prompt']);
  const normal = prompt();
  profile(['set-rewrite-mode', 'turbo']);
  const turbo = prompt();
  assert.equal(turbo.source, 'default');
  assert.notEqual(turbo.text, normal.text);
  assert.match(turbo.text, /rephrase|rewrite/i);
  const custom = 'Keep each paragraph short.';
  profile(['set-prompt'], custom);
  assert.deepEqual(prompt(), { source: 'custom', text: custom });
  profile(['set-rewrite-mode', 'normal']);
  assert.deepEqual(prompt(), { source: 'custom', text: custom });
  profile(['set-prompt', '--reset']);
  assert.deepEqual(prompt(), normal);
});

test('mode changes from a subdirectory reach the profile', t => {
  const { mode, cwd, call, getMode, hook } = fixture(t);
  fs.writeFileSync(mode, 'off\n');
  for (const value of ['auto', 'manual', 'off', 'off']) {
    assert.equal(json(call(['set-mode', value])).mode, value);
    assert.equal(getMode(), value); assert.equal(fs.readFileSync(mode, 'utf8'), value + '\n'); assert.equal(Boolean(hook()), value === 'auto');
  }
  assert.equal(fs.existsSync(path.join(cwd, '.codex')), false);
});

test('unsafe mode settings disable rewriting and reject writes', t => {
  const { settings, home, mode, call, hook, getMode } = fixture(t);
  const neighbor = path.join(home, 'unrelated');
  const saved = path.join(neighbor, path.basename(mode));
  fs.mkdirSync(neighbor);
  fs.writeFileSync(saved, 'auto\n');
  const rejectsMode = () => {
    assert.equal(getMode(), '');
    assert.match(JSON.parse(hook()).systemMessage, /codex-polish.mode/);
    assert.notEqual(call(['set-mode', 'auto']).status, 0);
  };
  fs.rmdirSync(settings);
  for (const target of [path.join(home, 'missing-directory'), neighbor]) {
    fs.symlinkSync(target, settings, 'junction');
    rejectsMode();
    fs.unlinkSync(settings);
  }
  fs.mkdirSync(settings);
  if (supportsFileSymlink()) {
    fs.symlinkSync(saved, mode);
    rejectsMode(); assert.ok(fs.lstatSync(mode).isSymbolicLink());
    fs.unlinkSync(mode);
  }
  if (!windows) {
    mkfifo(mode);
    rejectsMode();
    assert.ok(fs.lstatSync(mode).isFIFO());
  }
  assert.equal(fs.readFileSync(saved, 'utf8'), 'auto\n');
});

test('a linked repository settings directory has no effect even with a conflicting plugin setting', t => {
  const { home, project, check, call } = fixture(t);
  const directory = path.join(home, 'shared-settings');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'config.toml'), '');
  fs.symlinkSync(directory, path.join(project, '.codex'), 'junction');
  const before = check();
  const local = path.join(directory, 'codex-polish.decisions');
  fs.writeFileSync(local, 'broken');
  assert.deepEqual(check(), before);
  json(call(['set-decisions', 'off']));
  assert.equal(check().decisions_mode, 'off');
  assert.equal(fs.readFileSync(local, 'utf8'), 'broken');
});

test('an unreadable mode file disables rewriting', { skip: windows || process.getuid() === 0 }, t => {
  const { mode, getMode, hook } = fixture(t);
  fs.writeFileSync(mode, 'auto', { mode: 0o000 });
  assert.equal(getMode(), '');
  assert.match(JSON.parse(hook()).systemMessage, /codex-polish.mode/);
});

test('a saved history count applies across nested repositories and remains independent of trigger mode', t => {
  const { check, call, cwd, project, getMode, settings } = fixture(t);
  const count = options => check(options).history_turns;
  const setting = path.join(settings, 'codex-polish.history-turns');
  assert.equal(count(), 2); assert.equal(fs.existsSync(path.join(cwd, '.codex')), false); assert.equal(fs.existsSync(setting), false);
  const saved = json(call(['set-history-turns', '10'], { where: project }));
  assert.equal(saved.history_turns, 10); assert.equal(saved.file, setting);
  assert.equal(fs.readFileSync(setting, 'utf8'), '10\n'); if (!windows) assert.equal(fs.statSync(setting).mode & 0o777, 0o600);
  json(call(['set-mode', 'auto'])); assert.equal(count(), 10);
  json(call(['set-history-turns', '0'])); assert.equal(count(), 0);
  assert.equal(getMode(), 'auto'); assert.equal(count({ where: project }), 0);
  const child = path.join(cwd, 'child'); fs.mkdirSync(child); fs.writeFileSync(path.join(child, '.git'), 'gitdir: ../.git');
  assert.equal(count({ where: child }), 0);
});

test('invalid history input preserves saved value and malformed settings report the error', t => {
  const { call, check, project, mode, getMode, settings } = fixture(t);
  const max = '9223372036854775807', parent = { where: project };
  json(call(['set-history-turns', '6'], parent));
  for (const value of ['11', max]) {
    const result = call(['set-history-turns', value], parent); assert.notEqual(result.status, 0); assert.match(result.stderr, /10/);
  }
  for (const value of ['-1', '1.5', 'three', '1_0', '9223372036854775808']) assert.notEqual(call(['set-history-turns', value], parent).status, 0);
  assert.equal(check(parent).history_turns, 6);
  fs.writeFileSync(mode, 'auto\n');
  const file = path.join(settings, 'codex-polish.history-turns');
  for (const value of ['', '-3', '11', 'bad', '1\n0', Buffer.from([255]), '9'.repeat(100)]) {
    fs.writeFileSync(file, value); assert.equal(check().history_turns, null);
    assert.ok(check().blockers.includes('history_turns_invalid'));
    assert.equal(json(call(['check','--no-history'])).history_turns, 0);
    assert.ok(!json(call(['check','--no-history'])).blockers.includes('history_turns_invalid'));
  }
  assert.equal(getMode(), 'auto');
  fs.unlinkSync(file);
  const invalid = () => { assert.equal(check().history_turns, null); assert.notEqual(call(['set-history-turns', '1']).status, 0); };
  if (!windows) { mkfifo(file); invalid(); fs.unlinkSync(file); }
  if (supportsFileSymlink()) {
    const neighbor = path.join(project, 'other-history-count');
    fs.writeFileSync(neighbor, '6');
    fs.symlinkSync(neighbor, file);
    invalid(); assert.equal(fs.readFileSync(neighbor, 'utf8'), '6'); fs.unlinkSync(file);
  }
  fs.unlinkSync(mode);
  fs.rmdirSync(settings); fs.symlinkSync(project, settings, 'junction');
  invalid();
});

test('concurrent changes never leave partial or unrelated files', async t => {
  const { cwd, check, env, settings: dir } = fixture(t);
  const file = path.join(dir, 'codex-polish.history-turns');
  for (let round = 0; round < (windows ? 8 : 2); round++) {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      exec(process.execPath, [preferences, 'set-history-turns', String(i)], { env, cwd })));
    for (const [i, result] of results.entries()) {
      assert.equal(result.status, 'fulfilled', result.reason?.message);
      assert.equal(JSON.parse(result.value.stdout).history_turns, i);
    }
    assert.deepEqual(fs.readdirSync(dir), ['codex-polish.history-turns']);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^[0-7]\n$/);
    assert.equal(check().history_turns, Number(text));
  }
});

test('Windows keeps a locked setting intact and completes atomic replacement once the holder releases it', { skip: !windows }, async t => {
  let holder, closed;
  t.after(async () => { if (holder?.exitCode === null) holder.kill(); await closed; });
  const { home, call, env } = makeProject(t);
  const setting = json(call(['set-history-turns', '7'])).file;
  const dir = path.dirname(setting);
  const release = path.join(home, 'release-handle');
  const powershell = windowsSystemTool('WindowsPowerShell/v1.0/powershell.exe');
  const script = `
    $ErrorActionPreference='Stop'
    $stream=[IO.File]::Open($env:SETTING,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    try {
      [Console]::WriteLine('locked')
      [Console]::Out.Flush()
      while (![IO.File]::Exists($env:RELEASE)) { [Threading.Thread]::Sleep(5) }
    } finally { $stream.Dispose() }`;
  holder = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...env, SETTING: setting, RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  closed = once(holder, 'close');
  const ready = await Promise.race([once(holder.stdout, 'data'), closed.then(([code]) => {
    throw new Error('File handle holder exited before locking the setting: ' + code);
  })]);
  assert.match(ready[0].toString(), /locked/);
  const blocked = call(['set-history-turns', '4']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /rename (?:EPERM|EBUSY|EACCES)/);
  assert.equal(fs.readFileSync(setting, 'utf8'), '7\n');
  assert.deepEqual(fs.readdirSync(dir), [path.basename(setting)]);
  let sawConflict = false;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    try { return rename(from, to); }
    catch (error) {
      assert.equal(to, path.basename(setting));
      assert.ok(['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
      sawConflict = true;
      fs.writeFileSync(release, '');
      throw error;
    }
  });
  accessSettingFile(dir, 'write', path.basename(setting), '4');
  assert.equal(sawConflict, true);
  assert.equal(fs.readFileSync(setting, 'utf8'), '4\n');
  assert.deepEqual(fs.readdirSync(dir), [path.basename(setting)]);
});

test('check never launches agy or returns credentials', t => {
  const { project, cwd, call, env } = fixture(t);
  useTestProfile(t, env.CODEX_HOME);
  saveOpenAIKey('saved-private-openai');
  fs.writeFileSync(path.join(project, agyName), '#!/bin/sh\n: > invocations\n', { mode: 0o700 });
  const result = call(['check'], { cwd, env: { ...env, PATH: project, OPENAI_API_KEY: 'private-openai', GEMINI_API_KEY: 'private-gemini', CODEX_POLISH_AGY_AUTH: 'private-unknown' } });
  const s = json(result);
  for (const secret of ['private-openai', 'saved-private-openai', 'private-gemini', 'private-unknown']) assert.ok(!(result.stdout + result.stderr).includes(secret));
  assert.equal(s.agy_available, true); assert.equal(s.codex_available, false); assert.equal(s.openai_key_configured, true);
  assert.equal(s.gemini_key_configured, true); assert.equal(s.google_auth_method, 'unsupported');
  assert.ok(!fs.existsSync(path.join(cwd, 'invocations')) && !fs.existsSync(path.join(cwd, '.codex')));
});

test('locates official agy install when GUI has an older PATH', t => {
  const { project, cwd, check, env } = fixture(t);
  const home = path.join(project, 'temporary home'), dir = path.join(project, 'custom bin'), bin = windows ? path.join(homeEnv(home).LOCALAPPDATA, 'agy/bin', agyName) : path.join(home, '.local/bin/agy');
  fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.mkdirSync(dir);
  fs.writeFileSync(bin, '#!/bin/sh\n: > unexpected-launch\n', { mode: 0o600 });
  const opts = { cwd, env: { ...env, ...homeEnv(home), PATH: dir } };
  if (!windows) { assert.ok(check(opts).blockers.includes('agy_missing')); fs.chmodSync(bin, 0o700); }
  const s = check(opts); assert.ok(s.agy_available && !s.blockers.includes('agy_missing')); assert.equal(s.agy_path, bin);
  const selected = path.join(dir, agyName); fs.copyFileSync(bin, selected); fs.chmodSync(selected, 0o700);
  assert.equal(check(opts).agy_path, selected); assert.ok(!fs.existsSync(path.join(cwd, 'unexpected-launch')));
});

test('settings I/O restores the working directory on success and on error', t => {
  const { settings } = fixture(t);
  const before = process.cwd();
  accessSettingFile(settings, 'write', 'codex-polish.mode', 'auto');
  assert.equal(accessSettingFile(settings, 'read', 'codex-polish.mode', 16), 'auto');
  assert.equal(process.cwd(), before);
  assert.throws(() => accessSettingFile(settings, 'read', 'missing', 16), { code: 'ENOENT' });
  assert.equal(process.cwd(), before);
});
