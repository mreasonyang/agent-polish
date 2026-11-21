// Resolve preferences up to the closest repository boundary. A null value means
// absent; an empty string marks a preference that cannot safely be used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { windows, openRegular, sameEntry, replaceSettingFile } from './platform.mjs';

export const PROMPT_FILE = 'codex-polish.prompt.md';

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;

function accessSetting(operation, target, value, checkStagedFile) {
  if (operation === 'read') {
    const fd = openRegular(target);
    try {
      const stat = fs.fstatSync(fd);
      if (value === undefined) return stat.nlink === 1 ? fs.readFileSync(fd) : '';
      const raw = Buffer.alloc(value + 1);
      let size = 0;
      while (size < raw.length) {
        const count = fs.readSync(fd, raw, size, raw.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size > value) return '';
      const bytes = raw.subarray(0, size);
      return bytes.toString('latin1').replace(/^[\t-\r ]+|[\t-\r ]+$/g, '');
    } finally {
      fs.closeSync(fd);
    }
  }
  if (!['write', 'remove'].includes(operation)) throw new Error('invalid operation');
  if (operation === 'remove') {
    const current = fs.lstatSync(target, { throwIfNoEntry: false });
    if (current && !current.isFile())
      throw Object.assign(new Error('invalid setting'), { code: 'EINVAL' });
    if (current) fs.unlinkSync(target);
    return null;
  }
  const temporary = '.' + target + '-' + randomBytes(12).toString('hex');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  let published = false;
  let staged;
  try {
    try {
      checkStagedFile?.(temporary, fd);
      if (Buffer.isBuffer(value)) fs.writeFileSync(fd, value);
      else fs.writeFileSync(fd, value + '\n', 'ascii');
      staged = fs.fstatSync(fd, { bigint: true });
    } finally {
      fs.closeSync(fd);
    }
    replaceSettingFile(temporary, target);
    published = true;
  } finally {
    if (!published) fs.rmSync(temporary, { force: true });
  }
  return { staged };
}

export function withSettingsDirectory(directory, use) {
  const previous = process.cwd();
  const expected = fs.lstatSync(directory, { bigint: true });
  if (!expected.isDirectory()) throw Object.assign(new Error('invalid settings directory'), { code: 'EINVAL' });
  const fd = windows ? null : fs.openSync(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    // These one-shot CLI helpers run synchronously. Relative filesystem calls stay
    // anchored to the kernel's working directory even if its name is replaced.
    process.chdir(directory);
    try {
      if (!sameEntry(fd === null ? expected : fs.fstatSync(fd, { bigint: true }), fs.statSync('.', { bigint: true }))) {
        throw new Error('project settings directory changed');
      }
      return use(accessSetting);
    } finally {
      process.chdir(previous);
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function accessProjectSetting(directory, operation, filename, value) {
  return withSettingsDirectory(directory, access => access(operation, filename, value));
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

export function readProjectSetting(cwd, filename, maxBytes) {
  if (cwd === null) return [null, null]; // A profile-only check has no current project.
  let base;
  try {
    base = projectRoot(cwd);
    if (base === os.homedir() || base === path.dirname(base)) return [null, base];
    const settings = path.join(base, '.codex');
    if (fs.lstatSync(settings).isSymbolicLink() &&
        fs.statSync(settings, { throwIfNoEntry: false })?.isDirectory() &&
        !fs.lstatSync(path.join(settings, filename), { throwIfNoEntry: false })) return [null, base];
    return [accessProjectSetting(settings, 'read', filename, maxBytes), base];
  } catch (error) {
    return [base && error.code === 'ENOENT' ? null : '', base ?? null];
  }
}

function profileSettingsDirectory(create) {
  const profile = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  if (create) fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  let dir = profile;
  for (const part of ['codex-polish', 'settings']) {
    dir = path.join(dir, part);
    if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (entry && !entry.isDirectory()) throw new Error('invalid profile settings directory');
  }
  return dir;
}

export function readProfileSetting(filename, maxBytes) {
  try {
    return accessProjectSetting(profileSettingsDirectory(false), 'read', filename, maxBytes);
  } catch (error) {
    return error.code === 'ENOENT' ? null : '';
  }
}

export function readSettingWithDefault(cwd, filename, maxBytes) {
  const [projectValue] = readProjectSetting(cwd, filename, maxBytes);
  return projectValue ?? readProfileSetting(filename, maxBytes);
}

export function writeProfileDefault(filename, value) {
  const directory = profileSettingsDirectory(value !== null);
  try {
    accessProjectSetting(directory, value === null ? 'remove' : 'write', filename, value);
  } catch (error) {
    if (value !== null || error.code !== 'ENOENT') throw error;
  }
  return path.join(directory, filename);
}
