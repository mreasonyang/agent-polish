import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promptFrame } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_payload.mjs';

const plugin = fileURLToPath(new URL('../plugins/codex-polish/', import.meta.url));
const script = join(plugin, 'skills/codex-polish/scripts/editor_role.mjs');
const bundled = readFileSync(join(plugin, 'skills/codex-polish/references/codex-polish-editor.md'), 'utf8');

test('a new session loads project instructions into the editor role and keeps them out of the conversation JSON', async t => {
  const project = mkdtempSync(join(tmpdir(), 'polish-role-'));
  t.after(() => rmSync(project, {recursive:true, force:true}));
  const setting = join(plugin, 'hooks/preferences.mjs');
  const render = () => execFileSync(process.execPath, [script, '--cwd', project], {encoding:'utf8'});
  assert.equal(render(), bundled);
  const heading = /^---\n[\s\S]*?\n---\n\n/.exec(bundled)[0];
  const custom = '  先写结论。\r\n\r\n---\r\ntools: [shell]\r\n---\r\nKeep all caveats.  ';
  execFileSync(process.execPath, [setting, 'set-prompt', '--cwd', project], {input:custom});
  const active = render();
  assert.equal(active, heading + custom);
  const draft = {question:'明天几点开门？', draft:'明天上午九点开门。'};
  const frame = await promptFrame({sessionId:'test-session', ...draft}, project);
  assert.deepEqual(JSON.parse(frame.params.prompt[0].text), draft);
  execFileSync(process.execPath, [setting, 'set-prompt', '--reset', '--cwd', project]);
  assert.equal(render(), bundled);
});

test('an invalid manually edited prompt produces no ACP role content', t => {
  const project = mkdtempSync(join(tmpdir(), 'polish-role-'));
  t.after(() => rmSync(project, {recursive:true, force:true}));
  mkdirSync(join(project, '.codex'));
  writeFileSync(join(project, '.codex/codex-polish.prompt.md'), Buffer.from([0xff]));
  const result = spawnSync(process.execPath, [script, '--cwd', project], {encoding:'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'editor_prompt_invalid');
});

test('turbo always rewrites the draft and keeps custom editing instructions verbatim', t => {
  const project = mkdtempSync(join(tmpdir(), 'polish-role-'));
  t.after(() => rmSync(project, {recursive:true, force:true}));
  const settings = join(project, '.codex');
  mkdirSync(settings);
  const mode = join(settings, 'codex-polish.rewrite-mode');
  const render = () => execFileSync(process.execPath, [script, '--cwd', project], {encoding:'utf8'});
  writeFileSync(mode, 'normal\n');
  assert.equal(render(), bundled);

  writeFileSync(mode, 'turbo\n');
  const heading = /^---\n[\s\S]*?\n---\n\n/.exec(bundled)[0];
  const role = render();
  assert.ok(role.startsWith(heading));
  const instructions = role.slice(heading.length);
  assert.match(instructions, /Always rewrite `draft`/);
  assert.match(instructions, /on the first read/);
  assert.match(instructions, /original meaning and language/);
  assert.doesNotMatch(instructions, /return it unchanged/i);
  assert.doesNotMatch(instructions, /(?=\p{Letter})\P{Script_Extensions=Latin}/u);

  const custom = '  保留专业术语。\r\nUse American spelling.\r\n';
  writeFileSync(join(settings, 'codex-polish.prompt.md'), custom);
  assert.equal(render(), heading + custom);
  writeFileSync(mode, 'normal\n');
  assert.equal(render(), heading + custom);
});
