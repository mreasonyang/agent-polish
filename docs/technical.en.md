# Codex Polish Technical Reference

[简体中文](technical.md) · [Overview](../README.en.md)

Codex Polish `0.0.1-beta.3` is a Codex plugin for macOS and Linux. Its local scripts use built-in Node.js modules and require Node.js 22.16 or newer. The [rewrite skill](../plugins/codex-polish/skills/codex-polish/SKILL.md) polishes eligible final replies. The [setup skill](../plugins/codex-polish/skills/codex-polish-setup/SKILL.md) checks the environment and manages project settings.

## Project Settings and Inheritance

Each project stores its settings as individual files inside `.codex`. The plugin looks up each file independently, starting in the working directory where the turn began. The closest file wins. The search includes the first directory containing `.git` and stops there. If it reaches the user's home directory or the filesystem root first, it stops before reading settings there.

| File | Values and Default | Behavior |
| --- | --- | --- |
| `.codex/codex-polish.mode` | `auto` (default), `manual`, `off` | Without a saved mode, the project uses `auto`. The trusted hook triggers polishing for ordinary questions. `manual` runs only on explicit requests. `off` skips rewrites even when requested. |
| `.codex/codex-polish.rewrite-mode` | `normal` (default), `turbo` | Once polishing is triggered, normal uses the saved Decisions setting. Turbo sends each eligible draft directly to Gemini. |
| `.codex/codex-polish.model` | Model ID, default `gemini-4-hydrogen` (Gemini 4 Hydrogen) | Stores the per-project Gemini model discovered from the signed-in Antigravity account over ACP. |
| `.codex/codex-polish.prompt.md` | Up to 16 KiB of UTF-8 text, defaults to the active mode’s built-in prompt | Custom text takes effect on the next rewrite and carries over to new chats in the same project. |
| `.codex/codex-polish.history-turns` | Integer `0`–`10`, default `2` | Maximum completed exchanges to attach to a Gemini rewrite. Use `0` to omit earlier exchanges. Saving a value above `10` returns an error. An invalid or out-of-range setting disables history. Changes apply on the next rewrite. |
| `.codex/codex-polish.decisions` | `auto` (default), `off` | In normal mode, `auto` enables the OpenAI style check when `OPENAI_API_KEY` is set. `off` uses ACP only. This setting is independent of the trigger mode. |
| `.codex/codex-polish.language` | `auto` (default), `zh`, `en` | Sets the language for plugin prompts and setup checks. |

Say “Switch to turbo mode” or “Switch back to normal mode” to save the project preference. From a source checkout, run `node plugins/codex-polish/hooks/preferences.mjs set-rewrite-mode turbo --cwd /path/to/project`. Use `normal` to switch back. The `check --cwd /path/to/project` command reports the effective `rewrite_mode`. An invalid value pauses polishing locally until you save either mode.

When `.codex/codex-polish.language` is `auto`, chat prompts match the user's current message, falling back to the established chat language and then the system locale. Short replies such as menu numbers use the chat language. Terminal checks and the installer check the project setting first, then the system locale, and default to English.

### Show, set, or restore the polishing prompt

In chat, say “Show the polishing prompt”, “Set this project's polishing prompt to: Lead with the conclusion, then give the evidence”, or “Restore the default polishing prompt”. You can also run these commands locally from the root of a source checkout. Replace `/path/to/project` with the target project directory. The setter saves standard input verbatim, including line breaks and surrounding spaces. The reader returns the effective `text` and its `source` (`default` or `custom`). With no custom prompt, it returns the built-in text for the active rewrite mode. With a custom prompt, the returned `text` is the complete editing prompt for Gemini in both Normal and Turbo. The role file’s header configures the ACP session and tool access. Its body contains only that text.

```sh
node plugins/codex-polish/hooks/preferences.mjs prompt --cwd /path/to/project
node plugins/codex-polish/hooks/preferences.mjs set-prompt --cwd /path/to/project < my-prompt.md
node plugins/codex-polish/hooks/preferences.mjs set-prompt --reset --cwd /path/to/project
```

