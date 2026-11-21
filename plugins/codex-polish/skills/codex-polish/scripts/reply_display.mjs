const DISPLAY_LABELS = {
  zh: { polished: 'Gemini 润色版', original: '查看 GPT 原稿', unchanged: 'Gemini 返回了原稿',
    quoted: '查看原文', unchangedQuote: 'Gemini 返回了原文' },
  en: { polished: 'Polished by Gemini', original: 'View original GPT draft', unchanged: 'Gemini returned the original draft',
    quoted: 'View original text', unchangedQuote: 'Gemini returned the original text' },
};

// A single-body status has no disclosure to distinguish it from an author's heading.
export const STATUS_MARK = ' <!-- codex-polish -->';
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

// Only a complete comparison identifies its foreground and folded sections.
// A heading alone can be part of the user's text.
export function readReplyDisplay(reply) {
  const stop = reply.indexOf('\n\n');
  if (stop < 0) return null;
  const heading = reply.slice(0, stop);
  const marked = heading.endsWith(STATUS_MARK);
  const title = marked ? heading.slice(0, -STATUS_MARK.length) : heading;
  const body = reply.slice(stop + 2);
  if (marked && /^\*\*(?:未润色|Polishing skipped)\*\* · [^\r\n]+$/.test(title))
    return { visible: body, original: body };
  for (const labels of Object.values(DISPLAY_LABELS)) {
    if (marked && [labels.unchanged, labels.unchangedQuote].some(label => title === `**${label}**`))
      return { visible: body, original: body };
    if (title !== `**${labels.polished}**`) continue;
    const html = body.endsWith('\n\n</details>');
    const end = html ? '\n\n</details>' : '\n\n:::';
    if (!body.endsWith(end)) return null;
    const split = body.lastIndexOf(html ? '\n\n<details><summary>' : '\n\n:::github-details{summary=');
    if (split < 0) return null;
    const visible = body.slice(0, split);
    const disclosure = body.slice(split + 2);
    const prefix = label => html ? `<details><summary>${label}</summary>\n\n` : `:::github-details{summary=${JSON.stringify(label)}}\n\n`;
    const label = [labels.original, labels.quoted].find(label => disclosure.startsWith(prefix(label)));
    if (!label) return null;
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

export function originalReplyText(reply) {
  const display = readReplyDisplay(reply);
  return display ? display.original : reply;
}

export function formatReply({ draft, candidate: text, display_language, source_label }) {
  if (source_label !== undefined && !['gpt', 'quoted'].includes(source_label)) throw new Error('invalid_source_label');
  if (display_language === undefined) return { text };
  const labels = DISPLAY_LABELS[display_language];
  const same = text === draft;
  const quoted = source_label === 'quoted';
  const display_text = same
    ? `**${quoted ? labels.unchangedQuote : labels.unchanged}**${STATUS_MARK}\n\n${text}`
    : `**${labels.polished}**\n\n${text}\n\n${originalDisclosure(quoted ? labels.quoted : labels.original, draft)}`;
  return { text, display_text };
}
