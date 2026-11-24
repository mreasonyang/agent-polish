#!/usr/bin/env node
// Install Codex Polish through the selected host's native plugin manager.
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { on } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { clearLine, createInterface, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executable, windows, agyDirectory, windowsSystemTool, openRegular, sameEntry } from '../plugins/codex-polish/hooks/platform.mjs';
import { language, languageSettings, tr } from '../plugins/codex-polish/hooks/ui_locale.mjs';
import { DEFAULT_GEMINI_MODEL, DEFAULT_THINKING_LEVEL, DECISIONS_FILE, MODE_FILE, PROFILE_PREFERENCE_FILES, findAgy, runtimeStatus, saveModelSelection, triggerMode } from '../plugins/codex-polish/hooks/preferences.mjs';
import { REWRITE_MODE_FILE, REWRITE_MODES } from '../plugins/codex-polish/hooks/rewrite_mode.mjs';
import { accessSettingFile, readProfileSetting, writeProfileSetting } from '../plugins/codex-polish/hooks/profile_setting.mjs';
import { readOpenAIKey, saveOpenAIKey, clearOpenAIKey } from '../plugins/codex-polish/hooks/openai_credentials.mjs';
import { cleanupProjectSettings } from '../plugins/codex-polish/hooks/owned_settings.mjs';
import { removeProfileCache, sqliteModule } from '../plugins/codex-polish/hooks/recovery.mjs';
import { openSetupCatalog } from './setup_catalog.mjs';
import { preserve } from './native_cache.mjs';
import { withLock } from '../plugins/agy-polish/scripts/directory-lock.mjs';
export { withLock };
import {
  AgyInstallError, agyProfile, localAgyState, requireAgyCli, installedAgy,
  validateAgyBundle, changeAgyPlugin, loadAgySettings, checkCodexProvider
} from './agy_install.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MARKET = 'codex-polish-local',
  NAME = 'codex-polish',
  PLUGIN_ID = NAME + '@' + MARKET;
export const INDEX = '.agents/plugins/marketplace.json',
  PRODUCT = 'plugins/' + NAME;
const CODEX_INSTALL = 'https://developers.openai.com/codex/cli/';
const GEMINI_KEYS = 'https://aistudio.google.com/apikey';
const OPENAI_KEYS = 'https://platform.openai.com/api-keys';
const OPENAI_OFFER_FILE = 'codex-polish.openai-offer';
const openAICommand = `${windows ? 'npx.cmd' : 'npx'} @kyun.si/codex-polish openai`;
const installAgyCommand = `${windows ? 'npx.cmd' : 'npx'} @kyun.si/codex-polish setup --install-agy`;
const AGY_INSTALL = 'https://antigravity.google/docs/getting-started/?tab=cli';
const AGY_BOOTSTRAP = 'https://antigravity.google/cli/install.' + (windows ? 'ps1' : 'sh');
const VERSION = '[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?';
const validVersion = new RegExp('^' + VERSION + '$');
const snapshotName = new RegExp('^' + VERSION + '-[0-9a-f]{20}$');
const localSource = { source: 'local', path: './' + PRODUCT };
const { O_RDONLY, O_DIRECTORY } = fs.constants;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (data) => createHash('sha256').update(data);
const readJSON = (file) => JSON.parse(readPlain(file));
const fail = (zh, en) => new SetupError(tr(zh, en));
export class SetupError extends Error {}

