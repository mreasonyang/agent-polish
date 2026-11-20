---
name: codex-polish
description: Polishes Codex's final reply with Gemini when you ask or a trusted automatic-mode hook prompts. 在你点名或受信任的自动润色 hook 提醒时运行。
---

# 润色本轮回复

先完成用户任务，准备一份可以直接发出的完整回复，作为本轮的 GPT 原稿。保留这份原稿直到交付。只在最终答复前运行一次，不润色工具调用、进度消息或待原样交付的文件。

## 触发与输出格式

用本文件的安装位置定位 `scripts/`、`references/` 和 `../../hooks/preferences.mjs`。记住本轮开始时的绝对工作目录（可以是仓库子目录），后面的 `--cwd` 始终用它。用户本轮主动点名时用 `--trigger explicit`。普通提问只有收到本轮受信任的 `UserPromptSubmit` 提醒才用 `--trigger auto`。重复的提醒只处理一次。

用户本轮只想查看或设置项目的改写模式、润色提示词时，使用设置技能在本地完成，直接回复设置结果。用户取消就结束。用户禁止外发或要求 JSON、命令、补丁、逐字引用等固定格式时，按用户要求直接答复。用户明确只想看润色后的正文时，走下述润色流程，最终只交付选定的正文。其他情况下，润色结果与原稿都要在**用户可见的最终消息**中交代。

用 Node.js 22.16 或更新版本运行 `node …/hooks/preferences.mjs check --cwd "<原项目目录>"`。触发设置 `mode` 为 `off`，或仅由提醒触发且 `mode` 为 `manual` 时，按普通回复交付。记下初次检查的 `check.rewrite_mode`（默认 `normal`，可选 `turbo`）、`gemini_model`（默认 `gemini-4-hydrogen`）、`google_auth_method` 和本轮的显示语言。状态和标题使用项目设置的中文或英文。语言为自动时跟随本轮用户的语言，无法判断时用 `check.ui_language`。

材料不适合外发、执行工具不能持续读写并回收同一子进程、Node.js 或帮助脚本不可用、`blockers` 非空、自动触发且 `cooldown` 非空时，按下文“保留原稿”交付。CLI 能否找到 `codex` 供安装排查参考，正在运行的宿主可以直接提供执行工具。

## 判定与改写

脚本从标准输入读取 UTF-8 JSON，输出 JSON。使用宿主的安全 stdin。只有 shell 可用时，用 JSON 序列化器生成单行 JSON，再用单引号 heredoc 分隔符送入脚本。不要把正文当作 shell 代码执行，不写草稿到项目文件。检查退出状态、完整结果和返回字段，失败时保留原稿。

1. 调用 `scripts/text_guard.mjs prepare`，输入 `{"question":问题,"draft":原稿}`。两项只含本轮问题及其当前要求和完整原稿，保留原文。不要从先前的问答补写或概括背景，也不要加入展示用的标题。若 `bypass` 为真，保留原稿，固定格式按用户要求直接交付。收到 `{"bypass":false}` 后，后续步骤沿用传给 `prepare` 的问题和草稿原文。
2. `turbo` 一律选 `acp`。`normal` 在 `check.decisions_enabled` 为真时选 `decisions`，否则选 `acp`。运行 `node …/hooks/preferences.mjs decision judge --cwd "<原项目目录>" --trigger <auto或explicit> --route <所选路由> --rewrite-mode <check.rewrite_mode>`。只在 `action: "rewrite"` 时继续。`<check.rewrite_mode>` 在本轮所有命令中均替换为初次检查所得的值。保存返回的 `route` 和可能的 `recovery_token`。
   - `acp` 的标准输入留空。此入口在本地检查项目模式、依赖和冷却状态。通过就继续，即便原稿已经很通顺。
   - `decisions` 从标准输入接收原始 `question` 和 `draft`。OpenAI 只接收本轮问题、完整草稿以及项目已设置的自定义润色提示词。需要改写的概率达到 0.80 才继续。`reason: "already_clear"` 时保留原稿，并说明 OpenAI 判断无需润色。
