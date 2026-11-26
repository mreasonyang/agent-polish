#!/usr/bin/env node
// Manage the native Antigravity installation of agy-polish.
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agyExecutable, canonical, compareVersions, interactiveTerminal, LEGACY_BOTH_SETUP, npmChannel, windows } from './installer_common.mjs';
import { systemLanguage, tr } from './installer_locale.mjs';
import { withLock } from './installer_lock.mjs';
import { chooseOption, thinkingLabels, waitForCatalog } from './installer_terminal.mjs';
import { AGY_INSTALL, installAgyBootstrap } from './agy_bootstrap.mjs';
import {
  AgyInstallError, agyProfile, requireAgyCli, installedAgy, validateAgyBundle,
  changeAgyPlugin, loadAgySettings, checkCodexProvider
} from './agy_install.mjs';

const fail = (zh, en) => new AgyInstallError(tr(zh, en));

const agyModeLabels = {
  normal: ['Normal · 按需改写', 'Normal · rewrite when useful'],
  turbo: ['Turbo · 每次都请 Codex 改写', 'Turbo · ask Codex to rewrite every time'],
  manual: ['仅手动 · 只在我要求时润色', 'Manual · polish only when asked'],
  off: ['关闭润色', 'Off · turn off polishing']
};
const agyDataNotice = [
  '选择自动润色后，本轮问题和 Antigravity 草稿会发给 Codex 当前配置的模型提供商。Normal 会判断是否需要改写。',
  'Automatic polishing sends the current question and Antigravity draft to the model provider configured in Codex. In Normal mode the editor decides whether a rewrite would help.'
];
const agyPackage = '@kyun.si/agy-polish';
const root = fileURLToPath(new URL('../', import.meta.url));
const channel = npmChannel(root, agyPackage, 'plugins/agy-polish/plugin.json');
const agySetupCommand = `${windows ? 'npx.cmd' : 'npx'} ${agyPackage}@${channel} setup`;

function agyEffortLabel(effort, lang) {
  const labels = { ...thinkingLabels, minimal: ['最低', 'Minimal'], max: ['最高', 'Maximum'] };
  return Object.hasOwn(labels, effort) ? tr(...labels[effort], lang) : effort;
}

async function chooseAgyModel(settings, { model, effort }, { signedIn }, lang) {
  const t = (zh, en) => tr(zh, en, lang);
  const { DEFAULT_MODEL, DEFAULT_EFFORT, FOLLOW_CODEX } = settings;
  const usingRecommended = model === DEFAULT_MODEL && effort === DEFAULT_EFFORT;
  const followingCodex = model === null && effort === null;
  const initialChoice = usingRecommended ? 'recommended' : followingCodex ? 'follow' : 'keep';
  const choices = [
    { id: 'recommended', name: DEFAULT_MODEL + ' · ' + agyEffortLabel(DEFAULT_EFFORT, lang) + t('（默认）', ' (default)') },
    { id: 'follow', name: t('跟随本机 Codex 配置', 'Follow local Codex configuration') }
  ];
  if (initialChoice === 'keep') {
    const saved = (model ?? t('Codex 默认', 'Codex default')) + (effort ? ' · ' + agyEffortLabel(effort, lang) : '');
    choices.push({ id: 'keep', name: t('保留当前设置', 'Keep current settings') + ' · ' + saved });
  }
  choices.push({ id: 'lookup', name: signedIn
    ? t('选择账号可用模型和思考等级…', 'Choose a model and reasoning effort from my account…')
    : t('从 Codex 模型列表选择模型和思考等级…', 'Choose a model and reasoning effort from the Codex model list…') });
  const unavailable = signedIn
    ? t('没能读取账号模型。', 'Could not read the account model list.')
    : t('没能读取 Codex 模型列表。', 'Could not read the Codex model list.');
  while (true) {
    const choice = await chooseOption(t('选择改写用的 Codex 模型', 'Choose the Codex model for rewrites'),
      choices, lang, process.stdin, process.stdout, initialChoice);
    if (!choice) return null;
    if (choice === initialChoice) return {};
    if (choice === 'recommended') return { model: null, effort: null };
    if (choice === 'follow') return { model: FOLLOW_CODEX, effort: FOLLOW_CODEX };
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
        : t('Codex 模型列表中没有可选模型。', 'The Codex model list has no models to choose from.'));
      continue;
    }
    const defaultLabel = signedIn ? t('（账号默认）', ' (account default)') : t('（Codex 默认）', ' (Codex default)');
    const rows = models.map(item => ({
      id: item.id,
      name: (models.some(other => other.id !== item.id && other.name === item.name) ? item.name + ' (' + item.id + ')' : item.name) +
        (item.isDefault ? defaultLabel : '')
    }));
    const initialModel = models.find(item => item.id === model) ?? models.find(item => item.isDefault);
    const id = await chooseOption(t('用哪个模型改写？', 'Which model should rewrite your replies?'), rows,
      lang, process.stdin, process.stdout, initialModel?.id);
    if (!id) return null;
    const selected = models.find(item => item.id === id);
    if (!selected.efforts.length) return { model: id, effort: id === DEFAULT_MODEL ? FOLLOW_CODEX : null };
    const efforts = selected.efforts.map(id => ({
      id,
      name: agyEffortLabel(id, lang) + (id === selected.defaultEffort ? t('（模型默认）', ' (model default)') : '')
    }));
    const savedEffort = id === model && selected.efforts.includes(effort) ? effort : null;
    const recommendedEffort = id === DEFAULT_MODEL && selected.efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : null;
    const initial = savedEffort ?? recommendedEffort ?? selected.defaultEffort;
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
  let provider;
  if (mode !== 'off' && interactive) {
    provider = await checkCodexProvider(lang);
    if (provider.ready || provider.canListModels) {
      const model = await chooseAgyModel(settings, current, provider, lang);
      if (!model) return null;
      Object.assign(patch, model);
    }
  }
  return { settings, patch, mode, provider };
}

