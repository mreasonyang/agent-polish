# 当前 agent 操作 Antigravity ACP

全程由当前 Codex agent 持有并操作执行工具的进程句柄。在宿主的执行工具里逐条收发，agent 决定每一帧的内容、发送时机和去向；同一轮的句柄、协议会话 ID、待处理请求 ID 和已收到的文本分别保存。不要运行代你读写 ACP 的程序。下列帧中的尖括号均须替换为本次协商结果。

收到 `action: "rewrite"` 后，本轮的目标是将草稿提交给 Gemini 并取得回复。保留原稿，每轮最多创建一个进程并提交一次 prompt。只有收到本轮 prompt 的结束响应，或实际触发下文的停止条件，才进入回收。发生错误只向上层返回固定原因码，服务端的原始报错可能含材料或账号信息。

## 启动和认证

1. 确认宿主支持持续输入、中断与回收，检查返回的 `agy_path` 是官方 Antigravity CLI 可执行文件的绝对路径。要求 1.2.1 或更新版本。使用本地环境检查返回的 `google_auth_method`。默认 `existing-session` 表示让官方进程自行使用已有登录。凭据文件和密钥值始终由 `agy` 管理，不要读取、打印或向用户索取。专用角色会去掉默认工具并关闭命令自动执行；Antigravity 部署自己的 hooks 仍可能运行。
2. 用执行工具运行 `mktemp -d`，保留它返回的绝对路径。以该目录为工作目录，创建 `.agents/agents/codex-polish-editor/`。改写时运行下面的命令，将当前项目的编辑角色写入私有工作区，成功后才启动 ACP。本轮不带历史时也传原项目目录。只检查连接或查看模型菜单时，使用随插件分发的[默认角色](codex-polish-editor.md)，直接复制到同一路径即可。

   ```sh
   node "<Skill 目录>/scripts/editor_role.mjs" --cwd "<原项目绝对路径>" --trigger "<本轮触发方式>" > .agents/agents/codex-polish-editor/agent.md
   ```

   这个工作区只含角色文件，角色允许的工具列表为空，关闭命令自动执行。用 `agy acp --agent codex-polish-editor --sandbox` 启动官方进程；启动前清除其子进程环境的 `OPENAI_API_KEY`。角色无法发现就回原稿。不要附加项目目录或编辑器工具。在 macOS/Linux 的本轮私有临时目录中，用 `mkfifo -m 600 .acp-in` 创建输入管道。用持久执行工具启动官方进程，令它从该管道读入、向执行工具输出。保留进程句柄并持续读取输出。将下例中的 `<agy_path>` 换成 `check.agy_path` 并按一个 shell 参数安全引用，即使桌面端的 PATH 缺少它的目录也能启动。下列命令在临时目录执行；若使用 PTY，选 `tty: true`、`login: false`。

   ```sh
   unset OPENAI_API_KEY
   if [ -t 1 ]; then stty -echo -onlcr; fi
   printf '%s\n' "$$" > .acp-pid &&
     exec "<agy_path>" acp --agent codex-polish-editor --sandbox 0<>.acp-in 2>/dev/null
   ```

   保留返回的执行会话 `session_id`。角色与管道准备失败或宿主无法控制进程时，按 `acp_start_failed` 收尾。若宿主能在同一工具调用内把原始结果直接传给持久 stdin，也可沿用该原生输入通道；两种方式都只启动一次官方进程。
