import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { delimiter, dirname, join, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { chooseSetupModel, chooseSetupMode, discoverSetupModels, manageOpenAI, setupIssues, showSetupGuidance, doctor } from '../scripts/install.mjs';
import { readOpenAIKey } from '../plugins/codex-polish/hooks/openai_credentials.mjs';
import { projectGeminiModel } from '../plugins/codex-polish/hooks/preferences.mjs';
import { rewriteModeSettings } from '../plugins/codex-polish/hooks/rewrite_mode.mjs';
import { catalog } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_models.mjs';
import { makeProject, windows, homeEnv, useTestProfile } from './hook_fixture.mjs';

const checks = {
  ui_language: 'en',
  blockers: [],
  mode: 'auto',
  rewrite_mode: 'normal',
  rewrite_mode_configured: true,
  google_auth_method: 'existing-session',
  decisions_mode: 'auto',
  decisions_enabled: false,
  agy_available: true,
  codex_available: true,
  node_available: true,
  gemini_model: 'gemini-4-hydrogen',
  gemini_thinking_level: 'medium',
  gemini_model_configured: true,
  history_turns: 2,
  language_mode: 'auto'
};
test('doctor explains modes, decisions, history, model and Google authentication in the selected language', () => {
  for (const lang of ['zh', 'en']) {
    const data = { ...checks, ui_language: lang };
    const report = (extra = {}) => doctor({ ...data, ...extra });
    const defaults = report();
    assert.match(defaults, lang === 'en' ? /Thinking level: Medium/ : /思考等级：中/);
    assert.match(report({ gemini_thinking_level: 'fixed' }), lang === 'en' ? /Fixed by the model/ : /由模型固定/);
    assert.match(defaults, lang === 'en' ? /go straight to Gemini/ : /直接交给 Gemini/);
    assert.match(defaults, lang === 'en' ? /reuses your Antigravity account/ : /复用 Antigravity 里的登录/);
    assert.match(defaults, lang === 'en' ? /Gemini receives up to 2 earlier completed exchanges/ : /Gemini 改写时最多带上最近 2 轮完整问答/);
    assert.match(report({ openai_key_malformed: true }), /@kyun\.si\/codex-polish@beta openai/);
    const withOpenAI = report({ decisions_enabled: true });
    assert.match(
      withOpenAI,
      lang === 'en' ? /OpenAI Decisions API[^\n]*current question, draft, and any custom polishing prompt/ : /OpenAI Decisions API[^\n]*本轮问题、草稿和已设置的自定义润色提示词/
    );
    assert.match(withOpenAI, lang === 'en' ? /pays for the API calls/ : /API 费用/);
    assert.doesNotMatch(withOpenAI, /meaning|原意/);
    const manualDoctor = report({ rewrite_mode: 'turbo', mode: 'manual' });
    assert.match(manualDoctor, lang === 'en' ? /Requested rewrites use Turbo/ : /点名润色会用 Turbo/);
    assert.doesNotMatch(manualDoctor, /Set up OpenAI Decisions|配置 OpenAI Decisions/);
    assert.match(manualDoctor, lang === 'en' ? /When to polish: only when asked/ : /润色时机：只在我要求时/);
    assert.match(manualDoctor, lang === 'en' ? /Automatic rewrite mode: turbo/ : /自动润色的改写模式：turbo/);
    for (const mode of ['manual', 'off']) {
      const saved = report({ mode, openai_key_configured: true, decisions_enabled: false });
      assert.match(saved, lang === 'en' ? /OpenAI Decisions API check you enabled/ : /已开启的 OpenAI Decisions API 检查/);
      assert.doesNotMatch(saved, /Set up OpenAI Decisions|「配置 OpenAI Decisions」/);
    }
    const invalidMode = report({ rewrite_mode: null, blockers: ['rewrite_mode_invalid'] });
    assert.match(invalidMode, lang === 'en' ? /rewrite mode is invalid/ : /改写模式无效/);
    assert.doesNotMatch(invalidMode, /go straight to Gemini|直接交给 Gemini/);
    const enterprise = report({ google_auth_method: 'agent-platform' });
    assert.doesNotMatch(enterprise, /GEMINI_API_KEY|https:/);
    assert.match(enterprise, lang === 'en' ? /enterprise/ : /企业/);
    const key = report({ google_auth_method: 'gemini-api-key', gemini_key_configured: true, history_turns: 0, gemini_model: 'gemini-4-argon' });
    for (const detail of ['Node.js 22.16+', 'gemini-4-argon']) assert.ok(key.includes(detail));
    assert.match(key, lang === 'en' ? /Gemini API key: configured/ : /Gemini API 密钥：已配置/);
    assert.match(key, lang === 'en' ? /History is off/ : /历史记录设为 0/);
    assert.ok(!key.includes('api_timeout'));
  }
});

test('setup reports actionable blockers and offers the relevant official key page', () => {
  for (const lang of ['zh', 'en']) {
    const data = { ...checks, ui_language: lang };
    assert.deepEqual(setupIssues(data), [[], []]);
    for (const [code, fragment] of [
      ['agy_missing', '--install-agy'],
      ['agy_unsupported', '1.2.1'],
      ['unsupported_node', 'Node.js 22.16'],
      ['unsupported_google_auth', 'CODEX_POLISH_AGY_AUTH'],
      ['mode_invalid', 'codex-polish.mode'],
      ['rewrite_mode_invalid', lang === 'en' ? 'rewrite mode is invalid' : '改写模式无效'],
      ['history_turns_invalid', 'codex-polish.history-turns'],
      ['decisions_mode_invalid', 'codex-polish.decisions'],
      ['gemini_model_invalid', lang === 'en' ? 'Choose a rewrite model' : '选择改写模型']
    ]) {
      const [lines, pages] = setupIssues({ ...data, blockers: [code] });
      assert.ok(lines.join('\n').includes(fragment));
      assert.deepEqual(pages, []);
    }
    for (const code of ['gemini_key_missing', 'gemini_key_invalid']) {
      const [lines, pages] = setupIssues({ ...data, google_auth_method: 'gemini-api-key', blockers: [code] });
      assert.match(lines.join('\n'), /GEMINI_API_KEY/);
      assert.deepEqual(pages, ['https://aistudio.google.com/apikey']);
    }
  }
});
test('rewrite mode picker responds to arrows, Enter and cancellation and restores the terminal', async (t) => {
  const down = '\x1b[B', up = '\x1b[A', enter = '\r';
  for (const [name, keys, expected, lang, initiallyRaw] of [
    ['Enter accepts the default', [enter], 'normal', 'en', false],
    ['Down selects Turbo', [down, enter], 'turbo', 'zh', false],
    ['Up returns to Normal', [down, up, enter], 'normal', 'en', true],
    ['2 leaves Normal highlighted', ['2', enter], 'normal', 'en', false],
    ['1 does not confirm a choice', ['1', down, enter], 'turbo', 'en', false],
    ['Escape cancels a pending selection', [down, '\x1b'], null, 'zh', false],
    ['Ctrl+C cancels', ['\x03'], null, 'en', false],
    ['Ctrl+D cancels', ['\x04'], null, 'en', false],
    ['EOF cancels', [null], null, 'en', false]
  ]) {
    await t.test(name, { timeout: 3000 }, async (t) => {
      const input = new PassThrough({ autoDestroy: false }), output = new PassThrough();
      input.isTTY = output.isTTY = true;
      input.isRaw = initiallyRaw;
      input.setRawMode = (enabled) => {
        input.isRaw = enabled;
        return input;
      };
      t.after(() => { input.destroy(); output.destroy(); });
      let display = '';
      output.setEncoding('utf8').on('data', (chunk) => { display += chunk; });
      const selection = chooseSetupMode(lang, input, output);
      await setImmediate();
      assert.equal(input.isRaw, true);
      assert.match(display, /Normal/);
      assert.match(display, /Turbo/);
      assert.match(display, lang === 'en' ? /Enter/i : /回车|Enter/);
      assert.match(display, /↑/);
      assert.match(display, /↓/);
      for (const key of keys) {
        const previousDisplay = display;
        if (key === null) input.end();
        else input.write(key);
        await setImmediate();
        if (key === '1' || key === '2') assert.equal(input.isRaw, true, 'numeric input leaves the menu open');
        if (key === down || key === up) assert.notEqual(display, previousDisplay, 'redraw the highlighted choice');
      }
      assert.equal(await selection, expected);
      assert.equal(input.isRaw, initiallyRaw);
    });
  }
});

test('closing the terminal during selection cancels the picker', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = () => input;
  const selection = chooseSetupMode('en', input, output);
  input.destroy();
  assert.equal(await selection, null);
  output.destroy();
});

