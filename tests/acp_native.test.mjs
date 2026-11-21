import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { executable } from '../plugins/codex-polish/hooks/platform.mjs';
import { REPLY, SESSION } from './fixture_acp.mjs';

const windows = process.platform === 'win32';
const workspaceTool = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/acp_workspace.mjs', import.meta.url));
const formatter = join(dirname(workspaceTool), 'format_reply.mjs');
const fixtureURL = new URL('./fixture_acp.mjs', import.meta.url).href;
const model = 'gemini-4-hydrogen';

function shellArgs(exec) {
  if (!windows) return ['-c', exec.cmd];
  assert.match(basename(exec.shell), /^powershell(?:\.exe)?$/i);
  return ['-NoProfile', '-Command', exec.cmd];
}

function run(exe, args, options) {
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 20_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || String(result.signal));
  return result.stdout;
}

async function byDeadline(promise, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description())), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(check, description) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(50);
  }
  assert.fail(description);
}

function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

function openTurn(t, scenario, { catalog = false } = {}) {
  const project = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "polish 原稿 ' & ")));
  const agy = join(project, windows ? 'agy.exe' : 'agy');
  const log = join(project, 'requests.jsonl');
  const pidFile = join(project, 'process.json');
  const env = { ...process.env, HOME: project, USERPROFILE: project, CODEX_HOME: join(project, 'profile'),
    XDG_CACHE_HOME: join(project, 'cache'), CODEX_POLISH_AGY_AUTH: 'existing-session', OPENAI_API_KEY: 'private-test-key' };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  // Only native tools are on the Windows PATH. Git Bash and WSL cannot rescue an emitted command.
  env.PATH = [project, dirname(process.execPath), ...(windows ? [
    join(process.env.SystemRoot, 'System32'), join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0'),
  ] : ['/bin', '/usr/bin'])].join(delimiter);
  if (windows) fs.copyFileSync(process.execPath, agy);
  else fs.symlinkSync(process.execPath, agy);

  const options = catalog ? ['--catalog'] : ['--cwd', project, '--trigger', 'explicit', '--model', model,
    '--route', 'acp', '--rewrite-mode', 'turbo', '--display', 'zh', '--no-history'];
  const { workspace, editor_role_file, start } = JSON.parse(run(process.execPath,
    [workspaceTool, '--agy-path', agy, '--auth', 'existing-session', ...options], { env }));
  const providerCwd = fs.realpathSync.native(workspace);
  assert.equal(start.workdir, windows ? dirname(workspace) : workspace);
  assert.equal(start.tty, !windows);
  assert.match(fs.readFileSync(editor_role_file, 'utf8'), /codex-polish-editor/);

  // agy is a real Node executable. Its first production argument "acp" selects this
  // one-use test script in the provider's cwd. No wrapper parses the remaining argv.
  fs.writeFileSync(join(workspace, 'acp'), `
    const fs = require('node:fs');
    fs.unlinkSync(__filename);
    let child;
    if (process.platform === 'win32' && ${JSON.stringify(scenario)} === 'stalled') {
      child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {stdio:'ignore'});
      child.unref();
    }
    fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({pid:process.pid, descendant:child?.pid, argv:process.argv.slice(2),
      key:process.env.OPENAI_API_KEY ?? null, cwd:fs.realpathSync.native(process.cwd())}));
    import(${JSON.stringify(fixtureURL)}).then(({ Fixture, serveFixture }) =>
      serveFixture(new Fixture(${JSON.stringify(scenario)}), frame =>
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(frame) + '\\n')));`);

  const host = spawn(start.shell, shellArgs(start), { cwd: start.workdir, env });
  const done = once(host, 'close');
  let diagnostic = '';
  host.stderr.setEncoding('utf8').on('data', data => { diagnostic += data; });
  const lines = createInterface({ input: host.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  let lastEvent = 'starting the host';
  function progress() {
    let methods = 'no requests';
    if (fs.existsSync(log)) {
      const records = fs.readFileSync(log, 'utf8').trim().split('\n');
      methods = records.filter(Boolean).map(line => {
        try { return JSON.parse(line).method ?? 'response'; } catch { return 'partial frame'; }
      }).join(', ');
    }
    return `last event: ${lastEvent}; provider started: ${fs.existsSync(pidFile)}; requests: ${methods}; stderr: ${diagnostic}`;
  }
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill();
    if (fs.existsSync(pidFile)) {
      const { pid, descendant } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      for (const id of [pid, descendant]) if (id && !gone(id)) process.kill(id, 'SIGKILL');
    }
    await done;
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 5 });
  });
  const event = async () => {
    const item = await byDeadline(lines.next(), () => 'timed out waiting for ACP output; ' + progress());
    assert.ok(!item.done, 'host exited before its next event; ' + progress());
    const value = JSON.parse(item.value);
    lastEvent = value.event;
    return value;
  };
  const exec = descriptor => run(descriptor.shell, shellArgs(descriptor), { cwd: descriptor.workdir, env });
  async function handshake() {
    let next;
    while ((next = await event()).event === 'send') exec(next.exec);
    return next;
  }
  const requests = () => fs.readFileSync(log, 'utf8').trimEnd().split('\n').map(JSON.parse);
  async function cleaned() {
    const info = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.deepEqual(info.argv, ['--agent', 'codex-polish-editor', '--sandbox']);
    assert.equal(info.key, null);
    assert.equal(info.cwd, providerCwd);
    if (windows && scenario === 'stalled') assert.ok(info.descendant > 0);
    await waitFor(() => gone(info.pid) && (!info.descendant || gone(info.descendant)) && !fs.existsSync(workspace),
      'provider, descendant and workspace must be reclaimed');
  }
  return { host, finished: () => byDeadline(done, () => 'host did not exit; ' + progress()),
    env, project, workspace, exec, event, handshake, requests, cleaned };
}

