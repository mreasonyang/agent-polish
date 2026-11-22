# 第一次配置回复润色

[English](credentials.en.md)

在运行 Codex 的机器上，从任意目录交互运行 `setup`，或在 macOS 的 Finder 里双击安装脚本。第一屏用 **↑ / ↓** 选择 **Normal**（自动按需改写）、**Turbo**（自动每次改写）、**仅手动**（只在我要求时润色）或**关闭润色**，按 **回车** 确认。使用内置提示词时，**Normal** 可以保留清晰原稿，也支持可选的 OpenAI Decisions API；**Turbo** 跳过这项检查，请 Gemini 改写草稿。若选**关闭润色**，会为当前 Codex 配置保存全局关闭并直接结束，不再引导配置模型、依赖、密钥或 hook 信任，已保存的模型、思考等级、提示词和密钥都会保留。

开启润色（Normal、Turbo 或仅手动）且 `agy` 可用后，继续选择 Gemini 模型和思考等级。默认是 **Gemini 4 Hydrogen · 中等（Medium）**。也可以查看 Antigravity 账号的其他模型，选择该模型支持的等级。同一份 Codex 配置下的所有聊天和目录共用这套设置。可以在聊天里说“切换到 Turbo 模式”或“把 Gemini 的思考等级调到高”，保存后立即生效。再运行一次 `setup` 就能在终端查看当前选项，按**回车**保留，或从同一菜单改选 Normal、Turbo、仅手动重新开启。

## 准备 Antigravity

