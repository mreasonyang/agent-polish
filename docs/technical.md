# 技术参考

[English](technical.en.md) · [项目首页](../README.md)

`codex-polish` 的自动 hook 让 Codex 在原稿写完后直接执行[润色流程](../plugins/codex-polish/skills/codex-polish/WORKFLOW.md)，只在最终回复中展示结果。用户点名润色时，[改写技能](../plugins/codex-polish/skills/codex-polish/SKILL.md) 执行同一份流程。[设置技能](../plugins/codex-polish/skills/codex-polish-setup/SKILL.md) 检查运行环境并保存项目设置。

## 模式、配置文件与查找规则

Git 项目的设置保存在最近的仓库根目录的 `.codex/`。同一仓库的子目录共用这份设置，嵌套仓库和独立工作树分别保存。没有 Git 仓库时，设置保存在所选目录。

| 配置文件 | 取值范围与默认值 | 运行行为 |
| --- | --- | --- |
| `.codex/codex-polish.mode` | `auto`（默认）、`manual`、`off` | 未保存模式时使用 `auto`。在 Codex 的 **设置 → Hooks** 或 CLI `/hooks` 中信任插件的 `UserPromptSubmit`，再新开聊天，普通提问就会触发润色流程。`manual` 仅在点名时触发。两种模式都可以点名润色本轮问答，无需 hook。`off` 跳过所有润色请求。 |
| `.codex/codex-polish.rewrite-mode` | `normal`（默认）、`turbo` | 决定触发后如何改写。`normal` 沿用项目的 Decisions 设置，`turbo` 将符合条件的草稿直接交给 Gemini。 |
| `.codex/codex-polish.model` | 模型 ID，默认 `gemini-4-hydrogen`（Gemini 4 Hydrogen） | 保存当前项目选用的 Gemini 模型。选项在运行时通过 ACP 从当前登录的 Antigravity 账号实时读取，不同账号返回的列表可能不同。仅查看模型菜单不会发送草稿或历史。下次改写时会核对所选模型，若已下线则本轮保留原稿。 |
| `.codex/codex-polish.prompt.md` | UTF-8 纯文本，默认使用当前模式的内置提示词 | 自定义文本从下一次改写起生效。同一项目中新开的聊天沿用该设置。 |
| `.codex/codex-polish.history-turns` | `0`–`10` 的整数，默认 `2` | 控制 Gemini 改写时附带的最近完整问答轮数，从下次改写起生效。设为 `0` 就不附历史问答。保存大于 `10` 的值会报错。文件中的值不在范围内或格式无效时，本轮不带历史。无论手动还是自动模式，读取历史都需要受信任的 `UserPromptSubmit` hook。 |
| `.codex/codex-polish.decisions` | `auto`（默认）、`off` | 普通改写模式使用此设置。`auto` 按 `OPENAI_API_KEY` 决定是否调用 OpenAI，`off` 始终只用 ACP。 |
| `.codex/codex-polish.language` | `auto`（默认）、`zh`、`en` | 控制插件设置与终端提示语言。`auto` 下，设置对话优先跟随本条消息所用的中文或英文。只点击菜单或回复数字时沿用对话语言。两者都无法判断时使用系统语言。终端也使用系统语言，未识别出中文或英文时用英文。 |

在聊天中说“切换到 Turbo 模式”或“恢复普通模式”即可保存项目偏好。要从源码目录切换，可运行 `node plugins/codex-polish/hooks/preferences.mjs set-rewrite-mode turbo --cwd /path/to/project`，恢复时将 `turbo` 换为 `normal`。用 `check --cwd /path/to/project` 查看生效的 `rewrite_mode`。无效设置会在本地停止润色，重新选择任一模式即可恢复。

“这题用 Turbo”只对当前回复生效。“让 Gemini 重写刚才讲缓存的那条”会用 Turbo 处理同一聊天里指定的旧回复。Codex 根据整句话判断用户是否在要求改写，以及指的是哪一条。例如“解释一下 Turbo”只是在提问。单次请求使用 `--trigger turbo`，直接走 ACP，项目的 `rewrite-mode` 文件只在用户要求修改默认模式时写入。项目处于 `manual` 时可以点名改写，`off` 时会跳过。

