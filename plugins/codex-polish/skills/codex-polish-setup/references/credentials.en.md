# Connect Codex Polish to Gemini

[简体中文](credentials.md)

Run interactive `setup` from any folder on the machine running Codex, or double-click the macOS Finder launcher. On first setup, use **↑ / ↓** and **Enter** to choose the automatic rewrite mode. With the built-in prompt, **Normal** can keep a clear draft and supports the optional OpenAI check. **Turbo** skips the check and asks Gemini to rewrite the draft.

Once `agy` is available, you can keep **Gemini 4 Hydrogen** or choose from your Antigravity account. Only the live model lookup opens a temporary `codex exec` session and calls `agy acp`. Your choices apply across projects in this Codex profile. To override one in a single project, ask to change its mode or model in that project’s chat. The installer saves only the mode and model ID. API keys, when used, come from the environment that runs Codex.

## Use your Antigravity sign-in

1. Install the plugin on the machine that runs Codex, using the same system account. It looks for `agy` on the Codex process’s PATH and then in Google’s default directory (`%LOCALAPPDATA%\agy\bin` on Windows, `~/.local/bin` on macOS and Linux). On a first install from Finder or an interactive terminal, you can accept the offer to install Google’s official CLI or skip it. For an unattended install or to add the CLI later, run `npx @kyun.si/codex-polish@beta setup --install-agy`. From a source checkout, use `node scripts/install.mjs setup --install-agy`. You can also install it directly from Google. [Antigravity installation guide](https://antigravity.google/docs/getting-started/?tab=cli)
2. The plugin uses your existing Antigravity sign-in. If Antigravity requests authentication, run `agy` in your terminal and sign in. If your shell can’t find the installed CLI, run `& "$env:LOCALAPPDATA\agy\bin\agy.exe"` in Windows PowerShell or `~/.local/bin/agy` on macOS or Linux.
3. Projects default to automatic polishing. When you ask to rewrite a whole answer, Google receives that draft, the question it answers and any directions for this rewrite. The plugin sends the text as written, including any code, commands, paths or credentials in it. If the active Codex profile has a custom polishing prompt, Google also receives it. By default it also includes up to two exchanges from before the original answer. When you select a passage, the question and chat history stay local. Say “Only send this passage to Gemini” to send just the passage with the built-in Turbo prompt. In Codex **Settings → Hooks** (`/hooks` in the CLI), trust the plugin’s `UserPromptSubmit` hook. Start a fresh project chat and ask **“Explain what DNS does in one sentence.”**

Say **“Only polish when I ask”** for manual mode or **“Turn off Codex Polish”** to disable polishing. “Polish this reply” uses Turbo and sends the draft directly to Gemini. Before you trust the hook, the request omits earlier exchanges. The default setup works without API keys. If Codex runs on a remote machine, follow these steps there.

Say **“Check Codex Polish setup”** to inspect the local configuration and **“Test the ACP connection”** to check the live connection. **“Choose a rewrite model”** lists the models your account can use. Neither live check sends a draft.

If `agy` works in your terminal but the chat reports a failure at `session/new`, try **“Choose a rewrite model”** in that same chat. If the host reports blocked network access or a denied write to the Antigravity sign-in file, check the permissions for that session. Trusting the hook enables the automatic trigger.

## Optional OpenAI style check

For automatic polishing in Normal mode, when `OPENAI_API_KEY` is set, the plugin by default asks OpenAI whether the draft needs editing before sending it to Gemini. OpenAI receives only the current question, draft, and any custom polishing prompt. Say **“Switch to turbo mode”** to send every draft directly to Gemini. Turbo skips OpenAI even with a key. Say **“Switch back to normal mode”** to resume the project’s saved style-check setting. The project’s history setting applies only to Gemini rewrites. The OpenAI project linked to the key covers the Decisions API usage for `gpt-6-luna`. [Decisions API](https://developers.openai.com/api/docs/guides/decisions)

1. Open your OpenAI project’s **API keys** page. Choose **Create new secret key**, name it something like `codex-polish`, and save it in a password manager. For restricted keys, allow `POST /v1/decisions` and make sure the project can use `gpt-6-luna`. [Create a project key](https://platform.openai.com/api-keys)
2. Pass the key as `OPENAI_API_KEY` to the process running Codex. In a bash or zsh terminal, run these commands. Paste the key when prompted, then press Return. The terminal hides it while you type.

   ```sh
   printf 'OpenAI API key (hidden): '
   IFS= read -r -s OPENAI_API_KEY </dev/tty
   printf '\n'
   export OPENAI_API_KEY
   ```

   In Windows PowerShell, use this hidden prompt instead.

   ```powershell
   $env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'OpenAI API key' -AsSecureString)).Password
   ```

3. Start `codex` from that same terminal. In the project, say **“Use the OpenAI style check when a key is available.”** Then say **“Check Codex Polish setup.”** The local check confirms the setting and can catch a missing or malformed key. API access and quota are checked on a real request. [OpenAI billing](https://platform.openai.com/account/billing/overview)

To turn the check off for one project, say **“Use Gemini only.”** Other projects can keep using the key. Keep the key out of chat and project files.

### Desktop apps and remote Codex sessions

A terminal variable only applies to processes started from that terminal. If a desktop app launched from the Dock can’t see the key, finish active work and relaunch its executable from that terminal, or use the service’s normal environment settings. For a separate daemon or remote executor, set the key where that process starts and restart it. Then open a fresh chat and say **“Check Codex Polish setup”** there. [Codex environment configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)

## Other Antigravity sign-in methods

Only use one of these if you want a specific Google identity. Each uses the same official `agy acp` connection for rewriting.

| Identity | How to set up the environment that launches Codex |
| --- | --- |
| Existing sign-in (default) | Leave `CODEX_POLISH_AGY_AUTH` unset, or set it to `existing-session`. Open `agy` if the account needs to sign in again. |
| Google AI Studio API key | Set `CODEX_POLISH_AGY_AUTH=gemini-api-key` (`$env:CODEX_POLISH_AGY_AUTH = 'gemini-api-key'` in Windows PowerShell) and pass `GEMINI_API_KEY` through a password manager or a hidden terminal prompt as above (`$env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Gemini API key' -AsSecureString)).Password` in PowerShell). Create the key in Google AI Studio. [Google AI Studio keys](https://aistudio.google.com/apikey) |
| Managed enterprise identity | Set `CODEX_POLISH_AGY_AUTH=agent-platform`. Your admin can set up Google Application Default Credentials, the project, and the location for that runtime. [Google’s ACP authentication guide](https://antigravity.google/docs/ide/extensions/acp#authentication) |

After changing the runtime environment, start a fresh session and say **“Choose a rewrite model.”** A successful model lookup checks both the connection and access to that account’s models without sending a draft.