// Exercise the emitted submit command through a real terminal. A redirected pipe
// cannot detect console echo, canonical input truncation, or ConPTY Unicode loss.
async function submit(t, exec, env, material) {
  if (!windows) return submitWithCodex(exec, env, material);
  const line = JSON.stringify(material) + '\n';
  assert.ok(exec.tty);
  const pty = createRequire(import.meta.url)('node-pty');
  const terminal = pty.spawn(exec.shell, shellArgs(exec), { cwd: exec.workdir, env,
    cols: 160, rows: 40, name: 'xterm-256color', useConpty: true });
  const closed = new Promise(resolve => terminal.onExit(e => resolve(e.exitCode)));
  let output = '';
  let sent = false;
  let code;
  t.after(() => { if (code === undefined) terminal.kill(); });
  terminal.onData(data => {
    output += data;
    if (!sent && output.includes('input_ready')) {
      sent = true;
      terminal.write(line);
    }
  });
  code = await byDeadline(closed, () => 'ConPTY submit timed out ' +
    (sent ? 'after writing the complete JSON record' : 'before input_ready'));
  assert.equal(code, 0, output);
  assert.ok(sent, 'the terminal must announce input_ready');
  assert.doesNotMatch(output, /私有原稿|fixture-question|rewrite_request|draft"/);
}

for (const scenario of ['interleaved', 'unchanged']) {
  test('native ACP delivers exact ' + scenario + ' Markdown through a real terminal', { timeout: 120_000 }, async t => {
    const ctx = openTurn(t, scenario);
    const step = await ctx.handshake();
    assert.equal(step.event, 'submit');
    assert.equal(step.sessionId, SESSION);
    const draft = scenario === 'unchanged' ? '  私有原稿。\r\n' :
      ('  私有原稿 「雪🐕🏽」 e\u0301 \\ " \t\r\n').repeat(1200) + '末行  ';
    const material = { question: 'fixture-question: $() \u{1f3d4}\ufe0f', draft, rewrite_request: 'Keep the quotes and line endings.' };
    await submit(t, step.exec, ctx.env, material);

    const result = await ctx.event();
    const frames = ctx.requests();
    assert.deepEqual(frames.map(f => f.method), ['initialize', 'session/new', 'session/set_config_option', 'session/prompt']);
    assert.equal(frames[1].params.cwd, ctx.workspace);
    assert.equal(frames[2].params.value, model);
    assert.deepEqual(JSON.parse(frames[3].params.prompt[0].text), material);
    if (scenario === 'unchanged') {
      assert.deepEqual(result, { event: 'delivery', markdown: '**Gemini 返回了原稿** <!-- codex-polish -->\n\n' + draft });
    } else {
      const expected = '**Gemini 润色版**\n\n' + REPLY.join('') + '\n\n<details><summary>查看 GPT 原稿</summary>\n\n' + draft + '\n\n</details>';
      assert.equal(result.event, 'answer_pages');
      assert.equal(result.utf8_bytes, Buffer.byteLength(expected));
      const pages = [];
      let next = result.exec;
      while (next) {
        const page = JSON.parse(ctx.exec(next));
        assert.equal(page.event, 'answer_page');
        assert.ok(page.text.length);
        pages.push(page.text);
        next = page.next;
      }
      assert.ok(pages.length > 1);
      assert.equal(pages.join(''), expected);
    }
    assert.equal((await ctx.finished())[0], 0);
    await ctx.cleaned();
  });
}

for (const [scenario, reason] of [
  ['no-hydrogen', 'acp_model_unavailable'], ['truncated', 'acp_incomplete'], ['cancelled', 'acp_incomplete'],
]) {
  test('native ACP falls back after ' + scenario, { timeout: 75_000 }, async t => {
    const ctx = openTurn(t, scenario);
    const draft = '  私有原稿\r\n保留。  ';
    let result = await ctx.handshake();
    if (scenario !== 'no-hydrogen') {
      assert.equal(result.event, 'submit');
      await submit(t, result.exec, ctx.env, { question: 'fixture-question', draft });
      result = await ctx.event();
    }
    assert.deepEqual(result, { event: 'error', stage: scenario === 'no-hydrogen' ? 'session/new' : 'session/prompt', reason });
    assert.equal(ctx.requests().some(f => f.method === 'session/prompt'), scenario !== 'no-hydrogen');
    const rendered = run(process.execPath, [formatter, '--cwd', ctx.project, '--skipped', '--render'], {
      env: ctx.env, input: JSON.stringify({ draft, reason: result.reason }),
    });
    assert.equal(rendered, draft);
    await ctx.finished();
    await ctx.cleaned();
  });
}

test('interrupting the host reaps the stalled native provider and its workspace', { timeout: 75_000 }, async t => {
  const ctx = openTurn(t, 'stalled');
  const step = await ctx.handshake();
  assert.equal(step.event, 'submit');
  await submit(t, step.exec, ctx.env, { question: 'fixture-question', draft: '私有原稿' });
  await waitFor(() => ctx.requests().some(f => f.method === 'session/prompt'), 'the turn must be in progress');
  assert.ok(ctx.host.kill('SIGTERM'));
  await ctx.finished();
  await ctx.cleaned();
});

test('a Windows cancellation descriptor stops only the active ACP session', { skip: !windows, timeout: 75_000 }, async t => {
  const ctx = openTurn(t, 'stalled');
  const step = await ctx.handshake();
  await submit(t, step.exec, ctx.env, { question: 'fixture-question', draft: '私有原稿' });
  ctx.exec(step.cancel);
  assert.deepEqual(await ctx.event(), { event: 'error', stage: 'session/prompt', reason: 'acp_incomplete' });
  assert.deepEqual(ctx.requests().at(-1), { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION } });
  await ctx.finished();
  await ctx.cleaned();
});

