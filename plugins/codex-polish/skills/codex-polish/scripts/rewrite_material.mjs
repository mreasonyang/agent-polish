import { readEditorPrompt } from '../../../hooks/editor_prompt.mjs';
import { record } from './cli_io.mjs';
import { CREDENTIAL, DISPLAY_CONTROL, MAX_TEXT } from './text_guard.mjs';

// Count compact UTF-8 JSON, including escaped text, field names and any custom style.
export const MAX_EVIDENCE_BYTES = 256 * 1024;
export class MaterialError extends Error {}

export function validateSourceText(value, maxBytes = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()) throw new MaterialError('invalid_input');
  if (Buffer.byteLength(value) > maxBytes) throw new MaterialError('input_too_large');
  if (CREDENTIAL.test(value)) throw new MaterialError('possible_credential');
  if (DISPLAY_CONTROL.test(value)) throw new MaterialError('display_control');
}

export function primaryMaterial(data) {
  if (!record(data) || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'question') || !Object.hasOwn(data, 'draft'))
    throw new MaterialError('invalid_input');
  validateSourceText(data.question);
  validateSourceText(data.draft);
  return { question: data.question, draft: data.draft };
}

export function projectMaterial(primary, cwd, mode) {
  let prompt;
  try { prompt = readEditorPrompt(cwd ?? process.cwd(), mode); }
  catch { throw new MaterialError('editor_prompt_invalid'); }
  const evidence = prompt.source === 'custom' ? { ...primary, editor_prompt: prompt.text } : primary;
  const bytes = Buffer.byteLength(JSON.stringify(evidence));
  if (bytes > MAX_EVIDENCE_BYTES) throw new MaterialError('input_too_large');
  return { evidence, prompt, bytes };
}
