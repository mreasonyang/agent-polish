import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { json, makeProject, mkfifo, plugin } from './hook_fixture.mjs';
import { PROMPT_FILE, readBundledEditorRole, readEditorPrompt } from '../plugins/codex-polish/hooks/editor_prompt.mjs';

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

test('custom prompts keep literal UTF-8 bytes across CLI sessions and apply across a repository', t => {
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

  const updated = '保留空格\n\tRead this first.';
  assert.equal(json(call(['set-prompt'], {input:updated})).file, settingsFile(project));
  assert.equal(readEditorPrompt(project).text, updated);
  assert.ok(!fs.existsSync(path.join(cwd,'.codex')));
  fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../.git');
  assert.equal(readEditorPrompt(cwd).source, 'default');
  fs.unlinkSync(path.join(cwd, '.git'));
  json(call(['set-prompt', '--reset']));
  assert.ok(!fs.existsSync(saved.file));
  assert.equal(readEditorPrompt(project).source, 'default');
});

test('invalid save input preserves existing content and never echoes the prompt', t => {
  const { call, cwd } = makeProject(t);
  const longPrompt = 'é'.repeat(32 * 1024);
  json(call(['set-prompt'], { input: longPrompt }));
  assert.equal(readEditorPrompt(cwd).text, longPrompt);
  const secret = 'password=example-private-value';
  for (const input of ['', ' \n\t ', Buffer.from([0xff]), 'hide\x1b[31m', secret]) {
    const result = call(['set-prompt'], { input });
    assert.notEqual(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes('example-private-value'));
    assert.equal(readEditorPrompt(cwd).text, longPrompt);
  }
  const wrongArgs = call(['set-prompt', secret]);
  assert.equal(wrongArgs.status, 2);
  assert.ok(!(wrongArgs.stdout + wrongArgs.stderr).includes(secret));
});

test('unsafe or corrupt settings block use without exposing their contents', t => {
  const { cwd, project, call, check } = makeProject(t);
  const file = settingsFile(project), neighbor = path.join(cwd, 'neighbor.md');
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
  for (const content of [Buffer.from([0xff]), ' \n', '', 'token=' + secret]) {
    fs.writeFileSync(file, content);
    invalid();
  }
  fs.unlinkSync(file);
  fs.writeFileSync(neighbor, secret);
  fs.linkSync(neighbor, file);
  invalid();
  fs.unlinkSync(file);
  for (const create of [() => fs.symlinkSync(neighbor, file), () => mkfifo(file)]) {
    create();
    invalid();
    assert.notEqual(call(['set-prompt'], { input: '替换' }).status, 0);
    assert.notEqual(call(['set-prompt', '--reset']).status, 0);
    fs.unlinkSync(file);
  }
  fs.rmdirSync(path.dirname(file));
  fs.writeFileSync(path.join(cwd, PROMPT_FILE), secret);
  fs.symlinkSync(cwd, path.dirname(file));
  invalid();
  assert.notEqual(call(['set-prompt'], { input: '替换' }).status, 0);
  assert.notEqual(call(['set-prompt', '--reset']).status, 0);
  assert.equal(fs.readFileSync(neighbor, 'utf8'), secret);
});