async function openAIFlow(lang, onboarding, keys) {
  const input = new PassThrough({ autoDestroy: false }), output = new PassThrough();
  let display = '';
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.on('data', chunk => { display += chunk; });
  try {
    const flow = manageOpenAI(lang, { onboarding, input, output });
    for (const key of keys) {
      await setImmediate();
      assert.equal(input.isRaw, true, 'the active prompt has disabled input echo');
      if (key === null) input.end();
      else input.write(key);
    }
    const ok = await flow;
    assert.equal(input.isRaw, false);
    return { ok, display };
  } finally { input.destroy(); output.destroy(); }
}

test('Normal setup offers a single default skip after model selection and the manage command stays available', async t => {
  useTestProfile(t);
  const enter = '\r', down = '\x1b[B';
  const order = [];
  const session = { ...checks, rewrite_mode_configured: false, gemini_model_configured: false };
  const offers = [];
  const options = {
    interactive: true, check: () => session,
    chooseMode() { order.push('mode'); return 'normal'; },
    saveRewriteMode() { session.rewrite_mode_configured = true; },
    chooseModel() { order.push('model'); return { model: 'gemini-4-hydrogen', thinkingLevel: 'medium' }; },
    saveModel(selection) {
      assert.deepEqual(selection, { model: 'gemini-4-hydrogen', thinkingLevel: 'medium' });
      session.gemini_model_configured = true;
    },
    async offerOpenAI(lang) {
      order.push('openai');
      offers.push(await openAIFlow(lang, true, offers.length ? [] : [enter]));
    }
  };
  assert.equal(await showSetupGuidance(options), true);
  assert.deepEqual(order, ['mode', 'model', 'openai']);
  assert.match(offers[0].display, /❯ ● Skip and use Gemini only \(default\)/);
  assert.match(offers[0].display, /OpenAI Decisions API[^\n]+Gemini[^\n]+billed by API usage/);
  assert.doesNotMatch(offers[0].display, /platform\.openai\.com|custom polishing prompt|@kyun/);
  assert.equal(readOpenAIKey(), null);
  assert.equal(await showSetupGuidance(options), true);
  assert.equal(offers[1].display, '');
  const afterSkip = await openAIFlow('en', false, [down, enter]);
  assert.match(afterSkip.display, /Enable with my own OpenAI API key/);
  for (const variation of [{ interactive: false }, { dependencyOnly: true }, { check: () => ({ ...session, rewrite_mode: 'turbo' }) }]) {
    await showSetupGuidance({ ...options, ...variation, offerOpenAI: () => assert.fail('unexpected OpenAI prompt') });
  }
});

