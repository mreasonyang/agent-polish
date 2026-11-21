// Per-profile receipts for project settings explicitly saved by the preference commands.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withSettingsDirectory } from './project_setting.mjs';
import { initializeDatabase, sqliteModule } from './recovery.mjs';
import { sameEntry, windows } from './platform.mjs';

const APPLICATION_ID = 0x43504f53;
const FILES = new Set(['codex-polish.mode', 'codex-polish.rewrite-mode', 'codex-polish.model',
  'codex-polish.decisions', 'codex-polish.history-turns', 'codex-polish.language']);
const statEntry = name => fs.lstatSync(name, { bigint: true, throwIfNoEntry: false });
const identity = stat => [stat.dev, stat.ino, stat.birthtimeNs].join(':');
const RETRY = Symbol('registry was replaced');
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);

function lockedRegistry(file, entry, DatabaseSync, use, cleanup) {
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'rw');
  let db, acquired = false;
  try {
    db = new DatabaseSync(url.href);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');
    const current = statEntry(file);
    if (!current || !sameEntry(entry, current)) return RETRY;
    acquired = true;
    if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID)
      throw new Error('unrecognized settings registry');
    // Retire the database in the same transaction that clears its receipts.
    // A writer already waiting on this inode must reopen the published path.
    const retired = db.prepare('PRAGMA user_version').get().user_version === 1;
    if (retired && !cleanup) return RETRY;
    const objects = db.prepare('SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL').all();
    if (objects.some(row => row.type !== 'table' || row.name !== 'owned')) throw new Error('unexpected settings registry contents');
    db.exec('CREATE TABLE IF NOT EXISTS owned (directory TEXT, name TEXT, folder TEXT, file TEXT, PRIMARY KEY(directory, name))');
    const result = use(db);
    if (cleanup) db.exec('PRAGMA user_version=1');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    const current = statEntry(file);
    if (!acquired && (!current || !sameEntry(entry, current))) return RETRY;
    throw error;
  } finally {
    db?.close();
  }
}

function withRegistry(env, create, use, cleanup = false) {
  const profile = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const parent = path.join(profile, 'codex-polish');
  const file = path.join(parent, 'owned-settings.sqlite');
  try {
    if (create) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const folder = statEntry(parent);
    if (!folder && !create) return use(null);
    if (!folder?.isDirectory()) throw new Error('invalid settings registry directory');
    for (let attempt = 0; attempt < 100; attempt++) {
      let entry = statEntry(file);
      if (!entry && !create) return use(null);
      const { DatabaseSync } = sqliteModule();
      if (!entry) {
        initializeDatabase(file, DatabaseSync, APPLICATION_ID);
        entry = statEntry(file);
      }
      // A competing initializer briefly holds a second link to the database.
      if (entry?.nlink === 2n && attempt === 0) { pause(); continue; }
      if (!entry) continue;
      if (!entry.isFile() || entry.nlink !== 1n) throw new Error('invalid settings registry');
      const result = lockedRegistry(file, entry, DatabaseSync, use, cleanup);
      if (result === RETRY) { pause(); continue; }
      if (cleanup) {
        for (let retry = 0; ; retry++) {
          const current = statEntry(file);
          if (!current || !sameEntry(entry, current)) break;
          try { fs.unlinkSync(file); break; }
          catch (error) {
            if (!windows || retry >= 50 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
            pause();
          }
        }
      }
      return result;
    }
    throw new Error('settings registry cleanup is pending');
  } catch (error) {
    error.path ??= file;
    throw error;
  }
}

export function changeProjectSetting(directory, operation, name, value) {
  if (!FILES.has(name)) throw new Error('unknown project setting');
  return withRegistry(process.env, operation !== 'remove', db => withSettingsDirectory(directory, access => {
    if (!db) return access(operation, name, value);
    const folder = identity(statEntry('.'));
    const { staged } = access(operation, name, value) ?? {};
    const saved = statEntry(name);
    // A different profile could have published another setting before this
    // stat. NTFS can preserve the destination's creation time on replacement.
    if (staged && saved?.isFile() && saved.ino !== 0n && staged.ino === saved.ino && (windows || staged.dev === saved.dev))
      db.prepare('INSERT OR REPLACE INTO owned VALUES (?,?,?,?)').run(directory, name, folder, identity(saved));
    else
      db.prepare('DELETE FROM owned WHERE directory=? AND name=?').run(directory, name);
  }));
}

function removeRecorded({ directory, name, folder, file }) {
  if (!FILES.has(name) || !path.isAbsolute(directory) || path.basename(directory) !== '.codex')
    throw new Error('invalid recorded setting');
  const target = path.join(directory, name);
  try {
    const dir = statEntry(directory);
    if (!dir?.isDirectory() || identity(dir) !== folder || path.relative(directory, fs.realpathSync(directory))) return false;
    return withSettingsDirectory(directory, () => {
      if (identity(statEntry('.')) !== folder) return false;
      const entry = statEntry(name);
      if (!entry?.isFile() || identity(entry) !== file) return false;
      fs.unlinkSync(name);
      return true;
    });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return false;
    error.path = target;
    throw error;
  }
}

export function cleanupProjectSettings(env = process.env) {
  return withRegistry(env, false, db => {
    let removed = 0;
    if (db) {
      for (const row of db.prepare('SELECT directory, name, folder, file FROM owned').all())
        if (removeRecorded(row)) removed++;
      db.exec('DELETE FROM owned');
    }
    return removed;
  }, true);
}
