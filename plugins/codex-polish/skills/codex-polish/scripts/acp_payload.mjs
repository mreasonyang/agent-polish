// Format one ACP prompt for the current agent to send over its open session.
import { parseArgs } from 'node:util';
import { projectHistoryTurns, historySource } from '../../../hooks/preferences.mjs';
import { readHistory } from '../../../hooks/history.mjs';
import { projectRewriteMode } from '../../../hooks/rewrite_mode.mjs';
import { MAX_REQUEST } from './text_guard.mjs';
import { isMain, readLimited, record, utf8 } from './cli_io.mjs';
import { MAX_EVIDENCE_BYTES, primaryMaterial, projectMaterial, validateSourceText } from './rewrite_material.mjs';
import { checkStagedEditorRole } from './editor_role.mjs';

function promptHistory(cwd, primaryBytes) {
  let available = MAX_EVIDENCE_BYTES - primaryBytes - Buffer.byteLength(',"history":[]');
  if (available <= 0) return [];
  let history;
  try {
    const turns = projectHistoryTurns(cwd);
    if (!turns) return [];
    const source = historySource(cwd);
    if (!source) return [];
    history = readHistory(source.transcript_path, source.session_id, source.turn_id, turns);
  } catch { return []; }
  // Keep the newest complete suffix, counting JSON escaping and array separators.
  let start = history.length;
  while (start > 0) {
    const bytes = Buffer.byteLength(JSON.stringify(history[start - 1])) + (start < history.length ? 1 : 0);
    if (bytes > available) break;
    available -= bytes;
    start--;
  }
  return history.slice(start);
}

export async function promptFrame(payload, cwd, { noHistory = false, editorRoleFile, rewriteMode } = {}) {
  if (!record(payload) || !Object.hasOwn(payload, 'sessionId')) throw new Error('invalid_input');
  const { sessionId, ...primary } = payload;
  validateSourceText(sessionId, 4096);
  const material = primaryMaterial(primary);
  const mode = projectRewriteMode(cwd ?? process.cwd());
  if (editorRoleFile !== undefined && rewriteMode !== mode)
    throw new Error('rewrite_mode_changed');
  const { prompt, bytes } = projectMaterial(material, cwd, mode);
  if (editorRoleFile !== undefined) checkStagedEditorRole(editorRoleFile, prompt);
  // The project style is already in the ACP role, but counts towards the material budget.
  if (cwd && !noHistory) {
    const history = promptHistory(cwd, bytes);
    if (history.length) material.history = history;
  }
  return {
    jsonrpc: '2.0',
    id: 6,
    method: 'session/prompt',
    params: {
      sessionId,
      prompt: [{ type: 'text', text: JSON.stringify(material) }],
    },
  };
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      cwd: { type: 'string' }, 'no-history': { type: 'boolean' },
      'editor-role-file': { type: 'string' }, 'rewrite-mode': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log('Usage: acp_payload.mjs [--cwd PATH] [--no-history] [--editor-role-file PATH --rewrite-mode normal|turbo]');
    else {
      const payload = JSON.parse(utf8(await readLimited(process.stdin, MAX_REQUEST)));
      console.log(JSON.stringify(await promptFrame(payload, values.cwd, {
        noHistory: values['no-history'], editorRoleFile: values['editor-role-file'], rewriteMode: values['rewrite-mode'],
      })));
    }
  } catch { process.exitCode = 1; }
}
