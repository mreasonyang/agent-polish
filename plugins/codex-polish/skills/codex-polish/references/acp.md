# 当前 agent 操作 Antigravity ACP

全程由当前 Codex agent 持有并操作执行工具的进程句柄。在宿主的执行工具里逐条收发，agent 决定每一帧的内容、发送时机和去向；同一轮的句柄、协议会话 ID、待处理请求 ID 和已收到的文本分别保存。不要运行代你读写 ACP 的程序。下列帧中的尖括号均须替换为本次协商结果。

改写时保留原稿，每轮最多创建一个进程并提交一次 prompt。设置引导读取模型菜单时只建会话，取得选项后直接收尾。任一写入或读取失败后按末节收尾，结果不明时也不重放。发生错误只向上层返回固定原因码，服务端的原始报错可能含材料或账号信息。

## 启动和认证

1. 确认宿主支持持续输入、中断与回收，检查返回的 `agy_path` 是官方 Antigravity CLI 可执行文件的绝对路径。要求 1.2.1 或更新版本。使用本地环境检查返回的 `google_auth_method`。默认 `existing-session` 表示让官方进程自行使用已有登录。凭据文件和密钥值始终由 `agy` 管理，不要读取、打印或向用户索取。专用角色会去掉默认工具并关闭命令自动执行；Antigravity 部署自己的 hooks 仍可能运行。
2. 用执行工具运行 `mktemp -d`，保留它返回的绝对路径。以该目录为工作目录，创建 `.agents/agents/codex-polish-editor/`，把随 Skill 分发的 [纯文本编辑角色](codex-polish-editor.md) 复制到 `.agents/agents/codex-polish-editor/agent.md`。这个工作区只含角色文件，角色允许的工具列表为空，关闭命令自动执行。用 `agy acp --agent codex-polish-editor --sandbox` 启动官方进程；启动前清除其子进程环境的 `OPENAI_API_KEY`。角色无法发现就回原稿。不要附加项目目录或编辑器工具。在 macOS/Linux 的本轮私有临时目录中，用 `mkfifo -m 600 .acp-in` 创建输入管道。用持久执行工具启动官方进程，令它从该管道读入、向执行工具输出。保留进程句柄并持续读取输出。将下例中的 `<agy_path>` 换成 `check.agy_path` 并按一个 shell 参数安全引用，即使桌面端的 PATH 缺少它的目录也能启动。下列命令在临时目录执行；若使用 PTY，选 `tty: true`、`login: false`。

   ```sh
   unset OPENAI_API_KEY
   if [ -t 1 ]; then stty -echo -onlcr; fi
   printf '%s\n' "$$" > .acp-pid &&
     exec "<agy_path>" acp --agent codex-polish-editor --sandbox 0<>.acp-in 2>/dev/null
   ```

   保留返回的执行会话 `session_id`。角色与管道准备失败或宿主无法控制进程时，按 `acp_start_failed` 收尾。若宿主能在同一工具调用内把原始结果直接传给持久 stdin，也可沿用该原生输入通道；两种方式都只启动一次官方进程。
3. 对输入管道逐次写入一条完整的 JSON 行，然后从同一运行句柄读返回值。用执行工具在临时目录执行 `printf '%s\n' '<已安全引用的一帧>' > .acp-in`；有参数的文本始终交给 JSON 序列化器和安全引用，不拼入命令代码。若管道写入阻塞，限定在同一控制请求的期限内中断本次写入并回收服务。每帧通过 JSON 序列化器生成，末尾追加一个换行。正文中的换行属于 JSON 字符串；不可拆成多个请求或把正文当作 shell 命令执行。先发下列帧并等待对应的 `id`：

   ```json
   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"codex-polish","version":"0.0.1-beta.2"}}}
   ```

   确认 `result.protocolVersion == 1`。生产中若服务端提供 `agentInfo.name`，应与官方 `Antigravity ACP Server` 一致，身份或协议版本冲突记 `acp_protocol_error`。

   **默认使用现有登录。** 未设置 `CODEX_POLISH_AGY_AUTH` 或显式设为 `existing-session` 时，下一帧直接发下节的 `session/new`，跳过 `authenticate`。`existing-session` 是插件的设置值，勿将它作为协议的 `methodId` 发送。`result.authMethods` 列出可选的认证方式，不能用它判断用户是否已登录。

   **显式指定认证方式时**，若用户设置 `CODEX_POLISH_AGY_AUTH=gemini-api-key` 或 `agent-platform`，先核对 `result.authMethods` 中有同名 ID，再发送一次 `authenticate`。仅发送选中的方法 ID。等服务端返回成功后才创建会话。未列出所选方法或认证失败时，记 `acp_auth_failed`，沿用原稿并回收进程。以下仅为显式选用 API key 的例子。

   ```json
   {"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"gemini-api-key"}}
   ```

