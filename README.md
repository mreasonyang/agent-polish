# Codex Polish · Codex 回复润色

**简体中文** | [English](README.en.md)

在 Codex 里说一句「把这段回复润色一下」，Codex 就会通过 Antigravity 的 `agy acp` 请 Gemini 改写草稿。默认只在你点名时运行。改写失败或检查没通过，你看到的还是原稿。

## 改写示例

一次测试里，Codex 要告诉用户导出按钮修好了，本地测过了，线上还没验。

- **原稿** “关于导出按钮的修复进度，这里向你说明一下实际情况。目前导出按钮已经修复，本地测试已经通过，线上还没有验证。”
- **改写后** “导出按钮目前已经修复，本地测试也已通过，不过线上还没有验证。”

## 三步快速开始

支持 macOS 和 Linux。需要 Node.js 22.16 或更新版本，以及支持插件的 [Codex CLI](https://developers.openai.com/codex/cli/)。如果你用 T3 Code，选择 Codex 后端，并把插件装在运行该后端的机器上。

1. **安装插件。** 如需安装发布到 npm 的最新版，在终端运行以下命令。

   ```sh
   npx @kyun.si/codex-polish@latest setup
   ```

   也可以直接从 GitHub 源码安装。

   ```sh
   git clone https://github.com/mreasonyang/codex-polish.git
   cd codex-polish
   node scripts/install.mjs setup
   ```

   在 macOS 上也可以下载并解压 GitHub 仓库，在项目根目录双击[安装回复润色.command](安装回复润色.command)。

2. **连接 Gemini。** 安装器会复用已有的 Antigravity CLI（`agy` 1.2.1 或更新版本）。如果没装，按回车即可安装官方版本。无人值守安装时，在上述 `setup` 命令末尾加上 `--install-agy`。插件默认沿用 Antigravity 登录。只有收到登录提示时，才需要在运行 Codex 的机器上打开 `agy` 登录。
3. **试着润色一句话。** 在项目里新开聊天，发 **“用一句话解释 DNS，再把你的回复润色一下。”** 想检查配置时，点击 **Setup** 或说 **“配置回复润色”**。

## 项目设置

直接对 Codex 说 **“查看回复润色设置”** 就能看到当前配置。每个项目单独保存，在同一项目新开的聊天也会沿用。

| 设置 | 默认值 | 可以这样说 |
| --- | --- | --- |
| 什么时候润色 | 只在点名时 | “给这个项目开启自动润色”“只在我要求时润色”“关闭回复润色” |
| Gemini 模型 | Gemini 4 Hydrogen | “选择改写模型”会列出当前账号可用的模型，也可以说“恢复默认改写模型” |
| 带几轮历史 | 最近 2 轮 | “带最近 5 轮对话”“润色时不带历史”。一轮是之前的一个问题和对应的最终回复，可选 0 到 10 轮，历史正文合计最多 16 KiB |
| OpenAI 检查 | 配了 `OPENAI_API_KEY` 时启用 | “这个项目只用 Gemini 改写”“有密钥时用 OpenAI 检查” |
| 插件提示语言 | 自动识别中英文 | “插件提示改成中文”“恢复自动识别语言”。改稿始终沿用草稿的语言 |

没有 OpenAI 密钥也能用，符合条件的草稿会直接交给 Gemini。有密钥且启用了检查时，OpenAI 会先判断草稿是否值得润色，改完再核对原意。如果密钥无效，插件会保留原稿。可以修正或清除密钥，也可以把这个项目设为只用 Gemini。

## 谁会收到对话内容

手动润色当前问答可以直接用。要让 Gemini 参考历史，或开启自动润色，需要在 Codex 的 `/hooks` 或 **设置 → Hooks** 里信任 `UserPromptSubmit`，再开一个新聊天。要自动润色，还需要为项目开启自动模式。

每次润色，Google 都会收到当前问题和草稿，其中的代码、命令、路径、链接和数值会先替换成占位符，普通文字仍可读。附带的历史则按原文发送，可能包含代码。插件会跳过检测到凭据、带附件或回复不完整的历史轮次。启用检查时，OpenAI 只会收到经过占位符处理的本轮材料，最后一次检查还会收到候选改稿。插件本身不记录草稿。Codex、服务商和全局 `agy` 钩子各有自己的日志设置。

## 为什么还是原稿？

如果要求原样输出、OpenAI 判断原稿已经够清楚、所选模型不可用，或改稿没通过校验，插件都会保留原稿。可以问 **“为什么上条回复没润色？”** 查看本轮原因，或说 **“检查回复润色环境”** 排查安装与连接。

## 更新与卸载

| 操作 | 通过 npm 发行版 | 在源码根目录运行 |
| --- | --- | --- |
| 更新 | `npx @kyun.si/codex-polish@latest update` | 取得新版源码后运行 `node scripts/install.mjs update` |
| 卸载 | `npx @kyun.si/codex-polish@latest uninstall` | `node scripts/install.mjs uninstall` |

更新会保留项目设置和插件启用状态。升级后新开一个聊天。如果 Codex 提示钩子内容已变更，请重新审查并信任。卸载后，项目的 `.codex` 设置和共用的 `agy` 会保留。

## 文档与许可

- [凭据与登录](plugins/codex-polish/skills/codex-polish-setup/references/credentials.md)
- [技术说明与验证范围](docs/technical.md) · [如何评估润色效果](evaluation/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全问题反馈](SECURITY.md)
- [更新记录](CHANGELOG.md)

本项目采用 [Apache License 2.0](LICENSE)。
