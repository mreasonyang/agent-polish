import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const sources = ['authorized_real', 'synthetic'];
const splits = ['calibration', 'blind'];
const outcomes = ['original', 'adopted', 'fallback', 'cancelled'];

export function validate(row) {
  if (!row || typeof row.case_id !== 'string' || !row.case_id.trim()) {
    throw new Error('case_id must be a non-empty string');
  }
  for (const [key, choices] of [['source', sources], ['split', splits], ['outcome', outcomes]]) {
    if (!choices.includes(row[key])) throw new Error(`${key} must be one of ${choices.join(', ')}`);
  }
  for (const key of ['needs_rewrite', 'workflow_expected', 'workflow_ran', 'triggered']) {
    if (typeof row[key] !== 'boolean') throw new Error(`${key} must be true or false`);
  }
  const { outcome, triggered, workflow_ran: ran } = row;
  if (triggered && !ran) throw new Error('triggered requires workflow_ran');
  if ((outcome === 'adopted' && !triggered) || (outcome === 'original' && triggered)) {
    throw new Error('outcome conflicts with triggered');
  }
  if (outcome === 'fallback' && !ran) throw new Error('fallback requires workflow_ran');
  if (outcome === 'cancelled') {
    if (['selected_text', 'final_text', 'elapsed_ms', 'severe_fact_reversal'].some(key => row[key] != null)) {
      throw new Error('a cancelled turn must have no displayed reply or display measurements');
    }
  } else {
    for (const key of ['selected_text', 'final_text']) {
      if (typeof row[key] !== 'string' || !row[key]) throw new Error(`${key} is required for a displayed reply`);
    }
    if (row.elapsed_ms != null && (!Number.isFinite(row.elapsed_ms) || row.elapsed_ms < 0)) {
      throw new Error('elapsed_ms must be a finite non-negative number or null');
    }
    if (row.severe_fact_reversal != null && typeof row.severe_fact_reversal !== 'boolean') {
      throw new Error('severe_fact_reversal must be true, false or null');
    }
  }
  for (const key of ['vs_original', 'vs_prompt_only']) {
    const vote = row[key];
    if (vote == null) continue;
    if (row.split !== 'blind' || outcome === 'cancelled' || (key === 'vs_original' && outcome !== 'adopted')) {
      throw new Error(`${key} vote is inapplicable to this row`);
    }
    if (!['A', 'B'].includes(vote.plugin_side) || !['A', 'B', 'tie'].includes(vote.pick)) {
      throw new Error(`${key} needs plugin_side A/B and pick A/B/tie`);
    }
  }
}

export async function loadRows(path) {
  const rows = [];
  const ids = new Set();
  const stream = createReadStream(path);
  const decoded = Readable.toWeb(stream).pipeThrough(new TextDecoderStream('utf-8', { fatal: true, ignoreBOM: true }));
  const lines = createInterface({ input: Readable.fromWeb(decoded), crlfDelay: Infinity });
  let number = 0;
  try {
    for await (const line of lines) {
      number++;
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        validate(row);
        if (ids.has(row.case_id)) throw new Error('duplicate case_id across records or splits');
        ids.add(row.case_id);
        rows.push(row);
      } catch (error) {
        throw new Error(`${path}:${number}: ${error.message}`);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return rows;
}

function tally(rows, selected) {
  const count = rows.filter(selected).length;
  return { count, total: rows.length, rate: rows.length ? count / rows.length : null };
}

function preference(rows, key) {
  const votes = rows.map(row => row[key]).filter(vote => vote != null);
  return {
    ...tally(votes, vote => vote.pick === vote.plugin_side),
    ties: votes.filter(vote => vote.pick === 'tie').length,
    eligible: rows.length,
  };
}

function latency(rows) {
  const times = rows.map(row => row.elapsed_ms).filter(value => value != null).sort((a, b) => a - b);
  const percentile = fraction => times[Math.ceil(times.length * fraction) - 1] ?? null;
  return { measured: times.length, eligible: rows.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95) };
}

function assessment(source, metrics) {
  if (source === 'synthetic') return 'demo_only';
  if (metrics.severe_fact_reversal.count) return 'blocked_severe_fact_reversal';
  const { displayed, calibration_displayed, false_trigger, hit, adopted_preferred_to_original: original,
    preferred_to_prompt_only: baseline, severe_fact_reversal: reversals, latency: timing } = metrics;
  if (displayed + calibration_displayed < 200 || !calibration_displayed || !false_trigger.total ||
      !hit.total || !original.total || original.total !== original.eligible || baseline.total !== baseline.eligible ||
      reversals.total !== displayed || timing.measured !== displayed) return 'insufficient_evidence';
  if (false_trigger.rate > 0.05 || hit.rate < 0.7 || original.rate < 0.7) return 'thresholds_not_met';
  return 'statistical_targets_met';
}

export function summarize(rows, source) {
  const records = rows.filter(row => row.source === source);
  const blind = records.filter(row => row.split === 'blind');
  const completed = blind.filter(row => row.outcome !== 'cancelled');
  const expected = completed.filter(row => row.workflow_expected);
  const judged = completed.filter(row => row.severe_fact_reversal != null);
  const adopted = completed.filter(row => row.outcome === 'adopted');
  const displayedVerbatim = row => row.selected_text === row.final_text;
  const metrics = {
    calibration_cases: records.length - blind.length,
    calibration_displayed: records.filter(row => row.split === 'calibration' && row.outcome !== 'cancelled').length,
    blind_cases: blind.length,
    displayed: completed.length,
    cancelled: blind.length - completed.length,
    false_trigger: tally(expected.filter(row => !row.needs_rewrite), row => row.triggered),
    hit: tally(expected.filter(row => row.needs_rewrite), row => row.triggered),
    adopted_preferred_to_original: preference(adopted, 'vs_original'),
    preferred_to_prompt_only: preference(completed, 'vs_prompt_only'),
    severe_fact_reversal: { ...tally(judged, row => row.severe_fact_reversal), eligible: completed.length },
    missed_workflow: tally(expected, row => !row.workflow_ran),
    verbatim_display: tally(completed, displayedVerbatim),
    adopted_verbatim_display: tally(adopted, displayedVerbatim),
    fallback: tally(completed.filter(row => row.workflow_ran), row => row.outcome === 'fallback'),
    latency: latency(completed),
  };
  return { statistical_assessment: assessment(source, metrics), ...metrics };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node evaluation/report.mjs <observations.jsonl>');
  } else {
    try {
      if (process.argv.length !== 3) throw new Error('Usage: node evaluation/report.mjs <observations.jsonl>');
      const rows = await loadRows(process.argv[2]);
      console.log(JSON.stringify(Object.fromEntries(sources.map(source => [source, summarize(rows, source)])), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
    }
  }
}
