import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { homeEnv, windows } from './hook_fixture.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const reversePlugin = join(root, 'plugins', 'agy-polish');
const fakeCli = fileURLToPath(new URL('./fixture_host_cli.mjs', import.meta.url));

export function write(file, body) {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

export function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function isolatedHosts(t, { codex = true, agy = false, scenario = 'success', reply = '' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codex-polish-host-')));
  const cleanups = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup();
    } finally {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 4 });
    }
  });
  const home = join(base, '隔离 Home');
  const profile = join(base, 'Codex Profile');
  const reverseSettings = join(base, 'Antigravity Preferences');
  const workspace = join(base, '用户 workspace');
  const bin = join(base, 'bin');
  const log = join(base, 'cli.jsonl');
  for (const directory of [bin, home, profile, workspace]) fs.mkdirSync(directory);
  const env = {
    ...homeEnv(home),
    PATH: bin,
    CODEX_HOME: profile,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    TMPDIR: base, TEMP: base, TMP: base,
    CODEX_POLISH_AGY_SETTINGS_DIR: reverseSettings,
    LC_ALL: 'en_US.UTF-8',
    POLISH_TEST_CLI_LOG: log,
    POLISH_TEST_SCENARIO: scenario,
    POLISH_TEST_REPLY: reply
  };
  if (!windows) {
    fs.symlinkSync(process.execPath, join(bin, 'node'));
    for (const [name, enabled] of [['codex', codex], ['agy', agy]]) {
      if (!enabled) continue;
      const wrapper = join(bin, name);
      write(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeCli)} ${name} "$@"\n`);
      fs.chmodSync(wrapper, 0o755);
    }
  }
  const records = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : [];
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      env, cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, ...options
    });
    assert.ifError(result.error);
    return result;
  };
  const onCleanup = fn => cleanups.push(fn);
  return { base, home, profile, reverseSettings, workspace, env, records, run, onCleanup };
}

export const settingsModule = new URL('../plugins/agy-polish/scripts/settings.mjs', import.meta.url).href;

export function withSettings(fixture, code, values = [], env = fixture.env) {
  const result = fixture.run(process.execPath, ['--input-type=module', '-e',
    `import * as settings from ${JSON.stringify(settingsModule)}; ${code}`, ...values], { env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

export async function until(read, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value) return value;
    assert.ok(Date.now() < deadline, typeof message === 'function' ? message() : message);
    await sleep(15);
  }
}