You can edit the project's prompt file directly. Subdirectories inherit the nearest setting. When you restore the default in a subdirectory with an inherited custom or invalid prompt, the setter writes a zero-byte file there to select the active mode’s built-in prompt. A nonempty whitespace-only file, invalid UTF-8, disallowed control characters, a suspected credential, or text over 16 KiB stops polishing locally with `editor_prompt_invalid`. Replace the text or restore the default to resume. General setup checks report only the prompt source or its invalid status.

## Rewrite Routes, Stages, and Thresholds

- **Direct ACP.** Turbo always uses this route, even with an OpenAI key. Its built-in prompt asks Gemini to actively rewrite each eligible draft. In normal mode, when `OPENAI_API_KEY` is missing, empty, or entirely whitespace, the plugin uses Gemini alone. Setting `codex-polish.decisions` to `off` has the same effect. Every eligible draft that passes local checks goes to Gemini, even if it already reads well.
- **OpenAI Decisions and ACP.** In normal mode with `codex-polish.decisions` set to `auto` and a nonblank key, the plugin checks the key’s format locally before contacting OpenAI. It sends one request to `gpt-6-luna` to decide whether the draft needs editing. [Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create)

| Stage | Passing Condition |
| --- | --- |
| 1. Local input checks | The plugin skips polishing if it detects a possible credential in the current question or draft, the user requests exact output such as JSON only, or the draft has an unsupported structure. |
| 2. Style check | Direct ACP proceeds after local checks. With Decisions enabled, OpenAI considers only the current question, draft, and any custom polishing prompt. Gemini rewrites when `P(needs rewrite) >= 0.80`. |
| 3. ACP rewrite | Gemini loads the project’s effective prompt from the body of the editor role. The agent launches `agy acp` in a temporary workspace under a dedicated editor role, opens a session with the configured Antigravity identity, reads the live model list, and verifies the project model. It rejects tool permission requests and requires a complete `end_turn` matching the request ID. |
| 4. Local candidate checks | The plugin checks the rewrite’s size and screens it for control characters and possible credentials. It compares supported Markdown structures such as heading levels, list markers, and indentation with the draft. In turbo, a candidate that matches the draft after trimming outer whitespace and normalizing line endings returns `unchanged_candidate`. The plugin keeps the original, reports the reason and makes no second request. |
| 5. Delivery | Both routes run `preferences.mjs finish` locally. It takes no reply text and rechecks the trigger setting, rewrite mode, runtime requirements, and route. The plugin then delivers the rewrite. A failed check returns the original draft. User cancellation ends the turn. |

During a rewrite, `agy` connects to Google. The plugin's Node.js scripts contact a provider only for the optional OpenAI style check. The current Codex agent starts and cleans up the ACP process, selects the model, and exchanges protocol messages. [ACP operating instructions](../plugins/codex-polish/skills/codex-polish/references/acp.md)

