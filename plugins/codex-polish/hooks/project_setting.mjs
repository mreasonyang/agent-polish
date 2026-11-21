// Resolve preferences up to the closest repository boundary. A null value means
// absent; an empty string marks a preference that cannot safely be used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { windows, openRegular } from './platform.mjs';
import { readPromptLink, savePromptLink, resolvePromptBytes } from './prompt_link.mjs';

export const PROMPT_FILE = 'codex-polish.prompt.md';

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;

function sameDirectory(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function accessSetting(project, operation, filename, value) {
  const target = filename;
  if (operation === 'read' || operation === 'read-bytes') {
    if (operation === 'read-bytes' && filename === PROMPT_FILE && fs.lstatSync(target).isSymbolicLink())
      return readPromptLink(project, target);
    const fd = openRegular(target);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (operation === 'read-bytes' && stat.nlink > 1)) return '';
      if (operation === 'read-bytes' && value === undefined) return resolvePromptBytes(project, target, fs.readFileSync(fd));
      const raw = Buffer.alloc(value + 1);
      let size = 0;
      while (size < raw.length) {
        const count = fs.readSync(fd, raw, size, raw.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size > value) return '';
      const bytes = raw.subarray(0, size);
      return operation === 'read-bytes' ? bytes : bytes.toString('latin1').replace(/^[\t-\r ]+|[\t-\r ]+$/g, '');
    } finally {
      fs.closeSync(fd);
    }
  }
  if (!['write', 'remove', 'link'].includes(operation)) throw new Error('invalid operation');
  const current = fs.lstatSync(target, { throwIfNoEntry: false });
  if (current && !current.isFile() && !(filename === PROMPT_FILE && current.isSymbolicLink()))
    throw Object.assign(new Error('invalid setting'), { code: 'EINVAL' });
  if (operation === 'link') {
    if (filename !== PROMPT_FILE) throw new Error('invalid setting');
    return savePromptLink(project, target, value);
  }
  if (operation === 'remove') {
    if (current) fs.unlinkSync(target);
    return null;
  }
  const temporary = '.' + filename + '-' + randomBytes(12).toString('hex');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      if (Buffer.isBuffer(value)) fs.writeFileSync(fd, value);
      else fs.writeFileSync(fd, value + '\n', 'ascii');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return null;
}

export function accessProjectSetting(directory, operation, filename, value) {
  const previous = process.cwd();
  const expected = fs.lstatSync(directory, { bigint: true });
  if (!expected.isDirectory()) throw Object.assign(new Error('invalid settings directory'), { code: 'EINVAL' });
  const fd = windows ? null : fs.openSync(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    // These one-shot CLI helpers run synchronously. Relative filesystem calls stay
    // anchored to the kernel's working directory even if its name is replaced.
    process.chdir(directory);
    try {
      if (!sameDirectory(fd === null ? expected : fs.fstatSync(fd, { bigint: true }), fs.statSync('.', { bigint: true }))) {
        throw new Error('project settings directory changed');
      }
      return accessSetting(path.dirname(directory), operation, filename, value);
    } finally {
      process.chdir(previous);
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// Git worktrees and nested repositories each own their project preferences.
export function projectRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('invalid project path');
  const directory = fs.realpathSync(cwd);
  if (!fs.statSync(directory).isDirectory()) throw new Error('invalid project directory');
  for (let base = directory; base !== os.homedir() && base !== path.dirname(base); base = path.dirname(base)) {
    if (fs.lstatSync(path.join(base, '.git'), { throwIfNoEntry: false })) return base;
  }
  return directory;
}

export function readProjectSetting(cwd, filename, maxBytes, { raw = false } = {}) {
  let base;
  try {
    base = projectRoot(cwd);
    if (base === os.homedir() || base === path.dirname(base)) return [null, base];
    const settings = path.join(base, '.codex');
    if (fs.lstatSync(settings).isSymbolicLink() &&
        fs.statSync(settings, { throwIfNoEntry: false })?.isDirectory() &&
        !fs.lstatSync(path.join(settings, filename), { throwIfNoEntry: false })) return [null, base];
    return [accessProjectSetting(settings, raw ? 'read-bytes' : 'read', filename, maxBytes), base];
  } catch (error) {
    if (error.code === 'PROMPT_LINK_UNBOUND') throw error;
    return [base && error.code === 'ENOENT' ? null : '', base ?? null];
  }
}
