// Protect literals before editing a reply, then verify and restore them locally.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMain, readLimited, record, utf8 } from './cli_io.mjs';

export const MAX_TEXT = 128 * 1024;
export const MAX_REQUEST = 8 * MAX_TEXT;
export const PREFIX = '⟦CP:';
export const MARKER = /⟦CP:[0-9a-f]{16}:[QD]:[1-9][0-9]*⟧/g;
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
// Expand case only within ASCII units. Node 22 does not support scoped regexp modifiers.
const asciiUnits = 'GiB|MiB|KiB|GB|MB|KB|milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|hours?|hrs?|Hz|kg|km|px|tokens?'
  .replace(/[a-z]/gi, letter => '[' + letter.toLowerCase() + letter.toUpperCase() + ']');
const UNITS = '(?:' + asciiUnits + ')(?![A-Za-z])|%|‰|％|毫秒|秒钟|秒|分钟|小时|天|周|个月|月|年|元|美元|个|条|项|处|次|份|台|行|列|页|组|步|种|位|人|字节|字|倍|成|万|亿|公里|米';
const CHINESE_DIGITS = '[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二三四五六七八九]+)?';
const WORD_START = /(?<![A-Za-z0-9_./-])/.source;
const FILE = [
  /(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/|\\\\)[^\s`<>\[\]()，。；、：！？]+/.source,
  /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?::\p{Nd}+)?/u.source,
  /(?:[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx|mjs|rs|go|java|c|cpp|h|sh|json|toml|ya?ml|md|txt|csv|log|sql|html|css|png|jpg|svg|pdf)|\.(?:env|gitignore|npmrc))(?::\p{Nd}+)?/u.source,
].join('|');
const INLINE = new RegExp([
  /(?<bracket>!?\[)|(?<ticks>`+)/.source,
  /[^\r\n]*|【[^【】\r\n]+】/.source,
  /“[^“”\r\n]+”|「[^「」\r\n]+」|『[^『』\r\n]+』|"[^"\r\n]+"|(?<![A-Za-z0-9])'[^'\r\n]+'(?![A-Za-z0-9])/.source,
  WORD_START + /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|mailto:|www\.)[^\s<>`\[\]"'，。；、！？]+/.source,
  WORD_START + /(?:[A-Za-z0-9-]+\.)+(?:com|org|net|cn|io|dev|app|edu|gov)(?![A-Za-z0-9-])(?:\/[^\s<>`\[\]，。；、！？]*)?/.source,
  /<\/?[A-Za-z][^<>\r\n]*>/.source,
  WORD_START + COMMANDS + /(?=[ \t]+[-~./A-Za-z0-9'"$])[ \t]+[ -~]+/.source,
  '(?:' + /(?<![\p{L}\p{N}_./-])[A-Za-z][\p{L}\p{N}_.-]*/u.source + '|' + WORD_START + '[A-Za-z][A-Za-z0-9_.-]*)[ \\t]+--?[A-Za-z][ -~]*',
  WORD_START + '(?:' + FILE + ')',
  WORD_START + /--[A-Za-z][A-Za-z0-9_-]*/.source,
  WORD_START + /(?=[A-Za-z._-]*\p{Nd})[A-Za-z][A-Za-z0-9._-]*\p{Nd}[A-Za-z0-9._-]*/u.source,
  /[+−-]?\p{Nd}+(?:[,.:/–-]\p{Nd}+)*/u.source + '(?:[ \\t]*(?:' + UNITS + '))?',
  '第' + CHINESE_DIGITS + '(?:' + UNITS + ')?',
  '(?<![零〇一二两三四五六七八九十百千万亿])' + CHINESE_DIGITS + '(?:' + UNITS + ')',
  '(?<=[剩共为从到约有])' + CHINESE_DIGITS,
].join('|'), 'gu');
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FROZEN_LINE = /^(?:[ \t]*>| {4,}\S|\t\S|[ \t]*\[[^\]]+\]:|[ \t]*\|.*\||[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$|[ \t]*(?:\$ |PS> )\S)/;
const COMMAND_LINE = new RegExp('^[ \\t]*(?:' + COMMANDS + /(?:[ \t]+[ -~]*)?|(?:\.\/|~\/|\/)[A-Za-z0-9_./-]+[ \t]+[ -~]+/.source + ')$');
const STRUCTURE = /^([ \t]*)(#{1,6}(?=\s)|[-*+](?=\s)|[0-9]+[.)](?=\s)|>|\||`{3,}|~{3,}|\[[^\]]+\]:)/;
const DISPLAY_LABELS = {
  zh: { polished: 'Gemini 润色版', original: 'GPT 原稿', unchanged: 'Gemini 已核对，和 GPT 原稿相同' },
  en: { polished: 'Polished by Gemini', original: 'Original GPT draft', unchanged: 'Gemini reviewed the GPT draft and left it unchanged' },
};

class Skip extends Error {}

function balancedEnd(line, start, opener, closer) {
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === opener) depth++;
    else if (line[i] === closer && --depth === 0) return i + 1;
  }
  throw new Skip('ambiguous_markup');
}

