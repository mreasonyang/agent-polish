# 由 Codex agent 直接操作 Antigravity ACP

当前 agent 用宿主的执行工具启动官方 `agy`，持有它的进程句柄，亲自读写 JSON-RPC。插件的 Node 工具只在本地准备角色、组装材料或解析已经收到的文本。不能把进程或数据流交给插件脚本、ACP 客户端、管道转发器或另一个代理。一次改写只提交一次草稿。

## 启动

1. 使用 `check.agy_path` 指向的官方程序。先运行 `node "<技能>/scripts/acp_workspace.mjs" --cwd "<本轮工作目录>" --trigger auto|explicit`。只发选段时加 `--selection-only`，模型查询或握手测试则只传 `--catalog`。保存返回的 `workspace`、`editor_role_file`、`output_file`、`cleanup_token`。临时目录中已建好角色和空的私有输出文件。
2. 宿主能直接提供完整标准流时，在 `workspace` 中启动 `[agy_path, "acp", "--agent", "codex-polish-editor", "--sandbox"]`。保留 stdin、stdout 和退出句柄，stderr 单独读，子进程环境移除 `OPENAI_API_KEY`。Codex 原生 `command/exec` 使用 `processId`、`tty:false`、`streamStdin:true`、`streamStdoutStderr:true`、`disableOutputCap:true`，逐段接收 stdout，用 `command/exec/write` 直接写入。若宿主只返回限长的工具输出，选择下一步的终端方式。
3. 使用 `exec_command` / `write_stdin` 时，在 macOS/Linux 用 `shell:"/bin/sh", login:false, tty:true, workdir:workspace` 执行下面的命令。用实际路径替换 agy 的占位路径，并正确转义 shell 单引号。保留 `session_id`，每帧用 `write_stdin` 直接发给该进程。命令将 agy 的 stdout 追加到上一步创建的文件。所有协议响应都从该文件按下节分页读取，终端句柄只需关注诊断和退出状态。Windows 使用[直接终端步骤](acp-windows.md)。

```sh
unset OPENAI_API_KEY
stty -icanon -echo -ixon -icrnl -onlcr isig intr '^C' min 1 time 0 && exec '/absolute/path/to/agy' acp --agent codex-polish-editor --sandbox >> provider-output.jsonl
```

## 握手、选择模型和档位

每帧是一行 UTF-8 JSON 加一个 LF。用宿主的序列化器生成字符串。Windows ConPTY 按[终端步骤](acp-windows.md)发送行末 LF。

- **终端读取。** 从字节位置 0 开始运行 `node "<技能>/scripts/acp_workspace.mjs" --read-output "<workspace>" "<cleanup_token>" <offset> 1024`。在宿主调用环境内解析返回的 JSON。确认 `next_offset - offset` 等于 `text` 的 UTF-8 字节数后才接上这一页并推进位置。工具报告截断、页的 JSON 不完整或长度不符时，丢弃这次读取，**从同一个 offset 重读**，可将页长减半（4–8192 字节）或提高该次工具输出额度。这只读取已收到的字节，不会再次调用 Gemini。空页表示暂时没有新字符，稍后从原处继续。进程退出时先读完文件中已写出的数据。
- **按帧处理。** 连续拼接各页或原始流的增量，以 LF 切分，只解析完整行，保留下一个片段才收齐的尾行。原始字节流使用连续的 UTF-8 解码器。设置模型时常同时收到很长的 `available_commands_update` 通知，解析后跳过该通知，继续处理同一批里的其他帧，包括服务端请求和当前请求 ID 的响应。宿主支持执行代码时，在调用环境中完成拼接和筛选，只向 agent 返回本步需要的字段。命令列表不参与模型或档位确认。
- **恢复。** 重读用于工具截断的分页。如果已完整读回的 LF 行本身是无效的协议消息，或进程退出且读到最后一页仍缺少所等的响应，结束本次请求并说明原因。设置阶段若原始流确实丢了字节（例如 `capReached:true`），且尚未开始写入 `session/prompt`，关闭并清理该进程，用上述可重读的终端方式重新握手一次。开始写入草稿后只恢复读取。发送状态不明时也不得重新提交草稿。

| id | 请求 | 如何使用响应 |
| --- | --- | --- |
| 1 | `initialize`，参数 `{"protocolVersion":1,"clientCapabilities":{}}` | 确认 `result.protocolVersion === 1`，记录是否支持 `session/close`。仅测试握手可在这里结束。 |
| 2 | 仅显式配置 API 或企业身份时发送 `authenticate`，参数 `{"methodId":"<google_auth_method>"}` | 所选方法须在 `authMethods` 中。默认 `existing-session` 直接进入下一步。 |
| 3 | `session/new`，参数 `{"cwd":"<workspace>","mcpServers":[]}` | 保存返回的 `sessionId` 和 `configOptions`。 |
| 4 | 若目标模型与当前值不同，发送 `session/set_config_option`，参数 `{sessionId, configId, value}` | 使用 category 为 `model` 的选择器实际 ID，value 为目标模型。以成功响应里的配置确认模型并读取该模型的档位。 |
| 5 | 若目标档位与当前值不同，同样发送 `session/set_config_option` | 使用该模型 `thought_level` 选择器的实际 ID 和已保存的档位。两项均确认后才可发送草稿。保存为 `fixed` 的模型须无档位选择器。 |

