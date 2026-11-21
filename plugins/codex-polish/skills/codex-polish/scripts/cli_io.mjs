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
