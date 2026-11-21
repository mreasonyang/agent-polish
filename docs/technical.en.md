# Codex Polish Technical Reference

[简体中文](technical.md) · [Overview](../README.md)

Codex Polish `0.0.1-beta.5` is a Codex plugin for macOS and Linux. Its local scripts use built-in Node.js modules and require Node.js 22.16 or newer. The automatic hook directs Codex to follow the [polishing workflow](../plugins/codex-polish/skills/codex-polish/WORKFLOW.md) once the draft is ready and show the result in the final reply. Explicit requests use the same workflow through the [rewrite skill](../plugins/codex-polish/skills/codex-polish/SKILL.md). The [setup skill](../plugins/codex-polish/skills/codex-polish-setup/SKILL.md) checks the environment and manages project settings.

## Project Settings

Settings live in the nearest Git repository’s root .codex directory. All directories in the same repository use those settings. Nested repositories and linked worktrees have their own settings. Outside Git, settings belong to the chosen folder.

| File | Values and Default | Behavior |
| --- | --- | --- |
| `.codex/codex-polish.mode` | `auto` (default), `manual`, `off` | Without a saved mode, the project uses `auto`. The trusted hook triggers polishing for ordinary questions. `manual` runs only on explicit requests. `off` skips rewrites even when requested. |
| `.codex/codex-polish.rewrite-mode` | `normal` (default), `turbo` | Once polishing is triggered, normal uses the saved Decisions setting. Turbo sends each eligible draft directly to Gemini. |
| `.codex/codex-polish.model` | Model ID, default `gemini-4-hydrogen` (Gemini 4 Hydrogen) | The model picker lists models from the signed-in Antigravity account without sending a draft or history. If the saved model becomes unavailable, that rewrite keeps the original draft. |
| `.codex/codex-polish.prompt.md` | UTF-8 text, defaults to the active mode’s built-in prompt | Custom text takes effect on the next rewrite and carries over to new chats in the same project. |
| `.codex/codex-polish.history-turns` | Integer `0`–`10`, default `2` | Maximum completed exchanges to attach to a Gemini rewrite. Use `0` to omit earlier exchanges. Saving a value above `10` returns an error. An invalid or out-of-range setting disables history. Changes apply on the next rewrite. |
| `.codex/codex-polish.decisions` | `auto` (default), `off` | In normal mode, `auto` enables the OpenAI style check when `OPENAI_API_KEY` is set. `off` uses ACP only. This setting is independent of the trigger mode. |
| `.codex/codex-polish.language` | `auto` (default), `zh`, `en` | Sets the language for plugin prompts and setup checks. |

Say “Switch to turbo mode” or “Switch back to normal mode” to save the project preference. From a source checkout, run `node plugins/codex-polish/hooks/preferences.mjs set-rewrite-mode turbo --cwd /path/to/project`. Use `normal` to switch back. The `check --cwd /path/to/project` command reports the effective `rewrite_mode`. An invalid value pauses polishing locally until you save either mode.

“Use Turbo for this answer” applies to the current draft. “Have Gemini rewrite the answer about caching” uses Turbo on the selected earlier reply in the same chat. Codex interprets the request in context. A question like “What does Turbo do?” asks for an explanation. A one-time rewrite uses `--trigger turbo`, goes directly to ACP, and expires after the reply. Saving the project default takes a separate request. Explicit requests work in `manual` mode and are skipped in `off` mode.

When `.codex/codex-polish.language` is `auto`, chat prompts match the user's current message, falling back to the established chat language and then the system locale. Short replies such as menu numbers use the chat language. Terminal checks and the installer check the project setting first, then the system locale, and default to English.

### Show, set, or restore the polishing prompt

In chat, say “Show the polishing prompt”, “Set this project's polishing prompt to: Lead with the conclusion, then give the evidence”, or “Restore the default polishing prompt”. You can also run these commands locally from the root of a source checkout. Replace `/path/to/project` with the target project directory. The setter saves standard input verbatim, including line breaks and surrounding spaces. The reader returns the effective `text` and its `source` (`default` or `custom`). With no custom prompt, it returns the built-in text for the active rewrite mode. With a custom prompt, the returned `text` is the complete editing prompt for Gemini in both Normal and Turbo. The role file’s header configures the ACP session and tool access. Its body contains only that text.

