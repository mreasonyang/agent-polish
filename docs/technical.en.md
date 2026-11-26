# Agent Polish Technical Reference

[简体中文](technical.md) · [Overview](../README.md)

Both Agent Polish plugins run on Windows, macOS, and Linux. Its local scripts use built-in Node.js modules and require Node.js 22.16 or newer. In Codex, the automatic hook directs the agent to follow the [polishing workflow](../plugins/codex-polish/skills/codex-polish/WORKFLOW.md) once the draft is ready and show the result in the final reply. Explicit requests use the same workflow through the [rewrite skill](../plugins/codex-polish/skills/codex-polish/SKILL.md). The [setup skill](../plugins/codex-polish/skills/codex-polish-setup/SKILL.md) checks the environment and manages the current Codex profile’s polishing settings.

## Editing Antigravity replies with Codex

Install the Antigravity plugin with `npx @kyun.si/agy-polish@beta setup`. From a checkout, run `node scripts/agy-cli.mjs setup`. The plugin provides `/polish`, chat-based settings, and a local MCP tool named `polish_reply`. Gemini gives the tool its draft before sending the final message. The tool passes the editing material to the local Codex CLI on standard input and returns the complete text to the same conversation. Most edits use `codex exec`. An ephemeral Codex app-server session handles edits that need an in-memory ChatGPT sign-in.

Antigravity’s mode, Codex model and reasoning effort live in `~/.gemini/config/agy-polish/settings.json`. Terminal and chat settings use the same values. Set `CODEX_POLISH_AGY_SETTINGS_DIR` to choose a separate settings directory. Relative paths start in the user’s home directory. Manual is the default and calls Codex only for an explicit polishing request. Normal lets Codex keep a clear draft, Turbo requests a rewrite, and Off preserves the model preference.

The editor uses the model provider configured in the local Codex CLI. The AGY Polish default is `gpt-6.2-sol` with `xhigh` reasoning. In setup or chat, you can also follow your local Codex settings or choose a model and a supported effort. A custom provider without a catalog offers its configured model. The editor uses a temporary working directory and disables hooks and plugins for its own process to prevent another round of polishing. Antigravity manages its conversation records. The remaining sections describe Gemini editing in Codex.

## Saved settings

Chat, terminal and Finder setup share one set of preferences in the active Codex profile. A change saved from any directory takes effect immediately in all chats that use that profile. Each rewrite still draws its question, draft and optional history from its own chat.

The files below live in `$CODEX_HOME/codex-polish/settings/`. When `CODEX_HOME` is unset, Codex uses `~/.codex`. Each setting uses its built-in default until you choose another value.

| File | Values and Default | Behavior |
| --- | --- | --- |
| `codex-polish.mode` | `manual` (default), `auto`, `off` | In `auto`, the trusted hook triggers polishing for ordinary questions. `manual` runs only on explicit requests. `off` skips automatic and explicit rewrites without contacting Gemini or OpenAI Decisions, while preserving the saved model, thinking level, custom prompt and OpenAI key. |
| `codex-polish.rewrite-mode` | `normal` (built-in default), `turbo` | Applies only to the automatic hook. Neither mode needs an OpenAI key, and without the check both send drafts to Gemini. With the built-in prompts, `normal` can keep a clear draft and optionally checks with OpenAI Decisions, while `turbo` skips Decisions and asks Gemini to rewrite the draft. |
| `codex-polish.model` | Gemini model and thinking level, default `gemini-4-hydrogen` with `medium` | The picker offers the thinking levels available for the chosen model. Both Normal and Turbo apply the saved pair. If the model or level becomes unavailable, the rewrite keeps the original draft. |
| `codex-polish.history-turns` | Integer `0`–`10`, default `2` | Maximum completed exchanges to attach when Gemini rewrites a whole reply. Use `0` to omit earlier exchanges. Saving a value above `10` returns an error. An invalid setting reports the file and the allowed range. Changes apply on the next rewrite. |
| `codex-polish.decisions` | `auto` (default), `off` | For hook-triggered polishing in Normal mode, `auto` enables the OpenAI style check when this Codex profile has a saved plugin key that passes the local format check. With `off`, drafts go directly to Gemini. |
| `codex-polish.language` | `auto` (default), `zh`, `en` | Sets the language for plugin prompts and setup checks. |

