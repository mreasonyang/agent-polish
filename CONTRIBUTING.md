# 参与 Agent Polish

[English](CONTRIBUTING.en.md)

安装和使用请看[项目说明](docs/README.zh-CN.md)。改动插件前，可以先查[技术参考](docs/technical.md)，了解插件何时发送草稿、如何显示回复。

## 改哪里

- `packages/codex-polish/` 和 `packages/agy-polish/` 定义两个公开的 npm 包，根 workspace 为私有。`scripts/install.mjs` 和 `scripts/agy-cli.mjs` 分别处理两个宿主的安装、更新、诊断和卸载。
- `plugins/codex-polish/` 里有插件清单、钩子和两个技能。`codex-polish` 经 ACP 把选定的草稿交给 Gemini，并排版显示完整回复。主动要求润色时使用 Turbo，仅在 hook 以普通模式自动触发时才使用可选的 OpenAI 风格检查。`codex-polish-setup` 负责管理当前 Codex 配置的润色设置、选择模型和检查环境，详见[首次配置与登录指南](plugins/codex-polish/skills/codex-polish-setup/references/credentials.md)。改动用户提示或文档时，请同步更新中英文。
- `plugins/agy-polish/` 是供 Antigravity 加载的独立插件。它的 MCP 工具调用本机 `codex exec` 润色草稿，聊天和终端设置共用同一份反向配置。
- 完整源码的 `tests/` 放回归测试，`evaluation/` 放评测脚本和合成样本。[评测说明](evaluation/README.md)

## 本地测试与打包

在完整源码的根目录运行以下命令。支持 Windows、macOS 和 Linux，需要 Node.js 22.16 或更新版本和 npm。原生测试会调用 Codex 和 Antigravity CLI。[获取完整源码](https://github.com/mreasonyang/agent-polish)

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
node -e "require('node:fs').mkdirSync('dist', { recursive: true })"
npm pack --workspace @kyun.si/codex-polish --pack-destination dist
npm pack --workspace @kyun.si/agy-polish --pack-destination dist
```

每个 workspace 通过 `prepack` 准备归档文件，分别生成 `dist/kyun.si-codex-polish-<version>.tgz` 和 `dist/kyun.si-agy-polish-<version>.tgz`。默认测试无需 API 密钥，原生安装测试使用临时配置。Decisions 测试使用模拟响应验证风格判定。

## 反馈问题

请在 GitHub Issues 提交普通问题，附上复现步骤、预期和实际结果，并注明操作系统、Node.js、Codex CLI 和 `agy` 版本。在遇到问题的聊天里对 Codex 说 **“检查回复润色环境”** 可获取诊断信息。分享前请删去密钥、登录凭据、私人路径和对话原文。[提交问题](https://github.com/mreasonyang/agent-polish/issues)

安全漏洞请私下报告。[安全说明](SECURITY.md)

## 提交补丁

请通过 GitHub Pull Request 提交改动，附上改动原因、复现或验证方法，以及实际跑过的测试结果。如果改动涉及 Gemini 或 OpenAI，写明用的是模拟服务还是真实账号。测试样本请使用虚构内容，或已获授权且脱敏的材料。本项目采用 [Apache License 2.0](LICENSE)。

## 发布版本

发布某个宿主时，同步更新 `packages/<host>-polish/package.json` 和 `plugins/<host>-polish/` 中对应插件清单的版本号，并在该 workspace 的 `publishConfig.tag` 中填写对应的 npm 标签。

| 版本号 | Codex Git 标签 | Antigravity Git 标签 | npm 标签 | GitHub 发布类型 |
| --- | --- | --- | --- | --- |
| `X.Y.Z` | `codex-vX.Y.Z` | `agy-vX.Y.Z` | `latest` | 正式版 |
| `X.Y.Z-beta.N` | `codex-vX.Y.Z-beta.N` | `agy-vX.Y.Z-beta.N` | `beta` | 预发布版 |

将改动提交到 `main`，等 CI 通过后分别推送对应的宿主标签。两个宿主可以独立发布相同版本。比如 `codex-v0.0.4-beta.2` 只发布 `@kyun.si/codex-polish`，`agy-v0.0.4-beta.2` 只发布 `@kyun.si/agy-polish`。每个标签都在 Linux、macOS 和 Windows 上测试，验证过的归档上传到对应的 npm 包和 GitHub 发布。仓库的 GitHub **Latest** 跟随 Codex 正式版，npm 的 `latest` 由两个包各自维护。

发布中断时，重新运行原标签触发的工作流，或运行 `gh workflow run publish.yml --ref <tag> -f tag=<tag>`。工作流会核对已存在的 npm 版本，并恢复可以安全补齐的发布附件或标签。恢复历史 `vX.Y.Z` 或 `vX.Y.Z-beta.N` 时，运行 `gh workflow run publish.yml --ref main -f tag=<tag>`，核验 npm 已发布的 Codex 版本并补齐 GitHub 归档。重试旧版不会把 npm 标签退回旧版本。

### GitHub 仓库改名后的 npm 设置

1. 先尝试用现有的可信连接发布 `@kyun.si/codex-polish`。如果 npm 拒绝改名后仓库的 OIDC 身份，由拥有 npm 包写权限且已启用 2FA 的维护者打开 **Settings → Trusted publishing**。添加 GitHub Actions 连接，所有者填 `mreasonyang`，仓库填 `agent-polish`，工作流填 `publish.yml`，环境留空。勾选 **Allow npm publish** 和 **Allow npm dist-tag**。npm 将已验证的连接绑定到仓库身份，连接的必填字段不可编辑。新连接成功发布后即可移除失效的旧连接。新连接须在 48 小时内成功发布一次。[npm 可信发布设置](https://docs.npmjs.com/trusted-publishers/)
2. 如果 `@kyun.si/agy-polish` 还未创建，有权在 `@kyun.si` 下创建包的维护者须先建立 npm 包名。使用 npm 11.21+ 和已登录的本地 npm 账号，打包并暂存公开 beta 归档。npm 会创建公开占位版本 `0.0.0-stage`。用 2FA 拒绝这份暂存，释放候选版本给后续 OIDC 发布，再为新包添加相同的 GitHub Actions 连接。`<stage-id>` 使用 npm 返回的暂存 ID。[npm 暂存新包公告](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/) · [npm 暂存发布文档](https://docs.npmjs.com/staged-publishing/)

   ```sh
   npm pack --workspace @kyun.si/agy-polish --pack-destination dist
   npm stage publish ./dist/kyun.si-agy-polish-0.0.4-beta.2.tgz --access public --tag beta --registry https://registry.npmjs.org/
   npm stage reject <stage-id> --registry https://registry.npmjs.org/
   ```

GitHub Actions 从公开仓库通过 OIDC 发布实际 beta 并生成 provenance。**Allow npm dist-tag** 用于恢复标签。当 `latest` 指向占位版本或首个 beta，且版本历史仅有预发布版本时，工作流也会清除这一临时指向。[npm provenance](https://docs.npmjs.com/generating-provenance-statements/) · [npm dist-tag 权限](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing)
