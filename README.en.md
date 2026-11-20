# Codex Polish

**English** | **[简体中文](README.md)**

Codex Polish uses Gemini through Antigravity’s `agy acp` to polish Codex’s final replies. Projects default to automatic mode. Once you trust the plugin hook and start a new chat, ordinary questions trigger polishing. If the rewrite fails a check, you get the original.

In one test, Codex had to report that the export button was fixed and had passed local tests. A production check was still pending. Both texts below are translated from that test.

- **Draft** “Regarding progress with the export button fix, let me explain the actual situation. The export button has now been fixed, local tests have passed, and production verification has not yet been done.”
- **After** “The export button is fixed and passed local tests. It still needs to be checked in production.”

## Quick Start

You need macOS or Linux, Node.js 22.16+, and a [Codex CLI](https://developers.openai.com/codex/cli/) with plugin support. In T3 Code, select Codex and install the plugin on the machine running that backend.

1. **Install the plugin.** Use this command to install the beta from npm.

   ```sh
   npx @kyun.si/codex-polish@beta setup
   ```

   You can also clone the repository and run the installer locally.

   ```sh
   git clone https://github.com/mreasonyang/codex-polish.git
   cd codex-polish
   node scripts/install.mjs setup
   ```

   On macOS, you can also download and extract the GitHub repository, then double-click [Install Codex Polish.command](Install%20Codex%20Polish.command) in its root folder.

2. **Connect Gemini.** Setup reuses the Antigravity CLI (`agy` 1.2.1+) if it finds it. If it offers to install the official CLI, press Enter to accept. For unattended installation, add `--install-agy` to either `setup` command above. Your existing Antigravity sign-in works over ACP. If asked to sign in, run `agy` on the machine that runs Codex.
3. **Trust the hook and try an ordinary question.** Automatic polishing sends eligible questions and drafts to Google, with up to two completed exchanges by default. In Codex **Settings → Hooks** (`/hooks` in the CLI), trust the plugin’s `UserPromptSubmit` hook. Start a new chat in your project and ask **“Explain what DNS does in one sentence.”** To switch the project to manual mode, say **“Only polish when I ask.”**

## Project Settings

Settings are saved in each project’s `.codex/` directory and carry over to new chats in that project. Say **"Show Codex Polish settings"** to inspect them.

| Setting | Default | Natural prompt |
| --- | --- | --- |
| Mode | Automatic (requires a trusted hook) | "Only polish when I ask", "Turn off Codex Polish", or "Polish automatically in this project" |
| Gemini model | Gemini 4 Hydrogen | "Choose a rewrite model" (lists runtime account options, which can differ) or "Restore the default rewrite model" |
| History turns | Up to 2 earlier question-and-answer pairs | "Include the last 5 exchanges" or "Don't include any conversation history when polishing replies" (`0` to `10`, max 16 KiB) |
| OpenAI checks | On when `OPENAI_API_KEY` is set | "Use Gemini only" or "Use OpenAI checks when a key is available" |
| Language | Auto (`zh` or `en`) | "Use English for plugin settings", "Use Chinese for plugin settings", or "Detect the plugin language automatically" |

Without `OPENAI_API_KEY`, eligible drafts go straight to ACP. With OpenAI checks on, OpenAI runs a style check first and a meaning check after the rewrite. An invalid `OPENAI_API_KEY` blocks rewrites when checks are on until you fix or clear the key or set the project to Gemini only. Rewrites always stay in the draft's language.

## Privacy and Hooks

In automatic mode, the trusted `UserPromptSubmit` hook reminds Codex to polish the final reply to an ordinary question. Before trusting the hook, you can still say **“Polish this reply”** to share just the current question and draft. In manual mode, only explicit requests trigger polishing. Including history still requires the trusted hook. Turning polishing off skips even explicit requests.

For a rewrite, Google receives your current question and reply draft. The plugin replaces fixed details such as commands, paths, links, and numbers with placeholders. Ordinary prose is still readable. If history is enabled and available, Google also receives earlier exchanges as written, including code. The plugin skips turns with detected secrets, attachments, or incomplete output. OpenAI checks use only the protected current question and draft, plus the proposed rewrite for the final check. The plugin writes no draft logs of its own. Codex, your providers, and any global `agy` hooks have their own settings.

## If a Reply Stays Unchanged

Exact-output requests, already clear drafts when OpenAI checks are active, missing models, or failed checks keep the original draft. Say **"Check Codex Polish setup"** to inspect `agy` and cooldowns, **"Choose a rewrite model"** to verify model access, or **"Why wasn't my last reply polished?"** for the turn's reason.

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
