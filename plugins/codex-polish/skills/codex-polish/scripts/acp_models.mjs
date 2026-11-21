// Inspect one ACP frame. The current agent owns the connection and sends each request.
import { parseArgs } from 'node:util';
import { parseAcpFrame } from './acp_reader.mjs';
import { validModelId } from '../../../hooks/preferences.mjs';
import { isMain, readLimited, record, utf8 } from './cli_io.mjs';

// Bound incoming ACP configuration frames, which carry only model and session metadata.
export const MAX_CONFIG_FRAME_BYTES = 1024 * 1024;

// The provider's value selects the model. A label can be localized or renamed.
const GEMINI_ID = /(?:^|[/:])gemini-[a-z0-9][^/]*$/i;

export function catalog(options) {
  if (!Array.isArray(options)) throw new Error();
  const selectors = options.filter(option => option?.category === 'model');
  if (selectors.length !== 1) throw new Error();
  const [selector] = selectors;
  const { id, currentValue } = selector;
  if (selector.type !== 'select' || typeof id !== 'string' || !id.trim() || typeof currentValue !== 'string'
      || !Array.isArray(selector.options) || options.filter(option => option?.id === id).length !== 1) throw new Error();
  const seen = new Set();
  const models = [];
  const entries = selector.options.flatMap(item => Array.isArray(item?.options) ? item.options : [item]);
  for (const entry of entries) {
    if (!validModelId(entry?.value) || !GEMINI_ID.test(entry.value) || seen.has(entry.value)) continue;
    seen.add(entry.value);
    const name = (typeof entry.name === 'string' && entry.name.trim()) || entry.value;
    models.push({ id: entry.value, name });
  }
  return { config_id: id, current_model: seen.has(currentValue) ? currentValue : null, models };
}

export function nextRewriteStep(model, target, responseId) {
  if (![3n, 4n].includes(responseId) || !model.models.some(entry => entry.id === target)) throw new Error();
  if (model.current_model === target) return { next: 'submit_prompt' };
  if (responseId === 4n) throw new Error();
  return { next: 'set_model', config_id: model.config_id, value: target };
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
      'response-id': {type:'string'}, 'update-session': {type:'string'}, 'target-model': {type:'string'}, help:{type:'boolean', short:'h'},
    } });
    if (values.help) console.log('Usage: acp_models.mjs (--response-id ID | --update-session SESSION) [--target-model MODEL]');
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
      if (target !== undefined) {
        if (responseId !== undefined) result = nextRewriteStep(model, target, responseId);
        else if (model.current_model !== target) throw new Error();
      }
      console.log(JSON.stringify(result));
    }
  } catch { process.exitCode = 1; }
}
