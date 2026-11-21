import { isMain, readLimited, utf8 } from './cli_io.mjs';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const VISUAL_START = '\uE200visualize\uE202';
const VISUAL_END = '\uE201';
const VISUAL_LINE = /^( {0,3})(\uE200?visualize\uE202?(\{[^\r\n]*\})\uE201?)[ \t]*$/u;
const VISUAL_TOKEN = /\uE200visualize\uE202([^\uE201\r\n]*)\uE201/gu;
const DISPLAY_LABELS = {
  zh: { polished: 'Gemini 润色版', original: '查看 GPT 原稿', unchanged: 'Gemini 返回了原稿',
    quoted: '查看原文', unchangedQuote: 'Gemini 返回了原文' },
  en: { polished: 'Polished by Gemini', original: 'View original GPT draft', unchanged: 'Gemini returned the original draft',
    quoted: 'View original text', unchangedQuote: 'Gemini returned the original text' },
};

function originalDisclosure(label, draft) {
  // The desktop client converts HTML details to a Markdown container. If the
  // draft documents either delimiter, quote its source inside that container.
  if (/<\/?details\b|<!--|^[\t ]*:::/im.test(draft)) {
    let fenceLength = 3;
    for (const [ticks] of draft.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, ticks.length + 1);
    const fence = '`'.repeat(fenceLength);
    const quoted = draft.replace(VISUAL_TOKEN, (_, data) => '\\uE200visualize\\uE202' + data + '\\uE201')
      .replace(/\r\n|[\r\n]/g, '$&> ');
    return `:::github-details{summary=${JSON.stringify(label)}}\n\n> ${fence}text\n> ${quoted}\n> ${fence}\n\n:::`;
  }
  // Desktop expands live references before it renders the Markdown disclosure.
  // Entities display the original characters as text without instantiating a second chart.
  let original = draft;
  if (draft.includes(VISUAL_START)) {
    const edits = visualizationLines(draft).filter(ref => ref.live).map(ref => ({
      ...ref, replacement: literalVisual(ref.data)
    }));
    original = replaceReferences(draft, edits);
  }
  return `<details><summary>${label}</summary>\n\n${original}\n\n</details>`;
}

