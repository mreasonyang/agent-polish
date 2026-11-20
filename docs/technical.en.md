# Codex Polish Technical Reference

[简体中文](technical.md) · [Overview](../README.en.md)

Codex Polish `0.0.1-beta.2` is a Codex plugin for macOS and Linux. Its local scripts use built-in Node.js modules and require Node.js 22.16 or newer. The [rewrite skill](../plugins/codex-polish/skills/codex-polish/SKILL.md) polishes eligible final replies. The [setup skill](../plugins/codex-polish/skills/codex-polish-setup/SKILL.md) checks the environment and manages project settings.

## Project Settings and Inheritance

Each project stores its settings as individual files inside `.codex`. The plugin looks up each file independently, starting in the working directory where the turn began. The closest file wins. The search includes the first directory containing `.git` and stops there. If it reaches the user's home directory or the filesystem root first, it stops before reading settings there.

| File | Values and Default | Behavior |
| --- | --- | --- |
| `.codex/codex-polish.mode` | `auto` (default), `manual`, `off` | Without a saved mode, the project uses `auto`. The trusted hook triggers polishing for ordinary questions. `manual` runs only on explicit requests. `off` skips rewrites even when requested. |
| `.codex/codex-polish.model` | Model ID, default `gemini-4-hydrogen` (Gemini 4 Hydrogen) | Stores the per-project Gemini model discovered from the signed-in Antigravity account over ACP. |
| `.codex/codex-polish.history-turns` | Integer `0`–`10`, default `2` | Maximum completed exchanges to attach. Use `0` for the current turn only. Saving a value above `10` returns an error. An invalid or out-of-range setting disables history. Changes apply on the next rewrite. |
| `.codex/codex-polish.decisions` | `auto` (default), `off` | `auto` uses `OPENAI_API_KEY` to determine whether to run OpenAI’s style and meaning checks. `off` uses ACP only. This setting is independent of the trigger mode. |
| `.codex/codex-polish.language` | `auto` (default), `zh`, `en` | Sets the language for plugin prompts and setup checks. Polished replies always stay in the draft's own language. |

When `.codex/codex-polish.language` is `auto`, chat prompts match the user's current message, falling back to the established chat language and then the system locale. Short replies such as menu numbers use the chat language. Terminal checks and the installer check the project setting first, then the system locale, and default to English.

## Rewrite Routes, Stages, and Thresholds

- **Direct ACP.** When `OPENAI_API_KEY` is missing, empty, or entirely whitespace, the plugin uses Gemini alone. Setting `codex-polish.decisions` to `off` has the same effect. Every eligible draft that passes local checks goes to Gemini, even if it already reads well.
- **OpenAI Decisions and ACP.** With `codex-polish.decisions` set to `auto` and a nonblank key, the plugin checks the key’s format locally before contacting OpenAI. It asks `gpt-6-luna` whether to rewrite and, if a changed candidate passes local checks, whether the meaning was preserved. [Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create)

| Stage | Passing Condition |
| --- | --- |
| 1. Text protection | Drafts with detected credentials, explicit exact-output requests, or unsupported structures return the original draft immediately. Code blocks, inline commands, links, citations, file paths, and numbers with units are replaced with turn-specific and source-specific literal placeholders. |
| 2. Style check | Direct ACP proceeds immediately. With Decisions enabled, the protected current question and draft must score `P(needs rewrite) >= 0.80`. |
| 3. ACP rewrite | The agent launches `agy acp` in a temporary workspace under a dedicated editor role, opens a session with the configured Antigravity identity, reads the live model list, and verifies the project model. It rejects tool permission requests and requires a complete `end_turn` matching the request ID. |
| 4. Placeholder check | Every placeholder must appear in its original order. After restoring protected spans, the script verifies fixed tokens, numbers, units, and supported Markdown structures. |
| 5. Meaning check and delivery | Direct ACP delivers the verified rewrite. With Decisions enabled, comparing the protected question, draft, and candidate rewrite must score `P(substantive change) <= 0.05`. Any stage failure returns the original draft, and user cancellation ends the turn. |

