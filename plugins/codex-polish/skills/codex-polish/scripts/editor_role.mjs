import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { readBundledEditorRole, readEditorPrompt } from '../../../hooks/editor_prompt.mjs';
import { effectiveRewriteMode, REWRITE_TRIGGERS } from '../../../hooks/rewrite_mode.mjs';
import { isMain } from './cli_io.mjs';

function renderEditorRole({ source, text }) {
  const { header } = readBundledEditorRole();
  return header + (source === 'custom' ? text : text + '\n');
}

export function editorRole(cwd, trigger) {
  if (trigger !== undefined && !REWRITE_TRIGGERS.includes(trigger)) throw new Error('invalid_trigger');
  return renderEditorRole(readEditorPrompt(cwd, effectiveRewriteMode(cwd, trigger)));
}

export function checkStagedEditorRole(file, prompt) {
  const expected = Buffer.from(renderEditorRole(prompt));
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size !== expected.length) throw new Error('editor_role_changed');
    // Bound the read even if the staged file grows after the size check.
    const actual = Buffer.alloc(expected.length + 1);
    let bytes = 0;
    while (bytes < actual.length) {
      const count = readSync(fd, actual, bytes, actual.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    if (!actual.subarray(0, bytes).equals(expected)) throw new Error('editor_role_changed');
  } finally {
    closeSync(fd);
  }
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { cwd: { type: 'string' }, trigger: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) console.log('Usage: editor_role.mjs --cwd PROJECT [--trigger auto|explicit|turbo]');
    else if (!values.cwd || !isAbsolute(values.cwd)) process.exitCode = 2;
    else process.stdout.write(editorRole(values.cwd, values.trigger));
  } catch (error) {
    process.stderr.write(error.message === 'rewrite_mode_invalid' ? 'rewrite_mode_invalid\n' : 'editor_prompt_invalid\n');
    process.exitCode = 1;
  }
}
