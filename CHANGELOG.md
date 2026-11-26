# 更新记录 / Changelog

[中文使用说明](docs/README.zh-CN.md) · [English README](README.md)

## AGY Polish 0.0.4-beta.5

- Antigravity 的默认 `setup` 恢复四种润色模式，可直接选择 Codex 模型和思考等级。重新运行时会预选已有设置。
- Antigravity setup again offers all four polishing modes, the Codex model and reasoning effort. Running setup again preselects your saved settings.

## Codex Polish 0.0.4-beta.3

- Codex 的默认 `setup` 恢复四种模式、Gemini 模型和思考等级的选择。Normal 模式下可选择配置 OpenAI 检查或跳过。
- Codex setup again offers all four polishing modes, the Gemini model and thinking level. Normal mode also offers the optional OpenAI check.

## 0.0.4-beta.2

- 项目更名为 Agent Polish。Codex 用户安装 `@kyun.si/codex-polish`，Antigravity 用户安装 `@kyun.si/agy-polish`。每个包独立管理自己的插件，并沿用旧 beta 保存的设置。
- 首次设置只需选择自动润色或仅在点名时润色。模型和思考等级沿用已有配置，之后可在对应的聊天里更改。
- The project is now Agent Polish. Install `@kyun.si/codex-polish` for Codex or `@kyun.si/agy-polish` for Antigravity. Each package manages its own plugin and reuses settings saved by the previous beta.
- First-time setup offers automatic or on-request polishing. Model and reasoning settings carry over and can be changed in the host chat.

## 0.0.4-beta.1

- 在 Antigravity 中可让 Codex 润色 Gemini 的回复，改稿直接显示在原对话里。支持自动润色、点名改写和选段编辑，Codex 不可用时保留原稿。
- 安装向导可选 Codex、Antigravity 或两者。`setup`、`doctor`、`update` 和 `uninstall` 支持 `--host codex|agy|both`，两个方向各自保存模式和模型。
- Codex can now polish Gemini replies in Antigravity and return the edited text to the same chat. It supports automatic edits, explicit requests, and selected passages. If the editor is unavailable, the original draft is kept.
- Setup lets you choose Codex, Antigravity, or both. The `setup`, `doctor`, `update`, and `uninstall` commands accept `--host codex|agy|both`. Each host keeps its own mode and model preferences.

## 0.0.3

- 安装时从账号可用的 Gemini 模型中选择，再查询该模型的思考等级。支持固定思考等级的模型，查询时可按 Esc 取消。
- Setup lets you choose from the Gemini models available to your account, then looks up the selected model’s thinking levels. It supports models with a fixed thinking level. Press Esc to cancel a lookup.

## 0.0.3-beta.1

- 安装时先读取账号可用的 Gemini 模型，再查询所选模型的思考等级。查询期间可按 Esc 取消，支持固定思考等级的模型。
- Setup loads the Gemini models available to your account, then looks up the thinking levels for the selected model. Press Esc to cancel a lookup. Models with a fixed thinking level are supported.

## 0.0.2

- 终端工具截断 ACP 输出时，可以从原字节位置重读。确认 Gemini 模型和思考等级后，原稿只发送一次。
- 卸载会清除旧版遗留的空锁文件和空插件目录。同一配置下的安装、更新和卸载仍然互斥。

- When the terminal tool clips ACP output, Codex can reread it from the same byte offset. It sends the draft only once, after confirming the Gemini model and thinking level.
- Uninstall removes empty lock files left by older versions and cleans up empty plugin directories. Install, update and uninstall operations for the same profile still run one at a time.

## 0.0.1

- 首个正式版。运行 `npx @kyun.si/codex-polish setup` 安装；Windows PowerShell 请用 `npx.cmd @kyun.si/codex-polish setup`。
- 在终端或聊天的 Setup 首页可选 Normal、Turbo、仅手动或关闭。关闭后，自动润色和点名改写都会停用；重新开启时，之前的模型、思考等级、提示词和密钥仍然可用。

- First stable release. Install with `npx @kyun.si/codex-polish setup`, or `npx.cmd @kyun.si/codex-polish setup` in Windows PowerShell.
- Choose Normal, Turbo, Only when asked, or Turn off polishing from Setup in the terminal or in chat. Turning polishing off pauses both automatic and requested rewrites. Your model, thinking level, custom prompt and saved key are ready when you turn it back on.

## 0.0.1-beta.13

- 同一份 Codex 配置下的所有聊天和目录共用一套润色设置。在聊天或终端保存后立即生效。再运行一次交互式 `setup` 或在聊天中打开「配置回复润色」，即可查看或更改自动改写模式、Gemini 模型和思考等级。终端菜单按回车即可保留原选择。
- All chats and folders in the same Codex profile now share one set of polishing preferences. Changes saved in chat or in the terminal take effect immediately. Rerun interactive `setup` or reopen Setup in chat to review or change the automatic rewrite mode, Gemini model and thinking level. Press Enter in the terminal menus to keep each saved choice.

- 单独发“说人话”“重写”“润色”可以让 Gemini 重写上一条回复。对应的英文口令有 `Speak plainly`、`Rewrite` 和 `Polish`。改写后的正文下方默认折叠原文。要求只看正文时会省略折叠区。
- Send `Speak plainly`, `Rewrite` or `Polish` on its own to have Gemini rewrite the previous reply. The original is collapsed below the rewrite by default. Ask for just the rewritten text to omit it.

