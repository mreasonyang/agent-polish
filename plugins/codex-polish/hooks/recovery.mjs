// Private storage for the current thread’s transcript pointer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

export const APPLICATION_ID = 0x43504f4c;
const hash = value => createHash('sha256').update(value).digest('hex');

function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute));
  }
}

function profile() {
  return canonicalPath(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

export function cacheScope(scope) {
  if (typeof scope !== 'string' || !path.isAbsolute(scope)) throw new Error('invalid scope');
  return hash(profile() + '\0' + canonicalPath(scope));
}

export function databasePath() {
  let base = process.env.XDG_CACHE_HOME || '';
  if (!path.isAbsolute(base)) base = path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache');
  return path.join(base, 'codex-polish', `runtime-${hash(profile()).slice(0, 16)}.sqlite3`);
}

let sqlite;
export function sqliteModule() {
  if (sqlite) return sqlite;
  // Some supported Node releases print a one-time experimental warning when
  // loading this builtin. CLI diagnostics must never pollute the hook protocol.
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = function (message, type, ...rest) {
      if (type === 'ExperimentalWarning' && typeof message === 'string' && message.startsWith('SQLite is an experimental feature')) return;
      return emitWarning.call(process, message, type, ...rest);
    };
    sqlite = process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
  if (!sqlite) throw new Error('no local recovery cache');
  return sqlite;
}

function initializeDatabase(file, DatabaseSync) {
  const temporary = path.join(path.dirname(file), '.new-db-' + randomBytes(16).toString('hex'));
  fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
  try {
    const db = new DatabaseSync(temporary);
    try {
      db.exec('PRAGMA application_id=' + APPLICATION_ID);
    } finally {
      db.close();
    }
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    fs.unlinkSync(temporary);
  }
}

function privateDirectory(dir) {
  const entry = fs.lstatSync(dir);
  if (!entry.isDirectory() || entry.uid !== process.getuid() || entry.mode & 0o022) throw new Error('invalid cache directory');
}

function privateFile(entry) {
  return entry.isFile() && entry.nlink === 1 && entry.uid === process.getuid() && !(entry.mode & 0o077);
}

export function withCache(mode, use) {
  const { DatabaseSync } = sqliteModule();
  const file = databasePath();
  if (mode === 'create') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  privateDirectory(path.dirname(file));
  if (mode === 'create' && !fs.lstatSync(file, { throwIfNoEntry: false })) initializeDatabase(file, DatabaseSync);
  let entry = fs.lstatSync(file);
  if (entry.isFile() && entry.nlink === 2 && mode === 'create') {
    // A competing initializer just linked its private database into place.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    entry = fs.lstatSync(file);
  }
  if (!privateFile(entry)) throw new Error('invalid cache file');
  const url = pathToFileURL(file);
  url.searchParams.set('mode', mode === 'read' ? 'ro' : 'rw');
  const db = new DatabaseSync(url.href, { readOnly: mode === 'read' });
  try {
    db.exec('PRAGMA busy_timeout=250');
    if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) throw new Error('unrecognized cache file');
    return use(db);
  } finally {
    db.close(); // Closing rolls back any incomplete transaction.
  }
}

export function removeProfileCache() {
  const file = databasePath();
  try {
    privateDirectory(path.dirname(file));
    if (!privateFile(fs.lstatSync(file))) return file;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(72);
      if (fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
          header.toString('latin1', 0, 16) !== 'SQLite format 3\0' || header.readUInt32BE(68) !== APPLICATION_ID) return file;
    } finally {
      fs.closeSync(fd);
    }
    return withCache('write', db => {
      db.exec('BEGIN EXCLUSIVE');
      const objects = db.prepare('SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL').all();
      if (objects.some(row => row.type !== 'table' || row.name !== 'history_source')) return file;
      if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') return file;
      fs.unlinkSync(file);
      return null;
    });
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw Object.assign(new Error('could not clean up runtime cache', { cause }), { code: 'EIO', path: file });
  }
}
