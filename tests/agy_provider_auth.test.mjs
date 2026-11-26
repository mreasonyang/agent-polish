import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import test from 'node:test';
import { promisify } from 'node:util';
import { executable } from '../plugins/codex-polish/hooks/platform.mjs';
import { windows } from './hook_fixture.mjs';
import { isolatedHosts, shellQuote, until, write } from './host_fixture.mjs';

const runFile = promisify(execFile);
const nativeCodex = executable('codex');
const editor = new URL('../plugins/agy-polish/scripts/polish-reply.mjs', import.meta.url).href;
const token = 'fixture-provider-bearer';
const storedKey = 'unrelated-fixture-api-key';
const helperStderr = 'fixture-helper-stderr-canary';
const material = { question: 'Fixture private question?', draft: 'Fixture private draft.', trigger: 'explicit' };
const polished = 'Fixture edited reply.';

test('native Codex editor authenticates using a helper in the original profile environment', {
  skip: (windows || !nativeCodex) && 'requires a native Codex CLI and a POSIX fixture launcher',
  timeout: 25_000
}, async (t) => {
  const fixture = isolatedHosts(t, { codex: false });
  const helperCwd = join(fixture.profile, 'helper cwd');
  const helperRecord = join(fixture.base, 'helper record.json');
  const argvLog = join(fixture.base, 'Codex argv');
  const stderrLog = join(fixture.base, 'Codex stderr');
  const editorConfig = join(fixture.base, 'editor config snapshot');
  const editorHomes = join(fixture.base, 'editor homes');
  const unexpectedProgram = join(fixture.base, 'hook or MCP ran');
  const configKeys = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME'];
  const canaries = ['profile agents canary', 'home skill canary', 'model instructions canary', 'developer instructions canary'];

  fixture.env.USERPROFILE = join(fixture.base, 'separate USERPROFILE');
  fixture.env.XDG_STATE_HOME = join(fixture.base, 'separate XDG state');
  write(join(fixture.home, '.config', 'provider', 'token'), ' \t' + token + '\r\n');
  write(join(fixture.profile, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: storedKey }));
  write(join(fixture.profile, 'AGENTS.md'), canaries[0]);
  write(join(fixture.home, '.agents', 'skills', 'fixture', 'SKILL.md'),
    '---\nname: fixture\ndescription: ' + canaries[1] + '\n---\n');
  write(join(fixture.profile, 'private-instructions.txt'), canaries[2]);
  write(join(fixture.profile, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
    { type: 'command', command: '/usr/bin/touch ' + shellQuote(unexpectedProgram) }
  ] }] } }));

  const helper = join(helperCwd, 'bin', 'provider helper');
  write(helper, '#!/usr/bin/env node\n' + String.raw`
    const fs = require('node:fs');
    const { join } = require('node:path');
    const [scenario] = process.argv.slice(2);
    fs.writeFileSync(${JSON.stringify(helperRecord)}, JSON.stringify({
      argv: process.argv.slice(2), env: process.env, stdin: fs.readFileSync(0, 'utf8'),
      cwd: process.cwd(), pid: process.pid, startedAt: Date.now()
    }));
    process.stderr.write(${JSON.stringify(helperStderr)});
    if (scenario === 'timeout' || scenario === 'cancel') {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    } else if (scenario === 'empty') {
      process.stdout.write(' \t\r\n');
    } else if (scenario === 'bad-utf8') {
      process.stdout.write(Buffer.from([255]));
    } else if (scenario === 'bad-header') {
      process.stdout.write('bad\nheader');
    } else {
      process.stdout.write(fs.readFileSync(join(process.env.HOME, '.config', 'provider', 'token')));
      if (scenario === 'failed') process.exitCode = 7;
    }
  `);
  fs.chmodSync(helper, 0o755);

  const launcher = join(fixture.env.PATH, 'codex');
  const command = [nativeCodex.command, ...nativeCodex.args].map(shellQuote).join(' ');
  const sandbox = '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))' +
    ' (deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.secd"))';
  const guard = process.platform === 'darwin' ? '/usr/bin/sandbox-exec -p ' + shellQuote(sandbox) + ' ' : '';
  write(launcher, '#!/bin/sh\n' + String.raw`
printf '%s\000' "$@" >> ${shellQuote(argvLog)}
if [ "$1" = "exec" ]; then
  [ ! -e "$CODEX_HOME/auth.json" ] && [ ! -L "$CODEX_HOME/auth.json" ] || exit 10
  printf '%s\n%s\n' "$HOME" "$CODEX_HOME" > ${shellQuote(editorHomes)}
  /bin/cat "$CODEX_HOME/config.toml" > ${shellQuote(editorConfig)}
fi
exec ${guard}${command} "$@" 2>> ${shellQuote(stderrLog)}
`);
  fs.chmodSync(launcher, 0o755);

  const requests = [];
  const provider = createServer(async (request, response) => {
    const body = await text(request);
    if (request.method !== 'POST' || request.url !== '/fixture/responses') {
      response.writeHead(404).end('{}');
      return;
    }
    requests.push({ headers: request.headers, body });
    if (request.headers.authorization !== 'Bearer ' + token) {
      response.writeHead(401).end('{}');
      return;
    }
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify({ reply: polished, complete: true }), annotations: [] }] };
    const result = { id: 'resp_fixture', object: 'response', model: 'fixture-model', status: 'completed', output: [message],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    response.setHeader('content-type', 'text/event-stream');
    for (const [type, fields] of [
      ['response.created', { response: { ...result, status: 'in_progress', output: [] } }],
      ['response.output_item.done', { item: message, output_index: 0 }],
      ['response.completed', { response: result }]
    ]) {
      response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
    }
    response.end();
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  fixture.onCleanup(() => new Promise(resolve => {
    provider.close(resolve);
    provider.closeAllConnections();
  }));
  const local = 'http://127.0.0.1:' + provider.address().port;
  Object.assign(fixture.env, {
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost'
  });

  const driver = join(fixture.base, 'edit.mjs');
  write(driver, `
    import { existsSync } from 'node:fs';
    import { polishReply } from ${JSON.stringify(editor)};
    const controller = new AbortController();
    const cancellation = process.argv[2] === 'cancel' && setInterval(() => {
      if (existsSync(${JSON.stringify(helperRecord)})) controller.abort();
    }, 15);
    try {
      const result = await polishReply(${JSON.stringify(material)}, { signal: controller.signal, timeout: 5000 });
      console.log(JSON.stringify({ reply: result, finishedAt: Date.now() }));
    } finally {
      clearInterval(cancellation);
    }
  `);

  for (const scenario of ['success', 'empty', 'failed', 'bad-utf8', 'bad-header', 'cancel', 'timeout']) {
    await t.test(scenario, async () => {
      fs.rmSync(helperRecord, { force: true });
      fs.rmSync(argvLog, { force: true });
      fs.rmSync(stderrLog, { force: true });
      requests.length = 0;
      const args = [scenario, 'literal spaces & $HOME ; "quotes"'];
      write(join(fixture.profile, 'config.toml'), `
model = "fixture-model"
model_provider = "fixture"
model_reasoning_effort = "low"
developer_instructions = "${canaries[3]}"
model_instructions_file = "private-instructions.txt"
cli_auth_credentials_store = "file"
features.hooks = true
features.codex_hooks = true

[model_providers.fixture]
name = "Fixture"
base_url = "${local}/fixture"
http_headers = { "x-fixture-route" = "fixture-route" }
request_max_retries = 0
stream_max_retries = 0

[model_providers.fixture.auth]
command = "./bin/provider helper"
args = ${JSON.stringify(args)}
cwd = "helper cwd"
timeout_ms = ${scenario === 'timeout' ? 800 : 5000}

[mcp_servers.must-not-start]
command = "/usr/bin/touch"
args = ${JSON.stringify([unexpectedProgram])}
`);
      const result = await runFile(process.execPath, [driver, scenario], {
        cwd: fixture.workspace, env: fixture.env, timeout: 8000
      });
      const record = JSON.parse(fs.readFileSync(helperRecord, 'utf8'));
      const { reply, finishedAt } = JSON.parse(result.stdout);
      assert.deepEqual(record.argv, args);
      assert.equal(record.cwd, helperCwd);
      assert.equal(record.stdin, '');
      for (const key of configKeys) assert.equal(record.env[key], fixture.env[key], key);
      const cliArgs = fs.readFileSync(argvLog, 'utf8').split('\0');
      const diagnostics = fs.readFileSync(stderrLog, 'utf8') + result.stderr + JSON.stringify(record) + cliArgs.join('\n');
      for (const secret of [token, storedKey, helperStderr, material.question, material.draft]) {
        assert.ok(!diagnostics.includes(secret), 'diagnostics and helper inputs stay free of private material');
      }
      if (scenario === 'success') {
        assert.equal(reply, polished);
        assert.equal(requests.length, 1);
        const [{ headers, body }] = requests;
        assert.equal(headers.authorization, 'Bearer ' + token);
        assert.equal(headers['x-fixture-route'], 'fixture-route');
        assert.ok(body.includes(material.draft));
        for (const secret of [token, storedKey, ...canaries]) assert.ok(!body.includes(secret));
        assert.deepEqual(JSON.parse(body).tools ?? [], []);
        assert.ok(!fs.existsSync(unexpectedProgram));
        const homes = fs.readFileSync(editorHomes, 'utf8').trim().split('\n');
        assert.ok(homes.every(home => home !== fixture.home && home !== fixture.profile));
        const config = fs.readFileSync(editorConfig, 'utf8');
        assert.match(config, /CODEX_POLISH_PROVIDER_BEARER_/);
        assert.ok(!config.includes('provider helper') && !config.includes(token) && !config.includes(storedKey));
      } else {
        assert.equal(reply, material.draft);
        assert.equal(requests.length, 0);
        assert.ok(!cliArgs.includes('exec'), 'failed authentication must precede launching the editor');
      }
      if (scenario === 'cancel' || scenario === 'timeout') {
        assert.ok(finishedAt - record.startedAt < 3500, 'helper did not stop before the editor deadline');
        await until(() => {
          try { process.kill(record.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') return true; throw error; }
        }, 'cancelled credential helper process did not exit');
      }
    });
  }
});
