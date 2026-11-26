import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { executable } from '../plugins/codex-polish/hooks/platform.mjs';
import { windows } from './hook_fixture.mjs';
import { isolatedHosts, settingsModule, until, withSettings, write } from './host_fixture.mjs';

test('the reverse settings API isolates profiles and can reset one field without replacing the others', t => {
  const fixture = isolatedHosts(t);
  const alternate = { ...fixture.env, CODEX_POLISH_AGY_SETTINGS_DIR: join(fixture.base, 'Second settings directory') };
  const forward = join(fixture.profile, 'codex-polish', 'settings', 'codex-polish.mode');
  const reverseDefault = join(fixture.home, '.gemini', 'config', 'agy-polish');
  write(forward, 'manual\n');
  const read = env => withSettings(fixture, 'console.log(JSON.stringify(await settings.readSettings()));', [], env);
  const set = (values, env) => withSettings(fixture, 'await settings.writeSettings(JSON.parse(process.argv[1]));',
    [JSON.stringify(values)], env);
  const defaults = { mode: 'manual', model: 'gpt-6.2-sol', effort: 'xhigh' };
  assert.deepEqual(read(), defaults);
  assert.deepEqual(read(alternate), defaults);

  set({ model: 'provider/fixture-model', effort: 'xhigh' });
  set({ mode: 'turbo', model: 'other-model' }, alternate);
  for (const mode of ['normal', 'turbo', 'manual', 'off']) {
    set({ mode });
    assert.deepEqual(read(), { mode, model: 'provider/fixture-model', effort: 'xhigh' });
  }
  set({ model: null });
  assert.deepEqual(read(), { ...defaults, mode: 'off' });
  set({ effort: null });
  assert.deepEqual(read(), { ...defaults, mode: 'off' });
  assert.deepEqual(read(alternate), { mode: 'turbo', model: 'other-model', effort: null });
  assert.equal(fs.readFileSync(forward, 'utf8'), 'manual\n');
  assert.equal(fs.existsSync(reverseDefault), false);
  assert.deepEqual(fixture.records(), []);
});

