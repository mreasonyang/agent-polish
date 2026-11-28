# Agent Polish · 回复润色

[English](../README.md) | **简体中文**

Agent Polish 提供两个插件。在 Codex 里聊天就装 **Codex Polish**，让 Gemini 润色回复。在 Antigravity（`agy`）里聊天就装 **Agy Polish**，让 Codex 润色回复。改稿直接显示在原对话里。[快速开始](#快速开始)

## 快速开始

在聊天的电脑上安装。两种插件都需要 **Node.js 22.16+**、[Codex CLI](https://developers.openai.com/codex/cli/) 和 [Antigravity CLI](https://antigravity.google/docs/cli)。根据你使用的聊天工具运行对应命令。Windows PowerShell 请将 `npx` 换成 `npx.cmd`。

| 在哪里聊天 | 安装 beta 版 | 由谁润色 |
| --- | --- | --- |
| Codex | `npx @kyun.si/codex-polish@beta setup` | Gemini |
| Antigravity | `npx @kyun.si/agy-polish@beta setup` | Codex |

从源码试用时，在仓库根目录运行 `node scripts/install.mjs setup` 配置 Codex，或运行 `node scripts/agy-cli.mjs setup` 配置 Antigravity。首次安装时，两个向导都默认选中**仅手动 · 只在我要求时润色**。直接按回车即可保留，也可以选择 Normal、Turbo 或关闭。再次运行会预选已保存的模式。开启润色后，Codex 用户可以选 Gemini 模型和思考等级，Antigravity 用户可以选 Codex 模型和思考等级。两个聊天工具都用，就分别运行两次安装。两个插件独立保存设置，也会沿用旧版 `0.0.4-beta.1` 安装器保存的配置。

### 在 Antigravity 里，让 Codex 润色

Normal 会把本轮问题和草稿交给 Codex，由它判断是否需要改写。Turbo 每次都请 Codex 改写，仅手动模式则在你点名时润色。默认使用 `gpt-6.2-sol`，思考等级为极高（Extra High）。向导里也可以选择跟随本机 Codex 设置，或从当前提供商的列表里选择模型和思考等级。使用 ChatGPT 账号时，若需登录可运行 `codex login`。`agy` 需要支持原生插件。

新开一个 Antigravity 聊天。首次出现工具授权提示时，允许 `agy-polish` 的 `polish_reply`。可以试试 **“/polish 把上一条回复缩成两句话”**。编辑失败时保留原稿。之后说 **“配置回复润色”**，就能换模型、调思考等级、改用 Turbo 或关闭润色。

### 在 Codex 里，让 Gemini 润色

新安装默认使用 **Gemini 4 Hydrogen · 中等思考等级**，复用 Antigravity 的登录。缺少 `agy` 时安装器可协助安装。这个方向需要支持插件的 Codex CLI 和 `agy` 1.2.1 或更高版本。在 T3 Code 中使用时选择 Codex 后端。

要自动润色，在 Codex **设置 → Hooks**（CLI 输入 `/hooks`）中信任 `UserPromptSubmit`，再新开聊天。手动模式可以直接说 **“润色上一条回复”**。以后说 **“配置回复润色”**，可以更改当前 Codex 配置的模式、Gemini 模型、思考等级和历史轮数。

### Codex 中的改写示例

Codex 交互终端在改稿末尾显示一行提示。回复 **“查看原稿”** 就能看到原文。使用支持折叠的客户端时，也可以直接展开原稿对照。下面是一次实际改写。

导出按钮目前已经修复，本地测试也已通过，不过线上还没有验证。

<details>
<summary>Gemini 改写 · 查看 GPT 原稿</summary>

关于导出按钮的修复进度，这里向你说明一下实际情况。目前导出按钮已经修复，本地测试已经通过，线上还没有验证。

</details>

自动润色时，如果 OpenAI Decisions 判断无需改写，或 Gemini 原样返回，你只会看到原稿。主动要求改写时，如果文字没变，还会看到一句确认。改写失败时，你会看到简短原因和原稿。

### 使用 Gemini 时可选的 OpenAI Decisions API

普通模式默认直接使用 Gemini。若想让 OpenAI 判断草稿是否需要改写，运行 `npx @kyun.si/codex-polish@beta openai`，在终端隐藏提示中输入密钥。这项检查会将本轮问题、草稿和已保存的自定义润色提示词发给 OpenAI，API 用量计入密钥所属的项目。再次运行同一条命令可以更换或移除密钥。[凭据指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md#选配-openai-decisions-api)

## Codex 中的常用聊天指令

- **“配置回复润色。”** 打开已保存的设置，可保留或切换 **Normal**、**Turbo**、**仅手动**和**关闭润色**；润色开启时可继续选择 Gemini 模型和思考等级。
- **“说人话”“重写”“润色”** 都可以单独发，默认让 Gemini 改上一条回复。英文也可以说 **“Speak plainly.” “Rewrite.” “Polish.”** 想改本轮答案，直接问 **“什么是缓存穿透？说人话。”**
- **“让 Gemini 把上一条改成两句话。”** 也可以说“重写前面讲缓存的那条”。再次要求改原稿时，插件会找回最初的问题。原稿无法确认时，Codex 会请你指明或贴出原文。即使自动润色设为普通模式，主动要求润色或改写也会跳过 OpenAI Decisions API。
- **“切换到 Turbo 模式。”** 保存后，自动润色会用 Turbo。说**“恢复普通模式”**即可切回。只想改这一条时，说**“这次用 Turbo 润色”**。
- **“只在我要求时润色。”“关闭润色。”“开启自动润色。”** 分别切换为仅手动、关闭当前 Codex 配置下的自动和点名改写（保留已保存的模型、提示词和密钥），或重新开启自动润色。只想看本轮改稿，就说“只给我润色后的正文”。
- **“选择改写模型。”** 从 Antigravity 账号可用的模型中选择，再选该模型支持的思考等级。也可以只改等级，比如**“把 Gemini 的思考等级调到高。”** 普通和 Turbo 模式都用你选的等级。
- **“把我的润色提示词设为：先写结论，尽量用短句。”** 保存后，这份提示词会完整替换普通和 Turbo 模式的内置编辑指令。说**“恢复默认润色提示词”**即可删除已保存的文字。

## 会发送哪些内容

发送范围内的文字会原样传给对应的服务商，其中的密钥或令牌也会一并发送。说**“这轮别润色”**就能跳过本轮。明确要求只输出 JSON、一条命令或逐字引文时，Codex 会按指定格式直接答复。

**在 Antigravity 中**，本机 Codex CLI 配置的模型提供商会收到本轮草稿、对应的问题及本次编辑要求。改选段时只发送选中的文字和适用的编辑要求。插件不附加其他聊天历史。Antigravity 按自身设置管理对话与工具结果。

**在 Codex 中**，Gemini 润色流程使用以下材料。

- **OpenAI** 只在自动润色使用普通模式并调用 OpenAI Decisions API 时收到本轮问题、草稿和当前 Codex 配置的自定义提示词。关闭检查或检查服务不可用时，草稿直接发给 Gemini。
- **Google** 在润色整条回复时收到原问题和草稿，以及已保存的全局提示词和本次编辑要求。信任 hook 后，默认最多附上同一聊天中原答复之前的两轮问答。历史可设为 0 到 10 轮，也可以说“这次不带历史”。
- **选段改写：** 说**“把这段话改写成两句”**会发送所选片段、这条修改要求，以及当前 Codex 配置的自定义提示词或内置 Turbo 提示词。说**“只把这段原文发给 Gemini”**则只用内置 Turbo 提示词发送这段文字，额外修改要求和全局提示词都留在本地。两种方式都不会发送原问题或聊天历史。
- **再次修改选段：** 继续要求把刚改好的这段话再改短一点时，会以当前显示的所选版本作为草稿，连同新的修改要求和当前提示词一起发送，原问题和聊天历史仍留在本地。插件自身不记录草稿日志。

## 维护与排查

用所安装的包检查、更新或卸载对应插件。

| 操作 | Codex | Antigravity |
| --- | --- | --- |
| 检查配置 | `npx @kyun.si/codex-polish@beta doctor` | `npx @kyun.si/agy-polish@beta doctor` |
| 保留设置并更新 | `npx @kyun.si/codex-polish@beta update` | `npx @kyun.si/agy-polish@beta update` |
| 卸载 | `npx @kyun.si/codex-polish@beta uninstall` | `npx @kyun.si/agy-polish@beta uninstall` |

卸载 Agy Polish 会保留这一侧的模式和模型，重装时可以沿用。

在 Windows PowerShell 中，使用 `npx.cmd` 调用 `doctor`、`update` 和 `uninstall`。`doctor` 检查本机依赖、已保存的设置和 hook 信任状态。要确认 Antigravity 登录是否可用，可以说 **“选择改写模型”**，查看账号当前能用的模型。插件更新后，Codex 可能提示你重新信任 hook。

卸载 Codex Polish 会删除当前 Codex 配置保存的插件设置、自定义提示词和 OpenAI API 密钥。旧版留下的空锁文件和空插件目录也会一并清除，你自己放进去的无关文件和共用的 `agy` 会保留。[卸载范围](technical.md#安装更新和卸载)

[凭据与配置指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md) · [技术参考](technical.md) · [离线评测](../evaluation/README.md) · [参与贡献](../CONTRIBUTING.md) · [安全说明](../SECURITY.md) · [更新记录](../CHANGELOG.md) · [Apache-2.0 许可证](../LICENSE)
