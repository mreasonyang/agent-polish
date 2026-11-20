import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readProjectSetting, accessProjectSetting } from './project_setting.mjs';
import { LANGUAGES, LANGUAGE_FILE, language, languageSettings, tr } from './ui_locale.mjs';
import { COOLDOWNS, activeFailure, cacheScope, clearFailure, noteFailure, withCache } from './recovery.mjs';

const MODES = ['auto', 'manual', 'off'];
const MODE_FILE = 'codex-polish.mode';
const HISTORY_FILE = 'codex-polish.history-turns';
const DECISIONS_FILE = 'codex-polish.decisions';
const MODEL_FILE = 'codex-polish.model';
export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';
export const DEFAULT_HISTORY_TURNS = 2;
export const MAX_HISTORY_TURNS = 10;
const GOOGLE_AUTH_MODES = ['existing-session', 'gemini-api-key', 'agent-platform'];
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TURN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_MAX_AGE = 7 * 24 * 60 * 60;
const DECISION_ERRORS = new Set([
  ...Object.keys(COOLDOWNS).filter(reason => reason.startsWith('api_')),
  'invalid_api_response', 'api_refusal', 'api_http_error', 'input_read_error',
  'input_too_large', 'invalid_input', 'invalid_options', 'missing_api_key', 'invalid_api_key',
]);
const DECISION_REASONS = {
  judge: { rewrite: 'needs_rewrite', keep: 'already_clear' },
  verify: { accept: 'meaning_preserved', keep: 'meaning_changed' },
};

export function projectSettings(cwd) {
  const [value, scope] = readProjectSetting(cwd, MODE_FILE, 16, { allowMissingLink: true });
  return [value === null ? 'auto' : MODES.includes(value) ? value : 'off', scope];
}

function parseHistoryTurns(value, lang) {
  if (typeof value === 'string' && value.length && !/[^0-9]/.test(value)) {
    const turns = Number(value);
    if (turns <= MAX_HISTORY_TURNS) return turns;
  }
  throw new RangeError(tr(`历史轮数必须是 0 到 ${MAX_HISTORY_TURNS} 之间的整数。设为 0 可以关闭历史。`,
    `Use a whole number from 0 to ${MAX_HISTORY_TURNS}. Set it to 0 to turn off history.`, lang));
}

export function projectHistoryTurns(cwd) {
  const [value] = readProjectSetting(cwd, HISTORY_FILE, 32);
  if (value === null) return DEFAULT_HISTORY_TURNS;
  try {
    return parseHistoryTurns(value, 'en');
  } catch {
    return 0;
  }
}

export function decisionsSettings(cwd) {
  const [value] = readProjectSetting(cwd, DECISIONS_FILE, 16);
  const mode = value === null || value === 'auto' ? 'auto' : 'off';
  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  return { decisions_mode: mode, openai_key_configured: hasKey, decisions_enabled: mode === 'auto' && hasKey };
}

export function validModelId(value) {
  return typeof value === 'string' && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:[/:][A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value);
}

export function projectGeminiModel(cwd) {
  const [value] = readProjectSetting(cwd, MODEL_FILE, 257, { allowMissingLink: true });
  if (value === null) return DEFAULT_GEMINI_MODEL;
  return validModelId(value) ? value : null;
}

function writeProjectSetting(cwd, filename, value, lang) {
  if (!path.isAbsolute(cwd)) throw new RangeError(tr('请提供项目目录的完整路径。', 'Enter the full path to the project folder.', lang));
  const project = fs.realpathSync(cwd);
  if (!fs.statSync(project).isDirectory() || path.dirname(project) === project || project === fs.realpathSync(os.homedir())) {
    throw new RangeError(tr('请选择要配置的项目目录。', 'Choose a project folder to configure.', lang));
  }
  const settings = path.join(project, '.codex');
  fs.mkdirSync(settings, { mode: 0o700, recursive: true });
  try {
    accessProjectSetting(settings, 'write', filename, value);
  } catch (error) {
    if (error.code === 'EINVAL') throw new RangeError(tr('项目设置路径指向了链接或特殊文件。',
      'The settings path points to a link or another special file.', lang));
    throw error;
  }
  return path.join(settings, filename);
}

