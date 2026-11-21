import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executable } from './platform.mjs';
import { parseArgs } from 'node:util';
import { projectRoot, readProjectSetting, accessProjectSetting } from './project_setting.mjs';
import { PROMPT_FILE, readEditorPrompt, readPromptInput } from './editor_prompt.mjs';
import { REWRITE_MODES, REWRITE_MODE_FILE, REWRITE_TRIGGERS, projectRewriteMode, rewriteModeSettings } from './rewrite_mode.mjs';
import { readHostLine, utf8 } from '../skills/codex-polish/scripts/cli_io.mjs';
import { LANGUAGES, LANGUAGE_FILE, language, languageSettings, tr } from './ui_locale.mjs';
import { cacheScope, withCache } from './recovery.mjs';

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
const DECISION_UNAVAILABLE = new Set([
  'api_rate_limited', 'api_server_error', 'api_transport_error', 'api_timeout',
  'api_auth_error', 'api_quota_exhausted', 'invalid_api_response', 'api_refusal',
  'api_http_error', 'missing_api_key', 'invalid_api_key', 'decision_input_too_large',
]);
const LOCAL_DECISION_ERRORS = new Set([
  'input_read_error', 'input_too_large', 'invalid_input',
  'invalid_options', 'editor_prompt_invalid', 'decision_route_changed', 'rewrite_mode_invalid',
]);
const DECISION_REASONS = { rewrite: 'needs_rewrite', keep: 'already_clear' };

export function projectSettings(cwd) {
  const [value, scope] = readProjectSetting(cwd, MODE_FILE, 16);
  const mode = value?.toLowerCase() ?? 'auto';
  return [MODES.includes(mode) ? mode : null, scope];
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
    return null;
  }
}

export function decisionsSettings(cwd, rewriteMode = projectRewriteMode(cwd), triggerMode = projectSettings(cwd)[0]) {
  const [value] = readProjectSetting(cwd, DECISIONS_FILE, 16);
  const mode = decisionMode(value?.toLowerCase() ?? 'auto');
  const key = process.env.OPENAI_API_KEY;
  const hasKey = Boolean(key?.trim());
  return { decisions_mode: mode, openai_key_configured: hasKey, openai_key_malformed: hasKey && /[^!-~]/.test(key), decisions_enabled: triggerMode === 'auto' && rewriteMode === 'normal' && mode === 'auto' && hasKey };
}

function decisionMode(value) {
  if (value === 'auto' || value === 'on') return 'auto';
  return value === 'off' ? 'off' : null;
}

export function validModelId(value) {
  return typeof value === 'string' && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:[/:][A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value);
}

function modelPreference(cwd) {
  const [value] = readProjectSetting(cwd, MODEL_FILE, 257);
  return { gemini_model: value === null ? DEFAULT_GEMINI_MODEL : validModelId(value) ? value : null,
    gemini_model_configured: validModelId(value) };
}

export function projectGeminiModel(cwd) {
  return modelPreference(cwd).gemini_model;
}

function writeProjectSetting(cwd, filename, value, lang, operation = value === null ? 'remove' : 'write') {
  if (!path.isAbsolute(cwd)) throw new RangeError(tr('请提供项目目录的完整路径。', 'Enter the full path to the project folder.', lang));
  const project = projectRoot(cwd);
  if (!fs.statSync(project).isDirectory() || path.dirname(project) === project || project === fs.realpathSync(os.homedir())) {
    throw new RangeError(tr('请选择要配置的项目目录。', 'Choose a project folder to configure.', lang));
  }
  const settings = path.join(project, '.codex');
  if (value !== null) fs.mkdirSync(settings, { mode: 0o700, recursive: true });
  try {
    accessProjectSetting(settings, operation, filename, value);
  } catch (error) {
    if (value === null && error.code === 'ENOENT') return path.join(settings, filename);
    if (error.code === 'EINVAL') throw new RangeError(tr('项目设置路径指向了链接或特殊文件。',
      'The settings path points to a link or another special file.', lang));
    throw error;
  }
  return path.join(settings, filename);
}

function setProjectModel(cwd, model, lang) {
  if (!validModelId(model)) throw new RangeError(tr('这个模型 ID 无效，请从当前账号的 Gemini 模型列表里选一个。',
    "This model ID isn't valid. Choose a Gemini model from your account's list.", lang));
  const file = writeProjectSetting(cwd, MODEL_FILE, model, lang);
  return { gemini_model: model, file };
}

