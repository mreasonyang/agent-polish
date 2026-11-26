# Connect Codex Polish to Gemini

[简体中文](credentials.md)

Run `npx @kyun.si/codex-polish@beta setup` on the machine where you use Codex, or double-click the Codex launcher in macOS Finder. A fresh installation defaults to **Manual · polish only when asked**.

The default model is **Gemini 4 Hydrogen with Medium thinking**. Say “Set up Codex Polish” in a Codex chat to select Normal, Turbo, Manual or Off. You can also browse your Antigravity account’s models and choose a supported thinking level. All chats using the same Codex profile share these preferences.

## Use your Antigravity sign-in

1. Install the plugin on the machine that runs Codex, using the same system account. It looks for `agy` on the Codex process’s PATH and then in Google’s default directory (`%LOCALAPPDATA%\agy\bin` on Windows, `~/.local/bin` on macOS and Linux). On a first install from Finder or an interactive terminal, you can accept the offer to install Google’s official CLI or skip it. For an unattended install or to add the CLI later, run `npx @kyun.si/codex-polish@beta setup --install-agy`. From a source checkout, use `node scripts/install.mjs setup --install-agy`. You can also install it directly from Google. [Antigravity installation guide](https://antigravity.google/docs/getting-started/?tab=cli)
2. The plugin uses your existing Antigravity sign-in. If Antigravity requests authentication, run `agy` in your terminal and sign in. If your shell can’t find the installed CLI, run `& "$env:LOCALAPPDATA\agy\bin\agy.exe"` in Windows PowerShell or `~/.local/bin/agy` on macOS or Linux.
3. To try Manual, ask **“Explain what DNS does in one sentence, then polish your reply.”** When you ask to rewrite a whole answer, Google receives that draft, the question it answers and any directions for this rewrite. The plugin sends the text as written, including any code, commands, paths or credentials in it. If the active Codex profile has a custom polishing prompt, Google also receives it. By default it includes up to two exchanges from before the original answer when the `UserPromptSubmit` hook is trusted. To include those exchanges or use automatic polishing, trust the hook in Codex **Settings → Hooks** (`/hooks` in the CLI) and start a new chat. When you select a passage, the question and chat history stay local. Say “Only send this passage to Gemini” to send just the passage with the built-in Turbo prompt.

Say **“Only polish when I ask”** for Manual, **“Turn off polishing”** to disable automatic and requested rewrites, or **“Turn on automatic polishing”** to enable automatic rewrites. “Polish this reply” uses Turbo and sends the draft directly to Gemini. The default setup works without API keys. If Codex runs on a remote machine, follow these steps there.

Say **“Check Codex Polish setup”** to inspect the local configuration and **“Test the ACP connection”** to check the live connection. **“Choose a rewrite model”** shows your account’s models and the thinking levels available for the model you pick. Neither live check sends a draft.

If `agy` works in your terminal but the chat reports a failure at `session/new`, try **“Choose a rewrite model”** in that same chat. If the host reports blocked network access or a denied write to the Antigravity sign-in file, check the permissions for that session. In automatic mode, the trusted `UserPromptSubmit` hook triggers polishing on ordinary questions. It also records the session location so rewrites can include earlier exchanges according to your settings. Antigravity sign-in and network access have their own permissions.

## Optional OpenAI Decisions API

Normal mode uses Gemini directly by default. Use the command below to enable this check. If enabled, OpenAI receives the current question, draft and any custom polishing prompt to decide whether Gemini should rewrite the draft. The OpenAI project that owns the key pays for the API usage. History goes only to Gemini. Turbo and explicit rewrites skip OpenAI.

1. Create an OpenAI API key in the project you want to use. Restricted keys need access to `POST /v1/decisions` and the project needs access to `gpt-6-luna`. [OpenAI API keys](https://platform.openai.com/api-keys) · [API billing](https://platform.openai.com/account/billing/overview)
2. Run `npx @kyun.si/codex-polish@beta openai` on the machine and Codex profile that run the plugin. In Windows PowerShell, run `npx.cmd @kyun.si/codex-polish@beta openai`. From a source checkout, run `node scripts/install.mjs openai`. Paste the key only at the terminal’s hidden prompt. The plugin stores it in `$CODEX_HOME/codex-polish/credentials/openai.key`.
3. Open the same menu to replace or remove the saved key. Uninstall also deletes the local copy. To turn off the check for this profile, say **“Use only Gemini for rewrites.”**

The plugin ignores the `OPENAI_API_KEY` environment variable.

## Other Antigravity sign-in methods

Only use one of these if you want a specific Google identity. Each uses the same official `agy acp` connection for rewriting.

| Identity | How to set up the environment that launches Codex |
| --- | --- |
| Existing sign-in (default) | Leave `CODEX_POLISH_AGY_AUTH` unset, or set it to `existing-session`. Open `agy` if the account needs to sign in again. |
| Google AI Studio API key | Set `CODEX_POLISH_AGY_AUTH=gemini-api-key` (`$env:CODEX_POLISH_AGY_AUTH = 'gemini-api-key'` in Windows PowerShell) and pass `GEMINI_API_KEY` through a password manager or a hidden terminal prompt (`$env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Gemini API key' -AsSecureString)).Password` in PowerShell). Create the key in Google AI Studio. [Google AI Studio keys](https://aistudio.google.com/apikey) |
| Managed enterprise identity | Set `CODEX_POLISH_AGY_AUTH=agent-platform`. Your admin can set up Google Application Default Credentials, the project, and the location for that runtime. [Google’s ACP authentication guide](https://antigravity.google/docs/ide/extensions/acp#authentication) |

After changing the runtime environment, start a fresh session and say **“Choose a rewrite model.”** A successful model lookup checks both the connection and access to that account’s models without sending a draft.
