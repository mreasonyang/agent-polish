# 技术参考

[English](technical.en.md) · [项目首页](../README.md)

`codex-polish` 0.0.1 包含两个 Codex 技能。[改写技能](../plugins/codex-polish/skills/codex-polish/SKILL.md) 在最终答复交付前润色草稿，[设置技能](../plugins/codex-polish/skills/codex-polish-setup/SKILL.md) 检查运行环境并保存项目设置。

## 模式、配置文件与查找规则

设置保存在项目的 `.codex/` 目录下。每个文件单独查找，从本轮开始时的工作目录逐级向上，最先找到的文件生效。查过第一个含 `.git` 的目录即停止。在这之前若到达用户主目录或文件系统根目录，也会停止，不读取这两个目录里的设置。

| 配置文件 | 取值范围与默认值 | 运行行为 |
| --- | --- | --- |
| `.codex/codex-polish.mode` | `manual`（默认）、`auto`、`off` | `manual` 仅在用户点名时润色，处理当前问题和草稿不需要 hook。`auto` 需在宿主设置或 CLI `/hooks` 中信任插件的 `UserPromptSubmit` hook。`off` 完全停用，即使点名要求润色也不会外发。 |
| `.codex/codex-polish.model` | 模型 ID，默认 `gemini-4-hydrogen`（Gemini 4 Hydrogen） | 保存当前项目选用的 Gemini 模型。选项在运行时通过 ACP 从当前登录的 Antigravity 账号实时读取，不同账号返回的列表可能不同。仅查看模型菜单不会发送草稿或历史。下次改写时会核对所选模型，若已下线则本轮保留原稿。 |
| `.codex/codex-polish.history-turns` | `0`–`10` 的整数，默认 `2` | 控制附带的最近完整问答轮数，从下次改写起生效。设为 `0` 只发本轮问题和草稿。保存大于 `10` 的值会报错。文件中的值不在范围内或格式无效时，本轮不带历史。无论手动还是自动模式，读取历史都需要受信任的 `UserPromptSubmit` hook。 |
| `.codex/codex-polish.decisions` | `auto`（默认）、`off` | 与触发模式分开设置。`auto` 按 `OPENAI_API_KEY` 决定是否调用 OpenAI，`off` 始终只用 ACP。 |
| `.codex/codex-polish.language` | `auto`（默认）、`zh`、`en` | 控制插件设置与终端提示语言。`auto` 下，设置对话优先跟随本条消息所用的中文或英文。只点击菜单或回复数字时沿用对话语言。两者都无法判断时使用系统语言。终端也使用系统语言，未识别出中文或英文时用英文。改写后的回复始终保持草稿原本的语言。 |

