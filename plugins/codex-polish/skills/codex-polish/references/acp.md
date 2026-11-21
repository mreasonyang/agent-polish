# 由 Codex agent 直接操作 Antigravity ACP

当前 agent 用宿主的执行工具启动官方 `agy`，持有它的进程句柄，亲自读写 JSON-RPC。插件的 Node 工具只在本地准备角色、组装材料或解析已经收到的文本。不能把进程或数据流交给插件脚本、ACP 客户端、管道转发器或另一个代理。一次改写只提交一次草稿。

## 启动

1. 使用 `check.agy_path` 指向的官方程序。先运行 `node "<技能>/scripts/acp_workspace.mjs" --cwd "<原项目>" --trigger auto|explicit`；只发选段时加 `--selection-only`，模型查询或握手测试则只传 `--catalog`。保存返回的 `workspace`、`editor_role_file`、`cleanup_token`。临时目录包含本次编辑角色。
2. 如果宿主直接提供能读写标准流的进程工具，在 `workspace` 中启动参数数组 `[agy_path, "acp", "--agent", "codex-polish-editor", "--sandbox"]`。保留可写 stdin、原始 stdout 和进程退出句柄，stderr 单独读，子进程环境移除 `OPENAI_API_KEY`。例如宿主已暴露的 Codex `command/exec` 可用 `processId`、`tty:false`、`streamStdin:true`、`streamStdoutStderr:true`，向同一进程用 `command/exec/write` 写 UTF-8 字节。只使用当前宿主已经提供的工具。
3. 如果宿主提供的是 `exec_command` / `write_stdin`，在 macOS/Linux 用 `shell:"/bin/sh", login:false, tty:true, workdir:workspace` 执行下面的命令。将占位路径替换为实际路径，用 shell 单引号正确转义。保留返回的 `session_id`；每一帧用 `write_stdin` 直接写到这个句柄，并从同一个句柄读回复。Windows 使用[直接终端步骤](acp-windows.md)。宿主缺少可持续写入的直接进程工具时，说明限制并交付原稿。

```sh
unset OPENAI_API_KEY
stty -icanon -echo -ixon -icrnl -onlcr isig intr '^C' min 1 time 0 && exec '/absolute/path/to/agy' acp --agent codex-polish-editor --sandbox
```

## 握手、选择模型和档位

每帧是一行 UTF-8 JSON 加一个 LF。用宿主的序列化器生成字符串。持续收集写入和空读返回的输出，按行解析，保留下一次才收全的尾行，直到收到本次请求的响应。流式字节使用连续的 UTF-8 解码器。留足输出预算，保证工具不会截掉原始响应。若已截断、JSON 损坏或进程异常退出，交付原稿；不要重发草稿。

| id | 请求 | 如何使用响应 |
| --- | --- | --- |
| 1 | `initialize`，参数 `{"protocolVersion":1,"clientCapabilities":{}}` | 确认 `result.protocolVersion === 1`，记录是否支持 `session/close`。仅测试握手可在这里结束。 |
| 2 | 仅显式配置 API 或企业身份时发送 `authenticate`，参数 `{"methodId":"<google_auth_method>"}` | 所选方法须在 `authMethods` 中。默认 `existing-session` 直接进入下一步。 |
| 3 | `session/new`，参数 `{"cwd":"<workspace>","mcpServers":[]}` | 保存返回的 `sessionId` 和 `configOptions`。 |
| 4 | 若目标模型与当前值不同，发送 `session/set_config_option`，参数 `{sessionId, configId, value}` | 使用 category 为 `model` 的选择器实际 ID，value 为目标模型。以成功响应里的配置确认模型并读取该模型的档位。 |
| 5 | 若目标档位与当前值不同，同样发送 `session/set_config_option` | 使用该模型 `thought_level` 选择器的实际 ID 和已保存的档位。两项均确认后才可发送草稿。保存为 `fixed` 的模型须无档位选择器。 |

例如第一帧是 `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}`。服务端通知可与响应同时到达；协议请求的 id 由请求方指定。遇到 `session/request_permission`，用原请求 id 直接返回 `{"outcome":{"outcome":"cancelled"}}` 作为 `result`；其他不支持的服务端请求返回 JSON-RPC 错误 `-32601`。不执行 Gemini 请求的本地工具。

**查询模型**只需第 3 步的模型列表；查询指定模型的档位，可以执行第 4 步，读取选定模型的 `configOptions` 后即结束。无需更改档位或发送草稿。安装时按安装器的请求返回真实响应。模型或档位不在对应选项中时，说明原因。

## 改写与交付

用本地 `scripts/acp_payload.mjs --host-input --cwd "<原项目>" --editor-role-file "<editor_role_file>" --trigger <trigger> --route <route> --rewrite-mode <mode> --model <model> --thinking-level <level>` 准备请求。带上本轮的 `--no-history`、`--turns-back N`、`--selection` 或 `--selection-only`。通过该离线工具自己的输入句柄传 `{sessionId, question, draft}` 或 `{sessionId, selection}`。主动请求可带 `rewrite_request`，只发选段时省略。

1. 拼好离线工具返回的完整请求，使用宿主写入工具把这行原样发给 **agy 的句柄**，只在末尾追加一个 LF。长帧可按完整 Unicode 字符分块，只在最后一块追加 LF。不要重新输入、转述或重写材料。
2. 保存从提交后开始收到的完整协议输出，包含各行的换行，持续读到 id 6 的终止响应。中途收到权限请求时用 agy 的句柄直接回应。其他会话或模型思考文本不得当作润色正文。
3. 在本地运行 `scripts/acp_answer.mjs --host-input --cwd "<原项目>" --session-id "<sessionId>" --model <model> --thinking-level <level>`。选段时加 `--selection`，旧回答用 `--turns-back N`。传 `{draft, question?, output, display_language?, source_label?}`；这里的 `draft` 是实际提交的原稿（选段即选中的文字），`output` 是宿主已经收到的 id 6 阶段原始输出。常规展示传 `zh` 或 `en`；只要正文时省略 `display_language`。来源不明的可见原文传 `source_label:"quoted"`。该工具只在收到本会话非空正文且 id 6 返回 `end_turn` 时排版。按原文交付最终 Markdown。
4. 两个离线工具均可用普通 stdin 或带 `--host-input` 的独立终端。后一种等 `input_ready` 后输入单行 JSON 和 LF。结果是 `{text, more}`；若 `more:true`，等下一次 `input_ready`，在**离线工具**句柄输入空行取下一页，按顺序直接拼接各页的 `text`。将字符串和工具返回值保留在宿主调用环境中，避免把草稿、协议流写入命令、项目文件或聊天进度消息。

## 结束或取消

取消正在生成的回复时，agent 在 agy 的句柄发送 `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<sessionId>"}}`。无论成功、失败、取消或仅查询，均结束**本次**进程。有会话且提供 `session/close` 时发送 id 7 和该 sessionId，随后通过宿主关闭 stdin 或终止该进程。macOS/Linux PTY 发送 Ctrl-C，并等进程退出；Windows 参照终端步骤。最后从临时目录外运行 `node "<技能>/scripts/acp_workspace.mjs" --dispose "<workspace>" "<cleanup_token>"`。

[ACP 标准流](https://agentclientprotocol.com/protocol/v1/transports) · [会话配置](https://agentclientprotocol.com/protocol/v1/session-config-options) · [生成与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)
