import { readEditorPrompt } from '../../../hooks/editor_prompt.mjs';
import { record } from './cli_io.mjs';

export class MaterialError extends Error {}

export function validateSourceText(value, maxBytes) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()) throw new MaterialError('invalid_input');
  if (maxBytes !== undefined && Buffer.byteLength(value) > maxBytes) throw new MaterialError('input_too_large');
}

export function primaryMaterial(data) {
  if (!record(data) || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'question') || !Object.hasOwn(data, 'draft'))
    throw new MaterialError('invalid_input');
  validateSourceText(data.question);
  validateSourceText(data.draft);
  return { question: data.question, draft: data.draft };
}

export function selectedMaterial(data) {
  if (!record(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'selection'))
    throw new MaterialError('invalid_input');
  validateSourceText(data.selection);
  return { draft: data.selection };
}

export function editingMaterial(primary, mode, { selectionOnly = false } = {}) {
  let prompt;
  try { prompt = readEditorPrompt(mode, { selectionOnly }); }
  catch { throw new MaterialError('editor_prompt_invalid'); }
  const evidence = prompt.source === 'custom' ? { ...primary, editor_prompt: prompt.text } : primary;
  return { evidence, prompt };
}
