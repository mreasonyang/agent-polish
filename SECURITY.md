# 安全说明

[English](SECURITY.en.md) · [使用说明](README.md) · [技术说明](docs/technical.md)

## 私下报告漏洞

如发现安全漏洞，请[私下提交漏洞报告](https://github.com/mreasonyang/codex-polish/security/advisories/new)。维护者可以在同一份报告里与你跟进。

在报告中写明插件版本、复现步骤、预期结果和实际结果。视问题补充操作系统、Node.js、Codex CLI 或 `agy` 的版本，以及相关的项目设置或钩子状态。请用虚构的对话和示例值演示问题，并删去密钥、令牌、认证头和私人对话原文。

## 控制插件发送的内容

Turbo 仅通过 `agy acp` 调用 Gemini，即使配置了 OpenAI 密钥也会跳过 OpenAI。普通模式启用风格检查时，OpenAI 只收到本轮问题和草稿原文（包括代码、路径和链接），以及已设置的自定义润色提示词。进入 Gemini 改写时，Google 收到这些内容，还会按项目设置收到最近最多 2 轮完整问答原文（默认值）。可选 0 到 10 轮，历史正文合计最多 16 KiB。带附件、含疑似凭据或尚未完成的历史轮次会被跳过。如果本轮问题、草稿或自定义提示词含疑似凭据，插件会在发送前跳过整轮。Gemini 返回的改稿在本地检查。

- 要停止当前项目后续的改写请求，将 `.codex/codex-polish.mode` 设为 `off`。
- 要让 Gemini 省略历史问答，将 `.codex/codex-polish.history-turns` 设为 `0`。也可以说“这次润色不带历史”，只跳过本轮的历史。
- 要关闭插件的 OpenAI 检查，将 `.codex/codex-polish.decisions` 设为 `off`。

如果密钥或令牌可能已经泄露，请到相应服务商处撤销受影响的凭据，并在使用它的配置中换用新凭据。
