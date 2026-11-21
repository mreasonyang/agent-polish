import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { readPreviousReply } from '../../../hooks/history.mjs';
import { historySource, projectHistoryTurns } from '../../../hooks/preferences.mjs';
import { isMain } from './cli_io.mjs';

export function previousReply(cwd, { noHistory = false, turnsBack = 1 } = {}) {
  const source = historySource(cwd);
  if (!source) return null;
  return readPreviousReply(source.transcript_path, source.session_id, source.turn_id,
    noHistory ? 0 : projectHistoryTurns(cwd), turnsBack);
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      cwd: { type: 'string' }, 'turns-back': { type: 'string', default: '1' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log('Usage: previous_reply.mjs --cwd PROJECT [--turns-back N]');
    else {
      if (!values.cwd || !isAbsolute(values.cwd) || !/^[1-9]\d*$/.test(values['turns-back']) ||
          !Number.isSafeInteger(Number(values['turns-back']))) throw new Error('invalid_arguments');
      const target = previousReply(values.cwd, { noHistory: true, turnsBack: Number(values['turns-back']) });
      if (!target) throw new Error('previous_reply_unavailable');
      console.log(JSON.stringify({ question: target.question, draft: target.draft }));
    }
  } catch (error) {
    console.error(error.message === 'previous_reply_unavailable' ? error.message : 'invalid_arguments');
    process.exitCode = 1;
  }
}