在实际运行 Codex 的机器上，用同一个系统账户安装插件。插件先在 Codex 的 PATH 里找 `agy`，再查 Google 默认目录（Windows 的 `%LOCALAPPDATA%\agy\bin` 或 macOS、Linux 的 `~/.local/bin`）。首次双击安装或在终端交互运行 `setup` 时，如果缺少 `agy`，你可以同意安装 Google 官方 CLI，也可以跳过。无人值守安装或之后想补装时，运行 `npx @kyun.si/codex-polish setup --install-agy`。用源码安装时，在仓库里运行 `node scripts/install.mjs setup --install-agy`。也可以按 Google 的指南单独安装。[官方 CLI 安装指南](https://antigravity.google/docs/getting-started/?tab=cli)

只有 Antigravity 提示需要登录时，才需要在自己的终端运行 `agy` 登录。如果终端找不到命令，在 Windows PowerShell 中运行 `& "$env:LOCALAPPDATA\agy\bin\agy.exe"`，macOS 或 Linux 上运行 `~/.local/bin/agy`。登录后回 Codex 再试一次改写。[ACP 认证说明](https://antigravity.google/docs/ide/extensions/acp#authentication)

默认启用自动润色。改写整条答复时，Google 收到的是那条答复、它所回答的问题，以及你这次提出的改写要求。改写材料按原文发送，包括其中的代码、命令、路径或密钥。在当前 Codex 配置中保存过自定义润色提示词时，这份提示词也会发给 Google。默认还会附上原答复之前最多 2 轮问答。润色选段时省略原问题和历史。要求“只把这段原文发给 Gemini”时，只发送选段，使用内置 Turbo 提示词。在 Codex 的 **设置 → Hooks**（CLI 输入 `/hooks`）里信任插件的 `UserPromptSubmit`，再开一个聊天，问 **“用一句话解释 DNS。”** 如果想自己决定何时润色，可以说 **“只在我要求时润色”**。说“返回结果 polish”就会用 Turbo，直接把草稿交给 Gemini。信任 hook 前，这次请求不附带以前的问答。想停用就说 **“关闭润色”**，重新开启就说 **“开启自动润色”**。

## 选配 OpenAI Decisions API

首次交互安装并选用普通模式时，安装器会询问一次是否启用这项检查。直接按**回车**即可跳过，只用 Gemini。启用后，OpenAI 只收到本轮问题、草稿和已设置的自定义润色提示词，据此判断是否需要 Gemini 改写草稿。API 用量计入密钥所属的 OpenAI 项目。历史问答只发给 Gemini。Turbo 和点名润色始终跳过 OpenAI。

1. 在承担费用的 OpenAI 项目中创建 API 密钥。若使用受限密钥，请允许调用 `POST /v1/decisions`，并确认项目可以使用 `gpt-6-luna`。[OpenAI API 密钥](https://platform.openai.com/api-keys) · [API 账单](https://platform.openai.com/account/billing/overview)
2. 在安装时选择配置 OpenAI Decisions API，或在运行插件的机器上使用同一份 Codex 配置，运行 `npx @kyun.si/codex-polish openai`。Windows PowerShell 中运行 `npx.cmd @kyun.si/codex-polish openai`。用源码安装时，在仓库根目录运行 `node scripts/install.mjs openai`。只在终端提示隐藏输入时粘贴密钥。插件将其保存在 `$CODEX_HOME/codex-polish/credentials/openai.key`。
3. 以后可在同一菜单里更换或移除密钥，卸载也会删除本地副本。要关闭这份 Codex 配置下的检查，可以说**“以后只用 Gemini 改写”**。

插件会忽略 `OPENAI_API_KEY` 环境变量。

## 确认配置

说 **“检查回复润色环境”**，可以看到自动润色时是直接通过 ACP 改写还是启用了 OpenAI Decisions API，以及当前用的 Google 认证方式和 `agy` 是否可用。想单独测试 ACP 进程能不能连通，可以说 **“检测 ACP 连接”**。说 **“选择改写模型”** 可以查看当前账号的 Gemini 模型和所选模型的思考等级。配置的 OpenAI API 密钥能否调用该接口，以实际调用结果为准。

如果终端里的 `agy` 能用，聊天里却提示在 `session/new` 创建会话失败，可在同一聊天里试一次 **“选择改写模型”**。这一步不发草稿。如果宿主报告禁止联网或禁止写入 Antigravity 的登录文件，请检查这个会话的执行权限。在自动模式下，受信任的 `UserPromptSubmit` 会在普通提问时触发润色。它还会记录会话位置，让润色时能按设置带上之前的问答。Antigravity 登录和网络访问权限需要单独检查。

## 需要指定 Antigravity 身份时

用默认登录时不用设置 `CODEX_POLISH_AGY_AUTH`。如果之前手动指定过其他身份，可以在启动环境里删掉这个变量，或者把它设为 `existing-session`。要用 AI Studio 密钥认证，将 `CODEX_POLISH_AGY_AUTH` 设为 `gemini-api-key`，并配置 `GEMINI_API_KEY`。需要新密钥的话，去 Google AI Studio 点 **Create API key**，选好项目并创建，然后在自己的终端里隐藏输入密钥。[Google AI Studio](https://aistudio.google.com/apikey)

```sh
export CODEX_POLISH_AGY_AUTH=gemini-api-key
printf 'Gemini API key（隐藏输入）：'; IFS= read -r -s GEMINI_API_KEY </dev/tty && export GEMINI_API_KEY; printf '\n'
```

Windows PowerShell 用户在启动 Codex 的同一终端运行下面这两条命令，在隐藏提示处粘贴密钥：

```powershell
$env:CODEX_POLISH_AGY_AUTH = 'gemini-api-key'
$env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Gemini API key' -AsSecureString)).Password
```

用企业身份时，设置 `CODEX_POLISH_AGY_AUTH=agent-platform`，并由管理员给运行环境配好 Application Default Credentials（ADC）、Google Cloud 项目和区域。这三种方式都通过同一个官方 `agy acp` 进程提交改写。[Antigravity ACP 认证](https://antigravity.google/docs/ide/extensions/acp#authentication)

更换身份后，新开聊天，说 **“选择改写模型”**。成功列出模型表示当前账号已连通，这一步只读取模型列表。