```sh
node plugins/codex-polish/hooks/preferences.mjs prompt --cwd /path/to/project
node plugins/codex-polish/hooks/preferences.mjs set-prompt --cwd /path/to/project < my-prompt.md
node plugins/codex-polish/hooks/preferences.mjs set-prompt --reset --cwd /path/to/project
```

You can edit the prompt file directly. Restoring the default removes the project prompt. Invalid UTF-8, whitespace-only contents, display controls or a suspected credential prevent polishing until the file is corrected or reset.

## Rewrite Routes, Stages, and Thresholds

- **Direct ACP.** Turbo always uses this route, even with an OpenAI key. Its built-in prompt asks Gemini to actively rewrite each eligible draft. In normal mode, when `OPENAI_API_KEY` is missing, empty, or entirely whitespace, the plugin uses Gemini alone. Setting `codex-polish.decisions` to `off` has the same effect. Every eligible draft that passes local checks goes to Gemini, even if it already reads well.
- **OpenAI Decisions and ACP.** In normal mode with `codex-polish.decisions` set to `auto` and a nonblank key, the plugin checks the key’s format locally before contacting OpenAI. It sends one request to `gpt-6-luna` to decide whether the draft needs editing. [Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create)

| Stage | Behavior |
| --- | --- |
| 1. Local input checks | The plugin skips polishing if it detects a possible credential in the current question or draft, the user requests exact output such as JSON only, or the draft has an unsupported structure. |
| 2. Style check | Direct ACP proceeds after local checks. With Decisions enabled, OpenAI considers only the current question, draft, and any custom polishing prompt. Gemini rewrites when `P(needs rewrite) > 0.50`. |
| 3. ACP rewrite | Gemini loads the project’s effective prompt from the body of the editor role. The agent launches `agy acp` in a temporary workspace under a dedicated editor role, opens a session with the configured Antigravity identity, reads the live model list, and checks the project settings and selected model before sending. It rejects tool permission requests and collects only reply text from this session. The reply is ready to display once the agent has nonempty text and an `end_turn` matching the request ID. |
| 4. Display | Both modes format Gemini’s complete reply for display. The formatter ignores outer whitespace and line-ending differences when deciding whether to show one or both versions. |

During a rewrite, `agy` connects to Google. The plugin's Node.js scripts contact a provider only for the optional OpenAI style check. The current Codex agent starts and cleans up the ACP process, selects the model, and exchanges protocol messages. [ACP operating instructions](../plugins/codex-polish/skills/codex-polish/references/acp.md)

