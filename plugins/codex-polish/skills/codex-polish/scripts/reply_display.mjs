import { createHash } from 'node:crypto';

const DISPLAY_LABELS = {
  zh: { polished: 'Gemini 润色版', credit: 'Gemini 改写', original: '查看 GPT 原稿', unchanged: 'Gemini 返回了原稿',
    quoted: '查看原文', unchangedQuote: 'Gemini 返回了原文', period: '。',
    draftHint: 'Gemini 改写 · 回复「查看原稿」可对照。', quoteHint: 'Gemini 改写 · 回复「查看原文」可对照。' },
  en: { polished: 'Polished by Gemini', credit: 'Rewritten by Gemini', original: 'View original GPT draft', unchanged: 'Gemini returned the original draft',
    quoted: 'View original text', unchangedQuote: 'Gemini returned the original text', period: '.',
    draftHint: 'Rewritten by Gemini. Ask “show the original draft” to compare.', quoteHint: 'Rewritten by Gemini. Ask “show the original text” to compare.' },
};

// Earlier transcripts included this suffix in the status heading.
const STATUS_MARK = ' <!-- codex-polish -->';
const CHART_ENCODING = '<!-- codex-polish:chart-entities -->\n\n';

// Escape the widget delimiters in the fold, and quote literal entities by one
// extra level. This keeps both forms reversible even when they occur together.
function encodeChartText(text) {
  return text.replace(/&(?:amp;)*#xE20[012];|[\uE200-\uE202]/g, token =>
    token.startsWith('&') ? '&amp;' + token.slice(1) : '&#x' + token.charCodeAt(0).toString(16).toUpperCase() + ';');
}

function decodeChartText(text) {
  return text.replace(/&(?:amp;)*#xE20[012];/g, token =>
    token.startsWith('&amp;') ? '&' + token.slice(5) : String.fromCharCode(Number.parseInt(token.slice(3, -1), 16)));
}

function originalDisclosure(label, draft) {
  const encoded = encodeChartText(draft);
  const marker = encoded === draft ? '' : CHART_ENCODING;
  if (/<\/?details\b|<!--|^[\t ]*:::/im.test(draft)) {
    let fenceLength = 3;
    for (const [ticks] of draft.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, ticks.length + 1);
    const fence = '`'.repeat(fenceLength);
    const quoted = encoded.replace(/\r\n|[\r\n]/g, '$&> ');
    return `:::github-details{summary=${JSON.stringify(label)}}\n\n${marker}> ${fence}text\n> ${quoted}\n> ${fence}\n\n:::`;
  }
  return `<details><summary>${label}</summary>\n\n${marker}${encoded}\n\n</details>`;
}

// The TUI hides an unused Markdown link definition. Put it before the body so
// even an unclosed code fence in the rewrite cannot expose the source.
function terminalComparison(visible, draft, hint) {
  const id = createHash('sha256').update(visible).digest('hex').slice(0, 16);
  const title = JSON.stringify(draft).replace(/[\u2028\u2029\uE200-\uE202]/g,
    char => '\\u' + char.charCodeAt(0).toString(16));
  return `[codex-polish-${id}]: # ${title}\n\n${visible}\n\n${hint}`;
}

function readTerminalComparison(reply) {
  const end = reply.indexOf('\n\n');
  const start = /^\[codex-polish-[a-f0-9]{16}\]: # (?=")/.exec(reply);
  if (!start || end < 0) return null;
  let original;
  try { original = JSON.parse(reply.slice(start[0].length, end)); } catch { return null; }
  for (const { draftHint, quoteHint } of Object.values(DISPLAY_LABELS)) {
    for (const hint of [draftHint, quoteHint]) {
      if (!reply.endsWith('\n\n' + hint)) continue;
      const visible = reply.slice(end + 2, -(hint.length + 2));
      if (terminalComparison(visible, original, hint) === reply) return { visible, original };
    }
  }
  return null;
}

