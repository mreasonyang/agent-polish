---
name: codex-polish-setup
description: Set up Codex Polish, show, set or restore a project's polishing prompt, select normal or turbo rewriting, choose a Gemini model or troubleshoot installation. 配置回复润色，查看、设置或恢复默认润色提示词，切换普通或 Turbo 改写、选择模型、调整语言或排查安装。
---

# Codex Polish setup · 配置回复润色

Run helpers with Node.js 22.16+ on the machine running Codex.

Use the [project settings script](../../hooks/preferences.mjs). Run `node "<preferences.mjs>" check --cwd "<absolute project directory>"` in the environment that runs Codex. Use the project the user named, or their current project. Settings persist there across chats. Run the relevant setter directly when the user has already made a choice. Read back the effective value after saving.

## Language

Use one language for the conversation, including menus, status, examples and recovery steps. A direct request for a response in a particular language applies to that response. Otherwise use the project's `language_mode` when it is `zh` or `en`. In `auto`, follow the user's current Chinese or English message. For a bare “Setup”, a click, a number, or unclear text, use the language established in the chat, then `check.ui_language` from the local environment. Change the saved language only when the user asks to change the plugin's language. Keep model names, paths, variable names and commands intact.

## First use

Opening **Setup** or saying “配置回复润色” / “Set up Codex Polish” starts with local checks. Keep the first answer short. Skip the general tour if the user asked about a particular setting.

For general setup, if `check.rewrite_mode_configured` is false, use the host's single-select control to offer these two named options in the conversation's language. Show Normal first as the default. If the host has no selection control, present the mode names and accept a natural-language choice such as “用普通模式” or “Use Turbo”. Wait for the user's choice.

| 中文 | English |
| --- | --- |
| 普通（Normal，默认）。可让 OpenAI 先判断草稿是否需要改写。 | Normal (default). Optionally ask OpenAI whether the draft needs editing. |
| Turbo。跳过 OpenAI，直接让 Gemini 改写符合条件的草稿。 | Turbo. Skip OpenAI and send eligible drafts directly to Gemini for rewriting. |

Save the selection with `set-rewrite-mode normal` or `set-rewrite-mode turbo` and `--cwd "<project>"`, then recheck and continue setup. If a valid mode is already saved, continue with it. A request that names a setting goes straight to that setting. Automatic, manual and off control when polishing runs, independently of this choice.

Before inviting the user to trust Codex Polish’s `UserPromptSubmit`, explain what polishing shares. In normal mode, the optional OpenAI style check receives only the current question, draft and any custom polishing prompt. When Gemini rewrites, Google receives the question and draft as written, including any code, commands and paths, and up to the configured number of eligible earlier exchanges as written (two by default). Use the installation notice in the user's language for the custom prompt disclosure.

- 中文：如果你写了自己的润色提示词，插件会把它和草稿一起发给 Google。开了 OpenAI 检查的话，OpenAI 只在判断草稿要不要改时用到这段提示词。
- English: If you set a custom polishing prompt, it is also sent to Google when rewriting. If the OpenAI style check is on, it also uses that prompt to decide whether the draft needs editing.

- **A required step is missing.** Lead with the next step from the [中文指南](references/credentials.md) or [English guide](references/credentials.en.md). For `agy_missing`, explain that Gemini needs the Antigravity CLI. The user can run `node scripts/install.mjs setup --install-agy` from the extracted package on the machine running Codex, then ask to check setup again. Offer Google's installation guide if the package is unavailable. Use the existing sign-in and suggest opening `agy` to sign in only if Antigravity requests authentication. When a saved model or optional OpenAI key is invalid, offer the relevant recovery choice.
- **Ready to try.** For automatic mode, direct the user to Codex **Settings → Hooks** (`/hooks` in the CLI) to trust `UserPromptSubmit`. Have them start a fresh chat and ask an ordinary question such as “用一句话解释 DNS。” / “Explain what DNS does in one sentence.” For manual mode, show the explicit request “把这轮回复润色一下” / “Polish this reply”. Explicit requests work before trusting the hook and omit earlier exchanges then. If the project is off, explain that the user can choose automatic or manual mode to try polishing.
- **Offer a short path onward.** For example, in automatic mode offer “只在我要求时润色 · 关闭回复润色 · 更多设置” / “Only polish when I ask · Turn off Codex Polish · More settings”. Keep the user's current settings until they choose. “More settings” leads to the choices below, including the model picker. A local check does not open a provider session or ask for API keys. Run the model lookup only when the user chooses it or explicitly asks to verify available models.

