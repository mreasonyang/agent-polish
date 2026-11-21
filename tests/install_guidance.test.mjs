import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { chooseSetupModel, chooseSetupMode, configurationSteps, showSetupGuidance, doctor } from '../scripts/install.mjs';
import { rewriteModeSettings } from '../plugins/codex-polish/hooks/rewrite_mode.mjs';
import { catalog } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_models.mjs';
import { makeProject, windows, homeEnv } from './hook_fixture.mjs';

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
  history_turns: 2,
  language_mode: 'auto'
};
test('bilingual setup and doctor distinguish auth, project model, history, decision checks and temporary service failures', () => {
  for (const lang of ['zh', 'en']) {
    const data = { ...checks, ui_language: lang };
    const summarize = (extra) => configurationSteps({ ...data, ...extra })[0].join('\n');
    assert.match(summarize({}), lang === 'en' ? /go straight to Gemini/ : /直接交给 Gemini/);
    assert.match(summarize({ openai_key_malformed: true }), /OPENAI_API_KEY/);
    const withOpenAI = summarize({ decisions_enabled: true });
    assert.match(
      withOpenAI,
      lang === 'en' ? /OpenAI uses only the current question, draft, and any custom polishing prompt/ : /OpenAI 只用本轮问题、草稿和已设置的自定义润色提示词/
    );
    assert.doesNotMatch(withOpenAI, /meaning|原意/);
    const turbo = { rewrite_mode: 'turbo', mode: 'manual' };
    const turboSummary = summarize(turbo);
    assert.match(turboSummary, lang === 'en' ? /Requested rewrites use Turbo/ : /点名润色会用 Turbo/);
    assert.doesNotMatch(turboSummary, /Set up OpenAI Decisions|配置 OpenAI Decisions/);
    const manualDoctor = doctor({ ...data, ...turbo });
    assert.match(manualDoctor, lang === 'en' ? /When to polish: only when asked/ : /润色时机：只在我要求时/);
    assert.match(manualDoctor, lang === 'en' ? /Automatic rewrite mode: turbo/ : /自动润色的改写模式：turbo/);
    for (const mode of ['manual', 'off']) {
      const saved = { mode, openai_key_configured: true, decisions_enabled: false };
      for (const summary of [summarize(saved), doctor({ ...data, ...saved })]) {
        assert.match(summary, lang === 'en' ? /configured OpenAI Decisions/ : /已配置的 OpenAI Decisions/);
        assert.doesNotMatch(summary, /Set up OpenAI Decisions|「配置 OpenAI Decisions」/);
      }
    }
    const invalidMode = { rewrite_mode: null, blockers: ['rewrite_mode_invalid'] };
    assert.match(summarize(invalidMode), lang === 'en' ? /rewrite mode is invalid/ : /改写模式无效/);
    assert.doesNotMatch(summarize(invalidMode), /go straight to Gemini|直接交给 Gemini/);
    assert.match(doctor(data), lang === 'en' ? /Gemini receives up to 2 earlier completed exchanges/ : /Gemini 改写时最多带上最近 2 轮完整问答/);
    assert.match(summarize({}), lang === 'en' ? /Explain what DNS does in one sentence\./ : /用一句话解释 DNS。/);
    assert.match(summarize({ mode: 'manual' }), lang === 'en' ? /then polish your reply/ : /再把你的回复润色一下/);
    assert.match(summarize({ mode: 'off' }), lang === 'en' ? /Switch to on-demand rewrites/ : /改回手动润色/);
    const enterprise = summarize({ google_auth_method: 'agent-platform' });
    assert.doesNotMatch(enterprise, /GEMINI_API_KEY|https:/);
    assert.match(enterprise, lang === 'en' ? /enterprise/ : /企业/);
    for (const [code, fragment] of [
      ['agy_missing', 'setup --install-agy'],
      ['unsupported_node', 'Node.js 22.16'],
      ['unsupported_google_auth', 'CODEX_POLISH_AGY_AUTH'],
      ['mode_invalid', 'codex-polish.mode'],
      ['history_turns_invalid', 'codex-polish.history-turns'],
      ['decisions_mode_invalid', 'codex-polish.decisions'],
      ['editor_prompt_link_unbound', lang === 'en' ? 'prompt link' : '提示词链接'],
      ['gemini_model_invalid', lang === 'en' ? 'Choose a rewrite model' : '选择改写模型']
    ]) {
      const [lines, pages] = configurationSteps({ ...data, blockers: [code] });
      assert.ok(lines.join('\n').includes(fragment));
      assert.deepEqual(pages, []);
    }
    for (const code of ['gemini_key_missing', 'gemini_key_invalid']) {
      const [lines, pages] = configurationSteps({ ...data, google_auth_method: 'gemini-api-key', blockers: [code] });
      assert.match(lines.join('\n'), /GEMINI_API_KEY/);
      assert.deepEqual(pages, ['https://aistudio.google.com/apikey']);
    }
    for (const mode of ['off', 'auto']) {
      const report = doctor({
        ...data,
        decisions_mode: mode,
        decisions_enabled: mode === 'auto',
        google_auth_method: 'gemini-api-key',
        gemini_key_configured: true,
        history_turns: 0,
        gemini_model: 'gemini-4-argon'
      });
      for (const detail of ['Node.js 22.16+', 'gemini-4-argon']) assert.ok(report.includes(detail));
      assert.match(report, lang === 'en' ? /History is off/ : /历史记录设为 0/);
      assert.ok(!report.includes('api_timeout'));
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
      const selection = chooseSetupMode('/project', lang, input, output);
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
  const selection = chooseSetupMode('/project', 'en', input, output);
  input.destroy();
  assert.equal(await selection, null);
  output.destroy();
});

test('model picker accepts arrows, looks up only on request and preserves provider IDs', async t => {
  const enter = '\r', down = '\x1b[B';
  for (const [keys, lang, expected, calls] of [
    [[enter], 'en', 'gemini-4-hydrogen', 0],
    [[down, enter, '2', down, enter], 'zh', 'gemini-4-argon', 1],
    [[down, enter, '\x03'], 'en', null, 1],
    [[down, enter], 'en', null, 1]
  ]) {
    const input = new PassThrough(), output = new PassThrough();
    input.setRawMode = enabled => { input.isRaw = enabled; };
    const discover = t.mock.fn(() => keys.length === 2 ? [] : [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { id: 'gemini-4-argon', name: 'Gemini 4 Argon / Preview: (Auto)\x1b[9m' }
    ]);
    let display = '';
    output.on('data', bytes => { display += bytes.toString(); });
    const selection = chooseSetupModel(checks, lang, input, output, discover);
    for (const key of keys) { await setImmediate(); input.write(key); }
    assert.equal(await selection, expected);
    if (expected === 'gemini-4-argon') {
      assert.ok(display.includes('Gemini 4 Argon / Preview: (Auto)\\u001b[9m'));
      assert.ok(!display.includes('\x1b[9m'));
    }
    assert.equal(discover.mock.callCount(), calls);
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
  const discover = () => catalog([{ category: 'model', type: 'select', id: 'model', currentValue: 'gemini-first', options: choices }]).models;
  const selection = chooseSetupModel(checks, 'en', input, output, discover);
  for (const key of ['\x1b[B', '\r', '\x1b[B', '\r']) { await setImmediate(); input.write(key); }
  assert.equal(await selection, 'gemini-second');
  assert.ok(display.includes('Gemini Pro (gemini-first)'));
  assert.ok(display.includes('Gemini Pro (gemini-second)'));
  input.destroy(); output.destroy();
});

test('first setup from a subdirectory saves the model once for the whole repository', async t => {
  const { project, cwd, check } = makeProject(t);
  t.mock.method(console, 'log', () => {});
  const chooseModel = t.mock.fn(() => 'gemini-4-argon');
  const setup = where => showSetupGuidance({
    cwd: where, interactive: true, check: dir => ({ ...check({ where: dir }), agy_available: true, blockers: [] }),
    chooseMode: () => 'normal', chooseModel, prompt: () => assert.fail('unexpected question')
  });
  await setup(cwd);
  assert.equal(check({ where: project }).gemini_model, 'gemini-4-argon');
  await setup(project);
  assert.equal(chooseModel.mock.callCount(), 1);
  assert.equal(fs.existsSync(join(cwd, '.codex')), false);
});

test('first interactive setup chooses a mode before agy, saves it and refreshes its guidance', async (t) => {
  for (const [lang, expected] of [['en', 'normal'], ['zh', 'turbo']]) {
    await t.test(lang, async (t) => {
      const { project, cwd } = makeProject(t);
      const transcript = [], questions = [], reads = [];
      t.mock.method(console, 'log', (line) => transcript.push(line));
      const ok = await showSetupGuidance({
        cwd: project,
        interactive: true,
        check(where) {
          reads.push(where);
          return { ...checks, ...rewriteModeSettings(where), ui_language: lang, blockers: ['agy_missing'], agy_available: false };
        },
        chooseMode(where, language) {
          assert.equal(where, project);
          assert.equal(language, lang);
          questions.push('mode');
          return expected;
        },
        install: () => assert.fail('the user declined the dependency installation'),
        prompt(message) {
          assert.match(message, /agy/i);
          questions.push('agy');
          return 'n';
        }
      });
      assert.equal(ok, true);
      assert.deepEqual(questions, ['mode', 'agy']);
      assert.deepEqual(reads, [project, project]);
      assert.equal(fs.readFileSync(join(project, '.codex/codex-polish.rewrite-mode'), 'utf8'), expected + '\n');
      assert.deepEqual(rewriteModeSettings(cwd), { rewrite_mode: expected, rewrite_mode_configured: true });
      assert.match(transcript.at(-1), expected === 'normal' ? /go straight to Gemini/ : /Turbo 会跳过 OpenAI 检查/);
    });
  }
});

test('inherited modes, invalid settings, noninteractive and dependency-only setup skip mode selection', async (t) => {
  const { project, cwd } = makeProject(t);
  const setting = join(project, '.codex/codex-polish.rewrite-mode');
  const chooseMode = t.mock.fn(() => null), saveRewriteMode = t.mock.fn();
  t.mock.method(console, 'log', () => {});
  const setup = (options = {}) => showSetupGuidance({
    cwd, interactive: true, chooseMode, saveRewriteMode,
    prompt: () => assert.fail('unexpected text prompt'),
    check: (where) => ({ ...checks, ...rewriteModeSettings(where) }), ...options
  });
  await setup({ interactive: false });
  await setup({ dependencyOnly: true });
  for (const value of ['normal', 'turbo', 'invalid']) {
    fs.writeFileSync(setting, value + '\n');
    await setup();
    assert.equal(fs.readFileSync(setting, 'utf8'), value + '\n');
  }
  assert.equal(chooseMode.mock.callCount(), 0);
  fs.unlinkSync(setting);
  await setup();
  assert.equal(chooseMode.mock.callCount(), 1, 'a cancelled choice leaves the project unconfigured');
  assert.equal(saveRewriteMode.mock.callCount(), 0);
  assert.equal(fs.existsSync(join(cwd, '.codex')), false);
});

test('setup outside a project lets the user defer or choose a project directory', async (t) => {
  const { project } = makeProject(t);
  const fresh = { ...checks, rewrite_mode_configured: false };
  const saveRewriteMode = t.mock.fn(), chooseMode = t.mock.fn(() => 'normal');
  t.mock.method(console, 'log', () => {});
  for (const [cwd, answer] of [[homedir(), ''], [parse(homedir()).root, null], [join(homedir(), 'Downloads'), '']]) {
    const prompt = t.mock.fn(() => answer);
    await showSetupGuidance({ cwd, interactive: true, check: () => fresh, saveRewriteMode, chooseMode, prompt });
    assert.equal(prompt.mock.callCount(), 1);
    assert.equal(chooseMode.mock.callCount(), 0);
    assert.equal(saveRewriteMode.mock.callCount(), 0);
  }
  const answers = [join(project, 'missing'), homedir(), parse(homedir()).root, project];
  await showSetupGuidance({
    cwd: homedir(), interactive: true,
    check: (where) => ({
      ...fresh, rewrite_mode_configured: saveRewriteMode.mock.calls.some(call => call.arguments[1] === where)
    }),
    saveRewriteMode, chooseMode,
    prompt() {
      assert.ok(answers.length, 'unexpected prompt');
      return answers.shift();
    }
  });
  assert.deepEqual(answers, []);
  assert.deepEqual(chooseMode.mock.calls.map(call => call.arguments), [[project, 'en']]);
  assert.deepEqual(saveRewriteMode.mock.calls.map(call => call.arguments), [['normal', project]]);
});

test('interactive dependency prompts, opt-ins, browser consent, failure messaging and noninteractive behavior', async (t) => {
  const { project } = makeProject(t);
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
      cwd: project,
      interactive,
      installDependency,
      dependencyOnly,
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
  assert.match(result.text, /Your local setup checks out/);
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
    "if ($args[0] -ne '--dir' -or $args[1] -ne (Join-Path $env:LOCALAPPDATA 'agy/bin')) { exit 2 }",
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
