import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT, INDEX, PRODUCT, GUIDE, NAME, MARKET, PLUGIN_ID, nativeConfig } from '../scripts/install.mjs';

const canRun = ['codex', 'npm', 'npx', 'tar'].every(
  (name) => !spawnSync(name, ['--version'], { stdio: 'ignore' }).error
);
const nativeTest = (name, fn) => test(name, { skip: !canRun && 'requires native Codex CLI, npm, npx and tar' }, fn);
const exampleEn = 'Explain what DNS does in one sentence, then polish your reply.';
const exampleZh = '用一句话解释 DNS，再把你的回复润色一下。';

function isolated(t) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codex-polish-native-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'Home'),
    profile = join(base, 'Test Profile');
  fs.mkdirSync(profile);
  fs.mkdirSync(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: profile,
    XDG_CACHE_HOME: join(base, 'cache'),
    LC_ALL: 'en_US.UTF-8',
    npm_config_cache: join(base, 'npm cache'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false'
  };
  function invoke(cmd, args, { cwd = base, expect = 0 } = {}) {
    const result = spawnSync(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 90_000
    });
    assert.equal(result.status, expect, result.error?.message || result.stderr || result.stdout);
    return expect ? result.stderr : result.stdout;
  }
  const cli = (...args) => JSON.parse(invoke('codex', ['plugin', ...args, '--json']));
  const rows = () => cli('list', '--marketplace', MARKET).installed;
  const snapshot = () =>
    cli('marketplace', 'list').marketplaces.find((row) => row.name === MARKET)?.marketplaceSource.source;
  const local = (action) => invoke(process.execPath, [join(ROOT, 'scripts/install.mjs'), action]);
  return { base, profile, env, invoke, cli, rows, snapshot, local };
}
nativeTest(
  'npm tarball, both Finder launchers, npx from archive, native onboarding and hooks, disabled update, cache backups and uninstall',
  async (t) => {
    const { base, profile, env, invoke, rows, snapshot } = isolated(t);
    const [pack] = JSON.parse(
      invoke('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', base], { cwd: ROOT })
    );
    invoke('tar', ['-xzf', pack.filename]);
    const download = join(base, '下载的插件');
    fs.renameSync(join(base, 'package'), download);
    const script = join(download, 'scripts/install.mjs');
    env.LC_ALL = 'zh_CN.UTF-8';
    const chinese = invoke(join(download, '安装回复润色.command'), []);
    assert.ok(chinese.includes(exampleZh));
    assert.match(chinese, /自动润色或让 Gemini 参考之前的问答.*\/hooks.*信任.*UserPromptSubmit/);
    assert.ok(chinese.includes('复用你现有的 Antigravity 登录'));
    assert.ok(chinese.includes(join(snapshot(), GUIDE)));
    assert.doesNotMatch(chinese, /GEMINI_API_KEY|aistudio.google.com/);
    invoke(process.execPath, [script, 'uninstall']);
    env.LC_ALL = 'en_US.UTF-8';
    const english = invoke(join(download, 'Install Codex Polish.command'), []);
    assert.ok(english.includes(exampleEn));
    assert.match(english, /automatic rewrites or to include earlier exchanges.*\/hooks.*trust.*UserPromptSubmit/);
    const first = snapshot();
    assert.ok(first.startsWith(join(profile,'codex-polish','sources') + '/'));
    assert.ok(english.includes(join(first, GUIDE.replace('credentials.md', 'credentials.en.md'))));
    assert.equal(rows()[0].enabled, true);
    const rpc = (method, params) => nativeConfig(method, params, { env, cwd: base, experimental: true });
    const { plugin } = await rpc('plugin/read', { pluginName: NAME, marketplacePath: join(first, INDEX) });
    assert.equal(plugin.onboardingSkill.name, 'codex-polish:codex-polish-setup');
    assert.equal(plugin.onboardingSkill.enabled, true);
    assert.equal(plugin.summary.interface.displayName, 'Codex Polish · 回复润色');
    assert.deepEqual(plugin.summary.interface.defaultPrompt, [exampleZh, exampleEn]);
    const { data } = await rpc('hooks/list', { cwds: [base] });
    const hooks = data.flatMap((entry) => entry.hooks).filter((h) => h.pluginId === PLUGIN_ID);
    assert.deepEqual(
      hooks.map((h) => h.eventName.toLowerCase()),
      ['userpromptsubmit']
    );
    assert.equal(hooks[0].trustStatus, 'untrusted');
    await rpc('config/value/write', { keyPath: `plugins.${PLUGIN_ID}.enabled`, value: false, mergeStrategy: 'upsert' });
    const cache = join(profile, 'plugins/cache', MARKET, NAME, pack.version);
    fs.writeFileSync(join(cache, 'user-note'), 'edited cache');
    fs.appendFileSync(join(download, GUIDE), '\n<!-- replacement build -->');
    assert.match(invoke(join(download, 'Install Codex Polish.command'), []), /disabled/);
    const changed = snapshot();
    assert.notEqual(first, changed);
    assert.equal(rows()[0].enabled, false);
    assert.ok(!fs.existsSync(join(cache, 'user-note')));
    const backups = join(profile, 'codex-polish-backups');
    assert.ok(
      fs
        .readdirSync(backups)
        .some(
          (folder) => fs.readFileSync(join(backups, folder, NAME, pack.version, 'user-note'), 'utf8') === 'edited cache'
        )
    );
    fs.rmSync(download, { recursive: true });
    const npx = (action) => invoke('npx', ['--yes', 'file:./' + pack.filename, action]);
    for (const action of ['setup', 'update']) {
      const output = npx(action);
      assert.match(output, /disabled/);
      assert.ok(!output.includes(exampleEn));
      assert.equal(rows()[0].enabled, false);
    }
    const report = npx('doctor');
    assert.match(report, /Node\.js 22\.16\+: available/);
    assert.match(report, /reuses your Antigravity account/);
    assert.match(report, /Interface language: English \(automatic\)/);
    fs.writeFileSync(join(cache, 'another-note'), 'my note');
    npx('uninstall');
    assert.ok(
      fs.readdirSync(backups).some((folder) => fs.existsSync(join(backups, folder, NAME, pack.version, 'another-note')))
    );
    assert.deepEqual(rows(), []);
    assert.equal(snapshot(), undefined);
    for (const p of [first, changed, cache]) assert.ok(!fs.existsSync(p), p);
  }
);
nativeTest('explicit uninstall clears the current plugin after its marketplace was removed', (t) => {
  const { profile, local, cli, invoke } = isolated(t);
  local('setup');
  cli('marketplace', 'remove', MARKET);
  assert.match(invoke(process.execPath, [join(ROOT, 'scripts/install.mjs'), 'update'], { expect: 1 }), /uninstall/);
  local('uninstall');
  assert.ok(!fs.readFileSync(join(profile, 'config.toml'), 'utf8').includes(PLUGIN_ID));
  assert.ok(!fs.existsSync(join(profile, 'plugins/cache', MARKET, NAME)));
});
for (const [stage, action] of [
  ['after-removal', 'update'],
  ['after-install', 'setup'],
  ['after-removal', 'uninstall']
]) {
  nativeTest(`interrupted native update ${stage} supports ${action} in a new process`, (t) => {
    const { base, profile, invoke, rows, cli, env } = isolated(t);
    const root = join(base, 'source'),
      product = join(root, PRODUCT);
    fs.mkdirSync(dirname(join(root, INDEX)), { recursive: true });
    fs.copyFileSync(join(ROOT, INDEX), join(root, INDEX));
    fs.cpSync(join(ROOT, PRODUCT), product, { recursive: true });
    fs.writeFileSync(join(product, 'retired-file'), 'initial');
    const module = pathToFileURL(join(ROOT, 'scripts/install.mjs')).href;
    const script = `import * as app from ${JSON.stringify(module)};
      const [action,stage,root]=process.argv.slice(1);
      if(action==='disable'){await app.writeEnabled(false);}
      else await app.manage(action,root,app.snapshotStore(),(...args)=>{
        const reply=app.codex(...args);
        if(stage==='after-removal' && args[0]==='marketplace' && args[1]==='remove'
           || stage==='after-install' && args[0]==='add') process.exit(79);
        return reply;
      });`;
    const install = (action, stage = '') =>
      invoke(process.execPath, ['--input-type=module', '-e', script, action, stage, root], { expect: stage ? 79 : 0 });
    install('setup');
    const receipt = cli('add', PLUGIN_ID);
    install('disable');
    fs.unlinkSync(join(product, 'retired-file'));
    fs.writeFileSync(join(product, 'revision'), 'updated');
    install('update', stage);
    const journals = () =>
      fs.readdirSync(join(profile,'codex-polish'), { recursive: true }).filter((path) => path.endsWith('.pending-update.json'));
    assert.equal(journals().length, 1);
    let version = receipt.version;
    if (action === 'update') {
      version = '9.0.0';
      const manifest = join(product, '.codex-plugin/plugin.json');
      fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest)), version }));
    }
    install(action);
    assert.equal(journals().length, 0);
    if (action === 'uninstall') {
      assert.deepEqual(rows(), []);
      assert.ok(!fs.existsSync(receipt.installedPath));
      assert.ok(!fs.readFileSync(join(profile, 'config.toml'), 'utf8').includes(PLUGIN_ID));
    } else {
      assert.deepEqual(
        rows().map((r) => [r.pluginId, r.version, r.enabled]),
        [[PLUGIN_ID, version, false]]
      );
      const updated = join(dirname(receipt.installedPath), version);
      assert.equal(fs.readFileSync(join(updated, 'revision'), 'utf8'), 'updated');
      assert.ok(!fs.existsSync(join(updated, 'retired-file')));
    }
  });
}
