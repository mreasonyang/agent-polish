import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { fileLoginExists } from '../plugins/agy-polish/scripts/codex-process.mjs';
import { supportsFileSymlink, windows } from './hook_fixture.mjs';
import { isolatedHosts, root, until, withSettings, write } from './host_fixture.mjs';

const installer = join('scripts', 'install.mjs');
const reverseInstaller = join('scripts', 'agy-cli.mjs');
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

function install(fixture, args, release = root, entry = installer) {
  const result = fixture.run(process.execPath, [join(release, entry), ...args]);
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

hostTest('legacy delegation and setup guidance use the host package release channel', async t => {
  for (const [channel, codexVersion, agyVersion] of [
    ['beta', '0.0.4-beta.3', '0.0.4-beta.2'],
    ['latest', '0.0.5', '0.0.4']
  ]) {
    await t.test(channel, t => {
      const fixture = isolatedHosts(t, { agy: true });
      const forwardRelease = join(fixture.base, 'codex archive');
      const reverseRelease = join(fixture.base, 'agy archive');
      for (const [release, name, version, manifest] of [
        [forwardRelease, 'codex-polish', codexVersion, '.codex-plugin/plugin.json'],
        [reverseRelease, 'agy-polish', agyVersion, 'plugin.json']
      ]) {
        const folder = join('plugins', name);
        for (const entry of ['scripts', folder]) {
          fs.cpSync(join(root, entry), join(release, entry), {
            recursive: true,
            filter: file => release !== forwardRelease || file !== join(root, reverseInstaller)
          });
        }
        const pluginManifest = join(release, folder, manifest);
        write(pluginManifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(pluginManifest)), version }));
        write(join(release, 'package.json'), JSON.stringify(channel === 'beta'
          ? { name: 'agent-polish', private: true, version: '2.0.0' }
          : { name: '@kyun.si/' + name, version }));
      }
      const npx = join(fixture.env.PATH, 'npx');
      fixture.env.POLISH_TEST_NPX_ARGS = join(fixture.base, 'npm args');
      write(npx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$POLISH_TEST_NPX_ARGS"\nexit 1\n');
      fs.chmodSync(npx, 0o755);
      const forward = (...args) => fixture.run(process.execPath, [join(forwardRelease, installer), ...args]);
      const reverse = (...args) => fixture.run(process.execPath, [join(reverseRelease, reverseInstaller), ...args]);
      const codexSpec = `@kyun.si/codex-polish@${channel}`;
      const agySpec = `@kyun.si/agy-polish@${channel}`;

      const delegated = forward('doctor', '--host', 'agy');
      assert.equal(delegated.status, 1);
      assert.ok(delegated.stderr.includes(`npx ${agySpec} doctor`));
      assert.equal(fs.readFileSync(fixture.env.POLISH_TEST_NPX_ARGS, 'utf8'), `--yes\n${agySpec}\ndoctor\n`);
      assert.deepEqual(fixture.records(), []);
      const doctor = reverse('doctor');
      assert.equal(doctor.status, 1);
      assert.ok(doctor.stdout.includes(`npx ${agySpec} setup`));
      fs.renameSync(join(fixture.env.PATH, 'agy'), join(fixture.env.PATH, 'agy-unavailable'));
      const missing = reverse('setup');
      assert.equal(missing.status, 1);
      assert.ok(missing.stderr.includes(`npx ${agySpec} setup --install-agy`));
      assert.ok(forward('doctor').stdout.includes(`npx ${codexSpec} setup --install-agy`));
      assert.ok(forward('openai').stderr.includes(`npx ${codexSpec} openai`));
    });
  }
});

hostTest('standalone Antigravity setup honors an active legacy dependency installation lock', t => {
  const fixture = isolatedHosts(t, { agy: true });
  const lock = join(fixture.home, '.local', 'bin', '.codex-polish-agy.sqlite');
  write(lock, '');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(lock);
  try {
    db.exec('BEGIN EXCLUSIVE');
    const busy = fixture.run(process.execPath, [join(root, reverseInstaller), 'setup', '--install-agy']);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /Another installer is running/);
    assert.deepEqual(fixture.records(), []);
    assert.equal(fs.statSync(lock).size, 0);
  } finally {
    db.close();
  }
  install(fixture, ['setup', '--install-agy'], root, reverseInstaller);
  assert.ok(fs.existsSync(installedReverse(fixture)));
  assert.ok(!fs.existsSync(lock));
});

