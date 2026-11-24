import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { agyDirectory, agyExecutable, compareVersions, windows, windowsSystemTool } from './installer_common.mjs';
import { withExistingLock, withLock } from './installer_lock.mjs';

export const AGY_INSTALL = 'https://antigravity.google/docs/getting-started/?tab=cli';
const AGY_BOOTSTRAP = 'https://antigravity.google/cli/install.' + (windows ? 'ps1' : 'sh');

const statMaybe = path => fs.lstatSync(path, { throwIfNoEntry: false });

async function runBootstrap(script, target, options, fail) {
  const shell = windows ? windowsSystemTool('WindowsPowerShell/v1.0/powershell.exe') : '/bin/bash';
  const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] : [];
  const proc = spawn(shell, [...args, script, '--dir', target], { ...options, stdio: 'ignore', detached: !windows, windowsHide: true });
  function killGroup() {
    if (proc.pid) {
      try {
        if (windows) {
          spawnSync(windowsSystemTool('taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          proc.kill('SIGKILL');
        } else process.kill(-proc.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  const timer = setTimeout(killGroup, 180_000);
  process.once('SIGINT', killGroup);
  process.once('SIGTERM', killGroup);
  try {
    const status = await new Promise((done, reject) => proc.once('error', reject).once('close', done));
    if (status !== 0) throw fail('Google 的安装程序没有完成。', 'Google’s installer didn’t finish.');
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', killGroup);
    process.off('SIGTERM', killGroup);
  }
}
async function downloadBootstrap(file, fail) {
  const signal = AbortSignal.timeout(30_000);
  let url = new URL(AGY_BOOTSTRAP);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { signal, redirect: 'manual' });
    if (response.ok && response.body) {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), {
        signal
      });
      return;
    }
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
    url = new URL(location, url);
    if (url.protocol !== 'https:') break;
  }
  throw fail('从 Google 下载 agy 失败。', 'Could not download agy from Google.');
}
function agyEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['OPENAI_API_KEY', 'GEMINI_API_KEY', 'BASH_ENV', 'ENV'].includes(key.toUpperCase())) delete env[key];
  }
  return env;
}
export function supportedAgy(binary) {
  const result = spawnSync(binary, ['--version'], {
    env: agyEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000, maxBuffer: 16 * 1024, killSignal: 'SIGKILL'
  });
  const version = result.status === 0 && /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)(?=\s|$)/.exec(result.stdout);
  return Boolean(version && compareVersions(version[1], '1.2.1', () => new Error('Invalid agy version')) >= 0);
}
export async function installAgyBootstrap(fail) {
  const target = agyDirectory();
  fs.mkdirSync(target, { recursive: true });
  await withLock(target, () => withExistingLock(join(target, '.codex-polish-agy.sqlite'), async () => {
    const existing = agyExecutable()?.command;
    if (existing) {
      if (supportedAgy(existing)) return;
      throw fail('请将现有的 Antigravity CLI 更新到 1.2.1 或更高版本。', 'Update your existing Antigravity CLI to version 1.2.1 or later.');
    }
    const binary = join(target, windows ? 'agy.exe' : 'agy');
    if (statMaybe(binary))
      throw fail(`请先检查 ${binary}，这个路径已被占用。`, `Check ${binary}. That path is already in use.`);
    const temp = fs.mkdtempSync(join(tmpdir(), 'codex-polish-agy-')),
      script = join(temp, windows ? 'install.ps1' : 'install.sh');
    const options = { cwd: temp, env: agyEnvironment() };
    try {
      await downloadBootstrap(script, fail);
      try {
        await runBootstrap(script, target, options, fail);
        if (!supportedAgy(binary))
          throw fail('需要 Antigravity CLI 1.2.1 或更新版。', 'Antigravity CLI 1.2.1 or later is required.');
      } catch (error) {
        if (statMaybe(binary) && !fs.lstatSync(binary).isDirectory()) fs.unlinkSync(binary);
        throw error;
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, true, fail));
}
