# Codex Polish

**English** | [简体中文](docs/README.zh-CN.md)

[Install on Windows](#windows-powershell) · [Install on macOS or Linux](#macos-and-linux)

Codex Polish lets you use Codex to edit replies in Antigravity (`agy`) and Gemini to edit replies in Codex. Choose either direction or both during setup. The edited reply appears in the chat where you asked the question.

In Codex, you can expand the original underneath the rewrite in clients that support folding. Here’s an example translated from a Chinese test run.

The export button is fixed and passed local tests. It still needs to be checked in production.

<details>
<summary>Rewritten by Gemini · View original GPT draft</summary>

Regarding progress with the export button fix, let me explain the actual situation. The export button has now been fixed, local tests have passed, and production verification has not yet been done.

</details>

During automatic polishing, you see only the draft if OpenAI Decisions keeps it or Gemini returns it word for word. If you asked for a rewrite and Gemini keeps the wording, you also see “Gemini returned the original draft.” If a rewrite fails, you get the draft and a brief reason.

## Quick start

Bidirectional polishing is available in the npm beta channel.

Install on the machine where you chat. You need **Node.js 22.16+**, the [Codex CLI](https://developers.openai.com/codex/cli/) and [Antigravity CLI](https://antigravity.google/docs/cli). To edit replies in Antigravity, use a version of `agy` that supports native plugins and configure your model provider in Codex. For Gemini editing in Codex, use a Codex CLI with plugin support and `agy` 1.2.1+ with your Antigravity sign-in.

### Windows (PowerShell)

Open PowerShell and run this command from any folder.

```powershell
npx.cmd @kyun.si/codex-polish@beta setup
```

### macOS and Linux

Open a terminal and run this command from any folder.

```sh
npx @kyun.si/codex-polish@beta setup
```

### Edit replies in Antigravity with Codex

Choose **Antigravity** at the first prompt, or run `npx @kyun.si/codex-polish@beta setup --host agy` directly. From a source checkout, use `node scripts/install.mjs setup --host agy`. The editor uses your local Codex CLI configuration. For an OpenAI account, run `codex login` if you haven’t signed in yet.

Choose **Normal** to let Codex keep a clear draft, or **Turbo** to request a rewrite every time. Both modes send the current question and draft to Codex before Antigravity delivers its answer. **Only when asked** enables explicit edits. **Off** stops editing and preserves your model selection. Keep the Codex default or select a model and reasoning effort from the account’s model list.

Open a new `agy` chat. In automatic mode, ask an ordinary question. In manual mode, try **“/polish Rewrite the previous reply in two sentences.”** If Antigravity asks, allow the `polish_reply` tool. The final reply contains the edited text. If Codex is unavailable, Antigravity can deliver its original draft. Say **“Set up reply polishing”** in Antigravity to change these settings later.

### Edit replies in Codex with Gemini

Choose **Codex** at the first prompt, or use `setup --host codex`. Choose **both** to configure each direction in one run. If you run the installer non-interactively, the default host is Codex.

For T3 Code, select the Codex backend.

Use **↑ / ↓** and **Enter** to choose **Normal** (automatic, when useful), **Turbo** (automatic, every time), **Only when asked**, or **Turn off polishing**. When polishing is on, pick a Gemini model and its thinking level. The initial defaults are **Normal**, **Gemini 4 Hydrogen** and **Medium**. Setup offers to install `agy` if needed. Choosing **Turn off polishing** saves `off` for this Codex profile and exits right away without model, dependency, key or hook prompts. [Other installation options](docs/technical.en.md#installation-updates-and-uninstall)

Codex Polish uses one set of preferences for your current Codex profile. Changes you save in chat or in the terminal take effect immediately in every chat and folder using that profile. Run `setup` again to review your mode, model and thinking level, turn polishing off, or select **Normal**, **Turbo** or **Only when asked** from the same menu to turn it back on. Press **Enter** to keep each saved choice or use the arrows to change it. Turning polishing off stops automatic and requested rewrites—nothing is sent to Gemini or OpenAI Decisions—while keeping your saved model, thinking level, custom prompt and OpenAI key. Use `update` to upgrade with your existing settings.

- **Before trusting the hook:** Ask **“Why does a cache hit still take time? Polish the answer.”** Asking for a polish uses Turbo. Gemini receives the draft without earlier exchanges.
- **Automatic mode (default):** Trust `UserPromptSubmit` in Codex **Settings → Hooks** (`/hooks` in the CLI) and start a **new chat**. Codex then runs the polishing workflow on ordinary questions and can include recent exchanges.

### Optional OpenAI Decisions API for Gemini rewrites

On first interactive setup, choosing Normal lets you enable the OpenAI Decisions API to check whether Gemini should rewrite each draft. Press **Enter** to skip it and use Gemini alone. If you opt in, OpenAI receives your current question, draft and any custom polishing prompt. Create an OpenAI API key in the project that will pay for the checks and enter it at the hidden terminal prompt. The key is saved for this Codex profile. Turbo always goes directly to Gemini. [OpenAI API keys](https://platform.openai.com/api-keys)

To add, replace or remove the key later, run `npx @kyun.si/codex-polish@beta openai`. In Windows PowerShell, use `npx.cmd @kyun.si/codex-polish@beta openai`. Codex Polish ignores the `OPENAI_API_KEY` environment variable. [Credentials guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md#optional-openai-decisions-api)

## Useful chat prompts in Codex

- **“Set up Codex Polish.”** Opens your saved settings. You can keep or change the polishing mode (**Normal**, **Turbo**, **Only when asked**, or **Turn off polishing**), or pick a Gemini model and thinking level when polishing is on.
- **“Speak plainly.” “Rewrite.” “Polish.”** Send any of these on its own to rewrite the last reply with Gemini. To apply it to a new answer, ask **“Why does a cache hit still take time? Say it in plain English.”**
- **“Have Gemini rewrite your last answer in two sentences.”** You can name an earlier answer in the same chat. Asking to rewrite the original again uses the question that first prompted it. If Codex can’t identify the original, it asks you to point it out or quote it. A request to polish or rewrite skips the OpenAI Decisions API even when automatic polishing is set to Normal.
- **“Switch to Turbo mode.”** Saves Turbo for automatic polishing. To restore Normal, say **“Switch back to Normal mode.”** For a one-time rewrite, say **“Use Turbo for this reply.”**
- **“Only polish when I ask.” “Turn off polishing.” “Turn on automatic polishing.”** Switch to manual mode, turn off all automatic and requested rewrites across this Codex profile (keeping your saved model, prompt and key), or turn automatic polishing back on. **“Only show the polished text”** hides the comparison for one reply.
- **“Choose a rewrite model.”** Pick a model from your Antigravity account and a thinking level it supports. To change just the level, say **“Use High thinking for Gemini.”** Normal and Turbo both use your selection.
- **“Set my polishing prompt to: Lead with the conclusion and use short sentences.”** Your custom prompt replaces the built-in editing instructions for Normal and Turbo. Say **“Restore the default polishing prompt”** to delete the saved text.

## What gets sent

Codex Polish sends the selected text as written, including any keys or tokens it contains. Say **“Skip polishing this time”** to keep this reply out of the polishing workflow. If you ask for JSON only, a single command, or a verbatim quote, Codex delivers that format directly.

**In Antigravity**, the model provider configured in your Codex CLI receives the current draft, the question it answers and any editing directions. For a selection it receives the selected text and applicable directions. The editor gets no additional chat history. Antigravity manages the conversation and tool results under its usual settings.

**In Codex**, the Gemini workflow uses the following inputs.

- **OpenAI** receives the current question, draft and any custom prompt only when automatic polishing uses the OpenAI Decisions API in Normal mode. If the check is off or unavailable, drafts go directly to Gemini.
- **Google** receives the original question and draft when you polish a whole reply, along with any custom profile prompt and directions for this edit. A trusted hook can include up to two earlier exchanges from the same chat by default. Set history to 0–10 exchanges or say **“Leave out history this time.”**
- **Selected passages:** Saying **“Rewrite this passage in two sentences”** sends the passage, your editing direction, and the profile’s custom prompt or the built-in Turbo prompt. Saying **“Only send this passage to Gemini”** sends just the passage with the built-in Turbo prompt and keeps any extra directions and your profile prompt local. Neither sends the surrounding question or chat history.
- **Follow-up passage edits:** Asking to shorten that last edited passage again sends the displayed version you chose with your new direction and active prompt, while the original question and chat history stay local. The plugin keeps no draft log of its own.

## Maintenance

Add `--host agy` to check, update or uninstall the Antigravity plugin. Use `--host both` to operate on both installations. Uninstalling the Antigravity plugin keeps its mode and model settings for a later installation.

| Action | Command |
| --- | --- |
| Check setup | `npx @kyun.si/codex-polish@beta doctor` |
| Update | `npx @kyun.si/codex-polish@beta update` |
| Uninstall | `npx @kyun.si/codex-polish@beta uninstall` |

In Windows PowerShell, use `npx.cmd` to run `doctor`, `update`, and `uninstall`. `doctor` checks local dependencies, your saved settings and hook trust. Ask **“Choose a rewrite model”** to check your Antigravity sign-in and see the available models. After an update, Codex may ask you to trust the hook again.

Uninstall deletes the plugin settings, custom prompt and OpenAI API key saved in this Codex profile. It also removes empty lock files and empty plugin directories left by older versions, while keeping any unrelated files you placed there and the shared `agy` installation. [Uninstall details](docs/technical.en.md#installation-updates-and-uninstall)

[Credentials Guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md) · [Technical Reference](docs/technical.en.md) · [Evaluation](evaluation/README.en.md) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 License](LICENSE)
