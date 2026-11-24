// Keep the lock protocol in sync with the standalone Antigravity plugin.
import * as fs from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const { O_RDONLY, O_DIRECTORY } = fs.constants;

// Lock a stable directory. Process exit releases the kernel lock, including after an interrupted write.
export async function withLock(directory, action) {
  if (process.platform === 'darwin') {
    // Darwin's O_EXLOCK from <sys/fcntl.h> is not exported by node:fs.
    const O_EXLOCK = 0x20;
    let fd;
    for (;;) {
      try {
        fd = fs.openSync(directory, O_RDONLY | O_DIRECTORY | O_EXLOCK | fs.constants.O_NONBLOCK);
        break;
      } catch (error) {
        if (error.code !== 'EAGAIN') throw error;
        await sleep(50);
      }
    }
    try { return await action(); }
    finally { fs.closeSync(fd); }
  }

  // Both namespaces are kernel objects. No socket pathname or TCP port is used.
  const entry = fs.statSync(directory, { bigint: true });
  const name = `codex-polish-lock-${entry.dev}-${entry.ino}`;
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : '\0' + name;
  const server = createServer(socket => socket.destroy());
  for (;;) {
    try {
      const listening = once(server, 'listening');
      server.listen({ path: address, exclusive: true });
      await listening;
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      await sleep(50);
    }
  }
  try { return await action(); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function loadSQLite() {
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = function (message, type, ...rest) {
      if (type === 'ExperimentalWarning' && typeof message === 'string' &&
          message.startsWith('SQLite is an experimental feature')) return;
      return emitWarning.call(process, message, type, ...rest);
    };
    return process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

// An older installer may still hold its SQLite lock. Remove only the
// original, single-link empty file after releasing that lock.
export async function withExistingLock(file, action, remove, fail) {
  const entry = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!entry?.isFile() || entry.size !== 0n || entry.nlink !== 1n) return action();
  const { DatabaseSync } = loadSQLite();
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'rw');
  const db = new DatabaseSync(url.href);
  let result;
  try {
    try {
      db.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (![5, 6].includes(error.errcode)) throw error;
      throw fail('另一个安装程序正在运行，请等它结束后再试。', 'Another installer is running. Try again after it finishes.');
    }
    result = await action();
  } finally {
    db.close();
  }
  if (remove) {
    const current = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (current?.isFile() && current.size === 0n && current.nlink === 1n && current.ino === entry.ino &&
        (process.platform === 'win32' ? current.ino !== 0n && current.birthtimeNs === entry.birthtimeNs : current.dev === entry.dev)) {
      fs.unlinkSync(file);
    }
  }
  return result;
}
