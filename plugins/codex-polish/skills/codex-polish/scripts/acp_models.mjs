// List selectable Gemini models in one ACP frame captured by the current agent.
import { parseArgs } from 'node:util';
import { validModelId } from '../../../hooks/preferences.mjs';
import { CREDENTIAL, MAX_REQUEST } from './text_guard.mjs';
import { isMain, readLimited, record, utf8 } from './cli_io.mjs';

const GEMINI_NAME = /^Gemini(?= [a-z0-9])/i;
const GEMINI_ID = /^gemini-[a-z0-9]/;
const OTHER_MODEL = /(?:^|[^a-z0-9])(?:auto|automatic|router|routing|orchestrator|claude|anthropic|sonnet|opus|haiku|gpt|openai|llama|mistral|grok|deepseek|qwen)(?:$|[^a-z0-9]|[0-9])/i;

function publicName(value, label) {
  if (typeof label !== 'string' || !label || [...label].length > 128 || label !== label.trim()
      || /[^\p{L}\p{N} ._+()（）-]/u.test(label) || CREDENTIAL.test(label) || CREDENTIAL.test(value)
      || OTHER_MODEL.test(label) || OTHER_MODEL.test(value)) return null;
  return GEMINI_ID.test(value) && GEMINI_NAME.test(label) ? label : null;
}

function selectValues(options) {
  if (!Array.isArray(options) || !options.every(record)) throw new Error();
  if (!options.some(option => 'options' in option)) return options;
  return options.flatMap(group => {
    if (typeof group.group !== 'string' || typeof group.name !== 'string'
        || !Array.isArray(group.options) || 'value' in group) throw new Error();
    return group.options;
  });
}

export function catalog(options) {
  if (!Array.isArray(options) || !options.every(record)) throw new Error();
  const selectors = options.filter(option => option.category === 'model');
  if (selectors.length !== 1) throw new Error();
  const [selector] = selectors;
  const { id, currentValue } = selector;
  if (selector.type !== 'select' || typeof selector.name !== 'string' || !selector.name || !validModelId(id) || CREDENTIAL.test(id)
      || options.filter(option => option.id === id).length !== 1) throw new Error();
  const seen = new Set();
  const models = [];
  for (const item of selectValues(selector.options)) {
    if (!record(item) || 'options' in item || typeof item.value !== 'string' || typeof item.name !== 'string' || seen.has(item.value))
      throw new Error();
    seen.add(item.value);
    if (!validModelId(item.value)) continue;
    const name = publicName(item.value, item.name);
    if (name) models.push({ id: item.value, name });
  }
  if (!seen.has(currentValue)) throw new Error();
  return { config_id: id, current_model: models.some(model => model.id === currentValue) ? currentValue : null, models };
}

function parseFrame(raw) {
  // JSON.parse validates the grammar but normally drops duplicate fields. Scan the
  // already validated text for keys, decoding escaped forms before comparing.
  const frame = JSON.parse(raw, (key, value, context) => {
    if (key !== 'id' || typeof value !== 'number') return value;
    return /^-?\d+$/.test(context.source) ? BigInt(context.source) : null;
  });
  const objects = [];
  for (const match of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}]/g)) {
    const token = match[0];
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else {
      let end = match.index + token.length;
      while (end < raw.length && ' \r\n\t'.includes(raw[end])) end++;
      if (raw[end] !== ':') continue;
      const key = JSON.parse(token);
      const fields = objects.at(-1);
      if (fields.has(key)) throw new Error();
      fields.add(key);
    }
  }
  return frame;
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

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'response-id': {type:'string'}, 'update-session': {type:'string'}, help:{type:'boolean', short:'h'} } });
    if (values.help) console.log('Usage: acp_models.mjs --response-id ID | --update-session SESSION');
    else {
      const id = values['response-id'];
      if ((id === undefined) === (values['update-session'] === undefined) || (id !== undefined && !/^[+-]?\d+$/.test(id)))
        throw new Error();
      const frame = parseFrame(utf8(await readLimited(process.stdin, MAX_REQUEST)));
      console.log(JSON.stringify(catalog(frameOptions(frame, id === undefined ? undefined : BigInt(id), values['update-session']))));
    }
  } catch { process.exitCode = 1; }
}
