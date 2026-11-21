import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { executable } from '../plugins/codex-polish/hooks/platform.mjs';
import { windows, homeEnv } from './hook_fixture.mjs';
import { ROOT, INDEX, PRODUCT, NAME, MARKET, PLUGIN_ID, nativeConfig } from '../scripts/install.mjs';

function tool(command) {
  if (command === 'codex') return executable(command);
  if (windows && ['npm', 'npx'].includes(command)) {
    const cli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const script = join(dirname(cli), command + '-cli.js');
    return fs.existsSync(script) ? { command: process.execPath, args: [script] } : null;
  }
  return { command, args: [] };
}
const canRun = ['codex', 'npm', 'npx', ...(windows ? [] : ['tar'])].every(name => {
  const bin = tool(name);
  return bin && spawnSync(bin.command, [...bin.args, '--version'], { stdio: 'ignore' }).status === 0;
});
if (process.env.CI && !canRun) throw new Error('The native installer tests require Codex CLI, npm, npx and tar.');
const nativeTest = (name, fn) => test(name, { skip: !canRun && 'requires native Codex CLI, npm, npx and tar' }, fn);
const exampleEn = 'Explain what DNS does in one sentence, then polish your reply.';
const exampleZh = '用一句话解释 DNS，再把你的回复润色一下。';
const guide = join(PRODUCT, 'skills/codex-polish-setup/references/credentials.md');

function checkInstallMessage(output, version, status, lang) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  assert.match(lines[0], status);
  assert.ok(lines[0].includes(version), lines[0]);
  assert.match(output, /UserPromptSubmit/);
  assert.match(output, /\/hooks\b/);
  if (lang === 'zh') {
    assert.match(output, /信任/);
    assert.match(output, /新.*(?:聊天|对话|会话)/);
    assert.doesNotMatch(output, /\b(?:installed|updated|trust|new chat)\b/i);
  } else {
    assert.match(output, /\btrust\b/i);
    assert.match(output, /\bnew (?:chat|conversation|session)\b/i);
    assert.doesNotMatch(output, /\p{Script=Han}/u);
  }
  assert.ok(lines.length <= 8, output);
  assert.doesNotMatch(output, /credentials(?:\.en)?\.md\b|\bDNS\b|返回结果 polish|Polish the result|Turbo.*OpenAI/i);
}