test('old default settings, explicit Codex inheritance and a reset resolve in the settings command', t => {
  const fixture = isolatedHosts(t);
  const script = fileURLToPath(settingsModule);
  const invoke = (...args) => {
    const result = fixture.run(process.execPath, [script, ...args]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  write(join(fixture.reverseSettings, 'settings.json'), JSON.stringify({ mode: 'manual', model: null, effort: null }));
  const defaults = { mode: 'manual', model: 'gpt-6.2-sol', effort: 'xhigh' };
  assert.deepEqual(invoke('show'), defaults);
  assert.deepEqual(invoke('set', '--model', 'local-editor'), { mode: 'manual', model: 'local-editor', effort: null });
  assert.deepEqual(invoke('set', '--model', 'default', '--effort', 'low'), { ...defaults, effort: 'low' });
  assert.deepEqual(invoke('set', '--model', 'codex-default', '--effort', 'codex-default'),
    { mode: 'manual', model: null, effort: null });
  assert.deepEqual(invoke('set', '--mode', 'turbo'), { mode: 'turbo', model: null, effort: null });
  assert.deepEqual(invoke('set', '--model', 'default'), { ...defaults, mode: 'turbo', effort: null });
  assert.deepEqual(invoke('set', '--effort', 'default'), { ...defaults, mode: 'turbo' });
});

test('the first Off setting with a relative directory follows the fixture home across working directories', t => {
  const fixture = isolatedHosts(t);
  const directory = join('relative settings', 'agy-polish');
  const env = { ...fixture.env, CODEX_POLISH_AGY_SETTINGS_DIR: directory };
  const script = fileURLToPath(settingsModule);
  const invoke = (cwd, ...args) => {
    const result = fixture.run(process.execPath, [script, ...args], { cwd, env });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = { mode: 'off', model: 'gpt-6.2-sol', effort: 'xhigh' };
  assert.deepEqual(invoke(fixture.workspace, 'set', '--mode', 'off'), first);
  assert.deepEqual(invoke(fixture.base, 'show'), first);
  const stored = JSON.parse(fs.readFileSync(join(fixture.home, directory, 'settings.json'), 'utf8'));
  assert.deepEqual(stored, { mode: 'off', model: null, effort: null });
  assert.equal(fs.existsSync(join(fixture.workspace, directory)), false);
});

test('a legacy empty settings lock does not block the next write', t => {
  const fixture = isolatedHosts(t);
  write(join(fixture.reverseSettings, 'settings.json.lock'), '');
  assert.deepEqual(withSettings(fixture, 'console.log(JSON.stringify(await settings.writeSettings({ mode: "off" })));'),
    { mode: 'off', model: 'gpt-6.2-sol', effort: 'xhigh' });
  assert.equal(withSettings(fixture, 'console.log(JSON.stringify(settings.readSettings()));').mode, 'off');
});

test('settings writes recover after a process is killed mid-commit and merge concurrent field updates', {
  timeout: 15_000
}, async t => {
  const fixture = isolatedHosts(t);
  withSettings(fixture, 'await settings.writeSettings({ mode: "off" });');
  const settingsFile = join(fixture.reverseSettings, 'settings.json');
  const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const initial = { mode: 'off', model: null, effort: null };
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeSettings } from ${JSON.stringify(settingsModule)};
    const [patch, target, started, staged, resume] = process.argv.slice(1);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === target) {
        fs.writeFileSync(staged, '');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(resume)) Atomics.wait(wait, 0, 0, 15);
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    fs.writeFileSync(started, '');
    await writeSettings(JSON.parse(patch));
  `;
  async function writer(name, patch, pause) {
    const started = join(fixture.base, `${name}.started`);
    const staged = join(fixture.base, `${name}.staged`);
    const resume = join(fixture.base, `${name}.resume`);
    if (!pause) write(resume, '');
    const child = spawn(process.execPath, ['--input-type=module', '-e', source,
      JSON.stringify(patch), settingsFile, started, staged, resume], {
      cwd: fixture.workspace, env: fixture.env, stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const closed = once(child, 'close');
    fixture.onCleanup(async () => { child.kill('SIGKILL'); await closed; });
    const waitFor = path => until(() => fs.existsSync(path), () => `${name} did not reach ${path}: ${stderr}`);
    await waitFor(started);
    return { child, closed, resume: () => write(resume, ''), staged: () => fs.existsSync(staged),
      waitForStage: () => waitFor(staged), stderr: () => stderr };
  }

  const interrupted = await writer('interrupted', { mode: 'manual' }, true);
  await interrupted.waitForStage();
  const model = await writer('model', { model: 'provider/fixture-model' }, true);
  await sleep(120);
  assert.equal(model.staged(), false, 'a second writer must wait for the active transaction');
  assert.deepEqual(read(), initial);
  assert.ok(interrupted.child.kill('SIGKILL'));
  assert.deepEqual(await interrupted.closed, [null, 'SIGKILL']);
  await model.waitForStage();

  const effort = await writer('effort', { effort: 'xhigh' }, false);
  await sleep(120);
  assert.equal(effort.staged(), false, 'a waiting writer must merge after the preceding commit');
  model.resume();
  assert.deepEqual(await model.closed, [0, null], model.stderr());
  assert.deepEqual(await effort.closed, [0, null], effort.stderr());
  assert.deepEqual(read(), { ...initial, model: 'provider/fixture-model', effort: 'xhigh' });
});

test('listModels follows Codex App Server pagination and uses provider reasoning-effort metadata', {
  skip: windows && 'requires POSIX fake codex executable'
}, t => {
  const fixture = isolatedHosts(t);
  const models = withSettings(fixture, 'console.log(JSON.stringify(await settings.listModels()));');
  assert.deepEqual(models, [
    { id: 'fixture-model', name: '模型 Café', efforts: ['low', 'xhigh'], defaultEffort: 'low', isDefault: true },
    { id: 'fixture-other', name: 'Other model', efforts: ['medium'], defaultEffort: 'medium', isDefault: false }
  ]);
  const rpc = fixture.records().filter(row => row.method);
  assert.deepEqual(rpc.map(row => row.method), ['initialize', 'initialized', 'config/read', 'model/list', 'model/list']);
  assert.equal(rpc[3].params.cursor ?? null, null);
  assert.equal(rpc[4].params.cursor, 'next-page');
  assert.ok(!fixture.records().some(row => row.args.includes('exec')), 'browsing models never submits a draft');
});

test('a custom Responses provider without a model catalog only offers its configured model', {
  skip: !executable('codex') && 'requires the native Codex CLI'
}, t => {
  const fixture = isolatedHosts(t, { codex: false });
  const env = { ...fixture.env, PATH: [fixture.env.PATH, process.env.PATH].join(delimiter) };
  const file = join(fixture.profile, 'config.toml');
  const config = 'model_provider = "local"\n[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:9/v1"\n';
  const list = () => withSettings(fixture, 'console.log(JSON.stringify(await settings.listModels()));', [], env);
  write(file, 'model = "local-editor"\n' + config);
  assert.deepEqual(list(), [{ id: 'local-editor', name: 'local-editor', efforts: [], defaultEffort: null, isDefault: true }]);
  write(file, config);
  assert.deepEqual(list(), []);
});
