// Read recent visible chat turns from only the hook's own rollout.
import fs from 'node:fs';
import { openRegular } from './platform.mjs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readReplyDisplay } from '../skills/codex-polish/scripts/reply_display.mjs';
import { DEFAULT_HISTORY_TURNS, MAX_HISTORY_TURNS } from './preferences.mjs';
import { lookupReplyOrigin } from './reply_origin.mjs';

const ROLLBACK = Symbol('rollout contains a rollback');

function nonemptyText(text) {
  return typeof text === 'string' && text.trim() !== '' && text.isWellFormed();
}

function userMessageParts(item) {
  const { content_item_kinds: kinds, content_item_metadata: origins } = item.internal_chat_message_metadata_passthrough ?? {};
  if (item.role !== 'user' || !Array.isArray(item.content) || !Array.isArray(kinds) || !Array.isArray(origins)
      || kinds.length !== item.content.length || origins.length !== item.content.length) return [];
  return item.content.filter((part, index) => origins[index]?.provenance?.type === 'user' &&
    typeof kinds[index] === 'string' && kinds[index].startsWith('user.') &&
    (part?.type !== 'input_text' || kinds[index] === 'user.text'));
}

function textParts(parts, kind) {
  return parts.filter(part => part?.type === kind && typeof part.text === 'string').map(part => part.text).join('');
}

function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

class Turn {
  constructor(start, interrupted) {
    this.id = start.turn_id;
    this.events = [];
    this.messages = [];
    this.answer = null;
    this.previousInput = [];
    this.turnIds = new Set([this.id]);
    const source = start.turn_attribution ?? {};
    this.ordinary = typeof source === 'object' && !Array.isArray(source) &&
      [undefined, null, 'user', 'exec', 'composer', 'resume_interrupted_task'].includes(source.turn_trigger) &&
      !source.initiating_agent_path && !source.parent_turn_id && (start.root_turn_id ?? this.id) === this.id &&
      (source.root_turn_id ?? this.id) === this.id && (source.turn_id ?? this.id) === this.id;
    if (this.ordinary && source.turn_trigger === 'resume_interrupted_task' && interrupted?.ordinary) {
      this.previousInput = interrupted.userInput();
      this.turnIds = new Set([...interrupted.turnIds, this.id]);
    }
  }

  read(kind, item) {
    if (kind === 'event_msg') {
      if (item.type === 'user_message') {
        this.events.push(item.message);
      } else if (item.type === 'agent_message' && item.phase === 'final_answer') {
        this.answer = item.message;
      }
      return;
    }
    if (kind !== 'response_item' || item.type !== 'message') return;
    const metadata = item.internal_chat_message_metadata_passthrough ?? {};
    if (Object.hasOwn(metadata, 'turn_id') && metadata.turn_id !== this.id) return;
    if (item.role === 'assistant' && item.phase === 'final_answer') {
      if ((item.status == null || item.status === 'completed') && Array.isArray(item.content))
        this.answer = textParts(item.content, 'output_text');
    } else {
      const parts = userMessageParts(item);
      if (parts.length) this.messages.push(textParts(parts, 'input_text'));
    }
  }

  userInput() {
    return this.previousInput.concat(this.events.length ? this.events : this.messages);
  }

  finish(completed) {
    const messages = this.userInput().filter(nonemptyText);
    if (completed.last_agent_message !== this.answer || !nonemptyText(this.answer) || !messages.length) return null;
    return { user: messages.join('\n\n'), assistant: this.answer };
  }
}

// Snapshot the size at open and stream complete JSONL records. Only the current
// turn and the configured number of completed exchanges stay in memory.
function* records(fd, size) {
  const chunkSize = 64 * 1024;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = [];
  for (let pos = 0; pos < size;) {
    const chunk = Buffer.allocUnsafe(Math.min(chunkSize, size - pos));
    const count = fs.readSync(fd, chunk, 0, chunk.length, pos);
    if (!count) throw new Error('truncated transcript');
    pos += count;
    const raw = chunk.subarray(0, count);
    let start = 0;
    for (let newline = raw.indexOf(10); newline !== -1; newline = raw.indexOf(10, start)) {
      const part = raw.subarray(start, newline);
      const line = pending.length ? Buffer.concat([...pending, part]) : part;
      pending = [];
      yield JSON.parse(decoder.decode(line));
      start = newline + 1;
    }
    if (start < raw.length) pending.push(raw.subarray(start));
  }
  if (pending.length) throw new Error('incomplete transcript');
}

