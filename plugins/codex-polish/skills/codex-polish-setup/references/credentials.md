# 第一次配置回复润色

[English](credentials.en.md)

在项目里开一个新聊天，试一句 **“用一句话解释 DNS，再把你的回复润色一下。”** 插件默认沿用 Antigravity 登录，普通登录不用额外申请密钥。如果想让 OpenAI 判断什么时候值得润色、改稿有没有保留原意，再配置下面的可选服务。

## 准备 Antigravity

在实际运行 Codex 的机器上，用同一个系统账户安装插件。插件先在 Codex 的 PATH 里找 `agy`，再查 `~/.local/bin/agy`。首次双击安装或在终端交互运行 `setup` 时，如果缺少 `agy`，你可以同意安装 Google 官方 CLI，也可以跳过。无人值守安装或之后想补装时，在解压目录运行 `node scripts/install.mjs setup --install-agy`。也可以按 Google 的指南单独安装。[官方 CLI 安装指南](https://antigravity.google/docs/getting-started/?tab=cli)

只有 Antigravity 提示需要登录时，才需要在自己的终端运行 `agy` 登录。如果终端找不到命令，可以直接运行 `~/.local/bin/agy`。登录后回 Codex 再试一次改写。[ACP 认证说明](https://antigravity.google/docs/ide/extensions/acp#authentication)

## 选配 OpenAI Decisions

默认有 `OPENAI_API_KEY` 时启用 Decisions，没有时直接走 ACP。在项目里说 **“有 key 时用 Decisions”** 可以恢复这个默认设置。想保留现有 OpenAI key、只关掉本项目的两次判定，就说 **“这个项目只用 ACP”**。

要启用 Decisions，可以直接用自己已有的项目密钥，也可以按下面的步骤新建一个。

1. 登录 OpenAI API Platform，在项目选择器里选中要承担 API 用量的项目。已有合适的项目可以直接用。[打开 OpenAI API Keys](https://platform.openai.com/api-keys)
2. 在 **API Keys** 点 **+ Create new secret key**，名字可以填 `codex-polish`。创建后复制密钥，对应的变量名是 `OPENAI_API_KEY`。如果选受限权限，项目必须允许 `gpt-6-luna`，密钥必须允许调用 `POST /v1/decisions`。[项目与密钥权限](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform) · [Decisions API](https://developers.openai.com/api/docs/guides/decisions)
3. 如果提示额度不足，检查对应 API 组织的余额和付款设置。Decisions 用的是所选项目的 API 额度。[查看 API 账单](https://platform.openai.com/account/billing/overview)

### 让 Codex 读到 OpenAI 密钥

如果你**从终端启动 Codex**，在 macOS 或 Linux 上打开 zsh 或 bash，进入项目目录。复制下面第一条命令并回车，看到提示后再粘贴 OpenAI 密钥并回车。粘贴时屏幕不显示字符是正常的。这样输入，实际密钥不会出现在 shell 命令里。

```sh
printf 'OpenAI API key（隐藏输入）：'; IFS= read -r -s OPENAI_API_KEY </dev/tty && export OPENAI_API_KEY; printf '\n'
```

在**同一个终端**运行 `codex`，然后说 **“检查回复润色环境”**。这样设置只对当前 shell 和它启动的子进程有效。长期用的话，可以让密码管理器或进程管理器在每次启动执行器时注入同名变量。

如果你用的是 **Codex 桌面端或 T3 Code**，从 Dock 启动的应用和已经在跑的后台进程都可能读不到另一个终端里的 `export`。如果这个 macOS 桌面应用会自己启动本地后端，可以先结束正在进行的任务并退出应用，再从上面配好变量的终端直接运行它的可执行文件。装了 T3 Code Beta 的话，可以用下面这条命令启动它。

```sh
"/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)"
```

如果 T3 或桌面端连的是**独立 Codex daemon 或远程执行器**，要在对应后端的服务启动环境里配好变量、重启后端，再开一个新会话。在新会话里说“检查回复润色环境”，以这次结果为准。如果安装窗口能看到密钥，但会话里看不到，就检查后端启动环境和宿主的 shell 环境变量过滤规则。[Codex shell 环境配置](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)

## 确认配置

说 **“检查回复润色环境”**，可以看到当前是直接用 ACP 改写还是选用了 Decisions，以及当前用的 Google 认证方式和 `agy` 是否可用。想单独测试 ACP 进程能不能连通，可以说 **“检测 ACP 连接”**。说 **“选择改写模型”** 会列出当前账号实际可选的 Gemini 模型。配好的 key 能不能调用 Decisions，以实际调用结果为准。

## 需要指定 Antigravity 身份时

用默认登录时不用设置 `CODEX_POLISH_AGY_AUTH`。如果之前手动指定过其他身份，可以在启动环境里删掉这个变量，或者把它设为 `existing-session`。要用 AI Studio 密钥认证，将 `CODEX_POLISH_AGY_AUTH` 设为 `gemini-api-key`，并配置 `GEMINI_API_KEY`。需要新密钥的话，去 Google AI Studio 点 **Create API key**，选好项目并创建，然后在自己的终端里隐藏输入密钥。[Google AI Studio](https://aistudio.google.com/apikey)

```sh
export CODEX_POLISH_AGY_AUTH=gemini-api-key
printf 'Gemini API key（隐藏输入）：'; IFS= read -r -s GEMINI_API_KEY </dev/tty && export GEMINI_API_KEY; printf '\n'
```

用企业身份时，设置 `CODEX_POLISH_AGY_AUTH=agent-platform`，并由管理员给运行环境配好 Application Default Credentials（ADC）、Google Cloud 项目和区域。这三种方式都通过同一个官方 `agy acp` 进程提交改写。[Antigravity ACP 认证](https://antigravity.google/docs/ide/extensions/acp#authentication)