function maskInline(line, protect) {
  let pos = 0;
  const pieces = [];
  for (;;) {
    INLINE.lastIndex = pos;
    const match = INLINE.exec(line);
    if (!match) return pieces.join('') + line.slice(pos);
    let end = INLINE.lastIndex;
    if (match.groups.bracket) {
      end = balancedEnd(line, end - 1, '[', ']');
      if (line[end] === '(' || line[end] === '[')
        end = balancedEnd(line, end, line[end], line[end] === '(' ? ')' : ']');
    } else if (match.groups.ticks) {
      const ticks = /`+/g;
      ticks.lastIndex = end;
      let closer;
      do { closer = ticks.exec(line); } while (closer && closer[0].length !== match[0].length);
      if (!closer) throw new Skip('ambiguous_markup');
      end = ticks.lastIndex;
    }
    const literal = line.slice(match.index, end).replace(/[ \t]+$/, '');
    pieces.push(line.slice(pos, match.index), protect(literal));
    pos = match.index + literal.length;
  }
}

function maskText(text, nonce, role) {
  const literals = new Map();
  const protect = value => {
    const marker = PREFIX + nonce + ':' + role + ':' + (literals.size + 1) + '⟧';
    literals.set(marker, value);
    return marker;
  };
  const output = [];
  const lines = text.match(/[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029])|[^\r\n\u2028\u2029]+/g) ?? [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const body = line.replace(/[\r\n]+$/, '');
    const opening = FENCE.exec(body)?.[1];
    if (opening) {
      const closing = new RegExp('^ {0,3}' + opening[0] + '{' + opening.length + ',}[ \\t]*$');
      const start = index;
      while (++index < lines.length && !closing.test(lines[index].replace(/[\r\n]+$/, ''))) {}
      if (index === lines.length) throw new Skip('ambiguous_markup');
      const last = lines[index].replace(/[\r\n]+$/, '');
      output.push(protect(lines.slice(start, index).join('') + last), lines[index].slice(last.length));
    } else {
      const masked = FROZEN_LINE.test(body) || COMMAND_LINE.test(body) ? protect(body) : maskInline(body, protect);
      output.push(masked, line.slice(body.length));
    }
  }
  return [output.join(''), literals];
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

function prepare(payload) {
  if (!record(payload)) throw new Skip('invalid_input');
  const { question, draft } = payload;
  for (const value of [question, draft]) {
    validateText(value, 'invalid_input');
    if (value.includes(PREFIX)) throw new Skip('reserved_marker');
  }
  if (EXACT.test(question) || STRUCTURED.test(draft) || ['true','false','null'].includes(draft.trim()))
    throw new Skip('fixed_format');
  if (/^\s*[\[{]/.test(draft)) {
    try { JSON.parse(draft); throw new Skip('fixed_format'); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  const encoded = JSON.stringify([question, draft]);
  const nonce = createHash('sha256').update(encoded).digest('hex').slice(0, 16);
  const [protectedQuestion] = maskText(question, nonce, 'Q');
  const [protectedDraft, literals] = maskText(draft, nonce, 'D');
  if ([protectedQuestion, protectedDraft].some(value => Buffer.byteLength(value) > MAX_TEXT))
    throw new Skip('size_limit');
  if (!/[\p{L}\p{Nl}\p{No}]/u.test(protectedDraft.replace(MARKER, ''))) throw new Skip('fixed_format');
  return { protectedQuestion, protectedDraft, literals, nonce };
}

export function run(action, payload) {
  try {
    const { protectedQuestion, protectedDraft, literals, nonce } = prepare(payload);
    if (action === 'prepare')
      return { bypass: false, protected_question: protectedQuestion, protected_draft: protectedDraft };
    const { candidate } = payload;
    validateText(candidate, 'empty_candidate');
    if (!isDeepStrictEqual(candidate.match(MARKER) ?? [], [...literals.keys()]) || candidate.replace(MARKER, '').includes(PREFIX))
      throw new Skip('marker_mismatch');
    const text = candidate.replace(MARKER, marker => literals.get(marker));
    if (Buffer.byteLength(text) > MAX_TEXT) throw new Skip('size_limit');
    if (CREDENTIAL.test(text)) throw new Skip('possible_credential');
    const [, actual] = maskText(text, nonce, 'D');
    if (!isDeepStrictEqual([...actual.values()], [...literals.values()])) throw new Skip('literal_changed');
    if (!isDeepStrictEqual(structure(text), structure(payload.draft)) || STRUCTURED.test(text))
      throw new Skip('structure_changed');
    const { draft, display_language } = payload;
    if (display_language === undefined) return { ok: true, text };
    if (display_language !== 'zh' && display_language !== 'en') throw new Skip('invalid_input');
    const labels = DISPLAY_LABELS[display_language];
    const display_text = text === draft
      ? `**${labels.unchanged}**\n\n${draft}`
      : `**${labels.polished}**\n\n${text}\n\n**${labels.original}**\n\n${draft}`;
    return { ok: true, text, display_text };
  } catch (error) {
    if (!(error instanceof Skip)) throw error;
    return action === 'prepare' ? { bypass: true, reason: error.message } : { ok: false, reason: error.message };
  }
}

if (isMain(import.meta.url)) {
  const [action, ...extra] = process.argv.slice(2);
  if (action === '--help' || action === '-h') console.log('Usage: text_guard.mjs prepare|restore');
  else if (!['prepare', 'restore'].includes(action) || extra.length) process.exitCode = 2;
  else {
    let payload;
    try { payload = JSON.parse(utf8(await readLimited(process.stdin, MAX_REQUEST))); }
    catch { payload = null; }
    console.log(JSON.stringify(run(action, payload)));
  }
}