test('the agent can stop a Windows host before submitting any draft', { skip: !windows, timeout: 75_000 }, async t => {
  const ctx = openTurn(t, 'stalled');
  const initialize = await ctx.event();
  assert.equal(initialize.event, 'send');
  ctx.exec(initialize.exec);
  const step = await ctx.handshake();
  assert.equal(step.event, 'submit');
  assert.deepEqual(step.stop, initialize.stop);
  const wrongKey = { ...step.stop, cmd: step.stop.cmd.replace(/\.[0-9a-f]{64}\b/, '.' + '0'.repeat(64)) };
  assert.notEqual(wrongKey.cmd, step.stop.cmd);
  const rejected = spawnSync(wrongKey.shell, shellArgs(wrongKey), { cwd: wrongKey.workdir, env: ctx.env, timeout: 10_000 });
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 1);
  assert.equal(ctx.host.exitCode, null);
  ctx.exec(step.stop);
  assert.equal((await ctx.finished())[0], 0);
  assert.deepEqual(ctx.requests().map(frame => frame.method), ['initialize', 'session/new', 'session/set_config_option']);
  await ctx.cleaned();
});

test('native catalog discovery returns the current model and never submits a prompt', { timeout: 45_000 }, async t => {
  const ctx = openTurn(t, 'ok', { catalog: true });
  const result = await ctx.handshake();
  assert.equal(result.event, 'catalog');
  assert.equal(result.current_model, 'gemini-3.8-flash');
  assert.ok(result.models.some(m => m.id === model));
  assert.deepEqual(ctx.requests().map(frame => frame.method), ['initialize', 'session/new']);
  await ctx.finished();
  await ctx.cleaned();
});

