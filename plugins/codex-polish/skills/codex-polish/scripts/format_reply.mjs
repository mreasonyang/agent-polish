import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { isCurrentTurn, sessionSource } from '../../../hooks/history.mjs';
import { historySource } from '../../../hooks/preferences.mjs';
import { sqliteModule } from '../../../hooks/recovery.mjs';
import { rememberReplyOrigin } from '../../../hooks/reply_origin.mjs';
import { isMain, readHostLine, readLimited, utf8 } from './cli_io.mjs';
import { previousReply } from './previous_reply.mjs';
import { formatReply } from './reply_display.mjs';
export { formatReply, originalReplyText } from './reply_display.mjs';

// The formatter can itself run in a PTY on any client. Identify the Codex
// session, not the helper's stdin or TERM. Manual mode also works without hooks.
function isCodexTui(source) {
  const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: client, CODEX_THREAD_ID: id, CODEX_SQLITE_HOME, CODEX_HOME } = process.env;
  if (client) return client === 'codex-tui';
  if (!id) return false;
  const kind = source && sessionSource(source.transcript_path, id);
  if (kind) return kind === 'cli';
  try {
    const dir = CODEX_SQLITE_HOME || CODEX_HOME || join(homedir(), '.codex');
    if (!isAbsolute(dir)) return false;
    const files = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name));
    const latest = files.map(entry => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
    if (!latest) return false;
    const { DatabaseSync } = sqliteModule();
    const db = new DatabaseSync(join(dir, latest), { readOnly: true });
    try {
      return db.prepare('SELECT source FROM threads WHERE id=?').get(id)?.source === 'cli';
    } finally { db.close(); }
  } catch { return false; }
}

function formatSkipped({ draft, reason, display_language }) {
  if (typeof reason !== 'string' || !reason.trim() || /[\r\n\u2028\u2029]/u.test(reason)) throw new Error('invalid reason');
  if (!display_language) return { text: draft };
  return { text: draft, display_text: `${reason}\n\n${draft}` };
}

export function delivery(payload, { cwd, selection, skipped, kept, turnsBack, trigger = 'auto' }) {
  const { draft, display_language } = payload;
  if (!['auto', 'explicit'].includes(trigger) || (kept && (skipped || trigger !== 'auto'))) throw new Error('invalid options');
  if (typeof draft !== 'string' || (!kept && !skipped && typeof payload.candidate !== 'string') ||
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

  let result;
  if (kept) result = { text: draft };
  else if (skipped) result = formatSkipped(payload);
  else result = formatReply({ ...payload, source_label: label }, {
    trigger, terminal: Boolean(cwd && display_language && draft !== payload.candidate && isCodexTui(source)),
  });
  if (source) {
    const shown = result.display_text ?? result.text;
    const literal = shown === result.text;
    const notice = !literal && (skipped || draft === payload.candidate);
    const bodyOnlyRewrite = display_language === undefined && !kept && !skipped;
    rememberReplyOrigin(cwd, source, shown, origin, bodyOnlyRewrite ? 'quoted' : label, { literal, notice });
  }
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'host-input': { type: 'boolean' }, cwd: { type: 'string' }, trigger: { type: 'string' }, selection: { type: 'boolean' }, 'turns-back': { type: 'string' }, skipped: { type: 'boolean' }, kept: { type: 'boolean' }, render: { type: 'boolean' },
    } });
    const back = values['turns-back'];
    if ((values.cwd !== undefined && !isAbsolute(values.cwd)) || (back !== undefined &&
        (values.selection || !values.cwd || !/^[1-9]\d*$/.test(back) || !Number.isSafeInteger(Number(back))))) throw new Error('invalid arguments');
    const payload = JSON.parse(utf8(values['host-input'] ? await readHostLine() : await readLimited(process.stdin)));
    const result = delivery(payload, { ...values, turnsBack: Number(back) || undefined });
    if (values.render) process.stdout.write(result.display_text ?? result.text);
    else console.log(JSON.stringify(result));
  } catch { process.exitCode = 2; }
}