test('private key entry supports enrollment, replacement, cancellation, failed validation and removal', async t => {
  for (const lang of ['en', 'zh']) await t.test(lang, async t => {
    useTestProfile(t);
    const first = 'test-only-first', second = 'test-only-second';
    const enter = '\r', down = '\x1b[B';
    const enroll = await openAIFlow(lang, true, [down, enter, first, enter]);
    assert.equal(enroll.ok, true);
    assert.match(enroll.display.split('\n')[0], /OpenAI Decisions API.*Gemini/);
    assert.doesNotMatch(enroll.display, /test-only/);
    assert.match(enroll.display, /https:\/\/platform\.openai\.com\/api-keys/);
    assert.match(enroll.display, lang === 'en' ? /current question, draft, and any custom polishing prompt/ : /本轮问题、草稿和你设置的自定义润色提示词/);
    assert.match(enroll.display, lang === 'en' ? /pays for these API calls/ : /API 调用由你的 OpenAI 账号付费/);
    assert.equal(readOpenAIKey(), first);
    assert.equal((await openAIFlow(lang, true, [])).display, '');
    for (const exit of [enter, '\x03', '\x04', '\x1b', null]) {
      const keys = exit === enter ? [down, enter, enter] : [down, enter, second, exit];
      const cancel = await openAIFlow(lang, false, keys);
      assert.equal(cancel.ok, true);
      assert.doesNotMatch(cancel.display, /test-only/);
      assert.equal(readOpenAIKey(), first);
    }
    const invalid = await openAIFlow(lang, false, [down, enter, 'test-only with spaces', enter]);
    assert.equal(invalid.ok, false);
    assert.doesNotMatch(invalid.display, /test-only/);
    assert.equal(readOpenAIKey(), first);
    const replace = await openAIFlow(lang, false, [down, enter, second + 'x', '\x7f', enter]);
    assert.equal(replace.ok, true);
    assert.doesNotMatch(replace.display, /test-only/);
    assert.equal(readOpenAIKey(), second);
    assert.equal((await openAIFlow(lang, false, [down, down, enter])).ok, true);
    assert.equal(readOpenAIKey(), null);
    assert.equal((await openAIFlow(lang, true, [])).display, '');
  });
});

