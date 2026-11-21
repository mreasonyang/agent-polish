// Decode the official process's stdout. Only the Codex agent executes the suggested writes.
import { createReadStream, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMain, record, utf8 } from './cli_io.mjs';
import { nextRewriteStep, catalog } from './acp_models.mjs';
import { readACP } from './acp_reader.mjs';
import { openDisplayInput, submittedPrompt } from './acp_workspace.mjs';
import { answerEvent } from './acp_answer.mjs';
import { delivery } from './format_reply.mjs';
import { validateSourceText } from './rewrite_material.mjs';

const workspaceTool = fileURLToPath(new URL('acp_workspace.mjs', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function* framePieces(input) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of input) {
    const text = decoder.decode(chunk, { stream: true });
    // Feed the partial tail now, so the reader knows which request was pending when it began.
    yield* text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  }
  decoder.decode();
}

function displayScope(payloadArgs) {
  const { values } = parseArgs({ args: payloadArgs, strict: false, options: { cwd: { type: 'string' },
    selection: { type: 'boolean' }, 'selection-only': { type: 'boolean' }, 'turns-back': { type: 'string' } } });
  const turnsBack = values['turns-back'] === undefined ? undefined : Number(values['turns-back']);
  if (!values.cwd || !isAbsolute(values.cwd) || (turnsBack !== undefined && (!Number.isSafeInteger(turnsBack) || turnsBack < 1)))
    throw Error('invalid_display_scope');
  return { cwd: values.cwd, selection: Boolean(values.selection || values['selection-only']), turnsBack };
}

async function readDisplay(stream, scope) {
  const parts = [];
  for await (const bytes of stream) {
    const end = bytes.indexOf(10);
    if (end < 0) { parts.push(bytes); continue; }
    if (end !== bytes.length - 1) throw Error('invalid_display_material');
    parts.push(bytes.subarray(0, end));
    const data = JSON.parse(utf8(Buffer.concat(parts)));
    if (!record(data) || Object.keys(data).some(key => key !== 'draft' && key !== 'question'))
      throw Error('invalid_display_material');
    validateSourceText(data.draft);
    if (scope.turnsBack || Object.hasOwn(data, 'question')) validateSourceText(data.question);
    return data;
  }
  throw Error('missing_display_material');
}