hostTest('each host can update and uninstall without replacing the other plugin or touching its settings', t => {
  const fixture = isolatedHosts(t, { agy: true });
  const release = join(fixture.base, '提取目录');
  for (const entry of ['scripts', 'plugins', '.agents', 'package.json']) {
    fs.cpSync(join(root, entry), join(release, entry), { recursive: true });
  }
  const run = (action, host) => host === 'both'
    ? install(fixture, [action, '--host', 'both'], release)
    : install(fixture, [action], release, host === 'agy' ? reverseInstaller : installer);
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
      const setup = install(fixture, ['setup'], root, reverseInstaller);
      const report = fixture.run(process.execPath, [join(root, reverseInstaller), 'doctor']);
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
  const report = install(fixture, ['doctor'], root, reverseInstaller);
  assert.match(report, /Antigravity polishing mode: Off/);
  assert.ok(!fixture.records().some(row => row.host === 'codex'));
});

hostTest('updating an older Antigravity installation without a saved mode uses Manual', t => {
  const fixture = isolatedHosts(t, { agy: true });
  const legacy = join(fixture.base, 'legacy agy-polish');
  write(join(legacy, 'plugin.json'), JSON.stringify({ name: 'agy-polish', version: '0.0.4-beta.5' }));
  const registration = fixture.run(join(fixture.env.PATH, 'agy'), ['plugin', 'install', legacy]);
  assert.equal(registration.status, 0, registration.stderr || registration.stdout);
  assert.ok(!fs.existsSync(fixture.reverseSettings));

  const before = install(fixture, ['doctor'], root, reverseInstaller);
  assert.match(before, /Antigravity polishing mode: Normal/);
  assert.match(before, /Codex model: Codex default/);
  install(fixture, ['update'], root, reverseInstaller);
  const after = install(fixture, ['doctor'], root, reverseInstaller);
  assert.match(after, /Antigravity polishing mode: Manual · polish only when asked/);
  assert.match(after, /Codex model: gpt-6\.2-sol · Extra High/);
  assert.ok(!fs.existsSync(fixture.reverseSettings));
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

test('first terminal and Finder setups preselect Manual in their own host', {
  skip: (windows || !fs.existsSync(python)) && 'requires POSIX Python 3 for a pseudo-terminal'
}, async t => {
  for (const [name, command, args, reverse] of [
    ['Codex terminal', process.execPath, [join(root, installer), 'setup'], false],
    ['Finder', join(root, 'Install Codex Polish.command'), [], false],
    ['Antigravity terminal', process.execPath, [join(root, reverseInstaller), 'setup'], true]
  ]) {
    await t.test(name, async t => {
      const fixture = isolatedHosts(t, { agy: true });
      const session = terminal(fixture, command, args);
      await session.waitFor(reverse ? /Off · turn off polishing/ : /Turn off polishing/);
      assert.match(session.display(), reverse ? /provider configured in Codex/ : /question and Codex draft to Google Gemini/);
      assert.match(session.display(), /○ Normal[\s\S]*○ Turbo[\s\S]*❯ ● Manual · polish only when asked[\s\S]*○ (?:Off · turn off polishing|Turn off polishing)/);
      assert.doesNotMatch(session.display(), /Choose a host|Configure both/i);
      assert.deepEqual(fixture.records(), []);
      assert.equal(fs.existsSync(installedForward(fixture)), false);
      assert.equal(fs.existsSync(installedReverse(fixture)), false);

      session.write('\r');
      if (reverse) {
        await session.waitFor(/❯ ● gpt-6\.2-sol · Extra High \(default\)/);
        session.write('\r');
      } else {
        await session.waitFor(/Ask Codex to list models available to my account/);
        session.write('\r');
        await session.waitFor(/Extra High/);
        session.write('\x1b[B\r');
      }
      if (name === 'Finder') {
        await session.waitFor(/Press Enter to close the installer/);
        session.write('\r');
      }
      await session.finish();
      assert.equal(fs.existsSync(installedForward(fixture)), !reverse, session.display());
      assert.equal(fs.existsSync(installedReverse(fixture)), reverse, session.display());
      if (reverse) {
        assert.deepEqual(withSettings(fixture, readSettings), { mode: 'manual', model: 'gpt-6.2-sol', effort: 'xhigh' });
        assert.match(session.display(), /polish_reply[\s\S]*\/polish-settings/);
        assert.doesNotMatch(session.display(), /Decisions|API key|Choose the Gemini model/i);
      } else {
        const settings = join(fixture.profile, 'codex-polish', 'settings');
        assert.equal(fs.readFileSync(join(settings, 'codex-polish.model'), 'utf8'), 'gemini-4-hydrogen high\n');
        assert.match(install(fixture, ['doctor']), /When to polish: only when asked/);
        assert.doesNotMatch(session.display(), /OpenAI Decisions API/);
      }
      assert.ok(!fixture.records().some(row => row.host === (reverse ? 'codex' : 'agy') && row.args[0] === 'plugin'));
      assert.ok(!fixture.records().some(row => row.method === 'model/list'));
    });
  }
});

test('Antigravity setup remembers an explicit choice to follow local Codex configuration', {
  skip: (windows || !fs.existsSync(python)) && 'requires POSIX Python 3 for a pseudo-terminal'
}, async t => {
  const fixture = isolatedHosts(t, { agy: true });
  const setup = (...args) => terminal(fixture, process.execPath, [join(root, reverseInstaller), ...args]);
  const session = setup('setup', '--advanced');
  await session.waitFor(/Off · turn off polishing/);
  session.write('\r');
  await session.waitFor(/○ Follow local Codex configuration/);
  session.write('\x1b[B\r');
  await session.finish();
  const settingsPath = join(fixture.reverseSettings, 'settings.json');
  const saved = fs.readFileSync(settingsPath, 'utf8');
  assert.deepEqual(JSON.parse(saved), { mode: 'manual', model: 'codex-default', effort: 'codex-default' });
  assert.deepEqual(withSettings(fixture, readSettings), { mode: 'manual', model: null, effort: null });

  const rerun = setup();
  await rerun.waitFor(/Off · turn off polishing/);
  rerun.write('\r');
  await rerun.waitFor(/❯ ● Follow local Codex configuration/);
  rerun.write('\r');
  await rerun.finish();
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), saved);

  const reset = setup();
  await reset.waitFor(/Off · turn off polishing/);
  reset.write('\r');
  await reset.waitFor(/❯ ● Follow local Codex configuration/);
  reset.write('\x1b[A\r');
  await reset.finish();
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { mode: 'manual', model: null, effort: null });
  assert.deepEqual(withSettings(fixture, readSettings), { mode: 'manual', model: 'gpt-6.2-sol', effort: 'xhigh' });
  withSettings(fixture, writeSettings, [JSON.stringify({ model: 'fixture-model' })]);
  assert.deepEqual(withSettings(fixture, readSettings), { mode: 'manual', model: 'fixture-model', effort: null });
  assert.ok(!fixture.records().some(row => row.method === 'model/list'));
});