test('openai CLI rejects keys passed as arguments or through pipes and requires an interactive terminal', t => {
  const { cwd, env } = makeProject(t);
  const script = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [script, ...args], {
    cwd, env: { ...env, OPENAI_API_KEY: 'test-only-ambient' }, input: 'test-only-piped\n', encoding: 'utf8'
  });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /openai manages/);
  for (const args of [['openai'], ['openai', 'test-only-argument'], ['openai', '--install-agy']]) {
    const result = run(args);
    assert.equal(result.status, args.length === 1 ? 1 : 2);
    if (args.length === 1) assert.match(result.stderr, /interactive terminal/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-only/);
    assert.equal(fs.existsSync(env.CODEX_HOME), false);
  }
});

test('a damaged setup receipt cannot block removing a saved key', async t => {
  const profile = useTestProfile(t);
  assert.equal((await openAIFlow('en', false, ['\r', 'test-only-receipt', '\r'])).ok, true);
  const settings = join(profile, 'codex-polish', 'settings');
  fs.mkdirSync(settings, { recursive: true });
  fs.mkdirSync(join(settings, 'codex-polish.openai-offer'));
  const removal = await openAIFlow('en', false, ['\x1b[B', '\x1b[B', '\r']);
  assert.equal(readOpenAIKey(), null);
  assert.match(removal.display, /Key removed/);
  assert.match(removal.display, /could not remember/);
});

test('installer reads a catalog from the Codex agent’s final message and verifies the requested model', async t => {
  const bin = fs.mkdtempSync(join(tmpdir(), 'polish catalog test '));
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(bin, { recursive: true, force: true }); });
  const executable = windows ? join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : join(bin, 'codex');
  const reply = join(bin, 'reply.json'), observed = join(bin, 'invocation.json');
  fs.mkdirSync(dirname(executable), { recursive: true });
  fs.writeFileSync(executable, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"), args = process.argv.slice(2);',
    'const out = args.indexOf("--output-last-message");',
    'if (args[0] !== "exec" || out === -1) process.exit(1);',
    'fs.writeFileSync(' + JSON.stringify(observed) + ', JSON.stringify({cwd: process.cwd(), args}));',
    'fs.copyFileSync(' + JSON.stringify(reply) + ', args[out + 1]);'
  ].join('\n'), { mode: 0o700 });
  if (windows) fs.writeFileSync(join(bin, 'codex.cmd'), '');
  process.env.PATH = bin + delimiter + oldPath;
  const target = 'gemini-4-hydrogen', other = 'gemini-4-neon';
  const options = [
    {id: 'model', type: 'select', category: 'model', currentValue: target,
      options: [{value: target, name: 'Hydrogen'}, {value: other, name: 'Neon'}, {value: 'invalid id'}]},
    {id: 'thought_level', type: 'select', category: 'thought_level', currentValue: 'high',
      options: [{value: 'medium', name: 'Medium'}, {value: 'high', name: 'High'}, {value: 'invalid'}]}
  ];
  const status = { ...checks, agy_path: join(bin, windows ? 'agy.exe' : 'agy') };
  function response(id) { return {jsonrpc: '2.0', id, result: {sessionId: 'fixture-session', configOptions: options}}; }
  async function discover(frame, model) {
    fs.writeFileSync(reply, JSON.stringify(frame));
    const value = await discoverSetupModels(status, model);
    const {cwd, args} = JSON.parse(fs.readFileSync(observed));
    assert.equal(fs.existsSync(cwd), false, 'cleanup removes the temporary Codex workspace');
    assert.ok(args.includes('--ephemeral'));
    return value;
  }
  const account = await discover(response(3));
  assert.deepEqual(account.models.map(item => item.id), [target, other]);
  const chosen = await discover(response(4), target);
  assert.deepEqual(chosen.thinking_levels.map(item => item.id), ['medium', 'high']);
  assert.equal(await discover(response(4), other), null);
  assert.equal(await discover(response(4)), null);
  assert.equal(await discover({jsonrpc: '2.0', id: 3, error: {code: 1}}), null);
  assert.equal(await discover(null), null);
});

