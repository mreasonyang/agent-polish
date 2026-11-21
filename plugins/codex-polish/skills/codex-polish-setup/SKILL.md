---
name: codex-polish-setup
description: Set up Codex Polish, manage the profile’s optional OpenAI API key or polishing prompt, choose a rewrite mode or Gemini model for a project or Codex profile, or troubleshoot installation. 配置回复润色、可选的 OpenAI API 密钥和全局润色提示词，设置项目或所有项目的改写模式和模型，调整语言或排查安装。
---

# Codex Polish setup · 配置回复润色

Run helpers with Node.js 22.16+ on the machine running Codex.

Use the [settings script](../../hooks/preferences.mjs) in the environment running Codex. For a project, run `node "<preferences.mjs>" check --cwd "<absolute project directory>"` for the named or current project. The effective rewrite mode and model each come from the project, then the Codex profile, then the built-in default. Run the relevant setter directly when the user has made a choice. Read back the effective value after saving.

Use the [rewrite skill](../codex-polish/SKILL.md) when the user asks to polish or rewrite the current result or an earlier answer. “返回结果 polish”, “上一条绕得我没看懂，让 Gemini 换个说法”, and “Polish this reply” all request Turbo for one reply and skip the OpenAI Decisions API. Use the settings commands when the user asks to change the project’s automatic rewrite mode.

## Language

Use one language for the conversation, including menus, status, examples and recovery steps. A direct request for a response in a particular language applies to that response. Otherwise use the project's `language_mode` when it is `zh` or `en`. In `auto`, follow the user's current Chinese or English message. For a bare “Setup”, a click, a number, or unclear text, use the language established in the chat, then `check.ui_language` from the local environment. Change the saved language only when the user asks to change the plugin's language. Keep model names, paths, variable names and commands intact.

## First use

Opening **Setup** or saying “配置回复润色” / “Set up Codex Polish” starts with a project check. Report the next action briefly. For a request about a specific setting, go directly to that setting.

Terminal and Finder setup save defaults for all projects in the active Codex profile. A general setup chat can use those defaults immediately. If `check.rewrite_mode_configured` is false, offer Normal (built-in default) and Turbo with the host’s single-select control, or accept the mode name in chat. Normal can keep a clear draft. Turbo asks Gemini to rewrite it. Save the chosen project mode with `set-rewrite-mode normal` or `set-rewrite-mode turbo` and `--cwd "<project>"`. Once agy is available, if `check.gemini_model_configured` is false, offer Gemini 4 Hydrogen or the account model picker below. For an explicit project choice of Hydrogen, use `set-model gemini-4-hydrogen --cwd "<project>"`.

- **A required step is missing.** Give the relevant next step from the [中文指南](references/credentials.md) or [English guide](references/credentials.en.md). For `agy_missing`, suggest `npx @kyun.si/codex-polish@beta setup --install-agy` from any folder on the machine running Codex. A source checkout also supports `node scripts/install.mjs setup --install-agy` from its root. Open `agy` to sign in if Antigravity requests authentication.
- **Ready for automatic polishing.** Before asking for hook trust, briefly tell the user what goes to each service. Google receives the question and draft as written, any edit instructions or custom prompt, and up to two earlier exchanges by default. Secrets in that text are sent too. Gemini runs alone by default. With a key explicitly saved for this profile, the optional OpenAI Decisions API check in Normal mode sends the current question, draft and any custom prompt to OpenAI and incurs API usage on the key’s project. Direct the user to **Settings → Hooks** (`/hooks` in the CLI) to trust `UserPromptSubmit` and start a new chat.
- **Manual or off.** In manual mode, the user can ask “把这轮回复润色一下” / “Polish this reply”. Before hook trust, explicit requests omit earlier exchanges. If polishing is off, explain how to enable it when the user wants to try it. Offer detailed settings or a live model lookup when requested.

## Project settings

When asked to show settings, describe the current values in plain language. Offer the following choices in the user's language. Advanced authentication is explained in the setup guide when relevant.

