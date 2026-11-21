# 用 Gemini 改写回复

一次请求只改写一份原稿，保留它直到交付。只处理最终答复。

常规润色直接执行。无需单独发消息宣布开始润色、说明选择了哪个模型或逐步报告调用进度。用户主动问进度或需要用户操作时，再说明相关情况。最终消息直接交付排版结果。

## 触发与输出格式

用本文件的安装位置定位 `scripts/`、`references/` 和 `../../hooks/preferences.mjs`。后续命令的 `--cwd` 始终传本轮开始时的绝对工作目录，用于核实本轮和会话记录。润色设置由当前 Codex 配置下的所有聊天共用。按整句及会话上下文理解用户意图，无需固定口令。

- 用户主动要求润色或改写，用 `--trigger explicit`，固定走 Turbo，跳过 Decisions。“返回结果 polish”“润色一下”“上一条换个说法”都属于主动请求。即使同一轮也有 hook 提醒，仍只处理一次。用户要求接下来几轮都润色时，在其指定范围内沿用。
- 普通提问只有收到本轮受信任的 `UserPromptSubmit` 提醒才用 `--trigger auto`。这种自动润色按已保存的设置走 Normal 或 Turbo，默认 Normal。
- 用户问“Turbo 怎么用”“‘说人话’为什么没触发”、讨论插件实现或引用别人的指令时，按实际问题回答。要求重写函数或修改文件时，按用户指定的对象完成任务。如果刚问过要翻译成哪种语言，用户回答 “Polish” 指波兰语。只有用户要求更改以后使用的设置时才保存。
- 如果用户只想看 GPT 原稿，直接展示对话中可核实的原稿，也可在本地运行 `previous_reply.mjs --cwd "<本轮工作目录>" --turns-back N --require-gpt` 查找。没有可核实的原稿就如实说明，这条请求不启动 Gemini。

用户本轮只想查看或设置改写模式、模型、思考等级或全局润色提示词时，使用设置技能。用户说“这轮别润色”或禁止外发时直接交付原稿。用户取消就结束。本轮明确要求只给 JSON、命令、补丁或逐字引用时，按指定格式交付。用户要求改写某段代码、JSON 或引文时，以指定的原文为草稿。句数、篇幅和语气属于编辑要求。用户明确只想看正文时，改写成功只交付正文，保留原稿或改写失败也只交付原稿。

改写旧回复时，先按下节在本地定位原稿，再根据返回的是整条问答还是选区检查设置。用户要求只发送指定片段时，在检查设置、准备编辑角色和组装 ACP 请求这三处均加 `--selection-only`。运行 `node …/hooks/preferences.mjs check --cwd "<本轮工作目录>" --trigger <本轮触发方式>`（Node.js 22.16+）。普通选区或用户指定本轮省略历史时，给 `check` 加 `--no-history`。如果是整条回答且本轮省略历史，调用 Decisions 时也给 `decision judge` 加 `--no-history`。`mode=off` 或仅由提醒触发且 `mode=manual` 时按普通回复交付。记下 `check.rewrite_mode`、`gemini_model`、`gemini_thinking_level`、`google_auth_method` 和本轮的显示语言。语言为自动时跟随用户的语言，无法判断时用 `check.ui_language`。

若执行工具不能持续读写并回收同一子进程、Node.js 或帮助脚本不可用，或 `blockers` 非空，按下文的失败流程交付原稿。CLI 能否找到 `codex` 供安装排查参考，正在运行的宿主可以直接提供执行工具。

## 选择原稿

- **新的问题或任务**：“什么是缓存穿透？说人话。”或“Explain DNS, then polish the answer.”要求改写本轮回答。先完成任务，再用本轮问题和可直接交付的完整答案。用户说“刚才算错了，重算后让 Gemini 说简短点”，先纠错，以纠正后的结果为本轮原稿。只表达不满或指出事实错误时，回应具体问题；不要擅自把它理解成重写旧文本。
- **改写已有回答**：单独发“说人话”“重写”“润色”或英文 “Speak plainly.” “Rewrite.” “Polish.”，默认指上一条答复（N=1），整条原答复是草稿，用户这次的措辞传入 `rewrite_request`。如果是空白的新聊天，先问用户想改哪段文字。用户也可以指定“让 Gemini 重写前面讲缓存的那条”。直接取用户指的答复，不要重新回答问题或起草一段确认话。用 `node …/scripts/previous_reply.mjs --cwd "<本轮工作目录>" --turns-back N` 读取原来的 `question` 和 `draft`。N 按本会话已完成的问答倒数，上一条是 1。按主题或引用定位时，核对取出的问答确实是所指的那一条；仍有两个可能目标时，请用户指出。用户明确要改 GPT 原稿时，加 `--require-gpt`。用返回的 `source_label` 辨别来源。`gpt` 表示已确认的 GPT 原稿；`quoted` 表示可见原文。若用户明确要 GPT 原稿，不能把 `quoted` 当成 GPT 原稿。后续组装和排版统一使用此次选定的序号；`--require-gpt` 若返回 `turns_back`，用该值替代 N，原问题和可选历史以原稿所在轮为准。历史设为 0 仍保留原问题。没有可用的索引时，若当前上下文中能核实完整原问题和目标答复，传这两项并加 `--no-history`；排版用 `--selection` 标明来自可见原文。若只有用户选中的片段，走下一条选区路径。点名要 GPT 原稿且无法核实时，请用户指出或贴出原稿。
- **用户引用、粘贴或选中原文，或明确要改可见的 Gemini 版本**：取那段文字本身，以 `--selection` 组装，向离线材料工具输入 `{sessionId, selection}`；有本次编辑要求时可另传 `rewrite_request`。此路径省略整条用户消息、原问题和历史。用户限定“只把这一段发给 Gemini”时用 `--selection-only`，同样输入 `{sessionId, selection}`，省略 `rewrite_request`，只提交选中文字，使用内置编辑角色。两种选区都不传 `--turns-back`。如果范围不明确，先请用户指出。
- 读取旧回复时，如果脚本返回 `selection`，按选区发送所指版本的正文，不附原问题或历史。单凭上一条正文或它前面的用户消息，无法判断当时改的是整条还是选段。只有用户明确指定完整问答，或另有记录能核实原问题和完整答复时，才按这对问答加 `--no-history` 提交。用户点名要 GPT 原稿且无法核实时，请用户指出或贴出原稿。
- 如果用户还说了“只写三句”“给没接触过缓存的人看”等编辑要求，可通过 `rewrite_request` 传用户自己的措辞；“只发选区”时省略此字段。不要自行添加风格要求、把新要求混进旧问题，或覆盖自定义提示词。