// Forking prepends the new thread's header to the copied rollout, including
// every ancestor's header. Only the outermost header identifies this file.
function* userRollout(rows) {
  const ids = new Set();
  let expectedParent, sawBody = false;
  for (const row of rows) {
    if (row.type !== 'session_meta') {
      if (!ids.size) throw new Error('missing rollout header');
      sawBody = true;
      yield row;
      continue;
    }
    const { id, forked_from_id: parent, source, thread_source: threadSource } = row.payload;
    if (sawBody || typeof id !== 'string' || !id || ids.has(id) || (ids.size && id !== expectedParent) ||
        source?.subagent || (threadSource != null && threadSource !== 'user')) throw new Error('invalid rollout header');
    ids.add(id);
    if (parent != null && (typeof parent !== 'string' || !parent || ids.has(parent))) throw new Error('invalid fork parent');
    expectedParent = parent;
    if (ids.size === 1) yield row;
  }
}

function completedExchanges(rows, sessionId, turnId, limit, { previous = false, through = Infinity, originTurn } = {}) {
  const last = [];
  let count = 0;
  let originWindow;
  let active = null;
  let interrupted = null;
  for (const { type: kind, payload: item } of rows) {
    if (typeof kind !== 'string') return null;
    if (!['session_meta', 'event_msg', 'response_item'].includes(kind)) continue;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (kind === 'session_meta') {
      if (item.id !== sessionId) return null;
    } else if (kind === 'event_msg' && item.type === 'task_started') {
      active = typeof item.turn_id === 'string' && item.turn_id ? new Turn(item, interrupted) : null;
      interrupted = null;
    } else if (kind === 'event_msg' && item.type === 'turn_aborted') {
      interrupted = item.reason === 'interrupted' && active?.id === item.turn_id ? active : null;
      active = null;
    } else if (kind === 'event_msg' && item.type === 'thread_rolled_back') {
      throw ROLLBACK;
    } else if (kind === 'event_msg' && item.type === 'task_complete') {
      if (active?.ordinary && !active.turnIds.has(turnId) && item.turn_id === active.id &&
          (item.last_agent_message || (previous && active.answer != null)) &&
          (previous || (!present(item.error) && active.userInput().length))) {
        count++;
        if (limit && count <= through) {
          const exchange = present(item.error) ? null : active.finish(item);
          last.push(exchange ? { exchange, turnIds: active.turnIds, ordinal: count } : null);
          if (last.length > limit) last.shift();
          if (originTurn && active.turnIds.has(originTurn)) {
            if (originWindow) return null;
            originWindow = last.slice();
          }
        }
      }
      active = interrupted = null;
    } else if (limit || previous) {
      active?.read(kind, item);
    }
  }
  if (!active?.ordinary || (turnId !== null && !active.turnIds.has(turnId))) return null;
  return { last: originTurn ? originWindow ?? [] : last, count };
}