有关 Codex 如何加载插件、注册 hook 以及取得用户信任，参见 [Codex 插件与 hook](https://developers.openai.com/plugins/build/plugins) 和 [项目 hook 和信任机制](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks)。

## 改写流程与判定阈值

插件支持直接 ACP 和 OpenAI Decisions 加 ACP 两条路径。当 `OPENAI_API_KEY` 未设置、为空或仅含空白字符，或项目已关闭额外检查时，插件直接使用 ACP。此时由 `agy` 联系 Google，本地 Node.js 脚本不发网络请求。开启 Decisions 时，Node.js 脚本只向 OpenAI `gpt-6-luna` 发起风格判定与原意复核，且这两步都不附带对话历史。每轮最多提交一次含草稿的 ACP 请求。当前 Codex agent 负责启动和回收进程，并在同一会话中收发协议消息。[ACP 操作步骤](../plugins/codex-polish/skills/codex-polish/references/acp.md)

| 阶段 | 执行标准与阈值 |
| --- | --- |
| 1. 文本保护 | 扫描常见凭据、固定格式要求（如仅输出 JSON 或命令）以及不适合改写的结构，命中时直接返回原稿。将代码块、行内命令、链接、引用、文件路径和数值及其单位替换为按本轮和来源区分的字面量占位符。 |
| 2. 风格判定 | 直接 ACP 路径在本地检查通过后立即进入改写。开启 Decisions 时，只有 `P(需要改写) ≥ 0.80` 才进入改写，原本清楚的草稿直接保留。 |
| 3. ACP 改写 | 在临时工作区启动关闭了默认内置工具的专用编辑角色，使用已配置的 Antigravity 身份建立会话，核对项目选中的模型，拒绝全部权限请求，且只接收请求 ID 匹配的完整 `end_turn`。 |
| 4. 固定内容还原 | 占位符必须按顺序逐一对应。还原后再次校验固定内容、数值与单位、控制字符、疑似凭据以及受支持的 Markdown 结构。 |
| 5. 原意复核与交付 | 直接 ACP 路径通过本地校验即采用改稿。开启 Decisions 时还需满足 `P(实质变化) ≤ 0.05`。任一阶段未通过均回退原稿，用户取消则直接结束本轮。 |

相关接口规范见 [Google ACP 认证](https://antigravity.google/docs/ide/extensions/acp)、[Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create) 与 [Antigravity 角色的工具配置](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.1)。

## 隐私边界、文本保护与历史限制

本轮问题和待润色草稿在外发给 OpenAI 或 Google 之前都会先做字面量占位符替换。这些占位符保护代码、命令、路径、链接和数字等固定片段。服务商仍可读取普通正文。

只有 Google 会在触发改写时收到允许附带的对话历史，OpenAI 不会收到任何历史记录。hook 记录本轮对应的会话文件，本地脚本直接从该文件读取问答。一轮历史指本轮之前已完成的完整问答，含同一轮内用户补发的消息和 Codex 的最终答复，工具输出和进度提示均不计入。本轮问题和草稿不占历史轮数名额。

历史里的文字和代码按原文发送。脚本最多扫描会话记录末尾 4 MiB，按从近到远选取完整问答，最多附带 16 KiB 的 UTF-8 正文，再按时间顺序交给 Google。含疑似凭据或附件的回合会跳过，尚未完成的回合也不附带。未信任 hook、读不到匹配的会话记录、没有符合条件的历史，或用户本轮只允许发送当前内容时，插件仍可只用本轮问题和草稿改写。

插件自身不写草稿日志。Codex 宿主日志、服务商侧日志以及机器上全局配置的 Antigravity hooks 仍按各自的环境配置运行。服务商的数据处理遵循各自条款，与本项目的 Apache License 2.0 代码许可无关，可参阅 [Google 使用说明](https://antigravity.google/docs/faq)。

## 认证、故障分类与冷却机制

插件要求官方 Antigravity CLI（`agy`）1.2.1 或更高版本，先在 Codex 的 `PATH` 中查找 `agy`，再查 `~/.local/bin/agy`。默认通过 `agy acp` 复用本机已有登录，无需配置 Gemini API 密钥，也从不调用 `agy -p`。旧配置如需沿用 AI Studio 密钥可设 `CODEX_POLISH_AGY_AUTH=gemini-api-key`，企业环境可设 `agent-platform`。凭据必须配置在运行 Codex 的机器和对应系统用户下，详见 [首次配置指南](../plugins/codex-polish/skills/codex-polish-setup/references/credentials.md)。

| 故障类型 | 回退与限制行为 |
| --- | --- |
| 密钥格式错误、认证方式不支持、缺少 `agy` 或宿主工具不可用 | 本地停止并交付原稿。启用 Decisions 后，如果密钥含有实际内容，但夹带空白、非 ASCII 字符或不可打印字符，本地检查会拦下请求。修正或清空密钥，或将项目的 Decisions 设为 `off` 后可重试。 |
| Decisions 超时、断网、限流、配额耗尽、认证失败、响应无效或拒答 | 每次调用限时 10 秒。即使密钥格式通过本地检查，OpenAI 仍可能返回 401 或 403。发生错误时交付原稿，相关服务故障会触发下述冷却。单条内容被拒答只影响本轮。 |
| ACP 握手失败、未登录、账号无所选模型或中途切换模型 | 当前 agent 结束本次 ACP 请求，回收进程并交付原稿。 |
| ACP 静默、半篇断流或结束帧 ID 不匹配 | 每个控制请求限时 10 秒。生成期间若连续 30 秒未收到本会话的有效进度，就停止等待。从启动算起总限时 90 秒，清理阶段最多再等 3 秒。即使退出码为 0，未收到匹配 `end_turn` 的半篇内容也会丢弃，且不会自动重发。 |
| 占位符错位、数值单位改动、出现疑似凭据或原意复核超标 | 整篇改稿丢弃并交付原稿，模型思考与其他会话消息不会混入正文。 |
| 本轮中途停用、修改要求或取消 | 外发前重新核对项目模式。收到新要求时丢弃旧候选，按新要求作答。用户取消则结束本轮。若只有服务端取消，用户仍在等待，就交付原稿。 |

自动模式下，连接失败、超时、限流或服务异常会让当前 Codex 配置下的该项目暂停自动润色 **60 秒**。认证失败、明确的 OpenAI 配额耗尽或所选 Gemini 模型不可用会暂停 **5 分钟**。固定格式跳过、正常拒答和改稿校验驳回不会触发冷却。每条冷却记录只包含作用域哈希、固定故障码、时间戳和随机标记。用户在修好环境后可以随时在新一轮点名手动重试。

## 安装、更新和卸载

安装 npm 发行版时运行 `npx @kyun.si/codex-polish@latest setup`，将最后一个参数换成 `update`、`doctor` 或 `uninstall` 即可更新、检查当前项目或卸载。从 GitHub 源码安装时，在仓库根目录运行 `node scripts/install.mjs setup`，其余子命令相同。[安装步骤](../README.md#三步快速开始)

`setup` 和 `update` 支持 `--install-agy`，在缺少 Antigravity CLI 时可自动安装。更新会保留项目设置与插件启用状态。同一版本号的新构建也能用 `update` 覆盖或重试中断的更新。

手头有本地打包的 0.0.1 版时，也可以在压缩包所在目录运行 `npx --yes file:./kyun.si-codex-polish-0.0.1.tgz uninstall`。卸载会清理该插件与专用市场，按当前 Codex 配置清除冷却记录和会话指针，保留各项目的 `.codex/` 配置和共用的 `agy`，并提示被手动修改过的安装文件备份位置。

## 已验证记录与真机验收

在完整源码的根目录运行以下离线测试和合成数据报告。发行包附带中英文评测说明，测试脚本、统计脚本和示例数据需从源码获取。参见 [源码测试与贡献指南](../CONTRIBUTING.md)。

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
```

真实 Decisions 原意复核是单独的付费测试，默认跳过。在终端配置 `OPENAI_API_KEY` 后，运行以下命令会发起四次 API 请求。中文和英文各测两份改稿，一份保留原意，一份改错了事实。

```sh
CODEX_POLISH_TEST_LIVE_DECISIONS=1 node --test --test-name-pattern='live fidelity' tests/decisions.test.mjs
```

源码中的 `tests/fixture_acp.mjs` 是专供测试的模拟服务端，覆盖正常改写、认证失败、模型缺失、生成期换模型、权限请求、静默超时、断流和跨会话消息交错，不会安装到最终产物中。安装回归测试会在本机已装好 Codex CLI 和 npm 的前提下创建一次性 Codex 配置，打出发版压缩包，验证 macOS 双击脚本以及从 `.tgz` 安装、更新、检查和卸载的全流程，并通过 Codex CLI 确认 Setup 已启用、`UserPromptSubmit` 已注册且等待信任。本地 T3 Code Beta 的 Codex 配置中也能发现 `codex-polish` 和 `codex-polish-setup`，两者都显示已启用。T3 聊天界面从触发改写到显示最终回复的全流程仍待验收。

在 macOS 上用 Node.js 22.16 和官方 Antigravity CLI 1.5.12 做过一次真实改写。测试环境的 PATH 中没有 Python，也没有配置 OpenAI 密钥。当前 Codex agent 通过 ACP 选中了 `gemini-4-hydrogen`，改稿保留了本地测试通过、线上尚未验证的事实。本地校验通过，Node 辅助脚本没有向网络发出请求。

真人偏好仍待盲评。可用已获授权并去除敏感信息的真实样本完成以下验收。

1. 分别在无 OpenAI 密钥和开启 Decisions 的项目中核对工具轨迹，确认只有当前 agent 持有 ACP 进程、模型选择准确且结束后进程回收干净。
2. 用超过 4 KiB 的中文长文在两个 Codex 会话中并发运行，确认正文、占位符和会话 ID 不串线，并核对缺模型、权限请求、取消和断流时的回退表现。
3. 对照校验工具输出、原生最终消息和重开会话后的记录，统计盲评偏好、严重事实反转、漏调率、逐字一致率和端到端延迟。统计门槛要求校准集和盲评集合计至少 200 个已交付的真实样本。[验收数据格式和指标](../evaluation/README.md)
