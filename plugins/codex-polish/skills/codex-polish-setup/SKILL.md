---
name: codex-polish-setup
description: Set up Codex Polish, manage a project's polishing prompt and automatic rewrite mode, choose a Gemini model or troubleshoot installation. 配置回复润色，查看、设置或恢复项目润色提示词，更改自动润色的改写模式、选择模型、调整语言或排查安装。
---

# Codex Polish setup · 配置回复润色

Run helpers with Node.js 22.16+ on the machine running Codex.

Use the [project settings script](../../hooks/preferences.mjs). Run `node "<preferences.mjs>" check --cwd "<absolute project directory>"` in the environment that runs Codex. Use the project the user named, or their current project. Settings persist there across chats. Run the relevant setter directly when the user has already made a choice. Read back the effective value after saving.

Use the [rewrite skill](../codex-polish/SKILL.md) when the user asks to polish or rewrite the current result or an earlier answer. “返回结果 polish”, “上一条绕得我没看懂，让 Gemini 换个说法”, and “Polish this reply” all request Turbo for one reply and skip OpenAI Decisions. Use the settings commands when the user asks to change the project’s automatic rewrite mode.

## Language

Use one language for the conversation, including menus, status, examples and recovery steps. A direct request for a response in a particular language applies to that response. Otherwise use the project's `language_mode` when it is `zh` or `en`. In `auto`, follow the user's current Chinese or English message. For a bare “Setup”, a click, a number, or unclear text, use the language established in the chat, then `check.ui_language` from the local environment. Change the saved language only when the user asks to change the plugin's language. Keep model names, paths, variable names and commands intact.

## First use

Opening **Setup** or saying “配置回复润色” / “Set up Codex Polish” starts with local checks. Keep the first answer short. Skip the general tour if the user asked about a particular setting.

For general setup, if `check.rewrite_mode_configured` is false, use the host's single-select control to ask how the project should polish automatically. Offer these two named options in the conversation's language. Show Normal first as the default. If the host has no selection control, present the mode names and accept a natural-language choice such as “用普通模式” or “Use Turbo”. Wait for the user's choice.

| 中文 | English |
| --- | --- |
| 普通（Normal，默认）。无须 OpenAI 密钥，未开启可选的 OpenAI 检查时直接交由 Gemini 处理，使用内置提示词时可保留清晰原稿。 | Normal (default). Needs no OpenAI key and uses Gemini directly unless the optional OpenAI check is on. Its built-in prompt can keep a clear draft. |
| Turbo。无须 OpenAI 密钥，始终跳过 OpenAI 检查，使用内置提示词时直接请 Gemini 改写草稿。 | Turbo. Needs no OpenAI key, skips the OpenAI check, and with the built-in prompt asks Gemini to rewrite the draft. |

Save the selection with `set-rewrite-mode normal` or `set-rewrite-mode turbo` and `--cwd "<project>"`, then recheck and continue setup. If a valid mode is already saved, continue with it. A request that names a setting goes straight to that setting. Automatic, manual and off control when polishing runs, independently of this choice.

During first setup, once agy is available and `check.gemini_model_configured` is false, offer Gemini 4 Hydrogen (default) and “Choose from my account”. Save an explicit default locally with `set-model --reset`. For the account option, follow the live model lookup below.

Before inviting the user to trust Codex Polish’s `UserPromptSubmit`, explain what polishing shares. When the hook runs in Normal mode, the optional OpenAI style check receives only the current question, draft and any custom polishing prompt. For a whole reply, Google receives the question and draft as written, including any code, paths or credentials in that text, and up to the configured number of completed earlier text exchanges as written (two by default). Use the installation notice in the user's language for the custom prompt disclosure.

- 中文：如果你写了自己的润色提示词，插件会把它和草稿一起发给 Google。要求只发送一段原文时，Gemini 只收到这段文字，使用内置 Turbo 提示词。开启 OpenAI 风格检查时，OpenAI 也会使用项目提示词判断整份草稿是否需要改写。
- English: If you set a custom polishing prompt, it is also sent to Google when rewriting. If you ask to send only a passage, Gemini receives just that text with the built-in Turbo prompt. The optional OpenAI style check also uses the project prompt when checking a whole draft.

