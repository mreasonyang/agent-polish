# 用 Gemini 改写回复

一次请求只改写一份原稿，保留它直到交付。只处理最终答复。

常规润色直接执行。无需单独发消息宣布开始润色、说明选择了哪个模型或逐步报告调用进度。用户主动问进度或需要用户操作时，再说明相关情况。最终回复按下文展示润色结果和原稿。

## 触发与输出格式

用本文件的安装位置定位 `scripts/`、`references/` 和 `../../hooks/preferences.mjs`。记住本轮开始时的绝对工作目录（可以是仓库子目录），后面的 `--cwd` 始终用它。按整句及会话上下文理解用户意图，无需固定口令。

- 用户要求这次用 Turbo、一定要改写、直接让 Gemini 重写，或明确要求把已有回答换个说法时，用 `--trigger turbo`。这次跳过 Decisions，项目设置照旧。用户如果把要求限定在本次对话的接下来几轮，只在其指定范围内沿用；撤销后恢复项目模式。
- 用户一般性点名本轮润色，用 `--trigger explicit`，沿用项目改写模式。普通提问只有收到本轮受信任的 `UserPromptSubmit` 提醒才用 `--trigger auto`。点名和提醒重合时只处理一次，采用用户指定的方式。
- 用户问“Turbo 怎么用”、讨论插件实现或引用别人的指令时，按实际问题回答。只有用户要求设置项目默认值时才保存。

用户本轮只想查看或设置项目的改写模式、润色提示词时，使用设置技能在本地完成，直接回复设置结果。用户取消就结束。用户禁止外发或要求 JSON、命令、补丁、逐字引用等固定格式时，按用户要求直接答复。句数、篇幅和语气属于编辑要求。用户明确只想看润色后的正文时，走下述润色流程，最终只交付选定的正文。其他情况下，润色结果与原稿都要在**用户可见的最终消息**中交代。

用 Node.js 22.16 或更新版本运行 `node …/hooks/preferences.mjs check --cwd "<原项目目录>" --trigger <本轮触发方式>`。触发设置 `mode` 为 `off`，或仅由提醒触发且 `mode` 为 `manual` 时，按普通回复交付。记下初次检查的 `check.rewrite_mode`（默认 `normal`，可选 `turbo`）、`gemini_model`（默认 `gemini-4-hydrogen`）、`google_auth_method` 和本轮的显示语言。状态和标题使用项目设置的中文或英文。语言为自动时跟随本轮用户的语言，无法判断时用 `check.ui_language`。

材料不适合外发、执行工具不能持续读写并回收同一子进程、Node.js 或帮助脚本不可用、`blockers` 非空时，按下文“保留原稿”交付。CLI 能否找到 `codex` 供安装排查参考，正在运行的宿主可以直接提供执行工具。

## 选择原稿

- **新的问题或任务**：先完成任务，再用本轮问题和可直接交付的完整答案。用户说“刚才算错了，重算后让 Gemini 说简短点”，先纠错，以纠正后的结果为本轮原稿。只表达不满或指出事实错误时，回应具体问题；不要擅自把它理解成重写旧文本。
- **改写已有回答**：如“上一条我没看懂，换个说法”或“让 Gemini 重写前面讲缓存的那条”。直接取用户指的答复，不要重新回答问题或起草一段确认话。用 `node …/scripts/previous_reply.mjs --cwd "<原项目目录>" --turns-back N` 读取原来的 `question` 和 `draft`。N 按本会话已完成的问答倒数，上一条是 1。按主题或引用定位时，核对取出的问答确实是所指的那一条；仍有两个可能目标时，请用户指出。已有对照展示时，脚本取其中的 GPT 原稿。后续给 `acp_payload.mjs` 传同一个 `--turns-back N`，只会附上目标答复之前的历史。附加历史设为 0 时，仍可改写指定答复。
- **用户引用或选中了一段原文**：只改指定范围。如果用户明确要改可见的 Gemini 版本，就用那一版。采用用户指向的确切文字及其对应问题；无法取得对应问题但用户已明确贴出待改文本时，用本轮实际请求作 `question`。这条路径传 `--no-history`，省略 `--turns-back`。缺少宿主记录但对话里仍有完整的问题和答复，也可以使用可见原文；若无法确定指哪一版、只有摘要，或用户点名要改的 GPT 原稿已不可见，先请用户指出或贴出那段文字；用户明确要 GPT 原稿时不要用可见的 Gemini 版代替。
- 如果用户还说了“只写三句”“给没接触过缓存的人看”等编辑要求，在显式 Turbo 的 ACP 输入中用可选 `rewrite_request` 传用户自己的措辞。不要自行添加风格要求、把新要求混进旧问题，或覆盖自定义提示词。

## 判定与改写

