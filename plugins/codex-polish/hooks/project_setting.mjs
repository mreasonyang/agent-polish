// Resolve preferences up to the closest repository boundary. A null value means
// absent; an empty string marks a preference that cannot safely be used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

function sameDirectory(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function accessSetting(directory, operation, filename, value) {
  const target = path.join(directory, filename);
  if (operation === 'read' || operation === 'read-bytes') {
    const fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (operation === 'read-bytes' && stat.nlink > 1)) return '';
      if (operation === 'read-bytes' && value === undefined) return fs.readFileSync(fd);
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
  if (operation !== 'write' && operation !== 'remove') throw new Error('invalid operation');
  const current = fs.lstatSync(target, { throwIfNoEntry: false });
  if (current && !current.isFile()) throw Object.assign(new Error('invalid setting'), { code: 'EINVAL' });
  if (operation === 'remove') {
    if (current) fs.unlinkSync(target);
    return null;
  }
  const temporary = path.join(directory, '.' + filename + '-' + randomBytes(12).toString('hex'));
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
  const fd = fs.openSync(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    // These one-shot CLI helpers run synchronously. Relative filesystem calls stay
    // anchored to the kernel's working directory even if its name is replaced.
    process.chdir(directory);
    try {
      if (!sameDirectory(fs.fstatSync(fd, { bigint: true }), fs.statSync('.', { bigint: true }))) {
        throw new Error('project settings directory changed');
      }
      return accessSetting('.', operation, filename, value);
    } finally {
      process.chdir(previous);
    }
  } finally {
    fs.closeSync(fd);
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

export function readProjectSetting(cwd, filename, maxBytes, { allowMissingLink = false, raw = false } = {}) {
  let base;
  try {
    base = projectRoot(cwd);
    if (base === os.homedir() || base === path.dirname(base)) return [null, base];
    const settings = path.join(base, '.codex');
    if (allowMissingLink && fs.lstatSync(settings).isSymbolicLink() &&
        fs.statSync(settings, { throwIfNoEntry: false })?.isDirectory() &&
        !fs.lstatSync(path.join(settings, filename), { throwIfNoEntry: false })) return [null, base];
    return [accessProjectSetting(settings, raw ? 'read-bytes' : 'read', filename, maxBytes), base];
  } catch (error) {
    return [base && error.code === 'ENOENT' ? null : '', base ?? null];
  }
}
