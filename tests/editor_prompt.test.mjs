import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { json, makeProject, mkfifo, plugin, preferences, run, supportsFileSymlink, windows } from './hook_fixture.mjs';
import { PROMPT_FILE, readBundledEditorRole } from '../plugins/codex-polish/hooks/editor_prompt.mjs';

function fixture(t) {
  const project = makeProject(t);
  const profile = (args, options = {}) => run(preferences, [...args, '--profile'], { env: project.env, ...options });
  const file = path.join(project.env.CODEX_HOME, 'codex-polish', 'settings', PROMPT_FILE);
  return { ...project, profile, file };
}

test('fresh profile uses the bundled prompt, and checking or resetting creates no settings', t => {
  const { profile, file, env, home, check } = fixture(t);
  const { header, text } = readBundledEditorRole();
  const role = path.join(plugin, 'skills/codex-polish/references/codex-polish-editor.md');
  assert.equal(header + text + '\n', fs.readFileSync(role, 'utf8'));
  assert.deepEqual(json(profile(['prompt'])), { source: 'default', text });
  assert.equal(check().prompt_source, 'default');
  assert.deepEqual(json(profile(['set-prompt', '--reset'])), { prompt_source: 'default', file });
  assert.ok(!fs.existsSync(path.dirname(file)));
  json(profile(['set-rewrite-mode', 'turbo']));
  assert.equal(json(profile(['prompt'])).source, 'default');
  assert.notEqual(json(profile(['prompt'])).text, text);
  const defaultEnv = { ...env };
  delete defaultEnv.CODEX_HOME;
  const saved = json(profile(['set-prompt'], { env: defaultEnv, input: 'Use short sentences.' }));
  assert.equal(saved.file, path.join(home, '.codex', 'codex-polish', 'settings', PROMPT_FILE));
});

test('one profile prompt keeps literal UTF-8 and covers every project and rewrite mode', t => {
  const { profile, file, env, home, project, check, call } = fixture(t);
  const second = path.join(home, 'another project');
  fs.mkdirSync(second);
  const oldFile = path.join(project, '.codex', PROMPT_FILE);
  fs.writeFileSync(oldFile, 'Private to the old project.');
  assert.equal(check().prompt_source, 'default');
  const text = '  \r\n用中文说明。\r\n\r\nKeep `$` and ${names} intact.\t\r\n  ';
  assert.deepEqual(json(profile(['set-prompt'], { input: text })), { prompt_source: 'custom', file });
  if (!windows) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(json(profile(['prompt'])), { source: 'custom', text });
  for (const where of [project, second]) {
    assert.equal(check({ where }).prompt_source, 'custom');
    assert.equal(json(call(['check', '--trigger', 'explicit'], { where })).prompt_source, 'custom');
    assert.equal(json(call(['check', '--trigger', 'explicit', '--selection-only'], { where })).prompt_source, 'default');
  }
  assert.ok(!call(['check']).stdout.includes('Keep'));
  const otherProfile = { env: { ...env, CODEX_HOME: path.join(home, 'other profile') } };
  assert.equal(json(profile(['prompt'], otherProfile)).source, 'default');
  const other = 'Other profile only.';
  json(profile(['set-prompt'], { ...otherProfile, input: other }));
  json(profile(['set-prompt', '--reset']));
  assert.equal(check().prompt_source, 'default');
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(oldFile, 'utf8'), 'Private to the old project.');
  assert.equal(json(profile(['prompt'], otherProfile)).text, other);
});

test('host input preserves multiline prompts and project or link options are rejected', t => {
  const { profile, env, project, file } = fixture(t);
  const text = "  首行\r\n`$HOME` 和 ' 引号\r\n  ";
  const saved = profile(['set-prompt', '--host-input'], { input: JSON.stringify(text) + '\n' });
  assert.equal(saved.status, 0, saved.stderr);
  assert.ok(saved.stdout.startsWith('input_ready\n'));
  for (const command of ['prompt', 'set-prompt']) {
    for (const args of [[], ['--cwd', project], ['--profile', '--cwd', project], ['--profile', '--link', file]]) {
      assert.equal(run(preferences, [command, ...args], { env, input: 'replace' }).status, 2);
    }
  }
  assert.equal(json(profile(['prompt'])).text, text);
});

test('a saved custom prompt can be inspected even if the default automatic rewrite mode is invalid', t => {
  const { profile, file, call } = fixture(t);
  const text = 'Be concise.\n';
  json(profile(['set-prompt'], { input: text }));
  fs.writeFileSync(path.join(path.dirname(file), 'codex-polish.rewrite-mode'), 'typo');
  assert.deepEqual(json(profile(['prompt'])), { source: 'custom', text });
  const explicit = json(call(['check', '--trigger', 'explicit']));
  assert.equal(explicit.rewrite_mode, 'turbo');
  assert.equal(explicit.prompt_source, 'custom');
  assert.ok(json(call(['check', '--trigger', 'auto'])).blockers.includes('rewrite_mode_invalid'));
  json(profile(['set-prompt', '--reset']));
  assert.notEqual(profile(['prompt']).status, 0);
});

test('invalid save input preserves existing content and never echoes the prompt', t => {
  const { profile } = fixture(t);
  const secret = 'password=example-private-value';
  const longPrompt = secret + '\x1b[31m' + 'é'.repeat(32 * 1024);
  json(profile(['set-prompt'], { input: longPrompt }));
  for (const input of ['', ' \n\t ', Buffer.from([0xff])]) {
    const result = profile(['set-prompt'], { input });
    assert.notEqual(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.equal(json(profile(['prompt'])).text, longPrompt);
  }
  const wrongArgs = profile(['set-prompt', secret]);
  assert.equal(wrongArgs.status, 2);
  assert.ok(!(wrongArgs.stdout + wrongArgs.stderr).includes(secret));
});

test('invalid bytes, linked files and unsafe profile directories cannot supply a prompt', t => {
  const { home, profile, file, check } = fixture(t);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const neighbor = path.join(home, 'neighbor.md');
  const secret = 'private words';
  fs.writeFileSync(neighbor, secret);
  function invalid() {
    const result = profile(['prompt']);
    assert.notEqual(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.equal(check().prompt_source, 'invalid');
    assert.ok(check().blockers.includes('editor_prompt_invalid'));
  }
  function rejectsWrites() {
    assert.notEqual(profile(['set-prompt'], { input: '替换' }).status, 0);
    assert.notEqual(profile(['set-prompt', '--reset']).status, 0);
  }
  for (const content of [Buffer.from([0xff]), ' \n', '']) {
    fs.writeFileSync(file, content);
    invalid();
  }
  fs.unlinkSync(file);
  fs.linkSync(neighbor, file);
  invalid();
  fs.unlinkSync(file);
  if (supportsFileSymlink()) {
    fs.symlinkSync(neighbor, file);
    invalid();
    rejectsWrites();
    fs.unlinkSync(file);
  }
  if (windows) fs.mkdirSync(file);
  else mkfifo(file);
  invalid();
  rejectsWrites();
  fs.rmSync(file, { recursive: true });
  fs.rmdirSync(directory);
  fs.writeFileSync(path.join(home, PROMPT_FILE), secret);
  fs.symlinkSync(home, directory, 'junction');
  invalid();
  rejectsWrites();
  assert.equal(fs.readFileSync(neighbor, 'utf8'), secret);
  assert.equal(fs.readFileSync(path.join(home, PROMPT_FILE), 'utf8'), secret);
});
