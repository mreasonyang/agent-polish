// Format one ACP prompt for the current agent to send over its open session.
import { parseArgs } from 'node:util';
import { projectHistoryTurns, historySource, workflowPolicy } from '../../../hooks/preferences.mjs';
import { readHistory } from '../../../hooks/history.mjs';
import { effectiveRewriteMode } from '../../../hooks/rewrite_mode.mjs';
import { previousReply } from './previous_reply.mjs';
import { isMain, readLimited, record, utf8 } from './cli_io.mjs';
import { primaryMaterial, projectMaterial, validateSourceText } from './rewrite_material.mjs';
import { checkStagedEditorRole } from './editor_role.mjs';

function promptHistory(cwd) {
  try {
    const turns = projectHistoryTurns(cwd);
    if (!turns) return [];
    const source = historySource(cwd);
    if (!source) return [];
    return readHistory(source.transcript_path, source.session_id, source.turn_id, turns);
  } catch { return []; }
}

export async function promptFrame(payload, cwd, { noHistory = false, turnsBack, editorRoleFile, rewriteMode, trigger, route, model } = {}) {
  if (!record(payload) || !Object.hasOwn(payload, 'sessionId')) throw new Error('invalid_input');
  const { sessionId, rewrite_request, ...primary } = payload;
  validateSourceText(sessionId, 4096);
  const material = primaryMaterial(primary);
  if (turnsBack !== undefined) {
    if (!cwd || trigger !== 'turbo' || !Number.isSafeInteger(turnsBack) || turnsBack < 1) throw new Error('invalid_target');
    const target = previousReply(cwd, { turnsBack, noHistory });
    if (!target || target.question !== material.question || target.draft !== material.draft) throw new Error('target_changed');
    if (target.history?.length) material.history = target.history;
  } else if (cwd && !noHistory) {
    const history = promptHistory(cwd);
    if (history.length) material.history = history;
  }
  if (rewrite_request !== undefined) {
    if (trigger !== 'turbo') throw new Error('invalid_input');
    validateSourceText(rewrite_request);
    material.rewrite_request = rewrite_request;
  }
  const mode = effectiveRewriteMode(cwd ?? process.cwd(), trigger);
  const { prompt } = projectMaterial(material, cwd, mode);
  if (editorRoleFile !== undefined) {
    if (!cwd || !rewriteMode || !trigger || !route || !model) throw new Error('missing_workflow_settings');
    const policy = workflowPolicy(cwd, { trigger, route, rewriteMode, model });
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
      'editor-role-file': { type: 'string' }, 'rewrite-mode': { type: 'string' },
      trigger: { type: 'string' }, route: { type: 'string' }, model: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log('Usage: acp_payload.mjs --cwd PATH --editor-role-file PATH --rewrite-mode normal|turbo --trigger auto|explicit|turbo --route acp|decisions --model MODEL_ID [--no-history] [--turns-back N]');
    else {
      if (!values['editor-role-file']) throw new Error('missing_editor_role');
      const payload = JSON.parse(utf8(await readLimited(process.stdin)));
      console.log(JSON.stringify(await promptFrame(payload, values.cwd, {
        noHistory: values['no-history'], turnsBack: values['turns-back'] === undefined ? undefined : Number(values['turns-back']),
        editorRoleFile: values['editor-role-file'], rewriteMode: values['rewrite-mode'],
        trigger: values.trigger, route: values.route, model: values.model,
      })));
    }
  } catch { process.exitCode = 1; }
}