3. 读取 [ACP 操作步骤](references/acp.md)。**你就是 ACP 客户端。** 先用 `scripts/editor_role.mjs --cwd "<原项目目录>"` 为本次改写生成编辑角色，再用本轮的持久执行工具启动官方 `agy acp`，对同一进程逐条收发。默认 `existing-session` 使用已有登录，显式指定 API key 或企业身份才发送对应认证请求。发送 prompt 时，在同一个工具调用中把 `acp_payload.mjs` 的 stdout 直接重定向到已打开的 ACP 输入（见参考命令）。不要先打印整帧再抄到下一次调用。不要委派给子 agent，不写或启动 ACP 驱动脚本、MCP 代理或后台服务。脚本按项目设置自动附上最近完整问答，默认 2 轮、最多 10 轮。不要自行查阅、挑选或概括。将已加载的角色文件路径和首次检查的 `--rewrite-mode <check.rewrite_mode>` 一起传给组装脚本。用户要求本轮不带历史时加 `--no-history`。若材料超限，或当前模式、角色与本轮设置不符，保留原稿。提交 prompt 前再运行第一个 `check`，确认原项目仍允许调用，改写模式、服务路由与模型均与之前一致，用户要求仍有效，只提交一次。服务故障按步骤收尾，用 `node …/hooks/preferences.mjs note-failure <固定故障码> --cwd "<原项目目录>"` 记录，再保留原稿。记录失败也保留原稿。
4. Gemini 返回后，在本机调用 `scripts/text_guard.mjs review --rewrite-mode <check.rewrite_mode>`，传入原始 `question`、`draft` 和完整 `candidate`。常规回复同时传入 `display_language`（`zh` 或 `en`），用户只看润色正文时省略此字段。保留完整输出。若 `ok` 为真，使用返回的 `text` 或 `display_text` 准备交付。若返回 `reason: "unchanged_candidate"`，说明 Turbo 收到的仍是原稿（忽略首尾空白和换行风格），按下文说明原因并保留原稿。其他校验失败也保留原稿。
5. 仅在第 4 步通过校验后，用 `node …/hooks/preferences.mjs finish --cwd "<原项目目录>" --trigger <auto或explicit> --route <第2步返回的route> --rewrite-mode <check.rewrite_mode>` 在本机确认项目仍允许交付。标准输入留空，有恢复标记时传 `--recovery-token <标记>`。`action: "accept"` 时交付第 4 步通过校验的结果，其他情况保留原稿。

## 在最终消息中交付

- **常规回复**逐字发送第 4 步的 `display_text`。有改动时，先显示 Gemini 润色版，下方的 `<details>` 区块保留完整 GPT 原稿。保留脚本生成的折叠标记及本轮语言对应的展开标题“查看 GPT 原稿”或“View original GPT draft”。在普通模式下，两版逐字相同时只显示一次正文，标题说明 Gemini 返回了相同原稿。不要另写前言、摘要或差异说明，不要让用户去工具日志查原稿。
- **保留原稿**时，在最初的完整原稿前用界面语言说明本轮的实际结果。发送前跳过可写“本轮未润色，以下是 GPT 原稿。”OpenAI 判断无需改写可写“OpenAI 判断无需润色，以下是 GPT 原稿。”请求失败写“润色未完成，以下是 GPT 原稿。”Turbo 模式下 Gemini 返回相同文字时写“Gemini 返回了原稿，以下是 GPT 原稿。”或“Gemini returned the original GPT draft.”此时直接保留原稿，不重试。其他改稿被拒写“润色稿未通过检查，以下是 GPT 原稿。”只说明有证据的原因，不展示被拒的内容、凭据或服务端原始报错。
- **只看润色正文**时，采用候选就逐字发送 `text`，否则逐字发送最初的原稿。不加标题、状态或对照。固定格式、关闭、取消继续遵守前述规则。

不为展示多调用一次模型，不重发结果不明或失败的付费请求。若上下文恢复后无法确认先前的请求状态，放弃候选。用户中途修正要求就丢弃旧候选，回答最新要求。排查故障时可报告阶段、固定故障码和剩余等待时间。
