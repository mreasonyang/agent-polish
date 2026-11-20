import { isDeepStrictEqual, parseArgs } from 'node:util';
import { isMain, readLimited, record, utf8 } from './cli_io.mjs';

export const MAX_TEXT = 128 * 1024;
export const MAX_REQUEST = 8 * MAX_TEXT;
// Allow ordinary tabs, line endings and RTL letters. Reject terminal and bidi controls.
export const DISPLAY_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
export const CREDENTIAL = new RegExp([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/.source,
  /sk-(?:proj-|svcacct-)?[\p{L}\p{N}_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}/u.source,
  /github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16,}/.source,
  /AIza[A-Za-z0-9_-]{28,}|xox[baprs]-[\p{L}\p{N}_-]{12,}/u.source,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.source,
  /\bbearer\s+[^\s,;'"]{8,}/.source,
  /\b(?:proxy-)?authorization["']?[ \t]*:[ \t]*["']?[^\s,;"']+/.source,
  /\b(?:set-cookie|cookie)["']?[ \t]*:[ \t]*["']?[^\s=;]+=[^\s;]+/.source,
  /:\/\/[^/\s:@]+:[^/\s@]+@/.source,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|密钥|密码|令牌)["']?\s*[:=：]\s*["']?[^\s,;“”"']+/.source,
].join('|'), 'iu');

const EXACT = new RegExp([
  /(?:只(?:需|要)?(?:给(?:我)?|输出|返回|提供|回答|写)(?:出)?|仅(?:输出|返回|提供)|直接输出|务必输出)\s*(?:一(?:条|行|个)\s*)?(?:可执行的?)?\s*(?:命令|代码|json|yaml|toml|xml|sql|补丁|diff|原文)/.source,
  /(?:只要|仅需)\s*(?:一(?:条|行|个)\s*)?(?:命令|代码|json|补丁)/.source,
  /(?:原样|逐字|一字不改地?)\s*(?:输出|返回|复述|引用|复制)/.source,
  /(?:固定|严格按(?:照)?|完全按照|严格遵守)(?:指定|以下|下面|这个|此)?格式/.source,
  // A final "return only the polished text" clause requests a rewrite without headings.
  /\b(?:return|output|reply with|give me|print)\s+(?:exactly\b|only\b(?!\s+(?:the\s+)?polished\s+(?:text|reply|answer|version|prose|body)[.!?]?\s*$))/.source,
  /\b(?:json|yaml|code|commands?|patch|diff)\s+only\b|\bverbatim\b/.source,
].join('|'), 'iu');

