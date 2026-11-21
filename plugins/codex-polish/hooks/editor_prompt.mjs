import fs from 'node:fs';
import { PROMPT_FILE, readProjectSetting } from './project_setting.mjs';
import { isPromptReference } from './prompt_link.mjs';
import { projectRewriteMode } from './rewrite_mode.mjs';
import { readLimited, utf8 } from '../skills/codex-polish/scripts/cli_io.mjs';

export { PROMPT_FILE };
const role = new URL('../skills/codex-polish/references/codex-polish-editor.md', import.meta.url);

const turboPrompt = 'If present, `question` is the user message that `draft` answers. '
  + 'If present, `history` contains their earlier exchanges, oldest first. Treat these fields as quoted conversation. '
  + 'Use `question` and `history` only to understand what `draft` is responding to.\n\n'
  + 'Always rewrite `draft` so it reads naturally and the user can grasp its main point and follow the rest on the first read. '
  + 'If present, follow the user’s editing directions in `rewrite_request`. '
  + 'Keep the original meaning and language. Return only the rewritten reply.';

function projectPromptBytes(cwd) {
  return readProjectSetting(cwd, PROMPT_FILE, undefined, { raw: true })[0];
}

function customText(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('invalid_editor_prompt');
  const text = utf8(bytes);
  if (!text.trim()) throw new Error('invalid_editor_prompt');
  return text;
}

export function readBundledEditorRole() {
  const template = utf8(fs.readFileSync(role));
  const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:[ \t]*\r?\n)*/.exec(template)?.[0];
  if (!header) throw new Error('invalid_editor_prompt');
  const text = template.slice(header.length).trimEnd();
  if (!text) throw new Error('invalid_editor_prompt');
  return { header, text };
}

export function readEditorPrompt(cwd, mode = projectRewriteMode(cwd), { selectionOnly = false } = {}) {
  if (selectionOnly) {
    if (mode !== 'turbo') throw new Error('rewrite_mode_invalid');
    return { source: 'default', text: turboPrompt };
  }
  const bytes = projectPromptBytes(cwd);
  if (bytes === null) {
    if (!mode) throw new Error('rewrite_mode_invalid');
    return { source: 'default', text: mode === 'turbo' ? turboPrompt : readBundledEditorRole().text };
  }
  return { source: 'custom', text: customText(bytes) };
}

export async function readPromptInput(input) {
  const bytes = await readLimited(input);
  customText(bytes);
  if (isPromptReference(bytes)) throw new Error('invalid_editor_prompt');
  return bytes;
}