## 建立会话并选择模型

发出下列请求，记录实际返回的非空字符串 `sessionId` 和最新的 `configOptions`。执行工具的 `session_id` 只用于控制进程。

```json
{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"<绝对临时目录>","mcpServers":[]}}
```

如果建会话返回 ACP 认证错误 `-32000`（Authentication required），记 `acp_auth_failed`，本轮保留原稿并回收进程。不要提交草稿、改选身份、打开登录或重试。用户排查默认登录时，提示在运行 Codex 的同一系统账号和机器上，自行打开官方 `agy` 完成登录，再点名改写。显式认证模式下提示检查所选身份。

将匹配请求 ID 的单条成功响应通过标准输入传给 [模型列表脚本](../scripts/acp_models.mjs)，例如 `node "<脚本绝对路径>" --response-id 3`。它只解析这条 JSON，输出配置项 `config_id`、当前选中的 Gemini ID `current_model`（也可能为 `null`）和按服务端顺序排列的 `models`。每项有模型显示名 `name` 和协议原值 `id`。设置引导列出这些选项后关闭会话，不需要发送 prompt。

改写时按项目的 `check.gemini_model` 精确匹配本次列表中的 `id`。解析失败、列表为空或目标缺失时，记 `acp_model_unavailable`，保留原稿。若 `current_model` 已等于目标 ID 就继续，否则发送下列请求。

```json
{"jsonrpc":"2.0","id":4,"method":"session/set_config_option","params":{"sessionId":"<会话 ID>","configId":"<模型配置项 ID>","value":"<目标 Gemini 的确切 ID>"}}
```

将匹配的响应交给同一脚本（使用本次实际请求 ID），确认 `current_model` 与目标 ID 相同。从最新选项读取所选模型提供的思考档位（通常 `category: "thought_level"`）。若有 Low 且尚未选中，以新请求 ID 选择 Low，并再次核对最新响应中的模型和档位。没有 Low 时沿用该模型自己的档位。直到 prompt 结束，逐个核对本会话的 `config_option_update`，通过标准输入将通知整帧交给同一脚本的 `--update-session "<本次 ACP 会话 ID>"`。若所选模型消失、标识发生变化或不再是当前模型，丢弃已收内容并记 `acp_model_unavailable`。

## 提交一次、读到结束

发送 prompt 前，用 [请求组装脚本](../scripts/acp_payload.mjs) 的绝对路径和**原项目目录**。脚本通过标准输入接收 `{"sessionId":"<本次 ACP 会话>","question":"<受保护的本轮问题>","draft":"<受保护的原稿>"}`。在本轮临时目录执行以下命令，将返回的一条 JSON-RPC 帧直接交给已经打开的官方进程。用本轮真实值替换示例内容。命令只把历史保存在内存中，不要先打印帧、让模型复述历史或把帧写入文件。

```sh
frame=$(node "<插件内 acp_payload.mjs 的绝对路径>" --cwd "<原项目绝对路径>" <<'CODEX_POLISH_INPUT'
{"sessionId":"<本次 ACP 会话>","question":"<受保护的问题>","draft":"<受保护的原稿>"}
CODEX_POLISH_INPUT
) && printf '%s\n' "$frame" > .acp-in
```

使用原生 stdin 通道时，在同一工具调用内部将脚本成功返回的完整 stdout 直接写入进程句柄，输出预算须足以容纳整帧。截断、脚本报错或传输结果不明时沿用原稿，不尝试重发。用户本轮禁止附带历史时，省略 `--cwd`；禁止外发时跳过整个流程。

脚本生成一条 `session/prompt`（请求 id 为 6）。第一块是编辑指令，第二块是包含 `question`、`draft` 以及可选 `history` 的 JSON 文本。脚本在组装请求时读取原项目的历史轮数，默认 2 轮，最多附上 10 轮、合计 16 KiB 的历史正文。每轮以 `{"user":"…","assistant":"…"}` 表示本轮之前一次已完成的问答，历史按时间排列。它帮助理解指代和语气，新结论必须在原稿中有依据。启用 Decisions 时，两次判定只使用本轮材料。轮数为 0 或找不到可用记录时，脚本省略 `history`。

