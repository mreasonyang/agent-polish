import { spawnSync } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyExecutable, available, pathDirectories, windows } from './installer_common.mjs';
import { tr } from './installer_locale.mjs';
import { AGY_INSTALL } from './agy_bootstrap.mjs';
import { fileLoginExists, withWorkspace } from '../plugins/agy-polish/scripts/codex-process.mjs';
import { withCodexAppServer } from '../plugins/agy-polish/scripts/codex-provider.mjs';

const PLUGIN = 'agy-polish';
const SOURCE = new URL('../plugins/agy-polish/', import.meta.url);
const MANIFESTS = ['plugin.json', '.antigravity-plugin/plugin.json'];
const CODEX_INSTALL = 'https://developers.openai.com/codex/cli/';

export class AgyInstallError extends Error {}

const error = (zh, en) => new AgyInstallError(tr(zh, en));
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function agyProfile() {
  return join(homedir(), '.gemini', 'config');
}

function run(cli, args, timeout) {
  return spawnSync(cli.command, [...cli.args, ...args], {
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export function requireAgyCli() {
  const cli = agyExecutable();
  if (!cli) {
    throw error('没找到 Antigravity CLI（agy）。请按官方指南安装。\n  ' + AGY_INSTALL,
      "Couldn't find Antigravity CLI (agy). Follow the official installation guide.\n  " + AGY_INSTALL);
  }
  return cli;
}

function hasCodexCli() {
  const paths = [...pathDirectories(), process.env.CODEX_INSTALL_DIR, join(homedir(), '.local', 'bin')];
  if (windows) {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    paths.push(join(local, 'Programs', 'OpenAI', 'Codex', 'bin'));
  }
  return paths.some(directory => directory && isAbsolute(directory) &&
    (available(join(directory, windows ? 'codex.exe' : 'codex'), constants.X_OK) ||
     (windows && available(join(directory, 'codex.cmd')))));
}

function pluginCommand(args, json = false) {
  const [command] = args;
  const result = run(requireAgyCli(), ['plugin', ...args, ...(json ? ['--json'] : [])], 120_000);
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || '').trim().replace(/\p{Cc}/gu, ' ').slice(0, 600);
    const details = '\n  ' + AGY_INSTALL + (reason ? '\n  ' + reason : '');
    throw error('agy plugin ' + command + ' 执行失败。请检查插件路径或更新 agy。' + details,
      'agy plugin ' + command + ' failed. Check the plugin path or update agy.' + details);
  }
  if (!json) return;
  try { return JSON.parse(result.stdout); }
  catch {
    throw error('无法读取 agy 返回的插件信息。请更新 Antigravity CLI。', 'Could not read the agy plugin response. Update Antigravity CLI.');
  }
}

export function installedAgy() {
  const rows = pluginCommand(['list'], true);
  const matches = Array.isArray(rows) && rows.filter(row => row?.name === PLUGIN);
  if (matches?.length === 0) return null;
  const [entry] = matches || [];
  if (matches?.length !== 1 || typeof entry.enabled !== 'boolean' ||
      typeof entry.version !== 'string' || typeof entry.path !== 'string' || !isAbsolute(entry.path)) {
    throw error('无法核对 agy-polish 的安装记录。请在 Antigravity 里检查插件列表。',
      'Could not verify the agy-polish installation. Check the plugin list in Antigravity.');
  }
  return entry;
}

export function validateAgyBundle() {
  const path = fileURLToPath(SOURCE);
  const report = pluginCommand(['validate', path], true);
  if (report?.name !== PLUGIN || !MANIFESTS.includes(report.manifest)) {
    throw error('安装包里的 agy-polish 清单无效。', 'The bundled agy-polish manifest is invalid.');
  }
  const manifest = readJSON(new URL(report.manifest, SOURCE));
  if (manifest.name !== PLUGIN || typeof manifest.version !== 'string') {
    throw error('安装包里的 agy-polish 名称或版本无效。', 'The bundled agy-polish name or version is invalid.');
  }
  return { path, version: manifest.version };
}

export function changeAgyPlugin(action, target = PLUGIN) {
  pluginCommand([action, target]);
}

export async function loadAgySettings() {
  let settings;
  try {
    settings = await import(new URL('scripts/settings.mjs', SOURCE));
  } catch {
    throw error('无法加载 agy-polish 设置。请重新下载完整的安装包。',
      'Could not load agy-polish settings. Download a fresh copy of the full package.');
  }
  try {
    return { settings, current: await settings.readSettings() };
  } catch {
    throw error('无法读取 agy-polish 设置。请检查设置目录中的 settings.json 是否有效、可读。',
      'Could not read agy-polish settings. Check that settings.json is valid and readable.');
  }
}

export async function checkCodexProvider(lang) {
  const t = (zh, en) => tr(zh, en, lang);
  const blocked = (zh, en) => ({ ready: false, message: t(zh, en) });
  const unconfirmed = () => blocked('未能确认当前 Codex 提供商的认证状态。请检查 Codex CLI 和提供商配置。',
    'Could not confirm authentication for the selected Codex provider. Check the Codex CLI and provider configuration.');
  if (!hasCodexCli()) {
    return blocked('没找到 Codex CLI。请按官方指南安装。\n  ' + CODEX_INSTALL,
      "Couldn't find Codex CLI. Follow the official installation guide.\n  " + CODEX_INSTALL);
  }
  try {
    return await withWorkspace(({ cwd }) => withCodexAppServer(cwd, { timeout: 10_000 }, async (request, { codexHome }) => {
      const { config } = await request('config/read', { includeLayers: false, cwd });
      if (!isObject(config)) return unconfirmed();
      const id = config.model_provider ?? 'openai';
      if (typeof id !== 'string' || !id) return unconfirmed();
      const providers = config.model_providers ?? {};
      if (!isObject(providers)) return unconfirmed();
      const provider = Object.hasOwn(providers, id) ? providers[id] : null;
      if (provider !== null && !isObject(provider)) return unconfirmed();
      if (provider?.wire_api != null && provider.wire_api !== 'responses') return unconfirmed();
      if (provider?.auth != null || provider?.gateway_oauth != null || provider?.aws != null ||
          ['amazon-bedrock', 'amazon-bedrock-runtime', 'gcp'].includes(id)) {
        return { ready: false, canListModels: true, message: t(
          '请按当前 Codex 提供商的说明检查认证。安装程序无法确认这种认证方式是否可用，仍可选择模型。',
          'Check authentication using the selected Codex provider’s instructions. The installer could not confirm this authentication method. You can still choose a model.') };
      }

      const envKey = provider?.env_key;
      if (envKey != null) {
        if (typeof envKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) return unconfirmed();
        if (!process.env[envKey]?.trim()) {
          return blocked(`当前 Codex 提供商需要环境变量 ${envKey}。请设置该变量后重试。`,
            `The selected Codex provider needs the ${envKey} environment variable. Set it and try again.`);
        }
      }

      const { account, requiresOpenaiAuth } = await request('account/read', { refreshToken: false });
      if (requiresOpenaiAuth === true) {
        const fileKeyFallback = id === 'openai' && account === null &&
          (config.cli_auth_credentials_store ?? 'file') === 'file' && !process.env.CODEX_ACCESS_TOKEN?.trim() &&
          process.env.OPENAI_API_KEY?.trim() && !fileLoginExists(codexHome);
        if (config.forced_login_method !== 'chatgpt' && (process.env.CODEX_API_KEY?.trim() || fileKeyFallback)) {
          return { ready: true, message: t('Codex 编辑进程的 API 密钥环境变量已设置。此检查仅核对本机配置。',
            'The Codex editor’s API key environment variable is set. This check covers local configuration only.') };
        }
        if (account === null) {
          return blocked('未能确认 Codex CLI 已登录。请在终端运行 codex login，再检查 codex login status。',
            'Could not confirm Codex CLI sign-in. Run codex login in your terminal, then check codex login status.');
        }
        if (!['chatgpt', 'apiKey'].includes(account?.type)) return unconfirmed();
        return { ready: true, signedIn: true, message: t('Codex CLI 已登录。', 'Codex CLI is signed in.') };
      }
      if (requiresOpenaiAuth !== false || (!provider && !['ollama', 'lmstudio'].includes(id))) return unconfirmed();
      const message = envKey
        ? t('当前 Codex 提供商的认证环境变量已设置。此检查仅核对本机配置。',
          'The selected Codex provider’s authentication environment variable is set. This check covers local configuration only.')
        : t('当前 Codex 提供商无需登录 OpenAI。此检查仅核对本机配置。',
          'The selected Codex provider does not require OpenAI sign-in. This check covers local configuration only.');
      return { ready: true, message };
    }));
  } catch {
    return unconfirmed();
  }
}
