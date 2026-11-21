import { isMain, readLimited, record, utf8 } from './cli_io.mjs';

// Allow ordinary tabs, line endings and RTL letters. Reject terminal and bidi controls.
export const DISPLAY_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const CREDENTIAL_SIGNATURE = new RegExp([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/.source,
  /sk-(?:proj-|svcacct-)?[\p{L}\p{N}_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}/u.source,
  /github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16,}/.source,
  /AIza[A-Za-z0-9_-]{28,}|xox[baprs]-[\p{L}\p{N}_-]{12,}/u.source,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.source,
  /\b(?:set-cookie|cookie)["']?[ \t]*:[ \t]*["']?[^\s=;]+=[^\s;]+/.source,
  /:\/\/[^/\s:@]+:[^/\s@]+@/.source,
].join('|'), 'iu');

const CREDENTIAL_FIELDS = [
  /\bbearer\s+["'“‘`]*([^\s,;“”‘’'"`]{8,})/giu,
  /\b(?:proxy-)?authorization["']?[ \t]*:[ \t]*["'“‘`]*(?:(?:bearer|basic|token)[ \t]+)?["'“‘`]*([^\s,;“”‘’"'`]+)/giu,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|密钥|密码|令牌)["']?\s*[:=：]\s*["'“‘`]*([^\s,;“”‘’"'`]+)/giu,
];
const PLACEHOLDER = /^(?:\$[A-Za-z_][\w]*|\$\{[A-Za-z_][\w]*\}|<(?:your[-_ ]?)?(?:api[-_ ]?key|key|token|password|secret|(?:你的)?(?:密钥|密码|令牌))>|\[REDACTED\]|YOUR[_-](?:API[_-]KEY|TOKEN|PASSWORD|SECRET)(?:[_-]HERE)?)$/iu;

export const CREDENTIAL = {
  test(text) {
    if (CREDENTIAL_SIGNATURE.test(text)) return true;
    for (const pattern of CREDENTIAL_FIELDS) {
      for (const [, value] of text.matchAll(pattern)) {
        if (!PLACEHOLDER.test(value.replace(/[.。，；！？、]+$/u, ''))) return true;
      }
    }
    return false;
  },
};

const EXACT_ZH = new RegExp([
  /(?:只(?:需|要)?(?:给(?:我)?|输出|返回|提供|回答|写)(?:出)?|仅(?:输出|返回|提供)|直接输出|务必输出)\s*(?:一(?:条|行|个)\s*)?(?:可执行的?)?\s*(?:命令|代码|json|yaml|toml|xml|sql|补丁|diff|原文)/.source,
  /(?:只要|仅需)\s*(?:一(?:条|行|个)\s*)?(?:命令|代码|json|补丁)/.source,
  /(?:原样|逐字|一字不改地?)\s*(?:输出|返回|复述|引用|复制)/.source,
  /(?:固定|严格按(?:照)?|完全按照|严格遵守)(?:指定|以下|下面|这个|此)?格式/.source,
].join('|'), 'iu');

const ENGLISH_DIRECTIVE = /(?:^|[\n,;.!?])\s*(?:(?:please|then|and|can you|could you|you must|you should)\s+)*/.source;
const EXACT_EN = new RegExp(ENGLISH_DIRECTIVE + '(?:' + [
  /\b(?:return|output|reply with|give me|print)\s+exactly\b/.source,
  /\b(?:return|output|reply with|give me|print)\s+only\s+(?:(?:the|a|an|one|single|valid|raw)\s+)*(?:json|yaml|toml|xml|sql|code|commands?|patch|diff)\b/.source,
  /\breturn\s+only\s+(?:the\s+)?(?:polished\s+)?(?:text|reply|answer)\s+as\s+(?:json|yaml|xml|code)\b/.source,
  /\b(?:json|yaml|code|commands?|patch|diff)\s+only\b/.source,
  /\b(?:reproduce|quote|repeat|copy|keep|return|print|output)\s+(?:(?:this|that|it|the|my|following|original|text|quote|passage|answer|response)\s+)*verbatim\b/.source,
].join('|') + ')', 'iu');

const STRUCTURED = /^(?:diff --git |@@ |\*\*\* (?:Begin Patch|End Patch)|--- [ab]\/|[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{3,}:?|#!|<\?xml|<!doctype\s|\{\s*"|(?:async )?def [\p{L}\p{N}_]+\(|class [\p{L}\p{N}_]+[(:]|#include\s*<|from [\p{L}\p{N}_.]+ import |import [\p{L}\p{N}_.]+(?:$|[,;]| as )|(?:const|let|function) [\p{L}\p{N}_$]+[ (=:])/mu;
const COMMANDS = /(?:git|curl|wget|sudo|npm|npx|pnpm|yarn|bun|pip[0-9.]*|python[0-9.]*|pwd|whoami|node|bash|zsh|sh|docker|kubectl|make|cargo|go|brew|env|ls|cd|cat|echo|printf|rm|mv|cp|mkdir|chmod|rg|grep|sed|awk|ssh|scp|codex|agy)/.source;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const NON_PROSE_LINE = /^(?:[ \t]*>| {4,}\S|\t\S|[ \t]*\[[^\]]+\]:|[ \t]*\|.*\||[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$|[ \t]*(?:\$ |PS> )\S)/;
const COMMAND_LINE = new RegExp('^[ \\t]*(?:' + COMMANDS + /(?:[ \t]+[ -~]*)?|(?:\.\/|~\/|\/)[A-Za-z0-9_./-]+[ \t]+[ -~]+/.source + ')$');

class Skip extends Error {}

function validateText(value, emptyReason) {
  if (typeof value !== 'string' || !value.trim()) throw new Skip(emptyReason);
  if (!value.isWellFormed()) throw new Skip('invalid_input');
  if (DISPLAY_CONTROL.test(value)) throw new Skip('display_control');
  if (CREDENTIAL.test(value)) throw new Skip('possible_credential');
}

function isFixedFormat(draft) {
  const trimmed = draft.trim();
  if (/^(?:diff --git |\*\*\* Begin Patch(?:\r?\n|$)|--- [^\r\n]+\r?\n\+\+\+ )/.test(trimmed)) return true;
  if (/^(`{1,2})[^`\r\n]+\1$/.test(trimmed)) return true;
  if (/^[\[{"]/.test(trimmed) || ['true', 'false', 'null'].includes(trimmed)) {
    try { JSON.parse(trimmed); return true; }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }

  let fence = null;
  let hasProse = false;
  for (const line of draft.split(/\r\n|[\r\n\u2028\u2029]/)) {
    const delimiter = FENCE.exec(line)?.[1];
    if (fence) {
      if (delimiter?.[0] === fence[0] && delimiter.length >= fence.length && line.trim() === delimiter) fence = null;
    } else if (delimiter) {
      fence = delimiter;
    } else if (!STRUCTURED.test(line) && !COMMAND_LINE.test(line) && !NON_PROSE_LINE.test(line) && /[\p{L}\p{Nl}\p{No}]/u.test(line)) {
      hasProse = true;
    }
  }
  if (fence) throw new Skip('ambiguous_markup');
  return !hasProse;
}

export function prepare(payload) {
  try {
    if (!record(payload)) throw new Skip('invalid_input');
    const { question, draft } = payload;
    validateText(question, 'invalid_input');
    validateText(draft, 'invalid_input');
    if (EXACT_ZH.test(question) || EXACT_EN.test(question) || isFixedFormat(draft)) throw new Skip('fixed_format');
    return { bypass: false };
  } catch (error) {
    if (!(error instanceof Skip)) throw error;
    return { bypass: true, reason: error.message };
  }
}

if (isMain(import.meta.url)) {
  const [action, ...extra] = process.argv.slice(2);
  if (action === '--help' || action === '-h') console.log('Usage: text_guard.mjs prepare');
  else if (action !== 'prepare' || extra.length) process.exitCode = 2;
  else {
    let payload;
    try { payload = JSON.parse(utf8(await readLimited(process.stdin))); }
    catch { payload = null; }
    console.log(JSON.stringify(prepare(payload)));
  }
}
