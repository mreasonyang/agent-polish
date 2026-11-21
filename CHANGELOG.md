# 更新记录 / Changelog

[中文使用说明](docs/README.zh-CN.md) · [English README](README.md)

## 0.0.1-beta.8

- Windows 用户可以从 PowerShell 安装、更新和卸载插件。Codex 通过本机的 `agy.exe acp` 改写回复，可以使用自动钩子、选择模型和取回长回复。
- Windows users can install, update, or uninstall from PowerShell. Codex uses the native `agy.exe acp` for rewrites, including automatic polishing, model selection, and paged delivery for long replies.

- 修复多个 Windows 会话同时保存同一项目设置时偶发的写入失败。
- Fixed an intermittent Windows error when multiple sessions saved the same project setting at once.

## 0.0.1-beta.6

- 修复了自动润色时 ACP 消息被截断或多条消息被当成一条读取的问题。收到完整回复时直接排好最终消息，长回复可分页取回，交付前无需手动清理。
- Fixed truncated ACP input and misread batches of replies during automatic polishing. Completed rewrites now arrive as formatted Markdown. Codex can retrieve long replies in pages and deliver them without a separate cleanup command.

- 再次润色选段时只发送上次选定版本的正文。历史保留带附件消息的文字，支持用户分叉与按轮撤回。排版交付 Gemini 原文，包括图表标记。
- Editing a polished passage again sends a single version. History keeps attachment captions, reads user forks, and follows the host’s rollback count. Gemini’s reply is delivered verbatim, including chart markers.
- 选模使用账号返回的 Gemini ID 和显示名。手写设置支持大小写，配置无效时给出原因。项目可链接共用提示词，自动 hook 只提醒当前用户会话。
- The model picker uses the account’s Gemini IDs and display names. Settings accept mixed case and report invalid values. Projects can link shared prompts, and the automatic hook ignores events for subagents or other sessions.

- 移除了按正文内容跳过润色的本地规则。包含示例密码、代码、JSON 或特殊字符的材料也会按用户指定的范围原样发送。“这轮别润色”仍会跳过本轮。
- Removed the local rules that skipped rewrites based on their text. Samples containing passwords, code, JSON, or control characters now follow the same route as other text and are sent as written. “Skip polishing this time” still skips the turn.

- “返回结果 polish”或“重写上一条”等主动请求都会使用 Turbo，直接把选定的草稿交给 Gemini，跳过 OpenAI Decisions。项目保存的普通或 Turbo 模式只用于自动润色。
- Asking to polish a result or rewrite an earlier answer now uses Turbo and sends the selected draft directly to Gemini, skipping OpenAI Decisions. The project’s saved Normal or Turbo mode applies only to automatic polishing.
- 选中或引用一段文字时，改写只使用该段、当前润色提示词和本次编辑要求。“只把这段原文发给 Gemini”会使用内置 Turbo 提示词，项目提示词、其他要求和聊天历史都留在本地。再次改写旧原稿时，使用原问题和原答复之前的可选历史。无法确认来源时会请用户指出原文。
- Selected passages now use the active polishing prompt and any editing directions you give. “Only send this passage to Gemini” uses the built-in Turbo prompt and keeps the project prompt, other directions and conversation history local. Rewriting an original again uses its original question and any permitted exchanges from before that original answer. Codex asks you to identify the original when its source is unclear.

## 0.0.1-beta.5

- The repository and npm beta now open with the English README. The Simplified Chinese guide is linked at the top. Both guides cover first setup, one-time Turbo rewrites, and what each provider receives.
- 仓库和 npm 测试包默认展示英文 README，顶部可切换至简体中文。两份指南都更新了安装步骤、单次 Turbo 用法和数据发送范围。

## 0.0.1-beta.4

- 在普通模式也可以说“这题用 Turbo”或“让 Gemini 重写刚才那条”。单次请求直接走 Gemini，可以附上具体改法。下一条普通提问继续使用项目默认模式。
- A one-time Turbo request can rewrite the current draft or a specific earlier answer in the same chat. Give Gemini any directions for that rewrite. The next ordinary question uses the project's saved mode.
- 新增项目改写模式。普通模式（默认）沿用原有流程，Turbo 会跳过 OpenAI，将每份符合条件的草稿直接交给 Gemini，可直接说“切换到 Turbo 模式”或“恢复普通模式”。
- Projects can now choose a rewrite mode. Normal (default) keeps the existing workflow. Turbo skips OpenAI and sends every eligible draft directly to Gemini. Say “Switch to turbo mode” or “Switch back to normal mode”.
- OpenAI 风格检查只使用本轮问题、草稿和已设置的自定义润色提示词。历史问答仅在 Gemini 改写时附带，默认最多 2 轮，可选 0 到 10 轮。可以要求本轮不带历史。OpenAI 检查不可用或材料超过该接口限制时，直接交给 Gemini。
- The OpenAI style check uses only the current question, draft, and any custom polishing prompt. History goes only to Gemini when it rewrites. Projects can choose 0–10 exchanges (default 2), or omit history for one rewrite. When the OpenAI check is unavailable or its input limit is exceeded, the draft goes directly to Gemini.
- 可以在项目里说“查看润色提示词”“设置润色提示词”或“恢复默认润色提示词”。自定义提示词逐字保存在 `.codex/codex-polish.prompt.md`，供同一项目后续聊天使用。普通和 Turbo 模式都将原文作为 Gemini 的全部编辑指令。可选的 OpenAI 风格检查也会参考它。
- Projects can show, set, or restore the default polishing prompt in chat. Custom prompts are saved verbatim in `.codex/codex-polish.prompt.md` for future chats in the project. Normal and Turbo both use the saved text as Gemini’s complete editing prompt. The optional OpenAI style check also considers it.
- Gemini 返回改稿后，在支持折叠的客户端，完整原稿默认收起。点击润色版下方的“查看 GPT 原稿”即可对照。
- When a rewrite changes the text, clients that support folding show the full draft collapsed. Select “View original GPT draft” below the rewrite to compare.
- Gemini 和可选的 OpenAI 风格检查现在直接接收本轮问题和草稿原文，包括代码、路径、链接和数值。OpenAI 只在改写前判断草稿是否需要润色。本轮材料含疑似凭据或用户要求固定格式时，插件会在发送前跳过。两种模式收到 Gemini 的完整回复后只做显示排版。Gemini 返回原文时，正文只显示一次。
- Gemini and the optional OpenAI style check now receive the current question and draft as written, including code, paths, links, and numbers. OpenAI is called only before rewriting to decide whether the draft needs editing. The plugin skips suspected credentials and exact-output requests before sending. Both modes now format Gemini’s complete reply for display. If Gemini returns the original text, it appears once.

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
