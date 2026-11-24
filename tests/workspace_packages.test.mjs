import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { executable } from '../plugins/codex-polish/hooks/platform.mjs';
import { root, shellQuote, write } from './host_fixture.mjs';
import { homeEnv, temporary, windows } from './hook_fixture.mjs';

const forward = 'codex-polish';
const reverse = 'agy-polish';
const names = [forward, reverse];
const scope = name => '@kyun.si/' + name;
const market = 'codex-polish-local';
const oldVersion = '0.0.4-beta.1';
const manifest = { [forward]: '.codex-plugin/plugin.json', [reverse]: 'plugin.json' };
const entry = { [forward]: 'scripts/install.mjs', [reverse]: 'scripts/agy-cli.mjs' };
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));

const npm = windows
  ? { command: process.execPath, args: [process.env.npm_execpath ||
      join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] }
  : { command: 'npm', args: [] };
const nativeCodex = executable('codex');
const nativeAgy = executable('agy');

function inspect(result, status = 0) {
  assert.ifError(result.error);
  assert.equal(result.status, status, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

function sandbox(base) {
  const home = join(base, 'Isolated Home');
  const profile = join(home, 'Codex Profile');
  const agyProfile = join(home, '.gemini', 'config');
  const agySettings = join(agyProfile, reverse, 'settings.json');
  const npmLogs = join(base, 'npm-logs');
  const tools = join(base, 'bin');
  const path = (process.env.PATH || '').split(delimiter).filter(directory => directory &&
    !['', '.cmd', '.exe'].some(suffix => fs.existsSync(join(directory, reverse + suffix))));
  for (const directory of [profile, tools, npmLogs]) fs.mkdirSync(directory, { recursive: true });
  const env = {
    ...homeEnv(home),
    PATH: [tools, ...path].join(delimiter), CODEX_HOME: profile,
    CODEX_API_KEY: 'offline-qa-placeholder', LC_ALL: 'en_US.UTF-8',
    XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
    TMPDIR: base, TEMP: base, TMP: base,
    npm_config_cache: join(base, 'npm-cache'), npm_config_logs_dir: npmLogs,
    npm_config_userconfig: join(base, 'user.npmrc'), npm_config_globalconfig: join(base, 'global.npmrc'),
    npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:1/',
    npm_config_audit: 'false', npm_config_fund: 'false'
  };
  if (!nativeAgy && !windows) {
    const fake = join(tools, 'agy');
    const fixture = join(root, 'tests', 'fixture_host_cli.mjs');
    write(fake, '#!/bin/sh\nexec ' + [process.execPath, fixture, 'agy'].map(shellQuote).join(' ') + ' "$@"\n');
    fs.chmodSync(fake, 0o755);
    env.POLISH_TEST_CLI_LOG = join(base, 'host-calls.jsonl');
  }
  function run(command, args, options = {}) {
    return spawnSync(command, args, {
      cwd: base, env, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...options
    });
  }
  const npmRun = (args, options) => inspect(run(npm.command, [...npm.args, ...args], options));
  const binPath = prefix => join(prefix, 'node_modules', '.bin');
  function cli(prefix, name, args, { status = 0, dependencies = [], extraEnv, input, allowNpm = false } = {}) {
    const bin = join(binPath(prefix), name);
    const childEnv = { ...env, PATH: [binPath(prefix), ...dependencies.map(binPath), env.PATH].join(delimiter), ...extraEnv };
    const logs = fs.readdirSync(npmLogs);
    const options = { env: childEnv, input };
    // Invoke the generated npm shim, including the .cmd shim on Windows.
    const result = windows
      ? run(env.ComSpec, ['/d', '/s', '/c', `""${bin}.cmd" ${args.join(' ')}"`], { ...options, windowsVerbatimArguments: true })
      : run(bin, args, options);
    inspect(result, status);
    if (!allowNpm) assert.deepEqual(fs.readdirSync(npmLogs), logs, `${name} ${args.join(' ')} started npm`);
    return result.stdout + result.stderr;
  }
  const install = (archive, prefix) => {
    npmRun(['install', '--ignore-scripts', '--no-save', '--no-package-lock', '--prefix', prefix, archive]);
    return prefix;
  };
  const codexRows = () => JSON.parse(inspect(run(nativeCodex.command,
    [...nativeCodex.args, 'plugin', 'list', '--marketplace', market, '--json']))).installed;
  const agy = nativeAgy || { command: join(tools, 'agy'), args: [] };
  const agyRun = (...args) => inspect(run(agy.command, [...agy.args, 'plugin', ...args]));
  const agyRows = () => JSON.parse(agyRun('list', '--json')).filter(row => row.name === reverse);
  return { base, profile, agyProfile, agySettings, npmLogs, npmRun, cli, run, install, codexRows, agyRun, agyRows };
}

const packageRoot = (prefix, name) => join(prefix, 'node_modules', scope(name));
const pluginRoot = (prefix, name) => join(packageRoot(prefix, name), 'plugins', name);

test('workspace tarballs install offline with independent npm entry points', async t => {
  const base = temporary(t);
  const project = join(base, 'source');
  const archives = join(base, 'archives');
  fs.mkdirSync(archives);
  const packer = sandbox(join(base, 'pack'));

  // prepack stages files inside each workspace. Copy its inputs so packaging
  // never writes to the checkout, even when another test packs concurrently.
  for (const path of ['.agents', 'packages', 'plugins', 'scripts', 'package.json']) {
    fs.cpSync(join(root, path), join(project, path), { recursive: true, filter: source => {
      const sourcePath = relative(root, source).replaceAll('\\', '/');
      return !/^packages\/[^/]+\/(?:node_modules|plugins|scripts|\.agents|\.npm-pack-[^/]*)(?:\/|$)/.test(sourcePath);
    } });
  }
  assert.equal(json(join(project, 'package.json')).name, 'agent-polish');
  assert.equal(json(join(project, 'package.json')).private, true);
  const packs = JSON.parse(packer.npmRun([
    'pack', ...names.flatMap(name => ['--workspace', scope(name)]), '--silent', '--json', '--pack-destination', archives
  ], { cwd: project }));
  assert.deepEqual(packs.map(pack => pack.name).sort(), names.map(scope).sort());
  const archive = Object.fromEntries(packs.map(pack => [pack.name, join(archives, pack.filename)]));
  const version = Object.fromEntries(packs.map(pack => [pack.name, pack.version]));

  // Simulate a terminal on the real npm entry point so both menus can be
  // exercised with piped keys on Windows as well as POSIX.
  const tty = join(base, 'terminal.mjs');
  write(tty, `process.stdin.isTTY = process.stdout.isTTY = true;
process.stdin.setRawMode = value => { process.stdin.isRaw = value; };
`);
  const keys = input => ({ input, extraEnv: { NODE_OPTIONS: '--import=' + pathToFileURL(tty).href } });

  await t.test('each archive has one plugin and one npm bin, and setup starts at mode selection', () => {
    const box = sandbox(join(base, 'bins'));
    for (const [name, other, host] of [[reverse, forward, 'Antigravity'], [forward, reverse, 'Codex']]) {
      const pack = packs.find(row => row.name === scope(name));
      const files = pack.files.map(file => file.path);
      assert.ok(files.includes(`plugins/${name}/${manifest[name]}`));
      assert.ok(files.includes(entry[name]));
      assert.ok(!files.some(file => file.startsWith(`plugins/${other}/`) || file === entry[other]), files.join('\n'));
      const prefix = box.install(archive[scope(name)], join(box.base, name));
      assert.deepEqual(json(join(packageRoot(prefix, name), 'package.json')).bin, { [name]: entry[name] });
      assert.match(box.cli(prefix, name, ['--help']), new RegExp(`Usage: ${name}\\b`));
      const firstMenu = box.cli(prefix, name, ['setup'], keys('\x03'));
      assert.match(firstMenu, new RegExp(`^How should ${host} replies be polished\\?$`, 'm'));
      assert.match(firstMenu, /Automatic polishing \(Normal\)/);
      assert.doesNotMatch(firstMenu, /Where do you|Configure both|Both hosts/i);
      if (name === reverse) box.cli(prefix, name, ['setup', '--host', 'codex'], { status: 2 });
    }
  });

  await t.test('Codex runs alone offline and diagnoses legacy argument and missing-package errors', {
    skip: !nativeCodex && 'requires native Codex CLI'
  }, () => {
    const box = sandbox(join(base, 'codex-only'));
    const prefix = box.install(archive[scope(forward)], join(box.base, 'consumer'));
    for (const args of [['setup', '--host'], ['setup', '--host', 'invalid'], ['openai', '--host', 'agy']])
      box.cli(prefix, forward, args, { status: 2 });
    box.cli(prefix, forward, ['setup']);
    assert.equal(box.codexRows()[0].version, version[scope(forward)]);
    assert.match(box.cli(prefix, forward, ['doctor', '--host', 'codex']), /Node\.js/);
    box.cli(prefix, forward, ['update']);
    const missing = box.cli(prefix, forward, ['doctor', '--host', 'agy'], { status: 1, allowNpm: true });
    assert.match(missing, /agy-polish/);
    const channel = version[scope(forward)].includes('-') ? 'beta' : 'latest';
    const requested = `${scope(reverse)}@${channel}`;
    assert.ok(fs.readdirSync(box.npmLogs).some(file => read(join(box.npmLogs, file)).includes(`"${requested}"`)),
      `Expected legacy fallback to request ${requested}`);
    assert.equal(box.codexRows()[0].version, version[scope(forward)]);
    assert.ok(!fs.existsSync(box.agyProfile));
    box.cli(prefix, forward, ['uninstall']);
    assert.deepEqual(box.codexRows(), []);
  });

  // Windows requires agy.exe for host registration. POSIX can also use the
  // existing CLI fixture when Google's executable is not installed.
  const needsAgy = windows && !nativeAgy && 'requires native Antigravity CLI on Windows';
  await t.test('Antigravity runs alone offline without creating Codex registration', { skip: needsAgy }, () => {
    const box = sandbox(join(base, 'agy-only'));
    const prefix = box.install(archive[scope(reverse)], join(box.base, 'consumer'));
    write(box.agySettings, JSON.stringify({ mode: 'off', model: 'saved-model', effort: 'high' }));
    const before = read(box.agySettings);
    box.cli(prefix, reverse, ['setup']);
    assert.equal(box.agyRows()[0].version, version[scope(reverse)]);
    assert.match(box.cli(prefix, reverse, ['doctor']), /Antigravity polishing mode: Off/);
    box.cli(prefix, reverse, ['update']);
    box.cli(prefix, reverse, ['uninstall']);
    assert.deepEqual(box.agyRows(), []);
    assert.equal(read(box.agySettings), before);
    assert.deepEqual(fs.readdirSync(box.profile), []);
  });

  await t.test('upgrades and reruns preserve existing settings and legacy routes keep host boundaries', {
    skip: needsAgy || (!nativeCodex && 'requires native Codex CLI')
  }, () => {
    const box = sandbox(join(base, 'upgrade'));
    const codex = box.install(archive[scope(forward)], join(box.base, 'forward'));
    const agy = box.install(archive[scope(reverse)], join(box.base, 'reverse'));
    const runForward = (...args) => box.cli(codex, forward, args);
    const runReverse = (...args) => box.cli(agy, reverse, args);
    if (process.env.AGENT_POLISH_LEGACY_TARBALL) {
      const legacy = box.install(process.env.AGENT_POLISH_LEGACY_TARBALL, join(box.base, 'legacy'));
      box.cli(legacy, forward, ['setup', '--host', 'both']);
    } else {
      // Shallow CI checkouts lack the release tag. Register old-version
      // plugins through the native CLIs, then restore untouched tarball bytes.
      for (const [name, prefix] of [[forward, codex], [reverse, agy]]) {
        const file = join(pluginRoot(prefix, name), manifest[name]);
        const original = read(file);
        write(file, JSON.stringify({ ...JSON.parse(original), version: oldVersion }));
        box.cli(prefix, name, ['setup']);
        write(file, original);
      }
    }
    const codexEntry = box.codexRows()[0];
    const agyEntry = box.agyRows()[0];
    assert.equal(codexEntry.version, oldVersion);
    assert.equal(agyEntry.version, oldVersion);
    const preferences = join(box.profile, 'plugins', 'cache', market, forward, oldVersion, 'hooks/preferences.mjs');
    const setCodex = (...args) => inspect(box.run(process.execPath, [preferences, ...args]));
    setCodex('set-mode', 'off');
    setCodex('set-rewrite-mode', 'turbo');
    setCodex('set-model', 'gemini-2.5-pro', '--thinking-level', 'high');
    const setAgy = (...args) => inspect(box.run(process.execPath, [join(agyEntry.path, 'scripts/settings.mjs'), 'set', ...args]));
    setAgy('--mode', 'turbo', '--model', 'fixture-model', '--effort', 'high');
    box.agyRun('disable', reverse);

    const codexSettings = () => ['mode', 'rewrite-mode', 'model'].map(name =>
      read(join(box.profile, forward, 'settings', `${forward}.${name}`)));
    const beforeCodex = codexSettings();
    const beforeAgy = read(box.agySettings);
    runForward('update');
    assert.match(box.cli(codex, forward, ['setup'], keys('\r')), /● Keep current setting \(Off\)/);
    assert.deepEqual(codexSettings(), beforeCodex);
    assert.deepEqual(box.agyRows(), [{ ...agyEntry, enabled: false }]);
    assert.equal(read(box.agySettings), beforeAgy);

    const updatedCodex = box.codexRows();
    assert.equal(updatedCodex[0].version, version[scope(forward)]);
    runReverse('update');
    assert.match(box.cli(agy, reverse, ['setup'], keys('\r')), /● Keep current setting \(Turbo\)/);
    assert.equal(box.agyRows()[0].version, version[scope(reverse)]);
    assert.equal(box.agyRows()[0].enabled, false);
    assert.equal(read(box.agySettings), beforeAgy);
    assert.deepEqual(box.codexRows(), updatedCodex);
    assert.deepEqual(codexSettings(), beforeCodex);

    box.agyRun('enable', reverse);
    const compatibility = (action, host, status = 0) =>
      box.cli(codex, forward, [action, '--host', host], { dependencies: [agy], status });
    const reverseReport = compatibility('doctor', 'agy');
    assert.match(reverseReport, /Antigravity polishing mode: Turbo/);
    assert.match(reverseReport, /Codex model: fixture-model/);
    assert.doesNotMatch(reverseReport, /Node\.js/);
    setAgy('--mode', 'off');
    runReverse('setup');
    assert.deepEqual(json(box.agySettings), { mode: 'off', model: 'fixture-model', effort: 'high' });
    const bothReport = compatibility('doctor', 'both');
    assert.match(bothReport, /Node\.js/);
    assert.match(bothReport, /Antigravity polishing mode: Off/);

    const reverseSettings = read(box.agySettings);
    const updatedAgy = box.agyRows();
    runForward('uninstall');
    assert.deepEqual(box.codexRows(), []);
    assert.equal(read(box.agySettings), reverseSettings);
    assert.deepEqual(box.agyRows(), updatedAgy);
    runForward('setup');
    const reinstalledCodex = box.codexRows();
    compatibility('uninstall', 'agy');
    assert.deepEqual(box.agyRows(), []);
    assert.equal(read(box.agySettings), reverseSettings);
    assert.deepEqual(box.codexRows(), reinstalledCodex);
    assert.match(compatibility('doctor', 'both', 1), /Node\.js/);
  });
});
