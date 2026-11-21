// Render the prompt-phase bytes the agent already received. This tool has no ACP connection.
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { validModelId, validThinkingLevel } from '../../../hooks/preferences.mjs';
import { catalog, nextConfigStep } from './acp_models.mjs';
import { readACP } from './acp_reader.mjs';
import { isMain, readHostLine, readLimited, record, utf8, writeHostPages } from './cli_io.mjs';
import { delivery } from './format_reply.mjs';
import { validateSourceText } from './rewrite_material.mjs';

export function completedAnswer(input, { sessionId, model, thinkingLevel, cwd, selection, turnsBack }) {
  validateSourceText(sessionId, 4096);
  if (!validModelId(model) || !validThinkingLevel(thinkingLevel) || !isAbsolute(cwd) ||
      (turnsBack !== undefined && (selection || !Number.isSafeInteger(turnsBack) || turnsBack < 1)))
    throw Error('invalid_options');
  if (!record(input) || typeof input.output !== 'string') throw Error('invalid_input');
  const { draft, question, display_language, source_label } = input;
  validateSourceText(draft);
  if (turnsBack || question !== undefined) validateSourceText(question);

  const { state, events } = readACP(null, input.output, { pendingId: 6, sessionId });
  if (state.reason || !state.promptEnded) throw Error(state.reason ?? 'acp_incomplete');
  for (const event of events) {
    if (event.type !== 'config') continue;
    const config = catalog(JSON.parse(event.raw).params.update.configOptions);
    if (config.current_model !== model) throw Error('acp_model_unavailable');
    if (nextConfigStep(config, model, 3n, thinkingLevel).next !== 'submit_prompt')
      throw Error('acp_thinking_level_unavailable');
  }
  const result = delivery({ draft, question, candidate: state.text, display_language, source_label },
    { cwd, selection, turnsBack });
  return result.display_text ?? result.text;
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'session-id': { type: 'string' }, model: { type: 'string' }, 'thinking-level': { type: 'string' },
      cwd: { type: 'string' }, selection: { type: 'boolean' }, 'turns-back': { type: 'string' },
      'host-input': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log('Usage: acp_answer.mjs --session-id ID --model MODEL --thinking-level LEVEL --cwd DIR [--selection | --turns-back N] [--host-input]');
    else {
      const input = values['host-input'] ? await readHostLine() : await readLimited(process.stdin);
      const markdown = completedAnswer(JSON.parse(utf8(input)), {
        cwd: values.cwd, sessionId: values['session-id'], model: values.model, thinkingLevel: values['thinking-level'],
        selection: values.selection, turnsBack: values['turns-back'] === undefined ? undefined : Number(values['turns-back']),
      });
      if (values['host-input']) await writeHostPages(markdown);
      else process.stdout.write(markdown);
    }
  } catch (error) {
    const reason = /^acp_[a-z_]+$/.test(error.message) ? error.message : 'acp_display_failed';
    process.stderr.write(reason + '\n');
    process.exitCode = 1;
  }
}
