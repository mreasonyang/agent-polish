# Codex Polish · Codex 回复润色

[English](../README.md) | **简体中文**

Codex 的回答太绕时，可以让 Gemini 换个说法。Codex 通过 Antigravity（`agy acp`）发送原稿，在聊天里显示改写后的版本。支持折叠的客户端还可以点开原稿对照。下面是一次实际改写。

**Gemini 润色版**

导出按钮目前已经修复，本地测试也已通过，不过线上还没有验证。

<details>
<summary>查看 GPT 原稿</summary>

关于导出按钮的修复进度，这里向你说明一下实际情况。目前导出按钮已经修复，本地测试已经通过，线上还没有验证。

</details>

Gemini 返回原文时，正文只显示一次。改写失败时，你会看到原稿和原因。

## 快速开始

支持 **Windows、macOS 和 Linux**，需要 **Node.js 22.16+**、支持插件的 [Codex CLI](https://developers.openai.com/codex/cli/)，以及 `agy` 1.2.1+。无需配置 API 密钥，直接复用本机已有的 Antigravity 登录。

```sh
npx @kyun.si/codex-polish@beta setup
```

在运行 Codex 的机器上，打开任意目录即可运行上面的命令。Windows PowerShell 用户运行 `npx.cmd @kyun.si/codex-polish@beta setup`。使用 T3 Code 时，选择 Codex 后端。

用 **↑ / ↓** 选择改写模式和 Gemini 模型，按**回车**确认。缺少 `agy` 时，安装器会在选模型前提示安装。npm 发行版 `0.0.1-beta.8` 将选项存入所选项目。

如需给同一份 Codex 配置下的所有项目设置默认值，可在当前源码仓库根目录运行 `node scripts/install.mjs setup`。单个项目仍可另选模式或模型。再次运行安装命令会跳过已经保存的选项。[其他安装方式](technical.md#安装更新和卸载)

- **信任 hook 前手动试用：** 试试 **“为什么缓存命中了还要等？返回结果 polish。”** 主动要求润色就会用 Turbo。Gemini 会收到草稿，这次不附带以前的问答。
- **自动模式（默认）：** 在 Codex **设置 → Hooks**（CLI 输入 `/hooks`）中信任 `UserPromptSubmit` 并**新开聊天**。之后照常提问就会触发润色流程，也可以附上最近几轮对话。

## 常用聊天指令

- **“让 Gemini 把上一条改成两句话。”** 也可以说“重写前面讲缓存的那条”。再次要求改原稿时，插件会找回最初的问题。原稿无法确认时，Codex 会请你指明或贴出原文。即使项目的自动润色设为普通模式，主动要求润色或改写也会跳过 OpenAI 检查。
- **“只在我要求时润色。”** 这会把项目设为手动触发。想让自动润色也用 Turbo，可以说“把这个项目的默认改写模式设成 Turbo”。只想看本轮改稿，就说“只给我润色后的正文”。
- **“选择改写模型。”** 查看 Antigravity 账号可用的模型，内置默认模型是 **Gemini 4 Hydrogen**（`gemini-4-hydrogen`）。
- **“把我的润色提示词设为：先写结论，尽量用短句。”** 当前源码版中，同一份 Codex 配置下的所有项目共用这一份提示词。它完整替换普通和 Turbo 模式的内置编辑指令。说**“恢复默认润色提示词”**即可删除已保存的文字。

## 会发送哪些内容

发送范围内的文字会原样传给对应的服务商，其中的密钥或令牌也会一并发送。说**“这轮别润色”**就能跳过本轮。明确要求只输出 JSON、一条命令或逐字引文时，Codex 会按指定格式直接答复。

- **OpenAI** 只在自动润色使用普通模式并运行风格检查时收到本轮问题、草稿和当前 Codex 配置的自定义提示词。没配 `OPENAI_API_KEY`、关闭检查，或检查服务不可用时，草稿会直接发给 Gemini。Turbo 总是跳过这项检查。
- **Google** 在润色整条回复时收到原问题和草稿，以及已保存的全局提示词和本次编辑要求。信任 hook 后，默认最多附上原答复之前的两轮问答。历史可设为 0 到 10 轮，也可以说“这次不带历史”。
- **选段改写：** 说**“把这段话改写成两句”**会发送所选片段、这条修改要求，以及当前 Codex 配置的自定义提示词或内置 Turbo 提示词。说**“只把这段原文发给 Gemini”**则只用内置 Turbo 提示词发送这段文字，额外修改要求和全局提示词都留在本地。两种方式都不会发送原问题或聊天历史。
- **再次修改选段：** 继续要求把刚改好的这段话再改短一点时，会以当前显示的所选版本作为草稿，连同新的修改要求和当前提示词一起发送，原问题和聊天历史仍留在本地。插件自身不记录草稿日志。

## 维护与排查

| 操作 | 命令 |
| --- | --- |
| 检查配置 | `npx @kyun.si/codex-polish@beta doctor` |
| 更新 | `npx @kyun.si/codex-polish@beta update` |
| 卸载 | `npx @kyun.si/codex-polish@beta uninstall` |

在 Windows PowerShell 中，使用 `npx.cmd` 调用 `doctor`、`update` 和 `uninstall`。`doctor` 检查本机依赖、项目设置和 hook 信任状态。要确认 Antigravity 登录是否可用，可以说 **“选择改写模型”**，查看账号当前能用的模型。插件更新后，Codex 可能提示你重新信任 hook。

当前源码版的卸载命令会删除这份 Codex 配置保存的默认改写模式、模型和自定义提示词，并清理已记录的项目设置。[卸载范围](technical.md#安装更新和卸载)

[凭据与配置指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md) · [技术参考](technical.md) · [离线评测](../evaluation/README.md) · [参与贡献](../CONTRIBUTING.md) · [安全说明](../SECURITY.md) · [更新记录](../CHANGELOG.md) · [Apache-2.0 许可证](../LICENSE)
