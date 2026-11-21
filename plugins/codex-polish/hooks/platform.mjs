// Node cannot execute npm's Windows .cmd shims without a shell. Resolve the
// official JS entry point and pass every argument directly to Node instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const windows = process.platform === 'win32';

function localAppData(env) {
  return env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

export function agyDirectory(env = process.env) {
  return windows ? path.join(localAppData(env), 'agy', 'bin') : path.join(os.homedir(), '.local', 'bin');
}

export function executable(name, env = process.env) {
  const search = (env.PATH ?? env.Path ?? '').split(path.delimiter);
  if (name === 'agy') search.push(agyDirectory(env));
  if (windows && name === 'codex') {
    if (env.CODEX_INSTALL_DIR) search.push(env.CODEX_INSTALL_DIR);
    search.push(path.join(localAppData(env), 'Programs', 'OpenAI', 'Codex', 'bin'));
  }
  for (let directory of search) {
    if (windows) directory = directory.replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, name + (windows ? '.exe' : ''));
    if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return { command: file, args: [] };
      } catch { /* Search the next PATH entry. */ }
    }
    if (windows && name === 'codex' && fs.statSync(path.join(directory, 'codex.cmd'), { throwIfNoEntry: false })?.isFile()) {
      for (const prefix of [path.join(directory, 'node_modules'), path.dirname(directory)]) {
        const script = path.join(prefix, '@openai', 'codex', 'bin', 'codex.js');
        if (fs.statSync(script, { throwIfNoEntry: false })?.isFile()) return { command: process.execPath, args: [script] };
      }
    }
  }
  return null;
}

export function windowsSystemTool(relative) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', relative);
}

// Windows lacks O_NOFOLLOW. Compare the named entry with the opened file on
// both systems before returning its handle.
export function openRegular(file) {
  const expected = fs.lstatSync(file, { bigint: true });
  if (!expected.isFile()) throw Object.assign(new Error('Expected a regular file'), { code: 'EINVAL' });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const actual = fs.fstatSync(fd, { bigint: true });
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino)
      throw new Error('File changed while opening');
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