test('model picker selects model and thinking level together, using account metadata for the selected model', async t => {
  const enter = '\r', down = '\x1b[B', up = '\x1b[A', cancel = '\x03';
  const hydrogen = 'gemini-4-hydrogen', argon = 'gemini-4-argon', neon = 'gemini-4-neon';
  const account = {
    models: [{ id: neon, name: 'Gemini 4 Neon' }, { id: argon, name: 'Gemini 4 Argon / Preview: (Auto)\x1b[9m' }],
    current_model: neon, current_thinking_level: 'high', thinking_levels: [{ id: 'medium' }, { id: 'high' }]
  };
  const argonSteps = [down, enter, down, enter];
  for (const [keys, lang, accountResult, targetResult, expected, calls] of [
    [[enter, enter], 'en', null, null, { model: hydrogen, thinkingLevel: 'medium' }, []],
    [[enter, up, enter], 'zh', null, null, { model: hydrogen, thinkingLevel: 'low' }, []],
    [[enter, down, down, enter], 'en', null, null, { model: hydrogen, thinkingLevel: 'xhigh' }, []],
    [[enter, cancel], 'zh', null, null, null, []],
    [[down, enter, enter, enter], 'en', account, null, { model: neon, thinkingLevel: 'medium' }, [undefined]],
    [[...argonSteps, enter], 'zh', account, { current_model: argon, current_thinking_level: 'high', thinking_levels: [{ id: 'low' }, { id: 'high' }] }, { model: argon, thinkingLevel: 'high' }, [undefined, argon]],
    [argonSteps, 'en', account, { current_model: argon, thinking_levels: [] }, { model: argon, thinkingLevel: 'fixed' }, [undefined, argon]],
    [argonSteps, 'en', account, null, null, [undefined, argon]],
    [argonSteps, 'en', account, account, null, [undefined, argon]],
    [[down, enter, cancel], 'en', account, null, null, [undefined]],
    [[down, enter], 'en', null, null, null, [undefined]]
  ]) {
    const input = new PassThrough(), output = new PassThrough();
    input.setRawMode = enabled => { input.isRaw = enabled; };
    const discover = t.mock.fn((_, model) => model ? targetResult : accountResult);
    let display = '';
    output.on('data', bytes => { display += bytes.toString(); });
    const selection = chooseSetupModel(checks, lang, input, output, discover);
    for (const key of keys) { await setImmediate(); input.write(key); }
    assert.deepEqual(await selection, expected);
    if (expected?.model === argon) {
      assert.ok(display.includes('Gemini 4 Argon / Preview: (Auto)\\u001b[9m'));
      assert.ok(!display.includes('\x1b[9m'));
    }
    if (expected?.thinkingLevel === 'medium') assert.match(display, /❯ ● Medium \(default\)/);
    if (expected?.thinkingLevel === 'fixed') assert.match(display, /fixed thinking level/);
    if (expected?.thinkingLevel === 'high') assert.doesNotMatch(display, /极高|中（默认）/);
    assert.deepEqual(discover.mock.calls.map(call => call.arguments[1]), calls);
    assert.match(display, /Gemini 4 Hydrogen/);
    assert.equal(!!input.isRaw, false);
    input.destroy(); output.destroy();
  }
});

test('account picker shows both IDs when provider labels differ only in surrounding whitespace', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.setRawMode = () => {};
  let display = '';
  output.on('data', bytes => { display += bytes.toString(); });
  const choices = [{ value: 'gemini-first', name: 'Gemini Pro' }, { value: 'gemini-second', name: 'Gemini Pro ' }];
  const discover = (_, model) => catalog([{ category: 'model', type: 'select', id: 'model', currentValue: model || 'gemini-first', options: choices }]);
  const selection = chooseSetupModel(checks, 'en', input, output, discover);
  for (const key of ['\x1b[B', '\r', '\x1b[B', '\r']) { await setImmediate(); input.write(key); }
  assert.deepEqual(await selection, { model: 'gemini-second', thinkingLevel: 'fixed' });
  assert.ok(display.includes('Gemini Pro (gemini-first)'));
  assert.ok(display.includes('Gemini Pro (gemini-second)'));
  input.destroy(); output.destroy();
});

