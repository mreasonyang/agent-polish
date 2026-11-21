# 技术参考

[English](technical.en.md) · [项目首页](README.zh-CN.md)

Codex Polish 支持 Windows、macOS 和 Linux。本地脚本使用 Node.js 22.16 或更高版本的内置模块。自动 hook 让 Codex 在原稿写完后直接执行[润色流程](../plugins/codex-polish/skills/codex-polish/WORKFLOW.md)，只在最终回复中展示结果。用户点名润色时，[改写技能](../plugins/codex-polish/skills/codex-polish/SKILL.md) 执行同一份流程。[设置技能](../plugins/codex-polish/skills/codex-polish-setup/SKILL.md) 检查运行环境并保存当前 Codex 配置的润色设置。

## 润色设置

聊天、终端和 Finder 安装器共用当前 Codex 配置中的一套润色设置。从任意目录保存后，更改立即对使用这份 Codex 配置的所有聊天生效。每次改写的问题、原稿和可选历史仍取自本次聊天。

以下文件保存在 `$CODEX_HOME/codex-polish/settings/` 下。未设置 `CODEX_HOME` 时使用 `~/.codex`。尚未选择的设置采用各自的内置默认值。

| 配置文件 | 取值范围与默认值 | 运行行为 |
| --- | --- | --- |
| `codex-polish.mode` | `auto`（默认）、`manual`、`off` | 未保存模式时使用 `auto`。在 Codex 的 **设置 → Hooks** 或 CLI `/hooks` 中信任插件的 `UserPromptSubmit`，再新开聊天，普通提问就会触发润色流程。`manual` 仅在点名时触发。两种模式都可以点名润色本轮问答，无需 hook。`off` 跳过所有润色请求。 |
| `codex-polish.rewrite-mode` | `normal`（内置默认值）、`turbo` | 仅用于自动 hook。两种模式都无须 OpenAI 密钥，未启用检查时都直接交由 Gemini 处理。使用内置提示词时，`normal` 可保留清晰原稿并支持可选的 OpenAI Decisions 检查，`turbo` 则跳过 Decisions 并请 Gemini 改写草稿。 |
| `codex-polish.model` | Gemini 模型和思考等级，默认 `gemini-4-hydrogen`、`medium` | 选模型时可以选择该模型支持的思考等级。普通和 Turbo 模式都使用这组设置。若下次改写时模型或等级已不可用，本轮保留原稿。 |
| `codex-polish.history-turns` | `0`–`10` 的整数，默认 `2` | 控制 Gemini 改写整条回复时附带的最近完整问答轮数，从下次改写起生效。设为 `0` 就不附历史问答。保存大于 `10` 的值会报错。手动写入无效值时，插件会报告配置错误和可用范围。无论手动还是自动模式，读取历史都需要受信任的 `UserPromptSubmit` hook。 |
| `codex-polish.decisions` | `auto`（默认）、`off` | 仅在 hook 自动触发润色并使用普通模式时生效。`auto` 在当前 Codex 配置保存了格式有效的插件密钥时调用 OpenAI，`off` 始终只用 ACP。 |
| `codex-polish.language` | `auto`（默认）、`zh`、`en` | 控制插件设置与终端提示语言。`auto` 下，设置对话优先跟随本条消息所用的中文或英文。只点击菜单或回复数字时沿用对话语言。两者都无法判断时使用系统语言。设置菜单和插件诊断使用已保存的语言设置。自动识别时，终端提示跟随系统语言，未识别出中文或英文时使用英文。 |

触发模式、自动改写模式和 Decisions 的设置值接受大小写变体，Decisions 也接受 `on` 表示启用。无效值会指出具体文件与可选值。

在聊天中说“切换到 Turbo 模式”，即可为自动润色保存这个选项。从源码目录运行 `node plugins/codex-polish/hooks/preferences.mjs set-rewrite-mode turbo` 有相同效果。切回普通模式时，将 `turbo` 换成 `normal`。运行 `node plugins/codex-polish/hooks/preferences.mjs check` 可查看当前设置。润色时，`check` 也可通过 `--cwd` 检查本轮的运行环境。改写模式无效时，自动润色会暂停，重新选择任一模式即可恢复。点名润色仍然使用 Turbo。

`set-model gemini-4-hydrogen --thinking-level high` 会同时保存 Hydrogen 模型和高思考等级。用 `set-model --reset` 恢复内置的 Gemini 4 Hydrogen 和中等思考等级。用 `set-rewrite-mode --reset` 可将自动改写模式恢复为普通模式。

“返回结果 polish”要求润色当前回复，“让 Gemini 重写刚才讲缓存的那条”指定同一聊天里的旧回复。两者都使用 `--trigger explicit`，按 Turbo 模式通过 ACP 把选定的草稿直接交给 Gemini。点名改写只对本次生效，在 `auto` 和 `manual` 下都可以使用。Codex 会结合上下文判断意图，例如“解释一下 Turbo”是在询问功能。普通提问由 hook 以 `--trigger auto` 自动触发，使用已保存的改写模式。将触发模式设为 `off` 时，两种触发都会跳过。

