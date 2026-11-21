import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test as nodeTest } from 'node:test';
import { useTestProfile, writeTestPrompt } from './hook_fixture.mjs';
import { fileURLToPath } from 'node:url';
import { prepareWorkspace } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_workspace.mjs';
import { editorRole } from '../plugins/codex-polish/skills/codex-polish/scripts/editor_role.mjs';
import { formatReply } from '../plugins/codex-polish/skills/codex-polish/scripts/reply_display.mjs';

// These tests inspect Unix FIFOs, inode ownership, and shell job control.
// acp_native.test.mjs drives the public workspace lifecycle on every platform.
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
const scripts = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/', import.meta.url));
const stock = fs.readFileSync(join(scripts, '../references/codex-polish-editor.md'), 'utf8');
const base = { auth: 'existing-session', model: 'gemini-4-hydrogen', trigger: 'explicit', route: 'acp', rewriteMode: 'turbo', display: 'zh' };

function fixture(t, program = 'exit 0') {
  const cwd = fs.mkdtempSync(join(tmpdir(), "polish-test- ' "));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const agyPath = join(cwd, 'agy');
  fs.writeFileSync(agyPath, '#!/bin/sh\n' + program + '\n', { mode: 0o700 });
  const profile = useTestProfile(t);
  return { cwd, agyPath, profile };
}

function prepare(t, options) {
  const prepared = prepareWorkspace(options);
  t.after(() => fs.rmSync(prepared.workspace, { recursive: true, force: true }));
  return prepared;
}

function launch(start) {
  return spawn(start.shell, ['-c', start.cmd], { cwd: start.workdir,
    env: { ...process.env, OPENAI_API_KEY: 'fixture-secret' }, stdio: ['pipe', 'pipe', 'pipe'] });
}

test('one CLI call prepares private pipes and stages the exact role for this turn', t => {
  const { cwd, agyPath, profile } = fixture(t);
  const custom = "  Custom\n'$(false)'\r\n";
  writeTestPrompt(profile, custom);
  for (const selectionOnly of [false, true]) {
    const args = [join(scripts, 'acp_workspace.mjs'), '--agy-path', agyPath, '--cwd', cwd, '--trigger', 'explicit',
      '--auth', base.auth, '--model', base.model, '--route', base.route, '--rewrite-mode', base.rewriteMode, '--display', base.display];
    if (selectionOnly) args.push('--selection-only');
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const { workspace, fifo, editor_role_file, start } = JSON.parse(run.stdout);
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
    assert.equal(fs.statSync(fifo).mode & 0o777, 0o600);
    const displayPipe = fs.statSync(join(workspace, '.acp-display'));
    assert.ok(displayPipe.isFIFO());
    assert.equal(displayPipe.mode & 0o777, 0o600);
    assert.equal(fs.statSync(editor_role_file).mode & 0o777, 0o600);
    const staged = fs.readFileSync(editor_role_file, 'utf8');
    assert.equal(staged, editorRole(cwd, 'explicit', { selectionOnly }));
    assert.equal(staged.includes(custom), !selectionOnly);
    assert.equal(start.workdir, workspace);
    assert.equal(start.tty, true);
    assert.equal(start.login, false);
    assert.ok(start.yield_time_ms <= 250);
    assert.doesNotMatch(start.cmd, /Custom/);
    assert.match(start.cmd, / acp --agent codex-polish-editor --sandbox 0<>\.acp-in/);
  }
});

test('catalog uses the stock role and only accepts an unused file in a private log directory', t => {
  const { agyPath, cwd } = fixture(t);
  const args = { agyPath, catalog: true, auth: base.auth, catalogLog: join(cwd, 'record.jsonl') };
  const setup = prepare(t, args);
  assert.ok(!fs.existsSync(join(setup.workspace, '.acp-display')));
  assert.equal(fs.readFileSync(setup.editor_role_file, 'utf8'), stock);
  assert.throws(() => prepareWorkspace({ ...args, model: base.model }));
  assert.throws(() => prepareWorkspace({ ...args, display: 'en' }));
  assert.throws(() => prepareWorkspace({ agyPath, cwd, ...base, display: undefined }));
  assert.throws(() => prepareWorkspace({ agyPath, cwd, ...base, display: 'unsupported' }));
  assert.throws(() => prepareWorkspace({ agyPath, cwd, ...base, quotedSource: true, turnsBack: 1 }));
  assert.throws(() => prepareWorkspace({ ...args, catalog: false, cwd, trigger: 'explicit', model: base.model }));
  fs.writeFileSync(args.catalogLog, 'keep');
  assert.throws(() => prepareWorkspace(args));
  assert.equal(fs.readFileSync(args.catalogLog, 'utf8'), 'keep');
  fs.unlinkSync(args.catalogLog);
  fs.chmodSync(cwd, 0o755);
  assert.throws(() => prepareWorkspace(args));
});