Trigger mode, automatic rewrite mode, and Decisions accept mixed-case settings. Decisions also accepts `on` to enable the check. Diagnostics identify an invalid setting and list the allowed values.

Say “Switch to Turbo mode” to save Turbo for automatic rewrites. From a source checkout, run `node plugins/codex-polish/hooks/preferences.mjs set-rewrite-mode turbo`. Use `normal` to switch back. Run `node plugins/codex-polish/hooks/preferences.mjs check` to see the current settings. During a rewrite, `check` can also take `--cwd` for diagnostics about that turn. An invalid rewrite mode pauses automatic polishing until you save a valid mode. Explicit requests still use Turbo.

The command `set-model gemini-4-hydrogen --thinking-level high` saves the model and thinking level together. Use `set-model --reset` to restore Gemini 4 Hydrogen with Medium thinking, or `set-rewrite-mode --reset` to restore Normal for automatic polishing.

“Polish the result” applies to the current draft. “Have Gemini rewrite the answer about caching” selects an earlier reply in the same chat. Both use `--trigger explicit` and send the selected draft directly to Gemini over ACP in Turbo mode. The request applies once and works in either `auto` or `manual`. Codex interprets requests in context, so “What does Turbo do?” asks for an explanation. The hook uses `--trigger auto` on ordinary questions and uses the saved rewrite mode. The `off` setting skips both triggers.

When `codex-polish.language` is `auto`, chat prompts match the user's current message, falling back to the established chat language and then the system locale. Short replies such as menu numbers use the chat language. Setup menus and diagnostics use the saved language setting. In automatic mode, terminal prompts follow the system locale and fall back to English.

### Show, set, or restore the polishing prompt

The active Codex profile uses one custom polishing prompt. Ask “Show my polishing prompt”, “Set my polishing prompt to: Lead with the conclusion, then give the evidence”, or “Restore the default polishing prompt”. Setup uses the built-in editing instructions until you choose to save your own. For whole drafts, your text replaces the full built-in prompt in Normal and Turbo. An explicit request to send only a passage uses the built-in Turbo prompt.

The following commands show, save and reset the profile prompt. `set-prompt` copies the full UTF-8 text from standard input to `$CODEX_HOME/codex-polish/settings/codex-polish.prompt.md`, including line breaks and surrounding whitespace. Import a file again to pick up later changes. Reset and uninstall both delete the stored copy.

```sh
node plugins/codex-polish/hooks/preferences.mjs prompt
node plugins/codex-polish/hooks/preferences.mjs set-prompt < my-prompt.md
node plugins/codex-polish/hooks/preferences.mjs set-prompt --reset
```

From Windows PowerShell, pass the file’s raw bytes through Node to preserve its UTF-8 text and line endings.

```powershell
node -e "child_process.execFileSync(process.execPath, ['plugins/codex-polish/hooks/preferences.mjs', 'set-prompt'], { input: fs.readFileSync(process.argv[1]), stdio: ['pipe', 'inherit', 'inherit'] })" "C:\path\to\my-prompt.md"
```

## Rewrite Routes, Stages, and Thresholds

- **Direct ACP.** Explicit requests and automatic Turbo rewrites use this route, even with an OpenAI key. The built-in Turbo prompt asks Gemini to actively rewrite each draft. Normal mode also uses Gemini alone when the profile has no usable OpenAI key. Setting `codex-polish.decisions` to `off` has the same effect.
- **OpenAI Decisions and ACP.** For automatic polishing in Normal mode with `codex-polish.decisions` set to `auto` and a key saved in this profile, the plugin checks the key’s format locally before contacting OpenAI. It sends one request to `gpt-6-luna` to decide whether the draft needs editing. [Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create)

