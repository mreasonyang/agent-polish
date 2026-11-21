// Prepare one JSON-RPC prompt locally. The agent sends the resulting text itself.
import { parseArgs } from 'node:util';
import { DEFAULT_THINKING_LEVEL, projectHistoryTurns, historySource, workflowPolicy } from '../../../hooks/preferences.mjs';
import { readHistory } from '../../../hooks/history.mjs';
import { lookupReplyOrigin } from '../../../hooks/reply_origin.mjs';
import { effectiveRewriteMode } from '../../../hooks/rewrite_mode.mjs';
import { previousReply } from './previous_reply.mjs';
import { isMain, readHostLine, readLimited, record, utf8, writeHostPages } from './cli_io.mjs';
import { primaryMaterial, projectMaterial, selectedMaterial, validateSourceText } from './rewrite_material.mjs';
import { checkStagedEditorRole } from './editor_role.mjs';

function promptHistory(cwd) {
  try {
    const turns = projectHistoryTurns(cwd);
    if (!turns) return [];
    const source = historySource(cwd);
    if (!source) return [];
    return readHistory(source.transcript_path, source.session_id, source.turn_id, turns, {
      lookupOrigin: lookupReplyOrigin.bind(null, cwd, source.session_id),
    });
  } catch { return []; }
}

function replyMaterial(primary, cwd, { noHistory, turnsBack, trigger }) {
  const material = primaryMaterial(primary);
  if (turnsBack !== undefined) {
    if (!cwd || trigger !== 'explicit' || !Number.isSafeInteger(turnsBack) || turnsBack < 1) throw new Error('invalid_target');
    const target = previousReply(cwd, { turnsBack, noHistory });
    if (!target || target.question !== material.question || target.draft !== material.draft) throw new Error('target_changed');
    if (target.history?.length) material.history = target.history;
  } else if (cwd && !noHistory) {
    const history = promptHistory(cwd);
    if (history.length) material.history = history;
  }
  return material;
}

export async function promptFrame(payload, cwd, options = {}) {
  const { selection, selectionOnly, turnsBack, editorRoleFile, rewriteMode, trigger, route, model, thinkingLevel = DEFAULT_THINKING_LEVEL } = options;
  if (!record(payload) || !Object.hasOwn(payload, 'sessionId')) throw new Error('invalid_input');
  const { sessionId, rewrite_request, ...primary } = payload;
  validateSourceText(sessionId, 4096);
  const selected = selection || selectionOnly;
  if (selected && (trigger !== 'explicit' || turnsBack !== undefined || (selection && selectionOnly)))
    throw new Error('invalid_target');
  const material = selected ? selectedMaterial(primary) : replyMaterial(primary, cwd, options);
  if (Object.hasOwn(payload, 'rewrite_request')) {
    if (selectionOnly || trigger !== 'explicit') throw new Error('invalid_input');
    validateSourceText(rewrite_request);
    material.rewrite_request = rewrite_request;
  }
  const mode = effectiveRewriteMode(cwd ?? process.cwd(), trigger);
  const { prompt } = projectMaterial(material, cwd, mode, { selectionOnly });
  if (editorRoleFile !== undefined) {
    if (!cwd || !rewriteMode || !trigger || !route || !model) throw new Error('missing_workflow_settings');
    const policy = workflowPolicy(cwd, { trigger, route, rewriteMode, model, thinkingLevel, selectionOnly, noHistory: options.noHistory || selected });
    if (policy.action !== 'accept') throw new Error(policy.reason);
    checkStagedEditorRole(editorRoleFile, prompt);
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
      cwd: { type: 'string' }, 'no-history': { type: 'boolean' }, 'turns-back': { type: 'string' },
      selection: { type: 'boolean' }, 'selection-only': { type: 'boolean' }, 'host-input': { type: 'boolean' },
      'editor-role-file': { type: 'string' }, 'rewrite-mode': { type: 'string' },
      trigger: { type: 'string' }, route: { type: 'string' }, model: { type: 'string' }, 'thinking-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log('Usage: acp_payload.mjs [--host-input] --cwd PATH --editor-role-file PATH --rewrite-mode normal|turbo --trigger auto|explicit --route acp|decisions --model MODEL_ID [--thinking-level LEVEL] [--no-history] [--turns-back N | --selection | --selection-only]');
    else {
      if (!values['editor-role-file']) throw new Error('missing_editor_role');
      const input = values['host-input'] ? await readHostLine() : await readLimited(process.stdin);
      const payload = JSON.parse(utf8(input));
      const frame = await promptFrame(payload, values.cwd, {
        noHistory: values['no-history'], turnsBack: values['turns-back'] === undefined ? undefined : Number(values['turns-back']),
        selection: values.selection, selectionOnly: values['selection-only'],
        editorRoleFile: values['editor-role-file'], rewriteMode: values['rewrite-mode'],
        trigger: values.trigger, route: values.route, model: values.model, thinkingLevel: values['thinking-level'],
      });
      const text = JSON.stringify(frame);
      if (values['host-input']) await writeHostPages(text);
      else console.log(text);
    }
  } catch { process.exitCode = 1; }
}