## 0.0.1-beta.12

- 自动润色保留原稿时只显示正文。Gemini 改动文字时，回复直接从改稿开始，底部的“Gemini 改写 · 查看 GPT 原稿”可展开对照。主动要求润色而文字未变时，会附上一句确认。
- Automatic polishing shows only the draft when it is kept. Changed replies open with the rewritten text. Expand “Rewritten by Gemini · View original GPT draft” underneath to compare. When you explicitly request a rewrite and the wording stays the same, a brief sentence confirms the result.

- 润色失败时附上简短原因。您可从历史中找回有来源记录的原稿，也可继续改写之前的正文。
- When a rewrite fails, the reply gives a brief reason. You can retrieve the original draft when its source is recorded, or rewrite the visible text from a previous reply.

## 0.0.1-beta.11

- 修复了 Codex 桌面端在“未润色”和“Gemini 返回了原稿”等状态后显示 HTML 注释的问题。
- Removed the visible HTML comment after skipped and unchanged reply headings in the Codex app.

- Codex 现在直接启动官方 `agy acp`，通过宿主工具读写每条请求。移除了插件的进程启动器和协议转发器；安装时查询账号模型也使用同一路径。
- The Codex agent now starts `agy acp` and exchanges requests using its own process tools, both for rewrites and for the installer's account model lookup.

- 安装时可以一起选 Gemini 模型和思考等级。默认使用 Gemini 4 Hydrogen 和 Medium，以后也可以在 Codex 中更改。普通和 Turbo 模式都使用选定的等级。
- Choose a Gemini model and thinking level during setup, or change them later in Codex. The defaults are Gemini 4 Hydrogen and Medium. Both Normal and Turbo use the selected level.

## 0.0.1-beta.9

- 默认只用 Gemini，忽略已有的 `OPENAI_API_KEY`。首次交互安装并选用普通模式时，可以选择启用按 API 用量计费的 OpenAI Decisions API 检查。以后可用 `openai` 命令管理当前 Codex 配置保存的密钥，卸载时会删除密钥。
- Gemini now runs alone by default, even when `OPENAI_API_KEY` is set. The first interactive setup in Normal mode offers an optional OpenAI Decisions API check billed by API usage. Manage the profile’s saved key later with `openai`. Uninstall deletes it.

- 在任意目录用方向键选择默认改写模式和 Gemini 模型。安装后可为当前 Codex 配置保存一份润色提示词，所有项目共用。恢复默认或卸载会删除保存的提示词。卸载也会删除该配置的默认选项和已记录的项目设置。
- Choose a default rewrite mode and Gemini model from any folder. After setup, save one polishing prompt for every project in the active profile. Reset or uninstall deletes that prompt. Uninstall also removes the profile defaults and recorded project settings.

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
- 选模使用账号返回的 Gemini ID 和显示名。手写设置支持大小写，配置无效时给出原因。这一版加入了共享提示词文件的支持。自动 hook 只提醒当前用户会话。
- The model picker uses the account’s Gemini IDs and display names. Settings accept mixed case and report invalid values. This release added support for shared prompt files. The automatic hook ignores events for subagents or other sessions.

- 移除了按正文内容跳过润色的本地规则。包含示例密码、代码、JSON 或特殊字符的材料也会按用户指定的范围原样发送。“这轮别润色”仍会跳过本轮。
- Removed the local rules that skipped rewrites based on their text. Samples containing passwords, code, JSON, or control characters now follow the same route as other text and are sent as written. “Skip polishing this time” still skips the turn.

- “返回结果 polish”或“重写上一条”等主动请求都会使用 Turbo，直接把选定的草稿交给 Gemini，跳过 OpenAI Decisions。项目保存的普通或 Turbo 模式只用于自动润色。
- Asking to polish a result or rewrite an earlier answer now uses Turbo and sends the selected draft directly to Gemini, skipping OpenAI Decisions. The project’s saved Normal or Turbo mode applies only to automatic polishing.
- 选中或引用一段文字时，改写只使用该段、当前润色提示词和本次编辑要求。“只把这段原文发给 Gemini”会使用内置 Turbo 提示词，自定义提示词、其他要求和聊天历史都留在本地。再次改写旧原稿时，使用原问题和原答复之前的可选历史。无法确认来源时会请用户指出原文。
- Selected passages now use the active polishing prompt and any editing directions you give. “Only send this passage to Gemini” uses the built-in Turbo prompt and keeps the custom prompt, other directions and conversation history local. Rewriting an original again uses its original question and any permitted exchanges from before that original answer. Codex asks you to identify the original when its source is unclear.

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
- 可以在项目里说“查看润色提示词”“设置润色提示词”或“恢复默认润色提示词”。这一版支持逐字保存自定义提示词，供以后的聊天使用。普通和 Turbo 模式都将原文作为 Gemini 的全部编辑指令。可选的 OpenAI 风格检查也会参考它。
- Projects can show, set, or restore the default polishing prompt in chat. This release added verbatim storage for custom prompts in future chats. Normal and Turbo both use the saved text as Gemini’s complete editing prompt. The optional OpenAI style check also considers it.
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