During a rewrite, `agy` connects to Google. The plugin's Node.js scripts contact a provider only for the optional OpenAI Decisions checks. The current Codex agent starts and cleans up the ACP process, selects the model, and exchanges protocol messages. [ACP operating instructions](../plugins/codex-polish/skills/codex-polish/references/acp.md)

The plugin requires the official Antigravity CLI 1.2.1 or later. By default it reuses the existing Antigravity sign-in on the machine and OS account running Codex. To use an AI Studio key or an enterprise identity, set `CODEX_POLISH_AGY_AUTH` to `gemini-api-key` or `agent-platform`, respectively. [Sign-in guide](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Google ACP authentication](https://antigravity.google/docs/ide/extensions/acp)

## Outgoing Content, Hooks, and Limits

For automatic polishing, trust the plugin's `UserPromptSubmit` hook in Codex (**Settings → Hooks** or `/hooks` in the CLI), then start a fresh chat. Explicit requests to polish the current question and draft work without the hook in both automatic and manual mode. Including earlier exchanges requires the trusted hook in either mode. [Codex plugins](https://developers.openai.com/plugins/build/plugins) · [Codex hooks](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks)

The hook records which transcript belongs to the current turn. Local Node.js code reads the exchanges directly from that transcript. If the hook is untrusted, the matching transcript is unavailable, no eligible history can be read, or the user limits sharing to the current turn, the plugin can still send the current question and draft alone. One exchange consists of the user's prompt (including follow-up messages within that turn) and Codex's final reply, excluding progress updates and tool output. The current question and draft are sent alongside history and do not count toward `.codex/codex-polish.history-turns`.

- **Sent to Google over ACP.** Each rewrite sends a single ACP prompt containing the placeholder-protected current question and draft, plus up to the configured number of completed exchanges within a `16 KiB` total history cap. The reader scans up to the last 4 MiB of transcript, gives recent exchanges priority within the UTF-8 byte budget, and sends them in chronological order. It skips incomplete turns and turns with detected credentials or attachments. Earlier exchanges are sent with their original text and code. The current turn’s placeholders protect fixed tokens. The provider can still read ordinary prose. Opening the model menu in setup only queries available models and never sends drafts or history.
- **Sent to OpenAI Decisions.** Only the placeholder-protected current question and draft (plus the candidate rewrite during the second check) are sent. Conversation history is never sent to OpenAI.

The plugin never invokes `agy -p` and writes no draft logs of its own. Codex session logs and provider logs follow their own settings ([Google FAQ](https://antigravity.google/docs/faq)). The dedicated Antigravity editor role disables built-in tools ([Antigravity CLI 1.2.1](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1)), though global Antigravity hooks configured on the machine may still run.

## Failure Classes and Cooldowns

| Failure Class | Handling |
| --- | --- |
| Locally malformed key, unsupported auth mode, missing `agy`, or unavailable Node.js or host process tools | The plugin keeps the draft locally. With Decisions enabled, a nonblank key containing whitespace, non-ASCII characters, or nonprintable characters fails local checks. Correct or clear the key, or set the project’s Decisions mode to `off`. The plugin looks for `agy` in `PATH`, then in `~/.local/bin`. |
| Decisions network error, timeout, rate limit, quota failure, auth error, malformed JSON, or content refusal | Each request has a 10-second deadline. A key can pass the local format check and still receive HTTP 401 or 403 from OpenAI. Errors return the original draft and may trigger the cooldowns below. A content refusal affects only the current turn. |
| ACP startup failure, auth failure, missing selected model, or mid-stream model switch | The agent aborts the rewrite, terminates the process, and delivers the original draft. |
| ACP stall, truncated stream, or mismatched `end_turn` request ID | Each control request has a 10-second deadline. During generation, the agent stops after 30 seconds without valid progress for this session, or 90 seconds after process startup. Cleanup can take up to 3 additional seconds. The agent discards incomplete output without replaying the request. |
| Modified numbers or units, dropped code, control characters, suspected credentials, or failed meaning check | Discards the entire candidate rewrite and delivers the original draft. |
| Project disabled mid-turn, updated user instructions, or cancellation | Re-checks project mode before sending text out. The agent discards the old candidate on new instructions. User cancellation ends the turn. If only the server cancels while the user waits, the plugin returns the original draft. |

In automatic mode, service errors pause automatic rewrites for the current project within the active Codex profile.

- **60-second cooldown.** Triggered by connection failures, timeouts, rate limits, or transient service errors.
- **5-minute cooldown.** Triggered by authentication failures, explicit OpenAI quota exhaustion, or an unavailable selected Gemini model.

Exact-format skips, content refusals, and failed draft validation do not trigger a cooldown. Cooldown records store only a scope hash, a fixed error code, a timestamp, and a random token. An explicit request in a later turn can retry during a cooldown. If the cache is unavailable, a failed rewrite still returns the original draft. Saying `"Check Codex Polish setup"` shows missing dependencies and any active cooldown timer, while `"Test ACP connection"` runs a standalone handshake without sending a draft.

## Verification Status

Run the offline test suite and synthetic report from the root of a full source checkout. The release archive ships both language versions of the evaluation guide. The test scripts, report generator, and sample data are available in the source checkout.

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
```

The separate live meaning check makes four billable OpenAI Decisions requests to `gpt-6-luna`. It tests one faithful rewrite and one factual reversal in each of English and Chinese. The default suite skips it. To run it, set `OPENAI_API_KEY` in your terminal and opt in explicitly.

```sh
CODEX_POLISH_TEST_LIVE_DECISIONS=1 node --test --test-name-pattern='live fidelity' tests/decisions.test.mjs
```

### Verified on macOS

Using Node.js 22.16 and Antigravity CLI 1.5.12, the Codex agent selected `gemini-4-hydrogen` over ACP and requested a rewrite. The reply passed local validation and retained the distinction between passing local tests and unverified production behavior. The test environment had no Python on PATH and no OpenAI key. The Node.js helpers made no network requests.

### Checks still open

- Verify a complete rewrite in the T3 chat interface. Exercise both routes with authorized, de-identified samples. Compare the tool trace with the selected model, completed output, and process cleanup. Compare the chosen text with the native final message and the transcript after reopening the chat.
- Run Chinese drafts over 4 KiB in two chats simultaneously and check that each keeps its own text, placeholders, and session ID. Check fallback for an unavailable model, a permission request, cancellation, and a truncated stream.
- Collect at least 200 delivered real samples across the calibration and blind splits. Use the blind split to measure preference rates, severe fact reversals, missed workflows, verbatim display match, and end-to-end latency. Current thresholds are initial defaults, and `evaluation/example.jsonl` contains synthetic records (`demo_only`). See the [evaluation specification](../evaluation/README.en.md) and [contribution guide](../CONTRIBUTING.en.md).

## Installation, Updates, and Uninstall

Once the beta is published to npm, install it with `npx @kyun.si/codex-polish@beta setup`. Replace `setup` with `update` to upgrade, `doctor` to check the current project, or `uninstall` to remove the plugin. For a source installation, run `node scripts/install.mjs setup` from the root of the GitHub checkout. The same subcommands work there. [Quick Start](../README.en.md#quick-start)

Both `setup` and `update` accept `--install-agy` to install the Google CLI when needed. Updates preserve `.codex` project settings and the plugin’s enabled state. Re-running `update` with the same version replaces the build or recovers an interrupted update.

If you packed version `0.0.1-beta.2` locally, you can also run `npx --yes file:./kyun.si-codex-polish-0.0.1-beta.2.tgz uninstall` in the directory containing the archive. Uninstall removes the plugin and its marketplace, clears cooldowns and session pointers for the active Codex profile, and prints the backup path for any manually edited installation files. It keeps shared `agy` binaries and project `.codex` files.