function isolated(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'codex-polish-native-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'Home'),
    profile = join(base, 'Test Profile');
  fs.mkdirSync(profile);
  fs.mkdirSync(home);
  const env = {
    PATH: process.env.PATH,
    ...homeEnv(home),
    CODEX_HOME: profile,
    XDG_CACHE_HOME: join(base, 'cache'),
    LC_ALL: 'en_US.UTF-8',
    npm_config_cache: join(base, 'npm cache'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false'
  };
  function invoke(cmd, args, { cwd = base, expect = 0, input } = {}) {
    const bin = tool(cmd);
    const result = spawnSync(bin.command, [...bin.args, ...args], {
      cwd,
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], input,
      encoding: 'utf8',
      timeout: 90_000
    });
    assert.equal(result.status, expect, result.error?.message || result.stderr || result.stdout);
    return expect ? result.stderr : result.stdout;
  }
  const cli = (...args) => JSON.parse(invoke('codex', ['plugin', ...args, '--json']));
  const rows = () => cli('list', '--marketplace', MARKET).installed;
  const marketplace = () =>
    cli('marketplace', 'list').marketplaces.find((row) => row.name === MARKET)?.root;
  const snapshot = () => {
    const market = marketplace();
    if (!market) return;
    const { plugins } = JSON.parse(fs.readFileSync(join(market, INDEX)));
    return join(market, plugins[0].source.path.split('/')[1]);
  };
  const local = (action) => invoke(process.execPath, [join(ROOT, 'scripts/install.mjs'), action]);
  return { base, profile, env, invoke, cli, rows, marketplace, snapshot, local };
}
nativeTest(
  'npm tarball, both Finder launchers, npx from archive, native onboarding and hooks, disabled update, cache backups and uninstall',
  async (t) => {
    const { base, profile, env, invoke, rows, marketplace, snapshot } = isolated(t);
    const [pack] = JSON.parse(
      invoke('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', base], { cwd: ROOT })
    );
    const extraction = join(base, '下载的插件');
    let download = extraction;
    if (windows) {
      invoke('npm', ['install', '--no-save', '--ignore-scripts', '--prefix', extraction, join(base, pack.filename)]);
      download = join(extraction, 'node_modules', pack.name);
    } else {
      invoke('tar', ['-xzf', pack.filename]);
      fs.renameSync(join(base, 'package'), download);
    }
    const script = join(download, 'scripts/install.mjs');
    env.LC_ALL = 'zh_CN.UTF-8';
    const chinese = windows ? invoke(process.execPath, [script, 'setup']) : invoke(join(download, '安装回复润色.command'), []);
    checkInstallMessage(chinese, pack.version, /安装/, 'zh');
    checkInstallMessage(invoke(process.execPath, [script, 'update']), pack.version, /更新/, 'zh');
    assert.doesNotMatch(chinese, /GEMINI_API_KEY|aistudio.google.com/);
    assert.match(invoke(process.execPath, [script, 'uninstall']), /已卸载/);
    assert.equal(fs.existsSync(join(profile, NAME)), false);
    env.LC_ALL = 'en_US.UTF-8';
    const englishSetup = () => windows ? invoke(process.execPath, [script, 'setup']) : invoke(join(download, 'Install Codex Polish.command'), []);
    checkInstallMessage(englishSetup(), pack.version, /\binstalled\b/i, 'en');
    checkInstallMessage(invoke(process.execPath, [script, 'update']), pack.version, /\bupdated\b/i, 'en');
    const first = snapshot();
    assert.ok(first.startsWith(join(profile,'codex-polish','sources') + sep));
    assert.equal(rows()[0].enabled, true);
    const rpc = (method, params) => nativeConfig(method, params, { env, cwd: base, experimental: true });
    const { plugin } = await rpc('plugin/read', { pluginName: NAME, marketplacePath: join(marketplace(), INDEX) });
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
    const polishing = join(cache, 'skills/codex-polish');
    assert.ok(fs.statSync(join(polishing, 'WORKFLOW.md')).isFile());
    assert.match(fs.readFileSync(join(polishing, 'SKILL.md'), 'utf8'), /\]\((?:\.\/)?WORKFLOW\.md\)/);
    fs.writeFileSync(join(cache, 'user-note'), 'edited cache');
    fs.appendFileSync(join(download, guide), '\n<!-- replacement build -->');
    assert.match(englishSetup(), /disabled/);
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
    assert.equal(fs.existsSync(join(profile, NAME)), false);
    for (const p of [first, changed, cache]) assert.ok(!fs.existsSync(p), p);
  }
);
nativeTest('uninstall cleans 0.0.1 locks after deregistration, preserves agy and can be repeated', t => {
  const { profile, env, local } = isolated(t);
  const pluginHome = join(profile, NAME);
  const sources = join(pluginHome, 'sources');
  fs.mkdirSync(sources, { recursive: true });
  fs.writeFileSync(join(sources, '.installer.sqlite'), '');
  const agyDir = windows ? join(env.LOCALAPPDATA, 'agy', 'bin') : join(env.HOME, '.local', 'bin');
  const agy = join(agyDir, windows ? 'agy.exe' : 'agy');
  const agyLock = join(agyDir, '.codex-polish-agy.sqlite');
  fs.mkdirSync(agyDir, { recursive: true });
  fs.writeFileSync(agy, 'independently installed CLI', { mode: 0o755 });
  fs.writeFileSync(agyLock, '');
  const unrelated = join(profile, 'other-plugin', 'notes.txt');
  fs.mkdirSync(dirname(unrelated));
  fs.writeFileSync(unrelated, 'keep me');

  for (let attempt = 0; attempt < 2; attempt++) {
    assert.match(local('uninstall'), /uninstalled/i);
    assert.equal(fs.existsSync(pluginHome), false);
    assert.equal(fs.existsSync(agyLock), false);
    assert.equal(fs.readFileSync(agy, 'utf8'), 'independently installed CLI');
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep me');
  }
});
nativeTest('settings are shared across directories and uninstall removes all plugin preferences', (t) => {
  const { base, profile, env, invoke, snapshot, local } = isolated(t);
  env.OPENAI_API_KEY = 'unrelated-key-from-another-tool';
  local('setup');
  const script = join(snapshot(), PRODUCT, 'hooks/preferences.mjs');
  const first = join(base, 'first project'), second = join(base, 'second project');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const run = (cwd, args, input) => JSON.parse(invoke(process.execPath, [script, ...args], { cwd, input }));
  const initial = run(first, ['check']);
  assert.equal(initial.openai_key_configured, false);
  assert.equal(initial.decisions_enabled, false);
  assert.equal(initial.gemini_thinking_level, 'medium');
  const credentials = pathToFileURL(join(dirname(script), 'openai_credentials.mjs')).href;
  invoke(process.execPath, ['--input-type=module', '-e',
    `import {saveOpenAIKey} from ${JSON.stringify(credentials)}; saveOpenAIKey('sk-test-isolated-install');`]);
  assert.equal(run(second, ['check']).decisions_enabled, true);
  run(first, ['set-rewrite-mode', 'turbo']);
  run(first, ['set-model', 'gemini-4-hydrogen', '--thinking-level', 'high']);
  run(first, ['set-mode', 'manual']);
  run(first, ['set-prompt'], 'Use short sentences.');
  run(second, ['set-history-turns', '4']);
  run(second, ['set-decisions', 'off']);
  run(second, ['set-language', 'zh']);
  const settings = join(profile, 'codex-polish', 'settings');
  for (const directory of [first, second]) {
    const current = run(directory, ['check']);
    assert.equal(current.prompt_source, 'custom');
    assert.equal(current.mode, 'manual');
    assert.equal(current.rewrite_mode, 'turbo');
    assert.equal(current.gemini_thinking_level, 'high');
    assert.equal(current.history_turns, 4);
    assert.equal(current.decisions_mode, 'off');
    assert.equal(current.language_mode, 'zh');
    assert.equal(fs.existsSync(join(directory, '.codex')), false);
  }
  const skippedOffer = join(settings, 'codex-polish.openai-offer');
  fs.writeFileSync(skippedOffer, 'seen\n');
  const removed = [
    ...['mode', 'history-turns', 'decisions', 'language', 'rewrite-mode', 'model', 'prompt.md'].map(name =>
      join(settings, 'codex-polish.' + name)),
    join(profile, 'codex-polish', 'credentials', 'openai.key'), skippedOffer
  ];
  for (const file of removed) assert.ok(fs.existsSync(file), file);
  fs.mkdirSync(join(first, '.codex'));
  const sources = join(profile, NAME, 'sources');
  const unrelated = [join(first, '.codex', 'instructions.md'), join(settings, 'my notes'), join(sources, 'my notes')];
  for (const file of unrelated) fs.writeFileSync(file, 'keep me');
  const ledger = join(profile, 'codex-polish', 'owned-settings.sqlite');
  assert.equal(fs.existsSync(ledger), false);
  assert.match(local('doctor'), /思考等级：高/);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.match(local('uninstall'), attempt === 0 ? /已卸载/ : /uninstalled/i);
    assert.equal(fs.existsSync(join(profile, 'codex-polish', 'credentials')), false);
    assert.deepEqual(fs.readdirSync(sources), ['my notes']);
    for (const file of removed) assert.equal(fs.existsSync(file), false, file);
    for (const file of unrelated) assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');
  }
});
nativeTest('setup and update respect saved Off and stop prompting for hook trust', (t) => {
  const { local, invoke, snapshot, rows } = isolated(t);
  local('setup');
  const preferences = join(snapshot(), PRODUCT, 'hooks/preferences.mjs');
  invoke(process.execPath, [preferences, 'set-mode', 'off']);
  const reopened = local('setup');
  assert.match(reopened, /Polishing is off/);
  assert.doesNotMatch(reopened, /UserPromptSubmit|OpenAI|install-agy|model/i);
  assert.doesNotMatch(local('update'), /UserPromptSubmit/);
  const status = local('doctor');
  assert.match(status, /When to polish: off/);
  assert.doesNotMatch(status, /UserPromptSubmit/);
  assert.equal(rows()[0].enabled, true);
  invoke(process.execPath, [preferences, 'set-mode', 'manual']);
  assert.match(local('doctor'), /To include chat history, trust UserPromptSubmit/);
});
nativeTest('uninstall reports an unreadable ownership database and can be retried', (t) => {
  const { profile, invoke, local } = isolated(t);
  local('setup');
  const ledger = join(profile, 'codex-polish', 'owned-settings.sqlite');
  fs.writeFileSync(ledger, 'interrupted ownership data');
  const failed = invoke(process.execPath, [join(ROOT, 'scripts/install.mjs'), 'uninstall'], { expect: 1 });
  assert.match(failed, /uninstall again/i);
  assert.ok(failed.includes(ledger), failed);
  assert.equal(fs.readFileSync(ledger, 'utf8'), 'interrupted ownership data');
  fs.unlinkSync(ledger);
  assert.match(local('uninstall'), /uninstalled/i);
});
nativeTest('native hook trust survives identical content and reports package, editor prompt and hook changes until reviewed', async (t) => {
  const { base, env, invoke, marketplace } = isolated(t);
  const root = join(base, 'release');
  fs.mkdirSync(dirname(join(root, INDEX)), { recursive: true });
  fs.copyFileSync(join(ROOT, INDEX), join(root, INDEX));
  fs.cpSync(join(ROOT, PRODUCT), join(root, PRODUCT), { recursive: true });
  fs.cpSync(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  const install = (action) => invoke(process.execPath, [join(root, 'scripts/install.mjs'), action]);
  const rpc = (method, params) => nativeConfig(method, params, { env, cwd: base, experimental: true });
  const hook = async () => (await rpc('hooks/list', { cwds: [base] })).data[0].hooks.find((h) => h.pluginId === PLUGIN_ID);
  // Simulate approval only inside this disposable Codex profile.
  const approve = (h) => rpc('config/value/write', {
    keyPath: 'hooks.state."' + h.key + '".trusted_hash', value: h.currentHash, mergeStrategy: 'upsert'
  });
  assert.match(install('setup'), /trust UserPromptSubmit/i);
  const fixedMarket = marketplace();
  let initial = await hook();
  assert.equal(initial.trustStatus, 'untrusted');
  await approve(initial);
  fs.writeFileSync(join(root, 'README.md'), 'Updated package documentation outside the native plugin.');
  assert.match(install('update'), /Codex trusts UserPromptSubmit/);
  assert.equal((await hook()).currentHash, initial.currentHash);
  assert.equal((await hook()).trustStatus, 'trusted');
  const files = [
    [guide, '\nUpdated setup guide.\n'],
    [PRODUCT + '/skills/codex-polish/references/codex-polish-editor.md', '\nUpdated editorial prompt.\n'],
    [PRODUCT + '/hooks/preferences.mjs', '\n// Updated hook implementation.\n'],
    [PRODUCT + '/hooks/hooks.json', null]
  ];
  for (const [relative, change] of files) {
    const path = join(root, relative);
    if (change) fs.appendFileSync(path, change);
    else {
      const manifest = JSON.parse(fs.readFileSync(path));
      manifest.hooks.UserPromptSubmit[0].hooks[0][windows ? 'commandWindows' : 'command'] += ' ';
      fs.writeFileSync(path, JSON.stringify(manifest));
    }
    assert.match(install('update'), /trust UserPromptSubmit again/, relative);
    assert.equal(marketplace(), fixedMarket);
    const changed = await hook();
    assert.equal(changed.trustStatus, 'modified');
    assert.notEqual(changed.currentHash, initial.currentHash);
    assert.equal(changed.command === initial.command, Boolean(change));
    assert.match(install('doctor'), /trust UserPromptSubmit again/);
    const { config } = await rpc('config/read', { includeLayers: false });
    const saved = config.hooks.state[initial.key];
    assert.equal(saved.trusted_hash + '/' + saved.trusted_content_hash, initial.currentHash);
    await approve(changed);
    assert.equal((await hook()).trustStatus, 'trusted');
    initial = changed;
  }
});
nativeTest('a separately registered local marketplace with the same name survives setup and uninstall', t => {
  const { base, cli, invoke, marketplace } = isolated(t);
  const foreign = join(base, 'another marketplace');
  fs.mkdirSync(dirname(join(foreign, INDEX)), { recursive: true });
  fs.copyFileSync(join(ROOT, INDEX), join(foreign, INDEX));
  fs.cpSync(join(ROOT, PRODUCT), join(foreign, PRODUCT), { recursive: true });
  cli('marketplace', 'add', foreign);
  for (const action of ['setup', 'uninstall']) {
    assert.match(invoke(process.execPath, [join(ROOT, 'scripts/install.mjs'), action], { expect: 1 }), /different source/);
    assert.equal(fs.realpathSync.native(marketplace()), fs.realpathSync.native(foreign));
  }
});

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
  ['after-pointer', 'update'],
  ['after-install', 'setup'],
  ['after-pointer', 'uninstall']
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
        if(stage==='after-pointer' && args[0]==='add') process.exit(79);
        const reply=app.codex(...args);
        if(stage==='after-install' && args[0]==='add') process.exit(79);
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
    const pluginHome = join(profile, NAME);
    const journals = () =>
      fs.readdirSync(pluginHome, { recursive: true }).filter((path) => path.endsWith('.pending-update.json'));
    assert.equal(journals().length, 1);
    let version = receipt.version;
    if (action === 'update') {
      version = '9.0.0';
      const manifest = join(product, '.codex-plugin/plugin.json');
      fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest)), version }));
    }
    install(action);
    assert.ok(!fs.existsSync(join(profile, 'codex-polish-backups')), 'intact pre- and post-update caches need no backup');
    if (action === 'uninstall') {
      assert.equal(fs.existsSync(pluginHome), false);
      assert.deepEqual(rows(), []);
      assert.ok(!fs.existsSync(receipt.installedPath));
      assert.ok(!fs.readFileSync(join(profile, 'config.toml'), 'utf8').includes(PLUGIN_ID));
    } else {
      assert.equal(journals().length, 0);
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
