# 技术参考

[English](technical.en.md) · [项目首页](../README.md)

`codex-polish` 的 `0.0.1-beta.3` 版包含两个 Codex 技能。[改写技能](../plugins/codex-polish/skills/codex-polish/SKILL.md) 在最终答复交付前润色草稿，[设置技能](../plugins/codex-polish/skills/codex-polish-setup/SKILL.md) 检查运行环境并保存项目设置。

## 模式、配置文件与查找规则

设置保存在项目的 `.codex/` 目录下。每个文件单独查找，从本轮开始时的工作目录逐级向上，最先找到的文件生效。查过第一个含 `.git` 的目录即停止。在这之前若到达用户主目录或文件系统根目录，也会停止，不读取这两个目录里的设置。

| 配置文件 | 取值范围与默认值 | 运行行为 |
| --- | --- | --- |
| `.codex/codex-polish.mode` | `auto`（默认）、`manual`、`off` | 未保存模式时使用 `auto`。在 Codex 的 **设置 → Hooks** 或 CLI `/hooks` 中信任插件的 `UserPromptSubmit`，再新开聊天，普通提问就会触发润色流程。`manual` 仅在点名时触发。两种模式都可以点名润色本轮问答，无需 hook。`off` 跳过所有润色请求。 |
| `.codex/codex-polish.rewrite-mode` | `normal`（默认）、`turbo` | 决定触发后如何改写。`normal` 沿用项目的 Decisions 设置，`turbo` 将符合条件的草稿直接交给 Gemini。 |
| `.codex/codex-polish.model` | 模型 ID，默认 `gemini-4-hydrogen`（Gemini 4 Hydrogen） | 保存当前项目选用的 Gemini 模型。选项在运行时通过 ACP 从当前登录的 Antigravity 账号实时读取，不同账号返回的列表可能不同。仅查看模型菜单不会发送草稿或历史。下次改写时会核对所选模型，若已下线则本轮保留原稿。 |
| `.codex/codex-polish.prompt.md` | UTF-8 纯文本，最多 16 KiB，默认使用当前模式的内置提示词 | 自定义文本从下一次改写起生效。同一项目中新开的聊天沿用该设置。 |
| `.codex/codex-polish.history-turns` | `0`–`10` 的整数，默认 `2` | 控制 Gemini 改写时附带的最近完整问答轮数，从下次改写起生效。设为 `0` 就不附历史问答。保存大于 `10` 的值会报错。文件中的值不在范围内或格式无效时，本轮不带历史。无论手动还是自动模式，读取历史都需要受信任的 `UserPromptSubmit` hook。 |
| `.codex/codex-polish.decisions` | `auto`（默认）、`off` | 普通改写模式使用此设置。`auto` 按 `OPENAI_API_KEY` 决定是否调用 OpenAI，`off` 始终只用 ACP。 |
| `.codex/codex-polish.language` | `auto`（默认）、`zh`、`en` | 控制插件设置与终端提示语言。`auto` 下，设置对话优先跟随本条消息所用的中文或英文。只点击菜单或回复数字时沿用对话语言。两者都无法判断时使用系统语言。终端也使用系统语言，未识别出中文或英文时用英文。 |

在聊天中说“切换到 Turbo 模式”或“恢复普通模式”即可保存项目偏好。要从源码目录切换，可运行 `node plugins/codex-polish/hooks/preferences.mjs set-rewrite-mode turbo --cwd /path/to/project`，恢复时将 `turbo` 换为 `normal`。用 `check --cwd /path/to/project` 查看生效的 `rewrite_mode`。无效设置会在本地停止润色，重新选择任一模式即可恢复。

