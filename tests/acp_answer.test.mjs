import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { completedAnswer } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_answer.mjs';
import { Fixture, SESSION } from './fixture_acp.mjs';

const program = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_answer.mjs', import.meta.url));
const model = 'gemini-4-hydrogen';
const line = fields => JSON.stringify({ jsonrpc: '2.0', ...fields }) + '\n';
const chunk = (text, sessionId = SESSION, sessionUpdate = 'agent_message_chunk') => line({ method: 'session/update',
  params: { sessionId, update: { sessionUpdate, content: { type: 'text', text } } } });
const end = (stopReason = 'end_turn') => line({ id: 6, result: { stopReason } });

function scope(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'polish-offline-answer-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, sessionId: SESSION, model, thinkingLevel: 'medium' };
}

test('offline rendering accepts only the completed text for the submitted session and preserves attribution', t => {
  const options = scope(t);
  const draft = '原稿。';
  const candidate = '  新文。\r\n';
  const input = { draft, output: chunk('other', 'elsewhere') + chunk('private', SESSION, 'agent_thought_chunk') +
    line({ id: 6, method: 'session/request_permission' }) + chunk(candidate) + end() };
  assert.equal(completedAnswer(input, options), candidate);
  assert.equal(completedAnswer({ ...input, display_language: 'zh' }, options),
    candidate + '\n\n<details><summary>Gemini 改写 · 查看 GPT 原稿</summary>\n\n原稿。\n\n</details>');
  assert.equal(completedAnswer({ ...input, display_language: 'en' }, { ...options, selection: true, trigger: 'explicit' }),
    candidate + '\n\n<details><summary>Rewritten by Gemini · View original text</summary>\n\n原稿。\n\n</details>');
  const same = { ...input, draft: candidate, display_language: 'zh' };
  assert.equal(completedAnswer(same, options), candidate);
  assert.equal(completedAnswer(same, { ...options, trigger: 'explicit' }), 'Gemini 返回了原稿。\n\n' + candidate);
  assert.throws(() => completedAnswer(input, { ...options, turnsBack: 1 }), /invalid_input/);
  assert.throws(() => completedAnswer(input, { ...options, turnsBack: 1, selection: true }), /invalid_options/);
});

test('the offline CLI forwards the trigger when Gemini returns a user selection unchanged', t => {
  const { cwd } = scope(t);
  const args = [program, '--cwd', cwd, '--model', model, '--thinking-level', 'medium', '--session-id', SESSION];
  const draft = '   Quoted paragraph.\r\n';
  const input = JSON.stringify({ draft, display_language: 'en', output: chunk(draft) + end() });
  function run(...flags) {
    return spawnSync(process.execPath, [...args, ...flags], { input, encoding: 'utf8' });
  }
  const selected = run('--trigger', 'explicit', '--selection');
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.stdout, 'Gemini returned the original text.\n\n' + draft);
  const automatic = run('--trigger', 'auto');
  assert.equal(automatic.status, 0, automatic.stderr);
  assert.equal(automatic.stdout, draft);
  const invalid = run('--trigger', 'turbo');
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
});

test('offline renderer reports incomplete, corrupt, or mismatched output without exposing a partial answer', t => {
  const options = scope(t);
  const fixture = new Fixture('ok');
  fixture.model = model;
  fixture.thinking = 'high';
  const changed = line({ method: 'session/update', params: { sessionId: SESSION,
    update: { sessionUpdate: 'config_option_update', configOptions: fixture.options() } } });
  for (const [output, reason] of [[chunk('partial'), 'acp_incomplete'], [chunk('partial') + end('cancelled'), 'acp_incomplete'],
    [chunk('partial') + end().trimEnd(), 'acp_incomplete'], [chunk('partial') + 'corrupt\n' + end(), 'acp_protocol_error'],
    [chunk('partial') + line({ id: 5, result: {} }) + end(), 'acp_protocol_error'],
    [chunk('partial') + changed + end(), 'acp_thinking_level_unavailable']]) {
    assert.throws(() => completedAnswer({ draft: 'original', output }, options), { message: reason });
  }
});

test('host reads a long completed answer page by page over the offline helper terminal', { timeout: 20000 }, async t => {
  const { cwd } = scope(t);
  const args = [program, '--cwd', cwd, '--model', model, '--thinking-level', 'medium', '--session-id', SESSION];
  const text = 'a'.repeat(6143) + '🐕' + '\0'.repeat(1050) + '雪\n"\\🐕🏽'.repeat(900);
  const input = JSON.stringify({ draft: 'old', output: chunk(text) + end() });
  const plain = spawnSync(process.execPath, args, { input, encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, text);
  const child = spawn(process.execPath, [...args, '--host-input']);
  const done = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'input_ready');
  // Also exercise an input line split across host writes.
  child.stdin.write(input.slice(0, 100));
  child.stdin.write(input.slice(100) + '\n');
  let result = '';
  for (;;) {
    const raw = (await lines.next()).value;
    assert.ok(Buffer.byteLength(raw) <= 6250);
    const page = JSON.parse(raw);
    assert.ok(page.text.isWellFormed());
    if (!result) assert.equal(page.text, 'a'.repeat(6143));
    result += page.text;
    if (!page.more) break;
    assert.equal((await lines.next()).value, 'input_ready');
    child.stdin.write('\r\n');
  }
  assert.equal(result, text);
  assert.deepEqual(await done, [0, null]);
});