## 判定与改写

脚本从标准输入读取 UTF-8 JSON，输出 JSON。使用宿主的安全 stdin。只有宿主终端可用时，给 `decision judge` 和 `format_reply.mjs` 加 `--host-input`，使用 `tty: true` 启动。等 `input_ready` 后，用 `write_stdin` 发送 `JSON.stringify(材料) + "\n"`。后续只交付排版结果。`input_ready` 是工具状态。若命令直接返回判定结果，按该结果继续。不要把正文当作 shell 代码执行，不写草稿到项目文件。检查退出状态、完整结果和返回字段，失败时保留原稿。

1. 选好原稿后，按本轮的 `check.decisions_enabled` 选择路由。问题、草稿、选区和本次编辑要求均使用原文。
   - 为假时使用 `route=acp`，直接进入第 2 步。所有主动请求都走这条路径，不调用 `decision judge`。
   - 为真时才运行 `node …/hooks/preferences.mjs decision judge --cwd "<本轮工作目录>" --trigger auto --route decisions --rewrite-mode normal --model <check.gemini_model> --thinking-level <check.gemini_thinking_level>`。标准输入传原始 `question` 和 `draft`，OpenAI 只接收这两项和当前 Codex 配置保存的自定义提示词。概率大于 50% 时继续，平局保留原稿。返回 `action: "rewrite"` 时用返回的 `route` 进入第 2 步，包括 `reason: "decision_unavailable"`。返回 `action: "keep"` 且 `reason: "already_clear"` 时，走下文的 `--kept` 流程，只交付原稿。其他停止原因按实际情况使用 `--skipped`。
2. 按 [ACP 操作步骤](references/acp.md)，由当前 Codex agent 在本轮临时目录直接启动官方 `agy acp`。用宿主工具持有该进程的输入输出，完成握手并确认已保存的模型和思考等级。插件的本地工具负责准备编辑角色、组装原稿或解析 agent 已收到的回复。
3. agent 向该进程直接发送一次完整的 `session/prompt`。收到对应的 `end_turn` 后，将本轮原始输出和原稿交给 `acp_answer.mjs` 排版，并传本轮实际触发方式 `--trigger auto` 或 `--trigger explicit`。自动 Turbo 仍用 `auto`。中文常规展示用 `zh`，英文用 `en`。用户明确只看正文或要求严格输出格式时，给 `acp_answer.mjs` 加 `--body-only`。来源不明的可见原文标记为 `quoted`。结束本次进程并清理临时角色目录。若读取不完整或请求状态不明，保留原稿，同一轮不重发。

## 在最终消息中交付

独立口令使用常规展示，给排版器传本轮的 `display_language`。上轮的句数要求约束改稿正文，仍可在正文后折叠原稿。收到完整结果后，直接把第 3 步返回的 `text` 作为最终消息，包括其中的原稿折叠区。若单独用 `format_reply.mjs --render` 排版完整改稿，也传本轮的 `--trigger auto` 或 `--trigger explicit`。

- Gemini 改动文字时，直接从改稿正文开始。底部的“Gemini 改写 · 查看 GPT 原稿”或“Rewritten by Gemini · View original GPT draft”可展开原稿。选段或可见引文则用“Gemini 改写 · 查看原文”或“Rewritten by Gemini · View original text”。
- Gemini 原样返回时，自动触发只显示原稿。主动请求则显示一份原稿，并附一句 `Gemini 返回了原稿。` 或 `Gemini returned the original draft.`。选段或引文相应使用 `Gemini 返回了原文。` 或 `Gemini returned the original text.`。这些句子按普通文本显示。
- Decisions 返回 `already_clear` 时，运行 `node …/scripts/format_reply.mjs --render --kept --cwd "<本轮工作目录>"`，输入 `{draft}`。原样交付 stdout。此命令保留可用的原稿来源记录，只输出原稿。
- 发送前因故停止或 ACP 未能返回完整正文时，用 `node …/scripts/format_reply.mjs --render --skipped --cwd "<本轮工作目录>"`，输入 `{draft, reason, display_language}`。用显示语言把已知原因写成一句独立的话，例如“这次没能调用 Gemini，下面是原稿。”工具先显示这句话，再显示原稿。若排版工具也不可用，按相同格式交付。

按轮次取原稿时，给排版命令加 `--turns-back N` 并传 `question`。两种选区和直接引用的可见原文加 `--selection`。用户指定严格格式或只看正文时，成功改写用 `acp_answer.mjs --body-only`；直接调用 `format_reply.mjs` 时省略 `display_language`。用户取消就结束，要求变更时按最新要求处理。同一轮改写只发送一次。
