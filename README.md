# Agent Polish

**English** | [简体中文](docs/README.zh-CN.md)

Agent Polish provides two plugins. Install **Codex Polish** to have Gemini edit replies in Codex, or **Agy Polish** to have Codex edit replies in Antigravity (`agy`). The edited text appears in the chat where you asked the question. [Quick start](#quick-start)

## Quick start

Install on the machine where you chat. Both plugins use **Node.js 22.16+**, the [Codex CLI](https://developers.openai.com/codex/cli/) and the [Antigravity CLI](https://antigravity.google/docs/cli). Each npm command installs the plugin for one host. In Windows PowerShell, use `npx.cmd` in place of `npx`.

| Where you chat | Install from the beta channel | Editor |
| --- | --- | --- |
| Codex | `npx @kyun.si/codex-polish@beta setup` | Gemini |
| Antigravity | `npx @kyun.si/agy-polish@beta setup` | Codex |

From a source checkout, run `node scripts/install.mjs setup` for Codex or `node scripts/agy-cli.mjs setup` for Antigravity. Both installers offer Normal, Turbo, Manual, and Off. With polishing on, Codex users can choose a Gemini model and thinking level, and Antigravity users can choose a Codex model and reasoning effort. Run both installers if you use both hosts. Each plugin uses its existing settings, including settings saved by the combined `0.0.4-beta.1` installer.

### Edit replies in Antigravity with Codex

Normal sends the current question and draft to Codex and lets it keep a clear draft. Turbo asks Codex to rewrite every reply. Manual runs when you ask. In setup, you can keep the Codex default or choose a model from your configured provider and a reasoning effort the model supports. If you use a ChatGPT account and it needs a sign-in, run `codex login`. Antigravity needs a version of `agy` with native plugin support.

Start a new Antigravity chat. If prompted, allow the `polish_reply` tool from `agy-polish`. Try **“/polish Rewrite the previous reply in two sentences.”** If the editor fails, the chat keeps the original draft. Say **“Set up reply polishing”** to select another model or reasoning effort, switch to Turbo, or turn editing off.

### Edit replies in Codex with Gemini

A fresh installation defaults to **Gemini 4 Hydrogen** with **Medium** thinking, through your Antigravity sign-in. Setup can install `agy` if it is missing. This direction requires a Codex CLI with plugin support and `agy` 1.2.1 or newer. In T3 Code, select the Codex backend.

For automatic edits, trust `UserPromptSubmit` in Codex **Settings → Hooks** (`/hooks` in the CLI), then start a new chat. For a manual edit, ask **“Polish the last reply.”** To change the mode, model, thinking level or history in this Codex profile, say **“Set up Codex Polish.”**

### Example in Codex

In Codex, you can expand the original underneath the rewrite in clients that support folding. Here’s an example translated from a Chinese test run.

The export button is fixed and passed local tests. It still needs to be checked in production.

<details>
<summary>Rewritten by Gemini · View original GPT draft</summary>

Regarding progress with the export button fix, let me explain the actual situation. The export button has now been fixed, local tests have passed, and production verification has not yet been done.

</details>

During automatic polishing, you see only the draft if OpenAI Decisions keeps it or Gemini returns it word for word. If you asked for a rewrite and Gemini keeps the wording, you also see “Gemini returned the original draft.” If a rewrite fails, you get the draft and a brief reason.

### Optional OpenAI Decisions API for Gemini rewrites

Normal mode uses Gemini directly by default. To ask OpenAI whether a draft needs a rewrite, run `npx @kyun.si/codex-polish@beta openai` and enter the key at the hidden terminal prompt. The check sends the current question, draft and any custom polishing prompt to OpenAI and incurs API usage on the project that owns the key. The same command replaces or removes the key. [Credentials guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md#optional-openai-decisions-api)

## Useful chat prompts in Codex

- **“Set up Codex Polish.”** Opens your saved settings. You can keep or change the polishing mode (**Normal**, **Turbo**, **Only when asked**, or **Turn off polishing**), or pick a Gemini model and thinking level when polishing is on.
- **“Speak plainly.” “Rewrite.” “Polish.”** Send any of these on its own to rewrite the last reply with Gemini. To apply it to a new answer, ask **“Why does a cache hit still take time? Say it in plain English.”**
- **“Have Gemini rewrite your last answer in two sentences.”** You can name an earlier answer in the same chat. Asking to rewrite the original again uses the question that first prompted it. If Codex can’t identify the original, it asks you to point it out or quote it. A request to polish or rewrite skips the OpenAI Decisions API even when automatic polishing is set to Normal.
- **“Switch to Turbo mode.”** Saves Turbo for automatic polishing. To restore Normal, say **“Switch back to Normal mode.”** For a one-time rewrite, say **“Use Turbo for this reply.”**
- **“Only polish when I ask.” “Turn off polishing.” “Turn on automatic polishing.”** Switch to manual mode, turn off all automatic and requested rewrites across this Codex profile (keeping your saved model, prompt and key), or turn automatic polishing back on. **“Only show the polished text”** hides the comparison for one reply.
- **“Choose a rewrite model.”** Pick a model from your Antigravity account and a thinking level it supports. To change just the level, say **“Use High thinking for Gemini.”** Normal and Turbo both use your selection.
- **“Set my polishing prompt to: Lead with the conclusion and use short sentences.”** Your custom prompt replaces the built-in editing instructions for Normal and Turbo. Say **“Restore the default polishing prompt”** to delete the saved text.

## What gets sent

Both plugins send the selected text as written, including any keys or tokens it contains. Say **“Skip polishing this time”** to keep this reply out of the polishing workflow. If you ask for JSON only, a single command, or a verbatim quote, Codex delivers that format directly.

**In Antigravity**, the model provider configured in your Codex CLI receives the current draft, the question it answers and any editing directions. For a selection it receives the selected text and applicable directions. The editor gets no additional chat history. Antigravity manages the conversation and tool results under its usual settings.

**In Codex**, the Gemini workflow uses the following inputs.

- **OpenAI** receives the current question, draft and any custom prompt only when automatic polishing uses the OpenAI Decisions API in Normal mode. If the check is off or unavailable, drafts go directly to Gemini.
- **Google** receives the original question and draft when you polish a whole reply, along with any custom profile prompt and directions for this edit. A trusted hook can include up to two earlier exchanges from the same chat by default. Set history to 0–10 exchanges or say **“Leave out history this time.”**
- **Selected passages:** Saying **“Rewrite this passage in two sentences”** sends the passage, your editing direction, and the profile’s custom prompt or the built-in Turbo prompt. Saying **“Only send this passage to Gemini”** sends just the passage with the built-in Turbo prompt and keeps any extra directions and your profile prompt local. Neither sends the surrounding question or chat history.
- **Follow-up passage edits:** Asking to shorten that last edited passage again sends the displayed version you chose with your new direction and active prompt, while the original question and chat history stay local. The plugin keeps no draft log of its own.

## Maintenance

Run maintenance commands for the plugin you installed.

| Action | Codex | Antigravity |
| --- | --- | --- |
| Check setup | `npx @kyun.si/codex-polish@beta doctor` | `npx @kyun.si/agy-polish@beta doctor` |
| Update while keeping settings | `npx @kyun.si/codex-polish@beta update` | `npx @kyun.si/agy-polish@beta update` |
| Uninstall | `npx @kyun.si/codex-polish@beta uninstall` | `npx @kyun.si/agy-polish@beta uninstall` |

Agy Polish keeps its settings after uninstall so you can reuse them later.

In Windows PowerShell, use `npx.cmd` to run `doctor`, `update`, and `uninstall`. `doctor` checks local dependencies, your saved settings and hook trust. Ask **“Choose a rewrite model”** to check your Antigravity sign-in and see the available models. After an update, Codex may ask you to trust the hook again.

Uninstalling Codex Polish deletes the plugin settings, custom prompt and OpenAI API key saved in this Codex profile. It also removes empty lock files and empty plugin directories left by older versions, while keeping any unrelated files you placed there and the shared `agy` installation. [Uninstall details](docs/technical.en.md#installation-updates-and-uninstall)

[Credentials Guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Technical Reference](docs/technical.en.md) · [Evaluation](evaluation/README.en.md) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 License](LICENSE)
