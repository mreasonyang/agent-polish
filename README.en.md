# Codex Polish

**English** | **[简体中文](README.md)**

Ask Codex to polish a reply and it sends the draft to Gemini through Antigravity’s `agy acp`. If the rewrite fails a check, you get the original. By default, it runs only when you ask.

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
3. **Try it.** Start a new project chat and ask **"Explain what DNS does in one sentence, then polish your reply."** Click **Setup** or say **"Set up Codex Polish"** to check your setup.

## Project Settings

Settings are saved in each project’s `.codex/` directory and carry over to new chats in that project. Say **"Show Codex Polish settings"** to inspect them.

| Setting | Default | Natural prompt |
| --- | --- | --- |
| Mode | Manual (when asked) | "Polish automatically in this project", "Only polish when I ask", or "Turn off Codex Polish" |
| Gemini model | Gemini 4 Hydrogen | "Choose a rewrite model" (lists runtime account options, which can differ) or "Restore the default rewrite model" |
| History turns | Up to 2 earlier question-and-answer pairs | "Include the last 5 exchanges" or "Don't include any conversation history when polishing replies" (`0` to `10`, max 16 KiB) |
| OpenAI checks | On when `OPENAI_API_KEY` is set | "Use Gemini only" or "Use OpenAI checks when a key is available" |
| Language | Auto (`zh` or `en`) | "Use English for plugin settings", "Use Chinese for plugin settings", or "Detect the plugin language automatically" |

Without `OPENAI_API_KEY`, eligible drafts go straight to ACP. With OpenAI checks on, OpenAI runs a style check first and a meaning check after the rewrite. An invalid `OPENAI_API_KEY` blocks rewrites when checks are on until you fix or clear the key or set the project to Gemini only. Rewrites always stay in the draft's language.

## Privacy and Hooks

Manual rewrites of the current question and draft need no hook. Automatic mode requires trusting `UserPromptSubmit` in Codex (`/hooks` or **Settings → Hooks**) and enabling automatic mode for the project. That hook is also required to include history, even in manual mode. Start a fresh chat after trusting the hook.

For a rewrite, Google receives your current question and reply draft. The plugin replaces fixed details such as commands, paths, links, and numbers with placeholders. Ordinary prose is still readable. If history is enabled and available, Google also receives earlier exchanges as written, including code. The plugin skips turns with detected secrets, attachments, or incomplete output. OpenAI checks use only the protected current question and draft, plus the proposed rewrite for the final check. The plugin writes no draft logs of its own. Codex, your providers, and any global `agy` hooks have their own settings.

## If a Reply Stays Unchanged

Exact-output requests, already clear drafts when OpenAI checks are active, missing models, or failed checks keep the original draft. Say **"Check Codex Polish setup"** to inspect `agy` and cooldowns, **"Choose a rewrite model"** to verify model access, or **"Why wasn't my last reply polished?"** for the turn's reason.

## Check, Update, or Uninstall

| Action | From the npm beta | From the source directory |
| --- | --- | --- |
| Check the current project | `npx @kyun.si/codex-polish@beta doctor` | `node scripts/install.mjs doctor` |
| Update | `npx @kyun.si/codex-polish@beta update` | Get the latest source, then run `node scripts/install.mjs update` |
| Uninstall | `npx @kyun.si/codex-polish@beta uninstall` | `node scripts/install.mjs uninstall` |

Updates preserve your project settings and the plugin’s enabled state. Start a new chat after upgrading, and review the updated hook if Codex prompts you. Uninstalling keeps your `.codex` project settings and shared `agy` binary.

## References and License

- [Credentials and Sign-In Guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md)
- [Technical Reference](docs/technical.en.md) · [How to Evaluate Rewrites](evaluation/README.en.md)
- [Contributing](CONTRIBUTING.en.md)
- [Security Policy](SECURITY.en.md)
- [Changelog](CHANGELOG.md)

Codex Polish is licensed under the [Apache License 2.0](LICENSE).
