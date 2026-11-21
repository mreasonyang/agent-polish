# Codex Polish Technical Reference

[简体中文](technical.md) · [Overview](../README.md)

Codex Polish is a Codex plugin for Windows, macOS, and Linux. Its local scripts use built-in Node.js modules and require Node.js 22.16 or newer. The automatic hook directs Codex to follow the [polishing workflow](../plugins/codex-polish/skills/codex-polish/WORKFLOW.md) once the draft is ready and show the result in the final reply. Explicit requests use the same workflow through the [rewrite skill](../plugins/codex-polish/skills/codex-polish/SKILL.md). The [setup skill](../plugins/codex-polish/skills/codex-polish-setup/SKILL.md) checks the environment and manages project settings.

## Project Settings

Settings live in the nearest Git repository’s root .codex directory. All directories in the same repository use those settings. Nested repositories and linked worktrees have their own settings. Outside Git, settings belong to the chosen folder.

| File | Values and Default | Behavior |
| --- | --- | --- |
| `.codex/codex-polish.mode` | `auto` (default), `manual`, `off` | Without a saved mode, the project uses `auto`. The trusted hook triggers polishing for ordinary questions. `manual` runs only on explicit requests. `off` skips rewrites even when requested. |
| `.codex/codex-polish.rewrite-mode` | `normal` (default), `turbo` | Applies only to the automatic hook. Neither mode needs an OpenAI key, and without the check both send drafts to Gemini. With the built-in prompts, `normal` can keep a clear draft and optionally checks with OpenAI Decisions, while `turbo` skips Decisions and asks Gemini to rewrite the draft. |
| `.codex/codex-polish.model` | Model ID, default `gemini-4-hydrogen` (Gemini 4 Hydrogen) | The model picker lists models from the signed-in Antigravity account without sending a draft or history. If the saved model becomes unavailable, that rewrite keeps the original draft. |
| `.codex/codex-polish.prompt.md` | UTF-8 text, defaults to the active mode’s built-in prompt | Custom text applies across project chats. A request to send only a passage uses the built-in Turbo prompt. |
| `.codex/codex-polish.history-turns` | Integer `0`–`10`, default `2` | Maximum completed exchanges to attach when Gemini rewrites a whole reply. Use `0` to omit earlier exchanges. Saving a value above `10` returns an error. An invalid setting reports the file and the allowed range. Changes apply on the next rewrite. |
| `.codex/codex-polish.decisions` | `auto` (default), `off` | For hook-triggered polishing in Normal mode, `auto` enables the OpenAI style check when `OPENAI_API_KEY` is set. With `off`, drafts go directly to Gemini. |
| `.codex/codex-polish.language` | `auto` (default), `zh`, `en` | Sets the language for plugin prompts and setup checks. |

Trigger mode, automatic rewrite mode, and Decisions accept mixed-case settings. Decisions also accepts `on` to enable the check. Diagnostics identify an invalid setting and list the allowed values.

Say “Switch to turbo mode” or “Switch back to normal mode” to save the project preference. From a source checkout, run `node plugins/codex-polish/hooks/preferences.mjs set-rewrite-mode turbo --cwd /path/to/project`. Use `normal` to switch back. The `check --cwd /path/to/project` command reports the effective `rewrite_mode`. An invalid value pauses automatic polishing until you save either mode. Explicit requests still use Turbo.

“Polish the result” applies to the current draft. “Have Gemini rewrite the answer about caching” selects an earlier reply in the same chat. Both use `--trigger explicit` and send the selected draft directly to Gemini over ACP in Turbo mode. The request applies once and works in either `auto` or `manual`. Codex interprets requests in context, so “What does Turbo do?” asks for an explanation. The hook uses `--trigger auto` on ordinary questions and follows the project’s saved rewrite mode. The project’s `off` setting skips both triggers.

When `.codex/codex-polish.language` is `auto`, chat prompts match the user's current message, falling back to the established chat language and then the system locale. Short replies such as menu numbers use the chat language. Terminal checks and the installer check the project setting first, then the system locale, and default to English.