The plugin requires the official Antigravity CLI 1.2.1 or later. By default it reuses the existing Antigravity sign-in on the machine and OS account running Codex. To use an AI Studio key or an enterprise identity, set `CODEX_POLISH_AGY_AUTH` to `gemini-api-key` or `agent-platform`, respectively. [Sign-in guide](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Google ACP authentication](https://antigravity.google/docs/ide/extensions/acp)

## What Appears in the Final Reply

When Gemini returns a changed reply, the final message starts with **Polished by Gemini**. In the Codex app, select “View original GPT draft” below the rewrite to expand the full draft. Select it again to collapse it. Drafts retain their Markdown formatting. When a draft contains disclosure tags or container delimiters, the expanded view shows its Markdown source so you can read those markers verbatim.

For a selected passage or a previous Gemini version, the comparison is labeled **View original text**. Only the selected text and its question are used, along with any editing directions. Additional conversation history is omitted.

If Gemini returns identical text, the reply says it left the draft unchanged and shows the text once. If polishing is skipped before sending or the ACP request ends without a complete reply, the status explains what happened and the reply shows the original. Asking for “only the polished text” shows just Gemini’s text when the rewrite completes. Requests for plain JSON, a single command, or other exact output receive the requested content without labels or status.

When a visualization reference loses its delimiters in the ACP reply and unambiguously matches a reference in the draft, the formatter restores the delimiters. The formatter still displays Gemini’s reply if a reference changes or disappears. New visualization markers with no match in the draft appear as text.

## Outgoing Content, Hooks, and Limits

For automatic polishing, trust the plugin's `UserPromptSubmit` hook in Codex (**Settings → Hooks** or `/hooks` in the CLI), then start a fresh chat. Explicit requests to polish the current question and draft work without the hook in both automatic and manual mode. Including earlier exchanges requires the trusted hook in either mode. [Codex plugins](https://developers.openai.com/plugins/build/plugins) · [Codex hooks](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks)

When the OpenAI style check runs, the plugin sends only the current `question`, `draft`, and any custom `editor_prompt` in `input_json.data`. Gemini receives the `question` and `draft` for the reply being rewritten and optional `history`. If the user gives editing directions for a one-time Turbo rewrite, the plugin includes them in `rewrite_request`. The Antigravity editor role supplies any custom project prompt. The question, draft, and history are sent as written, including code, commands, paths, links, quotations, and numbers.

The trusted hook records the transcript location and current turn locally so a user can select an earlier reply for rewriting. This record holds only metadata, even when history is set to zero. For an earlier rewrite, `question` and `draft` come from the same turn. If that turn showed both versions, the plugin uses the folded GPT draft. When the target is unclear or unavailable, Codex asks the user to identify it or supply the text.

Optional `history` comes from before the selected reply and is sent in chronological order. An exchange consists of a user prompt (including follow-up messages within that turn) and Codex's final reply. The plugin skips progress updates, tool output, incomplete exchanges, and exchanges with detected credentials or attachments. The target question and draft do not count toward the limit of 0–10 exchanges (default 2). With history at zero, an untrusted hook, no usable history, or a request to omit history for this rewrite, the ACP message omits `history`.

OpenAI caps each `input_json.data` at 256 KiB of compact UTF-8 JSON, 32 container levels, and 10,000 values. The plugin puts the current turn’s style check material in one such field and asks one predicate question. Oversized inputs go directly to Gemini in full. The `gpt-6-luna` model card separately lists a context window of 1,050,000 tokens. [Decisions API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create) · [GPT-6 Luna model card](https://developers.openai.com/api/docs/models/gpt-6-luna)

On the Gemini API, the default `gemini-4-hydrogen` model shares a 1,048,576-token window across input, thinking, and output. On Antigravity, session overhead and the selected model also matter. For example, Antigravity lists a window of up to 512K tokens for Gemini 4 Neon. Google’s ACP documentation gives no exact byte limit for a Hydrogen rewrite prompt. Starting in version 1.5.8, `agy` reports context-window usage when it opens a session or changes models. [Hydrogen model card](https://aistudio.google.com/docs/models/gemini-4-hydrogen) · [Antigravity models](https://antigravity.google/docs/models#gemini-4-neon) · [Antigravity CLI 1.5.8](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.8)

The plugin never invokes `agy -p` and writes no draft logs of its own. Codex session logs and provider logs follow their own settings ([Google FAQ](https://antigravity.google/docs/faq)). The dedicated Antigravity editor role disables built-in tools ([Antigravity CLI 1.2.1](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1)), though global Antigravity hooks configured on the machine may still run.

## Handling failures

| Failure Class | Handling |
| --- | --- |
| Unsupported Google authentication, missing agy, Node.js or host process tools | Keep the original. The plugin looks for agy in PATH and ~/.local/bin. |
| Decisions unavailable, key invalid, response invalid, or input exceeds the provider limit | Continue to Gemini after local checks. Each turn makes its own routing decision. |
| ACP startup failure, auth failure, missing selected model, or mid-stream model switch | The agent aborts the rewrite, terminates the process, and delivers the original draft. |
| Slow or interrupted generation | Wait while the ACP process is running. On an explicit timeout, cancellation, disconnect or truncated result, discard incomplete output. A request is sent at most once. |
| Project disabled mid-turn, updated user instructions, or cancellation | Re-checks project mode before sending text out. The agent discards the old candidate on new instructions. User cancellation ends the turn. If only the server cancels while the user waits, the plugin returns the original draft. |

## Verification Status

In a live local test, a synthetic conversation had 10 earlier exchanges totaling 16 KiB and a saved custom polishing prompt. OpenAI received one request with just `question`, `draft`, and `editor_prompt` as evidence, and returned HTTP 200. Gemini 4 Hydrogen then received all 10 exchanges over ACP and completed the rewrite.

Run the offline test suite and synthetic report from the root of a full source checkout. The release archive ships both language versions of the evaluation guide. The test scripts, report generator, and sample data are available in the source checkout.

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
```

The Decisions tests use mock OpenAI responses to exercise the style threshold and API error handling. A simulated ACP server covers model changes, permission requests, interrupted replies and mixed session messages. The installer tests use a temporary Codex profile to install the packed archive, check hook registration, update the plugin and uninstall it.

### Verified on macOS

Using Node.js 22.16 and Antigravity CLI 1.5.12, the Codex agent selected `gemini-4-hydrogen` over ACP and requested a rewrite. The reply reported that local tests passed and production verification was still pending. The test environment had no Python on PATH and no OpenAI key. The Node.js helpers made no network requests.

In a T3 Code chat using the Codex backend, a one-time Turbo request rewrote the preceding visible answer through Gemini 4 Hydrogen. The delivered message contained the rewrite and the original draft.

### Checks still open

- Exercise the Normal route in T3 Code both with and without Decisions, using authorized, de-identified samples. Compare the tool trace with the selected model, completed output, and process cleanup. Check the status and section order in the native final message and again after reopening the chat. In clients that support folding, verify that a new reply starts with the draft collapsed. Expand it and compare each body with its source.
- Run Chinese drafts over 4 KiB in two chats simultaneously and check that each keeps its own text and session ID. Check fallback for an unavailable model, a permission request, cancellation, and a truncated stream.
- Collect at least 200 delivered real samples across the calibration and blind splits. Use the blind split to measure preference rates, severe fact reversals, missed workflows, verbatim display match, and end-to-end latency. Current thresholds are initial defaults, and `evaluation/example.jsonl` contains synthetic records (`demo_only`). See the [evaluation specification](../evaluation/README.en.md) and [contribution guide](../CONTRIBUTING.en.md).

## Installation, Updates, and Uninstall

Install the published npm beta with `npx @kyun.si/codex-polish@beta setup`. Replace `setup` with `update` to upgrade, `doctor` to check the current project, or `uninstall` to remove the plugin. For a source installation, run `node scripts/install.mjs setup` from the root of the GitHub checkout. The same subcommands work there. [Quick Start](../README.md#quick-start)

For a Finder install on macOS, extract the repository archive and double-click [Install Codex Polish.command](../Install%20Codex%20Polish.command). Select the project you want to configure when prompted.

Both `setup` and `update` accept `--install-agy` to install the Google CLI when needed. Updates preserve `.codex` project settings and the plugin’s enabled state. Re-running `update` with the same version replaces the build or recovers an interrupted update.

The installer registers one local marketplace per Codex profile. Updates stage a verified snapshot, atomically switch the marketplace manifest to the new snapshot and refresh the native plugin cache. If the refresh fails, the installer restores the previous snapshot and enabled state. Codex checks the installed plugin’s contents when deciding hook trust. An update to a bundled prompt or setup guide can therefore require a new approval even when the hook command is unchanged. The installer and `doctor` read the current status from `hooks/list`.

If you packed version `0.0.1-beta.5` locally, you can also run `npx --yes file:./kyun.si-codex-polish-0.0.1-beta.5.tgz uninstall` in the directory containing the archive. Uninstall removes the plugin and its marketplace, clears session pointers for the active Codex profile, and prints the backup path for any manually edited installation files. It keeps shared `agy` binaries and project `.codex` files.