有关 Codex 如何加载插件、注册 hook 以及取得用户信任，参见 [Codex 插件与 hook](https://developers.openai.com/plugins/build/plugins) 和 [项目 hook 和信任机制](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks)。

### 查看、设置或恢复润色提示词

可以在聊天中说“查看润色提示词”“把项目润色提示词设为：先写结论，再讲依据。”或“恢复默认润色提示词”。也可以在源码根目录执行下面的本地命令，将 `/path/to/project` 换成目标项目的路径。`set-prompt` 从标准输入逐字保存文本，包括换行和首尾空格。`prompt` 返回当前生效的文本 `text` 及其来源 `source`（`default` 或 `custom`）。没有自定义提示词时，返回当前改写模式的内置文本。设定自定义提示词后，普通和 Turbo 模式都以 `text` 原文作为 Gemini 的全部编辑指令。角色文件头部配置 ACP 会话与工具权限，正文只有这段原文。

```sh
node plugins/codex-polish/hooks/preferences.mjs prompt --cwd /path/to/project
node plugins/codex-polish/hooks/preferences.mjs set-prompt --cwd /path/to/project < my-prompt.md
node plugins/codex-polish/hooks/preferences.mjs set-prompt --reset --cwd /path/to/project
```

可以直接编辑项目提示词文件。恢复默认会删除该文件。无效 UTF-8、纯空白、受限控制字符或疑似凭据会让润色暂停，更正提示词或恢复默认即可。

## 改写流程与判定阈值

插件支持直接 ACP 和 OpenAI Decisions 加 ACP 两条路径。Turbo 始终跳过 OpenAI，将每份符合条件的草稿直接交给 Gemini。其内置提示词要求 Gemini 主动改写。普通模式下，当 `OPENAI_API_KEY` 未设置、为空或仅含空白字符，或项目已关闭风格检查时，插件直接使用 ACP。此时由 `agy` 联系 Google，本地 Node.js 脚本不发网络请求。开启 Decisions 时，Node.js 脚本只在改写前调用一次 OpenAI `gpt-6-luna`，判断草稿是否需要润色。每轮最多提交一次含草稿的 ACP 请求。当前 Codex agent 负责启动和回收进程，并在同一会话中收发协议消息。[ACP 操作步骤](../plugins/codex-polish/skills/codex-polish/references/acp.md)

| 阶段 | 行为 |
| --- | --- |
| 1. 本地输入检查 | 检查本轮问题和草稿中的疑似凭据。检测到疑似凭据、用户要求固定格式（如仅输出 JSON 或命令），或草稿结构不适合改写时，直接交付原稿。 |
| 2. 风格判定 | 直接 ACP 路径在本地检查通过后进入改写。开启 Decisions 时，OpenAI 只根据本轮问题、草稿和已设置的自定义润色提示词判断是否需要改写，只有 `P(需要改写) > 0.50` 才进入改写。 |
| 3. ACP 改写 | Gemini 从编辑角色正文加载项目当前生效的提示词。在临时工作区关闭默认内置工具，使用已配置的 Antigravity 身份建立会话，发送前核对项目设置和所选模型。Codex 拒绝权限请求，只拼接本次会话的回复正文。收到非空正文和请求 ID 匹配的 `end_turn` 后进入显示阶段。 |
| 4. 显示回复 | 两种模式都将 Gemini 返回的完整正文直接排版交付。比较两版时忽略首尾空白和换行符差异，只用于决定显示一份还是两份。 |

相关接口规范见 [Google ACP 认证](https://antigravity.google/docs/ide/extensions/acp)、[Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create) 与 [Antigravity 角色的工具配置](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1)。

## 最终回复如何显示

Gemini 返回的正文有改动时，Codex 在同一条最终消息中先显示 **Gemini 润色版**。在 Codex App 中，点击下方的“查看 GPT 原稿”即可展开完整原稿，再点一次收起。普通原稿保留 Markdown 排版。原稿包含折叠标签或容器分隔符时，展开后显示 Markdown 源文，方便逐字查看这些标记。

如果 Gemini 确实返回了相同的文字，回复会说明 Gemini 返回了原文，正文只显示一次。发送前跳过润色，或 ACP 请求未能取得完整正文时，回复说明可确认的原因，并显示原稿。明确要求“只给润色后的正文”时，改写完成后只显示 Gemini 正文。JSON、单条命令及其他逐字输出按用户要求直接交付，不加标题或状态。

排版时，如果 ACP 回复中的图表引用丢失了分隔符，且能明确对应原稿中的引用，插件会补回分隔符。Gemini 更改或省略图表引用时，仍显示它返回的正文。无法对应原稿的新增图表标记以文本显示。

## 发送给服务商的内容与历史限制

启用 OpenAI Decisions 时，发给 OpenAI 的 `input_json.data` 只包含本轮 `question`、`draft`，以及项目已设置的 `editor_prompt`。发给 Gemini 的 ACP 消息包含待改回复对应的 `question`、`draft` 和可选的 `history`。如果用户在单次 Turbo 请求里另提了改写要求，`rewrite_request` 会把要求一并带给 Gemini。自定义提示词仍通过 Antigravity 编辑角色传入。问题、草稿和历史都按原文发送，包括其中的代码、命令、路径、链接、引文和数字。

受信任的 hook 在本机记录会话文件的位置和当前轮次，以便用户点名重写之前的回复。即使历史设为 0，这条定位记录也只含元数据。取旧回复时，`question` 和 `draft` 来自同一轮。该轮若展示过润色版和原稿，就取折叠的 GPT 原稿。无法确认目标时，先请用户指明或提供原文。

`history` 从待改回复之前的完整问答中选取，按时间顺序发送。每轮包括用户消息（含同轮补充）和 Codex 最终答复。工具输出、进度提示、含疑似凭据或附件的轮次均会跳过。目标问答不占历史名额。可附带 0 到 10 轮，默认 2 轮。历史设为 0、未信任 hook、没有可用历史或用户要求这次不带历史时，ACP 消息省略 `history`。

OpenAI 对每个 `input_json.data` 规定 256 KiB 的紧凑 UTF-8 JSON、最多 32 层容器和 10,000 个值。插件在一个这样的字段中提交本轮的风格检查材料，一次只问一个判断题。超过接口大小限制的材料会完整交给 Gemini。`gpt-6-luna` 模型卡另列 1,050,000 token 的上下文窗口。[Decisions 接口](https://developers.openai.com/api/reference/resources/decisions/methods/create) · [GPT-6 Luna 模型卡](https://developers.openai.com/api/docs/models/gpt-6-luna)

Google 为默认模型 `gemini-4-hydrogen` 的 Gemini API 公布了 1,048,576 token 的共享窗口，输入、推理和最终输出均占用这个窗口。使用 Antigravity 时还要考虑会话本身的开销和所选模型，例如 Antigravity 对 Gemini 4 Neon 明列最多 512K token。Google 的 ACP 文档未给出 Hydrogen 单条润色请求的确切字节上限。`agy` 1.5.8 起会在创建会话和切换模型后报告会话窗口用量。[Hydrogen 模型卡](https://aistudio.google.com/docs/models/gemini-4-hydrogen) · [Antigravity 模型说明](https://antigravity.google/docs/models#gemini-4-neon) · [Antigravity CLI 1.5.8](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.8)

插件自身不写草稿日志。Codex 宿主日志、服务商侧日志以及机器上全局配置的 Antigravity hooks 仍按各自的环境配置运行。服务商的数据处理遵循各自条款，与本项目的 Apache License 2.0 代码许可无关，可参阅 [Google 使用说明](https://antigravity.google/docs/faq)。

## 认证与故障处理

插件要求官方 Antigravity CLI（`agy`）1.2.1 或更高版本，先在 Codex 的 `PATH` 中查找 `agy`，再查 `~/.local/bin/agy`。默认通过 `agy acp` 复用本机已有登录，无需配置 Gemini API 密钥，也从不调用 `agy -p`。旧配置如需沿用 AI Studio 密钥可设 `CODEX_POLISH_AGY_AUTH=gemini-api-key`，企业环境可设 `agent-platform`。凭据必须配置在运行 Codex 的机器和对应系统用户下，详见 [首次配置指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md)。

| 故障类型 | 回退与限制行为 |
| --- | --- |
| Google 认证方式不支持、缺少 agy 或宿主工具不可用 | 保留原稿。插件依次在 PATH 和 ~/.local/bin 查找 agy。 |
| Decisions 不可用、密钥无效、响应无效或材料超过接口限额 | 通过本地检查后，直接交给 Gemini。每一轮独立判断。 |
| ACP 握手失败、未登录、账号无所选模型或中途切换模型 | 当前 agent 结束本次 ACP 请求，回收进程并交付原稿。 |
| 生成耗时较长或中断 | 进程仍在运行时继续等待。宿主或服务端明确超时、取消、断流或返回不完整时丢弃候选，同一请求最多发送一次。 |
| 本轮中途停用、修改要求或取消 | 外发前重新核对项目模式。收到新要求时丢弃旧候选，按新要求作答。用户取消则结束本轮。若只有服务端取消，用户仍在等待，就交付原稿。 |

## 安装、更新和卸载

测试版发布到 npm 后，运行 `npx @kyun.si/codex-polish@beta setup` 即可安装。将最后一个参数换成 `update`、`doctor` 或 `uninstall` 即可更新、检查当前项目或卸载。从 GitHub 源码安装时，在仓库根目录运行 `node scripts/install.mjs setup`，其余子命令相同。[安装步骤](../README.md#三步快速开始)

`setup` 和 `update` 支持 `--install-agy`，在缺少 Antigravity CLI 时可自动安装。更新会保留项目设置与插件启用状态。同一版本号的新构建也能用 `update` 覆盖或重试中断的更新。

安装器为每份 Codex 配置注册一个本地市场。更新时先准备并校验新快照，然后原子替换市场清单，再请 Codex 刷新插件缓存。刷新失败时会恢复原快照和启用状态。Codex 判断 hook 信任时会核对已安装插件的内容，所以即使命令没变，内置提示词或配置指南的改动也可能触发重新确认。安装器和 `doctor` 都从 `hooks/list` 读取实际状态。

手头有本地打包的 `0.0.1-beta.4` 版时，也可以在压缩包所在目录运行 `npx --yes file:./kyun.si-codex-polish-0.0.1-beta.4.tgz uninstall`。卸载会清理该插件与专用市场，按当前 Codex 配置清除会话指针，保留各项目的 `.codex/` 配置和共用的 `agy`，并提示被手动修改过的安装文件备份位置。

## 已验证记录与真机验收

本机实测使用一份带有 10 轮虚构问答（合计 16 KiB）的会话，并保存了自定义润色提示词。OpenAI 收到一次请求，材料只有 `question`、`draft`、`editor_prompt`，返回 HTTP 200。随后 Gemini 4 Hydrogen 通过 ACP 收到全部 10 轮历史并完成了改写。

在完整源码的根目录运行以下离线测试和合成数据报告。发行包附带中英文评测说明，测试脚本、统计脚本和示例数据需从源码获取。参见 [源码测试与贡献指南](../CONTRIBUTING.md)。

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
```

Decisions 测试使用模拟的 OpenAI 响应检查风格判定阈值和接口报错时的处理。

源码中的 `tests/fixture_acp.mjs` 是专供测试的模拟服务端，覆盖正常改写、认证失败、模型缺失、生成期换模型、权限请求、静默超时、断流和跨会话消息交错，不会安装到最终产物中。安装回归测试会在本机已装好 Codex CLI 和 npm 的前提下创建一次性 Codex 配置，打出发版压缩包，验证 macOS 双击脚本以及从 `.tgz` 安装、更新、检查和卸载的全流程，并通过 Codex CLI 确认 Setup 已启用、`UserPromptSubmit` 已注册且等待信任。本地 T3 Code Beta 的 Codex 配置中也能发现 `codex-polish` 和 `codex-polish-setup`，两者都显示已启用。T3 聊天界面从触发改写到显示最终回复的全流程仍待验收。

在 macOS 上用 Node.js 22.16 和官方 Antigravity CLI 1.5.12 做过一次真实改写。测试环境的 PATH 中没有 Python，也没有配置 OpenAI 密钥。当前 Codex agent 通过 ACP 选中了 `gemini-4-hydrogen`，改稿保留了本地测试通过、线上尚未验证的事实。Node 辅助脚本没有向网络发出请求。

真人偏好仍待盲评。可用已获授权并去除敏感信息的真实样本完成以下验收。

1. 分别在无 OpenAI 密钥和开启 Decisions 的项目中核对工具轨迹，确认只有当前 agent 持有 ACP 进程、模型选择准确且结束后进程回收干净。
2. 用超过 4 KiB 的中文长文在两个 Codex 会话中并发运行，确认正文和会话 ID 不串线，并核对缺模型、权限请求、取消和断流时的回退表现。
3. 在原生最终消息和重开会话后的记录中核对状态、两版顺序及正文。在支持折叠的客户端，确认新回复里的原稿默认收起，展开后对照原稿，并将润色版与 Gemini 返回的改稿逐字核对。统计盲评偏好、严重事实反转、漏调率、选定正文的逐字一致率和端到端延迟。统计门槛要求校准集和盲评集合计至少 200 个已交付的真实样本。[验收数据格式和指标](../evaluation/README.md)