function statMaybe(path) {
  return fs.lstatSync(path, { throwIfNoEntry: false });
}
function readPlain(path, maxBytes) {
  const fd = openRegular(path);
  try {
    if (maxBytes !== undefined && fs.fstatSync(fd).size > maxBytes) throw new RangeError('File is too large');
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
  // Rust canonicalize() returns Win32 device paths; the marketplace list
  // displays the same directory using a DOS or UNC path.
  if (windows && path.startsWith('\\\\?\\UNC\\')) path = '\\\\' + path.slice(8);
  else if (windows && path.startsWith('\\\\?\\') && /^[a-z]:/i.test(path.slice(4))) path = path.slice(4);
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
  const files = [normalize(INDEX), ...productFiles(join(root, PRODUCT)).map((file) => join(PRODUCT, file))];
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
  if (!walk('') || !actual.has(normalize(INDEX))) return null;
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
function codexCommand(env = process.env) {
  const found = executable('codex', env);
  if (found) return found;
  throw fail('没找到 Codex CLI。请按官方指南安装，或把 codex 加入 PATH。\n  ' + CODEX_INSTALL,
    "Couldn't find Codex CLI. Follow the official installation guide or add codex to PATH.\n  " + CODEX_INSTALL);
}
export function codex(...args) {
  const cli = codexCommand();
  const result = spawnSync(cli.command, [...cli.args, 'plugin', ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
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
async function registration(run) {
  const row = lookup(run, 'marketplaces', 'name', MARKET, 'marketplace', 'list');
  if (!row) return null;
  let info = row.marketplaceSource;
  // Codex 0.170 on Windows can omit marketplaceSource from this list even
  // for a registered plugin. Read its configured source and verify the root
  // independently, including when the plugin itself has not been added yet.
  if (!info && windows && typeof row.root === 'string' && isAbsolute(row.root)) {
    const { config } = await nativeConfig('config/read', { includeLayers: false });
    const saved = config.marketplaces?.[MARKET];
    if (saved?.source_type === 'local' && typeof saved.source === 'string' && isAbsolute(saved.source) &&
        registeredPath(saved.source) === registeredPath(row.root)) {
      info = { sourceType: 'local', source: saved.source };
    }
  }
  const source = info?.source;
  if (info?.sourceType !== 'local' || typeof source !== 'string' || !isAbsolute(source)) {
    throw fail(
      '同名市场用了其他来源。请在 Codex 的插件设置里核对。',
      'A marketplace with the same name uses a different source. Check it in Codex plugin settings.'
    );
  }
  return registeredPath(source);
}
async function registeredMarket(run, store) {
  const path = await registration(run);
  if (path && path !== canonical(store))
    throw fail(`同名市场使用了其他来源。Codex 返回 ${path}，预期 ${store}。请在插件设置中核对。`,
      `A marketplace with the same name uses a different source. Codex returned ${path}. Expected ${store}. Check it in Codex plugin settings.`);
  return path ? store : null;
}
function marketIndex(snapshot) {
  bundleVersion(snapshot);
  const index = readJSON(join(snapshot, INDEX));
  index.plugins[0].source.path = './' + basename(snapshot) + '/' + PRODUCT;
  return index;
}
function activeSnapshot(store) {
  if (!plainFile(store, INDEX)) return null;
  const index = readJSON(join(store, INDEX));
  const relative = index?.plugins?.[0]?.source?.path;
  const name = typeof relative === 'string' && relative.split('/')[1];
  if (name && snapshotName.test(name)) {
    const snapshot = join(store, name);
    if (ownsSnapshot(snapshot, store) && isDeepStrictEqual(index, marketIndex(snapshot))) return snapshot;
  }
  throw fail('本地市场清单已变更，请在 Codex 插件设置中检查。', 'The local marketplace manifest has changed. Check it in Codex plugin settings.');
}
function activateSnapshot(store, target) {
  const current = activeSnapshot(store);
  if (current === target) return;
  const file = join(store, INDEX);
  if (target) {
    fs.mkdirSync(dirname(file), { recursive: true });
    writeAtomicJson(file, marketIndex(target));
  } else {
    fs.unlinkSync(file);
    syncStore(dirname(file));
    for (let dir = dirname(file); dir !== store; dir = dirname(dir)) {
      try {
        fs.rmdirSync(dir);
      } catch (error) {
        if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') break;
        throw error;
      }
    }
  }
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
      '已注册的安装副本被改动了。如需保留插件设置，请先备份，再运行 node scripts/install.mjs uninstall 和 node scripts/install.mjs setup。',
      'The registered plugin source has changed. Back up any plugin settings you want to keep, then run node scripts/install.mjs uninstall followed by node scripts/install.mjs setup.'
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
  const cli = codexCommand(env);
  const proc = spawn(cli.command, [...cli.args, 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], cwd, env });
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
async function hookGuidance(lang, mode, cwd = process.cwd()) {
  const settings = tr('Codex「设置 → Hooks」（CLI 输入 /hooks）', 'Codex Settings → Hooks (/hooks in the CLI)', lang);
  let hook;
  try {
    const { data } = await nativeConfig('hooks/list', { cwds: [cwd] }, { cwd, experimental: true });
    hook = data.flatMap((entry) => entry.hooks).find((h) => h.pluginId === PLUGIN_ID && h.eventName === 'userPromptSubmit');
  } catch {
    return tr(`未能读取 hook 状态。可在 ${settings} 中查看 UserPromptSubmit。`,
      `Couldn’t read the hook’s status. Check UserPromptSubmit in ${settings}.`, lang);
  }
  if (!hook) return tr('Codex 没有列出本插件的 UserPromptSubmit。请在插件设置中确认已安装并启用 Codex Polish。',
    'Codex hasn’t listed UserPromptSubmit for this plugin. Check that Codex Polish is installed and enabled in plugin settings.', lang);
  if (!hook.enabled) return tr(`UserPromptSubmit 已停用。要自动润色或附带历史，可在 ${settings} 中启用它。`,
    `UserPromptSubmit is disabled. To use automatic polishing or include history, enable it in ${settings}.`, lang);
  if (hook.trustStatus === 'trusted') return tr('Codex 已信任 UserPromptSubmit。', 'Codex trusts UserPromptSubmit.', lang);
  if (mode === 'manual' && ['modified', 'untrusted'].includes(hook.trustStatus))
    return tr(`手动润色已开启。想在改写时附带聊天历史，可在 ${settings} 中信任 UserPromptSubmit，再新开聊天。`,
      `Manual polishing is on. To include chat history, trust UserPromptSubmit in ${settings} and start a new chat.`, lang);
  if (hook.trustStatus === 'modified')
    return tr(`已安装的插件内容有变，Codex 要求重新确认。请在 ${settings} 中审查并重新信任 UserPromptSubmit，再新开聊天。`,
      `The installed plugin changed. Review and trust UserPromptSubmit again in ${settings}, then start a new chat.`, lang);
  if (hook.trustStatus === 'untrusted')
    return tr(`自动润色会把问答发给 Gemini。请在 ${settings} 中信任 UserPromptSubmit，再新开聊天。`,
      `Automatic polishing sends replies and their context to Gemini. Trust UserPromptSubmit in ${settings}, then start a new chat.`, lang);
  return tr(`请在 ${settings} 中查看 UserPromptSubmit 的信任状态。`,
    `Check the trust status of UserPromptSubmit in ${settings}.`, lang);
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
async function rollback(run, setEnabled, previous, before, target, store) {
  const market = await registeredMarket(run, store);
  if (![null, previous, target].includes(activeSnapshot(store)))
    throw fail('其他进程修改了市场。', 'Another process changed the marketplace.');
  if (!before && installed(run)) run('remove', PLUGIN_ID);
  if (!previous && market) run('marketplace', 'remove', MARKET);
  activateSnapshot(store, previous);
  if (previous && !market) run('marketplace', 'add', store);
  if (await registeredMarket(run, store) !== (previous ? store : null) || activeSnapshot(store) !== previous)
    throw fail('Codex 没有恢复更新前的市场来源。', "Codex didn't restore the previous marketplace.");
  if (before) {
    verifyReceipt(run('add', PLUGIN_ID), previous, before.version);
    await verifyInstalled(run, setEnabled, before.version, before.enabled);
  } else if (installed(run))
    throw fail('Codex 没有清除未完成的安装。', "Codex didn't remove the incomplete installation.");
}
export function pendingUpdate(store) {
  let fd;
  try {
    fd = openRegular(join(store, '.pending-update.json'));
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
          typeof entry.previous === 'string' && snapshotName.test(entry.previous)
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
  // Win32 does not expose a Node directory handle that supports fsync.
  if (windows) return;
  const fd = fs.openSync(store, O_RDONLY | O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function writeAtomicJson(file, entry) {
  const dir = dirname(file);
  const tmp = join(dir, '.prepare-update-' + randomUUID());
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(entry));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    syncStore(dir);
  } finally {
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
export function preserveNativeCache(store, previous, state, alternate) {
  if (store !== snapshotStore()) return;
  const version = state?.version;
  function verifiedSources() {
    return [...new Set([previous, alternate])].filter((path) =>
      path && ownsSnapshot(path, store) && statMaybe(path) && verifiedPaths(path) && bundleVersion(path) === version
    ).map((path) => join(path, PRODUCT));
  }
  try {
    const backup = preserve(codexProfile(), MARKET, NAME, version, verifiedSources);
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
  const market = await registeredMarket(run, store);
  const active = activeSnapshot(store);
  if (market && !active)
    throw fail('已注册的市场缺少安装清单，请在 Codex 插件设置中检查。', 'The registered marketplace manifest is missing. Check it in Codex plugin settings.');
  let previous = market ? active : null;
  checkSource(previous, store);
  const pending = pendingUpdate(store);
  if (pending) {
    const original = join(store, pending.previous);
    checkSource(original, store);
    if (!market || ![original, join(store, pending.target)].includes(active))
      throw fail('上次更新后，市场来源变了。请先在 Codex 里核对来源。', 'The marketplace source changed after the interrupted update. Check the source in Codex.');
    preserveNativeCache(store, active, installed(run), original);
    await rollback(run, setEnabled, original, pending, join(store, pending.target), store);
    finishPending(store);
    previous = original;
  }
  const before = installed(run);
  if (!previous && (before || (store === snapshotStore() && (await hasUnlistedPlugin())))) {
    throw fail(
      'Codex 里的安装记录缺少市场来源。如需保留插件设置，请先备份，再用这个包运行 uninstall 和 setup。',
      'The Codex installation record is missing its marketplace source. Back up any plugin settings you want to keep, then run uninstall and setup from this package.'
    );
  }
  if (before && (typeof before.enabled !== 'boolean' || typeof before.version !== 'string')) {
    throw fail(
      'Codex 没有返回能核对的原安装版本和启用状态。',
      "Codex didn't report the installed version and enabled state."
    );
  }
  const enabled = before?.enabled ?? true;
  const [target, version] = makeSnapshot(root, store, before ? [before.version] : [], previous);
  if (before)
    writeAtomicJson(join(store, '.pending-update.json'), { previous: basename(previous), target: basename(target), version: before.version, enabled });
  preserveNativeCache(store, previous, before);
  try {
    activateSnapshot(store, target);
    if (!market) run('marketplace', 'add', store);
    verifyReceipt(run('add', PLUGIN_ID), target, version);
    if (await registeredMarket(run, store) !== store || activeSnapshot(store) !== target)
      throw fail(
        'Codex 没有确认这次安装的市场来源。',
        "Codex didn't confirm the marketplace source for this installation."
      );
    await verifyInstalled(run, setEnabled, version, enabled);
  } catch (error) {
    try {
      await rollback(run, setEnabled, previous, before, target, store);
    } catch (rollbackError) {
      const describe = err => err instanceof SetupError ? err.message : [err.code, err.syscall, err.path].filter(Boolean).join(' ') || err.message;
      throw fail(
        `安装失败：${describe(error)}\n恢复失败：${describe(rollbackError)}\n本地快照已保留，请重新运行 setup。`,
        `Installation failed: ${describe(error)}\nCodex couldn't restore the previous installation: ${describe(rollbackError)}\nThe local copy is still there. Run setup again.`
      );
    }
    if (before) finishPending(store);
    throw error;
  }
  if (before) finishPending(store);
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
  return [status, true];
}
// Node has no unlinkat. Pin each directory as the kernel cwd for this synchronous
// walk and check inode identity after chdir, before any relative unlink/rmdir.
function removeVerifiedEntries(entry, paths) {
  function enter(path, expected) {
    process.chdir(path);
    const current = fs.statSync('.', { bigint: true });
    if (!sameEntry(current, expected))
      throw new Error('Directory changed during cleanup');
  }
  function removeChildren(relative) {
    const parent = fs.statSync('.', { bigint: true });
    for (const name of fs.readdirSync('.')) {
      const child = join(relative, name);
      if (!paths.has(child)) continue;
      const info = fs.lstatSync(name, { bigint: true });
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
    const store = fs.statSync('.', { bigint: true });
    const info = fs.lstatSync(basename(entry), { bigint: true });
    if (!info.isDirectory()) throw new Error('Snapshot changed during cleanup');
    enter(basename(entry), info);
    removeChildren('');
    enter('..', store);
    fs.rmdirSync(basename(entry));
  } finally {
    process.chdir(cwd);
  }
}
function removeProfileSettings(directory, kept) {
  const entry = statMaybe(directory);
  if (!entry) return;
  if (!entry.isDirectory()) {
    kept.push(directory);
    return;
  }
  for (const file of [...PROFILE_PREFERENCE_FILES, OPENAI_OFFER_FILE]) {
    try {
      accessSettingFile(directory, 'remove', file);
    } catch (error) {
      if (error.code !== 'EINVAL') throw Object.assign(error, { path: join(directory, file) });
      kept.push(join(directory, file));
    }
  }
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;
  }
}
function cleanUninstallData(store) {
  const lang = language();
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
    const settings = join(dirname(store), 'settings');
    try {
      clearOpenAIKey();
    } catch {
      errors.push(join(dirname(store), 'credentials'));
    }
    try {
      cleanupProjectSettings();
    } catch (error) {
      errors.push(error.path || dirname(store));
    }
    try {
      removeProfileSettings(settings, kept);
    } catch (error) {
      errors.push(error.path || settings);
    }
    try {
      const retained = removeProfileCache();
      if (retained) kept.push(retained);
    } catch (error) {
      errors.push(error.path || store);
    }
  }
  let message = tr('回复润色已卸载。', 'Uninstalled Codex Polish.', lang);
  if (kept.length)
    message +=
      '\n' +
      tr('下面这些路径有改动或额外内容，已保留：', 'Kept these paths because they have changes or extra contents:', lang) +
      '\n' +
      kept.join('\n');
  if (errors.length)
    throw new SetupError(
      message +
        '\n' +
        tr(
          '没法检查或清理下面这些路径。请关闭还在用这个插件的会话，检查权限，再重新卸载：',
          "Couldn't clean up these paths. Close any sessions using the plugin, check permissions, and run uninstall again:", lang
        ) +
        '\n' +
        errors.join('\n')
    );
  return message;
}
async function uninstall(store, run) {
  const market = await registeredMarket(run, store);
  const active = activeSnapshot(store);
  const previous = market && active;
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
  if (present || previous) {
    // A known marketplace can still be removed if its interrupted-update journal is damaged.
    let pending;
    try {
      pending = pendingUpdate(store);
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
    }
    preserveNativeCache(store, previous, before, pending && join(store, pending.previous));
  }
  if (present) {
    run('remove', PLUGIN_ID);
    if (!previous && store === snapshotStore() ? await hasUnlistedPlugin() : installed(run))
      throw fail(
        'Codex 还是显示这个插件已安装，请再试一次卸载。',
        'Codex still lists the plugin as installed. Run uninstall again.'
      );
  }
  if (market) {
    run('marketplace', 'remove', MARKET);
    if (await registration(run))
      throw fail(
        'Codex 还是显示这个市场已注册，请再试一次卸载。',
        'Codex still lists the marketplace. Run uninstall again.'
      );
  }
  activateSnapshot(store, null);
  return cleanUninstallData(store);
}
// A previous installer may still hold its SQLite lock. Only a regular, empty,
// single-link file with the original identity is eligible for removal.
async function withExistingLock(file, action, remove) {
  const entry = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!entry?.isFile() || entry.size !== 0n || entry.nlink !== 1n) return action();
  const { DatabaseSync } = sqliteModule();
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'rw');
  const db = new DatabaseSync(url.href);
  let result;
  try {
    try { db.exec('BEGIN EXCLUSIVE'); }
    catch (error) {
      if (![5, 6].includes(error.errcode)) throw error;
      throw fail('另一个安装程序正在运行，请等它结束后再试。', 'Another installer is running. Try again after it finishes.');
    }
    result = await action();
  } finally {
    db.close();
  }
  if (remove) {
    const current = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (current?.isFile() && current.size === 0n && current.nlink === 1n && sameEntry(entry, current)) fs.unlinkSync(file);
  }
  return result;
}

function removeEmptyDirectory(directory) {
  try { fs.rmdirSync(directory); }
  catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

export async function manage(action, root, store, run = codex, setEnabled = writeEnabled) {
  const profileStore = store === snapshotStore();
  const anchor = profileStore ? codexProfile() : dirname(store);
  fs.mkdirSync(anchor, { recursive: true, mode: 0o700 });
  const result = await withLock(anchor, async () => {
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
    // Windows can expand 8.3 names and casing in a realpath. Inspect each
    // named directory so those aliases work and junctions stay excluded.
    let ordinary = isAbsolute(store);
    for (let dir = store; ordinary && dir !== dirname(dir); dir = dirname(dir))
      ordinary = fs.lstatSync(dir).isDirectory();
    if (!ordinary) {
      throw fail('快照目录路径异常，请检查后再试。', 'Unexpected snapshot directory. Check this path before trying again.');
    }
    const remove = action === 'uninstall';
    const status = await withExistingLock(join(store, '.installer.sqlite'), async () => {
      if (!remove) return setup(root, store, run, setEnabled, action);
      const message = await uninstall(store, run);
      finishPending(store);
      return [message, false];
    }, remove);
    if (remove) {
      removeEmptyDirectory(store);
      if (profileStore) removeEmptyDirectory(dirname(store));
    }
    return status;
  });
  if (action === 'uninstall' && profileStore) {
    const target = agyDirectory();
    const file = join(target, '.codex-polish-agy.sqlite');
    if (statMaybe(file)) await withLock(target, () => withExistingLock(file, () => {}, true));
  }
  return result;
}
function readChecks() {
  return { ...runtimeStatus(), ...languageSettings() };
}
function checkAgyVersion(checks) {
  if (checks.agy_path && checks.agy_available && !supportedAgy(checks.agy_path)) {
    checks.agy_available = false;
    checks.blockers.push('agy_unsupported');
  }
  return checks;
}

function saveSetupMode(file, value) {
  try {
    writeProfileSetting(file, value);
  } catch {
    throw new SetupError(tr('无法保存默认设置。请检查 Codex 用户目录的写入权限。',
      'Could not save your defaults. Check write access to your Codex profile.', language()));
  }
}
async function runBootstrap(script, target, options) {
  const shell = windows ? windowsSystemTool('WindowsPowerShell/v1.0/powershell.exe') : '/bin/bash';
  const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] : [];
  const proc = spawn(shell, [...args, script, '--dir', target], { ...options, stdio: 'ignore', detached: !windows, windowsHide: true });
  function killGroup() {
    if (proc.pid) {
      try {
        if (windows) {
          spawnSync(windowsSystemTool('taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          proc.kill('SIGKILL');
        } else process.kill(-proc.pid, 'SIGKILL');
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
function agyEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['OPENAI_API_KEY', 'GEMINI_API_KEY', 'BASH_ENV', 'ENV'].includes(key.toUpperCase())) delete env[key];
  }
  return env;
}
function supportedAgy(binary) {
  const result = spawnSync(binary, ['--version'], {
    env: agyEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000, maxBuffer: 16 * 1024, killSignal: 'SIGKILL'
  });
  const version = result.status === 0 && /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)(?=\s|$)/.exec(result.stdout);
  return Boolean(version && compareVersions(version[1], '1.2.1') >= 0);
}
export async function installAgy() {
  const target = agyDirectory();
  fs.mkdirSync(target, { recursive: true });
  await withLock(target, () => withExistingLock(join(target, '.codex-polish-agy.sqlite'), async () => {
    const existing = findAgy();
    if (existing) {
      if (supportedAgy(existing)) return;
      throw fail('请将现有的 Antigravity CLI 更新到 1.2.1 或更高版本。', 'Update your existing Antigravity CLI to version 1.2.1 or later.');
    }
    const binary = join(target, windows ? 'agy.exe' : 'agy');
    if (statMaybe(binary))
      throw fail(`请先检查 ${binary}，这个路径已被占用。`, `Check ${binary}. That path is already in use.`);
    const temp = fs.mkdtempSync(join(tmpdir(), 'codex-polish-agy-')),
      script = join(temp, windows ? 'install.ps1' : 'install.sh');
    const options = { cwd: temp, env: agyEnvironment() };
    try {
      await downloadBootstrap(script);
      try {
        await runBootstrap(script, target, options);
        if (!supportedAgy(binary))
          throw fail('需要 Antigravity CLI 1.2.1 或更新版。', 'Antigravity CLI 1.2.1 or later is required.');
      } catch (error) {
        if (statMaybe(binary) && !fs.lstatSync(binary).isDirectory()) fs.unlinkSync(binary);
        throw error;
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, true));
}
function decisionsSummary(checks, lang) {
  if (checks.mode === 'manual' || checks.mode === 'off') {
    const current = checks.mode === 'manual'
      ? tr('点名润色会用 Turbo，直接交给 Gemini。', 'Requested rewrites use Turbo and go straight to Gemini.', lang)
      : tr('已关闭润色。', 'Polishing is off.', lang);
    if (checks.rewrite_mode === 'normal' && checks.decisions_mode === 'auto' && checks.openai_key_configured && !checks.openai_key_malformed)
      return current + tr('切回自动润色后，Normal 会使用你已开启的 OpenAI Decisions API 检查。',
        ' Switching to automatic polishing will use the OpenAI Decisions API check you enabled for Normal mode.', lang);
    return current;
  }
  if (checks.rewrite_mode === 'turbo')
    return tr(
      '自动润色时，Turbo 会跳过 OpenAI Decisions API 检查，把草稿直接交给 Gemini。可在 Codex 里说「恢复普通模式」。',
      'For automatic polishing, Turbo skips the OpenAI Decisions API check and sends each draft directly to Gemini. Say “Switch back to normal mode” to restore Normal for automatic polishing.',
      lang
    );
  if (checks.decisions_mode === 'off')
    return tr(
      '自动润色的 OpenAI Decisions API 检查已关闭，草稿会直接交给 Gemini 润色。',
      'The OpenAI Decisions API check for automatic polishing is off. Drafts go straight to Gemini.',
      lang
    );
  if (checks.openai_key_malformed)
    return tr(`无法使用为插件保存的 OpenAI 密钥。草稿会直接交给 Gemini。可在终端运行 ${openAICommand} 更换或移除密钥。`,
      `The saved OpenAI key is unusable. Drafts go straight to Gemini. Run ${openAICommand} in your terminal to replace or remove the key.`, lang);
  if (checks.decisions_enabled)
    return tr(
      `OpenAI Decisions API 检查已开启。插件会提交本轮问题、草稿和已设置的自定义润色提示词，检查是否需要 Gemini 改写，API 费用由你的 OpenAI 账号承担。可在终端运行 ${openAICommand} 更换或移除密钥。`,
      `The OpenAI Decisions API check is on. It uses the current question, draft, and any custom polishing prompt to check whether Gemini should rewrite the draft. Your OpenAI account pays for the API calls. Run ${openAICommand} in your terminal to replace or remove the key.`,
      lang
    );
  return tr(
    `自动润色时，草稿会直接交给 Gemini。想用 OpenAI Decisions API 检查是否需要 Gemini 改写，可在终端运行 ${openAICommand} 添加自己的 API 密钥。`,
    `Drafts go straight to Gemini during automatic polishing. To enable an optional OpenAI Decisions API check with your own API key, run ${openAICommand} in your terminal.`,
    lang
  );
}
const issues = {
  mode_invalid: [
    'codex-polish.mode 无效。请设为 auto、manual 或 off。',
    'Invalid codex-polish.mode. Choose auto, manual or off.'
  ],
  history_turns_invalid: [
    'codex-polish.history-turns 无效。请填写 0 到 10 的整数。',
    'Invalid codex-polish.history-turns. Choose a whole number from 0 to 10.'
  ],
  decisions_mode_invalid: [
    'codex-polish.decisions 无效。请设为 auto（使用已为插件开启的 OpenAI Decisions API 检查）或 off。',
    'Invalid codex-polish.decisions. Choose auto (use the OpenAI Decisions API check if enabled for this plugin) or off.'
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
    `找不到 agy。运行 ${installAgyCommand} 安装。`,
    `Couldn't find agy. Run ${installAgyCommand} to install it.`,
    AGY_INSTALL
  ],
  agy_unsupported: [
    '请确认 agy --version 能显示 1.2.1 或更高版本。需要更新时可参考 Google 的安装指南。',
    'Check that agy --version reports 1.2.1 or later. To update your installation, follow Google’s guide.',
    AGY_INSTALL
  ],
  unsupported_google_auth: [
    '移除 CODEX_POLISH_AGY_AUTH 就能恢复 Antigravity 默认登录（existing-session）。',
    'Unset CODEX_POLISH_AGY_AUTH to use the default Antigravity sign-in (existing-session).'
  ],
  rewrite_mode_invalid: [
    '自动润色的改写模式无效。点名润色仍使用 Turbo。要恢复自动润色，请在 Codex 里说「恢复普通模式」或「切换到 Turbo 模式」。',
    'The automatic rewrite mode is invalid. Explicit requests still use Turbo. To restore automatic polishing, ask Codex to “Switch back to normal mode” or “Switch to turbo mode”.'
  ],
  gemini_model_invalid: [
    '改写模型设置无效。请在 Codex 里说「选择改写模型」。',
    "The model setting is invalid. Ask Codex to “Choose a rewrite model”."
  ],
  editor_prompt_invalid: [
    '当前 Codex 配置的润色提示词无效。请在 Codex 里说「设置润色提示词」并提供新文本，或说「恢复默认润色提示词」。',
    'The editing prompt for this Codex profile is invalid. Ask Codex to “Set the polishing prompt” with new text or “Restore the default polishing prompt”.'
  ],
  unsupported_node: [
    '安装 Node.js 22.16 或更高版本，再用 node --version 检查。',
    'Install Node.js 22.16 or later and check with node --version.'
  ]
};
export function setupIssues(checks, lang = checks.ui_language || language()) {
  const lines = [],
    pages = new Set();
  for (const [code, [zh, en, url]] of Object.entries(issues))
    if (checks.blockers.includes(code)) {
      lines.push(tr(zh, en, lang) + (url ? '\n  ' + url : ''));
      if (url === GEMINI_KEYS) pages.add(url);
    }
  return [lines, [...pages]];
}
async function ask(prompt) {
  const io = createPrompt({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  io.once('SIGINT', cancel);
  io.once('close', cancel);
  try {
    return (await io.question(prompt, { signal: controller.signal })).trim();
  } catch {
    console.log();
    return null;
  } finally {
    io.close();
  }
}
function openPage(url) {
  if (windows)
    return spawnSync(windowsSystemTool('rundll32.exe'), ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', timeout: 5000 }).status === 0;
  return (
    spawnSync(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { stdio: 'ignore', timeout: 5000 })
      .status === 0
  );
}
async function* terminalKeys(input, output, show, signal) {
  if (input.destroyed || input.readableEnded || signal?.aborted) return;
  const wasRaw = !!input.isRaw;
  const wasFlowing = input.readableFlowing;
  function restoreInput() {
    if (!wasRaw && input.isRaw && !input.destroyed) input.setRawMode(false);
  }
  emitKeypressEvents(input);
  const keys = on(input, 'keypress', { close: ['end', 'close'], signal });
  // A stream may destroy its terminal handle immediately after emitting end.
  input.once('end', restoreInput);
  try {
    if (!wasRaw) input.setRawMode(true);
    input.resume();
    show();
    yield* keys;
  } catch (error) {
    if (!signal?.aborted || error.name !== 'AbortError') throw error;
  } finally {
    await keys.return();
    input.off('end', restoreInput);
    restoreInput();
    if (!wasFlowing) input.pause();
    output.write('\n');
  }
}
async function chooseOption(title, options, lang, input = process.stdin, output = process.stdout, initialChoice, signal) {
  let selected = Math.max(0, options.findIndex(option => option.id === initialChoice));
  function draw() {
    for (const [index, option] of options.entries()) {
      clearLine(output, 0);
      // A provider label is display text, including any literal terminal controls.
      const label = option.name.replace(/\p{Cc}/gu, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
      output.write((selected === index ? '❯ ● ' : '  ○ ') + label);
      if (index < options.length - 1) output.write('\r\n');
    }
  }
  const show = () => {
    output.write(title + '\n' + tr('用 ↑ ↓ 移动，按回车确认，按 Esc 取消。\n', 'Use ↑ ↓ to move, Enter to confirm, or Esc to cancel.\n', lang));
    draw();
  };
  for await (const [, key] of terminalKeys(input, output, show, signal)) {
    if (key.name === 'return' || key.name === 'enter') return options[selected].id;
    if (key.name === 'escape' || (key.ctrl && ['c', 'd'].includes(key.name))) return null;
    if (key.name !== 'up' && key.name !== 'down') continue;
    const next = Math.max(0, Math.min(options.length - 1, selected + (key.name === 'up' ? -1 : 1)));
    if (next === selected) continue;
    selected = next;
    moveCursor(output, 0, 1 - options.length);
    cursorTo(output, 0);
    draw();
  }
  return null;
}

async function readHiddenKey(lang, input, output) {
  const show = () => output.write(tr('在此粘贴 OpenAI API 密钥（输入隐藏，留空按回车可返回）：',
    'Paste your OpenAI API key here (input is hidden, press Enter with an empty field to go back): ', lang));
  let value = '';
  for await (const [text, key] of terminalKeys(input, output, show)) {
    if (key.name === 'escape' || (key.ctrl && ['c', 'd'].includes(key.name))) return null;
    if (key.name === 'return' || key.name === 'enter') return value || null;
    if (key.name === 'backspace') value = value.slice(0, -1);
    else if (key.ctrl && key.name === 'u') value = '';
    else if (text && !key.ctrl && !key.meta) value += text;
  }
  return null;
}

export async function manageOpenAI(lang, { onboarding = false, input = process.stdin, output = process.stdout } = {}) {
  const t = (zh, en) => tr(zh, en, lang);
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    if (onboarding) return true;
    throw new SetupError(t(`请在交互式终端中运行 ${openAICommand}，以隐藏输入的密钥。`,
      `Run ${openAICommand} in an interactive terminal so your key can be entered privately.`));
  }
  if (onboarding && readProfileSetting(OPENAI_OFFER_FILE, 16) !== null) return true;
  const existing = readOpenAIKey();
  if (onboarding && existing !== null) return true;
  const title = onboarding
    ? t('使用 OpenAI Decisions API 判断是否需要 Gemini 改写？（可选，按用量计费）',
      'Use the OpenAI Decisions API to check whether Gemini should rewrite the draft? (Optional, billed by API usage)')
    : t('可选的 OpenAI Decisions API 检查', 'Optional OpenAI Decisions API check');
  const details = t('在 Normal 自动润色时，插件会把本轮问题、草稿和你设置的自定义润色提示词发给 OpenAI Decisions API，检查是否需要 Gemini 改写。API 调用由你的 OpenAI 账号付费。',
    'In Normal mode, automatic polishing sends the current question, draft, and any custom polishing prompt to the OpenAI Decisions API to check whether Gemini should rewrite the draft. Your OpenAI account pays for these API calls.');
  const enable = { id: 'enable', name: t('用自己的 OpenAI API 密钥开启检查', 'Enable with my own OpenAI API key') };
  const back = { id: 'back', name: t('返回', 'Back') };
  let choices;
  if (existing !== null) {
    output.write(t(existing ? '当前配置已保存 OpenAI 密钥。\n' : '当前配置里的 OpenAI 密钥无法使用。\n',
      existing ? 'This profile has a saved OpenAI key.\n' : 'This profile has an unusable OpenAI key.\n'));
    choices = [back, { id: 'replace', name: t('更换密钥', 'Replace key') },
      { id: 'remove', name: t('移除密钥并关闭检查', 'Remove key and turn off the check') }];
  } else if (onboarding) {
    choices = [{ id: 'skip', name: t('跳过，只使用 Gemini（默认）', 'Skip and use Gemini only (default)') }, enable];
  } else {
    choices = [enable, back];
  }
  const action = await chooseOption(title, choices, lang, input, output);
  if (!action || action === 'back') return true;
  try {
    if (action === 'skip' || action === 'remove') {
      if (action === 'remove') {
        clearOpenAIKey();
        output.write(t('已移除密钥，OpenAI Decisions API 检查已关闭。\n', 'Key removed. The OpenAI Decisions API check is off.\n'));
      }
      try { writeProfileSetting(OPENAI_OFFER_FILE, 'seen'); }
      catch {
        output.write(t('安装程序无法记住这次选择，下次安装时会再询问。\n',
          'The installer could not remember this choice and may ask again next time.\n'));
        return false;
      }
      if (action === 'skip') output.write(t('已选择只使用 Gemini。\n', 'Gemini only.\n'));
      return true;
    }
    output.write(details + '\n' + t('在 OpenAI 创建 API 密钥：', 'Create an API key at OpenAI: ') + OPENAI_KEYS + '\n');
    const value = await readHiddenKey(lang, input, output);
    if (value === null) return true;
    saveOpenAIKey(value);
    if (action === 'enable') writeProfileSetting(DECISIONS_FILE, null);
    output.write(t('已保存密钥。Normal 模式自动润色时可使用 OpenAI Decisions API 检查。\n',
      'Key saved. The OpenAI Decisions API check is available for automatic polishing in Normal mode.\n'));
    return true;
  } catch (error) {
    if (error instanceof RangeError)
      output.write(t('密钥格式有误。请重新运行命令，并粘贴完整密钥。\n',
        'Invalid key format. Run the command again and paste the complete key.\n'));
    else output.write(t('无法保存更改。请检查 Codex 用户目录的权限。\n',
      'Could not save this change. Check the permissions for your Codex profile.\n'));
    return false;
  }
}
export function chooseSetupMode(lang, current, input, output) {
  const currentLabel = id => id === current ? tr('（当前）', ' (current)', lang) : '';
  const normalLabel = current ? currentLabel('normal') : tr('（默认）', ' (default)', lang);
  return chooseOption(tr('在 Codex 中如何润色？', 'How should Codex replies be polished?', lang), [
    { id: 'normal', name: 'Normal' + normalLabel + tr(' · 按需改写', ' · rewrite when useful', lang) },
    { id: 'turbo', name: 'Turbo' + currentLabel('turbo') + tr(' · 每次都请 Gemini 改写', ' · ask Gemini to rewrite every time', lang) },
    { id: 'manual', name: tr('仅手动 · 只在我要求时润色', 'Only when asked', lang) + currentLabel('manual') },
    { id: 'off', name: tr('关闭润色', 'Turn off polishing', lang) + currentLabel('off') }
  ], lang, input, output, current);
}

// Keep Esc, Ctrl-C and EOF responsive while the Codex agent reads account metadata.
async function waitForCatalog(operation, message, input, output, signal) {
  const controller = new AbortController();
  const cancelled = (async () => {
    const show = () => output.write(message);
    for await (const [, key] of terminalKeys(input, output, show, AbortSignal.any([signal, controller.signal]))) {
      if (key.name === 'escape' || (key.ctrl && ['c', 'd'].includes(key.name))) break;
    }
    return null;
  })();
  try {
    return await Promise.race([cancelled, operation()]);
  } finally {
    controller.abort();
    await cancelled;
  }
}

const thinkingLabels = {
  low: ['低', 'Low'], medium: ['中', 'Medium'], high: ['高', 'High'], xhigh: ['极高', 'Extra High'],
  fixed: ['由模型固定', 'Fixed by the model']
};

export async function chooseSetupModel(checks, lang, input = process.stdin, output = process.stdout, openCatalog = openSetupCatalog) {
  const controller = new AbortController();
  const choose = (title, rows, initial) => chooseOption(title, rows, lang, input, output, initial, controller.signal);
  const t = (zh, en) => tr(zh, en, lang);
  const savedModel = checks.gemini_model_configured ? checks.gemini_model : null;
  const savedLevel = checks.gemini_thinking_level;
  const choices = [
    { id: 'default', name: t('Gemini 4 Hydrogen（默认）', 'Gemini 4 Hydrogen (default)') },
    { id: 'lookup', name: t('让 Codex 查询我账号的可用模型…', 'Ask Codex to list models available to my account…') }
  ];
  if (savedModel && savedModel !== DEFAULT_GEMINI_MODEL) {
    const level = t(...thinkingLabels[savedLevel]);
    choices.unshift({ id: 'keep', name: t(`保留 ${savedModel} · ${level}`, `Keep ${savedModel} · ${level}`) });
  }
  const choice = await choose(t('选择改写用的 Gemini 模型', 'Choose the Gemini model for rewrites'), choices);
  if (!choice) return null;
  if (choice === 'keep') return { model: savedModel, thinkingLevel: savedLevel };
  async function chooseLevel(model, levels, current) {
    if (!levels.length) {
      output.write(t('这个模型的思考等级固定。', 'This model has a fixed thinking level.') + '\n');
      return { model, thinkingLevel: 'fixed' };
    }
    const rows = levels.map(({ id, name }) => {
      const label = Object.hasOwn(thinkingLabels, id) ? t(...thinkingLabels[id]) : name;
      return { id, name: id === DEFAULT_THINKING_LEVEL ? label + t('（默认）', ' (default)') : label };
    });
    const defaultLevel = rows.some(row => row.id === DEFAULT_THINKING_LEVEL) ? DEFAULT_THINKING_LEVEL : current;
    const initial = model === savedModel && rows.some(row => row.id === savedLevel) ? savedLevel : defaultLevel;
    const thinkingLevel = await choose(t('思考等级', 'Thinking level'), rows, initial);
    return thinkingLevel ? { model, thinkingLevel } : null;
  }
  if (choice === 'default') {
    const levels = savedModel === DEFAULT_GEMINI_MODEL && savedLevel === 'fixed' ? ['fixed'] : ['low', 'medium', 'high', 'xhigh'];
    return chooseLevel(DEFAULT_GEMINI_MODEL, levels.map(id => ({ id })));
  }

  let session, model;
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    session = await openCatalog(checks);
    const account = await waitForCatalog(() => session.list(),
      t('正在读取账号可用模型…（Esc 取消）', 'Looking up your models… (Esc to cancel)'), input, output, controller.signal);
    if (!account) return null;
    const rows = account.models.map(({ id, name }) => ({
      id, name: account.models.some(other => other.id !== id && other.name === name) ? name + ' (' + id + ')' : name
    }));
    model = await choose(t('用哪个模型改写？', 'Which model should rewrite your replies?'), rows, savedModel);
    if (!model) return null;
    const selected = account.current_model === model ? await session.select(model) :
      await waitForCatalog(() => session.select(model),
        t('正在读取思考等级…（Esc 取消）', 'Reading thinking levels… (Esc to cancel)'), input, output, controller.signal);
    if (!selected) return null;
    return await chooseLevel(model, selected.thinking_levels, selected.current_thinking_level);
  } catch {
    if (controller.signal.aborted) return null;
    output.write((model
      ? t('没能读取这个模型的思考等级。稍后在 Codex 里说「选择改写模型」可重试。',
        'Couldn’t read this model’s thinking levels. Say “Choose a rewrite model” in Codex to retry.')
      : t('没能读取模型。稍后在 Codex 里说「选择改写模型」可重试。',
        'Couldn’t read the model list. Say “Choose a rewrite model” in Codex to retry.')) + '\n');
    return null;
  } finally {
    process.off('SIGTERM', interrupt);
    process.off('SIGINT', interrupt);
    await session?.close();
  }
}

export async function showSetupGuidance({
  installDependency = false,
  dependencyOnly = false,
  interactive = process.stdin.isTTY && process.stdout.isTTY,
  check = readChecks,
  saveRewriteMode = value => saveSetupMode(REWRITE_MODE_FILE, value),
  saveTriggerMode = value => saveSetupMode(MODE_FILE, value),
  saveModel = ({ model, thinkingLevel }, lang) => saveModelSelection(model, thinkingLevel, lang),
  chooseMode = chooseSetupMode,
  chooseModel = chooseSetupModel,
  offerOpenAI = lang => manageOpenAI(lang, { onboarding: true }),
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
        '没能完成环境检查。在 Codex 里新开一个对话，说「配置回复润色」再试一次。',
        "Couldn't finish the environment check. Open a new chat in Codex and say “Set up Codex Polish” to try again."
      )
    );
    return !installDependency;
  }
  if (interactive && !dependencyOnly) {
    const current = currentSetupMode(checks);
    const selected = await chooseMode(lang, current);
    if (!selected) return true;
    if (selected !== current) {
      const useAutomatic = REWRITE_MODES.includes(selected);
      const mode = useAutomatic ? 'auto' : selected;
      if (useAutomatic && (!checks.rewrite_mode_configured || selected !== checks.rewrite_mode)) {
        await saveRewriteMode(selected);
      }
      if (mode !== checks.mode) await saveTriggerMode(mode);
      checks = check();
    }
  }
  if (checks.mode === 'off') {
    console.log(tr('已关闭润色。要重新开启，可再次运行 setup。', 'Polishing is off. Run setup again to turn it back on.', lang));
    if (!installDependency || (interactive && !dependencyOnly)) return true;
    dependencyOnly = true;
  }
  checkAgyVersion(checks);
  if (installDependency && checks.blockers.includes('agy_unsupported')) {
    console.error(tr(issues.agy_unsupported[0], issues.agy_unsupported[1], lang) + '\n' + AGY_INSTALL);
    return false;
  }
  if (checks.blockers.includes('agy_missing')) {
    let requested = installDependency;
    if (interactive && !requested)
      requested = ['', 'y', 'yes', '是'].includes(
        (await prompt(
          tr(
            '改写回复需要 Google 的 Antigravity 命令行工具（agy）。现在安装吗？[Y/n] ',
            'Codex Polish needs Google’s Antigravity CLI (agy). Install it now? [Y/n] ',
            lang
          )
        ))?.toLowerCase()
      );
    if (requested) {
      try {
        console.log(tr('正在从 Google 下载并安装 agy…', 'Downloading and installing agy from Google…', lang));
        await install();
        checks = checkAgyVersion(check());
        if (!checks.agy_available)
          throw fail('装好后仍找不到 agy。', 'The installer finished, but agy is still missing.');
        console.log(tr('agy 已安装，可以使用。', 'agy is installed and ready to use.', lang));
      } catch (error) {
        if (error instanceof SetupError) console.error(error.message);
        console.error(
          tr(
            `插件已安装。要重新安装 agy，运行 ${installAgyCommand}。`,
            `The plugin is installed. To retry the agy installation, run ${installAgyCommand}.`,
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
  if (!interactive)
    console.log(tr('要选择默认模式和模型，请在交互式终端运行 setup。', 'Run setup in an interactive terminal to choose your default mode and model.', lang));
  if (interactive && checks.agy_available && !checks.blockers.includes('agy_unsupported')) {
    const selected = await chooseModel(checks, lang);
    if (!selected) return true;
    if (!checks.gemini_model_configured || selected.model !== checks.gemini_model || selected.thinkingLevel !== checks.gemini_thinking_level) {
      await saveModel(selected, lang);
      checks = check();
    }
  }
  const [lines, pages] = setupIssues(checks, lang);
  if (lines.length) console.log(lines.join('\n'));
  if (interactive && checks.mode === 'auto' && checks.rewrite_mode === 'normal' && checks.rewrite_mode_configured && !checks.blockers.length)
    await offerOpenAI(lang);
  if (
    pages.length &&
    interactive &&
    (await prompt(
      tr(
        '输入 y 在浏览器打开上面的官方页面，直接回车跳过：',
        'Type y to open the official links above, or press Enter to skip: ',
        lang
      )
    ))?.toLowerCase() === 'y'
  ) {
    for (const page of pages)
      if (!browse(page))
        console.log(tr(`浏览器没能打开页面，请手动访问 ${page}`, `Couldn't open the browser. Visit ${page}`, lang));
  }
  return true;
}

function currentSetupMode(checks) {
  if (checks.mode !== 'auto') return checks.mode;
  return checks.rewrite_mode_configured ? checks.rewrite_mode : undefined;
}

export function doctor(checks = checkAgyVersion(readChecks())) {
  const lang = checks.ui_language,
    modes = { manual: ['只在我要求时', 'only when asked'], auto: ['自动改写', 'automatic'], off: ['已关闭', 'off'] };
  const lines = [
    tr('润色时机：', 'When to polish: ', lang) + tr(...(modes[checks.mode] ?? ['设置无效', 'invalid setting']), lang),
    tr('自动润色的改写模式：', 'Automatic rewrite mode: ', lang) + (checks.rewrite_mode || tr('设置无效', 'invalid setting', lang)),
    tr('改写模型：', 'Rewrite model: ', lang) + (checks.gemini_model || tr('设置无效', 'invalid setting', lang)),
    tr('思考等级：', 'Thinking level: ', lang) + (Object.hasOwn(thinkingLabels, checks.gemini_thinking_level)
      ? tr(...thinkingLabels[checks.gemini_thinking_level], lang) : checks.gemini_thinking_level || tr('设置无效', 'invalid setting', lang))
  ];
  if (checks.rewrite_mode && checks.decisions_mode !== null) lines.push(decisionsSummary(checks, lang));
  const turns = checks.history_turns;
  if (turns !== null) lines.push(
    turns
      ? tr(
          `对于整条回复，Gemini 改写时最多带上最近 ${turns} 轮完整问答，原问题和草稿另算。`,
          `For a whole reply, Gemini receives up to ${turns} earlier completed exchanges along with the original question and draft.`,
          lang
        )
      : tr(
          '历史记录设为 0，Gemini 改写时不附带以前的问答。',
          'History is off. Gemini rewrites omit additional exchanges.',
          lang
        )
  );
  const detected =
    checks.language_mode === 'auto' ? tr('自动识别', 'automatic', lang) : tr('手动选择', 'manually selected', lang);
  lines.push(tr(`界面语言：中文（${detected}）`, `Interface language: English (${detected})`, lang));
  for (const [tool, ready] of [
    ['Node.js 22.16+', checks.node_available],
    ['Codex CLI', checks.codex_available],
    ['Antigravity CLI', checks.agy_available]
  ]) {
    const status = tool === 'Antigravity CLI' && checks.blockers.includes('agy_unsupported')
      ? tr('需要 1.2.1 或更高版本', 'requires version 1.2.1 or later', lang)
      : ready ? tr('可用', 'available', lang) : tr('未找到', 'not found', lang);
    lines.push(tool + tr('：', ': ', lang) + status);
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
        '以下设置需要处理。',
        'The following settings need attention.',
        lang
      ),
      ...setupIssues(checks, lang)[0]
    );
  return lines.join('\n');
}
function localCodexState() {
  // The native CLI creates scratch directories even for a plugin list.
  // Read the plugin table written by the native installer for this menu only.
  const config = join(codexProfile(), 'config.toml');
  if (!statMaybe(config)) return activeSnapshot(snapshotStore()) ? { enabled: true } : null;
  const lines = readPlain(config, 4 * 1024 * 1024).toString('utf8').split(/\r?\n/);
  const table = /^\s*\[\s*plugins\s*\.\s*(?:"codex-polish@codex-polish-local"|'codex-polish@codex-polish-local')\s*\]\s*(?:#.*)?$/;
  const start = lines.findIndex(line => table.test(line));
  if (start === -1) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    if (/^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(line)) return { enabled: false };
  }
  return { enabled: true };
}

async function chooseHost(lang) {
  const t = (zh, en) => tr(zh, en, lang);
  const status = read => {
    try {
      const entry = read();
      if (!entry) return [false, t('未安装', 'not installed')];
      return [true, entry.enabled ? t('已安装', 'installed') : t('已停用', 'disabled')];
    } catch {
      return [false, t('无法读取状态', 'status unavailable')];
    }
  };
  const [hasCodex, codexState] = status(localCodexState);
  const [hasAgy, agyState] = status(localAgyState);
  const choices = [
    { id: 'codex', name: t('在 Codex 里，让 Gemini 润色', 'In Codex, polish with Gemini') + ' · ' + codexState },
    { id: 'agy', name: t('在 Antigravity（agy）里，让 Codex 润色', 'In Antigravity (agy), polish with Codex') + ' · ' + agyState },
    { id: 'both', name: t('两边都配置', 'Configure both') }
  ];
  const current = hasAgy ? (hasCodex ? 'both' : 'agy') : 'codex';
  return chooseOption(t('要在 Codex 还是 Antigravity 里润色回复？', 'Set up reply polishing in Codex or Antigravity'),
    choices, lang, process.stdin, process.stdout, current);
}

const agyModeLabels = {
  normal: ['Normal · 按需改写', 'Normal · rewrite when useful'],
  turbo: ['Turbo · 每次都请 Codex 改写', 'Turbo · ask Codex to rewrite every time'],
  manual: ['仅手动 · 只在我要求时润色', 'Manual · polish only when asked'],
  off: ['关闭润色', 'Off · turn off polishing']
};
const agyDataNotice = ['Normal 模式也会把本轮问题和草稿发送给 Codex，由 Codex 判断是否需要改写。',
  'Normal mode sends the current question and draft to Codex so it can decide whether a rewrite would help.'];
const agySetupCommand = `${windows ? 'npx.cmd' : 'npx'} @kyun.si/codex-polish@beta setup --host agy`;

function agyEffortLabel(effort, lang) {
  const labels = { ...thinkingLabels, minimal: ['最低', 'Minimal'], max: ['最高', 'Maximum'] };
  return Object.hasOwn(labels, effort) ? tr(...labels[effort], lang) : effort;
}

async function chooseAgyModel(settings, { model, effort }, { signedIn }, lang) {
  const t = (zh, en) => tr(zh, en, lang);
  const defaultModel = t('Codex 默认', 'Codex default');
  const saved = (model ?? defaultModel) + (effort ? ' · ' + agyEffortLabel(effort, lang) : '');
  const choices = [
    { id: 'default', name: defaultModel },
    { id: 'keep', name: t('保留当前设置', 'Keep current settings') + ' · ' + saved },
    { id: 'lookup', name: signedIn
      ? t('选择账号可用模型和思考等级…', 'Choose a model and reasoning effort from my account…')
      : t('从 Codex 模型列表选择模型和思考等级…', 'Choose a model and reasoning effort from the Codex model list…') }
  ];
  const unavailable = signedIn
    ? t('没能读取账号模型。可使用 Codex 默认或保留当前设置。',
      'Could not read the account model list. You can use the Codex default or keep your settings.')
    : t('没能读取 Codex 模型列表。可使用 Codex 默认或保留当前设置。',
      'Could not read the Codex model list. You can use the Codex default or keep your settings.');
  while (true) {
    const choice = await chooseOption(t('选择改写用的 Codex 模型', 'Choose the Codex model for rewrites'),
      choices, lang, process.stdin, process.stdout, model || effort ? 'keep' : 'default');
    if (!choice) return null;
    if (choice === 'keep') return {};
    if (choice === 'default') return { model: null, effort: null };
    let models;
    const controller = new AbortController();
    try {
      const loading = signedIn
        ? t('正在读取 Codex 账号的可用模型…（Esc 取消）', 'Looking up models available to your Codex account… (Esc to cancel)')
        : t('正在读取 Codex 模型列表…（Esc 取消）', 'Reading the Codex model list… (Esc to cancel)');
      models = await waitForCatalog(() => settings.listModels({ signal: controller.signal }), loading,
        process.stdin, process.stdout, controller.signal);
      if (models === null) return null;
    } catch {
      console.log(unavailable);
      continue;
    } finally {
      controller.abort();
    }
    if (!models.length) {
      console.log(signedIn ? unavailable
        : t('Codex 模型列表中没有可选模型。可使用 Codex 默认或保留当前设置。',
          'The Codex model list has no models to choose from. You can use the Codex default or keep your settings.'));
      continue;
    }
    const defaultLabel = signedIn ? t('（账号默认）', ' (account default)') : t('（Codex 默认）', ' (Codex default)');
    const rows = models.map(item => ({
      id: item.id,
      name: (models.some(other => other.id !== item.id && other.name === item.name) ? item.name + ' (' + item.id + ')' : item.name) +
        (item.isDefault ? defaultLabel : '')
    }));
    const id = await chooseOption(t('用哪个模型改写？', 'Which model should rewrite your replies?'), rows,
      lang, process.stdin, process.stdout, model ?? models.find(item => item.isDefault)?.id);
    if (!id) return null;
    const selected = models.find(item => item.id === id);
    if (!selected.efforts.length) return { model: id, effort: null };
    const efforts = selected.efforts.map(id => ({
      id,
      name: agyEffortLabel(id, lang) + (id === selected.defaultEffort ? t('（模型默认）', ' (model default)') : '')
    }));
    const initial = id === model && selected.efforts.includes(effort) ? effort : selected.defaultEffort;
    const level = await chooseOption(t('Codex 思考等级', 'Codex reasoning effort'), efforts,
      lang, process.stdin, process.stdout, initial);
    return level ? { model: id, effort: level } : null;
  }
}

async function prepareAgySetup(interactive, lang) {
  const { settings, current } = await loadAgySettings();
  const t = (zh, en) => tr(zh, en, lang);
  const patch = {};
  let mode = current.mode;
  if (interactive) {
    console.log(t(...agyDataNotice));
    const modes = Object.entries(agyModeLabels).map(([id, label]) => ({
      id, name: t(...label) + (id === current.mode ? t('（当前）', ' (current)') : '')
    }));
    mode = await chooseOption(t('在 Antigravity 中如何润色？', 'How should Antigravity replies be polished?'),
      modes, lang, process.stdin, process.stdout, current.mode);
    if (!mode) return null;
    if (mode !== current.mode) patch.mode = mode;
  }
  if (mode === 'off') return { settings, patch, mode };
  if (!interactive) console.log(t(...agyDataNotice));
  const provider = await checkCodexProvider(lang);
  if (!provider.signedIn) console.log(provider.message);
  if (interactive && (provider.ready || provider.canListModels)) {
    const model = await chooseAgyModel(settings, current, provider, lang);
    if (!model) return null;
    if (Object.hasOwn(model, 'model') && (model.model !== current.model || model.effort !== current.effort)) {
      Object.assign(patch, model);
    }
  }
  return { settings, patch, mode, codexReady: provider.ready };
}

async function doctorAgy(lang) {
  const t = (zh, en) => tr(zh, en, lang);
  const { current: { mode, model, effort } } = await loadAgySettings();
  console.log(t('Antigravity 润色模式：', 'Antigravity polishing mode: ') + t(...agyModeLabels[mode]));
  const entry = installedAgy();
  if (entry) {
    console.log(t('agy-polish 已安装，版本 ', 'agy-polish is installed, version ') + entry.version +
      (entry.enabled ? '' : t('（已停用）', ' (disabled)')));
  } else {
    console.log(t('agy-polish 未安装。运行 ', 'agy-polish is not installed. Run ') + agySetupCommand);
  }
  if (mode === 'off') return entry ? 0 : 1;
  console.log(t('Codex 模型：', 'Codex model: ') + (model ?? t('Codex 默认', 'Codex default')) +
    (effort ? ' · ' + agyEffortLabel(effort, lang) : ''));
  const provider = await checkCodexProvider(lang);
  console.log(provider.message);
  return entry && provider.ready ? 0 : 1;
}

async function runAgyHost(action, plan, installDependency, lang) {
  if (action === 'doctor') return doctorAgy(lang);
  const t = (zh, en) => tr(zh, en, lang);
  const off = t('Antigravity 回复润色已关闭。再次运行 setup 可重新开启。', 'Antigravity reply polishing is off. Run setup again to turn it back on.');
  const save = async () => {
    if (!plan || !Object.keys(plan.patch).length) return;
    try { await plan.settings.writeSettings(plan.patch); }
    catch { throw fail('无法保存 agy-polish 设置。请检查设置目录的写入权限。', 'Could not save agy-polish settings. Check write access to the settings directory.'); }
  };

  if (!findAgy() && plan?.mode === 'off') {
    await save();
    console.log(off);
    return 0;
  }
  if (!findAgy() && installDependency) {
    console.log(t('正在从 Google 下载并安装 agy…', 'Downloading and installing agy from Google…'));
    await installAgy();
  }
  requireAgyCli();
  const profile = canonical(agyProfile());
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  return withLock(profile, async () => {
    const before = installedAgy();
    if (action === 'uninstall') {
      if (before) changeAgyPlugin('uninstall');
      if (installedAgy()) throw fail('agy 仍显示插件已安装，请再试一次卸载。', 'agy still lists the plugin as installed. Run uninstall again.');
      console.log(t('agy-polish 已卸载，模式和模型设置已保留。', 'agy-polish is uninstalled. Your mode and model settings were kept.'));
      return 0;
    }
    if (action === 'update' && !before) {
      console.log(t('agy-polish 未安装。要加装，运行 ', 'agy-polish is not installed. To add it, run ') + agySetupCommand);
      return 0;
    }
    const { path, version } = validateAgyBundle();
    if (before && compareVersions(version, before.version) < 0) {
      throw fail('这个包比已安装的 agy-polish 旧。请使用更新的安装包。',
        'This package is older than the installed agy-polish. Use a newer package.');
    }
    // Persist a fresh install's selected mode before agy can load the plugin.
    if (!before) await save();
    changeAgyPlugin('install', path);
    let entry = installedAgy();
    if (before?.enabled === false && entry?.enabled === true) {
      changeAgyPlugin('disable');
      entry = installedAgy();
    }
    if (!entry || entry.version !== version || (before && entry.enabled !== before.enabled)) {
      throw fail('agy 没有确认插件版本和启用状态，请在 Antigravity 中检查。',
        'agy did not confirm the plugin version and enabled state. Check the installation in Antigravity.');
    }
    if (before) await save();
    console.log(action === 'update'
      ? t('agy-polish 已更新到 ', 'Updated agy-polish to ') + version
      : t('agy-polish 已安装，版本 ', 'agy-polish is installed, version ') + version);
    if (!entry.enabled) console.log(t('插件目前仍是停用状态，可在 Antigravity 的插件设置中启用。',
      'The plugin is still disabled. You can enable it in Antigravity plugin settings.'));
    if (plan?.mode === 'off') console.log(off);
    else if (plan && entry.enabled) {
      const start = plan.codexReady
        ? t('在 Antigravity 中新开对话。', 'Start a new chat in Antigravity.')
        : t('处理上面的 Codex 问题后，在 Antigravity 中新开对话。', 'After resolving the Codex issue above, start a new chat in Antigravity.');
      const use = plan.mode === 'manual'
        ? t('输入 /polish，或提问时加一句「请润色」。', 'Use /polish or ask for polishing in your question.')
        : t('输入 /polish，或像平常一样提问。', 'Use /polish or ask a question as usual.');
      console.log(start + ' ' + use);
      console.log(t('首次看到 MCP 授权提示时，只授权 agy-polish 的 polish_reply 工具。',
        'At the first MCP approval prompt, approve only the polish_reply tool from agy-polish.'));
    }
    return 0;
  });
}

function usage(lang) {
  return tr(
    '用法：codex-polish [setup|update|doctor|uninstall] [--host codex|agy|both] [--install-agy]\nsetup（默认命令）可安装插件、选择模式和模型，或关闭润色。交互式 setup 可选择宿主。其他命令和非交互式 setup 默认使用 Codex。\nupdate 更新插件，doctor 检查设置和环境，uninstall 卸载。--install-agy 在缺少 agy 时安装，仅限 setup 和 update。\ncodex-polish openai 管理 Codex 插件的可选 OpenAI Decisions API 检查和密钥。\n-h, --help 显示帮助。',
    'Usage: codex-polish [setup|update|doctor|uninstall] [--host codex|agy|both] [--install-agy]\nsetup (default) installs the plugin, lets you choose the mode and model, or turns polishing off. Interactive setup lets you choose a host. Other commands and noninteractive setup default to Codex.\nupdate upgrades the plugin, doctor checks settings and the environment, and uninstall removes the plugin. --install-agy installs Google’s Antigravity CLI if missing during setup or update.\ncodex-polish openai manages the optional OpenAI Decisions API check and its key for the Codex plugin.\n-h, --help shows this help.',
    lang
  );
}

async function runCodexHost(action, installDependency, interactive, mode, lang) {
  if (action === 'doctor') {
    const checks = checkAgyVersion(readChecks());
    console.log(doctor(checks));
    if (checks.mode !== 'off') console.log(await hookGuidance(checks.ui_language, checks.mode));
    return 0;
  }
  const [message, enabled] = await manage(action, ROOT, snapshotStore());
  console.log(message);
  const onboard = action === 'setup' && (enabled || interactive);
  if ((onboard || installDependency) && !(await showSetupGuidance({
    installDependency, dependencyOnly: !onboard, interactive,
    ...(mode && { chooseMode: () => mode })
  }))) return 1;
  if (enabled) {
    const trigger = triggerMode();
    if (trigger !== 'off') console.log(await hookGuidance(lang, trigger, homedir()));
  }
  return 0;
}

function reportInstallerError(error, lang) {
  console.error(error instanceof SetupError || error instanceof AgyInstallError ? error.message :
    tr('没法核对安装文件或环境。请检查文件权限和发行包后再试。',
      "Couldn't verify the installation files or environment. Check the package and file permissions, then try again.", lang));
}

export async function main(args = process.argv.slice(2)) {
  const lang = language();
  if (args.includes('-h') || args.includes('--help')) {
    console.log(usage(lang));
    return 0;
  }
  let action, host, installDependency;
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: { host: { type: 'string', multiple: true }, 'install-agy': { type: 'boolean' } }
    });
    action = positionals[0] ?? 'setup';
    host = values.host?.[0];
    installDependency = values['install-agy'] ?? false;
    if (positionals.length > 1 || !['setup', 'update', 'doctor', 'openai', 'uninstall'].includes(action) ||
        (values.host && (values.host.length !== 1 || !['codex', 'agy', 'both'].includes(host) || action === 'openai'))) {
      throw new Error('invalid installer arguments');
    }
  } catch {
    console.error(usage(lang));
    return 2;
  }
  if (installDependency && !['setup', 'update'].includes(action)) {
    const flag = '--install-agy';
    console.error(tr(`${flag} 只能用于 setup 或 update`, `${flag} only works with setup or update`, lang));
    return 2;
  }
  try {
    if (action === 'openai') return (await manageOpenAI(lang)) ? 0 : 1;
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function');
    host ??= action === 'setup' && interactive ? await chooseHost(lang) : 'codex';
    if (!host) return 0;
    const useCodex = host !== 'agy';
    const useAgy = host !== 'codex';
    let codexMode, agyPlan, status = 0;
    if (action === 'setup' && interactive && useCodex) {
      const checks = readChecks();
      codexMode = await chooseSetupMode(lang, currentSetupMode(checks));
      if (!codexMode) return 0;
    }
    if (action === 'setup' && useAgy) {
      try { agyPlan = await prepareAgySetup(interactive, lang); }
      catch (error) {
        reportInstallerError(error, lang);
        status = 1;
      }
      if (agyPlan === null) return 0;
    }
    const operations = [];
    if (useCodex) operations.push(() => runCodexHost(action, installDependency, interactive, codexMode, lang));
    if (useAgy && (action !== 'setup' || agyPlan)) operations.push(() => runAgyHost(action, agyPlan, installDependency, lang));
    for (const operation of operations) {
      try { status = Math.max(status, await operation()); }
      catch (error) {
        reportInstallerError(error, lang);
        status = 1;
      }
    }
    return status;
  } catch (error) {
    reportInstallerError(error, lang);
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
    await ask(tr('按回车关闭安装窗口。', 'Press Enter to close the installer.', language()));
}
