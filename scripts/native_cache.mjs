// Keep local edits before Codex replaces or removes its versioned cache.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { tr } from '../plugins/codex-polish/hooks/ui_locale.mjs';

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
export function treeContents(root) {
  const contents = new Map();
  function visit(relative) {
    const file = join(root, relative);
    const info = fs.lstatSync(file);
    if (info.isDirectory()) {
      contents.set(relative, info.mode & 0o7777);
      return fs.readdirSync(file).every((name) => visit(join(relative, name)));
    }
    if (!info.isFile()) return false;
    const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const actual = fs.fstatSync(fd);
      if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino) return false;
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(65536);
      let count;
      while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count));
      contents.set(relative, [actual.mode & 0o7777, hash.digest('hex')]);
      return true;
    } finally {
      fs.closeSync(fd);
    }
  }
  return visit('') ? contents : null;
}

export function preserve(profile, market, name, version, getSource) {
  let parent = profile;
  let cache;
  try {
    for (const component of ['plugins', 'cache', market]) {
      parent = join(parent, component);
      if (!fs.lstatSync(parent).isDirectory()) {
        throw new Error(tr(`不是预期的缓存目录：${parent}`, `Unexpected cache directory: ${parent}`));
      }
    }
    cache = join(parent, name);
    fs.lstatSync(cache);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  // Rename a cache containing special files or unreadable data as a whole.
  try {
    if (fs.lstatSync(cache).isDirectory()) {
      const entries = fs.readdirSync(cache);
      if (!entries.length) return null;
      if (entries.length === 1 && entries[0] === version && fs.lstatSync(join(cache, version)).isDirectory()) {
        const source = getSource();
        if (source) {
          const expected = treeContents(source);
          if (expected && isDeepStrictEqual(expected, treeContents(join(cache, version)))) return null;
        }
      }
    }
  } catch (error) {
    if (!error.code) throw error;
  }
  const backups = join(profile, 'codex-polish-backups');
  try {
    fs.mkdirSync(backups, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!fs.lstatSync(backups).isDirectory()) {
    throw new Error(tr(`不是预期的备份目录：${backups}`, `Unexpected backup directory: ${backups}`));
  }
  const reservation = fs.mkdtempSync(join(backups, 'plugin-cache-'));
  const destination = join(reservation, name);
  try {
    fs.renameSync(cache, destination);
  } catch (error) {
    fs.rmdirSync(reservation);
    throw error;
  }
  return destination;
}
