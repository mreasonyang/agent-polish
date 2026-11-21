// This reducer only interprets bytes already decoded by the caller. The agent owns all writes.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = value => typeof value === 'string' && value.trim().length > 0;

export function parseAcpFrame(raw, { bigintIds = false } = {}) {
  // JSON.parse rounds numbers. Check the source spelling before comparing or echoing a request ID.
  const invalidId = new WeakSet();
  const frame = JSON.parse(raw, function (key, value, context) {
    if (key !== 'id' || typeof value !== 'number') return value;
    const integer = /^-?\d+$/.test(context.source);
    if (bigintIds) return integer ? BigInt(context.source) : null;
    if (!integer || !Number.isSafeInteger(value)) invalidId.add(this);
    return value;
  });
  if (invalidId.has(frame)) throw new Error('acp_protocol_error');

  // JSON.parse overwrites duplicate object fields. Compare decoded keys, including escaped spellings.
  const objects = [];
  for (const match of raw.matchAll(/"[^"\\]*(?:\\.[^"\\]*)*"([ \r\n\t]*:)?|[{}]/g)) {
    const [token, colon] = match;
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (colon) {
      const key = JSON.parse(token.slice(0, -colon.length));
      const fields = objects.at(-1);
      if (fields.has(key)) throw new Error('acp_protocol_error');
      fields.add(key);
    }
  }
  return frame;
}

function rpcFailure(id, error) {
  if (!record(error) || !Number.isSafeInteger(error.code) || typeof error.message !== 'string') return 'acp_protocol_error';
  if (id === 2 || error.code === -32000) return 'acp_auth_failed';
  if (/\b(timeout|timed out|etimedout|deadline[_ ]exceeded)\b/i.test(error.message)) return 'acp_timeout';
  if (id === 4 && error.code === -32602) return 'acp_model_unavailable';
  if (id === 5 && error.code === -32602) return 'acp_thinking_level_unavailable';
  return 'acp_provider_error';
}

// Pass pendingId=6 only when the agent submits its prompt. Each request ID is used once per process.
export function readACP(previous, output, { pendingId = null, sessionId = null } = {}) {
  const state = { tail:'', tailPendingId:null, lastResponseId:null, sessionId:null, text:'', promptEnded:false, reason:null, ...previous };
  const events = [];
  function fail(reason = 'acp_protocol_error') {
    state.text = '';
    state.tail = '';
    state.reason = reason;
    events.push({type:'error', reason});
  }
  if (state.reason) return {state, events};
  if (sessionId !== null) {
    if (!nonblank(sessionId) || (state.sessionId !== null && state.sessionId !== sessionId)) {
      fail();
      return {state, events};
    }
    state.sessionId = sessionId;
  }

  function accept(raw, expected) {
    const frame = parseAcpFrame(raw);
    if (!record(frame) || frame.jsonrpc !== '2.0') return fail();
    const { id, method, params, result } = frame;
    const hasId = Object.hasOwn(frame, 'id');
    const hasResult = Object.hasOwn(frame, 'result');
    const hasError = Object.hasOwn(frame, 'error');
    if (hasId && typeof id !== 'string' && !Number.isSafeInteger(id)) return fail();

    if (Object.hasOwn(frame, 'method')) {
      if (!nonblank(method) || hasResult || hasError ||
          (params !== undefined && !record(params) && !Array.isArray(params))) return fail();
      if (hasId) {
        events.push({type:'request', id, method});
        return;
      }
      if (method !== 'session/update' || state.promptEnded) return;
      if (!nonblank(params?.sessionId)) return fail();
      if (params.sessionId !== state.sessionId) return;
      const update = params.update;
      if (!nonblank(update?.sessionUpdate)) return fail();
      if (update.sessionUpdate === 'config_option_update') {
        events.push({type:'config', sessionId:params.sessionId, raw});
      } else if (update.sessionUpdate === 'agent_message_chunk' && expected === 6 && update.content?.type === 'text') {
        if (typeof update.content.text !== 'string') return fail();
        state.text += update.content.text;
      }
      return;
    }

    if (!hasId || id !== expected || id === state.lastResponseId || hasResult === hasError) return fail();
    state.lastResponseId = id;
    if (id === 6) state.promptEnded = true;
    if (hasError) return fail(rpcFailure(id, frame.error));
    if (!record(result) || (id === 1 && result.protocolVersion !== 1)) return fail();
    if (id === 3) {
      if (!nonblank(result.sessionId)) return fail();
      state.sessionId = result.sessionId;
    }
    if (id === 6) {
      if (['cancelled','refusal','max_tokens','max_turn_requests'].includes(result.stopReason)) return fail('acp_incomplete');
      if (result.stopReason !== 'end_turn' || !state.sessionId) return fail();
      if (!state.text.trim()) return fail('acp_incomplete');
    }
    events.push({type:'response', id, result, raw});
  }

  // A frame that started before the prompt was sent belongs to its original phase, even when
  // its remaining characters arrive alongside the first genuine answer chunk.
  const firstPendingId = state.tail.length ? state.tailPendingId : pendingId;
  const lines = output.split('\n');
  const tail = lines.pop();
  if (!lines.length) {
    state.tail += tail;
    state.tailPendingId = firstPendingId;
    return {state, events};
  }
  lines[0] = state.tail + lines[0];
  state.tail = tail;
  state.tailPendingId = pendingId;
  for (const [index, raw] of lines.entries()) {
    try { accept(raw, index === 0 ? firstPendingId : pendingId); }
    catch { fail(); }
    if (state.reason) break;
  }
  return {state, events};
}