function setProjectModel(cwd, model, lang) {
  if (!validModelId(model)) throw new RangeError(tr('这个模型 ID 无效，请从当前账号的 Gemini 模型列表里选一个。',
    "This model ID isn't valid. Choose a Gemini model from your account's list.", lang));
  const [, scope] = projectSettings(cwd);
  const recent = model !== projectGeminiModel(cwd) ? activeFailure(scope) : null;
  const file = writeProjectSetting(cwd, MODEL_FILE, model, lang);
  if (recent?.reason === 'acp_model_unavailable') clearFailure(scope, recent.token);
  return { gemini_model: model, file };
}

function validSource(turn, file) {
  return typeof turn === 'string' && TURN_ID.test(turn) && typeof file === 'string' &&
    Array.from(file).length <= 4096 && path.isAbsolute(file) && !/[\p{C}\p{Zl}\p{Zp}]/u.test(file) &&
    !/[^\S\x20]/u.test(file);
}

function rememberHistorySource(event, mode) {
  const { session_id: session, turn_id: turn, transcript_path: file } = event;
  if (typeof session !== 'string' || !SESSION_ID.test(session) || event.agent_id || event.agent_type) return;
  if (process.env.CODEX_THREAD_ID && process.env.CODEX_THREAD_ID !== session) return;
  const valid = mode !== 'off' && validSource(turn, file);
  try {
    const scope = cacheScope(event.cwd);
    withCache(valid ? 'create' : 'write', db => {
      if (!valid) {
        db.prepare('DELETE FROM history_source WHERE scope=? AND session=?').run(scope, session);
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS history_source (
          scope TEXT, session TEXT, turn TEXT, path TEXT, updated INTEGER, PRIMARY KEY(scope, session))`);
      db.prepare('DELETE FROM history_source WHERE updated NOT BETWEEN ? AND ?').run(now - SOURCE_MAX_AGE, now);
      db.prepare('INSERT OR REPLACE INTO history_source VALUES (?,?,?,?,?)').run(scope, session, turn, file, now);
      db.exec('COMMIT');
    });
  } catch {
    // Cache unavailability must never interrupt a user turn.
  }
}

export function historySource(cwd) {
  const session = process.env.CODEX_THREAD_ID || '';
  if (!SESSION_ID.test(session) || projectSettings(cwd)[0] === 'off') return null;
  try {
    const scope = cacheScope(cwd);
    const now = Math.floor(Date.now() / 1000);
    const row = withCache('read', db => db.prepare(`SELECT turn, path FROM history_source
      WHERE scope=? AND session=? AND updated BETWEEN ? AND ?`).get(scope, session, now - SOURCE_MAX_AGE, now));
    if (row && validSource(row.turn, row.path)) return { transcript_path: row.path, session_id: session, turn_id: row.turn };
  } catch {
    // Missing, private to another user, stale, or unreadable.
  }
  return null;
}

function workflowCooldown(scope, decisionsEnabled) {
  const recent = activeFailure(scope);
  return !decisionsEnabled && DECISION_ERRORS.has(recent?.reason) ? null : recent;
}

function findExecutable(name, extra = []) {
  const directories = (process.env.PATH ?? '/bin:/usr/bin').split(path.delimiter);
  for (const directory of [...directories, ...extra]) {
    const file = path.resolve(directory, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Continue along PATH.
    }
  }
  return null;
}

export function findAgy() {
  return findExecutable('agy', [path.join(os.homedir(), '.local/bin')]);
}

function supportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 16);
}

export function runtimeStatus(cwd, mode, scope) {
  const googleAuth = process.env.CODEX_POLISH_AGY_AUTH ?? 'existing-session';
  const agy = findAgy();
  const status = {
    mode, node_available: supportedNode(),
    codex_available: Boolean(findExecutable('codex')), agy_available: Boolean(agy), agy_path: agy,
    ...decisionsSettings(cwd), gemini_model: projectGeminiModel(cwd),
    google_auth_method: GOOGLE_AUTH_MODES.includes(googleAuth) ? googleAuth : 'unsupported',
    gemini_key_configured: googleAuth === 'existing-session' ? null : Boolean(process.env.GEMINI_API_KEY?.trim()),
  };
  const blockers = [];
  if (!status.node_available) blockers.push('unsupported_node');
  if (!status.agy_available) blockers.push('agy_missing');
  if (status.google_auth_method === 'unsupported') blockers.push('unsupported_google_auth');
  if (status.gemini_model === null) blockers.push('gemini_model_invalid');
  const keys = [];
  if (status.decisions_enabled) keys.push(['openai', process.env.OPENAI_API_KEY]);
  if (googleAuth === 'gemini-api-key') keys.push(['gemini', process.env.GEMINI_API_KEY]);
  for (const [provider, key] of keys) {
    if (!key?.trim()) blockers.push(provider + '_key_missing');
    else if (/[^!-~]/.test(key)) blockers.push(provider + '_key_invalid');
  }
  return { ...status, blockers, cooldown: workflowCooldown(scope, status.decisions_enabled) };
}

function runOpenaiDecision(stage, scope) {
  const helper = fileURLToPath(new URL('../skills/codex-polish/scripts/decisions.mjs', import.meta.url));
  const unavailable = [{ action: 'keep', reason: 'decision_helper_unavailable' }, 1];
  const child = spawnSync(process.execPath, [helper, stage], {
    stdio: ['inherit', 'pipe', 'ignore'], timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
  if (child.error?.code === 'ETIMEDOUT') {
    noteFailure(scope, 'api_timeout');
    return [{ action: 'keep', reason: 'api_timeout' }, 1];
  }
  if (child.error || child.status === null) return unavailable;
  let output;
  try {
    output = JSON.parse(child.stdout);
  } catch {
    return unavailable;
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return unavailable;
  const { action, reason, probability } = output;
  if (child.status) {
    if (action !== 'keep' || !DECISION_ERRORS.has(reason)) return unavailable;
    noteFailure(scope, reason);
    return [{ action, reason }, 1];
  }
  if (typeof action !== 'string' || !Object.hasOwn(DECISION_REASONS[stage], action) ||
      reason !== DECISION_REASONS[stage][action] || typeof probability !== 'number' || !(probability >= 0 && probability <= 1)) return unavailable;
  return [{ action, reason, probability }, 0];
}

function guardedDecision(stage, args) {
  const [mode, scope] = projectSettings(args.cwd);
  if (mode === 'off' || (mode !== 'auto' && args.trigger === 'auto')) return [{ action: 'keep', reason: 'project_mode' }, 0];
  const { blockers, cooldown, decisions_enabled } = runtimeStatus(args.cwd, mode, scope);
  if (blockers.length) return [{ action: 'keep', reason: blockers[0], blockers }, 0];
  const route = decisions_enabled ? 'decisions' : 'acp';
  if (args.route && args.route !== route) return [{ action: 'keep', reason: 'decision_route_changed' }, 0];
  if (cooldown && args.trigger === 'auto') return [{ action: 'keep', reason: 'cooldown', cooldown }, 0];
  let result;
  if (decisions_enabled) {
    const [output, code] = runOpenaiDecision(stage, scope);
    if (code) return [output, code];
    result = output;
  } else {
    result = stage === 'judge' ? { action: 'rewrite', reason: 'direct_acp' } : { action: 'accept', reason: 'decisions_skipped' };
  }
  result.route = route;
  if (cooldown && stage === 'judge' && result.action === 'rewrite') result.recovery_token = cooldown.token;
  if (cooldown && stage === 'verify' && args['recovery-token'] === cooldown.token) clearFailure(scope, cooldown.token);
  return [result, 0];
}

function runHook() {
  if (!supportedNode()) return;
  const limit = 2 * 1024 * 1024;
  let event;
  try {
    const raw = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < raw.length) {
      const count = fs.readSync(0, raw, size, raw.length - size);
      if (count === 0) break;
      size += count;
    }
    if (size > limit) return;
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, size)));
  } catch {
    return;
  }
  if (event?.hook_event_name !== 'UserPromptSubmit') return;
  const [mode, scope] = projectSettings(event.cwd);
  rememberHistorySource(event, mode);
  if (mode !== 'auto') return;
  const lang = language(event.cwd);
  const paused = workflowCooldown(scope, decisionsSettings(event.cwd).decisions_enabled);
  const additionalContext = paused
    ? tr('自动润色因上次服务故障暂时暂停。常规回复请在最终消息里注明本轮未润色，再给出 GPT 原稿。遵守用户的格式要求；若本轮明确点名润色，可按技能手动重试。',
      'Automatic polishing is temporarily paused after a service failure. For ordinary replies, mark the final answer as unpolished and show the original GPT draft. Honor the requested format. An explicit polish request can still use the skill.', lang)
    : tr('本项目已开启自动改写。完成任务后，在发送最终回复前使用已安装的 codex-polish:codex-polish 技能。常规回复请在最终消息中显示润色结果和完整 GPT 原稿，两版相同时注明并只显示一次。遵守用户指定的输出格式、取消或禁止外发的要求。',
      'Automatic rewriting is on for this project. Before sending the final answer, use the installed codex-polish:codex-polish skill. In ordinary replies show the result and the full original GPT draft. If identical, label it and show it once. Honor the requested format, cancellations, and requests to keep content local.', lang);
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }));
}

const commands = {
  hook: ['', '处理 Codex 回合提醒', 'process a Codex hook event'],
  'project-hook': ['', '输出项目提醒配置', 'print the project hook definition'],
  mode: ['--cwd DIR', '查看改写模式', 'show the rewrite mode'],
  'set-mode': ['{auto,manual,off} --cwd DIR', '设置什么时候改写回复', 'choose when replies are rewritten'],
  'set-history-turns': ['N --cwd DIR', '设置改写时附带的历史轮数（0 到 10 轮，0 表示不带历史）', 'choose how much chat history to include (0–10 turns, 0 turns off history)'],
  'set-decisions': ['{auto,off} --cwd DIR', '配置 OpenAI 改写前后的检查', 'configure the optional OpenAI review'],
  'set-model': ['(MODEL_ID | --reset) --cwd DIR', '选择项目的 Gemini 改写模型，或恢复默认模型 ' + DEFAULT_GEMINI_MODEL, 'choose a Gemini model or reset to ' + DEFAULT_GEMINI_MODEL],
  'set-language': ['{auto,zh,en} --cwd DIR', '选择设置和提示的显示语言（auto 自动识别，zh 中文，en 英文）', 'choose the language for settings and messages (auto detects, zh Chinese, en English)'],
  check: ['--cwd DIR', '查看当前设置和缺少的依赖', 'check project settings and local requirements'],
  decision: ['{judge,verify} --trigger {auto,explicit} --cwd DIR [--route {acp,decisions}] [--recovery-token TOKEN]', '检查本轮该改写还是发出回复', 'check whether to rewrite or deliver a reply'],
  'note-failure': ['REASON --cwd DIR', '记录项目的临时服务故障', 'record a temporary service issue'],
};

function printHelp(command, t) {
  const prefix = t('用法：', 'Usage: ');
  if (command) {
    const [syntax, zh, en] = commands[command];
    console.log(`${prefix}preferences.mjs ${command} ${syntax}\n\n${t(zh, en)}`);
  } else {
    console.log(`${prefix}preferences.mjs COMMAND [OPTIONS]\n\n${t('管理项目的回复润色设置。', 'Manage Codex Polish settings for a project.')}\n`);
    for (const [name, [, zh, en]] of Object.entries(commands)) console.log(`  ${name.padEnd(18)} ${t(zh, en)}`);
  }
  console.log(`\n  -h, --help  ${t('显示帮助并退出', 'show this help message and exit')}`);
}

function main(args) {
  if (args.length === 1 && args[0] === 'hook') return runHook();
  const cwdOption = args.findIndex(arg => arg === '--cwd' || arg.startsWith('--cwd='));
  const location = cwdOption < 0 ? undefined : args[cwdOption] === '--cwd' ? args[cwdOption + 1] : args[cwdOption].slice(6);
  const lang = language(location);
  const t = (zh, en) => tr(zh, en, lang);
  const [command, ...rest] = args;
  const usageError = message => { console.error(message); return 2; };
  if (command === '--help' || command === '-h') { printHelp(null, t); return 0; }
  if (!Object.hasOwn(commands, command)) return usageError(t('请提供有效的命令。使用 --help 查看帮助。', 'Provide a valid command. Use --help to see available commands.'));
  if (rest.includes('--help') || rest.includes('-h')) { printHelp(command, t); return 0; }
  const options = {};
  if (commands[command][0]) options.cwd = { type: 'string' };
  if (command === 'set-model') options.reset = { type: 'boolean' };
  if (command === 'decision') {
    for (const key of ['route', 'trigger', 'recovery-token']) options[key] = { type: 'string' };
  }
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: rest, options, allowPositionals: true }));
  } catch {
    return usageError(t('参数无效或缺少参数值。使用 --help 查看用法。', 'Invalid option or missing option value. Use --help for usage.'));
  }
  if (options.cwd && !values.cwd) return usageError(t('缺少必填参数 --cwd', 'The --cwd option is required.'));
  const expected = command.startsWith('set-') || command === 'decision' || command === 'note-failure' ? 1 : 0;
  if (positionals.length !== (values.reset ? 0 : expected)) return usageError(t('参数组合无效。使用 --help 查看用法。', 'Invalid arguments. Use --help for usage.'));
  const value = positionals[0];
  const choices = { 'set-mode': MODES, 'set-language': LANGUAGES, 'set-decisions': ['auto', 'off'], decision: ['judge', 'verify'] };
  const toCheck = [[value, choices[command]]];
  if (command === 'decision') {
    toCheck.push([values.trigger, ['auto', 'explicit']]);
    if (values.route !== undefined) toCheck.push([values.route, ['acp', 'decisions']]);
  }
  for (const [selected, allowed] of toCheck) {
    if (allowed && !allowed.includes(selected)) {
      const valid = allowed.map(item => "'" + item + "'").join(', ');
      return usageError(t(`值 '${selected ?? ''}' 无效，请从 ${valid} 中选择`, `Invalid choice '${selected ?? ''}' (choose from ${valid}).`));
    }
  }
  const { cwd } = values;
  if (command === 'hook') return runHook();
  if (command === 'project-hook') {
    const definition = JSON.parse(fs.readFileSync(new URL('./hooks.json', import.meta.url), 'utf8'));
    const hook = definition.hooks.UserPromptSubmit[0].hooks[0];
    const quoted = "'" + import.meta.filename.replaceAll("'", "'\\''") + "'";
    hook.command = hook.command.replace('"$' + '{PLUGIN_ROOT}/hooks/preferences.mjs"', () => quoted);
    console.log(JSON.stringify(definition, null, 2));
    return 0;
  }
  if (command === 'mode') { console.log(projectSettings(cwd)[0]); return 0; }
  if (command === 'check') {
    console.log(JSON.stringify({ ...runtimeStatus(cwd, ...projectSettings(cwd)), ...languageSettings(cwd), history_turns: projectHistoryTurns(cwd) }));
    return 0;
  }
  if (command === 'note-failure') {
    const [mode, scope] = projectSettings(cwd);
    if (mode !== 'off') noteFailure(scope, value);
    return 0;
  }
  if (command === 'decision') {
    const [output, code] = guardedDecision(value, values);
    console.log(JSON.stringify(output));
    return code;
  }
  const save = (file, data) => writeProjectSetting(cwd, file, data, lang);
  let result;
  try {
    switch (command) {
      case 'set-mode': result = { mode: value, file: save(MODE_FILE, value) }; break;
      case 'set-decisions': result = { decisions_mode: value, file: save(DECISIONS_FILE, value) }; break;
      case 'set-history-turns': {
        const turns = parseHistoryTurns(value, lang);
        result = { history_turns: turns, file: save(HISTORY_FILE, String(turns)) };
        break;
      }
      case 'set-language': result = { file: save(LANGUAGE_FILE, value), ...languageSettings(cwd) }; break;
      case 'set-model': result = setProjectModel(cwd, values.reset ? DEFAULT_GEMINI_MODEL : value, lang); break;
    }
  } catch (error) {
    console.error(error instanceof RangeError ? t('无法保存设置。', "Couldn't save the setting. ") + error.message :
      t('无法保存设置。请确认项目目录存在，而且能在 .codex 目录里写入普通文件。',
        "Couldn't save the setting. Check that the project exists and you can write to its .codex folder."));
    return 1;
  }
  console.log(JSON.stringify(result));
  return 0;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2)) ?? 0;
}