test('interactive setup saves mode and model once in the Codex profile from any launch directory', async t => {
  const { home, project, cwd } = makeProject(t);
  const downloads = join(home, 'Downloads');
  const extracted = join(downloads, 'codex-polish');
  const newProject = join(home, 'another project');
  const bin = join(home, 'bin');
  fs.mkdirSync(extracted, { recursive: true });
  fs.mkdirSync(join(newProject, '.git'), { recursive: true });
  fs.mkdirSync(bin);
  if (windows) fs.copyFileSync(process.execPath, join(bin, 'agy.exe'));
  else fs.writeFileSync(join(bin, 'agy'), '#!/bin/sh\necho agy 1.2.1\n', { mode: 0o700 });
  for (const folder of ['scripts', 'plugins'])
    fs.cpSync(new URL('../' + folder, import.meta.url), join(extracted, folder), { recursive: true });
  const packaged = await import(pathToFileURL(join(extracted, 'scripts/install.mjs')).href);
  const localSettings = join(project, '.codex');
  fs.writeFileSync(join(localSettings, 'codex-polish.rewrite-mode'), 'normal\n');
  fs.writeFileSync(join(localSettings, 'codex-polish.model'), 'gemini-4-neon\n');

  for (const [launch, directory] of [
    ['home', home], ['root', parse(home).root], ['downloads', downloads],
    ['finder', project], ['extracted', extracted], ['project', cwd]
  ]) {
    await t.test(launch, async t => {
      const profile = join(home, 'profile-' + launch);
      const env = {
        ...homeEnv(home), CODEX_HOME: profile, PATH: bin, LC_ALL: 'en_US.UTF-8',
        CODEX_POLISH_AGY_AUTH: 'existing-session', CODEX_POLISH_INSTALL_WINDOW: launch === 'finder' ? '1' : '0'
      };
      for (const [key, value] of Object.entries(env)) {
        const previous = process.env[key];
        process.env[key] = value;
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
      }
      const previousDirectory = process.cwd();
      process.chdir(directory);
      t.after(() => process.chdir(previousDirectory));
      const log = t.mock.method(console, 'log', () => {});
      const choices = [];
      const setup = launch === 'extracted' ? packaged.showSetupGuidance : showSetupGuidance;
      const options = {
        interactive: true,
        chooseMode(lang) { assert.equal(lang, 'en'); choices.push('mode'); return 'turbo'; },
        chooseModel() { choices.push('model'); return { model: 'gemini-4-argon', thinkingLevel: 'high' }; },
        prompt: message => assert.fail('Unexpected question: ' + message)
      };
      assert.equal(await setup(options), true);
      process.chdir(project);
      assert.equal(await setup(options), true);
      assert.deepEqual(choices, ['mode', 'model']);
      assert.equal(log.mock.callCount(), 0);
      const defaults = join(profile, 'codex-polish', 'settings');
      assert.equal(fs.readFileSync(join(defaults, 'codex-polish.rewrite-mode'), 'utf8'), 'turbo\n');
      assert.equal(fs.readFileSync(join(defaults, 'codex-polish.model'), 'utf8'), 'gemini-4-argon high\n');
      assert.equal(rewriteModeSettings(newProject).rewrite_mode, 'turbo');
      assert.equal(projectGeminiModel(newProject), 'gemini-4-argon');
      assert.equal(rewriteModeSettings(cwd).rewrite_mode, 'normal');
      assert.equal(projectGeminiModel(cwd), 'gemini-4-neon');
      for (const dir of [cwd, home, downloads, extracted, newProject]) assert.equal(fs.existsSync(join(dir, '.codex')), false);
    });
  }
});

test('interactive setup chooses an unsaved mode before offering to install agy', async (t) => {
  for (const [lang, expected] of [['en', 'normal'], ['zh', 'turbo']]) {
    await t.test(lang, async (t) => {
      const questions = [];
      const log = t.mock.method(console, 'log', () => {});
      const saveRewriteMode = t.mock.fn();
      const ok = await showSetupGuidance({
        interactive: true,
        check: () => ({
          ...checks, ui_language: lang, rewrite_mode_configured: saveRewriteMode.mock.callCount() > 0,
          gemini_model_configured: false, blockers: ['agy_missing'], agy_available: false
        }),
        chooseMode(language) {
          assert.equal(language, lang);
          questions.push('mode');
          return expected;
        },
        saveRewriteMode,
        chooseModel: () => assert.fail('agy is unavailable'),
        install: () => assert.fail('the user declined the dependency installation'),
        prompt(message) {
          assert.match(message, /agy/i);
          questions.push('agy');
          return 'n';
        }
      });
      assert.equal(ok, true);
      assert.deepEqual(questions, ['mode', 'agy']);
      assert.deepEqual(saveRewriteMode.mock.calls.map(call => call.arguments), [[expected]]);
      assert.match(log.mock.calls.map(call => call.arguments.join(' ')).join('\n'), /--install-agy/);
    });
  }
});