test('the host runs the quoted executable once, sends exclusively via FIFO, and cleans up on exit', { timeout: 20000 }, async t => {
  const { agyPath, cwd } = fixture(t, `
[ "$*" = 'acp --agent codex-polish-editor --sandbox' ] && [ -z "\${OPENAI_API_KEY+x}" ] || exit 41
IFS= read -r request && [ "$request" = test ] || exit 42
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
`);
  const { start, workspace, fifo } = prepare(t, { agyPath, cwd, ...base });
  const proc = launch(start);
  const done = once(proc, 'close');
  t.after(() => proc.kill('SIGTERM'));
  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const event = async () => JSON.parse((await lines.next()).value);
  assert.equal((await event()).event, 'send');
  proc.stdin.write('not a frame\n');
  const collision = spawnSync(start.shell, ['-c', start.cmd], { cwd: workspace });
  assert.notEqual(collision.status, 0);
  assert.ok(fs.lstatSync(fifo).isFIFO());
  fs.linkSync(join(workspace, '.acp-owner'), join(workspace, '.acp-prompt'));
  fs.writeFileSync(fifo, 'test\n');
  assert.match((await event()).exec.cmd, /session\/new/);
  await done;
  assert.equal(fs.existsSync(workspace), false);
});

test('interrupt reaps a child that ignores TERM and cleanup keeps foreign entries and linked directories', { timeout: 20000 }, async t => {
  const { agyPath, cwd } = fixture(t, `trap '' INT TERM\nprintf '%s' "$$" > fixture-pid\nprintf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'\nwhile IFS= read -r line; do :; done`);
  const { start, workspace, fifo, editor_role_file } = prepare(t, { agyPath, cwd, ...base });
  const proc = launch(start);
  t.after(() => proc.kill('SIGTERM'));
  const done = once(proc, 'close');
  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  await lines.next();
  assert.match((await lines.next()).value, /session\/new/);
  const pid = Number(fs.readFileSync(join(workspace, 'fixture-pid'), 'utf8'));
  const originalRoleDir = dirname(editor_role_file);
  fs.renameSync(originalRoleDir, originalRoleDir + '-moved');
  fs.writeFileSync(join(cwd, 'agent.md'), 'external');
  fs.symlinkSync(cwd, originalRoleDir);
  assert.equal(proc.kill('SIGINT'), true);
  const [code] = await done;
  assert.equal(code, 130);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(fifo), false);
  assert.ok(fs.existsSync(join(workspace, 'fixture-pid')));
  assert.equal(fs.readFileSync(join(cwd, 'agent.md'), 'utf8'), 'external');
  assert.ok(fs.existsSync(join(originalRoleDir + '-moved', 'agent.md')));
});

test('one-time writer rejects closed, replaced and missing pipes without touching the target', t => {
  const { cwd, agyPath } = fixture(t);
  const { workspace, write_token, fifo } = prepare(t, { agyPath, cwd, ...base });
  const run = (...args) => spawnSync(process.execPath, [join(scripts, 'acp_workspace.mjs'), ...args], { cwd: workspace, timeout: 10000 });
  const send = () => run('--write', write_token, 'frame', 'example');
  assert.equal(send().status, 1);
  assert.equal(run('--activate', write_token).status, 0);
  assert.equal(send().status, 1); // ENXIO when there is no reader
  const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  try {
    assert.equal(send().status, 0);
    const frame = Buffer.alloc(8);
    assert.equal(fs.readSync(fd, frame), frame.length);
    assert.equal(frame.toString(), 'example\n');
    fs.renameSync(fifo, fifo + '-moved');
    assert.equal(send().status, 1);
    assert.equal(fs.existsSync(fifo), false);
    fs.symlinkSync(fifo + '-moved', fifo);
    assert.equal(send().status, 1);
    fs.unlinkSync(fifo);
    fs.writeFileSync(fifo, 'replacement');
    assert.equal(send().status, 1);
    assert.equal(fs.readFileSync(fifo, 'utf8'), 'replacement');
  } finally { fs.closeSync(fd); }
});