async function doctorAgy(lang) {
  const t = (zh, en) => tr(zh, en, lang);
  const entry = installedAgy();
  // Doctor describes the plugin Antigravity is running, even before the user updates it.
  const legacyDefaults = entry && compareVersions(entry.version, '0.0.4-beta.6',
    () => fail('没法确定 agy-polish 的版本。', "Couldn't determine the agy-polish version.")) < 0;
  const { current: { mode, model, effort } } = await loadAgySettings({ legacyDefaults });
  console.log(t('Antigravity 润色模式：', 'Antigravity polishing mode: ') + t(...agyModeLabels[mode]));
  if (entry) {
    console.log(t('agy-polish 已安装，版本 ', 'agy-polish is installed, version ') + entry.version +
      (entry.enabled ? '' : t('（已停用）', ' (disabled)')));
  } else {
    console.log(t('agy-polish 未安装。运行 ', 'agy-polish is not installed. Run ') + agySetupCommand);
  }
  if (mode === 'off') return entry ? 0 : 1;
  console.log(t('Codex 模型：', 'Codex model: ') + (model ?? t('Codex 默认', 'Codex default')) +
    (effort ? ' · ' + agyEffortLabel(effort, lang) : ''));
  if (!entry?.enabled) return entry ? 0 : 1;
  const provider = await checkCodexProvider(lang);
  console.log(provider.message);
  return entry && provider.ready ? 0 : 1;
}

