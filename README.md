# Codex Polish · Codex 回复润色

**简体中文** | [English](README.en.md)

Codex Polish 通过 Antigravity 的 `agy acp` 请 Gemini 润色 Codex 的最终回复。Gemini 返回改稿后，聊天里先显示润色版。在支持折叠的客户端，点下方的“查看 GPT 原稿”就能展开完整原稿。项目默认使用自动模式，信任插件的 hook 并新开聊天后，像平常一样提问即可触发。

## 改写示例

一次测试里，Codex 要告诉用户导出按钮修好了，本地测过了，线上还没验。

**Gemini 润色版**

导出按钮目前已经修复，本地测试也已通过，不过线上还没有验证。

<details>
<summary>查看 GPT 原稿</summary>

关于导出按钮的修复进度，这里向你说明一下实际情况。目前导出按钮已经修复，本地测试已经通过，线上还没有验证。

</details>

这轮只想看改稿，可以说 **“只给我润色后的正文”**。如果指定只输出 JSON、命令或逐字引文，回复会遵守指定格式。

## 只让 Gemini 重写一次

即使项目用的是普通模式，也可以在聊天里直接指定这次用 Turbo。用自己的话说明要改哪条，以及想怎么改就行。

- **“为什么缓存命中了还要等？这条用 Turbo。”** Codex 先回答这个问题，再把这份草稿交给 Gemini。
- **“你刚才那条我没看懂，换个说法，先说结论。”** Gemini 直接重写上一条回答。你也可以指明更早的一条，比如“让 Gemini 重写前面解释缓存的那条”。

这一次会跳过 OpenAI 检查。下一条普通提问继续用项目原先的模式。如果希望以后都用 Turbo，可以说 **“把这个项目的默认改写模式设成 Turbo”**。

## 三步快速开始

