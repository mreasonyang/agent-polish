import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { answerEvent } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_answer.mjs';

const moduleUrl = new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_answer.mjs', import.meta.url);
const expected = 'a'.repeat(6143) + '🐕' + '\0'.repeat(1050) + '\uD800' + '雪\n"\\🐕🏽'.repeat(900);

async function session(t, { hold = false, expire = false } = {}) {
  const base = fs.mkdtempSync(join(tmpdir(), 'polish-answer-test-'));
  const directory = fs.realpathSync(base) + '/' + 'long-private-workspace-'.repeat(5);
  fs.mkdirSync(directory, { mode: 0o700 });
  const program = `import { answerEvent } from ${JSON.stringify(moduleUrl.href)};
    import { mock } from 'node:test';
    if (process.env.ANSWER_EXPIRY) mock.timers.enable({ apis: ['setTimeout'] });
    if (process.env.ANSWER_HOLD) process.stdin.resume();
    const onDrained = () => console.log('drained');
    console.log(JSON.stringify(await answerEvent(JSON.parse(process.env.ANSWER_TEXT), process.cwd(), { onDrained })));
    if (process.env.ANSWER_EXPIRY) mock.timers.tick(6 * 60_000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { cwd: directory,
    env: { ...process.env, ANSWER_TEXT: JSON.stringify(expected), ANSWER_HOLD: hold ? '1' : '', ANSWER_EXPIRY: expire ? '1' : '' } });
  const done = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await done;
    fs.rmSync(base, { force: true, recursive: true });
  });
  const events = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return { directory, child, done, events, start: JSON.parse((await events.next()).value) };
}

function page(exec) {
  const read = spawnSync(exec.shell, ['-c', exec.cmd], { cwd: exec.workdir, encoding: 'utf8', timeout: 3000 });
  assert.equal(read.status, 0, read.stderr);
  assert.ok(Buffer.byteLength(read.stdout) < 8192);
  const output = JSON.parse(read.stdout);
  assert.equal(output.event, 'answer_page');
  return output;
}

test('short completed answers stay inline with exact whitespace', async () => {
  const text = ' \t雪\r\n🐕 ';
  assert.deepEqual(await answerEvent(text, process.cwd(), { onDrained: assert.fail }), { event: 'delivery', markdown: text });
});

test('agent can page an exact answer after provider EOF from a long workspace path', { timeout: 10_000 }, async t => {
  const { start, done, directory } = await session(t);
  assert.equal(start.event, 'answer_pages');
  assert.equal(start.utf8_bytes, Buffer.byteLength(expected));
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  assert.ok(fs.lstatSync(join(directory, files[0])).isSocket());
  const first = page(start.exec);
  assert.deepEqual(page(start.exec), first);
  assert.equal(first.text, 'a'.repeat(6143));
  let result = first.text;
  let next = first.next;
  while (next) {
    const item = page(next);
    result += item.text;
    next = item.next;
  }
  assert.equal(result, expected);
  assert.deepEqual(await done, [0, null]);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('the final page stays repeatable on a live handle and interrupt preserves a foreign replacement', { timeout: 6000 }, async t => {
  const { child, directory, done, start, events } = await session(t, { hold: true });
  let last = start.exec;
  let result = page(last);
  while (result.next) {
    last = result.next;
    result = page(last);
  }
  assert.deepEqual(page(last), result);
  const [name] = fs.readdirSync(directory);
  const path = join(directory, name);
  fs.renameSync(path, path + '-moved');
  fs.writeFileSync(path, 'foreign');
  child.kill('SIGTERM');
  assert.deepEqual(await done, [null, 'SIGTERM']);
  assert.equal((await events.next()).value, 'drained');
  assert.equal((await events.next()).done, true);
  assert.equal(fs.readFileSync(path, 'utf8'), 'foreign');
});

test('an abandoned paged answer notifies the observer on idle expiry', { timeout: 6000 }, async t => {
  const { done, events, directory, start } = await session(t, { expire: true });
  assert.equal(start.event, 'answer_pages');
  assert.deepEqual(await done, [0, null]);
  assert.equal((await events.next()).value, 'drained');
  assert.equal((await events.next()).done, true);
  assert.deepEqual(fs.readdirSync(directory), []);
});