function validSource(turn, file) {
  return typeof turn === 'string' && TURN_ID.test(turn) && typeof file === 'string' &&
    Array.from(file).length <= 4096 && path.isAbsolute(file) && !/[\p{C}\p{Zl}\p{Zp}]/u.test(file) &&
    !/[^\S\x20]/u.test(file);
}

function rememberHistorySource(event, mode) {
  const { session_id: session, turn_id: turn, transcript_path: file } = event;
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return;
  const valid = (mode === 'auto' || mode === 'manual') && validSource(turn, file);
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

export function findAgy() {
  return executable('agy')?.command ?? null;
}

function supportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 16);
}

export function runtimeStatus(cwd, mode, trigger, { selectionOnly = false, noHistory = false } = {}) {
  const googleAuth = process.env.CODEX_POLISH_AGY_AUTH ?? 'existing-session';
  const agy = findAgy();
  const rewriteSettings = rewriteModeSettings(cwd, trigger);
  const rewriteMode = rewriteSettings.rewrite_mode;
  let promptSource, promptError;
  try { promptSource = readEditorPrompt(cwd, rewriteMode ?? 'normal', { selectionOnly }).source; }
  catch (error) { promptSource = 'invalid'; promptError = error.code === 'PROMPT_LINK_UNBOUND' ? 'editor_prompt_link_unbound' : 'editor_prompt_invalid'; }
  const status = {
    mode, ...rewriteSettings, node_available: supportedNode(),
    codex_available: Boolean(executable('codex')), agy_available: Boolean(agy), agy_path: agy,
    ...decisionsSettings(cwd, rewriteMode, mode), ...modelPreference(cwd), prompt_source: promptSource,
    history_turns: noHistory || selectionOnly ? 0 : projectHistoryTurns(cwd),
    google_auth_method: GOOGLE_AUTH_MODES.includes(googleAuth) ? googleAuth : 'unsupported',
    gemini_key_configured: googleAuth === 'existing-session' ? null : Boolean(process.env.GEMINI_API_KEY?.trim()),
  };
  const blockers = [];
  if (mode === null) blockers.push('mode_invalid');
  if (rewriteMode === null) blockers.push('rewrite_mode_invalid');
  if (status.history_turns === null) blockers.push('history_turns_invalid');
  if (status.decisions_mode === null &&
      (trigger === undefined || (mode === 'auto' && rewriteMode === 'normal' && status.openai_key_configured)))
    blockers.push('decisions_mode_invalid');
  if (!status.node_available) blockers.push('unsupported_node');
  if (!status.agy_available) blockers.push('agy_missing');
  if (status.google_auth_method === 'unsupported') blockers.push('unsupported_google_auth');
  if (status.gemini_model === null) blockers.push('gemini_model_invalid');
  if (promptError) blockers.push(promptError);
  if (googleAuth === 'gemini-api-key') {
    const key = process.env.GEMINI_API_KEY;
    if (!key?.trim()) blockers.push('gemini_key_missing');
    else if (/[^!-~]/.test(key)) blockers.push('gemini_key_invalid');
  }
  return { ...status, blockers };
}

async function runOpenaiDecision(cwd, pinned, hostInput) {
  // Run the one request in this process so cancelling the host command also cancels HTTPS.
  let output;
  let policy;
  try {
    const { decide } = await import('../skills/codex-polish/scripts/decisions.mjs');
    const input = hostInput ? [await readHostLine()] : process.stdin;
    output = await decide(['judge', '--cwd', cwd], input, process.env, undefined, () => {
      policy = workflowPolicy(cwd, pinned);
      return policy.action === 'accept';
    });
    if (policy?.action === 'keep') return [policy, 0];
  } catch {
    return [{ action: 'keep', reason: 'decision_helper_unavailable' }, 1];
  }
  const { action, reason, probability } = output ?? {};
  if (DECISION_UNAVAILABLE.has(reason) && action === 'keep') {
    return [{ action: 'rewrite', reason: 'decision_unavailable', decision_error: reason }, 0];
  }
  if (LOCAL_DECISION_ERRORS.has(reason) && action === 'keep') return [{ action, reason }, 1];
  if (typeof action !== 'string' || !Object.hasOwn(DECISION_REASONS, action) || reason !== DECISION_REASONS[action] ||
      typeof probability !== 'number' || !(probability >= 0 && probability <= 1)) {
    return [{ action: 'keep', reason: 'decision_helper_unavailable' }, 1];
  }
  return [{ action, reason, probability }, 0];
}

