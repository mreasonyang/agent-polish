# 安全说明

[English](SECURITY.en.md) · [使用说明](docs/README.zh-CN.md) · [技术说明](docs/technical.md)

## 私下报告漏洞

如发现安全漏洞，请[私下提交漏洞报告](https://github.com/mreasonyang/codex-polish/security/advisories/new)。维护者可以在同一份报告里与你跟进。

在报告中写明插件版本、复现步骤、预期结果和实际结果。视问题补充操作系统、Node.js、Codex CLI 或 `agy` 的版本，以及相关的插件设置或钩子状态。请用虚构的对话和示例值演示问题，并删去密钥、令牌、认证头和私人对话原文。

## 在 Antigravity 中使用 Codex

在 Antigravity 中启用 Normal 或 Turbo 后，`polish_reply` 会将本轮问题、草稿及本次编辑要求交给本机 Codex CLI 配置的模型提供商。选段改写只发送指定文字和适用的编辑要求。插件不附加其他轮次。Antigravity 自身的对话记录可能包含工具输入和输出。可以在 Antigravity 中选择「仅手动」，或用「关闭润色」停止这一方向的自动和点名改写。

每次润色使用临时 Codex 配置目录，以隔离日常使用的全局指令、技能、插件和 MCP 服务。本机 Codex 负责读取已保存的登录。需要衔接系统凭据库时，插件在进程内存中传递本次调用所需的凭据。编辑结束后会清理临时目录。

## 在 Codex 中使用 Gemini 时发送的内容

插件按原文发送所选内容，包括问题、草稿、历史或编辑指令中的密钥和令牌。

自动润色以普通模式运行风格检查时，OpenAI 只收到本轮问题和草稿原文（包括代码、路径和链接），以及已设置的自定义润色提示词。主动要求润色或改写时，一律使用 Turbo。点名润色和自动触发的 Turbo 都跳过 OpenAI，通过 `agy acp` 调用 Gemini。润色整条回复时，Google 收到原问题、草稿、当前 Codex 配置的自定义提示词（如有）和本次编辑要求。再次改写同一份原稿时，可选历史仍取自同一聊天中原答复之前的问答。历史默认最多 2 轮，可设为 0 到 10 轮。只附带已完成的纯文字问答。收到 Gemini 的完整回复后，插件在本地排版并显示正文。

- 要润色一段文字，可选中或引用原文。Gemini 会收到所选文字、当前生效的润色提示词和本次编辑要求。原问题、其余文字和聊天历史留在本地。说“只把这段原文发给 Gemini”，就只发送所选文字并使用内置 Turbo 提示词。全局提示词和另提的编辑要求也留在本地。
- 说“关闭润色”（或运行 `setup` 选择“关闭润色”），就会停用当前 Codex 配置下所有聊天的自动和点名改写。
- 要让 Gemini 默认省略历史问答，可以说“把润色历史设为 0 轮”。只想临时省略时，说“这次润色不带历史”。这时仍可点名重写之前的某条回复。受信任的 hook 会在本机保存会话位置与轮次。为再次定位原稿，本地缓存记录来源类型、相关轮次和已展示回复的指纹，不存草稿正文。
- 说“以后只用 Gemini 改写”，即可关闭当前 Codex 配置下的 OpenAI 检查。

默认只用 Gemini。可选的 OpenAI Decisions API 检查使用你在安装器的隐藏输入框中填写的密钥，保存在当前 Codex 配置的 `$CODEX_HOME/codex-polish/credentials/openai.key`。可运行 `npx @kyun.si/codex-polish openai`（Windows PowerShell 中使用 `npx.cmd`）移除本地副本，卸载时也会删除。插件会忽略 `OPENAI_API_KEY`。[凭据指南](plugins/codex-polish/skills/codex-polish-setup/references/credentials.md#选配-openai-decisions-api)

如果密钥或令牌可能已经泄露，请到相应服务商处撤销受影响的凭据，并在使用它的配置中换用新凭据。
