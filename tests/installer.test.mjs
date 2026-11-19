import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ROOT,
  NAME,
  MARKET,
  PLUGIN_ID,
  INDEX,
  GUIDE,
  PRODUCT,
  SetupError,
  manage,
  pendingUpdate,
  compareVersions,
  bundleVersion,
  withLock
} from '../scripts/install.mjs';
import { preserve } from '../scripts/native_cache.mjs';

function temp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codex-polish-installer-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(path, content) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, content);
}
function fixture(t) {
  const base = temp(t),
    store = join(base, 'managed'),
    source = join(base, 'my release'),
    cache = join(base, 'native cache');
  const product = join(source, PRODUCT),
    manifest = join(product, '.codex-plugin/plugin.json');
  const setVersion = (version) => write(manifest, JSON.stringify({ name: NAME, version }));
  write(join(source, INDEX), fs.readFileSync(join(ROOT, INDEX)));
  write(join(product, 'signature'), 'original');
  write(join(source, GUIDE), 'instructions');
  setVersion('1.0.0');
  const state = { source: null, version: null, enabled: true, commands: [], fail: null, bad: 0 };
  function run(...args) {
    const command = args.join(' ');
    state.commands.push(command);
    if (command === state.fail) {
      state.fail = null;
      throw new SetupError('simulated host failure');
    }
    if (command === 'marketplace list')
      return {
        marketplaces: state.source
          ? [{ name: MARKET, marketplaceSource: { sourceType: 'local', source: state.source } }]
          : []
      };
    if (command === 'list --marketplace ' + MARKET)
      return {
        installed: state.version ? [{ pluginId: PLUGIN_ID, version: state.version, enabled: state.enabled }] : []
      };
    if (args[0] === 'marketplace' && args[1] === 'add') {
      assert.equal(state.source, null);
      state.source = args[2];
      return {};
    }
    if (command === 'marketplace remove ' + MARKET) {
      state.source = null;
      return {};
    }
    if (command === 'remove ' + PLUGIN_ID) {
      fs.rmSync(cache, { recursive: true, force: true });
      state.version = null;
      return {};
    }
    assert.equal(command, 'add ' + PLUGIN_ID);
    state.version = bundleVersion(state.source);
    state.enabled = true;
    fs.rmSync(cache, { recursive: true, force: true });
    fs.cpSync(join(state.source, PRODUCT), cache, { recursive: true });
    if (state.bad > 0) {
      state.bad--;
      fs.writeFileSync(join(cache, 'signature'), 'corrupt cache');
    }
    return { pluginId: PLUGIN_ID, version: state.version, installedPath: cache };
  }
  const call = (action) =>
    manage(action, source, store, run, (value) => {
      state.enabled = value;
    });
  return { base, store, source, cache, product, manifest, state, run, call, setVersion };
}
test('persistent snapshots survive extracted folder removal, update changed bytes and retain edits on reinstall', async (t) => {
  const { source, store, product, state, cache, call } = fixture(t);
  write(join(source, 'tests/example'), 'test');
  const [message] = await call('setup');
  const first = state.source;
  assert.ok(message.includes(first));
  assert.equal(dirname(first), store);
  assert.ok(!fs.existsSync(join(first, 'tests')));
  await call('setup');
  assert.equal(state.commands.filter((command) => command.startsWith('marketplace add')).length, 1);
  write(join(product, 'signature'), 'another release');
  await call('update');
  assert.notEqual(first, state.source);
  assert.equal(fs.readFileSync(join(cache, 'signature'), 'utf8'), 'another release');
  const changed = state.source;
  write(join(changed, PRODUCT, 'signature'), 'my notes');
  await call('uninstall');
  await call('setup');
  const [retained] = fs.readdirSync(store).filter((n) => n.startsWith('retained-'));
  assert.equal(fs.readFileSync(join(store, retained, basename(changed), PRODUCT, 'signature'), 'utf8'), 'my notes');
  fs.rmSync(source, { recursive: true });
  assert.equal(fs.readFileSync(join(state.source, PRODUCT, 'signature'), 'utf8'), 'another release');
});
test('failed installation, update and corrupt rollback can recover while preserving disabled state', async (t) => {
  const { store, call, state, product, cache, setVersion } = fixture(t);
  state.fail = 'add ' + PLUGIN_ID;
  await assert.rejects(call('setup'), SetupError);
  assert.equal(state.source, null);
  assert.equal(state.version, null);
  await call('setup');
  const first = state.source;
  state.enabled = false;
  write(join(product, 'signature'), 'updated');
  setVersion('1.1.0');
  state.bad = 1;
  await assert.rejects(call('update'), SetupError);
  assert.equal(state.source, first);
  assert.equal(state.version, '1.0.0');
  assert.equal(state.enabled, false);
  assert.equal(fs.readFileSync(join(cache, 'signature'), 'utf8'), 'original');
  assert.equal(pendingUpdate(store), null);
  state.bad = 2;
  await assert.rejects(call('update'), SetupError);
  assert.equal(pendingUpdate(store).enabled, false);
  await call('update');
  const [, onboard] = await call('setup');
  assert.equal(state.enabled, false);
  assert.equal(onboard, false);
  assert.equal(state.version, '1.1.0');
  assert.equal(pendingUpdate(store), null);
  assert.equal(fs.readFileSync(join(cache, 'signature'), 'utf8'), 'updated');
});
test('updates reject an older package before changing files or native state', async (t) => {
  const order = [
    '0.0.1-alpha',
    '0.0.1-alpha.1',
    '0.0.1-alpha.beta',
    '0.0.1-beta',
    '0.0.1-beta.2',
    '0.0.1-beta.11',
    '0.0.1-rc.1',
    '0.0.1',
    '0.0.2',
    '0.0.10',
    '0.1.0',
    '1.0.0'
  ];
  assert.deepEqual([...order].reverse().sort(compareVersions), order);
  for (const v of order) assert.equal(compareVersions(v, v + '+build.22'), 0);
  const { call, state, setVersion, store } = fixture(t);
  await call('setup');
  state.enabled = false;
  const first = state.source,
    entries = fs.readdirSync(store);
  setVersion('0.0.1');
  for (const action of ['setup', 'update']) {
    state.commands = [];
    await assert.rejects(call(action), /1.0.0/);
    assert.equal(state.source, first);
    assert.equal(state.enabled, false);
    assert.deepEqual(entries, fs.readdirSync(store));
    assert.ok(!state.commands.some((command) => command.includes('add') || command.includes('remove')));
  }
});
test('declines changes to a different registered marketplace for all operations', async (t) => {
  const { source, state, base, call } = fixture(t);
  const copy = join(base, 'another checkout');
  fs.cpSync(source, copy, { recursive: true });
  state.source = copy;
  for (const action of ['setup', 'update', 'uninstall']) {
    state.commands = [];
    await assert.rejects(call(action), SetupError);
    assert.deepEqual(state.commands, ['marketplace list']);
    assert.equal(state.source, copy);
  }
});
test('uninstall retains edited files, empty directories, FIFOs and links, and rejects foreign manifests', async (t) => {
  const { base, state, call } = fixture(t);
  for (const kind of ['empty directory', 'note', 'FIFO', 'dangling link', 'directory link', 'edited plugin']) {
    await call('setup');
    const current = state.source;
    let extra = join(current, '.mine');
    if (kind === 'empty directory') fs.mkdirSync(extra);
    if (kind === 'note') write(extra, 'my data');
    if (kind === 'FIFO') assert.equal(spawnSync('mkfifo', [extra]).status, 0);
    if (kind.endsWith('link')) fs.symlinkSync(kind === 'dangling link' ? join(base, 'absent') : base, extra);
    if (kind === 'edited plugin') {
      extra = join(current, PRODUCT, 'signature');
      write(extra, 'edited');
    }
    const [message] = await call('uninstall');
    assert.equal(state.source, null);
    assert.equal(state.version, null);
    assert.ok(fs.lstatSync(extra));
    assert.ok(message.includes(current));
    fs.rmSync(current, { recursive: true });
  }
  await call('setup');
  const index = join(state.source, INDEX),
    original = JSON.parse(fs.readFileSync(index));
  for (const change of [{ name: 'other' }, { plugins: [...original.plugins, { name: 'other-plugin' }] }]) {
    write(index, JSON.stringify({ ...original, ...change }));
    await assert.rejects(call('uninstall'), SetupError);
    assert.ok(state.version);
  }
  const external = join(base, 'external');
  write(external, JSON.stringify(original));
  fs.unlinkSync(index);
  fs.symlinkSync(external, index);
  await assert.rejects(call('uninstall'), SetupError);
  assert.equal(fs.readFileSync(external, 'utf8'), JSON.stringify(original));
});
test('broken deregistration retries and modified managed source offers recovery', async (t) => {
  const { state, call, store } = fixture(t);
  await call('setup');
  write(join(state.source, PRODUCT, 'custom'), 'keep');
  state.commands = [];
  await assert.rejects(call('update'), /uninstall.*setup/);
  assert.deepEqual(state.commands, ['marketplace list']);
  state.fail = 'marketplace remove ' + MARKET;
  await assert.rejects(call('uninstall'), SetupError);
  assert.equal(state.version, null);
  assert.ok(state.source);
  await call('uninstall');
  assert.equal(state.source, null);
  write(
    join(store, '.pending-update.json'),
    JSON.stringify({ enabled: true, target: '../somewhere', version: '1.0.0', previous: null })
  );
  await assert.rejects(call('setup'), SetupError);
  assert.equal(state.source, null);
  await call('uninstall');
});
test('cache preserves mode, bytes, links, nonregular files, empty directories and unknown sources', (t) => {
  const base = temp(t);
  for (const change of ['empty', 'link', 'fifo', 'bytes', 'mode', 'no source', 'cache link']) {
    const profile = join(base, change),
      source = join(profile, 'original'),
      cache = join(profile, 'plugins/cache/local/rewrite'),
      target = join(cache, '1.0.0');
    write(join(source, 'known'), 'data');
    fs.mkdirSync(dirname(cache), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    const keep = () => preserve(profile, 'local', 'rewrite', '1.0.0', () => (change === 'no source' ? null : source));
    if (change !== 'no source') assert.equal(keep(), null);
    if (change === 'empty') fs.mkdirSync(join(target, 'empty'));
    if (change === 'link') fs.symlinkSync(source, join(target, 'link'));
    if (change === 'fifo') assert.equal(spawnSync('mkfifo', [join(target, 'fifo')]).status, 0);
    if (change === 'bytes') write(join(target, 'known'), 'edited');
    if (change === 'mode') fs.chmodSync(join(target, 'known'), 0o777);
    if (change === 'cache link') {
      fs.rmSync(cache, { recursive: true });
      fs.symlinkSync(source, cache);
    }
    const backup = keep();
    assert.ok(fs.lstatSync(backup));
    assert.ok(!fs.existsSync(cache));
    assert.equal(fs.readFileSync(join(source, 'known'), 'utf8'), 'data');
    if (change === 'link') assert.ok(fs.lstatSync(join(backup, '1.0.0/link')).isSymbolicLink());
    if (change === 'fifo') assert.ok(fs.lstatSync(join(backup, '1.0.0/fifo')).isFIFO());
    if (change === 'cache link') assert.ok(fs.lstatSync(backup).isSymbolicLink());
  }
});
test('cache refuses linked ancestors and linked backup folder', (t) => {
  for (const problem of ['market', 'backup']) {
    const profile = temp(t),
      outside = join(profile, 'outside');
    fs.mkdirSync(outside);
    const parent = join(profile, 'plugins/cache'),
      market = join(parent, 'local');
    fs.mkdirSync(parent, { recursive: true });
    if (problem === 'market') fs.symlinkSync(outside, market);
    else {
      write(join(market, 'rewrite', 'notes'), 'mine');
      fs.symlinkSync(outside, join(profile, 'codex-polish-backups'));
    }
    assert.throws(() => preserve(profile, 'local', 'rewrite', null, () => null), /directory|目录/);
    assert.deepEqual(fs.readdirSync(outside), []);
  }
});
test('OS releases profile lock on process death and serializes independent installers', async (t) => {
  const path = join(temp(t), 'installer.sqlite');
  const module = new URL('../scripts/install.mjs', import.meta.url).href;
  const code = `import {withLock} from ${JSON.stringify(module)};
    await withLock(process.argv[1],async()=>{console.log('locked');await new Promise(()=>{setInterval(()=>{},1000);});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, path], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  let acquired = false;
  const contender = withLock(path, async () => {
    acquired = true;
  });
  await sleep(120);
  assert.equal(acquired, false);
  child.kill('SIGKILL');
  await contender;
  assert.equal(acquired, true);
});
test('missing Codex returns localized actionable errors; invalid CLI flags exit 2 before mutations', (t) => {
  const base = temp(t),
    script = join(ROOT, 'scripts/install.mjs');
  for (const lang of ['en', 'zh']) {
    const result = spawnSync(process.execPath, [script, 'setup'], {
      cwd: base,
      encoding: 'utf8',
      env: {
        PATH: base,
        HOME: base,
        CODEX_HOME: join(base, 'profile'),
        LC_ALL: lang
      }
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('https://developers.openai.com/codex/cli/'));
    assert.match(result.stderr, lang === 'zh' ? /没找到 Codex CLI/ : /Couldn't find Codex CLI/);
  }
  for (const action of ['doctor', 'uninstall']) {
    const flag = '--install-agy';
    assert.equal(spawnSync(process.execPath, [script, action, flag]).status, 2);
  }
});
