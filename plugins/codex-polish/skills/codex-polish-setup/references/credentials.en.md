# Connect Codex Polish to Gemini

[简体中文](credentials.md)

## Use your Antigravity sign-in

1. Install the plugin on the machine that runs Codex, using the same system account. It looks for `agy` on the Codex process’s PATH and then at `~/.local/bin/agy`. On a first install from Finder or an interactive terminal, you can accept the offer to install Google’s official CLI or skip it. For an unattended install or to add the CLI later, run `node scripts/install.mjs setup --install-agy` from the extracted package. You can also install it directly from Google. [Antigravity installation guide](https://antigravity.google/docs/getting-started/?tab=cli)
2. The plugin uses your existing Antigravity sign-in. If Antigravity requests authentication, run `agy` in your terminal and sign in. If your shell can’t find the installed CLI, open `~/.local/bin/agy` directly.
3. Start a fresh Codex chat in your project and say **“Check Codex Polish setup.”** To see which Gemini models the account can use, say **“Choose a rewrite model.”** To try polishing a reply, ask **“Explain what DNS does in one sentence, then polish your reply.”**

The default setup works without API keys. If Codex runs on a remote machine, follow these steps there.

## Optional OpenAI checks

Turn these on if you want OpenAI to check whether a draft needs editing and whether the edit keeps its meaning. The plugin uses the Decisions API with `gpt-6-luna`. The OpenAI project linked to the key covers the API usage. [Decisions API](https://developers.openai.com/api/docs/guides/decisions)

1. Open your OpenAI project’s **API keys** page. Choose **Create new secret key**, name it something like `codex-polish`, and save it in a password manager. For restricted keys, allow `POST /v1/decisions` and make sure the project can use `gpt-6-luna`. [Create a project key](https://platform.openai.com/api-keys)
2. Pass the key as `OPENAI_API_KEY` to the process running Codex. In a bash or zsh terminal, run these commands. Paste the key when prompted, then press Return. The terminal hides it while you type.

   ```sh
   printf 'OpenAI API key (hidden): '
   IFS= read -r -s OPENAI_API_KEY </dev/tty
   printf '\n'
   export OPENAI_API_KEY
   ```

3. Start `codex` from that same terminal. In the project, say **“Use OpenAI checks when a key is available.”** Then say **“Check Codex Polish setup.”** The local check confirms the setting and can catch a missing or malformed key. API access and quota are checked on a real request. [OpenAI billing](https://platform.openai.com/account/billing/overview)

To turn the checks off for one project, say **“Use Gemini only.”** Other projects can keep using the key. Keep the key out of chat and project files.

### Desktop apps and remote Codex sessions

A terminal variable only applies to processes started from that terminal. If a desktop app launched from the Dock can’t see the key, finish active work and relaunch its executable from that terminal, or use the service’s normal environment settings. For a separate daemon or remote executor, set the key where that process starts and restart it. Then open a fresh chat and say **“Check Codex Polish setup”** there. [Codex environment configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)

## Other Antigravity sign-in methods

Only use one of these if you want a specific Google identity. Each uses the same official `agy acp` connection for rewriting.

| Identity | How to set up the environment that launches Codex |
| --- | --- |
| Existing sign-in (default) | Leave `CODEX_POLISH_AGY_AUTH` unset, or set it to `existing-session`. Open `agy` if the account needs to sign in again. |
| Google AI Studio API key | Set `CODEX_POLISH_AGY_AUTH=gemini-api-key` and pass `GEMINI_API_KEY` through a password manager or a hidden terminal prompt as above. Create the key in Google AI Studio. [Google AI Studio keys](https://aistudio.google.com/apikey) |
| Managed enterprise identity | Set `CODEX_POLISH_AGY_AUTH=agent-platform`. Your admin can set up Google Application Default Credentials, the project, and the location for that runtime. [Google’s ACP authentication guide](https://antigravity.google/docs/ide/extensions/acp#authentication) |

After changing the runtime environment, start a fresh session and say **“Choose a rewrite model.”** A successful model lookup checks both the connection and access to that account’s models without sending a draft.
