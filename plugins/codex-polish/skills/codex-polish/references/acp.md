# 用宿主执行工具操作 Antigravity ACP

当前 Codex agent 直接调用官方 `agy acp`，每一帧都由当前 agent 提交。以下步骤适用于 T3、Codex App 和 CLI。每次改写只启动一个进程，提交一次草稿。需要 Antigravity CLI 1.2.1+。准备脚本创建本轮的编辑角色，并按当前系统生成宿主命令。Windows 使用 PowerShell，macOS 和 Linux 使用系统 shell。

## 1. 取得启动参数

在宿主执行工具中运行以下命令。脚本路径从本技能目录解析；其余值来自这次 `preferences.mjs check`。传入第 1 步选定的路由、改写模式，以及当前任务的 `--no-history`、`--turns-back N`、`--selection` 或 `--selection-only`。

```sh
node "<本技能>/scripts/acp_workspace.mjs" --cwd "<原项目>" --trigger "<auto 或 explicit>" --agy-path "<agy_path>" --auth "<google_auth_method>" --model "<gemini_model>" --route "<acp 或 decisions>" --rewrite-mode "<rewrite_mode>" --display "<zh、en 或 body-only>"
```

按本轮答复选择中文或英文展示；用户明确要求仅正文或严格格式时才选 `body-only`。无历史索引且无法确认整条原文是 GPT 原稿时加 `--quoted-source`。**把准备脚本返回的整个 `start` 对象原样作为宿主 `exec_command` 参数执行一次**。保存宿主返回的进程句柄 `session_id`。启动时和后面空读时，都处理返回的输出。

## 2. 按输出逐步操作

每行是一个完整的操作提示。输出不全时用 `write_stdin` 对同一宿主句柄传 `chars: ""` 继续读，留足输出预算（例如 `max_output_tokens: 32000`）。有多行就依次处理；运行中的空读表示仍在等待。

| `event` | 当前 agent 的下一步 |
| --- | --- |
| `send` | 把该行的 **`exec` 对象原样交给 `exec_command`**。命令会把这一帧送到 `agy` 的标准输入。然后空读原进程句柄。 |
| `submit` | 目标模型已选中。按第 3 步原样执行这一行的 `exec`，通过独立的材料输入句柄提交唯一的一份草稿。 |
| `delivery` | 将 `markdown` 原样作为最终回复发送。里面已经包含本轮的展示格式。 |
| `answer_pages` | 最终 Markdown 已排好。用 `exec_command` 执行该行的 `exec` 读取第一页，然后依次执行每页的 `next`。顺序拼接各页的 `text`，不加分隔符。读到 `next: null` 就发送。 |
| `catalog` | 模型查询已完成，使用 `models` 列表，按第 4 步结束。 |
| `error` | 保留原稿，按 `stage` 和 `reason` 说明失败在哪一步。若工具已报告沙箱限制联网或访问登录凭据，向用户说明这项限制。 |
| `closed` | 官方会话已关闭。已取得的交付结果仍然有效。 |

`send` 会依次提示初始化、按需认证、创建会话、按需选模。默认 `existing-session` 复用 `agy` 登录，显式 API 身份使用所选认证方法；思考档位沿用账号当前设置。遇到服务端的工具或权限请求，`send` 提供本次请求的拒绝响应。**每一帧都用本轮返回的宿主命令发送。对官方进程句柄，`write_stdin` 只做空读或发送 Ctrl-C。** 勿自行改用普通管道或终端输入，否则进程可能立即退出，或长文被终端截断。

## 3. 提交改写

将 `submit.exec` 原样交给宿主 `exec_command`。这会打开一个单独的材料输入句柄。读到 `input_ready` 后，用 `write_stdin` 将一行 UTF-8 JSON 加一个换行发给**这个新句柄**。它已绑定正确的 ACP 会话和本轮设置，不需要再拼协议帧或 shell 命令。

完整答复传 `{"question":"原问题","draft":"完整原稿"}`。选段传 `{"selection":"所选文字"}`。普通选段或主动改写可传 `rewrite_request`；只发原文时省略它。使用 JSON 序列化器；例如 `chars: JSON.stringify({question, draft}) + "\n"`。长文可分几次写，最后一次才追加换行。等材料输入句柄退出，状态码为 0 表示这一帧写入完成。

提交成功后空读宿主句柄直到 `delivery` 或 `answer_pages`。从 `send` 收到的配置和服务端请求照常处理。提交失败、结果不明或输出被截断时按本轮故障保留原稿，勿重发。出现权限请求后服务端可能继续返回正文，以最终状态决定交付。

## 4. 结束与交付

读完最终 Markdown（含长回复的最后一页）就直接交付。宿主命令会自行回收子进程和本轮目录。**正常结束无需再调工具**。宿主报告句柄已经退出时，已收到的结果仍然有效。

若用户在生成时取消，Windows 上原样执行 `submit.cancel`。若进程仍在运行，再执行 `submit.stop`；等待建立会话期间可用最近的 `send.stop` 结束本轮。macOS 或 Linux 上有可用会话时先向 FIFO 发送一次 `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<本轮 ACP sessionId>"}}`，随后结束进程。连接中断时只处理已确认的结果。

## 只看模型或检查连接

使用 `node "<本技能>/scripts/acp_workspace.mjs" --catalog --agy-path "<agy_path>" --auth "<google_auth_method>"` 准备内置角色。仍然原样执行 `start` 和每条 `send.exec`。查询模型到 `catalog` 为止，连接测试可在初始化成功后结束，都不提交草稿。安装器会单独提供 `--catalog-log` 的绝对路径，以便核对真实返回的模型列表。

[Google ACP 与认证](https://antigravity.google/docs/ide/extensions/acp) · [ACP 传输](https://agentclientprotocol.com/protocol/v1/transports) · [会话配置](https://agentclientprotocol.com/protocol/v1/session-config-options) · [生成与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)
