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

支持 **macOS 和 Linux**，需要 **Node.js 22.16+**、支持插件的 [Codex CLI](https://developers.openai.com/codex/cli/)，以及 `agy` 1.2.1+。无需配置 API 密钥，直接复用本机已有的 Antigravity 登录。

```sh
npx @kyun.si/codex-polish@beta setup
```

在项目目录运行上面的命令。交互安装时，如果缺少 `agy`，安装器会提示安装，也会让你选择改写模式，默认是**普通（Normal）**。使用内置提示词时，普通模式允许保留已经写清楚的原稿，**Turbo** 会要求 Gemini 改写每份符合条件的草稿。如果用 T3 Code，选择 Codex 后端，并在运行后端的机器上安装插件。[其他安装方式](technical.md#安装更新和卸载)

- **信任 hook 前手动试用：** 试试 **“为什么缓存命中了还要等？这条用 Turbo。”** 这次会直接把草稿交给 Gemini，不附带以前的问答。
- **自动模式（默认）：** 在 Codex **设置 → Hooks**（CLI 输入 `/hooks`）中信任 `UserPromptSubmit` 并**新开聊天**。之后照常提问就会触发润色流程，也可以附上最近几轮对话。

## 常用聊天指令

- **“让 Gemini 把上一条改成两句话。”** 这次会跳过 OpenAI 检查，直接改写指定的答复。也可以说“重写前面讲缓存的那条”。下一条普通提问仍然用项目原来的模式。
- **“只在我要求时润色。”** 这会把项目设为手动触发。想让项目以后默认用 Turbo，可以说“把这个项目的默认改写模式设成 Turbo”。只想看本轮改稿，就说“只给我润色后的正文”。
- **自定义模型与提示词：** 默认使用 **Gemini 4 Hydrogen**（`gemini-4-hydrogen`）。可说 **“选择改写模型”** 查询账号实时可用模型，或说 **“把这个项目的润色提示词设为：先写结论。尽量用短句。”**（保存在 `.codex/codex-polish.prompt.md`）。

## 隐私与检查机制

问题或草稿里有疑似密钥时，插件会跳过这次改写。要求只输出 JSON、一条命令或逐字引文时，回复会保留指定格式，不加润色标题。

- **OpenAI** 只在普通模式启用风格检查时收到本轮问题、草稿和项目自定义提示词。没配 `OPENAI_API_KEY`、关闭检查，或检查服务不可用时，符合条件的草稿会直接发给 Gemini。Turbo 总是跳过这项检查。
- **Google** 收到选中的草稿、它所回答的问题、项目自定义提示词，以及你为这次改写提出的要求。信任 hook 后，默认还会附上目标答复之前最多两轮完整问答。历史可设为 0 到 10 轮，也可以说“这次不带历史”。插件自身不记录草稿日志。

## 维护与排查

| 操作 | 命令 |
| --- | --- |
| 检查配置 | `npx @kyun.si/codex-polish@beta doctor` |
| 更新 | `npx @kyun.si/codex-polish@beta update` |
| 卸载 | `npx @kyun.si/codex-polish@beta uninstall` |

`doctor` 检查本机依赖、项目设置和 hook 信任状态。要确认 Antigravity 登录是否可用，可以说 **“选择改写模型”**，查看账号当前能用的模型。插件更新后，Codex 可能提示你重新信任 hook。

[凭据与配置指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md) · [技术参考](technical.md) · [离线评测](../evaluation/README.md) · [参与贡献](../CONTRIBUTING.md) · [安全说明](../SECURITY.md) · [更新记录](../CHANGELOG.md) · [Apache-2.0 许可证](../LICENSE)
