// Exercise the host process API against an offline ACP fixture. This test driver is not shipped.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { executable } from '../plugins/codex-polish/hooks/platform.mjs';

const fixtureUrl = new URL('./fixture_acp.mjs', import.meta.url).href;

test('Codex owns the provider stdin and stdout across model selection and a long UTF-8 turn', { timeout: 35_000 }, async t => {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'polish native '));
  const profile = join(dir, 'profile');
  fs.mkdirSync(profile);
  const allowed = /^(path|systemroot|comspec|pathext|windir|temp|tmp|localappdata|programfiles.*|psmodulepath)$/i;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => allowed.test(k))),
    HOME: dir, USERPROFILE: dir, CODEX_HOME: profile };
  const codex = executable('codex');
  assert.ok(codex, 'requires the Codex CLI');
  const server = spawn(codex.command, [...codex.args, 'app-server', '--stdio'], { cwd: dir, env });
  const closed = once(server, 'close');
  const timer = setTimeout(() => server.kill(), 28_000);
  t.after(async () => {
    clearTimeout(timer);
    server.stdin.end();
    if (server.exitCode === null) server.kill();
    await closed;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const rpc = (id, method, params) => server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  const processId = 'fixture';
  const ttyReady = 'fixture_ready';
  const draft = '中文 &\t𠮷\r\n'.repeat(2500);
  const providerScript = `import { Fixture, SESSION, serveFixture } from ${JSON.stringify(fixtureUrl)};
    const fixture = new Fixture('unchanged');
    process.stderr.write('fixture_ready\\n');
    await serveFixture(fixture, frame => {
      if (frame.id === 4) fixture.update(SESSION, 'available_commands_update', {
        availableCommands: [{ name: 'example', description: 'x'.repeat(1024 * 1024 + 1) }]
      });
    });`;
  rpc(1, 'initialize', { clientInfo: { name: 'codex-polish-test', version: '1' }, capabilities: { experimentalApi: true } });
  let stage = 'starting', sessionId, text = '', writeId = 20, promptCount = 0, commandListSeen = false;
  const stdout = new TextDecoder();
  let carry = '', stderr = '';
  function send(id, method, params) {
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    rpc(writeId++, 'command/exec/write', { processId, deltaBase64: Buffer.from(frame).toString('base64') });
  }
  function handle(frame) {
    assert.ok(!frame.error, JSON.stringify(frame.error));
    if (frame.method === 'session/update' && frame.params.update.sessionUpdate === 'available_commands_update') {
      assert.equal(frame.params.sessionId, sessionId);
      assert.ok(frame.params.update.availableCommands[0].description.length > 1024 * 1024);
      commandListSeen = true;
    } else if (frame.id === 1) {
      assert.equal(frame.result.protocolVersion, 1);
      send(3, 'session/new', { cwd: dir, mcpServers: [] });
    } else if (frame.id === 3) {
      sessionId = frame.result.sessionId;
      send(4, 'session/set_config_option', { sessionId, configId: 'model', value: 'gemini-4-hydrogen' });
    } else if (frame.id === 4) {
      assert.equal(commandListSeen, true);
      assert.equal(frame.result.configOptions.find(o => o.id === 'model').currentValue, 'gemini-4-hydrogen');
      send(5, 'session/set_config_option', { sessionId, configId: 'thought_level', value: 'medium' });
    } else if (frame.id === 5) {
      assert.equal(frame.result.configOptions.find(o => o.id === 'thought_level').currentValue, 'medium');
      promptCount++;
      send(6, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: JSON.stringify({ draft }) }] });
    } else if (frame.method === 'session/update' && frame.params.sessionId === sessionId &&
        frame.params.update.sessionUpdate === 'agent_message_chunk') {
      text += frame.params.update.content.text;
    } else if (frame.id === 6) {
      assert.equal(frame.result.stopReason, 'end_turn');
      assert.equal(text, draft);
      stage = 'complete';
      rpc(writeId++, 'command/exec/write', { processId, closeStdin: true });
    }
  }
  for await (const row of createInterface({ input: server.stdout, crlfDelay: Infinity })) {
    const message = JSON.parse(row);
    assert.ok(!message.error, JSON.stringify(message.error));
    if (message.id === 1) {
      server.stdin.write('{"method":"initialized"}\n');
      rpc(2, 'command/exec', { command: [process.execPath, '--input-type=module', '-e', providerScript],
        cwd: dir, processId, tty: false, streamStdin: true, streamStdoutStderr: true, disableOutputCap: true, timeoutMs: 20_000,
        sandboxPolicy: { type: 'dangerFullAccess' } });
    } else if (message.method === 'command/exec/outputDelta') {
      assert.equal(message.params.processId, processId);
      assert.equal(message.params.capReached, false);
      const bytes = Buffer.from(message.params.deltaBase64, 'base64');
      if (message.params.stream === 'stderr') {
        stderr += bytes.toString('utf8');
        if (stage === 'starting' && stderr.includes(ttyReady)) {
          stage = 'session';
          send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
        }
      } else {
        const lines = (carry + stdout.decode(bytes, { stream: true })).split('\n');
        carry = lines.pop();
        for (const line of lines) handle(JSON.parse(line));
      }
    } else if (message.id === 2) {
      assert.equal(message.result.exitCode, 0, stderr);
      break;
    }
  }
  assert.equal(stage, 'complete', stderr);
  assert.equal(promptCount, 1);
  assert.equal(carry + stdout.decode(), '');
});