有关 Codex 如何加载插件、注册 hook 以及取得用户信任，参见 [Codex 插件与 hook](https://developers.openai.com/plugins/build/plugins) 和 [项目 hook 和信任机制](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks)。

### 查看、设置或恢复润色提示词

每份 Codex 配置可以保存一份润色提示词。可以在聊天里说“查看我的润色提示词”“把我的润色提示词设为：先写结论，再讲依据。”或“恢复默认润色提示词”。安装时沿用内置提示词，你可以随后自行设置。改写整条回复时，普通和 Turbo 模式都会用你提供的全文替换内置提示词。明确要求只发送选段时使用内置 Turbo 提示词。

以下命令依次用于查看、保存和恢复默认。设置命令会从标准输入完整复制 UTF-8 文本到 `$CODEX_HOME/codex-polish/settings/codex-polish.prompt.md`，包括换行和首尾空白。从文件导入后，如要采用原文件的新内容，再导入一次即可。恢复默认和卸载都会删除保存的副本。

```sh
node plugins/codex-polish/hooks/preferences.mjs prompt
node plugins/codex-polish/hooks/preferences.mjs set-prompt < my-prompt.md
node plugins/codex-polish/hooks/preferences.mjs set-prompt --reset
```

在 Windows PowerShell 中，可以用 Node 将原文件字节传给命令，保留 UTF-8 文本和换行格式。

```powershell
node -e "child_process.execFileSync(process.execPath, ['plugins/codex-polish/hooks/preferences.mjs', 'set-prompt'], { input: fs.readFileSync(process.argv[1]), stdio: ['pipe', 'inherit', 'inherit'] })" "C:\path\to\my-prompt.md"
```

## 改写流程与判定阈值

插件支持直接 ACP 和 OpenAI Decisions 加 ACP 两条路径。点名润色或以 Turbo 自动润色时，插件会跳过 OpenAI，将草稿直接交给 Gemini。Turbo 的内置提示词要求 Gemini 主动改写。以普通模式自动润色时，如果当前 Codex 配置没有可用的 OpenAI 密钥，或已关闭风格检查，插件直接使用 ACP。此时由 `agy` 联系 Google，本地 Node.js 脚本不发网络请求。开启 Decisions 时，Node.js 脚本只在改写前调用一次 OpenAI `gpt-6-luna`，判断草稿是否需要润色。每轮最多提交一次含草稿的 ACP 请求。当前 Codex agent 负责启动和回收进程，并在同一会话中收发协议消息。[ACP 操作步骤](../plugins/codex-polish/skills/codex-polish/references/acp.md)

| 阶段 | 行为 |
| --- | --- |
| 1. 选取原文 | Codex 按本轮要求选取当前答复、旧答复或指定片段。用户要求跳过润色、禁止外发或要求逐字交付时，直接按要求答复。 |
| 2. 风格判定 | 直接 ACP 路径将选定的原文交给 Gemini。开启 Decisions 时，OpenAI 只根据本轮问题、草稿和已设置的自定义润色提示词判断是否需要改写，只有 `P(需要改写) > 0.50` 才进入改写。 |
| 3. ACP 改写 | Gemini 从编辑角色正文加载本次请求使用的润色提示词。在临时工作区关闭默认内置工具，使用已配置的 Antigravity 身份建立会话，选中配置的模型，确认思考等级后再发送草稿。Codex 拒绝权限请求，只拼接本次会话的回复正文。收到非空正文和请求 ID 匹配的 `end_turn` 后进入显示阶段。 |
| 4. 显示回复 | 正文逐字相同才显示一份。缩进、空白或换行有变化时，对照视图保留两版。 |

相关接口规范见 [Google ACP 认证](https://antigravity.google/docs/ide/extensions/acp)、[Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create) 与 [Antigravity 角色的工具配置](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1)。

## 最终回复如何显示

Gemini 改动了文字时，最终消息从改写后的正文开始。在 Codex App 中，点击下方的“Gemini 改写 · 查看 GPT 原稿”即可展开完整原稿。改写选段或之前的 Gemini 版本时，点击“Gemini 改写 · 查看原文”可以对照实际提交的文字。普通原稿保留 Markdown 排版。原稿包含折叠标签或容器分隔符时，展开后显示 Markdown 源文，方便逐字查看这些标记。

自动润色时，Decisions 判断无需改写，或 Gemini 原样返回，都只显示原稿。主动要求润色时，若 Gemini 返回相同的文字，原稿显示一次，并附一句“Gemini 返回了原稿。”改写选段时，相应的说明是“Gemini 返回了原文。”

润色无法执行或 ACP 未能返回完整正文时，显示原稿和简短原因。用户明确要求“只给正文”时，成功则只交付改写后的正文，保留原稿或改写失败时只交付原稿。JSON、单条命令及其他严格格式优先按用户要求交付。

本地排版器在收到完整改稿时，使用 Codex agent 保留的原稿，生成最终 Markdown。改稿的图表引用、空白和换行会原样保留。“只看正文”和原稿对照使用同一份正文。较长的最终消息通过分页交付。

## 发送给服务商的内容与历史限制

启用 OpenAI Decisions 时，发给 OpenAI 的 `input_json.data` 只包含本轮 `question`、`draft`，以及当前 Codex 配置保存的 `editor_prompt`。润色整条回复时，发给 Gemini 的 ACP 消息包含原问题 `question`、原稿 `draft` 和可选的 `history`。用户点名润色时另提的编辑要求放在 `rewrite_request` 中，自定义提示词通过 Antigravity 编辑角色传入。材料按原文发送，包括其中的密钥或令牌、代码、命令、路径、链接、引文和数字。

选中或引用一段文字，或明确指定可见的 Gemini 版本时，`--selection` 只把选定原文放入 `draft`，使用当前润色提示词，也可以用 `rewrite_request` 附上用户另提的编辑要求。原问题、消息中的其余文字和历史留在本地。“只把这段原文发给 Gemini”使用 `--selection-only`。ACP 消息中只有 `draft`，编辑角色使用内置 Turbo 提示词。全局提示词和另提的编辑要求留在本地。

受信任的 hook 在本机记录会话文件的位置和当前轮次，即使历史设为 0 也可用来定位原稿。为再次定位原稿，本地缓存保存来源类型、相关轮次和已展示回复的指纹，用于核对会话记录。缓存不存草稿正文。再次要求改写 GPT 原稿时，插件会回到 GPT 最初作答的那一轮，使用当时的问题，只从那一轮之前选取可选历史。

再次改写已润色的选段时，即使存在折叠对照或本机来源记录，Codex 也只发送所选版本的可见文本，不带原问题或聊天历史。如果上一条完整回复只显示了正文，且本机来源记录已过期或不存在，再要求改短时同样只发送该正文。只有用户提供了完整问答，或另有独立记录能核实原问题与完整答复时，Codex 才会把问题和答复一起发送，并省略其余历史。若点名改写 GPT 原稿却无法核实，Codex 会请用户指出或贴出原稿。

润色整条回复时，`history` 从原答复所在轮次之前的完整问答中选取，按时间顺序发送。每轮包括用户消息（含同轮补充）和 Codex 最终答复。历史只发送问答文本。带附件的消息保留配文，附件本身、工具输出和进度提示均不发送。用户分叉的聊天读取该分支自己的会话记录；撤回按宿主报告的轮数移除最近的问答。目标问答不占历史名额。可附带 0 到 10 轮，默认 2 轮。历史设为 0、未信任 hook、没有可用历史或用户要求这次不带历史时，ACP 消息省略 `history`。

OpenAI 对每个 `input_json.data` 规定 256 KiB 的紧凑 UTF-8 JSON、最多 32 层容器和 10,000 个值。插件在一个这样的字段中提交本轮的风格检查材料，一次只问一个判断题。超过接口大小限制的材料会完整交给 Gemini。`gpt-6-luna` 模型卡另列 1,050,000 token 的上下文窗口。[Decisions 接口](https://developers.openai.com/api/reference/resources/decisions/methods/create) · [GPT-6 Luna 模型卡](https://developers.openai.com/api/docs/models/gpt-6-luna)

Google 为默认模型 `gemini-4-hydrogen` 的 Gemini API 公布了 1,048,576 token 的共享窗口，输入、推理和最终输出均占用这个窗口。使用 Antigravity 时还要考虑会话本身的开销和所选模型，例如 Antigravity 对 Gemini 4 Neon 明列最多 512K token。Google 的 ACP 文档未给出 Hydrogen 单条润色请求的确切字节上限。`agy` 1.5.8 起会在创建会话和切换模型后报告会话窗口用量。[Hydrogen 模型卡](https://aistudio.google.com/docs/models/gemini-4-hydrogen) · [Antigravity 模型说明](https://antigravity.google/docs/models#gemini-4-neon) · [Antigravity CLI 1.5.8](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.8)

插件自身不写草稿日志。Codex 宿主日志、服务商侧日志以及机器上全局配置的 Antigravity hooks 仍按各自的环境配置运行。服务商的数据处理遵循各自条款，与本项目的 Apache License 2.0 代码许可无关，可参阅 [Google 使用说明](https://antigravity.google/docs/faq)。

## 认证与故障处理

Codex agent 用宿主进程工具直接启动官方 `agy acp`，向同一进程发送每条请求并读取响应。本地脚本只准备角色、组装原稿和解析已收到的回复。在 Windows 仅有终端工具时，agent 将 agy 的标准输出重定向到本轮专用的临时文件，以保留原始 JSON。正常退出或取消时会删除该文件；宿主被强制关闭可能留下它。[ACP 操作步骤](../plugins/codex-polish/skills/codex-polish/references/acp.md)

插件要求官方 Antigravity CLI（`agy`）1.2.1 或更高版本，先在 Codex 的 `PATH` 中查找 `agy`，再查 Google 的默认安装目录，Windows 上是 `%LOCALAPPDATA%\agy\bin`，macOS 和 Linux 上是 `~/.local/bin`。默认通过 `agy acp` 复用本机已有登录，无需配置 Gemini API 密钥，也从不调用 `agy -p`。旧配置如需沿用 AI Studio 密钥可设 `CODEX_POLISH_AGY_AUTH=gemini-api-key`，企业环境可设 `agent-platform`。凭据必须配置在运行 Codex 的机器和对应系统用户下，详见 [首次配置指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md)。

| 故障类型 | 回退与限制行为 |
| --- | --- |
| Google 认证方式不支持、缺少 agy 或宿主工具不可用 | 保留原稿。插件依次在 PATH 和 Google 的默认安装目录查找 agy。 |
| Decisions 不可用、密钥无效、响应无效或材料超过接口限额 | 使用原稿继续调用 Gemini。每一轮独立判断。 |
| ACP 握手失败、未登录、所选模型或思考等级不可用，或中途发生变更 | 当前 agent 结束本次 ACP 请求，回收进程并交付原稿。 |
| 生成耗时较长或中断 | 进程仍在运行时继续等待。宿主或服务端明确超时、取消、断流或返回不完整时丢弃候选，同一请求最多发送一次。 |
| 本轮中途停用、修改要求或取消 | 外发前重新核对当前触发模式。收到新要求时丢弃旧候选，按新要求作答。用户取消则结束本轮。若只有服务端取消，用户仍在等待，就交付原稿。 |

## 安装、更新和卸载

在任意目录运行 `npx @kyun.si/codex-polish@beta setup` 即可安装 npm beta 版。将最后一个参数换成 `update`、`doctor` 或 `uninstall` 即可更新、检查插件设置和本地环境或卸载。Windows PowerShell 中使用 `npx.cmd`。从 GitHub 源码安装时，在仓库根目录运行 `node scripts/install.mjs setup`，其余子命令相同。[安装步骤](README.zh-CN.md#快速开始)

macOS 用户也可以解压安装包，在 Finder 中双击安装脚本。每次交互运行 `setup`，都可以为当前 Codex 配置选择普通（Normal）或 Turbo 模式。`agy` 可用时，还可以选择 Gemini 模型和思考等级。再次打开时会预选已保存的值，按**回车**即可保留。思考等级固定的模型会跳过等级选择。[Finder 安装脚本](../安装回复润色.command)

`setup` 和 `update` 支持 `--install-agy`，在缺少 Antigravity CLI 时可自动安装。更新会跳过设置菜单，保留已保存的润色设置与插件启用状态。同一版本号的新构建也能用 `update` 覆盖或重试中断的更新。

安装器为每份 Codex 配置注册一个本地市场。更新时先准备并校验新快照，然后原子替换市场清单，再请 Codex 刷新插件缓存。刷新失败时会恢复原快照和启用状态。Codex 判断 hook 信任时会核对已安装插件的内容，所以即使命令没变，内置提示词或配置指南的改动也可能触发重新确认。安装器和 `doctor` 都从 `hooks/list` 读取实际状态。

首次交互安装并选用普通模式时，安装器会询问是否启用 OpenAI Decisions API 检查，默认跳过。之后可在运行插件的机器上使用同一份 Codex 配置，运行 `npx @kyun.si/codex-polish@beta openai` 管理密钥。Windows PowerShell 中使用 `npx.cmd`。终端隐藏输入，密钥保存在 `$CODEX_HOME/codex-polish/credentials/openai.key`。插件会忽略 `OPENAI_API_KEY`。[密钥设置与 API 计费](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md#选配-openai-decisions-api)

卸载会移除插件和专用市场，清除会话指针，并删除当前 Codex 配置保存的所有润色设置、自定义提示词和 OpenAI 密钥。旧版曾在个别目录登记的设置文件若仍在原位，卸载时也会删除，包括 Git 跟踪的文件和后来被就地修改的文件。其他应用仍可使用共用的 `agy`。

安装文件如有手动改动，卸载时会显示备份位置。使用本地打包的版本时，可将 npm 包名换成实际压缩包路径，例如 `npx --yes file:./kyun.si-codex-polish-VERSION.tgz uninstall`。
