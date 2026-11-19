---
name: codex-polish-setup
description: Set up Codex Polish, view or change project settings, choose a Gemini model, or troubleshoot installation. 设置回复润色、选择模型、调整语言，或排查插件问题。
---

# Codex Polish setup · 配置回复润色

Run helpers with Node.js 22.16+ on the machine running Codex.

Use the [project settings script](../../hooks/preferences.mjs). Run `node "<preferences.mjs>" check --cwd "<absolute project directory>"` in the environment that runs Codex. Use the project the user named, or their current project. Settings persist there across chats. Run the relevant setter directly when the user has already made a choice. Read back the effective value after saving.

## Language

Use one language for the conversation, including menus, status, examples and recovery steps. A direct request for a response in a particular language applies to that response. Otherwise use the project's `language_mode` when it is `zh` or `en`. In `auto`, follow the user's current Chinese or English message. For a bare “Setup”, a click, a number, or unclear text, use the language established in the chat, then `check.ui_language` from the local environment. Change the saved language only when the user asks to change the plugin's language. Keep model names, paths, variable names and commands intact. The language of polished replies follows the draft.

## First use

Opening **Setup** or saying “配置回复润色” / “Set up Codex Polish” starts with local checks. Keep the first answer short. Skip the general tour if the user asked about a particular setting.

At first use, explain that the current reply can be polished manually. To include earlier exchanges or use automatic rewrites, the user must trust Codex Polish’s `UserPromptSubmit` in Codex **Settings → Hooks** (`/hooks` in the CLI), then start a new chat. Automatic rewriting also needs auto mode enabled for that project.

- **A required step is missing.** Lead with the next step from the [中文指南](references/credentials.md) or [English guide](references/credentials.en.md). For `agy_missing`, explain that Gemini needs the Antigravity CLI. The user can run `node scripts/install.mjs setup --install-agy` from the extracted package on the machine running Codex, then ask to check setup again. Offer Google's installation guide if the package is unavailable. Use the existing sign-in and suggest opening `agy` to sign in only if Antigravity requests authentication. When a saved model or optional OpenAI key is invalid, offer the relevant recovery choice.
- **Ready to try in the default mode.** Give one example that works in a fresh chat: “用一句话解释 DNS，再把你的回复润色一下。” / “Explain what DNS does in one sentence, then polish your reply.” Say that polishing sends the question and draft to Google and can include the last two completed exchanges by default. For existing projects, report their actual mode and history count. A healthy project that is off should get the action to turn on on-demand polishing. If it already uses automatic polishing, explain that it applies to eligible replies.
- **Offer a short path onward.** For example, “直接试用 · 自动润色 · 更多设置” / “Try it · Polish automatically · More settings”. Keep the user's current settings until they choose. “Try it” can run the example if the user chooses it. “More settings” leads to the choices below, including the model picker. A local check does not open a provider session or ask for API keys. Run the model lookup only when the user chooses it or explicitly asks to verify available models.

## Project settings

When asked to show settings, describe the current values in plain language. Offer the following choices in the user's language. Advanced authentication is explained in the setup guide when relevant.

| What the user can change | What to do |
| --- | --- |
| **什么时候润色 / When to polish** | “只在我要求时 / Only when I ask” → `set-mode manual` (default). “自动润色 / Polish automatically” → `set-mode auto`. “关闭 / Turn off” → `set-mode off`. Append `--cwd "<project>"`. Off also skips explicit requests. For auto, explain which question, draft and history can go to Google, and which material goes to OpenAI when enabled. Help the user trust the plugin's `UserPromptSubmit` hook in Settings → Hooks (CLI: `/hooks`) and start a fresh chat. |
| **改写模型 / Rewrite model** | “选择改写模型 / Choose a rewrite model” opens the account's live Gemini list below. Default is Gemini 4 Hydrogen. “恢复默认模型 / Restore the default model” → `set-model --reset`. |
| **带多少对话历史 / Conversation history** | “带最近 5 轮 / Include the last 5 exchanges” → `set-history-turns 5`. Accept 0–10, default 2. Zero sends just the current question and draft. One exchange is one earlier completed user input and final Codex reply. History needs a trusted hook and readable transcript. Up to 16 KiB can be attached, so fewer exchanges may fit. For “no history just this time”, omit `--cwd` from the ACP prompt formatter for this rewrite only. |
| **额外检查 / Extra OpenAI checks** | Explain what the choice does in ordinary words. With an OpenAI key, OpenAI checks whether editing is worthwhile and whether the result keeps the meaning. “这个项目只用 Gemini 改写 / Use only Gemini for rewrites in this project” → `set-decisions off`. “有密钥时使用 OpenAI 检查 / Use OpenAI checks when a key is available” → `set-decisions auto` (default). Without a key, Gemini can handle eligible rewrites. OpenAI receives current material only. |
| **插件语言 / Plugin language** | “跟随当前语言 / Detect automatically” → `set-language auto` (default). “插件改用中文 / Use Chinese for plugin settings” → `set-language zh`. “插件改用英文 / Use English for plugin settings” → `set-language en`. Confirm in the resulting language. Only change the plugin interface, never translate the draft as a side effect. |

Append `--cwd "<project>"` to each setter. Newly created chats in that project use the saved preference. A request to **check** settings only reads them. For a general check, report actual blockers or a ready-to-try status, then summarize what the user asked to see. Keep internal field names and fault codes out of normal copy.

## Choosing a model

As the current agent, follow the [ACP steps](../codex-polish/references/acp.md) for authentication and a temporary `session/new`. Parse the returned model options and close the session. Listing sends no draft or history. Listing requires the Google connection and supported process tools. Optional OpenAI settings, rewrite mode, cooldown and a previously unavailable model do not prevent the lookup.

Show every returned Gemini name in provider order. Mark the **project's saved choice** or the plugin default and distinguish it from the provider's current model. If the saved model is missing, say so. Show IDs only to disambiguate duplicate names. Use a single-select control if it can show all options. Otherwise show a numbered list and accept a number. Hold the number-to-ID mapping from the list the user saw. Save the exact chosen ID with `set-model "<id>"`. An unambiguous named choice can be saved directly after the lookup. If the earlier menu is no longer available, show a fresh list before accepting a number. Viewing, cancellation, lookup failure or an empty result leaves project settings alone. Users can return to default without an online lookup.

## Troubleshooting

Use the guide in the conversation's language for Antigravity sign-in, optional OpenAI key creation, or enterprise identities. Never ask users to paste keys in chat. `existing-session` uses Antigravity's own login. If ACP reports authentication required, ask the user to open `agy` in a terminal on the machine running Codex and sign in. Google AI Studio keys apply only when the user explicitly selects `gemini-api-key`. Offer the English or Chinese guide for that exact case.

For “为什么没改写 / Why wasn't my reply polished?”, distinguish local setup issues, manual/off mode, deliberate fixed-format output and later provider failures. If OpenAI checks are active, an already clear draft or a change in meaning can also keep the original. Use actionable wording for the actual cause. For a cooldown, give the remaining time and remedy. A request to **test the connection** authorizes the ACP initialize handshake and cleanup without a draft. A successful handshake establishes connectivity. Successfully opening a session and reading the model menu also checks the signed-in account. Do not use a writing request to test setup without the user asking.

Use `project-hook` only when the host has not loaded the plugin hook and the user asks for a project hook. Merge it into `.codex/hooks.json` without duplicating an existing handler. The user trusts it in Codex.