test('pressing Enter on ordinary setup keeps legacy settings and a disabled plugin', {
  skip: (windows || !fs.existsSync(python)) && 'requires POSIX Python 3 for a pseudo-terminal'
}, async t => {
  for (const mode of ['off', 'normal', 'turbo']) {
    await t.test(mode, async t => {
      const fixture = isolatedHosts(t, { agy: true });
      const profileSettings = join(fixture.profile, 'codex-polish', 'settings');
      const key = join(fixture.profile, 'codex-polish', 'credentials', 'openai.key');
      const forwardSettings = new Map([
        [join(fixture.profile, forwardMode), mode === 'off' ? 'off\n' : 'auto\n'],
        [join(profileSettings, 'codex-polish.rewrite-mode'), (mode === 'normal' ? 'normal' : 'turbo') + '\n'],
        [join(profileSettings, 'codex-polish.model'), 'gemini-4-test high\n'],
        [key, 'synthetic-key-for-preservation-test\n']
      ]);
      for (const [file, value] of forwardSettings) write(file, value);
      fs.chmodSync(key, 0o600);
      const agySettings = { mode, model: 'fixture-model', effort: 'xhigh' };
      withSettings(fixture, writeSettings, [JSON.stringify(agySettings)]);
      install(fixture, ['setup', '--host', 'both']);
      const forwardConfig = join(fixture.profile, 'fake-registration.json');
      const reverseConfig = join(fixture.home, '.gemini', 'config', 'config.json');
      const registration = JSON.parse(fs.readFileSync(forwardConfig, 'utf8'));
      registration.plugin.enabled = false;
      write(forwardConfig, JSON.stringify(registration));
      write(reverseConfig, JSON.stringify({ plugins: { 'agy-polish': { enabled: false } } }));
      for (const entry of [installer, reverseInstaller]) {
        const calls = fixture.records().length;
        const session = terminal(fixture, process.execPath, [join(root, entry), 'setup']);
        const modeLabel = mode === 'off' && entry === installer ? 'Turn off polishing' : mode;
        const keep = new RegExp('❯ ● ' + modeLabel + '[^\\r\\n]* \\(current\\)', 'i');
        await session.waitFor(keep);
        session.write('\r');
        if (mode !== 'off') {
          await session.waitFor(entry === reverseInstaller ? /❯ ● Keep current settings · fixture-model · Extra High/ :
            /❯ ● Keep gemini-4-test · High/);
          session.write('\r');
        }
        await session.finish();
        assert.match(session.display(), /still disabled/i);
        assert.doesNotMatch(session.display(), /codex login|MCP approval/i);
        if (mode === 'off') assert.doesNotMatch(session.display(), /Choose the Gemini model|Choose the Codex model/i);
        const setupCalls = fixture.records().slice(calls);
        assert.ok(!setupCalls.some(row => row.method === 'model/list'));
        if (mode === 'off' || entry === installer) assert.ok(!setupCalls.some(row => row.method === 'account/read'));
      }
      assert.equal(JSON.parse(fs.readFileSync(forwardConfig)).plugin.enabled, false);
      assert.equal(JSON.parse(fs.readFileSync(reverseConfig)).plugins['agy-polish'].enabled, false);
      for (const [file, value] of forwardSettings) assert.equal(fs.readFileSync(file, 'utf8'), value);
      assert.deepEqual(withSettings(fixture, readSettings), agySettings);
    });
  }
});