test('owner-pinned prompt claim is one-use and a foreign marker cannot authorize collection', t => {
  const { cwd, agyPath } = fixture(t);
  const { workspace, write_token } = prepare(t, { agyPath, cwd, ...base });
  const program = `import { claimPrompt, submittedPrompt } from ${JSON.stringify(join(scripts, 'acp_workspace.mjs'))};
    if (process.argv[1] === 'claim') claimPrompt(process.argv[2], 'session-ident');
    else console.log(submittedPrompt(process.argv[2]));`;
  const run = op => spawnSync(process.execPath, ['--input-type=module', '-e', program, op, write_token], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run('read').stdout.trim(), 'null');
  assert.equal(run('claim').status, 0);
  assert.equal(run('read').stdout.trim(), 'session-ident');
  assert.equal(run('claim').status, 1);
  fs.unlinkSync(join(workspace, '.acp-prompt'));
  fs.writeFileSync(join(workspace, '.acp-prompt'), 'forged');
  assert.equal(run('read').status, 1);
});

test('a draft larger than the FIFO buffer survives a slow reader byte for byte', { timeout: 20000 }, async t => {
  const { cwd, agyPath } = fixture(t);
  const { workspace, write_token, editor_role_file } = prepare(t, { agyPath, cwd, ...base });
  const script = join(scripts, 'acp_workspace.mjs');
  assert.equal(spawnSync(process.execPath, [script, '--activate', write_token], { cwd: workspace }).status, 0);
  const reader = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const display = fs.openSync('.acp-display', fs.constants.O_RDWR);
    const provider = fs.openSync('.acp-in', fs.constants.O_RDWR);
    function record(fd) {
      const chunks = [];
      const buffer = Buffer.alloc(8192);
      do {
        const count = fs.readSync(fd, buffer);
        chunks.push(Buffer.from(buffer.subarray(0, count)));
      } while (chunks.at(-1).at(-1) !== 10);
      return JSON.parse(Buffer.concat(chunks));
    }
    console.log('ready');
    setTimeout(() => {
      const metadata = record(display);
      const frame = record(provider);
      const material = JSON.parse(frame.params.prompt[0].text);
      console.log(JSON.stringify({ metadata, material }));
    }, 200);
  `], { cwd: workspace });
  t.after(() => reader.kill('SIGKILL'));
  const lines = createInterface({ input: reader.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'ready');
  const sender = spawn(process.execPath, [script, '--write', write_token, 'prompt', '--submit', '--session-id', 'fixture',
    '--cwd', cwd, '--editor-role-file', editor_role_file, '--route', base.route, '--rewrite-mode', base.rewriteMode,
    '--model', base.model, '--trigger', base.trigger, '--no-history'], {
    cwd: workspace, env: { ...process.env, PATH: cwd + ':' + process.env.PATH, CODEX_POLISH_AGY_AUTH: 'existing-session' },
  });
  t.after(() => sender.kill('SIGKILL'));
  const sent = once(sender, 'close');
  const draft = "多行\n'\t$()".repeat(40000);
  const submitted = { question: 'fixture?', draft, rewrite_request: 'Change the opening.' };
  sender.stdin.end(JSON.stringify(submitted) + '\n');
  assert.equal((await sent)[0], 0);
  assert.deepEqual(JSON.parse((await lines.next()).value), { metadata: { draft, question: 'fixture?' }, material: submitted });
});

test('a provider crash drains observer output and the shell removes its staged files', { timeout: 20000 }, async t => {
  const { agyPath, cwd } = fixture(t, 'kill -KILL $$');
  const { start, workspace } = prepare(t, { agyPath, cwd, ...base });
  const proc = launch(start);
  t.after(() => proc.kill('SIGTERM'));
  const done = once(proc, 'close');
  let output = '';
  proc.stdout.on('data', chunk => { output += chunk; });
  await done;
  assert.match(output, /acp_incomplete/);
  assert.equal(fs.existsSync(workspace), false);
});

test('an observer crash ends the provider and a replaced marker survives disposal', { timeout: 20000 }, async t => {
  const { agyPath, cwd } = fixture(t, `trap '' TERM\nprintf '%s' "$$" > "$0.pid"\nprintf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'\nwhile IFS= read -r line; do :; done`);
  const { start, workspace } = prepare(t, { agyPath, cwd, ...base });
  // Record the exact observer our test will interrupt without needing a process listing.
  const proc = launch({ ...start, cmd: start.cmd.replace('acp_observer=$!',
    'acp_observer=$!; printf %s "$acp_observer" > fixture-observer') });
  t.after(() => proc.kill('SIGTERM'));
  const done = once(proc, 'close');
  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  await lines.next();
  assert.match((await lines.next()).value, /session\/new/);
  const observer = Number(fs.readFileSync(join(workspace, 'fixture-observer'), 'utf8'));
  fs.unlinkSync(join(workspace, 'fixture-observer'));
  const provider = Number(fs.readFileSync(agyPath + '.pid', 'utf8'));
  fs.unlinkSync(join(workspace, '.acp-live'));
  fs.writeFileSync(join(workspace, '.acp-live'), 'foreign');
  process.kill(observer, 'SIGKILL');
  await done;
  assert.throws(() => process.kill(provider, 0), { code: 'ESRCH' });
  assert.deepEqual(fs.readdirSync(workspace), ['.acp-live']);
});

