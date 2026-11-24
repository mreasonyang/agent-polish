import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { fileLoginExists } from '../plugins/agy-polish/scripts/codex-process.mjs';
import { supportsFileSymlink, windows } from './hook_fixture.mjs';
import { isolatedHosts, root, until, withSettings, write } from './host_fixture.mjs';

const installer = join('scripts', 'install.mjs');
const forwardMode = join('codex-polish', 'settings', 'codex-polish.mode');
const readSettings = 'console.log(JSON.stringify(await settings.readSettings()));';
const writeSettings = 'await settings.writeSettings(JSON.parse(process.argv[1]));';
const envKey = 'POLISH_TEST_PROVIDER_TOKEN';
const fakeToken = 'test-token-not-for-output';
const syntheticConfig = (provider = {}) => ({
  model_provider: 'synthetic',
  model_providers: { synthetic: { base_url: 'http://127.0.0.1:1/v1', wire_api: 'responses', ...provider } }
});
const signedOut = { requiresOpenaiAuth: true, account: null };
const noOpenaiAccount = { requiresOpenaiAuth: false, account: null };
// The fake Antigravity CLI is a POSIX executable. The argument parser runs on every platform.
const hostTest = (name, fn) => test(name, { skip: windows && 'requires POSIX fake agy executable' }, fn);

test('setup and the editor treat a dangling auth.json link as a missing login', {
  skip: !supportsFileSymlink() && 'file symlinks unavailable'
}, t => {
  const fixture = isolatedHosts(t, { codex: false });
  const target = join(fixture.home, 'login.json');
  const login = join(fixture.profile, 'auth.json');
  fs.symlinkSync(target, login, 'file');
  assert.equal(fileLoginExists(fixture.profile), false);
  write(target, '{}');
  assert.equal(fileLoginExists(fixture.profile), true);
  fs.rmSync(target);
  assert.equal(fileLoginExists(fixture.profile), false);
});