### Show, set, or restore the polishing prompt

In chat, say “Show the polishing prompt”, “Set this project's polishing prompt to: Lead with the conclusion, then give the evidence”, or “Restore the default polishing prompt”. You can also run these commands locally from the root of a source checkout. Replace `/path/to/project` with the target project directory. The setter saves standard input verbatim, including line breaks and surrounding spaces. The reader returns the effective `text` and its `source` (`default` or `custom`). With no custom prompt, the reader shows the project’s automatic mode prompt, and explicit requests use the built-in Turbo prompt. A custom prompt supplies Gemini’s editing role for Normal and Turbo. A request to send only the selected text uses the built-in Turbo role instead. The role file’s header configures the ACP session and tool access. Its body contains only that text.

```sh
node plugins/codex-polish/hooks/preferences.mjs prompt --cwd /path/to/project
node plugins/codex-polish/hooks/preferences.mjs set-prompt --cwd /path/to/project < my-prompt.md
node plugins/codex-polish/hooks/preferences.mjs set-prompt --reset --cwd /path/to/project
```

You can edit the project prompt file directly or link it to a prompt tracked by Git in the same project. The setup command stores a relative reference for a tracked project file. On Windows this is a regular file, so the command works without permission to create symbolic links. Commit the link to share it across clones. To use a shared prompt elsewhere or an untracked file, name the file in chat or run `node plugins/codex-polish/hooks/preferences.mjs set-prompt --link /path/to/prompt.md --cwd /path/to/project`. The file must contain valid UTF-8 and at least one non-whitespace character. Replacing the prompt or restoring the default changes only the project link.

## Rewrite Routes, Stages, and Thresholds

- **Direct ACP.** Explicit requests and automatic Turbo rewrites use this route, even with an OpenAI key. The built-in Turbo prompt asks Gemini to actively rewrite each draft. For automatic polishing in Normal mode, when `OPENAI_API_KEY` is missing, empty, or entirely whitespace, the plugin uses Gemini alone. Setting `codex-polish.decisions` to `off` has the same effect.
- **OpenAI Decisions and ACP.** For automatic polishing in Normal mode with `codex-polish.decisions` set to `auto` and a nonblank key, the plugin checks the key’s format locally before contacting OpenAI. It sends one request to `gpt-6-luna` to decide whether the draft needs editing. [Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create)

| Stage | Behavior |
| --- | --- |
| 1. Select the text | Codex uses the current draft, an earlier answer, or a selected passage, as requested. If you ask it to skip polishing, keep the text local, or return a verbatim answer, it follows that request directly. |
| 2. Style check | Direct ACP sends the selected text to Gemini. With Decisions enabled, OpenAI considers only the current question, draft, and any custom polishing prompt. Gemini rewrites when `P(needs rewrite) > 0.50`. |
| 3. ACP rewrite | Gemini loads the polishing prompt for this request from the body of the editor role. The agent launches `agy acp` in a temporary workspace under a dedicated editor role, opens a session with the configured Antigravity identity, reads the live model list, and checks the project settings and selected model before sending. It rejects tool permission requests and collects only reply text from this session. The reply is ready to display once the agent has nonempty text and an `end_turn` matching the request ID. |
| 4. Display | Identical replies appear once. The comparison keeps both versions if their indentation, whitespace, or line endings differ. |

On Windows, the host uses Windows PowerShell and its built-in .NET runtime to start `agy.exe`. A Windows job object ties the provider and its child processes to the rewrite. The agent submits each protocol message itself. Draft input goes through a separate console handle, which accepts long UTF-8 text.

During a rewrite, `agy` connects to Google. The plugin's Node.js scripts contact a provider only for the optional OpenAI style check. The current Codex agent starts and cleans up the ACP process, selects the model, and exchanges protocol messages. [ACP operating instructions](../plugins/codex-polish/skills/codex-polish/references/acp.md)

