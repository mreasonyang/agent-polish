import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { windowsSystemTool } from '../plugins/codex-polish/hooks/platform.mjs';
import { promisify } from 'node:util';
import { makeProject, json, mkfifo, agyName, windows, homeEnv, runHookCommand, supportsFileSymlink, preferences, plugin, run } from './hook_fixture.mjs';
import { accessProjectSetting } from '../plugins/codex-polish/hooks/project_setting.mjs';

const exec = promisify(execFile);
function fixture(t) {
  const f = makeProject(t);
  const alias = path.join(f.project, "plug'in with spaces");
  fs.symlinkSync(plugin, alias, 'junction');
  const config = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/hooks.json')));
  const command = config.hooks.UserPromptSubmit[0].hooks[0];
  const hook = (eventName = 'UserPromptSubmit', commandString = command) => {
    const result = runHookCommand(commandString, { encoding: 'utf8', env: { ...f.env, PLUGIN_ROOT: alias },
      input: JSON.stringify({ hook_event_name: eventName, cwd: f.cwd, prompt: '私密样本' }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes('私密样本'));
    return result.stdout;
  };
  return { ...f, hook, getMode: () => f.call(['mode']).stdout.trim() };
}

test('a fresh project receives a reminder for an ordinary prompt without writing settings', t => {
  const { mode, cwd, getMode, check, hook } = fixture(t);
  fs.rmdirSync(path.dirname(mode));
  assert.equal(getMode(), 'auto');
  assert.equal(check().mode, 'auto');
  const response = JSON.parse(hook());
  assert.equal(Object.hasOwn(response, 'systemMessage'), false);
  const output = response.hookSpecificOutput;
  assert.equal(output.hookEventName, 'UserPromptSubmit');
  assert.ok(output.additionalContext.includes(JSON.stringify(path.join(plugin, 'skills/codex-polish/WORKFLOW.md'))));
  assert.doesNotMatch(output.additionalContext, /codex-polish:codex-polish/);
  assert.equal(hook('SessionStart'), '');
  assert.equal(fs.existsSync(path.dirname(mode)), false);
  assert.equal(fs.existsSync(path.join(cwd, '.codex')), false);
});

test('explicit project modes are case insensitive and malformed modes are reported', t => {
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

test('closer overrides and nested repository boundaries', t => {
  const { mode, cwd, getMode } = fixture(t);
  fs.writeFileSync(mode, 'manual');
  assert.equal(getMode(), 'manual');
  fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.equal(getMode(), 'auto');
  fs.mkdirSync(path.join(cwd, '.codex')); fs.writeFileSync(path.join(cwd, '.codex/codex-polish.mode'), 'off');
  assert.equal(getMode(), 'off');
});

test('a project model override can be reset to the default', t => {
  const { project, cwd, check, call } = fixture(t);
  const def = 'gemini-4-hydrogen';
  assert.equal(check().gemini_model, def);
  assert.equal(check().gemini_model_configured, false);
  assert.equal(fs.existsSync(path.join(cwd, '.codex')), false);
  const parent = json(call(['set-model', 'models/gemini-2.5-pro'], { where: project }));
  assert.equal(check().gemini_model, 'models/gemini-2.5-pro');
  if (!windows) assert.equal(fs.statSync(parent.file).mode & 0o777, 0o600);
  const child = json(call(['set-model', 'MODEL_PLACEHOLDER_M8']));
  assert.equal(check().gemini_model, 'MODEL_PLACEHOLDER_M8'); assert.equal(fs.readFileSync(child.file, 'utf8'), 'MODEL_PLACEHOLDER_M8\n');
  assert.equal(json(call(['set-model', '--reset'])).gemini_model, def); assert.equal(check().gemini_model, def);
  assert.equal(child.file, parent.file);
  assert.equal(check({ where: project }).gemini_model, def);
  assert.equal(check({ where: project }).gemini_model_configured, false);
  assert.ok(!fs.existsSync(child.file));
  fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.equal(check().gemini_model, def);
});

test('profile settings work without a project, stay isolated by profile, and yield to project overrides', t => {
  const { cwd, env, check, call } = makeProject(t);
  const key = 'synthetic-key-only-in-the-environment';
  const profile = (args, other = {}) => run(preferences, [...args, '--profile'], { cwd, env: { ...env, OPENAI_API_KEY: key, ...other } });
  const mode = json(profile(['set-rewrite-mode', 'turbo']));
  const model = json(profile(['set-model', 'gemini-4-argon']));
  assert.equal(path.dirname(mode.file), path.join(env.CODEX_HOME, 'codex-polish', 'settings'));
  assert.equal(fs.readFileSync(mode.file, 'utf8'), 'turbo\n');
  assert.equal(fs.readFileSync(model.file, 'utf8'), 'gemini-4-argon\n');
  assert.deepEqual(fs.readdirSync(path.dirname(mode.file)).sort(), ['codex-polish.model', 'codex-polish.rewrite-mode']);
  assert.equal(check().gemini_model, 'gemini-4-argon');
  assert.equal(check().rewrite_mode, 'turbo');
  json(call(['set-model', 'gemini-4-neon']));
  json(call(['set-rewrite-mode', 'normal']));
  assert.equal(check().gemini_model, 'gemini-4-neon');
  assert.equal(check().rewrite_mode, 'normal');
  const defaults = json(profile(['check']));
  assert.equal(defaults.gemini_model, 'gemini-4-argon');
  assert.equal(defaults.rewrite_mode, 'turbo');
  assert.equal(defaults.openai_key_configured, true);
  assert.ok(!JSON.stringify(defaults).includes(key));
  assert.equal(call(['set-rewrite-mode', '--reset', 'turbo']).status, 2);
  assert.equal(json(call(['set-rewrite-mode', '--reset'])).rewrite_mode, 'turbo');
  assert.equal(check().rewrite_mode, 'turbo');
  assert.equal(json(profile(['set-rewrite-mode', '--reset'])).rewrite_mode, 'normal');
  assert.equal(check().rewrite_mode, 'normal');
  assert.equal(json(call(['set-model', '--reset'])).gemini_model, 'gemini-4-argon');
  assert.equal(json(profile(['check'], { CODEX_HOME: path.join(env.CODEX_HOME, 'other') })).rewrite_mode, 'normal');
  assert.equal(profile(['set-model', 'invalid id']).status, 1);
  assert.notEqual(profile(['set-model', 'gemini-4-hydrogen', '--cwd', cwd]).status, 0);
  assert.equal(json(profile(['set-model', '--reset'])).gemini_model, 'gemini-4-hydrogen');
});

test('invalid ids preserve model; corrupt settings block rewrites; links are handled safely', t => {
  const { call, check, project, cwd } = fixture(t);
  fs.mkdirSync(path.join(cwd, '.git'));
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
  if (supportsFileSymlink()) {
    fs.symlinkSync(parent, file);
  assert.notEqual(call(['set-model', '--reset']).status, 0); assert.ok(fs.lstatSync(file).isSymbolicLink());
    fs.unlinkSync(file);
  }
  fs.rmdirSync(path.dirname(file)); fs.symlinkSync(path.dirname(parent), path.dirname(file), 'junction');
  assert.equal(check().gemini_model, 'gemini-4-hydrogen');
  fs.writeFileSync(parent, 'linked-model'); assert.ok(check().blockers.includes('gemini_model_invalid'));
});

test('outside Git the chosen folder owns its settings', t => {
  const { home, call, check } = fixture(t);
  const base = path.join(home, 'standalone'), child = path.join(base, 'sub');
  fs.mkdirSync(child, { recursive: true });
  json(call(['set-model', 'gemini-4-neon'], { where: base }));
  assert.equal(check({ where: child }).gemini_model_configured, false);
  json(call(['set-model', 'gemini-4-argon'], { where: child }));
  assert.equal(check({ where: base }).gemini_model, 'gemini-4-neon');
});

test('Decisions settings recognize ON and OFF and report unknown values', t => {
  const { check, call, env, mode, cwd, project } = fixture(t), options = { env: { ...env, OPENAI_API_KEY: 'example' } };
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
  fs.unlinkSync(child.file); fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.deepEqual(policy(), ['auto', 'auto', true]);
});

test('automatic Normal bypasses an invalid Decisions setting when there is no OpenAI key', t => {
  const { project, env, call } = fixture(t);
  fs.writeFileSync(path.join(project, '.codex/codex-polish.decisions'), 'typo');
  fs.writeFileSync(path.join(project, agyName), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const options = { env: { ...env, PATH: project } };
  assert.ok(json(call(['check'], options)).blockers.includes('decisions_mode_invalid'));
  const status = json(call(['check', '--trigger', 'auto'], options));
  assert.deepEqual([status.rewrite_mode, status.decisions_enabled, status.blockers], ['normal', false, []]);
  assert.deepEqual(json(call(['decision', 'judge', '--trigger', 'auto', '--route', 'acp'], options)),
    { action: 'rewrite', reason: 'direct_acp', route: 'acp' });
  options.env.OPENAI_API_KEY = 'example';
  assert.ok(json(call(['check', '--trigger', 'auto'], options)).blockers.includes('decisions_mode_invalid'));
});

test('rewrite mode inherits independently of the trigger and Decisions settings', t => {
  const { cwd, project, call, check } = fixture(t);
  const parent = { where: project };
  const setting = path.join(project, '.codex/codex-polish.rewrite-mode');
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
  const { call, check, env, project, cwd } = fixture(t);
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
    assert.equal(json(run(preferences, ['prompt', '--profile'], options)).source, 'default');
  };
  fs.writeFileSync(file, 'Normal'); assert.equal(check().rewrite_mode,'normal');
  fs.writeFileSync(file, 'typo'); inspect();
  fs.unlinkSync(file);
  const parent = json(call(['set-rewrite-mode', 'normal'], { where: project }));
  if (!supportsFileSymlink()) return;
  fs.symlinkSync(parent.file, file); inspect();
  assert.notEqual(call(['set-rewrite-mode', 'turbo']).status, 0);
  assert.equal(fs.readFileSync(parent.file, 'utf8'), 'normal\n');
});

test('the profile prompt shows the default for the saved mode and keeps a custom prompt across modes', t => {
  const { env } = fixture(t);
  const profile = (args, input) => json(run(preferences, [...args, '--profile'], { env, input }));
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

test('portable project hook does not require the plugin environment', t => {
  const { mode, cwd, env, project } = fixture(t);
  fs.writeFileSync(mode, 'auto');
  const hooks = json(run(preferences, ['project-hook']));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0];
  const p = runHookCommand(command, { cwd, env: { ...env }, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: project }), encoding: 'utf8' });
  assert.ok(json(p).hookSpecificOutput.additionalContext.includes(JSON.stringify(path.join(plugin, 'skills/codex-polish/WORKFLOW.md'))));
});

test('mode changes from a subdirectory reach the repository root', t => {
  const { mode, cwd, call, getMode, hook } = fixture(t);
  fs.writeFileSync(mode, 'off\n');
  for (const value of ['auto', 'manual', 'off', 'off']) {
    assert.equal(json(call(['set-mode', value])).mode, value);
    assert.equal(getMode(), value); assert.equal(fs.readFileSync(mode, 'utf8'), value + '\n'); assert.equal(Boolean(hook()), value === 'auto');
  }
  assert.equal(fs.existsSync(path.join(cwd, '.codex')), false);
});

test('unsafe mode settings disable rewriting and reject writes', t => {
  const { mode, cwd, call, hook, getMode } = fixture(t);
  fs.writeFileSync(mode, 'auto\n');
  fs.mkdirSync(path.join(cwd, '.git'));
  const dir = path.join(cwd, '.codex'), marker = path.join(dir, path.basename(mode));
  const rejectsMode = () => {
    assert.equal(getMode(), '');
    assert.match(JSON.parse(hook()).systemMessage, /codex-polish.mode/);
    assert.notEqual(call(['set-mode', 'auto']).status, 0);
  };
  fs.symlinkSync(path.join(cwd, 'missing-directory'), dir, 'junction');
  rejectsMode();
  fs.unlinkSync(dir);
  fs.symlinkSync(path.dirname(mode), dir, 'junction');
  rejectsMode();
  fs.unlinkSync(dir); fs.mkdirSync(dir);
  if (supportsFileSymlink()) {
    fs.symlinkSync(mode, marker);
  rejectsMode(); assert.ok(fs.lstatSync(marker).isSymbolicLink());
    fs.unlinkSync(marker);
  }
  if (windows) return;
  mkfifo(marker);
  rejectsMode(); assert.ok(fs.lstatSync(marker).isFIFO()); assert.equal(fs.readFileSync(mode, 'utf8'), 'auto\n');
});

test('a linked repository settings directory uses defaults for absent plugin settings', t => {
  const { home, project, check } = fixture(t);
  const defaults = check();
  const settings = path.join(project, '.codex');
  const shared = path.join(home, 'shared-settings');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'config.toml'), '');
  fs.rmdirSync(settings);
  fs.symlinkSync(shared, settings, 'junction');
  assert.deepEqual(check(), defaults);
  fs.writeFileSync(path.join(shared, 'codex-polish.decisions'), 'auto');
  assert.deepEqual(check().blockers, ['decisions_mode_invalid', ...defaults.blockers]);
});

test('an unreadable mode file disables rewriting', { skip: windows || process.getuid() === 0 }, t => {
  const { mode, getMode, hook } = fixture(t);
  fs.writeFileSync(mode, 'auto', { mode: 0o000 });
  assert.equal(getMode(), '');
  assert.match(JSON.parse(hook()).systemMessage, /codex-polish.mode/);
});

test('history count has independent default, inheritance and override', t => {
  const { check, call, cwd, project, getMode } = fixture(t);
  const count = options => check(options).history_turns;
  const setting = path.join(project, '.codex/codex-polish.history-turns');
  assert.equal(count(), 2); assert.equal(fs.existsSync(path.join(cwd, '.codex')), false); assert.equal(fs.existsSync(setting), false);
  const saved = json(call(['set-history-turns', '10'], { where: project }));
  assert.equal(saved.history_turns, 10); assert.equal(saved.file, setting);
  assert.equal(fs.readFileSync(setting, 'utf8'), '10\n'); if (!windows) assert.equal(fs.statSync(setting).mode & 0o777, 0o600);
  json(call(['set-mode', 'auto'])); assert.equal(count(), 10);
  json(call(['set-history-turns', '0'])); assert.equal(count(), 0);
  assert.equal(getMode(), 'auto'); assert.equal(count({ where: project }), 0);
  const child = path.join(cwd, 'child'); fs.mkdirSync(child); fs.writeFileSync(path.join(child, '.git'), 'gitdir: ../.git');
  assert.equal(count({ where: child }), 2);
});

test('invalid history input preserves saved value and malformed settings report the error', t => {
  const { call, check, project, cwd, mode, getMode } = fixture(t);
  const max = '9223372036854775807', parent = { where: project };
  json(call(['set-history-turns', '6'], parent));
  for (const value of ['11', max]) {
    const result = call(['set-history-turns', value], parent); assert.notEqual(result.status, 0); assert.match(result.stderr, /10/);
  }
  for (const value of ['-1', '1.5', 'three', '1_0', '9223372036854775808']) assert.notEqual(call(['set-history-turns', value], parent).status, 0);
  assert.equal(check(parent).history_turns, 6);
  fs.writeFileSync(mode, 'auto\n');
  fs.mkdirSync(path.join(cwd, '.git'));
  const dir = path.join(cwd, '.codex'), file = path.join(dir, 'codex-polish.history-turns'); fs.mkdirSync(dir);
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
    fs.symlinkSync(path.join(path.dirname(mode),path.basename(file)), file);
    invalid(); assert.equal(check(parent).history_turns, 6); fs.unlinkSync(file);
  }
  fs.rmdirSync(dir); fs.symlinkSync(path.dirname(mode), dir, 'junction');
  invalid();
});