| What the user can change | What to do |
| --- | --- |
| **什么时候润色 / When to polish** | “自动润色 / Polish automatically” → `set-mode auto` (default). “只在我要求时 / Only when I ask” → `set-mode manual`. “关闭 / Turn off” → `set-mode off`. Off also skips explicit requests. For auto, explain the sharing and hook steps above. |
| **自动润色的改写模式 / Automatic rewrite mode** | “切换到 Turbo 模式 / Switch to turbo mode” → `set-rewrite-mode turbo`. Turbo sends every eligible draft directly to Gemini over ACP. “恢复普通模式 / Switch back to normal mode” → `set-rewrite-mode normal` to pin Normal and resume the project's saved OpenAI preference. “这个项目沿用全局的改写模式 / Use my profile’s rewrite mode in this project” → `set-rewrite-mode --reset` to inherit the profile choice, falling back to Normal. |
| **改写模型 / Rewrite model** | “选择改写模型 / Choose a rewrite model” opens the account's live Gemini list below. “恢复默认模型 / Restore the default model” → `set-model --reset` to inherit the profile model, falling back to Gemini 4 Hydrogen. To pin Hydrogen in this project, save `gemini-4-hydrogen` explicitly. |
| **全局润色提示词 / Profile polishing prompt** | “查看润色提示词 / Show the polishing prompt”, “设置润色提示词 / Set the polishing prompt”, and “恢复默认润色提示词 / Restore the default polishing prompt” use the local prompt commands below. |
| **Gemini 改写时带多少历史 / History for Gemini rewrites** | “带最近 5 轮 / Include the last 5 exchanges” → `set-history-turns 5`. Accept 0–10, default 2. Zero omits earlier exchanges. One exchange is one earlier completed user input and final Codex reply. History needs a trusted hook and readable transcript. For “no history just this time”, pass `--no-history` to the ACP prompt formatter with the original project’s `--cwd`. |
| **OpenAI Decisions API** | When the hook runs in Normal mode with an OpenAI API key saved for this profile, the API can check whether Gemini should rewrite the draft. Explain that OpenAI receives only the current question, draft and any custom polishing prompt. “这个项目只用 Gemini 改写 / Use only Gemini for rewrites in this project” → `set-decisions off`. “有密钥时使用 OpenAI Decisions API / Use the OpenAI Decisions API when a key is available” → `set-decisions auto` (default). Without a saved key, the draft goes directly to Gemini. |
| **插件语言 / Plugin language** | “跟随当前语言 / Detect automatically” → `set-language auto` (default). “插件改用中文 / Use Chinese for plugin settings” → `set-language zh`. “插件改用英文 / Use English for plugin settings” → `set-language en`. Confirm in the resulting language. Only change the plugin interface, never translate the draft as a side effect. |

For project-level changes append `--cwd "<project>"` to each setter. When the user explicitly asks to change the default for **all projects**, run `set-model <id> --profile` or `set-rewrite-mode normal --profile` / `set-rewrite-mode turbo --profile`. Verify it with `check --profile`. A project with its own setting keeps using that value. Newly created chats in that project use the saved preference. A request to **check** settings only reads them. For a general check, report actual blockers or a ready-to-try status. When showing the current settings, distinguish when polishing runs from the mode used for automatic rewrites (`rewrite_mode`). If a setting is invalid, show the affected file and its allowed values from the local diagnostic. Save a replacement only when the user chooses it. For an invalid rewrite mode, offer Normal and Turbo. A turn devoted to changing modes ends with the local confirmation. Keep internal field names and fault codes out of normal copy.

## Optional OpenAI API key