有关 Codex 如何加载插件、注册 hook 以及取得用户信任，参见 [Codex 插件与 hook](https://developers.openai.com/plugins/build/plugins) 和 [项目 hook 和信任机制](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks)。

### 查看、设置或恢复润色提示词

可以在聊天中说“查看润色提示词”“把项目润色提示词设为：先写结论，再讲依据。”或“恢复默认润色提示词”。也可以在源码根目录执行下面的本地命令，将 `/path/to/project` 换成目标项目的路径。`set-prompt` 从标准输入逐字保存文本，包括换行和首尾空格。`prompt` 返回当前生效的文本 `text` 及其来源 `source`（`default` 或 `custom`）。没有自定义提示词时，返回当前改写模式的内置文本。设定自定义提示词后，普通和 Turbo 模式都以 `text` 原文作为 Gemini 的全部编辑指令。角色文件头部配置 ACP 会话与工具权限，正文只有这段原文。

```sh
node plugins/codex-polish/hooks/preferences.mjs prompt --cwd /path/to/project
node plugins/codex-polish/hooks/preferences.mjs set-prompt --cwd /path/to/project < my-prompt.md
node plugins/codex-polish/hooks/preferences.mjs set-prompt --reset --cwd /path/to/project
```

直接编辑项目的提示词文件也会生效。子目录默认继承上级设置。在子目录恢复默认时，如果原本会继承上级的自定义或无效提示词，命令会在子目录写入零字节文件，选用当前模式的内置提示词。超过 16 KiB、仅含空白字符的非空文件、无效 UTF-8、受限控制字符或疑似凭据都会使本轮润色在本地停止（`editor_prompt_invalid`）。更正提示词或恢复默认即可。普通环境检查只报告提示词的来源或错误状态。

## 改写流程与判定阈值

插件支持直接 ACP 和 OpenAI Decisions 加 ACP 两条路径。Turbo 始终跳过 OpenAI，将每份符合条件的草稿直接交给 Gemini。其内置提示词要求 Gemini 主动改写。普通模式下，当 `OPENAI_API_KEY` 未设置、为空或仅含空白字符，或项目已关闭风格检查时，插件直接使用 ACP。此时由 `agy` 联系 Google，本地 Node.js 脚本不发网络请求。开启 Decisions 时，Node.js 脚本只在改写前调用一次 OpenAI `gpt-6-luna`，判断草稿是否需要润色。每轮最多提交一次含草稿的 ACP 请求。当前 Codex agent 负责启动和回收进程，并在同一会话中收发协议消息。[ACP 操作步骤](../plugins/codex-polish/skills/codex-polish/references/acp.md)

| 阶段 | 执行标准与阈值 |
| --- | --- |
| 1. 本地输入检查 | 检查本轮问题和草稿中的疑似凭据。检测到疑似凭据、用户要求固定格式（如仅输出 JSON 或命令），或草稿结构不适合改写时，直接交付原稿。 |
| 2. 风格判定 | 直接 ACP 路径在本地检查通过后进入改写。开启 Decisions 时，OpenAI 只根据本轮问题、草稿和已设置的自定义润色提示词判断是否需要改写，只有 `P(需要改写) ≥ 0.80` 才进入改写。 |
| 3. ACP 改写 | Gemini 从编辑角色正文加载项目当前生效的提示词。在临时工作区关闭默认内置工具，使用已配置的 Antigravity 身份建立会话，核对项目选中的模型，拒绝全部权限请求，且只接收请求 ID 匹配的完整 `end_turn`。 |
| 4. 本地改稿检查 | 检查改稿的长度、控制字符和疑似凭据，并对照草稿检查受支持的 Markdown 结构，例如标题级别、列表标记和缩进。Turbo 收到原文时返回 `unchanged_candidate`，保留原稿并说明原因，不重试。比较时忽略首尾空白及换行风格。 |
| 5. 交付 | 两条路径都运行本地 `preferences.mjs finish`。它不接收正文，会核对触发设置、改写模式、运行条件和本轮所用路径。通过后交付改稿，失败则交付原稿。用户取消时结束本轮。 |

相关接口规范见 [Google ACP 认证](https://antigravity.google/docs/ide/extensions/acp)、[Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create) 与 [Antigravity 角色的工具配置](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1)。

## 最终回复如何显示

采用改稿时，Codex 在同一条最终消息中先显示 **Gemini 润色版**。在 Codex App 中，点击下方的“查看 GPT 原稿”即可展开完整原稿，再点一次收起。普通原稿保留 Markdown 排版。原稿包含折叠标签或容器分隔符时，展开后显示 Markdown 源文，方便逐字查看这些标记。

如果 Gemini 确实返回了相同的文字，回复会说明 Gemini 返回了原文，正文只显示一次。在发送前跳过、请求未完成或改稿被拒绝时，回复说明可确认的原因，只显示原稿。明确要求“只给润色后的正文”时只交付选定的正文。JSON、单条命令及其他逐字输出按用户要求直接交付，不加标题或状态。

## 发送给服务商的内容与历史限制

启用 OpenAI Decisions 时，发给 OpenAI 的 `input_json.data` 只包含本轮 `question`、`draft`，以及项目已设置的 `editor_prompt`。进入 Gemini 改写时，发给 Google 的 ACP 消息包含本轮问题、草稿和可选的 `history`。自定义提示词通过 Antigravity 编辑角色传入。问题、草稿和历史都按原文发送，包括其中的代码、命令、路径、链接、引文和数字。Gemini 返回的改稿在本地检查。

受信任的 hook 记录本轮对应的会话文件。组装 Gemini 改写请求时，本地脚本可扫描其末尾最多 4 MiB。一轮历史包含先前一轮的用户消息（含同轮补充）和 Codex 最终答复。工具输出和进度提示不计入。历史轮数可选 0 到 10 轮，默认 2 轮。脚本优先选择近期完整问答，历史正文按 UTF-8 合计最多 16 KiB，按时间顺序发送。含疑似凭据、有附件或尚未完成的轮次会被跳过。本轮问题和草稿不占历史名额。历史设为 0、未信任 hook、读不到匹配的会话、没有可用历史或本轮要求不带历史时，ACP 消息省略 `history` 字段。

| 本地输入上限 | 计量方式与超限行为 |
| --- | --- |
| 本轮问题／草稿各 128 KiB | 分别按原文 UTF-8 字节数计算。任一超限就保留原稿。 |
| 每一步的材料合计 256 KiB（含边界） | 按紧凑 UTF-8 JSON 计算，包含问题、草稿、已设置的自定义提示词、字段名、标点和转义。仅在 Gemini 改写时计入所选历史。超限时先移除最早的完整问答。如果仅本轮问题、草稿和自定义提示词就已超限，保留原稿。 |

OpenAI 对每个 `input_json.data` 规定 256 KiB 的紧凑 UTF-8 JSON、最多 32 层容器和 10,000 个值。插件在一个这样的字段中提交本轮的风格检查材料，一次只问一个判断题。`gpt-6-luna` 模型卡另列 1,050,000 token 的上下文窗口。[Decisions 接口](https://developers.openai.com/api/reference/resources/decisions/methods/create) · [GPT-6 Luna 模型卡](https://developers.openai.com/api/docs/models/gpt-6-luna)

Google 为默认模型 `gemini-4-hydrogen` 的 Gemini API 公布了 1,048,576 token 的共享窗口，输入、推理和最终输出均占用这个窗口。使用 Antigravity 时还要考虑会话本身的开销和所选模型，例如 Antigravity 对 Gemini 4 Neon 明列最多 512K token。Google 的 ACP 文档未给出 Hydrogen 单条润色请求的确切字节上限。`agy` 1.5.8 起会在创建会话和切换模型后报告会话窗口用量。[Hydrogen 模型卡](https://aistudio.google.com/docs/models/gemini-4-hydrogen) · [Antigravity 模型说明](https://antigravity.google/docs/models#gemini-4-neon) · [Antigravity CLI 1.5.8](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.8)

插件自身不写草稿日志。Codex 宿主日志、服务商侧日志以及机器上全局配置的 Antigravity hooks 仍按各自的环境配置运行。服务商的数据处理遵循各自条款，与本项目的 Apache License 2.0 代码许可无关，可参阅 [Google 使用说明](https://antigravity.google/docs/faq)。

## 认证、故障分类与冷却机制

插件要求官方 Antigravity CLI（`agy`）1.2.1 或更高版本，先在 Codex 的 `PATH` 中查找 `agy`，再查 `~/.local/bin/agy`。默认通过 `agy acp` 复用本机已有登录，无需配置 Gemini API 密钥，也从不调用 `agy -p`。旧配置如需沿用 AI Studio 密钥可设 `CODEX_POLISH_AGY_AUTH=gemini-api-key`，企业环境可设 `agent-platform`。凭据必须配置在运行 Codex 的机器和对应系统用户下，详见 [首次配置指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md)。

| 故障类型 | 回退与限制行为 |
| --- | --- |
| 密钥格式错误、认证方式不支持、缺少 `agy` 或宿主工具不可用 | 本地停止并交付原稿。启用 Decisions 后，如果密钥含有实际内容，但夹带空白、非 ASCII 字符或不可打印字符，本地检查会拦下请求。修正或清空密钥，或将项目的 Decisions 设为 `off` 后可重试。 |
| Decisions 超时、断网、限流、配额耗尽、认证失败、响应无效或拒答 | 每次调用限时 10 秒。即使密钥格式通过本地检查，OpenAI 仍可能返回 401 或 403。发生错误时交付原稿，相关服务故障会触发下述冷却。单条内容被拒答只影响本轮。 |
| ACP 握手失败、未登录、账号无所选模型或中途切换模型 | 当前 agent 结束本次 ACP 请求，回收进程并交付原稿。 |
| ACP 静默、半篇断流或结束帧 ID 不匹配 | 每个控制请求限时 10 秒。生成期间若连续 30 秒未收到本会话的有效进度，就停止等待。从启动算起总限时 90 秒，清理阶段最多再等 3 秒。即使退出码为 0，未收到匹配 `end_turn` 的半篇内容也会丢弃，且不会自动重发。 |
| 改稿含疑似凭据或受限控制字符，或受支持的 Markdown 结构发生变化 | 整篇改稿丢弃并交付原稿，模型思考与其他会话消息不会混入正文。 |
| 本轮中途停用、修改要求或取消 | 外发前重新核对项目模式。收到新要求时丢弃旧候选，按新要求作答。用户取消则结束本轮。若只有服务端取消，用户仍在等待，就交付原稿。 |

自动模式下，连接失败、超时、限流或服务异常会让当前 Codex 配置下的该项目暂停自动润色 **60 秒**。认证失败、明确的 OpenAI 配额耗尽或所选 Gemini 模型不可用会暂停 **5 分钟**。固定格式跳过、正常拒答和改稿校验驳回不会触发冷却。每条冷却记录只包含作用域哈希、固定故障码、时间戳和随机标记。用户在修好环境后可以随时在新一轮点名手动重试。

## 安装、更新和卸载

测试版发布到 npm 后，运行 `npx @kyun.si/codex-polish@beta setup` 即可安装。将最后一个参数换成 `update`、`doctor` 或 `uninstall` 即可更新、检查当前项目或卸载。从 GitHub 源码安装时，在仓库根目录运行 `node scripts/install.mjs setup`，其余子命令相同。[安装步骤](../README.md#三步快速开始)

`setup` 和 `update` 支持 `--install-agy`，在缺少 Antigravity CLI 时可自动安装。更新会保留项目设置与插件启用状态。同一版本号的新构建也能用 `update` 覆盖或重试中断的更新。

手头有本地打包的 `0.0.1-beta.3` 版时，也可以在压缩包所在目录运行 `npx --yes file:./kyun.si-codex-polish-0.0.1-beta.3.tgz uninstall`。卸载会清理该插件与专用市场，按当前 Codex 配置清除冷却记录和会话指针，保留各项目的 `.codex/` 配置和共用的 `agy`，并提示被手动修改过的安装文件备份位置。

## 已验证记录与真机验收

本机实测使用一份带有 10 轮虚构问答（合计 16 KiB）的会话，并保存了自定义润色提示词。OpenAI 收到一次请求，材料只有 `question`、`draft`、`editor_prompt`，返回 HTTP 200。随后 Gemini 4 Hydrogen 通过 ACP 收到全部 10 轮历史并完成了改写。

在完整源码的根目录运行以下离线测试和合成数据报告。发行包附带中英文评测说明，测试脚本、统计脚本和示例数据需从源码获取。参见 [源码测试与贡献指南](../CONTRIBUTING.md)。

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
```

Decisions 测试使用模拟的 OpenAI 响应检查风格判定阈值和出错时保留原稿的行为。

源码中的 `tests/fixture_acp.mjs` 是专供测试的模拟服务端，覆盖正常改写、认证失败、模型缺失、生成期换模型、权限请求、静默超时、断流和跨会话消息交错，不会安装到最终产物中。安装回归测试会在本机已装好 Codex CLI 和 npm 的前提下创建一次性 Codex 配置，打出发版压缩包，验证 macOS 双击脚本以及从 `.tgz` 安装、更新、检查和卸载的全流程，并通过 Codex CLI 确认 Setup 已启用、`UserPromptSubmit` 已注册且等待信任。本地 T3 Code Beta 的 Codex 配置中也能发现 `codex-polish` 和 `codex-polish-setup`，两者都显示已启用。T3 聊天界面从触发改写到显示最终回复的全流程仍待验收。

在 macOS 上用 Node.js 22.16 和官方 Antigravity CLI 1.5.12 做过一次真实改写。测试环境的 PATH 中没有 Python，也没有配置 OpenAI 密钥。当前 Codex agent 通过 ACP 选中了 `gemini-4-hydrogen`，改稿保留了本地测试通过、线上尚未验证的事实。本地校验通过，Node 辅助脚本没有向网络发出请求。

真人偏好仍待盲评。可用已获授权并去除敏感信息的真实样本完成以下验收。

1. 分别在无 OpenAI 密钥和开启 Decisions 的项目中核对工具轨迹，确认只有当前 agent 持有 ACP 进程、模型选择准确且结束后进程回收干净。
2. 用超过 4 KiB 的中文长文在两个 Codex 会话中并发运行，确认正文和会话 ID 不串线，并核对缺模型、权限请求、取消和断流时的回退表现。
3. 在原生最终消息和重开会话后的记录中核对状态、两版顺序及正文。在支持折叠的客户端，确认新回复里的原稿默认收起，展开后对照原稿，并将润色版与 Gemini 返回的改稿逐字核对。统计盲评偏好、严重事实反转、漏调率、选定正文的逐字一致率和端到端延迟。统计门槛要求校准集和盲评集合计至少 200 个已交付的真实样本。[验收数据格式和指标](../evaluation/README.md)