| Stage | Behavior |
| --- | --- |
| 1. Select the text | Codex uses the current draft, an earlier answer, or a selected passage, as requested. If you ask it to skip polishing, keep the text local, or return a verbatim answer, it follows that request directly. |
| 2. Style check | Direct ACP sends the selected text to Gemini. With Decisions enabled, OpenAI considers only the current question, draft, and any custom polishing prompt. Gemini rewrites when `P(needs rewrite) > 0.50`. |
| 3. ACP rewrite | Gemini loads the polishing prompt for this request from the body of the editor role. The agent launches `agy acp` in a temporary workspace under a dedicated editor role, opens a session with the configured Antigravity identity, selects the saved model and confirms its thinking level before sending. It rejects tool permission requests and collects only reply text from this session. The reply is ready to display once the agent has nonempty text and an `end_turn` matching the request ID. |
| 4. Display | Identical replies appear once. The comparison keeps both versions if their indentation, whitespace, or line endings differ. |

The Codex agent starts the official executable and sends each request directly. With terminal-only tools on macOS, Linux and Windows, it redirects the provider’s stdout to a private temporary file. If a tool clips a page, the agent can reread it from the same byte offset. During setup it skips the provider’s list of available commands and waits for confirmation of the selected model and thinking level before sending the draft. The agent deletes the temporary file when the session ends. A forced host shutdown can leave it behind.

During a rewrite, `agy` connects to Google. The plugin's Node.js scripts contact a provider only for the optional OpenAI style check. The current Codex agent starts and cleans up the ACP process, selects the model and thinking level, and exchanges protocol messages. [ACP operating instructions](../plugins/codex-polish/skills/codex-polish/references/acp.md)