- **A required step is missing.** Lead with the next step from the [中文指南](references/credentials.md) or [English guide](references/credentials.en.md). For `agy_missing`, explain that Gemini needs the Antigravity CLI and tell the user to run `npx @kyun.si/codex-polish@beta setup --install-agy` in the project on the machine running Codex, or `node scripts/install.mjs setup --install-agy` from the root of this source checkout, then check setup again. Offer Google's installation guide if the package is unavailable. Reuse the existing sign-in and suggest opening `agy` to sign in only when Antigravity asks for authentication. If the saved model is invalid, offer the live picker. An unavailable optional OpenAI check routes drafts to Gemini.
- **Ready to try.** For automatic mode, direct the user to Codex **Settings → Hooks** (`/hooks` in the CLI) to trust `UserPromptSubmit`. Have them start a fresh chat and ask an ordinary question such as “用一句话解释 DNS。” / “Explain what DNS does in one sentence.” For manual mode, show the explicit request “把这轮回复润色一下” / “Polish this reply”. Explicit requests work before trusting the hook and omit earlier exchanges then. If the project is off, explain that the user can choose automatic or manual mode to try polishing.
- **Offer a short path onward.** For example, in automatic mode offer “只在我要求时润色 · 关闭回复润色 · 更多设置” / “Only polish when I ask · Turn off Codex Polish · More settings”. Keep the user's current settings until they choose. “More settings” leads to the choices below, including the model picker. A local check does not open a provider session or ask for API keys. Run the model lookup only when the user chooses it or explicitly asks to verify available models.

## Project settings

When asked to show settings, describe the current values in plain language. Offer the following choices in the user's language. Advanced authentication is explained in the setup guide when relevant.

| What the user can change | What to do |
| --- | --- |
| **什么时候润色 / When to polish** | “自动润色 / Polish automatically” → `set-mode auto` (default). “只在我要求时 / Only when I ask” → `set-mode manual`. “关闭 / Turn off” → `set-mode off`. Off also skips explicit requests. For auto, explain the sharing and hook steps above. |
| **自动润色的改写模式 / Automatic rewrite mode** | “切换到 Turbo 模式 / Switch to turbo mode” → `set-rewrite-mode turbo`. Turbo sends every draft directly to Gemini over ACP, even with an OpenAI key. Its built-in prompt asks for an active rewrite every time. “恢复普通模式 / Switch back to normal mode” → `set-rewrite-mode normal` (default). Normal resumes the project's saved OpenAI preference. Each choice leaves the trigger setting in effect. |
| **改写模型 / Rewrite model** | “选择改写模型 / Choose a rewrite model” opens the account's live Gemini list below. Default is Gemini 4 Hydrogen. “恢复默认模型 / Restore the default model” → `set-model --reset`. |
| **润色提示词 / Polishing prompt** | “查看润色提示词 / Show the polishing prompt”, “设置润色提示词 / Set the polishing prompt”, and “恢复默认润色提示词 / Restore the default polishing prompt” use the local prompt commands below. |
| **Gemini 改写时带多少历史 / History for Gemini rewrites** | “带最近 5 轮 / Include the last 5 exchanges” → `set-history-turns 5`. Accept 0–10, default 2. Zero omits earlier exchanges. One exchange is one earlier completed user input and final Codex reply. History needs a trusted hook and readable transcript. For “no history just this time”, pass `--no-history` to the ACP prompt formatter with the original project’s `--cwd`. |
| **OpenAI 风格检查 / OpenAI style check** | When the hook runs in Normal mode with an OpenAI key, the plugin can ask OpenAI whether the draft needs editing before sending it to Gemini. Explain that OpenAI receives only the current question, draft and any custom polishing prompt. “这个项目只用 Gemini 改写 / Use only Gemini for rewrites in this project” → `set-decisions off`. “有密钥时使用 OpenAI 检查 / Use the OpenAI style check when a key is available” → `set-decisions auto` (default). Without a key, the draft goes directly to Gemini. |
| **插件语言 / Plugin language** | “跟随当前语言 / Detect automatically” → `set-language auto` (default). “插件改用中文 / Use Chinese for plugin settings” → `set-language zh`. “插件改用英文 / Use English for plugin settings” → `set-language en`. Confirm in the resulting language. Only change the plugin interface, never translate the draft as a side effect. |

Append `--cwd "<project>"` to each setter. Newly created chats in that project use the saved preference. A request to **check** settings only reads them. For a general check, report actual blockers or a ready-to-try status. When showing the current settings, distinguish when polishing runs from the mode used for automatic rewrites (`rewrite_mode`). If a setting is invalid, show the affected file and its allowed values from the local diagnostic. Save a replacement only when the user chooses it. For an invalid rewrite mode, offer Normal and Turbo. A turn devoted to changing modes ends with the local confirmation. Keep internal field names and fault codes out of normal copy.