test('cancelling the legacy combined setup after Codex reports that Antigravity was cancelled', {
  skip: (windows || !fs.existsSync(python)) && 'requires POSIX Python 3 for a pseudo-terminal'
}, async t => {
  const fixture = isolatedHosts(t, { agy: true });
  const combined = terminal(fixture, process.execPath, [join(root, installer), 'setup', '--host', 'both']);
  await combined.waitFor(/❯ ● Manual · polish only when asked[\s\S]*Turn off polishing/);
  combined.write('\x1b[B\r');
  await combined.waitFor(/How should Antigravity replies be polished/);
  combined.write('\x1b');
  await combined.finish();
  assert.match(combined.display(), /Codex setup is complete\. Antigravity setup was cancelled\./);
  assert.ok(fs.existsSync(installedForward(fixture)));
  assert.equal(fs.existsSync(installedReverse(fixture)), false);
  assert.equal(fs.existsSync(fixture.reverseSettings), false);
  assert.ok(!fixture.records().some(row => row.host === 'agy' && row.args[0] === 'plugin'));

  const standalone = terminal(fixture, process.execPath, [join(root, reverseInstaller), 'setup']);
  await standalone.waitFor(/Off · turn off polishing/);
  standalone.write('\x1b');
  await standalone.finish();
  assert.doesNotMatch(standalone.display(), /setup was cancelled/);
  assert.equal(fs.existsSync(installedReverse(fixture)), false);
  assert.equal(fs.existsSync(fixture.reverseSettings), false);
});

