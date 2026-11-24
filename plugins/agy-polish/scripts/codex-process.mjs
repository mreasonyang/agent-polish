import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

const windows = process.platform === 'win32';

export function fileLoginExists(codexHome) {
  if (typeof codexHome !== 'string' || !isAbsolute(codexHome)) throw new Error('Native Codex home unavailable');
  const file = statSync(join(codexHome, 'auth.json'), { throwIfNoEntry: false });
  if (file && !file.isFile()) throw new Error('Invalid Codex credential file');
  return Boolean(file);
}

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function windowsNpmBinary(directory) {
  if (!executable(join(directory, 'codex.cmd'))) return;
  const entry = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!executable(entry)) return;
  const shim = realpathSync(entry);
  const require = createRequire(shim);
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const roots = [dirname(dirname(shim))];
  try {
    roots.unshift(dirname(require.resolve(`@openai/codex-win32-${process.arch}/package.json`)));
  } catch {
    // Older npm packages included the native binary in the main package.
  }
  for (const root of roots) {
    for (const folder of ['bin', 'codex']) {
      const file = join(root, 'vendor', target, folder, 'codex.exe');
      if (executable(file)) return file;
    }
  }
}

function findCodex() {
  const paths = (process.env.PATH ?? process.env.Path ?? '').split(delimiter);
  paths.push(process.env.CODEX_INSTALL_DIR, join(homedir(), '.local', 'bin'));
  if (windows) {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    paths.push(join(local, 'Programs', 'OpenAI', 'Codex', 'bin'));
  }
  for (const path of paths) {
    const directory = windows ? path?.replace(/^"(.*)"$/, '$1') : path;
    if (!directory || !isAbsolute(directory)) continue;
    const file = join(directory, windows ? 'codex.exe' : 'codex');
    if (executable(file)) return file;
    if (windows) {
      const native = windowsNpmBinary(directory);
      if (native) return native;
    }
  }
  throw new Error('Codex CLI unavailable');
}

export async function withWorkspace(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'agy-polish-'));
  try {
    const cwd = join(directory, 'workspace');
    await mkdir(cwd);
    return await operation({ directory, cwd });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function configArguments(settings) {
  return settings.flatMap((setting) => ['-c', setting]);
}

export function startCodex(args, cwd, { signal, timeout, env = process.env, captureOutput = false }) {
  signal?.throwIfAborted();
  const child = spawn(findCodex(), args, {
    cwd,
    env: { ...env, RUST_LOG: 'off', RUST_BACKTRACE: '0' },
    detached: !windows,
    windowsHide: true,
    stdio: ['pipe', captureOutput ? 'pipe' : 'ignore', 'ignore']
  });
  let aborted = false;
  let failed = false;
  let stopping = false;
  let finished = false;
  let escalation;
  const sentSignals = new Set();

  function killGroup(signalName) {
    if (!child.pid) return;
    const running = child.exitCode === null && child.signalCode === null;
    let sent;
    try {
      sent = windows ? child.kill(signalName) : process.kill(-child.pid, signalName);
    } catch (error) {
      if (error.code !== 'ESRCH') sent = child.kill(signalName);
    }
    if (sent && running) sentSignals.add(signalName);
  }

  function stop() {
    if (stopping || finished) return;
    stopping = true;
    clearTimeout(deadline);
    child.stdin.destroy();
    if (windows) killGroup('SIGKILL');
    else {
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), 350);
    }
  }

  function terminate() {
    aborted = true;
    stop();
  }

  const deadline = setTimeout(terminate, timeout);
  signal?.addEventListener('abort', terminate, { once: true });
  child.on('error', () => { failed = true; });
  child.stdin.on('error', () => { if (!stopping) failed = true; });
  const closed = new Promise((resolve) => {
    child.once('close', (code, exitSignal) => {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', terminate);
      // A launcher may have exited from SIGTERM while a descendant still has work.
      if (stopping && !windows) killGroup('SIGKILL');
      resolve(!aborted && !failed && (code === 0 || sentSignals.has(exitSignal)));
    });
  });
  return { child, closed, stop };
}
