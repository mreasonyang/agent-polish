# Codex Polish · 回复润色

[English](../README.md) | **简体中文**

[Windows 安装](#windows-powershell) · [macOS 和 Linux 安装](#macos-和-linux)

在 Antigravity（`agy`）里，可以让 Codex 润色 Gemini 的回复。在 Codex 里，也可以让 Gemini 润色 Codex 的回复。安装时可以选择一个方向或同时配置两边，改稿会显示在提问的聊天里。

在 Codex 中使用支持折叠的客户端时，还可以点开原稿对照。下面是一次实际改写。

导出按钮目前已经修复，本地测试也已通过，不过线上还没有验证。

<details>
<summary>Gemini 改写 · 查看 GPT 原稿</summary>

关于导出按钮的修复进度，这里向你说明一下实际情况。目前导出按钮已经修复，本地测试已经通过，线上还没有验证。

</details>

自动润色时，如果 OpenAI Decisions 判断无需改写，或 Gemini 原样返回，你只会看到原稿。主动要求改写时，如果文字没变，还会看到一句确认。改写失败时，你会看到简短原因和原稿。

## 快速开始

双向润色功能可通过 npm 的 beta 渠道安装。

在你聊天的电脑上安装，需要 **Node.js 22.16+**、[Codex CLI](https://developers.openai.com/codex/cli/) 和 [Antigravity CLI](https://antigravity.google/docs/cli)。在 Antigravity 中润色需要支持原生插件的 `agy`，并在本机 Codex CLI 中配好模型提供商。在 Codex 中润色需要支持插件的 Codex CLI，以及已经登录的 `agy` 1.2.1+。

### Windows (PowerShell)

打开 PowerShell，在任意目录执行下面的命令。

```powershell
npx.cmd @kyun.si/codex-polish@beta setup
```

### macOS 和 Linux

打开终端，在任意目录执行下面的命令。

```sh
npx @kyun.si/codex-polish@beta setup
```

### 在 Antigravity 里，让 Codex 润色

第一屏选择 **Antigravity**，也可以直接运行 `npx @kyun.si/codex-polish@beta setup --host agy`。从源码运行时用 `node scripts/install.mjs setup --host agy`。编辑器沿用本机 Codex CLI 的配置。如果使用 OpenAI 账号且尚未登录，运行 `codex login`。

选择 **Normal** 时，Codex 读过草稿后可以保留已经清楚的表述。选择 **Turbo** 时，每次都请 Codex 改写。两者都会在 Antigravity 交付回复前把本轮问题和草稿发送给 Codex。**仅手动**只在点名时润色，**关闭**停止润色并保留已选模型。模型和推理强度可沿用 Codex 默认值，也可以从账号的可用模型中选择。

新开一个 `agy` 会话。自动模式下照常提问，手动模式可以试试 **「/polish 把上一条回复缩成两句话」**。如果 Antigravity 请求权限，允许 `polish_reply` 工具即可。最终回复直接显示改稿，Codex 不可用时可以交付原稿。之后在 Antigravity 中说 **「配置回复润色」** 就能调整这一侧的设置。

### 在 Codex 里，让 Gemini 润色

第一屏选择 **Codex**，或使用 `setup --host codex`。选择**两边都配置**可分别设置两个方向。非交互运行且省略宿主参数时，默认使用 Codex。

使用 T3 Code 时，选择 Codex 后端。

用 **↑ / ↓** 选择 **Normal**（自动按需改写）、**Turbo**（自动每次改写）、**仅手动**（只在我要求时润色）或**关闭润色**；开启润色时继续选 Gemini 模型和思考等级，按**回车**确认。初始默认值是 **Normal、Gemini 4 Hydrogen、中等（Medium）**。缺少 `agy` 时，安装器会提示安装。若选**关闭润色**，安装器会为当前 Codex 配置保存全局关闭并直接结束，不再引导配置模型、依赖、密钥或 hook 信任。[其他安装方式](technical.md#安装更新和卸载)

同一份 Codex 配置下的所有聊天和目录共用一套润色设置。在聊天或终端保存后，更改立即生效。再次运行 `setup` 可查看或更改模式、模型和思考等级；菜单会预选当前项，按**回车**保留，或从同一菜单改选 **Normal**、**Turbo**、**仅手动**重新开启。关闭润色会同时停用自动和点名改写，不向 Gemini 或 OpenAI Decisions 发送内容，并保留已保存的模型、思考等级、提示词和密钥。只想升级插件并保留设置时，运行 `update`。

- **信任 hook 前手动试用：** 试试 **“为什么缓存命中了还要等？返回结果 polish。”** 主动要求润色就会用 Turbo。Gemini 会收到草稿，这次不附带以前的问答。
- **自动模式（默认）：** 在 Codex **设置 → Hooks**（CLI 输入 `/hooks`）中信任 `UserPromptSubmit` 并**新开聊天**。之后照常提问就会触发润色流程，也可以附上最近几轮对话。

### 使用 Gemini 时可选的 OpenAI Decisions API

首次交互安装并选用普通模式时，安装器会询问是否启用 OpenAI Decisions API，由它判断是否需要 Gemini 改写草稿。直接按**回车**即可跳过，只用 Gemini。启用后，OpenAI 会收到本轮问题、草稿和已设置的自定义润色提示词。在承担检查费用的 OpenAI 项目中创建 API 密钥，再粘贴到终端的隐藏输入框。密钥保存在当前 Codex 配置中。Turbo 始终直接使用 Gemini。[OpenAI API 密钥](https://platform.openai.com/api-keys)

以后要添加、更换或移除密钥，运行 `npx @kyun.si/codex-polish@beta openai`。Windows PowerShell 中使用 `npx.cmd @kyun.si/codex-polish@beta openai`。插件会忽略 `OPENAI_API_KEY` 环境变量。[凭据指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md#选配-openai-decisions-api)

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

给下面的命令加上 `--host agy` 可以检查、更新或卸载 Antigravity 插件，使用 `--host both` 可操作两边。卸载 Antigravity 插件会保留它的模式和模型设置，方便重装时沿用。

| 操作 | 命令 |
| --- | --- |
| 检查配置 | `npx @kyun.si/codex-polish@beta doctor` |
| 更新 | `npx @kyun.si/codex-polish@beta update` |
| 卸载 | `npx @kyun.si/codex-polish@beta uninstall` |

在 Windows PowerShell 中，使用 `npx.cmd` 调用 `doctor`、`update` 和 `uninstall`。`doctor` 检查本机依赖、已保存的设置和 hook 信任状态。要确认 Antigravity 登录是否可用，可以说 **“选择改写模型”**，查看账号当前能用的模型。插件更新后，Codex 可能提示你重新信任 hook。

卸载会删除当前 Codex 配置保存的插件设置、自定义提示词和 OpenAI API 密钥。旧版留下的空锁文件和空插件目录也会一并清除，你自己放进去的无关文件和共用的 `agy` 会保留。[卸载范围](technical.md#安装更新和卸载)

[凭据与配置指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md) · [技术参考](technical.md) · [离线评测](../evaluation/README.md) · [参与贡献](../CONTRIBUTING.md) · [安全说明](../SECURITY.md) · [更新记录](../CHANGELOG.md) · [Apache-2.0 许可证](../LICENSE)