test('concurrent changes never leave partial or unrelated files', async t => {
  const { project, cwd, check, env } = fixture(t);
  const dir = path.join(project, '.codex');
  const file = path.join(dir, 'codex-polish.history-turns');
  for (let round = 0; round < (windows ? 8 : 2); round++) {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      exec(process.execPath, [preferences, 'set-history-turns', String(i), '--cwd', cwd], { env })));
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
  const { home, project, call, env } = makeProject(t);
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
  accessProjectSetting(dir, 'write', path.basename(setting), '4');
  assert.equal(sawConflict, true);
  assert.equal(fs.readFileSync(setting, 'utf8'), '4\n');
  assert.deepEqual(fs.readdirSync(path.join(project, '.codex')), [path.basename(setting)]);
});

test('check never launches agy or returns credentials', t => {
  const { project, cwd, call, env } = fixture(t);
  fs.writeFileSync(path.join(project, agyName), '#!/bin/sh\n: > invocations\n', { mode: 0o700 });
  const result = call(['check'], { cwd, env: { ...env, PATH: project, OPENAI_API_KEY: 'private-openai', GEMINI_API_KEY: 'private-gemini', CODEX_POLISH_AGY_AUTH: 'private-unknown' } });
  const s = json(result);
  for (const secret of ['private-openai', 'private-gemini', 'private-unknown']) assert.ok(!(result.stdout + result.stderr).includes(secret));
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
  const { project } = fixture(t);
  const settings = path.join(project, '.codex');
  const before = process.cwd();
  accessProjectSetting(settings, 'write', 'codex-polish.mode', 'auto');
  assert.equal(accessProjectSetting(settings, 'read', 'codex-polish.mode', 16), 'auto');
  assert.equal(process.cwd(), before);
  assert.throws(() => accessProjectSetting(settings, 'read', 'missing', 16), { code: 'ENOENT' });
  assert.equal(process.cwd(), before);
});
