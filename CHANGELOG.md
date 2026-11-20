# 更新记录 / Changelog

[中文使用说明](README.md) · [English README](README.en.md)

## Unreleased

- 新增项目改写模式。普通模式（默认）沿用原有流程，Turbo 会跳过 OpenAI，将每份符合条件的草稿直接交给 Gemini，可直接说“切换到 Turbo 模式”或“恢复普通模式”。
- Projects can now choose a rewrite mode. Normal (default) keeps the existing workflow. Turbo skips OpenAI and sends every eligible draft directly to Gemini. Say “Switch to turbo mode” or “Switch back to normal mode”.
- OpenAI 风格检查只使用本轮问题、草稿和已设置的自定义润色提示词。历史问答仅在 Gemini 改写时附带，默认最多 2 轮，可选 0 到 10 轮，历史正文最多 16 KiB。可以要求本轮不带历史。本轮问题和草稿各限 128 KiB，每一步的材料按紧凑 UTF-8 JSON 计最多 256 KiB。Gemini 的材料放不下时先移除最早的完整问答，若本轮内容仍超限则保留原稿。
- The OpenAI style check uses only the current question, draft, and any custom polishing prompt. History goes only to Gemini when it rewrites. Projects can choose 0–10 exchanges (default 2) with up to 16 KiB of history text, or omit history for one rewrite. The question and draft may each contain up to 128 KiB. The plugin limits each step’s material to 256 KiB of compact UTF-8 JSON. It drops the oldest whole exchanges from Gemini’s material first and keeps the original draft if the current material alone exceeds the limit.
- 可以在项目里说“查看润色提示词”“设置润色提示词”或“恢复默认润色提示词”。自定义提示词逐字保存在 `.codex/codex-polish.prompt.md`，供同一项目后续聊天使用。普通和 Turbo 模式都将原文作为 Gemini 的全部编辑指令。可选的 OpenAI 风格检查也会参考它。
- Projects can show, set, or restore the default polishing prompt in chat. Custom prompts are saved verbatim in `.codex/codex-polish.prompt.md` for future chats in the project. Normal and Turbo both use the saved text as Gemini’s complete editing prompt. The optional OpenAI style check also considers it.
- 采用改稿时，在支持折叠的客户端，完整原稿默认收起。点击润色版下方的“查看 GPT 原稿”即可对照。
- When a rewrite changes the text, clients that support folding show the full draft collapsed. Select “View original GPT draft” below the rewrite to compare.
- Gemini 和可选的 OpenAI 风格检查现在直接接收本轮问题和草稿原文，包括代码、路径、链接和数值。OpenAI 只在改写前判断草稿是否需要润色。Gemini 返回的改稿在本地检查后交付。插件仍会跳过检测到疑似凭据或要求固定格式的回合，并检查改稿的 Markdown 结构。
- Gemini and the optional OpenAI style check now receive the current question and draft as written, including code, paths, links, and numbers. OpenAI is called only before rewriting to decide whether the draft needs editing. The plugin checks Gemini’s reply locally before delivery. It still skips detected credentials and exact-output requests and checks the rewrite’s Markdown structure.

## 0.0.1-beta.3

- 聊天里先显示 Gemini 润色版，再附上完整的 GPT 原稿。Gemini 返回原文时会注明，正文只显示一次。跳过或失败时会说明原因并保留原稿。可以单独要求只看润色后的正文。
- Replies show the Gemini rewrite followed by the complete original GPT draft. An unchanged reply appears once with a review label. If polishing skips or fails, the reply identifies the outcome and shows the original. You can ask for just the polished text.

## 0.0.1-beta.2

- 项目没有指定润色模式时，普通提问也会自动触发润色。使用前，在 Codex 中信任插件的 `UserPromptSubmit` 钩子。已选“只在我要求时”或“关闭”的项目会沿用该选择。
- Projects without a saved mode now polish ordinary replies automatically once the `UserPromptSubmit` hook is trusted. Projects set to on-demand or off keep their preference.

## 0.0.1-beta.1

### 简体中文

- 通过 Antigravity 的 `agy` 调用 Gemini 润色 Codex 回复。在 macOS 和 Linux 上使用 Node.js 22.16 或更新版本运行插件，macOS 也支持双击安装。
- 默认按需润色。每个项目可以单独设置触发模式、Gemini 模型和插件界面语言。
- 在 Codex 中信任 `UserPromptSubmit` 钩子后，可以开启自动润色，也可以选择让 Gemini 参考最近几轮已完成的问答。
- 改写时用占位符保护代码、命令、路径、链接和数值。可选的 OpenAI 检查会先判断是否需要润色，再核对改稿是否保留原意。检查失败时交付原稿。

### English

- Polish Codex replies with Gemini through the Antigravity CLI (`agy`). Install with Node.js 22.16+ on macOS or Linux, or double-click the installer on macOS.
- Request a rewrite when you need one. Each project has its own settings for rewrite mode, Gemini model, and interface language.
- Trust the `UserPromptSubmit` hook in Codex to enable automatic rewrites or let Gemini use recent completed exchanges as context.
- Placeholders protect code, commands, paths, links, and numbers. Optional OpenAI checks decide whether a draft needs editing and whether the rewrite preserves its meaning. If a check fails, the plugin keeps the original.