for (const shell of ['/bin/sh', '/bin/dash'].filter(path => fs.existsSync(path))) {
  test(`${shell} preserves a failed provider's status when USR1 stops only the observer`, t => {
    const { agyPath, cwd } = fixture(t, 'IFS= read -r line || exit 1\nexit 37');
    const { start, workspace } = prepare(t, { agyPath, cwd, ...base });
    // Hold the output pipe open so the observer cannot see EOF when the provider exits.
    const cmd = start.cmd.replace(/\nacp_wait$/, () => `
exec 5>.acp-out
printf 'finish\\n' >.acp-in
while kill -0 "$acp_provider" 2>/dev/null; do /bin/sleep 0.01; done
kill -0 "$acp_observer" || exit 1
kill -USR1 "$$"`);
    const run = spawnSync(shell, ['-c', cmd], { cwd: workspace, encoding: 'utf8', timeout: 5000 });
    assert.ifError(run.error);
    assert.equal(run.status, 37, run.stderr);
    assert.equal(fs.existsSync(workspace), false);
  });

  test(`${shell} reaps a TERM-ignoring provider on a terminal error with no host interrupt`, { timeout: 15000 }, async t => {
    const { agyPath, cwd } = fixture(t, `trap '' TERM
printf '%s' "$$" > "$0.pid"
IFS= read -r initialize || exit 1
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"fixture failure"}}'
while IFS= read -r unused; do :; done`);
    const { start, workspace } = prepare(t, { agyPath, cwd, ...base });
    const proc = launch({ ...start, shell });
    const done = once(proc, 'close');
    t.after(() => proc.kill('SIGTERM'));
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const initialize = JSON.parse((await lines.next()).value);
    assert.equal(initialize.event, 'send');
    const write = spawnSync(initialize.exec.shell, ['-c', initialize.exec.cmd], { cwd: initialize.exec.workdir });
    assert.equal(write.status, 0);
    const error = JSON.parse((await lines.next()).value);
    assert.equal(error.event, 'error');
    const pid = Number(fs.readFileSync(agyPath + '.pid', 'utf8'));
    await done;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(fs.existsSync(workspace), false);
  });
}

