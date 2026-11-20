import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { json, makeProject, mkfifo, plugin } from './hook_fixture.mjs';
import { MAX_PROMPT_BYTES, PROMPT_FILE, readBundledEditorRole, readEditorPrompt } from '../plugins/codex-polish/hooks/editor_prompt.mjs';

const settingsFile = project => path.join(project, '.codex', PROMPT_FILE);

test('prompt shows the bundled role body; check and reset leave a fresh project alone', t => {
  const { project, cwd, check, call } = makeProject(t);
  fs.rmdirSync(path.join(project, '.codex'));
  const { header, text } = readBundledEditorRole();
  const role = path.join(plugin, 'skills/codex-polish/references/codex-polish-editor.md');
  assert.equal(header + text + '\n', fs.readFileSync(role, 'utf8'));
  assert.deepEqual(json(call(['prompt'])), { source: 'default', text });
  assert.equal(check().prompt_source, 'default');
  for (const where of [project, cwd]) {
    assert.equal(json(call(['set-prompt', '--reset'], { where })).prompt_source, 'default');
    assert.ok(!fs.existsSync(path.join(where, '.codex')));
  }
});

test('custom prompts survive new CLI processes and keep literal UTF-8 bytes through inheritance', t => {
  const { project, cwd, check, call } = makeProject(t);
  const parentText = '  \r\n用中文说明。\r\n\r\nKeep `$` and ${names} intact.\t\r\n  ';
  const saved = json(call(['set-prompt'], { where: project, input: parentText }));
  assert.deepEqual(saved, { prompt_source: 'custom', file: settingsFile(project) });
  assert.equal(fs.statSync(saved.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(saved.file, 'utf8'), parentText);
  assert.deepEqual(json(call(['prompt'])), { source: 'custom', text: parentText });
  assert.equal(check().prompt_source, 'custom');
  assert.ok(!call(['check']).stdout.includes('Keep'));
  assert.ok(!fs.existsSync(path.join(cwd, '.codex')));

  const childText = '保留空格\n\tRead this first.';
  json(call(['set-prompt'], { input: childText }));
  assert.deepEqual(readEditorPrompt(cwd), { source: 'custom', text: childText });
  json(call(['set-prompt', '--reset']));
  assert.equal(json(call(['prompt'])).source, 'default');
  assert.equal(fs.statSync(settingsFile(cwd)).size, 0);
  assert.equal(readEditorPrompt(project).text, parentText);
  fs.unlinkSync(settingsFile(cwd));
  fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.equal(json(call(['prompt'])).source, 'default');
  json(call(['set-prompt', '--reset'], { where: project }));
  assert.ok(!fs.existsSync(saved.file));
});

test('invalid save input preserves existing content and never echoes the prompt', t => {
  const { call, cwd } = makeProject(t);
  const limit = 'é'.repeat(MAX_PROMPT_BYTES / 2);
  json(call(['set-prompt'], { input: limit }));
  assert.equal(readEditorPrompt(cwd).text, limit);
  const secret = 'password=example-private-value';
  for (const input of ['', ' \n\t ', limit + 'a', Buffer.from([0xff]), 'hide\x1b[31m', secret]) {
    const result = call(['set-prompt'], { input });
    assert.notEqual(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes('example-private-value'));
    assert.equal(readEditorPrompt(cwd).text, limit);
  }
  const wrongArgs = call(['set-prompt', secret]);
  assert.equal(wrongArgs.status, 2);
  assert.ok(!(wrongArgs.stdout + wrongArgs.stderr).includes(secret));
});

test('unsafe or corrupt settings block use without exposing their contents', t => {
  const { cwd, project, call, check } = makeProject(t);
  const file = settingsFile(cwd), parent = settingsFile(project);
  fs.mkdirSync(path.dirname(file));
  const secret = 'private-project-words';
  const invalid = () => {
    assert.throws(() => readEditorPrompt(cwd));
    const result = call(['prompt']);
    assert.notEqual(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    const status = check();
    assert.equal(status.prompt_source, 'invalid');
    assert.ok(status.blockers.includes('editor_prompt_invalid'));
    assert.ok(!JSON.stringify(status).includes(secret));
  };
  for (const content of [Buffer.from([0xff]), ' \n', 'a'.repeat(MAX_PROMPT_BYTES + 1), 'token=' + secret]) {
    fs.writeFileSync(file, content);
    invalid();
  }
  fs.unlinkSync(file);
  fs.writeFileSync(parent, secret);
  fs.linkSync(parent, file);
  invalid();
  fs.unlinkSync(file);
  for (const create of [() => fs.symlinkSync(parent, file), () => mkfifo(file)]) {
    create();
    invalid();
    assert.notEqual(call(['set-prompt'], { input: '替换' }).status, 0);
    assert.notEqual(call(['set-prompt', '--reset']).status, 0);
    fs.unlinkSync(file);
  }
  fs.rmdirSync(path.dirname(file));
  fs.symlinkSync(path.dirname(parent), path.dirname(file));
  invalid();
  assert.notEqual(call(['set-prompt'], { input: '替换' }).status, 0);
  assert.notEqual(call(['set-prompt', '--reset']).status, 0);
  assert.equal(fs.readFileSync(parent, 'utf8'), secret);
});