async function runAgyHost(action, plan, installDependency, lang) {
  if (action === 'doctor') return doctorAgy(lang);
  const t = (zh, en) => tr(zh, en, lang);
  const settingsHelp = t('可在 Antigravity 对话中输入 /polish-settings 调整模式、模型和思考等级。',
    'Use /polish-settings in Antigravity to change the mode, model, or reasoning effort.');
  const off = t('Antigravity 回复润色已关闭。', 'Antigravity reply polishing is off.');
  const save = async () => {
    if (!plan || !Object.keys(plan.patch).length) return;
    try { await plan.settings.writeSettings(plan.patch); }
    catch { throw fail('无法保存 agy-polish 设置。请检查设置目录的写入权限。', 'Could not save agy-polish settings. Check write access to the settings directory.'); }
  };

  const agy = agyExecutable();
  if (!agy && plan?.mode === 'off' && !installDependency) {
    await save();
    console.log(off);
    return 0;
  }
  if (installDependency) {
    if (!agy) console.log(t('正在从 Google 下载并安装 agy…', 'Downloading and installing agy from Google…'));
    await installAgyBootstrap(fail);
  }
  if (!agyExecutable() && action === 'setup') {
    throw fail(`没找到 agy。运行 ${agySetupCommand} --install-agy 安装。\n  ${AGY_INSTALL}`,
      `Couldn't find agy. Run ${agySetupCommand} --install-agy to install it.\n  ${AGY_INSTALL}`);
  }
  requireAgyCli();
  const profile = canonical(agyProfile());
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const enabled = await withLock(profile, async () => {
    const before = installedAgy();
    if (action === 'uninstall') {
      if (before) changeAgyPlugin('uninstall');
      if (installedAgy()) throw fail('agy 仍显示插件已安装，请再试一次卸载。', 'agy still lists the plugin as installed. Run uninstall again.');
      console.log(t('agy-polish 已卸载，模式和模型设置已保留。', 'agy-polish is uninstalled. Your mode and model settings were kept.'));
      return false;
    }
    if (action === 'update' && !before) {
      console.log(t('agy-polish 未安装。要加装，运行 ', 'agy-polish is not installed. To add it, run ') + agySetupCommand);
      return false;
    }
    const { path, version } = validateAgyBundle();
    if (before && compareVersions(version, before.version,
      () => fail('没法确定 agy-polish 的版本。', "Couldn't determine the agy-polish version.")) < 0) {
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
    return entry.enabled;
  });
  if (!plan) return 0;
  if (plan.mode === 'off') console.log(enabled ? off + ' ' + settingsHelp : off);
  else if (enabled) {
    const provider = plan.provider ?? await checkCodexProvider(lang);
    if (!provider.ready) console.log(provider.message);
    const start = provider.ready
      ? t('在 Antigravity 中新开对话。', 'Start a new chat in Antigravity.')
      : t('处理上面的 Codex 问题后，在 Antigravity 中新开对话。', 'After resolving the Codex issue above, start a new chat in Antigravity.');
    const use = plan.mode === 'manual'
      ? t('输入 /polish，或提问时加一句「请润色」。', 'Use /polish or ask for polishing in your question.')
      : t('输入 /polish，或像平常一样提问。', 'Use /polish or ask a question as usual.');
    console.log(start + ' ' + use);
    console.log(t('看到 MCP 授权提示时，只授权 agy-polish 的 polish_reply 工具。',
      'If Antigravity prompts for MCP approval, approve only the agy-polish tool polish_reply.'));
    console.log(settingsHelp);
  }
  return 0;
}

function usage(lang) {
  return tr(
    '用法：agy-polish [setup|update|doctor|uninstall] [--install-agy]\nsetup（默认命令）安装 Antigravity 插件，可选择润色模式、Codex 模型和思考等级。\n--install-agy 可在 setup 或 update 中安装 Google 的 Antigravity CLI。\n-h, --help 显示帮助。',
    'Usage: agy-polish [setup|update|doctor|uninstall] [--install-agy]\nsetup (default) installs the Antigravity plugin and lets you choose the polishing mode, Codex model and reasoning effort.\n--install-agy can install Google’s Antigravity CLI during setup or update.\n-h, --help shows this help.',
    lang
  );
}

export async function main(args = process.argv.slice(2)) {
  const lang = systemLanguage();
  if (args.includes('-h') || args.includes('--help')) {
    console.log(usage(lang));
    return 0;
  }
  let action, installDependency;
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: { 'install-agy': { type: 'boolean' }, advanced: { type: 'boolean' } }
    });
    action = positionals[0] ?? 'setup';
    installDependency = values['install-agy'] ?? false;
    if (positionals.length > 1 || !['setup', 'update', 'doctor', 'uninstall'].includes(action) ||
        (values.advanced && action !== 'setup') || (installDependency && !['setup', 'update'].includes(action))) {
      throw new Error('invalid installer arguments');
    }
  } catch {
    console.error(usage(lang));
    return 2;
  }
  try {
    const plan = action === 'setup' ? await prepareAgySetup(interactiveTerminal(), lang) : undefined;
    if (plan === null) {
      const legacy = process.env[LEGACY_BOTH_SETUP];
      if (legacy === 'codex-complete') console.log(tr('Codex 配置已完成。Antigravity 配置已取消。',
        'Codex setup is complete. Antigravity setup was cancelled.', lang));
      if (legacy === 'codex-failed') console.log(tr('Antigravity 配置已取消。', 'Antigravity setup was cancelled.', lang));
      return 0;
    }
    return await runAgyHost(action, plan, installDependency, lang);
  } catch (error) {
    console.error(error instanceof AgyInstallError ? error.message :
      tr('没法核对安装文件或环境。请检查文件权限和发行包后再试。',
        "Couldn't verify the installation files or environment. Check the package and file permissions, then try again.", lang));
    return 1;
  }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) &&
    fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