export function workflowPolicy(cwd, { trigger, route, rewriteMode, model, selectionOnly = false, noHistory = false }) {
  const [mode] = projectSettings(cwd);
  const keep = reason => ({ action: 'keep', reason });
  if (mode === null) return keep('mode_invalid');
  if (!REWRITE_TRIGGERS.includes(trigger) || mode === 'off' || (mode !== 'auto' && trigger === 'auto'))
    return keep('project_mode');
  if (selectionOnly && trigger !== 'explicit') return keep('invalid_options');
  const status = runtimeStatus(cwd, mode, trigger, { selectionOnly, noHistory });
  if (status.blockers.length) return { ...keep(status.blockers[0]), blockers: status.blockers };
  if (rewriteMode !== undefined && rewriteMode !== status.rewrite_mode) return keep('rewrite_mode_changed');
  if (model !== undefined && model !== status.gemini_model) return keep('gemini_model_changed');
  const selected = status.decisions_enabled ? 'decisions' : 'acp';
  if (route !== undefined && route !== selected) return keep('decision_route_changed');
  return { action: 'accept', reason: 'workflow_ready', route: selected };
}

async function judgeDraft(args) {
  const pinned = { trigger: args.trigger, route: args.route, rewriteMode: args['rewrite-mode'], model: args.model, noHistory: args['no-history'] };
  const policy = workflowPolicy(args.cwd, pinned);
  if (policy.action === 'keep') return [policy, 0];
  const { route } = policy;
  const [result, code] = route === 'decisions'
    ? await runOpenaiDecision(args.cwd, { ...pinned, route }, args['host-input'])
    : [{ action: 'rewrite', reason: 'direct_acp' }, 0];
  if (code) return [result, code];
  result.route = route;
  return [result, 0];
}

export function runHook() {
  if (!supportedNode()) {
    console.error('Codex Polish requires Node.js 22.16+.');
    return 1;
  }
  let event;
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(0)));
  } catch {
    console.error('Codex Polish could not read the hook event.');
    return 1;
  }
  if (event?.hook_event_name !== 'UserPromptSubmit' || event.agent_id || event.agent_type) return;
  if (event.session_id && process.env.CODEX_THREAD_ID && event.session_id !== process.env.CODEX_THREAD_ID) return;
  if (typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd)) return;
  const [mode] = projectSettings(event.cwd);
  rememberHistorySource(event, mode);
  if (mode === null) {
    console.log(JSON.stringify({ systemMessage: tr('Codex Polish 无法读取 codex-polish.mode。请设为 auto、manual 或 off。',
      'Codex Polish cannot read codex-polish.mode. Set it to auto, manual or off.', language(event.cwd)) }));
    return;
  }
  if (mode !== 'auto') return;
  const lang = language(event.cwd);
  const workflow = JSON.stringify(path.resolve(import.meta.dirname, '../skills/codex-polish/WORKFLOW.md'));
  const additionalContext = tr(`本项目已开启自动改写。按 ${workflow} 处理最终答复。用户主动要求润色本轮或已有回复时用 --trigger explicit，其余由本提醒触发的润色用 --trigger auto。进入 Gemini 步骤时，用 acp_workspace.mjs 返回的 start 和 send.exec 操作同一进程。保留用户指的原稿，无需播报润色进度。收到完整的最终 Markdown 后直接交付。遵守用户指定的格式、取消或禁止外发的要求。`,
      `Automatic rewriting is on for this project. Follow ${workflow} for the final reply. When the user asks to polish this reply or an earlier answer, use --trigger explicit. Use --trigger auto for polishing initiated by this reminder alone. For Gemini, execute the prepared start options from acp_workspace.mjs, then each send.exec on that session. Keep the selected draft. Run the polishing steps without progress announcements. Deliver the final Markdown as soon as it is complete. Honor the requested format, cancellations, and requests to keep content local.`, lang);
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }));
}

