import { readFileSync } from 'node:fs';
import { readSettings } from './settings.mjs';

const instructions = {
  normal: 'On an eligible ordinary turn call polish_reply once with trigger auto. On an explicit polishing turn use trigger explicit.',
  turbo: 'On an eligible ordinary turn call polish_reply once with trigger auto. On an explicit polishing turn use trigger explicit.',
  manual: 'Answer ordinary questions directly without calling polish_reply. Call it only for an explicit polishing request.',
  off: 'Do not call polish_reply or invoke Codex for reply polishing, even on an explicit request. ' +
    'If the user only asks to polish supplied text or a previous reply, return that text or the complete reply verbatim, ' +
    'with leading and trailing whitespace, line breaks, Markdown, and code intact. Do not rewrite it yourself or add any text, even if edits are requested. ' +
    'If /polish accompanies a new question or task, answer it normally and deliver the answer directly.'
};

function modeContext() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  // ProtoJSON may omit the initial, zero-valued invocation number.
  if ((input.invocationNum ?? 0) !== 0) return {};
  let mode = 'off';
  try {
    ({ mode } = readSettings());
  } catch {
    // Treat unavailable settings as off for this turn.
  }
  let guidance = instructions[mode];
  if (typeof input.lastUserInput === 'string' && /^说人话[。！.!]*$/u.test(input.lastUserInput.trim())) {
    guidance = mode === 'off'
      ? 'For this request, return the previous assistant reply verbatim. Do not call polish_reply or invoke Codex.'
      : 'The user explicitly asks for the previous reply in plain language. Call polish_reply once with trigger "explicit". ' +
        'Use the complete previous assistant reply verbatim as draft, its original question if available, and the exact user request as rewrite_request. ' +
        'Send the original reply to the editor before rewriting any of it yourself. Return the tool result verbatim.';
    guidance += ' If there is no previous reply, ask which text to rewrite.';
  }
  return {
    injectSteps: [{ systemMessage: { systemMessage:
      'The Codex Polish mode for the current user turn is ' + mode + '. ' + guidance
    } }]
  };
}

let result;
try {
  result = modeContext();
} catch {
  result = {};
}
process.stdout.write(JSON.stringify(result) + '\n');
