// Read recent visible chat turns from only the hook's own rollout.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { originalReplyText } from '../skills/codex-polish/scripts/format_reply.mjs';
import { CREDENTIAL, DISPLAY_CONTROL } from '../skills/codex-polish/scripts/text_guard.mjs';
import { DEFAULT_HISTORY_TURNS, MAX_HISTORY_TURNS } from './preferences.mjs';

const HOST_TEXT = /^\s*(?:<\/?(?:environment_context|system-reminder|subagent_notification|turn_aborted|user_shell_command|task-notification|user_instructions|skills_instructions|permissions|developer_instructions|instructions|goal_context|ide_context|local-command-[\w-]+|agent_message|skill|t3_code_[\w-]+)(?:[\s>/])|# AGENTS\.md instructions\b|# (?:Context from my IDE setup|Files mentioned by the user):|Subagent completed:)/im;
const ATTACHMENTS = ['images', 'file_ids', 'local_images', 'audio', 'audio_references', 'local_audio'];

function safeText(text) {
  return typeof text === 'string' && text.trim() !== '' && text.isWellFormed() &&
    !CREDENTIAL.test(text) && !DISPLAY_CONTROL.test(text) && !HOST_TEXT.test(text);
}

function textMessage(parts, kind) {
  if (!Array.isArray(parts) || !parts.length || !parts.every(p => p?.type === kind && typeof p.text === 'string')) return null;
  return parts.map(p => p.text).join('');
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
        this.events.push(ATTACHMENTS.some(key => present(item[key])) ? null : item.message);
      } else if (item.type === 'agent_message' && item.phase === 'final_answer') {
        this.answer = present(item.moderation) ? null : item.message;
      }
      return;
    }
    if (kind !== 'response_item' || item.type !== 'message') return;
    const metadata = item.internal_chat_message_metadata_passthrough ?? {};
    if (Object.hasOwn(metadata, 'turn_id') && metadata.turn_id !== this.id) return;
    if (item.role === 'assistant' && item.phase === 'final_answer') {
      if (item.status == null || item.status === 'completed') this.answer = textMessage(item.content, 'output_text');
    } else if (item.role === 'user' && Array.isArray(item.content) && item.content.length) {
      // A "user" role is also used for skills, tool notices, and host context.
      const kinds = metadata.content_item_kinds, origins = metadata.content_item_metadata;
      if (Array.isArray(kinds) && kinds.length === item.content.length && kinds.every(k => k === 'user.text') &&
          Array.isArray(origins) && origins.length === item.content.length &&
          origins.every(origin => isDeepStrictEqual(origin, { provenance: { type: 'user' } }))) {
        this.messages.push(textMessage(item.content, 'input_text'));
      }
    }
  }

  userInput() {
    return this.previousInput.concat(this.events.length ? this.events : this.messages);
  }

  finish(completed) {
    const messages = this.userInput();
    if (completed.last_agent_message !== this.answer || !safeText(this.answer) || !messages.length || !messages.every(safeText)) return null;
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

function completedExchanges(rows, sessionId, turnId, limit, { previous = false, through = Infinity } = {}) {
  const last = [];
  let count = 0;
  let header = false;
  let active = null;
  let interrupted = null;
  for (const { type: kind, payload: item } of rows) {
    if (typeof kind !== 'string' || (!header && kind !== 'session_meta')) return null;
    if (!['session_meta', 'event_msg', 'response_item'].includes(kind)) continue;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (kind === 'session_meta') {
      if (header || item.id !== sessionId || item.parent_thread_id || item.forked_from_id ||
          item.source?.subagent || (item.thread_source != null && item.thread_source !== 'user')) return null;
      header = true;
    } else if (kind === 'event_msg' && item.type === 'task_started') {
      active = typeof item.turn_id === 'string' && item.turn_id ? new Turn(item, interrupted) : null;
      interrupted = null;
    } else if (kind === 'event_msg' && item.type === 'turn_aborted') {
      interrupted = item.reason === 'interrupted' && active?.id === item.turn_id ? active : null;
      active = null;
    } else if (kind === 'event_msg' && item.type === 'thread_rolled_back') {
      interrupted = active = null;
      count = 0;
      last.length = 0;
    } else if (kind === 'event_msg' && item.type === 'task_complete') {
      if (active?.ordinary && !active.turnIds.has(turnId) && item.turn_id === active.id &&
          (item.last_agent_message || (previous && active.answer != null)) &&
          (previous || (!present(item.error) && active.userInput().length))) {
        count++;
        if (limit && count <= through) {
          last.push(present(item.error) ? null : active.finish(item));
          if (last.length > limit) last.shift();
        }
      }
      active = interrupted = null;
    } else {
      active?.read(kind, item);
    }
  }
  if (!active?.ordinary || (turnId !== null && !active.turnIds.has(turnId))) return null;
  return { last, count };
}

function withTranscript(file, read) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile()) return null;
      return read(() => records(fd, info.size));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function readHistory(file, sessionId, turnId = null, turns = DEFAULT_HISTORY_TURNS) {
  if (!Number.isInteger(turns) || turns <= 0 || !sessionId) return [];
  const exchanges = withTranscript(file, rows =>
    completedExchanges(rows(), sessionId, turnId, Math.min(turns, MAX_HISTORY_TURNS)));
  return exchanges?.last.filter(Boolean) ?? [];
}

export function readPreviousReply(file, sessionId, turnId, turns = DEFAULT_HISTORY_TURNS, turnsBack = 1) {
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
    const scan = completedExchanges(rows(), sessionId, turnId, turns + 1, { previous: true, through });
    const target = scan?.last.pop();
    if (!target) return null;
    const draft = originalReplyText(target.assistant);
    if (!safeText(draft)) return null;
    return { question: target.user, draft, history: scan.last.filter(Boolean) };
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
      console.log(JSON.stringify(readHistory(values.transcript, values['session-id'], values['turn-id'], Number(values.turns))));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