脚本从标准输入读取 UTF-8 JSON，输出 JSON。使用宿主的安全 stdin。只有 shell 可用时，用 JSON 序列化器生成单行 JSON，再用单引号 heredoc 分隔符送入脚本。不要把正文当作 shell 代码执行，不写草稿到项目文件。检查退出状态、完整结果和返回字段，失败时保留原稿。

1. 调用 `scripts/text_guard.mjs prepare`，输入 `{"question":问题,"draft":原稿}`。使用上一步选定的问题与原稿原文，省略界面标题。若 `bypass` 为真，保留原稿，固定格式按用户要求直接交付。收到 `{"bypass":false}` 后，后续步骤沿用传给 `prepare` 的问题和草稿原文。
2. `turbo` 一律选 `acp`。`normal` 在 `check.decisions_enabled` 为真时选 `decisions`，否则选 `acp`。运行 `node …/hooks/preferences.mjs decision judge --cwd "<原项目目录>" --trigger <本轮触发方式> --route <所选路由> --rewrite-mode <check.rewrite_mode> --model <check.gemini_model>`。只在 `action: "rewrite"` 时继续。`<check.rewrite_mode>` 在本轮所有命令中均替换为初次检查所得的值。使用返回的 `route` 组装 ACP 请求。
   - `acp` 的标准输入留空。此入口在本地检查项目模式和依赖。通过就继续，即便原稿已经很通顺。
   - `decisions` 从标准输入接收原始 `question` 和 `draft`。OpenAI 只接收本轮问题、完整草稿以及项目已设置的自定义润色提示词。需要改写的概率大于 50% 时继续，平局保留原稿。返回 `reason: "decision_unavailable"` 表示检查不可用，继续 ACP 步骤。`reason: "already_clear"` 时保留原稿，并说明 OpenAI 判断无需润色。
3. 收到 `action: "rewrite"` 后，按 [ACP 操作步骤](references/acp.md)直接向 Gemini 发送草稿。**当前 agent 是 ACP 客户端**。不要委派给子 agent，不写或启动 ACP 驱动脚本、MCP 代理或后台服务。
   - 用 `scripts/editor_role.mjs --cwd "<原项目目录>" --trigger <本轮触发方式>` 生成本轮编辑角色，再用持久执行工具启动官方 `agy acp`。对同一进程完成握手和选模。默认 `existing-session` 使用已有登录，显式指定 API key 或企业身份时才发送对应认证请求。
   - 读取每个配置响应后，用 `acp_models.mjs --response-id <请求 ID> --target-model <check.gemini_model>` 取得下一步。`submit_prompt` 表示可以提交草稿。确认用户仍允许调用，将 `acp_payload.mjs` 的 stdout 直接送入已打开的 ACP 输入一次，等待该请求的 `end_turn`。不要先打印整帧再抄送。
   - 给组装脚本传原项目目录、已加载的角色文件，以及 `--trigger <本轮触发方式> --route <第2步返回的route> --rewrite-mode <check.rewrite_mode> --model <check.gemini_model>`。脚本会在输出前重新核对这些设置。历史由脚本按项目设置附加，默认 2 轮、最多 10 轮。用户要求本轮不带历史时加 `--no-history`。若组装脚本拒绝材料或项目设置已变，按实际原因保留原稿。
   - 服务或协议发生故障时，按 ACP 步骤回收并保留原稿，下一轮独立判断。
4. 收到本次 `end_turn` 和完整的 Gemini 正文后，把正文原样传给下方的排版脚本并交付。不要再审稿，也不要自行改写或换回 GPT 原稿。

## 在最终消息中交付

用 `node …/scripts/format_reply.mjs` 排版。标准输入传入 JSON，`draft` 填本次选定并实际提交的原稿，`candidate` 填完整的 Gemini 正文，`display_language` 填 `zh` 或 `en`，如果素材是用户引用的文字、可见的 Gemini 版本或来源无法确认的正文，另传 `source_label: "quoted"`，折叠标题为“查看原文”。将返回的 `display_text` 直接作为最终回复。脚本只生成展示文本，包括标题和默认折叠的 GPT 原稿。两份文字相同时，正文只显示一次。用户要求只看润色正文时，省略 `display_language`，直接交付脚本返回的 `text`。排版工具不可用时，仍然发送已经收到的 Gemini 正文；常规展示附上折叠的原稿，并按原稿来源标注。

发送前跳过、OpenAI 判断无需改写，或 ACP 未能返回完整正文时，交付本次选定的原稿。常规展示首行写 `**未润色** · <一句话原因>` 或 `**Polishing skipped** · <reason>`，空一行后放原稿全文，以便下次能单独取回原稿。固定格式或只看正文时遵守用户要求。用户取消就结束，要求变更时按最新要求处理。同一轮改写只发送一次。