test('interactive setup offers only missing defaults and cancellation leaves them unsaved', async () => {
  const fresh = { ...checks, rewrite_mode_configured: false, gemini_model_configured: false };
  for (const [options, status, expected] of [
    [{ interactive: false }, fresh, []],
    [{ dependencyOnly: true }, fresh, []],
    [{}, { ...fresh, rewrite_mode_configured: true }, ['model']],
    [{}, { ...fresh, gemini_model_configured: true }, ['mode']],
    [{}, fresh, ['mode', 'model']]
  ]) {
    const offered = [];
    const ok = await showSetupGuidance({
      interactive: true, ...options, check: () => status,
      chooseMode() { offered.push('mode'); return null; },
      chooseModel() { offered.push('model'); return null; },
      offerOpenAI() {},
      saveRewriteMode: () => assert.fail('no mode selected'),
      saveModel: () => assert.fail('no model selected'),
      prompt: () => assert.fail('unexpected text prompt')
    });
    assert.equal(ok, true);
    assert.deepEqual(offered, expected);
  }
});

test('interactive dependency prompts, opt-ins, browser consent, failure messaging and noninteractive behavior', async (t) => {
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
  async function setup({
    interactive = true,
    installDependency = false,
    dependencyOnly = false,
    missing = true,
    key = false,
    answer = 'y',
    failure = false
  } = {}) {
    let reads = 0,
      installs = 0,
      prompts = 0,
      opens = 0,
      installed = false;
    output.length = 0;
    const ok = await showSetupGuidance({
      interactive,
      installDependency,
      dependencyOnly,
      offerOpenAI() {},
      check() {
        reads++;
        return {
          ...checks,
          google_auth_method: key ? 'gemini-api-key' : 'existing-session',
          agy_available: !missing || installed,
          blockers: [...(missing && !installed ? ['agy_missing'] : []), ...(key ? ['gemini_key_missing'] : [])]
        };
      },
      async install() {
        installs++;
        if (failure) throw new Error('private error');
        installed = true;
      },
      prompt() {
        prompts++;
        return answer;
      },
      browse() {
        opens++;
        return false;
      }
    });
    return { ok, reads, installs, prompts, opens, text: output.join('\n') };
  }
  let result = await setup({ interactive: false });
  assert.match(result.text, /--install-agy/);
  assert.equal(result.prompts, 0);
  assert.equal(result.installs, 0);
  assert.equal(result.opens, 0);
  for (const answer of ['n', null]) {
    result = await setup({ answer });
    assert.equal(result.prompts, 1);
    assert.equal(result.installs, 0);
    assert.equal(result.ok, true);
  }
  result = await setup({ answer: '' });
  assert.deepEqual([result.reads, result.installs, result.prompts, result.opens], [2, 1, 1, 0]);
  assert.match(result.text, /agy is installed/);
  result = await setup({ key: true });
  assert.deepEqual([result.prompts, result.opens], [2, 1]);
  assert.match(result.text, /Visit https:\/\/aistudio.google.com/);
  for (const missing of [true, false]) {
    result = await setup({ installDependency: true, interactive: false, dependencyOnly: true, missing });
    assert.equal(result.installs, Number(missing));
    assert.equal(result.prompts, 0);
    assert.equal(result.ok, true);
    assert.ok(!result.text.includes('Explain what DNS'));
  }
  result = await setup({ installDependency: true, failure: true });
  assert.equal(result.ok, false);
  assert.ok(!result.text.includes('private error'));
  assert.match(result.text, /--install-agy/);
  output.length = 0;
  const unsupported = await showSetupGuidance({
    interactive: false, installDependency: true,
    check: () => ({ ...checks, agy_available: false, blockers: ['agy_unsupported'] }),
    install: () => assert.fail('unsupported existing agy must be updated')
  });
  assert.equal(unsupported, false);
  assert.match(output.join('\n'), /1\.2\.1 or later/);
  for (const requested of [false, true]) {
    output.length = 0;
    assert.equal(
      await showSetupGuidance({
        installDependency: requested,
        check() {
          throw new Error('private details');
        }
      }),
      !requested
    );
    assert.ok(!output.join('').includes('private details'));
  }
});
test('bootstrap uses the official HTTPS endpoint, removes credentials, verifies the executable and can retry', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codex-polish-agy-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bootstrap = join(base, 'bootstrap'),
    release = join(base, 'release');
  const installer = windows ? [
    'if ($env:OPENAI_API_KEY -or $env:GEMINI_API_KEY -or $env:BASH_ENV -or $env:ENV) { exit 3 }',
    "if ($args[0] -ne '--dir' -or $args[1] -ne (Join-Path (Join-Path $env:LOCALAPPDATA 'agy') 'bin')) { exit 2 }",
    "Copy-Item -LiteralPath (Join-Path $env:USERPROFILE 'release') -Destination (Join-Path $args[1] 'agy.exe')"
  ].join('\n') : [
    '[[ -z "$OPENAI_API_KEY$GEMINI_API_KEY$ENV$BASH_ENV" ]] || exit 3',
    '[[ "$1" == "--dir" && "$2" == "$HOME/.local/bin" ]] || exit 2',
    '/bin/cp "$HOME/release" "$2/agy" && /bin/chmod 700 "$2/agy"'
  ].join('\n');
  fs.writeFileSync(bootstrap, installer);
  const supported =
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/invocations"\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 2\necho "agy 1.2.1"\n';
  fs.writeFileSync(release, supported);
  const module = new URL('../scripts/install.mjs', import.meta.url).href;
  const code = `import { installAgy } from ${JSON.stringify(module)};
    import * as fs from 'node:fs';
    globalThis.fetch=async url=>{
      fs.appendFileSync(process.env.HOME+'/requests',String(url)+'\\n');
      if (process.env.FAIL_DOWNLOAD) return new Response(null,{status:302,headers:{location:'http://example.invalid/'}});
      return new Response(fs.readFileSync(process.env.HOME+'/bootstrap'));
    };
    await installAgy();`;
  const env = {
    ...homeEnv(base),
    PATH: base,
    LC_ALL: 'en',
    OPENAI_API_KEY: 'test',
    GEMINI_API_KEY: 'test',
    BASH_ENV: 'test',
    ENV: 'test'
  };
  const run = (extra = {}) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: base,
      env: { ...env, ...extra },
      encoding: 'utf8'
    });
  const binary = windows ? join(env.LOCALAPPDATA, 'agy/bin/agy.exe') : join(base, '.local/bin/agy');
  const endpoint = 'https://antigravity.google/cli/install.' + (windows ? 'ps1' : 'sh') + '\n';
  assert.notEqual(run({ FAIL_DOWNLOAD: '1' }).status, 0);
  assert.equal(fs.readFileSync(join(base, 'requests'), 'utf8'), endpoint);
  fs.writeFileSync(bootstrap, 'exit 0\n');
  assert.notEqual(run().status, 0);
  fs.writeFileSync(bootstrap, installer);
  fs.writeFileSync(release, supported.replace('1.2.1', '1.2.0'));
  assert.notEqual(run().status, 0);
  assert.ok(!fs.existsSync(binary));
  if (!windows) fs.unlinkSync(join(base, 'invocations'));
  fs.unlinkSync(join(base, 'requests'));
  if (windows) fs.copyFileSync(process.execPath, release);
  else fs.writeFileSync(release, supported);
  for (let i = 0; i < 2; i++) {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
  }
  if (windows) assert.equal(spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim(), process.version);
  else {
    assert.equal(fs.readFileSync(binary, 'utf8'), supported);
    assert.equal(fs.readFileSync(join(base, 'invocations'), 'utf8'), '--version\n--version\n');
  }
  assert.equal(fs.readFileSync(join(base, 'requests'), 'utf8'), endpoint);
  for (const version of ['1.2.0', '1.2.1-rc.1', 'unreadable']) {
    const outdated = supported.replace('1.2.1', version);
    fs.writeFileSync(binary, outdated);
    const existing = run();
    assert.notEqual(existing.status, 0);
    assert.match(existing.stderr, /1\.2\.1 or later/);
    assert.equal(fs.readFileSync(binary, 'utf8'), outdated);
    const report = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/install.mjs', import.meta.url)), 'doctor'], {
      cwd: base, env, encoding: 'utf8'
    });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /Antigravity CLI: requires version 1\.2\.1 or later/);
  }
  assert.equal(fs.readFileSync(join(base, 'requests'), 'utf8'), endpoint);
});