export async function observe(input, { auth, model, catalogOnly, log, directory, token, payloadArgs, display, quotedSource, onDrained }, emit) {
  if (catalogOnly ? (display !== undefined || quotedSource) : (!['zh', 'en', 'body-only'].includes(display) || !Array.isArray(payloadArgs)))
    throw Error('invalid_display_scope');
  const scope = catalogOnly ? null : displayScope(payloadArgs);
  const displayInput = scope && new Socket({ fd: openDisplayInput(token), readable: true, writable: false });
  // Start draining before offering submit. The producer finishes this local copy before it writes ACP.
  const material = displayInput && readDisplay(displayInput, scope).catch(() => null);
  const command = args => [process.execPath, workspaceTool, '--write', token, ...args].map(quote).join(' ');
  const host = { workdir: directory, login: false, shell: '/bin/sh' };
  const write = frame => ({ ...host, cmd: command(['frame', JSON.stringify({ jsonrpc: '2.0', ...frame })]) });
  const request = (id, method, params) => ({ event: 'send', exec: write({ id, method, params }) });
  let pending = 1;
  let state = null;
  let sessionId;
  let canClose = false;
  let submitted = false;
  let finished = false;
  let failed = false;
  const finish = () => sessionId && canClose ? write({ id: 7, method: 'session/close', params: { sessionId } }) : undefined;
  function fail(reason, stage = { 1: 'initialize', 2: 'authenticate', 3: 'session/new', 4: 'session/set_config_option',
    6: 'session/prompt', 7: 'session/close' }[pending] ?? 'awaiting_prompt') {
    if (!finished && !failed) emit({ event: 'error', stage, reason });
    failed = true;
  }
  function openSession() {
    pending = 3;
    emit(request(3, 'session/new', { cwd: directory, mcpServers: [] }));
  }
  function select(raw, id, result) {
    if (id === 3 && !sessionId) return fail('acp_protocol_error');
    let options;
    let step;
    try {
      options = catalog(result.configOptions);
      if (!catalogOnly) step = nextRewriteStep(options, model, BigInt(id));
    } catch { return fail('acp_model_unavailable'); }
    if (catalogOnly) {
      if (log) writeFileSync(log, raw + '\n', { flag: 'wx', mode: 0o600 });
      pending = canClose ? 7 : null;
      finished = true;
      return emit({ event: 'catalog', ...options, finish: finish() });
    }
    if (step.next === 'set_model') {
      pending = 4;
      return emit(request(4, 'session/set_config_option', { sessionId, configId: step.config_id, value: step.value }));
    }
    pending = null;
    const producer = command(['prompt', ...payloadArgs, '--submit', '--session-id', sessionId]);
    emit({ event: 'submit', sessionId, model, exec: { ...host, tty: true, yield_time_ms: 250,
      cmd: "stty -icanon -echo -ixon -icrnl min 1 time 0 && printf 'input_ready\\n' && exec " + producer } });
  }
  async function onResponse({ id, raw, result }) {
    if (id === 1) {
      if (result.protocolVersion !== 1) return fail('acp_protocol_error');
      canClose = Boolean(result.agentCapabilities?.sessionCapabilities?.close);
      if (auth === 'existing-session') return openSession();
      if (!result.authMethods?.some(m => m.id === auth)) return fail('acp_auth_failed');
      pending = 2;
      return emit(request(2, 'authenticate', { methodId: auth }));
    }
    if (id === 2) return openSession();
    if (id === 3) {
      sessionId = result.sessionId;
      if (typeof sessionId !== 'string' || !sessionId.trim()) return fail('acp_protocol_error');
    }
    if (id === 3 || id === 4) return select(raw, id, result);
    if (id === 6) {
      let timer;
      try {
        const original = await Promise.race([material, new Promise(resolve => {
          timer = setTimeout(() => resolve(null), 3000).unref();
        })]);
        if (!original) return fail('acp_display_failed', 'delivery');
        const rendered = delivery({ ...original, candidate: state.text,
          display_language: display === 'body-only' ? undefined : display, source_label: quotedSource ? 'quoted' : 'gpt' }, scope);
        const answer = await answerEvent(rendered.display_text ?? rendered.text, directory, { onDrained });
        pending = null;
        finished = true;
        return emit(answer);
      } catch { return fail('acp_display_failed', 'delivery'); }
      finally { clearTimeout(timer); }
    }
    if (id === 7) emit({ event: 'closed' });
  }
  emit(request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} }));
  try {
    for await (const piece of framePieces(input)) {
      if (failed || (finished && !catalogOnly)) continue;
      if (pending === null && sessionId && !finished && !submitted) {
        submitted = submittedPrompt(token) === sessionId;
        if (submitted) pending = 6;
      }
      const decoded = readACP(state, piece, { pendingId: pending, sessionId });
      state = decoded.state;
      for (const e of decoded.events) {
        if (failed) break;
        if (e.type === 'response') await onResponse(e);
        if (e.type === 'error') fail(e.reason);
        if (e.type === 'request') {
          const reply = e.method === 'session/request_permission'
            ? { id: e.id, result: { outcome: { outcome: 'cancelled' } } }
            : { id: e.id, error: { code: -32601, message: 'Method not found' } };
          emit({ event: 'send', exec: write(reply) });
        }
        if (e.type === 'config' && !catalogOnly && sessionId && !finished && (pending === 6 || pending === null)) {
          try {
            if (catalog(JSON.parse(e.raw).params.update.configOptions).current_model !== model) fail('acp_model_unavailable');
          } catch { fail('acp_model_unavailable'); }
        }
      }
    }
    if (!finished) fail('acp_incomplete');
  } catch (error) { fail(error.message === 'acp_incomplete' ? 'acp_incomplete' : 'acp_protocol_error'); }
  finally { displayInput?.destroy(); }
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { auth: { type: 'string' }, model: { type: 'string' },
      catalog: { type: 'boolean' }, 'catalog-log': { type: 'string' }, 'workspace-token': { type: 'string' },
      'payload-args': { type: 'string' }, display: { type: 'string' }, 'quoted-source': { type: 'boolean' } } });
    if (!['existing-session', 'agent-platform', 'gemini-api-key'].includes(values.auth) ||
        Boolean(values.catalog) === Boolean(values.model) || (values['catalog-log'] && !values.catalog)) throw Error();
    // On macOS, a named pipe opened as process.stdin can remain live after its last writer exits.
    const payloadArgs = values['payload-args'] && JSON.parse(values['payload-args']);
    if (!values['workspace-token']) throw Error();
    let shutdown;
    const supervisor = process.env.CODEX_POLISH_SUPERVISOR_PID;
    function endAfterClose(grace = 3000) {
      // A standalone reader follows its caller's input through EOF. Only the
      // prepared host owns a live provider that must be stopped after delivery.
      if (!supervisor) return;
      clearTimeout(shutdown);
      // A blocking FIFO read can keep Node inside process.exit() on macOS.
      // Wake our own supervising shell to close the provider once output is flushed.
      shutdown = setTimeout(() => process.stdout.write('', () => {
        const parent = process.ppid;
        if (parent > 1 && String(parent) === supervisor) {
          try { process.kill(parent, 'SIGUSR1'); return; } catch { /* Host has exited. */ }
        }
        process.kill(process.pid, 'SIGTERM');
      }), grace).unref();
    }
    const emit = message => {
      process.stdout.write(JSON.stringify(message) + '\n', () => {
        if (['delivery', 'catalog', 'error', 'closed'].includes(message.event)) endAfterClose(message.finish ? 3000 : 0);
      });
    };
    await observe(createReadStream(null, { fd: 0 }), { auth: values.auth, model: values.model, catalogOnly: values.catalog,
      token: values['workspace-token'], payloadArgs, display: values.display, quotedSource: values['quoted-source'],
      log: values['catalog-log'], directory: process.cwd(), onDrained: () => endAfterClose(0) }, emit);
  } catch { process.exitCode = 1; }
}
