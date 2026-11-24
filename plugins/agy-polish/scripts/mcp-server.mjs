import { createInterface } from 'node:readline';
import manifest from '../plugin.json' with { type: 'json' };
import { polishInputSchema, polishReply, validInput } from './polish-reply.mjs';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const tool = {
  name: 'polish_reply',
  description: 'Polish one complete Antigravity draft with the local Codex CLI when the current polishing settings permit it. The response text is the entire final reply, or the original draft unchanged if skipped or unsuccessful.',
  inputSchema: polishInputSchema
};

const active = new Map();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stopping = false;

function write(frame) {
  if (!stopping) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
}

function fail(id, code, message) {
  write({ id, error: { code, message } });
}

async function call(id, input) {
  const controller = new AbortController();
  active.set(id, controller);
  try {
    const text = await polishReply(input, { signal: controller.signal });
    if (!controller.signal.aborted) write({ id, result: { content: [{ type: 'text', text }] } });
  } finally {
    active.delete(id);
  }
}

lines.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    fail(null, -32600, 'Invalid request');
    return;
  }
  const { id, method, params } = request;
  if (id === undefined) {
    if (method === 'notifications/cancelled') active.get(params?.requestId)?.abort();
    return;
  }
  if ((typeof id !== 'string' && typeof id !== 'number') || active.has(id)) {
    fail(null, -32600, 'Invalid request id');
    return;
  }
  switch (method) {
    case 'initialize':
      write({
        id,
        result: {
          protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0],
          capabilities: { tools: {} },
          serverInfo: { name: manifest.name, version: manifest.version }
        }
      });
      break;
    case 'ping':
      write({ id, result: {} });
      break;
    case 'tools/list':
      write({ id, result: { tools: [tool] } });
      break;
    case 'tools/call':
      if (params?.name !== tool.name || !validInput(params.arguments)) {
        fail(id, -32602, 'Invalid polish_reply arguments');
      } else {
        void call(id, params.arguments);
      }
      break;
    default:
      fail(id, -32601, 'Method not found');
  }
});

function stop() {
  if (stopping) return;
  stopping = true;
  for (const controller of active.values()) controller.abort();
  lines.close();
  process.stdin.destroy();
}

lines.on('close', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
