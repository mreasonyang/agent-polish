import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { json, makeProject, mkfifo, plugin, preferences } from './hook_fixture.mjs';
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
  if (process.platform !== 'win32') assert.equal(fs.statSync(saved.file).mode & 0o777, 0o600);
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

test('terminal input preserves the entire multiline custom prompt', t => {
  const { call } = makeProject(t);
  const prompt = "  首行\r\n`$HOME` 和 ' 引号\r\n  ";
  const result = call(['set-prompt', '--host-input'], { input: JSON.stringify(prompt) + '\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith('input_ready\n'));
  assert.equal(json(call(['prompt'])).text, prompt);
});

test('a saved custom prompt can be inspected when the automatic rewrite mode is invalid', t => {
  const { project, call } = makeProject(t);
  const text = 'Be concise.\n';
  json(call(['set-prompt'], { input: text }));
  fs.writeFileSync(path.join(project, '.codex/codex-polish.rewrite-mode'), 'typo');
  assert.deepEqual(json(call(['prompt'])), { source: 'custom', text });
  const explicit = json(call(['check', '--trigger', 'explicit']));
  assert.equal(explicit.rewrite_mode, 'turbo');
  assert.equal(explicit.prompt_source, 'custom');
  assert.ok(json(call(['check', '--trigger', 'auto'])).blockers.includes('rewrite_mode_invalid'));
  json(call(['set-prompt', '--reset']));
  assert.notEqual(call(['prompt']).status, 0);
});

test('invalid save input preserves existing content and never echoes the prompt', t => {
  const { call, cwd } = makeProject(t);
  const longPrompt = 'password=example-private-value\x1b[31m' + 'é'.repeat(32 * 1024);
  json(call(['set-prompt'], { input: longPrompt }));
  assert.equal(readEditorPrompt(cwd).text, longPrompt);
  const secret = 'password=example-private-value';
  for (const input of ['', ' \n\t ', Buffer.from([0xff])]) {
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
  for (const content of [Buffer.from([0xff]), ' \n', '']) {
    fs.writeFileSync(file, content);
    invalid();
  }
  fs.unlinkSync(file);
  fs.writeFileSync(neighbor, secret);
  fs.linkSync(neighbor, file);
  invalid();
  fs.unlinkSync(file);
  if (process.platform === 'win32') fs.mkdirSync(file);
  else mkfifo(file);
  invalid();
  assert.notEqual(call(['set-prompt'], { input: '替换' }).status, 0);
  assert.notEqual(call(['set-prompt', '--reset']).status, 0);
  fs.rmSync(file, { recursive: true });
  fs.rmdirSync(path.dirname(file));
  fs.writeFileSync(path.join(cwd, PROMPT_FILE), secret);
  fs.symlinkSync(cwd, path.dirname(file), 'junction');
  invalid();
  assert.notEqual(call(['set-prompt'], { input: '替换' }).status, 0);
  assert.notEqual(call(['set-prompt', '--reset']).status, 0);
  assert.equal(fs.readFileSync(neighbor, 'utf8'), secret);
});

test('tracked project links work directly; other prompt targets must be chosen explicitly', t => {
  const { home, project, cwd, call, check } = makeProject(t);
  execFileSync('git', ['init', '-q', project]);
  const tracked = path.join(project, 'editing.md');
  const untracked = path.join(project, '.env');
  const external = path.join(home, 'shared-prompt.md');
  const link = settingsFile(project);
  fs.writeFileSync(tracked, 'tracked');
  fs.writeFileSync(untracked, 'untracked local file');
  fs.writeFileSync(external, 'shared');
  execFileSync('git', ['-C', project, 'add', '--', 'editing.md']);
  fs.symlinkSync('../editing.md', link);
  if (process.platform === 'win32') {
    const args = ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', project, 'ls-files', '--stage', '-z', '--', 'editing.md'];
    const opts = { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } };
    const check = spawnSync('git', args, opts);
    assert.equal(check.status, 0, check.stderr || check.error?.message);
    assert.match(check.stdout, /^100644 [a-f0-9]+ 0\tediting\.md\0$/);
  }
  assert.equal(readEditorPrompt(cwd).text, 'tracked');
  for (const source of [untracked, external]) {
    fs.unlinkSync(link); fs.symlinkSync(source, link);
    assert.ok(check().blockers.includes('editor_prompt_link_unbound'));
    assert.match(call(['prompt']).stderr, /--link/);
  }
  json(call(['set-prompt', '--link', path.relative(cwd, external)]));
  assert.equal(json(call(['prompt'])).text, 'shared');
  fs.writeFileSync(external, 'updated');
  assert.equal(json(call(['prompt'])).text, 'updated');
  fs.unlinkSync(link); fs.symlinkSync(untracked, link);
  assert.ok(check().blockers.includes('editor_prompt_link_unbound'));
  json(call(['set-prompt'], {input:'new local prompt'}));
  assert.equal(fs.lstatSync(link).isFile(), true);
  assert.equal(fs.readFileSync(untracked,'utf8'),'untracked local file');
  json(call(['set-prompt', '--link', external]));
  json(call(['set-prompt', '--reset']));
  assert.ok(!fs.existsSync(link));
  assert.equal(fs.readFileSync(external, 'utf8'), 'updated');
  fs.symlinkSync(external, link);
  assert.ok(check().blockers.includes('editor_prompt_link_unbound'));
  fs.unlinkSync(link); fs.symlinkSync(path.join(home,'missing'),link);
  assert.ok(check().blockers.includes('editor_prompt_invalid'));
  fs.unlinkSync(link);
  const fifo = path.join(project,'pipe');
  if (process.platform === 'win32') fs.mkdirSync(fifo);
  else mkfifo(fifo);
  const invalid = call(['set-prompt', '--link', fifo]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /regular file containing nonempty UTF-8/);
  assert.equal(fs.existsSync(link),false);
});

test('set-prompt links to a tracked file survive a move and a clone without a profile cache', t => {
  const { home, project, env, call } = makeProject(t);
  const cache = path.join(home, 'unavailable-cache');
  fs.writeFileSync(cache, '');
  const options = { env: { ...env, XDG_CACHE_HOME: cache } };
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { env });
  git('init', '-q');
  const filename = 'src/Editing notes.md';
  fs.writeFileSync(path.join(project, filename), 'Use short sentences.');
  git('add', '--', filename);
  const saved = json(call(['set-prompt', '--link', 'Editing notes.md'], options));
  assert.equal(json(call(['prompt'], options)).text, 'Use short sentences.');
  const untracked = path.join(project, 'untracked.md');
  fs.writeFileSync(untracked, 'Local prompt');
  assert.notEqual(call(['set-prompt', '--link', untracked], options).status, 0);
  assert.equal(json(call(['prompt'], options)).text, 'Use short sentences.');
  git('add', '--', path.relative(project, saved.file));
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Save prompt');
  const moved = path.join(home, 'moved');
  fs.renameSync(project, moved);
  const clone = path.join(home, 'clone');
  execFileSync('git', ['clone', '-q', moved, clone], { env });
  for (const where of [moved, clone]) {
    const text = 'Editing in ' + path.basename(where);
    fs.writeFileSync(path.join(where, filename), text);
    assert.deepEqual(json(call(['prompt'], { ...options, where })), { source: 'custom', text });
  }
});

test('concurrent prompt choices in the same Codex profile remain scoped to each project', async t => {
  const { home, project, call, env } = makeProject(t);
  const neighbor = path.join(home, 'other-project');
  fs.mkdirSync(neighbor);
  const projects = [project, neighbor];
  const targets = projects.map((_, i) => {
    const target = path.join(home, 'shared-' + i + '.md');
    fs.writeFileSync(target, 'Project ' + i);
    return target;
  });
  await Promise.all(projects.map((where, i) =>
    promisify(execFile)(process.execPath, [preferences, 'set-prompt', '--cwd', where, '--link', targets[i]], { env })));
  for (const [i, where] of projects.entries()) assert.equal(json(call(['prompt'], { where })).text, 'Project ' + i);
  json(call(['set-prompt', '--reset'], { where: neighbor }));
  assert.equal(json(call(['prompt'], { where: project })).text, 'Project 0');
});
