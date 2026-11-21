import fs from 'node:fs';
import path from 'node:path';
import { devNull } from 'node:os';
import { windows, sameEntry } from './platform.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cacheScope, withCache } from './recovery.mjs';
import { utf8 } from '../skills/codex-polish/scripts/cli_io.mjs';

// A checked-in prompt link can refer to a regular project file in the index.
// Reading any other file requires the target the user selected on this machine.
function git(project, args) {
  return execFileSync('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', project, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
    env: { ...(windows && { SystemRoot: process.env.SystemRoot }), PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: '0' },
  });
}

// Windows can spell the same directory with an 8.3 alias in a hook and
// a long path in the file picker. Keep the last component to inspect link entries.
function relativeFile(parent, file) {
  if (!windows) return path.relative(parent, path.resolve(file));
  const absolute = path.resolve(file);
  return path.relative(fs.realpathSync.native(parent),
    path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute)));
}

function indexEntry(project, target) {
  const relative = relativeFile(project, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  try {
    const entry = git(project, ['ls-files', '--stage', '-z', '--', relative]).toString('utf8');
    const parsed = /^(100644|100755|120000) ([a-f0-9]+) 0\t/.exec(entry);
    return parsed && entry.slice(parsed[0].length) === relative.split(path.sep).join('/') + '\0' ? parsed : null;
  } catch { return null; }
}

function trackedTarget(project, target) {
  return ['100644', '100755'].includes(indexEntry(project, target)?.[1]);
}

function binding(link, target) {
  const stat = fs.lstatSync(link, { bigint: true });
  return createHash('sha256').update([target, stat.dev, stat.ino, stat.birthtimeNs].join('\0')).digest('hex');
}

function chosenLink(project, link, target) {
  try {
    const row = withCache('read', db => db.prepare('SELECT binding FROM prompt_link WHERE scope=?').get(cacheScope(project)));
    return row?.binding === binding(link, target);
  } catch { return false; }
}

function readTarget(target) {
  const named = fs.lstatSync(target, { bigint: true });
  if (!named.isFile() || named.nlink !== 1n) throw new Error('invalid_prompt_target');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !sameEntry(stat, named) || fs.realpathSync(target) !== target)
      throw new Error('invalid_prompt_target');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// Windows file symlinks need Developer Mode or an elevated token. A tagged
// regular file works in ordinary accounts and remains readable after cloning.
const referenceHeader = Buffer.from('\0codex-polish-prompt-link-v1\0');
export function isPromptReference(bytes) {
  return bytes.subarray(0, referenceHeader.length).equals(referenceHeader);
}

export function resolvePromptBytes(project, link, bytes) {
  if (isPromptReference(bytes)) {
    const target = utf8(bytes.subarray(referenceHeader.length));
    return readPromptLink(project, link, path.resolve(path.dirname(link), target));
  }
  // Git for Windows can check out a tracked symlink as its literal target text.
  if (windows && bytes.length < 32768) {
    const entry = indexEntry(project, link);
    if (entry?.[1] === '120000' && git(project, ['cat-file', 'blob', entry[2]]).equals(bytes))
      return readPromptLink(project, link, path.resolve(path.dirname(link), utf8(bytes)));
  }
  return bytes;
}

export function readPromptLink(project, link, reference = link) {
  let target;
  try { target = fs.realpathSync(reference); }
  catch { throw new Error('invalid_prompt_target'); }
  if (!trackedTarget(project, target) && !chosenLink(project, link, target))
    throw Object.assign(new Error('editor_prompt_link_unbound'), { code: 'PROMPT_LINK_UNBOUND' });
  try { return readTarget(target); }
  catch { throw new Error('invalid_prompt_target'); }
}

export function savePromptLink(project, link, source) {
  let target;
  try {
    target = fs.realpathSync(source);
    if (target === path.resolve(link) || !utf8(readTarget(target)).trim()) throw new Error('invalid_prompt_target');
  } catch (cause) {
    throw Object.assign(new Error('invalid_prompt_target', { cause }), { code: 'INVALID_PROMPT_TARGET' });
  }
  const temporary = '.new-prompt-' + randomBytes(12).toString('hex');
  const tracked = trackedTarget(project, target);
  const relative = tracked ? relativeFile(path.dirname(link), target).split(path.sep).join('/') : target;
  if (windows) {
    fs.writeFileSync(temporary, Buffer.concat([referenceHeader, Buffer.from(relative)]), { flag: 'wx', mode: 0o600 });
  } else {
    fs.symlinkSync(relative, temporary);
  }
  try {
    if (tracked) {
      fs.renameSync(temporary, link);
      return;
    }
    withCache('create', db => {
      db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS prompt_link (scope TEXT PRIMARY KEY, binding TEXT NOT NULL)');
      db.prepare('INSERT OR REPLACE INTO prompt_link VALUES (?,?)').run(cacheScope(project), binding(temporary, target));
      fs.renameSync(temporary, link);
      db.exec('COMMIT');
    });
  } finally { fs.rmSync(temporary, { force: true }); }
}
