// Inspect one ACP frame. The current agent owns the connection and sends each request.
import { parseArgs } from 'node:util';
import { parseAcpFrame } from './acp_reader.mjs';
import { DEFAULT_THINKING_LEVEL, validThinkingLevel, validModelId } from '../../../hooks/preferences.mjs';
import { isMain, readLimited, record, utf8 } from './cli_io.mjs';

// Bound incoming ACP configuration frames, which carry only model and session metadata.
export const MAX_CONFIG_FRAME_BYTES = 1024 * 1024;

// The provider's value selects the model. A label can be localized or renamed.
const GEMINI_ID = /(?:^|[/:])gemini-[a-z0-9][^/]*$/i;

export function catalog(options) {
  if (!Array.isArray(options)) throw new Error();
  const selector = selectByCategory(options, 'model');
  if (!selector) throw new Error('acp_model_unavailable');
  const { id, currentValue } = selector;
  const seen = new Set();
  const models = [];
  const entries = selector.options.flatMap(item => Array.isArray(item?.options) ? item.options : [item]);
  for (const entry of entries) {
    if (!validModelId(entry?.value) || !GEMINI_ID.test(entry.value) || seen.has(entry.value)) continue;
    seen.add(entry.value);
    const name = (typeof entry.name === 'string' && entry.name.trim()) || entry.value;
    models.push({ id: entry.value, name });
  }
  const thinking = selectByCategory(options, 'thought_level');
  const levels = [];
  if (thinking) {
    const entries = thinking.options.flatMap(item => Array.isArray(item?.options) ? item.options : [item]);
    for (const choice of entries) {
      if (!validThinkingLevel(choice?.value) || choice.value === 'fixed' || levels.some(level => level.id === choice.value)) continue;
      levels.push({ id: choice.value, name: (typeof choice.name === 'string' && choice.name.trim()) || choice.value });
    }
    if (!levels.length) throw new Error('acp_thinking_level_unavailable');
  }
  return { config_id: id, current_model: seen.has(currentValue) ? currentValue : null, models,
    thinking_config_id: thinking?.id ?? null, current_thinking_level: thinking?.currentValue ?? null, thinking_levels: levels };
}

function selectByCategory(options, category) {
  const selectors = options.filter(option => option?.category === category);
  if (!selectors.length) return null;
  const [selector] = selectors;
  if (selectors.length !== 1 || selector.type !== 'select' || typeof selector.id !== 'string' || !selector.id.trim() ||
      typeof selector.currentValue !== 'string' || !Array.isArray(selector.options) ||
      options.filter(option => option?.id === selector.id).length !== 1) throw new Error('acp_protocol_error');
  return selector;
}

// A target-only catalog checks the model but never changes its thinking level.
export function nextConfigStep(config, target, responseId, thinkingLevel) {
  if (![3n, 4n, 5n].includes(responseId) || !config.models.some(entry => entry.id === target)) throw new Error('acp_model_unavailable');
  if (config.current_model !== target) {
    if (responseId !== 3n) throw new Error('acp_model_unavailable');
    return { next: 'set_model', config_id: config.config_id, value: target };
  }
  if (thinkingLevel === undefined) return { next: 'catalog' };
  if (thinkingLevel === 'fixed' && !config.thinking_config_id && responseId !== 5n) return { next: 'submit_prompt' };
  if (!config.thinking_levels.some(level => level.id === thinkingLevel)) throw new Error('acp_thinking_level_unavailable');
  if (config.current_thinking_level === thinkingLevel) return { next: 'submit_prompt' };
  if (responseId === 5n) throw new Error('acp_thinking_level_unavailable');
  return { next: 'set_thinking_level', config_id: config.thinking_config_id, value: thinkingLevel };
}

function frameOptions(frame, responseId, session) {
  if (!record(frame) || frame.jsonrpc !== '2.0' || 'error' in frame) throw new Error();
  if (responseId !== undefined) {
    if ('method' in frame || frame.id !== responseId || !record(frame.result)) throw new Error();
    return frame.result.configOptions;
  }
  if (frame.method !== 'session/update' || 'id' in frame || 'result' in frame
      || !session || frame.params?.sessionId !== session || frame.params.update?.sessionUpdate !== 'config_option_update')
    throw new Error();
  return frame.params.update.configOptions;
}

export function sessionCatalog(line, id) {
  return catalog(frameOptions(parseAcpFrame(line, { bigintIds: true }), id));
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'response-id': {type:'string'}, 'update-session': {type:'string'}, 'target-model': {type:'string'}, 'thinking-level': {type:'string'}, help:{type:'boolean', short:'h'},
    } });
    if (values.help) console.log('Usage: acp_models.mjs (--response-id ID | --update-session SESSION) [--target-model MODEL [--thinking-level LEVEL]]');
    else {
      const id = values['response-id'];
      if ((id === undefined) === (values['update-session'] === undefined) || (id !== undefined && !/^[+-]?\d+$/.test(id)))
        throw new Error();
      const frame = parseAcpFrame(utf8(await readLimited(process.stdin, MAX_CONFIG_FRAME_BYTES)), { bigintIds: true });
      const responseId = id === undefined ? undefined : BigInt(id);
      const options = frameOptions(frame, responseId, values['update-session']);
      const model = catalog(options);
      const target = values['target-model'];
      let result = model;
      const level = values['thinking-level'] ?? DEFAULT_THINKING_LEVEL;
      if (!validThinkingLevel(level) || (!target && values['thinking-level'] !== undefined)) throw new Error();
      if (target !== undefined) {
        if (responseId !== undefined) result = nextConfigStep(model, target, responseId, level);
        else if (nextConfigStep(model, target, 3n, level).next !== 'submit_prompt') throw new Error();
      }
      console.log(JSON.stringify(result));
    }
  } catch { process.exitCode = 1; }
}
