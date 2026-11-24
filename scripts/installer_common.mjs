import fs from 'node:fs';
import os from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

export const windows = process.platform === 'win32';
export const LEGACY_BOTH_SETUP = 'CODEX_POLISH_LEGACY_BOTH_SETUP';

function localAppData(env) {
  return env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
}

export function agyDirectory(env = process.env) {
  return windows ? join(localAppData(env), 'agy', 'bin') : join(os.homedir(), '.local', 'bin');
}

export function available(file, mode = fs.constants.F_OK) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, mode);
    return true;
  } catch { return false; }
}

export function pathDirectories(env = process.env) {
  const search = (env.PATH ?? env.Path ?? (windows ? '' : '/bin:/usr/bin')).split(delimiter);
  return windows ? search.map(directory => directory.replace(/^"(.*)"$/, '$1')).filter(isAbsolute) : search;
}

export function agyExecutable(env = process.env) {
  for (const directory of [...pathDirectories(env), agyDirectory(env)]) {
    if (windows && !isAbsolute(directory)) continue;
    const file = resolve(directory, windows ? 'agy.exe' : 'agy');
    if (available(file, fs.constants.X_OK)) return { command: file, args: [] };
  }
  return null;
}

export function windowsSystemTool(relative) {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', relative);
}

export const VERSION = '[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?';
const validVersion = new RegExp('^' + VERSION + '$');

export function npmChannel(root, packageName, nativeManifest) {
  function read(relative) {
    try { return JSON.parse(fs.readFileSync(join(root, relative), 'utf8')); }
    catch { return null; }
  }
  const manifest = read('package.json');
  // Source checkouts use a private workspace root. Read the host's own version there.
  const version = manifest?.name === packageName && !manifest.private &&
    typeof manifest.version === 'string' && validVersion.test(manifest.version)
    ? manifest.version
    : read(nativeManifest)?.version;
  return typeof version === 'string' && validVersion.test(version) && version.split('+', 1)[0].includes('-')
    ? 'beta' : 'latest';
}

// Resolve the existing ancestors of profiles that have yet to be created.
export function canonical(path) {
  path = resolve(path);
  if (fs.existsSync(path)) return fs.realpathSync.native(path);
  return join(canonical(dirname(path)), basename(path));
}
export function compareVersions(a, b, invalidVersion) {
  function parts(version) {
    if (typeof version !== 'string' || !validVersion.test(version))
      throw invalidVersion();
    const [release, prerelease] = version.split('+')[0].split(/-(.*)/s);
    return [release.split('.').map(BigInt), prerelease?.split('.')];
  }
  const [x, xp] = parts(a),
    [y, yp] = parts(b);
  const cmp = (a, b) => (a < b ? -1 : Number(a > b));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return cmp(x[i], y[i]);
  if (!xp || !yp) return Number(!xp) - Number(!yp);
  for (let i = 0; i < Math.min(xp.length, yp.length); i++) {
    const l = xp[i],
      r = yp[i],
      ln = /^\d+$/.test(l),
      rn = /^\d+$/.test(r);
    const order = ln !== rn ? Number(rn) - Number(ln) : ln ? cmp(BigInt(l), BigInt(r)) : cmp(l, r);
    if (order) return order;
  }
  return cmp(xp.length, yp.length);
}

export function interactiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function');
}
