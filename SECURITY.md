# 安全说明

[English](SECURITY.en.md) · [使用说明](README.md) · [技术说明](docs/technical.md)

## 私下报告漏洞

如发现安全漏洞，请[私下提交漏洞报告](https://github.com/mreasonyang/codex-polish/security/advisories/new)。维护者可以在同一份报告里与你跟进。

在报告中写明插件版本、复现步骤、预期结果和实际结果。视问题补充操作系统、Node.js、Codex CLI 或 `agy` 的版本，以及相关的项目设置或钩子状态。请用虚构的对话和占位符演示问题，并删去密钥、令牌、认证头和私人对话原文。

## 控制插件发送的内容

- 要停止当前项目后续的改写请求，将 `.codex/codex-polish.mode` 设为 `off`。
- 要继续改写，但只向 Google 发送本轮内容，将 `.codex/codex-polish.history-turns` 设为 `0`。
- 要关闭插件的 OpenAI 检查，将 `.codex/codex-polish.decisions` 设为 `off`。

如果密钥或令牌可能已经泄露，请到相应服务商处撤销受影响的凭据，并在使用它的配置中换用新凭据。