const deliveryCases = [
  { name: 'an inline Markdown delivery reaps the waiting provider', paged: false },
  { name: 'paged Markdown survives provider close until the last page drains', paged: true },
];
if (fs.existsSync('/bin/dash')) {
  for (const providerExit of [0, 37, 127]) {
    deliveryCases.push({ name: `dash preserves provider exit ${providerExit} after paged delivery`,
      paged: true, shell: '/bin/dash', providerExit });
  }
}
for (const { name, paged, shell = '/bin/sh', providerExit = 0 } of deliveryCases) {
  test(name, { timeout: 20000 }, async t => {
    const body = paged ? '分页文字'.repeat(1600) : '  一行回答。\n';
    const id = 'fixture-id';
    const draft = paged ? '原稿\n'.repeat(4000) : '  原稿。  ';
    const markdown = formatReply({ draft, candidate: body, display_language: base.display, source_label: paged ? 'quoted' : 'gpt' }).display_text;
    // The provider exits after close, even if the local reply still has pages to serve.
    const emit = fields => "printf '%s\\n' '" + JSON.stringify({ jsonrpc: '2.0', ...fields }) + "'";
    const { agyPath, cwd } = fixture(t, [
      "trap '' TERM", 'printf %s "$$" > "$0.pid"', 'IFS= read -r line',
      emit({ id: 1, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } } }),
      'IFS= read -r line', emit({ id: 3, result: { sessionId: id, configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: base.model,
          options: [{ value: base.model, name: 'Fixture model' }] },
      ] } }), 'IFS= read -r line',
      emit({ method: 'session/update', params: { sessionId: id, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: body } } } }),
      emit({ id: 6, result: { stopReason: 'end_turn' } }),
      'IFS= read -r line', emit({ id: 7, result: {} }), ': > "$0.closed"', `exit ${providerExit}`,
    ].join('\n'));
    const setup = prepare(t, { agyPath, cwd, ...base, quotedSource: paged });
    const proc = launch({ ...setup.start, shell });
    t.after(() => proc.kill('SIGTERM'));
    const done = once(proc, 'close');
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const event = async () => JSON.parse((await lines.next()).value);
    const run = exec => {
      const child = spawnSync(exec.shell || '/bin/sh', ['-c', exec.cmd], { cwd: exec.workdir, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      return child.stdout;
    };
    run((await event()).exec);
    run((await event()).exec);
    assert.equal((await event()).event, 'submit');
    const submit = spawnSync(process.execPath, [join(scripts, 'acp_workspace.mjs'), '--write', setup.write_token, 'prompt',
      '--submit', '--session-id', id, '--cwd', cwd, '--editor-role-file', setup.editor_role_file, '--route',
      base.route, '--rewrite-mode', base.rewriteMode, '--model', base.model, '--trigger', base.trigger, '--no-history'], {
      cwd: setup.workspace, env: { ...process.env, PATH: cwd + ':' + process.env.PATH, CODEX_POLISH_AGY_AUTH: 'existing-session' },
      input: JSON.stringify({ question: 'fixture?', draft }) + '\n', encoding: 'utf8',
    });
    assert.equal(submit.status, 0, submit.stderr);
    const result = await event();
    assert.equal(result.event, paged ? 'answer_pages' : 'delivery');
    assert.equal(result.finish, undefined);
    if (paged) {
      const close = { jsonrpc: '2.0', id: 7, method: 'session/close', params: { sessionId: id } };
      const write = spawnSync(process.execPath, [join(scripts, 'acp_workspace.mjs'), '--write', setup.write_token,
        'frame', JSON.stringify(close)], { cwd: setup.workspace });
      assert.equal(write.status, 0);
      // The provider exits immediately on close. The local observer still owns
      // the rendered pages and keeps serving them until the final page drains.
      for (let n = 0; n < 200 && !fs.existsSync(agyPath + '.closed'); n++)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(fs.existsSync(agyPath + '.closed'));
      let next = result.exec;
      let text = '';
      while (next) {
        const page = JSON.parse(run(next));
        text += page.text;
        next = page.next;
      }
      assert.equal(text, markdown);
    } else assert.equal(result.markdown, markdown);
    const pid = Number(fs.readFileSync(agyPath + '.pid', 'utf8'));
    const [code] = await done;
    assert.equal(code, providerExit);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(fs.existsSync(setup.workspace), false);
  });
}