function install(fixture, args, release = root) {
  const result = fixture.run(process.execPath, [join(release, installer), ...args]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function installedReverse(fixture) {
  return join(fixture.home, '.gemini', 'config', 'plugins', 'agy-polish');
}

function installedForward(fixture) {
  return join(fixture.profile, 'fake-cache', '.codex-plugin', 'plugin.json');
}

test('an invalid or omitted --host value is rejected before invoking a host', t => {
  const fixture = isolatedHosts(t, { agy: true });
  for (const args of [['setup', '--host', 'unknown'], ['setup', '--host']]) {
    const result = fixture.run(process.execPath, [join(root, installer), ...args]);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /--host/);
  }
  assert.deepEqual(fixture.records(), []);
  assert.equal(fs.existsSync(installedForward(fixture)), false);
  assert.equal(fs.existsSync(installedReverse(fixture)), false);
});

hostTest('noninteractive setup still defaults to Codex even with both host CLIs present', t => {
  const fixture = isolatedHosts(t, { agy: true });
  write(join(fixture.profile, forwardMode), 'off\n');
  install(fixture, []);
  assert.ok(fs.existsSync(installedForward(fixture)));
  assert.equal(fs.existsSync(installedReverse(fixture)), false);
  assert.equal(fs.existsSync(fixture.reverseSettings), false);
  assert.ok(!fixture.records().some(row => row.host === 'agy' && row.args[0] === 'plugin'));
});

hostTest('each host can update and uninstall without replacing the other plugin or touching its settings', t => {
  const fixture = isolatedHosts(t, { agy: true });
  const release = join(fixture.base, '提取目录');
  for (const entry of ['scripts', 'plugins', '.agents', 'package.json']) {
    fs.cpSync(join(root, entry), join(release, entry), { recursive: true });
  }
  const run = (action, host) => install(fixture, [action, '--host', host], release);
  const forward = join(fixture.profile, forwardMode);
  const reverse = installedReverse(fixture);
  const agySettings = { mode: 'manual', model: 'fixture-model', effort: 'xhigh' };
  write(forward, 'off\n');
  withSettings(fixture, writeSettings, [JSON.stringify(agySettings)]);

  run('setup', 'both');
  assert.ok(fs.existsSync(installedForward(fixture)));
  const config = fs.readFileSync(join(reverse, 'mcp_config.json'));
  const otherPlugin = join(reverse, '..', 'unrelated', 'plugin.json');
  const otherManifest = '{"name":"unrelated","version":"1.0.0"}\n';
  write(otherPlugin, otherManifest);
  const reverseUpdate = join(release, 'plugins', 'agy-polish', 'fixture.txt');
  write(reverseUpdate, 'release changed\n');

  const report = run('doctor', 'both');
  assert.match(report, /Antigravity polishing mode: Manual/i);
  assert.match(report, /Polishing is off|mode[^\n]*\boff\b/i);
  const agyConfig = join(fixture.home, '.gemini', 'config', 'config.json');
  write(agyConfig, JSON.stringify({ plugins: { 'agy-polish': { enabled: false } } }));
  const beforeAgy = fixture.records().length;
  run('update', 'agy');
  assert.equal(fs.readFileSync(join(reverse, 'fixture.txt'), 'utf8'), 'release changed\n');
  assert.equal(fs.readFileSync(forward, 'utf8'), 'off\n');
  assert.ok(fs.existsSync(installedForward(fixture)));
  assert.deepEqual(withSettings(fixture, readSettings), agySettings);
  assert.equal(JSON.parse(fs.readFileSync(agyConfig, 'utf8')).plugins['agy-polish'].enabled, false);
  assert.ok(!fixture.records().slice(beforeAgy).some(row => row.host === 'codex' && row.args[0] === 'plugin'));

  const beforeCodex = fixture.records().length;
  run('update', 'codex');
  run('uninstall', 'codex');
  assert.equal(fs.existsSync(installedForward(fixture)), false);
  assert.deepEqual(fs.readFileSync(join(reverse, 'mcp_config.json')), config);
  assert.deepEqual(withSettings(fixture, readSettings), agySettings);
  assert.ok(!fixture.records().slice(beforeCodex).some(row => row.host === 'agy' && row.args[0] === 'plugin'));

  run('setup', 'codex');
  write(forward, 'manual\n');
  run('uninstall', 'agy');
  assert.equal(fs.existsSync(reverse), false);
  assert.ok(fs.existsSync(installedForward(fixture)));
  assert.equal(fs.readFileSync(forward, 'utf8'), 'manual\n');
  assert.equal(fs.readFileSync(otherPlugin, 'utf8'), otherManifest);

  run('setup', 'agy');
  run('update', 'both');
  run('uninstall', 'both');
  assert.equal(fs.existsSync(reverse), false);
  assert.equal(fs.existsSync(installedForward(fixture)), false);
  assert.ok(fs.existsSync(otherPlugin));
});

hostTest('reverse doctor checks the selected provider and reports only local authentication state', async t => {
  const cases = [
    { name: 'ChatGPT sign-in', expected: /Codex CLI is signed in/, status: 0 },
    { name: 'official API key sign-in', accountResponse: { requiresOpenaiAuth: true, account: { type: 'apiKey' } },
      expected: /Codex CLI is signed in/, status: 0 },
    { name: 'Codex exec API key without stored login', accountResponse: signedOut, envName: 'CODEX_API_KEY', envValue: fakeToken,
      expected: /API key environment variable is set/, status: 0 },
    { name: 'OpenAI key without a stored file login', accountResponse: signedOut, envName: 'OPENAI_API_KEY', envValue: fakeToken,
      expected: /API key environment variable is set/, status: 0 },
    { name: 'forced ChatGPT still requires login', accountResponse: signedOut, config: { forced_login_method: 'chatgpt' },
      envName: 'CODEX_API_KEY', envValue: fakeToken, expected: /Run codex login/, status: 1 },
    { name: 'OpenAI sign-in required', config: syntheticConfig({ requires_openai_auth: true }), accountResponse: signedOut,
      expected: /Run codex login/, status: 1 },
    { name: 'OpenAI sign-in present for the selected provider', config: syntheticConfig({ requires_openai_auth: true }),
      loginStatus: 1, expected: /Codex CLI is signed in/, status: 0 },
    { name: 'local provider without an account', config: syntheticConfig(), accountResponse: noOpenaiAccount, loginStatus: 1,
      expected: /does not require OpenAI sign-in/, status: 0 },
    { name: 'provider key is set', config: syntheticConfig({ env_key: envKey }), accountResponse: noOpenaiAccount,
      loginStatus: 1, envValue: fakeToken, expected: /authentication environment variable is set/, status: 0 },
    { name: 'provider key is missing despite a global sign-in', config: syntheticConfig({ env_key: envKey }),
      accountResponse: noOpenaiAccount, expected: new RegExp(envKey), status: 1 },
    { name: 'provider key is blank', config: syntheticConfig({ env_key: envKey }),
      accountResponse: noOpenaiAccount, envValue: '  ', expected: new RegExp(envKey), status: 1 },
    { name: 'provider auth command', config: syntheticConfig({ auth: { command: 'fixture-auth', args: [fakeToken] } }),
      accountResponse: noOpenaiAccount, loginStatus: 1, expected: /could not confirm this authentication method/, status: 1 },
    { name: 'unsupported provider wire API', config: syntheticConfig({ wire_api: 'unsupported' }),
      accountResponse: noOpenaiAccount, expected: /Could not confirm authentication/, status: 1 },
    { name: 'provider config is unavailable', configError: fakeToken, expected: /Could not confirm authentication/, status: 1 }
  ];
  for (const { name, expected, status, envName = envKey, envValue, ...provider } of cases) {
    await t.test(name, t => {
      const fixture = isolatedHosts(t, { agy: true });
      if (envValue !== undefined) fixture.env[envName] = envValue;
      fixture.env.POLISH_TEST_CODEX_PROVIDER = JSON.stringify(provider);
      const setup = install(fixture, ['setup', '--host', 'agy']);
      const report = fixture.run(process.execPath, [join(root, installer), 'doctor', '--host', 'agy']);
      assert.equal(report.status, status, report.stderr || report.stdout);
      assert.match(report.stdout, expected);
      if (status !== 0) assert.match(setup, expected);
      if (provider.accountResponse !== signedOut) assert.doesNotMatch(setup + report.stdout, /codex login|After signing in to Codex/i);
      assert.ok(!(setup + report.stdout + report.stderr + JSON.stringify(fixture.records())).includes(fakeToken));
      assert.ok(!fixture.records().some(row => row.host === 'codex' && (row.args.includes('exec') ||
        row.method && !['initialize', 'initialized', 'config/read', 'account/read'].includes(row.method))));
    });
  }
});

hostTest('reverse doctor with polishing off skips the Codex CLI', t => {
  const fixture = isolatedHosts(t, { agy: true });
  withSettings(fixture, writeSettings, [JSON.stringify({ mode: 'off' })]);
  install(fixture, ['setup', '--host', 'agy']);
  const report = install(fixture, ['doctor', '--host', 'agy']);
  assert.match(report, /Antigravity polishing mode: Off/);
  assert.ok(!fixture.records().some(row => row.host === 'codex'));
});

const python = '/usr/bin/python3';

function terminal(fixture, cmd, args) {
  const driver = `import os, pty, sys
def read_master(fd):
    data = os.read(fd, 4096)
    if not data:
        raise OSError('PTY closed')
    return data
sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:], master_read=read_master)))`;
  const child = spawn(python, ['-c', driver, cmd, ...args], {
    cwd: fixture.workspace, env: { ...fixture.env, TERM: 'xterm', PATH: [fixture.env.PATH, '/usr/bin', '/bin'].join(delimiter) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { output += chunk; });
  }
  let result;
  const ended = new Promise(resolve => {
    child.on('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).then(value => { result = value; });
  child.stdin.on('error', () => {});
  fixture.onCleanup(async () => {
    child.stdin.destroy();
    child.kill('SIGKILL');
    await ended;
  });
  const display = () => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  return {
    display,
    write: keys => child.stdin.write(keys),
    waitFor: (pattern, since = 0) => until(() => {
      if (pattern.test(display().slice(since))) return true;
      assert.ok(!result, `Installer exited before displaying ${pattern}:\n${display()}`);
    }, display),
    async finish() {
      await until(() => result, display);
      assert.ifError(result.error);
      assert.equal(result.code, 0, display());
    }
  };
}

test('interactive terminal and Finder ask for direction first and reverse Off exits before model or Decisions', {
  skip: (windows || !fs.existsSync(python)) && 'requires POSIX Python 3 for a pseudo-terminal'
}, async t => {
  for (const [name, command, args] of [
    ['terminal', process.execPath, [join(root, installer), 'setup']],
    ['Finder', join(root, 'Install Codex Polish.command'), []]
  ]) {
    await t.test(name, async t => {
      const fixture = isolatedHosts(t, { agy: true });
      const forward = join(fixture.profile, forwardMode);
      write(forward, 'manual\n');
      withSettings(fixture, writeSettings, [JSON.stringify({ mode: 'manual', model: 'fixture-model', effort: 'xhigh' })]);
      const session = terminal(fixture, command, args);
      await session.waitFor(/Configure both/i);
      assert.match(session.display(), /In Codex[^\n]*Gemini/i);
      assert.match(session.display(), /In Antigravity[^\n]*Codex/i);
      assert.doesNotMatch(session.display(), /\b(?:Turbo|Decisions)\b/i);
      assert.deepEqual(fixture.records(), []);
      assert.equal(fs.existsSync(installedForward(fixture)), false);
      assert.equal(fs.existsSync(installedReverse(fixture)), false);
      const start = session.display().length;
      session.write('\x1b[B\r');
      await session.waitFor(/Turbo[\s\S]*\bOff\b/i, start);
      session.write('\x1b[B\r');
      if (name === 'Finder') {
        await session.waitFor(/Press Enter to close the installer/i);
        session.write('\r');
      }
      await session.finish();
      assert.ok(fs.existsSync(installedReverse(fixture)), session.display());
      assert.equal(fs.existsSync(installedForward(fixture)), false);
      assert.equal(fs.readFileSync(forward, 'utf8'), 'manual\n');
      assert.deepEqual(withSettings(fixture, readSettings), { mode: 'off', model: 'fixture-model', effort: 'xhigh' });
      assert.doesNotMatch(session.display(), /\bDecisions\b|API key|(?:choose|select) (?:a |the )?model/i);
      assert.ok(!fixture.records().some(row => row.host === 'codex'), 'reverse Off must exit before checking Codex sign-in or models');
    });
  }
});

test('interactive reverse setup selects a model and effort without asking for Decisions', {
  skip: (windows || !fs.existsSync(python)) && 'requires POSIX Python 3 for a pseudo-terminal'
}, async t => {
  for (const [name, provider, lookup] of [
    ['ChatGPT account', {}, /from my account/i],
    ['local provider', {
      config: syntheticConfig({ model_catalog_url: 'http://127.0.0.1:1/v1/models' }),
      accountResponse: noOpenaiAccount, loginStatus: 1
    }, /from the Codex model list/i],
    ['provider with external authentication', {
      config: syntheticConfig({ auth: { command: 'test-credential-helper' }, model_catalog_url: 'http://127.0.0.1:1/v1/models' }),
      accountResponse: noOpenaiAccount, loginStatus: 1
    }, /from the Codex model list/i]
  ]) {
    await t.test(name, async t => {
      const fixture = isolatedHosts(t, { agy: true });
      fixture.env.POLISH_TEST_CODEX_PROVIDER = JSON.stringify(provider);
      const forward = join(fixture.profile, forwardMode);
      write(forward, 'manual\n');
      const session = terminal(fixture, process.execPath, [join(root, installer), 'setup', '--host', 'agy']);
      await session.waitFor(/Turbo[\s\S]*\bOff\b/i);
      session.write('\x1b[B\r');
      await session.waitFor(lookup);
      session.write('\x1b[B\x1b[B\r');
      await session.waitFor(/模型 Café[\s\S]*Other model/);
      session.write('\r');
      await session.waitFor(/Codex reasoning effort[\s\S]*(?:Extra High|xhigh)/i);
      session.write('\x1b[B\r');
      await session.finish();
      assert.ok(fs.existsSync(installedReverse(fixture)));
      assert.equal(fs.existsSync(installedForward(fixture)), false);
      assert.equal(fs.readFileSync(forward, 'utf8'), 'manual\n');
      assert.deepEqual(withSettings(fixture, readSettings), { mode: 'turbo', model: 'fixture-model', effort: 'xhigh' });
      assert.doesNotMatch(session.display(), /\bDecisions\b|API key|codex login/i);
      const pages = fixture.records().filter(row => row.method === 'model/list');
      assert.equal(pages.length, 2);
      if (provider.config) assert.ok(pages.every(row => row.params.modelProvider === 'synthetic'));
    });
  }
});
