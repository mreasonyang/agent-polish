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

function available(file, mode = fs.constants.F_OK) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, mode);
    return true;
  } catch { return false; }
}

export function executable(name, env = process.env) {
  const search = (env.PATH ?? env.Path ?? (windows ? '' : '/bin:/usr/bin')).split(path.delimiter);
  if (name === 'agy') search.push(agyDirectory(env));
  if (windows && name === 'codex') {
    if (env.CODEX_INSTALL_DIR) search.push(env.CODEX_INSTALL_DIR);
    search.push(path.join(localAppData(env), 'Programs', 'OpenAI', 'Codex', 'bin'));
  }
  for (let directory of search) {
    if (windows) directory = directory.replace(/^"(.*)"$/, '$1');
    if (windows && !path.isAbsolute(directory)) continue;
    const file = path.resolve(directory, name + (windows ? '.exe' : ''));
    if (available(file, fs.constants.X_OK)) return { command: file, args: [] };
    if (windows && name === 'codex' && available(path.join(directory, 'codex.cmd'))) {
      for (const prefix of [path.join(directory, 'node_modules'), path.dirname(directory)]) {
        const script = path.join(prefix, '@openai', 'codex', 'bin', 'codex.js');
        if (available(script)) return { command: process.execPath, args: [script] };
      }
    }
  }
  return null;
}

export function windowsSystemTool(relative) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', relative);
}

// libuv's Windows path and handle stat calls can report different volume
// serials (or zero). The NTFS file index and creation time are shared by both.
export function sameEntry(a, b) {
  if (a.ino !== b.ino) return false;
  if (!windows) return a.dev === b.dev;
  return a.ino !== 0n && a.birthtimeNs === b.birthtimeNs;
}

// Windows lacks O_NOFOLLOW. Compare the named entry with the opened file on
// both systems before returning its handle.
export function openRegular(file) {
  const expected = fs.lstatSync(file, { bigint: true });
  if (!expected.isFile()) throw Object.assign(new Error('Expected a regular file'), { code: 'EINVAL' });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const actual = fs.fstatSync(fd, { bigint: true });
    if (!actual.isFile() || !sameEntry(actual, expected))
      throw new Error('File changed while opening');
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

// MoveFileExW can briefly reject replacement while another process has the
// destination open without delete sharing. Keep the completed source intact and
// recheck the destination on every attempt. Never unlink the old setting first.
export function replaceSettingFile(source, target) {
  const staged = windows ? fs.lstatSync(source, { bigint: true }) : null;
  for (let delay = 5; ; delay *= 2) {
    try {
      const current = fs.lstatSync(target, { throwIfNoEntry: false });
      if (current && !current.isFile())
        throw Object.assign(new Error('invalid setting'), { code: 'EINVAL' });
      fs.renameSync(source, target);
      return;
    } catch (error) {
      // These are the only two filesystem operations in this try block.
      // Node can report absolute error paths for relative Windows arguments.
      const inspectingTarget = error.syscall === 'lstat';
      const replacingTarget = error.syscall === 'rename';
      const retryable = ['EBUSY', 'EPERM', 'EACCES'].includes(error.code) ||
        (replacingTarget && error.code === 'ENOENT');
      if (!windows || delay > 320 || !(inspectingTarget || replacingTarget) || !retryable) throw error;
      const current = fs.lstatSync(source, { bigint: true, throwIfNoEntry: false });
      if (!current?.isFile() || !sameEntry(current, staged)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}
