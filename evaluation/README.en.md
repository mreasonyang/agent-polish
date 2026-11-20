# Offline Evaluation Statistics

[简体中文](README.md)

Run these commands from the root of a full source checkout. Release archives include the English and Chinese guides. The script, sample data, and tests are available in the full source checkout. The reporting script uses the Node.js standard library to read per-sample observations from UTF-8 JSONL and write a JSON summary to standard output. All five records, preference votes, and latency numbers in the example file are synthetic.

```sh
node evaluation/report.mjs evaluation/example.jsonl
node --test tests/evaluation.test.mjs
```

## Data Collection and Blind Rating

1. Obtain permission to use the samples and remove sensitive content. Assign a stable `case_id` to each original prompt and draft. Record the variants and votes for that case in one JSONL row, assigned to a single split. A repeated ID in any row or split stops the script with the offending line number.
2. Label independently whether each original draft needs rewriting, then select thresholds on the calibration split. Freeze the plugin settings, model, and concise prompt used for the prompt-only baseline, and use that frozen setup across all blind samples. Each report corresponds to one frozen configuration.
3. Record the host tool trace, the selected reply text, and the native final message. Use the complete message to check the status, labels, section order, and original draft. For blind rating, take only the displayed body of the selected reply, omitting the plugin’s labels and status. Generate a prompt-only baseline reply using the same task, Codex model, and context with only a concise style instruction added. For samples that adopt a rewrite, also pair the rewrite against the original draft.
4. Randomize each pair into A and B. Raters see only the user prompt, required context, and two anonymous replies, choosing A, B, or a tie. After unblinding, record `plugin_side` and `pick`. An independent fact checker compares the original draft against the delivered reply and flags any severe fact reversal, such as turning "tests were not run" into "tests passed." The script consumes the collected records, while the data provider verifies authorization, split assignment, and blinding.

## JSONL Record Fields

| Field | How to Fill It |
| --- | --- |
| `case_id` | Non-empty string unique within the collection |
| `source`, `split` | `authorized_real` or `synthetic`, paired with `calibration` or `blind` |
| `needs_rewrite` | `true` when human review judges that the original draft needs rewriting |
| `workflow_expected`, `workflow_ran` | Whether the turn should run through the plugin, and whether the host trace shows it actually ran. Turns skipped by rule can be `false` |
| `triggered` | `true` when the check decides to trigger an external rewrite, even if a failure happens afterward |
| `outcome` | `original` when delivering the initial draft, `adopted` when using the rewrite, `fallback` when delivering the original draft after a workflow error or failed local check, `cancelled` when the user cancels and nothing is delivered |
| `selected_text`, `final_text` | Take the first from the chosen rewrite or original draft. Independently take the second from its corresponding body in the native final message. Use the polished body when both versions appear, or the sole body when one appears. Exclude plugin labels and status. Preserve punctuation, spaces, and newlines within the body. Omit or set to `null` when cancelled |
| `elapsed_ms` | Total milliseconds from draft ready to native final message display. Set to `null` when unmeasured or cancelled |
| `severe_fact_reversal` | Human fact-check result for the delivered reply. Set `true` if a severe reversal is found, `false` if checked and none is found, or `null` if unchecked or cancelled |
| `vs_original` | One vote for each blind record that adopted a rewrite. `{"plugin_side":"B","pick":"A"}` means the rewrite appeared on side B and the rater chose the original draft. Use `"pick":"tie"` for a tie |
| `vs_prompt_only` | One vote for each delivered blind record. The plugin side shows `final_text` and the other side shows the prompt-only baseline, using the same format. Omit or set to `null` when missing or not applicable |

## Reading the Report

The report summarizes synthetic and real datasets separately, taking quality metrics from the `blind` split. Each ratio entry includes the numerator `count`, denominator `total`, and a `rate` from 0 to 1. When the denominator is zero, `rate` is JSON `null`. Cancelled turns are counted separately.

| Metric | Denominator and Calculation |
| --- | --- |
| `false_trigger`, `hit` | Among delivered blind turns expected to run, the trigger rate within human-labeled clear drafts and within drafts needing a rewrite respectively. Expected turns where the workflow was missed remain in the denominator |
| `adopted_preferred_to_original`, `preferred_to_prompt_only` | Plugin win rate across valid preference votes for each comparison, counting ties in the denominator. Also reports `eligible` sample count and `ties` |
| `severe_fact_reversal` | Count and rate of severe reversals among delivered replies that completed human fact checking |
| `missed_workflow`, `verbatim_display`, `adopted_verbatim_display` | Rate of missed workflow runs among delivered turns expected to run, plus exact character match rates (including punctuation, spaces, and newlines) across all delivered replies and across adopted rewrites |
| `fallback`, `latency` | Fallback rate among delivered turns where the workflow ran. Recorded delivery latencies are sorted ascending, and P50 and P95 take item `ceil(p × n)` in milliseconds |

Any severe fact reversal in real blind data sets the status to `blocked_severe_fact_reversal`. Assessment requires at least 200 delivered real samples across the two splits, with delivered samples in both `calibration` and `blind`, non-zero denominators for `false_trigger`, `hit`, and `adopted_preferred_to_original`, and complete records for applicable blind votes, fact checks, and latency. Missing evidence sets `insufficient_evidence`. Once the evidence requirements are met, the report sets `statistical_targets_met` if the false trigger rate is at most 5%, the hit rate is at least 70%, and raters prefer at least 70% of adopted rewrites to their original drafts. Missing any of these targets gives `thresholds_not_met`. Actual sample counts for both splits appear in the report, while live runtime checks and host delivery still require separate verification. The synthetic group is always marked `demo_only`.
