// Format one ACP prompt for the current agent to send over its open session.
import { parseArgs } from 'node:util';
import { exchange, decode } from './acp_windows_io.mjs';
import { Socket } from 'node:net';
import { claimPrompt, openDisplayOutput } from './acp_workspace.mjs';
import { projectHistoryTurns, historySource, workflowPolicy } from '../../../hooks/preferences.mjs';
import { readHistory } from '../../../hooks/history.mjs';
import { lookupReplyOrigin } from '../../../hooks/reply_origin.mjs';
import { effectiveRewriteMode } from '../../../hooks/rewrite_mode.mjs';
import { previousReply } from './previous_reply.mjs';
import { isMain, readHostLine, readInputLine, readLimited, record, utf8 } from './cli_io.mjs';
import { primaryMaterial, projectMaterial, selectedMaterial, validateSourceText } from './rewrite_material.mjs';
import { checkStagedEditorRole } from './editor_role.mjs';

async function sendRecord(stream, value) {
  const data = Buffer.from(JSON.stringify(value) + '\n');
  stream.on('error', () => { process.exitCode = 1; });
  for (let offset = 0; offset < data.length; offset += 65536) {
    // Bound an actual stalled pipe, not the time spent receiving or generating the material.
    const stalled = setTimeout(() => process.exit(1), 30000);
    try {
      await new Promise((resolve, reject) => stream.write(data.subarray(offset, offset + 65536),
        error => error ? reject(error) : resolve()));
    } finally { clearTimeout(stalled); }
  }
}

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
  const { selection, selectionOnly, turnsBack, editorRoleFile, rewriteMode, trigger, route, model } = options;
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
    const policy = workflowPolicy(cwd, { trigger, route, rewriteMode, model, selectionOnly, noHistory: options.noHistory || selected });
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
    const windows = process.argv[2] === '--windows-submit';
    const { values } = parseArgs({ args: windows ? decode(process.argv[4]) : process.argv.slice(2), options: {
      cwd: { type: 'string' }, 'no-history': { type: 'boolean' }, 'turns-back': { type: 'string' },
      selection: { type: 'boolean' }, 'selection-only': { type: 'boolean' }, submit: { type: 'boolean' },
      'session-id': { type: 'string' },
      'editor-role-file': { type: 'string' }, 'rewrite-mode': { type: 'string' },
      trigger: { type: 'string' }, route: { type: 'string' }, model: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log('Usage: acp_payload.mjs [--submit --session-id ID] --cwd PATH --editor-role-file PATH --rewrite-mode normal|turbo --trigger auto|explicit --route acp|decisions --model MODEL_ID [--no-history] [--turns-back N | --selection | --selection-only]');
    else {
      if (!values['editor-role-file']) throw new Error('missing_editor_role');
      if (Boolean(values.submit) !== Boolean(values['session-id'])) throw new Error('invalid_options');
      const payload = JSON.parse(utf8(windows ? await readHostLine() : values.submit ? await readInputLine(process.stdin) : await readLimited(process.stdin)));
      if (values.submit) {
        if (!record(payload) || Object.hasOwn(payload, 'sessionId')) throw new Error('invalid_input');
        payload.sessionId = values['session-id'];
      }
      const frame = await promptFrame(payload, values.cwd, {
        noHistory: values['no-history'], turnsBack: values['turns-back'] === undefined ? undefined : Number(values['turns-back']),
        selection: values.selection, selectionOnly: values['selection-only'],
        editorRoleFile: values['editor-role-file'], rewriteMode: values['rewrite-mode'],
        trigger: values.trigger, route: values.route, model: values.model,
      });
      // The local display copy travels in memory. Claim the one submission after validation.
      if (values.submit) {
        const local = { draft: values.selection || values['selection-only'] ? payload.selection : payload.draft };
        if (payload.question !== undefined) local.question = payload.question;
        if (windows) {
          const ack = await exchange(process.argv[3], { frame, original: local }, 32);
          if (ack !== true) throw Error('acp_write_failed');
        } else {
          const token = process.env.CODEX_POLISH_WRITE_TOKEN;
          claimPrompt(token, frame.params.sessionId);
          const display = new Socket({ fd: openDisplayOutput(token), readable: false, writable: true });
          try { await sendRecord(display, local); }
          finally { display.destroy(); }
          await sendRecord(process.stdout, frame);
        }
      } else console.log(JSON.stringify(frame));
    }
  } catch { process.exitCode = 1; }
}
