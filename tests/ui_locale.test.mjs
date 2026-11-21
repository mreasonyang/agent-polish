import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { systemLanguage, language, LANGUAGE_FILE } from '../plugins/codex-polish/hooks/ui_locale.mjs';
import { makeProject, json, run, preferences, plugin } from './hook_fixture.mjs';

test('terminal locale precedence and unsupported fallback', () => {
  for (const [env, expected] of [
    [{ LANG: 'zh-Hans' }, 'zh'], [{ LANG: 'zh_TW.Big5' }, 'zh'],
    [{ LC_MESSAGES: 'en_GB.UTF-8', LANG: 'zh_CN' }, 'en'],
    [{ LC_ALL: 'ZH-Hant-HK', LC_MESSAGES: 'en', LANG: 'en_US' }, 'zh'],
    [{ LC_ALL: '', LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en' }, 'zh'],
    [{ LC_ALL: 'fr_FR.UTF-8', LANG: 'zh_CN' }, 'en'], [{ LC_ALL: 'C.UTF-8', LANG: 'zh_CN' }, 'en'], [{ LANG: 'POSIX' }, 'en'],
  ]) assert.equal(systemLanguage(env), expected);
});

test('desktop fallback selects the first supported Apple language and caches the lookup', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
  const original = childProcess.execFileSync;
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
  let index = 0;
  for (const [output, expected] of [['(\n "zh-Hans-CN",\n "en-US"\n)', 'zh'], ['("en-US", "zh-Hans")', 'en'],
    ['("fr-FR", "zh-Hant-TW")', 'zh'], ['("ja-JP")', 'en'], [null, 'en']]) {
    let calls = 0;
    childProcess.execFileSync = () => { calls++; if (output === null) throw new Error('defaults unavailable'); return output; };
    syncBuiltinESMExports();
    const fresh = await import('../plugins/codex-polish/hooks/ui_locale.mjs?case=' + index++);
    assert.equal(fresh.systemLanguage({}), expected);
    assert.equal(fresh.systemLanguage({}), expected);
    assert.equal(calls, 1);
  }
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
  assert.equal(systemLanguage({}), 'en');
});

test('Windows defaults to the system locale when the host provides no language override', t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  t.mock.method(Intl, 'DateTimeFormat', () => ({ resolvedOptions: () => ({ locale: 'zh-Hans-CN' }) }));
  assert.equal(systemLanguage({}), 'zh');
  assert.equal(systemLanguage({ LANG: 'en_US' }), 'en');
});

test('project language persists and auto uses environment without changing rewrite behavior', t => {
  const { check, cwd, call, env, project } = makeProject(t);
  const before = check();
  assert.deepEqual([before.language_mode, before.ui_language], ['auto', 'en']);
  assert.equal(fs.existsSync(path.join(cwd, '.codex')), false);
  const { file } = json(call(['set-language', 'zh'], { where: project }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'zh\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(check(), { ...before, language_mode: 'zh', ui_language: 'zh' });
  assert.match(call(['set-history-turns', '11']).stderr, /0 到 10 之间的整数/);
  const invalid = call(['set-language', 'jp']);
  assert.equal(invalid.status, 2);
  for (const text of ['无效', "'jp'", "'auto'", "'zh'", "'en'"]) assert.ok(invalid.stderr.includes(text));
  assert.match(call(['set-language', '--help']).stdout, /显示帮助/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'zh\n');
  assert.equal(json(call(['set-language', 'auto'])).ui_language, 'en');
  const override = check({ env: { ...env, LC_ALL: 'zh-Hant' } });
  assert.deepEqual([override.language_mode, override.ui_language], ['auto', 'zh']);
  assert.match(call(['set-history-turns', '11']).stderr, /whole number/);
  assert.equal(language(project, { LANG: 'en' }), 'en');
});

test('nested repositories, invalid and linked settings do not leak language', t => {
  const { call, project, cwd } = makeProject(t);
  json(call(['set-language', 'zh'], { where: project }));
  fs.writeFileSync(path.join(cwd, '.git'), '');
  assert.equal(language(cwd, { LANG: 'en' }), 'en');
  const file = path.join(cwd, '.codex', LANGUAGE_FILE);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'not-a-language');
  assert.equal(language(cwd, { LANG: 'zh_CN' }), 'zh');
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(project, '.codex', LANGUAGE_FILE), file);
  assert.equal(language(cwd, { LANG: 'en' }), 'en');
  assert.notEqual(call(['set-language', 'en']).status, 0);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
});

test('hook localizes reminder while preserving protocol fields', t => {
  const { call, project, cwd, env } = makeProject(t);
  json(call(['set-mode', 'auto'], { where: project }));
  for (const [lang, phrase, quiet] of [
    ['zh', '本项目已开启自动改写', /无需.*播报.*润色进度/],
    ['en', 'Automatic rewriting is on', /without progress announcements/],
  ]) {
    json(call(['set-language', lang], { where: project }));
    const output = json(run(preferences, ['hook'], { env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd }) })).hookSpecificOutput;
    assert.equal(output.hookEventName, 'UserPromptSubmit');
    assert.ok(output.additionalContext.includes(phrase));
    assert.match(output.additionalContext, quiet);
    assert.ok(output.additionalContext.includes(JSON.stringify(path.join(plugin, 'skills/codex-polish/WORKFLOW.md'))));
    assert.doesNotMatch(output.additionalContext, /codex-polish:codex-polish/);
  }
});
