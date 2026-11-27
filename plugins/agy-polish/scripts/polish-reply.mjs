import { isDeepStrictEqual } from 'node:util';
import editorPrompts from './editor-prompts.json' with { type: 'json' };
import { editWithCodex } from './codex-editor.mjs';
import { withWorkspace } from './codex-process.mjs';
import { readSettings } from './settings.mjs';

const outputSchema = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'The complete edited draft text, including unchanged sections. Copy quoted strings, URLs, link destinations, and code (including indentation and whitespace) exactly.'
    },
    complete: { type: 'boolean', enum: [true], description: 'True only when reply contains the entire result.' }
  },
  required: ['reply', 'complete'],
  additionalProperties: false
};

export const polishInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'draft', 'trigger'],
  properties: {
    question: { type: 'string', description: 'Current question, or the original question for a referenced reply.' },
    draft: { type: 'string', description: 'Complete draft exactly as written, including code and whitespace.' },
    trigger: { type: 'string', enum: ['auto', 'explicit'] },
    rewrite_request: { type: 'string', description: 'Optional editing directions explicitly supplied by the user.' },
    selection: { type: 'string', minLength: 1, description: 'Optional exact, uniquely occurring passage to edit within the draft.' }
  }
};

function skipRequest(text) {
  return [
    /不(?:要|用|必)(?:再)?(?:外发|外传|上传|联网|调用\s*Codex|发送给(?:其他|第三方)|把[^。！？\n]{0,30}(?:外发|外传|发给第三方))/iu,
    /不(?:要|用|必)(?:再)?(?:润色|改写)(?=\s*(?:这条回复|这次回答|草稿)?[。！？；，,.!?\n]|$)/u,
    /(?:仅|只)(?:在本地处理|用\s*Gemini)|(?:取消|跳过)(?:本次)?润色/u,
    /\b(?:do not|don['’]t|never|no need to)\s+(?:upload|(?:send|share)\b[^\n]{0,50}\b(?:anywhere|outside|external|third.part|other model|codex)|use\s+codex)/iu,
    /\b(?:do not|don['’]t|never|no need to)\s+(?:polish|rewrite)(?:\s+(?:this|it|(?:the|this) (?:reply|answer|draft)))?(?=\s*(?:[.,;!?]|\n|$))/iu,
    /\b(?:keep (?:it|this|the (?:turn|text|draft)) (?:private|local)|(?:use )?gemini only|only use gemini|no (?:external (?:services?|models?)|third.party (?:services?|models?))|skip polishing)\b/iu,
    /逐字(?:照抄|转录|输出)|原样(?:照抄|输出|返回)|(?:请)?(?:只|仅)(?:输出|返回)(?:有效的?|原始的?)?\s*(?:JSON|JSONL|YAML|XML|CSV|代码|命令)/iu,
    /\b(?:return|output|reproduce|copy|transcribe|respond with)\s+(?:(?:only|raw|valid)\s+)+(?:jsonl?|yaml|xml|csv|code|(?:a |the )?command)\b/iu,
    /(?:^|[.!?\n]\s*)(?:please\s+)?(?:return|output|reproduce|copy|transcribe)\b[^.!?\n]{0,90}\b(?:verbatim|byte.for.byte|exactly as written)\b/iu,
    /^\s*(?:配置回复润色|configure reply polishing|\/polish-settings)(?:[\s,.!?，。！？]|$)/iu
  ].some((pattern) => pattern.test(text));
}

function isStructured(text) {
  if (!/^\s*[[{]/u.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function protectedLiterals(text) {
  let fence;
  let block = [];
  let indented = '';
  let blankLines = '';
  const prose = [];
  const literals = [];

  function endIndentedCode() {
    if (indented) literals.push(indented.replace(/(?:\r\n|\r|\n)$/, ''));
    indented = '';
    blankLines = '';
  }

  for (const [line, body, ending] of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (!line) continue;
    const marker = /^[\t >]*(?:(?:[-+*]|\d+[.)])[\t ]+)?(\x60{3,}|~{3,})(.*)$/.exec(body);
    if (fence) {
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        literals.push(block.join('') + body);
        block = [];
        fence = undefined;
      } else {
        block.push(line);
      }
      continue;
    }
    if (!marker && /^(?: {4}|\t)[\t ]*\S/.test(body)) {
      indented += blankLines + line;
      blankLines = '';
      prose.push(ending);
      continue;
    }
    if (indented && !body.trim()) {
      blankLines += line;
      prose.push(line);
      continue;
    }
    endIndentedCode();
    if (marker) {
      fence = marker[1];
      block.push(line);
      prose.push(ending);
    } else {
      prose.push(line);
    }
  }
  endIndentedCode();
  if (block.length) literals.push(block.join(''));
  const inline = /(?<!\x60)(\x60+)(?!\x60)[\s\S]*?(?<!\x60)\1(?!\x60)|(?<=\]\()(?:<[^>\r\n]+>|[^\s)]+)|https?:\/\/[^\s<>\x60)"'，。]+|"[^"\r\n]+"|“[^”\r\n]+”|「[^」\r\n]+」|『[^』\r\n]+』/gu;
  for (const match of prose.join('').matchAll(inline)) literals.push(match[0]);
  return literals.sort();
}

function promptFor(input, mode, selected) {
  const instructions = editorPrompts[input.trigger === 'explicit' ? 'turbo' : mode];
  const material = {
    ...(selected ? {} : { question: input.question }),
    draft: input.selection ?? input.draft,
    ...(input.rewrite_request === undefined ? {} : { rewrite_request: input.rewrite_request })
  };
  return instructions + '\n\n' + JSON.stringify(material);
}

export function validInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every((key) => Object.hasOwn(polishInputSchema.properties, key)) &&
    polishInputSchema.required.every((key) => Object.hasOwn(input, key)) &&
    typeof input.question === 'string' && typeof input.draft === 'string' &&
    polishInputSchema.properties.trigger.enum.includes(input.trigger) &&
    (input.rewrite_request === undefined || typeof input.rewrite_request === 'string') &&
    (input.selection === undefined || (typeof input.selection === 'string' && !!input.selection.trim()));
}

export async function polishReply(input, { signal, timeout = 90_000 } = {}) {
  if (!validInput(input)) return typeof input?.draft === 'string' ? input.draft : '';
  const { draft, question, trigger, rewrite_request, selection } = input;
  try {
    if (signal?.aborted || !draft.trim() ||
        skipRequest(question) || (rewrite_request && skipRequest(rewrite_request)) || isStructured(draft)) return draft;
    const initialMode = readSettings().mode;
    if (initialMode === 'off' || (initialMode === 'manual' && trigger === 'auto')) return draft;

    const selected = selection !== undefined;
    const start = selected ? draft.indexOf(selection) : 0;
    if (selected && (start === -1 || start !== draft.lastIndexOf(selection))) return draft;
    const end = start + (selection ?? draft).length;
    const originalLiterals = protectedLiterals(draft);

    const reply = await withWorkspace((workspace) => editWithCodex(workspace, { signal, timeout }, outputSchema, () => {
      // Provider and credential lookup can take time. Read the current preferences at dispatch.
      const { mode, model, effort } = readSettings();
      if (signal?.aborted || mode === 'off' || (mode === 'manual' && initialMode !== 'manual')) return;
      return { model, effort, prompt: promptFor(input, mode, selected) };
    }));
    if (reply === undefined || signal?.aborted) return draft;
    const result = draft.slice(0, start) + reply + draft.slice(end);
    return isDeepStrictEqual(protectedLiterals(result), originalLiterals) ? result : draft;
  } catch {
    // Child output and exceptions may include input material. Keep them private.
    return draft;
  }
}