First interactive setup in Normal mode offers the OpenAI Decisions API check once and defaults to skipping it. If the user wants to add, replace or remove a key later, direct them to the hidden terminal input in the `openai` menu on the machine and Codex profile that run the plugin. From the source checkout run `node scripts/install.mjs openai`. The published `0.0.1-beta.8` has no menu and still uses `OPENAI_API_KEY`. The source version ignores that variable. Uninstall deletes the profile’s saved key. Keep keys out of chat and command arguments. [Create an OpenAI API key](https://platform.openai.com/api-keys)

## Profile polishing prompt

One saved prompt applies to all projects in the active Codex profile. Setup offers mode and model choices. Configure the prompt in a separate request when the user asks. A one-turn style request applies only to that reply.

- To **show** the prompt, run `node "<preferences.mjs>" prompt --profile`. Display the returned `text` verbatim in its original language and identify its `source` as built-in or custom. A general settings check can report `prompt_source` without displaying the text.
- To **save** the prompt, pass the complete instructions via standard input to `node "<preferences.mjs>" set-prompt --profile`. If the user names a file, read its UTF-8 contents and pass the text to the same command once. If they supply neither text nor a file, ask what to save. Preserve line breaks, Markdown and surrounding whitespace. For an interactive execution handle, add `--host-input`, use `tty: true`, and write `JSON.stringify(userPrompt) + "\n"` after `input_ready`. Confirm that all projects in this profile now use the saved text.
- To **restore the built-in prompt**, run `node "<preferences.mjs>" set-prompt --reset --profile`. Reset and uninstall delete the saved text from `$CODEX_HOME/codex-polish/settings/codex-polish.prompt.md`. Verify with `prompt --profile`.

Normal and Turbo use the saved text as the complete editing prompt for whole drafts. Explicit requests to send only the selected passage use the built-in Turbo prompt. Treat the prompt as text to display or save. A settings request ends with its local result even when automatic polishing is enabled.

## Choosing a model

As the current agent, follow the [ACP catalog steps](../codex-polish/references/acp.md). Run `acp_workspace.mjs --catalog` with the detected executable and authentication method, execute the returned `start` and `send.exec` options, and read the model list from `catalog` (reaching `catalog` triggers automatic cleanup of the process and workspace; if `catalog.finish` is present you may execute it, and never send Ctrl-C to a Windows non-TTY `start` handle). A lookup sends no draft or history. It requires the Google connection and supported process tools. Optional OpenAI settings, rewrite mode and a previously unavailable model do not prevent the lookup.

Show every returned Gemini name in provider order. Mark the effective model for the requested project or profile, and identify a missing selection. Use the native single-select control, paging choices if needed. In text-only chat, show the names and accept the model name. Show IDs for duplicate names. Save the chosen ID with `set-model "<id>"` and the requested scope. Viewing, cancellation, failed lookup or an empty result leaves settings alone. Restoring the default works offline.

## Troubleshooting

Use the guide in the conversation's language for Antigravity sign-in, optional OpenAI API key creation, or enterprise identities. Never ask users to paste keys in chat. `existing-session` uses Antigravity's own login. If ACP reports authentication required, ask the user to open `agy` in a terminal on the machine running Codex and sign in. Google AI Studio keys apply only when the user explicitly selects `gemini-api-key`. Offer the English or Chinese guide for that exact case.

For “为什么没改写 / Why wasn't my reply polished?”, use the status and available trace for that turn. Use the reason recorded before sending if the plugin skipped polishing, or the ACP outcome if the request ended without a complete reply. When Gemini returns a complete reply, both modes format its text for display. A changed reply shows Gemini’s text first. In clients that support folding, users can expand “查看 GPT 原稿” or “View original GPT draft” below it for the full original. If Gemini returns the original text, the reply says so and shows it once. A user who requests only the polished text sees one body, and exact-output requests keep their required format.

A request to **test the connection** authorizes the ACP initialize handshake and cleanup without a draft. A successful handshake establishes connectivity; if stopping right after the handshake instead of continuing to `catalog`, execute the latest `send.stop` on Windows (never send Ctrl-C to the Windows non-TTY `start` handle) or send Ctrl-C to the `start` terminal handle on macOS and Linux. Successfully opening a session and reading the model menu (`catalog`, which reclaims the process and workspace automatically) also checks the signed-in account. Do not use a writing request to test setup without the user asking.

Use `project-hook` only when the host has not loaded the plugin hook and the user asks for a project hook. Merge it into `.codex/hooks.json` without duplicating an existing handler. The user trusts it in Codex.