## Project settings

When asked to show settings, describe the current values in plain language. Offer the following choices in the user's language. Advanced authentication is explained in the setup guide when relevant.

| What the user can change | What to do |
| --- | --- |
| **什么时候润色 / When to polish** | “自动润色 / Polish automatically” → `set-mode auto` (default). “只在我要求时 / Only when I ask” → `set-mode manual`. “关闭 / Turn off” → `set-mode off`. Off also skips explicit requests. For auto, explain the sharing and hook steps above. |
| **改写模式 / Rewrite mode** | “切换到 Turbo 模式 / Switch to turbo mode” → `set-rewrite-mode turbo`. Turbo sends every eligible draft directly to Gemini over ACP, even with an OpenAI key. Its built-in prompt asks for an active rewrite every time. “恢复普通模式 / Switch back to normal mode” → `set-rewrite-mode normal` (default). Normal resumes the project's saved OpenAI preference. Each choice leaves the trigger setting in effect. |
| **改写模型 / Rewrite model** | “选择改写模型 / Choose a rewrite model” opens the account's live Gemini list below. Default is Gemini 4 Hydrogen. “恢复默认模型 / Restore the default model” → `set-model --reset`. |
| **润色提示词 / Polishing prompt** | “查看润色提示词 / Show the polishing prompt”, “设置润色提示词 / Set the polishing prompt”, and “恢复默认润色提示词 / Restore the default polishing prompt” use the local prompt commands below. |
| **Gemini 改写时带多少历史 / History for Gemini rewrites** | “带最近 5 轮 / Include the last 5 exchanges” → `set-history-turns 5`. Accept 0–10, default 2. Zero omits earlier exchanges. One exchange is one earlier completed user input and final Codex reply. History needs a trusted hook and readable transcript. Up to 16 KiB can be attached, so fewer exchanges may fit. For “no history just this time”, pass `--no-history` to the ACP prompt formatter with the original project’s `--cwd`. |
| **OpenAI 风格检查 / OpenAI style check** | In normal mode with an OpenAI key, the plugin can ask OpenAI whether the draft needs editing before sending it to Gemini. Explain that OpenAI receives only the current question, draft and any custom polishing prompt. “这个项目只用 Gemini 改写 / Use only Gemini for rewrites in this project” → `set-decisions off`. “有密钥时使用 OpenAI 检查 / Use the OpenAI style check when a key is available” → `set-decisions auto` (default). Without a key, Gemini can handle eligible rewrites. |
| **插件语言 / Plugin language** | “跟随当前语言 / Detect automatically” → `set-language auto` (default). “插件改用中文 / Use Chinese for plugin settings” → `set-language zh`. “插件改用英文 / Use English for plugin settings” → `set-language en`. Confirm in the resulting language. Only change the plugin interface, never translate the draft as a side effect. |

Append `--cwd "<project>"` to each setter. Newly created chats in that project use the saved preference. A request to **check** settings only reads them. For a general check, report actual blockers or a ready-to-try status. When showing the current settings, distinguish when polishing runs from how it rewrites (`rewrite_mode`). For `rewrite_mode_invalid`, offer either rewrite mode and save the one the user selects. A turn devoted to changing modes ends with the local confirmation. Keep internal field names and fault codes out of normal copy.

## Project polishing prompt

