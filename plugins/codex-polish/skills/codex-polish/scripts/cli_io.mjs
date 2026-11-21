import { constants } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(url) {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(url); }
  catch { return false; }
}

export async function readLimited(stream, limit = constants.MAX_LENGTH) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new RangeError('size_limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export function utf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A PTY has no record-preserving EOF. Disable editing/echo before announcing readiness.
// ConPTY can encode the Enter key as CR. Serialized JSON escapes embedded line breaks.
export async function readInputLine(stream, terminal = false, keepOpen = false) {
  const chunks = [];
  for await (const bytes of stream.iterator({ destroyOnReturn: !keepOpen })) {
    let end = bytes.indexOf(10);
    if (terminal && end < 0) end = bytes.indexOf(13);
    if (end < 0) { chunks.push(bytes); continue; }
    if (end !== bytes.length - 1) throw Error('invalid_input');
    chunks.push(bytes.subarray(0, end));
    return Buffer.concat(chunks);
  }
  throw Error('invalid_input');
}

export async function readHostLine(stream = process.stdin) {
  const raw = stream.isTTY && !stream.isRaw;
  if (raw) stream.setRawMode(true);
  try {
    process.stdout.write('input_ready\n');
    return await readInputLine(stream, stream.isTTY, true);
  } finally {
    if (raw) stream.setRawMode(false);
    stream.pause();
    stream.unref?.();
  }
}
