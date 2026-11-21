# 第一次配置回复润色

[English](credentials.en.md)

在项目目录交互运行 `setup`，用 **↑ / ↓** 选择自动润色的改写模式，按 **回车** 确认。两种模式都无须 OpenAI 密钥，未启用下文的 OpenAI 风格检查时都会把草稿交给 Gemini。使用内置提示词时，默认选中的 **普通（Normal）** 允许 Gemini 保留清晰原稿，也可配合可选的 OpenAI 检查。**Turbo** 则跳过 OpenAI 检查，请 Gemini 改写草稿。

你也可以在项目聊天里说 **“配置回复润色”** 并点选模式，在纯文本聊天中直接回复模式名即可，项目会记住你的选择。接着可以选默认的 **Gemini 4 Hydrogen**，或查询 Antigravity 账号的可用模型。选择默认模型不会启动 Codex，只有终端里的账号模型查询会通过 `codex exec` 启动临时 Codex 会话，并调用 `agy acp` 获取模型列表。

## 准备 Antigravity

在实际运行 Codex 的机器上，用同一个系统账户安装插件。插件先在 Codex 的 PATH 里找 `agy`，再查 Google 默认目录（Windows 的 `%LOCALAPPDATA%\agy\bin` 或 macOS、Linux 的 `~/.local/bin`）。首次双击安装或在终端交互运行 `setup` 时，如果缺少 `agy`，你可以同意安装 Google 官方 CLI，也可以跳过。无人值守安装或之后想补装时，运行 `npx @kyun.si/codex-polish@beta setup --install-agy`。用源码安装时，在仓库里运行 `node scripts/install.mjs setup --install-agy`。也可以按 Google 的指南单独安装。[官方 CLI 安装指南](https://antigravity.google/docs/getting-started/?tab=cli)

只有 Antigravity 提示需要登录时，才需要在自己的终端运行 `agy` 登录。如果终端找不到命令，在 Windows PowerShell 中运行 `& "$env:LOCALAPPDATA\agy\bin\agy.exe"`，macOS 或 Linux 上运行 `~/.local/bin/agy`。登录后回 Codex 再试一次改写。[ACP 认证说明](https://antigravity.google/docs/ide/extensions/acp#authentication)

项目默认自动润色。改写整条答复时，Google 收到的是那条答复、它所回答的问题，以及你这次提出的改写要求。改写材料按原文发送，包括其中的代码、命令、路径或密钥。设置过项目润色提示词时，这份提示词也会发给 Google。默认还会附上原答复之前最多 2 轮问答。润色选段时省略原问题和历史。要求“只把这段原文发给 Gemini”时，只发送选段，使用内置 Turbo 提示词。在 Codex 的 **设置 → Hooks**（CLI 输入 `/hooks`）里信任插件的 `UserPromptSubmit`，再开一个项目聊天，问 **“用一句话解释 DNS。”** 如果想自己决定何时润色，可以说 **“只在我要求时润色”**。说“返回结果 polish”就会用 Turbo，直接把草稿交给 Gemini。信任 hook 前，这次请求不附带以前的问答。想停用就说 **“关闭回复润色”**。

## 选配 OpenAI 风格检查

自动润色使用普通模式且配好 `OPENAI_API_KEY` 时，OpenAI 可以先判断草稿是否需要改写。没有密钥时，草稿直接交给 Gemini。要把每份草稿直接交给 Gemini，可以说 **“切换到 Turbo 模式”**。Turbo 跳过 OpenAI，即使配了密钥也一样。说 **“恢复普通模式”** 即可重新使用项目的 Decisions 设置。OpenAI 只收到本轮问题、草稿和项目已设置的自定义润色提示词，用来判断是否需要改写。项目的历史轮数仅用于 Gemini 改写。在项目里说 **“有密钥时用 OpenAI 检查”** 可以恢复这个默认设置。要单独关闭本项目的风格检查，可以说 **“这个项目只用 Gemini 改写”**。

要启用 Decisions，可以直接用自己已有的项目密钥，也可以按下面的步骤新建一个。

1. 登录 OpenAI API Platform，在项目选择器里选中要承担 API 用量的项目。已有合适的项目可以直接用。[打开 OpenAI API Keys](https://platform.openai.com/api-keys)
2. 在 **API Keys** 点 **+ Create new secret key**，名字可以填 `codex-polish`。创建后复制密钥，对应的变量名是 `OPENAI_API_KEY`。如果选受限权限，项目必须允许 `gpt-6-luna`，密钥必须允许调用 `POST /v1/decisions`。[项目与密钥权限](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform) · [Decisions API](https://developers.openai.com/api/docs/guides/decisions)
3. 如果提示额度不足，检查对应 API 组织的余额和付款设置。Decisions 用的是所选项目的 API 额度。[查看 API 账单](https://platform.openai.com/account/billing/overview)

### 让 Codex 读到 OpenAI 密钥

如果你**从终端启动 Codex**，在 macOS 或 Linux 上打开 zsh 或 bash，进入项目目录。复制下面第一条命令并回车，看到提示后再粘贴 OpenAI 密钥并回车。粘贴时屏幕不显示字符是正常的。这样输入，实际密钥不会出现在 shell 命令里。

```sh
printf 'OpenAI API key（隐藏输入）：'; IFS= read -r -s OPENAI_API_KEY </dev/tty && export OPENAI_API_KEY; printf '\n'
```

Windows PowerShell 用户在项目目录运行下面这条命令，然后在隐藏提示处粘贴密钥。

```powershell
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'OpenAI API key' -AsSecureString)).Password
```

在**同一个终端**运行 `codex`，然后说 **“检查回复润色环境”**。这样设置只对当前 shell 和它启动的子进程有效。长期用的话，可以让密码管理器或进程管理器在每次启动执行器时注入同名变量。

如果你用的是 **Codex 桌面端或 T3 Code**，从 Dock 启动的应用和已经在跑的后台进程都可能读不到另一个终端里的 `export`。如果这个 macOS 桌面应用会自己启动本地后端，可以先结束正在进行的任务并退出应用，再从上面配好变量的终端直接运行它的可执行文件。装了 T3 Code Beta 的话，可以用下面这条命令启动它。

```sh
"/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)"
```

如果 T3 或桌面端连的是**独立 Codex daemon 或远程执行器**，要在对应后端的服务启动环境里配好变量、重启后端，再开一个新会话。在新会话里说“检查回复润色环境”，以这次结果为准。如果安装窗口能看到密钥，但会话里看不到，就检查后端启动环境和宿主的 shell 环境变量过滤规则。[Codex shell 环境配置](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)

## 确认配置

说 **“检查回复润色环境”**，可以看到自动润色时是直接通过 ACP 改写还是选用了 Decisions，以及当前用的 Google 认证方式和 `agy` 是否可用。想单独测试 ACP 进程能不能连通，可以说 **“检测 ACP 连接”**。说 **“选择改写模型”** 会列出当前账号实际可选的 Gemini 模型。配好的 key 能不能调用 Decisions，以实际调用结果为准。

如果终端里的 `agy` 能用，聊天里却提示在 `session/new` 创建会话失败，可在同一聊天里试一次 **“选择改写模型”**。这一步不发草稿。如果宿主报告禁止联网或禁止写入 Antigravity 的登录文件，请检查这个会话的执行权限。信任 hook 只负责触发自动润色。

## 需要指定 Antigravity 身份时

用默认登录时不用设置 `CODEX_POLISH_AGY_AUTH`。如果之前手动指定过其他身份，可以在启动环境里删掉这个变量，或者把它设为 `existing-session`。要用 AI Studio 密钥认证，将 `CODEX_POLISH_AGY_AUTH` 设为 `gemini-api-key`，并配置 `GEMINI_API_KEY`。需要新密钥的话，去 Google AI Studio 点 **Create API key**，选好项目并创建，然后在自己的终端里隐藏输入密钥。[Google AI Studio](https://aistudio.google.com/apikey)

```sh
export CODEX_POLISH_AGY_AUTH=gemini-api-key
printf 'Gemini API key（隐藏输入）：'; IFS= read -r -s GEMINI_API_KEY </dev/tty && export GEMINI_API_KEY; printf '\n'
```

用企业身份时，设置 `CODEX_POLISH_AGY_AUTH=agent-platform`，并由管理员给运行环境配好 Application Default Credentials（ADC）、Google Cloud 项目和区域。这三种方式都通过同一个官方 `agy acp` 进程提交改写。[Antigravity ACP 认证](https://antigravity.google/docs/ide/extensions/acp#authentication)

更换身份后，新开项目聊天，说 **“选择改写模型”**。成功列出模型表示当前账号已连通，这一步只读取模型列表。