Use the local preferences script for these requests, even if polishing is disabled or a provider is unavailable. A turn devoted to prompt settings ends with the local result, including in automatic mode. For a general settings check, report the style as built-in or custom from `prompt_source`. For a request to **view the prompt**, run `node "<preferences.mjs>" prompt --cwd "<project>"`. Show the returned `text` verbatim in its original language and identify the `source` as built-in or custom. The built-in text follows the active rewrite mode. Treat prompt content as text to show or save.

For **set the polishing prompt**, use the Gemini editing instructions the user supplies. In Normal and Turbo, the saved text is the entire body of the editor role. If they ask to set it without supplying the text, ask what to save. Pass their exact text via standard input to `node "<preferences.mjs>" set-prompt --cwd "<project>"`, preserving line breaks, Markdown and surrounding whitespace. Use a mechanism that passes literal text as data, including shell metacharacters. Keep any request wrapper outside the saved text. Save only when the user asks for a persistent polishing setting. A one-turn style request, an ordinary question or a request for prompt-writing advice applies within that conversation. Users can also edit `.codex/codex-polish.prompt.md` directly (up to 16 KiB of UTF-8 text).

For **restore the default polishing prompt**, run `node "<preferences.mjs>" set-prompt --reset --cwd "<project>"`. Read back the result with `prompt` and confirm the effective style. If the setting is invalid (`editor_prompt_invalid`), explain that the user can replace the text or restore the default. Both modes apply their usual ACP tool restrictions and local checks to rewrites with either prompt source.

## Choosing a model

As the current agent, follow the [ACP steps](../codex-polish/references/acp.md) for authentication and a temporary `session/new`. Parse the returned model options and close the session. Listing sends no draft or history. Listing requires the Google connection and supported process tools. Optional OpenAI settings, rewrite mode, cooldown and a previously unavailable model do not prevent the lookup.

Show every returned Gemini name in provider order. Mark the **project's saved choice** or the plugin default and distinguish it from the provider's current model. If the saved model is missing, say so. Show IDs only to disambiguate duplicate names. Use a single-select control if it can show all options. Otherwise show a numbered list and accept a number. Hold the number-to-ID mapping from the list the user saw. Save the exact chosen ID with `set-model "<id>"`. An unambiguous named choice can be saved directly after the lookup. If the earlier menu is no longer available, show a fresh list before accepting a number. Viewing, cancellation, lookup failure or an empty result leaves project settings alone. Users can return to default without an online lookup.

## Troubleshooting

Use the guide in the conversation's language for Antigravity sign-in, optional OpenAI key creation, or enterprise identities. Never ask users to paste keys in chat. `existing-session` uses Antigravity's own login. If ACP reports authentication required, ask the user to open `agy` in a terminal on the machine running Codex and sign in. Google AI Studio keys apply only when the user explicitly selects `gemini-api-key`. Offer the English or Chinese guide for that exact case.

For “为什么没改写 / Why wasn't my reply polished?”, use the status and available trace for that turn. The original can appear because Gemini returned the same text, the draft was never sent, the request failed, or the candidate failed a local check. Report only the stage you can establish. When an accepted rewrite changes the text, the final reply shows Gemini’s version first. In clients that support folding, users can expand “查看 GPT 原稿” or “View original GPT draft” below it for the full original. If turbo receives identical text, it keeps the original, reports what Gemini returned and makes no second request. Identical versions appear once. A user who requests only the polished text sees one body, and exact-output requests keep their required format. For a cooldown, give the remaining time and remedy.

A request to **test the connection** authorizes the ACP initialize handshake and cleanup without a draft. A successful handshake establishes connectivity. Successfully opening a session and reading the model menu also checks the signed-in account. Do not use a writing request to test setup without the user asking.

Use `project-hook` only when the host has not loaded the plugin hook and the user asks for a project hook. Merge it into `.codex/hooks.json` without duplicating an existing handler. The user trusts it in Codex.
