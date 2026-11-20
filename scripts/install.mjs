#!/usr/bin/env node
// Install Codex Polish through the native Codex plugin manager.
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { language, tr } from '../plugins/codex-polish/hooks/ui_locale.mjs';
import { findAgy } from '../plugins/codex-polish/hooks/preferences.mjs';
import { removeProfileCache, sqliteModule } from '../plugins/codex-polish/hooks/recovery.mjs';
import { preserve } from './native_cache.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MARKET = 'codex-polish-local',
  NAME = 'codex-polish',
  PLUGIN_ID = NAME + '@' + MARKET;
export const INDEX = '.agents/plugins/marketplace.json',
  PRODUCT = 'plugins/' + NAME;
export const GUIDE = PRODUCT + '/skills/codex-polish-setup/references/credentials.md';
const CODEX_INSTALL = 'https://developers.openai.com/codex/cli/';
const GEMINI_KEYS = 'https://aistudio.google.com/apikey';
const AGY_INSTALL = 'https://antigravity.google/docs/getting-started/?tab=cli';
const AGY_BOOTSTRAP = 'https://antigravity.google/cli/install.sh';
const VERSION = '[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?';
const validVersion = new RegExp('^' + VERSION + '$');
const snapshotName = new RegExp('^' + VERSION + '-[0-9a-f]{20}$');
const localSource = { source: 'local', path: './' + PRODUCT };
const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = fs.constants;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (data) => createHash('sha256').update(data);
const readJSON = (file) => JSON.parse(readPlain(file));
const fail = (zh, en) => new SetupError(tr(zh, en));
export class SetupError extends Error {}