// Recover the displayed original from our own comparison format. Encoded
// chart references may also be literal examples, so never unescape those into
// a live widget. A malformed comparison has no trustworthy target.
export function originalReplyText(reply) {
  const skipped = /^\*\*(?:未润色|Polishing skipped)\*\* · [^\r\n]+\n\n/.exec(reply);
  if (skipped) return reply.slice(skipped[0].length);
  for (const labels of Object.values(DISPLAY_LABELS)) {
    for (const heading of [labels.unchanged, labels.unchangedQuote]) {
      const unchanged = `**${heading}**\n\n`;
      if (reply.startsWith(unchanged)) return reply.slice(unchanged.length);
    }
    if (!reply.startsWith(`**${labels.polished}**\n\n`)) continue;

    const html = reply.endsWith('\n\n</details>');
    const index = reply.lastIndexOf(html ? '\n\n<details><summary>' : '\n\n:::github-details{summary=');
    if (index === -1) return null;
    const disclosure = reply.slice(index + 2);
    const prefix = label => html ? `<details><summary>${label}</summary>\n\n` : `:::github-details{summary=${JSON.stringify(label)}}\n\n`;
    const label = [labels.original, labels.quoted].find(label => disclosure.startsWith(prefix(label)));
    if (!label) return null;
    const body = disclosure.slice(prefix(label).length);
    let draft;
    if (html) {
      draft = body.slice(0, -'\n\n</details>'.length);
      if (draft.includes('&#xE200;visualize&#xE202;')) return null;
    } else {
      const match = /^> (`{3,})text\n> /.exec(body);
      if (!match) return null;
      const suffix = `\n> ${match[1]}\n\n:::`;
      if (!body.endsWith(suffix)) return null;
      draft = body.slice(match[0].length, -suffix.length).replace(/(\r\n|[\r\n])> /g, '$1');
      if (draft.includes('\\uE200visualize\\uE202')) return null;
    }
    return originalDisclosure(label, draft) === disclosure ? draft : null;
  }
  return reply;
}

// A Codex visual is a standalone reference. A provider can return its exact
// JSON while dropping the private-use characters that make it render in chat.
function visualizationLines(text) {
  const refs = [];
  let fence;
  for (const line of text.matchAll(/^[^\r\n]+/gm)) {
    const delimiter = FENCE.exec(line[0])?.[1];
    if (fence) {
      if (delimiter?.[0] === fence[0] && delimiter.length >= fence.length && line[0].trim() === delimiter) fence = null;
    } else if (delimiter) {
      fence = delimiter;
    } else {
      const match = VISUAL_LINE.exec(line[0]);
      if (!match) continue;
      const [, indent, token, data] = match;
      let attrs;
      try { attrs = JSON.parse(data); } catch { continue; }
      if (typeof attrs?.path !== 'string' || !attrs.path.startsWith('/')) continue;
      refs.push({ data, token, at: line.index + indent.length, live: token === VISUAL_START + data + VISUAL_END });
    }
  }
  return refs;
}

// Restore unambiguous widget delimiters for the original chart. Other returned
// text is still displayed, even when no original chart can be matched.
function formatVisualizations(draft, candidate) {
  if (!draft.includes(VISUAL_START) && !candidate.includes(VISUAL_START)) return candidate;
  const groups = new Map();
  for (const ref of visualizationLines(draft)) {
    const group = groups.get(ref.data) ?? { live: 0, literal: false, slots: [] };
    if (ref.live) group.live++; else group.literal = true;
    groups.set(ref.data, group);
  }
  const edits = [];
  for (const ref of visualizationLines(candidate)) {
    const group = groups.get(ref.data);
    if (!ref.live) {
      if (group) group.slots.push(ref);
    } else if (group?.live) {
      group.live--;
    } else {
      // A model can write text for a new reference, but only the authoring
      // agent's original references have a corresponding trusted local widget.
      edits.push({ ...ref, replacement: literalVisual(ref.data) });
    }
  }
  for (const [data, group] of groups) {
    if (group.literal || group.slots.length !== group.live) continue;
    for (const ref of group.slots) edits.push({ ...ref, replacement: VISUAL_START + data + VISUAL_END });
  }
  return replaceReferences(candidate, edits.sort((a, b) => a.at - b.at));
}

function literalVisual(data) {
  return '&#xE200;visualize&#xE202;' + data + '&#xE201;';
}

function replaceReferences(text, edits) {
  if (!edits.length) return text;
  let result = '', start = 0;
  for (const edit of edits) {
    result += text.slice(start, edit.at) + edit.replacement;
    start = edit.at + edit.token.length;
  }
  return result + text.slice(start);
}

function comparableProse(text) {
  return text.replace(/\r\n?/g, '\n').trim();
}

export function formatReply({ draft, candidate, display_language, source_label }) {
  if (source_label !== undefined && source_label !== 'quoted') throw new Error('invalid_source_label');
  const text = formatVisualizations(draft, candidate);
  if (display_language === undefined) return { text };
  const labels = DISPLAY_LABELS[display_language];
  const same = comparableProse(text) === comparableProse(draft);
  const quoted = source_label === 'quoted';
  const display_text = same
    ? `**${quoted ? labels.unchangedQuote : labels.unchanged}**\n\n${text}`
    : `**${labels.polished}**\n\n${text}\n\n${originalDisclosure(quoted ? labels.quoted : labels.original, draft)}`;
  return { text, display_text };
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('unexpected arguments');
    const payload = JSON.parse(utf8(await readLimited(process.stdin)));
    if (typeof payload?.draft !== 'string' || typeof payload?.candidate !== 'string' ||
        (payload.display_language !== undefined && !Object.hasOwn(DISPLAY_LABELS, payload.display_language))) {
      throw new Error('invalid input');
    }
    console.log(JSON.stringify(formatReply(payload)));
  } catch { process.exitCode = 2; }
}
