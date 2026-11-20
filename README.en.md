# Codex Polish

**English** | **[简体中文](README.md)**

Codex Polish uses Gemini through Antigravity’s `agy acp` to polish Codex’s final replies. The chat shows Gemini’s rewrite first. In clients that support collapsible sections, select “View original GPT draft” below it to read the full draft. Projects default to automatic mode. Once you trust the plugin hook and start a new chat, ordinary questions trigger polishing.

In one test, Codex had to report that the export button was fixed and had passed local tests. A production check was still pending. Both texts below are translated from that test.

**Polished by Gemini**

The export button is fixed and passed local tests. It still needs to be checked in production.

<details>
<summary>View original GPT draft</summary>

Regarding progress with the export button fix, let me explain the actual situation. The export button has now been fixed, local tests have passed, and production verification has not yet been done.

</details>

To see just the rewrite for one reply, say **“Only show the polished text.”** If you ask for plain JSON, a command, or a verbatim quotation, the reply keeps that exact format.

## Quick Start

You need macOS or Linux, Node.js 22.16+, and a [Codex CLI](https://developers.openai.com/codex/cli/) with plugin support. In T3 Code, select Codex and install the plugin on the machine running that backend.

1. **Install the plugin from your project directory.** Use this command to install the beta from npm.

   ```sh
   npx @kyun.si/codex-polish@beta setup
   ```

   You can also clone the repository into your home directory and run its installer from your current project.

   ```sh
   git clone https://github.com/mreasonyang/codex-polish.git ~/codex-polish
   node ~/codex-polish/scripts/install.mjs setup
   ```

   On first interactive setup, use **↑ / ↓** to select a rewrite mode and press **Enter** to confirm. **Normal** is selected by default and can ask OpenAI whether a draft needs editing. **Turbo** skips OpenAI and sends eligible drafts directly to Gemini for rewriting. You can set when polishing runs separately. Setup reuses the project's saved choice. Unattended setup uses Normal for projects without one.

   On macOS, you can also download and extract the GitHub repository, then double-click [Install Codex Polish.command](Install%20Codex%20Polish.command). At the project directory prompt, enter the path or press Enter to choose later. Say **“Set up Codex Polish”** in a project chat to select **Normal** or **Turbo** on first setup. In a text-only chat, reply with the mode name.

2. **Connect Gemini.** Setup reuses the Antigravity CLI (`agy` 1.2.1+) if it finds it. If it offers to install the official CLI, press Enter to accept. For unattended installation, add `--install-agy` to either `setup` command above. Your existing Antigravity sign-in works over ACP. If asked to sign in, run `agy` on the machine that runs Codex.
3. **Trust the hook and try an ordinary question.** If the OpenAI style check is enabled, OpenAI receives only your current question, draft, and any custom polishing prompt. When Gemini rewrites, Google receives those items plus up to two earlier completed exchanges by default. In Codex **Settings → Hooks** (`/hooks` in the CLI), trust the plugin’s `UserPromptSubmit` hook. Start a new chat in your project and ask **“Explain what DNS does in one sentence.”** To switch the project to manual mode, say **“Only polish when I ask.”**

## Project Settings

Settings are saved in each project’s `.codex/` directory and carry over to new chats in that project. Say **"Show Codex Polish settings"** to inspect them.

| Setting | Default | Natural prompt |
| --- | --- | --- |
| When to polish | Automatic (requires a trusted hook) | "Only polish when I ask", "Turn off Codex Polish", or "Polish automatically in this project" |
| Rewrite mode | Normal | “Switch to turbo mode” or “Switch back to normal mode” |
| Gemini model | Gemini 4 Hydrogen | "Choose a rewrite model" (lists runtime account options, which can differ) or "Restore the default rewrite model" |
| Polishing prompt | Built-in prompt for the current mode | “Show the polishing prompt”, “Set the polishing prompt”, or “Restore the default polishing prompt” |
| History for Gemini rewrites | Up to 2 earlier question-and-answer pairs | “Include the last 5 exchanges” or “Don't include any conversation history when polishing replies”. Choose 0 to 10 exchanges, up to 16 KiB of history text. Say “Leave out history this time” for one rewrite. |
| OpenAI style check before rewriting | On in normal mode when `OPENAI_API_KEY` is set | "Use Gemini only" or "Use the OpenAI style check when a key is available" |
| Language | Auto (`zh` or `en`) | "Use English for plugin settings", "Use Chinese for plugin settings", or "Detect the plugin language automatically" |

For example, say **“Set this project's polishing prompt to: Lead with the conclusion. Use short sentences. Keep the technical terms.”** On the next rewrite, those three sentences are the only editing instructions the plugin gives Gemini, exactly as you wrote them. This applies in both Normal and Turbo. Restoring the default brings back the built-in prompt for the current mode. You can also edit `.codex/codex-polish.prompt.md` directly (up to 16 KiB of UTF-8 text). Viewing, saving, and restoring the prompt all work locally without calling a polishing model. A request like “Keep this reply short” applies only to that reply.

**Normal mode** is the default. With the style check enabled, OpenAI decides whether the draft needs editing. Eligible drafts go straight to Gemini when the check is off or there is no key. An invalid key blocks rewriting when the check is enabled.

**Turbo mode** sends every eligible draft directly to Gemini through `agy acp`, even with an OpenAI key. Turbo’s built-in prompt asks Gemini to actively rewrite the draft. Your automatic, manual, or off setting still controls when polishing runs. Say **“Switch back to normal mode”** to resume your saved style-check setting.

## Privacy and Hooks

In automatic mode, the trusted `UserPromptSubmit` hook reminds Codex to polish the final reply to an ordinary question. Before trusting the hook, you can still say **“Polish this reply”** to polish the current draft without sharing earlier exchanges. In manual mode, only explicit requests trigger polishing. Including history still requires the trusted hook. Turning polishing off skips even explicit requests.

The plugin checks the current question and draft locally before sending them. It skips polishing if it detects a possible credential or you request exact output such as JSON only or a single command.

The plugin sends your current question and draft as written, including code, commands, paths, links, and numbers.

- **OpenAI** receives only the current question, draft, and any custom polishing prompt when the optional style check runs.
- **Google** receives the current question, draft, any custom polishing prompt, and eligible history when Gemini rewrites. Each earlier exchange contains a user question and its final reply, as written. The plugin skips incomplete exchanges and those with detected credentials or attachments.

The current question and draft may each contain up to 128 KiB of UTF-8 text. The plugin limits each step’s material to 256 KiB of compact UTF-8 JSON, including any custom prompt, field names, and JSON escaping. History counts toward Gemini’s limit, so the plugin drops the oldest whole exchanges first. If the question, draft, and any custom prompt alone exceed the limit, it keeps the original draft.

The plugin writes no draft logs of its own. Codex, your providers, and any global `agy` hooks have their own settings.

## If a Reply Stays Unchanged

If Gemini returns the same text, the reply says so and shows it once. In turbo mode the plugin keeps the original and makes no second request. If polishing was skipped before sending the draft, the request failed to finish, or the rewrite failed a check, the reply says what happened and shows the original GPT draft. Ask **“Why wasn’t my last reply polished?”** for that turn’s reason, or **“Check Codex Polish setup”** to troubleshoot the connection.

## Check, Update, or Uninstall

| Action | From the npm beta | From the source directory |
| --- | --- | --- |
| Check the current project | `npx @kyun.si/codex-polish@beta doctor` | `node scripts/install.mjs doctor` |
| Update | `npx @kyun.si/codex-polish@beta update` | Get the latest source, then run `node scripts/install.mjs update` |
| Uninstall | `npx @kyun.si/codex-polish@beta uninstall` | `node scripts/install.mjs uninstall` |

Updates preserve saved project modes and the plugin’s enabled state. Projects with no saved mode also pick up the automatic default. Start a new chat after upgrading, and review the updated hook if Codex prompts you. Uninstalling keeps your `.codex` project settings and shared `agy` binary.

## References and License

- [Credentials and Sign-In Guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md)
- [Technical Reference](docs/technical.en.md) · [How to Evaluate Rewrites](evaluation/README.en.md)
- [Contributing](CONTRIBUTING.en.md)
- [Security Policy](SECURITY.en.md)
- [Changelog](CHANGELOG.md)

Codex Polish is licensed under the [Apache License 2.0](LICENSE).
