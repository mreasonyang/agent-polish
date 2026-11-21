// Pages contain the final rendered Markdown. This socket never connects to ACP.
import fs from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';
import { checkPrivatePath, exchange, listenPrivate, windowsCommand } from './acp_windows_io.mjs';
import { fileURLToPath } from 'node:url';
import { isMain, readLimited } from './cli_io.mjs';

const pageBytes = 6144;
const idleMs = 5 * 60_000;
const self = fileURLToPath(import.meta.url);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function command(socket, offset, directory) {
  if (process.platform === 'win32') return { ...windowsCommand([process.execPath, self, socket, String(offset)], directory), max_output_tokens: 8192 };
  return { cmd: [process.execPath, self, socket, String(offset)].map(quote).join(' '),
    workdir: directory, shell: '/bin/sh', login: false, max_output_tokens: 8192 };
}

function pageAt(text, start) {
  if (!Number.isSafeInteger(start) || start < 0 || start >= text.length) throw Error('invalid_page');
  if (start && /[\uD800-\uDBFF]/.test(text[start - 1]) && /[\uDC00-\uDFFF]/.test(text[start])) throw Error('invalid_page');
  let offset = start;
  let bytes = 0;
  for (const character of text.slice(start)) {
    // Budget the actual JSON representation, including control-character escapes.
    bytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > pageBytes) break;
    offset += character.length;
  }
  return { text: text.slice(start, offset), next: offset === text.length ? null : offset };
}

export async function answerEvent(text, directory = process.cwd(), { onDrained } = {}) {
  if (text.length <= pageBytes && Buffer.byteLength(JSON.stringify(text)) <= pageBytes + 2)
    return { event: 'delivery', markdown: text };

  function drained() {
    const notify = onDrained;
    onDrained = undefined;
    notify?.();
  }
  if (process.platform === 'win32') {
    checkPrivatePath(directory);
    const pages = await listenPrivate((offset, afterFlush) => {
      const page = pageAt(text, offset);
      expiry.refresh();
      if (page.next === null) afterFlush(() => { pages.server.unref(); drained(); });
      return page;
    });
    const expiry = setTimeout(() => { pages.close(); drained(); }, idleMs).unref();
    return { event: 'answer_pages', exec: command(pages.endpoint, 0, dirname(directory)), utf8_bytes: Buffer.byteLength(text) };
  }

  const info = fs.statSync('.');
  if (fs.realpathSync(directory) !== fs.realpathSync('.') || info.uid !== process.getuid() || (info.mode & 0o077))
    throw Error('invalid_answer_directory');
  // libuv unlinks its original bind path when a server closes. Removing this
  // temporary path component lets us check the exported socket's inode ourselves.
  const guard = fs.mkdtempSync('.acp-answer-');
  const socketPath = guard + '.sock';
  const server = net.createServer({ allowHalfOpen: true }, client => {
    client.on('error', () => {});
    client.setTimeout(10_000, () => client.destroy());
    let raw = '';
    client.setEncoding('utf8');
    client.on('data', chunk => {
      if (raw.length + chunk.length > 16) return client.destroy();
      raw += chunk;
    });
    client.once('end', () => {
      try {
        if (!/^(0|[1-9]\d*)$/.test(raw)) throw Error('invalid_page');
        const page = pageAt(text, Number(raw));
        timer.refresh();
        client.end(JSON.stringify(page), error => {
          // Keep pages repeatable while the host is active. Once the last page
          // has flushed, the socket alone need not keep a finished observer alive.
          if (!error && page.next === null) {
            server.unref();
            drained();
          }
        });
      } catch { client.destroy(); }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen('./' + guard + '/../' + socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally { fs.rmdirSync(guard); }

  const owned = fs.lstatSync(socketPath, { bigint: true });
  const signals = new Map();
  function unlinkOwned() {
    const current = fs.lstatSync(socketPath, { bigint: true, throwIfNoEntry: false });
    if (current?.isSocket() && current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(socketPath);
  }
  function close() {
    clearTimeout(timer);
    server.off('error', abandon);
    process.off('exit', unlinkOwned);
    for (const [signal, handler] of signals) process.off(signal, handler);
    server.close();
    unlinkOwned();
  }
  function abandon() {
    try { close(); }
    finally { drained(); }
  }
  // An abandoned completed result expires even if the provider already exited.
  const timer = setTimeout(abandon, idleMs).unref();
  server.once('error', abandon);
  process.once('exit', unlinkOwned);
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    const handler = () => {
      close();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    signals.set(signal, handler);
    process.once(signal, handler);
  }
  return { event: 'answer_pages', exec: command(socketPath, 0, directory), utf8_bytes: Buffer.byteLength(text) };
}

if (isMain(import.meta.url)) {
  try {
    const [socketPath, rawOffset] = process.argv.slice(2);
    if (!/^(0|[1-9]\d*)$/.test(rawOffset)) throw Error('invalid_page');
    let page;
    if (process.platform === 'win32') page = await exchange(socketPath, Number(rawOffset), pageBytes + 128);
    else {
      if (!/^\.acp-answer-[A-Za-z0-9]{6}\.sock$/.test(socketPath)) throw Error('invalid_page');
      const client = net.createConnection(socketPath);
      client.setTimeout(10_000, () => client.destroy(new Error('page_timeout')));
      client.end(rawOffset);
      page = JSON.parse((await readLimited(client, pageBytes + 128)).toString('utf8'));
    }
    if (typeof page.text !== 'string' || !page.text || (page.next !== null &&
        (!Number.isSafeInteger(page.next) || page.next !== Number(rawOffset) + page.text.length))) throw Error('invalid_page');
    console.log(JSON.stringify({ event: 'answer_page', text: page.text,
      next: page.next === null ? null : command(socketPath, page.next, process.cwd()) }));
  } catch { process.exitCode = 1; }
}