3. 对输入管道逐次写入一条完整的 JSON 行，然后从同一运行句柄读返回值。用执行工具在临时目录执行 `printf '%s\n' '<已安全引用的一帧>' > .acp-in`；有参数的文本始终交给 JSON 序列化器和安全引用，不拼入命令代码。若管道写入阻塞，检查官方进程是否仍在运行；若宿主取消或进程已退出，中断写入并回收。每帧通过 JSON 序列化器生成，末尾追加一个换行。正文中的换行属于 JSON 字符串；不可拆成多个请求或把正文当作 shell 命令执行。先发下列帧并等待对应的 `id`：

   ```json
   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"codex-polish","version":"0.0.1-beta.4"}}}
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

改写时，将匹配请求 ID 的单条成功响应原样通过标准输入交给[配置解析脚本](../scripts/acp_models.mjs)。例如，`session/new` 成功后运行 `node "<脚本绝对路径>" --response-id 3 --target-model "<check.gemini_model>"`。它只读取配置并返回下一步。当前 agent 按返回值操作同一进程：

| `next` | 下一步 |
| --- | --- |
| `set_model` | 发送 `session/set_config_option`，请求 ID 用 4，使用返回的 `config_id` 和 `value`。把匹配响应再交给脚本，这次用 `--response-id 4` 和原目标模型。 |
| `submit_prompt` | 模型已就绪。立即执行下节的提交前检查，通过后发送唯一的一次 `session/prompt`（ID 6），等待对应回复。 |

只设置项目选定的模型，思考档位沿用 `agy` 当前的设置。以下请求的 `configId` 和 `value` 取自脚本输出：

```json
{"jsonrpc":"2.0","id":4,"method":"session/set_config_option","params":{"sessionId":"<会话 ID>","configId":"<config_id>","value":"<value>"}}
```

若选项解析失败、目标模型缺失或服务端没有应用请求的设置，记 `acp_model_unavailable` 并收尾。从目标模型选中起，到 prompt 结束，将本会话每条 `config_option_update` 通知原样传给 `acp_models.mjs --update-session "<本次 ACP 会话 ID>" --target-model "<check.gemini_model>"`。模型匹配时脚本返回当前模型和列表，继续处理后续帧。若模型消失或发生变化，脚本返回失败，丢弃已收内容并记 `acp_model_unavailable`。只有上表中的请求响应才能触发提交。

## 提交一次、读到结束

当上一步返回 `submit_prompt`，用原项目目录用同一 `--trigger` 再次运行 `preferences.mjs check`。确认本轮仍允许调用、改写模式、路由和模型与开始时一致，且用户未取消或禁止外发，随即发送草稿。若检查阻止提交，按检查给出的具体原因保留原稿。

发送 prompt 前，用 [请求组装脚本](../scripts/acp_payload.mjs) 的绝对路径和**原项目目录**。将本次会话 ID、通过本地检查的目标问题和原稿原样作为 `sessionId`、`question` 和 `draft` 传入脚本的标准输入。在本轮临时目录执行以下命令，把 JSON-RPC 帧直接交给已经打开的官方进程。传入已加载的角色文件、本轮触发方式、判定步骤返回的 `route`，以及初次检查返回的模型 ID 和改写模式。从旧问答取原稿时加同一个 `--turns-back N`。仅改用户引用的文字，或用户要求省略历史时，加 `--no-history`。显式 Turbo 收到用户的具体编辑要求时，输入 JSON 加入 `rewrite_request`。用本轮真实值替换示例内容。命令只把历史保存在内存中，不要先打印帧、让模型复述历史或把帧写入文件。

```sh
node "<插件内 acp_payload.mjs 的绝对路径>" --cwd "<原项目绝对路径>" --editor-role-file .agents/agents/codex-polish-editor/agent.md --rewrite-mode "<check.rewrite_mode>" --trigger "<auto、explicit 或 turbo>" --route "<判定返回的route>" --model "<check.gemini_model>" > .acp-in <<'CODEX_POLISH_INPUT'
{"sessionId":"<本次 ACP 会话>","question":"<原稿所答的问题>","draft":"<完整草稿原文>"}
CODEX_POLISH_INPUT
```

使用原生 stdin 通道时，在同一工具调用内部将脚本成功返回的完整 stdout 直接写入进程句柄，输出预算须足以容纳整帧。截断、脚本报错或传输结果不明时沿用原稿，不尝试重发。用户禁止外发时跳过整个流程。项目关闭改写、触发方式不再适用、路由、模型或模式变化、角色与当前提示词不符，或材料无法安全传输时，组装脚本不输出请求帧。本轮保留原稿，不记录为服务故障。

脚本生成一条 `session/prompt`（请求 id 为 6）。编辑规则由启动时加载的专用角色提供。采用项目自定义提示词时，普通和 Turbo 模式的角色正文都只有用户原文。若用户在这轮中途更改改写模式或润色提示词，结束当前 ACP 会话，新设置从下次改写生效。请求只有一个文本块，内容是含 `question`、`draft` 和可选 `history`、`rewrite_request` 的 JSON 对象序列化后的字符串。脚本在组装请求时读取原项目的历史轮数，默认 2 轮，最多附上 10 轮的历史问答。每轮以 `{"user":"…","assistant":"…"}` 表示目标答复之前一次已完成的问答，历史按时间排列。仅 Gemini 的请求可附带历史问答。按原文发送所选问答。轮数为 0 或找不到可用记录时，脚本省略 `history`。

按换行缓冲解析 JSON-RPC 2.0，保留跨读取的残帧。先用 `method` 区分服务端请求／通知和响应；两端各自分配的 ID 可能相同。每次最多一个待响应请求，响应必须有对应 ID（含类型）且只有 `result` 或 `error` 之一。进程仍在运行时，空读只表示暂无输出。按顺序处理同批中的通知与响应，忽略其他会话及思考、进度文本。只在本次 prompt 等待期间拼接本会话 `agent_message_chunk` 中 `content.type == "text"` 的字符串 `text`，逐字保留标点、空白和换行。正文夹有非文本内容就放弃整份候选。匹配的 `end_turn` 到达时必须已有完整非空正文，且没有之前触发的错误，即可交付已收到的 Gemini 正文。

## 故障与回收

使用宿主的短轮询保持响应。只要进程仍在运行且用户仍在等待，就继续读取；空读或长时间思考都不足以判定失败。由宿主或服务端明确报告超时才记作 `acp_timeout`。为每次读取留出足够的输出空间，检测截断。

| 遇到的情况 | 本轮结果 |
| --- | --- |
| 用户取消 Codex 回合，或更改了当前任务要求 | 丢弃旧候选并回收。用户取消时不再交付；有新要求时按新要求继续。 |
| 权限、文件、终端、外部工具请求或工具调用通知 | 丢弃候选，回原稿，记 `acp_tool_requested`。 |
| 服务端给出 `cancelled`、`refusal`、`max_tokens`、`max_turn_requests`，或 `end_turn` 正文为空白、含非文本 | 用户仍在等待时回原稿，记 `acp_turn_declined`。此前因超时或工具请求主动取消的，保留最初原因。 |
| EOF 出现在匹配的结束帧之前、宿主标明截断、进程句柄丢失，或写入结果不明 | 回原稿，记 `acp_incomplete`。即使退出码为零、已收到可读片段，也不重发。 |
| JSON／包络损坏、响应 ID 不符、无效会话 ID 或未知停止原因 | 回原稿，记 `acp_protocol_error`。 |
| 宿主或服务端明确报告超时 | 回原稿，记 `acp_timeout`。服务端限流、配额不足或其他运行时 error 记 `acp_provider_error`；认证错误优先归为 `acp_auth_failed`。 |

凡收到 `session/request_permission`，先用该请求自己的 `id` 回答 `{"jsonrpc":"2.0","id":"<服务端请求 ID>","result":{"outcome":{"outcome":"cancelled"}}}`（保留 ID 的实际类型）。其他不支持的客户端请求有 ID 时回复 JSON-RPC `-32601`，不执行工具。已发 prompt 且尚未结束、传输仍可用时，发送一次不含 ID 的通知：

```json
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<会话 ID>"}}
```

成功、失败和主动取消都收尾。仅在已建会话且服务端声明支持关闭时发 `session/close`。清理阶段总共最多额外等 3 秒；丢弃迟到的候选和结束帧。用宿主的终止功能回收本轮进程。Unix PTY 可向同一句柄写 Ctrl-C 字节 `\u0003`；Ctrl-D 在此模式下是普通字节。如果 Ctrl-C 后进程仍在，使用本轮临时目录中的 `.acp-pid`，核实 PID 当前仍运行 `agy acp` 且工作目录正是本轮临时目录，再向该 PID 发 TERM，必要时重新核实并发 KILL。不得按进程名批量终止。仅删除本轮自己创建的输入管道、PID 文件及角色文件，再用 `rmdir` 从内到外清理临时目录。

[Google ACP 与认证](https://antigravity.google/docs/ide/extensions/acp) · [自定义角色与工具名单](https://antigravity.google/docs/subagents/) · [默认工具开关](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1) · [ACP 传输](https://agentclientprotocol.com/protocol/v1/transports) · [会话选项](https://agentclientprotocol.com/protocol/v1/session-config-options) · [流式生成与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)