支持 macOS 和 Linux。需要 Node.js 22.16 或更新版本，以及支持插件的 [Codex CLI](https://developers.openai.com/codex/cli/)。如果你用 T3 Code，选择 Codex 后端，并把插件装在运行该后端的机器上。

1. **在要润色的项目目录安装插件。** 用下面的命令安装 npm 上的测试版。

   ```sh
   npx @kyun.si/codex-polish@beta setup
   ```

   也可以将源码下载到家目录，在当前项目运行安装脚本。

   ```sh
   git clone https://github.com/mreasonyang/codex-polish.git ~/codex-polish
   node ~/codex-polish/scripts/install.mjs setup
   ```

   首次交互配置时，用 **↑ / ↓** 选择改写模式，按 **回车** 确认。默认选中 **普通（Normal）**，可让 OpenAI 先判断草稿是否需要改写。**Turbo** 跳过 OpenAI，直接让 Gemini 改写符合条件的草稿。何时触发润色可单独设置。安装器会沿用项目已选的改写模式。首次配置还可以用方向键选择 Gemini 4 Hydrogen，或让 Codex 查询账号里可用的其他模型。选择会保存在仓库根目录，无人值守安装使用默认值。

   在 macOS 上也可以下载并解压 GitHub 仓库，双击[安装回复润色.command](安装回复润色.command)。在项目目录提示处输入目标路径，或按回车稍后配置。在项目聊天里说 **“配置回复润色”**，首次配置时即可点选 **普通（Normal）** 或 **Turbo**。如果聊天只支持文字，直接回复模式名即可。

2. **连接 Gemini。** 安装器会复用已有的 Antigravity CLI（`agy` 1.2.1 或更新版本）。如果没装，按回车即可安装官方版本。无人值守安装时，在上述 `setup` 命令末尾加上 `--install-agy`。插件默认沿用 Antigravity 登录。只有收到登录提示时，才需要在运行 Codex 的机器上打开 `agy` 登录。
3. **信任 hook，试一次普通提问。** 启用 OpenAI 风格检查时，OpenAI 只收到本轮问题、草稿和已设置的自定义润色提示词。进入改写时，Google 收到这些内容，默认还会附带最近最多 2 轮完整问答。在 Codex 的 **设置 → Hooks**（CLI 输入 `/hooks`）里信任本插件的 `UserPromptSubmit`，然后在项目里新开聊天，问 **“用一句话解释 DNS。”** 想改成手动，可以在项目里说 **“只在我要求时润色”**。

## 项目设置

直接对 Codex 说 **“查看回复润色设置”** 就能看到当前配置。每个项目单独保存，在同一项目新开的聊天也会沿用。

| 设置 | 默认值 | 可以这样说 |
| --- | --- | --- |
| 什么时候润色 | 自动（需信任 hook） | “只在我要求时润色”“关闭回复润色”“给这个项目开启自动润色” |
| 改写模式 | 普通（normal） | “切换到 Turbo 模式”“恢复普通模式” |
| Gemini 模型 | Gemini 4 Hydrogen | “选择改写模型”会列出当前账号可用的模型，也可以说“恢复默认改写模型” |
| 润色提示词 | 当前模式的内置提示词 | “查看润色提示词”“设置润色提示词”“恢复默认润色提示词” |
| Gemini 改写时带几轮历史 | 最近最多 2 轮 | “带最近 5 轮对话”“润色时不带历史”。可选 0 到 10 轮。说“这次润色不带历史”只对本轮生效 |
| 改写前的 OpenAI 风格检查 | 普通模式下，配了 `OPENAI_API_KEY` 时启用 | “这个项目只用 Gemini 改写”“有密钥时用 OpenAI 检查” |
| 插件提示语言 | 自动识别中英文 | “插件提示改成中文”“恢复自动识别语言” |

例如，对 Codex 说 **“把这个项目的润色提示词设为：先写结论。尽量用短句。保留专业术语。”** 从下次改写起，无论使用普通模式还是 Turbo，Gemini 都用这三句话作为完整的项目提示词。恢复默认后，Gemini 使用当前模式的内置提示词。也可以直接编辑项目里的 `.codex/codex-polish.prompt.md`。查看、设置和恢复默认都在本机完成，无需调用润色模型。只说“这次回答简短一点”仅对本轮生效。

**普通模式（normal）** 默认生效。启用风格检查时，OpenAI 判断是否需要改写，需要时才交给 Gemini。检查已关闭或未配置密钥时，符合条件的草稿直接交给 Gemini。如果密钥失效或 OpenAI 暂时不可用，本轮也直接交给 Gemini。

**Turbo 模式** 通过 `agy acp` 将每份符合条件的草稿直接交给 Gemini，即使配了 OpenAI 密钥也一样。Turbo 的内置提示词要求 Gemini 主动改写。切换改写模式不影响自动、手动或关闭设置。说 **“恢复普通模式”** 即可重新使用原有的风格检查设置。

## 谁会收到对话内容

自动模式下，受信任的 `UserPromptSubmit` 会在普通提问时提醒 Codex 润色最终回复。信任前，仍可说 **“把这轮回复润色一下”**，用本轮问答润色，不附带历史。手动模式只在点名时触发，附带历史同样需要信任 hook。关闭后，即使点名也会跳过润色。

插件会先在本地检查本轮问题和草稿。检测到疑似凭据，或用户要求只输出 JSON、命令等固定格式时，插件会跳过润色。

问题和草稿按原文发送，包括其中的代码、命令、路径、链接和数值。

- **OpenAI** 启用风格检查时只收到本轮问题、草稿和已设置的自定义润色提示词，用来判断草稿是否需要改写。
- **Google** 收到待改回复对应的问题、原稿和项目自定义润色提示词（如有）。单次 Turbo 还会带上你这次提出的改写要求。重写之前的回答时，插件从同一聊天里取出那一轮的提问和答复。如果当时展示了两个版本，就取折叠的 GPT 原稿。附带的历史从目标回复往前数，设为 0 就只发改写所需的材料。插件跳过含疑似凭据、有附件或尚未完成的历史轮次。

OpenAI 风格检查的输入超过接口的 256 KiB 限制时，完整材料会直接交给 Gemini。

插件本身不记录草稿。Codex、服务商和全局 `agy` 钩子各有自己的日志设置。

## 为什么还是原稿？

普通和 Turbo 模式都会直接显示 Gemini 通过 ACP 返回的完整正文。如果 Gemini 返回原文，回复会注明这一点，正文只显示一次。如果在发送前跳过润色，或 ACP 请求未能取得完整正文，回复会说明原因并显示 GPT 原稿。需要排查时，可以问 **“为什么上条回复没润色？”** 或 **“检查回复润色环境”**。

## 检查、更新与卸载

| 操作 | 通过 npm 测试版 | 在源码根目录运行 |
| --- | --- | --- |
| 检查当前项目 | `npx @kyun.si/codex-polish@beta doctor` | `node scripts/install.mjs doctor` |
| 更新 | `npx @kyun.si/codex-polish@beta update` | 取得新版源码后运行 `node scripts/install.mjs update` |
| 卸载 | `npx @kyun.si/codex-polish@beta uninstall` | `node scripts/install.mjs uninstall` |

更新会保留项目设置和插件启用状态。安装器会向 Codex 查询 hook 的信任状态。已安装插件里的文件有变动，包括内置的 Gemini 提示词或配置指南，Codex 都可能要求再次确认。看到提示时，在 **设置 → Hooks** 里审查并信任 `UserPromptSubmit`，再新开聊天。重新安装内容相同的插件会保留信任。卸载后，项目的 `.codex` 设置和共用的 `agy` 会保留。

## 文档与许可

- [凭据与登录](plugins/codex-polish/skills/codex-polish-setup/references/credentials.md)
- [技术说明与验证范围](docs/technical.md) · [如何评估润色效果](evaluation/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全问题反馈](SECURITY.md)
- [更新记录](CHANGELOG.md)

本项目采用 [Apache License 2.0](LICENSE)。
