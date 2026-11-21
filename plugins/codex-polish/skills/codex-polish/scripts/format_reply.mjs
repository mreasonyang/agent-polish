import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { isCurrentTurn } from '../../../hooks/history.mjs';
import { historySource } from '../../../hooks/preferences.mjs';
import { rememberReplyOrigin } from '../../../hooks/reply_origin.mjs';
import { isMain, readLimited, utf8 } from './cli_io.mjs';
import { previousReply } from './previous_reply.mjs';
import { formatReply, STATUS_MARK } from './reply_display.mjs';
export { formatReply, originalReplyText } from './reply_display.mjs';

function formatSkipped({ draft, reason, display_language }) {
  if (typeof reason !== 'string' || !reason.trim() || /[\r\n\u2028\u2029]/u.test(reason)) throw new Error('invalid reason');
  if (!display_language) return { text: draft };
  const heading = display_language === 'zh' ? '未润色' : 'Polishing skipped';
  return { text: draft, display_text: `**${heading}** · ${reason}${STATUS_MARK}\n\n${draft}` };
}

export function delivery(payload, { cwd, selection, skipped, turnsBack }) {
  const { draft, display_language } = payload;
  if (typeof draft !== 'string' || (!skipped && typeof payload.candidate !== 'string') ||
      (display_language !== undefined && !['zh', 'en'].includes(display_language)) ||
      (payload.source_label !== undefined && !['gpt', 'quoted'].includes(payload.source_label))) throw new Error('invalid input');

  let source, origin = null;
  let label = selection || turnsBack ? 'quoted' : payload.source_label ?? 'gpt';
  try {
    source = cwd && historySource(cwd);
    if (source && turnsBack) {
      const target = previousReply(cwd, { turnsBack, noHistory: true }, source);
      if (target && target.question === payload.question && target.draft === draft) {
        origin = target.origin_turn_id;
        label = target.source_label;
      } else if (!isCurrentTurn(source.transcript_path, source.session_id, source.turn_id)) {
        source = null;
      }
    } else if (source && isCurrentTurn(source.transcript_path, source.session_id, source.turn_id)) {
      if (!selection && label === 'gpt') origin = source.turn_id;
    } else {
      source = null;
    }
  } catch {
    source = null;
  }

  const result = skipped ? formatSkipped(payload) : formatReply({ ...payload, source_label: label });
  if (source) {
    const literal = display_language === undefined;
    rememberReplyOrigin(cwd, source, result.display_text ?? result.text, origin, literal && !skipped ? 'quoted' : label, literal);
  }
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      cwd: { type: 'string' }, selection: { type: 'boolean' }, 'turns-back': { type: 'string' }, skipped: { type: 'boolean' }, render: { type: 'boolean' },
    } });
    const back = values['turns-back'];
    if ((values.cwd !== undefined && !isAbsolute(values.cwd)) || (back !== undefined &&
        (values.selection || !values.cwd || !/^[1-9]\d*$/.test(back) || !Number.isSafeInteger(Number(back))))) throw new Error('invalid arguments');
    const payload = JSON.parse(utf8(await readLimited(process.stdin)));
    const result = delivery(payload, { ...values, turnsBack: Number(back) || undefined });
    if (values.render) process.stdout.write(result.display_text ?? result.text);
    else console.log(JSON.stringify(result));
  } catch { process.exitCode = 2; }
}
