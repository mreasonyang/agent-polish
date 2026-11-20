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
  if (operation === 'read') {
    const fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) return '';
      const raw = Buffer.alloc(value + 1);
      const size = fs.readSync(fd, raw, 0, raw.length, 0);
      if (size > value) return '';
      return raw.subarray(0, size).toString('latin1').replace(/^[\t-\r ]+|[\t-\r ]+$/g, '');
    } finally {
      fs.closeSync(fd);
    }
  }
  if (operation !== 'write') throw new Error('invalid operation');
  const current = fs.lstatSync(target, { throwIfNoEntry: false });
  if (current && !current.isFile()) throw Object.assign(new Error('invalid setting'), { code: 'EINVAL' });
  const temporary = path.join(directory, '.' + filename + '-' + randomBytes(12).toString('hex'));
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, value + '\n', 'ascii');
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

const invalid = '';

export function readProjectSetting(cwd, filename, maxBytes, { allowMissingLink = false } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return [invalid, null];
  try {
    const directory = fs.realpathSync(cwd);
    if (!fs.statSync(directory).isDirectory()) return [invalid, null];
    for (let base = directory; base !== os.homedir() && base !== path.dirname(base); base = path.dirname(base)) {
      const settings = path.join(base, '.codex');
      try {
        if (fs.lstatSync(settings).isSymbolicLink()) {
          if (!allowMissingLink || !fs.statSync(settings, { throwIfNoEntry: false })?.isDirectory() ||
              fs.lstatSync(path.join(settings, filename), { throwIfNoEntry: false })) {
            return [invalid, base];
          }
        } else {
          return [accessProjectSetting(settings, 'read', filename, maxBytes), base];
        }
      } catch (error) {
        if (error.code !== 'ENOENT') return [invalid, base];
      }
      if (fs.existsSync(path.join(base, '.git'))) return [null, base];
    }
    return [null, directory];
  } catch {
    return [invalid, null];
  }
}