const commands = {
  hook: ['', '处理 Codex 回合提醒', 'process a Codex hook event'],
  'project-hook': ['', '输出项目提醒配置', 'print the project hook definition'],
  mode: ['--cwd DIR', '查看什么时候触发改写', 'show when replies are rewritten'],
  'set-mode': ['{auto,manual,off} --cwd DIR', '设置什么时候改写回复', 'choose when replies are rewritten'],
  'set-rewrite-mode': ['{normal,turbo} --cwd DIR', '选择自动润色用普通还是 Turbo 模式', 'choose Normal or Turbo for automatic polishing'],
  'set-history-turns': ['N --cwd DIR', '设置 Gemini 润色时能看到几轮历史（0 到 10 轮）', 'choose how many earlier exchanges Gemini receives (0–10)'],
  'set-decisions': ['{auto,off} --cwd DIR', '设置是否让 OpenAI 判断原稿是否需要润色', 'choose whether OpenAI decides if a draft needs editing'],
  'set-model': ['(MODEL_ID | --reset) --cwd DIR', '选择项目的 Gemini 改写模型，或恢复默认模型 ' + DEFAULT_GEMINI_MODEL, 'choose a Gemini model or reset to ' + DEFAULT_GEMINI_MODEL],
  prompt: ['--cwd DIR', '查看当前生效的润色提示词和来源', 'show the effective editing prompt and its source'],
  'set-prompt': ['[--link FILE | --reset] --cwd DIR', '从标准输入保存提示词、连接提示词文件或恢复默认', 'save a prompt from stdin, link a prompt file or restore the default'],
  'set-language': ['{auto,zh,en} --cwd DIR', '选择设置和提示的显示语言（auto 自动识别，zh 中文，en 英文）', 'choose the language for settings and messages (auto detects, zh Chinese, en English)'],
  check: ['--cwd DIR [--trigger {auto,explicit}] [--selection-only] [--no-history]', '查看当前设置和缺少的依赖', 'check project settings and local requirements'],
  decision: ['judge --trigger {auto,explicit} --cwd DIR [--route {acp,decisions}] [--rewrite-mode {normal,turbo}] [--model MODEL_ID] [--no-history]', '判断原稿是否需要润色', 'decide whether to rewrite a draft'],
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

async function main(args) {
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
  if (command === 'set-model' || command === 'set-prompt') options.reset = { type: 'boolean' };
  if (command === 'set-prompt' || command === 'decision') options['host-input'] = { type: 'boolean' };
  if (command === 'set-prompt') options.link = { type: 'string' };
  if (command === 'decision' || command === 'check') options.trigger = { type: 'string' };
  if (command === 'check') options['selection-only'] = { type: 'boolean' };
  if (command === 'check' || command === 'decision') options['no-history'] = { type: 'boolean' };
  if (command === 'decision') {
    options.route = { type: 'string' };
    options['rewrite-mode'] = { type: 'string' };
    options.model = { type: 'string' };
  }
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: rest, options, allowPositionals: true }));
  } catch {
    return usageError(t('参数无效或缺少参数值。使用 --help 查看用法。', 'Invalid option or missing option value. Use --help for usage.'));
  }
  if (options.cwd && !values.cwd) return usageError(t('缺少必填参数 --cwd', 'The --cwd option is required.'));
  if (values.link !== undefined && (values.reset || !values.link.trim()))
    return usageError(t('请使用 --link FILE 或 --reset。', 'Choose --link FILE or --reset.'));
  const expected = (command.startsWith('set-') && command !== 'set-prompt') || command === 'decision' ? 1 : 0;
  if (positionals.length !== (values.reset ? 0 : expected)) return usageError(t('参数组合无效。使用 --help 查看用法。', 'Invalid arguments. Use --help for usage.'));
  let value = positionals[0];
  if (['set-mode', 'set-rewrite-mode', 'set-language', 'set-decisions'].includes(command) && value)
    value = value.trim().toLowerCase();
  if (command === 'set-decisions' && value === 'on') value = 'auto';
  const choices = { 'set-mode': MODES, 'set-rewrite-mode': REWRITE_MODES, 'set-language': LANGUAGES, 'set-decisions': ['auto', 'off'], decision: ['judge'] };
  const toCheck = [[value, choices[command]]];
  if (command === 'decision' || values.trigger !== undefined) toCheck.push([values.trigger, REWRITE_TRIGGERS]);
  if (command === 'decision') {
    if (values['rewrite-mode'] !== undefined) toCheck.push([values['rewrite-mode'], REWRITE_MODES]);
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
    const encoded = Buffer.from(import.meta.url).toString('base64');
    hook.commandWindows = `node -e "import(Buffer.from('${encoded}','base64').toString()).then(m=>process.exitCode=m.runHook()||0)"`;
    console.log(JSON.stringify(definition, null, 2));
    return 0;
  }
  if (command === 'mode') {
    const [mode] = projectSettings(cwd);
    if (mode === null) return usageError(t('codex-polish.mode 无效。请设为 auto、manual 或 off。',
      'Invalid codex-polish.mode. Choose auto, manual or off.'));
    console.log(mode);
    return 0;
  }
  if (command === 'prompt') {
    try { console.log(JSON.stringify(readEditorPrompt(cwd))); }
    catch (error) {
      console.error(error.code === 'PROMPT_LINK_UNBOUND'
        ? t('这个提示词链接还没绑定。请用 set-prompt --link FILE 指定要使用的文件。',
          'This prompt link has no saved target. Use set-prompt --link FILE to choose the file.')
        : error.message === 'rewrite_mode_invalid'
        ? t('无法读取有效的改写模式。请用 set-rewrite-mode 选择 normal 或 turbo。',
          'Could not read a valid rewrite mode. Use set-rewrite-mode to choose normal or turbo.')
        : t('无法读取有效的润色提示词。可用 set-prompt --reset 恢复默认。',
          'Could not read a valid editing prompt. Use set-prompt --reset to restore the default.'));
      return 1;
    }
    return 0;
  }
  if (command === 'check') {
    const selectionOnly = values['selection-only'];
    if (selectionOnly && values.trigger !== 'explicit')
      return usageError(t('--selection-only 需要 --trigger explicit。', '--selection-only requires --trigger explicit.'));
    console.log(JSON.stringify({ ...runtimeStatus(cwd, projectSettings(cwd)[0], values.trigger, { selectionOnly, noHistory: values['no-history'] }), ...languageSettings(cwd) }));
    return 0;
  }
  if (command === 'decision') {
    const [output, code] = await judgeDraft(values);
    console.log(JSON.stringify(output));
    return code;
  }
  const save = (file, data) => writeProjectSetting(cwd, file, data, lang);
  let result;
  try {
    switch (command) {
      case 'set-mode': result = { mode: value, file: save(MODE_FILE, value) }; break;
      case 'set-rewrite-mode': result = { rewrite_mode: value, file: save(REWRITE_MODE_FILE, value) }; break;
      case 'set-decisions': result = { decisions_mode: value, file: save(DECISIONS_FILE, value) }; break;
      case 'set-history-turns': {
        const turns = parseHistoryTurns(value, lang);
        result = { history_turns: turns, file: save(HISTORY_FILE, String(turns)) };
        break;
      }
      case 'set-language': result = { file: save(LANGUAGE_FILE, value), ...languageSettings(cwd) }; break;
      case 'set-model': result = setProjectModel(cwd, values.reset ? DEFAULT_GEMINI_MODEL : value, lang); break;
      case 'set-prompt': {
        if (values.link !== undefined) {
          const target = path.resolve(cwd, values.link);
          const file = writeProjectSetting(cwd, PROMPT_FILE, target, lang, 'link');
          result = { prompt_source: 'custom', file };
          break;
        }
        let data;
        if (values.reset) data = null;
        else {
          try {
            if (values['host-input']) {
              const prompt = JSON.parse(utf8(await readHostLine()));
              if (typeof prompt !== 'string') throw new Error('invalid_prompt');
              data = await readPromptInput([Buffer.from(prompt)]);
            } else data = await readPromptInput(process.stdin);
          }
          catch {
            throw new RangeError(t('请输入非空的 UTF-8 文本。', 'Enter nonempty UTF-8 text.'));
          }
        }
        result = { prompt_source: values.reset ? 'default' : 'custom', file: save(PROMPT_FILE, data) };
        break;
      }
    }
  } catch (error) {
    if (error.code === 'INVALID_PROMPT_TARGET') {
      console.error(t('请选择包含非空 UTF-8 文本的普通文件。', 'Choose a regular file containing nonempty UTF-8 text.'));
      return 1;
    }
    console.error(error instanceof RangeError ? t('无法保存设置。', "Couldn't save the setting. ") + error.message :
      t('无法保存设置。请确认项目目录存在，而且能在 .codex 目录里写入普通文件。',
        "Couldn't save the setting. Check that the project exists and you can write to its .codex folder."));
    return 1;
  }
  console.log(JSON.stringify(result));
  return 0;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  process.exitCode = (await main(process.argv.slice(2))) ?? 0;
}