The plugin requires the official Antigravity CLI 1.2.1 or later. By default it reuses the existing Antigravity sign-in on the machine and OS account running Codex. To use an AI Studio key or an enterprise identity, set `CODEX_POLISH_AGY_AUTH` to `gemini-api-key` or `agent-platform`, respectively. [Sign-in guide](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Google ACP authentication](https://antigravity.google/docs/ide/extensions/acp)

## What Appears in the Final Reply

When Gemini changes a reply, the final message starts with the rewritten text. In the Codex app, select “Rewritten by Gemini · View original GPT draft” underneath to expand the full draft. For a selected passage or an earlier Gemini version, “Rewritten by Gemini · View original text” opens the exact text submitted for editing. Drafts retain their Markdown formatting. When a draft contains disclosure tags or container delimiters, the expanded view shows its Markdown source so you can read those markers verbatim.

During automatic polishing, you see only the original if Decisions keeps the draft or Gemini returns it verbatim. When you explicitly ask for a rewrite and Gemini returns identical wording, the text appears once with the sentence “Gemini returned the original draft.” For a selected passage, the sentence reads “Gemini returned the original text.”

If polishing cannot run or ACP fails to return a complete reply, you see the original and a brief reason. When you request only the body, you receive the rewritten text on success or the original if it is kept or the rewrite fails. Requests for plain JSON, a single command, or other exact output take precedence.

When the full reply arrives, the local formatter uses the original draft retained by the Codex agent to produce the final Markdown. Both the comparison view and text-only delivery preserve Gemini’s chart references, whitespace, and line endings. Codex can retrieve a long formatted message in pages.

## Outgoing Content, Hooks, and Limits

For automatic polishing, trust the plugin's `UserPromptSubmit` hook in Codex (**Settings → Hooks** or `/hooks` in the CLI), then start a fresh chat. Explicit requests to polish the current question and draft work without the hook in both automatic and manual mode. Including earlier exchanges requires the trusted hook in either mode. [Codex plugins](https://developers.openai.com/plugins/build/plugins) · [Codex hooks](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks)

When the OpenAI style check runs, the plugin sends only the current `question`, `draft`, and any custom `editor_prompt` in `input_json.data`. For a whole reply, Gemini receives the original `question` and `draft` and optional `history`. Explicit requests may also include the user’s editing directions in `rewrite_request`. The Antigravity editor role supplies any custom profile prompt. All material is sent as written, including any keys or tokens, code, commands, paths, links, quotations and numbers.

For a selected passage or an explicitly requested Gemini version, `--selection` takes the exact text and sends it as `draft`, with the active polishing prompt and any separately requested `rewrite_request`. The surrounding request, original question and chat history stay local. “Only send this passage” uses `--selection-only`. Its ACP message contains only `draft`, and its editor role uses the built-in Turbo prompt. Separate directions and the profile prompt stay local.

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
| ACP startup failure, auth failure, unavailable model or thinking level, or mid-stream configuration change | The agent aborts the rewrite, terminates the process, and delivers the original draft. |
| Slow or interrupted generation | Wait while the ACP process is running. If a terminal read clips a page, reread from the same byte offset. On an explicit timeout, cancellation, disconnect, a malformed frame, or process exit with the expected response still missing, discard incomplete output and keep the original draft. The brief reason distinguishes failures before sending, after submission, or when delivery is unknown, and the same draft is submitted at most once. |
| Polishing disabled mid-turn, updated user instructions, or cancellation | The plugin checks the current trigger mode before sending text out. The agent discards the old candidate on new instructions. User cancellation ends the turn. If only the server cancels while the user waits, the plugin returns the original draft. |

## Installation, Updates, and Uninstall

Install Codex Polish from npm in any folder with `npx @kyun.si/codex-polish@beta setup`. Run `npx @kyun.si/codex-polish@beta doctor` to check the plugin settings and local environment, `npx @kyun.si/codex-polish@beta update` to upgrade, or `npx @kyun.si/codex-polish@beta uninstall` to remove the plugin. In Windows PowerShell, use `npx.cmd` for these commands. From a source checkout, run `node scripts/install.mjs setup` from its root. The same subcommands work there. [Quick Start](../README.md#quick-start)

On macOS, you can also double-click the launcher in the extracted Codex Polish archive. Interactive setup offers Normal, Turbo, manual polishing and Off. When polishing is on, you can then choose a Gemini model and thinking level. Run `setup` again or say “Set up Codex Polish” in a Codex chat to change these settings. [Finder launcher](../Install%20Codex%20Polish.command)

Both `setup` and `update` accept `--install-agy` to install the Google CLI when needed. Updates skip the settings menus and preserve your saved settings and the plugin’s enabled state. Re-running `update` with the same version replaces the build or recovers an interrupted update.

The installer registers one local marketplace per Codex profile. Updates stage a verified snapshot, atomically switch the marketplace manifest to the new snapshot and refresh the native plugin cache. If the refresh fails, the installer restores the previous snapshot and enabled state. Codex checks the installed plugin’s contents when deciding hook trust. An update to a bundled prompt or setup guide can therefore require a new approval even when the hook command is unchanged. The installer and `doctor` read the current status from `hooks/list`.

Normal mode sends drafts directly to Gemini by default. To enable the optional OpenAI Decisions API check or manage its key, run `npx @kyun.si/codex-polish@beta openai` on the machine and Codex profile that run the plugin. In Windows PowerShell, use `npx.cmd`. Hidden terminal input saves the key to `$CODEX_HOME/codex-polish/credentials/openai.key`. The plugin ignores `OPENAI_API_KEY`. [Credential setup and API billing](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md#optional-openai-decisions-api)

Uninstall removes the plugin, its marketplace and the session pointers. It clears all plugin preferences for this Codex profile, deletes the saved custom prompt and OpenAI key, and removes empty lock files and empty plugin directories left by older versions. It also deletes settings files that older versions registered in individual folders if the recorded file is still in place. This includes Git-tracked files and files edited in place. Unrelated files you placed there and the shared `agy` installation are kept.

Manually edited installation source snapshots can be kept in place with their locations printed, while a modified native plugin cache may be moved to a backup directory with its backup path printed. If an installation command from 0.0.1 is still running, wait for it to finish before running a new one. To run an uninstaller from a locally packed release, substitute the archive path for the npm package name, for example `npx --yes file:./kyun.si-codex-polish-VERSION.tgz uninstall`.
