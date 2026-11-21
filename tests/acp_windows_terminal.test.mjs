// Exercise the UTF-8 and line-discipline behavior of the agent's documented command.
// This fixture is built locally on Windows, and never calls Antigravity.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { executable, windows, windowsSystemTool } from '../plugins/codex-polish/hooks/platform.mjs';
import { dispose, prepareWorkspace, readOutput } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_workspace.mjs';

const fixture = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Fixture {
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern bool ReadConsoleW(IntPtr handle, [Out] char[] buffer, uint length, out uint read, IntPtr control);

    public static int Main(string[] args) {
        if (string.Join(" ", args) != "acp --agent codex-polish-editor --sandbox") return 1;
        IntPtr handle = GetStdHandle(-10);
        uint mode, count;
        if (!GetConsoleMode(handle, out mode) || (mode & 6) != 0) return 2;
        var line = new StringBuilder();
        var input = new char[1024];
        while (true) {
            if (!ReadConsoleW(handle, input, (uint)input.Length, out count, IntPtr.Zero) || count == 0) return 3;
            for (int i = 0; i < count; i++) {
                if (input[i] == '\\n') {
                    byte[] result = new UTF8Encoding(false).GetBytes("{\\"received\\":" + line.ToString() + "}\\n");
                    using (var output = Console.OpenStandardOutput()) output.Write(result, 0, result.Length);
                    return 0;
                }
                if (input[i] == '\\r') return 4;
                line.Append(input[i]);
            }
        }
    }
}
`;
const guide = new URL('../plugins/codex-polish/skills/codex-polish/references/acp-windows.md', import.meta.url);
const shellCommand = fs.readFileSync(guide, 'utf8').match(/^```powershell\n([\s\S]+?)\n```$/m)[1];

test('Windows Codex terminal sends a long Unicode frame to the native provider and reads its exact redirected reply',
  { skip: !windows, timeout: 65_000 }, async t => {
    const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'polish terminal '));
    const profile = join(dir, 'profile');
    const bin = join(dir, 'native 中文 %TEMP% & !');
    fs.mkdirSync(profile);
    fs.mkdirSync(bin);
    const provider = join(bin, 'agy.exe');
    const source = join(bin, 'fixture.cs');
    fs.writeFileSync(source, fixture);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    const powershell = windowsSystemTool('WindowsPowerShell/v1.0/powershell.exe');
    const compiled = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -Path $env:POLISH_TEST_SOURCE -OutputAssembly $env:POLISH_TEST_EXE -OutputType ConsoleApplication -ErrorAction Stop'], {
      env: { ...process.env, POLISH_TEST_SOURCE: source, POLISH_TEST_EXE: provider }, encoding: 'utf8',
    });
    assert.equal(compiled.status, 0, compiled.stderr);

    const { workspace, output_file, cleanup_token } = prepareWorkspace({ catalog: true });
    t.after(() => dispose(workspace, cleanup_token));
    assert.deepEqual(readOutput(workspace, cleanup_token, 0), { text: '', next_offset: 0 });
    const codex = executable('codex');
    assert.ok(codex, 'requires the Codex CLI');
    const allowed = /^(path|systemroot|comspec|pathext|windir|temp|tmp|localappdata|appdata|programfiles.*|psmodulepath)$/i;
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))),
      HOME: dir, USERPROFILE: dir, CODEX_HOME: profile };
    const server = spawn(codex.command, [...codex.args, 'app-server', '--stdio'], { cwd: dir, env });
    const closed = once(server, 'close');
    const hardStop = setTimeout(() => server.kill(), 50_000);
    t.after(async () => {
      clearTimeout(hardStop);
      server.stdin.end();
      if (server.exitCode === null) server.kill();
      await closed;
    });
    server.stderr.resume();
    const rpc = (id, method, params) => server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    const processId = 'windows-terminal';
    const command = shellCommand.replace('AGY_PATH_UTF8_BASE64', Buffer.from(provider).toString('base64'));
    const frame = { id: 1, jsonrpc: '2.0', method: 'example', params: { text: '私密测试𠮷☀️ & "\r\n'.repeat(3200) } };
    let screen = '';
    let sent = false;
    let done = false;
    rpc(1, 'initialize', { clientInfo: { name: 'terminal-test', version: '1' }, capabilities: { experimentalApi: true } });
    for await (const row of createInterface({ input: server.stdout, crlfDelay: Infinity })) {
      const message = JSON.parse(row);
      assert.ok(!message.error, JSON.stringify(message.error));
      if (message.id === 1) {
        server.stdin.write('{"method":"initialized"}\n');
        rpc(2, 'command/exec', { command: [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64')], cwd: workspace, processId, tty: true, timeoutMs: 40_000,
          sandboxPolicy: { type: 'dangerFullAccess' } });
      } else if (message.method === 'command/exec/outputDelta' && message.params.processId === processId) {
        assert.equal(message.params.capReached, false);
        screen += Buffer.from(message.params.deltaBase64, 'base64').toString('utf8');
        if (!sent && screen.includes('acp_console_ready')) {
          sent = true;
          const characters = Array.from(JSON.stringify(frame) + '\n');
          let id = 3;
          for (let i = 0; i < characters.length; i += 1500) {
            const slice = characters.slice(i, i + 1500).join('');
            rpc(id++, 'command/exec/write', { processId, deltaBase64: Buffer.from(slice).toString('base64') });
            // Let the terminal consume input between writes, as it would on separate tool calls.
            await delay(5);
          }
        }
      } else if (message.id === 2) {
        assert.equal(message.result.exitCode, 0, screen);
        done = true;
        break;
      }
    }
    assert.ok(sent && done, screen);
    assert.doesNotMatch(screen, /私密测试|jsonrpc/);
    let text = '';
    let offset = 0;
    do {
      const page = readOutput(workspace, cleanup_token, offset);
      if (page.next_offset === offset) break;
      text += page.text;
      offset = page.next_offset;
    } while (true);
    assert.deepEqual(JSON.parse(text), { received: frame });
    assert.equal(offset, fs.statSync(output_file).size);
    fs.linkSync(output_file, join(workspace, 'new-link'));
    assert.throws(() => readOutput(workspace, cleanup_token, 0));
    fs.unlinkSync(join(workspace, 'new-link'));
    dispose(workspace, cleanup_token);
    assert.equal(fs.existsSync(workspace), false);
  });
