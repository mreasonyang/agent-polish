// Read recent visible chat turns from only the hook's own rollout.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { CREDENTIAL, DISPLAY_CONTROL } from '../skills/codex-polish/scripts/text_guard.mjs';
import { DEFAULT_HISTORY_TURNS, MAX_HISTORY_TURNS } from './preferences.mjs';

export const MAX_HISTORY_BYTES = 16 * 1024;
export const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const HOST_TEXT = /^\s*(?:<\/?(?:environment_context|system-reminder|subagent_notification|turn_aborted|user_shell_command|task-notification|user_instructions|skills_instructions|permissions|developer_instructions|instructions|goal_context|ide_context|local-command-[\w-]+|agent_message|skill|t3_code_[\w-]+)(?:[\s>/])|# AGENTS\.md instructions\b|# (?:Context from my IDE setup|Files mentioned by the user):|Subagent completed:)/im;
const ATTACHMENTS = ['images', 'file_ids', 'local_images', 'audio', 'audio_references', 'local_audio'];

function safeText(text) {
  return typeof text === 'string' && text.trim() !== '' && text.length <= MAX_HISTORY_BYTES && text.isWellFormed() &&
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
  constructor(start) {
    this.id = start.turn_id;
    this.events = [];
    this.messages = [];
    this.answer = null;
    const source = start.turn_attribution ?? {};
    this.ordinary = typeof source === 'object' && !Array.isArray(source) &&
      [undefined, null, 'user', 'exec'].includes(source.turn_trigger) &&
      !source.initiating_agent_path && !source.parent_turn_id && (start.root_turn_id ?? this.id) === this.id;
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

  finish(completed) {
    const messages = this.events.length ? this.events : this.messages;
    if (completed.last_agent_message !== this.answer || !safeText(this.answer) || !messages.every(safeText)) return null;
    const user = messages.join('\n\n');
    if (Buffer.byteLength(user) + Buffer.byteLength(this.answer) > MAX_HISTORY_BYTES) return null;
    return { user, assistant: this.answer };
  }
}

function completedExchanges(data, sessionId, turnId, turns) {
  const last = [];
  let active = null;
  for (const line of data.split('\n')) {
    const { type: kind, payload: item } = JSON.parse(line);
    if (typeof kind !== 'string') return [];
    if (!['session_meta', 'event_msg', 'response_item'].includes(kind)) continue;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    if (kind === 'session_meta') {
      if (item.id !== sessionId) return [];
    } else if (kind === 'event_msg' && item.type === 'task_started') {
      active = typeof item.turn_id === 'string' && item.turn_id ? new Turn(item) : null;
    } else if (kind === 'event_msg' && ['turn_aborted', 'thread_rolled_back'].includes(item.type)) {
      active = null;
      if (item.type === 'thread_rolled_back') last.length = 0;
    } else if (kind === 'event_msg' && item.type === 'task_complete') {
      if (active?.ordinary && active.id !== turnId && item.turn_id === active.id && !present(item.error) &&
          (active.events.length || active.messages.length) && item.last_agent_message) {
        last.push(active.finish(item));
        if (last.length > Math.min(turns, MAX_HISTORY_TURNS)) last.shift();
      }
      active = null;
    } else {
      active?.read(kind, item);
    }
  }
  if (!active?.ordinary || (turnId !== null && active.id !== turnId)) return [];
  let budget = MAX_HISTORY_BYTES;
  const result = [];
  for (const exchange of last.reverse()) {
    if (!exchange) continue;
    budget -= Buffer.byteLength(exchange.user) + Buffer.byteLength(exchange.assistant);
    if (budget < 0) break;
    result.push(exchange);
  }
  return result.reverse();
}

function readRange(fd, start, length) {
  const raw = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const n = fs.readSync(fd, raw, count, length - count, start + count);
    if (!n) break;
    count += n;
  }
  return raw.subarray(0, count);
}

export function readHistory(file, sessionId, turnId = null, turns = DEFAULT_HISTORY_TURNS) {
  if (!Number.isInteger(turns) || turns <= 0 || !sessionId || typeof file !== 'string' || !path.isAbsolute(file)) return [];
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile()) return [];
      const head = readRange(fd, 0, Math.min(info.size, MAX_HEADER_BYTES));
      const headerEnd = head.indexOf(10) + 1;
      if (!headerEnd || info.size <= headerEnd) return [];
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const { type, payload } = JSON.parse(decoder.decode(head.subarray(0, headerEnd)));
      if (type !== 'session_meta' || payload?.id !== sessionId || payload.parent_thread_id || payload.forked_from_id) return [];
      const start = Math.max(headerEnd, info.size - MAX_SCAN_BYTES);
      let raw = readRange(fd, start, info.size - start);
      if (raw.length !== info.size - start || raw.at(-1) !== 10) return [];
      // Drop the truncated first line before decoding, since it may start mid-codepoint.
      if (start > headerEnd) raw = raw.subarray(raw.indexOf(10) + 1);
      if (!raw.length) return [];
      return completedExchanges(decoder.decode(raw.subarray(0, -1)), sessionId, turnId, turns);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
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
