// Bind a formatted reply to its original exchange without retaining either text.
import { createHash } from 'node:crypto';
import { cacheScope, withCache } from './recovery.mjs';

const retention = 7 * 24 * 60 * 60;
const digest = text => createHash('sha256').update(text).digest('hex');

export function rememberReplyOrigin(cwd, source, text, origin, label, literal) {
  if (origin !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(origin)) origin = null;
  try {
    const scope = cacheScope(cwd);
    const now = Math.floor(Date.now() / 1000);
    withCache('write', db => {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS reply_origin (
          scope TEXT, session TEXT, turn TEXT, digest TEXT, origin TEXT, label TEXT, literal INTEGER,
          updated INTEGER, PRIMARY KEY(scope, session, turn))`);
      const pointer = db.prepare('SELECT turn, path FROM history_source WHERE scope=? AND session=?').get(scope, source.session_id);
      if (pointer?.turn === source.turn_id && pointer.path === source.transcript_path) {
        db.prepare('DELETE FROM reply_origin WHERE updated NOT BETWEEN ? AND ?').run(now - retention, now);
        db.prepare('INSERT OR REPLACE INTO reply_origin VALUES (?,?,?,?,?,?,?,?)')
          .run(scope, source.session_id, source.turn_id, digest(text), origin, label, Number(literal), now);
      }
      db.exec('COMMIT');
    });
  } catch {
    // Formatting and delivery also work without a cache or a trusted hook.
  }
}

export function lookupReplyOrigin(cwd, session, turnIds, text) {
  try {
    const scope = cacheScope(cwd);
    const now = Math.floor(Date.now() / 1000);
    return withCache('read', db => {
      const query = db.prepare(`SELECT digest, origin, label, literal FROM reply_origin
        WHERE scope=? AND session=? AND turn=? AND updated BETWEEN ? AND ?`);
      let found;
      for (const id of turnIds) {
        const row = query.get(scope, session, id, now - retention, now);
        if (!row) continue;
        if (found || row.digest !== digest(text) || !['gpt', 'quoted'].includes(row.label) || ![0, 1].includes(row.literal)) return;
        found = row;
      }
      return found;
    });
  } catch {
    return undefined;
  }
}