The plugin requires the official Antigravity CLI 1.2.1 or later. By default it reuses the existing Antigravity sign-in on the machine and OS account running Codex. To use an AI Studio key or an enterprise identity, set `CODEX_POLISH_AGY_AUTH` to `gemini-api-key` or `agent-platform`, respectively. [Sign-in guide](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Google ACP authentication](https://antigravity.google/docs/ide/extensions/acp)

## What Appears in the Final Reply

When Codex adopts a rewrite, the final message starts with **Polished by Gemini**. In the Codex app, select “View original GPT draft” below the rewrite to expand the full draft. Select it again to collapse it. Drafts retain their Markdown formatting. When a draft contains disclosure tags or container delimiters, the expanded view shows its Markdown source so you can read those markers verbatim.

If Gemini returns identical text, the reply says it left the draft unchanged and shows the text once. A skip before sending, an incomplete request, or a rejected rewrite gets a brief status based on what happened, followed only by the original. Asking for “only the polished text” gives you just the selected body. Requests for plain JSON, a single command, or other exact output receive the requested content without labels or status.

## Outgoing Content, Hooks, and Limits

For automatic polishing, trust the plugin's `UserPromptSubmit` hook in Codex (**Settings → Hooks** or `/hooks` in the CLI), then start a fresh chat. Explicit requests to polish the current question and draft work without the hook in both automatic and manual mode. Including earlier exchanges requires the trusted hook in either mode. [Codex plugins](https://developers.openai.com/plugins/build/plugins) · [Codex hooks](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks)

When the OpenAI style check runs, the plugin sends only the current `question`, `draft`, and any custom `editor_prompt` in `input_json.data`. When Gemini rewrites, Google receives an ACP message with the current question, draft, and optional `history`. The Antigravity editor role supplies any custom polishing prompt. The question, draft, and history are sent as written, including code, commands, paths, links, quotations, and numbers. The plugin checks Gemini’s reply locally.

The trusted hook identifies the transcript for the current turn. When preparing a Gemini rewrite, the local reader can scan up to the last 4 MiB. An exchange consists of a previous user prompt (including follow-up messages within that turn) and Codex's final reply. Progress updates and tool output are excluded. The project can include 0–10 exchanges, with a default of 2. The plugin prioritizes recent complete exchanges, fits up to 16 KiB of UTF-8 history text, and sends them in chronological order. It skips incomplete exchanges and those with detected credentials or attachments. The current question and draft do not count toward the exchange limit. With the setting at zero, an untrusted hook, no usable transcript or history, or a request to omit history for this turn, the ACP message omits the `history` field.

| Local input limit | Measurement and behavior |
| --- | --- |
| 128 KiB each for the current question and draft | Measured separately as UTF-8 text. If either exceeds the limit, the plugin keeps the original draft. |
| 256 KiB of material per step, inclusive | Measured as compact UTF-8 JSON, including the question, draft, any custom prompt, field names, punctuation, and escaping. Selected history also counts toward the Gemini limit. The plugin removes the oldest whole exchanges first. If the question, draft, and custom prompt alone exceed the limit, it keeps the original draft. |

OpenAI caps each `input_json.data` at 256 KiB of compact UTF-8 JSON, 32 container levels, and 10,000 values. The plugin puts the current turn’s style check material in one such field and asks one predicate question. The `gpt-6-luna` model card separately lists a context window of 1,050,000 tokens. [Decisions API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create) · [GPT-6 Luna model card](https://developers.openai.com/api/docs/models/gpt-6-luna)

On the Gemini API, the default `gemini-4-hydrogen` model shares a 1,048,576-token window across input, thinking, and output. On Antigravity, session overhead and the selected model also matter. For example, Antigravity lists a window of up to 512K tokens for Gemini 4 Neon. Google’s ACP documentation gives no exact byte limit for a Hydrogen rewrite prompt. Starting in version 1.5.8, `agy` reports context-window usage when it opens a session or changes models. [Hydrogen model card](https://aistudio.google.com/docs/models/gemini-4-hydrogen) · [Antigravity models](https://antigravity.google/docs/models#gemini-4-neon) · [Antigravity CLI 1.5.8](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.8)

The plugin never invokes `agy -p` and writes no draft logs of its own. Codex session logs and provider logs follow their own settings ([Google FAQ](https://antigravity.google/docs/faq)). The dedicated Antigravity editor role disables built-in tools ([Antigravity CLI 1.2.1](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1)), though global Antigravity hooks configured on the machine may still run.

## Failure Classes and Cooldowns

| Failure Class | Handling |
| --- | --- |
| Locally malformed key, unsupported auth mode, missing `agy`, or unavailable Node.js or host process tools | The plugin keeps the draft locally. With Decisions enabled, a nonblank key containing whitespace, non-ASCII characters, or nonprintable characters fails local checks. Correct or clear the key, or set the project’s Decisions mode to `off`. The plugin looks for `agy` in `PATH`, then in `~/.local/bin`. |
| Decisions network error, timeout, rate limit, quota failure, auth error, malformed JSON, or content refusal | Each request has a 10-second deadline. A key can pass the local format check and still receive HTTP 401 or 403 from OpenAI. Errors return the original draft and may trigger the cooldowns below. A content refusal affects only the current turn. |
| ACP startup failure, auth failure, missing selected model, or mid-stream model switch | The agent aborts the rewrite, terminates the process, and delivers the original draft. |
| ACP stall, truncated stream, or mismatched `end_turn` request ID | Each control request has a 10-second deadline. During generation, the agent stops after 30 seconds without valid progress for this session, or 90 seconds after process startup. Cleanup can take up to 3 additional seconds. The agent discards incomplete output without replaying the request. |
| Disallowed control characters, suspected credentials, or a change in supported Markdown structure in the rewrite | Discards the entire candidate rewrite and delivers the original draft. |
| Project disabled mid-turn, updated user instructions, or cancellation | Re-checks project mode before sending text out. The agent discards the old candidate on new instructions. User cancellation ends the turn. If only the server cancels while the user waits, the plugin returns the original draft. |

In automatic mode, service errors pause automatic rewrites for the current project within the active Codex profile.

- **60-second cooldown.** Triggered by connection failures, timeouts, rate limits, or transient service errors.
- **5-minute cooldown.** Triggered by authentication failures, explicit OpenAI quota exhaustion, or an unavailable selected Gemini model.

Exact-format skips, content refusals, and failed draft validation do not trigger a cooldown. Cooldown records store only a scope hash, a fixed error code, a timestamp, and a random token. An explicit request in a later turn can retry during a cooldown. If the cache is unavailable, a failed rewrite still returns the original draft. Saying `"Check Codex Polish setup"` shows missing dependencies and any active cooldown timer, while `"Test ACP connection"` runs a standalone handshake without sending a draft.

## Verification Status

In a live local test, a synthetic conversation had 10 earlier exchanges totaling 16 KiB and a saved custom polishing prompt. OpenAI received one request with just `question`, `draft`, and `editor_prompt` as evidence, and returned HTTP 200. Gemini 4 Hydrogen then received all 10 exchanges over ACP and completed the rewrite.

Run the offline test suite and synthetic report from the root of a full source checkout. The release archive ships both language versions of the evaluation guide. The test scripts, report generator, and sample data are available in the source checkout.

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
```

The Decisions tests use mock OpenAI responses to check the style threshold and confirm that errors return the original draft.

### Verified on macOS

Using Node.js 22.16 and Antigravity CLI 1.5.12, the Codex agent selected `gemini-4-hydrogen` over ACP and requested a rewrite. The reply passed local validation and retained the distinction between passing local tests and unverified production behavior. The test environment had no Python on PATH and no OpenAI key. The Node.js helpers made no network requests.

### Checks still open

- Verify a complete rewrite in the T3 chat interface. Exercise both routes with authorized, de-identified samples. Compare the tool trace with the selected model, completed output, and process cleanup. Check the status and section order in the native final message and again after reopening the chat. In clients that support folding, verify that a new reply starts with the draft collapsed. Expand it and compare each body with its source.
- Run Chinese drafts over 4 KiB in two chats simultaneously and check that each keeps its own text and session ID. Check fallback for an unavailable model, a permission request, cancellation, and a truncated stream.
- Collect at least 200 delivered real samples across the calibration and blind splits. Use the blind split to measure preference rates, severe fact reversals, missed workflows, verbatim display match, and end-to-end latency. Current thresholds are initial defaults, and `evaluation/example.jsonl` contains synthetic records (`demo_only`). See the [evaluation specification](../evaluation/README.en.md) and [contribution guide](../CONTRIBUTING.en.md).

## Installation, Updates, and Uninstall

Once the beta is published to npm, install it with `npx @kyun.si/codex-polish@beta setup`. Replace `setup` with `update` to upgrade, `doctor` to check the current project, or `uninstall` to remove the plugin. For a source installation, run `node scripts/install.mjs setup` from the root of the GitHub checkout. The same subcommands work there. [Quick Start](../README.en.md#quick-start)

Both `setup` and `update` accept `--install-agy` to install the Google CLI when needed. Updates preserve `.codex` project settings and the plugin’s enabled state. Re-running `update` with the same version replaces the build or recovers an interrupted update.

If you packed version `0.0.1-beta.3` locally, you can also run `npx --yes file:./kyun.si-codex-polish-0.0.1-beta.3.tgz uninstall` in the directory containing the archive. Uninstall removes the plugin and its marketplace, clears cooldowns and session pointers for the active Codex profile, and prints the backup path for any manually edited installation files. It keeps shared `agy` binaries and project `.codex` files.
