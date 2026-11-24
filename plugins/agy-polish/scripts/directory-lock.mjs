import * as fs from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

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