按换行缓冲解析 JSON-RPC 2.0，保留跨读取的残帧。先用 `method` 区分服务端请求／通知和响应；两端各自分配的 ID 可能相同。每次最多一个待响应请求，响应必须有对应 ID（含类型）且只有 `result` 或 `error` 之一。进程仍在运行时，空读只表示暂无输出。按顺序处理同批中的通知与响应，忽略其他会话及思考、进度文本。只在本次 prompt 等待期间拼接本会话 `agent_message_chunk` 中 `content.type == "text"` 的字符串 `text`，逐字保留标点、空白和换行。正文夹有非文本内容就放弃整份候选。匹配的 `end_turn` 到达时必须已有完整非空正文，且没有之前触发的错误，才能进入本地校验。

## 故障与回收

从提交每次控制请求起限时 10 秒，等待生成期间连续 30 秒没有本会话有效进度也停止。启动以来的硬上限为 90 秒，外层剩余预算更短时服从外层。用单调时钟和短轮询实现限时。宿主最短轮询已超过剩余预算时提前收尾；连续空读、无关通知和片段都不延长硬上限。为每次读取设置足够的工具输出上限；拼接后的候选限 128 KiB UTF-8，与本地文本校验相同。

| 遇到的情况 | 本轮结果 |
| --- | --- |
| 用户取消 Codex 回合，或更改了当前任务要求 | 丢弃旧候选并回收。用户取消时不再交付；有新要求时按新要求继续。 |
| 权限、文件、终端、外部工具请求或工具调用通知 | 丢弃候选，回原稿，记 `acp_tool_requested`。 |
| 服务端给出 `cancelled`、`refusal`、`max_tokens`、`max_turn_requests`，或 `end_turn` 正文为空白、超出本地大小上限、含非文本 | 用户仍在等待时回原稿，记 `acp_turn_declined`。此前因超时或工具请求主动取消的，保留最初原因。 |
| EOF 出现在匹配的结束帧之前、宿主标明截断、进程句柄丢失，或写入结果不明 | 回原稿，记 `acp_incomplete`。即使退出码为零、已收到可读片段，也不重发。 |
| JSON／包络损坏、响应 ID 不符、无效会话 ID 或未知停止原因 | 回原稿，记 `acp_protocol_error`。 |
| 请求逾期、持续静默或达到总时限 | 回原稿，记 `acp_timeout`。服务端限流、配额不足或其他运行时 error 记 `acp_provider_error`；认证错误优先归为 `acp_auth_failed`。 |

凡收到 `session/request_permission`，先用该请求自己的 `id` 回答 `{"jsonrpc":"2.0","id":"<服务端请求 ID>","result":{"outcome":{"outcome":"cancelled"}}}`（保留 ID 的实际类型）。其他不支持的客户端请求有 ID 时回复 JSON-RPC `-32601`，不执行工具。已发 prompt 且尚未结束、传输仍可用时，发送一次不含 ID 的通知：

```json
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<会话 ID>"}}
```

成功、失败和主动取消都收尾。仅在已建会话且服务端声明支持关闭时发 `session/close`。清理阶段总共最多额外等 3 秒；丢弃迟到的候选和结束帧。用宿主的终止功能回收本轮进程。Unix PTY 可向同一句柄写 Ctrl-C 字节 `\u0003`；Ctrl-D 在此模式下是普通字节。如果 Ctrl-C 后进程仍在，使用本轮临时目录中的 `.acp-pid`，核实 PID 当前仍运行 `agy acp` 且工作目录正是本轮临时目录，再向该 PID 发 TERM，必要时重新核实并发 KILL。不得按进程名批量终止。仅删除本轮自己创建的输入管道、PID 文件及角色文件，再用 `rmdir` 从内到外清理临时目录。

[Google ACP 与认证](https://antigravity.google/docs/ide/extensions/acp) · [自定义角色与工具名单](https://antigravity.google/docs/subagents/) · [默认工具开关](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1) · [ACP 传输](https://agentclientprotocol.com/protocol/v1/transports) · [会话选项](https://agentclientprotocol.com/protocol/v1/session-config-options) · [流式生成与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)
