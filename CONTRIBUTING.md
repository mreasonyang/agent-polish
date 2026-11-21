# 参与贡献

[English](CONTRIBUTING.en.md)

安装和使用请看[项目说明](docs/README.zh-CN.md)。改动插件前，可以先查[技术参考](docs/technical.md)，了解插件何时发送草稿、如何显示回复。

## 改哪里

- `scripts/install.mjs` 和两个 `.command` 启动脚本负责安装、更新、环境检查和卸载。
- `plugins/codex-polish/` 里有插件清单、钩子和两个技能。`codex-polish` 经 ACP 把选定的草稿交给 Gemini，并排版显示完整回复。主动要求润色时使用 Turbo，仅在 hook 以普通模式自动触发时才使用可选的 OpenAI 风格检查。`codex-polish-setup` 负责设置、选择模型和检查环境，详见[首次配置与登录指南](plugins/codex-polish/skills/codex-polish-setup/references/credentials.md)。改动用户提示或文档时，请同步更新中英文。
- 完整源码的 `tests/` 放回归测试，`evaluation/` 放评测脚本和合成样本。[评测说明](evaluation/README.md)

## 本地测试与打包

在完整源码的根目录运行以下命令。需要 macOS 或 Linux 和 Node.js 22.16 或更新版本。打包需要 npm，原生安装测试还会用到 Codex CLI、npx 和 tar。[获取完整源码](https://github.com/mreasonyang/codex-polish)

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
mkdir -p dist
npm pack --ignore-scripts --pack-destination dist
```

`npm pack` 会把 `@kyun.si/codex-polish` 的 `0.0.1-beta.6` 版打包为 `dist/kyun.si-codex-polish-0.0.1-beta.6.tgz`。默认测试无需 API 密钥，原生安装测试会使用临时 Codex 配置。Decisions 测试使用模拟响应验证风格判定。

## 反馈问题

请在 GitHub Issues 提交普通问题，附上复现步骤、预期和实际结果，并注明操作系统、Node.js、Codex CLI 和 `agy` 版本。在遇到问题的项目里对 Codex 说 **“检查回复润色环境”** 可获取诊断信息。分享前请删去密钥、登录凭据、私人路径和对话原文。[提交问题](https://github.com/mreasonyang/codex-polish/issues)

安全漏洞请私下报告。[安全说明](SECURITY.md)

## 提交补丁

请通过 GitHub Pull Request 提交改动，附上改动原因、复现或验证方法，以及实际跑过的测试结果。如果改动涉及 Gemini 或 OpenAI，写明用的是模拟服务还是真实账号。测试样本请使用虚构内容，或已获授权且脱敏的材料。本项目采用 [Apache License 2.0](LICENSE)。

## 发布 beta

将 `package.json` 和插件清单中的版本一同改为 `X.Y.Z-beta.N`，提交后推送同名 Git 标签。例如发布 `0.0.1-beta.6` 时运行：

```sh
git tag v0.0.1-beta.6
git push origin v0.0.1-beta.6
```

GitHub Actions 会测试这个标签的代码，将安装包发布到 npm 的 `beta` 标签，并创建 GitHub 预发布版。如果某一步失败，可以在 Actions 中选择发布工作流，用已有标签重试。

npm 按包授权。此包使用 GitHub 仓库 `mreasonyang/codex-polish` 的 `publish.yml` 工作流，可信发布者勾选 **Allow npm publish** 和 **Allow npm dist-tag**。后一项让工作流在 npm 把首个 beta 同时标记为 `latest` 时自动清理标签。发布时 GitHub 会向 npm 证明工作流身份，仓库无需保存 npm 令牌。[npm 可信发布设置](https://docs.npmjs.com/trusted-publishers/)
