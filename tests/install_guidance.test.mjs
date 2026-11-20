import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { configurationSteps, showSetupGuidance, doctor } from '../scripts/install.mjs';

const checks = {
  ui_language: 'en',
  blockers: [],
  mode: 'auto',
  google_auth_method: 'existing-session',
  decisions_mode: 'auto',
  decisions_enabled: false,
  agy_available: true,
  codex_available: true,
  node_available: true,
  gemini_model: 'gemini-4-hydrogen',
  history_turns: 2,
  language_mode: 'auto',
  cooldown: null
};
test('bilingual setup and doctor distinguish auth, project model, history, decision checks and temporary service failures', () => {
  for (const lang of ['zh', 'en']) {
    const data = { ...checks, ui_language: lang };
    const summarize = (extra) => configurationSteps({ ...data, ...extra })[0].join('\n');
    assert.match(summarize({}), lang === 'en' ? /go straight to Gemini/ : /直接交给 Gemini/);
    assert.match(summarize({}), lang === 'en' ? /Explain what DNS does in one sentence\./ : /用一句话解释 DNS。/);
    assert.match(summarize({ mode: 'manual' }), lang === 'en' ? /then polish your reply/ : /再把你的回复润色一下/);
    assert.match(summarize({ mode: 'off' }), lang === 'en' ? /Switch to on-demand rewrites/ : /改回手动润色/);
    const enterprise = summarize({ google_auth_method: 'agent-platform' });
    assert.doesNotMatch(enterprise, /GEMINI_API_KEY|https:/);
    assert.match(enterprise, lang === 'en' ? /enterprise/ : /企业/);
    for (const [code, fragment] of [
      ['openai_key_invalid', 'OPENAI_API_KEY'],
      ['agy_missing', 'setup --install-agy'],
      ['unsupported_node', 'Node.js 22.16'],
      ['unsupported_google_auth', 'CODEX_POLISH_AGY_AUTH'],
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
        gemini_model: 'gemini-4-argon',
        cooldown: { reason: 'api_timeout', remaining_seconds: 12 }
      });
      for (const detail of ['Node.js 22.16+', 'gemini-4-argon', '12']) assert.ok(report.includes(detail));
      assert.match(report, lang === 'en' ? /History is off/ : /历史记录设为 0/);
      assert.ok(!report.includes('api_timeout'));
    }
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
  const installer = [
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
    HOME: base,
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
  const binary = join(base, '.local/bin/agy');
  assert.notEqual(run({ FAIL_DOWNLOAD: '1' }).status, 0);
  assert.equal(fs.readFileSync(join(base, 'requests'), 'utf8'), 'https://antigravity.google/cli/install.sh\n');
  fs.writeFileSync(bootstrap, 'exit 0\n');
  assert.notEqual(run().status, 0);
  fs.writeFileSync(bootstrap, installer);
  fs.writeFileSync(release, supported.replace('1.2.1', '1.2.0'));
  assert.notEqual(run().status, 0);
  assert.ok(!fs.existsSync(binary));
  fs.unlinkSync(join(base, 'invocations'));
  fs.unlinkSync(join(base, 'requests'));
  fs.writeFileSync(release, supported);
  for (let i = 0; i < 2; i++) {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fs.readFileSync(binary, 'utf8'), supported);
  assert.equal(fs.readFileSync(join(base, 'invocations'), 'utf8'), '--version\n');
  assert.equal(fs.readFileSync(join(base, 'requests'), 'utf8'), 'https://antigravity.google/cli/install.sh\n');
});
