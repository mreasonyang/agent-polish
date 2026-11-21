// Private storage for the current thread’s transcript pointer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { windows, openRegular, sameEntry } from './platform.mjs';
import { secureDirectory, checkPrivatePath, checkPrivatePaths } from '../skills/codex-polish/scripts/acp_windows_io.mjs';
import { createHash, randomBytes } from 'node:crypto';

export const APPLICATION_ID = 0x43504f4c;
const hash = value => createHash('sha256').update(value).digest('hex');

function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return windows ? fs.realpathSync.native(absolute) : fs.realpathSync(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonicalPath(parent), path.basename(absolute));
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
  if (!path.isAbsolute(base))
    base = windows ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache');
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

export function initializeDatabase(file, DatabaseSync, applicationId = APPLICATION_ID) {
  const temporary = path.join(path.dirname(file), '.new-db-' + randomBytes(16).toString('hex'));
  fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
  try {
    const db = new DatabaseSync(temporary);
    try {
      db.exec('PRAGMA application_id=' + applicationId);
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

function privateDirectory(dir, checkAcl = true) {
  const entry = fs.lstatSync(dir);
  if (!entry.isDirectory()) throw new Error('invalid cache directory');
  if (windows) {
    if (checkAcl) checkPrivatePath(dir);
  } else if (entry.uid !== process.getuid() || entry.mode & 0o022) throw new Error('invalid cache directory');
}

export function privateFile(file, entry, checkAcl = true) {
  if (!entry.isFile() || entry.nlink !== 1) return false;
  if (windows) {
    if (checkAcl) checkPrivatePath(file, false);
    return true;
  }
  return entry.uid === process.getuid() && !(entry.mode & 0o077);
}

export function createPrivateDirectory(dir) {
  if (!windows) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (fs.lstatSync(dir, { throwIfNoEntry: false })) return;
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, '.codex-polish-cache-'));
  let published = false;
  try {
    // Publish the directory only after its ACL is private. A simultaneous
    // hook can then validate and use the winner's directory immediately.
    secureDirectory(path.resolve(temporary));
    try {
      fs.renameSync(temporary, dir);
      published = true;
    } catch (error) {
      if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw error;
    }
  } finally {
    if (!published) fs.rmdirSync(temporary);
  }
}

export function withCache(mode, use) {
  const { DatabaseSync } = sqliteModule();
  const file = databasePath();
  const directory = path.dirname(file);
  if (mode === 'create') createPrivateDirectory(directory);
  privateDirectory(directory, false);
  if (mode === 'create' && !fs.lstatSync(file, { throwIfNoEntry: false })) {
    if (windows) checkPrivatePath(directory);
    initializeDatabase(file, DatabaseSync);
  }
  let entry = fs.lstatSync(file);
  if (entry.isFile() && entry.nlink === 2 && mode === 'create') {
    // A competing initializer just linked its private database into place.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    entry = fs.lstatSync(file);
  }
  if (!privateFile(file, entry, false)) throw new Error('invalid cache file');
  if (windows) checkPrivatePaths([{ path: directory, directory: true }, { path: file, directory: false }]);
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
    const expected = fs.lstatSync(file, { bigint: true });
    if (!privateFile(file, fs.lstatSync(file))) return file;
    const fd = openRegular(file);
    try {
      const header = Buffer.alloc(72);
      if (fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
          header.toString('latin1', 0, 16) !== 'SQLite format 3\0' || header.readUInt32BE(68) !== APPLICATION_ID) return file;
    } finally {
      fs.closeSync(fd);
    }
    const retained = withCache('write', db => {
      db.exec('BEGIN EXCLUSIVE');
      const objects = db.prepare('SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL').all();
      if (objects.some(row => row.type !== 'table' || !['history_source', 'reply_origin'].includes(row.name))) return file;
      if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') return file;
      if (!windows) fs.unlinkSync(file);
      return null;
    });
    // SQLite's Windows handle cannot be unlinked during the transaction.
    // After close, Windows rejects deletion if another connection opened it.
    if (windows && !retained) {
      const current = fs.lstatSync(file, { bigint: true });
      if (!current.isFile() || !sameEntry(current, expected)) return file;
      fs.unlinkSync(file);
    }
    return retained;
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw Object.assign(new Error('could not clean up runtime cache', { cause }), { code: 'EIO', path: file });
  }
}