function statMaybe(path) {
  return fs.lstatSync(path, { throwIfNoEntry: false });
}
function readPlain(path) {
  const fd = fs.openSync(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw fail('文件类型异常。', 'Unexpected file type.');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
// Keep each Codex profile separate, including profiles that have not been created yet.
function canonical(path) {
  path = resolve(path);
  if (fs.existsSync(path)) return fs.realpathSync.native(path);
  return join(canonical(dirname(path)), basename(path));
}
function registeredPath(path) {
  return join(canonical(dirname(path)), basename(path));
}
export function codexProfile() {
  return canonical(process.env.CODEX_HOME || join(homedir(), '.codex'));
}
export function snapshotStore() {
  return join(codexProfile(), 'codex-polish', 'sources');
}
function plainFile(base, relative) {
  let current = base;
  const target = join(base, relative);
  for (const part of relative.split('/')) {
    current = join(current, part);
    const info = statMaybe(current);
    if (!info) return false;
    if (!(current === target ? info.isFile() : info.isDirectory())) {
      throw fail(
        `市场路径有异常，请在 Codex 里检查：${current}`,
        `Check this unexpected marketplace path in Codex: ${current}`
      );
    }
  }
  return true;
}
function productFiles(root) {
  const files = [];
  function walk(relative) {
    const dir = join(root, relative);
    if (!fs.lstatSync(dir).isDirectory())
      throw fail('插件目录异常。请重新解压插件包。', 'Unexpected plugin directory. Extract a fresh copy.');
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : Number(a.name > b.name));
    for (const entry of entries) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name === '.DS_Store') continue;
      else if (entry.isFile()) files.push(child);
      else throw fail('插件包里有不支持的文件类型，请重新解压。', 'The plugin contains an unsupported file or symlink. Extract a fresh copy.');
    }
  }
  walk('');
  return files;
}
function fingerprint(root) {
  const files = [INDEX, ...productFiles(join(root, PRODUCT)).map((file) => join(PRODUCT, file))];
  const hash = createHash('sha256');
  for (const file of files) {
    const path = join(root,file);
    const mode = fs.lstatSync(path).mode & 0o7777;
    hash.update(file + '\0' + mode + '\0').update(sha(readPlain(path)).digest());
  }
  return { digest: hash.digest('hex').slice(0, 20), files };
}
function ownsSnapshot(path, store) {
  return dirname(path) === store && snapshotName.test(basename(path)) && !statMaybe(path)?.isSymbolicLink();
}
export function bundleVersion(root) {
  if (!plainFile(root, INDEX)) throw fail('缺少市场清单。', 'Missing marketplace manifest.');
  const index = readJSON(join(root, INDEX));
  if (
    index?.name !== MARKET ||
    !Array.isArray(index.plugins) || index.plugins.length !== 1 ||
    index.plugins[0]?.name !== NAME ||
    !isDeepStrictEqual(index.plugins[0].source, localSource)
  ) {
    throw fail(
      '安装源里的本地市场清单无效。请重新解压一份新的插件包再试。',
      "The local marketplace manifest isn't valid. Extract a fresh copy of the plugin and try again."
    );
  }
  const manifest = PRODUCT + '/.codex-plugin/plugin.json';
  const metadata = plainFile(root, manifest) && readJSON(join(root, manifest));
  if (metadata?.name !== NAME || typeof metadata.version !== 'string' || !validVersion.test(metadata.version)) {
    throw fail('插件清单里的名称或版本无效。', 'The plugin manifest has an invalid name or version.');
  }
  return metadata.version;
}
export function compareVersions(a, b) {
  function parts(version) {
    if (typeof version !== 'string' || !validVersion.test(version))
      throw fail('没法确定已安装插件的版本。', "Couldn't determine the installed plugin version.");
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
function verifiedPaths(entry) {
  if (!fs.lstatSync(entry).isDirectory()) return null;
  const actual = new Set();
  function walk(relative) {
    for (const name of fs.readdirSync(join(entry, relative))) {
      const child = join(relative, name),
        info = fs.lstatSync(join(entry, child));
      if (!info.isFile() && !info.isDirectory()) return false;
      actual.add(child);
      if (info.isDirectory() && !walk(child)) return false;
    }
    return true;
  }
  if (!walk('') || !actual.has(INDEX)) return null;
  try {
    const version = bundleVersion(entry),
      { digest, files } = fingerprint(entry);
    if (basename(entry) !== version + '-' + digest) return null;
    const expected = new Set(files);
    for (const file of files) {
      for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) expected.add(dir);
    }
    return isDeepStrictEqual(expected, actual) ? expected : null;
  } catch (error) {
    if (error.code && !['EISDIR', 'ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
    return null;
  }
}
function makeSnapshot(root, store, minimumVersions, registered) {
  const version = bundleVersion(root);
  for (const existing of minimumVersions) {
    if (compareVersions(version, existing) < 0)
      throw fail(
        `这个安装包是 ${version}，比已安装的 ${existing} 旧。请使用更新的安装包。`,
        `This package has ${version}, which is older than the installed ${existing}. Use a newer package.`
      );
  }
  const { digest, files } = fingerprint(root),
    target = join(store, version + '-' + digest);
  const occupied = statMaybe(target);
  if (occupied) {
    if (!ownsSnapshot(target, store) || !occupied.isDirectory())
      throw fail('安装路径已被占用。', 'The snapshot path is already occupied.');
    if (target === registered || verifiedPaths(target)) return [target, version];
  }
  const temp = fs.mkdtempSync(join(store, '.prepare-'));
  try {
    const stage = join(temp, 'market');
    for (const file of files) {
      const dest = join(stage, file),
        src = join(root, file);
      fs.mkdirSync(dirname(dest), { recursive: true });
      fs.writeFileSync(dest, readPlain(src));
      fs.chmodSync(dest, fs.lstatSync(src).mode & 0o7777);
    }
    if (fingerprint(stage).digest !== digest)
      throw fail(
        '安装过程中插件文件变了，请重新运行安装。',
        'The plugin files changed during installation. Run setup again.'
      );
    if (occupied) {
      const backup = join(fs.mkdtempSync(join(store, 'retained-')), basename(target));
      fs.renameSync(target, backup);
      console.log(tr(`本地改动已保存在 ${backup}`, `Your local changes were kept at ${backup}`));
    }
    fs.renameSync(stage, target);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return [target, version];
}
export function codex(...args) {
  const result = spawnSync('codex', ['plugin', ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error?.code === 'ENOENT')
    throw fail(
      '没找到 Codex CLI。请按官方指南安装，或把 codex 加入 PATH。\n  ' + CODEX_INSTALL,
      "Couldn't find Codex CLI. Follow the official installation guide or add codex to PATH.\n  " + CODEX_INSTALL
    );
  if (result.error || result.signal)
    throw fail(
      'Codex CLI 没有正常结束，请检查后再试。',
      "Codex CLI didn't finish. Check that it runs, then try again."
    );
  const label = args[0] === 'marketplace' ? args.slice(0, 2).join(' ') : args[0];
  if (result.status !== 0)
    throw new SetupError(
      tr(
        `Codex plugin ${label} 运行失败。请检查插件状态后再试。`,
        `codex plugin ${label} failed. Check the plugin in Codex and try again.`
      )
    );
  let reply;
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    throw fail('Codex CLI 返回的内容没法读取。', "Couldn't read the response from Codex CLI.");
  }
  if (!isObject(reply))
    throw fail('不支持 Codex CLI 返回的格式。', 'This version of Codex CLI returned an unsupported response.');
  return reply;
}
function lookup(run, field, key, value, ...args) {
  const rows = run(...args)[field];
  if (!Array.isArray(rows) || !rows.every(isObject))
    throw fail(
      '没法核对 Codex 的市场或插件列表，请检查 CLI 版本。',
      "Couldn't verify the marketplace or plugin list. Check your Codex CLI version."
    );
  const found = rows.filter((row) => row[key] === value);
  if (found.length > 1)
    throw fail('Codex 返回了重复的市场或插件记录。', 'Codex returned duplicate marketplace or plugin records.');
  return found[0] ?? null;
}
function registration(run) {
  const row = lookup(run, 'marketplaces', 'name', MARKET, 'marketplace', 'list');
  if (!row) return null;
  const info = row.marketplaceSource,
    source = info?.source;
  if (info?.sourceType !== 'local' || typeof source !== 'string' || !isAbsolute(source)) {
    throw fail(
      '同名市场用了其他来源。请在 Codex 的插件设置里核对。',
      'A marketplace with the same name uses a different source. Check it in Codex plugin settings.'
    );
  }
  return registeredPath(source);
}
function installed(run) {
  return lookup(run, 'installed', 'pluginId', PLUGIN_ID, 'list', '--marketplace', MARKET);
}
function requireManagedSource(previous, store) {
  if (previous && !ownsSnapshot(previous, store)) {
    throw fail(
      '同名市场使用了其他来源，请在 Codex 插件设置中检查。',
      'A marketplace with the same name uses a different source. Check it in Codex plugin settings.'
    );
  }
}
function checkSource(previous, store) {
  requireManagedSource(previous, store);
  if (previous && !verifiedPaths(previous))
    throw fail(
      '已注册的安装副本被改动了。请先运行 node scripts/install.mjs uninstall，再运行 node scripts/install.mjs setup。项目设置会保留。',
      'The registered plugin source has changed. Run node scripts/install.mjs uninstall, then node scripts/install.mjs setup. Your project settings will be kept.'
    );
}
function verifyReceipt(receipt, target, version) {
  const directory = receipt.installedPath;
  if (
    receipt.pluginId !== PLUGIN_ID ||
    receipt.version !== version ||
    typeof directory !== 'string' ||
    !isAbsolute(directory)
  ) {
    throw fail(
      'Codex 没有返回能核对的插件安装目录和版本。',
      "Codex didn't confirm the installation directory and plugin version."
    );
  }
  const source = join(target, PRODUCT),
    files = productFiles(source);
  if (
    !statMaybe(directory)?.isDirectory() ||
    !isDeepStrictEqual(productFiles(directory), files) ||
    files.some((file) => !readPlain(join(directory, file)).equals(readPlain(join(source, file))))
  ) {
    throw fail('Codex 的安装缓存和这次发行的内容不一致。', "The files Codex installed don't match this release.");
  }
}
export async function nativeConfig(method, params, { experimental = false, cwd, env = process.env } = {}) {
  const proc = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], cwd, env });
  let ended = false;
  const closed = new Promise((done) =>
    proc.once('close', () => {
      ended = true;
      done();
    })
  );
  proc.on('error', () => {});
  proc.stdin.on('error', () => {});
  const deadline = setTimeout(() => proc.kill('SIGKILL'), 20_000);
  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const stream = lines[Symbol.asyncIterator]();
  async function send(frame) {
    proc.stdin.write(JSON.stringify(frame) + '\n');
    if (frame.id == null) return;
    for (;;) {
      const { value, done } = await stream.next();
      if (done) break;
      const msg = JSON.parse(value);
      if (msg.id !== frame.id) continue;
      if (!msg.error && isObject(msg.result)) return msg.result;
      break;
    }
    throw fail('Codex 配置接口没有确认这次请求。', "The Codex configuration service didn't confirm the request.");
  }
  try {
    await send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex-polish-installer', version: '1' },
        ...(experimental && { capabilities: { experimentalApi: true } })
      }
    });
    await send({ method: 'initialized' });
    return await send({ id: 2, method, params });
  } finally {
    proc.stdin.end();
    lines.close();
    if (!ended) {
      const force = setTimeout(() => proc.kill('SIGKILL'), 2000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    clearTimeout(deadline);
  }
}
export async function writeEnabled(value) {
  const result = await nativeConfig('config/value/write', {
    keyPath: `plugins.${PLUGIN_ID}.enabled`,
    value,
    mergeStrategy: 'upsert'
  });
  if (!['ok', 'okOverridden'].includes(result.status))
    throw fail('Codex 配置接口没有确认写入。', "Codex didn't confirm that it saved the setting.");
}
async function hasUnlistedPlugin() {
  const { config } = await nativeConfig('config/read', { includeLayers: false });
  if (config.marketplaces?.[MARKET])
    throw fail('市场来源变了，请再试一次。', 'The marketplace source changed. Try again.');
  return Object.hasOwn(config.plugins ?? {}, PLUGIN_ID);
}
async function verifyInstalled(run, setEnabled, version, enabled) {
  let state = installed(run);
  if (state?.version !== version)
    throw fail(
      'Codex 没有确认已安装预期版本。',
      "Codex didn't confirm that the requested plugin version is installed."
    );
  if (state.enabled !== enabled) {
    await setEnabled(enabled);
    state = installed(run);
    if (state?.version !== version || state.enabled !== enabled)
      throw fail('Codex 没有确认插件的启用状态。', "Codex didn't confirm whether the plugin is enabled.");
  }
}
async function rollback(run, setEnabled, previous, before, target) {
  const current = registration(run);
  if (![null, previous, target].includes(current))
    throw fail('其他进程修改了市场。', 'Another process changed the marketplace.');
  if (!before && installed(run)) run('remove', PLUGIN_ID);
  if (current !== previous) {
    if (current) run('marketplace', 'remove', MARKET);
    if (previous) run('marketplace', 'add', previous);
  }
  if (registration(run) !== previous)
    throw fail('Codex 没有恢复更新前的市场来源。', "Codex didn't restore the previous marketplace.");
  if (before) {
    verifyReceipt(run('add', PLUGIN_ID), previous, before.version);
    await verifyInstalled(run, setEnabled, before.version, before.enabled);
  } else if (installed(run))
    throw fail('Codex 没有清除未完成的安装。', "Codex didn't remove the incomplete installation.");
}
const sourceId = (path) => (path === null ? null : sha(path).digest('hex'));
export function pendingUpdate(store) {
  let fd;
  try {
    fd = fs.openSync(join(store, '.pending-update.json'), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(1025);
    if (fs.fstatSync(fd).isFile()) {
      const n = fs.readSync(fd, buffer);
      if (n <= 1024) {
        let entry;
        try {
          entry = JSON.parse(buffer.subarray(0, n));
        } catch {}
        if (
          entry &&
          typeof entry.enabled === 'boolean' &&
          typeof entry.target === 'string' &&
          snapshotName.test(entry.target) &&
          typeof entry.version === 'string' &&
          validVersion.test(entry.version) &&
          (entry.previous === null || (typeof entry.previous === 'string' && /^[0-9a-f]{64}$/.test(entry.previous)))
        )
          return entry;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  throw fail(
    '上次更新的记录损坏了。请先在 Codex 里检查插件来源，再卸载并重新安装。',
    'The interrupted update record is invalid. Check its source in Codex, then uninstall and reinstall.'
  );
}
function syncStore(store) {
  const fd = fs.openSync(store, O_RDONLY | O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function savePending(store, entry) {
  const tmp = join(store, '.prepare-update-' + randomUUID());
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(entry));
    fs.fsyncSync(fd);
    fs.renameSync(tmp, join(store, '.pending-update.json'));
    syncStore(store);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}
function finishPending(store) {
  try {
    fs.unlinkSync(join(store, '.pending-update.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  syncStore(store);
}
export function preserveNativeCache(store, previous, state) {
  if (store !== snapshotStore()) return;
  const version = state?.version;
  function verifiedSource() {
    if (!previous || !ownsSnapshot(previous, store) || !statMaybe(previous)) return null;
    return verifiedPaths(previous) && bundleVersion(previous) === version ? join(previous, PRODUCT) : null;
  }
  try {
    const backup = preserve(codexProfile(), MARKET, NAME, version, verifiedSource);
    if (backup)
      console.log(tr('已保留有改动或没法核对的插件缓存：', 'Kept a changed or unverified plugin cache at: ') + backup);
  } catch (error) {
    throw fail(
      '没法安全保留 Codex 里的插件缓存。先检查下面这个路径再重试。\n  ' + error.message,
      "Couldn't safely keep the plugin cache in Codex intact. Check this path and try again.\n  " + error.message
    );
  }
}
async function setup(root, store, run, setEnabled, action) {
  const previous = registration(run);
  checkSource(previous, store);
  const pending = pendingUpdate(store);
  if (pending && previous && sourceId(previous) !== pending.previous && previous !== join(store, pending.target)) {
    throw fail(
      '上次更新后，市场来源变了。请先在 Codex 里核对来源，再重新安装。',
      'The marketplace source changed after the interrupted update. Check it in Codex before reinstalling.'
    );
  }
  const before = installed(run);
  if (!previous && !pending && (before || (store === snapshotStore() && (await hasUnlistedPlugin())))) {
    throw fail(
      'Codex 里还有安装记录，但市场来源已被移除。请用这个包运行 uninstall，再运行 setup。项目设置会保留。',
      'Codex still has an installation record, but the marketplace was removed. Run uninstall from this package, then setup. Your project settings will be kept.'
    );
  }
  if (before && (typeof before.enabled !== 'boolean' || typeof before.version !== 'string')) {
    throw fail(
      'Codex 没有返回能核对的原安装版本和启用状态。',
      "Codex didn't report the installed version and enabled state."
    );
  }
  const original = pending || before,
    enabled = original?.enabled ?? true;
  const versions = [before, pending].filter(Boolean).map((row) => row.version);
  const [target, version] = makeSnapshot(root, store, versions, previous);
  if (original)
    savePending(store, { previous: sourceId(previous), target: basename(target), version: original.version, enabled });
  preserveNativeCache(store, previous, before);
  try {
    if (previous !== target) {
      if (previous) run('marketplace', 'remove', MARKET);
      run('marketplace', 'add', target);
    }
    verifyReceipt(run('add', PLUGIN_ID), target, version);
    if (registration(run) !== target)
      throw fail(
        'Codex 没有确认这次安装的市场来源。',
        "Codex didn't confirm the marketplace source for this installation."
      );
    await verifyInstalled(run, setEnabled, version, enabled);
  } catch (error) {
    try {
      await rollback(run, setEnabled, previous, before, target);
    } catch {
      throw fail(
        '安装失败，Codex 没能恢复。本地快照已保留，请重新运行 setup。',
        "Codex couldn't restore the previous installation. The local copy is still there. Run setup again."
      );
    }
    if (before && !pending) finishPending(store);
    throw error;
  }
  if (original) finishPending(store);
  if (!enabled)
    return [
      tr(
        `回复润色 ${version} 已安装，目前仍是停用状态。要用时可以在 Codex 的插件设置里启用。`,
        `Codex Polish ${version} is installed, but it's still disabled. You can enable it in Codex plugin settings.`
      ),
      false
    ];
  const lang = language();
  const status = action === 'setup'
    ? tr(`回复润色 ${version} 已安装。`, `Codex Polish ${version} is installed.`, lang)
    : tr(`回复润色已更新到 ${version}。`, `Updated Codex Polish to ${version}.`, lang);
  const lines = [
    status,
    tr(
      '未设置模式的项目默认自动润色，已保存的模式继续生效。改写时，Google 会收到用占位符保护了固定内容的本轮问题和草稿，以及按原文附带的历史问答（默认最多 2 轮）。开启 OpenAI 检查时，OpenAI 只收到本轮材料。',
      'Projects without a saved mode default to automatic polishing. Saved modes still apply. On a rewrite, Google receives the current question and draft with fixed details masked, plus earlier exchanges as written (up to two by default). Optional OpenAI checks use only current-turn material.',
      lang
    ),
    tr(
      '要自动润色或附带历史，请在 Codex 的「设置 → Hooks」（CLI 输入 /hooks）中信任本插件的 UserPromptSubmit，再新开一个聊天。想改模式，可以说「只在我要求时润色」或「关闭回复润色」。',
      'For automatic polishing or history, trust the plugin’s UserPromptSubmit hook in Codex Settings → Hooks (/hooks in the CLI), then start a new chat. To change modes, say “Only polish when I ask” or “Turn off Codex Polish”.',
      lang
    )
  ];
  if (action === 'setup') {
    const guide = join(target, lang === 'zh' ? GUIDE : GUIDE.replace('credentials.md', 'credentials.en.md'));
    lines.push(tr(`配置指南：${guide}`, `Setup guide: ${guide}`, lang));
  }
  return [lines.join('\n'), action === 'setup'];
}
// Node has no unlinkat. Pin each directory as the kernel cwd for this synchronous
// walk and check inode identity after chdir, before any relative unlink/rmdir.
function removeVerifiedEntries(entry, paths) {
  function enter(path, expected) {
    process.chdir(path);
    const current = fs.statSync('.');
    if (current.dev !== expected.dev || current.ino !== expected.ino)
      throw new Error('Directory changed during cleanup');
  }
  function removeChildren(relative) {
    const parent = fs.statSync('.');
    for (const name of fs.readdirSync('.')) {
      const child = join(relative, name);
      if (!paths.has(child)) continue;
      const info = fs.lstatSync(name);
      if (info.isDirectory()) {
        enter(name, info);
        removeChildren(child);
        enter('..', parent);
        fs.rmdirSync(name);
      } else if (info.isFile()) fs.unlinkSync(name);
    }
  }
  const cwd = process.cwd();
  try {
    process.chdir(dirname(entry));
    const store = fs.statSync('.');
    const info = fs.lstatSync(basename(entry));
    if (!info.isDirectory()) throw new Error('Snapshot changed during cleanup');
    enter(basename(entry), info);
    removeChildren('');
    enter('..', store);
    fs.rmdirSync(basename(entry));
  } finally {
    process.chdir(cwd);
  }
}
function cleanUninstallData(store) {
  const kept = [],
    errors = [];
  let entries = [];
  try {
    entries = fs.readdirSync(store).sort();
  } catch {
    errors.push(store);
  }
  for (const name of entries.filter((name) => snapshotName.test(name))) {
    const entry = join(store, name);
    try {
      const paths = verifiedPaths(entry);
      if (paths) removeVerifiedEntries(entry, paths);
      else kept.push(entry);
    } catch {
      errors.push(entry);
    }
  }
  if (store === snapshotStore()) {
    try {
      const retained = removeProfileCache();
      if (retained) kept.push(retained);
    } catch (error) {
      errors.push(error.path || store);
    }
  }
  let message = tr('回复润色已卸载。项目设置已保留。', 'Uninstalled Codex Polish and kept your project settings.');
  if (kept.length)
    message +=
      '\n' +
      tr('下面这些路径有改动或额外内容，已保留：', 'Kept these paths because they have changes or extra contents:') +
      '\n' +
      kept.join('\n');
  if (errors.length)
    throw new SetupError(
      message +
        '\n' +
        tr(
          '没法检查或清理下面这些路径。请关闭还在用这个插件的会话，检查权限，再重新卸载：',
          "Couldn't clean up these paths. Close any sessions using the plugin, check permissions, and run uninstall again:"
        ) +
        '\n' +
        errors.join('\n')
    );
  return message;
}
async function uninstall(store, run) {
  const previous = registration(run);
  requireManagedSource(previous, store);
  if (previous) bundleVersion(previous);
  const before = installed(run);
  let present = Boolean(before);
  // The native plugin list hides an installed plugin when an interrupted
  // update has already removed its marketplace. Read its current config key.
  if (!previous && store === snapshotStore()) {
    present = await hasUnlistedPlugin();
  }
  if (present && !previous) {
    const known = fs
      .readdirSync(store)
      .map((name) => join(store, name))
      .some((entry) => ownsSnapshot(entry, store) && verifiedPaths(entry));
    if (!known && !pendingUpdate(store))
      throw fail(
        '没法确定这个已安装插件来自哪个市场，卸载已停止。',
        "Couldn't verify the marketplace for the installed plugin. Check its source before uninstalling."
      );
  }
  if (present || previous) preserveNativeCache(store, previous, before);
  if (present) {
    run('remove', PLUGIN_ID);
    if (!previous && store === snapshotStore() ? await hasUnlistedPlugin() : installed(run))
      throw fail(
        'Codex 还是显示这个插件已安装，请再试一次卸载。',
        'Codex still lists the plugin as installed. Run uninstall again.'
      );
  }
  if (previous) {
    run('marketplace', 'remove', MARKET);
    if (registration(run))
      throw fail(
        'Codex 还是显示这个市场已注册，请再试一次卸载。',
        'Codex still lists the marketplace. Run uninstall again.'
      );
  }
  return cleanUninstallData(store);
}
// An exclusive SQLite transaction serializes installers on both supported
// platforms. The OS releases it immediately if the process is interrupted.
// Keep the native handle live even when a caller awaits a promise whose
// resolver has been discarded. V8 can collect the suspended async stack.
const heldLocks = new Set();
export async function withLock(file, action) {
  const entry = statMaybe(file);
  if (entry && (!entry.isFile() || entry.nlink !== 1)) throw fail('锁文件路径异常。', 'Unexpected lock file.');
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(file);
  heldLocks.add(db);
  try {
    for (;;) {
      try {
        db.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if (error.errcode !== 5 && error.errcode !== 6) throw error;
        await sleep(50);
      }
    }
    return await action();
  } finally {
    heldLocks.delete(db);
    db.close();
  }
}
export async function manage(action, root, store, run = codex, setEnabled = writeEnabled) {
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(store).isDirectory() || fs.realpathSync.native(store) !== store) {
    throw fail(
      '快照目录路径异常，请检查后再试。',
      'Unexpected snapshot directory. Check this path before trying again.'
    );
  }
  return withLock(join(store, '.installer.sqlite'), async () => {
    if (action === 'uninstall') {
      const message = await uninstall(store, run);
      finishPending(store);
      return [message, false];
    }
    return setup(root, store, run, setEnabled, action);
  });
}
function readChecks() {
  const helper = join(ROOT, PRODUCT, 'hooks/preferences.mjs');
  const result = spawnSync(process.execPath, [helper, 'check', '--cwd', process.cwd()], {
    encoding: 'utf8',
    timeout: 10_000
  });
  if (result.status !== 0 || result.error)
    throw fail('没法读取插件的环境检查结果。', "Couldn't read the plugin environment check results.");
  return JSON.parse(result.stdout);
}
async function runBootstrap(script, target, options) {
  const proc = spawn('/bin/bash', [script, '--dir', target], { ...options, stdio: 'ignore', detached: true });
  function killGroup() {
    if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  const timer = setTimeout(killGroup, 180_000);
  process.once('SIGINT', killGroup);
  process.once('SIGTERM', killGroup);
  try {
    const status = await new Promise((done, reject) => proc.once('error', reject).once('close', done));
    if (status !== 0) throw fail('Google 的安装程序没有完成。', 'Google’s installer didn’t finish.');
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', killGroup);
    process.off('SIGTERM', killGroup);
  }
}
async function downloadBootstrap(file) {
  const signal = AbortSignal.timeout(30_000);
  let url = new URL(AGY_BOOTSTRAP);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { signal, redirect: 'manual' });
    if (response.ok && response.body) {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), {
        signal
      });
      return;
    }
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
    url = new URL(location, url);
    if (url.protocol !== 'https:') break;
  }
  throw fail('从 Google 下载 agy 失败。', 'Could not download agy from Google.');
}
export async function installAgy() {
  const target = join(homedir(), '.local/bin');
  fs.mkdirSync(target, { recursive: true });
  await withLock(join(target, '.codex-polish-agy.sqlite'), async () => {
    if (findAgy()) return;
    const binary = join(target, 'agy');
    if (statMaybe(binary))
      throw fail(`请先检查 ${binary}，这个路径已被占用。`, `Check ${binary}. That path is already in use.`);
    const temp = fs.mkdtempSync(join(tmpdir(), 'codex-polish-agy-')),
      script = join(temp, 'install.sh');
    const env = { ...process.env };
    for (const key of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'BASH_ENV', 'ENV']) delete env[key];
    const options = { cwd: temp, env };
    try {
      await downloadBootstrap(script);
      try {
        await runBootstrap(script, target, options);
        const output = execFileSync(binary, ['--version'], {
          ...options,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
          killSignal: 'SIGKILL'
        });
        const version = /\b(\d+\.\d+\.\d+)\b/.exec(output);
        if (!version || compareVersions(version[1], '1.2.1') < 0)
          throw fail('需要 Antigravity CLI 1.2.1 或更新版。', 'Antigravity CLI 1.2.1 or later is required.');
      } catch (error) {
        if (statMaybe(binary) && !fs.lstatSync(binary).isDirectory()) fs.unlinkSync(binary);
        throw error;
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
function decisionsSummary(checks, lang) {
  if (checks.decisions_mode === 'off')
    return tr(
      '改写检查：未开启，回复会直接交给 Gemini 润色。',
      'Rewrite checks: off. Replies go straight to Gemini.',
      lang
    );
  if (checks.blockers.includes('openai_key_invalid'))
    return tr('OpenAI 检查目前用不了。', "OpenAI checks aren't available right now.", lang);
  if (checks.decisions_enabled)
    return tr(
      '改写检查：已配置 OpenAI Decisions，先判断要不要改写，改完再核对原意没变。',
      'Rewrite checks: using OpenAI Decisions to decide whether a reply needs a rewrite and verify the meaning stays intact.',
      lang
    );
  return tr(
    '改写检查：回复直接交给 Gemini 润色。想加一层检查，在 Codex 里说「配置 OpenAI Decisions」。',
    'Rewrite checks: replies go straight to Gemini. If you want extra checks, tell Codex “Set up OpenAI Decisions”.',
    lang
  );
}
const issues = {
  openai_key_invalid: [
    'OPENAI_API_KEY 格式不对。请重新复制密钥，或者在项目里说「这个项目只用 Gemini 改写」，跳过 OpenAI 检查。',
    'OPENAI_API_KEY is invalid. Copy the key again, or ask Codex to “Use only Gemini for rewrites in this project”.'
  ],
  gemini_key_missing: [
    '你选了用 API 密钥登录 Google。去 Google AI Studio 点 Create API key，然后把密钥设为 GEMINI_API_KEY。',
    'You chose Google API key sign-in. Select Create API key in Google AI Studio, then set GEMINI_API_KEY.',
    GEMINI_KEYS
  ],
  gemini_key_invalid: [
    'GEMINI_API_KEY 格式不对。请重新复制完整密钥，去掉空格和换行。要创建新密钥可以访问',
    'GEMINI_API_KEY is invalid. Copy the full key without spaces or newlines. To create a new key, visit',
    GEMINI_KEYS
  ],
  agy_missing: [
    '找不到 agy。在插件解压目录运行 node scripts/install.mjs setup --install-agy，或按 Google 的指南安装。',
    "Couldn't find agy. Install it from the extracted plugin folder with node scripts/install.mjs setup --install-agy, or follow Google’s guide.",
    AGY_INSTALL
  ],
  unsupported_google_auth: [
    '移除 CODEX_POLISH_AGY_AUTH 就能恢复 Antigravity 默认登录（existing-session）。',
    'Unset CODEX_POLISH_AGY_AUTH to use the default Antigravity sign-in (existing-session).'
  ],
  gemini_model_invalid: [
    '这个项目的改写模型设置无效。请在 Codex 里说「选择改写模型」。',
    "The project's model setting is invalid. Ask Codex to “Choose a rewrite model”."
  ],
  unsupported_node: [
    '安装 Node.js 22.16 或更高版本，再用 node --version 检查。',
    'Install Node.js 22.16 or later and check with node --version.'
  ]
};
function setupIssues(checks, lang) {
  const lines = [],
    pages = new Set();
  for (const [code, [zh, en, url]] of Object.entries(issues))
    if (checks.blockers.includes(code)) {
      lines.push(tr(zh, en, lang) + (url ? '\n  ' + url : ''));
      if (url === GEMINI_KEYS) pages.add(url);
    }
  return [lines, [...pages]];
}
export function configurationSteps(checks) {
  const lang = checks.ui_language || language(),
    [issues, pages] = setupIssues(checks, lang);
  const lines = [
    issues.length
      ? tr('开始改写前，先完成下面的设置。', 'Finish these steps before your first rewrite.', lang)
      : tr('本地配置检查都通过了。', 'Your local setup checks out.', lang),
    ...issues
  ];
  if (checks.google_auth_method === 'existing-session')
    lines.push(
      tr(
        'Gemini 会复用你现有的 Antigravity 登录。第一次改写如果提示登录，在运行 Codex 的机器上打开终端，运行 agy 登录就行。',
        'Gemini reuses your Antigravity sign-in. If your first rewrite asks you to sign in, open a terminal on the machine running Codex, run agy, and sign in there.',
        lang
      )
    );
  if (checks.google_auth_method === 'agent-platform')
    lines.push(
      tr(
        '已选择 Google 企业身份。管理员需要先在运行 Codex 的环境里配置好身份。',
        'Google enterprise authentication is selected. Your admin needs to set it up in the environment running Codex.',
        lang
      )
    );
  lines.push(
    decisionsSummary(checks, lang),
    tr(
      '在项目里新开一个 Codex 对话，说「配置回复润色」就能查看或修改设置。',
      'Open a new project chat in Codex and say “Set up Codex Polish” to view or change settings.',
      lang
    )
  );
  const examples = {
    auto: [
      '在已信任 hook 的新聊天里，直接问「用一句话解释 DNS。」就会触发自动润色。',
      'After trusting the hook, try automatic polishing in a new chat. Ask “Explain what DNS does in one sentence.”'
    ],
    manual: [
      '这个项目只在点名时润色。试一句：「用一句话解释 DNS，再把你的回复润色一下。」',
      'This project polishes only when asked. Try “Explain what DNS does in one sentence, then polish your reply.”'
    ],
    off: [
      '这个项目已关闭改写。想试用的话，可以先说「改回手动润色」。',
      'Rewriting is off in this project. To try it, say “Switch to on-demand rewrites”.'
    ]
  };
  lines.push(tr(...examples[checks.mode], lang));
  return [lines, pages];
}
async function ask(prompt) {
  const io = createPrompt({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  io.once('SIGINT', cancel);
  io.once('close', cancel);
  try {
    return (await io.question(prompt, { signal: controller.signal })).trim().toLowerCase();
  } catch {
    console.log();
    return null;
  } finally {
    io.close();
  }
}
function openPage(url) {
  return (
    spawnSync(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { stdio: 'ignore', timeout: 5000 })
      .status === 0
  );
}
export async function showSetupGuidance({
  installDependency = false,
  dependencyOnly = false,
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  check = readChecks,
  install = installAgy,
  prompt = ask,
  browse = openPage
} = {}) {
  let checks, lang;
  try {
    checks = check();
    lang = checks.ui_language || language();
  } catch {
    console.log(
      tr(
        '没能完成环境检查。在项目里新开一个 Codex 对话，说「配置回复润色」再试一次。',
        "Couldn't finish the environment check. Open a new project chat in Codex and say “Set up Codex Polish” to try again."
      )
    );
    return !installDependency;
  }
  if (checks.blockers.includes('agy_missing')) {
    let requested = installDependency;
    if (interactive && !requested)
      requested = ['', 'y', 'yes', '是'].includes(
        await prompt(
          tr(
            '改写回复需要 Google 的 Antigravity 命令行工具（agy）。现在安装吗？[Y/n] ',
            'Codex Polish needs Google’s Antigravity CLI (agy). Install it now? [Y/n] ',
            lang
          )
        )
      );
    if (requested) {
      try {
        console.log(tr('正在从 Google 下载并安装 agy…', 'Downloading and installing agy from Google…', lang));
        await install();
        checks = check();
        if (!checks.agy_available)
          throw fail('装好后仍找不到 agy。', 'The installer finished, but agy is still missing.');
        console.log(tr('agy 已安装，可以使用。', 'agy is installed and ready to use.', lang));
      } catch (error) {
        if (error instanceof SetupError) console.error(error.message);
        console.error(
          tr(
            '插件已安装，agy 安装未完成。可在解压目录运行 node scripts/install.mjs setup --install-agy 重试。',
            'The plugin is installed. To retry the agy installation, run node scripts/install.mjs setup --install-agy from the extracted folder.',
            lang
          ) +
            '\n' +
            AGY_INSTALL
        );
        return false;
      }
    }
  } else if (installDependency)
    console.log(tr('已找到 agy，直接使用现有安装。', 'Found agy. Your existing installation will be used.', lang));
  if (dependencyOnly) return true;
  const [lines, pages] = configurationSteps(checks);
  console.log(lines.join('\n'));
  if (
    pages.length &&
    interactive &&
    (await prompt(
      tr(
        '输入 y 在浏览器打开上面的官方页面，直接回车跳过：',
        'Type y to open the official links above, or press Enter to skip: ',
        lang
      )
    )) === 'y'
  ) {
    for (const page of pages)
      if (!browse(page))
        console.log(tr(`浏览器没能打开页面，请手动访问 ${page}`, `Couldn't open the browser. Visit ${page}`, lang));
  }
  return true;
}
const serviceIssues = {
  api_rate_limited: ['OpenAI 请求过于频繁', 'OpenAI rate limit'],
  api_server_error: ['OpenAI 服务暂不可用', 'OpenAI service unavailable'],
  api_transport_error: ['无法连接 OpenAI', 'OpenAI connection failed'],
  api_timeout: ['OpenAI 请求超时', 'OpenAI request timed out'],
  invalid_api_response: ['OpenAI 返回了无效结果', 'invalid OpenAI response'],
  api_auth_error: ['OpenAI 认证失败，请检查密钥', 'OpenAI authentication failed; check your key'],
  api_quota_exhausted: ['OpenAI 额度不足', 'OpenAI quota exhausted'],
  acp_start_failed: ['Antigravity 启动失败', 'Antigravity failed to start'],
  acp_timeout: ['Antigravity 请求超时', 'Antigravity request timed out'],
  acp_protocol_error: ['Antigravity 通信中断', 'Antigravity communication failed'],
  acp_provider_error: ['Antigravity 服务暂不可用', 'Antigravity service unavailable'],
  acp_incomplete: ['Antigravity 没返回完整回复', 'incomplete Antigravity response'],
  acp_auth_failed: ['Antigravity 登录失效，请重新登录', 'Antigravity sign-in failed; sign in again'],
  acp_model_unavailable: ['所选 Gemini 模型不可用，请重新选择', 'selected Gemini model unavailable; choose a new model']
};
export function doctor(checks = readChecks()) {
  const lang = checks.ui_language,
    modes = { manual: ['只在我要求时', 'only when asked'], auto: ['自动改写', 'automatic'], off: ['已关闭', 'off'] };
  const lines = [
    tr('当前项目模式：', 'Project mode: ', lang) + tr(...modes[checks.mode], lang),
    tr('项目改写模型：', 'Rewrite model: ', lang) + (checks.gemini_model || tr('设置无效', 'invalid setting', lang)),
    decisionsSummary(checks, lang)
  ];
  const turns = checks.history_turns;
  lines.push(
    turns
      ? tr(
          `最多带上最近 ${turns} 组问答（你的提问 + Codex 的回复），这一次的提问和草稿另算。`,
          `Sends up to ${turns} past Q&As (your question + Codex's reply), plus your current request and draft.`,
          lang
        )
      : tr(
          '历史记录设为 0，只发这一次的提问和草稿。',
          'History is off, so only your current request and draft go out.',
          lang
        )
  );
  const detected =
    checks.language_mode === 'auto' ? tr('自动识别', 'automatic', lang) : tr('项目设置', 'project setting', lang);
  lines.push(tr(`界面语言：中文（${detected}）`, `Interface language: English (${detected})`, lang));
  for (const [tool, ready] of [
    ['Node.js 22.16+', checks.node_available],
    ['Codex CLI', checks.codex_available],
    ['Antigravity CLI', checks.agy_available]
  ]) {
    lines.push(tool + tr('：', ': ', lang) + (ready ? tr('可用', 'available', lang) : tr('未找到', 'not found', lang)));
  }
  switch (checks.google_auth_method) {
    case 'existing-session':
      lines.push(
        tr(
          'Google 账号：复用 Antigravity 里的登录，真正改写时才会验证状态。',
          'Google sign-in: reuses your Antigravity account (verified when you run a rewrite).',
          lang
        )
      );
      break;
    case 'agent-platform':
      lines.push(tr('Google 身份：企业平台。', 'Google sign-in: enterprise platform.', lang));
      break;
    case 'gemini-api-key':
      lines.push(
        tr('Gemini API 密钥：', 'Gemini API key: ', lang) +
          (checks.gemini_key_configured ? tr('已配置', 'configured', lang) : tr('未配置', 'not configured', lang))
      );
      break;
  }
  if (checks.blockers.length)
    lines.unshift(
      tr(
        '现在会先原样保留草稿。完成下面的设置后就可以使用改写了。',
        'Codex Polish is leaving your drafts as-is for now. Finish these steps, then try again.',
        lang
      ),
      ...setupIssues(checks, lang)[0]
    );
  if (checks.cooldown) {
    const reason = tr(...(serviceIssues[checks.cooldown.reason] || ['服务暂不可用', 'service unavailable']), lang),
      seconds = checks.cooldown.remaining_seconds;
    lines.push(
      tr(
        `自动改写已暂停，${seconds} 秒后可以再试。上次遇到的问题：${reason}。`,
        `Automatic rewrites are paused for ${seconds} more seconds. Last issue: ${reason}.`,
        lang
      )
    );
  }
  return lines.join('\n');
}
function usage(lang) {
  return tr(
    '用法：node scripts/install.mjs [setup|update|doctor|uninstall] [--install-agy]\nsetup 安装（默认），update 更新，doctor 检查当前项目，uninstall 卸载。\n--install-agy 在缺少 agy 时安装，仅限 setup 和 update。\n-h, --help 显示帮助并退出。',
    'Usage: node scripts/install.mjs [setup|update|doctor|uninstall] [--install-agy]\nsetup installs the plugin (default), update upgrades it, doctor checks this project, and uninstall removes it.\n--install-agy installs Google’s Antigravity CLI if missing during setup or update.\n-h, --help shows this help.',
    lang
  );
}
export async function main(args = process.argv.slice(2)) {
  const lang = language();
  if (args.includes('-h') || args.includes('--help')) {
    console.log(usage(lang));
    return 0;
  }
  const actions = args.filter((arg) => arg !== '--install-agy');
  const action = actions[0] ?? 'setup';
  if (actions.length > 1 || !['setup', 'update', 'doctor', 'uninstall'].includes(action)) {
    console.error(usage(lang));
    return 2;
  }
  const installDependency = args.includes('--install-agy');
  if (installDependency && !['setup', 'update'].includes(action)) {
    const flag = '--install-agy';
    console.error(tr(`${flag} 只能用于 setup 或 update`, `${flag} only works with setup or update`, lang));
    return 2;
  }
  try {
    if (action === 'doctor') {
      console.log(doctor());
      return 0;
    }
    const [message, offerSetup] = await manage(action, ROOT, snapshotStore());
    console.log(message);
    if (
      (offerSetup || installDependency) &&
      !(await showSetupGuidance({ installDependency, dependencyOnly: !offerSetup }))
    )
      return 1;
    return 0;
  } catch (error) {
    console.error(
      error instanceof SetupError
        ? error.message
        : tr(
            '没法核对安装文件或环境。请检查文件权限和发行包后再试。',
            "Couldn't verify the installation files or environment. Check the package and file permissions, then try again.",
            lang
          )
    );
    return 1;
  }
}
if (
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
  if (process.env.CODEX_POLISH_INSTALL_WINDOW === '1' && process.stdin.isTTY)
    await ask(tr('按回车关闭安装窗口。', 'Press Enter to close the installer.'));
}