async function submitWithCodex(exec, fixtureEnv, material) {
  const codex = executable('codex');
  assert.ok(codex, 'install @openai/codex to exercise the actual Codex terminal');
  const project = fixtureEnv.HOME;
  fs.mkdirSync(fixtureEnv.CODEX_HOME, { recursive: true });
  const systemKeys = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PSMODULEPATH',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE',
    'OS', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'CODEX_HOME', 'XDG_CACHE_HOME']);
  const env = Object.fromEntries(Object.entries(fixtureEnv).filter(([key]) => systemKeys.has(key.toUpperCase())));
  const server = spawn(codex.command, [...codex.args, 'app-server', '--stdio'], { cwd: project, env });
  const closed = once(server, 'close');
  let diagnostic = '';
  server.stderr.setEncoding('utf8').on('data', data => { diagnostic += data; });
  const messages = createInterface({ input: server.stdout, crlfDelay: Infinity });
  const rpc = (id, method, params) => server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  const processId = 'acp-submit';
  const output = [];
  let sent = false;
  let writeAcknowledged = false;
  let exitCode;
  try {
    rpc(1, 'initialize', { clientInfo: { name: 'codex-polish-tests', version: '1' }, capabilities: { experimentalApi: true } });
    const incoming = messages[Symbol.asyncIterator]();
    let waiting = 'initialize';
    for (;;) {
      const item = await byDeadline(incoming.next(), () => 'Codex app-server timed out waiting for ' + waiting);
      if (item.done) break;
      const message = JSON.parse(item.value);
      assert.ok(!message.error, JSON.stringify(message.error));
      if (message.id === 1) {
        server.stdin.write('{"method":"initialized"}\n');
        waiting = 'input_ready on the ACP submit terminal';
        rpc(2, 'command/exec', { command: [exec.shell, ...shellArgs(exec)], cwd: exec.workdir, env, processId,
          tty: true, timeoutMs: 30_000, size: { rows: 40, cols: 160 }, sandboxPolicy: { type: 'dangerFullAccess' } });
      } else if (message.method === 'command/exec/outputDelta' && message.params.processId === processId) {
        assert.ok(!message.params.capReached);
        output.push(Buffer.from(message.params.deltaBase64, 'base64'));
        if (!sent && Buffer.concat(output).includes(Buffer.from('input_ready'))) {
          sent = true;
          waiting = 'command/exec/write acknowledgement or command exit';
          rpc(3, 'command/exec/write', { processId, deltaBase64: Buffer.from(JSON.stringify(material) + '\n').toString('base64') });
        }
      } else if (message.id === 3) { writeAcknowledged = true; waiting = 'command exit after material submission'; }
      else if (message.id === 2) exitCode = message.result.exitCode;
      if (exitCode !== undefined && (!sent || writeAcknowledged)) break;
    }
    assert.equal(exitCode, 0, diagnostic || Buffer.concat(output).toString());
    assert.ok(sent && writeAcknowledged, 'Codex must confirm the terminal write');
    assert.doesNotMatch(Buffer.concat(output).toString(), /fixture-question|私有原稿|draft"/);
  } finally {
    server.stdin.end();
    await closed;
  }
}

test('Codex app-server writes exact UTF-8 to the ACP submit terminal without echo', { timeout: 90_000 }, async t => {
  const ctx = openTurn(t, 'unchanged');
  const { exec } = await ctx.handshake();
  const material = { draft: '  私有原稿 "🐕🏽"\r\n', question: 'fixture-question 共享组合字 e\u0301 和\t雪。\r\n'.repeat(650) };
  await submitWithCodex(exec, ctx.env, material);
  assert.deepEqual(await ctx.event(), { event: 'delivery', markdown: '**Gemini 返回了原稿** <!-- codex-polish -->\n\n' + material.draft });
  const prompt = ctx.requests().find(frame => frame.method === 'session/prompt');
  assert.deepEqual(JSON.parse(prompt.params.prompt[0].text), material);
  await ctx.finished();
  await ctx.cleaned();
});
