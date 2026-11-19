import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, summarize, loadRows } from '../evaluation/report.mjs';

const source = 'authorized_real';
const example = new URL('../evaluation/example.jsonl', import.meta.url);
const status = rows => summarize(rows, source).statistical_assessment;
const ratio = (count, total) => ({ count, total, rate: count / total });
const cancelled = { outcome: 'cancelled', selected_text: null, final_text: null, elapsed_ms: null, severe_fact_reversal: null };

function batch() {
  return Array.from({ length: 200 }, (_, i) => {
    const j = i - 100;
    const adopted = j >= 60 && j < 70;
    const triggered = (j >= 0 && j < 3) || (j >= 60 && j < 88);
    const row = {
      case_id: String(i), source, split: j < 0 ? 'calibration' : 'blind', needs_rewrite: j >= 60,
      workflow_expected: true, workflow_ran: true, triggered,
      outcome: adopted ? 'adopted' : triggered ? 'fallback' : 'original',
      selected_text: '回复', final_text: '回复', elapsed_ms: Math.max(1, j + 1), severe_fact_reversal: false,
      vs_prompt_only: j < 0 ? null : { plugin_side: 'A', pick: 'A' },
      vs_original: adopted ? { plugin_side: 'B', pick: j < 67 ? 'B' : 'tie' } : null,
    };
    validate(row);
    return row;
  });
}

test('empty observations have no percentages', () => {
  const result = summarize([], source);
  assert.equal(result.statistical_assessment, 'insufficient_evidence');
  for (const key of ['false_trigger', 'hit', 'fallback', 'severe_fact_reversal', 'adopted_verbatim_display']) {
    assert.equal(result[key].rate, null);
  }
  assert.equal(result.latency.p95_ms, null);
});

test('inclusive thresholds, matched votes, and severity priority', () => {
  const rows = batch();
  const result = summarize(rows, source);
  assert.equal(result.statistical_assessment, 'statistical_targets_met');
  assert.deepEqual(result.false_trigger, ratio(3, 60));
  assert.deepEqual(result.hit, ratio(28, 40));
  assert.equal(result.adopted_preferred_to_original.ties, 3);
  assert.equal(result.latency.p50_ms, 50);
  assert.equal(result.latency.p95_ms, 95);
  rows[100].vs_prompt_only = null;
  assert.equal(status(rows), 'insufficient_evidence');
  rows[100].severe_fact_reversal = true;
  assert.equal(status(rows), 'blocked_severe_fact_reversal');
});

test('synthetic and cancelled rows do not count towards real sample size', () => {
  const rows = batch();
  const synthetic = rows.map(row => ({ ...row, source: 'synthetic', case_id: 'demo-' + row.case_id }));
  assert.equal(status([...rows.slice(1), ...synthetic]), 'insufficient_evidence');
  assert.equal(summarize(synthetic, 'synthetic').statistical_assessment, 'demo_only');
  Object.assign(rows[0], cancelled);
  assert.equal(status(rows), 'insufficient_evidence');
  Object.assign(rows[1], { split: 'blind', needs_rewrite: false, triggered: true, outcome: 'fallback' });
  assert.deepEqual(summarize(rows, source).false_trigger, ratio(4, 61));
});

test('each individual threshold can fail', () => {
  for (const [i, changes] of [[103, { triggered: true, outcome: 'fallback' }],
    [187, { triggered: false, outcome: 'original' }], [160, { vs_original: { plugin_side: 'B', pick: 'A' } }]]) {
    const rows = batch();
    Object.assign(rows[i], changes);
    validate(rows[i]);
    assert.equal(status(rows), 'thresholds_not_met');
  }
});

test('example measures displayed text exactly, including a trailing newline', async () => {
  const rows = await loadRows(example);
  rows[1].final_text += '\n';
  const result = summarize(rows, 'synthetic');
  assert.equal(result.cancelled, 1);
  assert.deepEqual(result.missed_workflow, ratio(1, 3));
  assert.deepEqual(result.fallback, ratio(1, 2));
  assert.deepEqual(result.adopted_verbatim_display, ratio(0, 1));
  assert.equal(result.preferred_to_prompt_only.rate, 0);
});

test('reject reused IDs with line numbers and votes on calibration rows', async t => {
  const rows = batch();
  const folder = await mkdtemp(join(tmpdir(), 'reply-eval-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'samples.jsonl');
  const duplicate = { ...rows[100], case_id: rows[0].case_id };
  await writeFile(path, [JSON.stringify(rows[0]), '', JSON.stringify(duplicate)].join('\n'));
  await assert.rejects(loadRows(path), /samples\.jsonl:3: duplicate/);
  assert.throws(() => validate({ ...rows[0], vs_prompt_only: { plugin_side: 'B', pick: 'B' } }), /inapplicable/);
});
