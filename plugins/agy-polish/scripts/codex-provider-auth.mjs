import { spawn } from 'node:child_process';
import { isAbsolute, sep } from 'node:path';

const windows = process.platform === 'win32';

export async function readProviderBearer(config, { cwd: workspace, signal, timeout }) {
  const { command, args = [], timeout_ms: commandTimeout = 5_000 } = config;
  const cwd = config.cwd ?? workspace;
  signal?.throwIfAborted();
  const pathCommand = command.includes('/') || (windows && command.includes('\\'));
  const program = pathCommand && !isAbsolute(command) ? cwd + sep + command : command;
  // Inherit the native environment. Only stdout carries the credential.
  const child = spawn(program, args, {
    cwd, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));

  const success = await new Promise((resolve) => {
    function finish(success) {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', terminate);
      resolve(success);
    }

    function terminate() {
      try {
        if (windows) child.kill('SIGKILL');
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The helper may have exited before cancellation reached it.
      }
      child.stdout.destroy();
      finish(false);
    }

    const deadline = setTimeout(terminate, Math.min(commandTimeout, timeout, 2_147_483_647));
    signal?.addEventListener('abort', terminate, { once: true });
    child.once('error', () => finish(false));
    child.stdout.once('error', terminate);
    child.once('close', (code) => finish(code === 0));
  });

  if (success) {
    let token;
    try {
      const output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
      token = output.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    } catch {
      // An invalid UTF-8 response is an authentication failure.
    }
    // Codex omits Authorization if the value contains invalid HTTP header bytes.
    if (token && !/[\x00-\x08\x0a-\x1f\x7f]/u.test(token)) return token;
  }
  throw new Error('Provider auth command did not return a usable bearer token');
}
