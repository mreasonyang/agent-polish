import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cacheScope, withCache } from './recovery.mjs';
import { utf8 } from '../skills/codex-polish/scripts/cli_io.mjs';

// A checked-in prompt link can refer to a regular project file in the index.
// Reading any other file requires the target the user selected on this machine.
function trackedTarget(project, target) {
  const relative = path.relative(project, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  try {
    const entry = execFileSync('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false',
      '-C', project, 'ls-files', '--stage', '-z', '--', relative], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
    });
    return /^(?:100644|100755) [a-f0-9]+ 0\t/.test(entry) && entry.slice(entry.indexOf('\t') + 1) === relative + '\0';
  } catch { return false; }
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
    if (!stat.isFile() || stat.nlink !== 1n || stat.ino !== named.ino || stat.dev !== named.dev || fs.realpathSync(target) !== target)
      throw new Error('invalid_prompt_target');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function readPromptLink(project, link) {
  let target;
  try { target = fs.realpathSync(link); }
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
  fs.symlinkSync(tracked ? path.relative(path.dirname(link), target) : target, temporary);
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