function withTranscript(file, read) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  try {
    const fd = openRegular(file);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile()) return null;
      const rows = () => userRollout(records(fd, info.size));
      try {
        return read(rows);
      } catch (error) {
        if (error !== ROLLBACK) throw error;
        const removed = rollbackRanges(rows());
        return read(() => remainingRows(rows(), removed));
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Index positions, never message bodies. Replaying only surviving turns also
// restores turns that had already fallen outside the configured history window.
function rollbackRanges(rows) {
  const starts = [], removed = [];
  let at = 0;
  for (const { type, payload } of rows) {
    at++;
    if (type === 'event_msg' && payload.type === 'task_started') {
      // The host counts every explicitly opened turn, even when it has no
      // user input, is interrupted, or resumes an earlier exchange.
      starts.push(at);
    } else if (type === 'event_msg' && payload.type === 'thread_rolled_back') {
      if (!Number.isSafeInteger(payload.num_turns) || payload.num_turns < 0) throw new Error('invalid rollback count');
      if (!payload.num_turns || !starts.length) continue;
      const keep = Math.max(0, starts.length - payload.num_turns);
      const first = starts[keep];
      starts.length = keep;
      while (removed.length && removed.at(-1).first >= first) removed.pop();
      removed.push({ first, end: at });
    }
  }
  return removed;
}

function* remainingRows(rows, ranges) {
  let at = 0, cursor = 0;
  for (const row of rows) {
    at++;
    if (cursor < ranges.length && at >= ranges[cursor].end) cursor++;
    if (row.type === 'event_msg' && row.payload?.type === 'thread_rolled_back') continue;
    if (cursor >= ranges.length || at < ranges[cursor].first) yield row;
  }
}

export function readHistory(file, sessionId, turnId = null, turns = DEFAULT_HISTORY_TURNS, { lookupOrigin } = {}) {
  if (!Number.isInteger(turns) || turns <= 0 || !sessionId) return [];
  const exchanges = withTranscript(file, rows =>
    completedExchanges(rows(), sessionId, turnId, Math.min(turns, MAX_HISTORY_TURNS)));
  return exchanges?.last.filter(Boolean).map(item => visibleExchange(item, lookupOrigin)) ?? [];
}

function replyBodies({ exchange, turnIds }, lookupOrigin) {
  const reply = exchange.assistant;
  const receipt = lookupOrigin?.(turnIds, reply);
  const display = receipt?.literal ? null : readReplyDisplay(reply);
  return { receipt, visible: display?.visible ?? reply, draft: receipt?.literal ? reply : display?.original };
}

function visibleExchange({ exchange, turnIds }, lookupOrigin) {
  const display = readReplyDisplay(exchange.assistant);
  if (!display || lookupOrigin?.(turnIds, exchange.assistant)?.literal) return exchange;
  return { user: exchange.user, assistant: display.visible };
}

export function isCurrentTurn(file, sessionId, turnId) {
  return Boolean(turnId && withTranscript(file, rows => completedExchanges(rows(), sessionId, turnId, 0)));
}

export function readPreviousReply(file, sessionId, turnId, turns = DEFAULT_HISTORY_TURNS, turnsBack = 1, { lookupOrigin, requireGpt = false } = {}) {
  if (!turnId || !sessionId || !Number.isSafeInteger(turnsBack) || turnsBack < 1 ||
      !Number.isInteger(turns) || turns < 0 || turns > MAX_HISTORY_TURNS) return null;
  return withTranscript(file, rows => {
    let through = Infinity;
    if (turnsBack > 1) {
      // Find the selected ordinal without retaining every intervening answer.
      const scan = completedExchanges(rows(), sessionId, turnId, 0, { previous: true });
      if (!scan || scan.count < turnsBack) return null;
      through = scan.count - turnsBack + 1;
    }
    const options = { previous: true, through };
    const scan = completedExchanges(rows(), sessionId, turnId, turns + 1, options);
    const target = scan?.last.at(-1);
    if (!target) return null;
    let bodies = replyBodies(target, lookupOrigin);
    const visibleSelection = requireGpt ? null : { selection: bodies.visible };
    // A body-only selection and a whole answer can be byte-identical. Only a
    // matching delivery record can attach the original question and its history.
    const origin = bodies.receipt?.origin;
    if (!origin) return visibleSelection;
    const context = target.turnIds.has(origin) ? scan.last
      : completedExchanges(rows(), sessionId, turnId, turns + 1, { ...options, originTurn: origin })?.last;
    const original = context?.pop();
    if (!original) return visibleSelection;
    let selected = target;
    if (requireGpt && bodies.receipt.label !== 'gpt') {
      // A body-only Gemini output may still refer to a separately visible
      // original. Verify that exchange's own delivered text and provenance.
      if (target.turnIds.has(origin)) return null;
      selected = original;
      bodies = replyBodies(original, lookupOrigin);
      if (bodies.receipt?.origin !== origin || bodies.receipt.label !== 'gpt') return null;
    }
    const draft = bodies.draft;
    if (!nonemptyText(draft)) return visibleSelection;
    return { question: original.exchange.user, draft, history: context.filter(Boolean).map(item => visibleExchange(item, lookupOrigin)),
      source_label: bodies.receipt.label, origin_turn_id: origin,
      ...(requireGpt ? { turns_back: scan.count - selected.ordinal + 1 } : {}) };
  });
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    const { values } = parseArgs({ options: {
      transcript: { type: 'string' }, 'session-id': { type: 'string' }, 'turn-id': { type: 'string' },
      turns: { type: 'string', default: String(DEFAULT_HISTORY_TURNS) }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log('Usage: history.mjs --transcript FILE --session-id ID [--turn-id ID] [--turns 0–10]');
    else {
      if (!values.transcript || !values['session-id']) throw new Error('--transcript and --session-id are required');
      if (!/^[+]?[0-9]+$/.test(values.turns) || Number(values.turns) > MAX_HISTORY_TURNS) throw new Error(`--turns must be between 0 and ${MAX_HISTORY_TURNS}`);
      console.log(JSON.stringify(readHistory(values.transcript, values['session-id'], values['turn-id'], Number(values.turns), {
        lookupOrigin: lookupReplyOrigin.bind(null, process.cwd(), values['session-id']),
      })));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