例如第一帧是 `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}`。服务端通知可与响应同时到达；协议请求的 id 由请求方指定。遇到 `session/request_permission`，用原请求 id 直接返回 `{"outcome":{"outcome":"cancelled"}}` 作为 `result`；其他不支持的服务端请求返回 JSON-RPC 错误 `-32601`。不执行 Gemini 请求的本地工具。

**查询模型**时，终端安装器从临时输出文件读到第 3 步的响应后就显示模型列表。等待用户选择时保持会话打开。如果用户选中当前模型，直接使用已有的档位。如果选中其他模型，在同一会话执行第 4 步，从响应中的 `configOptions` 读取档位。查询结束或用户取消时关闭会话。整个过程只读取配置，无需更改档位或发送草稿。模型或档位不可用时，说明原因。

## 改写与交付

用本地 `scripts/acp_payload.mjs --host-input --cwd "<本轮工作目录>" --editor-role-file "<editor_role_file>" --trigger <trigger> --route <route> --rewrite-mode <mode> --model <model> --thinking-level <level>` 准备请求。带上本轮的 `--no-history`、`--turns-back N`、`--selection` 或 `--selection-only`。通过该离线工具自己的输入句柄传 `{sessionId, question, draft}` 或 `{sessionId, selection}`。主动请求可带 `rewrite_request`，只发选段时省略。

1. 拼好离线工具返回的完整请求，使用宿主写入工具把这行原样发给 **agy 的句柄**。长帧可按完整 Unicode 字符分块，只在最后一块加行尾符。Windows ConPTY 使用[终端步骤](acp-windows.md)中的输入序列，其他直接进程工具和终端追加一个 LF。不要重新输入、转述或重写材料。
2. 从已经确认的读取位置继续，保存 id 6 阶段的完整协议输出和换行。设置阶段已开始的一行即使跨页也归设置阶段。中途收到权限请求时用 agy 的句柄直接回应。持续读到 id 6 的终止响应。其他会话或模型思考文本不得当作润色正文。
3. 在本地运行 `scripts/acp_answer.mjs --host-input --cwd "<本轮工作目录>" --session-id "<sessionId>" --model <model> --thinking-level <level> --trigger <trigger>`。`--trigger` 沿用本轮请求的 `auto` 或 `explicit`，普通和 Turbo 模式都按实际触发方式排版。选段时加 `--selection`，旧回答用 `--turns-back N`。传 `{draft, question?, output, display_language?, source_label?}`。`draft` 是实际提交的原稿（选段即选中的文字），`output` 是宿主已经收到的 id 6 阶段原始输出。常规展示按聊天语言传 `display_language:"zh"` 或 `"en"`。主动请求缺少此字段时，原稿对照使用插件的界面语言。“用两句话解释”等篇幅要求沿用常规展示。只有用户明确只看正文，或要求输出严格格式（如纯 JSON）时，才加 `--body-only`。来源不明的可见原文传 `source_label:"quoted"`。该工具只在收到本会话非空正文且 id 6 返回 `end_turn` 时排版。按原文交付最终 Markdown。
4. 两个离线工具均可用普通 stdin 或带 `--host-input` 的独立终端。后一种等 `input_ready` 后输入单行 JSON 和 LF。结果是 `{text, more}`；若 `more:true`，等下一次 `input_ready`，在**离线工具**句柄输入空行取下一页，按顺序直接拼接各页的 `text`。将字符串和工具返回值保留在宿主调用环境中，避免把草稿、协议流写入命令、项目文件或聊天进度消息。

## 结束或取消

取消正在生成的回复时，agent 在 agy 的句柄发送 `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<sessionId>"}}`。无论成功、失败、取消或仅查询，均结束**本次**进程。有会话且提供 `session/close` 时发送 id 7 和该 sessionId，随后通过宿主关闭 stdin 或终止该进程。macOS/Linux PTY 发送 Ctrl-C，并等进程退出；Windows 参照终端步骤。最后从临时目录外运行 `node "<技能>/scripts/acp_workspace.mjs" --dispose "<workspace>" "<cleanup_token>"`。

[ACP 标准流](https://agentclientprotocol.com/protocol/v1/transports) · [会话配置](https://agentclientprotocol.com/protocol/v1/session-config-options) · [生成与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)