The plugin requires the official Antigravity CLI 1.2.1 or later. By default it reuses the existing Antigravity sign-in on the machine and OS account running Codex. To use an AI Studio key or an enterprise identity, set `CODEX_POLISH_AGY_AUTH` to `gemini-api-key` or `agent-platform`, respectively. [Sign-in guide](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Google ACP authentication](https://antigravity.google/docs/ide/extensions/acp)

## What Appears in the Final Reply

When Gemini returns a changed reply, the final message starts with **Polished by Gemini**. In the Codex app, select “View original GPT draft” below the rewrite to expand the full draft. Select it again to collapse it. Drafts retain their Markdown formatting. When a draft contains disclosure tags or container delimiters, the expanded view shows its Markdown source so you can read those markers verbatim.

For a selected passage or a previous Gemini version, the comparison is labeled **View original text**. The expanded comparison shows the exact passage submitted for editing.

If Gemini returns identical text, the reply says it left the draft unchanged and shows the text once. If polishing is skipped before sending or the ACP request ends without a complete reply, the status explains what happened and the reply shows the original. Asking for “only the polished text” shows just Gemini’s text when the rewrite completes. Requests for plain JSON, a single command, or other exact output receive the requested content without labels or status.

When the full reply arrives, the local formatter uses the original draft held in memory to produce the final Markdown. Both the comparison view and text-only delivery preserve Gemini’s chart references, whitespace, and line endings. Codex can retrieve a long formatted message in pages.

## Outgoing Content, Hooks, and Limits

For automatic polishing, trust the plugin's `UserPromptSubmit` hook in Codex (**Settings → Hooks** or `/hooks` in the CLI), then start a fresh chat. Explicit requests to polish the current question and draft work without the hook in both automatic and manual mode. Including earlier exchanges requires the trusted hook in either mode. [Codex plugins](https://developers.openai.com/plugins/build/plugins) · [Codex hooks](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks)

When the OpenAI style check runs, the plugin sends only the current `question`, `draft`, and any custom `editor_prompt` in `input_json.data`. For a whole reply, Gemini receives the original `question` and `draft` and optional `history`. Explicit requests may also include the user’s editing directions in `rewrite_request`. The Antigravity editor role supplies any custom project prompt. All material is sent as written, including any keys or tokens, code, commands, paths, links, quotations and numbers.

For a selected passage or an explicitly requested Gemini version, `--selection` takes the exact text and sends it as `draft`, with the active polishing prompt and any separately requested `rewrite_request`. The surrounding request, original question and chat history stay local. “Only send this passage” uses `--selection-only`. Its ACP message contains only `draft`, and its editor role uses the built-in Turbo prompt. Separate directions and the project prompt stay local.

The trusted hook records the transcript location and current turn locally, even with history set to zero. For repeat rewrites, the local cache stores the source type, turn references and a fingerprint of the displayed reply. It uses the fingerprint to check that the source record matches the transcript. The cache stores no draft text. When you ask to rewrite a GPT original again, the plugin uses the question from the turn where GPT wrote the draft and only the history preceding that turn.

Re-editing a polished selection sends only the visible text of the version you chose, without the surrounding question or chat history, even when a comparison or local source record exists. The same body-only scope applies when you ask to shorten a previous reply that showed only the final text and no longer has a local source record. Codex includes the original question only if you supply the complete exchange or an independent record verifies both the question and the full reply, and it omits any other history. If you ask for the GPT draft and Codex cannot verify it, it asks you to point it out or quote it.

Optional `history` for a whole reply comes from before its original turn and is sent in chronological order. An exchange consists of a user prompt (including follow-up messages within that turn) and Codex's final reply. History carries the text of completed exchanges, including captions on messages with attachments. It excludes the attachments themselves, progress updates, and tool output. User-created forks use their own transcript. A rollback removes the number of recent turns reported by the host. The target question and draft do not count toward the limit of 0–10 exchanges (default 2). With history at zero, an untrusted hook, no usable history, or a request to omit history for this rewrite, the ACP message omits `history`.

OpenAI caps each `input_json.data` at 256 KiB of compact UTF-8 JSON, 32 container levels, and 10,000 values. The plugin puts the current turn’s style check material in one such field and asks one predicate question. Oversized inputs go directly to Gemini in full. The `gpt-6-luna` model card separately lists a context window of 1,050,000 tokens. [Decisions API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create) · [GPT-6 Luna model card](https://developers.openai.com/api/docs/models/gpt-6-luna)

On the Gemini API, the default `gemini-4-hydrogen` model shares a 1,048,576-token window across input, thinking, and output. On Antigravity, session overhead and the selected model also matter. For example, Antigravity lists a window of up to 512K tokens for Gemini 4 Neon. Google’s ACP documentation gives no exact byte limit for a Hydrogen rewrite prompt. Starting in version 1.5.8, `agy` reports context-window usage when it opens a session or changes models. [Hydrogen model card](https://aistudio.google.com/docs/models/gemini-4-hydrogen) · [Antigravity models](https://antigravity.google/docs/models#gemini-4-neon) · [Antigravity CLI 1.5.8](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.8)

The plugin never invokes `agy -p` and writes no draft logs of its own. Codex session logs and provider logs follow their own settings ([Google FAQ](https://antigravity.google/docs/faq)). The dedicated Antigravity editor role disables built-in tools ([Antigravity CLI 1.2.1](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1)), though global Antigravity hooks configured on the machine may still run.

## Handling failures

| Failure Class | Handling |
| --- | --- |
| Unsupported Google authentication, missing agy, Node.js or host process tools | Keep the original. The plugin looks for agy in `PATH` and the Google installer’s default directory (`%LOCALAPPDATA%\agy\bin` on Windows, `~/.local/bin` on macOS and Linux). |
| Decisions unavailable, key invalid, response invalid, or input exceeds the provider limit | Continue to Gemini with the original draft. Each turn makes its own routing decision. |
| ACP startup failure, auth failure, missing selected model, or mid-stream model switch | The agent aborts the rewrite, terminates the process, and delivers the original draft. |
| Slow or interrupted generation | Wait while the ACP process is running. On an explicit timeout, cancellation, disconnect or truncated result, discard incomplete output. A request is sent at most once. |
| Project disabled mid-turn, updated user instructions, or cancellation | Re-checks project mode before sending text out. The agent discards the old candidate on new instructions. User cancellation ends the turn. If only the server cancels while the user waits, the plugin returns the original draft. |

## Installation, Updates, and Uninstall

Install the published npm beta with `npx @kyun.si/codex-polish@beta setup`. Replace `setup` with `update` to upgrade, `doctor` to check the current project, or `uninstall` to remove the plugin. For a source installation, run `node scripts/install.mjs setup` from the root of the GitHub checkout. The same subcommands work there. [Quick Start](../README.md#quick-start)

For a Finder install on macOS, extract the repository archive and double-click [Install Codex Polish.command](../Install%20Codex%20Polish.command). Select the project you want to configure when prompted.

Both `setup` and `update` accept `--install-agy` to install the Google CLI when needed. Updates preserve `.codex` project settings and the plugin’s enabled state. Re-running `update` with the same version replaces the build or recovers an interrupted update.

The installer registers one local marketplace per Codex profile. Updates stage a verified snapshot, atomically switch the marketplace manifest to the new snapshot and refresh the native plugin cache. If the refresh fails, the installer restores the previous snapshot and enabled state. Codex checks the installed plugin’s contents when deciding hook trust. An update to a bundled prompt or setup guide can therefore require a new approval even when the hook command is unchanged. The installer and `doctor` read the current status from `hooks/list`.

If you packed version `0.0.1-beta.8` locally, you can also run `npx --yes file:./kyun.si-codex-polish-0.0.1-beta.8.tgz uninstall` in the directory containing the archive. Uninstall removes the plugin and its marketplace and clears session pointers and prompt file selections for the active Codex profile. It keeps shared `agy` binaries and project `.codex` files. If your prompt file is outside the project or untracked by Git, select it again after reinstalling. The uninstaller prints the backup path for any manually edited installation files.
