---
name: codex-polish
description: Uses Gemini to polish Codex's final reply when you ask, or when project auto mode prompts. 你要求润色这轮回复，或项目自动模式触发时运行。
---

# 润色本轮回复

先完成用户任务，准备一份本来就可以交付的完整正文。始终保留这份原稿。只在最终答复前运行一次，不润色工具调用、进度更新或待原样交付的文件。

## 本轮可否处理

用本文件的安装位置定位 `scripts/`、`references/` 和 `../../hooks/preferences.mjs`。记住**本轮开始时实际工作目录的绝对路径**（即使它是仓库的子目录），后面的 `--cwd` 始终用它。用户本轮主动点名时 `--trigger explicit`，仅因项目提醒触发时 `--trigger auto`。重复的提醒只处理一次。用户本轮禁止外发、材料不适合外发、宿主无法持续读写并回收同一个子进程，直接交付原稿。

使用 Node.js 22.16 或更新版本。先在实际执行工具的环境运行 `node …/hooks/preferences.mjs check --cwd "<原项目目录>"`。模式为 `off`、仅提醒触发而模式为 `manual`、`blockers` 非空、或自动触发且 `cooldown` 非空时，直接交付原稿。找不到 Node.js、帮助脚本无法运行或结果不完整，也沿用原稿。记下本轮 `gemini_model`，默认值为 `gemini-4-hydrogen`。插件状态提示使用本项目的界面语言。在自动语言模式下优先跟随本轮用户说的中文或英文，无法判断时用 `check.ui_language`。最终答复始终保持待润色原稿的语言。按 `google_auth_method` 选择 ACP 步骤。默认的 `existing-session` 由官方进程使用已有登录，直接建立新会话。显式指定 API key 或企业身份时，才发送对应的认证请求。CLI 能否找到 `codex` 供安装排查参考，正在运行的宿主可以直接提供执行工具。

用户规定只给命令、JSON、补丁、逐字引用或其他固定格式时，按指定格式交付。只取本轮问题、当前有效的用户要求和答复原稿。这两个字段只写本轮材料。需要改写时，脚本会按当前项目的历史轮数为 ACP 附上最近的完整问答，默认 2 轮，最多 10 轮，设为 0 时只发本轮材料。不要自行查阅、挑选、概括或转录前文。

## 判定、改写与交付

下面的脚本均用 Node.js 运行，从标准输入接收一个 UTF-8 JSON 对象，读标准输出的 JSON。使用宿主的安全 stdin；只有 shell 可用时，用 JSON 序列化器生成单行 JSON，再用单引号 heredoc 分隔符送入脚本。不要把正文插进 shell 表达式或当命令执行，不写草稿到项目文件。所有步骤检查退出状态与返回字段。失败时交付原稿。

1. 调用 `scripts/text_guard.mjs prepare`，输入 `{"question":问题,"draft":原稿}`。若 `bypass` 为真，直接交付原稿。保存成功结果中的 `protected_question` 和 `protected_draft`。下文的“受保护文本”均指这两个返回值。
2. 看本轮 `check.decisions_enabled`。为真时选择 `decisions`，为假时选择 `acp`。运行 `node …/hooks/preferences.mjs decision judge --cwd "<原项目目录>" --trigger <auto或explicit> --route <所选路由>`，等待 `action: "rewrite"`。保存返回的 `route` 和可能的 `recovery_token`。两条路径的输入如下。
   - `acp`：这个入口只在本地检查项目模式、依赖和冷却状态，标准输入留空。符合条件就继续改写，即便原稿已经很通顺。
   - `decisions`：从标准输入提供受保护的 `question` 和 `draft`，供 OpenAI 做风格判定。需要改写的概率达到 0.80 才继续。
3. 读取 [ACP 操作步骤](references/acp.md)。**你就是 ACP 客户端。** 在本轮用你的持久执行工具启动官方 `agy acp`，对同一个进程逐条收发。按步骤用 acp_payload.mjs 组装一次改写请求，由当前 agent 将它直接交给同一个进程。不要委派给子 agent，不写或启动 ACP 驱动脚本、MCP 代理或后台服务。发送 prompt 前再运行第一个 `check`，确认原项目仍允许本次调用、Decisions 路由与第 2 步一致、`gemini_model` 与建立 ACP 会话前相同且本轮要求仍有效，再提交一次。当前要求仅允许外发本轮内容时，按 ACP 步骤省略历史。发生服务故障且用户仍在等待时，按操作步骤收尾，用 `node …/hooks/preferences.mjs note-failure <固定故障码> --cwd "<原项目目录>"` 记录原因，再交付原稿。记录失败也交付原稿。
4. 调用 `scripts/text_guard.mjs restore`，输入原始 `question`、原始 `draft` 和受保护的 `candidate`。仅当返回 `ok: true`，才保留还原的 `text`。若 `route` 为 `decisions` 且它与原稿相同，可以直接交付原稿。
5. 调用 `node …/hooks/preferences.mjs decision verify --cwd "<原项目目录>" --trigger <auto或explicit> --route <第2步返回的route>`。第 2 步返回了恢复标记时传入 `--recovery-token <标记>`。
   - `acp`：标准输入留空。本地确认项目仍允许改写后，返回 `action: "accept"` 即逐字交付第 4 步还原的正文。这条路径没有模型原意复核。
   - `decisions`：从标准输入提供受保护的 `question`、`draft` 和 ACP 返回的 `candidate`。仅在 OpenAI 判断实质变化概率不超过 0.05 且返回 `action: "accept"` 时交付还原稿。

   若本轮项目设置或凭据变化导致路由不一致，或任一步失败，交付原稿。

任一步出错都不自动重发付费请求。若上下文恢复后无法确认先前的请求状态，放弃该候选。用户中途取消就结束本轮；收到修正要求则丢弃旧候选，回答最新要求。单篇文本被拒绝、固定内容冲突，或启用 Decisions 时被判为已足够清楚、可能改变原意，都只影响这一篇。

自动模式正常交付原稿即可。用户主动点名且因配置或服务故障跳过时，可用一句进度提示说明原因，如“这轮保留原稿，当前 Codex 环境找不到 agy。”最终正文保持原样。用户要求严格格式时不额外提示。排查时报告阶段、固定故障码及剩余等待时间，隐藏材料及凭据。