function comparison(reply) {
  if (reply.startsWith('[codex-polish-')) {
    const terminal = readTerminalComparison(reply);
    if (terminal) return terminal;
  }
  const html = reply.endsWith('\n\n</details>');
  const end = html ? '\n\n</details>' : '\n\n:::';
  if (!reply.endsWith(end)) return null;
  const split = reply.lastIndexOf(html ? '\n\n<details><summary>' : '\n\n:::github-details{summary=');
  if (split < 0) return null;
  const disclosure = reply.slice(split + 2);
  const prefix = label => html ? `<details><summary>${label}</summary>\n\n` : `:::github-details{summary=${JSON.stringify(label)}}\n\n`;
  for (const labels of Object.values(DISPLAY_LABELS)) {
    let visible = reply.slice(0, split);
    const originals = [labels.original, labels.quoted];
    let label = originals.map(source => labels.credit + ' · ' + source).find(source => disclosure.startsWith(prefix(source)));
    if (!label) {
      const heading = [`**${labels.polished}**\n\n`, `**${labels.polished}**${STATUS_MARK}\n\n`]
        .find(heading => visible.startsWith(heading));
      if (!heading) continue;
      label = originals.find(source => disclosure.startsWith(prefix(source)));
      if (!label) continue;
      visible = visible.slice(heading.length);
    }
    let original = disclosure.slice(prefix(label).length, -end.length);
    const encoded = original.startsWith(CHART_ENCODING);
    if (encoded) original = original.slice(CHART_ENCODING.length);
    if (!html) {
      const fence = /^> (`{3,})text\n> /.exec(original);
      if (!fence || !original.endsWith('\n> ' + fence[1])) return null;
      original = original.slice(fence[0].length, -(3 + fence[1].length)).replace(/(\r\n|[\r\n])> /g, '$1');
    }
    if (encoded) original = decodeChartText(original);
    return { visible, original: originalDisclosure(label, original) === disclosure ? original : null };
  }
  return null;
}

export function readReplyDisplay(reply, { formatted = false, notice } = {}) {
  const stop = reply.indexOf('\n\n');
  if (stop < 0) return null;
  const body = reply.slice(stop + 2);
  if (notice) return { visible: body, original: body };
  if (notice === false) return comparison(reply);
  const heading = reply.slice(0, stop);
  const marked = heading.endsWith(STATUS_MARK);
  if (!formatted && !marked) return comparison(reply);
  const title = marked ? heading.slice(0, -STATUS_MARK.length) : heading;
  const oldStatus = /^\*\*(?:未润色|Polishing skipped)\*\* · [^\r\n]+$/.test(title) ||
    Object.values(DISPLAY_LABELS).some(labels => [labels.unchanged, labels.unchangedQuote].some(label => title === `**${label}**`));
  return oldStatus ? { visible: body, original: body } : comparison(reply);
}

export function originalReplyText(reply) {
  const display = readReplyDisplay(reply);
  return display ? display.original : reply;
}

export function formatReply({ draft, candidate: text, display_language, source_label }, { trigger = 'auto', terminal = false } = {}) {
  if (!['auto', 'explicit'].includes(trigger)) throw new Error('invalid_trigger');
  if (source_label !== undefined && !['gpt', 'quoted'].includes(source_label)) throw new Error('invalid_source_label');
  if (display_language === undefined) return { text };
  const labels = DISPLAY_LABELS[display_language];
  const same = text === draft;
  const quoted = source_label === 'quoted';
  let display_text = text;
  if (!same) {
    const label = labels.credit + ' · ' + (quoted ? labels.quoted : labels.original);
    display_text = terminal ? terminalComparison(text, draft, quoted ? labels.quoteHint : labels.draftHint)
      : text + '\n\n' + originalDisclosure(label, draft);
  } else if (trigger === 'explicit') {
    display_text = (quoted ? labels.unchangedQuote : labels.unchanged) + labels.period + '\n\n' + text;
  }
  return { text, display_text };
}