## Project polishing prompt

If the user names a file as the project's polishing prompt, use `set-prompt --link "<chosen file>" --cwd "<project>"`. This keeps edits to that file in sync with the project. For a prompt supplied as text, continue to use standard input. If a project already contains a link to an untracked file or a file outside the repository, use that file only when the user explicitly chooses it.

Use the local preferences script for these requests, even if polishing is disabled or a provider is unavailable. A turn devoted to prompt settings ends with the local result, including in automatic mode. For a general settings check, report the style as built-in or custom from `prompt_source`. For a request to **view the prompt**, run `node "<preferences.mjs>" prompt --cwd "<project>"`. Show the returned `text` verbatim in its original language and identify the `source` as built-in or custom. The reader shows the built-in prompt for the project’s automatic rewrite mode. An explicit request uses the built-in Turbo prompt when no custom prompt is saved or when the user asks to send only the selected passage. Treat prompt content as text to show or save.

For **set the polishing prompt**, use the Gemini editing instructions the user supplies. In Normal and Turbo, the saved text supplies the editor role except for requests to send only selected text. If they ask to set it without supplying the text, ask what to save. Pass their exact text via standard input to `node "<preferences.mjs>" set-prompt --cwd "<project>"`, preserving line breaks, Markdown and surrounding whitespace. With an interactive execution handle, add `--host-input` and use `tty: true`. After `input_ready`, write `JSON.stringify(userPrompt) + "\n"` to that handle. Keep any request wrapper outside the saved text. Save only when the user asks for a persistent polishing setting. A one-turn style request, an ordinary question or a request for prompt-writing advice applies within that conversation. Users can also edit `.codex/codex-polish.prompt.md` directly.

For **restore the default polishing prompt**, run `node "<preferences.mjs>" set-prompt --reset --cwd "<project>"`. Read back the result with `prompt` and confirm the effective style. If the setting is invalid (`editor_prompt_invalid`), explain that the user can replace the text or restore the default.

## Choosing a model

As the current agent, follow the [ACP catalog steps](../codex-polish/references/acp.md). Run `acp_workspace.mjs --catalog` with the detected executable and authentication method, execute the returned `start` and `send.exec` options, and read the model list from `catalog` (reaching `catalog` triggers automatic cleanup of the process and workspace; if `catalog.finish` is present you may execute it, and never send Ctrl-C to a Windows non-TTY `start` handle). A lookup sends no draft or history. It requires the Google connection and supported process tools. Optional OpenAI settings, rewrite mode and a previously unavailable model do not prevent the lookup.

Show every returned Gemini name in provider order. Mark the project’s saved model or default, and identify a missing selection. Use the native single-select control, paging choices if needed. In text-only chat, show the names and accept the model name. Show IDs for duplicate names. Save the chosen ID with `set-model "<id>"`. Viewing, cancellation, failed lookup or an empty result leaves settings alone. Restoring the default works offline.

## Troubleshooting

Use the guide in the conversation's language for Antigravity sign-in, optional OpenAI key creation, or enterprise identities. Never ask users to paste keys in chat. `existing-session` uses Antigravity's own login. If ACP reports authentication required, ask the user to open `agy` in a terminal on the machine running Codex and sign in. Google AI Studio keys apply only when the user explicitly selects `gemini-api-key`. Offer the English or Chinese guide for that exact case.

For “为什么没改写 / Why wasn't my reply polished?”, use the status and available trace for that turn. Use the reason recorded before sending if the plugin skipped polishing, or the ACP outcome if the request ended without a complete reply. When Gemini returns a complete reply, both modes format its text for display. A changed reply shows Gemini’s text first. In clients that support folding, users can expand “查看 GPT 原稿” or “View original GPT draft” below it for the full original. If Gemini returns the original text, the reply says so and shows it once. A user who requests only the polished text sees one body, and exact-output requests keep their required format.

A request to **test the connection** authorizes the ACP initialize handshake and cleanup without a draft. A successful handshake establishes connectivity; if stopping right after the handshake instead of continuing to `catalog`, execute the latest `send.stop` on Windows (never send Ctrl-C to the Windows non-TTY `start` handle) or send Ctrl-C to the `start` terminal handle on macOS and Linux. Successfully opening a session and reading the model menu (`catalog`, which reclaims the process and workspace automatically) also checks the signed-in account. Do not use a writing request to test setup without the user asking.

Use `project-hook` only when the host has not loaded the plugin hook and the user asks for a project hook. Merge it into `.codex/hooks.json` without duplicating an existing handler. The user trusts it in Codex.