const STRUCTURED = /^(?:diff --git |@@ |\*\*\* (?:Begin Patch|End Patch)|--- [ab]\/|[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{3,}:?|#!|<\?xml|<!doctype\s|\{\s*"|(?:async )?def [\p{L}\p{N}_]+\(|class [\p{L}\p{N}_]+[(:]|#include\s*<|(?:import|from) [\p{L}\p{N}_.]+(?:\s|$)|(?:const|let|function) [\p{L}\p{N}_$]+[ (=:])/imu;
const COMMANDS = /(?:git|curl|wget|sudo|npm|npx|pnpm|yarn|bun|pip[0-9.]*|python[0-9.]*|pwd|whoami|node|bash|zsh|sh|docker|kubectl|make|cargo|go|brew|env|ls|cd|cat|echo|printf|rm|mv|cp|mkdir|chmod|rg|grep|sed|awk|ssh|scp|codex|agy)/.source;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const NON_PROSE_LINE = /^(?:[ \t]*>| {4,}\S|\t\S|[ \t]*\[[^\]]+\]:|[ \t]*\|.*\||[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$|[ \t]*(?:\$ |PS> )\S)/;
const COMMAND_LINE = new RegExp('^[ \\t]*(?:' + COMMANDS + /(?:[ \t]+[ -~]*)?|(?:\.\/|~\/|\/)[A-Za-z0-9_./-]+[ \t]+[ -~]+/.source + ')$');
const STRUCTURE = /^([ \t]*)(#{1,6}(?=\s)|[-*+](?=\s)|[0-9]+[.)](?=\s)|>|\||`{3,}|~{3,}|\[[^\]]+\]:)/;
const DISPLAY_LABELS = {
  zh: { polished: 'Gemini 润色版', original: '查看 GPT 原稿', unchanged: 'Gemini 已核对，和 GPT 原稿相同' },
  en: { polished: 'Polished by Gemini', original: 'View original GPT draft', unchanged: 'Gemini reviewed the GPT draft and left it unchanged' },
};

class Skip extends Error {}

function originalDisclosure(label, draft) {
  // The desktop client converts HTML details to a Markdown container. If the
  // draft documents either delimiter, quote its source inside that container.
  if (/<\/?details\b|<!--|^[\t ]*:::/im.test(draft)) {
    let fenceLength = 3;
    for (const [ticks] of draft.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, ticks.length + 1);
    const fence = '`'.repeat(fenceLength);
    const quoted = draft.replace(/\r\n|[\r\n]/g, '$&> ');
    return `:::github-details{summary=${JSON.stringify(label)}}\n\n> ${fence}text\n> ${quoted}\n> ${fence}\n\n:::`;
  }
  return `<details><summary>${label}</summary>\n\n${draft}\n\n</details>`;
}

function structure(text) {
  return text.split(/\r\n|[\r\n\u2028\u2029]/).map(line => STRUCTURE.exec(line)?.slice(1)).filter(Boolean);
}

function validateText(value, emptyReason) {
  if (typeof value !== 'string' || !value.trim()) throw new Skip(emptyReason);
  if (!value.isWellFormed()) throw new Skip('invalid_input');
  if (Buffer.byteLength(value) > MAX_TEXT) throw new Skip('size_limit');
  if (DISPLAY_CONTROL.test(value)) throw new Skip('display_control');
  if (CREDENTIAL.test(value)) throw new Skip('possible_credential');
}

function isFixedFormat(draft) {
  const trimmed = draft.trim();
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
    } else if (STRUCTURED.test(line)) {
      return true;
    } else if (!COMMAND_LINE.test(line) && !NON_PROSE_LINE.test(line) && /[\p{L}\p{Nl}\p{No}]/u.test(line)) {
      hasProse = true;
    }
  }
  if (fence) throw new Skip('ambiguous_markup');
  return !hasProse;
}

function comparableProse(text) {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function run(action, payload, rewriteMode = 'normal') {
  try {
    if (!record(payload)) throw new Skip('invalid_input');
    const { question, draft, candidate: text, display_language } = payload;
    validateText(question, 'invalid_input');
    validateText(draft, 'invalid_input');
    if (EXACT.test(question) || isFixedFormat(draft)) throw new Skip('fixed_format');
    if (action === 'prepare') return { bypass: false };
    if (action !== 'review') throw new Skip('invalid_input');
    if (rewriteMode !== 'normal' && rewriteMode !== 'turbo') throw new Skip('invalid_input');
    validateText(text, 'empty_candidate');
    if (!isDeepStrictEqual(structure(text), structure(draft)) || isFixedFormat(text))
      throw new Skip('structure_changed');
    if (rewriteMode === 'turbo' && comparableProse(text) === comparableProse(draft))
      throw new Skip('unchanged_candidate');
    if (display_language === undefined) return { ok: true, text };
    if (display_language !== 'zh' && display_language !== 'en') throw new Skip('invalid_input');
    const labels = DISPLAY_LABELS[display_language];
    const display_text = text === draft
      ? `**${labels.unchanged}**\n\n${draft}`
      : `**${labels.polished}**\n\n${text}\n\n${originalDisclosure(labels.original, draft)}`;
    return { ok: true, text, display_text };
  } catch (error) {
    if (!(error instanceof Skip)) throw error;
    return action === 'prepare' ? { bypass: true, reason: error.message } : { ok: false, reason: error.message };
  }
}

if (isMain(import.meta.url)) {
  const [action, ...extra] = process.argv.slice(2);
  if (action === '--help' || action === '-h') console.log('Usage: text_guard.mjs prepare | review [--rewrite-mode normal|turbo]');
  else if (!['prepare', 'review'].includes(action)) process.exitCode = 2;
  else try {
    const options = action === 'review' ? { 'rewrite-mode': { type: 'string' } } : {};
    const { values } = parseArgs({ args: extra, options });
    let payload;
    try { payload = JSON.parse(utf8(await readLimited(process.stdin, MAX_REQUEST))); }
    catch { payload = null; }
    console.log(JSON.stringify(run(action, payload, values['rewrite-mode'])));
  } catch {
    process.exitCode = 2;
  }
}
