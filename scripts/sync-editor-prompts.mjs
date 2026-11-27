import { readFileSync, writeFileSync } from 'node:fs';
import { readBundledEditorPrompt } from '../plugins/codex-polish/hooks/editor_prompt.mjs';

// Native AgY installations only contain their own plugin directory.
// Bundle the stock editor text there without reading anyone's profile.
const target = new URL('../plugins/agy-polish/scripts/editor-prompts.json', import.meta.url);
const content = JSON.stringify({
  normal: readBundledEditorPrompt('normal'),
  turbo: readBundledEditorPrompt('turbo')
}, null, 2) + '\n';

if (process.argv[2] === '--check') {
  if (readFileSync(target, 'utf8') !== content)
    throw new Error('AgY editor prompts are out of date. Run node scripts/sync-editor-prompts.mjs.');
} else {
  writeFileSync(target, content);
}