test('default Antigravity setup selects a model and effort', {
  skip: (windows || !fs.existsSync(python)) && 'requires POSIX Python 3 for a pseudo-terminal'
}, async t => {
  for (const [name, provider, lookup, modelChoice] of [
    ['ChatGPT account', { catalogDefaultModel: 'gpt-6.2-sol' }, /from my account/i],
    ['local provider', {
      config: syntheticConfig({ model_catalog_url: 'http://127.0.0.1:1/v1/models' }),
      accountResponse: noOpenaiAccount, loginStatus: 1
    }, /from the Codex model list/i],
    ['provider with external authentication', {
      config: syntheticConfig({ auth: { command: 'test-credential-helper' }, model_catalog_url: 'http://127.0.0.1:1/v1/models' }),
      accountResponse: noOpenaiAccount, loginStatus: 1
    }, /from the Codex model list/i, 'fixture-other']
  ]) {
    await t.test(name, async t => {
      const fixture = isolatedHosts(t, { agy: true });
      fixture.env.POLISH_TEST_CODEX_PROVIDER = JSON.stringify(provider);
      const forward = join(fixture.profile, forwardMode);
      write(forward, 'manual\n');
      const session = terminal(fixture, process.execPath, [join(root, reverseInstaller)]);
      await session.waitFor(/❯ ● Manual · polish only when asked[\s\S]*\bOff\b/);
      session.write('\x1b[A\r');
      await session.waitFor(lookup);
      session.write('\x1b[B\x1b[B\r');
      await session.waitFor(/❯ ● 模型 Café \((?:account|Codex) default\)[\s\S]*Other model/);
      const model = modelChoice ?? provider.catalogDefaultModel ?? 'fixture-model';
      session.write(model === 'fixture-other' ? '\x1b[B\r' : '\r');
      const initialEffort = {
        'gpt-6.2-sol': /❯ ● Extra High/,
        'fixture-model': /❯ ● Low \(model default\)[\s\S]*Extra High/,
        'fixture-other': /❯ ● Medium \(model default\)/
      };
      await session.waitFor(initialEffort[model]);
      session.write(model === 'fixture-model' ? '\x1b[B\r' : '\r');
      await session.finish();
      assert.ok(fs.existsSync(installedReverse(fixture)));
      assert.equal(fs.existsSync(installedForward(fixture)), false);
      assert.equal(fs.readFileSync(forward, 'utf8'), 'manual\n');
      assert.deepEqual(withSettings(fixture, readSettings), {
        mode: 'turbo', model, effort: model === 'fixture-other' ? 'medium' : 'xhigh'
      });
      assert.doesNotMatch(session.display(), /\bDecisions\b|API key|codex login/i);
      const pages = fixture.records().filter(row => row.method === 'model/list');
      assert.equal(pages.length, 2);
      if (provider.config) assert.ok(pages.every(row => row.params.modelProvider === 'synthetic'));

      if (model === 'gpt-6.2-sol') {
        withSettings(fixture, writeSettings, [JSON.stringify({ effort: 'low' })]);
        const rerun = terminal(fixture, process.execPath, [join(root, reverseInstaller)]);
        await rerun.waitFor(/Turbo[\s\S]*\bOff\b/i);
        rerun.write('\r');
        await rerun.waitFor(/❯ ● Keep current settings · gpt-6\.2-sol · Low[\s\S]*from my account/);
        rerun.write('\x1b[B\r');
        await rerun.waitFor(/❯ ● 模型 Café \(account default\)[\s\S]*Other model/);
        rerun.write('\r');
        await rerun.waitFor(/❯ ● Low \(model default\)[\s\S]*Extra High/);
        rerun.write('\r');
        await rerun.finish();
        assert.deepEqual(withSettings(fixture, readSettings), { mode: 'turbo', model, effort: 'low' });
      }
    });
  }
});
